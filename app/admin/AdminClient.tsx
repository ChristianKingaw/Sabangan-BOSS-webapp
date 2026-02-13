"use client"

import { useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut } from "firebase/auth"
import { onValue, ref, push, set, remove, serverTimestamp } from "firebase/database"
import { LogOut, Plus, Trash2 } from "lucide-react"
import { app as firebaseApp, realtimeDb } from "@/database/firebase"
import { findAdminByEmail, type AdminRecord } from "@/database/admin"
import {
  BUSINESS_APPLICATION_PATH,
  getStatusBadge,
  normalizeBusinessApplication,
  type BusinessApplicationRecord,
} from "@/lib/business-applications"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { toast } from "sonner"

const RAW_NAMESPACE =
  process.env.NEXT_PUBLIC_DATABASE_NAMESPACE ??
  process.env.NEXT_PUBLIC_FIREBASE_DATABASE_NAMESPACE ??
  "users/webapp"
const STAFF_COLLECTION = RAW_NAMESPACE.endsWith("/staff") ? RAW_NAMESPACE : `${RAW_NAMESPACE}/staff`

type StaffRecord = {
  id: string
  firstName: string
  lastName: string
  middleName?: string
  email: string
  emailVerified?: boolean
  status?: string
}

type StaffFormState = {
  firstName: string
  middleName: string
  lastName: string
  email: string
}

