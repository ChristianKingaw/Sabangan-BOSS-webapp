"use client"

import React, { useMemo, useState, useEffect } from "react"
import { getAuth, onAuthStateChanged, type User } from "firebase/auth"
import { onValue, ref } from "firebase/database"
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
  saveTreasuryReassessment,
  watchTreasuryFeesByClient,
  watchTreasuryReassessmentsByApplication,
  type TreasuryAdditionalFeeLine,
  type TreasuryFeeAssessmentRecord,
  type TreasuryFeeLine,
  type TreasuryReassessmentRecord,
} from "@/database/treasury"
import {
  BUSINESS_APPLICATION_PATH,
  normalizeBusinessApplication,
  type BusinessApplicationRecord,
} from "@/lib/business-applications"
import { toast } from "sonner"

type ReassessmentStatus = "re_assessed" | "not_yet_re_assessed"
type DifferenceType = "balanced" | "excess" | "insufficient"
type FeeSection = "local" | "regulatory" | "fire"
type FeeLineInput = { amount: string; penalty: string }
type AdditionalFeeInput = { id: string; name: string; amount: string; penalty: string }
type ReassessmentAssessmentStatus = "paid" | "unpaid"
type ReassessmentEditorState = {
  assessmentStatus: ReassessmentAssessmentStatus
  fees: Record<string, FeeLineInput>
  additionalFees: AdditionalFeeInput[]
}

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
  { key: "signboard_billboard_tax", label: "Tax on Signboard / Billboards", section: "local", includeInLgu: true },
  { key: "mayors_permit_fee", label: "Mayor's Permit Fee", section: "regulatory", includeInLgu: true },
  { key: "mayors_clearance_fee", label: "Mayor's Clearance Fee", section: "regulatory", includeInLgu: true },
  { key: "sanitary_inspection_fee", label: "Sanitary Inspection Fee", section: "regulatory", includeInLgu: true },
  { key: "delivery_permit_fee", label: "Delivery Trucks/Vans Permit Fee", section: "regulatory", includeInLgu: true },
  { key: "garbage_charges", label: "Garbage Charges", section: "regulatory", includeInLgu: true },
  { key: "building_inspection_fee", label: "Building Inspection Fee", section: "regulatory", includeInLgu: true },
  { key: "electrical_inspection_fee", label: "Electrical Inspection Fee", section: "regulatory", includeInLgu: true },
  { key: "mechanical_inspection_fee", label: "Mechanical Inspection Fee", section: "regulatory", includeInLgu: true },
  { key: "dst_fee", label: "D.S.T. (Documentary Stamp Tax)", section: "regulatory", includeInLgu: true },
  { key: "signboard_business_plate_fee", label: "Signboard/Business Plate", section: "regulatory", includeInLgu: true },
  {
    key: "combustible_storage_sale_fee",
    label: "Storage and Sale of Combustible",
    section: "regulatory",
    includeInLgu: true,
  },
  { key: "fire_safety_inspection_fee", label: "Fire Safety Inspection Fee", section: "fire", includeInLgu: false },
] as const

const FEE_ORDER = FEE_DEFINITIONS.map((item) => item.key)
const LOCAL_TAX_ITEMS = FEE_DEFINITIONS.filter((item) => item.section === "local")
const REGULATORY_FEE_ITEMS = FEE_DEFINITIONS.filter((item) => item.section === "regulatory")
const FIRE_FEE_ITEMS = FEE_DEFINITIONS.filter((item) => item.section === "fire")
const FEE_ROW_INDEX_BY_KEY = FEE_DEFINITIONS.reduce<Record<string, number>>((map, item, index) => {
  map[item.key] = index
  return map
}, {})
const FEE_INCLUDE_IN_LGU = FEE_DEFINITIONS.reduce<Record<string, boolean>>((map, item) => {
  map[item.key] = item.includeInLgu
  return map
}, {})

const normalizeAssessmentStatus = (value: unknown) => {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : ""
  if (normalized === "paid" || normalized === "unpaid" || normalized === "ongoing") {
    return normalized
  }
  return "ongoing"
}

const getTreasuryAssessmentStatusLabel = (value: string) => {
  if (value === "paid") return "Paid"
  if (value === "unpaid") return "Unpaid"
  return "Ongoing"
}

const toReassessmentAssessmentStatus = (value: unknown): ReassessmentAssessmentStatus =>
  normalizeAssessmentStatus(value) === "unpaid" ? "unpaid" : "paid"

const getApplicationTypeBadgeClassName = (value: string) =>
  value === "Renewal"
    ? "border-indigo-400 bg-indigo-100 text-indigo-900"
    : "border-emerald-400 bg-emerald-100 text-emerald-900"

const parseNumberInput = (value: string): number | null => {
  const trimmed = value.trim()
  if (!trimmed) return null
  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed)) return null
  return parsed
}

