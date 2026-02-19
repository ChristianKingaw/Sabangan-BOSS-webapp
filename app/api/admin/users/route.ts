import { createHash } from "crypto"
import { NextRequest, NextResponse } from "next/server"
import { adminAuth, adminDb, adminServerValue } from "@/lib/firebase-admin"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const revalidate = 0

type ManagedRole = "staff" | "treasury"

const MANAGED_ROLES = new Set<ManagedRole>(["staff", "treasury"])
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

const normalizeOptionalString = (value: unknown) => {
  const normalized = normalizeString(value)
  return normalized.length > 0 ? normalized : null
}

const normalizeBoolean = (value: unknown, fallback: boolean) => {
  if (typeof value === "boolean") return value
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase()
    if (["true", "1", "yes", "y"].includes(lower)) return true
    if (["false", "0", "no", "n"].includes(lower)) return false
  }
  return fallback
}

const passwordToHash = (password: string) => createHash("sha256").update(password).digest("hex")

const roleFromValue = (value: unknown): ManagedRole | null => {
  const normalized = normalizeString(value).toLowerCase()
  if (!MANAGED_ROLES.has(normalized as ManagedRole)) {
    return null
  }
  return normalized as ManagedRole
}

const rolePath = (role: ManagedRole) => `${BASE_NAMESPACE}/${role}`

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

const getAuthToken = (request: NextRequest) => {
  const authHeader = request.headers.get("Authorization")
  if (!authHeader?.startsWith("Bearer ")) {
    return null
  }
  return authHeader.slice(7).trim() || null
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

const getRoleRecordByEmail = async (role: ManagedRole, normalizedEmail: string) => {
  if (!normalizedEmail) return null

  const snapshot = await adminDb
    .ref(rolePath(role))
    .orderByChild("email")
    .equalTo(normalizedEmail)
    .limitToFirst(1)
    .get()

  if (!snapshot.exists()) {
    return null
  }

  let id: string | null = null
  let value: Record<string, unknown> | null = null
  snapshot.forEach((child) => {
    if (!id) {
      id = child.key
      value = (child.val() ?? {}) as Record<string, unknown>
    }
    return true
  })

  if (!id || !value) {
    return null
  }

  return { id, value }
}

const getRoleRecordById = async (role: ManagedRole, id: string) => {
  const snapshot = await adminDb.ref(`${rolePath(role)}/${id}`).get()
  if (!snapshot.exists()) {
    return null
  }
  return {
    id,
    value: (snapshot.val() ?? {}) as Record<string, unknown>,
  }
}

const normalizeManagedRecord = (id: string, value: Record<string, unknown>) => ({
  id,
  firstName: normalizeString(value.firstName),
  middleName: normalizeOptionalString(value.middleName),
  lastName: normalizeString(value.lastName),
  email: normalizeString(value.email).toLowerCase(),
  status: normalizeOptionalString(value.status),
  emailVerified: normalizeBoolean(value.emailVerified, false),
  uid: normalizeOptionalString(value.uid),
  createdAt: typeof value.createdAt === "number" ? value.createdAt : null,
  updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : null,
})

const parseBody = async (request: NextRequest) => {
  try {
    const body = (await request.json()) as Record<string, unknown>
    return { body }
  } catch {
    return { error: NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 }) }
  }
}

const listRoleRecords = async (role: ManagedRole) => {
  const snapshot = await adminDb.ref(rolePath(role)).get()
  if (!snapshot.exists()) {
    return [] as ReturnType<typeof normalizeManagedRecord>[]
  }

  const node = snapshot.val() as Record<string, Record<string, unknown>>
  return Object.entries(node)
    .map(([id, value]) => normalizeManagedRecord(id, value ?? {}))
    .sort((a, b) => {
      const left = `${a.lastName} ${a.firstName}`.trim().toLowerCase()
      const right = `${b.lastName} ${b.firstName}`.trim().toLowerCase()
      return left.localeCompare(right)
    })
}

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request)
  if (auth.error) {
    return auth.error
  }

  const requestedRole = roleFromValue(request.nextUrl.searchParams.get("role"))
  if (request.nextUrl.searchParams.has("role") && !requestedRole) {
    return NextResponse.json({ error: "Invalid role. Use staff or treasury." }, { status: 400 })
  }

  if (requestedRole) {
    const users = await listRoleRecords(requestedRole)
    return NextResponse.json({ role: requestedRole, users })
  }

  const [staffUsers, treasuryUsers] = await Promise.all([listRoleRecords("staff"), listRoleRecords("treasury")])

  return NextResponse.json({
    staff: staffUsers,
    treasury: treasuryUsers,
  })
}

