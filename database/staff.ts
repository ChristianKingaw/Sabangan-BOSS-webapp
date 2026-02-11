import { ref, push, set, update, serverTimestamp, query as dbQuery, orderByChild, equalTo, get } from "firebase/database"
import { realtimeDb } from "@/database/firebase"

const RAW_NAMESPACE =
  process.env.NEXT_PUBLIC_DATABASE_NAMESPACE ??
  process.env.NEXT_PUBLIC_FIREBASE_DATABASE_NAMESPACE ??
  "users/webapp"
const STAFF_COLLECTION = RAW_NAMESPACE.endsWith("/staff")
  ? RAW_NAMESPACE
  : `${RAW_NAMESPACE}/staff`

export type StaffRecord = {
  id: string
  firstName: string
  middleName?: string
  lastName: string
  email: string
  passwordHash: string
  createdAt?: number | null
  createdByEmail?: string | null
  emailVerified?: boolean
}

export async function createStaffRecord(data: {
  firstName: string
  middleName?: string
  lastName: string
  email: string
  passwordHash: string
  createdByEmail?: string | null
  emailVerified?: boolean
}) {
  const normalizedEmail = data.email.trim().toLowerCase()
  const staffCollectionRef = ref(realtimeDb, STAFF_COLLECTION)
  const newStaffRef = push(staffCollectionRef)

  if (!newStaffRef.key) {
    throw new Error("Unable to create staff record. Please try again.")
  }

  const emailVerified = data.emailVerified ?? Boolean(data.createdByEmail)

  await set(newStaffRef, {
    ...data,
    email: normalizedEmail,
    emailVerified,
    createdAt: serverTimestamp(),
  })

  return newStaffRef.key
}

export async function findStaffByEmail(email: string) {
  const normalizedEmail = email.trim().toLowerCase()
  const staffRef = ref(realtimeDb, STAFF_COLLECTION)
  const staffQuery = dbQuery(staffRef, orderByChild("email"), equalTo(normalizedEmail))
  const snapshot = await get(staffQuery)

  if (!snapshot.exists()) {
    return null
  }

  let staffId: string | null = null
  let staffData: StaffRecord | null = null

  snapshot.forEach((child) => {
    if (!staffId) {
      staffId = child.key
      staffData = child.val() as StaffRecord
      return true
    }
    return true
  })

  if (!staffId || !staffData) {
    return null
  }

  const s = staffData as StaffRecord

  return {
    id: staffId,
    firstName: s.firstName ?? "",
    middleName: s.middleName ?? undefined,
    lastName: s.lastName ?? "",
    email: s.email ?? normalizedEmail,
    passwordHash: s.passwordHash ?? "",
    createdAt: s.createdAt ?? null,
    createdByEmail: s.createdByEmail ?? null,
    emailVerified: s.emailVerified ?? Boolean(s.createdByEmail),
  }
}

export async function updateStaffEmailVerificationStatus(staffId: string, emailVerified: boolean) {
  const staffRef = ref(realtimeDb, `${STAFF_COLLECTION}/${staffId}`)
  await update(staffRef, { emailVerified })
}
