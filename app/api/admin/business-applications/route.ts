import { NextRequest, NextResponse } from "next/server"
import { adminAuth, adminDb } from "@/lib/firebase-admin"
import { BUSINESS_APPLICATION_PATH, normalizeBusinessApplication } from "@/lib/business-applications"

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

  const snapshot = await adminDb.ref(BUSINESS_APPLICATION_PATH).get()
  if (!snapshot.exists()) {
    return NextResponse.json({ applications: [] })
  }

  const node = snapshot.val() as Record<string, any>
  const applications = Object.entries(node)
    .map(([id, payload]) => {
      const normalized = normalizeBusinessApplication(id, payload)
      return {
        id: normalized.id,
        applicantName: normalized.applicantName,
        businessName: normalized.businessName,
        applicationType: normalized.applicationType,
        status: normalized.overallStatus || normalized.status || "",
        applicationDate: normalized.applicationDate || null,
        submittedAt: normalized.submittedAt ?? null,
      }
    })
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

  const ids = Array.from(new Set([singleId, ...idsFromArray].filter(Boolean)))
  if (ids.length === 0) {
    return NextResponse.json({ error: "Application id is required." }, { status: 400 })
  }

  await Promise.all(ids.map((id) => adminDb.ref(`${BUSINESS_APPLICATION_PATH}/${id}`).remove()))

  return NextResponse.json({ success: true, ids })
}