export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request)
  if (auth.error) {
    return auth.error
  }

  const parsed = await parseBody(request)
  if (parsed.error) {
    return parsed.error
  }

  const role = roleFromValue(parsed.body.role)
  if (!role) {
    return NextResponse.json({ error: "Role is required. Use staff or treasury." }, { status: 400 })
  }

  const firstName = normalizeString(parsed.body.firstName)
  const middleName = normalizeOptionalString(parsed.body.middleName)
  const lastName = normalizeString(parsed.body.lastName)
  const email = normalizeString(parsed.body.email).toLowerCase()
  const password = normalizeString(parsed.body.password)
  const status = normalizeOptionalString(parsed.body.status) ?? "active"
  const emailVerified = normalizeBoolean(parsed.body.emailVerified, true)

  if (!firstName || !lastName || !email || !password) {
    return NextResponse.json(
      { error: "First name, last name, email, and password are required." },
      { status: 400 }
    )
  }

  const existingRoleUser = await getRoleRecordByEmail(role, email)
  if (existingRoleUser) {
    return NextResponse.json({ error: "A user with this email already exists in this role." }, { status: 409 })
  }

  let createdAuthUser
  try {
    createdAuthUser = await adminAuth.createUser({
      email,
      password,
      emailVerified,
      displayName: [firstName, lastName].filter(Boolean).join(" "),
    })
  } catch (error: any) {
    if (error?.code === "auth/email-already-exists") {
      return NextResponse.json({ error: "This email is already used in Firebase Auth." }, { status: 409 })
    }
    console.error("Failed to create auth user", error)
    return NextResponse.json({ error: "Failed to create Auth user." }, { status: 500 })
  }

  const collectionRef = adminDb.ref(rolePath(role))
  const newRef = collectionRef.push()

  if (!newRef.key) {
    try {
      await adminAuth.deleteUser(createdAuthUser.uid)
    } catch {}
    return NextResponse.json({ error: "Failed to allocate a user ID." }, { status: 500 })
  }

  await newRef.set({
    firstName,
    ...(middleName ? { middleName } : {}),
    lastName,
    email,
    passwordHash: passwordToHash(password),
    status,
    emailVerified,
    uid: createdAuthUser.uid,
    createdAt: adminServerValue.TIMESTAMP,
    createdByEmail: auth.admin?.email ?? null,
  })

  return NextResponse.json({
    role,
    user: {
      id: newRef.key,
      firstName,
      middleName,
      lastName,
      email,
      status,
      emailVerified,
      uid: createdAuthUser.uid,
    },
  })
}

