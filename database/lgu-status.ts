import { app, realtimeDb } from "@/database/firebase"
import { getAuth } from "firebase/auth"
import {
  ref,
  onValue,
  get,
  type Unsubscribe,
} from "firebase/database"

export const STATUS_BOARD_PATH = "lgu_sabangan_status/statusBoard"

export type MunicipalityStatus = {
  isOpen: boolean
  officeHours?: string
  publicNote?: string
  lastUpdatedAt?: number
  lastUpdatedBy?: string
}

export type MayorStatus = {
  availability: string
  expectedBack?: string
  note?: string
}

export type FeaturedEvent = {
  enabled: boolean
  title: string
  subtitle?: string
  date?: string
  time?: string
  location?: string
  details?: string
  category?: string
  bannerUrl?: string
  updatedAt?: number
  updatedBy?: string
}

export type UpcomingEvent = {
  id: string
  title: string
  date: string
  time?: string
  location?: string
  category?: string
  details?: string
}

export type UpcomingEventInput = Omit<UpcomingEvent, "id">

export type StatusBoardData = {
  municipality: MunicipalityStatus
  mayor: MayorStatus
  featuredEvent: FeaturedEvent
  upcomingEvents: UpcomingEvent[]
}

type StatusBoardRecord = {
  municipality?: Partial<MunicipalityStatus> | null
  mayor?: Partial<MayorStatus> | null
  featuredEvent?: Partial<FeaturedEvent> | null
  upcomingEvents?: Record<string, Partial<UpcomingEventInput> | null>
}

const defaultMunicipality: MunicipalityStatus = {
  isOpen: true,
  officeHours: "",
  publicNote: "",
}

const defaultMayor: MayorStatus = {
  availability: "available",
  expectedBack: "",
  note: "",
}

const defaultFeaturedEvent: FeaturedEvent = {
  enabled: false,
  title: "",
  subtitle: "",
  date: "",
  time: "",
  location: "",
  details: "",
  category: "",
  bannerUrl: "",
}

type LguStatusWriteAction =
  | { action: "saveMunicipalityStatus"; payload: Partial<MunicipalityStatus> }
  | { action: "saveMayorStatus"; payload: Partial<MayorStatus> }
  | { action: "saveFeaturedEvent"; payload: Partial<FeaturedEvent> }
  | { action: "addUpcomingEvent"; payload: UpcomingEventInput }
  | { action: "updateUpcomingEvent"; eventId: string; payload: Partial<UpcomingEventInput> }
  | { action: "deleteUpcomingEvent"; eventId: string }

async function getAuthTokenOrThrow() {
  const auth = getAuth(app)
  const currentUser = auth?.currentUser
  if (!currentUser) {
    throw new Error("Session expired. Please log in again.")
  }
  return currentUser.getIdToken()
}

async function requestLguStatusWrite<T = void>(body: LguStatusWriteAction): Promise<T> {
  const idToken = await getAuthTokenOrThrow()
  const response = await fetch("/api/lgu-status", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const errorPayload = (await response.json().catch(() => null)) as { error?: string } | null
    throw new Error(errorPayload?.error || "Failed to update LGU status.")
  }

  if (response.status === 204) {
    return undefined as T
  }

  return (await response.json()) as T
}

function sanitizePayload<T extends Record<string, unknown>>(payload: T) {
  const next: Record<string, unknown> = {}
  Object.entries(payload).forEach(([key, value]) => {
    if (value !== undefined) {
      next[key] = value
    }
  })
  return next as T
}

function mapStatusBoard(record?: StatusBoardRecord | null): StatusBoardData | null {
  if (!record) {
    return null
  }

  const municipality: MunicipalityStatus = {
    ...defaultMunicipality,
    ...record.municipality,
    isOpen:
      typeof record.municipality?.isOpen === "boolean"
        ? record.municipality.isOpen
        : defaultMunicipality.isOpen,
  }

  const mayor: MayorStatus = {
    ...defaultMayor,
    ...record.mayor,
    availability: record.mayor?.availability ?? defaultMayor.availability,
  }

  const featuredEvent: FeaturedEvent = {
    ...defaultFeaturedEvent,
    ...record.featuredEvent,
    enabled:
      typeof record.featuredEvent?.enabled === "boolean"
        ? record.featuredEvent.enabled
        : defaultFeaturedEvent.enabled,
    title: record.featuredEvent?.title ?? defaultFeaturedEvent.title,
  }

  const upcomingEvents: UpcomingEvent[] = record.upcomingEvents
    ? Object.entries(record.upcomingEvents)
        .filter(([, value]) => Boolean(value))
        .map(([id, value]) => ({
          id,
          title: value?.title ?? "",
          date: value?.date ?? "",
          time: value?.time ?? "",
          location: value?.location ?? "",
          category: value?.category ?? "",
          details: value?.details ?? "",
        }))
    : []

  upcomingEvents.sort((a, b) => {
    const aTime = Date.parse(a.date)
    const bTime = Date.parse(b.date)
    if (Number.isNaN(aTime) && Number.isNaN(bTime)) {
      return a.title.localeCompare(b.title)
    }
    if (Number.isNaN(aTime)) {
      return 1
    }
    if (Number.isNaN(bTime)) {
      return -1
    }
    return aTime - bTime
  })

  return {
    municipality,
    mayor,
    featuredEvent,
    upcomingEvents,
  }
}

export async function getStatusBoardOnce(): Promise<StatusBoardData | null> {
  const snapshot = await get(ref(realtimeDb, STATUS_BOARD_PATH))
  if (!snapshot.exists()) {
    return null
  }
  return mapStatusBoard(snapshot.val() as StatusBoardRecord)
}

export function subscribeToStatusBoard(
  callback: (data: StatusBoardData | null) => void,
  onError?: (error: Error) => void
): Unsubscribe {
  const statusRef = ref(realtimeDb, STATUS_BOARD_PATH)
  return onValue(
    statusRef,
    (snapshot) => {
      callback(mapStatusBoard(snapshot.val() as StatusBoardRecord))
    },
    (error) => {
      console.error("Failed to listen for status board updates", error)
      if (onError) {
        onError(error)
      }
    }
  )
}

export async function saveMunicipalityStatus(data: Partial<MunicipalityStatus>) {
  await requestLguStatusWrite({
    action: "saveMunicipalityStatus",
    payload: sanitizePayload(data),
  })
}

export async function saveMayorStatus(data: Partial<MayorStatus>) {
  await requestLguStatusWrite({
    action: "saveMayorStatus",
    payload: sanitizePayload(data),
  })
}

export async function saveFeaturedEvent(data: Partial<FeaturedEvent>) {
  await requestLguStatusWrite({
    action: "saveFeaturedEvent",
    payload: sanitizePayload(data),
  })
}

export async function addUpcomingEvent(data: UpcomingEventInput): Promise<string> {
  const result = await requestLguStatusWrite<{ id: string }>({
    action: "addUpcomingEvent",
    payload: sanitizePayload(data),
  })

  if (!result?.id) {
    throw new Error("Unable to create event entry")
  }

  return result.id
}

export async function updateUpcomingEvent(eventId: string, data: Partial<UpcomingEventInput>) {
  await requestLguStatusWrite({
    action: "updateUpcomingEvent",
    eventId,
    payload: sanitizePayload(data),
  })
}

export async function deleteUpcomingEvent(eventId: string) {
  await requestLguStatusWrite({
    action: "deleteUpcomingEvent",
    eventId,
  })
}
