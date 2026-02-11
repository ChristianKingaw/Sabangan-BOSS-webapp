import { ref, push, set, update, remove, serverTimestamp, query as dbQuery, orderByChild, equalTo, get } from "firebase/database"
import { realtimeDb } from "@/database/firebase"

const RAW_NAMESPACE =
  process.env.NEXT_PUBLIC_DATABASE_NAMESPACE ??
  process.env.NEXT_PUBLIC_FIREBASE_DATABASE_NAMESPACE ??
  "users/webapp"

export const ADMIN_COLLECTION = RAW_NAMESPACE.endsWith("/admin")
  ? RAW_NAMESPACE
  : `${RAW_NAMESPACE}/admin`

export type AdminRecord = {
  id: string
  firstName: string
  middleName?: string
  lastName: string
  email: string
  createdAt?: number | null
  createdByEmail?: string | null
  emailVerified?: boolean
}

export async function createAdminRecord(data: {
  firstName: string
  middleName?: string
  lastName: string
  email: string
  createdByEmail?: string | null
  emailVerified?: boolean
}) {
  const normalizedEmail = data.email.trim().toLowerCase()
  const adminCollectionRef = ref(realtimeDb, ADMIN_COLLECTION)
  const newAdminRef = push(adminCollectionRef)

  if (!newAdminRef.key) {
    throw new Error("Unable to create admin record. Please try again.")
  }

  const emailVerified = data.emailVerified ?? Boolean(data.createdByEmail)

  await set(newAdminRef, {
    ...data,
    email: normalizedEmail,
    emailVerified,
    createdAt: serverTimestamp(),
  })

  return newAdminRef.key
}

export async function findAdminByEmail(email: string) {
  const normalizedEmail = email.trim().toLowerCase()
  const adminRef = ref(realtimeDb, ADMIN_COLLECTION)
  const adminQuery = dbQuery(adminRef, orderByChild("email"), equalTo(normalizedEmail))
  const snapshot = await get(adminQuery)

  if (!snapshot.exists()) {
    return null
  }

  let adminId: string | null = null
  let adminData: AdminRecord | null = null

  snapshot.forEach((child) => {
    if (!adminId) {
      adminId = child.key
      adminData = child.val() as AdminRecord
      return true
    }
    return true
  })

  if (!adminId || !adminData) {
    return null
  }

  const a = adminData as AdminRecord

  return {
    id: adminId,
    firstName: a.firstName ?? "",
    middleName: a.middleName ?? undefined,
    lastName: a.lastName ?? "",
    email: a.email ?? normalizedEmail,
    createdAt: a.createdAt ?? null,
    createdByEmail: a.createdByEmail ?? null,
    emailVerified: a.emailVerified ?? Boolean(a.createdByEmail),
  }
}

export async function updateAdminRecord(adminId: string, updates: Partial<Omit<AdminRecord, "id">>) {
  const adminRef = ref(realtimeDb, `${ADMIN_COLLECTION}/${adminId}`)
  await update(adminRef, updates)
}

export async function deleteAdminRecord(adminId: string) {
  const adminRef = ref(realtimeDb, `${ADMIN_COLLECTION}/${adminId}`)
  await remove(adminRef)
}

export async function fetchAdminRecords() {
  const adminRef = ref(realtimeDb, ADMIN_COLLECTION)
  const snapshot = await get(adminRef)
  if (!snapshot.exists()) return [] as AdminRecord[]

  return Object.entries(snapshot.val() as Record<string, any>).map(([key, value]) => ({
    id: key,
    firstName: value?.firstName ?? "",
    middleName: value?.middleName ?? undefined,
    lastName: value?.lastName ?? "",
    email: value?.email ?? "",
    createdAt: value?.createdAt ?? null,
    createdByEmail: value?.createdByEmail ?? null,
    emailVerified: value?.emailVerified ?? Boolean(value?.createdByEmail),
  }))
}
