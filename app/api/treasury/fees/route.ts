import { NextRequest, NextResponse } from "next/server"
import { adminAuth, adminDb } from "@/lib/firebase-admin"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const revalidate = 0

const TREASURY_FEES_PATH = "Treasury/fees"
const TREASURY_USERS_PATH = "users/webapp/treasury"

const normalizeOptionalString = (value: unknown) => (typeof value === "string" ? value.trim() : "")

const normalizeOptionalNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const parsed = Number(value.trim())
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

const normalizeFees = (value: unknown) => {
  const rows = value as Record<string, Record<string, unknown>>
  if (!rows || typeof rows !== "object") return {}

  const normalized: Record<string, { amount: number | null; penalty: number | null; total: number }> = {}
  Object.entries(rows).forEach(([key, line]) => {
    const amount = normalizeOptionalNumber(line?.amount)
    const penalty = normalizeOptionalNumber(line?.penalty)
    normalized[key] = {
      amount,
      penalty,
      total: normalizeOptionalNumber(line?.total) ?? (amount ?? 0) + (penalty ?? 0),
    }
  })
  return normalized
}

const normalizeAdditionalFees = (value: unknown) => {
  if (!Array.isArray(value)) return []

  return value
    .map((row) => {
      const line = row as Record<string, unknown>
      const amount = normalizeOptionalNumber(line?.amount)
      const penalty = normalizeOptionalNumber(line?.penalty)
      return {
        name: normalizeOptionalString(line?.name) || "Additional Fee",
        amount,
        penalty,
        total: normalizeOptionalNumber(line?.total) ?? (amount ?? 0) + (penalty ?? 0),
      }
    })
    .filter((row) => row.name || row.amount !== null || row.penalty !== null)
}

const isTreasuryAccount = async (email: string) => {
  const normalizedEmail = email.trim().toLowerCase()
  if (!normalizedEmail) return false
  const snapshot = await adminDb.ref(TREASURY_USERS_PATH).orderByChild("email").equalTo(normalizedEmail).get()
  return snapshot.exists()
}

export async function POST(request: NextRequest) {
  try {
    const authHeader = request.headers.get("Authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Missing or invalid Authorization header." }, { status: 401 })
    }

    const idToken = authHeader.slice(7).trim()
    const decoded = await adminAuth.verifyIdToken(idToken)
    const userEmail = normalizeOptionalString(decoded.email).toLowerCase()
    if (!userEmail) {
      return NextResponse.json({ error: "Authenticated user is missing email." }, { status: 403 })
    }

    const allowed = await isTreasuryAccount(userEmail)
    if (!allowed) {
      return NextResponse.json({ error: "Authenticated user is not a treasury account." }, { status: 403 })
    }

    const body = (await request.json()) as Record<string, unknown>
    const applicationUid = normalizeOptionalString(body?.applicationUid)
    if (!applicationUid) {
      return NextResponse.json({ error: "Application UID is required." }, { status: 400 })
    }

    const cedulaNumber = normalizeOptionalString(body?.cedulaNumber)
    const officialReceiptNumber = normalizeOptionalString(body?.officialReceiptNumber)
    if (!cedulaNumber || !officialReceiptNumber) {
      return NextResponse.json(
        { error: "Cedula Number and Official Receipt Number are required." },
        { status: 400 }
      )
    }

    const fees = normalizeFees(body?.fees)
    const additionalFees = normalizeAdditionalFees(body?.additionalFees)
    const lguTotal = normalizeOptionalNumber(body?.lguTotal) ?? 0
    const grandTotal = normalizeOptionalNumber(body?.grandTotal) ?? 0
    const staffUid = normalizeOptionalString(body?.staffUid) || decoded.uid
    const staffEmail = normalizeOptionalString(body?.staffEmail) || userEmail

    const collectionRef = adminDb.ref(TREASURY_FEES_PATH)
    let existingSnapshot = await collectionRef.orderByChild("application_uid").equalTo(applicationUid).get()
    if (!existingSnapshot.exists()) {
      existingSnapshot = await collectionRef.orderByChild("client_uid").equalTo(applicationUid).get()
    }

    let existingKey: string | null = null
    let existingPayload: Record<string, unknown> = {}
    if (existingSnapshot.exists()) {
      existingSnapshot.forEach((child) => {
        if (!existingKey) {
          existingKey = String(child.key ?? "")
          existingPayload = (child.val() ?? {}) as Record<string, unknown>
        }
        return false
      })
    }

    const now = Date.now()
    const previousCedulaNo = normalizeOptionalString(existingPayload["cedula_no"])
    const previousOrNo = normalizeOptionalString(existingPayload["or_no"])
    const previousCedulaIssuedAt =
      normalizeOptionalNumber(existingPayload["cedula_issued_at"]) ??
      normalizeOptionalNumber(existingPayload["cedulaIssuedAt"])
    const previousOrIssuedAt =
      normalizeOptionalNumber(existingPayload["or_issued_at"]) ??
      normalizeOptionalNumber(existingPayload["orIssuedAt"])

    const cedulaIssuedAt = cedulaNumber
      ? cedulaNumber === previousCedulaNo
        ? previousCedulaIssuedAt ?? now
        : now
      : null
    const orIssuedAt = officialReceiptNumber
      ? officialReceiptNumber === previousOrNo
        ? previousOrIssuedAt ?? now
        : now
      : null

    const payload = {
      application_uid: applicationUid,
      client_uid: applicationUid,
      cedula_no: cedulaNumber,
      cedula_issued_at: cedulaIssuedAt,
      or_no: officialReceiptNumber,
      or_issued_at: orIssuedAt,
      fees,
      additional_fees: additionalFees,
      lgu_total: Number.isFinite(lguTotal) ? lguTotal : 0,
      grand_total: Number.isFinite(grandTotal) ? grandTotal : 0,
      updatedAt: now,
      staff_uid: staffUid,
      staff_email: staffEmail,
    }

    if (existingKey) {
      const existingRef = adminDb.ref(`${TREASURY_FEES_PATH}/${existingKey}`)
      await existingRef.update({ uid: existingKey, ...payload })
      return NextResponse.json({ uid: existingKey })
    }

    const newRef = collectionRef.push()
    const key = String(newRef.key ?? "").trim()
    if (!key) {
      return NextResponse.json({ error: "Unable to allocate treasury record UID." }, { status: 500 })
    }

    await newRef.set({
      uid: key,
      ...payload,
      createdAt: now,
    })

    return NextResponse.json({ uid: key })
  } catch (error) {
    console.error("Failed to save treasury assessment via API", error)
    return NextResponse.json({ error: "Unable to save treasury assessment." }, { status: 500 })
  }
}
