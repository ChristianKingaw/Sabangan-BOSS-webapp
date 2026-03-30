
"use client"

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useSearchParams } from "next/navigation"
import { getAuth, onAuthStateChanged, type User } from "firebase/auth"
import { get, onValue, ref } from "firebase/database"
import TreasuryShell from "@/components/treasury-shell"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { app as firebaseApp, realtimeDb } from "@/database/firebase"
import {
  saveTreasuryFeeAssessment,
  type TreasuryAdditionalFeeLine,
  type TreasuryFeeAssessmentRecord,
  type TreasuryFeeLine,
  watchTreasuryFeesByClient,
} from "@/database/treasury"
import {
  BUSINESS_APPLICATION_PATH,
  normalizeBusinessApplication,
  type BusinessApplicationRecord,
} from "@/lib/business-applications"
import { toast } from "sonner"

type SaveFeedback = { type: "success" | "error"; message: string }
type FeeLineInput = { amount: string; penalty: string }
type AdditionalFeeInput = { id: string; name: string; amount: string; penalty: string }
type AssessmentBasisInput = { grossSales: string; capital: string }
type TreasuryAssessmentStatus = "paid" | "unpaid" | "ongoing"
type MobileFeeBreakdownLine = { label: string; amount: number }
type MobileCalculatedFeeReference = {
  applicationUid: string
  basisType: string
  basisTotal: number | null
  estimatedTotal: number | null
  status: string
  sourcePath: string
  sourceLabel: string
  computedAt: number | null
  breakdown: MobileFeeBreakdownLine[]
}

const ESTIMATED_FEES_PATH = "estimated_fees"

const FEE_DEFINITIONS = [
  { key: "gross_sales_tax", label: "Gross Sales Tax", section: "local", includeInLgu: true },
  {
    key: "delivery_vehicles_tax",
    label: "Tax on Delivery Vans / Trucks (Tricycle)",
    section: "local",
    includeInLgu: true,
  },
  {
    key: "combustible_storage_tax",
    label: "Tax on Storage for Combustible / Flammable / Explosive Substance",
    section: "local",
    includeInLgu: true,
  },
  {
    key: "signboard_billboard_tax",
    label: "Tax on Signboard / Billboards",
    section: "local",
    includeInLgu: true,
  },
  { key: "mayors_permit_fee", label: "Mayor's Permit Fee", section: "regulatory", includeInLgu: true },
  { key: "mayors_clearance_fee", label: "Mayor's Clearance Fee", section: "regulatory", includeInLgu: true },
  {
    key: "sanitary_inspection_fee",
    label: "Sanitary Inspection Fee",
    section: "regulatory",
    includeInLgu: true,
  },
  {
    key: "delivery_permit_fee",
    label: "Delivery Trucks/Vans Permit Fee",
    section: "regulatory",
    includeInLgu: true,
  },
  { key: "garbage_charges", label: "Garbage Charges", section: "regulatory", includeInLgu: true },
  {
    key: "building_inspection_fee",
    label: "Building Inspection Fee",
    section: "regulatory",
    includeInLgu: true,
  },
  {
    key: "electrical_inspection_fee",
    label: "Electrical Inspection Fee",
    section: "regulatory",
    includeInLgu: true,
  },
  {
    key: "mechanical_inspection_fee",
    label: "Mechanical Inspection Fee",
    section: "regulatory",
    includeInLgu: true,
  },
  { key: "dst_fee", label: "D.S.T. (Documentary Stamp Tax)", section: "regulatory", includeInLgu: true },
  {
    key: "signboard_business_plate_fee",
    label: "Signboard/Business Plate",
    section: "regulatory",
    includeInLgu: true,
  },
  {
    key: "combustible_storage_sale_fee",
    label: "Storage and Sale of Combustible",
    section: "regulatory",
    includeInLgu: true,
  },
  {
    key: "fire_safety_inspection_fee",
    label: "Fire Safety Inspection Fee",
    section: "fire",
    includeInLgu: false,
  },
] as const

type FeeKey = (typeof FEE_DEFINITIONS)[number]["key"]
type FeeSection = (typeof FEE_DEFINITIONS)[number]["section"]
type ClientAssessmentInputs = {
  cedula: string
  officialReceipt: string
  assessmentStatus: TreasuryAssessmentStatus
  assessmentBasis: AssessmentBasisInput
  fees: Record<FeeKey, FeeLineInput>
  additionalFees: AdditionalFeeInput[]
}

const LOCAL_TAX_ITEMS = FEE_DEFINITIONS.filter((item) => item.section === "local")
const REGULATORY_FEE_ITEMS = FEE_DEFINITIONS.filter((item) => item.section === "regulatory")
const FIRE_FEE_ITEMS = FEE_DEFINITIONS.filter((item) => item.section === "fire")
const FEE_ROW_INDEX_BY_KEY = FEE_DEFINITIONS.reduce((accumulator, item, index) => {
  accumulator[item.key] = index
  return accumulator
}, {} as Record<FeeKey, number>)
const BUSINESS_TAX_FEE_KEY: FeeKey = "gross_sales_tax"

const ESTIMATED_TREASURY_FEE_LABELS: Record<string, string> = {
  mayors_permit: "Mayor's Permit",
  mayors_clearance: "Mayor's Clearance",
  sanitary_permit: "Sanitary Permit",
  weights_and_measure: "Weights and Measure",
  subscription_fee: "Subscription Fee",
  dst: "D.S.T.",
  zoning: "Zoning",
  others_total: "Others",
}

const normalizeOptionalStringValue = (value: unknown) =>
  typeof value === "string" ? value.trim() : ""

const normalizeTreasuryAssessmentStatus = (value: unknown): TreasuryAssessmentStatus => {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : ""
  if (normalized === "paid" || normalized === "unpaid") return normalized
  return "ongoing"
}

const isPermissionDeniedError = (error: unknown) => {
  const node = (error ?? {}) as { code?: unknown; message?: unknown }
  const code = typeof node.code === "string" ? node.code.toLowerCase() : ""
  const message = typeof node.message === "string" ? node.message.toLowerCase() : ""
  return code.includes("permission_denied") || message.includes("permission denied")
}

const getTreasuryAssessmentStatusLabel = (value: TreasuryAssessmentStatus) => {
  if (value === "paid") return "Paid"
  if (value === "unpaid") return "Unpaid"
  return "Ongoing"
}

const getApplicationTypeBadgeClassName = (value: string) =>
  value === "Renewal"
    ? "border-indigo-400 bg-indigo-100 text-indigo-900"
    : "border-emerald-400 bg-emerald-100 text-emerald-900"

const normalizeOptionalNumberValue = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value !== "string") return null
  const parsed = Number(value.replace(/,/g, "").trim())
  return Number.isFinite(parsed) ? parsed : null
}

const normalizeBreakdownNode = (value: unknown): MobileFeeBreakdownLine[] => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return []

  return Object.entries(value as Record<string, unknown>)
    .map(([label, rawAmount]) => {
      const amount = normalizeOptionalNumberValue(rawAmount)
      if (amount === null) return null
      const normalizedLabel = normalizeOptionalStringValue(label)
      return {
        label: normalizedLabel || "Fee",
        amount,
      } satisfies MobileFeeBreakdownLine
    })
    .filter((entry): entry is MobileFeeBreakdownLine => entry !== null)
}

const normalizeOtherEstimatedBreakdown = (value: unknown): MobileFeeBreakdownLine[] => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return []

  return Object.entries(value as Record<string, unknown>)
    .map(([name, rawAmount]) => {
      const amount = normalizeOptionalNumberValue(rawAmount)
      if (amount === null) return null
      const normalizedName = normalizeOptionalStringValue(name)
        .replace(/[_-]+/g, " ")
        .replace(/\s+/g, " ")
      const label = normalizedName ? `Other - ${normalizedName}` : "Other"
      return { label, amount } satisfies MobileFeeBreakdownLine
    })
    .filter((entry): entry is MobileFeeBreakdownLine => entry !== null)
}

const normalizeEstimatedFeesBreakdown = (value: unknown): MobileFeeBreakdownLine[] => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return []
  const node = value as Record<string, unknown>
  const detailedOthers = normalizeOtherEstimatedBreakdown(node.others)
  const rows: MobileFeeBreakdownLine[] = []

  Object.entries(ESTIMATED_TREASURY_FEE_LABELS).forEach(([key, label]) => {
    if (key === "others_total" && detailedOthers.length > 0) {
      return
    }

    const amount = normalizeOptionalNumberValue(node[key])
    if (amount === null) return

    rows.push({ label, amount })
  })

  rows.push(...detailedOthers)
  return rows
}

const normalizeEstimatedFeeReference = (
  appId: string,
  payload: Record<string, unknown>
): MobileCalculatedFeeReference | null => {
  const estimatedTreasuryFeesRaw = payload.estimated_treasury_fees
  const estimatedTreasuryFeesNode =
    estimatedTreasuryFeesRaw && typeof estimatedTreasuryFeesRaw === "object" && !Array.isArray(estimatedTreasuryFeesRaw)
      ? (estimatedTreasuryFeesRaw as Record<string, unknown>)
      : {}

  const applicationUid = normalizeOptionalStringValue(payload.application_uid) || appId.trim()
  if (!applicationUid) return null

  const breakdown = normalizeEstimatedFeesBreakdown(estimatedTreasuryFeesNode)
  const estimatedTotal =
    normalizeOptionalNumberValue(estimatedTreasuryFeesNode.estimated_total) ??
    normalizeOptionalNumberValue(payload.estimated_treasury_fees_total)
  const basisTotal =
    normalizeOptionalNumberValue(payload.basis_total) ??
    normalizeOptionalNumberValue(payload.gross_total) ??
    normalizeOptionalNumberValue(payload.capital_total)
  const computedAt =
    normalizeOptionalNumberValue(payload.updatedAt) ??
    normalizeOptionalNumberValue(payload.submittedAt) ??
    normalizeOptionalNumberValue(payload.createdAt)

  if (estimatedTotal === null && basisTotal === null && breakdown.length === 0) {
    return null
  }

  return {
    applicationUid,
    basisType: normalizeOptionalStringValue(payload.basis_type) || "Not specified",
    basisTotal,
    estimatedTotal,
    status: normalizeOptionalStringValue(payload.status),
    sourcePath: normalizeOptionalStringValue(payload.source_path) || `${ESTIMATED_FEES_PATH}/${applicationUid}`,
    sourceLabel: `${ESTIMATED_FEES_PATH}/${applicationUid}`,
    computedAt,
    breakdown,
  }
}

