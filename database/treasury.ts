import {
  equalTo,
  get,
  onValue,
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
const TREASURY_COLLECTION = RAW_NAMESPACE.endsWith("/treasury")
  ? RAW_NAMESPACE
  : `${RAW_NAMESPACE}/treasury`
const TREASURY_BUCKET = "Treasury"
const TREASURY_FEES_PATH = `${TREASURY_BUCKET}/fees`
const TREASURY_REASSESSMENT_PATH = `${TREASURY_BUCKET}/reassessment`

export type TreasuryRecord = {
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

export type TreasuryFeeLine = {
  amount: number | null
  penalty: number | null
  total: number
}

export type TreasuryAdditionalFeeLine = {
  name: string
  amount: number | null
  penalty: number | null
  total: number
}

export type TreasuryFeeAssessmentRecord = {
  uid: string
  application_uid: string
  client_uid?: string
  assessment_status?: string
  reassessment_status?: string
  reassessed_at?: number | null
  salary_amount?: string
  gross_sales_amount?: string
  capital_amount?: string
  cedula_no: string
  cedula_issued_at?: number | null
  or_no: string
  or_issued_at?: number | null
  fees: Record<string, TreasuryFeeLine>
  additional_fees: TreasuryAdditionalFeeLine[]
  lgu_total: number
  grand_total: number
  createdAt: number
  updatedAt?: number
  staff_uid?: string | null
  staff_email?: string | null
}

export type TreasuryReassessmentDifferenceType = "balanced" | "excess" | "insufficient"

export type TreasuryReassessmentRecord = {
  uid: string
  application_uid: string
  assessment_status?: string
  source_assessment_uid?: string
  previous_fees: Record<string, TreasuryFeeLine>
  updated_fees: Record<string, TreasuryFeeLine>
  previous_additional_fees: TreasuryAdditionalFeeLine[]
  updated_additional_fees: TreasuryAdditionalFeeLine[]
  previous_lgu_total: number
  updated_lgu_total: number
  previous_grand_total: number
  updated_grand_total: number
  difference_amount: number
  difference_type: TreasuryReassessmentDifferenceType
  createdAt: number
  updatedAt?: number
  staff_uid?: string | null
  staff_email?: string | null
}

export async function findTreasuryByEmail(email: string) {
  const normalizedEmail = email.trim().toLowerCase()
  const treasuryRef = ref(realtimeDb, TREASURY_COLLECTION)
  const treasuryQuery = dbQuery(treasuryRef, orderByChild("email"), equalTo(normalizedEmail))
  const snapshot = await get(treasuryQuery)

  if (!snapshot.exists()) {
    return null
  }

  let treasuryId: string | null = null
  let treasuryData: TreasuryRecord | null = null

  snapshot.forEach((child) => {
    if (!treasuryId) {
      treasuryId = child.key
      treasuryData = child.val() as TreasuryRecord
      return true
    }
    return true
  })

  if (!treasuryId || !treasuryData) {
    return null
  }

  const t = treasuryData as TreasuryRecord

  return {
    id: treasuryId,
    firstName: t.firstName ?? "",
    middleName: t.middleName ?? undefined,
    lastName: t.lastName ?? "",
    email: t.email ?? normalizedEmail,
    passwordHash: t.passwordHash ?? "",
    uid: t.uid ?? undefined,
    createdAt: t.createdAt ?? null,
    createdByEmail: t.createdByEmail ?? null,
    emailVerified: t.emailVerified ?? Boolean(t.createdByEmail),
  }
}

const normalizeOptionalString = (value: unknown) => (typeof value === "string" ? value.trim() : "")
const normalizeAmountInput = (value: unknown) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value)
  }
  return normalizeOptionalString(value)
}

const normalizeAssessmentStatus = (value: unknown) => {
  const normalized = normalizeOptionalString(value).toLowerCase()
  if (normalized === "paid" || normalized === "unpaid" || normalized === "ongoing") {
    return normalized
  }
  return "ongoing"
}

const normalizeOptionalNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value
  }
  if (typeof value === "string") {
    const parsed = Number(value.trim())
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }
  return null
}

const normalizeFeeLine = (value: unknown): TreasuryFeeLine => {
  const node = value as Record<string, unknown>
  const amount = normalizeOptionalNumber(node?.amount)
  const penalty = normalizeOptionalNumber(node?.penalty)
  const totalRaw = normalizeOptionalNumber(node?.total)
  const computedTotal = (amount ?? 0) + (penalty ?? 0)

  return {
    amount,
    penalty,
    total: totalRaw ?? computedTotal,
  }
}

