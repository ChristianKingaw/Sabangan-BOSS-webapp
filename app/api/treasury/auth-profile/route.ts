import { NextRequest, NextResponse } from "next/server"
import { adminAuth, adminDb } from "@/lib/firebase-admin"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const revalidate = 0

const TREASURY_USERS_PATH = "users/webapp/treasury"

const normalizeOptionalString = (value: unknown) =>
  typeof value === "string" ? value.trim() : ""

const normalizeErrorMessage = (error: unknown) => {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "object" && error !== null && "message" in error) {
    const maybeMessage = (error as { message?: unknown }).message
    if (typeof maybeMessage === "string") return maybeMessage
  }
  return ""
}

const normalizeErrorCode = (value: unknown) => normalizeOptionalString(value).toLowerCase()

const isInvalidAuthTokenError = (error: unknown) => {
  const code = normalizeErrorCode((error as { code?: unknown } | null)?.code)
  return code.startsWith("auth/")
}

const isMissingEmailIndexError = (error: unknown) =>
  normalizeErrorMessage(error).toLowerCase().includes("index not defined")

const findTreasuryRecordByEmail = async (email: string) => {
  const normalizedEmail = email.trim().toLowerCase()
  if (!normalizedEmail) {
    return null
  }

  const findByScan = async () => {
    const fullSnapshot = await adminDb.ref(TREASURY_USERS_PATH).get()
    if (!fullSnapshot.exists()) {
      return null
    }

    const node = (fullSnapshot.val() ?? {}) as Record<string, Record<string, unknown>>
    for (const [id, value] of Object.entries(node)) {
      const candidateEmail = normalizeOptionalString(value?.email).toLowerCase()
      if (candidateEmail === normalizedEmail) {
        return { id, value }
      }
    }
    return null
  }

  let snapshot: Awaited<ReturnType<ReturnType<typeof adminDb.ref>["get"]>>
  try {
    snapshot = await adminDb
      .ref(TREASURY_USERS_PATH)
      .orderByChild("email")
      .equalTo(normalizedEmail)
      .limitToFirst(1)
      .get()
  } catch (error) {
    if (isMissingEmailIndexError(error)) {
      return findByScan()
    }
    throw error
  }

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

export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get("Authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json(
        { error: "Missing or invalid Authorization header." },
        { status: 401 }
      )
    }

    const idToken = authHeader.slice(7).trim()
    let decoded: Awaited<ReturnType<typeof adminAuth.verifyIdToken>>
    try {
      decoded = await adminAuth.verifyIdToken(idToken)
    } catch (error) {
      if (isInvalidAuthTokenError(error)) {
        return NextResponse.json(
          { error: "Authentication token is invalid or expired." },
          { status: 401 }
        )
      }
      throw error
    }

    const userEmail = normalizeOptionalString(decoded.email).toLowerCase()
    if (!userEmail) {
      return NextResponse.json(
        { error: "Authenticated user is missing email." },
        { status: 403 }
      )
    }

    const record = await findTreasuryRecordByEmail(userEmail)
    if (!record) {
      return NextResponse.json(
        { error: "Authenticated user is not a treasury account." },
        { status: 403 }
      )
    }

    const status = normalizeOptionalString(record.value.status).toLowerCase()
    if (status && ["inactive", "disabled", "suspended"].includes(status)) {
      return NextResponse.json(
        { error: "Treasury account is inactive." },
        { status: 403 }
      )
    }

    return NextResponse.json({
      id: record.id,
      uid: normalizeOptionalString(record.value.uid) || decoded.uid,
      email: userEmail,
      status: status || "active",
      firstName: normalizeOptionalString(record.value.firstName),
      lastName: normalizeOptionalString(record.value.lastName),
      emailVerified:
        typeof record.value.emailVerified === "boolean"
          ? record.value.emailVerified
          : true,
    })
  } catch (error) {
    console.error("Failed to validate treasury auth profile", error)
    return NextResponse.json(
      { error: "Unable to validate treasury account." },
      { status: 500 }
    )
  }
}

