'use client'

import { useEffect, useMemo, useState, type FormEvent } from "react"
import { useRouter } from "next/navigation"
import {
  LayoutDashboard,
  FileText,
  XCircle,
  Award,
  Plus,
  CalendarDays,
  RefreshCcw,
  Sparkles,
  MapPin,
  Clock,
  Power,
  ShieldCheck,
  AlertTriangle,
  Loader2,
  Trash2,
  Pencil,
  CheckCircle2,
  Building2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { toast } from "sonner"
import { getAuth, signOut } from "firebase/auth"
import { app as firebaseApp } from "@/database/firebase"
import {
  addUpcomingEvent,
  deleteUpcomingEvent,
  getStatusBoardOnce,
  saveFeaturedEvent,
  saveMayorStatus,
  saveMunicipalityStatus,
  subscribeToStatusBoard,
  updateUpcomingEvent,
  type FeaturedEvent,
  type MunicipalityStatus,
  type StatusBoardData,
  type UpcomingEvent,
  type UpcomingEventInput,
} from "@/database/lgu-status"
import { cn } from "@/lib/utils"

const firebaseAuth = getAuth(firebaseApp)

const navItems = [
  { id: "home", label: "Home", icon: LayoutDashboard, href: "/?page=home" },
  { id: "clients", label: "Business Application", icon: FileText, href: "/?page=clients" },
  { id: "clearance-clients", label: "Mayor's Clearance", icon: Award, href: "/?page=clearance-clients" },
  { id: "lgu-status", label: "LGU Status", icon: CalendarDays, href: "/lgu-status" },
] as const

const mayorAvailabilityOptions = [
  { value: "available", label: "Available at office" },
  { value: "in_meeting", label: "In a meeting" },
  { value: "on_field", label: "On field work" },
  { value: "on_leave", label: "On leave" },
  { value: "unavailable", label: "Temporarily unavailable" },
]

type MunicipalityFormState = Pick<MunicipalityStatus, "isOpen" | "officeHours" | "publicNote">
type OfficeHoursRange = {
  start: string
  end: string
}

type MayorFormState = {
  availability: string
  expectedBack: string
}
type FeaturedEventFormState = Pick<
  FeaturedEvent,
  "enabled" | "title" | "subtitle" | "date" | "time" | "location" | "details" | "category" | "bannerUrl"
>
type UpcomingEventFormState = UpcomingEventInput

const defaultMunicipalityForm: MunicipalityFormState = {
  isOpen: true,
  officeHours: "",
  publicNote: "",
}

const defaultMayorForm: MayorFormState = {
  availability: "available",
  expectedBack: "",
}

const defaultFeaturedEventForm: FeaturedEventFormState = {
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

const defaultUpcomingEventForm: UpcomingEventFormState = {
  title: "",
  date: "",
  time: "",
  location: "",
  category: "",
  details: "",
}

const defaultOfficeHoursRange: OfficeHoursRange = {
  start: "",
  end: "",
}

function formatTimeLabel(value: string) {
  if (!value) return "Select time"
  const [hoursStr, minutesStr] = value.split(":")
  const hours = Number(hoursStr)
  const minutes = Number(minutesStr)
  const period = hours >= 12 ? "PM" : "AM"
  const normalizedHour = ((hours + 11) % 12) + 1
  const paddedMinutes = minutes.toString().padStart(2, "0")
  return `${normalizedHour}:${paddedMinutes} ${period}`
}

function buildOfficeHoursLabel(range: OfficeHoursRange) {
  if (!range.start && !range.end) return ""
  if (range.start && range.end) {
    return `${formatTimeLabel(range.start)} - ${formatTimeLabel(range.end)}`
  }
  return range.start ? `${formatTimeLabel(range.start)} onwards` : `Until ${formatTimeLabel(range.end)}`
}

function convertTo24Hour(value: string) {
  if (!value) return ""
  const trimmed = value.trim()
  if (/^\d{2}:\d{2}$/.test(trimmed)) {
    return trimmed
  }
  const match = trimmed.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i)
  if (!match) {
    return ""
  }
  let hours = Number(match[1])
  const minutes = match[2] ? Number(match[2]) : 0
  const period = match[3]?.toUpperCase()
  if (period === "PM" && hours < 12) {
    hours += 12
  }
  if (period === "AM" && hours === 12) {
    hours = 0
  }
  return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`
}

function parseOfficeHoursRange(value?: string | null): OfficeHoursRange {
  if (!value) {
    return { ...defaultOfficeHoursRange }
  }
  const [rawStart, rawEnd] = value.split("-")
  return {
    start: convertTo24Hour(rawStart ?? ""),
    end: convertTo24Hour(rawEnd ?? ""),
  }
}

function toDateInputValue(value?: string) {
  if (!value) return ""
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return ""
  }
  return date.toISOString().slice(0, 10)
}

function formatFriendlyDate(value?: string) {
  if (!value) return "Not set"
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split("-").map((part) => Number(part))
    if (!Number.isNaN(year) && !Number.isNaN(month) && !Number.isNaN(day)) {
      const date = new Date(Date.UTC(year, month - 1, day))
      return new Intl.DateTimeFormat(undefined, {
        month: "long",
        day: "numeric",
        year: "numeric",
      }).format(date)
    }
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(date)
}

function formatDate(value?: string) {
  if (!value) return "Date TBA"
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) {
    return value
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date(parsed))
}

function formatTimestamp(value?: number) {
  if (!value) return "Not recorded"
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value))
}

function getMayorAvailabilityLabel(value?: string) {
  const match = mayorAvailabilityOptions.find((option) => option.value === value)
  return match ? match.label : "Status not set"
}

export default function LGUStatusPage() {
  const router = useRouter()
  const [loggedInEmail, setLoggedInEmail] = useState<string | null>(null)
  const [statusBoard, setStatusBoard] = useState<StatusBoardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isNavigating, setIsNavigating] = useState(false)

  const [municipalityForm, setMunicipalityForm] = useState(defaultMunicipalityForm)
  const [officeHoursRange, setOfficeHoursRange] = useState<OfficeHoursRange>(defaultOfficeHoursRange)
  const [mayorForm, setMayorForm] = useState(defaultMayorForm)
  const [featuredEventForm, setFeaturedEventForm] = useState(defaultFeaturedEventForm)
  const [eventForm, setEventForm] = useState(defaultUpcomingEventForm)
  const [editingEventId, setEditingEventId] = useState<string | null>(null)

  const [savingMunicipality, setSavingMunicipality] = useState(false)
  const [savingMayor, setSavingMayor] = useState(false)
  const [savingFeaturedEvent, setSavingFeaturedEvent] = useState(false)
  const [savingEvent, setSavingEvent] = useState(false)
  const [deletingEventId, setDeletingEventId] = useState<string | null>(null)

  useEffect(() => {
    if (typeof window === "undefined") {
      return
    }
    const storedEmail = localStorage.getItem("bossStaffEmail")
    if (!storedEmail) {
      router.replace("/")
      return
    }
    setLoggedInEmail(storedEmail)
  }, [router])

  useEffect(() => {
    const unsubscribe = subscribeToStatusBoard(
      (data) => {
        setStatusBoard(data)
        setLoading(false)
        setError(null)
      },
      (listenError) => {
        setError(listenError.message || "Unable to load LGU status board.")
        setLoading(false)
      }
    )

    return () => {
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (!statusBoard?.municipality) return
    setMunicipalityForm({
      isOpen: statusBoard.municipality.isOpen,
      officeHours: statusBoard.municipality.officeHours ?? "",
      publicNote: statusBoard.municipality.publicNote ?? "",
    })
    setOfficeHoursRange(parseOfficeHoursRange(statusBoard.municipality.officeHours ?? ""))
  }, [statusBoard?.municipality])

  useEffect(() => {
    if (!statusBoard?.mayor) return
    setMayorForm({
      availability: statusBoard.mayor.availability ?? "available",
      expectedBack: statusBoard.mayor.expectedBack ?? "",
    })
  }, [statusBoard?.mayor])

  useEffect(() => {
    if (!statusBoard?.featuredEvent) return
    setFeaturedEventForm({
      enabled: Boolean(statusBoard.featuredEvent.enabled),
      title: statusBoard.featuredEvent.title ?? "",
      subtitle: statusBoard.featuredEvent.subtitle ?? "",
      date: statusBoard.featuredEvent.date ?? "",
      time: statusBoard.featuredEvent.time ?? "",
      location: statusBoard.featuredEvent.location ?? "",
      details: statusBoard.featuredEvent.details ?? "",
      category: statusBoard.featuredEvent.category ?? "",
      bannerUrl: statusBoard.featuredEvent.bannerUrl ?? "",
    })
  }, [statusBoard?.featuredEvent])

  const upcomingEvents: UpcomingEvent[] = useMemo(() => {
    return statusBoard?.upcomingEvents ?? []
  }, [statusBoard?.upcomingEvents])

  const latestUpdate = useMemo(() => {
    const timestamps = [
      statusBoard?.municipality?.lastUpdatedAt,
      statusBoard?.featuredEvent?.updatedAt,
    ].filter((value): value is number => Boolean(value))
    if (!timestamps.length) {
      return null
    }
    return Math.max(...timestamps)
  }, [statusBoard?.municipality?.lastUpdatedAt, statusBoard?.featuredEvent?.updatedAt])

  const officeHoursSummary = municipalityForm.officeHours || "Not set"
  const expectedBackInputValue = toDateInputValue(mayorForm.expectedBack)
  const expectedBackSummary = formatFriendlyDate(mayorForm.expectedBack)

  const handleLogout = async () => {
    await signOut(firebaseAuth).catch(() => undefined)
    localStorage.removeItem("bossStaffEmail")
    router.replace("/")
  }

  const handleManualRefresh = async () => {
    setSyncing(true)
    try {
      const snapshot = await getStatusBoardOnce()
      setStatusBoard(snapshot)
      toast.success("Status board synced with Realtime Database")
    } catch (refreshError) {
      console.error(refreshError)
      toast.error("Unable to refresh LGU status board")
    } finally {
      setSyncing(false)
    }
  }

  const handleOfficeHourChange = (key: keyof OfficeHoursRange, value: string) => {
    setOfficeHoursRange((prev) => {
      const next = { ...prev, [key]: value }
      setMunicipalityForm((prevForm) => ({
        ...prevForm,
        officeHours: buildOfficeHoursLabel(next),
      }))
      return next
    })
  }

  const handleClearOfficeHours = () => {
    setOfficeHoursRange({ ...defaultOfficeHoursRange })
    setMunicipalityForm((prevForm) => ({
      ...prevForm,
      officeHours: "",
    }))
  }

  const handleMunicipalitySave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSavingMunicipality(true)
    const formattedOfficeHours = buildOfficeHoursLabel(officeHoursRange) || municipalityForm.officeHours
    try {
      await saveMunicipalityStatus({
        ...municipalityForm,
        officeHours: formattedOfficeHours,
        lastUpdatedAt: Date.now(),
        lastUpdatedBy: loggedInEmail ?? "web-admin",
      })
      toast.success("Municipality status updated")
    } catch (saveError) {
      console.error(saveError)
      toast.error("Failed to update municipality status")
    } finally {
      setSavingMunicipality(false)
    }
  }

  const handleExpectedBackChange = (value: string) => {
    setMayorForm((prev) => ({
      ...prev,
      expectedBack: value,
    }))
  }

  const handleClearExpectedBack = () => {
    setMayorForm((prev) => ({
      ...prev,
      expectedBack: "",
    }))
  }

  const handleMayorSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSavingMayor(true)
    try {
      await saveMayorStatus({
        availability: mayorForm.availability,
        expectedBack: mayorForm.expectedBack,
      })
      toast.success("Mayor availability updated")
    } catch (saveError) {
      console.error(saveError)
      toast.error("Failed to update mayor status")
    } finally {
      setSavingMayor(false)
    }
  }

  const handleFeaturedEventSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!featuredEventForm.title.trim()) {
      toast.error("Featured event requires a title")
      return
    }
    setSavingFeaturedEvent(true)
    try {
      await saveFeaturedEvent({
        ...featuredEventForm,
        updatedAt: Date.now(),
        updatedBy: loggedInEmail ?? "web-admin",
      })
      toast.success("Featured event updated")
    } catch (saveError) {
      console.error(saveError)
      toast.error("Failed to save featured event")
    } finally {
      setSavingFeaturedEvent(false)
    }
  }

  const handleEventSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!eventForm.title.trim() || !eventForm.date.trim()) {
      toast.error("Upcoming events need both a title and a date")
      return
    }

    setSavingEvent(true)
    try {
      if (editingEventId) {
        await updateUpcomingEvent(editingEventId, eventForm)
        toast.success("Event updated")
      } else {
        await addUpcomingEvent(eventForm)
        toast.success("New event added")
      }
      setEventForm(defaultUpcomingEventForm)
      setEditingEventId(null)
    } catch (eventError) {
      console.error(eventError)
      toast.error("Unable to save event")
    } finally {
      setSavingEvent(false)
    }
  }

  const handleEditEvent = (eventToEdit: UpcomingEvent) => {
    setEditingEventId(eventToEdit.id)
    setEventForm({
      title: eventToEdit.title,
      date: eventToEdit.date,
      time: eventToEdit.time ?? "",
      location: eventToEdit.location ?? "",
      category: eventToEdit.category ?? "",
      details: eventToEdit.details ?? "",
    })
  }

  const handleDeleteEvent = async (eventId: string) => {
    setDeletingEventId(eventId)
    try {
      await deleteUpcomingEvent(eventId)
      toast.success("Event removed")
    } catch (deleteError) {
      console.error(deleteError)
      toast.error("Failed to delete event")
    } finally {
      setDeletingEventId(null)
    }
  }

  const handleCancelEventEdit = () => {
    setEditingEventId(null)
    setEventForm(defaultUpcomingEventForm)
  }

  const renderNavButton = (item: (typeof navItems)[number], variant: "desktop" | "mobile") => {
    const Icon = item.icon
    const isActive = item.id === "lgu-status"
    const baseClasses =
      variant === "desktop"
        ? "w-full flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition"
        : "flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-medium whitespace-nowrap"

    const styles = isActive
      ? variant === "desktop"
        ? "bg-primary text-primary-foreground shadow-sm"
        : "bg-primary text-primary-foreground"
      : variant === "desktop"
        ? "text-muted-foreground hover:text-foreground hover:bg-muted/40"
        : "bg-muted text-foreground"

    const handleNavClick = () => {
      if (isActive) return
      setIsNavigating(true)
      router.push(item.href)
    }

    return (
      <button key={`${item.id}-${variant}`} type="button" onClick={handleNavClick} className={cn(baseClasses, styles)}>
        <Icon className="h-4 w-4" />
        {item.label}
      </button>
    )
  }

  if (isNavigating) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="h-12 w-12 animate-spin rounded-full border-4 border-primary border-t-transparent"></div>
          <p className="text-muted-foreground">Loading...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex bg-background">
      <aside className="hidden md:flex w-64 flex-col border-r border-border bg-card/40 fixed top-0 left-0 h-screen">
        <div className="p-6">
          <p className="text-lg font-semibold text-foreground">BOSS Portal</p>
          {loggedInEmail && <p className="text-xs text-muted-foreground break-words mt-1">{loggedInEmail}</p>}
        </div>
        <nav className="flex-1 px-3 space-y-1 overflow-y-auto">
          {navItems.map((item) => renderNavButton(item, "desktop"))}
        </nav>
        <div className="p-4">
          <Button variant="outline" className="w-full justify-center gap-2" onClick={handleLogout}>
            <Power className="h-4 w-4" />
            Logout
          </Button>
        </div>
      </aside>

      <div className="flex-1 flex flex-col md:ml-64">
        <div className="md:hidden border-b border-border bg-card/70 px-4 py-3 flex gap-2 overflow-x-auto">
          {navItems.map((item) => renderNavButton(item, "mobile"))}
        </div>

        <main className="flex-1 p-4 sm:p-6">
          <div className="max-w-6xl mx-auto space-y-8">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-sm uppercase tracking-widest text-primary/80 font-semibold">Status Board</p>
                <h1 className="text-3xl font-bold text-foreground mt-1">LGU Sabangan Live Status</h1>
                <p className="text-sm text-muted-foreground mt-2">
                  Monitor municipality operations, mayor availability, and public-facing events in real time.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="outline" onClick={handleManualRefresh} disabled={syncing} className="gap-2">
                  {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
                  {syncing ? "Syncing" : "Refresh"}
                </Button>
              </div>
            </div>

            {error && (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>Database error</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <div className="grid gap-6 lg:grid-cols-3">
              <Card className="lg:col-span-2">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Building2 className="h-5 w-5 text-primary" />
                    Municipality Operations
                  </CardTitle>
                  <CardDescription>Control the public notice displayed on kiosks and the LGU mobile app.</CardDescription>
                </CardHeader>
                <CardContent>
                  <form className="space-y-6" onSubmit={handleMunicipalitySave}>
                    <div className="flex flex-wrap items-center gap-4">
                      <div className="flex items-center gap-3">
                        <Switch
                          id="municipality-open"
                          checked={municipalityForm.isOpen}
                          onCheckedChange={(checked) =>
                            setMunicipalityForm((prev) => ({
                              ...prev,
                              isOpen: checked,
                            }))
                          }
                        />
                        <div>
                          <p className="text-sm font-semibold text-foreground">Open to the public</p>
                          <p className="text-xs text-muted-foreground">
                            Toggle to instantly show &quot;Open&quot; or &quot;Closed&quot; status on the board
                          </p>
                        </div>
                      </div>
                      <Badge
                        className={cn(
                          "px-4 py-1 text-sm",
                          municipalityForm.isOpen ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"
                        )}
                      >
                        {municipalityForm.isOpen ? "Open today" : "Closed today"}
                      </Badge>
                    </div>

                    <div className="grid gap-4">
                      <div>
                        <label className="text-sm font-medium text-foreground">Office hours</label>
                        <div className="grid gap-3 sm:grid-cols-2 mt-2">
                          <div>
                            <p className="text-xs text-muted-foreground mb-1">Opens</p>
                            <Input
                              type="time"
                              value={officeHoursRange.start}
                              onChange={(e) => handleOfficeHourChange("start", e.target.value)}
                              step="900"
                            />
                          </div>
                          <div>
                            <p className="text-xs text-muted-foreground mb-1">Closes</p>
                            <Input
                              type="time"
                              value={officeHoursRange.end}
                              onChange={(e) => handleOfficeHourChange("end", e.target.value)}
                              step="900"
                            />
                          </div>
                        </div>
                        <div className="flex items-center justify-between text-xs text-muted-foreground mt-2">
                          <span>Display: {officeHoursSummary || "Not set"}</span>
                          <Button type="button" variant="ghost" size="sm" onClick={handleClearOfficeHours}>
                            Reset
                          </Button>
                        </div>
                      </div>
                      <div>
                        <label htmlFor="public-note" className="text-sm font-medium text-foreground">
                          Public note
                        </label>
                        <Textarea
                          id="public-note"
                          placeholder="Share guidance for walk-in clients"
                          value={municipalityForm.publicNote}
                          onChange={(e) =>
                            setMunicipalityForm((prev) => ({
                              ...prev,
                              publicNote: e.target.value,
                            }))
                          }
                          className="min-h-[96px]"
                        />
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
                      <p>Last updated: {formatTimestamp(statusBoard?.municipality?.lastUpdatedAt)}</p>
                      <Button type="submit" className="gap-2" disabled={savingMunicipality}>
                        {savingMunicipality ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                        {savingMunicipality ? "Saving" : "Save changes"}
                      </Button>
                    </div>
                  </form>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <CheckCircle2 className="h-5 w-5 text-primary" />
                    Mayor Availability
                  </CardTitle>
                  <CardDescription>Keep the public informed about Mayor on-site availability.</CardDescription>
                </CardHeader>
                <CardContent>
                  <form className="space-y-4" onSubmit={handleMayorSave}>
                    <div>
                      <label className="text-sm font-medium text-foreground">Current status</label>
                      <Select
                        value={mayorForm.availability}
                        onValueChange={(value) =>
                          setMayorForm((prev) => ({
                            ...prev,
                            availability: value,
                          }))
                        }
                      >
                        <SelectTrigger className="mt-1">
                          <SelectValue placeholder="Select status" />
                        </SelectTrigger>
                        <SelectContent>
                          {mayorAvailabilityOptions.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div>
                      <label htmlFor="expected-back" className="text-sm font-medium text-foreground">
                        Expected back
                      </label>
                      <Input
                        id="expected-back"
                        type="date"
                        value={expectedBackInputValue}
                        onChange={(e) => handleExpectedBackChange(e.target.value)}
                      />
                      <div className="flex flex-wrap items-center justify-between text-xs text-muted-foreground mt-2 gap-2">
                        <span>Public display: {expectedBackSummary}</span>
                        {mayorForm.expectedBack && (
                          <Button type="button" variant="ghost" size="sm" onClick={handleClearExpectedBack}>
                            Clear
                          </Button>
                        )}
                      </div>
                    </div>

                    <Button type="submit" className="w-full gap-2" disabled={savingMayor}>
                      {savingMayor ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                      {savingMayor ? "Saving" : "Update status"}
                    </Button>
                  </form>
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <Sparkles className="h-5 w-5 text-primary" />
                    Featured Event Broadcast
                  </CardTitle>
                  <CardDescription>Highlight the most important activity across kiosks and the mobile feed.</CardDescription>
                </div>
                <Badge variant="secondary" className="gap-2">
                  <CalendarDays className="h-3.5 w-3.5" />
                  Updated: {formatTimestamp(statusBoard?.featuredEvent?.updatedAt)}
                </Badge>
              </CardHeader>
              <CardContent className="space-y-6">
                <div
                  className={cn(
                    "rounded-2xl p-6 text-white shadow-inner",
                    featuredEventForm.enabled ? "bg-gradient-to-br from-primary to-emerald-600" : "bg-muted text-foreground"
                  )}
                  style={
                    featuredEventForm.bannerUrl
                      ? {
                          backgroundImage: `linear-gradient(rgba(10,30,15,0.75), rgba(9,30,15,0.8)), url(${featuredEventForm.bannerUrl})`,
                          backgroundSize: "cover",
                          backgroundPosition: "center",
                        }
                      : undefined
                  }
                >
                  <p className="text-xs uppercase tracking-[0.2em] mb-2">
                    {featuredEventForm.category || "Community"}
                  </p>
                  <h3 className="text-2xl font-bold">{featuredEventForm.title || "No featured event"}</h3>
                  <p className="text-white/80 mt-1">{featuredEventForm.subtitle || "Add a subtitle to inspire attendees."}</p>
                  <div className="grid gap-2 text-sm text-white/80 mt-4 sm:grid-cols-2">
                    <div className="flex items-center gap-2">
                      <CalendarDays className="h-4 w-4" />
                      {featuredEventForm.date ? formatDate(featuredEventForm.date) : "Date TBA"}
                    </div>
                    <div className="flex items-center gap-2">
                      <Clock className="h-4 w-4" />
                      {featuredEventForm.time || "Time TBA"}
                    </div>
                    <div className="flex items-center gap-2">
                      <MapPin className="h-4 w-4" />
                      {featuredEventForm.location || "Location TBA"}
                    </div>
                  </div>
                  <p className="text-sm mt-4 text-white/80">
                    {featuredEventForm.details || "Share highlights, entry reminders, or dress code here."}
                  </p>
                </div>

                <form className="grid gap-4 sm:grid-cols-2" onSubmit={handleFeaturedEventSave}>
                  <div className="flex items-center gap-3 sm:col-span-2">
                    <Switch
                      id="featured-enabled"
                      checked={featuredEventForm.enabled}
                      onCheckedChange={(checked) =>
                        setFeaturedEventForm((prev) => ({
                          ...prev,
                          enabled: checked,
                        }))
                      }
                    />
                    <div>
                      <p className="text-sm font-semibold text-foreground">Show featured event</p>
                      <p className="text-xs text-muted-foreground">Disable to hide the hero banner everywhere.</p>
                    </div>
                  </div>

                  <div>
                    <label htmlFor="event-title" className="text-sm font-medium text-foreground">
                      Title
                    </label>
                    <Input
                      id="event-title"
                      placeholder="Event title"
                      value={featuredEventForm.title}
                      onChange={(e) =>
                        setFeaturedEventForm((prev) => ({
                          ...prev,
                          title: e.target.value,
                        }))
                      }
                    />
                  </div>

                  <div>
                    <label htmlFor="event-subtitle" className="text-sm font-medium text-foreground">
                      Subtitle
                    </label>
                    <Input
                      id="event-subtitle"
                      placeholder="Event subtitle"
                      value={featuredEventForm.subtitle}
                      onChange={(e) =>
                        setFeaturedEventForm((prev) => ({
                          ...prev,
                          subtitle: e.target.value,
                        }))
                      }
                    />
                  </div>

                  <div>
                    <label htmlFor="event-date" className="text-sm font-medium text-foreground">
                      Date
                    </label>
                    <Input
                      id="event-date"
                      type="date"
                      value={featuredEventForm.date}
                      onChange={(e) =>
                        setFeaturedEventForm((prev) => ({
                          ...prev,
                          date: e.target.value,
                        }))
                      }
                    />
                  </div>

                  <div>
                    <label htmlFor="event-time" className="text-sm font-medium text-foreground">
                      Time
                    </label>
                    <Input
                      id="event-time"
                      placeholder="e.g., All day"
                      value={featuredEventForm.time}
                      onChange={(e) =>
                        setFeaturedEventForm((prev) => ({
                          ...prev,
                          time: e.target.value,
                        }))
                      }
                    />
                  </div>

                  <div>
                    <label htmlFor="event-location" className="text-sm font-medium text-foreground">
                      Location
                    </label>
                    <Input
                      id="event-location"
                      placeholder="Venue"
                      value={featuredEventForm.location}
                      onChange={(e) =>
                        setFeaturedEventForm((prev) => ({
                          ...prev,
                          location: e.target.value,
                        }))
                      }
                    />
                  </div>

                  <div>
                    <label htmlFor="event-category" className="text-sm font-medium text-foreground">
                      Category
                    </label>
                    <Input
                      id="event-category"
                      placeholder="e.g., Festival"
                      value={featuredEventForm.category}
                      onChange={(e) =>
                        setFeaturedEventForm((prev) => ({
                          ...prev,
                          category: e.target.value,
                        }))
                      }
                    />
                  </div>

                  <div className="sm:col-span-2">
                    <label htmlFor="event-details" className="text-sm font-medium text-foreground">
                      Details
                    </label>
                    <Textarea
                      id="event-details"
                      placeholder="Describe the event activities, reminders, or registration links."
                      value={featuredEventForm.details}
                      onChange={(e) =>
                        setFeaturedEventForm((prev) => ({
                          ...prev,
                          details: e.target.value,
                        }))
                      }
                      className="min-h-[100px]"
                    />
                  </div>

                  <div className="sm:col-span-2 flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm text-muted-foreground">
                      Updated by: {statusBoard?.featuredEvent?.updatedBy || "Not recorded"}
                    </p>
                    <Button type="submit" className="gap-2" disabled={savingFeaturedEvent}>
                      {savingFeaturedEvent ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                      {savingFeaturedEvent ? "Saving" : "Save featured event"}
                    </Button>
                  </div>
                </form>
              </CardContent>
            </Card>

            <div className="grid gap-6 lg:grid-cols-2">
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <CardTitle className="flex items-center gap-2">
                        <CalendarDays className="h-5 w-5 text-primary" />
                        Upcoming Events
                      </CardTitle>
                      <CardDescription>Events pushed to the queue, list, and mobile app feed.</CardDescription>
                    </div>
                    <Badge variant="outline">{upcomingEvents.length} scheduled</Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  {loading ? (
                    <div className="flex items-center gap-3 text-muted-foreground">
                      <Loader2 className="h-5 w-5 animate-spin" />
                      Loading events
                    </div>
                  ) : upcomingEvents.length === 0 ? (
                    <div className="text-sm text-muted-foreground">No upcoming events recorded yet.</div>
                  ) : (
                    upcomingEvents.map((eventItem) => (
                      <div key={eventItem.id} className="border border-border rounded-xl p-4 space-y-3">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <p className="text-base font-semibold text-foreground">{eventItem.title || "Unnamed"}</p>
                            <p className="text-sm text-muted-foreground flex items-center gap-2">
                              <CalendarDays className="h-4 w-4" />
                              {formatDate(eventItem.date)}
                            </p>
                          </div>
                          <Badge variant="secondary">{eventItem.category || "General"}</Badge>
                        </div>
                        <div className="grid gap-3 text-sm text-muted-foreground sm:grid-cols-2">
                          <div className="flex items-center gap-2">
                            <Clock className="h-4 w-4" />
                            {eventItem.time || "Time TBA"}
                          </div>
                          <div className="flex items-center gap-2">
                            <MapPin className="h-4 w-4" />
                            {eventItem.location || "Location TBA"}
                          </div>
                        </div>
                        {eventItem.details && <p className="text-sm text-foreground/80">{eventItem.details}</p>}
                        <div className="flex items-center justify-between pt-3 border-t border-border">
                          <p className="text-xs text-muted-foreground">Ref ID: {eventItem.id}</p>
                          <div className="flex items-center gap-2">
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => handleEditEvent(eventItem)}
                              className="hover:bg-primary/10"
                              aria-label="Edit event"
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => handleDeleteEvent(eventItem.id)}
                              className="hover:bg-red-50 text-red-600"
                              aria-label="Delete event"
                              disabled={deletingEventId === eventItem.id}
                            >
                              {deletingEventId === eventItem.id ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <Trash2 className="h-4 w-4" />
                              )}
                            </Button>
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Plus className="h-5 w-5 text-primary" />
                    {editingEventId ? "Update Event" : "Add Event"}
                  </CardTitle>
                  <CardDescription>
                    {editingEventId
                      ? "Editing an existing record updates it everywhere instantly."
                      : "Add community programs, holidays, or advisory schedules."}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <form className="space-y-4" onSubmit={handleEventSubmit}>
                    <div>
                      <label htmlFor="upcoming-title" className="text-sm font-medium text-foreground">
                        Title
                      </label>
                      <Input
                        id="upcoming-title"
                        placeholder="e.g., Sabangan Day"
                        value={eventForm.title}
                        onChange={(e) =>
                          setEventForm((prev) => ({
                            ...prev,
                            title: e.target.value,
                          }))
                        }
                        required
                      />
                    </div>

                    <div className="grid gap-4 sm:grid-cols-2">
                      <div>
                        <label htmlFor="upcoming-date" className="text-sm font-medium text-foreground">
                          Date
                        </label>
                        <Input
                          id="upcoming-date"
                          type="date"
                          value={eventForm.date}
                          onChange={(e) =>
                            setEventForm((prev) => ({
                              ...prev,
                              date: e.target.value,
                            }))
                          }
                          required
                        />
                      </div>
                      <div>
                        <label htmlFor="upcoming-time" className="text-sm font-medium text-foreground">
                          Time
                        </label>
                        <Input
                          id="upcoming-time"
                          placeholder="e.g., 6:00 PM"
                          value={eventForm.time}
                          onChange={(e) =>
                            setEventForm((prev) => ({
                              ...prev,
                              time: e.target.value,
                            }))
                          }
                        />
                      </div>
                    </div>

                    <div className="grid gap-4 sm:grid-cols-2">
                      <div>
                        <label htmlFor="upcoming-location" className="text-sm font-medium text-foreground">
                          Location
                        </label>
                        <Input
                          id="upcoming-location"
                          placeholder="Venue"
                          value={eventForm.location}
                          onChange={(e) =>
                            setEventForm((prev) => ({
                              ...prev,
                              location: e.target.value,
                            }))
                          }
                        />
                      </div>
                      <div>
                        <label htmlFor="upcoming-category" className="text-sm font-medium text-foreground">
                          Category
                        </label>
                        <Input
                          id="upcoming-category"
                          placeholder="e.g., Advisory"
                          value={eventForm.category}
                          onChange={(e) =>
                            setEventForm((prev) => ({
                              ...prev,
                              category: e.target.value,
                            }))
                          }
                        />
                      </div>
                    </div>

                    <div>
                      <label htmlFor="upcoming-details" className="text-sm font-medium text-foreground">
                        Details
                      </label>
                      <Textarea
                        id="upcoming-details"
                        placeholder="Share agenda, reminders, or registration steps."
                        value={eventForm.details}
                        onChange={(e) =>
                          setEventForm((prev) => ({
                            ...prev,
                            details: e.target.value,
                          }))
                        }
                        className="min-h-[100px]"
                      />
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-2">
                      {editingEventId ? (
                        <Button type="button" variant="ghost" onClick={handleCancelEventEdit}>
                          Cancel editing
                        </Button>
                      ) : (
                        <span className="text-xs text-muted-foreground">All fields sync instantly after saving.</span>
                      )}
                      <Button type="submit" className="gap-2" disabled={savingEvent}>
                        {savingEvent ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                        {editingEventId ? "Update event" : "Add event"}
                      </Button>
                    </div>
                  </form>
                </CardContent>
              </Card>
            </div>

            {/* Sync summary removed per request */}
          </div>
        </main>
      </div>
    </div>
  )
}
