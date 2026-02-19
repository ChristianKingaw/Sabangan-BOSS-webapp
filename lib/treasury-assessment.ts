const TREASURY_FEES_PATH = "Treasury/fees"
const TEMPLATE_FEE_KEYS = [
  "gross_sales_tax",
  "delivery_vehicles_tax",
  "combustible_storage_tax",
  "signboard_billboard_tax",
  "mayors_permit_fee",
  "mayors_clearance_fee",
  "sanitary_inspection_fee",
  "delivery_permit_fee",
  "garbage_charges",
  "building_inspection_fee",
  "electrical_inspection_fee",
  "mechanical_inspection_fee",
  "dst_fee",
  "signboard_business_plate_fee",
  "combustible_storage_sale_fee",
  "fire_safety_inspection_fee",
] as const

export type TreasuryAssessmentFeeLine = {
  amount: number | null
  penalty: number | null
  total: number
}

export type TreasuryAssessmentAdditionalFeeLine = {
  name: string
  amount: number | null
  penalty: number | null
  total: number
}

export type TreasuryAssessmentRecord = {
  uid: string
  application_uid: string
  client_uid?: string
  cedula_no: string
  cedula_issued_at?: number | null
  or_no: string
  or_issued_at?: number | null
  fees: Record<string, TreasuryAssessmentFeeLine>
  additional_fees: TreasuryAssessmentAdditionalFeeLine[]
  lgu_total: number
  grand_total: number
  createdAt: number
  updatedAt?: number
}

const normalizeOptionalString = (value: unknown) => (typeof value === "string" ? value.trim() : "")

const normalizeOptionalNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const parsed = Number(value.trim())
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

const toTemplateNumericValue = (value: unknown): number | "" => {
  const normalized = normalizeOptionalNumber(value)
  if (normalized === null) return ""
  return normalized === 0 ? "" : normalized
}

const normalizeFeeLine = (value: unknown): TreasuryAssessmentFeeLine => {
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

const normalizeFees = (value: unknown): Record<string, TreasuryAssessmentFeeLine> => {
  const rows = value as Record<string, unknown>
  if (!rows || typeof rows !== "object") {
    return {}
  }

  const normalized: Record<string, TreasuryAssessmentFeeLine> = {}
  Object.entries(rows).forEach(([key, line]) => {
    normalized[key] = normalizeFeeLine(line)
  })

  return normalized
}

const normalizeAdditionalFees = (value: unknown): TreasuryAssessmentAdditionalFeeLine[] => {
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
      } satisfies TreasuryAssessmentAdditionalFeeLine
    })
    .filter((entry) => entry.name || entry.amount !== null || entry.penalty !== null)
}

export const normalizeTreasuryAssessmentRecord = (
  key: string,
  payload: Record<string, unknown>
): TreasuryAssessmentRecord | null => {
  const applicationUid =
    normalizeOptionalString(payload?.application_uid) || normalizeOptionalString(payload?.client_uid)
  if (!applicationUid) return null
  const legacyClientUid = normalizeOptionalString(payload?.client_uid)

  const additionalFees = Array.isArray(payload?.additional_fees)
    ? normalizeAdditionalFees(payload?.additional_fees)
    : normalizeAdditionalFees(payload?.additionalFees)

  return {
    uid: normalizeOptionalString(payload?.uid) || key,
    application_uid: applicationUid,
    client_uid: legacyClientUid || undefined,
    cedula_no: normalizeOptionalString(payload?.cedula_no) || normalizeOptionalString(payload?.cedula),
    cedula_issued_at:
      normalizeOptionalNumber(payload?.cedula_issued_at) ?? normalizeOptionalNumber(payload?.cedulaIssuedAt),
    or_no: normalizeOptionalString(payload?.or_no) || normalizeOptionalString(payload?.officialReceipt),
    or_issued_at:
      normalizeOptionalNumber(payload?.or_issued_at) ?? normalizeOptionalNumber(payload?.orIssuedAt),
    fees: normalizeFees(payload?.fees),
    additional_fees: additionalFees,
    lgu_total: normalizeOptionalNumber(payload?.lgu_total) ?? 0,
    grand_total: normalizeOptionalNumber(payload?.grand_total) ?? 0,
    createdAt: normalizeOptionalNumber(payload?.createdAt) ?? 0,
    updatedAt: normalizeOptionalNumber(payload?.updatedAt) ?? undefined,
  }
}

