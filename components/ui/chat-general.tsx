"use client"

import { useState, useMemo } from "react"
import { Button } from "@/components/ui/button"
import { realtimeDb } from "@/database/firebase"
import { getAuth } from "firebase/auth"
import { ref, push } from "firebase/database"
import { BUSINESS_APPLICATION_PATH } from "@/lib/business-applications"

export type ChatMessage = {
  id: string
  senderRole?: string
  senderUid?: string
  text?: string
  sentAt?: number
}

export default function ChatGeneral({ messages, applicationId }: { messages?: ChatMessage[]; applicationId: string }) {
  const [input, setInput] = useState("")
  const [sending, setSending] = useState(false)

  const sorted = useMemo(() => (messages ?? []).slice().sort((a, b) => (a.sentAt ?? 0) - (b.sentAt ?? 0)), [messages])

  const handleSend = async () => {
    if (!input.trim()) return
    const auth = getAuth()
    const user = auth.currentUser
    if (!user) return alert("You must be logged in to send messages.")

    try {
      setSending(true)
      const chatRef = ref(realtimeDb, `${BUSINESS_APPLICATION_PATH}/${applicationId}/chat`)
      await push(chatRef, {
        senderRole: "admin",
        senderUid: user.uid,
        text: input.trim(),
        ts: Date.now(),
      })
      setInput("")
    } catch (err) {
      console.error("Failed to send chat message", err)
      alert("Failed to send message. Please try again.")
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="mt-6 bg-card border border-border rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-lg font-semibold text-foreground">General Chat</h3>
      </div>

      <div className="max-h-48 overflow-y-auto mb-3 space-y-2">
        {sorted.length === 0 ? (
          <div className="text-sm text-muted-foreground">No messages yet.</div>
        ) : (
          sorted.map((m) => (
            <div key={m.id} className="p-2 rounded bg-muted/30">
              <div className="text-xs text-muted-foreground">{m.senderRole ?? m.senderUid}</div>
              <div className="text-sm text-foreground">{m.text}</div>
              <div className="text-xs text-muted-foreground">{m.sentAt ? new Date(m.sentAt).toLocaleString() : ""}</div>
            </div>
          ))
        )}
      </div>

      <div className="flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Write a message..."
          className="flex-1 p-2 border border-border rounded bg-background"
        />
        <Button onClick={handleSend} disabled={sending || !input.trim()}>
          Send
        </Button>
      </div>
    </div>
  )
}