const normalizeFees = (value: unknown) => {
  const rows = value as Record<string, unknown>
  if (!rows || typeof rows !== "object") {
    return {}
  }

  const normalized: Record<string, TreasuryFeeLine> = {}
  Object.entries(rows).forEach(([key, line]) => {
    normalized[key] = normalizeFeeLine(line)
  })
  return normalized
}

const normalizeAdditionalFees = (value: unknown): TreasuryAdditionalFeeLine[] => {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .map((entry) => {
      const node = entry as Record<string, unknown>
      const name = normalizeOptionalString(node?.name)
      const amount = normalizeOptionalNumber(node?.amount)
      const penalty = normalizeOptionalNumber(node?.penalty)
      const totalRaw = normalizeOptionalNumber(node?.total)
      const total = totalRaw ?? (amount ?? 0) + (penalty ?? 0)

      return {
        name,
        amount,
        penalty,
        total,
      } satisfies TreasuryAdditionalFeeLine
    })
    .filter((entry) => entry.name || entry.amount !== null || entry.penalty !== null)
}

const normalizeTreasuryFeeAssessmentRecord = (
  key: string,
  payload: Record<string, unknown>
): TreasuryFeeAssessmentRecord | null => {
  const applicationUid =
    normalizeOptionalString(payload?.application_uid) || normalizeOptionalString(payload?.client_uid)
  if (!applicationUid) {
    return null
  }
  const legacyClientUid = normalizeOptionalString(payload?.client_uid)

  const cedulaNo =
    normalizeOptionalString(payload?.cedula_no) || normalizeOptionalString(payload?.cedula)
  const cedulaIssuedAt =
    normalizeOptionalNumber(payload?.cedula_issued_at) ?? normalizeOptionalNumber(payload?.cedulaIssuedAt)
  const orNo = normalizeOptionalString(payload?.or_no) || normalizeOptionalString(payload?.officialReceipt)
  const orIssuedAt =
    normalizeOptionalNumber(payload?.or_issued_at) ?? normalizeOptionalNumber(payload?.orIssuedAt)
  const fees = normalizeFees(payload?.fees)
  const additionalFees = Array.isArray(payload?.additional_fees)
    ? normalizeAdditionalFees(payload?.additional_fees)
    : normalizeAdditionalFees(payload?.additionalFees)
  const lguTotal = normalizeOptionalNumber(payload?.lgu_total) ?? 0
  const grandTotal = normalizeOptionalNumber(payload?.grand_total) ?? 0

  return {
    uid: normalizeOptionalString(payload?.uid) || key,
    application_uid: applicationUid,
    client_uid: legacyClientUid || undefined,
    assessment_status: normalizeAssessmentStatus(payload?.assessment_status ?? payload?.status),
    reassessment_status: normalizeOptionalString(payload?.reassessment_status) || undefined,
    reassessed_at:
      normalizeOptionalNumber(payload?.reassessed_at) ??
      normalizeOptionalNumber(payload?.reassessedAt),
    salary_amount: normalizeAmountInput(payload?.salary_amount ?? payload?.salaryAmount) || undefined,
    gross_sales_amount:
      normalizeAmountInput(payload?.gross_sales_amount ?? payload?.grossSalesAmount) || undefined,
    capital_amount: normalizeAmountInput(payload?.capital_amount ?? payload?.capitalAmount) || undefined,
    cedula_no: cedulaNo,
    cedula_issued_at: cedulaIssuedAt,
    or_no: orNo,
    or_issued_at: orIssuedAt,
    fees,
    additional_fees: additionalFees,
    lgu_total: lguTotal,
    grand_total: grandTotal,
    createdAt: normalizeOptionalNumber(payload?.createdAt) ?? 0,
    updatedAt: normalizeOptionalNumber(payload?.updatedAt) ?? undefined,
    staff_uid: normalizeOptionalString(payload?.staff_uid) || null,
    staff_email: normalizeOptionalString(payload?.staff_email) || null,
  }
}

const deriveDifferenceTypeFromTotals = (
  previousGrandTotal: number,
  updatedGrandTotal: number
): TreasuryReassessmentDifferenceType => {
  if (previousGrandTotal > updatedGrandTotal) return "excess"
  if (previousGrandTotal < updatedGrandTotal) return "insufficient"
  return "balanced"
}

