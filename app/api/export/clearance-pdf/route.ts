import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { PDFDocument } from "pdf-lib"
import { adminAuth, adminDb } from "@/lib/firebase-admin"
import { loadTemplateBuffer } from "@/lib/docx/loadTemplateBuffer"
import renderMergeFields from "@/lib/docx/renderMergeFields"
import { getRequestPublicOrigin } from "@/lib/http/getRequestPublicOrigin"
import { MAYORS_CLEARANCE_APPLICATION_PATH } from "@/lib/clearance-applications"
import { BUSINESS_APPLICATION_PATH } from "@/lib/business-applications"
import { mapClearanceToMergeFields } from "@/lib/export/mapClearanceToMergeFields"
import {
  resolveFallbackBusinessClearanceDocumentNo,
  resolveFallbackClearanceDocumentNo,
} from "@/lib/export/resolveClearanceDocumentNo"
import { fetchLatestTreasuryAssessmentByClientUid } from "@/lib/treasury-assessment"
import { getRedisClient } from "@/lib/redis"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const revalidate = 0

const TEMPLATE_PATH = "templates/mayors_clearance_2026.docx"
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

const CLEARANCE_CACHE_KEY_PREFIX = "preview:clearance-pdf:v1"
const DEFAULT_CACHE_TTL_SECONDS = 10 * 60
const MAX_CACHE_TTL_SECONDS = 24 * 60 * 60

function getCacheTtlSeconds() {
  const raw = Number.parseInt(process.env.CLEARANCE_PDF_CACHE_TTL_SECONDS ?? "", 10)
  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_CACHE_TTL_SECONDS
  }
  return Math.min(raw, MAX_CACHE_TTL_SECONDS)
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

function buildClearanceCacheKey(
  sourceApplicationId: string,
  applicationClass: string | undefined,
  targetPageNumber: number,
  mergeFields: unknown
): string {
  const cacheVersion = process.env.CLEARANCE_PDF_CACHE_VERSION ?? "1"
  const digest = createHash("sha256")
    .update(
      stableSerialize({
        cacheVersion,
        sourceApplicationId,
        applicationClass,
        targetPageNumber,
        mergeFields,
      })
    )
    .digest("hex")

  return `${CLEARANCE_CACHE_KEY_PREFIX}:${sourceApplicationId}:${digest.slice(0, 16)}`
}

function buildPdfResponse(
  pdfBuffer: Buffer,
  baseName: string,
  cacheStatus: "HIT" | "MISS" | "BYPASS"
) {
  return new NextResponse(new Uint8Array(pdfBuffer), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${baseName}.pdf"`,
      "Content-Length": String(pdfBuffer.length),
      "Cache-Control": "private, no-store",
      "X-Clearance-Cache": cacheStatus,
    },
  })
}

const ExportRequestSchema = z
  .object({
    applicantUid: z.string().min(1, "Applicant UID is required").optional(),
    applicationId: z.string().min(1, "Application ID is required").optional(),
    businessApplicationId: z.string().min(1, "Business application ID is required").optional(),
    applicationSource: z.enum(["business", "mayors_clearance"]).optional(),
    applicationClass: z.enum(["corp_or_association", "regular_business", "mayors_clearance"]).optional(),
    displayNo: z.union([z.number(), z.string()]).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.applicationSource === "business") {
      if (!value.businessApplicationId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["businessApplicationId"],
          message: "Business application ID is required for business source",
        })
      }
      return
    }

    if (value.applicationSource === "mayors_clearance") {
      if (!value.applicantUid) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["applicantUid"],
          message: "Applicant UID is required for mayor's clearance source",
        })
      }
      if (!value.applicationId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["applicationId"],
          message: "Application ID is required for mayor's clearance source",
        })
      }
      return
    }

    if (value.businessApplicationId) return
    if (!value.applicantUid) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["applicantUid"],
        message: "Applicant UID is required",
      })
    }
    if (!value.applicationId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["applicationId"],
        message: "Application ID is required",
      })
    }
  })

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

  candidates.push(toConverterDocxEndpoint(`${requestOrigin}/api/convert`))
  candidates.push("http://localhost:8080/convert/docx-to-pdf")
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

