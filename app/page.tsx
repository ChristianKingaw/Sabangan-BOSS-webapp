"use client"

import { useState, useEffect, useCallback, useMemo, useRef, type FormEvent, type MouseEvent, type ReactNode } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import {
  LogIn,
  Eye,
  EyeOff,
  LogOut,
  Search,
  FileText,
  XCircle,
  Award,
  Download,
  LayoutDashboard,
  CalendarDays,
  Check,
  Loader2,
  MessageSquare,
  RefreshCw,
  ClipboardList,
  X,
  ChevronLeft,
  ChevronRight,
  CheckCircle,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import Image from "next/image"
import Header from "@/components/header"
import Messenger from "@/components/ui/messenger"
import ExcelJS from "exceljs"
import { renderAsync } from "docx-preview"
import { app as firebaseApp, realtimeDb } from "@/database/firebase"
import { saveClearanceFile, subscribeToClearanceFiles, clearClearanceFiles, type ClearanceFileWithId } from "@/database/clearance"
import { findStaffByEmail, updateStaffEmailVerificationStatus } from "@/database/staff"
import { getAuth, onAuthStateChanged, sendEmailVerification, signInWithEmailAndPassword, signOut } from "firebase/auth"
import { FirebaseError } from "firebase/app"
import { onValue, ref, off, get, update } from "firebase/database"
import { cn } from "@/lib/utils"
import { handlePrintHtml, handlePrintPdf } from "@/lib/print"
import { toast } from "sonner"
import { mergePdfUrls } from "@/lib/pdf"
import { PDFDocument } from "pdf-lib"
import {
  BUSINESS_APPLICATION_PATH,
  type ApplicationType,
  type BusinessApplicationRecord,
  type BusinessRequirement,
  type BusinessRequirementFile,
  parseDateToTimestamp,
  getStatusBadge,
  normalizeBusinessApplication,
  buildRequirementNotificationId,
} from "@/lib/business-applications"
import {
  MAYORS_CLEARANCE_APPLICATION_PATH,
  normalizeClearanceApplicant,
  type ClearanceApplicationRecord,
  buildClearanceMessengerThreadId,
} from "@/lib/clearance-applications"

const MS_IN_DAY = 24 * 60 * 60 * 1000
const RECENT_NOTIFICATION_DAYS = 2
const MAX_NOTIFICATIONS_PER_GROUP = 6
const REQUIREMENT_UPDATE_THRESHOLD_MS = 6 * 60 * 60 * 1000

const getClientMessageTimestamps = (payload: any): number[] => {
  const chatNode = (payload as any)?.chat ?? null
  const appChats: number[] = chatNode
    ? Object.values(chatNode)
        .map((c: any) => {
          const role = (c?.senderRole ?? "").toString().toLowerCase()
          if (role === "admin") return null
          return typeof c?.ts === "number" ? c.ts : null
        })
        .filter((ts): ts is number => typeof ts === "number")
    : []

  const reqNode = (payload as any)?.requirements ?? null
  const reqChats: number[] = reqNode
    ? Object.values(reqNode).flatMap((reqData: any) => {
        const rChat = reqData?.chat ?? null
        if (!rChat) return []
        return Object.values(rChat)
          .map((c: any) => {
            const role = (c?.senderRole ?? "").toString().toLowerCase()
            if (role === "admin") return null
            return typeof c?.ts === "number" ? c.ts : null
          })
          .filter((ts): ts is number => typeof ts === "number")
      })
    : []

  return [...appChats, ...reqChats]
}

const getLatestClientMessageTimestamp = (payload: any): number | undefined => {
  const ts = getClientMessageTimestamps(payload)
  if (ts.length === 0) return undefined
  return Math.max(...ts)
}

const buildBusinessLatestClientTsMap = (node: Record<string, any>) => {
  const computed: Record<string, number> = {}
  for (const [id, payload] of Object.entries(node)) {
    try {
      const lastClientTs = getLatestClientMessageTimestamp(payload)
      if (lastClientTs === undefined) continue
      computed[id] = lastClientTs
    } catch {}
  }
  return computed
}

const buildClearanceLatestClientTsMap = (node: Record<string, any>) => {
  const computed: Record<string, number> = {}
  for (const [applicantUid, applications] of Object.entries(node)) {
    if (!applications || typeof applications !== "object") {
      continue
    }

    for (const [applicationId, payload] of Object.entries(applications as Record<string, any>)) {
      try {
        const lastClientTs = getLatestClientMessageTimestamp(payload)
        if (lastClientTs === undefined) continue
        const threadId = buildClearanceMessengerThreadId(applicantUid, applicationId)
        computed[threadId] = lastClientTs
      } catch {}
    }
  }
  return computed
}

const isWithinRecentNotificationWindow = (timestamp: number) => {
  if (!Number.isFinite(timestamp)) {
    return false
  }

  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)

  const startOfWindow = startOfToday.getTime() - (RECENT_NOTIFICATION_DAYS - 1) * MS_IN_DAY
  const endOfWindow = startOfToday.getTime() + MS_IN_DAY

  return timestamp >= startOfWindow && timestamp < endOfWindow
}

type NotificationEvent = {
  id: string
  clientId?: string
  entityName: string
  action: string
  type?: string
  category?: string
  timestamp: number
  href: string
}

type NotificationGroup = {
  key: string
  label: string
  items: NotificationEvent[]
}

type ClearanceStatusFilter = "All" | "Approved" | "Pending" | "Rejected"

const buildNotificationEvents = (records: BusinessApplicationRecord[]): NotificationEvent[] => {
  const events: NotificationEvent[] = []

  records.forEach((record) => {
    const targetName = record.applicantName || record.businessName || "Unnamed Applicant"

    const submittedAt = record.submittedAt ?? parseDateToTimestamp(record.applicationDate)

    const allRequirementUploads: number[] = []
    const recentRequirementUploads: number[] = []
    const hasUpdatedStatus = record.requirements.some((requirement) =>
      requirement.files.some((file) => (file.status ?? "").toLowerCase() === "updated")
    )

    record.requirements.forEach((requirement) => {
      requirement.files.forEach((file) => {
        const statusLower = (file.status ?? "").toLowerCase()
        let ts = typeof file.uploadedAt === "number" ? file.uploadedAt : undefined
        if (!ts && statusLower === "updated") {
          ts = Date.now()
        }
        if (!ts) {
          return
        }

        allRequirementUploads.push(ts)
        if (isWithinRecentNotificationWindow(ts)) {
          recentRequirementUploads.push(ts)
        }
      })
    })

    // Removed: automatic "business application form" notifications.
    // These previously used the `submittedAt` timestamp which for date-only
    // application dates could display as 8:00 AM due to timezone offsets.
    // Keep only requirement upload / update events to avoid misleading times.

    if (recentRequirementUploads.length > 0) {
      const latestRequirementUpload = Math.max(...recentRequirementUploads)
      const hadEarlierUploads = allRequirementUploads.some(
        (timestamp) => timestamp <= latestRequirementUpload - REQUIREMENT_UPDATE_THRESHOLD_MS
      )
      const isUpdateEvent = hasUpdatedStatus || hadEarlierUploads

      const notificationId =
        buildRequirementNotificationId(record) ?? `requirements-${record.id}-${latestRequirementUpload}`

      events.push({
        id: notificationId,
        clientId: record.id,
        entityName: targetName,
        action: isUpdateEvent
          ? "updated the requirements for their"
          : "just submitted the requirements for their",
        type: record.applicationType,
        category: "application",
        timestamp: latestRequirementUpload,
        href: `/client/${record.id}?from=notification`,
      })
    }
  })

  return events.sort((a, b) => b.timestamp - a.timestamp)
}

const getDateKey = (date: Date) => {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

const getDateKeyFromTimestamp = (timestamp: number) => {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) {
    return ""
  }
  return getDateKey(date)
}

const formatDateLabelFromKey = (key: string) => {
  const [year, month, day] = key.split("-").map((value) => Number.parseInt(value, 10))
  if (!year || !month || !day) {
    return key
  }
  const date = new Date(year, month - 1, day)
  return date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
}

const getClearanceFileYear = (file: ClearanceFileWithId): number | null => {
  const nameYear = (file.fileName || "").match(/\b(20\d{2})\b/)
  if (nameYear) {
    return Number(nameYear[1])
  }

  const raw = (file as { createdAt?: unknown }).createdAt
  let timestamp: number | null = null

  if (typeof raw === "number" && Number.isFinite(raw)) {
    timestamp = raw < 1_000_000_000_000 ? raw * 1000 : raw
  } else if (typeof raw === "string") {
    const numeric = Number(raw)
    if (Number.isFinite(numeric)) {
      timestamp = numeric < 1_000_000_000_000 ? numeric * 1000 : numeric
    } else {
      const parsed = Date.parse(raw)
      if (!Number.isNaN(parsed)) {
        timestamp = parsed
      }
    }
  }

  if (timestamp !== null) {
    const createdYear = new Date(timestamp).getFullYear()
    if (!Number.isNaN(createdYear)) {
      return createdYear
    }
  }

  return null
}

const getYearFromDateValue = (value: unknown): number | null => {
  if (value instanceof Date) {
    const year = value.getFullYear()
    return Number.isNaN(year) ? null : year
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    const timestamp = value < 1_000_000_000_000 ? value * 1000 : value
    const year = new Date(timestamp).getFullYear()
    return Number.isNaN(year) ? null : year
  }

  if (typeof value === "string") {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) {
      const timestamp = numeric < 1_000_000_000_000 ? numeric * 1000 : numeric
      const year = new Date(timestamp).getFullYear()
      return Number.isNaN(year) ? null : year
    }
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) {
      const year = new Date(parsed).getFullYear()
      return Number.isNaN(year) ? null : year
    }
  }

  return null
}

const buildNotificationGroups = (events: NotificationEvent[]): NotificationGroup[] => {
  if (events.length === 0) {
    return []
  }

  const todayKey = getDateKey(new Date())
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  const yesterdayKey = getDateKey(yesterday)
  const allowedDateKeys = new Set([todayKey, yesterdayKey])

  const groups = new Map<string, NotificationEvent[]>()
  events.forEach((event) => {
    const key = getDateKeyFromTimestamp(event.timestamp)
    if (!key || !allowedDateKeys.has(key)) {
      return
    }
    const current = groups.get(key) ?? []
    current.push(event)
    groups.set(key, current)
  })

  return Array.from(groups.keys())
    .sort((a, b) => (a > b ? -1 : 1))
    .slice(0, 2)
    .map((key) => {
      const items = (groups.get(key) ?? []).sort((a, b) => b.timestamp - a.timestamp).slice(0, MAX_NOTIFICATIONS_PER_GROUP)
      const baseLabel = formatDateLabelFromKey(key)
      const label =
        key === todayKey
          ? `Today - ${baseLabel}`
          : key === yesterdayKey
            ? `Yesterday - ${baseLabel}`
            : baseLabel
      return { key, label, items }
    })
}

type SortType = "default" | "firstComeFirstServe"
type TypeFilterType = "All" | "Approved" | "Pending"
type PageType = "login" | "home" | "clients" | "clearance-applications" | "clearance-clients" | "lgu-status"

const allowedPages: PageType[] = ["login", "home", "clients", "clearance-applications", "clearance-clients", "lgu-status"]
const publicPages: PageType[] = ["login"]

const isPublicPage = (page: PageType) => publicPages.includes(page)

type AuthenticatedNavItem = {
  id: PageType | string
  label: string
  icon: typeof LayoutDashboard
  href?: string
}

const authenticatedNavItems: AuthenticatedNavItem[] = [
  { id: "home", label: "Home", icon: LayoutDashboard },
  { id: "clients", label: "Business Application", icon: FileText },
  { id: "clearance-applications", label: "Mayor's Clearance Application", icon: ClipboardList },
  { id: "clearance-clients", label: "Mayor's Clearance", icon: Award },
  { id: "lgu-status", label: "LGU Status", icon: CalendarDays, href: "/lgu-status" },
]



const getStoredEmail = () => {
  if (typeof window === "undefined") {
    return null
  }
  try {
    return localStorage.getItem("bossStaffEmail")
  } catch {
    return null
  }
}

async function hashPassword(value: string) {
  if (typeof window !== "undefined" && window.crypto?.subtle) {
    const encoder = new TextEncoder()
    const data = encoder.encode(value)
    const hashBuffer = await window.crypto.subtle.digest("SHA-256", data)
    const hashArray = Array.from(new Uint8Array(hashBuffer))
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("")
  }

  const { createHash } = await import("crypto")
  return createHash("sha256").update(value).digest("hex")
}

const firebaseAuth = getAuth(firebaseApp)