const getLineTotalValue = (line: TreasuryFeeLine | TreasuryAdditionalFeeLine) =>
  Number.isFinite(line.total) ? line.total : (line.amount ?? 0) + (line.penalty ?? 0)

const hasAnyNonZeroFeeValues = (
  fees: Record<string, TreasuryFeeLine>,
  additionalFees: TreasuryAdditionalFeeLine[]
) =>
  Object.values(fees).some((line) => getLineTotalValue(line) !== 0) ||
  additionalFees.some((line) => getLineTotalValue(line) !== 0)

const normalizeTreasuryReassessmentRecord = (
  key: string,
  payload: Record<string, unknown>
): TreasuryReassessmentRecord | null => {
  const applicationUid =
    normalizeOptionalString(payload?.application_uid) || normalizeOptionalString(payload?.client_uid)
  if (!applicationUid) {
    return null
  }

  const previousFees = normalizeFees(payload?.previous_fees ?? payload?.fees_before)
  const updatedFees = normalizeFees(payload?.updated_fees ?? payload?.fees_after)
  const previousAdditionalFees = Array.isArray(payload?.previous_additional_fees)
    ? normalizeAdditionalFees(payload?.previous_additional_fees)
    : normalizeAdditionalFees(payload?.previousAdditionalFees)
  const updatedAdditionalFees = Array.isArray(payload?.updated_additional_fees)
    ? normalizeAdditionalFees(payload?.updated_additional_fees)
    : normalizeAdditionalFees(payload?.updatedAdditionalFees)
  const previousLguTotal = normalizeOptionalNumber(payload?.previous_lgu_total) ?? 0
  const updatedLguTotal = normalizeOptionalNumber(payload?.updated_lgu_total) ?? 0
  const previousGrandTotal = normalizeOptionalNumber(payload?.previous_grand_total) ?? 0
  const updatedGrandTotal = normalizeOptionalNumber(payload?.updated_grand_total) ?? 0
  const hasUpdatedFeeValues = hasAnyNonZeroFeeValues(updatedFees, updatedAdditionalFees)
  const normalizedDifferenceType = hasUpdatedFeeValues
    ? deriveDifferenceTypeFromTotals(previousGrandTotal, updatedGrandTotal)
    : "balanced"
  const normalizedDifferenceAmount = hasUpdatedFeeValues
    ? normalizeOptionalNumber(payload?.difference_amount) ?? Math.abs(updatedGrandTotal - previousGrandTotal)
    : 0
  const rawAssessmentStatus = normalizeOptionalString(payload?.assessment_status)

  return {
    uid: normalizeOptionalString(payload?.uid) || key,
    application_uid: applicationUid,
    assessment_status: rawAssessmentStatus ? normalizeAssessmentStatus(rawAssessmentStatus) : undefined,
    source_assessment_uid: normalizeOptionalString(payload?.source_assessment_uid) || undefined,
    previous_fees: previousFees,
    updated_fees: updatedFees,
    previous_additional_fees: previousAdditionalFees,
    updated_additional_fees: updatedAdditionalFees,
    previous_lgu_total: previousLguTotal,
    updated_lgu_total: updatedLguTotal,
    previous_grand_total: previousGrandTotal,
    updated_grand_total: updatedGrandTotal,
    difference_amount: normalizedDifferenceAmount,
    difference_type: normalizedDifferenceType,
    createdAt: normalizeOptionalNumber(payload?.createdAt) ?? 0,
    updatedAt: normalizeOptionalNumber(payload?.updatedAt) ?? undefined,
    staff_uid: normalizeOptionalString(payload?.staff_uid) || null,
    staff_email: normalizeOptionalString(payload?.staff_email) || null,
  }
}