export async function PATCH(request: NextRequest) {
  const auth = await requireAdmin(request)
  if (auth.error) {
    return auth.error
  }

  const parsed = await parseBody(request)
  if (parsed.error) {
    return parsed.error
  }

  const role = roleFromValue(parsed.body.role)
  if (!role) {
    return NextResponse.json({ error: "Role is required. Use staff or treasury." }, { status: 400 })
  }

  const id = normalizeString(parsed.body.id)
  if (!id) {
    return NextResponse.json({ error: "User id is required." }, { status: 400 })
  }

  const existing = await getRoleRecordById(role, id)
  if (!existing) {
    return NextResponse.json({ error: "User not found." }, { status: 404 })
  }

  const current = existing.value

  const firstName = parsed.body.firstName === undefined ? normalizeString(current.firstName) : normalizeString(parsed.body.firstName)
  const middleName =
    parsed.body.middleName === undefined
      ? normalizeOptionalString(current.middleName)
      : normalizeOptionalString(parsed.body.middleName)
  const lastName = parsed.body.lastName === undefined ? normalizeString(current.lastName) : normalizeString(parsed.body.lastName)
  const email =
    parsed.body.email === undefined
      ? normalizeString(current.email).toLowerCase()
      : normalizeString(parsed.body.email).toLowerCase()
  const status = parsed.body.status === undefined ? normalizeOptionalString(current.status) : normalizeOptionalString(parsed.body.status)
  const emailVerified =
    parsed.body.emailVerified === undefined
      ? normalizeBoolean(current.emailVerified, false)
      : normalizeBoolean(parsed.body.emailVerified, false)

  const newPassword = normalizeString(parsed.body.password)

  if (!firstName || !lastName || !email) {
    return NextResponse.json({ error: "First name, last name, and email are required." }, { status: 400 })
  }

  if (email !== normalizeString(current.email).toLowerCase()) {
    const duplicate = await getRoleRecordByEmail(role, email)
    if (duplicate && duplicate.id !== id) {
      return NextResponse.json({ error: "A user with this email already exists in this role." }, { status: 409 })
    }
  }

  let authUid = normalizeOptionalString(current.uid)
  const currentEmail = normalizeString(current.email).toLowerCase()

  if (!authUid && currentEmail) {
    try {
      const userByEmail = await adminAuth.getUserByEmail(currentEmail)
      authUid = userByEmail.uid
    } catch (error: any) {
      if (error?.code !== "auth/user-not-found") {
        console.error("Failed to look up auth user", error)
      }
    }
  }

  const authUpdates: Record<string, unknown> = {}
  if (email !== currentEmail) {
    authUpdates.email = email
  }
  if (newPassword) {
    authUpdates.password = newPassword
  }
  if (emailVerified !== normalizeBoolean(current.emailVerified, false)) {
    authUpdates.emailVerified = emailVerified
  }

  const currentDisplayName = [normalizeString(current.firstName), normalizeString(current.lastName)].filter(Boolean).join(" ")
  const newDisplayName = [firstName, lastName].filter(Boolean).join(" ")
  if (newDisplayName && newDisplayName !== currentDisplayName) {
    authUpdates.displayName = newDisplayName
  }

  if (Object.keys(authUpdates).length > 0) {
    if (authUid) {
      try {
        await adminAuth.updateUser(authUid, authUpdates)
      } catch (error: any) {
        if (error?.code === "auth/user-not-found") {
          authUid = null
        } else if (error?.code === "auth/email-already-exists") {
          return NextResponse.json({ error: "This email is already used in Firebase Auth." }, { status: 409 })
        } else {
          console.error("Failed to update auth user", error)
          return NextResponse.json({ error: "Failed to update Auth user." }, { status: 500 })
        }
      }
    }

    if (!authUid && newPassword) {
      try {
        const created = await adminAuth.createUser({
          email,
          password: newPassword,
          emailVerified,
          displayName: newDisplayName,
        })
        authUid = created.uid
      } catch (error: any) {
        if (error?.code === "auth/email-already-exists") {
          try {
            const existingAuth = await adminAuth.getUserByEmail(email)
            authUid = existingAuth.uid
          } catch {}
        } else {
          console.error("Failed to recreate missing auth user", error)
        }
      }
    }
  }

  const updates: Record<string, unknown> = {
    firstName,
    lastName,
    email,
    status,
    emailVerified,
    updatedAt: adminServerValue.TIMESTAMP,
    updatedByEmail: auth.admin?.email ?? null,
    middleName,
  }

  if (newPassword) {
    updates.passwordHash = passwordToHash(newPassword)
  }
  if (authUid) {
    updates.uid = authUid
  }

  await adminDb.ref(`${rolePath(role)}/${id}`).update(updates)

  return NextResponse.json({
    role,
    user: {
      id,
      firstName,
      middleName,
      lastName,
      email,
      status,
      emailVerified,
      uid: authUid,
    },
  })
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

  const role = roleFromValue(parsed.body.role)
  if (!role) {
    return NextResponse.json({ error: "Role is required. Use staff or treasury." }, { status: 400 })
  }

  const id = normalizeString(parsed.body.id)
  if (!id) {
    return NextResponse.json({ error: "User id is required." }, { status: 400 })
  }

  const existing = await getRoleRecordById(role, id)
  if (!existing) {
    return NextResponse.json({ error: "User not found." }, { status: 404 })
  }

  const existingUid = normalizeOptionalString(existing.value.uid)
  const existingEmail = normalizeString(existing.value.email).toLowerCase()

  await adminDb.ref(`${rolePath(role)}/${id}`).remove()

  let authUid = existingUid
  if (!authUid && existingEmail) {
    try {
      const byEmail = await adminAuth.getUserByEmail(existingEmail)
      authUid = byEmail.uid
    } catch {}
  }

  if (authUid) {
    try {
      await adminAuth.deleteUser(authUid)
    } catch (error: any) {
      if (error?.code !== "auth/user-not-found") {
        console.error("Failed to delete auth user", error)
      }
    }
  }

  return NextResponse.json({ success: true, role, id })
}