export default function HomePage() {
  // Sworn docx preview modal state for main table
  const [isSwornDocxPreviewOpen, setIsSwornDocxPreviewOpen] = useState(false);
  const [swornDocxPreviewHtml, setSwornDocxPreviewHtml] = useState<string | null>(null);
  const [swornDocxPreviewPdfUrl, setSwornDocxPreviewPdfUrl] = useState<string | null>(null);
  const [swornDocxPreviewLoading, setSwornDocxPreviewLoading] = useState(false);
  const [swornDocxPreviewTitle, setSwornDocxPreviewTitle] = useState("Sworn Statement Preview");
  const [swornDocxPreviewError, setSwornDocxPreviewError] = useState<string | null>(null);

  const handleSwornDocxPreview = async (clientId: string, event?: React.MouseEvent) => {
    event?.stopPropagation();
    const clientRecord = clients.find((client) => client.id === clientId);
    const isNew = (clientRecord?.applicationType || "").toLowerCase() === "new";
    const titleParts = [clientRecord?.applicantName, clientRecord?.businessName].filter(Boolean);
    setSwornDocxPreviewTitle(titleParts.length > 0 ? `${titleParts.join(" - ")} ${isNew ? "Sworn Statement of Capital" : "Sworn Declaration of Gross Receipts"}` : "Sworn Statement Preview");
    setSwornDocxPreviewHtml(null);
    setSwornDocxPreviewError(null);
    setIsSwornDocxPreviewOpen(true);
    setSwornDocxPreviewLoading(true);
    try {
      const currentUser = firebaseAuth.currentUser;
      if (!currentUser) {
        setSwornDocxPreviewError("You must be logged in to preview documents.");
        setSwornDocxPreviewLoading(false);
        return;
      }
      const idToken = await currentUser.getIdToken();
      const response = await fetch("/api/export/docx-to-pdf", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({ applicationId: clientId, swornOnly: true }),
      });
      if (!response.ok) {
        setSwornDocxPreviewError("Unable to generate the sworn document. Please try again.");
        setSwornDocxPreviewLoading(false);
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      setSwornDocxPreviewPdfUrl(url);
      setSwornDocxPreviewHtml(null);
    } catch (error) {
      console.error("Sworn preview error:", error);
      setSwornDocxPreviewError("Unable to preview this document. Please try downloading instead.");
    } finally {
      setSwornDocxPreviewLoading(false);
    }
  };

  const handleCloseSwornDocxPreview = () => {
    setIsSwornDocxPreviewOpen(false);
    if (swornDocxPreviewPdfUrl) {
      try { URL.revokeObjectURL(swornDocxPreviewPdfUrl) } catch {}
    }
    setSwornDocxPreviewHtml(null);
    setSwornDocxPreviewPdfUrl(null);
    setSwornDocxPreviewError(null);
    setSwornDocxPreviewLoading(false);
  };
  const router = useRouter()
  const [isMessengerOpen, setIsMessengerOpen] = useState(false)
  const [hasUnreadMessages, setHasUnreadMessages] = useState(false)
  // Prefer rendering immediately; hydrate-only logic stays inside effects to avoid flicker between pages
  const [showPassword, setShowPassword] = useState(false)
  const [loggedInEmail, setLoggedInEmail] = useState<string | null>(null)
  const [isLoggedIn, setIsLoggedIn] = useState(false)
  const [isAuthChecking, setIsAuthChecking] = useState(true)
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [loginError, setLoginError] = useState("")
  const [loginVerificationStatus, setLoginVerificationStatus] = useState<"unverified" | null>(null)
  const [isAuthLoading, setIsAuthLoading] = useState(false)
  const [typeFilter, setTypeFilter] = useState<TypeFilterType>("All")
  const [searchQuery, setSearchQuery] = useState("")
  const [currentPage, setCurrentPage] = useState<PageType>("login")
  const [sortBy, setSortBy] = useState<SortType>("firstComeFirstServe")
  const [applicationDateFilter, setApplicationDateFilter] = useState<Date | undefined>(undefined)
  const [clients, setClients] = useState<BusinessApplicationRecord[]>([])
  const [clientsLoading, setClientsLoading] = useState(false)
  const [clientsError, setClientsError] = useState<string | null>(null)
  const [clearanceApplicants, setClearanceApplicants] = useState<ClearanceApplicationRecord[]>([])
  const [clearanceApplicantsLoading, setClearanceApplicantsLoading] = useState(false)
  const [clearanceApplicantsError, setClearanceApplicantsError] = useState<string | null>(null)
  const [clearanceApplicantsSearch, setClearanceApplicantsSearch] = useState("")
  const [clearanceApplicantsStatus, setClearanceApplicantsStatus] = useState<ClearanceStatusFilter>("All")
  const [clearanceApplicationDateFilter, setClearanceApplicationDateFilter] = useState<Date | undefined>(undefined)
  const [clearanceRecordRange, setClearanceRecordRange] = useState<"monthly" | "yearly">("yearly")
  const [clearanceRecordMonth, setClearanceRecordMonth] = useState<number | null>(null)
  const [clearanceRecordYear, setClearanceRecordYear] = useState<number | null>(null)
  const [clearanceRecordSearch, setClearanceRecordSearch] = useState("")
  const [clearanceFiles, setClearanceFiles] = useState<ClearanceFileWithId[]>([])
  const [clearanceFilesLoading, setClearanceFilesLoading] = useState(true)
  const [isClearanceGenerating, setIsClearanceGenerating] = useState(false)
  const [clearanceAutoAttempted, setClearanceAutoAttempted] = useState(false)
  const [isDocxPreviewOpen, setIsDocxPreviewOpen] = useState(false)
  const [docxPreviewHtml, setDocxPreviewHtml] = useState<string | null>(null)
  const [docxPreviewPdfUrl, setDocxPreviewPdfUrl] = useState<string | null>(null)
  const [docxPreviewMergedPdfUrl, setDocxPreviewMergedPdfUrl] = useState<string | null>(null)
  const [docxPreviewTempUrls, setDocxPreviewTempUrls] = useState<string[]>([])
  const [docxPreviewSwornHtml, setDocxPreviewSwornHtml] = useState<string | null>(null)
  const [docxPreviewSwornPdfUrl, setDocxPreviewSwornPdfUrl] = useState<string | null>(null)
  const [docxPreviewLoading, setDocxPreviewLoading] = useState(false)
  const [docxPreviewTitle, setDocxPreviewTitle] = useState("Application Form Preview")
  const [docxPreviewError, setDocxPreviewError] = useState<string | null>(null)
  const [barangayPreview, setBarangayPreview] = useState<{
    record: ClearanceApplicationRecord
    url: string
    requirementName: string
    fileId: string
  } | null>(null)
  const [isBarangayActionLoading, setIsBarangayActionLoading] = useState(false)
  const [showBarangayRejectModal, setShowBarangayRejectModal] = useState(false)
  const [barangayRejectReason, setBarangayRejectReason] = useState("")
  type BarangayDocumentItem = { requirement: BusinessRequirement; file: BusinessRequirementFile }
  const [barangayDocuments, setBarangayDocuments] = useState<BarangayDocumentItem[]>([])
  const [barangaySelectedDocIndex, setBarangaySelectedDocIndex] = useState<number>(-1)
  const [barangayImageLoading, setBarangayImageLoading] = useState(false)
  const [barangayLoadingFiles, setBarangayLoadingFiles] = useState<Set<string>>(new Set())
  const docxPreviewCancelRef = useRef(false)
  const docxPreviewAbortRef = useRef<AbortController | null>(null)
  const [docxPreviewClientId, setDocxPreviewClientId] = useState<string | null>(null)
  const previousRequirementFilesRef = useRef<
    Map<string, { fileName: string; fileSize: number; fileHash: string; status: string }>
  >(new Map())

  type DocxPreviewCacheEntry = {
    signature: string | null
    pdfUrl: string | null
    mergedUrl: string | null
    tempUrls: string[]
  }

  const docxPreviewCacheRef = useRef<Map<string, DocxPreviewCacheEntry>>(new Map())

  const isAbortError = (err: unknown) => {
    const name = (err as any)?.name
    return name === "AbortError"
  }

  const revokeUrlSafe = (url: string | null | undefined) => {
    if (!url) return
    try { URL.revokeObjectURL(url) } catch {}
  }

  const buildDocxPreviewSignature = (record?: BusinessApplicationRecord | null) => {
    if (!record) return null
    try {
      const requirements = (record.requirements || []).map((req) => ({
        id: req.id,
        name: req.name,
        files: (req.files || []).map((f) => ({
          id: f.id,
          status: f.status ?? null,
          uploadedAt: f.uploadedAt ?? null,
          fileHash: f.fileHash ?? null,
          fileSize: f.fileSize ?? null,
          downloadUrl: f.downloadUrl ?? null,
        })),
      }))

      return JSON.stringify({
        id: record.id,
        status: record.status ?? null,
        overallStatus: record.overallStatus ?? null,
        applicationDate: record.applicationDate ?? null,
        updatedAt: (record as any)?.updatedAt ?? null,
        requirements,
      })
    } catch {
      return String(record.id || "")
    }
  }

  const cacheDocxPreview = (clientId: string, signature: string | null, entry: Partial<DocxPreviewCacheEntry>) => {
    const existing = docxPreviewCacheRef.current.get(clientId)
    if (existing && existing.signature !== signature) {
      revokeUrlSafe(existing.pdfUrl)
      revokeUrlSafe(existing.mergedUrl)
      existing.tempUrls?.forEach((u) => revokeUrlSafe(u))
    }

    const next: DocxPreviewCacheEntry = {
      signature,
      pdfUrl: entry.pdfUrl ?? existing?.pdfUrl ?? null,
      mergedUrl: entry.mergedUrl ?? existing?.mergedUrl ?? null,
      tempUrls: entry.tempUrls ?? existing?.tempUrls ?? [],
    }

    docxPreviewCacheRef.current.set(clientId, next)
  }

  const getDocxPreviewCache = (clientId: string, signature: string | null) => {
    const cached = docxPreviewCacheRef.current.get(clientId)
    if (cached && cached.signature === signature) {
      return cached
    }
    return null
  }

  const [latestClientTsMap, setLatestClientTsMap] = useState<Record<string, number>>({})
  const [messengerLastReadMap, setMessengerLastReadMap] = useState<Record<string, number>>({})
  const [isMessengerLastReadLoaded, setIsMessengerLastReadLoaded] = useState(false)
  const [readNotifications, setReadNotifications] = useState<Set<string>>(new Set())
  const [isReadNotificationsLoaded, setIsReadNotificationsLoaded] = useState(false)
  const [clearedRequirementClientIds, setClearedRequirementClientIds] = useState<Set<string>>(new Set())
  const generateAndSaveClearanceFileRef = useRef<((targetYear?: number) => Promise<{ fileName: string; base64: string } | null>) | null>(null)
  const notificationEvents = useMemo(() => buildNotificationEvents(clients), [clients])
  const notificationGroups = useMemo(() => buildNotificationGroups(notificationEvents), [notificationEvents])
  const hasNotifications = notificationGroups.length > 0
  const unreadNotifications = useMemo(
    () => notificationEvents.filter((event) => !readNotifications.has(event.id)),
    [notificationEvents, readNotifications]
  )
  const hasClientUpdate = useMemo(
    () =>
      unreadNotifications.some((event) =>
        ["application"].includes((event.category || "").toLowerCase())
      ),
    [unreadNotifications]
  )

  const unreadClientIds = useMemo(() => {
    const ids = new Set<string>()
    unreadNotifications.forEach((event) => {
      const clientId = event.clientId
      if (clientId) ids.add(clientId)
    })
    // remove clients whose requirements were explicitly cleared by staff
    clearedRequirementClientIds.forEach((c) => ids.delete(c))
    return ids
  }, [unreadNotifications, clearedRequirementClientIds])

  const approvedClients = useMemo(
    () =>
      clients.filter((client) => {
        const normalized = (client.overallStatus || client.status || "").toLowerCase()
        return (
          normalized.includes("approve") ||
          normalized.includes("complete") ||
          normalized.includes("process")
        )
      }),
    [clients]
  )

  const approvedClearanceApplicants = useMemo(() => {
    return clearanceApplicants.filter((record) => {
      const normalized = (record.overallStatus || record.status || "").toLowerCase()
      return normalized.includes("approve") || normalized.includes("complete") || normalized.includes("process")
    })
  }, [clearanceApplicants])

  const clearanceRecords = useMemo(() => {
    const fromClearance = approvedClearanceApplicants.map((record) => {
      const form = record.form || {}
      const nameParts = getClearanceNameParts(form)
      const composedName = [nameParts.firstName, nameParts.middleName, nameParts.lastName].filter(Boolean).join(" ")
      const phone =
        (form.phone ?? form.mobile ?? form.contactNumber ?? form.phoneNumber ?? "").toString().trim()
      return {
        id: `clearance-${record.id}`,
        fullName: composedName || record.applicantName || "",
        address: formatClearanceAddress(form),
        phone,
        date: record.applicationDate ?? record.submittedAt ?? null,
      }
    })

    const fromBusiness = approvedClients.map((client) => {
      const form = client.form || {}
      const nameParts = getClearanceNameParts(form)
      const composedName = [nameParts.firstName, nameParts.middleName, nameParts.lastName].filter(Boolean).join(" ")
      const phone =
        (form.businessMobile ?? form.ownerMobile ?? form.mobile ?? form.phone ?? "").toString().trim()
      return {
        id: `business-${client.id}`,
        fullName: composedName || client.applicantName || "",
        address: formatClearanceAddress(form),
        phone,
        date:
          form.dateOfApplication ??
          form.registrationDate ??
          client.applicationDate ??
          client.approvedAt ??
          client.submittedAt ??
          null,
      }
    })

    return [...fromClearance, ...fromBusiness]
  }, [approvedClearanceApplicants, approvedClients])

  const clearanceRecordYears = useMemo(() => {
    const years = new Set<number>()
    clearanceRecords.forEach((record) => {
      if (!record.date) return
      const date = new Date(record.date as string)
      if (Number.isNaN(date.getTime())) return
      years.add(date.getFullYear())
    })
    return Array.from(years).sort((a, b) => b - a)
  }, [clearanceRecords])

  useEffect(() => {
    if (clearanceRecordYears.length === 0) {
      if (clearanceRecordYear !== null) setClearanceRecordYear(null)
      return
    }
    if (!clearanceRecordYear || !clearanceRecordYears.includes(clearanceRecordYear)) {
      setClearanceRecordYear(clearanceRecordYears[0])
    }
  }, [clearanceRecordYears, clearanceRecordYear])

  useEffect(() => {
    if (clearanceRecordRange === "monthly" && clearanceRecordMonth === null) {
      setClearanceRecordMonth(new Date().getMonth())
    }
  }, [clearanceRecordRange, clearanceRecordMonth])

  const filteredClearanceRecords = useMemo(() => {
    const normalizedSearch = clearanceRecordSearch.trim().toLowerCase()

    return clearanceRecords.filter((record) => {
      if (!record.date) return false
      const date = new Date(record.date as string)
      if (Number.isNaN(date.getTime())) return false

      const matchesYear = !clearanceRecordYear || date.getFullYear() === clearanceRecordYear
      const matchesMonth =
        clearanceRecordRange !== "monthly" ||
        clearanceRecordMonth === null ||
        date.getMonth() === clearanceRecordMonth

      let matchesSearch = true
      if (normalizedSearch) {
        const haystack = [record.fullName, record.address, record.phone]
          .filter(Boolean)
          .map((value) => value.toLowerCase())
        matchesSearch = haystack.some((value) => value.includes(normalizedSearch))
      }

      return matchesYear && matchesMonth && matchesSearch
    })
  }, [
    clearanceRecords,
    clearanceRecordYear,
    clearanceRecordRange,
    clearanceRecordMonth,
    clearanceRecordSearch,
  ])

  const clearanceRecordsLoading = clientsLoading || clearanceApplicantsLoading

  const selectedClearanceFile = useMemo(() => {
    if (!clearanceRecordYear) return null
    const byYear = clearanceFiles.filter((file) => {
      const fileYear = getClearanceFileYear(file)
      return fileYear === clearanceRecordYear
    })
    if (byYear.length === 0) return null
    return byYear.sort((a, b) => b.createdAt - a.createdAt)[0]
  }, [clearanceFiles, clearanceRecordYear])

  const handleDownloadSavedClearance = async () => {
    if (!clearanceRecordYear) {
      toast.error("Select a year to download the clearance file.")
      return
    }

    if (clearanceFilesLoading) {
      toast.error("Clearance files are still loading. Please try again.")
      return
    }

    try {
      if (!selectedClearanceFile) {
        const generated = await generateAndSaveClearanceFileRef.current?.(clearanceRecordYear)
        if (!generated) {
          toast.error(`No saved clearance file found for ${clearanceRecordYear}.`)
          return
        }
        const blob = base64ToBlob(generated.base64)
        const url = URL.createObjectURL(blob)
        const a = document.createElement("a")
        a.href = url
        a.download = generated.fileName
        document.body.appendChild(a)
        a.click()
        a.remove()
        URL.revokeObjectURL(url)
        return
      }

      const blob = base64ToBlob(selectedClearanceFile.dataBase64)
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `Mayor's Clearance ${clearanceRecordYear}.xlsx`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (err) {
      console.error("Failed to download saved clearance file", err)
      toast.error("Unable to download that file.")
    }
  }

  const resolveBusinessMatchForClearance = (record: ClearanceApplicationRecord): BusinessApplicationRecord | null => {
    const uid = record.applicantUid
    if (uid) {
      const byUid = clients.find((c) => (c as any)?.applicantUid === uid || (c.form as any)?.applicantUid === uid)
      if (byUid) return byUid
    }

    const normalizedName = (record.applicantName || "").toLowerCase()
    if (normalizedName) {
      const byName = clients.find((c) => (c.applicantName || "").toLowerCase() === normalizedName)
      if (byName) return byName
    }

    return null
  }

  const buildBarangayDocuments = (
    record: ClearanceApplicationRecord,
    overrideRequirements?: BusinessRequirement[] | null
  ) => {
    const requirementsSource = Array.isArray(overrideRequirements)
      ? overrideRequirements
      : Array.isArray(record.requirements)
        ? record.requirements
        : []

    if (requirementsSource.length === 0) return null

    const barangayReq = requirementsSource.find((req) => req.name.toLowerCase().includes("barangay"))
    const targetReq = barangayReq ?? requirementsSource.find((req) => (req.files || []).length > 0)
    if (!targetReq) return null

    const files = Array.isArray(targetReq.files) ? [...targetReq.files] : []
    if (files.length === 0) return null

    const docs: BarangayDocumentItem[] = files.map((file) => ({ requirement: targetReq, file }))
    return { requirement: targetReq, documents: docs }
  }

  const barangayActiveDocument = useMemo(() => {
    if (barangaySelectedDocIndex < 0 || barangaySelectedDocIndex >= barangayDocuments.length) return null
    return barangayDocuments[barangaySelectedDocIndex]
  }, [barangayDocuments, barangaySelectedDocIndex])

  const handleBarangayImageLoaded = (fileId: string) => {
    setBarangayLoadingFiles((prev) => {
      const next = new Set(prev)
      next.delete(fileId)
      if (next.size === 0) {
        setBarangayImageLoading(false)
      }
      return next
    })
  }

  const goToPrevBarangayDoc = (e?: React.MouseEvent) => {
    e?.stopPropagation()
    if (barangayDocuments.length === 0) return
    setBarangayImageLoading(true)
    const prevIndex = barangaySelectedDocIndex <= 0 ? barangayDocuments.length - 1 : barangaySelectedDocIndex - 1
    setBarangaySelectedDocIndex(prevIndex)
  }

  const goToNextBarangayDoc = (e?: React.MouseEvent) => {
    e?.stopPropagation()
    if (barangayDocuments.length === 0) return
    setBarangayImageLoading(true)
    const nextIndex = barangaySelectedDocIndex >= barangayDocuments.length - 1 ? 0 : barangaySelectedDocIndex + 1
    setBarangaySelectedDocIndex(nextIndex)
  }

  const handleOpenBarangayClearance = (record: ClearanceApplicationRecord) => {
    const normalizedPurpose = (record.purpose || "").toLowerCase()
    const isBusinessPurpose = normalizedPurpose.includes("business")

    const businessMatch = isBusinessPurpose ? resolveBusinessMatchForClearance(record) : null
    const built = buildBarangayDocuments(record, businessMatch?.requirements)
    if (!built) {
      toast.error("No Barangay Clearance file available for this application.")
      return
    }

    setBarangayPreview({
      record,
      url: built.documents[0].file.downloadUrl ?? "",
      requirementName: built.requirement.name,
      fileId: built.documents[0].file.id,
    })
    setBarangayDocuments(built.documents)
    setBarangaySelectedDocIndex(0)
    setBarangayImageLoading(true)
    setBarangayLoadingFiles(new Set(built.documents.map((doc) => doc.file.id)))
  }

  const handleBarangayApprove = async () => {
    if (!barangayPreview) return
    const { record, requirementName } = barangayPreview
    const activeDoc = barangayActiveDocument
    const fileId = activeDoc?.file.id
    if (!record.applicantUid) {
      toast.error("Missing applicant information for this application.")
      return
    }
    if (!fileId) {
      toast.error("No file selected.")
      return
    }

    setIsBarangayActionLoading(true)
    try {
      const fileRef = ref(
        realtimeDb,
        `${MAYORS_CLEARANCE_APPLICATION_PATH}/${record.applicantUid}/${record.id}/requirements/${requirementName}/files/${fileId}`
      )

      await update(fileRef, { status: "approved", adminNote: "" })
      toast.success("Barangay clearance approved.")
      setBarangayPreview(null)
      setBarangaySelectedDocIndex(-1)
      setBarangayDocuments([])
    } catch (err) {
      console.error("Failed to update barangay clearance status", err)
      toast.error("Unable to mark as approved.")
    } finally {
      setIsBarangayActionLoading(false)
    }
  }

  const handleBarangayRejectConfirm = async () => {
    if (!barangayPreview) return
    const { record, requirementName } = barangayPreview
    const activeDoc = barangayActiveDocument
    const fileId = activeDoc?.file.id
    if (!record.applicantUid) {
      toast.error("Missing applicant information for this application.")
      return
    }
    if (!fileId) {
      toast.error("No file selected.")
      return
    }
    if (!barangayRejectReason.trim()) {
      toast.error("Please enter a rejection reason.")
      return
    }

    setIsBarangayActionLoading(true)
    try {
      const fileRef = ref(
        realtimeDb,
        `${MAYORS_CLEARANCE_APPLICATION_PATH}/${record.applicantUid}/${record.id}/requirements/${requirementName}/files/${fileId}`
      )

      await update(fileRef, { status: "rejected", adminNote: barangayRejectReason.trim() })
      toast.success("Barangay clearance rejected.")
      setShowBarangayRejectModal(false)
      setBarangayRejectReason("")
      setBarangayPreview(null)
      setBarangaySelectedDocIndex(-1)
      setBarangayDocuments([])
    } catch (err) {
      console.error("Failed to update barangay clearance status", err)
      toast.error("Unable to mark as rejected.")
    } finally {
      setIsBarangayActionLoading(false)
    }
  }

  const approvedBusinessClearanceCandidates = useMemo<ClearanceApplicationRecord[]>(() => {
    return clients
      .filter((client) => {
        const normalized = (client.overallStatus || client.status || "").toLowerCase()
        return (
          normalized.includes("approve") ||
          normalized.includes("complete") ||
          normalized.includes("process")
        )
      })
      .map((client) => ({
        id: `business-${client.id}`,
        applicantName: client.applicantName || client.businessName || "Unnamed Applicant",
        applicationDate: client.applicationDate ?? client.approvedAt ?? client.submittedAt,
        purpose: "Business",
        status: "Approved",
        overallStatus: "Approved",
        submittedAt: client.approvedAt ?? client.submittedAt,
        requirements: [],
        form: client.form,
      }))
  }, [clients])

  const handleNotificationNavigate = useCallback(
    (item: NotificationEvent) => {
      setReadNotifications((previous) => {
        const next = new Set(previous)
        next.add(item.id)
        return next
      })
      router.push(item.href)
    },
    [router]
  )

  const handlePageChange = useCallback(
    async (nextPage: PageType) => {
      setCurrentPage(nextPage)
      const targetPath = nextPage === "home" || nextPage === "login" ? "/" : `/?page=${nextPage}`
      await router.replace(targetPath)

      // If navigating to pages that display the Messages button, ensure
      // we have the latest client message timestamps so the unread dot
      // reflects messages that arrived while this page was unmounted.
      if (["home", "clients", "clearance-clients"].includes(nextPage)) {
        try {
          await refreshLatestClientTs()
        } catch {}
      }
    },
    [router]
  )

  // Fetch a one-time snapshot of latest client message timestamps.
  // This complements the realtime `onValue` listener and ensures that
  // when the user navigates back to a UI page the latest timestamps
  // (including messages received while this component was unmounted)
  // are applied immediately.
  const refreshLatestClientTs = useCallback(async () => {
    try {
      const [businessSnap, clearanceSnap] = await Promise.all([
        get(ref(realtimeDb, BUSINESS_APPLICATION_PATH)),
        get(ref(realtimeDb, MAYORS_CLEARANCE_APPLICATION_PATH)),
      ])

      const businessNode = businessSnap.exists() ? (businessSnap.val() as Record<string, any>) : {}
      const clearanceNode = clearanceSnap.exists() ? (clearanceSnap.val() as Record<string, any>) : {}

      const nextMap: Record<string, number> = {
        ...buildBusinessLatestClientTsMap(businessNode),
        ...buildClearanceLatestClientTsMap(clearanceNode),
      }

      setLatestClientTsMap(nextMap)
    } catch (err) {
      // non-fatal
    }
  }, [])

  const hasFetchedInitialLatestClientTs = useRef(false)

  const handleOpenMessenger = useCallback(() => {
    setIsMessengerOpen(true)
  }, [])

  const handleMarkConversationRead = useCallback(
    (appId: string, lastClientTs?: number) => {
      setMessengerLastReadMap((previous) => {
        const next = { ...previous, [appId]: lastClientTs ?? Date.now() }
        try {
          if (typeof window !== "undefined") {
            localStorage.setItem("bossMessengerLastRead", JSON.stringify(next))
          }
        } catch {}
        return next
      })
    },
    []
  )

  const renderNotificationsList = useCallback(
    (onItemClick?: (item: NotificationEvent) => void) => (
      <div className="space-y-6">
        {clientsError && (
          <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {clientsError}
          </div>
        )}

        {clientsLoading && (
          <div className="flex items-center gap-3 text-sm text-muted-foreground px-2 py-1.5">
            <div className="h-4 w-4 rounded-full border-2 border-primary border-t-transparent animate-spin" aria-hidden />
            <span>Loading the latest updates...</span>
          </div>
        )}

        {!clientsLoading && !hasNotifications && !clientsError && (
          <div className="rounded-md border border-dashed border-muted-foreground/40 px-4 py-6 text-center text-sm text-muted-foreground">
            No notifications from today or yesterday. Stay tuned for new activity.
          </div>
        )}

        {notificationGroups.map((group) => (
          <div key={group.key}>
            <h3 className="text-sm font-medium text-primary mb-3">{group.label}</h3>
            <div className="space-y-2 pl-4 border-l-2 border-primary/30">
              {group.items.map((item) => {
                const isRead = readNotifications.has(item.id)
                const timestampLabel = (() => {
                  const date = new Date(item.timestamp)
                  if (Number.isNaN(date.getTime())) {
                    return ""
                  }
                  return date.toLocaleTimeString(undefined, {
                    hour: "numeric",
                    minute: "numeric",
                  })
                })()

                const clickHandler = () =>
                  onItemClick ? onItemClick(item) : handleNotificationNavigate(item)

                return (
                  <div
                    key={item.id}
                    onClick={clickHandler}
                    className={`flex items-start gap-2 text-sm cursor-pointer rounded-md px-2 py-1.5 -ml-2 transition-colors hover:bg-muted/50 ${
                      isRead ? "text-muted-foreground" : "text-foreground"
                    }`}
                  >
                    {isRead ? (
                      <Check className="h-4 w-4 text-green-500 mt-0.5 flex-shrink-0" />
                    ) : (
                      <span className="mt-1 h-2.5 w-2.5 flex-shrink-0 rounded-full bg-red-500" aria-hidden />
                    )}
                    {/* Notification actions removed: Print, Sworn Docx, Download (not applicable here) */}
                    <div className="flex flex-col">
                      <span>
                        <b>{item.entityName}</b> {item.action} {item.type && <b>{item.type}</b>}{" "}
                        {item.category && <> {item.category}</>}
                      </span>
                      {timestampLabel && (
                        <span className="text-xs text-muted-foreground mt-0.5">{timestampLabel}</span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    ),
    [
      clientsError,
      clientsLoading,
      hasNotifications,
      notificationGroups,
      readNotifications,
      handleNotificationNavigate,
    ]
  )

  // Initialize auth state and read notifications after mount to prevent hydration mismatch
  useEffect(() => {
    if (typeof window === "undefined") {
      return
    }

    try {
      const stored = localStorage.getItem("bossReadNotifications")
      if (stored) {
        const parsed = JSON.parse(stored)
        setReadNotifications(new Set(parsed))
      }
      const cleared = localStorage.getItem("bossClearedRequirements")
      if (cleared) {
        try {
          setClearedRequirementClientIds(new Set(JSON.parse(cleared)))
        } catch {}
      }
    } catch {}
    setIsReadNotificationsLoaded(true)
  }, [])

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(firebaseAuth, (user) => {
      if (user) {
        setIsLoggedIn(true)
        setLoggedInEmail(user.email ?? null)
        if (typeof window !== "undefined" && user.email) {
          localStorage.setItem("bossStaffEmail", user.email.toLowerCase())
        }
        setCurrentPage((prev) => (prev === "login" ? "home" : prev))
      } else {
        setIsLoggedIn(false)
        setLoggedInEmail(null)
        if (typeof window !== "undefined") {
          localStorage.removeItem("bossStaffEmail")
        }
        setCurrentPage("login")
      }
      setIsAuthChecking(false)
    })

    return () => unsubscribe()
  }, [])

  // Persist read notifications to localStorage
  useEffect(() => {
    if (typeof window === "undefined") {
      return
    }
    // Only persist after initial load to avoid overwriting stored data
    if (!isReadNotificationsLoaded) {
      return
    }
    try {
      localStorage.setItem("bossReadNotifications", JSON.stringify([...readNotifications]))
    } catch {}
  }, [readNotifications, isReadNotificationsLoaded])

  // Listen for external updates to bossReadNotifications (from client pages)
  useEffect(() => {
    const handler = () => {
      if (typeof window === "undefined") return
      try {
        const stored = localStorage.getItem("bossReadNotifications")
        if (!stored) return
        const parsed = JSON.parse(stored)
        setReadNotifications(new Set(parsed))
        const cleared = localStorage.getItem("bossClearedRequirements")
        if (cleared) {
          try {
            setClearedRequirementClientIds(new Set(JSON.parse(cleared)))
          } catch {}
        }
      } catch {}
    }

    window.addEventListener("bossReadNotifications:update", handler)
    window.addEventListener("storage", handler)
    return () => {
      window.removeEventListener("bossReadNotifications:update", handler)
      window.removeEventListener("storage", handler)
    }
  }, [])

  // If the root page is opened with a `?page=...` query param, use that
  // to initialize the UI view. This allows detail pages to navigate back to
  // a specific list view (for example `/?page=clients`).
  const searchParams = useSearchParams()
  useEffect(() => {
    const requested = searchParams?.get("page")
    if (!requested) {
      return
    }

    if (!allowedPages.includes(requested as PageType)) {
      return
    }

    const nextPage = requested as PageType
    if (!isLoggedIn && !isPublicPage(nextPage)) {
      return
    }

    setCurrentPage(nextPage)
  }, [searchParams, isLoggedIn])

  useEffect(() => {
    if (!isLoggedIn) {
      setClients([])
      setClientsError(null)
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

        const raw = snapshot.val() as Record<string, any>
        const parsed = Object.entries(raw).map(([id, payload]) => normalizeBusinessApplication(id, payload))

        // Realtime detection: if a previously rejected requirement file changes, mark it as updated and bump uploadedAt
        try {
          const prevMap = previousRequirementFilesRef.current
          const updates: Record<string, any> = {}
          let hasReplacement = false

          parsed.forEach((record) => {
            record.requirements.forEach((req) => {
              req.files.forEach((file) => {
                const key = `${record.id}::${req.name}::${file.id}`
                const prev = prevMap.get(key)
                const fileName = file.fileName ?? ""
                const fileSize = file.fileSize ?? 0
                const fileHash = file.fileHash ?? ""
                const normalizedStatus = (file.status ?? "").toLowerCase()

                if (
                  prev &&
                  prev.status === "rejected" &&
                  (normalizedStatus !== "rejected" || fileHash !== prev.fileHash || fileSize !== prev.fileSize || fileName !== prev.fileName)
                ) {
                  const basePath = `${BUSINESS_APPLICATION_PATH}/${record.id}/requirements/${req.name}/files/${file.id}`
                  updates[`${basePath}/status`] = "updated"
                  updates[`${basePath}/uploadedAt`] = Date.now()
                  updates[`${BUSINESS_APPLICATION_PATH}/${record.id}/status`] = "Pending Update Review"
                  hasReplacement = true
                }

                prevMap.set(key, { fileName, fileSize, fileHash, status: normalizedStatus })
              })
            })
          })

          if (hasReplacement) {
            update(ref(realtimeDb), updates).catch((err) => {
              console.error("Failed to auto-mark replaced requirement as updated (home)", err)
            })
          }
        } catch (autoErr) {
          console.error("Realtime replacement detection failed", autoErr)
        }

        // Exclude clients that have no uploaded requirement files
        const withUploadedRequirements = parsed.filter((rec) =>
          rec.requirements.some((req) => req.files.length > 0)
        )

        setClients(withUploadedRequirements)
        setClientsLoading(false)
      },
      (error) => {
        console.error("Failed to load business applications", error)
        setClientsError("Unable to load clients right now. Please try again later.")
        setClients([])
        setClientsLoading(false)
      }
    )

    return () => unsubscribe()
  }, [isLoggedIn])

  useEffect(() => {
    if (!isLoggedIn) {
      setClearanceApplicants([])
      setClearanceApplicantsError(null)
      setClearanceApplicantsLoading(false)
      return
    }

    setClearanceApplicantsLoading(true)
    setClearanceApplicantsError(null)

    const clearanceAppRef = ref(realtimeDb, MAYORS_CLEARANCE_APPLICATION_PATH)
    const unsub = onValue(
      clearanceAppRef,
      (snapshot) => {
        if (!snapshot.exists()) {
          setClearanceApplicants([])
          setClearanceApplicantsLoading(false)
          return
        }

        const node = snapshot.val() as Record<string, Record<string, any>>
        const rows: ClearanceApplicationRecord[] = []

        Object.entries(node).forEach(([applicantUid, applications]) => {
          if (!applications || typeof applications !== "object") {
            return
          }

          Object.entries(applications).forEach(([applicationId, payload]) => {
            if (!payload || typeof payload !== "object") {
              return
            }

            const normalizedPayload = {
              ...payload,
              meta: { applicantUid, ...(payload.meta ?? {}) },
            }

            rows.push(normalizeClearanceApplicant(applicationId, normalizedPayload))
          })
        })

        rows.sort((a, b) => (a.submittedAt ?? Number.MAX_SAFE_INTEGER) - (b.submittedAt ?? Number.MAX_SAFE_INTEGER))
        setClearanceApplicants(rows)
        setClearanceApplicantsLoading(false)
      },
      (error) => {
        console.error("Failed to load Mayor's Clearance applications", error)
        setClearanceApplicantsError("Unable to load Mayor's Clearance applications right now. Please try again later.")
        setClearanceApplicants([])
        setClearanceApplicantsLoading(false)
      }
    )

    return () => {
      try { unsub() } catch {}
    }
  }, [isLoggedIn])

  // Load messenger last-read map from localStorage on mount so unread
  // indicator can be computed even when not authenticated.
  useEffect(() => {
    try {
      const stored = typeof window !== 'undefined' ? localStorage.getItem('bossMessengerLastRead') : null
      const parsed = stored ? JSON.parse(stored || '{}') : {}
      if (parsed && typeof parsed === 'object') {
        setMessengerLastReadMap(parsed)
      }
    } catch {}
    setIsMessengerLastReadLoaded(true)
  }, [])

  // Ensure latest client message timestamps are loaded on initial home render
  useEffect(() => {
    if (!isLoggedIn) {
      hasFetchedInitialLatestClientTs.current = false
      return
    }
    if (hasFetchedInitialLatestClientTs.current) return
    hasFetchedInitialLatestClientTs.current = true
    ;(async () => {
      try {
        await refreshLatestClientTs()
      } catch {
        // allow a retry on next login state change
        hasFetchedInitialLatestClientTs.current = false
      }
    })()
  }, [isLoggedIn, refreshLatestClientTs])

  // Periodically refresh latest client message timestamps as a fallback
  // in case realtime listeners miss updates due to network/auth hiccups.
  useEffect(() => {
    if (!isLoggedIn) return
    const interval = setInterval(() => {
      refreshLatestClientTs().catch(() => {})
    }, 15000)
    return () => clearInterval(interval)
  }, [isLoggedIn, refreshLatestClientTs])

  // Load saved Mayor's Clearance files list
  useEffect(() => {
    if (!isLoggedIn) {
      setClearanceFiles([])
      setClearanceFilesLoading(false)
      return
    }
    setClearanceFilesLoading(true)
    const unsub = subscribeToClearanceFiles((rows) => {
      setClearanceFiles(rows)
      setClearanceFilesLoading(false)
    }, () => setClearanceFilesLoading(false))
    return () => {
      try { unsub() } catch {}
    }
  }, [isLoggedIn])

  // Auto-generate a clearance file for the current year if none exist yet.
  useEffect(() => {
    if (!isLoggedIn) return
    if (clearanceAutoAttempted) return
    if (clientsLoading || clearanceFilesLoading) return
    if (approvedClients.length === 0) return

    const currentYear = new Date().getFullYear()
    const hasCurrentYearFile = clearanceFiles.some((file) => getClearanceFileYear(file) === currentYear)
    if (hasCurrentYearFile) {
      setClearanceAutoAttempted(true)
      return
    }

    generateAndSaveClearanceFileRef.current
      ? generateAndSaveClearanceFileRef.current(currentYear)
          .catch((err) => {
            console.error("Auto-generate clearance file failed", err)
          })
          .finally(() => setClearanceAutoAttempted(true))
      : setClearanceAutoAttempted(true)
  }, [isLoggedIn, clearanceAutoAttempted, clientsLoading, clearanceFilesLoading, approvedClients, clearanceFiles])

  // Watch for any changes to approved clients and regenerate the Mayor's
  // Clearance file so every update to business clearance status is reflected.
  const approvedSnapshotRef = useRef<string>("")
  useEffect(() => {
    if (!isLoggedIn) return
    if (clientsLoading) return
    if (isClearanceGenerating) return

    const targetYear = clearanceRecordYear ?? new Date().getFullYear()
    const approvalsKey = approvedClients
      .map((c) => `${c.id}:${(c.overallStatus || c.status || "").toLowerCase()}`)
      .sort()
      .join("|")
    const clearanceKey = approvedClearanceApplicants
      .map((c) => `${c.id}:${(c.overallStatus || c.status || "").toLowerCase()}`)
      .sort()
      .join("|")
    const fingerprint = `${targetYear}::${approvalsKey}::${clearanceKey}`

    if (approvedSnapshotRef.current === fingerprint) return
    approvedSnapshotRef.current = fingerprint

    if (approvedClients.length === 0) {
      return
    }

    // Regenerate the selected-year clearance file to reflect the latest approved clients.
    setIsClearanceGenerating(true)
    ;(async () => {
      try {
        await generateAndSaveClearanceFileRef.current?.(targetYear)
      } catch (err) {
        console.error("Auto-regenerate clearance file failed", err)
      } finally {
        setIsClearanceGenerating(false)
      }
    })()
  }, [approvedClients, approvedClearanceApplicants, clearanceRecordYear, isLoggedIn, clientsLoading, isClearanceGenerating])

  // Recompute global unread indicator whenever relevant state changes.
  useEffect(() => {
    if (!isLoggedIn) {
      setHasUnreadMessages(false)
      return
    }

    if (!isMessengerLastReadLoaded) {
      return
    }

    let hasUnread = false
    for (const [id, ts] of Object.entries(latestClientTsMap)) {
      const readTs = messengerLastReadMap[id] ?? 0
      if ((ts ?? 0) > (readTs ?? 0)) {
        hasUnread = true
        break
      }
    }

    if (hasUnread) {
      setHasUnreadMessages(true)
    } else if (isMessengerOpen) {
      setHasUnreadMessages(false)
    }
  }, [isLoggedIn, isMessengerLastReadLoaded, latestClientTsMap, messengerLastReadMap, isMessengerOpen])

  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key && e.key !== 'bossMessengerLastRead') return
      try {
        const stored = typeof window !== 'undefined' ? localStorage.getItem('bossMessengerLastRead') : null
        const parsed = stored ? JSON.parse(stored || '{}') : {}
        if (parsed && typeof parsed === 'object') {
          setMessengerLastReadMap(parsed)
        }
      } catch {}
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', handler)
    }
    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('storage', handler)
      }
    }
  }, [])

  // Subscribe to application messages in realtime and keep the latest
  // client message timestamps up to date. Re-subscribe on auth changes
  // to ensure permissions allow reads when rules require authentication.
  useEffect(() => {
    if (!isLoggedIn) {
      setLatestClientTsMap({})
      return
    }

    let businessMap: Record<string, number> = {}
    let clearanceMap: Record<string, number> = {}

    const recompute = () => {
      setLatestClientTsMap({ ...businessMap, ...clearanceMap })
    }

    const businessRef = ref(realtimeDb, BUSINESS_APPLICATION_PATH)
    const businessUnsub = onValue(businessRef, (snapshot) => {
      try {
        const node = snapshot.val() || {}
        businessMap = buildBusinessLatestClientTsMap(node)
      } catch {
        businessMap = {}
      }
      recompute()
    })

    const clearanceRef = ref(realtimeDb, MAYORS_CLEARANCE_APPLICATION_PATH)
    const clearanceUnsub = onValue(clearanceRef, (snapshot) => {
      try {
        const node = snapshot.val() || {}
        clearanceMap = buildClearanceLatestClientTsMap(node)
      } catch {
        clearanceMap = {}
      }
      recompute()
    })

    return () => {
      try { if (typeof businessUnsub === 'function') businessUnsub() } catch {}
      try { if (typeof clearanceUnsub === 'function') clearanceUnsub() } catch {}
      try { off(businessRef) } catch {}
      try { off(clearanceRef) } catch {}
    }
  }, [isLoggedIn])

  

  const handleLogin = async (event?: FormEvent<HTMLFormElement> | MouseEvent<HTMLButtonElement>) => {
    event?.preventDefault()
    setLoginError("")
    setLoginVerificationStatus(null)

    const normalizedEmail = email.trim().toLowerCase()
    if (!normalizedEmail || !password) {
      setLoginError("Please enter both email and password.")
      return
    }

    setIsAuthLoading(true)
    try {
      const staffRecord = await findStaffByEmail(normalizedEmail)
      if (!staffRecord) {
        throw new Error("Account not found. Please contact an administrator.")
      }

      const hashedInput = await hashPassword(password)
      if (staffRecord.passwordHash !== hashedInput) {
        throw new Error("Invalid email or password.")
      }

      // Sign in with Firebase Auth to enable database writes
      try {
        await signInWithEmailAndPassword(firebaseAuth, normalizedEmail, password)
      } catch (authError) {
        if (authError instanceof FirebaseError && authError.code === "auth/user-not-found") {
          throw new Error("Account not found. Please contact an administrator.")
        } else {
          throw authError
        }
      }

      // Check email verification status
      if (!staffRecord.emailVerified) {
        const currentUser = firebaseAuth.currentUser
        if (currentUser && !currentUser.emailVerified) {
          await sendEmailVerification(currentUser)
          setLoginVerificationStatus("unverified")
          setLoginError("Please verify your email before logging in. We just sent a new verification link.")
          await signOut(firebaseAuth).catch(() => {})
          return
        }

        if (currentUser?.emailVerified) {
          await updateStaffEmailVerificationStatus(staffRecord.id, true)
        }
      }

      setIsLoggedIn(true)
      handlePageChange("home")
      setLoggedInEmail(normalizedEmail)
      if (typeof window !== "undefined") {
        localStorage.setItem("bossStaffEmail", normalizedEmail)
      }
      setPassword("")
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : "Unable to login. Please try again.")
    } finally {
      setIsAuthLoading(false)
    }
  }

  const handleLogout = async () => {
    await signOut(firebaseAuth).catch(() => {})
    setIsLoggedIn(false)
    handlePageChange("login")
    setEmail("")
    setPassword("")
    setLoggedInEmail(null)
    if (typeof window !== "undefined") {
      localStorage.removeItem("bossStaffEmail")
    }
  }

  const handleCloseDocxPreview = () => {
    const cached = docxPreviewClientId ? docxPreviewCacheRef.current.get(docxPreviewClientId) : null
    const isCachedPdf = cached?.pdfUrl && cached.pdfUrl === docxPreviewPdfUrl
    const isCachedMerged = cached?.mergedUrl && cached.mergedUrl === docxPreviewMergedPdfUrl
    const cachedTempSet = new Set(cached?.tempUrls || [])

    docxPreviewAbortRef.current?.abort()
    docxPreviewAbortRef.current = null
    docxPreviewCancelRef.current = true
    setIsDocxPreviewOpen(false)
    if (!isCachedPdf) revokeUrlSafe(docxPreviewPdfUrl)
    revokeUrlSafe(docxPreviewSwornPdfUrl)
    if (!isCachedMerged) revokeUrlSafe(docxPreviewMergedPdfUrl)
    if (docxPreviewTempUrls && docxPreviewTempUrls.length > 0) {
      try {
        docxPreviewTempUrls.forEach((u) => {
          if (cachedTempSet.has(u)) return
          revokeUrlSafe(u)
        })
      } catch {}
    }
    setDocxPreviewTempUrls([])
    setDocxPreviewHtml(null)
    setDocxPreviewPdfUrl(null)
    setDocxPreviewSwornPdfUrl(null)
    setDocxPreviewError(null)
    setDocxPreviewLoading(false)
    setDocxPreviewClientId(null)
  }

  // Merge main + sworn PDFs into a single Blob URL for combined preview/print
  const prepareMergedPdfIfNeeded = async () => {
    if (docxPreviewMergedPdfUrl) return
    if (docxPreviewPdfUrl && docxPreviewSwornPdfUrl) {
      try {
        const blob = await mergePdfUrls([docxPreviewPdfUrl, docxPreviewSwornPdfUrl])
        const url = URL.createObjectURL(blob)
        setDocxPreviewMergedPdfUrl(url)
      } catch (err) {
        console.warn("Failed to merge PDFs:", err)
      }
    }
  }

  

  const handleDownloadApplicationDocs = async (clientId: string, event?: React.MouseEvent) => {
    event?.stopPropagation()
    try {
      const currentUser = firebaseAuth.currentUser
      if (!currentUser) {
        console.error("User not authenticated")
        return
      }

      const idToken = await currentUser.getIdToken()
      
      const response = await fetch("/api/export/application-docs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({ applicationId: clientId }),
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        console.error("Failed to download:", errorData)
        return
      }

      const blob = await response.blob()
      const contentDisposition = response.headers.get("Content-Disposition")
      let fileName = "Application_Documents.zip"
      if (contentDisposition) {
        const match = contentDisposition.match(/filename="(.+)"/)
        if (match) {
          fileName = match[1]
        }
      }

      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = fileName
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (error) {
      console.error("Error downloading application documents:", error)
    }
  }

  const handlePrintApplicationForm = async (clientId: string, event?: React.MouseEvent) => {
    event?.stopPropagation()

    docxPreviewCancelRef.current = false
    docxPreviewAbortRef.current?.abort()
    const abortController = new AbortController()
    docxPreviewAbortRef.current = abortController
    setDocxPreviewClientId(clientId)

    const clientRecord = clients.find((client) => client.id === clientId)
    const titleParts = [clientRecord?.applicantName, clientRecord?.businessName].filter(Boolean)
    setDocxPreviewTitle(titleParts.length > 0 ? `${titleParts.join(" - ")} Application Form` : "Application Form Preview")
    setDocxPreviewHtml(null)
    setDocxPreviewError(null)
    setIsDocxPreviewOpen(true)
    setDocxPreviewLoading(true)

    const previewSignature = buildDocxPreviewSignature(clientRecord)
    const cached = getDocxPreviewCache(clientId, previewSignature)
    if (cached) {
      setDocxPreviewPdfUrl(cached.pdfUrl)
      setDocxPreviewMergedPdfUrl(cached.mergedUrl)
      setDocxPreviewTempUrls(cached.tempUrls)
      setDocxPreviewSwornHtml(null)
      setDocxPreviewSwornPdfUrl(null)
      setDocxPreviewLoading(false)
      return
    }

    try {
      const currentUser = firebaseAuth.currentUser
      if (!currentUser) {
        setDocxPreviewError("You must be logged in to preview documents.")
        setDocxPreviewLoading(false)
        return
      }

      const idToken = await currentUser.getIdToken()
      // Attempt server-side PDF conversion first
      const tryServerPdf = async () => {
        const resp = await fetch("/api/export/docx-to-pdf", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${idToken}`,
          },
          body: JSON.stringify({ applicationId: clientId }),
          signal: abortController.signal,
        })
        return resp
      }

      let usedServerPdf = false
      try {
        const mainResp = await tryServerPdf()
        if (docxPreviewCancelRef.current) {
          return
        }
          if (mainResp.ok) {
            const mainBlob = await mainResp.blob()
            const mainUrl = URL.createObjectURL(mainBlob)
            if (docxPreviewCancelRef.current) {
              try { URL.revokeObjectURL(mainUrl) } catch {}
              return
            }
            setDocxPreviewPdfUrl(mainUrl)
            setDocxPreviewHtml(null)
            setDocxPreviewSwornHtml(null)
            setDocxPreviewSwornPdfUrl(null)
            cacheDocxPreview(clientId, previewSignature, { pdfUrl: mainUrl })
            usedServerPdf = true

            // Also include any approved requirement PDFs in the preview (merge them)
            try {
              const clientRecord = clients.find((c) => c.id === clientId)
              const tempCreatedUrls: string[] = []
              const mergeCandidates: string[] = [mainUrl]

              if (clientRecord && Array.isArray(clientRecord.requirements)) {
                for (const req of clientRecord.requirements) {
                  for (const f of req.files || []) {
                    try {
                      const status = String(f.status || "").toLowerCase()
                      if (!status.includes("approve")) continue
                      const url = f.downloadUrl
                      if (!url) continue

                      const proxy = `/api/proxy?url=${encodeURIComponent(url)}`
                      const resp = await fetch(proxy, { signal: abortController.signal })
                      if (docxPreviewCancelRef.current) {
                        return
                      }
                      if (!resp.ok) continue
                      const blob = await resp.blob()
                      const contentType = (blob.type || "").toLowerCase()

                      if (contentType.includes("pdf")) {
                        // make a blob url so mergePdfUrls can fetch it reliably
                        const obj = URL.createObjectURL(blob)
                        tempCreatedUrls.push(obj)
                        mergeCandidates.push(obj)
                      } else if (contentType.startsWith("image/")) {
                        // convert image blob to a one-page PDF
                        try {
                          const arrayBuffer = await blob.arrayBuffer()
                          const pdfDoc = await PDFDocument.create()
                          let embedded: any
                          try {
                            if (contentType === "image/jpeg" || contentType === "image/jpg") {
                              embedded = await pdfDoc.embedJpg(new Uint8Array(arrayBuffer))
                            } else {
                              embedded = await pdfDoc.embedPng(new Uint8Array(arrayBuffer))
                            }
                          } catch (embedErr) {
                            // fallback: some servers misreport content-type or image is in an unexpected format
                            try {
                              const imageBitmap = await createImageBitmap(blob)
                              const canvas = document.createElement("canvas")
                              canvas.width = imageBitmap.width
                              canvas.height = imageBitmap.height
                              const ctx = canvas.getContext("2d")
                              if (!ctx) throw new Error("Canvas context unavailable")
                              ctx.drawImage(imageBitmap, 0, 0)
                              const pngBlob: Blob | null = await new Promise((res) => canvas.toBlob(res, "image/png"))
                              if (!pngBlob) throw new Error("Failed to convert image to PNG blob")
                              const pngArray = new Uint8Array(await pngBlob.arrayBuffer())
                              embedded = await pdfDoc.embedPng(pngArray)
                            } catch (fallbackErr) {
                              console.warn("Failed to convert image requirement to PDF:", f, fallbackErr)
                              continue
                            }
                          }

                          // Fit the image onto an 8.5 x 13 (legal short) page while preserving aspect ratio
                          const imgWidth = embedded.width || 600
                          const imgHeight = embedded.height || 800
                          const pageWidth = 8.5 * 72 // PDF points per inch
                          const pageHeight = 13 * 72
                          const margin = 18 // 0.25in margin to avoid printer clipping
                          const maxWidth = pageWidth - margin * 2
                          const maxHeight = pageHeight - margin * 2
                          const scale = Math.min(maxWidth / imgWidth, maxHeight / imgHeight, 1)
                          const drawWidth = imgWidth * scale
                          const drawHeight = imgHeight * scale
                          const x = (pageWidth - drawWidth) / 2
                          const y = (pageHeight - drawHeight) / 2

                          const page = pdfDoc.addPage([pageWidth, pageHeight])
                          page.drawImage(embedded, { x, y, width: drawWidth, height: drawHeight })
                          const pdfBytes = await pdfDoc.save()
                          const pdfBlob = new Blob([pdfBytes.buffer as ArrayBuffer], { type: "application/pdf" })
                          const pdfUrl = URL.createObjectURL(pdfBlob)
                          tempCreatedUrls.push(pdfUrl)
                          mergeCandidates.push(pdfUrl)
                        } catch (imgErr) {
                          console.warn("Failed to convert image requirement to PDF:", f, imgErr)
                        }
                      } else {
                        // unsupported content type — skip
                        continue
                      }
                    } catch (fileErr) {
                      console.warn("Failed to fetch/convert requirement file:", f, fileErr)
                      continue
                    }
                  }
                }
              }

              // replace any previous temp urls with the new set for cleanup
              if (tempCreatedUrls.length > 0) {
                // revoke old ones first
                try {
                  docxPreviewTempUrls.forEach((u) => {
                    try { URL.revokeObjectURL(u) } catch {}
                  })
                } catch {}
                if (!docxPreviewCancelRef.current) {
                  setDocxPreviewTempUrls(tempCreatedUrls)
                  cacheDocxPreview(clientId, previewSignature, { pdfUrl: mainUrl, tempUrls: tempCreatedUrls })
                } else {
                  tempCreatedUrls.forEach((u) => {
                    try { URL.revokeObjectURL(u) } catch {}
                  })
                }
              }

              if (mergeCandidates.length > 1) {
                try {
                  if (docxPreviewCancelRef.current) {
                    // Do not attempt merge when preview is cancelled
                    mergeCandidates.forEach((u, idx) => {
                      if (idx === 0) return
                      try { URL.revokeObjectURL(u) } catch {}
                    })
                    return
                  }
                  const mergedBlob = await mergePdfUrls(mergeCandidates)
                  const mergedUrl = URL.createObjectURL(mergedBlob)
                  if (docxPreviewCancelRef.current) {
                    try { URL.revokeObjectURL(mergedUrl) } catch {}
                    mergeCandidates.forEach((u, idx) => {
                      if (idx === 0) return
                      try { URL.revokeObjectURL(u) } catch {}
                    })
                  } else {
                    setDocxPreviewMergedPdfUrl(mergedUrl)
                    cacheDocxPreview(clientId, previewSignature, { pdfUrl: mainUrl, mergedUrl: mergedUrl, tempUrls: tempCreatedUrls })
                  }
                } catch (mergeErr) {
                  console.warn("Failed to merge approved requirement PDFs/images:", mergeErr)
                }
              }
            } catch (err) {
              console.warn("Error while collecting approved requirement PDFs:", err)
            }

            // Do not fetch sworn document during preview to avoid creating/duplicating sworn files.
          } else {
          // If server returned an error, try to inspect details for soffice/ENOENT and fall back
          const errData = await mainResp.json().catch(() => ({}))
          const details = (errData && (errData.details || errData.error || "")) as string
          if (details.toLowerCase().includes("soffice") || details.toLowerCase().includes("enoent")) {
            toast.info("Server-side PDF conversion unavailable; falling back to client-side preview.")
            console.info("Server-side PDF conversion unavailable; falling back to client-side HTML preview.")
            // Fall through to client-side docx rendering below
          } else {
            console.error("Failed to get document for printing:", errData)
            setDocxPreviewError("Unable to generate the application form. Please try again.")
            setDocxPreviewLoading(false)
            return
          }
        }
      } catch (err) {
        if (isAbortError(err)) return
        console.warn("Error requesting server PDF, will fall back to client rendering:", err)
      }

      // If server PDF wasn't used (soffice missing or conversion failed), fall back to client-side DOCX rendering
      if (!usedServerPdf) {
        try {
          const mainResp = await fetch("/api/export/docx", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${idToken}`,
            },
            body: JSON.stringify({ applicationId: clientId }),
            signal: abortController.signal,
          })
          if (!mainResp.ok) {
            const errorData = await mainResp.json().catch(() => ({}))
            console.error("Failed to get document for printing:", errorData)
            setDocxPreviewError("Unable to generate the application form. Please try again.")
            setDocxPreviewLoading(false)
            return
          }
          const mainBlob = await mainResp.blob()
          const mainContainer = document.createElement("div")
          await renderAsync(mainBlob, mainContainer)
            if (!docxPreviewCancelRef.current) {
              setDocxPreviewHtml(mainContainer.innerHTML)
              setDocxPreviewSwornHtml(null)
            }
            // Do not fetch sworn document during preview to avoid creating/duplicating sworn files.
        } catch (error) {
          if (isAbortError(error)) return
          console.error("Error printing application form:", error)
          setDocxPreviewError("Unable to preview this document. Please try downloading instead.")
        }
      }
    } catch (error) {
      if (!isAbortError(error)) {
        console.error("Error printing application form:", error)
        setDocxPreviewError("Unable to preview this document. Please try downloading instead.")
      }
    } finally {
      if (!docxPreviewCancelRef.current) {
        setDocxPreviewLoading(false)
      }
      docxPreviewAbortRef.current = null
    }
  }

  useEffect(() => {
    return () => {
      docxPreviewCacheRef.current.forEach((entry) => {
        revokeUrlSafe(entry.pdfUrl)
        revokeUrlSafe(entry.mergedUrl)
        entry.tempUrls.forEach((u) => revokeUrlSafe(u))
      })
      docxPreviewCacheRef.current.clear()
    }
  }, [])

  const arrayBufferToBase64 = (buffer: ArrayBuffer) => {
    const bytes = new Uint8Array(buffer)
    let binary = ""
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i])
    }
    return btoa(binary)
  }

  const base64ToBlob = (b64: string, type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") => {
    const binary = atob(b64)
    const len = binary.length
    const bytes = new Uint8Array(len)
    for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i)
    return new Blob([bytes], { type })
  }

  const formatDateWithSlash = (input: string | number | Date | null | undefined) => {
    if (!input) return ""

    const toParts = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`

    if (input instanceof Date) {
      return toParts(input)
    }

    if (typeof input === "number" && Number.isFinite(input)) {
      return toParts(new Date(input))
    }

    const normalized = String(input).trim().replace(/-/g, "/")
    const parsed = new Date(normalized)
    if (!Number.isNaN(parsed.getTime())) {
      return toParts(parsed)
    }

    // Fallback: just return the normalized string with slashes
    return normalized
  }

  function getClearanceNameParts(form: Record<string, any> | undefined) {
    const first = (form?.firstName ?? "").toString().trim()
    const middle = (form?.middleName ?? "").toString().trim()
    const last = (form?.lastName ?? "").toString().trim()
    if (first || middle || last) {
      return { firstName: first, middleName: middle, lastName: last }
    }

    const fullName = (form?.fullName ?? form?.name ?? "").toString().trim()
    if (!fullName) {
      return { firstName: "", middleName: "", lastName: "" }
    }

    if (fullName.includes(",")) {
      const [lastPart, rest] = fullName.split(",").map((part: string) => part.trim())
      const restParts = rest ? rest.split(/\s+/).filter(Boolean) : []
      return {
        firstName: restParts[0] ?? "",
        middleName: restParts.slice(1).join(" "),
        lastName: lastPart ?? "",
      }
    }

    const parts = fullName.split(/\s+/).filter(Boolean)
    if (parts.length === 1) {
      return { firstName: parts[0], middleName: "", lastName: "" }
    }

    return {
      firstName: parts[0] ?? "",
      middleName: parts.slice(1, -1).join(" "),
      lastName: parts[parts.length - 1] ?? "",
    }
  }

  const extractBarangayOnly = (raw: string | null | undefined) => {
    if (!raw) return ""
    const firstSegment = raw
      .split(/[,\n;]/)
      .map((part: string) => part.trim())
      .find(Boolean)

    const base = (firstSegment || raw).trim()
    const cleaned = base
      .replace(/\b(Sabangan|Mountain\s*Province|Mt\.?\s*Province)\b/gi, "")
      .replace(/\s+/g, " ")
      .trim()

    return cleaned || base
  }

  function formatClearanceAddress(form: Record<string, any> | undefined) {
    const address = form?.address
    if (address && typeof address === "object") {
      const parts = [address.barangay, address.municipality, address.province]
        .map((part) => (part ?? "").toString().trim())
        .filter(Boolean)
      if (parts.length > 0) return parts.join(", ")
    }

    const raw =
      form?.businessAddress ??
      form?.ownerAddress ??
      form?.address ??
      ""

    return raw ? String(raw).trim() : ""
  }

  const fetchClearanceTemplate = async () => {
    const response = await fetch("/api/export/clearance-template", { cache: "no-cache" })
    if (!response.ok) {
      throw new Error(`Template download failed with status ${response.status}`)
    }
    return response.arrayBuffer()
  }

  const handleRefreshClearance = async () => {
    if (isClearanceGenerating) return
    if (approvedClearanceApplicants.length === 0 && approvedClients.length === 0) {
      return
    }
    setIsClearanceGenerating(true)
    try {
      const targetYear = clearanceRecordYear ?? new Date().getFullYear()
      await generateAndSaveClearanceFileRef.current?.(targetYear)
      toast.success("Mayor's Clearance has been refreshed.")
    } catch (err) {
      console.error("Failed to refresh Mayor's Clearance", err)
      toast.error("Unable to refresh the Mayor's Clearance file.")
    } finally {
      setIsClearanceGenerating(false)
    }
  }

  const generateAndSaveClearanceFile = useCallback(async (targetYear?: number) => {
    const today = new Date()
    const year = targetYear ?? today.getFullYear()
    const todayLabel = formatDateWithSlash(today)
    let templateBuffer: ArrayBuffer | null = null

    if (approvedClearanceApplicants.length === 0 && approvedClients.length === 0) {
      return null
    }

    try {
      templateBuffer = await fetchClearanceTemplate()
    } catch (err) {
      console.error("Failed to load Mayor's Clearance template", err)
      toast.error("Unable to load the Mayor's Clearance template. Please try again.")
      return null
    }

    if (!templateBuffer) {
      toast.error("Mayor's Clearance template could not be loaded.")
      return null
    }

    const workbook = new ExcelJS.Workbook()
    try {
      await workbook.xlsx.load(templateBuffer)
    } catch (err) {
      console.error("Failed to parse Mayor's Clearance template", err)
      toast.error("Mayor's Clearance template is corrupted. Please refresh and try again.")
      return null
    }
    const sheet = workbook.worksheets[0] ?? workbook.getWorksheet(1)

    if (!sheet) {
      toast.error("Mayor's Clearance template is missing a worksheet.")
      return null
    }

    // Keep the template header intact (yellow styling) and clear any existing data rows.
    const headerRowIndex = 1
    if (sheet.rowCount > headerRowIndex) {
      sheet.spliceRows(headerRowIndex + 1, sheet.rowCount - headerRowIndex)
    }

    const clearanceRows = approvedClearanceApplicants.flatMap((record) => {
      const form = record.form || {}
      const { firstName, middleName, lastName } = getClearanceNameParts(form)
      const middleInitial = middleName ? `${middleName.charAt(0).toUpperCase()}.` : ""
      const barangay = extractBarangayOnly(form?.address?.barangay ?? form.barangay ?? "")
      const dateValue = record.applicationDate ?? record.submittedAt ?? ""
      const recordYear = getYearFromDateValue(dateValue)
      if (targetYear && recordYear !== targetYear) {
        return []
      }
      const applicationDate = formatDateWithSlash(dateValue)
      const purpose = record.purpose || "Mayor's Clearance"

      return [[
        todayLabel,
        applicationDate,
        firstName,
        middleName,
        middleInitial,
        lastName,
        barangay,
        "Sabangan, Mountain Province",
        "",
        "",
        "",
        purpose,
        "",
        "",
      ]]
    })

    const businessRows = approvedClients.flatMap((client) => {
      const form = client.form || {}
      const { firstName, middleName, lastName } = getClearanceNameParts(form)
      const middleInitial = middleName ? `${middleName.charAt(0).toUpperCase()}.` : ""
      const barangay = extractBarangayOnly(form.barangay ?? form.businessAddress ?? "")
      const dateValue =
        form.dateOfApplication ??
          form.registrationDate ??
          client.applicationDate ??
          client.approvedAt ??
          client.submittedAt ??
          ""
      const recordYear = getYearFromDateValue(dateValue)
      if (targetYear && recordYear !== targetYear) {
        return []
      }
      const applicationDate = formatDateWithSlash(dateValue)

      return [[
        todayLabel,
        applicationDate,
        firstName,
        middleName,
        middleInitial,
        lastName,
        barangay,
        "Sabangan, Mountain Province",
        "",
        "",
        "",
        "Securing Business Permit",
        "",
        "",
      ]]
    })

    const combinedRows = [...clearanceRows, ...businessRows].map((row, index) => [index + 1, ...row])

    if (combinedRows.length > 0) {
      sheet.addRows(combinedRows)
    } else {
      toast.error(`No approved records found for ${year}.`)
      return null
    }

    const buffer = await workbook.xlsx.writeBuffer()
    const fileName = `Mayor's Clearance ${year}.xlsx`

    const base64 = arrayBufferToBase64(buffer)
    const user = firebaseAuth.currentUser
    await saveClearanceFile({
      fileName,
      createdAt: Date.now(),
      rowCount: combinedRows.length,
      dataBase64: base64,
      createdBy: user?.uid ?? null,
    })
    return { fileName, base64 }
  }, [approvedClearanceApplicants, approvedClients, fetchClearanceTemplate, arrayBufferToBase64, formatDateWithSlash, extractBarangayOnly, saveClearanceFile, firebaseAuth, getClearanceNameParts])

  useEffect(() => {
    generateAndSaveClearanceFileRef.current = generateAndSaveClearanceFile
  }, [generateAndSaveClearanceFile])

  const normalizedClientSearch = searchQuery.trim().toLowerCase()
  const filteredClients = clients
    .filter((client) => {
      const matchesType = (() => {
        if (typeFilter === "All") return true
        const norm = ((client.overallStatus ?? client.status ?? "") as string).toLowerCase()
        if (typeFilter === "Approved") {
          return norm.includes("approve") || norm.includes("complete") || norm.includes("process")
        }
        if (typeFilter === "Pending") {
          return norm === "" || norm.includes("pending") || norm.includes("review") || norm.includes("updated")
        }
        return true
      })()
      const haystack = [client.applicantName, client.businessName]
        .filter(Boolean)
        .map((value) => value.toLowerCase())
      const matchesSearch = !normalizedClientSearch || haystack.some((value) => value.includes(normalizedClientSearch))
      const matchesDate = (() => {
        if (!applicationDateFilter) return true
        if (!client.applicationDate) return false
        const date = new Date(client.applicationDate)
        return !Number.isNaN(date.getTime()) && date.toDateString() === applicationDateFilter.toDateString()
      })()

      return matchesType && matchesSearch && matchesDate
    })
    .sort((a, b) => {
      if (sortBy === "firstComeFirstServe") {
        return (a.submittedAt ?? Number.MAX_SAFE_INTEGER) - (b.submittedAt ?? Number.MAX_SAFE_INTEGER)
      }
      return 0
    })

  const combinedClearanceApplicants = useMemo(
    () => [...clearanceApplicants, ...approvedBusinessClearanceCandidates],
    [clearanceApplicants, approvedBusinessClearanceCandidates]
  )

  const normalizedClearanceSearch = clearanceApplicantsSearch.trim().toLowerCase()
  const filteredClearanceApplicants = useMemo(() => {
    return combinedClearanceApplicants
      .filter((record) => {
        const normalizedStatus = (record.overallStatus || record.status || "").toLowerCase()
        const matchesStatus = (() => {
          if (clearanceApplicantsStatus === "All") return true
          if (clearanceApplicantsStatus === "Approved") {
            return (
              normalizedStatus.includes("approve") ||
              normalizedStatus.includes("complete") ||
              normalizedStatus.includes("process")
            )
          }
          if (clearanceApplicantsStatus === "Rejected") {
            return normalizedStatus.includes("reject") || normalizedStatus.includes("incomplete")
          }
          return (
            normalizedStatus === "" ||
            normalizedStatus.includes("pending") ||
            normalizedStatus.includes("review") ||
            normalizedStatus.includes("process")
          )
        })()

        const haystack = [record.applicantName, record.purpose]
          .filter((value): value is string => Boolean(value))
          .map((value) => value.toLowerCase())
        const matchesSearch =
          !normalizedClearanceSearch || haystack.some((value) => value.includes(normalizedClearanceSearch))

        const matchesDate = (() => {
          if (!clearanceApplicationDateFilter) return true
          const raw = record.applicationDate ?? record.submittedAt
          if (!raw) return false
          const date = new Date(raw as string)
          return !Number.isNaN(date.getTime()) && date.toDateString() === clearanceApplicationDateFilter.toDateString()
        })()

        return matchesStatus && matchesSearch && matchesDate
      })
      .sort((a, b) => {
        return (a.submittedAt ?? Number.MAX_SAFE_INTEGER) - (b.submittedAt ?? Number.MAX_SAFE_INTEGER)
      })
  }, [combinedClearanceApplicants, clearanceApplicantsStatus, normalizedClearanceSearch, clearanceApplicationDateFilter])

  const renderWithSidebar = (content: ReactNode) => (
    <div className="min-h-screen flex bg-background">
      <aside className="hidden md:flex w-64 flex-col border-r border-border bg-card/40 fixed left-0 top-0 bottom-0">
        <div className="p-6">
          <p className="text-lg font-semibold text-foreground">BOSS Portal</p>
          {loggedInEmail && <p className="text-xs text-muted-foreground break-words mt-1">{loggedInEmail}</p>}
        </div>
        <nav className="flex-1 px-3 space-y-1">
          {authenticatedNavItems.map((item) => {
            const Icon = item.icon
            const isRouteLink = typeof item.href === "string"
            const isActive = !isRouteLink && currentPage === item.id
            const showHomeDot = item.id === "home" && hasClientUpdate
            const handleNavClick = () => {
              if (isRouteLink && item.href) {
                router.push(item.href)
              } else {
                handlePageChange(item.id as PageType)
              }
            }
            return (
              <button
                key={item.id}
                type="button"
                onClick={handleNavClick}
                className={cn(
                  "w-full relative flex items-center gap-3 rounded-md py-2 text-base font-medium transition",
                  "px-3",
                  isActive
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/40"
                )}
              >
                <Icon className="h-4 w-4" />
                <span className="relative inline-flex items-center flex-1 text-left whitespace-normal">
                  {item.label}
                  {showHomeDot && (
                    <span className="absolute -right-3 -top-1 h-2.5 w-2.5 rounded-full bg-red-500" aria-hidden />
                  )}
                </span>
              </button>
            )
          })}
        </nav>
        <div className="p-4">
          <Button
            variant="destructive"
            className="w-full justify-center gap-2 hover:shadow-lg hover:scale-105 transition-all duration-200"
            onClick={handleLogout}
          >
            <LogOut className="h-4 w-4" />
            Logout
          </Button>
        </div>
      </aside>
      <div className="flex-1 flex flex-col md:ml-64">
        <div className="md:hidden border-b border-border bg-card/70 px-4 py-3 flex gap-2 overflow-x-auto">
          {authenticatedNavItems.map((item) => {
            const Icon = item.icon
            const isRouteLink = typeof item.href === "string"
            const isActive = !isRouteLink && currentPage === item.id
            const showHomeDot = item.id === "home" && hasClientUpdate
            const handleNavClick = () => {
              if (isRouteLink && item.href) {
                router.push(item.href)
              } else {
                handlePageChange(item.id as PageType)
              }
            }
            return (
              <button
                key={`${item.id}-mobile`}
                type="button"
                onClick={handleNavClick}
                className={cn(
                  "relative flex items-center gap-2 rounded-full px-3 py-1.5 text-base font-medium whitespace-nowrap",
                  isActive ? "bg-primary text-primary-foreground" : "bg-muted text-foreground"
                )}
              >
                <Icon className="h-4 w-4" />
                <span className="relative inline-flex items-center flex-1 text-left whitespace-normal">
                  {item.label}
                  {showHomeDot && (
                    <span className="absolute -right-3 -top-1 h-2.5 w-2.5 rounded-full bg-red-500" aria-hidden />
                  )}
                </span>
                
              </button>
            )
          })}
        </div>
        <div className="flex-1 flex flex-col">{content}</div>
      </div>
    </div>
  )

  // Show loading screen while checking authentication
  if (isAuthChecking) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="h-12 w-12 animate-spin rounded-full border-4 border-primary border-t-transparent"></div>
          <p className="text-muted-foreground">Loading...</p>
        </div>
      </div>
    )
  }

  // Determine the effective current page from URL params OR state
  // This prevents flashing the wrong page when navigating with query params
  const requestedPage = searchParams?.get("page")
  const effectivePage = (requestedPage && isLoggedIn && allowedPages.includes(requestedPage as PageType)) 
    ? requestedPage as PageType 
    : currentPage

  if (isLoggedIn && effectivePage === "home") {

    return renderWithSidebar(
      <>
        <main className="flex-1 p-6 mt-28 max-w-4xl w-full relative">
          {/* Background decorative elements */}
          <div className="absolute inset-0 overflow-hidden pointer-events-none">
            <div className="absolute -top-10 -right-10 w-32 h-32 bg-primary/5 rounded-full blur-3xl"></div>
            <div className="absolute top-1/2 -left-10 w-24 h-24 bg-blue-500/5 rounded-full blur-2xl"></div>
            <div className="absolute -bottom-10 right-1/4 w-20 h-20 bg-green-500/5 rounded-full blur-xl"></div>
          </div>

          <div className="flex flex-col items-center mb-16 relative z-10">
            {/* Animated background glow */}
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="w-64 h-64 bg-gradient-to-r from-primary/20 via-blue-500/10 to-primary/20 rounded-full blur-3xl animate-pulse"></div>
            </div>

            {/* Welcome text with gradient effect */}
            <div className="text-center mb-6 relative">
              <h1 className="text-5xl md:text-6xl font-black text-foreground mb-3 tracking-tight">
                Welcome to BOSS
              </h1>
              <div className="h-1 w-24 bg-gradient-to-r from-transparent via-primary to-transparent mx-auto rounded-full"></div>
            </div>

            {/* Subtitle with elegant styling */}
            <div className="relative">
              <p className="text-xl md:text-2xl font-semibold text-muted-foreground/90 tracking-wide relative z-10 px-6 py-2 rounded-full bg-white/50 dark:bg-gray-900/50 backdrop-blur-sm border border-white/20 dark:border-gray-700/20 shadow-lg">
                Business One Stop Shop
              </p>
              {/* Subtle shadow effect */}
              <div className="absolute inset-0 rounded-full bg-gradient-to-r from-primary/10 to-blue-500/10 blur-xl -z-10"></div>
            </div>

            {/* Decorative elements */}
            <div className="flex items-center gap-4 mt-8">
              <div className="w-2 h-2 bg-primary rounded-full animate-bounce" style={{animationDelay: '0s'}}></div>
              <div className="w-2 h-2 bg-blue-500 rounded-full animate-bounce" style={{animationDelay: '0.2s'}}></div>
              <div className="w-2 h-2 bg-primary rounded-full animate-bounce" style={{animationDelay: '0.4s'}}></div>
            </div>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8 relative z-10 max-w-3xl mx-auto">
            <div className="group relative overflow-hidden bg-gradient-to-br from-blue-50 via-blue-100 to-indigo-100 dark:from-blue-950/50 dark:via-blue-900/50 dark:to-indigo-900/50 border border-blue-200/50 dark:border-blue-800/50 rounded-2xl p-6 shadow-lg hover:shadow-2xl transition-all duration-500 hover:-translate-y-1">
              <div className="absolute inset-0 bg-gradient-to-br from-blue-400/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500"></div>
              <div className="absolute top-0 right-0 w-32 h-32 bg-blue-500/10 rounded-full -translate-y-16 translate-x-16 blur-2xl group-hover:bg-blue-500/20 transition-colors duration-500"></div>
              
              <div className="relative z-10 flex items-center gap-4">
                <div className="relative">
                  <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-blue-500 to-blue-600 flex items-center justify-center shadow-xl group-hover:shadow-2xl transition-shadow duration-500">
                    <FileText className="h-10 w-10 text-white" />
                  </div>
                  <div className="absolute -bottom-1 -right-1 w-6 h-6 bg-blue-400 rounded-full border-2 border-white dark:border-gray-900 flex items-center justify-center">
                    <span className="text-xs font-bold text-white">📋</span>
                  </div>
                </div>
                
                <div className="flex-1">
                  <div className="flex items-baseline gap-2 mb-1">
                    <p className="text-4xl font-bold text-blue-900 dark:text-blue-100 group-hover:text-blue-800 dark:group-hover:text-blue-200 transition-colors duration-300">
                      {clientsLoading ? "..." : clients.length}
                    </p>
                    <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse"></div>
                  </div>
                  <p className="text-blue-700 dark:text-blue-300 font-semibold text-lg mb-1">Total Registrants</p>
                  <p className="text-sm text-blue-600/80 dark:text-blue-400/80">Active business applications</p>
                  <div className="mt-3 flex items-center gap-1">
                    <div className="h-1 bg-blue-200 dark:bg-blue-800 rounded-full flex-1">
                      <div className="h-1 bg-gradient-to-r from-blue-500 to-blue-600 rounded-full transition-all duration-1000" 
                           style={{width: clientsLoading ? '0%' : '100%'}}></div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            
            <div className="group relative overflow-hidden bg-gradient-to-br from-emerald-50 via-green-100 to-teal-100 dark:from-emerald-950/50 dark:via-green-900/50 dark:to-teal-900/50 border border-emerald-200/50 dark:border-emerald-800/50 rounded-2xl p-6 shadow-lg hover:shadow-2xl transition-all duration-500 hover:-translate-y-1">
              <div className="absolute inset-0 bg-gradient-to-br from-emerald-400/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500"></div>
              <div className="absolute top-0 right-0 w-32 h-32 bg-emerald-500/10 rounded-full -translate-y-16 translate-x-16 blur-2xl group-hover:bg-emerald-500/20 transition-colors duration-500"></div>
              
              <div className="relative z-10 flex items-center gap-4">
                <div className="relative">
                  <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-emerald-500 to-green-600 flex items-center justify-center shadow-xl group-hover:shadow-2xl transition-shadow duration-500">
                    <Check className="h-10 w-10 text-white" />
                  </div>
                  <div className="absolute -bottom-1 -right-1 w-6 h-6 bg-emerald-400 rounded-full border-2 border-white dark:border-gray-900 flex items-center justify-center">
                    <span className="text-xs font-bold text-white">✅</span>
                  </div>
                </div>
                
                <div className="flex-1">
                  <div className="flex items-baseline gap-2 mb-1">
                    <p className="text-4xl font-bold text-emerald-900 dark:text-emerald-100 group-hover:text-emerald-800 dark:group-hover:text-emerald-200 transition-colors duration-300">
                      {clientsLoading ? "..." : approvedClients.length}
                    </p>
                    <div className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse"></div>
                  </div>
                  <p className="text-emerald-700 dark:text-emerald-300 font-semibold text-lg mb-1">Processed Applications</p>
                  <p className="text-sm text-emerald-600/80 dark:text-emerald-400/80">Approved & completed</p>
                  <div className="mt-3 flex items-center gap-1">
                    <div className="h-1 bg-emerald-200 dark:bg-emerald-800 rounded-full flex-1">
                      <div className="h-1 bg-gradient-to-r from-emerald-500 to-green-600 rounded-full transition-all duration-1000" 
                           style={{width: clientsLoading ? '0%' : '100%'}}></div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          
          <div className="bg-card border border-border rounded-lg p-6 md:fixed md:right-6 md:top-20 md:w-96 md:max-h-[80vh] md:overflow-auto z-50 shadow-sm">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-xl font-semibold text-foreground flex items-center gap-2">
                <FileText className="h-5 w-5 text-primary" />
                Recent Notifications
              </h2>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  className="bg-white text-primary hover:bg-gray-100 fixed top-4 right-4 z-50"
                  onClick={handleOpenMessenger}
                >
                  <div className="relative mr-2 inline-flex items-center">
                    <MessageSquare className="h-4 w-4" />
                    {hasUnreadMessages && <span className="h-2 w-2 bg-rose-500 rounded-full absolute -top-1 -right-1" aria-hidden />}
                  </div>
                  Messages
                </Button>
                {isMessengerOpen && (
                  <Messenger
                    onClose={() => setIsMessengerOpen(false)}
                    lastReadMap={messengerLastReadMap}
                    onMarkRead={handleMarkConversationRead}
                    latestClientTsMap={latestClientTsMap}
                  />
                )}
              </div>
            </div>
            
            {renderNotificationsList()}
          </div>
        </main>
      </>
    )
  }

  if (isLoggedIn && effectivePage === "clients") {
    return renderWithSidebar(
      <div className="flex-1 flex flex-col p-6 max-w-6xl mx-auto w-full">
        <div className="mb-8">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-lg bg-primary/10 flex items-center justify-center">
                <FileText className="h-6 w-6 text-primary" />
              </div>
              <div>
                <h1 className="text-3xl font-bold text-foreground">Business Application</h1>
                <p className="text-muted-foreground">Manage business permit applications</p>
              </div>
            </div>
            <div className="text-right">
              <p className="text-2xl font-semibold text-primary">
                {clientsLoading ? "..." : filteredClients.length}
              </p>
              <p className="text-sm text-muted-foreground">Active Applications</p>
            </div>
          </div>
        </div>

          
          <div className="mb-6">
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
              <div className="flex flex-col md:flex-row md:items-center gap-3">
                <div className="flex-none w-full md:w-auto">
                  <Input
                    placeholder="Search by client name..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full max-w-md"
                  />
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant={typeFilter === "All" ? "default" : "outline"}
                    onClick={() => setTypeFilter("All")}
                    className={`${typeFilter === "All" ? "bg-primary hover:bg-primary/90 text-white" : ""} px-4 py-2 text-sm md:text-base`}
                    size="lg"
                  >
                    All
                  </Button>
                  <Button
                    variant={typeFilter === "Approved" ? "default" : "outline"}
                    onClick={() => setTypeFilter("Approved")}
                    className={`${typeFilter === "Approved" ? "bg-primary hover:bg-primary/90 text-white" : ""} px-4 py-2 text-sm md:text-base`}
                    size="lg"
                  >
                    Approved
                  </Button>
                  <Button
                    variant={typeFilter === "Pending" ? "default" : "outline"}
                    onClick={() => setTypeFilter("Pending")}
                    className={`${typeFilter === "Pending" ? "bg-primary hover:bg-primary/90 text-white" : ""} px-4 py-2 text-sm md:text-base`}
                    size="lg"
                  >
                    Pending
                  </Button>
                </div>
              </div>

              <div className="flex items-center">
                <Popover>
                  <PopoverTrigger asChild>
                    <Button size="sm" className="ml-2 px-3 py-2 flex items-center gap-2">
                      <span>Application Date</span>
                      <CalendarDays className="h-4 w-4" />
                      {applicationDateFilter && (
                        <span className="text-xs bg-white/20 px-2 py-0.5 rounded ml-2">
                          {applicationDateFilter.toLocaleDateString()}
                        </span>
                      )}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <div className="p-2 border-b">
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => setApplicationDateFilter(undefined)}
                        className="w-full text-sm"
                      >
                        Clear Filter
                      </Button>
                    </div>
                    <Calendar mode="single" selected={applicationDateFilter} onSelect={setApplicationDateFilter} />
                  </PopoverContent>
                </Popover>
              </div>
            </div>
          </div>

          {clientsError && (
            <div className="mb-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {clientsError}
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="bg-primary text-white">
                  <th className="border border-border p-3 text-center">No.</th>
                  <th className="border border-border p-3 text-center">Client Name</th>
                  <th className="border border-border p-3 text-center">Type</th>
                  <th className="border border-border p-3 text-center">Application Date</th>
                  <th className="border border-border p-3 text-center">Status</th>
                  <th className="border border-border p-3 text-center">Approval Date</th>
                </tr>
              </thead>
              <tbody>
                {clientsLoading ? (
                  <tr>
                    <td colSpan={6} className="border border-border p-6 text-center text-muted-foreground">
                      Loading clients...
                    </td>
                  </tr>
                ) : filteredClients.length > 0 ? (
                  filteredClients.map((client, index) => (
                    <tr 
                      key={client.id} 
                      className={`${index % 2 === 0 ? "bg-background" : "bg-muted/30"} cursor-pointer hover:bg-green-200 transition-colors`}
                      onClick={() => router.push(`/client/${client.id}?from=application&page=clients`)}
                    >
                      <td className="border border-border p-3 text-center">
                        <div className="flex items-center justify-center gap-2">
                          <span>{index + 1}</span>
                          {unreadClientIds.has(client.id) && (
                            <span className="h-2 w-2 rounded-full bg-red-500" aria-label="Client updates" />
                          )}
                        </div>
                      </td>
                      <td className="border border-border p-3 text-center">
                        <div className="flex flex-col items-center">
                          <span className="font-medium">{client.applicantName}</span>
                          {client.businessName && (
                            <span className="text-xs text-muted-foreground">{client.businessName}</span>
                          )}
                        </div>
                      </td>
                      <td className="border border-border p-3 text-center">{client.applicationType}</td>
                      <td className="border border-border p-3 text-center">
                        {(() => {
                          const raw = client.applicationDate
                          if (!raw) return "—"
                          const date = new Date(raw)
                          return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString()
                        })()}
                      </td>
                      <td className="border border-border p-3 text-center">
                        {(() => {
                          const badge = getStatusBadge(client.status, client.overallStatus)
                          return (
                            <span className={`px-3 py-1 rounded-full text-sm font-medium ${badge.className}`}>
                              {badge.label}
                            </span>
                          )
                        })()}
                      </td>
                      <td className="border border-border p-3 text-center">
                        {(() => {
                          const normalized = (client.overallStatus || client.status || "").toLowerCase()
                          if (!normalized.includes("approve")) return "—"
                          const ts = client.approvedAt
                          if (!ts) return "—"
                          const date = new Date(ts)
                          return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString()
                        })()}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={6} className="border border-border p-3 text-center text-muted-foreground">
                      No clients found
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {isSwornDocxPreviewOpen && (
            <div
              className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
              onClick={handleCloseSwornDocxPreview}
            >
              <div
                className="bg-card rounded-lg max-w-screen-2xl w-full max-h-[98vh] overflow-auto"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center justify-between px-4 py-3 border-b border-border"></div>
                <div className="p-4">
                  <div className="docx-preview min-h-[240px]">
                    {swornDocxPreviewLoading && (
                      <div className="flex items-center gap-2 text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Preparing preview...
                      </div>
                    )}
                    {!swornDocxPreviewLoading && swornDocxPreviewError && (
                      <p className="text-sm text-destructive">{swornDocxPreviewError}</p>
                    )}
                    {!swornDocxPreviewLoading && !swornDocxPreviewError && swornDocxPreviewPdfUrl && (
                      <div className="w-full h-[92vh]">
                        <iframe src={swornDocxPreviewPdfUrl} className="w-full h-full border-0" />
                      </div>
                    )}
                    {!swornDocxPreviewLoading && !swornDocxPreviewError && !swornDocxPreviewPdfUrl && swornDocxPreviewHtml && (
                      <div dangerouslySetInnerHTML={{ __html: swornDocxPreviewHtml }} />
                    )}
                    {!swornDocxPreviewLoading && !swornDocxPreviewError && !swornDocxPreviewHtml && !swornDocxPreviewPdfUrl && (
                      <p className="text-sm text-muted-foreground">No content available.</p>
                    )}
                  </div>
                </div>
                <div className="px-4 py-3 border-t border-border flex justify-end">
                  <Button
                    size="sm"
                    onClick={() => {
                      if (swornDocxPreviewPdfUrl) {
                        handlePrintPdf(swornDocxPreviewPdfUrl, swornDocxPreviewTitle)
                      } else {
                        handlePrintHtml(swornDocxPreviewHtml, swornDocxPreviewTitle)
                      }
                    }}
                    disabled={(!swornDocxPreviewPdfUrl && !swornDocxPreviewHtml) || swornDocxPreviewLoading}
                    className="mr-2"
                  >
                    Print
                  </Button>
                  <Button variant="outline" onClick={handleCloseSwornDocxPreview}>
                    Close
                  </Button>
                </div>
              </div>
            </div>
          )}
          {isDocxPreviewOpen && (
            <div
              className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
              onClick={handleCloseDocxPreview}
            >
              <div
                className="bg-card rounded-lg max-w-screen-2xl w-full max-h-[98vh] overflow-auto"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center justify-between px-4 py-3 border-b border-border"></div>
                <div className="p-4">
                  <div className="docx-preview min-h-[240px]">
                    {docxPreviewLoading && (
                      <div className="flex items-center gap-2 text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Preparing preview...
                      </div>
                    )}
                    {!docxPreviewLoading && docxPreviewError && (
                      <p className="text-sm text-destructive">{docxPreviewError}</p>
                    )}
                    {!docxPreviewLoading && !docxPreviewError && (docxPreviewMergedPdfUrl || docxPreviewPdfUrl) && (
                      <div className="w-full h-[80vh]">
                        <iframe src={docxPreviewMergedPdfUrl ?? docxPreviewPdfUrl ?? undefined} className="w-full h-full border-0" />
                      </div>
                    )}
                    {!docxPreviewLoading && !docxPreviewError && !docxPreviewPdfUrl && docxPreviewHtml && (
                      <div dangerouslySetInnerHTML={{ __html: docxPreviewHtml }} />
                    )}
                    {!docxPreviewLoading && !docxPreviewError && !docxPreviewHtml && !docxPreviewPdfUrl && (
                      <p className="text-sm text-muted-foreground">No content available.</p>
                    )}
                  </div>
                </div>
                <div className="px-4 py-3 border-t border-border flex justify-end">
                  <Button
                    size="sm"
                    onClick={async () => {
                      // Ensure merged PDF prepared if both PDFs are present
                      if (docxPreviewPdfUrl && docxPreviewSwornPdfUrl && !docxPreviewMergedPdfUrl) {
                        await prepareMergedPdfIfNeeded()
                      }

                      const printablePdf = docxPreviewMergedPdfUrl ?? docxPreviewPdfUrl
                      if (printablePdf) {
                        handlePrintPdf(printablePdf, docxPreviewTitle)
                      } else {
                        handlePrintHtml(docxPreviewHtml, docxPreviewTitle, docxPreviewSwornHtml)
                      }
                    }}
                    disabled={(!docxPreviewPdfUrl && !docxPreviewHtml) || docxPreviewLoading}
                    className="mr-2"
                  >
                    Print
                  </Button>
                  <Button variant="outline" onClick={handleCloseDocxPreview}>
                    Close
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
    )
  }

  if (isLoggedIn && effectivePage === "clearance-applications") {
    return renderWithSidebar(
      <div className="flex-1 flex flex-col p-6 max-w-6xl mx-auto w-full">
        <div className="mb-8">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-lg bg-primary/10 flex items-center justify-center">
                <ClipboardList className="h-6 w-6 text-primary" />
              </div>
              <div>
                <h1 className="text-3xl font-bold text-foreground">Mayor&apos;s Clearance Application</h1>
                <p className="text-muted-foreground">Track applicants requesting Mayor&apos;s Clearance</p>
              </div>
            </div>
            <div className="text-right">
              <p className="text-2xl font-semibold text-primary">
                {clearanceApplicantsLoading ? "..." : filteredClearanceApplicants.length}
              </p>
              <p className="text-sm text-muted-foreground">Active Applicants</p>
            </div>
          </div>
        </div>

        <div className="mb-6 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
          <div className="flex flex-col md:flex-row md:items-center gap-3 w-full">
            <Input
              placeholder="Search applicant or purpose..."
              value={clearanceApplicantsSearch}
              onChange={(e) => setClearanceApplicantsSearch(e.target.value)}
              className="w-full md:w-80"
            />
            <div className="flex flex-wrap gap-2">
              <Button
                variant={clearanceApplicantsStatus === "All" ? "default" : "outline"}
                onClick={() => setClearanceApplicantsStatus("All")}
                className={clearanceApplicantsStatus === "All" ? "bg-primary hover:bg-primary/90 text-white" : ""}
              >
                All
              </Button>
              <Button
                variant={clearanceApplicantsStatus === "Approved" ? "default" : "outline"}
                onClick={() => setClearanceApplicantsStatus("Approved")}
                className={clearanceApplicantsStatus === "Approved" ? "bg-primary hover:bg-primary/90 text-white" : ""}
              >
                Approved
              </Button>
              <Button
                variant={clearanceApplicantsStatus === "Pending" ? "default" : "outline"}
                onClick={() => setClearanceApplicantsStatus("Pending")}
                className={clearanceApplicantsStatus === "Pending" ? "bg-primary hover:bg-primary/90 text-white" : ""}
              >
                Pending
              </Button>
              <Button
                variant={clearanceApplicantsStatus === "Rejected" ? "default" : "outline"}
                onClick={() => setClearanceApplicantsStatus("Rejected")}
                className={clearanceApplicantsStatus === "Rejected" ? "bg-primary hover:bg-primary/90 text-white" : ""}
              >
                Rejected
              </Button>
            </div>
          </div>

          <div className="flex items-center">
            <Popover>
              <PopoverTrigger asChild>
                <Button size="sm" className="ml-2 px-3 py-2 flex items-center gap-2">
                  <span>Application Date</span>
                  <CalendarDays className="h-4 w-4" />
                  {clearanceApplicationDateFilter && (
                    <span className="text-xs bg-white/20 px-2 py-0.5 rounded ml-2">
                      {clearanceApplicationDateFilter.toLocaleDateString()}
                    </span>
                  )}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <div className="p-2 border-b">
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => setClearanceApplicationDateFilter(undefined)}
                    className="w-full text-sm"
                  >
                    Clear Filter
                  </Button>
                </div>
                <Calendar
                  mode="single"
                  selected={clearanceApplicationDateFilter}
                  onSelect={setClearanceApplicationDateFilter}
                />
              </PopoverContent>
            </Popover>
          </div>
        </div>

        {clearanceApplicantsError && (
          <div className="mb-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {clearanceApplicantsError}
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="bg-primary text-white">
                <th className="border border-border p-3 text-center">No.</th>
                <th className="border border-border p-3 text-center">Applicant Name</th>
                <th className="border border-border p-3 text-center">Purpose</th>
                <th className="border border-border p-3 text-center">Application Date</th>
                <th className="border border-border p-3 text-center">Status</th>
              </tr>
            </thead>
            <tbody>
              {clearanceApplicantsLoading ? (
                <tr>
                  <td colSpan={5} className="border border-border p-6 text-center text-muted-foreground">
                    Loading applications...
                  </td>
                </tr>
              ) : filteredClearanceApplicants.length > 0 ? (
                filteredClearanceApplicants.map((application, index) => (
                  <tr
                    key={application.id}
                    className={`${index % 2 === 0 ? "bg-background" : "bg-muted/30"} cursor-pointer hover:bg-green-200 transition-colors`}
                    onClick={() => handleOpenBarangayClearance(application)}
                  >
                    <td className="border border-border p-3 text-center">{index + 1}</td>
                    <td className="border border-border p-3 text-center font-medium">{application.applicantName}</td>
                    <td className="border border-border p-3 text-center text-muted-foreground">
                      {application.purpose || "—"}
                    </td>
                    <td className="border border-border p-3 text-center">
                      {(() => {
                        const raw = application.applicationDate ?? application.submittedAt
                        if (!raw) return "—"
                        const date = new Date(raw as string)
                        return Number.isNaN(date.getTime()) ? raw : date.toLocaleDateString()
                      })()}
                    </td>
                    <td className="border border-border p-3 text-center">
                      {(() => {
                        const badge = getStatusBadge(application.status, application.overallStatus)
                        return (
                          <span className={`px-3 py-1 rounded-full text-sm font-medium ${badge.className}`}>
                            {badge.label}
                          </span>
                        )
                      })()}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={5} className="border border-border p-3 text-center text-muted-foreground">
                    No Mayor&apos;s Clearance applications found
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {barangayPreview && barangayActiveDocument && (
          <div
            className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
            onClick={() => {
              if (isBarangayActionLoading) return
              setBarangayPreview(null)
              setBarangaySelectedDocIndex(-1)
              setBarangayDocuments([])
              setShowBarangayRejectModal(false)
              setBarangayRejectReason("")
            }}
          >
            {barangayDocuments.length > 1 && (
              <button
                onClick={goToPrevBarangayDoc}
                className="absolute left-4 top-1/2 -translate-y-1/2 bg-white/10 hover:bg-white/20 text-white rounded-full p-2 transition-colors z-20"
                title="Previous document"
              >
                <ChevronLeft className="h-8 w-8" />
              </button>
            )}

            {barangayDocuments.length > 1 && (
              <button
                onClick={goToNextBarangayDoc}
                className="absolute right-4 top-1/2 -translate-y-1/2 bg-white/10 hover:bg-white/20 text-white rounded-full p-2 transition-colors z-20"
                title="Next document"
              >
                <ChevronRight className="h-8 w-8" />
              </button>
            )}

            <div
              className="bg-card rounded-lg max-w-[90vw] w-full max-h-[96vh] overflow-y-auto"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="relative flex items-center justify-center px-2 py-2 border-b border-border sticky top-0 bg-card z-10">
                <div className="text-center">
                  <h3 className="text-lg font-semibold text-foreground">{barangayActiveDocument.requirement.name}</h3>
                  <p className="text-xs text-muted-foreground">
                    Document {barangaySelectedDocIndex + 1} of {barangayDocuments.length}
                  </p>
                </div>
                <button
                  onClick={() => {
                    if (isBarangayActionLoading) return
                    setBarangayPreview(null)
                    setBarangaySelectedDocIndex(-1)
                    setBarangayDocuments([])
                    setShowBarangayRejectModal(false)
                    setBarangayRejectReason("")
                  }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              <div className="p-0">
                {barangayActiveDocument.requirement.files && barangayActiveDocument.requirement.files.length > 1 ? (
                  <div className="flex flex-col gap-4 p-0 overflow-y-auto">
                    {barangayActiveDocument.requirement.files.map((f, idx) => {
                      const isFileLoading = barangayImageLoading || barangayLoadingFiles.has(f.id)
                      const isPdf = (f.fileName || "").toLowerCase().endsWith(".pdf")
                      return (
                        <div key={f.id} className="w-full">
                          <div className="relative w-full h-[98vh]" style={{ minHeight: "98vh" }}>
                            {isFileLoading && (
                              <div className="absolute inset-0 flex items-center justify-center bg-muted/50 rounded-md z-10">
                                <Loader2 className="h-8 w-8 animate-spin text-primary" />
                              </div>
                            )}
                            {isPdf ? (
                              <iframe
                                title={barangayActiveDocument.requirement.name}
                                src={f.downloadUrl || ""}
                                className={`w-full h-full border-0 ${isFileLoading ? "opacity-0" : "opacity-100"}`}
                                onLoad={() => handleBarangayImageLoaded(f.id)}
                              />
                            ) : (
                              <Image
                                src={f.downloadUrl || "/placeholder.svg"}
                                alt={barangayActiveDocument.requirement.name}
                                fill
                                sizes="(max-width: 768px) 100vw, 80vw"
                                className={`object-contain rounded-md w-full h-full transition-opacity ${isFileLoading ? "opacity-0" : "opacity-100"}`}
                                priority
                                unoptimized
                                onLoad={() => handleBarangayImageLoaded(f.id)}
                                onError={() => handleBarangayImageLoaded(f.id)}
                              />
                            )}
                          </div>
                          {idx !== barangayActiveDocument.requirement.files.length - 1 && (
                            <div className="h-2 bg-border w-full my-2" />
                          )}
                        </div>
                      )
                    })}
                  </div>
                ) : (
                  <div className="relative w-full h-[98vh]" style={{ minHeight: "98vh" }}>
                    {(barangayImageLoading || barangayLoadingFiles.has(barangayActiveDocument.file.id)) && (
                      <div className="absolute inset-0 flex items-center justify-center bg-muted/50 rounded-md">
                        <Loader2 className="h-8 w-8 animate-spin text-primary" />
                      </div>
                    )}
                    {(() => {
                      const isPdf = (barangayActiveDocument.file.fileName || "").toLowerCase().endsWith(".pdf")
                      if (isPdf) {
                        return (
                          <iframe
                            title={barangayActiveDocument.requirement.name}
                            src={barangayActiveDocument.file.downloadUrl || ""}
                            className={`w-full h-full border-0 ${(barangayImageLoading || barangayLoadingFiles.has(barangayActiveDocument.file.id)) ? "opacity-0" : "opacity-100"}`}
                            onLoad={() => handleBarangayImageLoaded(barangayActiveDocument.file.id)}
                          />
                        )
                      }
                      return (
                        <Image
                          src={barangayActiveDocument.file.downloadUrl || "/placeholder.svg"}
                          alt={barangayActiveDocument.requirement.name}
                          fill
                          sizes="(max-width: 768px) 100vw, 80vw"
                          className={`object-contain rounded-md w-full h-full transition-opacity ${(barangayImageLoading || barangayLoadingFiles.has(barangayActiveDocument.file.id)) ? "opacity-0" : "opacity-100"}`}
                          priority
                          unoptimized
                          onLoad={() => handleBarangayImageLoaded(barangayActiveDocument.file.id)}
                          onError={() => handleBarangayImageLoaded(barangayActiveDocument.file.id)}
                        />
                      )
                    })()}
                  </div>
                )}
              </div>

              <div className="flex flex-col gap-3 p-4 border-t border-border sticky bottom-0 bg-card sm:flex-row">
                <Button
                  className="flex-1 bg-primary hover:bg-primary/90 text-white disabled:opacity-70"
                  onClick={(e) => {
                    e.stopPropagation()
                    handleBarangayApprove()
                  }}
                  disabled={isBarangayActionLoading}
                >
                  <CheckCircle className="h-4 w-4 mr-2" />
                  {isBarangayActionLoading ? "Saving..." : "Approve"}
                </Button>
                <Button
                  variant="destructive"
                  className="flex-1 disabled:opacity-70"
                  onClick={(e) => {
                    e.stopPropagation()
                    setShowBarangayRejectModal(true)
                  }}
                  disabled={isBarangayActionLoading}
                >
                  <XCircle className="h-4 w-4 mr-2" />
                  Reject
                </Button>
              </div>
            </div>
          </div>
        )}

        {showBarangayRejectModal && barangayPreview && (
          <div
            className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
            onClick={() => {
              if (isBarangayActionLoading) return
              setShowBarangayRejectModal(false)
              setBarangayRejectReason("")
            }}
          >
            <div
              className="bg-card rounded-lg max-w-md w-full p-6"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold text-foreground">Reason for Rejection</h3>
                <button
                  onClick={() => {
                    if (isBarangayActionLoading) return
                    setShowBarangayRejectModal(false)
                    setBarangayRejectReason("")
                  }}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
              <p className="text-sm text-muted-foreground mb-4">
                Please provide a reason for rejecting "{barangayPreview.requirementName}".
              </p>
              <textarea
                value={barangayRejectReason}
                onChange={(e) => setBarangayRejectReason(e.target.value)}
                placeholder="Enter rejection reason..."
                className="w-full p-3 border border-border rounded-md bg-background text-foreground min-h-[120px] mb-4 focus:outline-none focus:ring-2 focus:ring-primary"
              />
              <div className="flex gap-3">
                <Button
                  variant="outline"
                  className="flex-1 bg-transparent"
                  onClick={() => {
                    if (isBarangayActionLoading) return
                    setShowBarangayRejectModal(false)
                    setBarangayRejectReason("")
                  }}
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  className="flex-1 disabled:opacity-70"
                  onClick={(e) => {
                    e.stopPropagation()
                    handleBarangayRejectConfirm()
                  }}
                  disabled={isBarangayActionLoading || !barangayRejectReason.trim()}
                >
                  {isBarangayActionLoading ? "Saving..." : "Confirm Rejection"}
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

  if (isLoggedIn && effectivePage === "clearance-clients") {
      return renderWithSidebar(
        <div className="flex-1 flex flex-col p-6 max-w-6xl mx-auto w-full">
          <div className="mb-8">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-lg bg-primary/10 flex items-center justify-center">
                  <Award className="h-6 w-6 text-primary" />
                </div>
                <div>
                  <h1 className="text-3xl font-bold text-foreground">Mayor&apos;s Clearance</h1>
                  <p className="text-muted-foreground">Generate and manage clearance documents</p>
                </div>
              </div>
              <div className="text-right">
                <p className="text-2xl font-semibold text-primary">
                  {clearanceRecordsLoading ? "..." : filteredClearanceRecords.length}
                </p>
                <p className="text-sm text-muted-foreground">Available Records</p>
              </div>
            </div>
          </div>

          <div className="mb-6 bg-card rounded-lg p-4">
            <h2 className="text-lg font-semibold text-foreground mb-3">Clearance Records</h2>
            {clearanceRecordsLoading && (
              <div className="text-sm text-muted-foreground">Loading records...</div>
            )}

            {!clearanceRecordsLoading && clearanceRecords.length === 0 && (
              <div className="text-sm text-muted-foreground">No clearance records available yet.</div>
            )}

            {!clearanceRecordsLoading && clearanceRecords.length > 0 && (
              <div className="space-y-4">
                <div className="flex flex-col gap-3">
                  <div className="flex items-center">
                    <Input
                      placeholder="Search name, address, or number..."
                      value={clearanceRecordSearch}
                      onChange={(e) => setClearanceRecordSearch(e.target.value)}
                      className="w-full md:w-72"
                    />
                  </div>
                  <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                    <div className="flex flex-wrap gap-2">
                    <Button
                      variant={clearanceRecordRange === "monthly" ? "default" : "outline"}
                      onClick={() => setClearanceRecordRange("monthly")}
                      className={clearanceRecordRange === "monthly" ? "bg-primary hover:bg-primary/90 text-white" : ""}
                    >
                      Monthly
                    </Button>
                    <Button
                      variant={clearanceRecordRange === "yearly" ? "default" : "outline"}
                      onClick={() => setClearanceRecordRange("yearly")}
                      className={clearanceRecordRange === "yearly" ? "bg-primary hover:bg-primary/90 text-white" : ""}
                    >
                      Yearly
                    </Button>
                    </div>

                    <div className="flex items-center gap-2 md:justify-end">
                      <Select
                        value={clearanceRecordYear ? String(clearanceRecordYear) : ""}
                        onValueChange={(value) => setClearanceRecordYear(Number(value))}
                        disabled={clearanceRecordYears.length === 0}
                      >
                        <SelectTrigger className="w-[160px]">
                          <SelectValue placeholder="Select year" />
                        </SelectTrigger>
                        <SelectContent>
                          {clearanceRecordYears.map((year) => (
                            <SelectItem key={year} value={String(year)}>
                              {year}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  {clearanceRecordRange === "monthly" && (
                    <div className="flex items-center gap-2">
                      <Select
                        value={clearanceRecordMonth !== null ? String(clearanceRecordMonth) : ""}
                        onValueChange={(value) => setClearanceRecordMonth(Number(value))}
                      >
                        <SelectTrigger className="w-[180px]">
                          <SelectValue placeholder="Select month" />
                        </SelectTrigger>
                        <SelectContent>
                          {[
                            "January",
                            "February",
                            "March",
                            "April",
                            "May",
                            "June",
                            "July",
                            "August",
                            "September",
                            "October",
                            "November",
                            "December",
                          ].map((label, index) => (
                            <SelectItem key={label} value={String(index)}>
                              {label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => setClearanceRecordMonth(null)}
                      >
                        Clear
                      </Button>
                    </div>
                  )}


                  <div className="flex items-center justify-end gap-2">
                    <Button
                      onClick={handleDownloadSavedClearance}
                      disabled={clearanceFilesLoading}
                    >
                      <Download className="h-4 w-4 mr-2" />
                      Download Clearance File
                    </Button>
                  </div>
                </div>

                {filteredClearanceRecords.length === 0 && clearanceRecordYear && (
                  <div className="rounded-lg border border-dashed border-muted-foreground/40 px-4 py-6 text-center text-sm text-muted-foreground">
                    No records available for {clearanceRecordYear}.
                  </div>
                )}

                {filteredClearanceRecords.length > 0 && (
                  <div className="overflow-x-auto">
                    <table className="w-full border-collapse">
                      <thead>
                        <tr className="bg-primary text-white">
                          <th className="border border-border p-3 text-center">No.</th>
                          <th className="border border-border p-3 text-center">Full Name</th>
                          <th className="border border-border p-3 text-center">Address</th>
                          <th className="border border-border p-3 text-center">Contact No.</th>
                          <th className="border border-border p-3 text-center">Application Date</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredClearanceRecords.map((record, idx) => (
                          <tr
                            key={record.id}
                            className={`${idx % 2 === 0 ? "bg-background" : "bg-muted/30"} transition-colors`}
                          >
                            <td className="border border-border p-3 text-center text-muted-foreground">{idx + 1}</td>
                            <td className="border border-border p-3 text-center">
                              {record.fullName || "—"}
                            </td>
                            <td className="border border-border p-3 text-center">
                              {record.address || "—"}
                            </td>
                            <td className="border border-border p-3 text-center text-muted-foreground">
                              {record.phone || "—"}
                            </td>
                            <td className="border border-border p-3 text-center text-muted-foreground">
                              {record.date ? formatDateWithSlash(record.date) : "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>

        </div>
    )
  }

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <Header tall={currentPage === "login"} />

      <main className="flex-1 flex items-center justify-center px-4 bg-gradient-to-br from-orange-50 to-white">
        <div className="w-full max-w-5xl grid grid-cols-1 md:[grid-template-columns:2fr_1fr] gap-0 items-stretch">
          <div className="hidden md:flex items-stretch">
            <div className="bg-card border border-border border-r-0 rounded-l-xl p-0 shadow-md flex items-center justify-center md:h-[440px] w-full overflow-hidden">
              <Image src="/images/sabangan-lgu-building.png" alt="Sabangan Seal" width={520} height={520} className="object-cover w-full h-full rounded-l-xl transform scale-110" />
            </div>
          </div>

          <div className="w-full flex items-center justify-center">
            <div className="w-full max-w-md md:max-w-none bg-card border border-border border-l-0 rounded-r-xl p-8 shadow-md text-left md:h-[440px]">
              <div className="flex items-center gap-3 mb-6">
                <div className="w-12 h-12 rounded-full bg-primary flex items-center justify-center">
                  <LogIn className="h-6 w-6 text-white" />
                </div>
                <div>
                  <h1 className="text-2xl font-semibold text-foreground">Sign in to BOSS</h1>
                  <p className="text-sm text-muted-foreground">Use your staff account to continue</p>
                </div>
              </div>

              <form className="space-y-4" onSubmit={handleLogin}>
                <div>
                  <Label htmlFor="email" className="text-sm font-medium text-foreground">
                    Email
                  </Label>
                  <Input
                    id="email"
                    type="email"
                    autoComplete="email"
                    placeholder="staff@municipality.gov"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="mt-1"
                  />
                </div>

                <div>
                  <Label htmlFor="password" className="text-sm font-medium text-foreground">
                    Password
                  </Label>
                  <div className="relative mt-1">
                    <Input
                      id="password"
                      type={showPassword ? "text" : "password"}
                      autoComplete="current-password"
                      placeholder="Enter your password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="pr-10"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>

                {loginError && <p className="text-sm text-red-600">{loginError}</p>}

                {loginVerificationStatus === "unverified" && (
                  <div className="mt-4 rounded-lg border border-yellow-200 bg-yellow-50 p-4">
                    <Badge variant="secondary" className="bg-yellow-100 text-yellow-800 border-transparent uppercase tracking-wide">
                      Email Not Verified
                    </Badge>
                    <p className="mt-2 text-sm text-yellow-900">
                      Check <span className="font-semibold">{email || "your inbox"}</span> for the verification link to continue.
                    </p>
                  </div>
                )}

                <Button
                  type="submit"
                  size="lg"
                  disabled={isAuthLoading}
                  className="w-full px-6 py-3 text-base bg-primary hover:bg-primary/90 text-white disabled:opacity-70"
                >
                  {isAuthLoading ? "Logging in..." : "Login"}
                </Button>
              </form>

{/* create account removed */}
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}


