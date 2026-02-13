"use client"

import { useState, Suspense, useEffect, useCallback, useMemo, useRef } from "react"
import { useParams, useRouter, useSearchParams } from "next/navigation"
import {
  ArrowLeft,
  X,
  CheckCircle,
  XCircle,
  Loader2,
  ChevronLeft,
  ChevronRight,
  Printer,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import Image from "next/image"
import Header from "@/components/header"
import { toast } from "sonner"
import { onValue, ref, get } from "firebase/database"
import { onAuthStateChanged } from "firebase/auth"
import { app as firebaseApp, realtimeDb, auth as firebaseAuth } from "@/database/firebase"
import {
  BUSINESS_APPLICATION_PATH,
  buildRequirementNotificationId,
  getStatusBadge,
  normalizeBusinessApplication,
  type BusinessApplicationRecord,
  type BusinessRequirement,
} from "@/lib/business-applications"
import Chat from "@/components/ui/chat"
// Import necessary libraries for rendering docx files
import { renderAsync } from "docx-preview";
import { handlePrintHtml, handlePrintPdf } from "@/lib/print"
import { mergePdfUrls } from "@/lib/pdf"
import { PDFDocument } from "pdf-lib"

const MS_IN_DAY = 24 * 60 * 60 * 1000
const NEW_LOOKBACK_DAYS = 30

const getClientNotificationId = (record: BusinessApplicationRecord | null) =>
  record ? buildRequirementNotificationId(record) ?? `requirements-${record.id}` : null

type LocalDocumentStatus = {
  status: "approved" | "rejected" | "awaiting-review"
  reason?: string
}

type RequirementDocumentItem = {
  id: string
  requirement: BusinessRequirement
  requirementIndex: number
  file: BusinessRequirement["files"][number]
  fileIndex: number
}

// Firebase RTDB keys cannot include . # $ [ ] or /. Ensure string conversion first.
const sanitizeKey = (value: unknown) => (String(value ?? "").replace(/[.#$\[\]/]/g, "-") || "-")

// Firebase REST API helper to bypass SDK cache issues (ChildrenNode.equals recursion)
const FIREBASE_DB_URL = process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL || ""

async function firebaseRestUpdate(
  path: string,
  data: Record<string, unknown>,
  idToken: string
): Promise<void> {
  const url = `${FIREBASE_DB_URL}/${path}.json?auth=${encodeURIComponent(idToken)}`
  const resp = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  })
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "")
    throw new Error(`Firebase REST update failed: ${resp.status} ${errText}`)
  }
}

async function firebaseRestSet(
  path: string,
  data: unknown,
  idToken: string
): Promise<void> {
  const url = `${FIREBASE_DB_URL}/${path}.json?auth=${encodeURIComponent(idToken)}`
  const resp = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  })
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "")
    throw new Error(`Firebase REST set failed: ${resp.status} ${errText}`)
  }
}

async function firebaseRestPush(
  path: string,
  data: Record<string, unknown>,
  idToken: string
): Promise<string> {
  const url = `${FIREBASE_DB_URL}/${path}.json?auth=${encodeURIComponent(idToken)}`
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  })
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "")
    throw new Error(`Firebase REST push failed: ${resp.status} ${errText}`)
  }
  const result = await resp.json()
  return result?.name ?? ""
}