function getCurrentIssuedDateLabel() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).formatToParts(new Date())

  const day = Number(parts.find((part) => part.type === "day")?.value ?? "0")
  const month = parts.find((part) => part.type === "month")?.value ?? ""
  const year = parts.find((part) => part.type === "year")?.value ?? ""

  const mod10 = day % 10
  const mod100 = day % 100
  const suffix =
    mod10 === 1 && mod100 !== 11 ? "st" :
    mod10 === 2 && mod100 !== 12 ? "nd" :
    mod10 === 3 && mod100 !== 13 ? "rd" :
    "th"

  return `${day}${suffix} day of ${month} ${year}`.trim()
}

function getCurrentCalendarDateLabel() {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date())
}

function quotePowerShell(value: string) {
  return `'${value.replace(/'/g, "''")}'`
}

function normalizeBusinessType(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
}

function shouldUseSecondClearancePage(businessType: string) {
  const normalized = normalizeBusinessType(businessType)
  return (
    normalized.includes("corporation") ||
    normalized.includes("association") ||
    normalized.includes("assoc")
  )
}

function ensureSecondPageNoPrefix(value: string) {
  const trimmed = String(value ?? "").trim()
  if (!trimmed) return ""
  return trimmed.startsWith("000") ? trimmed : `000${trimmed}`
}

function normalizeDisplayNo(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return String(Math.trunc(value))
  }
  if (typeof value === "string") {
    const trimmed = value.trim()
    if (!trimmed || !/^\d+$/.test(trimmed)) return ""
    const parsed = Number(trimmed)
    if (!Number.isFinite(parsed) || parsed <= 0) return ""
    return String(Math.trunc(parsed))
  }
  return ""
}

async function keepSinglePdfPage(pdfBuffer: Buffer, pageNumber: number): Promise<Buffer> {
  const src = await PDFDocument.load(pdfBuffer)
  const pageCount = src.getPageCount()
  if (pageCount <= 1) return pdfBuffer

  const selectedIndex = Math.max(0, Math.min(pageCount - 1, pageNumber - 1))
  const output = await PDFDocument.create()
  const [copied] = await output.copyPages(src, [selectedIndex])
  output.addPage(copied)

  const bytes = await output.save()
  return Buffer.from(bytes)
}

