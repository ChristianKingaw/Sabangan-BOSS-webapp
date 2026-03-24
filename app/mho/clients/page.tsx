"use client"

import React, { useEffect, useMemo, useState } from "react"
import { getAuth, onAuthStateChanged, type User } from "firebase/auth"
import { onValue, ref } from "firebase/database"
import MhoShell from "@/components/mho-shell"
import { app as firebaseApp, realtimeDb } from "@/database/firebase"
import {
  type TreasuryFeeAssessmentRecord,
  watchTreasuryFeesByClient,
} from "@/database/treasury"
import {
  BUSINESS_APPLICATION_PATH,
  normalizeBusinessApplication,
  type BusinessApplicationRecord,
} from "@/lib/business-applications"
import { toast } from "sonner"

const getApplicationUid = (record: BusinessApplicationRecord) => record.id

const getApplicantName = (record: BusinessApplicationRecord) => {
  const form = (record.form ?? {}) as Record<string, unknown>
  const first = String(form.firstName ?? "").trim()
  const middle = String(form.middleName ?? "").trim()
  const last = String(form.lastName ?? "").trim()
  return [first, middle, last].filter(Boolean).join(" ") || "Unnamed Applicant"
}

const getBusinessName = (record: BusinessApplicationRecord) => {
  const form = (record.form ?? {}) as Record<string, unknown>
  return String(form.businessName ?? "").trim() || "—"
}

const formatDate = (value: string | number | null | undefined) => {
  if (!value) return "—"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "—"
  return date.toLocaleDateString()
}

const getApplicationDateTimestamp = (record: BusinessApplicationRecord) => {
  if (!record.applicationDate) return null
  const date = new Date(record.applicationDate)
  const timestamp = date.getTime()
  return Number.isNaN(timestamp) ? null : timestamp
}

const getApplicationYear = (record: BusinessApplicationRecord) => {
  const timestamp = getApplicationDateTimestamp(record)
  if (timestamp === null) return null
  return new Date(timestamp).getFullYear()
}

const getSortTimestamp = (record: BusinessApplicationRecord) =>
  getApplicationDateTimestamp(record) ?? record.submittedAt ?? 0

