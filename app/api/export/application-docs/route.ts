import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import archiver from "archiver"
import { adminAuth, adminDb } from "@/lib/firebase-admin"
import { renderFromTemplateBuffer } from "@/lib/docx/renderFromTemplate"
import { loadTemplateBuffer } from "@/lib/docx/loadTemplateBuffer"
import { getRequestPublicOrigin } from "@/lib/http/getRequestPublicOrigin"
import { mapApplicationToTemplate } from "@/lib/export/mapApplicationToTemplate"
import { BUSINESS_APPLICATION_PATH } from "@/lib/business-applications"
import {
  fetchLatestTreasuryAssessmentByClientUid,
  resolveBusinessClientUid,
} from "@/lib/treasury-assessment"

// Force Node.js runtime for this route (required for file system operations)
export const runtime = "nodejs"
// Must run per-request to read admin credentials and templates
export const dynamic = "force-dynamic"
export const revalidate = 0

// Template paths
const TEMPLATES = {
  mainForm: "templates/2025_new_business_form_template_with_tags_v2_fixed.docx",
  swornCapital: "templates/Sworn_Statement_of_Capital.docx",
  swornGrossReceipts: "templates/Sworn_Declaration_of_Gross_receipt.docx",
}

// Request body schema
const ExportRequestSchema = z.object({
  applicationId: z.string().min(1, "Application ID is required"),
})

/**
 * POST /api/export/application-docs
 *
 * Generate a ZIP containing the main form plus the appropriate sworn document:
 * - NEW businesses: Main Form + Sworn Statement of Capital
 * - RENEWAL businesses: Main Form + Sworn Declaration of Gross Receipts
 *
 * Headers:
 *   Authorization: Bearer <Firebase ID Token>
 *
 * Body:
 *   { applicationId: string }
 *
 * Returns:
 *   ZIP file as downloadable attachment
 */
export async function POST(request: NextRequest) {
  try {
    // 1. Verify Firebase Auth token
    const authHeader = request.headers.get("Authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json(
        { error: "Missing or invalid Authorization header" },
        { status: 401 }
      )
    }

    const idToken = authHeader.slice(7)
    try {
      await adminAuth.verifyIdToken(idToken)
    } catch (authError) {
      console.error("Token verification failed:", authError)
      return NextResponse.json(
        { error: "Invalid or expired authentication token" },
        { status: 401 }
      )
    }

    // 2. Parse and validate request body
    const body = await request.json()
    const parseResult = ExportRequestSchema.safeParse(body)

    if (!parseResult.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parseResult.error.flatten() },
        { status: 400 }
      )
    }

    const { applicationId } = parseResult.data

    // 3. Fetch application data from Realtime Database
    const applicationRef = adminDb.ref(`${BUSINESS_APPLICATION_PATH}/${applicationId}`)
    const snapshot = await applicationRef.get()

    if (!snapshot.exists()) {
      return NextResponse.json(
        { error: "Application not found" },
        { status: 404 }
      )
    }

    const applicationData = snapshot.val()
    const formData = applicationData?.form ?? {}
    const publicOrigin = getRequestPublicOrigin(request)
    const clientUid = resolveBusinessClientUid(applicationId, applicationData ?? {})

    let treasuryAssessment = null
    try {
      treasuryAssessment = await fetchLatestTreasuryAssessmentByClientUid(adminDb, [clientUid, applicationId])
    } catch (treasuryError) {
      console.warn("Failed to load treasury assessment for application-docs export", treasuryError)
    }

    // 4. Map database fields to template tags
    const templateData = mapApplicationToTemplate(formData, treasuryAssessment)

    // 5. Determine application type
    const applicationType = String(formData.applicationType ?? "").toLowerCase()
    const isNew = applicationType === "new"

    // 6. Render documents
    const mainTemplateBuffer = await loadTemplateBuffer(TEMPLATES.mainForm, publicOrigin)
    const mainFormBuffer = renderFromTemplateBuffer(mainTemplateBuffer, templateData)

    const swornTemplatePath = isNew ? TEMPLATES.swornCapital : TEMPLATES.swornGrossReceipts
    const swornTemplateBuffer = await loadTemplateBuffer(swornTemplatePath, publicOrigin)
    const swornDocBuffer = renderFromTemplateBuffer(swornTemplateBuffer, templateData)

    const swornDocName = isNew
      ? "Sworn_Statement_of_Capital.docx"
      : "Sworn_Declaration_of_Gross_Receipts.docx"

    // 7. Generate filename base
    const businessName = formData.businessName || "Application"
    const sanitizedName = businessName.replace(/[^a-zA-Z0-9\s-]/g, "").trim().replace(/\s+/g, "_")

    // 8. Create ZIP archive
    const zipBuffer = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = []
      const archive = archiver("zip", { zlib: { level: 9 } })

      archive.on("data", (chunk) => chunks.push(chunk))
      archive.on("end", () => resolve(Buffer.concat(chunks)))
      archive.on("error", (err) => reject(err))

      // Add files to archive
      archive.append(mainFormBuffer, { name: `${sanitizedName}_Business_Application.docx` })
      archive.append(swornDocBuffer, { name: `${sanitizedName}_${swornDocName}` })

      archive.finalize()
    })

    // 9. Return ZIP as downloadable response
    const zipFileName = `${sanitizedName}_Application_Documents.zip`

    return new NextResponse(new Uint8Array(zipBuffer), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${zipFileName}"`,
        "Content-Length": String(zipBuffer.length),
      },
    })
  } catch (error) {
    console.error("Application docs export error:", error)
    return NextResponse.json(
      { error: "Failed to generate documents" },
      { status: 500 }
    )
  }
}
