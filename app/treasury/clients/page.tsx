
"use client"

import React, { useEffect, useMemo, useState } from "react"
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

const createEmptyFeeInputs = (): Record<FeeKey, FeeLineInput> =>
  FEE_DEFINITIONS.reduce((accumulator, item) => {
    accumulator[item.key] = { amount: "", penalty: "" }
    return accumulator
  }, {} as Record<FeeKey, FeeLineInput>)

const createEmptyAssessmentInputs = (): ClientAssessmentInputs => ({
  cedula: "",
  officialReceipt: "",
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

const cloneAssessmentInputs = (value: ClientAssessmentInputs): ClientAssessmentInputs => ({
  cedula: value.cedula,
  officialReceipt: value.officialReceipt,
  fees: FEE_DEFINITIONS.reduce((accumulator, item) => {
    const row = value.fees[item.key]
    accumulator[item.key] = { amount: row?.amount ?? "", penalty: row?.penalty ?? "" }
    return accumulator
  }, {} as Record<FeeKey, FeeLineInput>),
  additionalFees: value.additionalFees.map((fee) => ({ ...fee })),
})

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

const getApplicantNameKey = (record: BusinessApplicationRecord) => {
  const form = (record.form ?? {}) as Record<string, unknown>
  const first = normalizeNameToken(form.firstName)
  const middle = normalizeNameToken(form.middleName)
  const last = normalizeNameToken(form.lastName)
  if (first || middle || last) {
    return `${first}|${middle}|${last}`
  }

  // Avoid accidentally grouping unknown-name records together.
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
  nameKey: string
  applicationUids: string[]
  primaryApplicationUid: string
}

const getSharedDocumentValues = (
  applicationUids: string[],
  primaryApplicationUid: string,
  inputsByApplication: Record<string, ClientAssessmentInputs>
) => {
  const primary = inputsByApplication[primaryApplicationUid]
  if (primary && (primary.cedula.trim() || primary.officialReceipt.trim())) {
    return { cedula: primary.cedula, officialReceipt: primary.officialReceipt }
  }

  for (const applicationUid of applicationUids) {
    const candidate = inputsByApplication[applicationUid]
    if (!candidate) continue
    if (candidate.cedula.trim() || candidate.officialReceipt.trim()) {
      return { cedula: candidate.cedula, officialReceipt: candidate.officialReceipt }
    }
  }

  return { cedula: "", officialReceipt: "" }
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
        <td className="border-b border-r border-slate-300 px-3 py-2 text-slate-800">{item.label}</td>
        <td className="border-b border-r border-slate-300 px-3 py-2 text-right tabular-nums text-slate-700 whitespace-nowrap">
          {isEditing ? (
            <input
              type="text"
              inputMode="decimal"
              value={row.amount}
              onChange={(event) => onFeeValueChange(item.key, "amount", event.target.value)}
              onKeyDown={onInputKeyDown}
              data-nav-row={rowIndex}
              data-nav-col={1}
              className="h-9 w-full rounded-md border border-slate-300 px-2 text-right text-sm outline-none ring-emerald-200 focus:ring"
            />
          ) : (
            formatNumberCell(row.amount)
          )}
        </td>
        <td className="border-b border-r border-slate-300 px-3 py-2 text-right tabular-nums text-slate-700 whitespace-nowrap">
          {isEditing ? (
            <input
              type="text"
              inputMode="decimal"
              value={row.penalty}
              onChange={(event) => onFeeValueChange(item.key, "penalty", event.target.value)}
              onKeyDown={onInputKeyDown}
              data-nav-row={rowIndex}
              data-nav-col={2}
              className="h-9 w-full rounded-md border border-slate-300 px-2 text-right text-sm outline-none ring-emerald-200 focus:ring"
            />
          ) : (
            formatNumberCell(row.penalty)
          )}
        </td>
        <td className="border-b border-slate-300 px-3 py-2 text-right tabular-nums text-slate-700 whitespace-nowrap">
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
        <td className="border-b border-r border-slate-300 px-3 py-2 text-slate-800">
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
                className="h-9 w-full rounded-md border border-slate-300 px-2 text-sm outline-none ring-emerald-200 focus:ring"
              />
              <button
                type="button"
                onClick={() => onRemoveAdditionalFee(fee.id)}
                className="inline-flex h-9 items-center justify-center rounded-md border border-slate-300 px-3 text-xs font-medium text-slate-700 hover:bg-slate-100"
              >
                Remove
              </button>
            </div>
          ) : (
            fee.name.trim() || "-"
          )}
        </td>
        <td className="border-b border-r border-slate-300 px-3 py-2 text-right tabular-nums text-slate-700 whitespace-nowrap">
          {isEditing ? (
            <input
              type="text"
              inputMode="decimal"
              value={fee.amount}
              onChange={(event) => onAdditionalFeeValueChange(fee.id, "amount", event.target.value)}
              onKeyDown={onInputKeyDown}
              data-nav-row={rowIndex}
              data-nav-col={1}
              className="h-9 w-full rounded-md border border-slate-300 px-2 text-right text-sm outline-none ring-emerald-200 focus:ring"
            />
          ) : (
            formatNumberCell(fee.amount)
          )}
        </td>
        <td className="border-b border-r border-slate-300 px-3 py-2 text-right tabular-nums text-slate-700 whitespace-nowrap">
          {isEditing ? (
            <input
              type="text"
              inputMode="decimal"
              value={fee.penalty}
              onChange={(event) => onAdditionalFeeValueChange(fee.id, "penalty", event.target.value)}
              onKeyDown={onInputKeyDown}
              data-nav-row={rowIndex}
              data-nav-col={2}
              className="h-9 w-full rounded-md border border-slate-300 px-2 text-right text-sm outline-none ring-emerald-200 focus:ring"
            />
          ) : (
            formatNumberCell(fee.penalty)
          )}
        </td>
        <td className="border-b border-slate-300 px-3 py-2 text-right tabular-nums text-slate-700 whitespace-nowrap">
          {hasValue ? formatCurrency(additionalLineTotals[fee.id] ?? 0) : "-"}
        </td>
      </tr>
    )
  })

