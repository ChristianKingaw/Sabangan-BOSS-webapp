import { realtimeDb } from "@/database/firebase"
import { get, onValue, push, ref, set, Unsubscribe } from "firebase/database"

export type ClearanceFileRecord = {
  fileName: string
  createdAt: number
  rowCount: number
  dataBase64: string
  createdBy?: string | null
}

const CLEARANCE_PATH = "mayors_clearance_files"

const getFileYearKey = (fileName: unknown): string | null => {
  const match = String(fileName ?? "").match(/(19|20)\d{2}/)
  return match ? match[0] : null
}

/**
 * Persist a generated Mayor's Clearance Excel file (base64) with metadata.
 */
export async function saveClearanceFile(record: ClearanceFileRecord) {
  const yearKey = getFileYearKey(record.fileName)
  const clearanceRef = ref(realtimeDb, CLEARANCE_PATH)
  if (yearKey) {
    const perYearRef = ref(realtimeDb, `${CLEARANCE_PATH}/${String(yearKey)}`)
    await set(perYearRef, record)
    return
  }

  await push(clearanceRef, record)
}

/**
 * Delete all saved Mayor's Clearance files.
 */
export async function clearClearanceFiles() {
  const clearanceRef = ref(realtimeDb, CLEARANCE_PATH)
  await set(clearanceRef, null)
}

export type ClearanceFileWithId = ClearanceFileRecord & { id: string }

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

export function subscribeToClearanceFiles(callback: (rows: ClearanceFileWithId[]) => void, onError?: (err: Error) => void): Unsubscribe {
  const clearanceRef = ref(realtimeDb, CLEARANCE_PATH)
  return onValue(
    clearanceRef,
    (snapshot) => {
        const value = snapshot.val() || {}

        // Deduplicate entries that have identical metadata to avoid showing
        // the same generated file multiple times when duplicate pushes occur.
        const seen = new Set<string>()
        const list: ClearanceFileWithId[] = []
        for (const [id, payload] of Object.entries(value) as Array<[string, any]>) {
          const normalizedCreatedAt = normalizeTimestamp(payload?.createdAt)
          const key = `${payload?.fileName ?? ""}|${normalizedCreatedAt}|${payload?.rowCount ?? 0}|${payload?.createdBy ?? ""}`
          if (seen.has(key)) continue
          seen.add(key)
          list.push({
            id,
            fileName: payload?.fileName ?? "",
            createdAt: normalizedCreatedAt,
            rowCount: payload?.rowCount ?? 0,
            dataBase64: payload?.dataBase64 ?? "",
            createdBy: payload?.createdBy ?? null,
          })
        }

        list.sort((a, b) => b.createdAt - a.createdAt)
        callback(list)
    },
    (err) => {
      console.error("Failed to load clearance files", err)
      if (onError) onError(err as Error)
    }
  )
}

export async function fetchClearanceFilesOnce(): Promise<ClearanceFileWithId[]> {
  try {
    const snapshot = await get(ref(realtimeDb, CLEARANCE_PATH))
    if (!snapshot.exists()) return []

    const value = snapshot.val() || {}
    const list: ClearanceFileWithId[] = []

    const seen = new Set<string>()
    for (const [id, payload] of Object.entries(value) as Array<[string, any]>) {
      const normalizedCreatedAt = normalizeTimestamp(payload?.createdAt)
      const key = `${payload?.fileName ?? ""}|${normalizedCreatedAt}|${payload?.rowCount ?? 0}|${payload?.createdBy ?? ""}`
      if (seen.has(key)) continue
      seen.add(key)
      list.push({
        id,
        fileName: payload?.fileName ?? "",
        createdAt: normalizedCreatedAt,
        rowCount: payload?.rowCount ?? 0,
        dataBase64: payload?.dataBase64 ?? "",
        createdBy: payload?.createdBy ?? null,
      })
    }

    list.sort((a, b) => b.createdAt - a.createdAt)
    return list
  } catch (err) {
    console.error("Failed to fetch clearance files", err)
    return []
  }
}
