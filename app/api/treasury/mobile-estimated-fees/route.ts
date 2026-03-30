import { NextRequest, NextResponse } from "next/server"
import { adminAuth, adminDb } from "@/lib/firebase-admin"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const revalidate = 0

const TREASURY_USERS_PATH = "users/webapp/treasury"
const ESTIMATED_FEES_PATH = "estimated_fees"

const normalizeOptionalString = (value: unknown) =>
  typeof value === "string" ? value.trim() : ""

const isTreasuryAccount = async (email: string) => {
  const normalizedEmail = email.trim().toLowerCase()
  if (!normalizedEmail) return false

  const treasurySnapshot = await adminDb
    .ref(TREASURY_USERS_PATH)
    .orderByChild("email")
    .equalTo(normalizedEmail)
    .get()

  return treasurySnapshot.exists()
}

const normalizeErrorCode = (value: unknown) => normalizeOptionalString(value).toLowerCase()

const isInvalidAuthTokenError = (error: unknown) => {
  const code = normalizeErrorCode((error as { code?: unknown } | null)?.code)
  return code.startsWith("auth/")
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

    const allowed = await isTreasuryAccount(userEmail)
    if (!allowed) {
      return NextResponse.json(
        { error: "Authenticated user is not a treasury account." },
        { status: 403 }
      )
    }

    const snapshot = await adminDb.ref(ESTIMATED_FEES_PATH).get()
    const records = snapshot.exists()
      ? (snapshot.val() as Record<string, Record<string, unknown>>)
      : {}

    return NextResponse.json({ records })
  } catch (error) {
    console.error("Failed to load mobile-calculated estimated fees via API", error)
    return NextResponse.json(
      { error: "Unable to load mobile-calculated estimated fees." },
      { status: 500 }
    )
  }
}
