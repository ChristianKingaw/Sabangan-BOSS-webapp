import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { adminAuth, adminDb } from "@/lib/firebase-admin"
import { loadTemplateBuffer } from "@/lib/docx/loadTemplateBuffer"
import renderMergeFields from "@/lib/docx/renderMergeFields"
import { getRequestPublicOrigin } from "@/lib/http/getRequestPublicOrigin"
import { MAYORS_CLEARANCE_APPLICATION_PATH } from "@/lib/clearance-applications"
import { mapClearanceToMergeFields } from "@/lib/export/mapClearanceToMergeFields"
import { resolveFallbackClearanceDocumentNo } from "@/lib/export/resolveClearanceDocumentNo"
import { fetchLatestTreasuryAssessmentByClientUid } from "@/lib/treasury-assessment"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const revalidate = 0

const TEMPLATE_PATH = "templates/mayors_clearance_2026.docx"

const ExportRequestSchema = z.object({
  applicantUid: z.string().min(1, "Applicant UID is required"),
  applicationId: z.string().min(1, "Application ID is required"),
})

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

    const { applicantUid, applicationId } = parseResult.data
    const snapshot = await adminDb.ref(`${MAYORS_CLEARANCE_APPLICATION_PATH}/${applicantUid}/${applicationId}`).get()
    if (!snapshot.exists()) {
      return NextResponse.json({ error: "Mayor's clearance application not found" }, { status: 404 })
    }

    const payload = snapshot.val() ?? {}
    const metaApplicantUid = String(payload?.meta?.applicantUid ?? "").trim()
    let treasuryAssessment = null
    try {
      treasuryAssessment = await fetchLatestTreasuryAssessmentByClientUid(adminDb, [
        applicantUid,
        metaApplicantUid,
        applicationId,
      ])
    } catch (treasuryErr) {
      console.warn("Failed to load treasury assessment for Mayor's Clearance DOCX", treasuryErr)
    }

    const { name, mergeFields } = mapClearanceToMergeFields(payload, applicationId, treasuryAssessment)
    const rankedNo = await resolveFallbackClearanceDocumentNo(adminDb, applicantUid, applicationId)
    if (rankedNo) mergeFields.No = rankedNo

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