export default function AdminClient() {
  const router = useRouter()
  const auth = useMemo(() => getAuth(firebaseApp), [])

  const [authLoading, setAuthLoading] = useState(true)
  const [loginForm, setLoginForm] = useState({ email: "", password: "" })
  const [me, setMe] = useState<AdminRecord | null>(null)

  const [staff, setStaff] = useState<StaffRecord[]>([])
  const [apps, setApps] = useState<BusinessApplicationRecord[]>([])

  const [selectedStaff, setSelectedStaff] = useState<Set<string>>(new Set())
  const [selectedApps, setSelectedApps] = useState<Set<string>>(new Set())

  const [staffForm, setStaffForm] = useState<StaffFormState>({
    firstName: "",
    middleName: "",
    lastName: "",
    email: "",
  })

  const isAuthed = Boolean(me)

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user || !user.email) {
        setMe(null)
        setAuthLoading(false)
        return
      }

      try {
        const record = await findAdminByEmail(user.email)
        if (record) {
          setMe(record)
        } else {
          toast.error("You are not registered as an admin in Realtime DB")
          await signOut(auth)
          setMe(null)
        }
      } catch (err) {
        console.error(err)
        toast.error("Failed to verify admin profile")
        setMe(null)
      } finally {
        setAuthLoading(false)
      }
    })

    return () => unsub()
  }, [auth])

  useEffect(() => {
    const staffRef = ref(realtimeDb, STAFF_COLLECTION)
    const unsub = onValue(
      staffRef,
      (snapshot) => {
        const data = snapshot.val() as Record<string, any> | null
        if (!data) {
          setStaff([])
          return
        }
        const rows = Object.entries(data).map(([id, value]) => ({
          id,
          firstName: value?.firstName ?? "",
          middleName: value?.middleName ?? "",
          lastName: value?.lastName ?? "",
          email: value?.email ?? "",
          emailVerified: value?.emailVerified ?? false,
          status: value?.status ?? "",
        }))
        setStaff(rows)
      },
      (error) => {
        console.error(error)
        toast.error("Failed to load staff")
      }
    )
    return () => unsub()
  }, [])

  useEffect(() => {
    const appRef = ref(realtimeDb, BUSINESS_APPLICATION_PATH)
    const unsub = onValue(
      appRef,
      (snapshot) => {
        const data = snapshot.val() as Record<string, any> | null
        if (!data) {
          setApps([])
          return
        }
        const records = Object.entries(data).map(([id, payload]) => normalizeBusinessApplication(id, payload))
        setApps(records)
      },
      (error) => {
        console.error(error)
        toast.error("Failed to load applications")
      }
    )
    return () => unsub()
  }, [])

  const toggleSelectApp = (id: string) => {
    setSelectedApps((prev) => {
      const s = new Set(prev)
      if (s.has(id)) s.delete(id)
      else s.add(id)
      return s
    })
  }

  const toggleSelectAllApps = () => {
    if (selectedApps.size === apps.length) {
      setSelectedApps(new Set())
      return
    }
    setSelectedApps(new Set(apps.map((a) => a.id)))
  }

  const handleDeleteSelectedApps = async () => {
    if (selectedApps.size === 0) return
    const confirmDelete = window.confirm("Delete selected applications?")
    if (!confirmDelete) return
    try {
      const ids = Array.from(selectedApps)
      await Promise.all(ids.map((id) => remove(ref(realtimeDb, `${BUSINESS_APPLICATION_PATH}/${id}`))))
      setSelectedApps(new Set())
      toast.success("Deleted selected applications")
    } catch (err) {
      console.error(err)
      toast.error("Failed to delete selected applications")
    }
  }

  const handleLogin = async () => {
    if (!loginForm.email || !loginForm.password) {
      toast.error("Email and password are required")
      return
    }
    try {
      setAuthLoading(true)
      const cred = await signInWithEmailAndPassword(auth, loginForm.email.trim(), loginForm.password)
      const user = cred.user
      if (!user.email) throw new Error("Missing email on user")
      const record = await findAdminByEmail(user.email)
      if (!record) {
        await signOut(auth)
        toast.error("No admin profile found in DB for this account")
        return
      }
      setMe(record)
      toast.success("Signed in as admin")
    } catch (err: any) {
      console.error(err)
      toast.error(err?.message ?? "Login failed")
    } finally {
      setAuthLoading(false)
    }
  }

  const handleLogout = async () => {
    await signOut(auth)
    setMe(null)
    router.refresh()
  }

  const handleCreateStaff = async () => {
    if (!staffForm.email || !staffForm.firstName || !staffForm.lastName) {
      toast.error("First name, last name, and email are required")
      return
    }
    try {
      const staffRef = ref(realtimeDb, STAFF_COLLECTION)
      const newRef = push(staffRef)
      if (!newRef.key) throw new Error("Failed to allocate staff ID")

      await set(newRef, {
        firstName: staffForm.firstName.trim(),
        middleName: staffForm.middleName.trim() || undefined,
        lastName: staffForm.lastName.trim(),
        email: staffForm.email.trim().toLowerCase(),
        emailVerified: false,
        status: "active",
        createdAt: serverTimestamp(),
        createdByEmail: me?.email ?? null,
      })

      setStaffForm({ firstName: "", middleName: "", lastName: "", email: "" })
      toast.success("Staff user created")
    } catch (err) {
      console.error(err)
      toast.error("Failed to create staff user")
    }
  }

  const handleDeleteStaff = async (id: string) => {
    const confirmDelete = window.confirm("Delete this staff user?")
    if (!confirmDelete) return
    try {
      const staffRef = ref(realtimeDb, `${STAFF_COLLECTION}/${id}`)
      await remove(staffRef)
      toast.success("Staff user deleted")
    } catch (err) {
      console.error(err)
      toast.error("Failed to delete staff user")
    }
  }

  const toggleSelectStaff = (id: string) => {
    setSelectedStaff((prev) => {
      const s = new Set(prev)
      if (s.has(id)) s.delete(id)
      else s.add(id)
      return s
    })
  }

  const toggleSelectAllStaff = () => {
    if (selectedStaff.size === staff.length) {
      setSelectedStaff(new Set())
      return
    }
    setSelectedStaff(new Set(staff.map((s) => s.id)))
  }

  const handleDeleteSelectedStaff = async () => {
    if (selectedStaff.size === 0) return
    const confirmDelete = window.confirm("Delete selected staff users?")
    if (!confirmDelete) return
    try {
      const ids = Array.from(selectedStaff)
      await Promise.all(ids.map((id) => remove(ref(realtimeDb, `${STAFF_COLLECTION}/${id}`))))
      setSelectedStaff(new Set())
      toast.success("Deleted selected staff users")
    } catch (err) {
      console.error(err)
      toast.error("Failed to delete selected staff users")
    }
  }

  const handleDeleteApplication = async (id: string) => {
    const confirmDelete = window.confirm("Delete this application?")
    if (!confirmDelete) return
    try {
      const appRef = ref(realtimeDb, `${BUSINESS_APPLICATION_PATH}/${id}`)
      await remove(appRef)
      toast.success("Application deleted")
    } catch (err) {
      console.error(err)
      toast.error("Failed to delete application")
    }
  }

  if (authLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-gray-600">
        Checking admin session...
      </div>
    )
  }

  if (!isAuthed) {
    return (
      <div className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-4 p-6">
        <Card>
          <CardHeader>
            <CardTitle>Admin Login</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={loginForm.email}
                onChange={(e) => setLoginForm((prev) => ({ ...prev, email: e.target.value }))}
                placeholder="admin@example.com"
              />
            </div>
            <div>
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                value={loginForm.password}
                onChange={(e) => setLoginForm((prev) => ({ ...prev, password: e.target.value }))}
                placeholder="••••••••"
              />
            </div>
            <Button onClick={handleLogin} className="w-full">
              {authLoading && <LoaderIcon />}Login
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-gray-500">Signed in as</p>
          <p className="font-semibold text-gray-900">{me?.email}</p>
        </div>
        <Button variant="secondary" onClick={handleLogout} className="gap-2">
          <LogOut className="h-4 w-4" />
          Logout
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Create Staff User</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div>
                <Label>First name</Label>
                <Input
                  value={staffForm.firstName}
                  onChange={(e) => setStaffForm((prev) => ({ ...prev, firstName: e.target.value }))}
                />
              </div>
              <div>
                <Label>Last name</Label>
                <Input
                  value={staffForm.lastName}
                  onChange={(e) => setStaffForm((prev) => ({ ...prev, lastName: e.target.value }))}
                />
              </div>
              <div>
                <Label>Middle name</Label>
                <Input
                  value={staffForm.middleName}
                  onChange={(e) => setStaffForm((prev) => ({ ...prev, middleName: e.target.value }))}
                />
              </div>
              <div>
                <Label>Email</Label>
                <Input
                  type="email"
                  value={staffForm.email}
                  onChange={(e) => setStaffForm((prev) => ({ ...prev, email: e.target.value }))}
                  placeholder="staff@example.com"
                />
              </div>
            </div>
            <Button onClick={handleCreateStaff} className="w-full gap-2">
              <Plus className="h-4 w-4" /> Create staff user
            </Button>
            <p className="text-xs text-gray-500">Creates a staff entry in Realtime Database.</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Staff users ({staff.length})</CardTitle>
          <div className="ml-auto">
            <Button size="sm" variant="destructive" onClick={handleDeleteSelectedStaff} disabled={selectedStaff.size === 0}>
              Delete selected
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    checked={selectedStaff.size > 0 && selectedStaff.size === staff.length}
                    onChange={toggleSelectAllStaff}
                    aria-label="Select all staff"
                  />
                </TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Verified</TableHead>
                <TableHead className="w-24">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {staff.map((user) => (
                <TableRow key={user.id}>
                  <TableCell>
                    <input
                      type="checkbox"
                      className="h-4 w-4"
                      checked={selectedStaff.has(user.id)}
                      onChange={() => toggleSelectStaff(user.id)}
                      aria-label={`Select staff ${user.email}`}
                    />
                  </TableCell>
                  <TableCell>
                    <div className="font-medium">
                      {[user.firstName, user.middleName, user.lastName].filter(Boolean).join(" ")}
                    </div>
                  </TableCell>
                  <TableCell className="text-sm text-gray-700">{user.email}</TableCell>
                  <TableCell className="text-sm text-gray-700">{user.status || ""}</TableCell>
                  <TableCell>
                    <Badge className={cn("capitalize", user.emailVerified ? "bg-green-100 text-green-800" : "bg-amber-100 text-amber-800")}>
                      {user.emailVerified ? "Verified" : "Unverified"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Button size="sm" variant="destructive" onClick={() => handleDeleteStaff(user.id)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {staff.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-sm text-gray-500">
                    No staff users.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Applications ({apps.length})</CardTitle>
          <div className="ml-auto">
            <Button size="sm" variant="destructive" onClick={handleDeleteSelectedApps} disabled={selectedApps.size === 0}>
              Delete selected
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    checked={selectedApps.size > 0 && selectedApps.size === apps.length}
                    onChange={toggleSelectAllApps}
                    aria-label="Select all applications"
                  />
                </TableHead>
                <TableHead>Applicant</TableHead>
                <TableHead>Business</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-44">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {apps.map((app) => {
                const badge = getStatusBadge(app.status, app.overallStatus)
                return (
                  <TableRow key={app.id}>
                    <TableCell>
                      <input
                        type="checkbox"
                        className="h-4 w-4"
                        checked={selectedApps.has(app.id)}
                        onChange={() => toggleSelectApp(app.id)}
                        aria-label={`Select app ${app.id}`}
                      />
                    </TableCell>
                    <TableCell className="font-medium">{app.applicantName || "Unnamed"}</TableCell>
                    <TableCell className="text-sm text-gray-700">{app.businessName || ""}</TableCell>
                    <TableCell className="text-sm text-gray-700">{app.applicationType}</TableCell>
                    <TableCell>
                      <Badge className={cn(badge.className, "capitalize")}>{badge.label}</Badge>
                    </TableCell>
                    <TableCell>
                      <Button size="sm" variant="destructive" onClick={() => handleDeleteApplication(app.id)}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                )
              })}
              {apps.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-sm text-gray-500">
                    No applications found.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}

function LoaderIcon() {
  return <span className="mr-2 inline-block h-4 w-4 animate-spin rounded-full border border-gray-300 border-t-gray-600" />
}