const normalizeEstimatedFeeRecordMap = (value: unknown) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {} as Record<string, MobileCalculatedFeeReference>
  }

  const node = value as Record<string, unknown>
  const byApplication: Record<string, MobileCalculatedFeeReference> = {}

  Object.entries(node).forEach(([recordUid, payload]) => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return
    }

    const normalized = normalizeEstimatedFeeReference(recordUid, payload as Record<string, unknown>)
    if (!normalized) return

    const existing = byApplication[normalized.applicationUid]
    if (!existing) {
      byApplication[normalized.applicationUid] = normalized
      return
    }

    if ((normalized.computedAt ?? 0) >= (existing.computedAt ?? 0)) {
      byApplication[normalized.applicationUid] = normalized
    }
  })

  return byApplication
}

const normalizeLegacyBusinessFeeReference = (
  appId: string,
  payload: Record<string, unknown>
): MobileCalculatedFeeReference | null => {
  const feesRaw = payload.fees
  if (!feesRaw || typeof feesRaw !== "object" || Array.isArray(feesRaw)) {
    return null
  }

  const feesNode = feesRaw as Record<string, unknown>
  const inputsRaw = feesNode.inputs
  const inputsNode =
    inputsRaw && typeof inputsRaw === "object" && !Array.isArray(inputsRaw)
      ? (inputsRaw as Record<string, unknown>)
      : {}
  const metaRaw = payload.meta
  const metaNode =
    metaRaw && typeof metaRaw === "object" && !Array.isArray(metaRaw)
      ? (metaRaw as Record<string, unknown>)
      : {}
  const breakdown = normalizeBreakdownNode(feesNode.breakdown)
  const estimatedTotal = normalizeOptionalNumberValue(feesNode.total)
  const basisTotal =
    normalizeOptionalNumberValue(inputsNode.basisTotal) ??
    normalizeOptionalNumberValue(inputsNode.taxBasisTotal) ??
    normalizeOptionalNumberValue(inputsNode.grossTotal) ??
    normalizeOptionalNumberValue(inputsNode.capitalTotal)
  const computedAt =
    normalizeOptionalNumberValue(feesNode.computedAt) ??
    normalizeOptionalNumberValue(metaNode.feesComputedAt) ??
    normalizeOptionalNumberValue(metaNode.updatedAt)

  if (estimatedTotal === null && basisTotal === null && breakdown.length === 0) {
    return null
  }

  return {
    applicationUid: appId,
    basisType:
      normalizeOptionalStringValue(inputsNode.basisLabel) ||
      normalizeOptionalStringValue(inputsNode.basis_type) ||
      "Not specified",
    basisTotal,
    estimatedTotal,
    status: normalizeOptionalStringValue(metaNode.status) || normalizeOptionalStringValue(payload.status),
    sourcePath: `business/business_application/${appId}/fees`,
    sourceLabel: `business/business_application/${appId}/fees`,
    computedAt,
    breakdown,
  }
}

const createEmptyFeeInputs = (): Record<FeeKey, FeeLineInput> =>
  FEE_DEFINITIONS.reduce((accumulator, item) => {
    accumulator[item.key] = { amount: "", penalty: "" }
    return accumulator
  }, {} as Record<FeeKey, FeeLineInput>)

const createEmptyAssessmentBasisInputs = (): AssessmentBasisInput => ({
  grossSales: "",
  capital: "",
})

const createEmptyAssessmentInputs = (): ClientAssessmentInputs => ({
  cedula: "",
  officialReceipt: "",
  assessmentStatus: "unpaid",
  assessmentBasis: createEmptyAssessmentBasisInputs(),
  fees: createEmptyFeeInputs(),
  additionalFees: [],
})

const EMPTY_ASSESSMENT_INPUTS = createEmptyAssessmentInputs()