export function watchTreasuryFeesByClient(
  onChange: (records: Record<string, TreasuryFeeAssessmentRecord>) => void,
  onError?: (error: Error) => void
) {
  const collectionRef = ref(realtimeDb, TREASURY_FEES_PATH)

  return onValue(
    collectionRef,
    (snapshot) => {
      if (!snapshot.exists()) {
        onChange({})
        return
      }

      const rows = snapshot.val() as Record<string, Record<string, unknown>>
      const byApplication: Record<string, TreasuryFeeAssessmentRecord> = {}

      Object.entries(rows).forEach(([key, payload]) => {
        const normalized = normalizeTreasuryFeeAssessmentRecord(key, payload)
        if (!normalized) {
          return
        }

        const existing = byApplication[normalized.application_uid]
        if (!existing) {
          byApplication[normalized.application_uid] = normalized
          return
        }

        const existingTs = existing.updatedAt ?? existing.createdAt ?? 0
        const incomingTs = normalized.updatedAt ?? normalized.createdAt ?? 0
        if (incomingTs >= existingTs) {
          byApplication[normalized.application_uid] = normalized
        }
      })

      onChange(byApplication)
    },
    (error) => {
      if (onError) {
        onError(error as Error)
      }
    }
  )
}

export function watchTreasuryReassessmentsByApplication(
  onChange: (records: Record<string, TreasuryReassessmentRecord>) => void,
  onError?: (error: Error) => void
) {
  const collectionRef = ref(realtimeDb, TREASURY_REASSESSMENT_PATH)

  return onValue(
    collectionRef,
    (snapshot) => {
      if (!snapshot.exists()) {
        onChange({})
        return
      }

      const rows = snapshot.val() as Record<string, Record<string, unknown>>
      const byApplication: Record<string, TreasuryReassessmentRecord> = {}

      Object.entries(rows).forEach(([key, payload]) => {
        const normalized = normalizeTreasuryReassessmentRecord(key, payload)
        if (!normalized) {
          return
        }

        const existing = byApplication[normalized.application_uid]
        if (!existing) {
          byApplication[normalized.application_uid] = normalized
          return
        }

        const existingTs = existing.updatedAt ?? existing.createdAt ?? 0
        const incomingTs = normalized.updatedAt ?? normalized.createdAt ?? 0
        if (incomingTs >= existingTs) {
          byApplication[normalized.application_uid] = normalized
        }
      })

      onChange(byApplication)
    },
    (error) => {
      if (onError) {
        onError(error as Error)
      }
    }
  )
}

type SaveTreasuryReassessmentInput = {
  applicationUid: string
  sourceAssessmentUid?: string
  assessmentStatus?: string
  previousFees: Record<string, TreasuryFeeLine>
  updatedFees: Record<string, TreasuryFeeLine>
  previousAdditionalFees?: TreasuryAdditionalFeeLine[]
  updatedAdditionalFees?: TreasuryAdditionalFeeLine[]
  previousLguTotal: number
  updatedLguTotal: number
  previousGrandTotal: number
  updatedGrandTotal: number
  staffUid?: string | null
  staffEmail?: string | null
}

