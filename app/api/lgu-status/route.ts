import { NextRequest, NextResponse } from "next/server"
import { adminAuth, adminDb } from "@/lib/firebase-admin"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const revalidate = 0

const STATUS_BOARD_PATH = "lgu_sabangan_status/statusBoard"
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
const STAFF_COLLECTION = `${BASE_NAMESPACE}/staff`
const ADMIN_COLLECTION = `${BASE_NAMESPACE}/admin`

const MUNICIPALITY_FIELDS = ["isOpen", "officeHours", "publicNote", "lastUpdatedAt", "lastUpdatedBy"] as const
const MAYOR_FIELDS = ["availability", "expectedBack", "note"] as const
const FEATURED_EVENT_FIELDS = [
  "enabled",
  "title",
  "subtitle",
  "date",
  "time",
  "location",
  "details",
  "category",
  "bannerUrl",
  "updatedAt",
  "updatedBy",
] as const
const UPCOMING_EVENT_FIELDS = ["title", "date", "time", "location", "category", "details"] as const

type ActionBody =
  | { action: "saveMunicipalityStatus"; payload: Record<string, unknown> }
  | { action: "saveMayorStatus"; payload: Record<string, unknown> }
  | { action: "saveFeaturedEvent"; payload: Record<string, unknown> }
  | { action: "addUpcomingEvent"; payload: Record<string, unknown> }
  | { action: "updateUpcomingEvent"; eventId: string; payload: Record<string, unknown> }
  | { action: "deleteUpcomingEvent"; eventId: string }

const toTrimmedString = (value: unknown) => (typeof value === "string" ? value.trim() : "")

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value)

const pickFields = <T extends readonly string[]>(source: unknown, fields: T) => {
  if (!isRecord(source)) return {} as Partial<Record<T[number], unknown>>
  const next: Partial<Record<T[number], unknown>> = {}
  for (const field of fields) {
    const key = field as T[number]
    if (Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined) {
      next[key] = source[key]
    }
  }
  return next
}

const isLikelyActive = (value: Record<string, unknown>) => {
  const status = toTrimmedString(value.status).toLowerCase()
  return !status || !["inactive", "disabled", "suspended"].includes(status)
}

const hasRoleRecordByEmail = async (path: string, email: string) => {
  if (!email) {
    console.log(`[LGU Status] hasRoleRecordByEmail: No email provided`)
    return false
  }

  console.log(`[LGU Status] hasRoleRecordByEmail: Checking ${path} for email "${email}"`)

  // Try indexed query first
  try {
    const snapshot = await adminDb.ref(path).orderByChild("email").equalTo(email).limitToFirst(1).get()
    console.log(`[LGU Status] Indexed query for ${path}: exists=${snapshot.exists()}`)
    if (snapshot.exists()) {
      let activeMatch = false
      snapshot.forEach((child) => {
        const value = (child.val() ?? {}) as Record<string, unknown>
        console.log(`[LGU Status] Found record ${child.key}: status="${value.status}", email="${value.email}"`)
        if (isLikelyActive(value)) {
          console.log(`[LGU Status] Record ${child.key} is active!`)
          activeMatch = true
          return true
        }
        return false
      })
      if (activeMatch) return true
    }
  } catch (indexErr) {
    // Index might not exist - fallback to manual scan
    console.warn(`[LGU Status] Index query failed for ${path}, falling back to scan:`, indexErr)
  }

  // Fallback: fetch all records and filter manually (for missing indexes)
  try {
    console.log(`[LGU Status] Running fallback scan for ${path}`)
    const allSnapshot = await adminDb.ref(path).get()
    if (!allSnapshot.exists()) {
      console.log(`[LGU Status] Fallback: ${path} has no data`)
      return false
    }

    let found = false
    allSnapshot.forEach((child) => {
      const value = (child.val() ?? {}) as Record<string, unknown>
      const recordEmail = toTrimmedString(value.email).toLowerCase()
      console.log(`[LGU Status] Fallback scan: ${child.key} has email "${recordEmail}"`)
      if (recordEmail === email && isLikelyActive(value)) {
        console.log(`[LGU Status] Fallback: FOUND matching active record ${child.key}!`)
        found = true
        return true
      }
      return false
    })
    return found
  } catch (scanErr) {
    console.error(`[LGU Status] Failed to scan ${path}:`, scanErr)
    return false
  }
}

const hasRoleRecordByUid = async (path: string, uid: string) => {
  if (!uid) return false

  try {
    // First check if record exists directly at path/uid
    const directSnapshot = await adminDb.ref(`${path}/${uid}`).get()
    if (directSnapshot.exists()) {
      const value = (directSnapshot.val() ?? {}) as Record<string, unknown>
      if (isLikelyActive(value)) {
        console.log(`[LGU Status] Found active record at ${path}/${uid}`)
        return true
      }
    }
  } catch (directErr) {
    console.warn(`[LGU Status] Direct uid lookup failed for ${path}/${uid}:`, directErr)
  }

  // Skip the indexed query for uid - most records don't have uid field anyway
  // and Firebase throws errors about missing indexes
  console.log(`[LGU Status] hasRoleRecordByUid: No direct match for ${uid} at ${path}`)
  return false
}

const isMobileAppUser = async (uid: string) => {
  if (!uid) return false
  const snapshot = await adminDb.ref(`users/mobileApp/${uid}`).get()
  return snapshot.exists()
}

