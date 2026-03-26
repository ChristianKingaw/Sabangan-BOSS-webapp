import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
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

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const revalidate = 0

const TEMPLATE_PATH = "templates/mayors_clearance_2026.docx"

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

function normalizeBusinessType(value: unknown) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
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
        console.error("Token verification failed (clearance-docx):", authError)
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

    const metaApplicantUid = String(payload?.meta?.applicantUid ?? "").trim()
    let treasuryAssessment = null
    try {
      treasuryAssessment = await fetchLatestTreasuryAssessmentByClientUid(adminDb, [
        sourceApplicantUid,
        metaApplicantUid,
        sourceApplicationId,
      ])
    } catch (treasuryErr) {
      console.warn("Failed to load treasury assessment for Mayor's Clearance DOCX", treasuryErr)
    }

    const { name, mergeFields, businessType } = mapClearanceToMergeFields(
      payload,
      sourceApplicationId,
      treasuryAssessment
    )
    if (isBusinessRequest) {
      mergeFields.Purpose = "Business"
    }

    let resolvedNo = normalizeDisplayNo(displayNo) || String(mergeFields.no ?? mergeFields.No ?? "").trim()
    if (!resolvedNo) {
      resolvedNo = isBusinessRequest
        ? await resolveFallbackBusinessClearanceDocumentNo(adminDb, sourceApplicationId)
        : await resolveFallbackClearanceDocumentNo(adminDb, applicantUid, applicationId)
    }

    const useSecondPageNumberFormat =
      applicationClass === "corp_or_association" ||
      (isBusinessRequest && applicationClass !== "regular_business" && shouldUseSecondClearancePage(businessType))

    if (resolvedNo && useSecondPageNumberFormat) {
      resolvedNo = ensureSecondPageNoPrefix(resolvedNo)
    }

    if (resolvedNo) {
      mergeFields.No = resolvedNo
      mergeFields.no = resolvedNo
    }

    let renderedBuffer: Buffer
    try {
      const publicOrigin = getRequestPublicOrigin(request)
      const templateBuffer = await loadTemplateBuffer(TEMPLATE_PATH, publicOrigin)
      renderedBuffer = renderMergeFields.renderMergeFieldsTemplateBuffer(templateBuffer, mergeFields)
    } catch (renderErr) {
      console.error("Failed to render Mayor's Clearance template", renderErr)
      return NextResponse.json({ error: "Failed to render Mayor's Clearance template" }, { status: 500 })
    }

    const printableName = `${[name.firstName, name.lastName].filter(Boolean).join("_") || "Applicant"}_Mayors_Clearance.docx`
      .replace(/[^\w.-]+/g, "_")
      .replace(/_+/g, "_")

    return new NextResponse(new Uint8Array(renderedBuffer), {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename="${printableName}"`,
        "Content-Length": String(renderedBuffer.length),
      },
    })
  } catch (error) {
    console.error("clearance-docx export error:", error)
    return NextResponse.json({ error: "Failed to generate Mayor's Clearance document" }, { status: 500 })
  }
}