async function convertDocxToPdfViaWordCom(
  docxBuffer: Buffer,
  issuedDateLabel: string,
  calendarDateLabel: string
): Promise<Buffer> {
  if (process.platform !== "win32") {
    throw new Error("Word COM conversion is only available on Windows")
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clearance-word-"))
  const inputPath = path.join(tempDir, "input.docx")
  const outputPath = path.join(tempDir, "output.pdf")

  await fs.writeFile(inputPath, docxBuffer)

  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$in = ${quotePowerShell(inputPath)}`,
    `$out = ${quotePowerShell(outputPath)}`,
    "$word = $null",
    "$doc = $null",
    "try {",
    "  $word = New-Object -ComObject Word.Application",
    "  $word.Visible = $false",
    "  $word.DisplayAlerts = 0",
    "  $doc = $word.Documents.Open($in, $false, $true)",
    `  $issued = ${quotePowerShell(issuedDateLabel)}`,
    `  $calendarDate = ${quotePowerShell(calendarDateLabel)}`,
    "  foreach ($target in @('12th day of January 2026','12 th day of January 2026')) {",
    "    $find = $doc.Content.Find",
    "    $find.ClearFormatting()",
    "    $find.Replacement.ClearFormatting()",
    "    $find.Execute($target, $false, $false, $false, $false, $false, $true, 1, $false, $issued, 2) | Out-Null",
    "  }",
    "  foreach ($target in @('Issued this*at Poblacion,*','Issued this*Sabangan, Mountain Province.*')) {",
    "    $find = $doc.Content.Find",
    "    $find.ClearFormatting()",
    "    $find.Replacement.ClearFormatting()",
    "    $replaceLine = \"Issued this $issued at Poblacion, Sabangan, Mountain Province.\"",
    "    $find.Execute($target, $false, $false, $true, $false, $false, $true, 1, $false, $replaceLine, 2) | Out-Null",
    "  }",
    "  foreach ($target in @('January 12, 2026','January 12,2026','Jan 12, 2026')) {",
    "    $find = $doc.Content.Find",
    "    $find.ClearFormatting()",
    "    $find.Replacement.ClearFormatting()",
    "    $find.Execute($target, $false, $false, $false, $false, $false, $true, 1, $false, $calendarDate, 2) | Out-Null",
    "  }",
    "  $doc.SaveAs([ref]$out, [ref]17)",
    "} finally {",
    "  if ($doc -ne $null) { $doc.Close([ref]$false) }",
    "  if ($word -ne $null) { $word.Quit() }",
    "  if ($doc -ne $null) { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($doc) }",
    "  if ($word -ne $null) { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) }",
    "  [GC]::Collect()",
    "  [GC]::WaitForPendingFinalizers()",
    "}",
  ].join("; ")

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
        stdio: ["ignore", "pipe", "pipe"],
      })

      let stderr = ""
      const timeout = setTimeout(() => {
        child.kill("SIGTERM")
        reject(new Error("Word COM conversion timed out"))
      }, 90_000)

      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString()
      })

      child.on("error", (err) => {
        clearTimeout(timeout)
        reject(err)
      })

      child.on("exit", (code) => {
        clearTimeout(timeout)
        if (code === 0) resolve()
        else reject(new Error(`Word COM conversion failed (exit ${code}): ${stderr}`))
      })
    })

    return await fs.readFile(outputPath)
  } finally {
    await Promise.allSettled([
      fs.rm(inputPath, { force: true }),
      fs.rm(outputPath, { force: true }),
      fs.rm(tempDir, { force: true, recursive: true }),
    ])
  }
}

export async function POST(request: NextRequest) {
  try {
    const authHeader = request.headers.get("Authorization")
    const isDev = process.env.NODE_ENV !== "production"
    const devBypass = isDev && request.headers.get("x-dev-bypass") === "1"

    if (!devBypass) {
      if (!authHeader?.startsWith("Bearer ")) {
        return NextResponse.json({ error: "Missing or invalid Authorization header" }, { status: 401 })
      }
      if (!adminAuth) {
        return NextResponse.json({ error: "Server misconfigured: Firebase Admin not initialized" }, { status: 500 })
      }

      const idToken = authHeader.slice(7)
      try {
        await adminAuth.verifyIdToken(idToken)
      } catch (authError) {
        console.error("Token verification failed (clearance-pdf):", authError)
        return NextResponse.json({ error: "Invalid or expired authentication token" }, { status: 401 })
      }
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
    }

    const parseResult = ExportRequestSchema.safeParse(body)
    if (!parseResult.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parseResult.error.flatten() },
        { status: 400 }
      )
    }

    if (!adminDb) {
      return NextResponse.json({ error: "Server misconfigured: Firebase Admin DB not initialized" }, { status: 500 })
    }

    const { businessApplicationId, applicationSource, applicationClass, displayNo } = parseResult.data
    const isBusinessRequest =
      applicationSource === "business" ? true :
      applicationSource === "mayors_clearance" ? false :
      Boolean(businessApplicationId)

    const applicantUid = String(parseResult.data.applicantUid ?? "").trim()
    const applicationId = String(parseResult.data.applicationId ?? "").trim()

    let payload: any = {}
    let sourceApplicantUid = applicantUid
    let sourceApplicationId = applicationId

    if (isBusinessRequest) {
      const businessId = String(businessApplicationId ?? "").trim()
      const businessSnapshot = await adminDb.ref(`${BUSINESS_APPLICATION_PATH}/${businessId}`).get()
      if (!businessSnapshot.exists()) {
        return NextResponse.json({ error: "Business application not found" }, { status: 404 })
      }
      payload = businessSnapshot.val() ?? {}
      sourceApplicationId = businessId
      sourceApplicantUid = String(payload?.form?.applicantUid ?? payload?.meta?.applicantUid ?? "").trim()
    } else {
      const snapshot = await adminDb.ref(`${MAYORS_CLEARANCE_APPLICATION_PATH}/${applicantUid}/${applicationId}`).get()
      if (!snapshot.exists()) {
        return NextResponse.json({ error: "Mayor's clearance application not found" }, { status: 404 })
      }
      payload = snapshot.val() ?? {}
    }

    const metaApplicantUid = String(payload?.meta?.applicantUid ?? payload?.form?.applicantUid ?? "").trim()
    let treasuryAssessment = null
    try {
      treasuryAssessment = await fetchLatestTreasuryAssessmentByClientUid(adminDb, [
        sourceApplicantUid,
        metaApplicantUid,
        sourceApplicationId,
      ])
    } catch (treasuryErr) {
      console.warn("Failed to load treasury assessment for Mayor's Clearance PDF", treasuryErr)
    }

    const { mergeFields, name, businessType } = mapClearanceToMergeFields(payload, sourceApplicationId, treasuryAssessment)
    if (isBusinessRequest) {
      mergeFields.Purpose = "Business"
    }

    const targetPageNumber =
      applicationClass === "mayors_clearance" ? 1 :
      applicationClass === "corp_or_association" ? 2 :
      applicationClass === "regular_business" ? 1 :
      shouldUseSecondClearancePage(businessType) ? 2 : 1

    let resolvedNo = normalizeDisplayNo(displayNo) || String(mergeFields.no ?? mergeFields.No ?? "").trim()
    if (!resolvedNo) {
      resolvedNo = isBusinessRequest
        ? await resolveFallbackBusinessClearanceDocumentNo(adminDb, sourceApplicationId)
        : await resolveFallbackClearanceDocumentNo(adminDb, applicantUid, applicationId)
    }
    if (resolvedNo && targetPageNumber === 2) {
      resolvedNo = ensureSecondPageNoPrefix(resolvedNo)
    }
    if (resolvedNo) {
      mergeFields.No = resolvedNo
      mergeFields.no = resolvedNo
    }

    const baseName = `${[name.firstName, name.lastName].filter(Boolean).join("_") || "Applicant"}_Mayors_Clearance`
      .replace(/[^\w.-]+/g, "_")
      .replace(/_+/g, "_")

    const cacheKey = buildClearanceCacheKey(sourceApplicationId, applicationClass, targetPageNumber, mergeFields)
    let redisClient = null as Awaited<ReturnType<typeof getRedisClient>> | null
    try {
      redisClient = await getRedisClient()
    } catch (redisError) {
      console.warn("Failed to initialize Redis for clearance-pdf cache. Continuing without cache.", redisError)
    }

    if (redisClient) {
      try {
        const cachedBase64 = await redisClient.get(cacheKey)
        if (cachedBase64) {
          const cachedBuffer = Buffer.from(cachedBase64, "base64")
          if (cachedBuffer.length > 0) {
            return buildPdfResponse(cachedBuffer, baseName, "HIT")
          }
        }
      } catch (err) {
        console.warn("Redis clearance-pdf cache read failed. Falling back to fresh render.", err)
      }
    }

    let docxBuffer: Buffer
    try {
      const publicOrigin = getRequestPublicOrigin(request)
      const templateBuffer = await loadTemplateBuffer(TEMPLATE_PATH, publicOrigin)
      docxBuffer = renderMergeFields.renderMergeFieldsTemplateBuffer(templateBuffer, mergeFields)
    } catch (renderErr) {
      console.error("Failed to render Mayor's Clearance template for PDF", renderErr)
      return NextResponse.json({ error: "Failed to render Mayor's Clearance template" }, { status: 500 })
    }

    let pdfBuffer: Buffer
    try {
      const issuedDateLabel = getCurrentIssuedDateLabel()
      const calendarDateLabel = getCurrentCalendarDateLabel()
      if (process.platform === "win32") {
        pdfBuffer = await convertDocxToPdfViaWordCom(docxBuffer, issuedDateLabel, calendarDateLabel)
      } else {
        const converterEndpoints = getConverterEndpoints(request.nextUrl.origin)
        pdfBuffer = await convertDocxToPdfBuffer(docxBuffer, converterEndpoints)
      }
    } catch (primaryConvertErr) {
      try {
        const converterEndpoints = getConverterEndpoints(request.nextUrl.origin)
        pdfBuffer = await convertDocxToPdfBuffer(docxBuffer, converterEndpoints)
      } catch (fallbackConvertErr) {
        console.error("Failed to convert Mayor's Clearance DOCX to PDF", {
          primary: String(primaryConvertErr),
          fallback: String(fallbackConvertErr),
        })
        return NextResponse.json({ error: "Failed to convert Mayor's Clearance to PDF" }, { status: 500 })
      }
    }

    pdfBuffer = await keepSinglePdfPage(pdfBuffer, targetPageNumber)

    if (redisClient) {
      try {
        await redisClient.set(cacheKey, pdfBuffer.toString("base64"), {
          EX: getCacheTtlSeconds(),
        })
      } catch (err) {
        console.warn("Redis clearance-pdf cache write failed. Continuing without cache.", err)
      }
    }

    return buildPdfResponse(pdfBuffer, baseName, redisClient ? "MISS" : "BYPASS")
  } catch (error) {
    console.error("clearance-pdf export error:", error)
    return NextResponse.json({ error: "Failed to generate Mayor's Clearance PDF" }, { status: 500 })
  }
}
