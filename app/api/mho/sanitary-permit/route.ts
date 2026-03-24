import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { adminAuth, adminDb } from "@/lib/firebase-admin"
import { BUSINESS_APPLICATION_PATH } from "@/lib/business-applications"
import { loadTemplateBuffer } from "@/lib/docx/loadTemplateBuffer"
import renderMergeFields from "@/lib/docx/renderMergeFields"
import { mapSanitaryPermitToTemplate } from "@/lib/export/mapSanitaryPermitToTemplate"
import { getRequestPublicOrigin } from "@/lib/http/getRequestPublicOrigin"
import { fetchLatestTreasuryAssessmentByClientUid } from "@/lib/treasury-assessment"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const revalidate = 0

const TEMPLATE_PATH = "templates/sanitary_permit.docx"

const RAW_NAMESPACE =
  process.env.NEXT_PUBLIC_DATABASE_NAMESPACE ??
  process.env.NEXT_PUBLIC_FIREBASE_DATABASE_NAMESPACE ??
  "users/webapp"

const resolveBaseNamespace = () => {
  const trimmed = RAW_NAMESPACE.replace(/\/+$/, "")
  if (trimmed.endsWith("/staff")) return trimmed.slice(0, -"/staff".length)
  if (trimmed.endsWith("/treasury")) return trimmed.slice(0, -"/treasury".length)
  if (trimmed.endsWith("/admin")) return trimmed.slice(0, -"/admin".length)
  if (trimmed.endsWith("/mho")) return trimmed.slice(0, -"/mho".length)
  return trimmed
}

const BASE_NAMESPACE = resolveBaseNamespace()
const MHO_COLLECTION = `${BASE_NAMESPACE}/mho`
const ADMIN_COLLECTION = `${BASE_NAMESPACE}/admin`
const STAFF_COLLECTION = `${BASE_NAMESPACE}/staff`

const RequestSchema = z.object({
  applicationId: z.string().min(1, "Application ID is required"),
})

const normalizeString = (value: unknown) => (typeof value === "string" ? value.trim() : "")

const getAuthToken = (request: NextRequest) => {
  const authHeader = request.headers.get("Authorization")
  if (!authHeader?.startsWith("Bearer ")) return null
  return authHeader.slice(7).trim() || null
}

const hasRoleRecordByEmail = async (path: string, email: string) => {
  if (!email) return false

  try {
    const indexedSnapshot = await adminDb.ref(path).orderByChild("email").equalTo(email).limitToFirst(1).get()
    if (indexedSnapshot.exists()) return true
  } catch {
    // Missing indexes or malformed data should not hard-fail permit generation.
  }

  try {
    const snapshot = await adminDb.ref(path).get()
    if (!snapshot.exists()) return false
    let found = false
    snapshot.forEach((child) => {
      const value = (child.val() ?? {}) as Record<string, unknown>
      const rowEmail = normalizeString(value.email).toLowerCase()
      if (rowEmail === email) {
        found = true
        return true
      }
      return false
    })
    return found
  } catch {
    return false
  }
}

const isMhoAuthorized = async (uid: string, email: string) => {
  if (!uid) return false

  const rootAdminSnapshot = await adminDb.ref(`admins/${uid}`).get()
  if (rootAdminSnapshot.val() === true) return true

  const normalizedEmail = email.trim().toLowerCase()
  if (!normalizedEmail) return false

  const [isMho, isAdmin, isStaff] = await Promise.all([
    hasRoleRecordByEmail(MHO_COLLECTION, normalizedEmail),
    hasRoleRecordByEmail(ADMIN_COLLECTION, normalizedEmail),
    hasRoleRecordByEmail(STAFF_COLLECTION, normalizedEmail),
  ])

  return isMho || isAdmin || isStaff
}

const requireMho = async (request: NextRequest) => {
  const idToken = getAuthToken(request)
  if (!idToken) {
    return { error: NextResponse.json({ error: "Missing or invalid Authorization header." }, { status: 401 }) }
  }

  try {
    const decoded = await adminAuth.verifyIdToken(idToken)
    const email = normalizeString(decoded.email).toLowerCase()
    const allowed = await isMhoAuthorized(decoded.uid, email)
    if (!allowed) {
      return { error: NextResponse.json({ error: "Forbidden." }, { status: 403 }) }
    }

    return {
      user: {
        uid: decoded.uid,
        email,
      },
    }
  } catch {
    return { error: NextResponse.json({ error: "Invalid token." }, { status: 401 }) }
  }
}

const toSafeFileSegment = (value: string) =>
  value
    .trim()
    .replace(/[^\w.-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")

export async function POST(request: NextRequest) {
  try {
    const auth = await requireMho(request)
    if ("error" in auth) {
      return auth.error
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 })
    }

    const parsed = RequestSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request body.", details: parsed.error.flatten() },
        { status: 400 }
      )
    }

    const { applicationId } = parsed.data
    const applicationSnapshot = await adminDb.ref(`${BUSINESS_APPLICATION_PATH}/${applicationId}`).get()
    if (!applicationSnapshot.exists()) {
      return NextResponse.json({ error: "Business application not found." }, { status: 404 })
    }

    const applicationPayload = (applicationSnapshot.val() ?? {}) as Record<string, unknown>
    const form = (applicationPayload.form ?? {}) as Record<string, unknown>

    const applicantUid = normalizeString(
      form.applicantUid ??
        ((applicationPayload.meta as Record<string, unknown> | undefined)?.applicantUid ?? "")
    )

    let treasuryAssessment = null
    try {
      treasuryAssessment = await fetchLatestTreasuryAssessmentByClientUid(adminDb, [
        applicationId,
        applicantUid,
      ])
    } catch (treasuryErr) {
      console.warn("Failed to load treasury assessment for sanitary permit", treasuryErr)
    }

    const sanitaryFee = treasuryAssessment?.fees?.sanitary_inspection_fee
    const sanitaryFeePaid = Boolean(sanitaryFee && Number(sanitaryFee.total) > 0)
    if (!sanitaryFeePaid) {
      return NextResponse.json({ error: "Sanitary inspection fee has not been paid." }, { status: 400 })
    }

    const mergeFields = mapSanitaryPermitToTemplate(form)
    const publicOrigin = getRequestPublicOrigin(request)
    const templateBuffer = await loadTemplateBuffer(TEMPLATE_PATH, publicOrigin)
    const renderedBuffer = renderMergeFields.renderMergeFieldsTemplateBuffer(templateBuffer, mergeFields)

    const businessName = toSafeFileSegment(mergeFields.businessName) || "business"
    const fileName = `sanitary_permit_${businessName}.docx`

    return new NextResponse(new Uint8Array(renderedBuffer), {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Content-Length": String(renderedBuffer.length),
      },
    })
  } catch (error) {
    console.error("Sanitary permit generation failed", error)
    return NextResponse.json({ error: "Failed to generate sanitary permit document." }, { status: 500 })
  }
}
