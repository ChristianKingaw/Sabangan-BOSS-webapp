import { parseDateToTimestamp, type BusinessRequirement, type BusinessRequirementFile } from "@/lib/business-applications"

export const MAYORS_CLEARANCE_APPLICATION_PATH = "mayors_clearance"

export type ClearanceApplicationRecord = {
  id: string
  applicantName: string
  applicationDate?: string | number
  purpose?: string
  status?: string
  overallStatus?: string
  submittedAt?: number
  applicantUid?: string
  requirements: BusinessRequirement[]
  form?: Record<string, any>
}

export const buildClearanceMessengerThreadId = (applicantUid: string, applicationId: string) =>
  `clearance:${applicantUid}:${applicationId}`

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")

export const normalizeClearanceRequirementFiles = (filesNode: Record<string, any> | undefined): BusinessRequirementFile[] => {
  if (!filesNode) return []

  return Object.entries(filesNode)
    .map(([fileId, fileData]) => ({
      id: fileId,
      downloadUrl: fileData?.downloadUrl ?? "",
      status: fileData?.status ?? "",
      adminNote: fileData?.adminNote ?? "",
      storagePath: fileData?.storagePath ?? "",
      uploadedAt: typeof fileData?.uploadedAt === "number" ? fileData.uploadedAt : undefined,
      fileName: fileData?.fileName ?? "",
      fileSize: fileData?.fileSize ?? 0,
      fileHash: fileData?.fileHash ?? "",
    }))
    .sort((a, b) => (a.uploadedAt ?? 0) - (b.uploadedAt ?? 0))
}

export const normalizeClearanceRequirements = (requirementsNode: Record<string, any> | undefined): BusinessRequirement[] => {
  if (!requirementsNode) return []

  return Object.entries(requirementsNode).map(([name, requirementData], index) => ({
    id: `${slugify(name) || "requirement"}-${index}`,
    name,
    files: normalizeClearanceRequirementFiles(requirementData?.files),
  }))
}

export const normalizeClearanceApplicant = (id: string, payload: any): ClearanceApplicationRecord => {
  const form = payload?.form ?? payload ?? {}
  const meta = payload?.meta ?? {}

  const normalizedRequirements = normalizeClearanceRequirements(payload?.requirements)

  const nameParts = [
    form.firstName ?? form.firstname ?? form.givenName,
    form.middleName ?? form.middlename ?? form.middle_name,
    form.lastName ?? form.lastname ?? form.surname,
  ]
    .map((part: unknown) => (part ?? "").toString().trim())
    .filter(Boolean)

  const fallbackName = (form.applicantName || form.fullName || form.name || "").toString().trim()
  const applicantName = (nameParts.join(" ") || fallbackName || "Unnamed Applicant").trim()

  let applicationDate: string | number =
    form.dateOfApplication ??
    form.applicationDate ??
    form.date ??
    form.submissionDate ??
    meta.applicationDate ??
    meta.submissionDate ??
    ""

  if (!applicationDate && typeof meta.createdAt === "number") {
    applicationDate = meta.createdAt
  }

  const submittedAt =
    (typeof applicationDate === "number" ? applicationDate : parseDateToTimestamp(applicationDate)) ??
    (typeof meta.updatedAt === "number" ? meta.updatedAt : undefined) ??
    (typeof payload?.submittedAt === "number" ? payload.submittedAt : undefined)

  const status = meta.status ?? payload?.status ?? ""
  const overallStatus = meta.overallStatus ?? payload?.overallStatus ?? status ?? ""
  const purpose = form.purpose ?? form.reason ?? form.applicationPurpose ?? form.clearancePurpose ?? ""

  const requirementStates = normalizedRequirements.map((req) => {
    const fileStatuses = req.files.map((f) => (f.status ?? "").toLowerCase())
    if (fileStatuses.some((s) => s === "updated" || s.includes("pending") || s === "")) return "pending"
    if (fileStatuses.some((s) => s.includes("reject"))) return "rejected"
    if (fileStatuses.some((s) => s.includes("approve"))) return "approved"
    return "pending"
  })

  let derivedOverallStatus = overallStatus
  if (requirementStates.some((s) => s === "pending")) {
    derivedOverallStatus = "Pending Review"
  } else if (requirementStates.length > 0 && requirementStates.every((s) => s === "approved")) {
    derivedOverallStatus = "Approved"
  } else if (!requirementStates.some((s) => s === "pending") && requirementStates.some((s) => s === "rejected")) {
    derivedOverallStatus = "Incomplete"
  }

  return {
    id,
    applicantUid: meta.applicantUid ?? payload?.applicantUid ?? "",
    applicantName,
    applicationDate,
    purpose,
    status,
    overallStatus: derivedOverallStatus,
    submittedAt,
    requirements: normalizedRequirements,
    form,
  }
}