export default function TreasuryClientsPage() {
  const auth = useMemo(() => getAuth(firebaseApp), [])
  const [clients, setClients] = useState<BusinessApplicationRecord[]>([])
  const [authReady, setAuthReady] = useState(false)
  const [authUser, setAuthUser] = useState<User | null>(null)
  const [clientsLoading, setClientsLoading] = useState(true)
  const [clientsError, setClientsError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState("")
  const [feesByClient, setFeesByClient] = useState<Record<string, TreasuryFeeAssessmentRecord>>({})
  const [inputsByClient, setInputsByClient] = useState<Record<string, ClientAssessmentInputs>>({})
  const [savingClientUid, setSavingClientUid] = useState<string | null>(null)
  const [selectedClient, setSelectedClient] = useState<BusinessApplicationRecord | null>(null)
  const [editorValues, setEditorValues] = useState<ClientAssessmentInputs>(createEmptyAssessmentInputs)
  const [isDialogEditing, setIsDialogEditing] = useState(false)
  const [dialogFeedback, setDialogFeedback] = useState<SaveFeedback | null>(null)

  const selectedApplicationUid = selectedClient ? getApplicationUid(selectedClient) : null
  const dialogIsSaving = selectedApplicationUid ? savingClientUid === selectedApplicationUid : false
  const applicantGroupsByApplication = useMemo(() => {
    const grouped = new Map<string, BusinessApplicationRecord[]>()

    clients.forEach((client) => {
      const nameKey = getApplicantNameKey(client)
      const current = grouped.get(nameKey) ?? []
      current.push(client)
      grouped.set(nameKey, current)
    })

    const result: Record<string, ApplicantGroupContext> = {}
    grouped.forEach((records, nameKey) => {
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
          nameKey,
          applicationUids,
          primaryApplicationUid,
        }
      })
    })

    return result
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

      const sharedDocuments = getSharedDocumentValues(
        group.applicationUids,
        group.primaryApplicationUid,
        inputsByClient
      )

      if (group.primaryApplicationUid === applicationUid) {
        const primary = inputsByClient[applicationUid] ?? EMPTY_ASSESSMENT_INPUTS
        next[applicationUid] = {
          ...cloneAssessmentInputs(primary),
          cedula: sharedDocuments.cedula,
          officialReceipt: sharedDocuments.officialReceipt,
        }
        return
      }

      const nonPrimary = createEmptyAssessmentInputs()
      nonPrimary.cedula = sharedDocuments.cedula
      nonPrimary.officialReceipt = sharedDocuments.officialReceipt
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
          setClientsLoading(false)
          return
        }

        const node = snapshot.val() as Record<string, Record<string, any>>
        const parsed = Object.entries(node).map(([id, payload]) => normalizeBusinessApplication(id, payload))
        const submitted = parsed.filter((record) => Boolean(record.form) && Object.keys(record.form ?? {}).length > 0)
        submitted.sort((a, b) => (a.submittedAt ?? 0) - (b.submittedAt ?? 0))

        setClients(submitted)
        setClientsLoading(false)
      },
      (error) => {
        console.error("Failed to load treasury clients", error)
        setClients([])
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
    setInputsByClient(() => {
      const next: Record<string, ClientAssessmentInputs> = {}
      clients.forEach((client) => {
        const applicationUid = getApplicationUid(client)
        next[applicationUid] = mapRecordToInputs(getAssessmentForClient(client, feesByClient))
      })
      return next
    })
  }, [clients, feesByClient])

  const filteredClients = useMemo(() => {
    const normalizedSearch = searchQuery.trim().toLowerCase()
    if (!normalizedSearch) return clients

    return clients.filter((client) => {
      const fullName = (client.applicantName ?? "").toLowerCase()
      const businessName = (client.businessName ?? "").toLowerCase()
      return fullName.includes(normalizedSearch) || businessName.includes(normalizedSearch)
    })
  }, [clients, searchQuery])

  const openClientPreview = (record: BusinessApplicationRecord) => {
    const applicationUid = getApplicationUid(record)
    const group = applicantGroupsByApplication[applicationUid]
    const sourceUid = group?.primaryApplicationUid ?? applicationUid
    const existing = displayInputsByApplication[sourceUid] ?? EMPTY_ASSESSMENT_INPUTS
    setSelectedClient(record)
    setEditorValues(cloneAssessmentInputs(existing))
    setIsDialogEditing(!hasAnyAssessmentValue(existing))
    setDialogFeedback(null)
  }

  const handleDialogOpenChange = (open: boolean) => {
    if (open) return
    setSelectedClient(null)
    setEditorValues(createEmptyAssessmentInputs())
    setIsDialogEditing(false)
    setDialogFeedback(null)
  }

  const handleDocumentValueChange = (field: "cedula" | "officialReceipt", value: string) => {
    setEditorValues((previous) => ({ ...previous, [field]: value }))
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
      const authIdToken = await liveUser.getIdToken(true)
      if (liveUser.uid !== authUser.uid) {
        throw new Error("Treasury session changed. Please sign in again.")
      }

      const totals = computeAssessmentTotals(normalized.fees, normalized.additionalFees)
      const feesPayload = FEE_DEFINITIONS.reduce((accumulator, item) => {
        const row = normalized.fees[item.key]
        const amount = parseOptionalNumber(row.amount)
        const penalty = parseOptionalNumber(row.penalty)
        accumulator[item.key] = {
          amount,
          penalty,
          total: (amount ?? 0) + (penalty ?? 0),
        } satisfies TreasuryFeeLine
        return accumulator
      }, {} as Record<string, TreasuryFeeLine>)
      const additionalFeesPayload: TreasuryAdditionalFeeLine[] = normalized.additionalFees.map((row) => {
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
          return saveTreasuryFeeAssessment({
            applicationUid: groupApplicationUid,
            cedulaNumber: normalized.cedula,
            officialReceiptNumber: normalized.officialReceipt,
            fees: isPrimary ? feesPayload : {},
            additionalFees: isPrimary ? additionalFeesPayload : [],
            lguTotal: isPrimary ? totals.lguTotal : 0,
            grandTotal: isPrimary ? totals.grandTotal : 0,
            staffUid: authUser.uid,
            staffEmail: authUser.email ?? null,
            authIdToken,
          })
        })
      )

      setInputsByClient((previous) => {
        const next = { ...previous }
        const nonPrimaryInputs = createEmptyAssessmentInputs()
        nonPrimaryInputs.cedula = normalized.cedula
        nonPrimaryInputs.officialReceipt = normalized.officialReceipt

        groupedApplicationUids.forEach((groupApplicationUid) => {
          next[groupApplicationUid] =
            groupApplicationUid === primaryApplicationUid
              ? cloneAssessmentInputs(normalized)
              : cloneAssessmentInputs(nonPrimaryInputs)
        })

        return next
      })
      setSelectedClient(null)
      setEditorValues(createEmptyAssessmentInputs())
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
          <input
            type="text"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search clients by name..."
            className="h-10 w-full rounded-md border border-slate-300 px-3 text-sm outline-none ring-emerald-200 focus:ring md:max-w-sm"
          />
        </div>

        {clientsError ? (
          <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{clientsError}</div>
        ) : null}

        <div className="overflow-x-auto">
          <table className="min-w-[1080px] table-auto border-collapse">
            <thead>
              <tr className="bg-emerald-700 text-left text-sm text-white">
                <th className="px-3 py-3 font-medium">No.</th>
                <th className="px-3 py-3 font-medium">Client</th>
                <th className="px-3 py-3 font-medium">Application UID</th>
                <th className="px-3 py-3 font-medium">Application Date</th>
                <th className="px-3 py-3 font-medium">Grand Total</th>
                <th className="px-3 py-3 font-medium">Cedula No.</th>
                <th className="px-3 py-3 font-medium">OR No.</th>
              </tr>
            </thead>
            <tbody>
              {clientsLoading ? (
                <tr>
                  <td colSpan={7} className="border-b border-slate-200 px-3 py-6 text-center text-sm text-slate-500">Loading clients...</td>
                </tr>
              ) : filteredClients.length === 0 ? (
                <tr>
                  <td colSpan={7} className="border-b border-slate-200 px-3 py-6 text-center text-sm text-slate-500">No matching clients found.</td>
                </tr>
              ) : (
                filteredClients.map((client, index) => {
                  const applicationUid = getApplicationUid(client)
                  const row = displayInputsByApplication[applicationUid] ?? EMPTY_ASSESSMENT_INPUTS
                  const rowTotals = computeAssessmentTotals(row.fees, row.additionalFees)
                  const group = applicantGroupsByApplication[applicationUid]
                  const isPrimaryInGroup = !group || group.primaryApplicationUid === applicationUid
                  const shouldShowGrandTotal = isPrimaryInGroup && hasAnyFeeValue(row)
                  const formattedDate = (() => {
                    if (!client.applicationDate) return "-"
                    const date = new Date(client.applicationDate)
                    if (Number.isNaN(date.getTime())) return "-"
                    return date.toLocaleDateString()
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
                      <td className="px-3 py-3">
                        <p className="font-medium text-slate-900">{client.applicantName}</p>
                        {client.businessName ? <p className="text-xs text-slate-500">{client.businessName}</p> : null}
                      </td>
                      <td className="px-3 py-3 font-mono text-xs">{applicationUid}</td>
                      <td className="px-3 py-3">{formattedDate}</td>
                      <td className="px-3 py-3"><span className={shouldShowGrandTotal ? "font-medium text-slate-800" : "text-slate-400"}>{shouldShowGrandTotal ? formatCurrency(rowTotals.grandTotal) : "-"}</span></td>
                      <td className="px-3 py-3"><span className={row.cedula.trim() ? "font-medium text-slate-800" : "text-slate-400"}>{row.cedula.trim() || "-"}</span></td>
                      <td className="px-3 py-3"><span className={row.officialReceipt.trim() ? "font-medium text-slate-800" : "text-slate-400"}>{row.officialReceipt.trim() || "-"}</span></td>
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
          <DialogHeader className="border-b border-slate-200 bg-white px-6 py-4">
            <DialogTitle className="text-xl text-slate-900">Assessment Preview</DialogTitle>
            <DialogDescription className="text-slate-600">
              {selectedClient
                ? `${selectedClient.applicantName || "Client"}${selectedClient.businessName ? ` • ${selectedClient.businessName}` : ""}`
                : "Preview and update fee assessment details."}
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-[70vh] overflow-y-auto bg-slate-50 p-6" data-nav-scope="treasury-assessment">
            <div className="space-y-5">
              <div className="rounded-lg border border-slate-200 bg-white p-4">
                <p className="text-sm font-semibold text-slate-900">What This Form Is For</p>
                <p className="mt-2 text-sm text-slate-600">This form is used to assess local taxes, compute regulatory fees, add inspection charges, and calculate the Grand Total for business permit approval.</p>
                <p className="mt-2 text-xs text-slate-500">Typical use: Mayor's Permit application, business renewal, and new business registration.</p>
              </div>

              <div className="overflow-x-auto rounded-lg border-2 border-slate-300 bg-white">
                <div className="border-b border-slate-300 px-4 py-3"><p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Assessment of Applicable Fees</p></div>

                <table className="w-full min-w-[1200px] border-collapse text-sm">
                  <colgroup>
                    <col className="w-[52%]" />
                    <col className="w-[16%]" />
                    <col className="w-[16%]" />
                    <col className="w-[16%]" />
                  </colgroup>
                  <thead>
                    <tr className="bg-slate-100 text-slate-700">
                      <th className="border-b border-r border-slate-300 px-3 py-2 text-left font-semibold">Particulars</th>
                      <th className="border-b border-r border-slate-300 px-3 py-2 text-right font-semibold whitespace-nowrap">Amount</th>
                      <th className="border-b border-r border-slate-300 px-3 py-2 text-right font-semibold whitespace-nowrap">Penalty/Surcharge</th>
                      <th className="border-b border-slate-300 px-3 py-2 text-right font-semibold whitespace-nowrap">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="bg-slate-50"><td colSpan={4} className="border-b border-slate-300 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-600">1. Local Taxes</td></tr>
                    {renderFeeSectionRows(
                      LOCAL_TAX_ITEMS,
                      editorValues,
                      isDialogEditing,
                      dialogTotals.lineTotals,
                      handleFeeValueChange,
                      handleAssessmentInputArrowNavigation
                    )}
                    <tr className="bg-slate-50"><td colSpan={4} className="border-b border-slate-300 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-600">2. Regulatory Fees and Charges</td></tr>
                    {renderFeeSectionRows(
                      REGULATORY_FEE_ITEMS,
                      editorValues,
                      isDialogEditing,
                      dialogTotals.lineTotals,
                      handleFeeValueChange,
                      handleAssessmentInputArrowNavigation
                    )}
                    <tr className="bg-slate-50"><td colSpan={4} className="border-b border-slate-300 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-600">3. Additional Fees (Optional)</td></tr>
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
                        <td colSpan={4} className="border-b border-slate-300 px-3 py-3">
                          <button
                            type="button"
                            onClick={handleAddAdditionalFee}
                            className="inline-flex h-9 items-center justify-center rounded-md border border-slate-300 px-3 text-xs font-medium text-slate-700 hover:bg-slate-100"
                          >
                            + Add Fee
                          </button>
                        </td>
                      </tr>
                    ) : null}
                    <tr className="bg-slate-50"><td colSpan={4} className="border-b border-slate-300 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-600">4. Fire Safety Fees</td></tr>
                    {renderFeeSectionRows(
                      FIRE_FEE_ITEMS,
                      editorValues,
                      isDialogEditing,
                      dialogTotals.lineTotals,
                      handleFeeValueChange,
                      handleAssessmentInputArrowNavigation
                    )}
                    <tr className="bg-slate-50">
                      <td className="border-b border-r border-slate-300 px-3 py-2 font-semibold text-slate-900">TOTAL FEES for LGU</td>
                      <td className="border-b border-r border-slate-300 px-3 py-2 text-right text-slate-500">-</td>
                      <td className="border-b border-r border-slate-300 px-3 py-2 text-right text-slate-500">-</td>
                      <td className="border-b border-slate-300 px-3 py-2 text-right font-semibold tabular-nums text-slate-900 whitespace-nowrap">{dialogHasFeeValues ? formatCurrency(dialogTotals.lguTotal) : "-"}</td>
                    </tr>
                    <tr className="bg-slate-100">
                      <td className="border-r border-slate-300 px-3 py-2 font-semibold text-slate-900">GRAND TOTAL</td>
                      <td className="border-r border-slate-300 px-3 py-2 text-right text-slate-500">-</td>
                      <td className="border-r border-slate-300 px-3 py-2 text-right text-slate-500">-</td>
                      <td className="px-3 py-2 text-right font-semibold tabular-nums text-slate-900 whitespace-nowrap">{dialogHasFeeValues ? formatCurrency(dialogTotals.grandTotal) : "-"}</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <div className="overflow-hidden rounded-lg border-2 border-slate-300 bg-white">
                <div className="grid grid-cols-12 border-b border-slate-300 bg-slate-100 text-[11px] font-semibold uppercase tracking-wide text-slate-600">
                  <div className="col-span-6 border-r border-slate-300 px-3 py-2">Field</div>
                  <div className="col-span-3 border-r border-slate-300 px-3 py-2">Reference No.</div>
                  <div className="col-span-3 px-3 py-2">Notes</div>
                </div>

                <div className="grid grid-cols-12 border-b border-slate-300">
                  <div className="col-span-6 border-r border-slate-300 px-3 py-3 text-sm font-medium text-slate-800">Cedula Number</div>
                  <div className="col-span-3 border-r border-slate-300 px-3 py-2">
                    {isDialogEditing ? <input type="text" value={editorValues.cedula} onChange={(event) => handleDocumentValueChange("cedula", event.target.value)} onKeyDown={handleAssessmentInputArrowNavigation} data-nav-row={FEE_DEFINITIONS.length + editorValues.additionalFees.length} data-nav-col={0} className="h-9 w-full rounded-md border border-slate-300 px-2 text-sm outline-none ring-emerald-200 focus:ring" /> : <p className="pt-2 text-sm text-slate-700">{editorValues.cedula.trim() || "-"}</p>}
                  </div>
                  <div className="col-span-3 px-3 py-3 text-xs text-slate-500">Community Tax Certificate reference.</div>
                </div>

                <div className="grid grid-cols-12">
                  <div className="col-span-6 border-r border-slate-300 px-3 py-3 text-sm font-medium text-slate-800">Official Receipt Number</div>
                  <div className="col-span-3 border-r border-slate-300 px-3 py-2">
                    {isDialogEditing ? <input type="text" value={editorValues.officialReceipt} onChange={(event) => handleDocumentValueChange("officialReceipt", event.target.value)} onKeyDown={handleAssessmentInputArrowNavigation} data-nav-row={FEE_DEFINITIONS.length + editorValues.additionalFees.length + 1} data-nav-col={0} className="h-9 w-full rounded-md border border-slate-300 px-2 text-sm outline-none ring-emerald-200 focus:ring" /> : <p className="pt-2 text-sm text-slate-700">{editorValues.officialReceipt.trim() || "-"}</p>}
                  </div>
                  <div className="col-span-3 px-3 py-3 text-xs text-slate-500">Official receipt reference for payment.</div>
                </div>
              </div>

              {isDialogEditing && !hasRequiredDocumentReferences(editorValues) ? (
                <p className="text-xs font-medium text-red-600">Cedula Number and Official Receipt Number are required to save.</p>
              ) : null}
            </div>

            {dialogFeedback ? <p className={`mt-4 text-sm ${dialogFeedback.type === "success" ? "text-emerald-700" : "text-red-600"}`}>{dialogFeedback.message}</p> : null}
          </div>

          <DialogFooter className="border-t border-slate-200 bg-white px-6 py-4">
            {!isDialogEditing ? (
              <button type="button" onClick={() => { setDialogFeedback(null); setIsDialogEditing(true) }} className="inline-flex h-10 items-center justify-center rounded-md border border-slate-300 px-4 text-sm font-medium text-slate-700 hover:bg-slate-100">Edit</button>
            ) : null}

            {isDialogEditing ? (
              <button type="button" onClick={() => handleDialogOpenChange(false)} disabled={dialogIsSaving} className="inline-flex h-10 items-center justify-center rounded-md border border-slate-300 px-4 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60">Close</button>
            ) : null}

            {isDialogEditing ? (
              <button type="button" onClick={handleSaveFromDialog} disabled={dialogIsSaving || !hasRequiredDocumentReferences(editorValues)} className="inline-flex h-10 items-center justify-center rounded-md bg-emerald-700 px-4 text-sm font-medium text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-60">{dialogIsSaving ? "Saving..." : "Save"}</button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TreasuryShell>
  )
}
