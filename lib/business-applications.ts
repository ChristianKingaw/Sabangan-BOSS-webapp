export const BUSINESS_APPLICATION_PATH = "business/business_application"

export type ApplicationType = "New" | "Renewal"

export type BusinessRequirementFile = {
  id: string
  downloadUrl?: string
  status?: string
  adminNote?: string
  storagePath?: string
  uploadedAt?: number
  fileName?: string
  fileSize?: number
  fileHash?: string
}

export type BusinessRequirement = {
  id: string
  name: string
  files: BusinessRequirementFile[]
}

export type ChatMessage = {
  id: string
  senderRole?: string
  senderUid?: string
  text?: string
  sentAt?: number
}

export type BusinessApplicationRecord = {
  id: string
  applicantUid?: string
  applicantName: string
  businessName: string
  applicationType: ApplicationType
  applicationDate?: string
  form?: Record<string, any>
  status?: string
  overallStatus?: string
  approvedAt?: number
  submittedAt?: number
  requirements: BusinessRequirement[]
  chat?: ChatMessage[]
}

/**
 * Returns the latest uploadedAt timestamp across all requirement files
 * for a business application. Useful for building stable notification IDs
 * that change whenever a client uploads a new document.
 */
export const getLatestRequirementUploadTimestamp = (record: BusinessApplicationRecord): number | undefined => {
  let latest: number | undefined

  record.requirements.forEach((requirement) => {
    requirement.files.forEach((file) => {
      if (typeof file.uploadedAt !== "number") return
      if (latest === undefined || file.uploadedAt > latest) {
        latest = file.uploadedAt
      }
    })
  })

  return latest
}

/**
 * Build a notification ID that bumps when a new requirement file arrives.
 * This keeps unread state in sync with the latest client activity instead
 * of staying "read" forever after the first upload.
 */
export const buildRequirementNotificationId = (record: BusinessApplicationRecord): string | null => {
  const latest = getLatestRequirementUploadTimestamp(record)
  if (!latest) return null
  return `requirements-${record.id}-${latest}`
}

export type StatusBadge = { label: string; className: string }

const normalizeWhitespace = (value?: string) =>
  (value ?? "")
    .split(" ")
    .filter(Boolean)
    .join(" ")
    .trim()

export const formatStatusLabel = (value?: string) => {
  if (!value) {
    return "Pending"
  }
  return value
    .replace(/[_-]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ")
}

export const parseDateToTimestamp = (value?: string) => {
  if (!value) {
    return undefined
  }
  const parsed = new Date(value)
  const time = parsed.getTime()
  return Number.isNaN(time) ? undefined : time
}

const coerceTimestamp = (value: unknown) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value
  }
  if (typeof value === "string" && value.trim()) {
    return parseDateToTimestamp(value)
  }
  return undefined
}

export const getStatusBadge = (status?: string, overallStatus?: string): StatusBadge => {
  const normalized = (overallStatus || status || "").toLowerCase()
  const label = formatStatusLabel(overallStatus || status)

  if (normalized.includes("reject")) {
    return { label, className: "bg-red-100 text-red-700" }
  }

  // Explicit Incomplete state should match the rejected badge styling
  if (normalized.includes("incomplete")) {
    return { label, className: "bg-red-100 text-red-700" }
  }

  if (
    normalized.includes("approve") ||
    normalized.includes("complete") ||
    normalized.includes("process")
  ) {
    return { label, className: "bg-green-100 text-green-800" }
  }

  if (normalized.includes("review") || normalized.includes("submit")) {
    return { label, className: "bg-blue-100 text-blue-700" }
  }

  // Treat explicit pending statuses as blue
  if (normalized.includes("pending")) {
    return { label: label || "Pending", className: "bg-blue-100 text-blue-700" }
  }

  return { label: label || "Pending", className: "bg-yellow-100 text-yellow-700" }
}

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")

