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
import { onValue, ref, update, push } from "firebase/database"
import { getAuth, onAuthStateChanged } from "firebase/auth"
import { app as firebaseApp, realtimeDb } from "@/database/firebase"
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

const firebaseAuth = getAuth(firebaseApp)

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

function ClientRequirementsContent() {
  const params = useParams()
  const router = useRouter()
  const searchParams = useSearchParams()
  const id = params.id as string

  const [client, setClient] = useState<BusinessApplicationRecord | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedDocIndex, setSelectedDocIndex] = useState(-1)
  const [documentStatuses, setDocumentStatuses] = useState<Record<string, LocalDocumentStatus>>({})
  const [showRejectModal, setShowRejectModal] = useState(false)
  const [rejectReason, setRejectReason] = useState("")  
  const [imageLoading, setImageLoading] = useState(false)
  const [isPersisting, setIsPersisting] = useState(false)
  const [isAuthReady, setIsAuthReady] = useState(false)

  // Define state variables for docx modal and content
  const [docxContent, setDocxContent] = useState<string | null>(null)
  const [isDocxModalOpen, setIsDocxModalOpen] = useState(false)
  const [isDocxLoading, setIsDocxLoading] = useState(false)
  const [docxPdfUrl, setDocxPdfUrl] = useState<string | null>(null)
  const docxPreviewCancelRef = useRef(false)

  // Wait for Firebase Auth to be ready
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(firebaseAuth, (user) => {
      setIsAuthReady(true)
      if (!user) {
        router.replace("/")
      }
    })
    return () => unsubscribe()
  }, [router])

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
    if (selectedDocIndex !== -1) {
      setImageLoading(true)
    }
  }, [selectedDocIndex])

  const goToPrevDoc = useCallback(() => {
    setSelectedDocIndex((prev) => {
      if (prev <= 0) {
        return prev
      }
      setImageLoading(true)
      return prev - 1
    })
  }, [])

  const goToNextDoc = useCallback(() => {
    setSelectedDocIndex((prev) => {
      if (prev < 0 || prev >= flatDocuments.length - 1) {
        return prev
      }
      setImageLoading(true)
      return prev + 1
    })
  }, [flatDocuments.length])

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
        const currentUser = firebaseAuth.currentUser
        if (currentUser) {
          const idToken = await currentUser.getIdToken()
          const resp = await fetch("/api/export/docx-to-pdf", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${idToken}`,
            },
            body: JSON.stringify({ applicationId: id }),
          })
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
          // If server returned non-ok, check for soffice/ENOENT details and notify
          const errData = await resp.json().catch(() => ({}))
          const details = (errData && (errData.details || errData.error || "")) as string
          if (String(details).toLowerCase().includes("soffice") || String(details).toLowerCase().includes("enoent")) {
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
  }, [activeDocument])

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
    // Check if user is authenticated
    const currentUser = firebaseAuth.currentUser
    if (!currentUser) {
      toast.error("You must be logged in to update document status.")
      router.replace("/")
      return
    }

    try {
      setIsPersisting(true)

      const currentFileRef = ref(
        realtimeDb,
        `${BUSINESS_APPLICATION_PATH}/${id}/requirements/${targetDocument.requirement.name}/files/${targetDocument.file.id}`
      )

      // read current snapshot
      const snapshot = (await new Promise((resolve, reject) => {
        onValue(currentFileRef, (snap) => resolve(snap), (error) => reject(error))
      })) as import("firebase/database").DataSnapshot

      if (snapshot.exists()) {
        const existingFile = snapshot.val() as { fileName: string; fileSize: number; fileHash: string }
        if (
          existingFile.fileName !== targetDocument.file.fileName ||
          existingFile.fileSize !== targetDocument.file.fileSize ||
          existingFile.fileHash !== targetDocument.file.fileHash
        ) {
          const clientRef = ref(realtimeDb, `${BUSINESS_APPLICATION_PATH}/${id}`)
          await update(clientRef, { status: "Pending Update Review" })
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

      // If the requirement has exactly two files, apply the same status to both files
      if (targetDocument.requirement.files && targetDocument.requirement.files.length === 2) {
        const updates = targetDocument.requirement.files.map((f) => {
          const fileRef = ref(
            realtimeDb,
            `${BUSINESS_APPLICATION_PATH}/${id}/requirements/${targetDocument.requirement.name}/files/${f.id}`
          )
          return update(fileRef, payload)
        })
        await Promise.all(updates)
        // If rejected with a note, also send the rejection note to the requirement chat so the applicant sees it
        if (status === "rejected" && note && note.trim()) {
          try {
            const chatRef = ref(realtimeDb, `${BUSINESS_APPLICATION_PATH}/${id}/requirements/${targetDocument.requirement.name}/chat`)
            await push(chatRef, { senderRole: "admin", senderUid: currentUser.uid, text: note.trim(), ts: Date.now() })
          } catch (err) {
            // non-fatal
            console.error("Failed to push rejection note to requirement chat:", err)
          }
        }
      } else {
        await update(currentFileRef, payload)
        // If rejected with a note, also send the rejection note to the requirement chat so the applicant sees it
        if (status === "rejected" && note && note.trim()) {
          try {
            const chatRef = ref(realtimeDb, `${BUSINESS_APPLICATION_PATH}/${id}/requirements/${targetDocument.requirement.name}/chat`)
            await push(chatRef, { senderRole: "admin", senderUid: currentUser.uid, text: note.trim(), ts: Date.now() })
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

      setSelectedDocIndex(-1)
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
    if (!activeDocument) {
      return
    }
    await persistDocumentStatus(activeDocument, "approved")
  }

  const handleRejectClick = () => {
    setShowRejectModal(true)
  }

  const handleRejectConfirm = async () => {
    if (!activeDocument || !rejectReason.trim()) {
      return
    }
    await persistDocumentStatus(activeDocument, "rejected", rejectReason.trim())
  }

  const [unreadRequirements, setUnreadRequirements] = useState<Set<string>>(new Set())

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
                    const files = requirement.files || []

                    if (files.length === 0) {
                      return (
                        <tr key={requirement.id} className={index % 2 === 0 ? "bg-background" : "bg-muted/30"}>
                          <td className="border border-border p-3 text-center text-muted-foreground">{index + 1}</td>
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
                        <td className="border border-border p-3 text-center text-muted-foreground align-top">{index + 1}</td>
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
          {selectedDocIndex > 0 && (
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

          {selectedDocIndex < flatDocuments.length - 1 && (
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
            <div className="flex items-center justify-between px-2 py-2 border-b border-border sticky top-0 bg-card z-10">
              <div>
                <h3 className="text-lg font-semibold text-foreground">{activeDocument.requirement.name}</h3>
                <p className="text-xs text-muted-foreground">
                  Document {selectedDocIndex + 1} of {flatDocuments.length} • Press Esc to close, ← → to navigate
                </p>
              </div>
              <button onClick={() => setSelectedDocIndex(-1)} className="text-muted-foreground hover:text-foreground">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="p-0">
              {activeDocument.requirement.files && activeDocument.requirement.files.length > 1 ? (
                <div className="flex flex-col gap-4 p-0 overflow-y-auto">
                  {activeDocument.requirement.files.map((f, idx) => (
                    <div key={f.id} className="w-full">
                      <div className="relative w-full h-[98vh]" style={{ minHeight: "98vh" }}>
                        {imageLoading && (
                          <div className="absolute inset-0 flex items-center justify-center bg-muted/50 rounded-md z-10">
                            <Loader2 className="h-8 w-8 animate-spin text-primary" />
                          </div>
                        )}
                        <Image
                          src={f.downloadUrl || "/placeholder.svg"}
                          alt={activeDocument.requirement.name}
                          fill
                          sizes="(max-width: 768px) 100vw, 80vw"
                          className="object-contain rounded-md w-full h-full"
                          priority
                          unoptimized
                          onLoad={() => setImageLoading(false)}
                        />
                      </div>
                      {idx !== activeDocument.requirement.files.length - 1 && (
                        <div className="h-2 bg-border w-full my-2" />
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="relative w-full h-[98vh]" style={{ minHeight: "98vh" }}>
                  {imageLoading && (
                    <div className="absolute inset-0 flex items-center justify-center bg-muted/50 rounded-md">
                      <Loader2 className="h-8 w-8 animate-spin text-primary" />
                    </div>
                  )}
                  <Image
                    src={activeDocument.file.downloadUrl || "/placeholder.svg"}
                    alt={activeDocument.requirement.name}
                    fill
                    sizes="(max-width: 768px) 100vw, 80vw"
                    className="object-contain rounded-md w-full h-full"
                    priority
                    unoptimized
                    onLoad={() => setImageLoading(false)}
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