export async function saveTreasuryReassessment({
  applicationUid,
  sourceAssessmentUid = "",
  assessmentStatus = "paid",
  previousFees,
  updatedFees,
  previousAdditionalFees = [],
  updatedAdditionalFees = [],
  previousLguTotal,
  updatedLguTotal,
  previousGrandTotal,
  updatedGrandTotal,
  staffUid = null,
  staffEmail = null,
}: SaveTreasuryReassessmentInput) {
  const normalizedApplicationUid = applicationUid.trim()
  if (!normalizedApplicationUid) {
    throw new Error("Application UID is required.")
  }
  const normalizedAssessmentStatus = normalizeAssessmentStatus(assessmentStatus)

  const normalizedPreviousGrandTotal = Number.isFinite(previousGrandTotal) ? previousGrandTotal : 0
  const normalizedUpdatedGrandTotal = Number.isFinite(updatedGrandTotal) ? updatedGrandTotal : 0
  const normalizedPreviousLguTotal = Number.isFinite(previousLguTotal) ? previousLguTotal : 0
  const normalizedUpdatedLguTotal = Number.isFinite(updatedLguTotal) ? updatedLguTotal : 0
  const hasUpdatedFeeValues = hasAnyNonZeroFeeValues(updatedFees, updatedAdditionalFees)
  const differenceAmount = hasUpdatedFeeValues
    ? Math.abs(normalizedUpdatedGrandTotal - normalizedPreviousGrandTotal)
    : 0
  const differenceType = hasUpdatedFeeValues
    ? deriveDifferenceTypeFromTotals(normalizedPreviousGrandTotal, normalizedUpdatedGrandTotal)
    : "balanced"
  const now = Date.now()

  const collectionRef = ref(realtimeDb, TREASURY_REASSESSMENT_PATH)
  const existingByApplicationQuery = dbQuery(
    collectionRef,
    orderByChild("application_uid"),
    equalTo(normalizedApplicationUid)
  )
  const existingSnapshot = await get(existingByApplicationQuery)
  let existingKey: string | null = null
  let existingTimestamp = -1

  if (existingSnapshot.exists()) {
    existingSnapshot.forEach((child) => {
      const childPayload = (child.val() ?? {}) as Record<string, unknown>
      const childTimestamp =
        normalizeOptionalNumber(childPayload.updatedAt) ??
        normalizeOptionalNumber(childPayload.createdAt) ??
        0
      if (childTimestamp >= existingTimestamp) {
        existingTimestamp = childTimestamp
        existingKey = child.key
      }
      return false
    })
  }

  const normalizedPayload = {
    application_uid: normalizedApplicationUid,
    // Keep legacy key during transition so writes still pass on older rule sets.
    client_uid: normalizedApplicationUid,
    assessment_status: normalizedAssessmentStatus,
    source_assessment_uid: sourceAssessmentUid.trim(),
    previous_fees: previousFees,
    updated_fees: updatedFees,
    previous_additional_fees: previousAdditionalFees,
    updated_additional_fees: updatedAdditionalFees,
    previous_lgu_total: normalizedPreviousLguTotal,
    updated_lgu_total: normalizedUpdatedLguTotal,
    previous_grand_total: normalizedPreviousGrandTotal,
    updated_grand_total: normalizedUpdatedGrandTotal,
    difference_amount: differenceAmount,
    difference_type: differenceType,
    updatedAt: now,
    staff_uid: staffUid,
    staff_email: staffEmail,
  }

  if (existingKey) {
    const existingRef = ref(realtimeDb, `${TREASURY_REASSESSMENT_PATH}/${existingKey}`)
    await update(existingRef, {
      uid: existingKey,
      ...normalizedPayload,
    })
    return existingKey
  }

  const newRef = push(collectionRef)
  if (!newRef.key) {
    throw new Error("Unable to allocate treasury reassessment UID.")
  }

  await set(newRef, {
    uid: newRef.key,
    ...normalizedPayload,
    createdAt: now,
  })

  return newRef.key
}

type SaveTreasuryFeeAssessmentInput = {
  applicationUid: string
  cedulaNumber: string
  officialReceiptNumber: string
  assessmentStatus?: string
  salaryAmount?: string
  grossSalesAmount?: string
  capitalAmount?: string
  allowMissingDocumentReferences?: boolean
  fees: Record<string, TreasuryFeeLine>
  additionalFees: TreasuryAdditionalFeeLine[]
  lguTotal: number
  grandTotal: number
  staffUid?: string | null
  staffEmail?: string | null
  authIdToken?: string | null
}