const toInputAmount = (value: number | null | undefined) => {
  if (typeof value !== "number" || !Number.isFinite(value)) return ""
  return value === 0 ? "" : String(value)
}

const toFeeInputLine = (line: TreasuryFeeLine | undefined): FeeLineInput => ({
  amount: toInputAmount(line?.amount),
  penalty: toInputAmount(line?.penalty),
})

const toAdditionalInputLine = (line: TreasuryAdditionalFeeLine, index: number): AdditionalFeeInput => ({
  id: `additional-${index}-${line.name || "fee"}`,
  name: line.name,
  amount: toInputAmount(line.amount),
  penalty: toInputAmount(line.penalty),
})

const createEmptyAdditionalFee = (): AdditionalFeeInput => ({
  id: `additional-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  name: "",
  amount: "",
  penalty: "",
})

const toFeeLine = (value: FeeLineInput): TreasuryFeeLine => {
  const amount = parseNumberInput(value.amount)
  const penalty = parseNumberInput(value.penalty)
  return {
    amount,
    penalty,
    total: (amount ?? 0) + (penalty ?? 0),
  }
}

const toAdditionalFeeLine = (value: AdditionalFeeInput): TreasuryAdditionalFeeLine | null => {
  const amount = parseNumberInput(value.amount)
  const penalty = parseNumberInput(value.penalty)
  const name = value.name.trim()
  if (!name && amount === null && penalty === null) {
    return null
  }
  return {
    name,
    amount,
    penalty,
    total: (amount ?? 0) + (penalty ?? 0),
  }
}

const formatCurrency = (value: number) =>
  value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const formatSignedCurrency = (value: number) => {
  if (!Number.isFinite(value) || value === 0) return "0.00"
  const amount = formatCurrency(Math.abs(value))
  return value > 0 ? `+${amount}` : `-${amount}`
}

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

const getAssessmentForClient = (
  record: BusinessApplicationRecord,
  byClientUid: Record<string, TreasuryFeeAssessmentRecord>
) => {
  const applicationUid = record.id
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

const buildFeeKeyOrder = (
  previousFees: Record<string, TreasuryFeeLine>,
  updatedFees: Record<string, TreasuryFeeLine>
) => {
  const union = new Set<string>([...FEE_ORDER, ...Object.keys(previousFees), ...Object.keys(updatedFees)])
  const known = FEE_ORDER.filter((key) => union.has(key))
  const unknown = [...union].filter((key) => !FEE_ORDER.includes(key as (typeof FEE_ORDER)[number])).sort()
  return [...known, ...unknown]
}

const computeTotals = (
  fees: Record<string, TreasuryFeeLine>,
  additionalFees: TreasuryAdditionalFeeLine[]
) => {
  let lguTotal = 0
  let grandTotal = 0

  Object.entries(fees).forEach(([key, line]) => {
    const lineTotal = Number.isFinite(line.total) ? line.total : (line.amount ?? 0) + (line.penalty ?? 0)
    if (FEE_INCLUDE_IN_LGU[key] !== false) {
      lguTotal += lineTotal
    }
    grandTotal += lineTotal
  })

  additionalFees.forEach((line) => {
    const lineTotal = Number.isFinite(line.total) ? line.total : (line.amount ?? 0) + (line.penalty ?? 0)
    lguTotal += lineTotal
    grandTotal += lineTotal
  })

  return { lguTotal, grandTotal }
}

const getLineTotalValue = (line: TreasuryFeeLine | TreasuryAdditionalFeeLine) =>
  Number.isFinite(line.total) ? line.total : (line.amount ?? 0) + (line.penalty ?? 0)

const hasAnyNonZeroFeeValues = (
  fees: Record<string, TreasuryFeeLine>,
  additionalFees: TreasuryAdditionalFeeLine[]
) =>
  Object.values(fees).some((line) => getLineTotalValue(line) !== 0) ||
  additionalFees.some((line) => getLineTotalValue(line) !== 0)

const computeEditorTotals = (
  fees: Record<string, FeeLineInput>,
  additionalFees: AdditionalFeeInput[]
) => {
  const lineTotals: Record<string, number> = {}
  const additionalLineTotals: Record<string, number> = {}
  let lguTotal = 0
  let grandTotal = 0

  FEE_DEFINITIONS.forEach((item) => {
    const row = fees[item.key] ?? { amount: "", penalty: "" }
    const amount = parseNumberInput(row.amount) ?? 0
    const penalty = parseNumberInput(row.penalty) ?? 0
    const lineTotal = amount + penalty

    lineTotals[item.key] = lineTotal
    if (item.includeInLgu) {
      lguTotal += lineTotal
    }
    grandTotal += lineTotal
  })

  additionalFees.forEach((row) => {
    const amount = parseNumberInput(row.amount) ?? 0
    const penalty = parseNumberInput(row.penalty) ?? 0
    const lineTotal = amount + penalty

    additionalLineTotals[row.id] = lineTotal
    lguTotal += lineTotal
    grandTotal += lineTotal
  })

  return { lineTotals, additionalLineTotals, lguTotal, grandTotal }
}

const resolveAssessmentGrandTotal = (assessment: TreasuryFeeAssessmentRecord) => {
  if (typeof assessment.grand_total === "number" && Number.isFinite(assessment.grand_total)) {
    return assessment.grand_total
  }
  return computeTotals(assessment.fees, assessment.additional_fees).grandTotal
}

const resolveAssessmentLguTotal = (assessment: TreasuryFeeAssessmentRecord) => {
  if (typeof assessment.lgu_total === "number" && Number.isFinite(assessment.lgu_total)) {
    return assessment.lgu_total
  }
  return computeTotals(assessment.fees, assessment.additional_fees).lguTotal
}

const getDifferenceType = (previousTotal: number, updatedTotal: number): DifferenceType => {
  if (previousTotal > updatedTotal) return "excess"
  if (previousTotal < updatedTotal) return "insufficient"
  return "balanced"
}

const initializeEditorValues = (
  assessment: TreasuryFeeAssessmentRecord,
  reassessment?: TreasuryReassessmentRecord
): ReassessmentEditorState => {
  const baselineFees =
    reassessment && Object.keys(reassessment.updated_fees ?? {}).length > 0
      ? reassessment.updated_fees
      : assessment.fees
  const baselineAdditionalFees = reassessment
    ? (reassessment.updated_additional_fees ?? [])
    : (assessment.additional_fees ?? [])
  const feeKeys = buildFeeKeyOrder(assessment.fees, baselineFees)
  const feeInputs = feeKeys.reduce<Record<string, FeeLineInput>>((map, key) => {
    map[key] = toFeeInputLine(baselineFees[key] ?? assessment.fees[key])
    return map
  }, {})

  return {
    assessmentStatus: toReassessmentAssessmentStatus(
      reassessment?.assessment_status ?? assessment.assessment_status
    ),
    fees: feeInputs,
    additionalFees: baselineAdditionalFees.map((line, index) => toAdditionalInputLine(line, index)),
  }
}

const renderFeeSectionRows = (
  definitions: ReadonlyArray<{ key: string; label: string; section: FeeSection; includeInLgu: boolean }>,
  values: ReassessmentEditorState,
  lineTotals: Record<string, number>,
  onFeeValueChange: (feeKey: string, field: keyof FeeLineInput, value: string) => void,
  onInputKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void
) =>
  definitions.map((item) => {
    const row = values.fees[item.key] ?? { amount: "", penalty: "" }
    const hasValue = Boolean(row.amount.trim() || row.penalty.trim())
    const rowIndex = FEE_ROW_INDEX_BY_KEY[item.key] ?? 0

    return (
      <tr key={item.key}>
        <td className="border-b border-r border-slate-500 px-3 py-2 text-slate-900">{item.label}</td>
        <td className="border-b border-r border-slate-500 px-3 py-2 text-right tabular-nums text-slate-800 whitespace-nowrap">
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
        </td>
        <td className="border-b border-r border-slate-500 px-3 py-2 text-right tabular-nums text-slate-800 whitespace-nowrap">
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
        </td>
        <td className="border-b border-slate-500 px-3 py-2 text-right tabular-nums text-slate-800 whitespace-nowrap">
          {hasValue ? formatCurrency(lineTotals[item.key] ?? 0) : "-"}
        </td>
      </tr>
    )
  })

const renderAdditionalFeeRows = (
  values: ReassessmentEditorState,
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
        </td>
        <td className="border-b border-r border-slate-500 px-3 py-2 text-right tabular-nums text-slate-800 whitespace-nowrap">
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
        </td>
        <td className="border-b border-r border-slate-500 px-3 py-2 text-right tabular-nums text-slate-800 whitespace-nowrap">
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
        </td>
        <td className="border-b border-slate-500 px-3 py-2 text-right tabular-nums text-slate-800 whitespace-nowrap">
          {hasValue ? formatCurrency(additionalLineTotals[fee.id] ?? 0) : "-"}
        </td>
      </tr>
    )
  })

type PaidClientEntry = {
  client: BusinessApplicationRecord
  assessment: TreasuryFeeAssessmentRecord
  reassessment: TreasuryReassessmentRecord | undefined
  totalPaid: number
  reassessmentStatus: ReassessmentStatus
}

export default function TreasuryReassessmentPage() {
  const auth = useMemo(() => getAuth(firebaseApp), [])
  const [authReady, setAuthReady] = useState(false)
  const [authUser, setAuthUser] = useState<User | null>(null)
  const [clients, setClients] = useState<BusinessApplicationRecord[]>([])
  const [feesByClient, setFeesByClient] = useState<Record<string, TreasuryFeeAssessmentRecord>>({})
  const [reassessmentsByApplication, setReassessmentsByApplication] = useState<
    Partial<Record<string, TreasuryReassessmentRecord>>
  >({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedApplicationUid, setSelectedApplicationUid] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [editorValues, setEditorValues] = useState<ReassessmentEditorState>({
    assessmentStatus: "paid",
    fees: {},
    additionalFees: [],
  })
  const dialogTotals = useMemo(
    () => computeEditorTotals(editorValues.fees, editorValues.additionalFees),
    [editorValues.fees, editorValues.additionalFees]
  )
  const dialogHasFeeValues = useMemo(
    () =>
      FEE_DEFINITIONS.some((item) => {
        const row = editorValues.fees[item.key]
        return Boolean(row?.amount.trim() || row?.penalty.trim())
      }) || editorValues.additionalFees.some((fee) => Boolean(fee.amount.trim() || fee.penalty.trim())),
    [editorValues.fees, editorValues.additionalFees]
  )

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setAuthUser(user)
      setAuthReady(true)
    })
    return unsubscribe
  }, [auth])

  useEffect(() => {
    if (!authReady) return
    if (!authUser) {
      setClients([])
      setLoading(false)
      setError("Treasury session expired. Please sign in again.")
      return
    }

    setLoading(true)
    setError(null)
    const businessRef = ref(realtimeDb, BUSINESS_APPLICATION_PATH)
    const unsubscribe = onValue(
      businessRef,
      (snapshot) => {
        if (!snapshot.exists()) {
          setClients([])
          setLoading(false)
          return
        }

        const node = snapshot.val() as Record<string, Record<string, unknown>>
        const parsed = Object.entries(node).map(([id, payload]) => normalizeBusinessApplication(id, payload))
        const submitted = parsed.filter((record) => Boolean(record.form) && Object.keys(record.form ?? {}).length > 0)
        setClients(submitted)
        setLoading(false)
      },
      (loadError) => {
        console.error("Failed to load clients for reassessment", loadError)
        setClients([])
        setLoading(false)
        setError("Unable to load client records right now.")
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
      (watchError) => console.error("Failed to load treasury fee assessments for reassessment", watchError)
    )

    return () => stop()
  }, [authReady, authUser])

  useEffect(() => {
    if (!authReady || !authUser) {
      setReassessmentsByApplication({})
      return
    }

    const stop = watchTreasuryReassessmentsByApplication(
      (records) => setReassessmentsByApplication(records),
      (watchError) => console.error("Failed to load reassessment records", watchError)
    )

    return () => stop()
  }, [authReady, authUser])

  const paidClients = useMemo(() => {
    return clients
      .map((client) => {
        const assessment = getAssessmentForClient(client, feesByClient)
        if (!assessment) return null
        if (normalizeAssessmentStatus(assessment.assessment_status) !== "paid") return null

        const reassessment = reassessmentsByApplication[client.id]
        const reassessmentStatus: ReassessmentStatus = reassessment ? "re_assessed" : "not_yet_re_assessed"

        return {
          client,
          assessment,
          reassessment,
          totalPaid: resolveAssessmentGrandTotal(assessment),
          reassessmentStatus,
        } satisfies PaidClientEntry
      })
      .filter((entry): entry is PaidClientEntry => entry !== null)
      .sort((left, right) => {
        const rightTs =
          getApplicationDateTimestamp(right.client) ??
          right.assessment.updatedAt ??
          right.assessment.createdAt ??
          0
        const leftTs =
          getApplicationDateTimestamp(left.client) ??
          left.assessment.updatedAt ??
          left.assessment.createdAt ??
          0
        return rightTs - leftTs
      })
  }, [clients, feesByClient, reassessmentsByApplication])

  const selectedEntry = useMemo(
    () => paidClients.find((entry) => entry.client.id === selectedApplicationUid) ?? null,
    [paidClients, selectedApplicationUid]
  )

  const comparison = useMemo(() => {
    if (!selectedEntry) return null

    const previousFees = selectedEntry.assessment.fees
    const previousAdditionalFees = selectedEntry.assessment.additional_fees ?? []
    const editorFeeKeys = Object.keys(editorValues.fees).reduce<Record<string, TreasuryFeeLine>>((map, key) => {
      map[key] = { amount: null, penalty: null, total: 0 }
      return map
    }, {})
    const feeKeys = buildFeeKeyOrder(previousFees, editorFeeKeys)

    const updatedFees = feeKeys.reduce<Record<string, TreasuryFeeLine>>((map, key) => {
      map[key] = toFeeLine(editorValues.fees[key] ?? { amount: "", penalty: "" })
      return map
    }, {})

    const updatedAdditionalFees = editorValues.additionalFees
      .map((line) => toAdditionalFeeLine(line))
      .filter((line): line is TreasuryAdditionalFeeLine => line !== null)

    const updatedTotals = computeTotals(updatedFees, updatedAdditionalFees)
    const previousGrandTotal = resolveAssessmentGrandTotal(selectedEntry.assessment)
    const previousLguTotal = resolveAssessmentLguTotal(selectedEntry.assessment)
    const hasUpdatedFeeValues = hasAnyNonZeroFeeValues(updatedFees, updatedAdditionalFees)
    const differenceAmount = hasUpdatedFeeValues
      ? previousGrandTotal - updatedTotals.grandTotal
      : 0
    const differenceType = hasUpdatedFeeValues
      ? getDifferenceType(previousGrandTotal, updatedTotals.grandTotal)
      : "balanced"

    return {
      updatedFees,
      updatedAdditionalFees,
      updatedTotals,
      previousGrandTotal,
      previousLguTotal,
      differenceAmount,
      differenceType,
    }
  }, [selectedEntry, editorValues])

  const openReassessmentPreview = (entry: PaidClientEntry) => {
    setSelectedApplicationUid(entry.client.id)
    setEditorValues(initializeEditorValues(entry.assessment, entry.reassessment))
    setDialogOpen(true)
  }

  const handleFeeChange = (key: string, field: "amount" | "penalty", value: string) => {
    setEditorValues((previous) => ({
      ...previous,
      fees: {
        ...previous.fees,
        [key]: {
          ...(previous.fees[key] ?? { amount: "", penalty: "" }),
          [field]: value,
        },
      },
    }))
  }

  const handleAdditionalFeeChange = (
    id: string,
    field: "name" | "amount" | "penalty",
    value: string
  ) => {
    setEditorValues((previous) => ({
      ...previous,
      additionalFees: previous.additionalFees.map((line) =>
        line.id === id
          ? {
              ...line,
              [field]: value,
            }
          : line
      ),
    }))
  }

  const addAdditionalFee = () => {
    setEditorValues((previous) => ({
      ...previous,
      additionalFees: [...previous.additionalFees, createEmptyAdditionalFee()],
    }))
  }

  const handleAssessmentStatusChange = (status: ReassessmentAssessmentStatus) => {
    setEditorValues((previous) => ({
      ...previous,
      assessmentStatus: status,
    }))
  }

  const removeAdditionalFee = (id: string) => {
    setEditorValues((previous) => ({
      ...previous,
      additionalFees: previous.additionalFees.filter((line) => line.id !== id),
    }))
  }

  const handleAssessmentInputArrowNavigation = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const key = event.key
    if (key !== "ArrowUp" && key !== "ArrowDown" && key !== "ArrowLeft" && key !== "ArrowRight") return

    const current = event.currentTarget
    const currentRow = Number(current.dataset.navRow)
    const currentCol = Number(current.dataset.navCol)
    if (!Number.isFinite(currentRow) || !Number.isFinite(currentCol)) return

    const scope = current.closest("[data-nav-scope='treasury-reassessment']")
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

    rows.forEach((cells) => cells.sort((left, right) => left.col - right.col))

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
      const sortedRows = Array.from(rows.keys()).sort((left, right) => left - right)
      const currentRowIndex = sortedRows.indexOf(currentRow)
      if (currentRowIndex >= 0) {
        const step = key === "ArrowUp" ? -1 : 1
        for (
          let index = currentRowIndex + step;
          index >= 0 && index < sortedRows.length;
          index += step
        ) {
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

  const saveReassessment = async () => {
    if (!selectedEntry || !comparison) return
    if (!authUser) {
      toast.error("Treasury session expired. Please sign in again.")
      return
    }

    setSaving(true)
    try {
      await saveTreasuryReassessment({
        applicationUid: selectedEntry.client.id,
        sourceAssessmentUid: selectedEntry.assessment.uid,
        assessmentStatus: editorValues.assessmentStatus,
        previousFees: selectedEntry.assessment.fees,
        updatedFees: comparison.updatedFees,
        previousAdditionalFees: selectedEntry.assessment.additional_fees ?? [],
        updatedAdditionalFees: comparison.updatedAdditionalFees,
        previousLguTotal: comparison.previousLguTotal,
        updatedLguTotal: comparison.updatedTotals.lguTotal,
        previousGrandTotal: comparison.previousGrandTotal,
        updatedGrandTotal: comparison.updatedTotals.grandTotal,
        staffUid: authUser.uid,
        staffEmail: authUser.email ?? null,
      })

      const message =
        comparison.differenceType === "excess"
          ? `Re-assessment saved. Barya (excess): ${formatCurrency(Math.abs(comparison.differenceAmount))}`
          : comparison.differenceType === "insufficient"
            ? `Re-assessment saved. Utang/Kulang (insufficient): ${formatCurrency(Math.abs(comparison.differenceAmount))}`
            : "Re-assessment saved. No payment difference detected."
      toast.success(message)
    } catch (saveError) {
      console.error("Failed to save reassessment", saveError)
      toast.error("Unable to save re-assessment right now.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <TreasuryShell
      activeNav="reassessment"
      title="Re-Assessment"
      description="Standalone reassessment workflow for paid clients, with previous vs updated fee comparison."
    >
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm md:p-5">
        {error ? (
          <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        ) : null}

        <div className="overflow-x-hidden">
          <table className="w-full table-fixed border-collapse">
            <thead>
              <tr className="bg-emerald-700 text-left text-sm text-white">
                <th className="px-3 py-3 font-medium">No.</th>
                <th className="px-3 py-3 font-medium">Client</th>
                <th className="px-3 py-3 font-medium">Business</th>
                <th className="px-3 py-3 font-medium">Type</th>
                <th className="px-3 py-3 font-medium">Re-Assessment Status</th>
                <th className="px-3 py-3 font-medium">Latest Result</th>
                <th className="px-3 py-3 font-medium text-right">Total Paid</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={7} className="border-b border-slate-200 px-3 py-6 text-center text-sm text-slate-500">
                    Loading paid clients...
                  </td>
                </tr>
              ) : paidClients.length === 0 ? (
                <tr>
                  <td colSpan={7} className="border-b border-slate-200 px-3 py-6 text-center text-sm text-slate-500">
                    No paid clients found.
                  </td>
                </tr>
              ) : (
                paidClients.map((entry, index) => {
                  const { client, reassessment, reassessmentStatus, totalPaid } = entry
                  const resultLabel =
                    reassessment?.difference_type === "excess"
                      ? `Barya ${formatCurrency(reassessment.difference_amount)}`
                      : reassessment?.difference_type === "insufficient"
                        ? `Utang/Kulang ${formatCurrency(reassessment.difference_amount)}`
                        : reassessment
                          ? "Balanced"
                          : "-"

                  return (
                    <tr
                      key={client.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => openReassessmentPreview(entry)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault()
                          openReassessmentPreview(entry)
                        }
                      }}
                      className="cursor-pointer border-b border-slate-200 text-sm text-slate-700 transition-colors hover:bg-slate-50 focus-within:bg-slate-50"
                    >
                      <td className="px-3 py-3">{index + 1}</td>
                      <td className="px-3 py-3 font-medium text-slate-900 break-words">{client.applicantName || "-"}</td>
                      <td className="px-3 py-3 break-words">{client.businessName || "-"}</td>
                      <td className="px-3 py-3">{client.applicationType}</td>
                      <td className="px-3 py-3">
                        <span
                          className={
                            reassessmentStatus === "re_assessed"
                              ? "font-medium text-emerald-700"
                              : "font-medium text-amber-700"
                          }
                        >
                          {reassessmentStatus === "re_assessed" ? "Re-Assessed" : "Not Yet Re-Assessed"}
                        </span>
                      </td>
                      <td className="px-3 py-3 font-medium text-slate-800">{resultLabel}</td>
                      <td className="px-3 py-3 text-right tabular-nums font-medium text-slate-900">
                        {formatCurrency(totalPaid)}
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open)
          if (!open) {
            setSelectedApplicationUid(null)
            setEditorValues({ assessmentStatus: "paid", fees: {}, additionalFees: [] })
          }
        }}
      >
        <DialogContent className="h-[calc(100vh-0.75rem)] w-[90vw] max-w-[86rem] sm:max-w-[86rem] gap-0 overflow-hidden p-0">
          <DialogHeader className="border-b border-slate-400 bg-slate-100 px-6 py-4">
            <DialogTitle className="flex flex-wrap items-center gap-2 text-xl text-slate-950">
              <span>Re-Assessment Preview</span>
              {selectedEntry ? (
                <span
                  className={`inline-flex rounded-full border px-2 py-1 text-xs font-semibold ${getApplicationTypeBadgeClassName(
                    selectedEntry.client.applicationType
                  )}`}
                >
                  {selectedEntry.client.applicationType}
                </span>
              ) : null}
            </DialogTitle>
            <DialogDescription className="text-slate-700">
              {selectedEntry
                ? `${selectedEntry.client.applicantName || "Client"}${selectedEntry.client.businessName ? ` • ${selectedEntry.client.businessName}` : ""}`
                : "Review and update fee assessment details for re-assessment."}
            </DialogDescription>
          </DialogHeader>

          {selectedEntry && comparison ? (
            <div className="max-h-[70vh] overflow-y-auto bg-slate-200 p-6" data-nav-scope="treasury-reassessment">
              <div className="space-y-5">
                <div className="rounded-lg border border-slate-400 bg-slate-50 p-4">
                  <p className="text-sm font-semibold text-slate-900">What This Form Is For</p>
                  <p className="mt-2 text-sm text-slate-600">
                    This form is used to revise assessed taxes and fees, then compare the updated total against the
                    previous paid total.
                  </p>
                  <p className="mt-2 text-xs text-slate-500">
                    Only re-assessment adds the payment difference result: Barya (excess) or Utang/Kulang
                    (insufficient).
                  </p>
                </div>

                <div className="grid gap-3 md:grid-cols-3">
                  <div className="rounded-md border border-slate-400 bg-white p-3">
                    <p className="text-xs uppercase tracking-wide text-slate-500">Previous Total Paid</p>
                    <p className="mt-1 text-xl font-semibold tabular-nums text-slate-900">
                      {formatCurrency(comparison.previousGrandTotal)}
                    </p>
                  </div>
                  <div className="rounded-md border border-slate-400 bg-white p-3">
                    <p className="text-xs uppercase tracking-wide text-slate-500">Updated Re-Assessment Total</p>
                    <p className="mt-1 text-xl font-semibold tabular-nums text-slate-900">
                      {formatCurrency(comparison.updatedTotals.grandTotal)}
                    </p>
                  </div>
                  <div
                    className={`rounded-md border p-3 ${
                      comparison.differenceType === "excess"
                        ? "border-emerald-500 bg-emerald-50"
                        : comparison.differenceType === "insufficient"
                          ? "border-amber-400 bg-amber-50"
                          : "border-slate-400 bg-white"
                    }`}
                  >
                    <p className="text-xs uppercase tracking-wide text-slate-500">Difference (Previous - Updated)</p>
                    <p className="mt-1 text-xl font-semibold tabular-nums text-slate-900">
                      {formatSignedCurrency(comparison.differenceAmount)}
                    </p>
                    <p className="mt-1 text-xs text-slate-700">
                      {comparison.differenceType === "excess"
                        ? "Barya detected (updated total is lower than previous total)."
                        : comparison.differenceType === "insufficient"
                          ? "Utang/Kulang detected (updated total is higher than previous total)."
                          : "No difference in fees."}
                    </p>
                  </div>
                </div>

                <div className="overflow-x-auto rounded-lg border-2 border-slate-500 bg-white">
                  <div className="border-b border-slate-500 bg-slate-300 px-4 py-3">
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-800">
                      Assessment of Applicable Fees
                    </p>
                  </div>

                  <table className="w-full min-w-[1200px] border-collapse text-sm">
                    <colgroup>
                      <col className="w-[52%]" />
                      <col className="w-[16%]" />
                      <col className="w-[16%]" />
                      <col className="w-[16%]" />
                    </colgroup>
                    <thead>
                      <tr className="bg-slate-300 text-slate-900">
                        <th className="border-b border-r border-slate-500 px-3 py-2 text-left font-semibold">
                          Particulars
                        </th>
                        <th className="border-b border-r border-slate-500 px-3 py-2 text-right font-semibold whitespace-nowrap">
                          Amount
                        </th>
                        <th className="border-b border-r border-slate-500 px-3 py-2 text-right font-semibold whitespace-nowrap">
                          Penalty/Surcharge
                        </th>
                        <th className="border-b border-slate-500 px-3 py-2 text-right font-semibold whitespace-nowrap">
                          Total
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="bg-slate-200">
                        <td
                          colSpan={4}
                          className="border-b border-slate-500 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-800"
                        >
                          1. Local Taxes
                        </td>
                      </tr>
                      {renderFeeSectionRows(
                        LOCAL_TAX_ITEMS,
                        editorValues,
                        dialogTotals.lineTotals,
                        handleFeeChange,
                        handleAssessmentInputArrowNavigation
                      )}
                      <tr className="bg-slate-200">
                        <td
                          colSpan={4}
                          className="border-b border-slate-500 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-800"
                        >
                          2. Regulatory Fees and Charges
                        </td>
                      </tr>
                      {renderFeeSectionRows(
                        REGULATORY_FEE_ITEMS,
                        editorValues,
                        dialogTotals.lineTotals,
                        handleFeeChange,
                        handleAssessmentInputArrowNavigation
                      )}
                      <tr className="bg-slate-200">
                        <td
                          colSpan={4}
                          className="border-b border-slate-500 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-800"
                        >
                          3. Additional Fees (Optional)
                        </td>
                      </tr>
                      {renderAdditionalFeeRows(
                        editorValues,
                        dialogTotals.additionalLineTotals,
                        handleAdditionalFeeChange,
                        removeAdditionalFee,
                        FEE_DEFINITIONS.length,
                        handleAssessmentInputArrowNavigation
                      )}
                      <tr>
                        <td colSpan={4} className="border-b border-slate-500 px-3 py-3">
                          <button
                            type="button"
                            onClick={addAdditionalFee}
                            className="inline-flex h-9 items-center justify-center rounded-md border border-slate-400 px-3 text-xs font-medium text-slate-700 hover:bg-slate-200"
                          >
                            + Add Fee
                          </button>
                        </td>
                      </tr>
                      <tr className="bg-slate-200">
                        <td
                          colSpan={4}
                          className="border-b border-slate-500 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-800"
                        >
                          4. Fire Safety Fees
                        </td>
                      </tr>
                      {renderFeeSectionRows(
                        FIRE_FEE_ITEMS,
                        editorValues,
                        dialogTotals.lineTotals,
                        handleFeeChange,
                        handleAssessmentInputArrowNavigation
                      )}
                      <tr className="bg-slate-200">
                        <td className="border-b border-r border-slate-500 px-3 py-2 font-semibold text-slate-900">
                          TOTAL FEES for LGU
                        </td>
                        <td className="border-b border-r border-slate-500 px-3 py-2 text-right text-slate-700">-</td>
                        <td className="border-b border-r border-slate-500 px-3 py-2 text-right text-slate-700">-</td>
                        <td className="border-b border-slate-500 px-3 py-2 text-right font-semibold tabular-nums text-slate-900 whitespace-nowrap">
                          {dialogHasFeeValues ? formatCurrency(dialogTotals.lguTotal) : "-"}
                        </td>
                      </tr>
                      <tr className="bg-slate-300">
                        <td className="border-r border-slate-500 px-3 py-2 font-semibold text-slate-900">
                          GRAND TOTAL
                        </td>
                        <td className="border-r border-slate-500 px-3 py-2 text-right text-slate-700">-</td>
                        <td className="border-r border-slate-500 px-3 py-2 text-right text-slate-700">-</td>
                        <td className="px-3 py-2 text-right font-semibold tabular-nums text-slate-900 whitespace-nowrap">
                          {dialogHasFeeValues ? formatCurrency(dialogTotals.grandTotal) : "-"}
                        </td>
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
                    <div className="col-span-6 border-r border-slate-500 px-3 py-3 text-sm font-medium text-slate-900">
                      Cedula Number
                    </div>
                    <div className="col-span-3 border-r border-slate-500 px-3 py-3 text-sm text-slate-800">
                      {selectedEntry.assessment.cedula_no?.trim() || "-"}
                    </div>
                    <div className="col-span-3 px-3 py-3 text-xs text-slate-600">
                      Community Tax Certificate reference from assessment.
                    </div>
                  </div>

                  <div className="grid grid-cols-12 border-b border-slate-500 bg-white">
                    <div className="col-span-6 border-r border-slate-500 px-3 py-3 text-sm font-medium text-slate-900">
                      Official Receipt Number
                    </div>
                    <div className="col-span-3 border-r border-slate-500 px-3 py-3 text-sm text-slate-800">
                      {selectedEntry.assessment.or_no?.trim() || "-"}
                    </div>
                    <div className="col-span-3 px-3 py-3 text-xs text-slate-600">
                      Official receipt reference from assessment.
                    </div>
                  </div>

                  <div className="grid grid-cols-12 bg-slate-200">
                    <div className="col-span-6 border-r border-slate-500 px-3 py-3 text-sm font-medium text-slate-900">
                      Assessment Status
                    </div>
                    <div className="col-span-3 border-r border-slate-500 px-3 py-2">
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => handleAssessmentStatusChange("paid")}
                          className={`inline-flex h-8 items-center justify-center rounded-md border px-3 text-xs font-medium ${
                            editorValues.assessmentStatus === "paid"
                              ? "border-emerald-700 bg-emerald-700 text-white"
                              : "border-slate-400 bg-white text-slate-800 hover:bg-slate-200"
                          }`}
                        >
                          Paid
                        </button>
                        <button
                          type="button"
                          onClick={() => handleAssessmentStatusChange("unpaid")}
                          className={`inline-flex h-8 items-center justify-center rounded-md border px-3 text-xs font-medium ${
                            editorValues.assessmentStatus === "unpaid"
                              ? "border-rose-700 bg-rose-700 text-white"
                              : "border-slate-400 bg-white text-slate-800 hover:bg-slate-200"
                          }`}
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
                      . Saved on re-assessment without changing the assessment preview record.
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="p-6 text-sm text-slate-600">Select a paid client to open reassessment preview.</div>
          )}

          <DialogFooter className="border-t border-slate-400 bg-slate-100 px-6 py-4">
            <button
              type="button"
              onClick={() => setDialogOpen(false)}
              className="inline-flex h-10 items-center justify-center rounded-md border border-slate-300 px-4 text-sm font-medium text-slate-700 hover:bg-slate-100"
            >
              Close
            </button>
            <button
              type="button"
              onClick={saveReassessment}
              disabled={!selectedEntry || !comparison || saving}
              className="inline-flex h-10 items-center justify-center rounded-md bg-emerald-700 px-4 text-sm font-medium text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {saving ? "Saving..." : "Save Re-Assessment"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TreasuryShell>
  )
}
