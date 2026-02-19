import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { createHash } from "node:crypto"
import { adminAuth, adminDb } from "@/lib/firebase-admin"
import { renderFromTemplateBuffer } from "@/lib/docx/renderFromTemplate"
import { loadTemplateBuffer } from "@/lib/docx/loadTemplateBuffer"
import { getRequestPublicOrigin } from "@/lib/http/getRequestPublicOrigin"
import { mapApplicationToTemplate } from "@/lib/export/mapApplicationToTemplate"
import { BUSINESS_APPLICATION_PATH } from "@/lib/business-applications"
import { getRedisClient } from "@/lib/redis"
import { PDFDocument } from "pdf-lib"
import {
  fetchLatestTreasuryAssessmentByClientUid,
  resolveBusinessClientUid,
} from "@/lib/treasury-assessment"

export const runtime = "nodejs"

// Needs runtime execution for auth and LibreOffice; disable prerendering
export const dynamic = "force-dynamic"
export const revalidate = 0

const ExportRequestSchema = z.object({
  applicationId: z.string().min(1),
})

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
const PREVIEW_CACHE_KEY_PREFIX = "preview:application-form-pdf:v1"
const DEFAULT_PREVIEW_CACHE_TTL_SECONDS = 10 * 60
const MAX_PREVIEW_CACHE_TTL_SECONDS = 24 * 60 * 60

function getPreviewCacheTtlSeconds() {
  const raw = Number.parseInt(process.env.PREVIEW_FORM_CACHE_TTL_SECONDS ?? "", 10)
  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_PREVIEW_CACHE_TTL_SECONDS
  }
  return Math.min(raw, MAX_PREVIEW_CACHE_TTL_SECONDS)
}

function stableSerialize(value: unknown): string {
  if (value === undefined) return "null"
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value)
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`
  }

  const sortedEntries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
  const body = sortedEntries
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableSerialize(nested)}`)
    .join(",")

  return `{${body}}`
}

function buildPreviewCacheKey(
  applicationId: string,
  swornOnly: boolean,
  templateData: unknown
): string {
  const cacheVersion = process.env.PREVIEW_FORM_CACHE_VERSION ?? "1"
  const digest = createHash("sha256")
    .update(
      stableSerialize({
        cacheVersion,
        applicationId,
        swornOnly,
        templateData,
      })
    )
    .digest("hex")

  return `${PREVIEW_CACHE_KEY_PREFIX}:${applicationId}:${swornOnly ? "sworn" : "full"}:${digest}`
}

