import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { adminAuth, adminDb } from "@/lib/firebase-admin"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const revalidate = 0

const CLEARANCE_PATH = "mayors_clearance_files"

const ClearanceFileSchema = z.object({
  fileName: z.string().min(1),
  createdAt: z.number(),
  rowCount: z.number(),
  dataBase64: z.string(),
  createdBy: z.string().nullable().optional(),
})

function getFileYearKey(fileName: unknown): string | null {
  const match = String(fileName ?? "").match(/(19|20)\d{2}/)
  return match ? match[0] : null
}

const normalizeTimestamp = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? value * 1000 : value
  }

  if (typeof value === "string") {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) {
      return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric
    }
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? 0 : parsed
  }

  if (value && typeof value === "object") {
    const anyValue = value as Record<string, unknown>
    const nested = anyValue.Value ?? anyValue.value ?? anyValue.timestamp
    if (nested !== undefined) {
      return normalizeTimestamp(nested)
    }
    const seconds = anyValue.seconds ?? anyValue._seconds
    if (typeof seconds === "number" && Number.isFinite(seconds)) {
      return seconds * 1000
    }
  }

  return 0
}

async function verifyAuth(request: NextRequest) {
  const authHeader = request.headers.get("Authorization")
  if (!authHeader?.startsWith("Bearer ")) {
    return { ok: false as const, response: NextResponse.json({ error: "Missing or invalid Authorization header" }, { status: 401 }) }
  }
  if (!adminAuth) {
    return { ok: false as const, response: NextResponse.json({ error: "Server misconfigured: Firebase Admin not initialized" }, { status: 500 }) }
  }

  try {
    const idToken = authHeader.slice(7)
    await adminAuth.verifyIdToken(idToken)
    return { ok: true as const }
  } catch (err) {
    console.error("Token verification failed (clearance-files):", err)
    return { ok: false as const, response: NextResponse.json({ error: "Invalid or expired authentication token" }, { status: 401 }) }
  }
}

export async function GET(request: NextRequest) {
  try {
    const auth = await verifyAuth(request)
    if (!auth.ok) return auth.response

    if (!adminDb) {
      return NextResponse.json({ error: "Server misconfigured: Firebase Admin DB not initialized" }, { status: 500 })
    }

    const snapshot = await adminDb.ref(CLEARANCE_PATH).get()
    if (!snapshot.exists()) {
      return NextResponse.json({ files: [] })
    }

    const value = snapshot.val() || {}
    const seen = new Set<string>()
    const files: Array<{
      id: string
      fileName: string
      createdAt: number
      rowCount: number
      dataBase64: string
      createdBy: string | null
    }> = []

    for (const [id, payload] of Object.entries(value) as Array<[string, any]>) {
      const normalizedCreatedAt = normalizeTimestamp(payload?.createdAt)
      const key = `${payload?.fileName ?? ""}|${normalizedCreatedAt}|${payload?.rowCount ?? 0}|${payload?.createdBy ?? ""}`
      if (seen.has(key)) continue
      seen.add(key)
      files.push({
        id,
        fileName: payload?.fileName ?? "",
        createdAt: normalizedCreatedAt,
        rowCount: payload?.rowCount ?? 0,
        dataBase64: payload?.dataBase64 ?? "",
        createdBy: payload?.createdBy ?? null,
      })
    }

    files.sort((a, b) => b.createdAt - a.createdAt)
    return NextResponse.json({ files })
  } catch (error) {
    console.error("clearance-files GET error:", error)
    return NextResponse.json({ error: "Failed to fetch clearance files" }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await verifyAuth(request)
    if (!auth.ok) return auth.response

    if (!adminDb) {
      return NextResponse.json({ error: "Server misconfigured: Firebase Admin DB not initialized" }, { status: 500 })
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
    }

    const parsed = ClearanceFileSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request", details: parsed.error.flatten() }, { status: 400 })
    }

    const record = parsed.data
    const yearKey = getFileYearKey(record.fileName)
    if (yearKey) {
      await adminDb.ref(`${CLEARANCE_PATH}/${yearKey}`).set(record)
    } else {
      await adminDb.ref(CLEARANCE_PATH).push(record)
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error("clearance-files POST error:", error)
    return NextResponse.json({ error: "Failed to save clearance file" }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const auth = await verifyAuth(request)
    if (!auth.ok) return auth.response

    if (!adminDb) {
      return NextResponse.json({ error: "Server misconfigured: Firebase Admin DB not initialized" }, { status: 500 })
    }

    await adminDb.ref(CLEARANCE_PATH).set(null)
    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error("clearance-files DELETE error:", error)
    return NextResponse.json({ error: "Failed to clear clearance files" }, { status: 500 })
  }
}