const isAllowedEditor = async (uid: string, email: string) => {
  if (!uid) {
    console.warn("[LGU Status] isAllowedEditor: No uid provided")
    return false
  }

  // Check root admin
  const rootAdminSnapshot = await adminDb.ref(`admins/${uid}`).get()
  if (rootAdminSnapshot.val() === true) {
    console.log(`[LGU Status] User ${email} (${uid}) authorized as root admin`)
    return true
  }

  const [isStaffByEmail, isAdminByEmail, isStaffByUid, isAdminByUid] = await Promise.all([
    hasRoleRecordByEmail(STAFF_COLLECTION, email),
    hasRoleRecordByEmail(ADMIN_COLLECTION, email),
    hasRoleRecordByUid(STAFF_COLLECTION, uid),
    hasRoleRecordByUid(ADMIN_COLLECTION, uid),
  ])

  console.log(`[LGU Status] Authorization check for ${email} (${uid}):`, {
    isStaffByEmail,
    isAdminByEmail,
    isStaffByUid,
    isAdminByUid,
    staffPath: STAFF_COLLECTION,
    adminPath: ADMIN_COLLECTION,
  })

  if (isStaffByEmail || isAdminByEmail || isStaffByUid || isAdminByUid) {
    return true
  }

  // Fallback for legacy web accounts that are authenticated but do not have uid/email
  // normalized in webapp role nodes yet. Keep mobile users excluded.
  const mobileUser = await isMobileAppUser(uid)
  console.log(`[LGU Status] Fallback check for ${email}: isMobileUser=${mobileUser}, allowing=${!mobileUser}`)
  return !mobileUser
}

const getAuthToken = (request: NextRequest) => {
  const authHeader = request.headers.get("Authorization")
  if (!authHeader?.startsWith("Bearer ")) return null
  return authHeader.slice(7).trim() || null
}

const requireEditor = async (request: NextRequest) => {
  const idToken = getAuthToken(request)
  if (!idToken) {
    console.warn("[LGU Status] Missing or invalid Authorization header")
    return { error: NextResponse.json({ error: "Missing or invalid Authorization header." }, { status: 401 }) }
  }

  try {
    const decoded = await adminAuth.verifyIdToken(idToken)
    const uid = toTrimmedString(decoded.uid)
    const email = toTrimmedString(decoded.email).toLowerCase()
    console.log(`[LGU Status] Token verified for ${email} (${uid})`)
    const allowed = await isAllowedEditor(uid, email)
    if (!allowed) {
      console.warn(`[LGU Status] User ${email} (${uid}) is forbidden from editing`)
      return { error: NextResponse.json({ error: "Forbidden." }, { status: 403 }) }
    }
    return { uid, email }
  } catch (tokenErr) {
    console.error("[LGU Status] Token verification failed:", tokenErr)
    return { error: NextResponse.json({ error: "Invalid token." }, { status: 401 }) }
  }
}

const parseBody = async (request: NextRequest) => {
  try {
    return (await request.json()) as ActionBody
  } catch {
    return null
  }
}

const assertEventId = (value: unknown) => {
  const eventId = toTrimmedString(value)
  return eventId.length > 0 ? eventId : null
}

export async function POST(request: NextRequest) {
  const editor = await requireEditor(request)
  if ("error" in editor) {
    return editor.error
  }

  const body = await parseBody(request)
  if (!body?.action) {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 })
  }

  try {
    switch (body.action) {
      case "saveMunicipalityStatus": {
        const payload = pickFields(body.payload, MUNICIPALITY_FIELDS)
        await adminDb.ref(`${STATUS_BOARD_PATH}/municipality`).update(payload)
        return NextResponse.json({ success: true })
      }
      case "saveMayorStatus": {
        const payload = pickFields(body.payload, MAYOR_FIELDS)
        await adminDb.ref(`${STATUS_BOARD_PATH}/mayor`).update(payload)
        return NextResponse.json({ success: true })
      }
      case "saveFeaturedEvent": {
        const payload = pickFields(body.payload, FEATURED_EVENT_FIELDS)
        await adminDb.ref(`${STATUS_BOARD_PATH}/featuredEvent`).update(payload)
        return NextResponse.json({ success: true })
      }
      case "addUpcomingEvent": {
        const payload = pickFields(body.payload, UPCOMING_EVENT_FIELDS)
        const title = toTrimmedString(payload.title)
        const date = toTrimmedString(payload.date)
        if (!title || !date) {
          return NextResponse.json({ error: "Upcoming events require both title and date." }, { status: 400 })
        }
        const eventsRef = adminDb.ref(`${STATUS_BOARD_PATH}/upcomingEvents`)
        const newEventRef = eventsRef.push()
        if (!newEventRef.key) {
          return NextResponse.json({ error: "Unable to create event entry." }, { status: 500 })
        }
        await newEventRef.set(payload)
        return NextResponse.json({ id: newEventRef.key })
      }
      case "updateUpcomingEvent": {
        const eventId = assertEventId(body.eventId)
        if (!eventId) {
          return NextResponse.json({ error: "Missing eventId." }, { status: 400 })
        }
        const payload = pickFields(body.payload, UPCOMING_EVENT_FIELDS)
        await adminDb.ref(`${STATUS_BOARD_PATH}/upcomingEvents/${eventId}`).update(payload)
        return NextResponse.json({ success: true })
      }
      case "deleteUpcomingEvent": {
        const eventId = assertEventId(body.eventId)
        if (!eventId) {
          return NextResponse.json({ error: "Missing eventId." }, { status: 400 })
        }
        await adminDb.ref(`${STATUS_BOARD_PATH}/upcomingEvents/${eventId}`).remove()
        return new NextResponse(null, { status: 204 })
      }
      default:
        return NextResponse.json({ error: "Unsupported action." }, { status: 400 })
    }
  } catch (error) {
    console.error("LGU status write action failed", error)
    return NextResponse.json({ error: "Failed to save LGU status changes." }, { status: 500 })
  }
}
