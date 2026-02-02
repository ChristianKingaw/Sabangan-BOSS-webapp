"use client"

import { useEffect, useState, useRef } from "react"
import { realtimeDb } from "@/database/firebase"
import { BUSINESS_APPLICATION_PATH, normalizeBusinessApplication } from "@/lib/business-applications"
import { ref, onValue, push, off } from "firebase/database"
import { getAuth } from "firebase/auth"
import { Button } from "@/components/ui/button"
import { X, ChevronDown } from "lucide-react"


type Msg = {
  id: string
  senderRole?: string
  senderUid?: string
  text?: string
  ts?: number
  inReplyTo?: string | null
}

type ApplicationItem = {
  id: string
  displayName: string
  hasChat: boolean
  chatFromJson?: Msg[]
  applicantName?: string
  businessName?: string
  lastMessageTs?: number
  lastClientMessageTs?: number
}

export default function Messenger({
  onClose,
  lastReadMap,
  onMarkRead,
  latestClientTsMap,
}: {
  onClose: () => void
  lastReadMap: Record<string, number>
  onMarkRead: (appId: string, lastClientTs?: number) => void
  latestClientTsMap?: Record<string, number>
}) {
  
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState("")
  const [matchedAppId, setMatchedAppId] = useState<string | null>(null)
  const [applications, setApplications] = useState<ApplicationItem[]>([])
  const [selectedAppId, setSelectedAppId] = useState<string | null>(null)
  const [replyTarget, setReplyTarget] = useState<null | { type: "req"; reqName: string; messageId?: string; preview?: string }>(null)
  const messageRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const [highlightedId, setHighlightedId] = useState<string | null>(null)
  const messagesContainerRef = useRef<HTMLDivElement | null>(null)
  const [isAtBottom, setIsAtBottom] = useState(true)
  const initialScrollRef = useRef(true)

  const scrollToMessage = (targetId?: string | null) => {
    if (!targetId) return
    const el = messageRefs.current[targetId]
    if (el) {
      try {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
        setHighlightedId(targetId)
        window.setTimeout(() => setHighlightedId(null), 2000)
      } catch {}
    }
  }

  const scrollToBottom = () => {
    const c = messagesContainerRef.current
    if (!c) return
    try {
      c.scrollTo({ top: c.scrollHeight, behavior: 'smooth' })
    } catch {
      c.scrollTop = c.scrollHeight
    }
  }

  useEffect(() => {
    const el = messagesContainerRef.current
    if (!el) return
    const threshold = 50
    const check = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= threshold
      setIsAtBottom(atBottom)
    }
    check()
    el.addEventListener('scroll', check, { passive: true })
    // On initial load for the selected app, scroll to bottom
    if (initialScrollRef.current) {
      // run after a tick so content is rendered
      setTimeout(() => {
        try { el.scrollTo({ top: el.scrollHeight }) } catch { el.scrollTop = el.scrollHeight }
        initialScrollRef.current = false
        setIsAtBottom(true)
      }, 50)
    }
    return () => el.removeEventListener('scroll', check)
  }, [messages.length, selectedAppId])

  // When selectedAppId changes, mark for initial scroll so the container will
  // jump to latest on the next messages effect run.
  useEffect(() => {
    initialScrollRef.current = true
  }, [selectedAppId])

  // No user fetch — this messenger lists applications with chats only.

  // user-based resolution removed; messenger is application-centric

  // Load list of applications from the realtime database and use DB chats when present.
  useEffect(() => {
    let mounted = true

    setApplications([])
    const appsRef = ref(realtimeDb, BUSINESS_APPLICATION_PATH)
    const handle = onValue(appsRef, (snap) => {
      try {
        const businessNode = snap.val() || {}
        const list: ApplicationItem[] = Object.entries(businessNode).map(([id, payload]) => {
          const normalized = normalizeBusinessApplication(id, payload)
          const applicantName = normalized.applicantName ?? ""

          const chatNode = (payload as any)?.chat ?? null
          const appChats: Msg[] = chatNode
            ? Object.entries(chatNode).map(([cid, c]) => ({ id: `app:${cid}`, senderRole: (c as any).senderRole, senderUid: (c as any).senderUid, text: (c as any).text, ts: (c as any).ts }))
            : []

          const reqNode = (payload as any)?.requirements ?? null
          const hasRequirements = reqNode && Object.keys(reqNode).length > 0
          const reqChats: Msg[] = reqNode
            ? Object.entries(reqNode).flatMap(([reqName, reqData]) => {
                const rChat = (reqData as any)?.chat ?? null
                if (!rChat) return []
                return Object.entries(rChat).map(([cid, c]) => ({ id: `req:${reqName}:${cid}`, senderRole: (c as any).senderRole, senderUid: (c as any).senderUid, text: `Issue: ${reqName} - ${(c as any).text}`, ts: (c as any).ts }))
              })
            : []

          const combined = [...appChats, ...reqChats].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))
          const chatFromJson: Msg[] | undefined = combined.length > 0 ? combined : undefined

          // Include application if it has any requirement nodes (even without chat) or has chat messages
          const lastTs = combined.length > 0 ? Math.max(...combined.map(c => (c.ts ?? 0))) : undefined
          const clientTs = combined
            .filter((c) => (c.senderRole ?? "").toString().toLowerCase() !== "admin" && typeof c.ts === "number")
            .map((c) => c.ts as number)
          const lastClientTs = clientTs.length > 0 ? Math.max(...clientTs) : undefined

          return {
            id,
            displayName: applicantName === "Unnamed Applicant" ? (normalized.businessName || id) : (applicantName || normalized.businessName || id),
            hasChat: !!chatFromJson || !!hasRequirements,
            chatFromJson,
            applicantName,
            businessName: normalized.businessName,
            lastMessageTs: lastTs,
            lastClientMessageTs: lastClientTs,
          }
        }).filter(a => a.hasChat && a.applicantName !== "Unnamed Applicant")

        if (mounted) setApplications(list)
      } catch (e) {
        console.warn('Failed to load business data from DB', e)
        if (mounted) setApplications([])
      }
    })

    return () => {
      mounted = false
      try { off(appsRef) } catch {}
      try { if (typeof handle === 'function') handle() } catch {}
    }
  }, [])

  // Subscribe to selected application chat
  useEffect(() => {
    if (!selectedAppId) return

    // Always subscribe to realtime DB for both the main chat and requirement-level chats.
    // If the application also has chat data in the local JSON, we'll merge it with DB messages
    // and let DB messages take precedence.
    setMatchedAppId(selectedAppId)
    setMessages([])

    const app = applications.find((a) => a.id === selectedAppId)
    const jsonMsgs: Msg[] | undefined = app?.chatFromJson

    let mainData: any = {}
    let reqsData: any = {}

    const updateMessagesFromSources = () => {
      const dbMainList: Msg[] = mainData
        ? Object.entries(mainData).map(([id, payload]) => ({ id: `app:${id}`, senderRole: (payload as any).senderRole, senderUid: (payload as any).senderUid, text: (payload as any).text, ts: (payload as any).ts, inReplyTo: (payload as any).inReplyTo ?? null }))
        : []

      const dbReqList: Msg[] = reqsData
        ? Object.entries(reqsData).flatMap(([reqName, reqNode]) => {
            const chatNode = (reqNode as any)?.chat ?? null
            if (!chatNode) return []
            return Object.entries(chatNode).map(([cid, c]) => ({ id: `req:${reqName}:${cid}`, senderRole: (c as any).senderRole, senderUid: (c as any).senderUid, text: `Issue: ${reqName} - ${(c as any).text}`, ts: (c as any).ts, inReplyTo: (c as any).inReplyTo ?? null }))
          })
        : []

      const mergedMap = new Map<string, Msg>()

      if (jsonMsgs && jsonMsgs.length > 0) {
        for (const jm of jsonMsgs) mergedMap.set(jm.id, jm)
      }

      for (const d of [...dbMainList, ...dbReqList]) {
        mergedMap.set(d.id, d)
      }

      const merged = Array.from(mergedMap.values()).sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))
      setMessages(merged)
    }

    const mainRef = ref(realtimeDb, `${BUSINESS_APPLICATION_PATH}/${selectedAppId}/chat`)
    const unsubMain = onValue(mainRef, (snap) => {
      mainData = snap.val() || {}
      updateMessagesFromSources()
    })

    const reqRef = ref(realtimeDb, `${BUSINESS_APPLICATION_PATH}/${selectedAppId}/requirements`)
    const unsubReq = onValue(reqRef, (snap) => {
      reqsData = snap.val() || {}
      updateMessagesFromSources()
    })

    return () => {
      try { off(mainRef) } catch {}
      try { off(reqRef) } catch {}
      try { if (typeof unsubMain === 'function') unsubMain() } catch {}
      try { if (typeof unsubReq === 'function') unsubReq() } catch {}
      setMatchedAppId(null)
    }
  }, [selectedAppId])

  // application-centric messenger: no user display name helpers

  const handleSend = async () => {
    if (!input.trim() || !selectedAppId) return
    const auth = getAuth()
    const user = auth.currentUser
    if (!user) return alert("You must be logged in to send messages.")

    try {
      // Allow sending replies to both requirement-level chats and main chat even when
      // the application has historical messages from a local JSON file. Messages
      // will be written to the realtime DB.
      const app = applications.find((a) => a.id === selectedAppId)

      // If replying to a requirement-level message, write to that requirement's chat path
      if (replyTarget && replyTarget.reqName) {
        const payload = {
          senderRole: "admin",
          senderUid: user.uid,
          text: input.trim(),
          ts: Date.now(),
          inReplyTo: replyTarget.messageId ?? null,
        }
        const reqChatRef = ref(realtimeDb, `${BUSINESS_APPLICATION_PATH}/${selectedAppId}/requirements/${replyTarget.reqName}/chat`)
        const newRef = await push(reqChatRef, payload)
      } else {
        const chatRef = ref(realtimeDb, `${BUSINESS_APPLICATION_PATH}/${selectedAppId}/chat`)
        const payload = {
          senderRole: "admin",
          senderUid: user.uid,
          text: input.trim(),
          ts: Date.now(),
          inReplyTo: replyTarget?.messageId ?? null,
        }
        const newRef = await push(chatRef, payload)
      }

      setInput("")
      setReplyTarget(null)
    } catch (err) {
      console.error("Failed to send message", err)
      alert("Failed to send message. Please try again.")
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative z-10 max-w-4xl w-full h-[80vh] bg-card border border-border rounded-lg overflow-hidden shadow-lg flex">
        <div className="w-72 border-r border-border p-3 overflow-y-auto h-full">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h3 className="text-lg font-semibold text-foreground">Messages</h3>
                    <div className="text-xs text-muted-foreground">{applications.length} application{applications.length !== 1 ? "s" : ""}</div>
              </div>
          </div>
          <div className="space-y-2">
            {applications.length === 0 && <div className="text-sm text-muted-foreground">No applications with chats</div>}
            {applications.map((a) => {
              const latestTs = (latestClientTsMap && latestClientTsMap[a.id]) ?? a.lastClientMessageTs ?? 0
              const unread = latestTs > (lastReadMap[a.id] ?? 0)
              return (
                <button
                  key={a.id}
                  onClick={() => { setSelectedAppId(a.id); onMarkRead(a.id, a.lastClientMessageTs) }}
                  className={`w-full text-left p-2 rounded-md transition-colors ${selectedAppId === a.id ? "bg-primary/10" : "hover:bg-muted/30"}`}
                >
                  <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div className="font-medium">{a.displayName}</div>
                      </div>
                    {unread && (
                      <span
                        role="button"
                        tabIndex={0}
                        onClick={(e) => {
                          e.stopPropagation()
                          onMarkRead(a.id, a.lastClientMessageTs)
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            e.stopPropagation()
                            onMarkRead(a.id, a.lastClientMessageTs)
                          }
                        }}
                        aria-label="Mark messages read"
                        className="h-3 w-3 bg-rose-500 rounded-full"
                      />
                    )}
                  </div>
                </button>
              )
            })}
          </div>
        </div>
        <div className="flex-1 p-4 flex flex-col h-full">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <div className="font-semibold text-foreground flex items-baseline gap-2">
                <div>{selectedAppId ? (applications.find(a => a.id === selectedAppId)?.displayName ?? selectedAppId) : "Select an application"}</div>
                {selectedAppId && (
                  <div className="text-sm text-muted-foreground">{applications.find(a => a.id === selectedAppId)?.businessName ?? ""}</div>
                )}
              </div>
            </div>
            <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
              <X className="h-4 w-4" />
            </button>
          </div>

          <div ref={messagesContainerRef} className="flex-1 overflow-y-auto space-y-2 mb-3">
            {selectedAppId ? (
              messages.length === 0 ? (
                <div className="text-sm text-muted-foreground">No messages yet.</div>
              ) : (
                messages.map((m) => {
                  const raw = m.text ?? ""
                  let issueLabel: string | null = null
                  let body = raw
                  if (raw.startsWith("Issue: ")) {
                    const parts = raw.split(" - ")
                    if (parts.length >= 2) {
                      issueLabel = parts[0]
                      body = parts.slice(1).join(" - ")
                    }
                  }

                  const isAdmin = m.senderRole === "admin"

                  return (
                    <div key={m.id} className={`w-full flex ${isAdmin ? 'justify-end' : 'justify-start'}`}>
                      <div ref={(el) => { messageRefs.current[m.id] = el }} className={`border border-border p-3 rounded-md shadow-sm max-w-[72%] ${isAdmin ? 'bg-primary/10' : 'bg-muted/30'} ${highlightedId === m.id ? 'ring-2 ring-primary/50' : ''}`}>
                        <div className="flex items-center justify-between">
                          <div className="text-xs text-muted-foreground">{m.senderRole ?? m.senderUid}</div>
                          <div className="text-xs">
                            {m.id.startsWith('req:') && m.senderRole !== 'admin' && (
                              <button
                                className="text-xs text-primary hover:underline"
                                onClick={() => {
                                  const parts = m.id.split(':')
                                  const reqName = parts[1]
                                  setReplyTarget({ type: 'req', reqName, messageId: m.id, preview: body })
                                }}
                              >
                                Reply
                              </button>
                            )}
                          </div>
                        </div>
                        <div className="text-sm text-foreground mt-1">
                          {issueLabel && (
                            <span className="inline-block bg-yellow-100 text-yellow-800 px-2 py-0.5 rounded text-xs mr-2">{issueLabel}</span>
                          )}
                          {body}
                        </div>
                        <div className="flex items-center justify-between mt-1">
                          <div className="text-xs text-muted-foreground">{m.ts ? new Date(m.ts).toLocaleString() : ""}</div>
                          <div>
                            {m.inReplyTo && (
                              <button className="text-xs text-primary hover:underline" onClick={() => scrollToMessage(m.inReplyTo)}>
                                View context
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  )
                })
              )
            ) : (
              <div className="text-sm text-muted-foreground">Choose an application to view messages.</div>
            )}
          </div>

          <div className="flex gap-2">
            <div className="flex-1">
              {replyTarget && (
                <div className="mb-2 p-2 bg-muted/10 rounded flex items-center justify-between">
                  <div className="text-sm">Replying to: <span className="font-medium">{replyTarget.preview ?? ''}</span></div>
                  <button className="text-xs text-muted-foreground hover:underline" onClick={() => setReplyTarget(null)}>Cancel</button>
                </div>
              )}
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={selectedAppId ? "Write a message..." : "Select an application to message"}
                disabled={!selectedAppId}
                className="w-full p-2 border border-border rounded bg-background"
              />
            </div>
            {!isAtBottom && (
              <Button onClick={scrollToBottom} className="h-8 w-8 p-0" title="Go to latest">
                <ChevronDown className="h-4 w-4" />
              </Button>
            )}
            <Button onClick={handleSend} disabled={!selectedAppId || !input.trim()}>
              Send
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
