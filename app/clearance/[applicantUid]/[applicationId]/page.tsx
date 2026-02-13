"use client"

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useParams, useRouter, useSearchParams } from "next/navigation"
import Image from "next/image"
import { onValue, ref } from "firebase/database"
import { onAuthStateChanged } from "firebase/auth"
import { ArrowLeft, CheckCircle, ChevronLeft, ChevronRight, Loader2, X, XCircle } from "lucide-react"
import Header from "@/components/header"
import { Button } from "@/components/ui/button"
import { toast } from "sonner"
import { realtimeDb, auth as firebaseAuth } from "@/database/firebase"
import { getStatusBadge, type BusinessRequirement } from "@/lib/business-applications"
import {
  MAYORS_CLEARANCE_APPLICATION_PATH,
  normalizeClearanceApplicant,
  type ClearanceApplicationRecord,
} from "@/lib/clearance-applications"
import { renderAsync } from "docx-preview"
import { handlePrintHtml } from "@/lib/print"

// Helper to sanitize keys for Firebase RTDB paths
const sanitizeKey = (key: string) => key.replace(/[.#$\/\[\]]/g, "_")

// Firebase REST API URL
const FIREBASE_DATABASE_URL = process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL

// REST API helper to bypass SDK cache issues
const firebaseRestUpdate = async (path: string, data: Record<string, unknown>, idToken: string) => {
  const url = `${FIREBASE_DATABASE_URL}/${path}.json?auth=${idToken}`
  const response = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  })
  if (!response.ok) {
    throw new Error(`Firebase REST update failed: ${response.status} ${response.statusText}`)
  }
  return response.json()
}

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