function ClientRequirementsContent() {
  const renderCountRef = useRef(0)
  renderCountRef.current++
  
  const authUserRestoredRef = useRef<boolean>(false)
  
  // Log on every render
  console.debug(`[Render #${renderCountRef.current}] firebaseAuth exists:`, !!firebaseAuth, "firebaseAuth.currentUser:", firebaseAuth?.currentUser?.uid ?? "null", "authUserRestoredRef:", authUserRestoredRef.current)

  // Use centralized auth from firebase.ts - already initialized with browserLocalPersistence
  const getAuthInstance = useCallback(() => {
    if (!firebaseAuth) {
      console.debug("[getAuthInstance] No firebaseAuth (SSR), returning null")
      return null
    }
    console.debug("[getAuthInstance] Returning centralized firebaseAuth, currentUser:", firebaseAuth.currentUser?.uid ?? "null")
    return firebaseAuth
  }, [])

  // Helper to wait for auth user to be restored after page refresh
  const waitForAuthUser = useCallback(async (): Promise<typeof firebaseAuth extends null ? null : NonNullable<typeof firebaseAuth>["currentUser"]> => {
    const auth = getAuthInstance()
    console.debug("[waitForAuthUser] Called, auth:", auth ? "exists" : "null", "auth.currentUser:", auth?.currentUser?.uid ?? "null")
    if (!auth) return null
    
    // If we already have a user, return immediately
    if (auth.currentUser) {
      console.debug("[waitForAuthUser] User already exists, returning immediately:", auth.currentUser.uid)
      authUserRestoredRef.current = true
      return auth.currentUser
    }
    
    // Always wait for auth state to settle, even if we've waited before
    // Firebase may need time to restore the user from IndexedDB
    console.debug("[waitForAuthUser] Starting auth wait, authUserRestoredRef:", authUserRestoredRef.current)
    return new Promise((resolve) => {
      let resolved = false
      let delayTimeoutId: NodeJS.Timeout | null = null
      let pollIntervalId: NodeJS.Timeout | null = null
      
      const cleanup = () => {
        if (delayTimeoutId) clearTimeout(delayTimeoutId)
        if (pollIntervalId) clearInterval(pollIntervalId)
      }
      
      // Poll every 100ms to check if user was restored
      // This catches cases where IndexedDB restoration happens
      // but onAuthStateChanged doesn't fire again
      pollIntervalId = setInterval(() => {
        if (!resolved && auth.currentUser) {
          console.debug("[waitForAuthUser] Poll found user:", auth.currentUser.uid)
          resolved = true
          authUserRestoredRef.current = true
          cleanup()
          unsubscribe()
          resolve(auth.currentUser)
        }
      }, 100)
      
      const unsubscribe = onAuthStateChanged(auth, (user) => {
        console.debug("[waitForAuthUser] onAuthStateChanged callback, user:", user?.uid ?? "null", "resolved:", resolved)
        if (resolved) return
        if (user) {
          // User restored successfully
          console.debug("[waitForAuthUser] User found, resolving immediately")
          resolved = true
          authUserRestoredRef.current = true
          cleanup()
          unsubscribe()
          resolve(user)
        } else {
          // Got null - wait longer for potential IndexedDB restoration
          if (!delayTimeoutId) {
            console.debug("[waitForAuthUser] Got null, starting 4s delay timer")
            delayTimeoutId = setTimeout(() => {
              if (!resolved) {
                console.debug("[waitForAuthUser] 4s delay completed, currentUser:", auth.currentUser?.uid ?? "null")
                resolved = true
                authUserRestoredRef.current = true
                cleanup()
                unsubscribe()
                // Final check - maybe user was restored during the wait
                resolve(auth.currentUser)
              }
            }, 4000)
          }
        }
      })
      
      // Ultimate timeout after 8 seconds
      setTimeout(() => {
        if (!resolved) {
          console.debug("[waitForAuthUser] 8s ultimate timeout, currentUser:", auth.currentUser?.uid ?? "null")
          resolved = true
          authUserRestoredRef.current = true
          cleanup()
          unsubscribe()
          resolve(auth.currentUser)
        }
      }, 8000)
    })
  }, [getAuthInstance])

  const params = useParams()
  const router = useRouter()
  const searchParams = useSearchParams()
  const rawId = (params as { id?: string | string[] } | undefined)?.id
  const id = Array.isArray(rawId) ? rawId[0] : rawId ?? ""

  const [client, setClient] = useState<BusinessApplicationRecord | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedDocIndex, setSelectedDocIndex] = useState(-1)
  const [documentStatuses, setDocumentStatuses] = useState<Record<string, LocalDocumentStatus>>({})
  const [showRejectModal, setShowRejectModal] = useState(false)
  const [rejectReason, setRejectReason] = useState("")  
  const [imageLoading, setImageLoading] = useState(false)
  const [loadingFiles, setLoadingFiles] = useState<Set<string>>(new Set())
  const [isPersisting, setIsPersisting] = useState(false)
  const [isAuthReady, setIsAuthReady] = useState(false)

  // Define state variables for docx modal and content
  const [docxContent, setDocxContent] = useState<string | null>(null)
  const [isDocxModalOpen, setIsDocxModalOpen] = useState(false)
  const [isDocxLoading, setIsDocxLoading] = useState(false)
  const [docxPdfUrl, setDocxPdfUrl] = useState<string | null>(null)
  const [isFormPreviewLoading, setIsFormPreviewLoading] = useState(false)
  const [isFormPreviewModalOpen, setIsFormPreviewModalOpen] = useState(false)
  const [formPreviewUrl, setFormPreviewUrl] = useState<string | null>(null)
  const [formPreviewTempUrls, setFormPreviewTempUrls] = useState<string[]>([])
  const docxPreviewCancelRef = useRef(false)
  const formPreviewCancelRef = useRef(false)
  const formPreviewAbortRef = useRef<AbortController | null>(null)

  // Wait for Firebase Auth to be ready
  useEffect(() => {
    const auth = getAuthInstance()
    if (!auth) {
      console.debug("[Auth] No auth instance, setting ready")
      setIsAuthReady(true)
      return
    }

    let cancelled = false
    
    const waitForAuth = async () => {
      console.debug("[Auth] Starting auth wait, currentUser:", auth.currentUser?.uid ?? "null")
      
      try {
        // authStateReady() returns a promise that resolves when initial auth state is determined
        // This is available in Firebase 9.22+
        if (typeof (auth as any).authStateReady === "function") {
          console.debug("[Auth] Using authStateReady()")
          await (auth as any).authStateReady()
          console.debug("[Auth] authStateReady resolved, currentUser:", auth.currentUser?.uid ?? "null")
        } else {
          // Fallback for older Firebase versions:
          // Wait for onAuthStateChanged, but if we get null, wait a bit more
          // in case the user is being restored from IndexedDB
          console.debug("[Auth] Using onAuthStateChanged fallback")
          await new Promise<void>((resolve) => {
            let resolved = false
            let delayTimeoutId: NodeJS.Timeout | null = null
            
            const unsubscribe = onAuthStateChanged(auth, (user) => {
              console.debug("[Auth] onAuthStateChanged callback, user:", user?.uid ?? "null", "resolved:", resolved)
              if (resolved) return
              
              if (user) {
                // User found - definitely authenticated, resolve immediately
                console.debug("[Auth] User found, resolving immediately")
                resolved = true
                if (delayTimeoutId) clearTimeout(delayTimeoutId)
                unsubscribe()
                resolve()
              } else {
                // Got null - could be "not logged in" or "still loading"
                // Wait 3 seconds to allow IndexedDB restoration to complete
                if (!delayTimeoutId) {
                  console.debug("[Auth] Got null, starting 3s delay timer")
                  delayTimeoutId = setTimeout(() => {
                    if (!resolved) {
                      console.debug("[Auth] 3s delay completed, currentUser:", auth.currentUser?.uid ?? "null")
                      resolved = true
                      unsubscribe()
                      resolve()
                    }
                  }, 3000)
                }
              }
            })
            
            // Final timeout after 6 seconds as ultimate fallback
            setTimeout(() => {
              if (!resolved) {
                console.debug("[Auth] 6s ultimate timeout, currentUser:", auth.currentUser?.uid ?? "null")
                resolved = true
                if (delayTimeoutId) clearTimeout(delayTimeoutId)
                unsubscribe()
                resolve()
              }
            }, 6000)
          })
        }
      } catch (err) {
        console.error("[Auth] Error waiting for auth:", err)
      }
      
      if (cancelled) {
        console.debug("[Auth] Cancelled, returning early")
        return
      }
      
      authUserRestoredRef.current = true
      console.debug("[Auth] Auth wait complete, currentUser:", auth.currentUser?.uid ?? "null")
      
      // Don't redirect here - let the page load and check auth when user interacts
      // This allows Firebase more time to restore the user from IndexedDB
      console.debug("[Auth] Setting isAuthReady=true (auth check will happen on interaction)")
      setIsAuthReady(true)
    }
    
    waitForAuth()
    
    return () => {
      cancelled = true
    }
  }, [getAuthInstance, router])

  // Monitor auth state changes continuously for debugging
  useEffect(() => {
    const auth = getAuthInstance()
    if (!auth) return
    
    console.debug("[AuthMonitor] Setting up continuous auth monitor")
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      console.debug("[AuthMonitor] Auth state changed! user:", user?.uid ?? "null", "isAuthReady:", isAuthReady)
    })
    
    return () => {
      console.debug("[AuthMonitor] Cleaning up auth monitor")
      unsubscribe()
    }
  }, [getAuthInstance, isAuthReady])

  const requirements = client?.requirements ?? []
  const hasRequirementUpdate = useMemo(
    () =>
      requirements.some((requirement) =>
        requirement.files.some((file) => {
          const status = (file.status ?? "").toLowerCase()
          return status !== "" && status !== "approved"
        })
      ),
    [requirements]
  )
  const flatDocuments = useMemo<RequirementDocumentItem[]>(() => {
    const docs: RequirementDocumentItem[] = []
    requirements.forEach((requirement, requirementIndex) => {
      requirement.files.forEach((file, fileIndex) => {
        docs.push({
          id: `${requirement.id}::${file.id}`,
          requirement,
          requirementIndex,
          file,
          fileIndex,
        })
      })
    })
    return docs
  }, [requirements])
  const activeDocument =
    selectedDocIndex >= 0 && selectedDocIndex < flatDocuments.length ? flatDocuments[selectedDocIndex] : null
  const isDocxFile = useMemo(() => {
    if (!activeDocument) {
      return false
    }
    const fileName = activeDocument.file.fileName?.toLowerCase() ?? ""
    return fileName.endsWith(".docx")
  }, [activeDocument])

  useEffect(() => {
    if (!id) {
      return
    }

    setIsLoading(true)
    setError(null)

    const recordRef = ref(realtimeDb, `${BUSINESS_APPLICATION_PATH}/${id}`)
    const unsubscribe = onValue(
      recordRef,
      (snapshot) => {
        if (!snapshot.exists()) {
          setClient(null)
          setError("Client not found.")
          setIsLoading(false)
          return
        }

        setClient(normalizeBusinessApplication(snapshot.key ?? id, snapshot.val()))
        setError(null)
        setIsLoading(false)
      },
      (err) => {
        console.error("Failed to load client record", err)
        setClient(null)
        setError("Unable to load client record. Please try again later.")
        setIsLoading(false)
      }
    )

    return () => unsubscribe()
  }, [id])

  useEffect(() => {
    if (selectedDocIndex >= flatDocuments.length) {
      setSelectedDocIndex(-1)
    }
  }, [flatDocuments.length, selectedDocIndex])

  // Ensure loader shows when opening a document viewer (including when setSelectedDocIndex is called directly)
  useEffect(() => {
    if (!activeDocument) {
      setLoadingFiles(new Set())
      setImageLoading(false)
      return
    }
    const fileIds = (activeDocument.requirement.files ?? []).map((file) => file.id)
    setLoadingFiles(new Set(fileIds))
    setImageLoading(true)
  }, [activeDocument])

  const goToPrevDoc = useCallback(() => {
    if (!activeDocument) return
    const currentReqIndex = requirements.findIndex((r) => r.id === activeDocument.requirement.id)
    if (currentReqIndex <= 0) return
    const prevRequirement = requirements[currentReqIndex - 1]
    const targetIndex = flatDocuments.findIndex((d) => d.requirement.id === prevRequirement.id)
    if (targetIndex !== -1) {
      setImageLoading(true)
      setSelectedDocIndex(targetIndex)
    }
  }, [activeDocument, requirements, flatDocuments])

  const goToNextDoc = useCallback(() => {
    if (!activeDocument) return
    const currentReqIndex = requirements.findIndex((r) => r.id === activeDocument.requirement.id)
    if (currentReqIndex < 0 || currentReqIndex >= requirements.length - 1) return
    const nextRequirement = requirements[currentReqIndex + 1]
    const targetIndex = flatDocuments.findIndex((d) => d.requirement.id === nextRequirement.id)
    if (targetIndex !== -1) {
      setImageLoading(true)
      setSelectedDocIndex(targetIndex)
    }
  }, [activeDocument, requirements, flatDocuments])

  const handleImageLoaded = useCallback((fileId: string) => {
    setLoadingFiles((prev) => {
      const next = new Set(prev)
      next.delete(fileId)
      if (next.size === 0) {
        setImageLoading(false)
      }
      return next
    })
  }, [])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!activeDocument) {
        return
      }
      if (e.key === "Escape") {
        if (showRejectModal) {
          setShowRejectModal(false)
          setRejectReason("")
        } else {
          setSelectedDocIndex(-1)
        }
      } else if (e.key === "ArrowLeft" && !showRejectModal) {
        goToPrevDoc()
      } else if (e.key === "ArrowRight" && !showRejectModal) {
        goToNextDoc()
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [activeDocument, showRejectModal, goToPrevDoc, goToNextDoc])

  const handleDocxPreview = useCallback(async () => {
    if (!activeDocument?.file?.downloadUrl) {
      toast.error("Document is not available for preview.")
      return
    }

    try {
      docxPreviewCancelRef.current = false
      setIsDocxModalOpen(true)
      setIsDocxLoading(true)
      setDocxContent(null)
      setDocxPdfUrl(null)

      // First try server-side PDF conversion for the application (best-effort)
      try {
        const currentUser = getAuthInstance()?.currentUser
        if (currentUser) {
          let idToken = await currentUser.getIdToken()
          let resp = await fetch("/api/export/docx-to-pdf", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${idToken}`,
            },
            body: JSON.stringify({ applicationId: id }),
          })

          if (resp.status === 401) {
            idToken = await currentUser.getIdToken(true)
            resp = await fetch("/api/export/docx-to-pdf", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${idToken}`,
              },
              body: JSON.stringify({ applicationId: id }),
            })
          }

          if (resp.ok) {
            const blob = await resp.blob()
            const url = URL.createObjectURL(blob)
            if (!docxPreviewCancelRef.current) {
              setDocxPdfUrl(url)
              setIsDocxLoading(false)
            } else {
              try { URL.revokeObjectURL(url) } catch {}
            }
            return
          }
          // If server returned non-ok, check conversion details and notify when converter is unavailable
          const errData = await resp.json().catch(() => ({}))
          const details = (errData && (errData.details || errData.error || "")) as string
          const detailsLower = String(details).toLowerCase()
          if (
            detailsLower.includes("soffice") ||
            detailsLower.includes("enoent") ||
            detailsLower.includes("converter") ||
            detailsLower.includes("econnrefused") ||
            detailsLower.includes("fetch failed")
          ) {
            toast.info("Server-side PDF conversion unavailable; falling back to client-side preview.")
          }
        }
      } catch (err) {
        // ignore and fall back to client rendering
        console.warn("Server PDF conversion unavailable; falling back to client-side preview", err)
        toast.info("Server-side PDF conversion unavailable; falling back to client-side preview.")
      }

      const response = await fetch(activeDocument.file.downloadUrl)
      if (!response.ok) {
        throw new Error(`Failed to fetch document: ${response.statusText}`)
      }

      if (docxPreviewCancelRef.current) {
        return
      }

      const blob = await response.blob()
      const container = document.createElement("div")
      await renderAsync(blob, container)
      if (!docxPreviewCancelRef.current) {
        setDocxContent(container.innerHTML)
      }
    } catch (error) {
      console.error("Failed to preview DOCX", error)
      toast.error("Unable to preview the document. Please try downloading instead.")
      setIsDocxModalOpen(false)
    } finally {
      if (!docxPreviewCancelRef.current) {
        setIsDocxLoading(false)
      }
    }
  }, [activeDocument, getAuthInstance, id])

  const handleCloseDocxModal = () => {
    docxPreviewCancelRef.current = true
    setIsDocxModalOpen(false)
    if (docxPdfUrl) {
      try { URL.revokeObjectURL(docxPdfUrl) } catch {}
    }
    setDocxContent(null)
    setDocxPdfUrl(null)
    setIsDocxLoading(false)
  }

  const persistDocumentStatus = async (
    targetDocument: RequirementDocumentItem,
    status: LocalDocumentStatus["status"],
    note?: string
  ) => {
    console.debug("[persistDocumentStatus] Called, isAuthReady:", isAuthReady, "authUserRestoredRef:", authUserRestoredRef.current)
    
    // Wait for auth user to be restored (handles page refresh scenario)
    const currentUser = await waitForAuthUser()
    
    console.debug("[persistDocumentStatus] After waitForAuthUser, currentUser:", currentUser?.uid ?? "null")
    
    if (!currentUser) {
      console.debug("[persistDocumentStatus] No user, showing error and redirecting")
      toast.error("You must be logged in to update document status.")
      router.replace("/")
      return
    }

    // Get fresh ID token for REST API calls
    let idToken: string
    try {
      idToken = await currentUser.getIdToken(true)
    } catch (tokenErr) {
      console.error("Failed to get ID token", tokenErr)
      toast.error("Authentication error. Please refresh and try again.")
      return
    }

    try {
      setIsPersisting(true)

      const nextRequirementIndex = (() => {
        if (selectedDocIndex < 0 || selectedDocIndex >= flatDocuments.length) return -1
        const currentReqId = flatDocuments[selectedDocIndex]?.requirement.id
        for (let i = selectedDocIndex + 1; i < flatDocuments.length; i++) {
          if (flatDocuments[i].requirement.id !== currentReqId) return i
        }
        return -1
      })()

      const clientId = id || client?.id || ""
      if (!realtimeDb) {
        console.error("persistDocumentStatus: realtimeDb not initialized")
        toast.error("Database unavailable. Please refresh and try again.")
        return
      }
      const safeReqName = sanitizeKey(targetDocument.requirement.name || "requirement")
      const safeFileId = sanitizeKey(targetDocument.file.id || "file")
      const currentFileRef = ref(
        realtimeDb,
        `${BUSINESS_APPLICATION_PATH}/${clientId}/requirements/${safeReqName}/files/${safeFileId}`
      )

      // read current snapshot
      const snapshot = await get(currentFileRef)

      if (snapshot.exists()) {
        const existingFile = snapshot.val() as { fileName: string; fileSize: number; fileHash: string }
        if (
          existingFile.fileName !== targetDocument.file.fileName ||
          existingFile.fileSize !== targetDocument.file.fileSize ||
          existingFile.fileHash !== targetDocument.file.fileHash
        ) {
          const clientStatusPath = `${BUSINESS_APPLICATION_PATH}/${clientId}/status`
          const clientStatusPathType = typeof clientStatusPath
          if (clientStatusPathType !== "string" || !clientId) {
            console.error("persistDocumentStatus: invalid client status path", {
              clientId,
              clientIdType: typeof clientId,
              businessPath: BUSINESS_APPLICATION_PATH,
              businessPathType: typeof BUSINESS_APPLICATION_PATH,
              clientStatusPath,
              clientStatusPathType,
            })
          } else {
            if (process.env.NODE_ENV !== "production") {
              console.debug("persistDocumentStatus: updating client status via REST", {
                clientId,
                path: clientStatusPath,
              })
            }
            await firebaseRestSet(clientStatusPath, "Pending Update Review", idToken)
          }
        }
      }

      // remove unread marker for this file locally
      setUnreadRequirements((prev) => {
        const next = new Set(prev)
        next.delete(targetDocument.file.id)
        return next
      })

      const payload: { status: string; adminNote?: string } = { status }
      if (status === "rejected") payload.adminNote = note ?? ""
      else if (status === "approved") payload.adminNote = ""

      // Ensure plain JSON object
      const cleanPayload = JSON.parse(JSON.stringify(payload))

      // If the requirement has exactly two files, apply the same status to both files
      if (targetDocument.requirement.files && targetDocument.requirement.files.length === 2) {
        await Promise.all(
          targetDocument.requirement.files.map((f) => {
            const safeId = sanitizeKey(f.id || "file")
            const filePath = `${BUSINESS_APPLICATION_PATH}/${clientId}/requirements/${safeReqName}/files/${safeId}`
            if (process.env.NODE_ENV !== "production") {
              console.debug("persistDocumentStatus: updating file status via REST", {
                clientId,
                path: filePath,
                updatePayload: { status: cleanPayload.status, adminNote: cleanPayload.adminNote ?? "" },
              })
            }
            return firebaseRestUpdate(filePath, {
              status: cleanPayload.status,
              adminNote: cleanPayload.adminNote ?? "",
            }, idToken)
          })
        )
        // If rejected with a note, also send the rejection note to the requirement chat so the applicant sees it
        if (status === "rejected" && note && note.trim()) {
          try {
            const chatPath = `${BUSINESS_APPLICATION_PATH}/${clientId}/requirements/${safeReqName}/chat`
            await firebaseRestPush(chatPath, { senderRole: "admin", senderUid: currentUser.uid, text: note.trim(), ts: Date.now() }, idToken)
          } catch (err) {
            // non-fatal
            console.error("Failed to push rejection note to requirement chat:", err)
          }
        }
      } else {
        const filePath = `${BUSINESS_APPLICATION_PATH}/${clientId}/requirements/${safeReqName}/files/${safeFileId}`
        if (process.env.NODE_ENV !== "production") {
          console.debug("persistDocumentStatus: updating single file status via REST", {
            clientId,
            path: filePath,
            updatePayload: { status: cleanPayload.status, adminNote: cleanPayload.adminNote ?? "" },
          })
        }
        await firebaseRestUpdate(filePath, {
          status: cleanPayload.status,
          adminNote: cleanPayload.adminNote ?? "",
        }, idToken)
        // If rejected with a note, also send the rejection note to the requirement chat so the applicant sees it
        if (status === "rejected" && note && note.trim()) {
          try {
            const chatPath = `${BUSINESS_APPLICATION_PATH}/${clientId}/requirements/${safeReqName}/chat`
            await firebaseRestPush(chatPath, { senderRole: "admin", senderUid: currentUser.uid, text: note.trim(), ts: Date.now() }, idToken)
          } catch (err) {
            // non-fatal
            console.error("Failed to push rejection note to requirement chat:", err)
          }
        }
      }

      // Clear unread markers for the requirement when approved/rejected
      setUnreadRequirements((prev) => {
        const next = new Set(prev)
        const normalizedStatus = (status || "").toLowerCase()
        if (normalizedStatus.includes("approve") || normalizedStatus.includes("reject")) {
          try {
            targetDocument.requirement.files.forEach((f) => next.delete(f.id))
          } catch {}
        } else {
          next.delete(targetDocument.file.id)
        }
        return next
      })

      // Mark client notification read & cleared in localStorage so home updates
      try {
        if (client) {
          const clientNotificationId = getClientNotificationId(client)
          if (!clientNotificationId) return
          const stored = localStorage.getItem("bossReadNotifications")
          const parsed: string[] = stored ? JSON.parse(stored) : []
          if (!parsed.includes(clientNotificationId)) {
            parsed.push(clientNotificationId)
            localStorage.setItem("bossReadNotifications", JSON.stringify(parsed))

            try {
              const namesKey = "bossNotificationNames"
              const storedNames = localStorage.getItem(namesKey)
              const namesObj: Record<string, string> = storedNames ? JSON.parse(storedNames) : {}
              if (client?.applicantName) namesObj[clientNotificationId] = client.applicantName
              localStorage.setItem(namesKey, JSON.stringify(namesObj))
            } catch {}
          }

          const clearedKey = "bossClearedRequirements"
          const storedCleared = localStorage.getItem(clearedKey)
          const clearedArr: string[] = storedCleared ? JSON.parse(storedCleared) : []
          if (!clearedArr.includes(client.id)) {
            clearedArr.push(client.id)
            localStorage.setItem(clearedKey, JSON.stringify(clearedArr))
          }

          // notify other components in same window (include client name)
          window.dispatchEvent(
            new CustomEvent("bossReadNotifications:update", {
              detail: { id: clientNotificationId, clientName: client.applicantName },
            })
          )
        }
      } catch {}

      // Update local document status state for the affected file(s)
      if (targetDocument.requirement.files && targetDocument.requirement.files.length === 2) {
        setDocumentStatuses((prev) => {
          const next = { ...prev }
          targetDocument.requirement.files.forEach((f) => {
            next[f.id] = note ? { status, reason: note } : { status }
          })
          return next
        })
      } else {
        setDocumentStatuses((prev) => ({ ...prev, [targetDocument.file.id]: note ? { status, reason: note } : { status } }))
      }

      if (nextRequirementIndex !== -1) {
        setSelectedDocIndex(nextRequirementIndex)
      } else {
        setSelectedDocIndex(-1)
      }
      setShowRejectModal(false)
      setRejectReason("")
    } catch (err) {
      console.error("Failed to update requirement status", err)
      toast.error("Unable to update document status. Please try again.")
    } finally {
      setIsPersisting(false)
    }
  }

  const handleApprove = async () => {
    const auth = getAuthInstance()
    console.debug("[handleApprove] Called, isAuthReady:", isAuthReady, "auth.currentUser:", auth?.currentUser?.uid ?? "null")
    if (!activeDocument) {
      return
    }
    await persistDocumentStatus(activeDocument, "approved")
  }

  const handleRejectClick = () => {
    setShowRejectModal(true)
  }

  const handleRejectConfirm = async () => {
    const auth = getAuthInstance()
    console.debug("[handleRejectConfirm] Called, isAuthReady:", isAuthReady, "auth.currentUser:", auth?.currentUser?.uid ?? "null")
    if (!activeDocument || !rejectReason.trim()) {
      return
    }
    await persistDocumentStatus(activeDocument, "rejected", rejectReason.trim())
  }

  const convertImageBlobToPdfUrl = useCallback(async (blob: Blob) => {
    const arrayBuffer = await blob.arrayBuffer()
    const pdfDoc = await PDFDocument.create()

    let embedded
    try {
      embedded = await pdfDoc.embedJpg(new Uint8Array(arrayBuffer))
    } catch {
      embedded = await pdfDoc.embedPng(new Uint8Array(arrayBuffer))
    }

    const page = pdfDoc.addPage()
    const { width, height } = embedded
    const pageWidth = page.getWidth()
    const pageHeight = page.getHeight()
    const scale = Math.min(pageWidth / width, pageHeight / height, 1)
    const scaledWidth = width * scale
    const scaledHeight = height * scale
    const x = (pageWidth - scaledWidth) / 2
    const y = (pageHeight - scaledHeight) / 2
    page.drawImage(embedded, { x, y, width: scaledWidth, height: scaledHeight })

    const pdfBytes = await pdfDoc.save()
    // Normalize to a concrete ArrayBuffer (avoid SharedArrayBuffer union)
    const pdfBuffer: ArrayBuffer = pdfBytes.slice().buffer
    const pdfBlob = new Blob([pdfBuffer], { type: "application/pdf" })
    return URL.createObjectURL(pdfBlob)
  }, [])

  const cleanupFormPreviewUrls = useCallback((urls: string[]) => {
    urls.forEach((u) => {
      try { URL.revokeObjectURL(u) } catch {}
    })
  }, [])

  const handlePreviewApplicationForm = useCallback(async () => {
    // reset/prepare cancel state and abort controller
    formPreviewCancelRef.current = false
    formPreviewAbortRef.current?.abort()
    formPreviewAbortRef.current = new AbortController()

    setIsFormPreviewModalOpen(true)
    setIsFormPreviewLoading(true)
    setFormPreviewUrl(null)
    cleanupFormPreviewUrls(formPreviewTempUrls)
    setFormPreviewTempUrls([])

    try {
      const currentUser = getAuthInstance()?.currentUser
      if (!currentUser) {
        toast.error("You must be logged in to preview the application form.")
        router.replace("/")
        return
      }

      // Always force-refresh token to avoid stale/expired auth when previewing
      let token = await currentUser.getIdToken(true)
      let response = await fetch("/api/export/docx-to-pdf", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          // Allow local development bypass (ignored in production)
          "x-dev-bypass": process.env.NODE_ENV !== "production" ? "1" : "0",
        },
        body: JSON.stringify({ applicationId: id }),
        signal: formPreviewAbortRef.current?.signal,
      })

      if (response.status === 401) {
        token = await currentUser.getIdToken(true)
        response = await fetch("/api/export/docx-to-pdf", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            "x-dev-bypass": process.env.NODE_ENV !== "production" ? "1" : "0",
          },
          body: JSON.stringify({ applicationId: id }),
          signal: formPreviewAbortRef.current?.signal,
        })
      }

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        const message = (errorData?.error as string) || "Unable to preview application form."
        toast.error(message)
        return
      }

      const mainBlob = await response.blob()
      const tempUrls: string[] = []
      const pdfSources: string[] = []

      const mainUrl = URL.createObjectURL(mainBlob)
      tempUrls.push(mainUrl)
      pdfSources.push(mainUrl)

      // Append approved requirement files as PDFs (convert images to PDF pages)
      if (client) {
        for (const req of client.requirements || []) {
          for (const f of req.files || []) {
            try {
              const status = String(f.status || "").toLowerCase()
              if (!status.includes("approve")) continue
              if (!f.downloadUrl) continue

              const proxyUrl = `/api/proxy?url=${encodeURIComponent(f.downloadUrl)}`
              const resp = await fetch(proxyUrl, { signal: formPreviewAbortRef.current?.signal })
              if (!resp.ok) continue
              const blob = await resp.blob()
              const contentType = (blob.type || "").toLowerCase()

              if (contentType.includes("pdf")) {
                const url = URL.createObjectURL(blob)
                tempUrls.push(url)
                pdfSources.push(url)
              } else if (contentType.startsWith("image/")) {
                const url = await convertImageBlobToPdfUrl(blob)
                tempUrls.push(url)
                pdfSources.push(url)
              }
            } catch (err) {
              console.warn("Skipping requirement file for preview merge", err)
            }
          }
        }
      }

      if (formPreviewAbortRef.current?.signal.aborted || formPreviewCancelRef.current) {
        // aborted while preparing sources
        return
      }

      const mergedBlob = await mergePdfUrls(pdfSources)
      const mergedUrl = URL.createObjectURL(mergedBlob)
      tempUrls.push(mergedUrl)

      if (!formPreviewCancelRef.current) {
        setFormPreviewTempUrls(tempUrls)
        setFormPreviewUrl(mergedUrl)
      }
    } catch (error) {
      if ((error as any)?.name === "AbortError") {
        // fetches were aborted, don't show an error toast
        return
      }
      console.error("Failed to preview application form", error)
      toast.error("Unable to preview application form.")
    } finally {
      if (!formPreviewCancelRef.current) {
        setIsFormPreviewLoading(false)
      } else {
        setIsFormPreviewLoading(false)
      }
    }
  }, [client, cleanupFormPreviewUrls, convertImageBlobToPdfUrl, formPreviewTempUrls, getAuthInstance, id, router])

  const handleCloseFormPreview = useCallback(() => {
    // signal cancellation to any in-flight preview work and abort network requests
    formPreviewCancelRef.current = true
    try { formPreviewAbortRef.current?.abort() } catch {}

    cleanupFormPreviewUrls([formPreviewUrl, ...formPreviewTempUrls].filter(Boolean) as string[])
    setFormPreviewUrl(null)
    setFormPreviewTempUrls([])
    setIsFormPreviewModalOpen(false)
    setIsFormPreviewLoading(false)
  }, [cleanupFormPreviewUrls, formPreviewTempUrls, formPreviewUrl])

  const [unreadRequirements, setUnreadRequirements] = useState<Set<string>>(new Set())
  const previousFilesRef = useRef<Map<string, { fileName: string; fileSize: number; fileHash: string; status: string }>>(new Map())

  useEffect(() => {
    if (!client) return

    const prev = previousFilesRef.current
    const filesToUpdate: Array<{ path: string; data: Record<string, unknown> }> = []
    let hasReplacement = false
    const updatedAt = Date.now()

    client.requirements.forEach((requirement) => {
      const safeReqName = sanitizeKey(requirement.name || "requirement")
      requirement.files.forEach((file) => {
        const key = `${requirement.name}::${file.id}`
        const normalizedStatus = (file.status ?? "").toLowerCase()
        const prevEntry = prev.get(key)
        const fileName = file.fileName ?? ""
        const fileSize = file.fileSize ?? 0
        const fileHash = file.fileHash ?? ""

        if (
          prevEntry &&
          prevEntry.status === "rejected" &&
          (normalizedStatus !== "rejected" || fileHash !== prevEntry.fileHash || fileSize !== prevEntry.fileSize || fileName !== prevEntry.fileName)
        ) {
          const safeFileId = sanitizeKey(file.id || "file")
          const filePath = `${BUSINESS_APPLICATION_PATH}/${client.id}/requirements/${safeReqName}/files/${safeFileId}`
          filesToUpdate.push({ path: filePath, data: { status: "updated", uploadedAt: updatedAt } })
          hasReplacement = true
        }

        prev.set(key, { fileName, fileSize, fileHash, status: normalizedStatus })
      })
    })

    if (!hasReplacement) return

    const clientStatusPath = `${BUSINESS_APPLICATION_PATH}/${client.id}/status`

    ;(async () => {
      try {
        const auth = getAuthInstance()
        const currentUser = auth?.currentUser
        if (!currentUser) return
        const idToken = await currentUser.getIdToken()

        // Update all file statuses
        await Promise.all(filesToUpdate.map((f) => firebaseRestUpdate(f.path, f.data, idToken)))
        // Update client status
        await firebaseRestSet(clientStatusPath, "Pending Update Review", idToken)
      } catch (err) {
        console.error("Failed to mark replaced requirement as updated", err)
      }
    })()
  }, [client, getAuthInstance])

  useEffect(() => {
    if (!client) return

    const cutoff = Date.now() - NEW_LOOKBACK_DAYS * MS_IN_DAY
    setUnreadRequirements((prev) => {
      const updatedUnread = new Set(prev)
      client.requirements.forEach((requirement) => {
        requirement.files.forEach((file) => {
          const fileStatus = (file.status || "").toLowerCase()
          const isApprovedOrRejected = fileStatus.includes("approve") || fileStatus.includes("reject")
          if (isApprovedOrRejected) {
            // remove any existing unread marker for approved/rejected files
            updatedUnread.delete(file.id)
            return
          }

          const isUpdated = fileStatus === "updated"
          const isNewUpload = typeof file.uploadedAt === "number" && file.uploadedAt >= cutoff
          if ((isUpdated || isNewUpload) && !prev.has(file.id)) {
            updatedUnread.add(file.id)
          }
        })
      })
      return updatedUnread
    })
  }, [client])

  const handleViewRequirement = (requirementId: string) => {
    const docIndex = flatDocuments.findIndex((doc) => doc.requirement.id === requirementId)
    if (docIndex === -1) {
      toast.info("No files uploaded for this requirement yet.")
      return
    }
    setImageLoading(true)
    setSelectedDocIndex(docIndex)

    // Mark requirement as read
    setUnreadRequirements((prev) => {
      const next = new Set(prev)
      // remove all file ids belonging to this requirement
      const req = requirements.find((r) => r.id === requirementId)
      if (req) {
        req.files.forEach((f) => next.delete(f.id))
      }
      return next
    })
    // ensure clients-list notification is cleared reliably
    setTimeout(() => {
      try {
        if (!client) return
        const clientNotificationId = getClientNotificationId(client)
        if (!clientNotificationId) return
        const stored = localStorage.getItem("bossReadNotifications")
        const parsed: string[] = stored ? JSON.parse(stored) : []
        if (!parsed.includes(clientNotificationId)) {
          parsed.push(clientNotificationId)
          localStorage.setItem("bossReadNotifications", JSON.stringify(parsed))
          try {
            const namesKey = "bossNotificationNames"
            const storedNames = localStorage.getItem(namesKey)
            const namesObj: Record<string, string> = storedNames ? JSON.parse(storedNames) : {}
            if (client?.applicantName) namesObj[clientNotificationId] = client.applicantName
            localStorage.setItem(namesKey, JSON.stringify(namesObj))
          } catch {}
          window.dispatchEvent(
            new CustomEvent("bossReadNotifications:update", {
              detail: { id: clientNotificationId, clientName: client.applicantName },
            })
          )
        }
      } catch {}
    }, 0)
  }

  // When there are no more unread requirement files for this client, mark notification as read
  useEffect(() => {
    if (!client) return

    const clientNotificationId = getClientNotificationId(client)
    if (!clientNotificationId) return

    const hasUnreadForClient = client.requirements.some((req) => req.files.some((f) => unreadRequirements.has(f.id)))
    if (!hasUnreadForClient) {
      try {
        const stored = localStorage.getItem("bossReadNotifications")
        const parsed: string[] = stored ? JSON.parse(stored) : []
        if (!parsed.includes(clientNotificationId)) {
          parsed.push(clientNotificationId)
          localStorage.setItem("bossReadNotifications", JSON.stringify(parsed))
          try {
            const namesKey = "bossNotificationNames"
            const storedNames = localStorage.getItem(namesKey)
            const namesObj: Record<string, string> = storedNames ? JSON.parse(storedNames) : {}
            if (client?.applicantName) namesObj[clientNotificationId] = client.applicantName
            localStorage.setItem(namesKey, JSON.stringify(namesObj))
          } catch {}
          // notify other components in same window (include client name)
          window.dispatchEvent(
            new CustomEvent("bossReadNotifications:update", {
              detail: { id: clientNotificationId, clientName: client?.applicantName ?? null },
            })
          )
        }
      } catch {}
    }
  }, [unreadRequirements, client])

  const handleBack = () => {
    const fromParam = searchParams.get("from")
    
    // If redirected from notification, go back to home
    if (fromParam === "notification") {
      router.push("/")
      return
    }

    // Otherwise, go back to clients list
    const page = searchParams.get("page")
    if (page) {
      router.push(`/?page=${page}`)
      return
    }

    router.push("/?page=clients")
  }

  if (isLoading || !isAuthReady) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          Loading client details...
        </div>
      </div>
    )
  }

  if (!client) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center space-y-4">
          <h1 className="text-2xl font-bold text-foreground">{error ?? "Client Not Found"}</h1>
          <Button className="bg-primary hover:bg-primary/90 text-white" onClick={handleBack}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back
          </Button>
        </div>
      </div>
    )
  }

  const requirementCount = requirements.length

  const currentRequirementIndex =
    selectedDocIndex >= 0 && selectedDocIndex < flatDocuments.length
      ? requirements.findIndex((r) => r.id === flatDocuments[selectedDocIndex].requirement.id)
      : -1
  const hasPrevRequirement = currentRequirementIndex > 0
  const hasNextRequirement = currentRequirementIndex >= 0 && currentRequirementIndex < requirements.length - 1

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <Header showBack onBack={handleBack} />

      <main className="flex-1 container mx-auto px-4 py-8">
        <div className="mb-8 space-y-4">
          <div>
            <h1 className="text-3xl font-bold text-foreground mb-1">{client.applicantName}</h1>
            {client.businessName && (
              <p className="text-muted-foreground text-sm">{client.businessName}</p>
            )}
          </div>
          <div className="flex flex-wrap gap-3">
            <span className="px-3 py-1 rounded-full text-sm font-medium bg-primary/15 text-primary">
              {client.applicationType}
            </span>
            {(() => {
              const badge = getStatusBadge(client.status, client.overallStatus)
              return (
                <span className={`px-3 py-1 rounded-full text-sm font-medium ${badge.className}`}>
                  {badge.label}
                </span>
              )
            })()}
            {client.applicationDate && (
              <span className="px-3 py-1 rounded-full text-sm font-medium bg-muted text-foreground/80">
                Application Date: {(() => {
                  const date = new Date(client.applicationDate)
                  return Number.isNaN(date.getTime()) ? client.applicationDate : date.toLocaleDateString()
                })()}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 mb-4">
          <h2 className="text-xl font-semibold text-foreground">
            Requirements ({requirementCount} item{requirementCount === 1 ? "" : "s"})
          </h2>
        </div>
        <div className="flex justify-end mb-3">
          <Button
            variant="requirements"
            size="lg"
            onClick={(e) => {
              e.stopPropagation()
              handlePreviewApplicationForm()
            }}
            disabled={isFormPreviewLoading}
            className="shadow-md bg-blue-600 hover:bg-blue-700 text-white"
          >
            Preview Application Form
          </Button>
        </div>

        <div className="bg-card border border-border rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="bg-primary text-white">
                  <th className="border border-border p-3 text-center">No.</th>
                  <th className="border border-border p-3 text-center">Document Name</th>
                  <th className="border border-border p-3 text-center">Status</th>
                  <th className="border border-border p-3 text-center">Action</th>
                </tr>
              </thead>
              <tbody>
                {requirements.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="border border-border p-6 text-center text-muted-foreground">
                      No requirements have been uploaded for this application yet.
                    </td>
                  </tr>
                ) : (
                  requirements.map((requirement, index) => {
                    const rowIndex = index + 1
                    const files = requirement.files || []

                    if (files.length === 0) {
                      return (
                        <tr key={requirement.id} className={index % 2 === 0 ? "bg-background" : "bg-muted/30"}>
                          <td className="border border-border p-3 text-center text-muted-foreground">{rowIndex}</td>
                          <td className="border border-border p-3">
                            <div className="flex items-center gap-3 justify-center">
                              <div className="flex flex-col">
                                <span className="font-medium text-foreground">{requirement.name}</span>
                              </div>
                            </div>
                          </td>
                          <td className="border border-border p-3 text-center">
                            <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-700`}>
                              Pending
                            </span>
                          </td>
                          <td className="border border-border p-3 text-center">
                            <div className="flex items-center justify-center gap-2">
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={true}
                                className="text-primary hover:text-primary hover:bg-primary/10 disabled:text-muted-foreground"
                              >
                                No Upload
                              </Button>
                            </div>
                          </td>
                        </tr>
                      )
                    }

                    // Aggregate status for requirement
                    const collectedStatuses = files.map((f) => (documentStatuses[f.id]?.status ?? f?.status ?? "pending").toLowerCase())
                    const hasRejected = collectedStatuses.some((s) => s.includes("reject"))
                    const hasUpdated = collectedStatuses.some((s) => s === "updated")
                    const allApproved = collectedStatuses.length > 0 && collectedStatuses.every((s) => s.includes("approve"))
                    let aggStatus = "pending"
                    if (allApproved) aggStatus = "approved"
                    else if (hasRejected) aggStatus = "rejected"
                    else if (hasUpdated) aggStatus = "updated"

                    const badge = getStatusBadge(aggStatus, aggStatus)
                    const docIndex = flatDocuments.findIndex((d) => d.requirement.id === requirement.id)

                    return (
                      <tr key={requirement.id} className={index % 2 === 0 ? "bg-background" : "bg-muted/30"}>
                        <td className="border border-border p-3 text-center text-muted-foreground align-top">{rowIndex}</td>
                        <td className="border border-border p-3">
                          <div className="flex items-center gap-3 justify-center">
                            <div className="flex flex-col">
                              <span className="font-medium text-foreground">{requirement.name}</span>
                            </div>
                            {files.length > 1 && (
                              <span className="text-xs text-muted-foreground">{files.length} files</span>
                            )}
                          </div>
                        </td>
                        <td className="border border-border p-3 text-center">
                          {(() => {
                            const isApproved = String(aggStatus).toLowerCase().includes("approve")
                            const badgeClassName = isApproved ? "bg-green-600 text-white" : badge.className
                            return (
                              <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${badgeClassName}`}>
                                {badge.label}
                              </span>
                            )
                          })()}
                        </td>
                        <td className="border border-border p-3 text-center">
                          <div className="flex items-center justify-center gap-2">
                            <Button
                              variant="requirements"
                              size="lg"
                              disabled={files.length === 0}
                              onClick={() => {
                                handleViewRequirement(requirement.id)
                              }}
                            >
                              View
                            </Button>
                            {(files.some((f) => ((documentStatuses[f.id]?.status ?? f.status ?? "") as string).toLowerCase() === "updated") || files.some((f) => unreadRequirements.has(f.id))) && (
                              <span className="h-2 w-2 rounded-full bg-red-500" aria-label="Updated requirement" />
                            )}
                          </div>
                        </td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
        {/* General application chat removed from the requirements list as requested */}
      </main>

      {activeDocument && !showRejectModal && (
        <div
          className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
          onClick={() => setSelectedDocIndex(-1)}
        >
          {hasPrevRequirement && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                goToPrevDoc()
              }}
              className="absolute left-4 top-1/2 -translate-y-1/2 bg-white/10 hover:bg-white/20 text-white rounded-full p-2 transition-colors z-20"
              title="Previous document (←)"
            >
              <ChevronLeft className="h-8 w-8" />
            </button>
          )}

          {hasNextRequirement && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                goToNextDoc()
              }}
              className="absolute right-4 top-1/2 -translate-y-1/2 bg-white/10 hover:bg-white/20 text-white rounded-full p-2 transition-colors z-20"
              title="Next document (→)"
            >
              <ChevronRight className="h-8 w-8" />
            </button>
          )}

          <div
            className="bg-card rounded-lg max-w-[90vw] w-full max-h-[98vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="relative flex items-center justify-center px-2 py-2 border-b border-border sticky top-0 bg-card z-10">
              <div className="text-center">
                <h3 className="text-lg font-semibold text-foreground">{activeDocument.requirement.name}</h3>
                <p className="text-xs text-muted-foreground">
                  Document {selectedDocIndex + 1} of {flatDocuments.length} • Press Esc to close, ← → to navigate
                </p>
              </div>
              <button
                onClick={() => setSelectedDocIndex(-1)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="p-0">
              {activeDocument.requirement.files && activeDocument.requirement.files.length > 1 ? (
                <div className="flex flex-col gap-4 p-0 overflow-y-auto">
                  {activeDocument.requirement.files.map((f, idx) => {
                    const isFileLoading = imageLoading || loadingFiles.has(f.id)
                    return (
                      <div key={f.id} className="w-full">
                        <div className="relative w-full h-[98vh]" style={{ minHeight: "98vh" }}>
                          {isFileLoading && (
                            <div className="absolute inset-0 flex items-center justify-center bg-muted/50 rounded-md z-10">
                              <Loader2 className="h-8 w-8 animate-spin text-primary" />
                            </div>
                          )}
                          <Image
                            src={f.downloadUrl || "/placeholder.svg"}
                            alt={activeDocument.requirement.name}
                            fill
                            sizes="(max-width: 768px) 100vw, 80vw"
                            className={`object-contain rounded-md w-full h-full transition-opacity ${isFileLoading ? "opacity-0" : "opacity-100"}`}
                            priority
                            unoptimized
                            onLoad={() => handleImageLoaded(f.id)}
                            onError={() => handleImageLoaded(f.id)}
                          />
                        </div>
                        {idx !== activeDocument.requirement.files.length - 1 && (
                          <div className="h-2 bg-border w-full my-2" />
                        )}
                      </div>
                    )
                  })}
                </div>
              ) : (
                <div className="relative w-full h-[98vh]" style={{ minHeight: "98vh" }}>
                  {(imageLoading || loadingFiles.has(activeDocument.file.id)) && (
                    <div className="absolute inset-0 flex items-center justify-center bg-muted/50 rounded-md">
                      <Loader2 className="h-8 w-8 animate-spin text-primary" />
                    </div>
                  )}
                  <Image
                    src={activeDocument.file.downloadUrl || "/placeholder.svg"}
                    alt={activeDocument.requirement.name}
                    fill
                    sizes="(max-width: 768px) 100vw, 80vw"
                    className={`object-contain rounded-md w-full h-full transition-opacity ${(imageLoading || loadingFiles.has(activeDocument.file.id)) ? "opacity-0" : "opacity-100"}`}
                    priority
                    unoptimized
                    onLoad={() => handleImageLoaded(activeDocument.file.id)}
                    onError={() => handleImageLoaded(activeDocument.file.id)}
                  />
                </div>
              )}
            </div>
            <div className="flex flex-col gap-3 p-4 border-t border-border sticky bottom-0 bg-card sm:flex-row">
              {isDocxFile && (
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={(e) => {
                    e.stopPropagation()
                    handleDocxPreview()
                  }}
                  disabled={isDocxLoading}
                >
                  <Printer className="h-4 w-4 mr-2" />
                  {isDocxLoading ? "Preparing preview..." : "Print"}
                </Button>
              )}
              <Button
                className="flex-1 bg-primary hover:bg-primary/90 text-white disabled:opacity-70"
                onClick={handleApprove}
                disabled={isPersisting}
              >
                <CheckCircle className="h-4 w-4 mr-2" />
                {isPersisting ? "Saving..." : "Approve"}
              </Button>
              <Button
                variant="destructive"
                className="flex-1 disabled:opacity-70"
                onClick={handleRejectClick}
                disabled={isPersisting}
              >
                <XCircle className="h-4 w-4 mr-2" />
                Reject
              </Button>
            </div>
          </div>
        </div>
      )}

      {showRejectModal && (
        <div
          className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
          onClick={() => {
            setShowRejectModal(false)
            setRejectReason("")
          }}
        >
          <div className="bg-card rounded-lg max-w-md w-full p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-foreground">Reason for Rejection</h3>
              <button
                onClick={() => {
                  setShowRejectModal(false)
                  setRejectReason("")
                }}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <p className="text-sm text-muted-foreground mb-4">
              Please provide a reason for rejecting &quot;{activeDocument?.requirement.name}&quot;
            </p>
            <textarea
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="Enter rejection reason..."
              className="w-full p-3 border border-border rounded-md bg-background text-foreground min-h-[120px] mb-4 focus:outline-none focus:ring-2 focus:ring-primary"
            />
            <div className="flex gap-3">
              <Button
                variant="outline"
                className="flex-1 bg-transparent"
                onClick={() => {
                  setShowRejectModal(false)
                  setRejectReason("")
                }}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                className="flex-1 disabled:opacity-70"
                onClick={handleRejectConfirm}
                disabled={!rejectReason.trim() || isPersisting}
              >
                {isPersisting ? "Saving..." : "Confirm Rejection"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {isDocxModalOpen && (
        <div
          className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
          onClick={handleCloseDocxModal}
        >
          <div
            className="bg-card rounded-lg max-w-4xl w-full p-6 overflow-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-foreground">Document Preview</h3>
              <button
                onClick={handleCloseDocxModal}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="docx-preview min-h-[200px]">
              {isDocxLoading && (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Preparing preview...
                </div>
              )}
              {!isDocxLoading && docxPdfUrl && (
                <div className="w-full h-[70vh]">
                  <iframe src={docxPdfUrl} className="w-full h-full border-0" />
                </div>
              )}
              {!isDocxLoading && !docxPdfUrl && docxContent && (
                <div dangerouslySetInnerHTML={{ __html: docxContent }} />
              )}
              {!isDocxLoading && !docxContent && !docxPdfUrl && (
                <p className="text-muted-foreground text-sm">Unable to display this document.</p>
              )}
            </div>
            <div className="px-4 py-3 border-t border-border flex justify-end">
              <Button
                size="sm"
                onClick={() => {
                  if (docxPdfUrl) {
                    handlePrintPdf(docxPdfUrl, activeDocument?.requirement.name ?? "Document PDF")
                  } else {
                    handlePrintHtml(docxContent, activeDocument?.requirement.name ?? "Document Preview")
                  }
                }}
                disabled={(!docxContent && !docxPdfUrl) || isDocxLoading}
                className="mr-2"
              >
                Print
              </Button>
              <Button variant="outline" onClick={handleCloseDocxModal}>
                Close
              </Button>
            </div>
          </div>
        </div>
      )}

      {isFormPreviewModalOpen && (
        <div
          className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
          onClick={handleCloseFormPreview}
        >
          <div
            className="bg-card rounded-lg max-w-screen-2xl w-full max-h-[98vh] flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <h3 className="text-lg font-semibold text-foreground">Application Form Preview</h3>
              <button onClick={handleCloseFormPreview} className="text-muted-foreground hover:text-foreground">
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="flex-1 overflow-hidden">
              {isFormPreviewLoading && (
                <div className="h-full flex items-center justify-center text-muted-foreground gap-2">
                  <Loader2 className="h-5 w-5 animate-spin" />
                  Preparing preview...
                </div>
              )}
              {!isFormPreviewLoading && formPreviewUrl && (
                <iframe src={formPreviewUrl} className="w-full h-[82vh] border-0" />
              )}
              {!isFormPreviewLoading && !formPreviewUrl && (
                <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
                  Unable to display application form.
                </div>
              )}
            </div>

            <div className="px-4 py-3 border-t border-border flex justify-end gap-2">
              <Button
                size="sm"
                onClick={() => {
                  if (formPreviewUrl) {
                    handlePrintPdf(formPreviewUrl, client?.applicantName ? `${client.applicantName} Application Form` : "Application Form")
                  }
                }}
                disabled={!formPreviewUrl || isFormPreviewLoading}
              >
                Print
              </Button>
              <Button variant="outline" onClick={handleCloseFormPreview}>
                Close
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default function ClientRequirementsPage() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <ClientRequirementsContent />
    </Suspense>
  )
}
