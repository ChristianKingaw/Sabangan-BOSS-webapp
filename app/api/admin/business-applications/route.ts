import { NextRequest, NextResponse } from "next/server"
import { adminAuth, adminDb } from "@/lib/firebase-admin"
import { BUSINESS_APPLICATION_PATH, normalizeBusinessApplication } from "@/lib/business-applications"
import { MAYORS_CLEARANCE_APPLICATION_PATH, normalizeClearanceApplicant } from "@/lib/clearance-applications"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const revalidate = 0

const RAW_NAMESPACE =
  process.env.NEXT_PUBLIC_DATABASE_NAMESPACE ??
  process.env.NEXT_PUBLIC_FIREBASE_DATABASE_NAMESPACE ??
  "users/webapp"

const resolveBaseNamespace = () => {
  const trimmed = RAW_NAMESPACE.replace(/\/+$/, "")
  if (trimmed.endsWith("/staff")) return trimmed.slice(0, -"/staff".length)
  if (trimmed.endsWith("/treasury")) return trimmed.slice(0, -"/treasury".length)
  if (trimmed.endsWith("/admin")) return trimmed.slice(0, -"/admin".length)
  return trimmed
}

const BASE_NAMESPACE = resolveBaseNamespace()
const ADMIN_COLLECTION = `${BASE_NAMESPACE}/admin`

const normalizeString = (value: unknown) => (typeof value === "string" ? value.trim() : "")

const getAuthToken = (request: NextRequest) => {
  const authHeader = request.headers.get("Authorization")
  if (!authHeader?.startsWith("Bearer ")) {
    return null
  }
  return authHeader.slice(7).trim() || null
}

const isAdminAuthorized = async (uid: string, email: string) => {
  if (!uid) return false

  const rootAdminSnapshot = await adminDb.ref(`admins/${uid}`).get()
  if (rootAdminSnapshot.val() === true) {
    return true
  }

  const normalizedEmail = email.trim().toLowerCase()
  if (!normalizedEmail) {
    return false
  }

  const emailSnapshot = await adminDb
    .ref(ADMIN_COLLECTION)
    .orderByChild("email")
    .equalTo(normalizedEmail)
    .limitToFirst(1)
    .get()

  return emailSnapshot.exists()
}

const requireAdmin = async (request: NextRequest) => {
  const idToken = getAuthToken(request)
  if (!idToken) {
    return { error: NextResponse.json({ error: "Missing or invalid Authorization header." }, { status: 401 }) }
  }

  try {
    const decoded = await adminAuth.verifyIdToken(idToken)
    const userEmail = normalizeString(decoded.email).toLowerCase()
    const allowed = await isAdminAuthorized(decoded.uid, userEmail)
    if (!allowed) {
      return { error: NextResponse.json({ error: "Forbidden." }, { status: 403 }) }
    }

    return {
      admin: {
        uid: decoded.uid,
        email: userEmail,
      },
    }
  } catch {
    return { error: NextResponse.json({ error: "Invalid token." }, { status: 401 }) }
  }
}