function buildPdfResponse(pdfBuffer: Buffer, cacheStatus: "HIT" | "MISS" | "BYPASS") {
  return new NextResponse(new Uint8Array(pdfBuffer), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="Application.pdf"`,
      "Content-Length": String(pdfBuffer.length),
      "Cache-Control": "private, no-store",
      "X-Preview-Cache": cacheStatus,
    },
  })
}

function toConverterDocxEndpoint(value: string): string {
  const base = value.trim().replace(/\/+$/, "")

  if (base.endsWith("/convert/docx-to-pdf") || base.endsWith("/api/convert/docx-to-pdf")) {
    return base
  }
  if (base.endsWith("/convert") || base.endsWith("/api/convert")) {
    return `${base}/docx-to-pdf`
  }

  return `${base}/convert/docx-to-pdf`
}

function getConverterEndpoints(requestOrigin: string): string[] {
  const candidates: string[] = []

  const configured =
    process.env.CONVERTER_SERVICE_URL ||
    process.env.CONVERTER_BASE_URL ||
    process.env.NEXT_PUBLIC_CONVERTER_SERVICE_URL

  if (configured) {
    candidates.push(toConverterDocxEndpoint(configured))
  }

  // Production path via Firebase Hosting rewrite -> Cloud Run converter service.
  candidates.push(toConverterDocxEndpoint(`${requestOrigin}/api/convert`))
  // Local Docker container fallback.
  candidates.push("http://127.0.0.1:8080/convert/docx-to-pdf")

  return [...new Set(candidates)]
}

async function convertDocxToPdfBuffer(docxBuffer: Buffer, converterEndpoints: string[]): Promise<Buffer> {
  const errors: string[] = []

  for (const endpoint of converterEndpoints) {
    try {
      const form = new FormData()
      const payload = new Uint8Array(docxBuffer.length)
      payload.set(docxBuffer)
      form.append("file", new Blob([payload], { type: DOCX_MIME }), "input.docx")

      const response = await fetch(endpoint, {
        method: "POST",
        body: form,
        cache: "no-store",
      })

      if (!response.ok) {
        const bodyText = await response.text().catch(() => "")
        throw new Error(`HTTP ${response.status} ${response.statusText} ${bodyText}`.trim())
      }

      const pdfBuffer = Buffer.from(await response.arrayBuffer())
      if (!pdfBuffer.length) {
        throw new Error("Empty PDF payload returned by converter")
      }

      return pdfBuffer
    } catch (err) {
      errors.push(`${endpoint} -> ${String(err)}`)
    }
  }

  throw new Error(
    `Converter service unreachable. Tried: ${converterEndpoints.join(", ")}. Errors: ${errors.join(" | ")}`
  )
}

async function mergePdfBuffers(buffers: Buffer[]): Promise<Buffer> {
  const merged = await PDFDocument.create()

  for (const buf of buffers) {
    const src = await PDFDocument.load(buf)
    const copied = await merged.copyPages(src, src.getPageIndices())
    copied.forEach((p) => merged.addPage(p))
  }

  const mergedBytes = await merged.save()
  return Buffer.from(mergedBytes)
}

export async function POST(request: NextRequest) {
  try {
    const authHeader = request.headers.get("Authorization")
    const isDev = process.env.NODE_ENV !== "production"
    const devBypass = isDev && request.headers.get("x-dev-bypass") === "1"

    if (devBypass) {
      console.warn("Development bypass enabled for DOCX->PDF export request")
    } else {
      if (!authHeader?.startsWith("Bearer ")) {
        return NextResponse.json({ error: "Missing or invalid Authorization header" }, { status: 401 })
      }

      if (!adminAuth) {
        return NextResponse.json({ error: "Server misconfigured: Firebase Admin not initialized" }, { status: 500 })
      }

      const idToken = authHeader.slice(7)
      try {
        await adminAuth.verifyIdToken(idToken)
      } catch (err) {
        console.error("Token verification failed (docx-to-pdf)", err)
        return NextResponse.json({ error: "Invalid or expired authentication token" }, { status: 401 })
      }
    }

    let body: any
    try {
      body = await request.json()
    } catch (err) {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
    }

    const parse = ExportRequestSchema.safeParse(body)
    if (!parse.success) {
      return NextResponse.json({ error: "Invalid request", details: parse.error.flatten() }, { status: 400 })
    }

    const { applicationId } = parse.data
    const swornOnly = Boolean(body.swornOnly)

    if (!adminDb) {
      return NextResponse.json({ error: "Server misconfigured: Firebase Admin DB not initialized" }, { status: 500 })
    }

    const applicationRef = adminDb.ref(`${BUSINESS_APPLICATION_PATH}/${applicationId}`)
    const snapshot = await applicationRef.get()
    if (!snapshot.exists()) {
      return NextResponse.json({ error: "Application not found" }, { status: 404 })
    }

    const applicationData = snapshot.val()
    const formData = applicationData?.form ?? {}
    const publicOrigin = getRequestPublicOrigin(request)
    const clientUid = resolveBusinessClientUid(applicationId, applicationData ?? {})

    let treasuryAssessment = null
    try {
      treasuryAssessment = await fetchLatestTreasuryAssessmentByClientUid(adminDb, [clientUid, applicationId])
    } catch (treasuryError) {
      console.warn("Failed to load treasury assessment for DOCX->PDF export", treasuryError)
    }

    const templateData = mapApplicationToTemplate(formData, treasuryAssessment)
    const previewCacheKey = buildPreviewCacheKey(applicationId, swornOnly, templateData)
    let redisClient = null as Awaited<ReturnType<typeof getRedisClient>> | null
    try {
      redisClient = await getRedisClient()
    } catch (redisError) {
      console.warn("Failed to initialize Redis preview cache. Continuing without cache.", redisError)
    }

    if (redisClient) {
      try {
        const cachedBase64 = await redisClient.get(previewCacheKey)
        if (cachedBase64) {
          const cachedBuffer = Buffer.from(cachedBase64, "base64")
          if (cachedBuffer.length > 0) {
            return buildPdfResponse(cachedBuffer, "HIT")
          }
        }
      } catch (err) {
        console.warn("Redis preview cache read failed. Falling back to fresh render.", err)
      }
    }

    let templatePath = "templates/2025_new_business_form_template_with_tags_v2_fixed.docx"
    try {
      const appType = String(formData.applicationType ?? "").toLowerCase()
      if (swornOnly) {
        if (appType === "new") {
          templatePath = "templates/Sworn_Statement_of_Capital.docx"
        } else {
          templatePath = "templates/Sworn_Declaration_of_Gross_receipt.docx"
        }
      }
    } catch {}

    let docxBuffer: Buffer
    try {
      const mainTemplateBuffer = await loadTemplateBuffer(templatePath, publicOrigin)
      docxBuffer = renderFromTemplateBuffer(mainTemplateBuffer, templateData)
    } catch (err) {
      return NextResponse.json(
        { error: "Failed to render application template", details: String(err) },
        { status: 500 }
      )
    }

    let pdfBuffer: Buffer
    try {
      const converterEndpoints = getConverterEndpoints(request.nextUrl.origin)

      // Convert main docx to PDF
      const mainPdf = await convertDocxToPdfBuffer(docxBuffer, converterEndpoints)

      // If not swornOnly, try to also render/convert the sworn template and merge PDFs
      if (!swornOnly) {
        try {
          // Determine sworn template path based on application type
          let swornTemplatePath: string | null = null
          try {
            const appType = String(formData.applicationType ?? "").toLowerCase()
            if (appType === "new") {
              swornTemplatePath = "templates/Sworn_Statement_of_Capital.docx"
            } else {
              swornTemplatePath = "templates/Sworn_Declaration_of_Gross_receipt.docx"
            }
          } catch {}

          if (swornTemplatePath) {
            try {
              const swornTemplateBuffer = await loadTemplateBuffer(swornTemplatePath, publicOrigin)
              const swornDocx = renderFromTemplateBuffer(swornTemplateBuffer, templateData)
              const swornPdf = await convertDocxToPdfBuffer(swornDocx, converterEndpoints)
              // Merge main + sworn
              pdfBuffer = await mergePdfBuffers([mainPdf, swornPdf])
            } catch {
              // sworn template missing; return main PDF
              pdfBuffer = mainPdf
            }
          } else {
            pdfBuffer = mainPdf
          }
        } catch (mergeErr) {
          console.warn("Failed to render/merge sworn doc; returning main PDF:", mergeErr)
          pdfBuffer = mainPdf
        }
      } else {
        // swornOnly requested — return only the sworn PDF (main not included)
        // But for swornOnly, templatePath was already switched earlier; mainPdf is actually sworn PDF
        pdfBuffer = mainPdf
      }
    } catch (err) {
      const errStr = String(err || "")
      const lowerErr = errStr.toLowerCase()
      // Keep conversion-path errors as warnings (common when converter service is down).
      if (
        lowerErr.includes("converter") ||
        lowerErr.includes("econnrefused") ||
        lowerErr.includes("fetch failed") ||
        lowerErr.includes("soffice") ||
        lowerErr.includes("enoent")
      ) {
        console.warn("Server-side PDF conversion unavailable; converter service failed:", errStr)
        return NextResponse.json({ error: "Failed to convert to PDF", details: errStr }, { status: 500 })
      }

      console.error("PDF conversion error:", err)
      return NextResponse.json({ error: "Failed to convert to PDF", details: errStr }, { status: 500 })
    }

    if (redisClient) {
      try {
        await redisClient.set(previewCacheKey, pdfBuffer.toString("base64"), {
          EX: getPreviewCacheTtlSeconds(),
        })
      } catch (err) {
        console.warn("Redis preview cache write failed. Continuing without cache.", err)
      }
    }

    return buildPdfResponse(pdfBuffer, redisClient ? "MISS" : "BYPASS")
  } catch (error) {
    console.error("DOCX->PDF export error:", error)
    return NextResponse.json({ error: "Failed to generate PDF" }, { status: 500 })
  }
}
