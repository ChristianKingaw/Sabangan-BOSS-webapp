"use client"

import * as React from "react"
import { AlertTriangle, Wifi, WifiOff } from "lucide-react"
import { useConnectionStatus } from "@/hooks/use-connection-status"
import { cn } from "@/lib/utils"

export function NetworkStatus() {
  const [mounted, setMounted] = React.useState(false)
  const status = useConnectionStatus()
  const [visible, setVisible] = React.useState(false)
  const hideTimer = React.useRef<number | null>(null)

  React.useEffect(() => {
    setMounted(true)
  }, [])

  React.useEffect(() => {
    if (hideTimer.current) {
      window.clearTimeout(hideTimer.current)
      hideTimer.current = null
    }

    if (status === "online") {
      setVisible(true)
      hideTimer.current = window.setTimeout(() => {
        setVisible(false)
      }, 3000)
    } else if (status === "offline") {
      setVisible(true)
    } else {
      // Unstable → hide until a definite state arrives
      setVisible(false)
    }

    return () => {
      if (hideTimer.current) {
        window.clearTimeout(hideTimer.current)
        hideTimer.current = null
      }
    }
  }, [status])

  if (!mounted) {
    // Avoid hydration mismatch
    return null
  }

  const shouldShow = status === "offline" || visible
  if (!shouldShow) return null

  return (
    <div
      className="pointer-events-none fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center justify-center"
      role="status"
      aria-live="polite"
    >
      <div className="pointer-events-auto flex items-center gap-2 rounded-full border bg-card/90 px-3 py-2 text-sm shadow-sm backdrop-blur">
        <span
          className={cn(
            "flex h-2 w-2 items-center justify-center rounded-full",
            status === "online" ? "bg-emerald-500" : "bg-destructive",
          )}
          aria-hidden="true"
        />
        {status === "online" && (
          <>
            <Wifi className="h-4 w-4 text-emerald-600" aria-hidden="true" />
            <span className="text-foreground">Online</span>
          </>
        )}
        {status === "offline" && (
          <>
            <WifiOff className="h-4 w-4 text-destructive" aria-hidden="true" />
            <span className="text-destructive">Offline</span>
          </>
        )}
      </div>
    </div>
  )
}