export default function MhoClientsPage() {
  const auth = useMemo(() => getAuth(firebaseApp), [])
  const [currentUser, setCurrentUser] = useState<User | null>(null)
  const [applications, setApplications] = useState<BusinessApplicationRecord[]>([])
  const [treasuryFees, setTreasuryFees] = useState<Record<string, TreasuryFeeAssessmentRecord>>({})
  const [loading, setLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState("")
  const [selectedYear, setSelectedYear] = useState("all")
  const [generatingFor, setGeneratingFor] = useState<string | null>(null)

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setCurrentUser(user)
    })
    return unsubscribe
  }, [auth])

  useEffect(() => {
    const applicationsRef = ref(realtimeDb, BUSINESS_APPLICATION_PATH)
    const unsubscribeApplications = onValue(
      applicationsRef,
      (snapshot) => {
        if (!snapshot.exists()) {
          setApplications([])
          setLoading(false)
          return
        }

        const raw = snapshot.val() as Record<string, Record<string, unknown>>
        const list = Object.entries(raw)
          .map(([id, data]) => normalizeBusinessApplication(id, data))
          .filter((app): app is BusinessApplicationRecord => app !== null)

        setApplications(list)
        setLoading(false)
      },
      (error) => {
        console.error("Failed to load applications:", error)
        toast.error("Failed to load applications")
        setLoading(false)
      }
    )

    const unsubscribeFees = watchTreasuryFeesByClient(
      (fees) => setTreasuryFees(fees),
      (error) => console.error("Failed to load treasury fees:", error)
    )

    return () => {
      unsubscribeApplications()
      unsubscribeFees()
    }
  }, [])

  const getSanitaryPaymentStatus = (applicationId: string) => {
    const assessment = treasuryFees[applicationId]
    if (!assessment) return { paid: false, amount: 0 }
    const sanitaryFee = assessment.fees?.sanitary_inspection_fee
    return {
      paid: Boolean(sanitaryFee && sanitaryFee.total > 0),
      amount: sanitaryFee?.total ?? 0,
    }
  }

  const availableYears = useMemo(() => {
    const years = new Set<number>()
    applications.forEach((application) => {
      const year = getApplicationYear(application)
      if (year !== null) years.add(year)
    })
    return [...years].sort((left, right) => right - left)
  }, [applications])

  const filteredApplications = useMemo(() => {
    const term = searchTerm.trim().toLowerCase()
    const selectedYearValue = selectedYear === "all" ? null : Number(selectedYear)

    return applications
      .filter((app) => {
        const applicantName = getApplicantName(app).toLowerCase()
        const businessName = getBusinessName(app).toLowerCase()
        const matchesSearch =
          !term || applicantName.includes(term) || businessName.includes(term)

        if (!matchesSearch) return false
        if (selectedYearValue === null) return true

        return getApplicationYear(app) === selectedYearValue
      })
      .sort((left, right) => {
        const timestampDiff = getSortTimestamp(right) - getSortTimestamp(left)
        if (timestampDiff !== 0) return timestampDiff
        return left.id.localeCompare(right.id)
      })
  }, [applications, searchTerm, selectedYear])

  const handleGenerateSanitaryPermit = async (app: BusinessApplicationRecord) => {
    if (!currentUser) {
      toast.error("You must be logged in to generate permits")
      return
    }

    const status = getSanitaryPaymentStatus(app.id)
    if (!status.paid) {
      toast.error("Sanitary inspection fee has not been paid")
      return
    }

    setGeneratingFor(app.id)
    try {
      const idToken = await currentUser.getIdToken(true)
      const response = await fetch("/api/mho/sanitary-permit", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({ applicationId: app.id }),
      })

      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        throw new Error(String(body.error || "Failed to generate permit"))
      }

      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const link = document.createElement("a")
      link.href = url
      link.download = `sanitary_permit_${getBusinessName(app).replace(/\s+/g, "_")}.docx`
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      URL.revokeObjectURL(url)

      toast.success("Sanitary permit generated successfully")
    } catch (error) {
      console.error("Failed to generate sanitary permit:", error)
      toast.error(error instanceof Error ? error.message : "Failed to generate permit")
    } finally {
      setGeneratingFor(null)
    }
  }

  return (
    <MhoShell
      activeNav="clients"
      title="Client Applications"
      description="View business applications and generate sanitary permits for clients with paid fees."
    >
      <div className="mb-4 flex flex-col gap-2 md:flex-row md:items-center">
        <input
          type="text"
          placeholder="Search by applicant or business name..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 md:max-w-md"
        />
        <select
          value={selectedYear}
          onChange={(event) => setSelectedYear(event.target.value)}
          className="h-[38px] rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-700 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 md:w-40"
        >
          <option value="all">All Years</option>
          {availableYears.map((year) => (
            <option key={year} value={String(year)}>
              {year}
            </option>
          ))}
        </select>
      </div>

      {loading ? (
        <p className="text-sm text-slate-600">Loading applications...</p>
      ) : filteredApplications.length === 0 ? (
        <p className="text-sm text-slate-600">No applications found.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-slate-700">Applicant Name</th>
                <th className="px-4 py-3 text-left font-medium text-slate-700">Business Name</th>
                <th className="px-4 py-3 text-left font-medium text-slate-700">Type</th>
                <th className="px-4 py-3 text-left font-medium text-slate-700">Date</th>
                <th className="px-4 py-3 text-left font-medium text-slate-700">Sanitary Fee</th>
                <th className="px-4 py-3 text-left font-medium text-slate-700">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {filteredApplications.map((app) => {
                const status = getSanitaryPaymentStatus(app.id)
                const isGenerating = generatingFor === app.id

                return (
                  <tr key={app.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3 font-medium text-slate-900">{getApplicantName(app)}</td>
                    <td className="px-4 py-3 text-slate-700">{getBusinessName(app)}</td>
                    <td className="px-4 py-3 text-slate-700">{app.applicationType || "—"}</td>
                    <td className="px-4 py-3 text-slate-700">{formatDate(app.applicationDate)}</td>
                    <td className="px-4 py-3">
                      {status.paid ? (
                        <span className="inline-flex items-center rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-800">
                          Paid ({status.amount.toFixed(2)})
                        </span>
                      ) : (
                        <span className="inline-flex items-center rounded-full bg-yellow-100 px-2.5 py-0.5 text-xs font-medium text-yellow-800">
                          Pending
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        onClick={() => handleGenerateSanitaryPermit(app)}
                        disabled={!status.paid || isGenerating}
                        className="inline-flex items-center rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {isGenerating ? "Generating..." : "Generate Permit"}
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </MhoShell>
  )
}
