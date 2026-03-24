import {
  equalTo,
  get,
  orderByChild,
  push,
  query as dbQuery,
  ref,
  set,
  update,
} from "firebase/database"
import { realtimeDb } from "@/database/firebase"

const RAW_NAMESPACE =
  process.env.NEXT_PUBLIC_DATABASE_NAMESPACE ??
  process.env.NEXT_PUBLIC_FIREBASE_DATABASE_NAMESPACE ??
  "users/webapp"

const MHO_COLLECTION = RAW_NAMESPACE.endsWith("/mho")
  ? RAW_NAMESPACE
  : `${RAW_NAMESPACE}/mho`

export type MhoRecord = {
  id: string
  firstName: string
  middleName?: string
  lastName: string
  email: string
  passwordHash: string
  uid?: string
  createdAt?: number | null
  createdByEmail?: string | null
  emailVerified?: boolean
}

export async function findMhoByEmail(email: string): Promise<MhoRecord | null> {
  const normalizedEmail = email.trim().toLowerCase()
  const mhoRef = ref(realtimeDb, MHO_COLLECTION)
  const mhoQuery = dbQuery(mhoRef, orderByChild("email"), equalTo(normalizedEmail))
  const snapshot = await get(mhoQuery)

  if (!snapshot.exists()) {
    return null
  }

  let mhoId: string | null = null
  let mhoData: MhoRecord | null = null

  snapshot.forEach((child) => {
    if (!mhoId) {
      mhoId = child.key
      mhoData = child.val() as MhoRecord
      return true
    }
    return true
  })

  if (!mhoId || !mhoData) {
    return null
  }

  const m = mhoData as MhoRecord

  return {
    id: mhoId,
    firstName: m.firstName ?? "",
    middleName: m.middleName ?? undefined,
    lastName: m.lastName ?? "",
    email: m.email ?? normalizedEmail,
    passwordHash: m.passwordHash ?? "",
    uid: m.uid ?? undefined,
    createdAt: m.createdAt ?? null,
    createdByEmail: m.createdByEmail ?? null,
    emailVerified: m.emailVerified ?? Boolean(m.createdByEmail),
  }
}

export async function createMhoRecord(data: {
  firstName: string
  middleName?: string
  lastName: string
  email: string
  passwordHash: string
  createdByEmail?: string | null
  emailVerified?: boolean
}): Promise<string> {
  const collectionRef = ref(realtimeDb, MHO_COLLECTION)
  const newRef = push(collectionRef)

  if (!newRef.key) {
    throw new Error("Unable to allocate MHO record UID.")
  }

  await set(newRef, {
    firstName: data.firstName,
    ...(data.middleName ? { middleName: data.middleName } : {}),
    lastName: data.lastName,
    email: data.email.trim().toLowerCase(),
    passwordHash: data.passwordHash,
    createdAt: Date.now(),
    createdByEmail: data.createdByEmail ?? null,
    emailVerified: data.emailVerified ?? false,
  })

  return newRef.key
}

export async function updateMhoEmailVerificationStatus(
  mhoId: string,
  emailVerified: boolean
): Promise<void> {
  const mhoRef = ref(realtimeDb, `${MHO_COLLECTION}/${mhoId}`)
  await update(mhoRef, { emailVerified })
}
