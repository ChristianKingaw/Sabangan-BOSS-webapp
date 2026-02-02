"use client"

import { useState, useEffect, useCallback, useMemo, useRef, type FormEvent, type MouseEvent, type ReactNode } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { LogIn, Eye, EyeOff, LogOut, Search, FileText, XCircle, Award, Download, LayoutDashboard, CalendarDays, Check, Loader2, MessageSquare, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
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
import { onValue, ref, off, get } from "firebase/database"
import { cn } from "@/lib/utils"
import { handlePrintHtml, handlePrintPdf } from "@/lib/print"
import { toast } from "sonner"
import { mergePdfUrls } from "@/lib/pdf"
import { PDFDocument } from "pdf-lib"
import {
  BUSINESS_APPLICATION_PATH,
  type ApplicationType,
  type BusinessApplicationRecord,
  parseDateToTimestamp,
  getStatusBadge,
  normalizeBusinessApplication,
  buildRequirementNotificationId,
} from "@/lib/business-applications"

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

const buildNotificationEvents = (records: BusinessApplicationRecord[]): NotificationEvent[] => {
  const events: NotificationEvent[] = []

  records.forEach((record) => {
    const targetName = record.applicantName || record.businessName || "Unnamed Applicant"

    const submittedAt = record.submittedAt ?? parseDateToTimestamp(record.applicationDate)

    const allRequirementUploads: number[] = []
    const recentRequirementUploads: number[] = []

    record.requirements.forEach((requirement) => {
      requirement.files.forEach((file) => {
        if (typeof file.uploadedAt !== "number") {
          return
        }

        allRequirementUploads.push(file.uploadedAt)
        if (isWithinRecentNotificationWindow(file.uploadedAt)) {
          recentRequirementUploads.push(file.uploadedAt)
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

      const notificationId =
        buildRequirementNotificationId(record) ?? `requirements-${record.id}-${latestRequirementUpload}`

      events.push({
        id: notificationId,
        clientId: record.id,
        entityName: targetName,
        action: hadEarlierUploads
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
type TypeFilterType = "All" | ApplicationType
type PageType = "login" | "home" | "clients" | "clearance-clients" | "lgu-status"

const allowedPages: PageType[] = ["login", "home", "clients", "clearance-clients", "lgu-status"]
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
  const [closureDateFilter, setClosureDateFilter] = useState<Date | undefined>(undefined)
  const [clients, setClients] = useState<BusinessApplicationRecord[]>([])
  const [clientsLoading, setClientsLoading] = useState(false)
  const [clientsError, setClientsError] = useState<string | null>(null)
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
  const docxPreviewCancelRef = useRef(false)
  const docxPreviewAbortRef = useRef<AbortController | null>(null)
  const [docxPreviewClientId, setDocxPreviewClientId] = useState<string | null>(null)

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
  const generateAndSaveClearanceFileRef = useRef<(() => Promise<void>) | null>(null)
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
        return normalized.includes("approve")
      }),
    [clients]
  )

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
      const snapshot = await get(ref(realtimeDb, BUSINESS_APPLICATION_PATH))
      const node = snapshot.exists() ? (snapshot.val() as Record<string, any>) : {}
      const computedLastMap: Record<string, number> = {}
      for (const [id, payload] of Object.entries(node)) {
        try {
          const lastClientTs = getLatestClientMessageTimestamp(payload)
          if (lastClientTs === undefined) continue
          computedLastMap[id] = lastClientTs
        } catch {}
      }
      setLatestClientTsMap(computedLastMap)
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
      setMessengerLastReadMap({})
      setIsMessengerLastReadLoaded(false)
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
    const hasCurrentYearFile = clearanceFiles.some((f) => (f.fileName || "").includes(String(currentYear)))
    if (hasCurrentYearFile) {
      setClearanceAutoAttempted(true)
      return
    }

    generateAndSaveClearanceFileRef.current
      ? generateAndSaveClearanceFileRef.current()
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

    const fingerprint = approvedClients
      .map((c) => `${c.id}:${(c.overallStatus || c.status || "").toLowerCase()}`)
      .sort()
      .join("|")

    if (approvedSnapshotRef.current === fingerprint) return
    approvedSnapshotRef.current = fingerprint

    if (approvedClients.length === 0) {
      // If there are no approved clients, clear any saved files to keep state
      // consistent with the current approvals.
      setIsClearanceGenerating(true)
      ;(async () => {
        try {
          await clearClearanceFiles()
        } catch (err) {
          console.error("Failed to clear clearance files on approvedClients change", err)
        } finally {
          setIsClearanceGenerating(false)
        }
      })()
      return
    }

    // Regenerate the clearance file to reflect the latest approved clients.
    setIsClearanceGenerating(true)
    ;(async () => {
      try {
        await clearClearanceFiles()
        await generateAndSaveClearanceFileRef.current?.()
      } catch (err) {
        console.error("Auto-regenerate clearance file failed", err)
      } finally {
        setIsClearanceGenerating(false)
      }
    })()
  }, [approvedClients, isLoggedIn, clientsLoading, isClearanceGenerating])

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

    const businessRef = ref(realtimeDb, BUSINESS_APPLICATION_PATH)
    const unsub = onValue(businessRef, (snapshot) => {
      const node = snapshot.val() || {}
      const computedLastMap: Record<string, number> = {}
      try {
        for (const [id, payload] of Object.entries(node)) {
          try {
            const lastClientTs = getLatestClientMessageTimestamp(payload)
            if (lastClientTs === undefined) continue
            computedLastMap[id] = lastClientTs
          } catch {}
        }
        setLatestClientTsMap(computedLastMap)
      } catch {}
    })

    return () => {
      try { if (typeof unsub === 'function') unsub() } catch {}
      try { off(businessRef) } catch {}
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

                          const imgWidth = embedded.width || 600
                          const imgHeight = embedded.height || 800
                          const page = pdfDoc.addPage([imgWidth, imgHeight])
                          page.drawImage(embedded, { x: 0, y: 0, width: imgWidth, height: imgHeight })
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

  const formatDateWithSlash = (input: string | Date | null | undefined) => {
    if (!input) return ""

    const toParts = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`

    if (input instanceof Date) {
      return toParts(input)
    }

    const normalized = String(input).trim().replace(/-/g, "/")
    const parsed = new Date(normalized)
    if (!Number.isNaN(parsed.getTime())) {
      return toParts(parsed)
    }

    // Fallback: just return the normalized string with slashes
    return normalized
  }

  const extractBarangayOnly = (raw: string | null | undefined) => {
    if (!raw) return ""
    const firstSegment = raw
      .split(/[,\n;]/)
      .map((part) => part.trim())
      .find(Boolean)

    const base = (firstSegment || raw).trim()
    const cleaned = base
      .replace(/\b(Sabangan|Mountain\s*Province|Mt\.?\s*Province)\b/gi, "")
      .replace(/\s+/g, " ")
      .trim()

    return cleaned || base
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
    if (approvedClients.length === 0) {
      toast.error("No approved clients available for Mayor's Clearance.")
      return
    }
    setIsClearanceGenerating(true)
    try {
      await clearClearanceFiles()
      await generateAndSaveClearanceFileRef.current?.()
      toast.success("Mayor's Clearance has been refreshed.")
    } catch (err) {
      console.error("Failed to refresh Mayor's Clearance", err)
      toast.error("Unable to refresh the Mayor's Clearance file.")
    } finally {
      setIsClearanceGenerating(false)
    }
  }

  const generateAndSaveClearanceFile = useCallback(async () => {
    const today = new Date()
    const year = today.getFullYear()
    const todayLabel = formatDateWithSlash(today)
    let templateBuffer: ArrayBuffer | null = null

    if (approvedClients.length === 0) {
      toast.error("No approved clients available for Mayor's Clearance.")
      return
    }

    try {
      templateBuffer = await fetchClearanceTemplate()
    } catch (err) {
      console.error("Failed to load Mayor's Clearance template", err)
      toast.error("Unable to load the Mayor's Clearance template. Please try again.")
      return
    }

    if (!templateBuffer) {
      toast.error("Mayor's Clearance template could not be loaded.")
      return
    }

    const workbook = new ExcelJS.Workbook()
    try {
      await workbook.xlsx.load(templateBuffer)
    } catch (err) {
      console.error("Failed to parse Mayor's Clearance template", err)
      toast.error("Mayor's Clearance template is corrupted. Please refresh and try again.")
      return
    }
    const sheet = workbook.worksheets[0] ?? workbook.getWorksheet(1)

    if (!sheet) {
      toast.error("Mayor's Clearance template is missing a worksheet.")
      return
    }

    // Keep the template header intact (yellow styling) and clear any existing data rows.
    const headerRowIndex = 1
    if (sheet.rowCount > headerRowIndex) {
      sheet.spliceRows(headerRowIndex + 1, sheet.rowCount - headerRowIndex)
    }

    const dataRows = approvedClients.map((client, index) => {
      const form = client.form || {}
      const middleName = String(form.middleName ?? "").trim()
      const middleInitial = middleName ? `${middleName.charAt(0).toUpperCase()}.` : ""
      const barangay = extractBarangayOnly(form.barangay ?? form.businessAddress ?? "")
      const applicationDate = formatDateWithSlash(form.dateOfApplication ?? form.registrationDate ?? "")

      return [
        index + 1,
        todayLabel,
        applicationDate,
        form.firstName ?? "",
        middleName,
        middleInitial,
        form.lastName ?? "",
        barangay,
        "Sabangan, Mountain Province",
        "",
        "",
        "",
        "Securing Business Permit",
        "",
        "",
      ]
    })

    if (dataRows.length > 0) {
      sheet.addRows(dataRows)
    }

    const buffer = await workbook.xlsx.writeBuffer()
    const fileName = `Mayor's Clearance ${year}.xlsx`

    const base64 = arrayBufferToBase64(buffer)
    const user = firebaseAuth.currentUser
    await saveClearanceFile({
      fileName,
      createdAt: Date.now(),
      rowCount: approvedClients.length,
      dataBase64: base64,
      createdBy: user?.uid ?? null,
    })
  }, [approvedClients, fetchClearanceTemplate, arrayBufferToBase64, formatDateWithSlash, extractBarangayOnly, saveClearanceFile, firebaseAuth])

  useEffect(() => {
    generateAndSaveClearanceFileRef.current = generateAndSaveClearanceFile
  }, [generateAndSaveClearanceFile])

  const normalizedClientSearch = searchQuery.trim().toLowerCase()
  const filteredClients = clients
    .filter((client) => {
      const matchesType = typeFilter === "All" || client.applicationType === typeFilter
      const haystack = [client.applicantName, client.businessName]
        .filter(Boolean)
        .map((value) => value.toLowerCase())
      const matchesSearch = !normalizedClientSearch || haystack.some((value) => value.includes(normalizedClientSearch))
      const matchesDate = (() => {
        if (!applicationDateFilter) {
          return true
        }
        if (!client.applicationDate) {
          return false
        }
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

  const handleDownloadSavedClearance = (record: ClearanceFileWithId) => {
    try {
      const blob = base64ToBlob(record.dataBase64)
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = record.fileName || "Mayor's Clearance.xlsx"
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (err) {
      console.error("Failed to download saved clearance file", err)
      toast.error("Unable to download that file.")
    }
  }

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
                  "w-full relative flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition",
                  isActive
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/40"
                )}
              >
                <Icon className="h-4 w-4" />
                <span className="relative inline-flex items-center">
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
            variant="outline"
            className="w-full justify-center gap-2"
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
                  "relative flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-medium whitespace-nowrap",
                  isActive ? "bg-primary text-primary-foreground" : "bg-muted text-foreground"
                )}
              >
                <Icon className="h-4 w-4" />
                <span className="relative inline-flex items-center">
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
        <main className="flex-1 p-6 max-w-4xl w-full">
          <h1 className="text-3xl font-bold text-foreground mb-8">Welcome to BOSS</h1>
          
          <div className="bg-card border border-border rounded-lg p-6 md:fixed md:right-6 md:top-20 md:w-96 md:max-h-[80vh] md:overflow-auto z-50">
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
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-3xl font-bold text-primary">Business Application</h2>
        </div>

          
          <div className="mb-6 relative">
            <div className="flex items-center">
              <div className="flex-none">
                <Input
                  placeholder="Search by client name..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full max-w-xs"
                />
              </div>
            </div>

            <div className="absolute left-1/2 transform -translate-x-1/2 flex gap-2">
              <Button
                variant={typeFilter === "All" ? "default" : "outline"}
                onClick={() => setTypeFilter("All")}
                className={typeFilter === "All" ? "bg-primary hover:bg-primary/90 text-white" : ""}
              >
                All
              </Button>
              <Button
                variant={typeFilter === "New" ? "default" : "outline"}
                onClick={() => setTypeFilter("New")}
                className={typeFilter === "New" ? "bg-primary hover:bg-primary/90 text-white" : ""}
              >
                New
              </Button>
              <Button
                variant={typeFilter === "Renewal" ? "default" : "outline"}
                onClick={() => setTypeFilter("Renewal")}
                className={typeFilter === "Renewal" ? "bg-primary hover:bg-primary/90 text-white" : ""}
              >
                Renewal
              </Button>
            </div>
          </div>

          <div className="mb-6">
            <p className="text-sm text-muted-foreground mb-4">
              Total Clients: {clientsLoading ? "Loading..." : filteredClients.length}
            </p>
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
                  <th className="border border-border p-3 text-center">
                    <Popover>
                      <PopoverTrigger asChild>
                        <button className="flex items-center justify-center gap-2 hover:opacity-80 transition-opacity w-full text-center">
                          Application Date
                          <CalendarDays className="h-4 w-4" />
                          {applicationDateFilter && (
                            <span className="text-xs bg-white/20 px-2 py-0.5 rounded">
                              {applicationDateFilter.toLocaleDateString()}
                            </span>
                          )}
                        </button>
                      </PopoverTrigger>
                      <PopoverContent className="w-auto p-0" align="start">
                        <div className="p-2 border-b">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setApplicationDateFilter(undefined)}
                            className="w-full text-sm"
                          >
                            Clear Filter
                          </Button>
                        </div>
                        <Calendar
                          mode="single"
                          selected={applicationDateFilter}
                          onSelect={setApplicationDateFilter}
                        />
                      </PopoverContent>
                    </Popover>
                  </th>
                  <th className="border border-border p-3 text-center">Status</th>
                  <th className="border border-border p-3 text-center">Application Form/Requirements</th>
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
                          if (!client.applicationDate) {
                            return "—"
                          }
                          const date = new Date(client.applicationDate)
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
                        <div className="flex gap-2 justify-center">
                          <Button
                            size="lg"
                            onClick={(e) => handlePrintApplicationForm(client.id, e)}
                            className="bg-primary hover:bg-primary/90 text-white"
                          >
                            Preview
                          </Button>
                          {/* Sworn Docx button removed: sworn content is now merged into main preview */}
                          {/* Download button removed for Business Application list */}
                        </div>
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

  if (isLoggedIn && effectivePage === "clearance-clients") {
      return renderWithSidebar(
        <div className="flex-1 flex flex-col p-6 max-w-6xl mx-auto w-full">
          <div className="flex items-center justify-between mb-6">
            <h1 className="text-3xl font-bold text-foreground">Mayor&apos;s Clearance</h1>
          </div>

          <div className="mb-6 bg-card border border-border rounded-lg p-4">
            <h2 className="text-lg font-semibold text-foreground mb-3">Saved Clearance Files</h2>
            {clearanceFilesLoading && (
              <div className="text-sm text-muted-foreground">Loading files...</div>
            )}
            {!clearanceFilesLoading && clearanceFiles.length === 0 && (
              <div className="text-sm text-muted-foreground">No saved files yet. Generate one to see it here.</div>
            )}
            {!clearanceFilesLoading && clearanceFiles.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full border border-border rounded-md overflow-hidden text-sm">
                  <thead className="bg-orange-500 text-white">
                    <tr>
                      <th className="px-3 py-2 text-left w-12">#</th>
                      <th className="px-3 py-2 text-left">File Name</th>
                      <th className="px-3 py-2 text-left w-32">Total Clients</th>
                      <th className="px-3 py-2 text-left w-28">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {clearanceFiles
                      .filter((file) => (file.fileName && file.fileName.trim()) || file.rowCount > 0)
                      .map((file, idx) => (
                        <tr key={file.id} className="border-t border-border">
                          <td className="px-3 py-2 text-muted-foreground">{idx + 1}</td>
                          <td className="px-3 py-2">
                            <div className="font-medium text-foreground">{file.fileName || "Mayor's Clearance.xlsx"}</div>
                            <div className="text-xs text-muted-foreground">{new Date(file.createdAt).toLocaleString()}</div>
                          </td>
                          <td className="px-3 py-2 text-foreground">{file.rowCount}</td>
                          <td className="px-3 py-2">
                            <Button size="sm" variant="outline" onClick={() => handleDownloadSavedClearance(file)}>
                              <Download className="h-4 w-4 mr-2" />
                              Download
                            </Button>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
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