const parseBody = async (request: NextRequest) => {
  try {
    const body = (await request.json()) as Record<string, unknown>
    return { body }
  } catch {
    return { error: NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 }) }
  }
}

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request)
  if (auth.error) {
    return auth.error
  }

  const [businessSnapshot, clearanceSnapshot] = await Promise.all([
    adminDb.ref(BUSINESS_APPLICATION_PATH).get(),
    adminDb.ref(MAYORS_CLEARANCE_APPLICATION_PATH).get(),
  ])

  const businessApplications = businessSnapshot.exists()
    ? Object.entries(businessSnapshot.val() as Record<string, any>).map(([id, payload]) => {
      const normalized = normalizeBusinessApplication(id, payload)
      return {
        key: `business:${normalized.id}`,
        source: "business" as const,
        id: normalized.id,
        applicantUid: normalized.applicantUid ?? null,
        applicantName: normalized.applicantName,
        businessName: normalized.businessName,
        applicationType: normalized.applicationType,
        purpose: "Business",
        status: normalized.overallStatus || normalized.status || "",
        applicationDate: normalized.applicationDate || null,
        submittedAt: normalized.submittedAt ?? null,
      }
    })
    : []

  const clearanceApplications = (() => {
    if (!clearanceSnapshot.exists()) return [] as Array<{
      key: string
      source: "mayors_clearance"
      id: string
      applicantUid: string
      applicantName: string
      businessName: string
      applicationType: string
      purpose: string
      status: string
      applicationDate: string | number | null
      submittedAt: number | null
    }>

    const rows: Array<{
      key: string
      source: "mayors_clearance"
      id: string
      applicantUid: string
      applicantName: string
      businessName: string
      applicationType: string
      purpose: string
      status: string
      applicationDate: string | number | null
      submittedAt: number | null
    }> = []

    const byApplicant = clearanceSnapshot.val() as Record<string, Record<string, any>>
    Object.entries(byApplicant).forEach(([applicantUid, applications]) => {
      Object.entries(applications ?? {}).forEach(([applicationId, payload]) => {
        const normalizedPayload = {
          ...(payload ?? {}),
          meta: { applicantUid, ...((payload as any)?.meta ?? {}) },
        }
        const normalized = normalizeClearanceApplicant(applicationId, normalizedPayload)
        rows.push({
          key: `mayors_clearance:${applicantUid}:${normalized.id}`,
          source: "mayors_clearance",
          id: normalized.id,
          applicantUid: normalized.applicantUid || applicantUid,
          applicantName: normalized.applicantName || "Unnamed Applicant",
          businessName: String(normalized.form?.businessName ?? ""),
          applicationType: "Mayor's Clearance",
          purpose: normalized.purpose || "Mayor's Clearance",
          status: normalized.overallStatus || normalized.status || "",
          applicationDate: normalized.applicationDate ?? null,
          submittedAt: normalized.submittedAt ?? null,
        })
      })
    })

    return rows
  })()

  const applications = [...businessApplications, ...clearanceApplications]
    .sort((a, b) => (b.submittedAt ?? 0) - (a.submittedAt ?? 0))

  return NextResponse.json({ applications })
}

export async function DELETE(request: NextRequest) {
  const auth = await requireAdmin(request)
  if (auth.error) {
    return auth.error
  }

  const parsed = await parseBody(request)
  if (parsed.error) {
    return parsed.error
  }

  const singleId = normalizeString(parsed.body.id)
  const idsFromArray = Array.isArray(parsed.body.ids)
    ? parsed.body.ids.map((value) => normalizeString(value)).filter(Boolean)
    : []
  const legacyBusinessIds = Array.from(new Set([singleId, ...idsFromArray].filter(Boolean)))

  const typedApplications = Array.isArray(parsed.body.applications)
    ? parsed.body.applications
        .map((value) => {
          const source = normalizeString((value as any)?.source)
          const id = normalizeString((value as any)?.id)
          const applicantUid = normalizeString((value as any)?.applicantUid)
          return {
            source,
            id,
            applicantUid,
          }
        })
        .filter((item) => Boolean(item.source) && Boolean(item.id))
    : []

  if (legacyBusinessIds.length === 0 && typedApplications.length === 0) {
    return NextResponse.json({ error: "Application id is required." }, { status: 400 })
  }

  const deleteTasks: Array<Promise<void>> = []

  legacyBusinessIds.forEach((id) => {
    deleteTasks.push(adminDb.ref(`${BUSINESS_APPLICATION_PATH}/${id}`).remove())
  })

  typedApplications.forEach((item) => {
    if (item.source === "business") {
      deleteTasks.push(adminDb.ref(`${BUSINESS_APPLICATION_PATH}/${item.id}`).remove())
      return
    }

    if (item.source === "mayors_clearance" && item.applicantUid) {
      deleteTasks.push(adminDb.ref(`${MAYORS_CLEARANCE_APPLICATION_PATH}/${item.applicantUid}/${item.id}`).remove())
    }
  })

  await Promise.all(deleteTasks)

  return NextResponse.json({
    success: true,
    deleted: {
      legacyBusinessIds,
      typedApplications,
    },
  })
}
