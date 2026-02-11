"use client"

import * as React from "react"
import { useNetworkStatus } from "@/hooks/use-network-status"

const HEARTBEAT_URL = "/api/health"
const ONLINE_INTERVAL_MS = 30000
const UNSTABLE_INTERVAL_MS = 10000
const OFFLINE_BACKOFF_STEPS = [15000, 30000, 60000, 120000]
const FAILURE_THRESHOLD = 3
const UNSTABLE_THRESHOLD = 2
const HEARTBEAT_TIMEOUT_MS = 5000

type ConnectionState = "online" | "unstable" | "offline"

export function useConnectionStatus(): ConnectionState {
  const isNetworkAvailable = useNetworkStatus()
  const [state, setState] = React.useState<ConnectionState>("online")
  const failureCount = React.useRef(0)
  const timeoutRef = React.useRef<number | null>(null)
  const intervalRef = React.useRef<number | null>(null)
  const offlineBackoffIndex = React.useRef(0)

  const clearTimers = React.useCallback(() => {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
    if (intervalRef.current !== null) {
      window.clearTimeout(intervalRef.current)
      intervalRef.current = null
    }
  }, [])

  React.useEffect(() => {
    let isActive = true

    const tick = async () => {
      clearTimers()

      const nextOfflineDelay = () => {
        const delay =
          OFFLINE_BACKOFF_STEPS[
            Math.min(offlineBackoffIndex.current, OFFLINE_BACKOFF_STEPS.length - 1)
          ]
        offlineBackoffIndex.current = Math.min(
          offlineBackoffIndex.current + 1,
          OFFLINE_BACKOFF_STEPS.length - 1,
        )
        return delay
      }

      const resetOfflineBackoff = () => {
        offlineBackoffIndex.current = 0
      }

      if (!isNetworkAvailable) {
        const delay = nextOfflineDelay()
        setState("offline")
        if (isActive) {
          intervalRef.current = window.setTimeout(tick, delay)
        }
        return
      }

      const controller = new AbortController()
      timeoutRef.current = window.setTimeout(
        () => controller.abort(),
        HEARTBEAT_TIMEOUT_MS,
      )

      let nextStatus: ConnectionState = state

      try {
        const res = await fetch(HEARTBEAT_URL, {
          method: "GET",
          cache: "no-store",
          signal: controller.signal,
          headers: {
            "x-connection-check": "true",
          },
        })

        if (res.ok) {
          failureCount.current = 0
          resetOfflineBackoff()
          nextStatus = "online"
          setState("online")
        } else {
          throw new Error("Heartbeat failed")
        }
      } catch (error) {
        failureCount.current += 1

        if (failureCount.current >= FAILURE_THRESHOLD) {
          nextStatus = "offline"
          setState("offline")
        } else if (failureCount.current >= UNSTABLE_THRESHOLD) {
          nextStatus = "unstable"
          setState("unstable")
        }
      } finally {
        controller.abort()
        clearTimers()
        const delay =
          nextStatus === "online"
            ? ONLINE_INTERVAL_MS
            : nextStatus === "unstable"
              ? UNSTABLE_INTERVAL_MS
              : nextOfflineDelay()
        if (isActive) {
          intervalRef.current = window.setTimeout(tick, delay)
        }
      }
    }

    tick()

    return () => {
      isActive = false
      clearTimers()
    }
  }, [isNetworkAvailable, clearTimers])

  React.useEffect(() => {
    if (!isNetworkAvailable) {
      setState("offline")
    }
  }, [isNetworkAvailable])

  return state
}
