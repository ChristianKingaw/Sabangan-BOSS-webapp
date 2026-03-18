import { MAYORS_CLEARANCE_APPLICATION_PATH } from "@/lib/clearance-applications"

const parseDateToTimestamp = (value: unknown) => {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value)
    const time = parsed.getTime()
    if (!Number.isNaN(time)) return time
  }
  return 0
}

function getRecordTimestamp(payload: any) {
  const form = (payload?.form ?? payload ?? {}) as Record<string, any>
  const meta = (payload?.meta ?? {}) as Record<string, any>

  const candidates: unknown[] = [
    form.dateOfApplication,
    form.applicationDate,
    form.date,
    form.submissionDate,
    meta.applicationDate,
    meta.submissionDate,
    meta.createdAt,
    payload?.submittedAt,
    meta.updatedAt,
  ]

  for (const candidate of candidates) {
    const ts = parseDateToTimestamp(candidate)
    if (ts > 0) return ts
  }

  return 0
}

function getLatestApprovedFileTimestamp(payload: any) {
  const requirements = payload?.requirements
  if (!requirements || typeof requirements !== "object") return 0

  let latest = 0
  for (const requirementData of Object.values(requirements as Record<string, any>)) {
    const files = (requirementData as any)?.files
    if (!files || typeof files !== "object") continue
    for (const fileData of Object.values(files as Record<string, any>)) {
      const status = String((fileData as any)?.status ?? "").toLowerCase()
      if (!status.includes("approve")) continue
      const ts = parseDateToTimestamp((fileData as any)?.uploadedAt)
      if (ts > latest) latest = ts
    }
  }

  return latest
}

function getApprovedTimestamp(payload: any) {
  const form = (payload?.form ?? payload ?? {}) as Record<string, any>
  const meta = (payload?.meta ?? {}) as Record<string, any>

  const candidates: unknown[] = [
    form.approvedAt,
    form.approvedDate,
    form.dateApproved,
    form.dateOfApproval,
    payload?.approvedAt,
    payload?.approvedDate,
    meta.approvedAt,
    meta.approvedDate,
    getLatestApprovedFileTimestamp(payload),
    payload?.submittedAt,
    meta.updatedAt,
    getRecordTimestamp(payload),
  ]

  for (const candidate of candidates) {
    const ts = parseDateToTimestamp(candidate)
    if (ts > 0) return ts
  }

  return 0
}

function isApprovedPayload(payload: any) {
  const form = (payload?.form ?? payload ?? {}) as Record<string, any>
  const meta = (payload?.meta ?? {}) as Record<string, any>
  const normalized = String(
    meta.overallStatus ??
      meta.status ??
      payload?.overallStatus ??
      payload?.status ??
      form.overallStatus ??
      form.status ??
      ""
  ).toLowerCase()

  return normalized.includes("approve") || normalized.includes("complete") || normalized.includes("process")
}

export async function resolveFallbackClearanceDocumentNo(
  adminDb: any,
  applicantUid: string,
  applicationId: string
): Promise<string> {
  try {
    const snap = await adminDb.ref(MAYORS_CLEARANCE_APPLICATION_PATH).get()
    if (!snap.exists()) return ""

    const node = (snap.val() ?? {}) as Record<string, Record<string, any>>
    const approvedRows: Array<{ applicantUid: string; applicationId: string; ts: number }> = []
    const allRows: Array<{ applicantUid: string; applicationId: string; ts: number }> = []

    for (const [uid, applications] of Object.entries(node)) {
      if (!applications || typeof applications !== "object") continue
      for (const [appId, payload] of Object.entries(applications)) {
        allRows.push({
          applicantUid: uid,
          applicationId: appId,
          ts: getRecordTimestamp(payload),
        })
        if (isApprovedPayload(payload)) {
          approvedRows.push({
            applicantUid: uid,
            applicationId: appId,
            ts: getApprovedTimestamp(payload),
          })
        }
      }
    }

    approvedRows.sort((a, b) => {
      if (a.ts !== b.ts) return a.ts - b.ts
      if (a.applicantUid !== b.applicantUid) return a.applicantUid.localeCompare(b.applicantUid)
      return a.applicationId.localeCompare(b.applicationId)
    })

    const approvedIndex = approvedRows.findIndex(
      (row) => row.applicantUid === applicantUid && row.applicationId === applicationId
    )
    if (approvedIndex >= 0) {
      return String(approvedIndex + 1)
    }

    allRows.sort((a, b) => {
      if (a.ts !== b.ts) return a.ts - b.ts
      if (a.applicantUid !== b.applicantUid) return a.applicantUid.localeCompare(b.applicantUid)
      return a.applicationId.localeCompare(b.applicationId)
    })

    const fallbackIndex = allRows.findIndex(
      (row) => row.applicantUid === applicantUid && row.applicationId === applicationId
    )
    if (fallbackIndex < 0) return ""

    return String(fallbackIndex + 1)
  } catch {
    return ""
  }
}
