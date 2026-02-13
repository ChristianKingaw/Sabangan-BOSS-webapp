import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { adminAuth, adminDb } from "@/lib/firebase-admin"
import { renderFromTemplateBuffer } from "@/lib/docx/renderFromTemplate"
import { loadTemplateBuffer } from "@/lib/docx/loadTemplateBuffer"
import { getRequestPublicOrigin } from "@/lib/http/getRequestPublicOrigin"
import { mapApplicationToTemplate } from "@/lib/export/mapApplicationToTemplate"
import { BUSINESS_APPLICATION_PATH } from "@/lib/business-applications"

// Force Node.js runtime for this route (required for file system operations)
export const runtime = "nodejs"

// Avoid prerendering; must run at request time to access credentials/files
export const dynamic = "force-dynamic"
export const revalidate = 0

// Request body schema
const ExportRequestSchema = z.object({
  applicationId: z.string().min(1, "Application ID is required"),
})

/**
 * POST /api/export/docx
 *
 * Generate a DOCX file from a business application record.
 *
 * Headers:
 *   Authorization: Bearer <Firebase ID Token>
 *
 * Body:
 *   { applicationId: string }
 *
 * Returns:
 *   DOCX file as downloadable attachment
 */
export async function POST(request: NextRequest) {
  try {
    console.log("DOCX export handler invoked", { time: new Date().toISOString() })
    try {
      console.log("Request info", {
        method: request.method,
        url: request.url,
        headers: Object.fromEntries(request.headers),
      })
    } catch (hdrErr) {
      console.error("Failed to stringify request headers", hdrErr)
    }

    // Sanity-check imported admin SDK instances
    try {
      console.log("adminAuth available:", typeof adminAuth !== "undefined")
      console.log("adminDb available:", typeof adminDb !== "undefined")
    } catch (envErr) {
      console.error("Error checking admin SDK availability:", envErr)
    }
    // 1. Verify Firebase Auth token
    const authHeader = request.headers.get("Authorization")

    // Development bypass: allow requests to skip Firebase token verification when
    // running locally (NODE_ENV !== 'production') and the caller includes
    // header `x-dev-bypass: 1`. This is helpful for local testing only.
    const isDev = process.env.NODE_ENV !== "production"
    const devBypass = isDev && request.headers.get("x-dev-bypass") === "1"
    if (devBypass) {
      console.warn("Development bypass enabled for DOCX export request")
    } else {
      // Ensure adminAuth is initialized before attempting verification
      if (!adminAuth) {
        console.error("Firebase Admin SDK not initialized; cannot verify tokens")
        return NextResponse.json({ error: "Server misconfigured: Firebase Admin not initialized" }, { status: 500 })
      }

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
    }

    // 2. Parse and validate request body
    let body: any
    try {
      body = await request.json()
      console.log("Request body:", body)
    } catch (bodyErr) {
      console.error("Failed to parse JSON body:", bodyErr)
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
    }
    const parseResult = ExportRequestSchema.safeParse(body)

    if (!parseResult.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parseResult.error.flatten() },
        { status: 400 }
      )
    }

    const { applicationId } = parseResult.data
    const swornOnly = Boolean(body.swornOnly)

    // 3. Fetch application data from Realtime Database
    if (!adminDb) {
      console.error("Firebase Admin Realtime Database not initialized; cannot fetch application data")
      return NextResponse.json(
        { error: "Server misconfigured: Firebase Admin DB not initialized" },
        { status: 500 }
      )
    }

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

    // 4. Map database fields to template tags
    const templateData = mapApplicationToTemplate(formData)

    // 5. Choose DOCX template
    let templatePath = "templates/2025_new_business_form_template_with_tags_v2.docx"
    try {
      const appType = String(formData.applicationType ?? "").toLowerCase()
      if (swornOnly) {
        if (appType === "new") {
          templatePath = "templates/Sworn_Statement_of_Capital.docx"
        } else {
          templatePath = "templates/Sworn_Declaration_of_Gross_receipt.docx"
        }
      }
    } catch (tplErr) {
      console.error("Error determining templatePath, falling back to default:", tplErr)
    }
    console.log("Using DOCX template:", templatePath)

    let docxBuffer: Buffer
    try {
      const templateBuffer = await loadTemplateBuffer(templatePath, publicOrigin)
      docxBuffer = renderFromTemplateBuffer(templateBuffer, templateData)
    } catch (renderErr) {
      console.error("Error rendering DOCX template:", renderErr)
      return NextResponse.json(
        { error: "Template file not found on server", details: String(renderErr) },
        { status: 500 }
      )
    }

    // 6. Generate filename
    const businessName = formData.businessName || "Application"
    const sanitizedName = businessName.replace(/[^a-zA-Z0-9\s-]/g, "").trim()
    const fileName = `${sanitizedName}_Business_Application.docx`

    // 7. Return file as downloadable response
    // Convert Buffer to Uint8Array for NextResponse compatibility
    const uint8Array = new Uint8Array(docxBuffer)
    return new NextResponse(uint8Array, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Content-Length": String(docxBuffer.length),
      },
    })
  } catch (error) {
    // Log full error for server-side debugging
    console.error("DOCX export error:", error)

    // In development return error details to help debugging, in production return generic message
    const isDev = process.env.NODE_ENV !== "production"
    const payload: Record<string, unknown> = { error: "Failed to generate document" }
    if (isDev) {
      payload.details = (error instanceof Error) ? { message: error.message, stack: error.stack } : String(error)
    }

    return NextResponse.json(payload, { status: 500 })
  }
}