export const resolveBusinessClientUid = (applicationId: string, applicationData: Record<string, unknown>) => {
  const formUid = normalizeOptionalString((applicationData?.form as Record<string, unknown> | undefined)?.applicantUid)
  if (formUid) return formUid

  const metaUid = normalizeOptionalString((applicationData?.meta as Record<string, unknown> | undefined)?.applicantUid)
  if (metaUid) return metaUid

  return applicationId
}

export const fetchLatestTreasuryAssessmentByClientUid = async (
  adminDb: any,
  clientUid: string | string[]
): Promise<TreasuryAssessmentRecord | null> => {
  const candidateUids = (Array.isArray(clientUid) ? clientUid : [clientUid])
    .map((value) => String(value ?? "").trim())
    .filter(Boolean)

  if (candidateUids.length === 0) {
    return null
  }

  let latest: TreasuryAssessmentRecord | null = null

  for (const uid of Array.from(new Set(candidateUids))) {
    const [applicationSnapshot, legacySnapshot] = await Promise.all([
      adminDb.ref(TREASURY_FEES_PATH).orderByChild("application_uid").equalTo(uid).get(),
      adminDb.ref(TREASURY_FEES_PATH).orderByChild("client_uid").equalTo(uid).get(),
    ])

    const candidateRows = new Map<string, Record<string, unknown>>()
    if (applicationSnapshot.exists()) {
      applicationSnapshot.forEach((child: any) => {
        const key = String(child.key ?? "")
        candidateRows.set(key, (child.val() ?? {}) as Record<string, unknown>)
        return false
      })
    }
    if (legacySnapshot.exists()) {
      legacySnapshot.forEach((child: any) => {
        const key = String(child.key ?? "")
        if (!candidateRows.has(key)) {
          candidateRows.set(key, (child.val() ?? {}) as Record<string, unknown>)
        }
        return false
      })
    }
    if (candidateRows.size === 0) {
      continue
    }

    Array.from(candidateRows.entries()).forEach(([key, payload]) => {
      const normalized = normalizeTreasuryAssessmentRecord(key, payload)
      if (!normalized) return
      if (!latest) {
        latest = normalized
        return
      }

      const latestTs = latest.updatedAt ?? latest.createdAt ?? 0
      const incomingTs = normalized.updatedAt ?? normalized.createdAt ?? 0
      if (incomingTs >= latestTs) {
        latest = normalized
      }
    })
  }

  return latest
}

export const getAdditionalFeeNames = (assessment: TreasuryAssessmentRecord | null | undefined) => {
  if (!assessment) return []
  return assessment.additional_fees
    .map((row) => row.name.trim())
    .filter(Boolean)
}

export const formatOthersLabel = (assessment: TreasuryAssessmentRecord | null | undefined) => {
  const names = getAdditionalFeeNames(assessment)
  if (names.length === 0) return "Others"
  return `Others (${names.join(", ")})`
}