const createAdditionalFeeInput = (seed?: Partial<AdditionalFeeInput>): AdditionalFeeInput => ({
  id: seed?.id ?? `additional_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  name: seed?.name ?? "",
  amount: seed?.amount ?? "",
  penalty: seed?.penalty ?? "",
})

const cloneFeeInputs = (fees: Record<FeeKey, FeeLineInput>): Record<FeeKey, FeeLineInput> =>
  FEE_DEFINITIONS.reduce((accumulator, item) => {
    const row = fees[item.key]
    accumulator[item.key] = { amount: row?.amount ?? "", penalty: row?.penalty ?? "" }
    return accumulator
  }, {} as Record<FeeKey, FeeLineInput>)

const cloneAssessmentInputs = (value: ClientAssessmentInputs): ClientAssessmentInputs => ({
  cedula: value.cedula,
  officialReceipt: value.officialReceipt,
  assessmentStatus: value.assessmentStatus,
  assessmentBasis: {
    grossSales: value.assessmentBasis.grossSales,
    capital: value.assessmentBasis.capital,
  },
  fees: FEE_DEFINITIONS.reduce((accumulator, item) => {
    const row = value.fees[item.key]
    accumulator[item.key] = { amount: row?.amount ?? "", penalty: row?.penalty ?? "" }
    return accumulator
  }, {} as Record<FeeKey, FeeLineInput>),
  additionalFees: value.additionalFees.map((fee) => ({ ...fee })),
})

const serializeAssessmentInputsForComparison = (value: ClientAssessmentInputs) => {
  const normalized = normalizeAssessmentInputs(value)
  return JSON.stringify({
    cedula: normalized.cedula,
    officialReceipt: normalized.officialReceipt,
    assessmentStatus: normalized.assessmentStatus,
    assessmentBasis: normalized.assessmentBasis,
    fees: normalized.fees,
    additionalFees: normalized.additionalFees.map((fee) => ({
      name: fee.name,
      amount: fee.amount,
      penalty: fee.penalty,
    })),
  })
}

const parseOptionalNumber = (value: string): number | null => {
  const trimmed = value.trim()
  if (!trimmed) return null
  const parsed = Number(trimmed.replace(/,/g, ""))
  return Number.isFinite(parsed) ? parsed : null
}

const formatCurrency = (value: number) =>
  value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const formatNumberCell = (value: string) => {
  const parsed = parseOptionalNumber(value)
  return parsed === null ? "-" : formatCurrency(parsed)
}

const formatBasisCell = (value: string) => {
  const trimmed = value.trim()
  if (!trimmed) return "-"
  const parsed = parseOptionalNumber(trimmed)
  return parsed === null ? trimmed : formatCurrency(parsed)
}

const toAmountInputString = (value: unknown) => {
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  if (typeof value === "string") return value.trim()
  return ""
}

const getAssessmentBasisFromForm = (record: BusinessApplicationRecord): AssessmentBasisInput => {
  const form = (record.form ?? {}) as Record<string, unknown>
  const activities = Array.isArray(form.activities) ? form.activities : []
  const pickFirstFilled = (values: unknown[]) => {
    for (const value of values) {
      const normalized = toAmountInputString(value)
      if (normalized) return normalized
    }
    return ""
  }
  const pickHighestActivityAmount = (field: "grossSales" | "capitalization") => {
    let highest: number | null = null
    let fallback = ""

    activities.forEach((entry) => {
      const activity = (entry ?? {}) as Record<string, unknown>
      const normalized = toAmountInputString(activity[field])
      if (!normalized) return

      const numeric = parseOptionalNumber(normalized)
      if (numeric === null) {
        if (!fallback) fallback = normalized
        return
      }

      if (highest === null || numeric > highest) {
        highest = numeric
      }
    })

    if (highest !== null) return String(highest)
    return fallback
  }

  return {
    grossSales:
      pickFirstFilled([form.grossSales, form.grossTotal, form.grossTotalInt, form.basisTotal, form.taxBasisTotal]) ||
      pickHighestActivityAmount("grossSales"),
    capital:
      pickFirstFilled([form.capitalization, form.capitalTotal]) || pickHighestActivityAmount("capitalization"),
  }
}

const getBusinessBasisFieldByApplicationType = (
  applicationType: BusinessApplicationRecord["applicationType"] | undefined
): keyof Pick<AssessmentBasisInput, "grossSales" | "capital"> =>
  applicationType === "New" ? "capital" : "grossSales"

const enforceBusinessBasisByApplicationType = (
  applicationType: BusinessApplicationRecord["applicationType"] | undefined,
  basis: AssessmentBasisInput
): AssessmentBasisInput => {
  const normalized = {
    grossSales: basis.grossSales.trim(),
    capital: basis.capital.trim(),
  }
  const basisField = getBusinessBasisFieldByApplicationType(applicationType)

  if (basisField === "capital") {
    return {
      ...normalized,
      grossSales: "",
    }
  }

  return {
    ...normalized,
    capital: "",
  }
}

const enforceBusinessTaxByApplicationType = (
  applicationType: BusinessApplicationRecord["applicationType"] | undefined,
  fees: Record<FeeKey, FeeLineInput>
): Record<FeeKey, FeeLineInput> => {
  const normalizedFees = cloneFeeInputs(fees)

  if (applicationType === "Renewal") {
    return normalizedFees
  }

  normalizedFees[BUSINESS_TAX_FEE_KEY] = { amount: "", penalty: "" }
  return normalizedFees
}

const formatDateTimeCell = (value: number | null) => {
  if (value === null) return "-"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "-"
  return date.toLocaleString()
}

const hasAnyAssessmentValue = (value: ClientAssessmentInputs) => {
  if (value.cedula.trim() || value.officialReceipt.trim()) return true
  const hasAnyAdditionalFeeValue = value.additionalFees.some((fee) => Boolean(fee.name.trim() || fee.amount.trim() || fee.penalty.trim()))
  if (hasAnyAdditionalFeeValue) return true

  return FEE_DEFINITIONS.some((item) => {
    const row = value.fees[item.key]
    return Boolean(row?.amount.trim() || row?.penalty.trim())
  })
}

const hasAnyFeeValue = (value: ClientAssessmentInputs) =>
  FEE_DEFINITIONS.some((item) => {
    const row = value.fees[item.key]
    return Boolean(row?.amount.trim() || row?.penalty.trim())
  }) || value.additionalFees.some((fee) => Boolean(fee.amount.trim() || fee.penalty.trim()))

const hasRequiredDocumentReferences = (value: ClientAssessmentInputs) =>
  Boolean(value.cedula.trim() && value.officialReceipt.trim())

const computeAssessmentTotals = (fees: Record<FeeKey, FeeLineInput>, additionalFees: AdditionalFeeInput[]) => {
  const lineTotals = {} as Record<FeeKey, number>
  const additionalLineTotals: Record<string, number> = {}
  let lguTotal = 0
  let grandTotal = 0

  FEE_DEFINITIONS.forEach((item) => {
    const row = fees[item.key]
    const amount = parseOptionalNumber(row?.amount ?? "") ?? 0
    const penalty = parseOptionalNumber(row?.penalty ?? "") ?? 0
    const lineTotal = amount + penalty

    lineTotals[item.key] = lineTotal
    if (item.includeInLgu) lguTotal += lineTotal
    grandTotal += lineTotal
  })

  additionalFees.forEach((row) => {
    const amount = parseOptionalNumber(row.amount) ?? 0
    const penalty = parseOptionalNumber(row.penalty) ?? 0
    const lineTotal = amount + penalty

    additionalLineTotals[row.id] = lineTotal
    lguTotal += lineTotal
    grandTotal += lineTotal
  })

  return { lineTotals, additionalLineTotals, lguTotal, grandTotal }
}

const normalizeAssessmentInputs = (value: ClientAssessmentInputs): ClientAssessmentInputs => ({
  cedula: value.cedula.trim(),
  officialReceipt: value.officialReceipt.trim(),
  assessmentStatus: normalizeTreasuryAssessmentStatus(value.assessmentStatus),
  assessmentBasis: {
    grossSales: value.assessmentBasis.grossSales.trim(),
    capital: value.assessmentBasis.capital.trim(),
  },
  fees: FEE_DEFINITIONS.reduce((accumulator, item) => {
    const row = value.fees[item.key]
    accumulator[item.key] = { amount: row?.amount.trim() ?? "", penalty: row?.penalty.trim() ?? "" }
    return accumulator
  }, {} as Record<FeeKey, FeeLineInput>),
  additionalFees: value.additionalFees
    .map((fee) => ({
      ...fee,
      name: fee.name.trim(),
      amount: fee.amount.trim(),
      penalty: fee.penalty.trim(),
    }))
    .filter((fee) => fee.name || fee.amount || fee.penalty),
})

const numberToInputValue = (value: number | null | undefined) =>
  value === null || value === undefined ? "" : String(value)

const mapRecordToInputs = (record: TreasuryFeeAssessmentRecord | undefined): ClientAssessmentInputs => {
  const next = createEmptyAssessmentInputs()
  if (!record) return next

  next.cedula = typeof record.cedula_no === "string" ? record.cedula_no : ""
  next.officialReceipt = typeof record.or_no === "string" ? record.or_no : ""
  next.assessmentStatus = normalizeTreasuryAssessmentStatus(record.assessment_status)
  next.assessmentBasis.grossSales = toAmountInputString(record.gross_sales_amount)
  next.assessmentBasis.capital = toAmountInputString(record.capital_amount)

  FEE_DEFINITIONS.forEach((item) => {
    const feeLine = record.fees?.[item.key]
    next.fees[item.key] = {
      amount: numberToInputValue(feeLine?.amount),
      penalty: numberToInputValue(feeLine?.penalty),
    }
  })

  next.additionalFees = (record.additional_fees ?? []).map((fee) =>
    createAdditionalFeeInput({
      name: typeof fee.name === "string" ? fee.name : "",
      amount: numberToInputValue(fee.amount),
      penalty: numberToInputValue(fee.penalty),
    })
  )

  return next
}

const getApplicationUid = (record: BusinessApplicationRecord) => record.id
const parseApplicationDateTimestamp = (value?: string) => {
  const trimmed = (value ?? "").trim()
  if (!trimmed) return null

  const localDateMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (localDateMatch) {
    const year = Number(localDateMatch[1])
    const month = Number(localDateMatch[2])
    const day = Number(localDateMatch[3])
    const localDate = new Date(year, month - 1, day)
    const timestamp = localDate.getTime()
    return Number.isNaN(timestamp) ? null : timestamp
  }

  const parsed = new Date(trimmed)
  const timestamp = parsed.getTime()
  return Number.isNaN(timestamp) ? null : timestamp
}

const getApplicationDateTimestamp = (record: BusinessApplicationRecord) => {
  const parsedApplicationDate = parseApplicationDateTimestamp(record.applicationDate)
  if (parsedApplicationDate !== null) return parsedApplicationDate
  if (typeof record.submittedAt === "number" && Number.isFinite(record.submittedAt)) {
    return record.submittedAt
  }
  return null
}
const getApplicationYear = (record: BusinessApplicationRecord) => {
  const timestamp = getApplicationDateTimestamp(record)
  if (timestamp === null) return null
  return new Date(timestamp).getFullYear()
}
const getSortTimestamp = (record: BusinessApplicationRecord) =>
  getApplicationDateTimestamp(record) ?? record.submittedAt ?? 0

const normalizeNameToken = (value: unknown) =>
  String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")

const parseAmountLike = (value: unknown) => {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value !== "string") return 0
  const parsed = Number(value.replace(/,/g, "").trim())
  return Number.isFinite(parsed) ? parsed : 0
}

const getApplicantTaxpayerKey = (record: BusinessApplicationRecord) => {
  const form = (record.form ?? {}) as Record<string, unknown>
  const first = normalizeNameToken(form.firstName)
  const middle = normalizeNameToken(form.middleName)
  const last = normalizeNameToken(form.lastName)
  if (first || middle || last) {
    return `${first}|${middle}|${last}`
  }

  const applicantUidCandidates = [
    (record.applicantUid ?? "").toString().trim(),
    (record.form?.applicantUid ?? "").toString().trim(),
  ].filter(Boolean)

  if (applicantUidCandidates.length > 0) {
    return `applicant:${applicantUidCandidates[0].toLowerCase()}`
  }

  // Avoid accidentally grouping unknown-name, unknown-uid records together.
  return `application:${getApplicationUid(record)}`
}

const getComparableSalary = (record: BusinessApplicationRecord) => {
  const form = (record.form ?? {}) as Record<string, unknown>
  const directCandidates = [
    form.salary,
    form.monthlySalary,
    form.annualSalary,
    form.grossSales,
    form.capitalization,
    form.grossTotal,
    form.grossTotalInt,
    form.basisTotal,
    form.taxBasisTotal,
  ]

  const directMax = directCandidates.reduce<number>(
    (highest, value) => Math.max(highest, parseAmountLike(value)),
    0
  )
  const activityMax = Array.isArray(form.activities)
    ? form.activities.reduce<number>((highest, entry) => {
        const activity = (entry ?? {}) as Record<string, unknown>
        const gross = parseAmountLike(activity.grossSales)
        const capital = parseAmountLike(activity.capitalization)
        return Math.max(highest, gross, capital)
      }, 0)
    : 0

  return Math.max(directMax, activityMax)
}

type ApplicantGroupContext = {
  taxpayerKey: string
  applicationUids: string[]
  primaryApplicationUid: string
}

const getSharedCedulaValue = (
  applicationUids: string[],
  primaryApplicationUid: string,
  inputsByApplication: Record<string, ClientAssessmentInputs>
) => {
  const primary = inputsByApplication[primaryApplicationUid]
  if (primary?.cedula.trim()) {
    return primary.cedula
  }

  for (const applicationUid of applicationUids) {
    const candidate = inputsByApplication[applicationUid]
    if (!candidate) continue
    if (candidate.cedula.trim()) {
      return candidate.cedula
    }
  }

  return ""
}

const getAssessmentForClient = (
  record: BusinessApplicationRecord,
  byClientUid: Record<string, TreasuryFeeAssessmentRecord>
) => {
  const applicationUid = getApplicationUid(record)
  const exactMatch = byClientUid[applicationUid]
  if (exactMatch) return exactMatch

  const candidates = [
    (record.applicantUid ?? "").toString().trim(),
    (record.form?.applicantUid ?? "").toString().trim(),
  ].filter(Boolean)

  const matches = candidates
    .map((uid) => byClientUid[uid])
    .filter((value): value is TreasuryFeeAssessmentRecord => Boolean(value))

  if (matches.length === 0) return undefined
  if (matches.length === 1) return matches[0]

  return [...matches].sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0))[0]
}

const renderFeeSectionRows = (
  definitions: ReadonlyArray<{ key: FeeKey; label: string; section: FeeSection; includeInLgu: boolean }>,
  values: ClientAssessmentInputs,
  isEditing: boolean,
  lineTotals: Record<FeeKey, number>,
  onFeeValueChange: (feeKey: FeeKey, field: keyof FeeLineInput, value: string) => void,
  onInputKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void
) =>
  definitions.map((item) => {
    const row = values.fees[item.key]
    const hasValue = Boolean(row.amount.trim() || row.penalty.trim())
    const rowIndex = FEE_ROW_INDEX_BY_KEY[item.key]

    return (
      <tr key={item.key}>
        <td className="border-b border-r border-slate-500 px-3 py-2 text-slate-900">{item.label}</td>
        <td className="border-b border-r border-slate-500 px-3 py-2 text-right tabular-nums text-slate-800 whitespace-nowrap">
          {isEditing ? (
            <input
              type="text"
              inputMode="decimal"
              value={row.amount}
              onChange={(event) => onFeeValueChange(item.key, "amount", event.target.value)}
              onKeyDown={onInputKeyDown}
              data-nav-row={rowIndex}
              data-nav-col={1}
              className="h-9 w-full rounded-md border border-slate-400 px-2 text-right text-sm outline-none ring-emerald-300 focus:ring"
            />
          ) : (
            formatNumberCell(row.amount)
          )}
        </td>
        <td className="border-b border-r border-slate-500 px-3 py-2 text-right tabular-nums text-slate-800 whitespace-nowrap">
          {isEditing ? (
            <input
              type="text"
              inputMode="decimal"
              value={row.penalty}
              onChange={(event) => onFeeValueChange(item.key, "penalty", event.target.value)}
              onKeyDown={onInputKeyDown}
              data-nav-row={rowIndex}
              data-nav-col={2}
              className="h-9 w-full rounded-md border border-slate-400 px-2 text-right text-sm outline-none ring-emerald-300 focus:ring"
            />
          ) : (
            formatNumberCell(row.penalty)
          )}
        </td>
        <td className="border-b border-slate-500 px-3 py-2 text-right tabular-nums text-slate-800 whitespace-nowrap">
          {hasValue ? formatCurrency(lineTotals[item.key]) : "-"}
        </td>
      </tr>
    )
  })

const renderAdditionalFeeRows = (
  values: ClientAssessmentInputs,
  isEditing: boolean,
  additionalLineTotals: Record<string, number>,
  onAdditionalFeeValueChange: (id: string, field: "name" | keyof FeeLineInput, value: string) => void,
  onRemoveAdditionalFee: (id: string) => void,
  rowOffset: number,
  onInputKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void
) =>
  values.additionalFees.map((fee, index) => {
    const hasValue = Boolean(fee.amount.trim() || fee.penalty.trim())
    const rowIndex = rowOffset + index

    return (
      <tr key={fee.id}>
        <td className="border-b border-r border-slate-500 px-3 py-2 text-slate-900">
          {isEditing ? (
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={fee.name}
                onChange={(event) => onAdditionalFeeValueChange(fee.id, "name", event.target.value)}
                onKeyDown={onInputKeyDown}
                data-nav-row={rowIndex}
                data-nav-col={0}
                placeholder="Fee name"
                className="h-9 w-full rounded-md border border-slate-400 px-2 text-sm outline-none ring-emerald-300 focus:ring"
              />
              <button
                type="button"
                onClick={() => onRemoveAdditionalFee(fee.id)}
                className="inline-flex h-9 items-center justify-center rounded-md border border-slate-400 px-3 text-xs font-medium text-slate-700 hover:bg-slate-200"
              >
                Remove
              </button>
            </div>
          ) : (
            fee.name.trim() || "-"
          )}
        </td>
        <td className="border-b border-r border-slate-500 px-3 py-2 text-right tabular-nums text-slate-800 whitespace-nowrap">
          {isEditing ? (
            <input
              type="text"
              inputMode="decimal"
              value={fee.amount}
              onChange={(event) => onAdditionalFeeValueChange(fee.id, "amount", event.target.value)}
              onKeyDown={onInputKeyDown}
              data-nav-row={rowIndex}
              data-nav-col={1}
              className="h-9 w-full rounded-md border border-slate-400 px-2 text-right text-sm outline-none ring-emerald-300 focus:ring"
            />
          ) : (
            formatNumberCell(fee.amount)
          )}
        </td>
        <td className="border-b border-r border-slate-500 px-3 py-2 text-right tabular-nums text-slate-800 whitespace-nowrap">
          {isEditing ? (
            <input
              type="text"
              inputMode="decimal"
              value={fee.penalty}
              onChange={(event) => onAdditionalFeeValueChange(fee.id, "penalty", event.target.value)}
              onKeyDown={onInputKeyDown}
              data-nav-row={rowIndex}
              data-nav-col={2}
              className="h-9 w-full rounded-md border border-slate-400 px-2 text-right text-sm outline-none ring-emerald-300 focus:ring"
            />
          ) : (
            formatNumberCell(fee.penalty)
          )}
        </td>
        <td className="border-b border-slate-500 px-3 py-2 text-right tabular-nums text-slate-800 whitespace-nowrap">
          {hasValue ? formatCurrency(additionalLineTotals[fee.id] ?? 0) : "-"}
        </td>
      </tr>
    )
  })

export default function TreasuryClientsPage() {
  const auth = useMemo(() => getAuth(firebaseApp), [])
  const searchParams = useSearchParams()
  const [clients, setClients] = useState<BusinessApplicationRecord[]>([])
  const [authReady, setAuthReady] = useState(false)
  const [authUser, setAuthUser] = useState<User | null>(null)
  const [clientsLoading, setClientsLoading] = useState(true)
  const [clientsError, setClientsError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState("")
  const [selectedYear, setSelectedYear] = useState("all")
  const [feesByClient, setFeesByClient] = useState<Record<string, TreasuryFeeAssessmentRecord>>({})
  const [inputsByClient, setInputsByClient] = useState<Record<string, ClientAssessmentInputs>>({})
  const [savingClientUid, setSavingClientUid] = useState<string | null>(null)
  const [selectedClient, setSelectedClient] = useState<BusinessApplicationRecord | null>(null)
  const [editorValues, setEditorValues] = useState<ClientAssessmentInputs>(createEmptyAssessmentInputs)
  const [dialogInitialValues, setDialogInitialValues] = useState<ClientAssessmentInputs>(createEmptyAssessmentInputs)
  const [isDialogEditing, setIsDialogEditing] = useState(false)
  const [dialogFeedback, setDialogFeedback] = useState<SaveFeedback | null>(null)
  const [estimatedFeesByApplication, setEstimatedFeesByApplication] = useState<
    Record<string, MobileCalculatedFeeReference>
  >({})
  const estimatedFeesAccessDeniedRef = useRef(false)
  const autoPreviewHandledRef = useRef("")
  const [legacyMobileFeesByApplication, setLegacyMobileFeesByApplication] = useState<
    Record<string, MobileCalculatedFeeReference>
  >({})
  const previewApplicationUid = useMemo(() => {
    const shouldPreview = searchParams.get("preview") === "1"
    if (!shouldPreview) return ""
    return (searchParams.get("applicationId") ?? "").trim()
  }, [searchParams])

  const selectedApplicationUid = selectedClient ? getApplicationUid(selectedClient) : null
  const dialogIsSaving = selectedApplicationUid ? savingClientUid === selectedApplicationUid : false
  const applicantGroupsByApplication = useMemo(() => {
    const grouped = new Map<string, BusinessApplicationRecord[]>()

    clients.forEach((client) => {
      const taxpayerKey = getApplicantTaxpayerKey(client)
      const current = grouped.get(taxpayerKey) ?? []
      current.push(client)
      grouped.set(taxpayerKey, current)
    })

    const result: Record<string, ApplicantGroupContext> = {}
    grouped.forEach((records, taxpayerKey) => {
      const sorted = [...records].sort((a, b) => {
        const salaryDiff = getComparableSalary(b) - getComparableSalary(a)
        if (salaryDiff !== 0) return salaryDiff

        const submittedDiff = (b.submittedAt ?? 0) - (a.submittedAt ?? 0)
        if (submittedDiff !== 0) return submittedDiff

        return getApplicationUid(a).localeCompare(getApplicationUid(b))
      })

      const primaryApplicationUid = getApplicationUid(sorted[0])
      const applicationUids = records.map((record) => getApplicationUid(record))
      applicationUids.forEach((applicationUid) => {
        result[applicationUid] = {
          taxpayerKey,
          applicationUids,
          primaryApplicationUid,
        }
      })
    })

    return result
  }, [clients])
  const clientByApplicationUid = useMemo(() => {
    return clients.reduce((accumulator, client) => {
      accumulator[getApplicationUid(client)] = client
      return accumulator
    }, {} as Record<string, BusinessApplicationRecord>)
  }, [clients])
  const displayInputsByApplication = useMemo(() => {
    const next: Record<string, ClientAssessmentInputs> = {}

    clients.forEach((client) => {
      const applicationUid = getApplicationUid(client)
      const group = applicantGroupsByApplication[applicationUid]
      if (!group) {
        next[applicationUid] = cloneAssessmentInputs(inputsByClient[applicationUid] ?? EMPTY_ASSESSMENT_INPUTS)
        return
      }

      const sharedCedula = getSharedCedulaValue(
        group.applicationUids,
        group.primaryApplicationUid,
        inputsByClient
      )

      if (group.primaryApplicationUid === applicationUid) {
        const primary = inputsByClient[applicationUid] ?? EMPTY_ASSESSMENT_INPUTS
        next[applicationUid] = {
          ...cloneAssessmentInputs(primary),
          cedula: sharedCedula,
        }
        return
      }

      const nonPrimary = createEmptyAssessmentInputs()
      const existingNonPrimary = inputsByClient[applicationUid] ?? EMPTY_ASSESSMENT_INPUTS
      nonPrimary.cedula = sharedCedula
      nonPrimary.officialReceipt = existingNonPrimary.officialReceipt
      nonPrimary.assessmentStatus = existingNonPrimary.assessmentStatus
      next[applicationUid] = nonPrimary
    })

    return next
  }, [clients, inputsByClient, applicantGroupsByApplication])
  const dialogTotals = useMemo(
    () => computeAssessmentTotals(editorValues.fees, editorValues.additionalFees),
    [editorValues.fees, editorValues.additionalFees]
  )
  const dialogHasFeeValues = useMemo(
    () =>
      FEE_DEFINITIONS.some((item) => {
        const row = editorValues.fees[item.key]
        return Boolean(row.amount.trim() || row.penalty.trim())
      }) ||
      editorValues.additionalFees.some((fee) => Boolean(fee.amount.trim() || fee.penalty.trim())),
    [editorValues.fees, editorValues.additionalFees]
  )
  const dialogHasUnsavedChanges = useMemo(() => {
    return (
      serializeAssessmentInputsForComparison(editorValues) !==
      serializeAssessmentInputsForComparison(dialogInitialValues)
    )
  }, [editorValues, dialogInitialValues])
  const selectedMobileFeeReference = useMemo(() => {
    if (!selectedClient) return null

    const selectedApplicationUid = getApplicationUid(selectedClient)
    const selectedGroup = applicantGroupsByApplication[selectedApplicationUid]
    const candidateApplicationUids = selectedGroup?.applicationUids ?? [selectedApplicationUid]
    const references = candidateApplicationUids
      .map((applicationUid) => {
        return (
          estimatedFeesByApplication[applicationUid] ??
          legacyMobileFeesByApplication[applicationUid] ??
          null
        )
      })
      .filter((entry): entry is MobileCalculatedFeeReference => entry !== null)

    if (references.length === 0) {
      return null
    }

    return [...references].sort(
      (left, right) => (right.computedAt ?? 0) - (left.computedAt ?? 0)
    )[0]
  }, [
    selectedClient,
    applicantGroupsByApplication,
    estimatedFeesByApplication,
    legacyMobileFeesByApplication,
  ])
  const selectedBusinessBasisField = getBusinessBasisFieldByApplicationType(selectedClient?.applicationType)
  const selectedBusinessBasisLabel =
    selectedBusinessBasisField === "capital" ? "Capitalization (New Business)" : "Gross Sales (Renewal)"
  const assessmentBasisBaseNavRow = FEE_DEFINITIONS.length + editorValues.additionalFees.length
  const assessmentBasisRowCount = 1
  const cedulaNavRow = assessmentBasisBaseNavRow + assessmentBasisRowCount
  const officialReceiptNavRow = cedulaNavRow + 1
  const selectedBusinessBasisNote =
    selectedBusinessBasisField === "capital"
      ? "For New businesses, basis uses capitalization."
      : "For Renewal businesses, basis uses gross sales."

  const fetchLatestEstimatedFees = useCallback(async () => {
    if (!authReady || !authUser) {
      setEstimatedFeesByApplication({})
      return
    }
    if (estimatedFeesAccessDeniedRef.current) {
      return
    }

    try {
      const directSnapshot = await get(ref(realtimeDb, ESTIMATED_FEES_PATH))
      const directNode = directSnapshot.exists() ? (directSnapshot.val() as unknown) : {}
      setEstimatedFeesByApplication(normalizeEstimatedFeeRecordMap(directNode))
    } catch (error) {
      if (isPermissionDeniedError(error)) {
        estimatedFeesAccessDeniedRef.current = true
        setEstimatedFeesByApplication({})
        return
      }
      setEstimatedFeesByApplication({})
      console.warn(
        "Direct mobile-calculated estimated fees are unavailable; using legacy references.",
        error
      )
    }
  }, [authReady, authUser])

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setAuthUser(user)
      setAuthReady(true)
    })
    return unsubscribe
  }, [auth])

  useEffect(() => {
    if (!authReady) {
      setClientsLoading(true)
      return
    }
    if (!authUser) {
      setClients([])
      setLegacyMobileFeesByApplication({})
      setClientsError("Treasury session expired. Please sign in again.")
      setClientsLoading(false)
      return
    }

    setClientsLoading(true)
    setClientsError(null)

    const businessRef = ref(realtimeDb, BUSINESS_APPLICATION_PATH)
    const unsubscribe = onValue(
      businessRef,
      (snapshot) => {
        if (!snapshot.exists()) {
          setClients([])
          setLegacyMobileFeesByApplication({})
          setClientsLoading(false)
          return
        }

        const node = snapshot.val() as Record<string, Record<string, any>>
        const legacyByApplication: Record<string, MobileCalculatedFeeReference> = {}

        Object.entries(node).forEach(([applicationUid, payload]) => {
          const normalizedLegacy = normalizeLegacyBusinessFeeReference(
            applicationUid,
            payload as Record<string, unknown>
          )
          if (normalizedLegacy) {
            legacyByApplication[applicationUid] = normalizedLegacy
          }
        })

        const parsed = Object.entries(node).map(([id, payload]) => normalizeBusinessApplication(id, payload))
        const submitted = parsed.filter((record) => Boolean(record.form) && Object.keys(record.form ?? {}).length > 0)

        setLegacyMobileFeesByApplication(legacyByApplication)
        setClients(submitted)
        setClientsLoading(false)
      },
      (error) => {
        console.error("Failed to load treasury clients", error)
        setClients([])
        setLegacyMobileFeesByApplication({})
        setClientsError("Unable to load client records right now.")
        setClientsLoading(false)
      }
    )

    return () => unsubscribe()
  }, [authReady, authUser])

  useEffect(() => {
    if (!authReady || !authUser) {
      setFeesByClient({})
      return
    }

    const stop = watchTreasuryFeesByClient(
      (records) => setFeesByClient(records),
      (error) => console.error("Failed to load treasury fee assessments", error)
    )

    return () => stop()
  }, [authReady, authUser])

  useEffect(() => {
    void fetchLatestEstimatedFees()
  }, [fetchLatestEstimatedFees])

  useEffect(() => {
    setInputsByClient(() => {
      const next: Record<string, ClientAssessmentInputs> = {}
      clients.forEach((client) => {
        const applicationUid = getApplicationUid(client)
        next[applicationUid] = mapRecordToInputs(getAssessmentForClient(client, feesByClient))
      })
      return next
    })
  }, [clients, feesByClient])

  const availableYears = useMemo(() => {
    const years = new Set<number>()
    clients.forEach((client) => {
      const year = getApplicationYear(client)
      if (year !== null) years.add(year)
    })
    return [...years].sort((left, right) => right - left)
  }, [clients])

  const filteredClients = useMemo(() => {
    const normalizedSearch = searchQuery.trim().toLowerCase()
    const selectedYearValue = selectedYear === "all" ? null : Number(selectedYear)

    return clients
      .filter((client) => {
        const fullName = (client.applicantName ?? "").toLowerCase()
        const businessName = (client.businessName ?? "").toLowerCase()
        const matchesSearch =
          !normalizedSearch ||
          fullName.includes(normalizedSearch) ||
          businessName.includes(normalizedSearch)

        if (!matchesSearch) return false
        if (selectedYearValue === null) return true

        return getApplicationYear(client) === selectedYearValue
      })
      .sort((left, right) => {
        const timestampDiff = getSortTimestamp(right) - getSortTimestamp(left)
        if (timestampDiff !== 0) return timestampDiff
        return getApplicationUid(left).localeCompare(getApplicationUid(right))
      })
  }, [clients, searchQuery, selectedYear])

  const openClientPreview = async (record: BusinessApplicationRecord) => {
    await fetchLatestEstimatedFees()

    const applicationUid = getApplicationUid(record)
    const group = applicantGroupsByApplication[applicationUid]
    const sourceUid = group?.primaryApplicationUid ?? applicationUid
    const existing = displayInputsByApplication[sourceUid] ?? EMPTY_ASSESSMENT_INPUTS
    const selectedRowValues = displayInputsByApplication[applicationUid] ?? EMPTY_ASSESSMENT_INPUTS
    const previewValues = cloneAssessmentInputs(existing)
    const fallbackAssessmentBasis = getAssessmentBasisFromForm(record)
    previewValues.assessmentBasis = enforceBusinessBasisByApplicationType(record.applicationType, {
      grossSales: previewValues.assessmentBasis.grossSales || fallbackAssessmentBasis.grossSales,
      capital: previewValues.assessmentBasis.capital || fallbackAssessmentBasis.capital,
    })
    previewValues.fees = enforceBusinessTaxByApplicationType(record.applicationType, previewValues.fees)
    previewValues.cedula = selectedRowValues.cedula
    previewValues.officialReceipt = selectedRowValues.officialReceipt
    previewValues.assessmentStatus = selectedRowValues.assessmentStatus
    setSelectedClient(record)
    setEditorValues(previewValues)
    setDialogInitialValues(cloneAssessmentInputs(previewValues))
    setIsDialogEditing(!hasAnyAssessmentValue(existing))
    setDialogFeedback(null)
  }

  useEffect(() => {
    if (!previewApplicationUid || clientsLoading) return
    if (autoPreviewHandledRef.current === previewApplicationUid) return

    const target = clients.find((client) => getApplicationUid(client) === previewApplicationUid)
    if (!target) return
    if (!getAssessmentForClient(target, feesByClient)) return

    autoPreviewHandledRef.current = previewApplicationUid
    void openClientPreview(target)
  }, [previewApplicationUid, clientsLoading, clients, feesByClient])

  const persistAssessmentStatus = async (
    record: BusinessApplicationRecord,
    assessmentStatus: TreasuryAssessmentStatus
  ) => {
    const applicationUid = getApplicationUid(record)
    const selectedGroup = applicantGroupsByApplication[applicationUid]
    const primaryApplicationUid = selectedGroup?.primaryApplicationUid ?? applicationUid
    const groupedApplicationUids = Array.from(new Set(selectedGroup?.applicationUids ?? [applicationUid]))

    try {
      if (!authUser) throw new Error("Treasury session expired. Please sign in again.")
      const liveUser = auth.currentUser
      if (!liveUser) throw new Error("Treasury session expired. Please sign in again.")
      if (liveUser.uid !== authUser.uid) {
        throw new Error("Treasury session changed. Please sign in again.")
      }

      const primaryInputs = displayInputsByApplication[primaryApplicationUid] ?? EMPTY_ASSESSMENT_INPUTS
      const normalizedPrimary = normalizeAssessmentInputs(primaryInputs)
      const primaryClient = clientByApplicationUid[primaryApplicationUid]
      const normalizedPrimaryForSave: ClientAssessmentInputs = {
        ...normalizedPrimary,
        fees: enforceBusinessTaxByApplicationType(primaryClient?.applicationType, normalizedPrimary.fees),
      }
      const totals = computeAssessmentTotals(
        normalizedPrimaryForSave.fees,
        normalizedPrimaryForSave.additionalFees
      )
      const feesPayload = FEE_DEFINITIONS.reduce((accumulator, item) => {
        const row = normalizedPrimaryForSave.fees[item.key]
        const amount = parseOptionalNumber(row.amount)
        const penalty = parseOptionalNumber(row.penalty)
        accumulator[item.key] = {
          amount,
          penalty,
          total: (amount ?? 0) + (penalty ?? 0),
        } satisfies TreasuryFeeLine
        return accumulator
      }, {} as Record<string, TreasuryFeeLine>)
      const additionalFeesPayload: TreasuryAdditionalFeeLine[] = normalizedPrimaryForSave.additionalFees.map((row) => {
        const amount = parseOptionalNumber(row.amount)
        const penalty = parseOptionalNumber(row.penalty)

        return {
          name: row.name.trim() || "Additional Fee",
          amount,
          penalty,
          total: (amount ?? 0) + (penalty ?? 0),
        }
      })

      setSavingClientUid(applicationUid)
      await Promise.all(
        groupedApplicationUids.map((groupApplicationUid) => {
          const isPrimary = groupApplicationUid === primaryApplicationUid
          const currentInputs = displayInputsByApplication[groupApplicationUid] ?? EMPTY_ASSESSMENT_INPUTS
          const targetClient = clientByApplicationUid[groupApplicationUid]
          const targetAssessmentBasis = enforceBusinessBasisByApplicationType(
            targetClient?.applicationType,
            normalizedPrimaryForSave.assessmentBasis
          )

          return saveTreasuryFeeAssessment({
            applicationUid: groupApplicationUid,
            cedulaNumber: currentInputs.cedula,
            officialReceiptNumber: currentInputs.officialReceipt,
            salaryAmount: "",
            grossSalesAmount: targetAssessmentBasis.grossSales,
            capitalAmount: targetAssessmentBasis.capital,
            fees: isPrimary ? feesPayload : {},
            additionalFees: isPrimary ? additionalFeesPayload : [],
            lguTotal: isPrimary ? totals.lguTotal : 0,
            grandTotal: isPrimary ? totals.grandTotal : 0,
            assessmentStatus,
            allowMissingDocumentReferences: true,
            staffUid: authUser.uid,
            staffEmail: authUser.email ?? null,
          })
        })
      )

      setInputsByClient((previous) => {
        const next = { ...previous }
        groupedApplicationUids.forEach((groupApplicationUid) => {
          const existing = next[groupApplicationUid] ?? createEmptyAssessmentInputs()
          next[groupApplicationUid] = {
            ...cloneAssessmentInputs(existing),
            assessmentStatus,
          }
        })
        return next
      })
    } catch (error) {
      console.error("Failed to persist treasury assessment status", error)
      const message = error instanceof Error ? error.message : "Unable to update status right now."
      toast.error(message)
    } finally {
      setSavingClientUid(null)
    }
  }

  const handleDialogOpenChange = (open: boolean) => {
    if (open) return
    if (selectedClient) {
      const currentStatus = normalizeTreasuryAssessmentStatus(editorValues.assessmentStatus)
      void persistAssessmentStatus(selectedClient, currentStatus)
    }
    setSelectedClient(null)
    setEditorValues(createEmptyAssessmentInputs())
    setDialogInitialValues(createEmptyAssessmentInputs())
    setIsDialogEditing(false)
    setDialogFeedback(null)
  }

  const handleAssessmentStatusChange = (nextStatus: TreasuryAssessmentStatus) => {
    setEditorValues((previous) => ({ ...previous, assessmentStatus: nextStatus }))
  }

  const handleDocumentValueChange = (field: "cedula" | "officialReceipt", value: string) => {
    setEditorValues((previous) => ({ ...previous, [field]: value }))
  }

  const handleAssessmentBasisValueChange = (
    field: keyof AssessmentBasisInput,
    value: string
  ) => {
    setEditorValues((previous) => ({
      ...previous,
      assessmentBasis: {
        ...previous.assessmentBasis,
        [field]: value,
      },
    }))
  }

  const handleFeeValueChange = (feeKey: FeeKey, field: keyof FeeLineInput, value: string) => {
    setEditorValues((previous) => ({
      ...previous,
      fees: {
        ...previous.fees,
        [feeKey]: {
          ...previous.fees[feeKey],
          [field]: value,
        },
      },
    }))
  }

  const handleAdditionalFeeValueChange = (
    id: string,
    field: "name" | keyof FeeLineInput,
    value: string
  ) => {
    setEditorValues((previous) => ({
      ...previous,
      additionalFees: previous.additionalFees.map((fee) => (fee.id === id ? { ...fee, [field]: value } : fee)),
    }))
  }

  const handleAddAdditionalFee = () => {
    setEditorValues((previous) => ({
      ...previous,
      additionalFees: [...previous.additionalFees, createAdditionalFeeInput()],
    }))
  }

  const handleRemoveAdditionalFee = (id: string) => {
    setEditorValues((previous) => ({
      ...previous,
      additionalFees: previous.additionalFees.filter((fee) => fee.id !== id),
    }))
  }

  const handleAssessmentInputArrowNavigation = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const key = event.key
    if (key !== "ArrowUp" && key !== "ArrowDown" && key !== "ArrowLeft" && key !== "ArrowRight") return

    const current = event.currentTarget
    const currentRow = Number(current.dataset.navRow)
    const currentCol = Number(current.dataset.navCol)
    if (!Number.isFinite(currentRow) || !Number.isFinite(currentCol)) return

    const scope = current.closest("[data-nav-scope='treasury-assessment']")
    if (!scope) return

    const allInputs = Array.from(
      scope.querySelectorAll<HTMLInputElement>("input[data-nav-row][data-nav-col]")
    ).filter((input) => !input.disabled)

    if (allInputs.length === 0) return

    const rows = new Map<number, Array<{ col: number; input: HTMLInputElement }>>()
    allInputs.forEach((input) => {
      const row = Number(input.dataset.navRow)
      const col = Number(input.dataset.navCol)
      if (!Number.isFinite(row) || !Number.isFinite(col)) return
      const bucket = rows.get(row) ?? []
      bucket.push({ col, input })
      rows.set(row, bucket)
    })

    rows.forEach((cells) => cells.sort((a, b) => a.col - b.col))

    const pickClosestInRow = (row: number, preferredCol: number) => {
      const candidates = rows.get(row)
      if (!candidates || candidates.length === 0) return null
      return candidates.reduce((best, candidate) => {
        if (!best) return candidate
        const bestDistance = Math.abs(best.col - preferredCol)
        const candidateDistance = Math.abs(candidate.col - preferredCol)
        return candidateDistance < bestDistance ? candidate : best
      }, null as { col: number; input: HTMLInputElement } | null)
    }

    let next: HTMLInputElement | null = null

    if (key === "ArrowLeft" || key === "ArrowRight") {
      const currentRowCells = rows.get(currentRow) ?? []
      const currentIndex = currentRowCells.findIndex((cell) => cell.input === current)
      if (currentIndex >= 0) {
        const targetIndex = key === "ArrowLeft" ? currentIndex - 1 : currentIndex + 1
        next = currentRowCells[targetIndex]?.input ?? null
      }
    } else {
      const sortedRows = Array.from(rows.keys()).sort((a, b) => a - b)
      const currentRowIndex = sortedRows.indexOf(currentRow)
      if (currentRowIndex >= 0) {
        const step = key === "ArrowUp" ? -1 : 1
        for (let index = currentRowIndex + step; index >= 0 && index < sortedRows.length; index += step) {
          const candidateRow = sortedRows[index]
          const closest = pickClosestInRow(candidateRow, currentCol)
          if (closest) {
            next = closest.input
            break
          }
        }
      }
    }

    if (!next || next === current) return
    event.preventDefault()
    next.focus()
    next.select()
  }

  const handleSaveFromDialog = async () => {
    if (!selectedClient) return

    const normalized = normalizeAssessmentInputs(editorValues)
    if (!hasRequiredDocumentReferences(normalized)) {
      const message = "Cedula Number and Official Receipt Number are required before saving."
      setDialogFeedback({ type: "error", message })
      toast.error(message)
      return
    }

    const applicationUid = getApplicationUid(selectedClient)
    const selectedGroup = applicantGroupsByApplication[applicationUid]
    const primaryApplicationUid = selectedGroup?.primaryApplicationUid ?? applicationUid
    const groupedApplicationUids = Array.from(
      new Set(selectedGroup?.applicationUids ?? [applicationUid])
    )
    setSavingClientUid(applicationUid)
    setDialogFeedback(null)

    try {
      if (!authUser) throw new Error("Treasury session expired. Please sign in again.")
      const liveUser = auth.currentUser
      if (!liveUser) throw new Error("Treasury session expired. Please sign in again.")
      if (liveUser.uid !== authUser.uid) {
        throw new Error("Treasury session changed. Please sign in again.")
      }

      const resolvedAssessmentStatus: TreasuryAssessmentStatus = normalizeTreasuryAssessmentStatus(
        normalized.assessmentStatus
      )
      const normalizedForSave: ClientAssessmentInputs = {
        ...normalized,
        assessmentStatus: resolvedAssessmentStatus,
        assessmentBasis: enforceBusinessBasisByApplicationType(
          selectedClient.applicationType,
          normalized.assessmentBasis
        ),
      }
      const primaryClient = clientByApplicationUid[primaryApplicationUid]
      const normalizedForSaveWithTaxRule: ClientAssessmentInputs = {
        ...normalizedForSave,
        fees: enforceBusinessTaxByApplicationType(primaryClient?.applicationType, normalizedForSave.fees),
      }

      const totals = computeAssessmentTotals(
        normalizedForSaveWithTaxRule.fees,
        normalizedForSaveWithTaxRule.additionalFees
      )
      const feesPayload = FEE_DEFINITIONS.reduce((accumulator, item) => {
        const row = normalizedForSaveWithTaxRule.fees[item.key]
        const amount = parseOptionalNumber(row.amount)
        const penalty = parseOptionalNumber(row.penalty)
        accumulator[item.key] = {
          amount,
          penalty,
          total: (amount ?? 0) + (penalty ?? 0),
        } satisfies TreasuryFeeLine
        return accumulator
      }, {} as Record<string, TreasuryFeeLine>)
      const additionalFeesPayload: TreasuryAdditionalFeeLine[] = normalizedForSaveWithTaxRule.additionalFees.map((row) => {
        const amount = parseOptionalNumber(row.amount)
        const penalty = parseOptionalNumber(row.penalty)

        return {
          name: row.name.trim() || "Additional Fee",
          amount,
          penalty,
          total: (amount ?? 0) + (penalty ?? 0),
        }
      })

      await Promise.all(
        groupedApplicationUids.map((groupApplicationUid) => {
          const isPrimary = groupApplicationUid === primaryApplicationUid
          const currentInputs = displayInputsByApplication[groupApplicationUid] ?? EMPTY_ASSESSMENT_INPUTS
          const officialReceiptNumber =
            groupApplicationUid === applicationUid
              ? normalized.officialReceipt
              : currentInputs.officialReceipt.trim()
          const targetClient = clientByApplicationUid[groupApplicationUid]
          const targetAssessmentBasis = enforceBusinessBasisByApplicationType(
            targetClient?.applicationType,
            normalizedForSaveWithTaxRule.assessmentBasis
          )
          return saveTreasuryFeeAssessment({
            applicationUid: groupApplicationUid,
            cedulaNumber: normalized.cedula,
            officialReceiptNumber,
            salaryAmount: "",
            grossSalesAmount: targetAssessmentBasis.grossSales,
            capitalAmount: targetAssessmentBasis.capital,
            fees: isPrimary ? feesPayload : {},
            additionalFees: isPrimary ? additionalFeesPayload : [],
            lguTotal: isPrimary ? totals.lguTotal : 0,
            grandTotal: isPrimary ? totals.grandTotal : 0,
            assessmentStatus: resolvedAssessmentStatus,
            staffUid: authUser.uid,
            staffEmail: authUser.email ?? null,
          })
        })
      )

      setInputsByClient((previous) => {
        const next = { ...previous }

        groupedApplicationUids.forEach((groupApplicationUid) => {
          const existing = previous[groupApplicationUid] ?? EMPTY_ASSESSMENT_INPUTS
          const nextOfficialReceipt =
            groupApplicationUid === applicationUid
              ? normalizedForSave.officialReceipt
              : existing.officialReceipt.trim()
          const targetClient = clientByApplicationUid[groupApplicationUid]
          const targetAssessmentBasis = enforceBusinessBasisByApplicationType(
            targetClient?.applicationType,
            normalizedForSaveWithTaxRule.assessmentBasis
          )
          const primarySnapshot = cloneAssessmentInputs({
            ...normalizedForSaveWithTaxRule,
            assessmentBasis: targetAssessmentBasis,
          })
          const nonPrimarySnapshot = cloneAssessmentInputs({
            ...createEmptyAssessmentInputs(),
            cedula: normalizedForSave.cedula,
            officialReceipt: nextOfficialReceipt,
            assessmentStatus: resolvedAssessmentStatus,
            assessmentBasis: targetAssessmentBasis,
          })
          next[groupApplicationUid] =
            groupApplicationUid === primaryApplicationUid
              ? {
                  ...primarySnapshot,
                  cedula: normalizedForSave.cedula,
                  officialReceipt: nextOfficialReceipt,
                }
              : nonPrimarySnapshot
        })

        return next
      })
      setSelectedClient(null)
      setEditorValues(createEmptyAssessmentInputs())
      setDialogInitialValues(createEmptyAssessmentInputs())
      setDialogFeedback(null)
      toast.success("Saved")
      setIsDialogEditing(false)
    } catch (error) {
      console.error("Failed to save treasury fee assessment", error)
      const message = error instanceof Error ? error.message : "Save failed. Please try again."
      setDialogFeedback({ type: "error", message })
      toast.error(message)
    } finally {
      setSavingClientUid(null)
    }
  }

  return (
    <TreasuryShell
      activeNav="clients"
      title="Clients"
      description="Submitted business application forms with fee assessment and treasury references."
    >
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm md:p-5">
        <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-sm text-slate-600">Total submitted applications</p>
            <p className="text-2xl font-semibold text-slate-900">{clientsLoading ? "..." : filteredClients.length}</p>
          </div>
          <div className="flex w-full flex-col gap-2 md:w-auto md:flex-row">
            <input
              type="text"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search clients by name..."
              className="h-10 w-full rounded-md border border-slate-300 px-3 text-sm outline-none ring-emerald-200 focus:ring md:w-72"
            />
            <select
              value={selectedYear}
              onChange={(event) => setSelectedYear(event.target.value)}
              className="h-10 rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-700 outline-none ring-emerald-200 focus:ring md:w-40"
            >
              <option value="all">All Years</option>
              {availableYears.map((year) => (
                <option key={year} value={String(year)}>
                  {year}
                </option>
              ))}
            </select>
          </div>
        </div>

        {clientsError ? (
          <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{clientsError}</div>
        ) : null}

        <div className="overflow-x-hidden">
          <table className="w-full table-fixed border-collapse">
            <thead>
              <tr className="bg-emerald-700 text-left text-sm text-white">
                <th className="px-3 py-3 font-medium">No.</th>
                <th className="px-3 py-3 font-medium">Client</th>
                <th className="px-3 py-3 font-medium">Application Date</th>
                <th className="px-3 py-3 font-medium">Type</th>
                <th className="px-3 py-3 font-medium">Status</th>
                <th className="px-3 py-3 font-medium">Cedula No.</th>
                <th className="px-3 py-3 font-medium">OR No.</th>
                <th className="px-3 py-3 font-medium text-right">Total Paid</th>
              </tr>
            </thead>
            <tbody>
              {clientsLoading ? (
                <tr>
                  <td colSpan={8} className="border-b border-slate-200 px-3 py-6 text-center text-sm text-slate-500">Loading clients...</td>
                </tr>
              ) : filteredClients.length === 0 ? (
                <tr>
                  <td colSpan={8} className="border-b border-slate-200 px-3 py-6 text-center text-sm text-slate-500">No matching clients found.</td>
                </tr>
              ) : (
                filteredClients.map((client, index) => {
                  const applicationUid = getApplicationUid(client)
                  const row = displayInputsByApplication[applicationUid] ?? EMPTY_ASSESSMENT_INPUTS
                  const status = normalizeTreasuryAssessmentStatus(row.assessmentStatus)
                  const groupedClient = applicantGroupsByApplication[applicationUid]
                  const primaryClient = groupedClient
                    ? clientByApplicationUid[groupedClient.primaryApplicationUid]
                    : client
                  const paidAssessment =
                    (primaryClient ? getAssessmentForClient(primaryClient, feesByClient) : undefined) ??
                    getAssessmentForClient(client, feesByClient)
                  const paidTotal =
                    typeof paidAssessment?.grand_total === "number" &&
                    Number.isFinite(paidAssessment.grand_total)
                      ? paidAssessment.grand_total
                      : 0
                  const formattedDate = (() => {
                    const timestamp = getApplicationDateTimestamp(client)
                    if (timestamp === null) return "-"
                    return new Date(timestamp).toLocaleDateString()
                  })()

                  return (
                    <tr
                      key={client.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => openClientPreview(client)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault()
                          openClientPreview(client)
                        }
                      }}
                      className="cursor-pointer border-b border-slate-200 text-sm text-slate-700 transition-colors hover:bg-slate-50 focus-within:bg-slate-50"
                    >
                      <td className="px-3 py-3">{index + 1}</td>
                      <td className="px-3 py-3 break-words">
                        <p className="font-medium text-slate-900">{client.applicantName}</p>
                        {client.businessName ? <p className="text-xs text-slate-500">{client.businessName}</p> : null}
                      </td>
                      <td className="px-3 py-3">{formattedDate}</td>
                      <td className="px-3 py-3">
                        <span
                          className={`inline-flex rounded-full border px-2 py-1 text-xs font-semibold ${getApplicationTypeBadgeClassName(
                            client.applicationType
                          )}`}
                        >
                          {client.applicationType}
                        </span>
                      </td>
                      <td className="px-3 py-3">
                        <span
                          className={
                            status === "paid"
                              ? "font-medium text-emerald-700"
                              : status === "unpaid"
                                ? "font-medium text-rose-700"
                                : "font-medium text-amber-700"
                          }
                        >
                          {getTreasuryAssessmentStatusLabel(status)}
                        </span>
                      </td>
                      <td className="px-3 py-3"><span className={row.cedula.trim() ? "font-medium text-slate-800" : "text-slate-400"}>{row.cedula.trim() || "-"}</span></td>
                      <td className="px-3 py-3"><span className={row.officialReceipt.trim() ? "font-medium text-slate-800" : "text-slate-400"}>{row.officialReceipt.trim() || "-"}</span></td>
                      <td className="px-3 py-3 text-right tabular-nums">
                        <span className={status === "paid" ? "font-medium text-slate-900" : "text-slate-400"}>
                          {status === "paid" ? formatCurrency(paidTotal) : "-"}
                        </span>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      <Dialog open={Boolean(selectedClient)} onOpenChange={handleDialogOpenChange}>
        <DialogContent className="h-[calc(100vh-0.75rem)] w-[90vw] max-w-[86rem] sm:max-w-[86rem] gap-0 overflow-hidden p-0">
          <DialogHeader className="border-b border-slate-400 bg-slate-100 px-6 py-4">
            <DialogTitle className="flex flex-wrap items-center gap-2 text-xl text-slate-950">
              <span>Assessment Preview</span>
              {selectedClient ? (
                <span
                  className={`inline-flex rounded-full border px-2 py-1 text-xs font-semibold ${getApplicationTypeBadgeClassName(
                    selectedClient.applicationType
                  )}`}
                >
                  {selectedClient.applicationType}
                </span>
              ) : null}
            </DialogTitle>
            <DialogDescription className="text-slate-700">
              {selectedClient
                ? `${selectedClient.applicantName || "Client"}${selectedClient.businessName ? ` • ${selectedClient.businessName}` : ""}`
                : "Preview and update fee assessment details."}
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-[70vh] overflow-y-auto bg-slate-200 p-6" data-nav-scope="treasury-assessment">
            <div className="space-y-5">
              <div className="rounded-lg border border-slate-400 bg-slate-50 p-4">
                <p className="text-sm font-semibold text-slate-900">What This Form Is For</p>
                <p className="mt-2 text-sm text-slate-600">This form is used to assess local taxes, compute regulatory fees, add inspection charges, and calculate the Grand Total for business permit approval.</p>
                <p className="mt-2 text-xs text-slate-500">Typical use: Mayor's Permit application, business renewal, and new business registration.</p>
              </div>

              <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
                <p className="text-sm font-semibold text-amber-900">Mobile-App Calculated Fee Reference (Prepared by External Team)</p>
                <p className="mt-2 text-xs text-amber-800">
                  Reference-only basis for treasury checking. These values are from the mobile app and are not final treasury-assessed fees.
                </p>

                {selectedMobileFeeReference ? (
                  <div className="mt-3 space-y-3">
                    <div className="overflow-x-auto rounded-md border border-amber-200 bg-white">
                      <table className="w-full min-w-[420px] border-collapse text-sm">
                        <thead>
                          <tr className="bg-amber-100 text-amber-900">
                            <th className="border-b border-r border-amber-200 px-3 py-2 text-left font-semibold">Mobile Calculated Fee</th>
                            <th className="border-b border-amber-200 px-3 py-2 text-right font-semibold whitespace-nowrap">Amount</th>
                          </tr>
                        </thead>
                        <tbody>
                          {selectedMobileFeeReference.breakdown.length === 0 ? (
                            <tr>
                              <td colSpan={2} className="px-3 py-3 text-xs text-amber-800">
                                No mobile-calculated fee breakdown was provided.
                              </td>
                            </tr>
                          ) : (
                            selectedMobileFeeReference.breakdown.map((item) => (
                              <tr key={`${item.label}-${item.amount}`} className="text-slate-800">
                                <td className="border-b border-r border-amber-100 px-3 py-2">{item.label}</td>
                                <td className="border-b border-amber-100 px-3 py-2 text-right tabular-nums whitespace-nowrap">
                                  {formatCurrency(item.amount)}
                                </td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>

                    <p className="text-xs font-semibold text-amber-900 md:text-right">
                      <span>Estimated Total:</span>{" "}
                      {selectedMobileFeeReference.estimatedTotal !== null
                        ? formatCurrency(selectedMobileFeeReference.estimatedTotal)
                        : "-"}
                    </p>
                  </div>
                ) : (
                  <p className="mt-3 text-sm text-amber-800">
                    No mobile-calculated fee reference found for this application.
                  </p>
                )}
              </div>

              <div className="overflow-hidden rounded-lg border-2 border-slate-500 bg-white">
                <div className="border-b border-slate-500 bg-slate-300 px-4 py-3">
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-800">Assessment Basis (Editable)</p>
                </div>
                <div className="grid grid-cols-12 border-b border-slate-500 bg-slate-200 text-[11px] font-semibold uppercase tracking-wide text-slate-700">
                  <div className="col-span-4 border-r border-slate-500 px-3 py-2">Field</div>
                  <div className="col-span-4 border-r border-slate-500 px-3 py-2">Amount</div>
                  <div className="col-span-4 px-3 py-2">Notes</div>
                </div>

                <div className="grid grid-cols-12 bg-white">
                  <div className="col-span-4 border-r border-slate-500 px-3 py-3 text-sm font-medium text-slate-900">{selectedBusinessBasisLabel}</div>
                  <div className="col-span-4 border-r border-slate-500 px-3 py-2">
                    {isDialogEditing ? (
                      <input
                        type="text"
                        inputMode="decimal"
                        value={editorValues.assessmentBasis[selectedBusinessBasisField]}
                        onChange={(event) =>
                          handleAssessmentBasisValueChange(selectedBusinessBasisField, event.target.value)
                        }
                        onKeyDown={handleAssessmentInputArrowNavigation}
                        data-nav-row={assessmentBasisBaseNavRow}
                        data-nav-col={0}
                        className="h-9 w-full rounded-md border border-slate-400 px-2 text-right text-sm outline-none ring-emerald-300 focus:ring"
                      />
                    ) : (
                      <p className="pt-2 text-right text-sm text-slate-800">
                        {formatBasisCell(editorValues.assessmentBasis[selectedBusinessBasisField])}
                      </p>
                    )}
                  </div>
                  <div className="col-span-4 px-3 py-3 text-xs text-slate-600">{selectedBusinessBasisNote}</div>
                </div>

              </div>

              <div className="overflow-x-auto rounded-lg border-2 border-slate-500 bg-white">
                <div className="border-b border-slate-500 bg-slate-300 px-4 py-3"><p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-800">Assessment of Applicable Fees</p></div>

                <table className="w-full min-w-[1200px] border-collapse text-sm">
                  <colgroup>
                    <col className="w-[52%]" />
                    <col className="w-[16%]" />
                    <col className="w-[16%]" />
                    <col className="w-[16%]" />
                  </colgroup>
                  <thead>
                    <tr className="bg-slate-300 text-slate-900">
                      <th className="border-b border-r border-slate-500 px-3 py-2 text-left font-semibold">Particulars</th>
                      <th className="border-b border-r border-slate-500 px-3 py-2 text-right font-semibold whitespace-nowrap">Amount</th>
                      <th className="border-b border-r border-slate-500 px-3 py-2 text-right font-semibold whitespace-nowrap">Penalty/Surcharge</th>
                      <th className="border-b border-slate-500 px-3 py-2 text-right font-semibold whitespace-nowrap">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="bg-slate-200"><td colSpan={4} className="border-b border-slate-500 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-800">1. Local Taxes</td></tr>
                    {renderFeeSectionRows(
                      LOCAL_TAX_ITEMS,
                      editorValues,
                      isDialogEditing,
                      dialogTotals.lineTotals,
                      handleFeeValueChange,
                      handleAssessmentInputArrowNavigation
                    )}
                    <tr className="bg-slate-200"><td colSpan={4} className="border-b border-slate-500 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-800">2. Regulatory Fees and Charges</td></tr>
                    {renderFeeSectionRows(
                      REGULATORY_FEE_ITEMS,
                      editorValues,
                      isDialogEditing,
                      dialogTotals.lineTotals,
                      handleFeeValueChange,
                      handleAssessmentInputArrowNavigation
                    )}
                    <tr className="bg-slate-200"><td colSpan={4} className="border-b border-slate-500 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-800">3. Additional Fees (Optional)</td></tr>
                    {renderAdditionalFeeRows(
                      editorValues,
                      isDialogEditing,
                      dialogTotals.additionalLineTotals,
                      handleAdditionalFeeValueChange,
                      handleRemoveAdditionalFee,
                      FEE_DEFINITIONS.length,
                      handleAssessmentInputArrowNavigation
                    )}
                    {isDialogEditing ? (
                      <tr>
                        <td colSpan={4} className="border-b border-slate-500 px-3 py-3">
                          <button
                            type="button"
                            onClick={handleAddAdditionalFee}
                            className="inline-flex h-9 items-center justify-center rounded-md border border-slate-400 px-3 text-xs font-medium text-slate-700 hover:bg-slate-200"
                          >
                            + Add Fee
                          </button>
                        </td>
                      </tr>
                    ) : null}
                    <tr className="bg-slate-200"><td colSpan={4} className="border-b border-slate-500 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-800">4. Fire Safety Fees</td></tr>
                    {renderFeeSectionRows(
                      FIRE_FEE_ITEMS,
                      editorValues,
                      isDialogEditing,
                      dialogTotals.lineTotals,
                      handleFeeValueChange,
                      handleAssessmentInputArrowNavigation
                    )}
                    <tr className="bg-slate-200">
                      <td className="border-b border-r border-slate-500 px-3 py-2 font-semibold text-slate-900">TOTAL FEES for LGU</td>
                      <td className="border-b border-r border-slate-500 px-3 py-2 text-right text-slate-700">-</td>
                      <td className="border-b border-r border-slate-500 px-3 py-2 text-right text-slate-700">-</td>
                      <td className="border-b border-slate-500 px-3 py-2 text-right font-semibold tabular-nums text-slate-900 whitespace-nowrap">{dialogHasFeeValues ? formatCurrency(dialogTotals.lguTotal) : "-"}</td>
                    </tr>
                    <tr className="bg-slate-300">
                      <td className="border-r border-slate-500 px-3 py-2 font-semibold text-slate-900">GRAND TOTAL</td>
                      <td className="border-r border-slate-500 px-3 py-2 text-right text-slate-700">-</td>
                      <td className="border-r border-slate-500 px-3 py-2 text-right text-slate-700">-</td>
                      <td className="px-3 py-2 text-right font-semibold tabular-nums text-slate-900 whitespace-nowrap">{dialogHasFeeValues ? formatCurrency(dialogTotals.grandTotal) : "-"}</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <div className="overflow-hidden rounded-lg border-2 border-slate-500 bg-white">
                <div className="grid grid-cols-12 border-b border-slate-500 bg-slate-300 text-[11px] font-semibold uppercase tracking-wide text-slate-700">
                  <div className="col-span-6 border-r border-slate-500 px-3 py-2">Field</div>
                  <div className="col-span-3 border-r border-slate-500 px-3 py-2">Reference No.</div>
                  <div className="col-span-3 px-3 py-2">Notes</div>
                </div>

                <div className="grid grid-cols-12 border-b border-slate-500 bg-white">
                  <div className="col-span-6 border-r border-slate-500 px-3 py-3 text-sm font-medium text-slate-900">Cedula Number</div>
                  <div className="col-span-3 border-r border-slate-500 px-3 py-2">
                    {isDialogEditing ? <input type="text" value={editorValues.cedula} onChange={(event) => handleDocumentValueChange("cedula", event.target.value)} onKeyDown={handleAssessmentInputArrowNavigation} data-nav-row={cedulaNavRow} data-nav-col={0} className="h-9 w-full rounded-md border border-slate-400 px-2 text-sm outline-none ring-emerald-300 focus:ring" /> : <p className="pt-2 text-sm text-slate-800">{editorValues.cedula.trim() || "-"}</p>}
                  </div>
                  <div className="col-span-3 px-3 py-3 text-xs text-slate-600">Community Tax Certificate reference.</div>
                </div>

                <div className="grid grid-cols-12 bg-white">
                  <div className="col-span-6 border-r border-slate-500 px-3 py-3 text-sm font-medium text-slate-900">Official Receipt Number</div>
                  <div className="col-span-3 border-r border-slate-500 px-3 py-2">
                    {isDialogEditing ? <input type="text" value={editorValues.officialReceipt} onChange={(event) => handleDocumentValueChange("officialReceipt", event.target.value)} onKeyDown={handleAssessmentInputArrowNavigation} data-nav-row={officialReceiptNavRow} data-nav-col={0} className="h-9 w-full rounded-md border border-slate-400 px-2 text-sm outline-none ring-emerald-300 focus:ring" /> : <p className="pt-2 text-sm text-slate-800">{editorValues.officialReceipt.trim() || "-"}</p>}
                  </div>
                  <div className="col-span-3 px-3 py-3 text-xs text-slate-600">Official receipt reference for payment.</div>
                </div>

                <div className="grid grid-cols-12 border-t border-slate-500 bg-slate-200">
                  <div className="col-span-6 border-r border-slate-500 px-3 py-3 text-sm font-medium text-slate-900">Assessment Status</div>
                  <div className="col-span-3 border-r border-slate-500 px-3 py-2">
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => handleAssessmentStatusChange("paid")}
                        className={`inline-flex h-8 items-center justify-center rounded-md border px-3 text-xs font-medium ${editorValues.assessmentStatus === "paid" ? "border-emerald-700 bg-emerald-700 text-white" : "border-slate-400 bg-white text-slate-800 hover:bg-slate-200"}`}
                      >
                        Paid
                      </button>
                      <button
                        type="button"
                        onClick={() => handleAssessmentStatusChange("unpaid")}
                        className={`inline-flex h-8 items-center justify-center rounded-md border px-3 text-xs font-medium ${editorValues.assessmentStatus === "unpaid" ? "border-rose-700 bg-rose-700 text-white" : "border-slate-400 bg-white text-slate-800 hover:bg-slate-200"}`}
                      >
                        Unpaid
                      </button>
                    </div>
                  </div>
                  <div className="col-span-3 px-3 py-3 text-xs text-slate-600">
                    Current:{" "}
                    <span className="font-semibold text-slate-800">
                      {getTreasuryAssessmentStatusLabel(editorValues.assessmentStatus)}
                    </span>
                    . Status is kept unless you change it.
                  </div>
                </div>
              </div>

              {isDialogEditing && !hasRequiredDocumentReferences(editorValues) ? (
                <p className="text-xs font-medium text-red-600">Cedula Number and Official Receipt Number are required to save.</p>
              ) : null}
            </div>

            {dialogFeedback ? <p className={`mt-4 text-sm ${dialogFeedback.type === "success" ? "text-emerald-700" : "text-red-600"}`}>{dialogFeedback.message}</p> : null}
          </div>

          <DialogFooter className="border-t border-slate-400 bg-slate-100 px-6 py-4">
            {!isDialogEditing ? (
              <button type="button" onClick={() => { setDialogFeedback(null); setIsDialogEditing(true) }} className="inline-flex h-10 items-center justify-center rounded-md border border-slate-300 px-4 text-sm font-medium text-slate-700 hover:bg-slate-100">Edit</button>
            ) : null}

            {isDialogEditing ? (
              <button type="button" onClick={() => handleDialogOpenChange(false)} disabled={dialogIsSaving} className="inline-flex h-10 items-center justify-center rounded-md border border-slate-300 px-4 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60">Close</button>
            ) : null}

            {dialogHasUnsavedChanges ? (
              <button type="button" onClick={handleSaveFromDialog} disabled={dialogIsSaving || !hasRequiredDocumentReferences(editorValues)} className="inline-flex h-10 items-center justify-center rounded-md bg-emerald-700 px-4 text-sm font-medium text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-60">{dialogIsSaving ? "Saving..." : "Save"}</button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TreasuryShell>
  )
}