const normalizeRequirementFiles = (filesNode: Record<string, any> | undefined): BusinessRequirementFile[] => {
  if (!filesNode) {
    return []
  }

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

const normalizeRequirementChat = (chatNode: Record<string, any> | undefined): ChatMessage[] => {
  if (!chatNode) return []

  return Object.entries(chatNode)
    .map(([chatId, chatData]) => ({
      id: chatId,
      senderRole: chatData?.senderRole ?? "",
      senderUid: chatData?.senderUid ?? "",
      text: chatData?.text ?? "",
      sentAt: typeof chatData?.ts === "number" ? chatData.ts : undefined,
    }))
    .sort((a, b) => (a.sentAt ?? 0) - (b.sentAt ?? 0))
}

const normalizeRequirements = (requirementsNode: Record<string, any> | undefined): BusinessRequirement[] => {
  if (!requirementsNode) {
    return []
  }

  return Object.entries(requirementsNode).map(([name, requirementData], index) => ({
    id: `${slugify(name) || "requirement"}-${index}`,
    name,
    files: normalizeRequirementFiles(requirementData?.files),
    chat: normalizeRequirementChat(requirementData?.chat),
  }))
}

const getLatestApprovedRequirementTimestamp = (requirements: BusinessRequirement[]): number | undefined => {
  const approvedUploads: number[] = []

  requirements.forEach((requirement) => {
    requirement.files.forEach((file) => {
      const normalizedStatus = (file.status ?? "").toLowerCase()
      if (!normalizedStatus.includes("approve")) return
      if (typeof file.uploadedAt === "number" && Number.isFinite(file.uploadedAt)) {
        approvedUploads.push(file.uploadedAt)
      }
    })
  })

  if (approvedUploads.length === 0) {
    return undefined
  }

  return Math.max(...approvedUploads)
}

export const normalizeBusinessApplication = (id: string, payload: any): BusinessApplicationRecord => {
  const form = payload?.form ?? {}
  const meta = payload?.meta ?? {}
  const applicantUid = normalizeWhitespace(
    String(form?.applicantUid ?? meta?.applicantUid ?? payload?.applicantUid ?? "")
  )
  const applicationDate: string = form.dateOfApplication ?? form.registrationDate ?? ""
  const submittedAt =
    parseDateToTimestamp(applicationDate) ?? (typeof meta.updatedAt === "number" ? meta.updatedAt : undefined)
  const applicantName = normalizeWhitespace([form.firstName, form.middleName, form.lastName].filter(Boolean).join(" "))
  const applicationType: ApplicationType = form.applicationType === "Renewal" ? "Renewal" : "New"
  const normalizedRequirements = normalizeRequirements(payload?.requirements)

  // Derive overall status from requirement file statuses with these rules:
  // - If any requirement has a pending status (e.g. "pending", "updated", or empty), client overall status => "Pending Review"
  // - Else if all requirements have an approved file => "Approved"
  // - Else if there are no pending statuses but at least one rejected file => "Incomplete"
  const requirementStates = normalizedRequirements.map((req) => {
    const fileStatuses = req.files.map((f) => (f.status ?? "").toLowerCase())
    // Prioritize pending updates, then rejections, then approvals.
    if (fileStatuses.some((s) => s === "updated" || s.includes("pending") || s === "")) return "pending"
    if (fileStatuses.some((s) => s.includes("reject"))) return "rejected"
    if (fileStatuses.some((s) => s.includes("approve"))) return "approved"
    return "pending"
  })

  let derivedOverallStatus = meta.overallStatus ?? ""
  if (requirementStates.some((s) => s === "pending")) {
    derivedOverallStatus = "Pending Review"
  } else if (requirementStates.length > 0 && requirementStates.every((s) => s === "approved")) {
    derivedOverallStatus = "Approved"
  } else if (!requirementStates.some((s) => s === "pending") && requirementStates.some((s) => s === "rejected")) {
    derivedOverallStatus = "Incomplete"
  }

  return {
    id,
    applicantUid: applicantUid || undefined,
    applicantName: applicantName || form.businessName || "Unnamed Applicant",
    businessName: form.businessName ?? "",
    applicationType,
    applicationDate,
    form,
    status: meta.status ?? "",
    overallStatus: derivedOverallStatus,
    approvedAt:
      coerceTimestamp(meta.approvedAt) ??
      coerceTimestamp(meta.approvedOn) ??
      coerceTimestamp(meta.approvalDate) ??
      coerceTimestamp(meta.approvedDate) ??
      coerceTimestamp(meta.dateApproved) ??
      (derivedOverallStatus === "Approved"
        ? getLatestApprovedRequirementTimestamp(normalizedRequirements) ??
          (typeof meta.updatedAt === "number" ? meta.updatedAt : undefined)
        : undefined),
    submittedAt,
    requirements: normalizedRequirements,
    chat: normalizeRequirementChat(payload?.chat),
  }
}