export const buildTemplateTreasuryFields = (assessment: TreasuryAssessmentRecord | null | undefined) => {
  const flattenedFees: Record<string, unknown> = {}
  TEMPLATE_FEE_KEYS.forEach((key) => {
    flattenedFees[key] = ""
    flattenedFees[`${key}_amount`] = ""
    flattenedFees[`${key}_penalty`] = ""
    flattenedFees[`${key}_total`] = ""
    flattenedFees[`treasury_${key}_amount`] = ""
    flattenedFees[`treasury_${key}_penalty`] = ""
    flattenedFees[`treasury_${key}_total`] = ""
  })

  if (!assessment) {
    return {
      treasuryCedulaNo: "",
      treasuryCedulaIssuedAt: "",
      treasuryOrNo: "",
      treasuryOrIssuedAt: "",
      treasuryOthers: "Others",
      others: "Others",
      otherFees: "",
      otherFeeNames: "",
      others_amount: "",
      others_penalty: "",
      others_total: "",
      other_amount: "",
      other_penalty: "",
      other_total: "",
      treasury_others_amount: "",
      treasury_others_penalty: "",
      treasury_others_total: "",
      grand_total: "",
      lgu_total: "",
      treasuryGrandTotal: "",
      treasuryLguTotal: "",
      ...flattenedFees,
    } satisfies Record<string, unknown>
  }

  const additionalNames = getAdditionalFeeNames(assessment)
  const additionalList = additionalNames.join(", ")
  const othersLabel = formatOthersLabel(assessment)
  const othersAmount = assessment.additional_fees.reduce((sum, line) => sum + (line.amount ?? 0), 0)
  const othersPenalty = assessment.additional_fees.reduce((sum, line) => sum + (line.penalty ?? 0), 0)
  const othersTotal = assessment.additional_fees.reduce(
    (sum, line) => sum + ((line.amount ?? 0) + (line.penalty ?? 0)),
    0
  )
  const computedGrandTotal =
    Object.values(assessment.fees).reduce((sum, line) => sum + (Number(line.total) || 0), 0) +
    othersTotal

  Object.entries(assessment.fees).forEach(([key, line]) => {
    const safeKey = key.replace(/[^a-zA-Z0-9_]+/g, "_")
    flattenedFees[safeKey] = toTemplateNumericValue(line.total)
    flattenedFees[`${safeKey}_amount`] = toTemplateNumericValue(line.amount)
    flattenedFees[`${safeKey}_penalty`] = toTemplateNumericValue(line.penalty)
    flattenedFees[`${safeKey}_total`] = toTemplateNumericValue(line.total)
    flattenedFees[`treasury_${safeKey}_amount`] = toTemplateNumericValue(line.amount)
    flattenedFees[`treasury_${safeKey}_penalty`] = toTemplateNumericValue(line.penalty)
    flattenedFees[`treasury_${safeKey}_total`] = toTemplateNumericValue(line.total)
  })

  return {
    treasuryCedulaNo: assessment.cedula_no,
    treasuryCedulaIssuedAt: assessment.cedula_issued_at ?? "",
    treasuryOrNo: assessment.or_no,
    treasuryOrIssuedAt: assessment.or_issued_at ?? "",
    treasuryOthers: othersLabel,
    others: othersLabel,
    otherFees: additionalList,
    otherFeeNames: additionalList,
    others_amount: toTemplateNumericValue(othersAmount),
    others_penalty: toTemplateNumericValue(othersPenalty),
    others_total: toTemplateNumericValue(othersTotal),
    other_amount: toTemplateNumericValue(othersAmount),
    other_penalty: toTemplateNumericValue(othersPenalty),
    other_total: toTemplateNumericValue(othersTotal),
    treasury_others_amount: toTemplateNumericValue(othersAmount),
    treasury_others_penalty: toTemplateNumericValue(othersPenalty),
    treasury_others_total: toTemplateNumericValue(othersTotal),
    grand_total: toTemplateNumericValue(computedGrandTotal),
    lgu_total: toTemplateNumericValue(assessment.lgu_total),
    treasuryGrandTotal: toTemplateNumericValue(computedGrandTotal),
    treasuryLguTotal: toTemplateNumericValue(assessment.lgu_total),
    ...flattenedFees,
  } satisfies Record<string, unknown>
}