function ClearanceRequirementsContent() {
  const params = useParams()
  const router = useRouter()
  const searchParams = useSearchParams()

  const applicantUid = params.applicantUid as string
  const applicationId = params.applicationId as string

  const [application, setApplication] = useState<ClearanceApplicationRecord | null>(null)
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

  const [isDocxModalOpen, setIsDocxModalOpen] = useState(false)
  const [isDocxLoading, setIsDocxLoading] = useState(false)
  const [docxContent, setDocxContent] = useState<string | null>(null)
  const docxPreviewCancelRef = useRef(false)

  const previousFilesRef = useRef<
    Map<string, { fileName: string; fileSize: number; fileHash: string; status: string }>
  >(new Map())

  // Wait for Firebase Auth to be ready
  useEffect(() => {
    if (!firebaseAuth) {
      setIsAuthReady(true)
      return
    }

    const auth = firebaseAuth // Local reference for type narrowing
    let cancelled = false
    
    const waitForAuth = async () => {
      // Wait for auth state with polling for IndexedDB restoration
      await new Promise<void>((resolve) => {
        let resolved = false
        let delayTimeoutId: NodeJS.Timeout | null = null
        let pollIntervalId: NodeJS.Timeout | null = null
        
        const cleanup = () => {
          if (delayTimeoutId) clearTimeout(delayTimeoutId)
          if (pollIntervalId) clearInterval(pollIntervalId)
        }
        
        // Poll every 100ms to check if user was restored
        pollIntervalId = setInterval(() => {
          if (!resolved && auth.currentUser) {
            resolved = true
            cleanup()
            unsubscribe()
            resolve()
          }
        }, 100)
        
        const unsubscribe = onAuthStateChanged(auth, (user) => {
          if (resolved) return
          if (user) {
            resolved = true
            cleanup()
            unsubscribe()
            resolve()
          } else {
            // Wait 3 seconds for IndexedDB restoration
            if (!delayTimeoutId) {
              delayTimeoutId = setTimeout(() => {
                if (!resolved) {
                  resolved = true
                  cleanup()
                  unsubscribe()
                  resolve()
                }
              }, 3000)
            }
          }
        })
        
        // Ultimate timeout after 6 seconds
        setTimeout(() => {
          if (!resolved) {
            resolved = true
            cleanup()
            unsubscribe()
            resolve()
          }
        }, 6000)
      })
      
      if (cancelled) return
      setIsAuthReady(true)
    }
    
    waitForAuth()
    
    return () => {
      cancelled = true
    }
  }, [router])

  const requirements = application?.requirements ?? []
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
    if (!activeDocument) return false
    const fileName = activeDocument.file.fileName?.toLowerCase() ?? ""
    return fileName.endsWith(".docx") || fileName.endsWith(".doc")
  }, [activeDocument])

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

  useEffect(() => {
    if (!applicantUid || !applicationId) return

    setIsLoading(true)
    setError(null)

    const recordRef = ref(realtimeDb, `${MAYORS_CLEARANCE_APPLICATION_PATH}/${applicantUid}/${applicationId}`)
    const unsubscribe = onValue(
      recordRef,
      (snapshot) => {
        if (!snapshot.exists()) {
          setApplication(null)
          setError("Application not found.")
          setIsLoading(false)
          return
        }

        const payload = snapshot.val()
        const normalized = normalizeClearanceApplicant(applicationId, {
          ...payload,
          meta: { applicantUid, ...(payload?.meta ?? {}) },
        })
        setApplication(normalized)
        setError(null)
        setIsLoading(false)
      },
      (err) => {
        console.error("Failed to load clearance application", err)
        setApplication(null)
        setError("Unable to load application. Please try again later.")
        setIsLoading(false)
      }
    )

    return () => unsubscribe()
  }, [applicantUid, applicationId])

  useEffect(() => {
    if (selectedDocIndex >= flatDocuments.length) {
      setSelectedDocIndex(-1)
    }
  }, [flatDocuments.length, selectedDocIndex])

  useEffect(() => {
    if (!application) return

    const prev = previousFilesRef.current
    const replacedFiles: Array<{ requirementName: string; fileId: string }> = []

    application.requirements.forEach((requirement) => {
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
          replacedFiles.push({ requirementName: requirement.name, fileId: file.id })
        }

        prev.set(key, { fileName, fileSize, fileHash, status: normalizedStatus })
      })
    })

    if (replacedFiles.length === 0) return

    // Use REST API to update replaced files (requires auth)
    ;(async () => {
      const currentUser = firebaseAuth?.currentUser
      if (!currentUser) {
        console.warn("Cannot mark replaced files as updated - user not authenticated")
        return
      }

      try {
        const idToken = await currentUser.getIdToken(true)
        const timestamp = Date.now()

        // Update each replaced file using REST API
        for (const { requirementName, fileId } of replacedFiles) {
          const safeReqName = sanitizeKey(requirementName)
          const safeFileId = sanitizeKey(fileId)
          const path = `${MAYORS_CLEARANCE_APPLICATION_PATH}/${applicantUid}/${application.id}/requirements/${safeReqName}/files/${safeFileId}`
          await firebaseRestUpdate(path, { status: "updated", uploadedAt: timestamp }, idToken)
        }

        // Update application status
        const statusPath = `${MAYORS_CLEARANCE_APPLICATION_PATH}/${applicantUid}/${application.id}`
        await firebaseRestUpdate(statusPath, { status: "Pending Update Review" }, idToken)
      } catch (err) {
        console.error("Failed to mark replaced clearance requirement as updated", err)
      }
    })()
  }, [applicantUid, application])

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

  const handleViewRequirement = (requirementId: string) => {
    const docIndex = flatDocuments.findIndex((doc) => doc.requirement.id === requirementId)
    if (docIndex === -1) {
      toast.info("No files uploaded for this requirement yet.")
      return
    }
    setImageLoading(true)
    const fileIds = flatDocuments[docIndex].requirement.files.map((f) => f.id)
    setLoadingFiles(new Set(fileIds))
    setSelectedDocIndex(docIndex)
  }

  const persistDocumentStatus = async (
    targetDocument: RequirementDocumentItem,
    status: LocalDocumentStatus["status"],
    note?: string
  ) => {
    if (!applicantUid || !applicationId) {
      toast.error("Missing application information.")
      return
    }

    const currentUser = firebaseAuth?.currentUser
    if (!currentUser) {
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

      const safeReqName = sanitizeKey(targetDocument.requirement.name || "requirement")
      const safeFileId = sanitizeKey(targetDocument.file.id || "file")

      const payload: { status: string; adminNote?: string } = { status }
      if (status === "rejected") payload.adminNote = note ?? ""
      else if (status === "approved") payload.adminNote = ""

      // Use REST API to bypass SDK cache issues
      if (targetDocument.requirement.files && targetDocument.requirement.files.length === 2) {
        const updates = targetDocument.requirement.files.map((f) => {
          const safeFId = sanitizeKey(f.id || "file")
          const path = `${MAYORS_CLEARANCE_APPLICATION_PATH}/${applicantUid}/${applicationId}/requirements/${safeReqName}/files/${safeFId}`
          return firebaseRestUpdate(path, payload, idToken)
        })
        await Promise.all(updates)
      } else {
        const path = `${MAYORS_CLEARANCE_APPLICATION_PATH}/${applicantUid}/${applicationId}/requirements/${safeReqName}/files/${safeFileId}`
        await firebaseRestUpdate(path, payload, idToken)
      }

      setDocumentStatuses((prev) => {
        const next = { ...prev }
        if (targetDocument.requirement.files && targetDocument.requirement.files.length === 2) {
          targetDocument.requirement.files.forEach((f) => {
            next[f.id] = note ? { status, reason: note } : { status }
          })
        } else {
          next[targetDocument.file.id] = note ? { status, reason: note } : { status }
        }
        return next
      })

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
    if (!activeDocument) return
    await persistDocumentStatus(activeDocument, "approved")
  }

  const handleRejectConfirm = async () => {
    if (!activeDocument || !rejectReason.trim()) return
    await persistDocumentStatus(activeDocument, "rejected", rejectReason.trim())
  }

  const handleBack = () => {
    const fromParam = searchParams.get("from")
    if (fromParam === "notification") {
      router.push("/")
      return
    }
    const page = searchParams.get("page")
    if (page) {
      router.push(`/?page=${page}`)
      return
    }
    router.push("/?page=clearance-applications")
  }

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
    setDocxContent(null)
    setIsDocxLoading(false)
  }

  if (isLoading || !isAuthReady) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          Loading clearance application...
        </div>
      </div>
    )
  }

  if (!application) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center space-y-4">
          <h1 className="text-2xl font-bold text-foreground">{error ?? "Application Not Found"}</h1>
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
            <h1 className="text-3xl font-bold text-foreground mb-1">{application.applicantName}</h1>
            {application.purpose && <p className="text-muted-foreground text-sm">Purpose: {application.purpose}</p>}
          </div>
          <div className="flex flex-wrap gap-3">
            {(() => {
              const badge = getStatusBadge(application.status, application.overallStatus)
              return (
                <span className={`px-3 py-1 rounded-full text-sm font-medium ${badge.className}`}>
                  {badge.label}
                </span>
              )
            })()}
            {application.applicationDate && (
              <span className="px-3 py-1 rounded-full text-sm font-medium bg-muted text-foreground/80">
                Application Date: {(() => {
                  const raw = application.applicationDate
                  const date = new Date(raw as string)
                  return Number.isNaN(date.getTime()) ? raw : date.toLocaleDateString()
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
                            <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-700">
                              Pending
                            </span>
                          </td>
                          <td className="border border-border p-3 text-center">
                            <div className="flex items-center justify-center gap-2">
                              <Button variant="outline" size="sm" disabled className="text-muted-foreground">
                                No Upload
                              </Button>
                            </div>
                          </td>
                        </tr>
                      )
                    }

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
                            {files.length > 1 && <span className="text-xs text-muted-foreground">{files.length} files</span>}
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
                              disabled={files.length === 0 || docIndex === -1}
                              onClick={() => handleViewRequirement(requirement.id)}
                            >
                              View
                            </Button>
                            {files.some((f) => ((documentStatuses[f.id]?.status ?? f.status ?? "") as string).toLowerCase() === "updated") && (
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
                const currentReqIndex = requirements.findIndex((r) => r.id === activeDocument.requirement.id)
                if (currentReqIndex > 0) {
                  const prevRequirement = requirements[currentReqIndex - 1]
                  const targetIndex = flatDocuments.findIndex((d) => d.requirement.id === prevRequirement.id)
                  if (targetIndex !== -1) {
                    setImageLoading(true)
                    setSelectedDocIndex(targetIndex)
                  }
                }
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
                const currentReqIndex = requirements.findIndex((r) => r.id === activeDocument.requirement.id)
                if (currentReqIndex >= 0 && currentReqIndex < requirements.length - 1) {
                  const nextRequirement = requirements[currentReqIndex + 1]
                  const targetIndex = flatDocuments.findIndex((d) => d.requirement.id === nextRequirement.id)
                  if (targetIndex !== -1) {
                    setImageLoading(true)
                    setSelectedDocIndex(targetIndex)
                  }
                }
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
                  Document {selectedDocIndex + 1} of {flatDocuments.length}
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
                        {idx !== activeDocument.requirement.files.length - 1 && <div className="h-2 bg-border w-full my-2" />}
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
                  {isDocxLoading ? "Preparing preview..." : "Preview / Print"}
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
                onClick={(e) => {
                  e.stopPropagation()
                  setShowRejectModal(true)
                }}
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
              Please provide a reason for rejecting "{activeDocument?.requirement.name}"
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
              <button onClick={handleCloseDocxModal} className="text-muted-foreground hover:text-foreground">
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
              {!isDocxLoading && docxContent && (
                <div className="prose max-w-none" dangerouslySetInnerHTML={{ __html: docxContent }} />
              )}
              {!isDocxLoading && !docxContent && (
                <p className="text-muted-foreground text-sm">Unable to display this document.</p>
              )}
            </div>
            <div className="px-4 py-3 border-t border-border flex justify-end">
              <Button
                size="sm"
                onClick={() => {
                  if (docxContent) {
                    handlePrintHtml(docxContent, activeDocument?.requirement.name ?? "Document Preview")
                  }
                }}
                disabled={!docxContent || isDocxLoading}
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

export default function ClearanceRequirementPage() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <ClearanceRequirementsContent />
    </Suspense>
  )
}