const saveTreasuryFeeAssessmentViaApi = async ({
  applicationUid,
  cedulaNumber,
  officialReceiptNumber,
  assessmentStatus,
  salaryAmount,
  grossSalesAmount,
  capitalAmount,
  fees,
  additionalFees,
  lguTotal,
  grandTotal,
  staffUid,
  staffEmail,
  authIdToken,
}: SaveTreasuryFeeAssessmentInput & { authIdToken: string }) => {
  const response = await fetch("/api/treasury/fees", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${authIdToken}`,
    },
    body: JSON.stringify({
      applicationUid,
      cedulaNumber,
      officialReceiptNumber,
      assessmentStatus,
      salaryAmount,
      grossSalesAmount,
      capitalAmount,
      fees,
      additionalFees,
      lguTotal,
      grandTotal,
      staffUid,
      staffEmail,
    }),
  })

  let body: Record<string, unknown> = {}
  try {
    body = (await response.json()) as Record<string, unknown>
  } catch {
    body = {}
  }

  if (!response.ok) {
    throw new Error(String(body?.error ?? "Unable to save treasury assessment via API."))
  }

  const uid = String(body?.uid ?? "").trim()
  if (!uid) {
    throw new Error("Treasury save API returned an invalid UID.")
  }

  return uid
}

export async function saveTreasuryFeeAssessment({
  applicationUid,
  cedulaNumber,
  officialReceiptNumber,
  assessmentStatus = "ongoing",
  salaryAmount = "",
  grossSalesAmount = "",
  capitalAmount = "",
  allowMissingDocumentReferences = false,
  fees,
  additionalFees,
  lguTotal,
  grandTotal,
  staffUid = null,
  staffEmail = null,
  authIdToken = null,
}: SaveTreasuryFeeAssessmentInput) {
  const normalizedCedulaNo = cedulaNumber.trim()
  const normalizedOrNo = officialReceiptNumber.trim()
  const normalizedSalaryAmount = salaryAmount.trim()
  const normalizedGrossSalesAmount = grossSalesAmount.trim()
  const normalizedCapitalAmount = capitalAmount.trim()
  if (!allowMissingDocumentReferences && (!normalizedCedulaNo || !normalizedOrNo)) {
    throw new Error("Cedula Number and Official Receipt Number are required.")
  }
  const normalizedAssessmentStatus = normalizeAssessmentStatus(assessmentStatus)

  if (authIdToken) {
    return saveTreasuryFeeAssessmentViaApi({
      applicationUid,
      cedulaNumber: normalizedCedulaNo,
      officialReceiptNumber: normalizedOrNo,
      assessmentStatus: normalizedAssessmentStatus,
      salaryAmount: normalizedSalaryAmount,
      grossSalesAmount: normalizedGrossSalesAmount,
      capitalAmount: normalizedCapitalAmount,
      fees,
      additionalFees,
      lguTotal,
      grandTotal,
      staffUid,
      staffEmail,
      authIdToken,
    })
  }

  const normalizedApplicationUid = applicationUid.trim()
  if (!normalizedApplicationUid) {
    throw new Error("Application UID is required.")
  }

  const collectionRef = ref(realtimeDb, TREASURY_FEES_PATH)
  const existingByApplicationQuery = dbQuery(
    collectionRef,
    orderByChild("application_uid"),
    equalTo(normalizedApplicationUid)
  )
  let existingSnapshot = await get(existingByApplicationQuery)
  // Backward compatibility: records previously saved under client_uid.
  if (!existingSnapshot.exists()) {
    const existingByLegacyClientQuery = dbQuery(collectionRef, orderByChild("client_uid"), equalTo(normalizedApplicationUid))
    existingSnapshot = await get(existingByLegacyClientQuery)
  }
  const now = Date.now()
  let existingKey: string | null = null
  let existingPayload: Record<string, unknown> | null = null

  if (existingSnapshot.exists()) {
    existingSnapshot.forEach((child) => {
      if (!existingKey) {
        existingKey = child.key
        existingPayload = (child.val() ?? {}) as Record<string, unknown>
      }
      return false
    })
  }

  const existingNode = (existingPayload ?? {}) as Record<string, unknown>

  const previousCedulaNo = normalizeOptionalString(existingNode["cedula_no"])
  const previousOrNo = normalizeOptionalString(existingNode["or_no"])
  const previousCedulaIssuedAt =
    normalizeOptionalNumber(existingNode["cedula_issued_at"]) ??
    normalizeOptionalNumber(existingNode["cedulaIssuedAt"])
  const previousOrIssuedAt =
    normalizeOptionalNumber(existingNode["or_issued_at"]) ??
    normalizeOptionalNumber(existingNode["orIssuedAt"])

  const cedulaIssuedAt = normalizedCedulaNo
    ? normalizedCedulaNo === previousCedulaNo
      ? previousCedulaIssuedAt ?? now
      : now
    : null
  const orIssuedAt = normalizedOrNo
    ? normalizedOrNo === previousOrNo
      ? previousOrIssuedAt ?? now
      : now
    : null

  const normalizedPayload = {
    application_uid: normalizedApplicationUid,
    // Keep legacy key during transition so writes still pass on older rule sets.
    client_uid: normalizedApplicationUid,
    assessment_status: normalizedAssessmentStatus,
    salary_amount: normalizedSalaryAmount,
    gross_sales_amount: normalizedGrossSalesAmount,
    capital_amount: normalizedCapitalAmount,
    cedula_no: normalizedCedulaNo,
    cedula_issued_at: cedulaIssuedAt,
    or_no: normalizedOrNo,
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
    const existingRef = ref(realtimeDb, `${TREASURY_FEES_PATH}/${existingKey}`)
    await update(existingRef, {
      uid: existingKey,
      ...normalizedPayload,
    })
    return existingKey
  }

  const newRef = push(collectionRef)
  if (!newRef.key) {
    throw new Error("Unable to allocate treasury record UID.")
  }

  await set(newRef, {
    uid: newRef.key,
    ...normalizedPayload,
    createdAt: now,
  })

  return newRef.key
}
