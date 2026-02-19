"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut } from "firebase/auth"
import { Edit3, LogOut, Plus, Save, Trash2, X } from "lucide-react"
import { app as firebaseApp } from "@/database/firebase"
import { findAdminByEmail, type AdminRecord } from "@/database/admin"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { toast } from "sonner"

type ManagedRole = "staff" | "treasury"

type ManagedUser = {
  id: string
  firstName: string
  middleName?: string | null
  lastName: string
  email: string
  status?: string | null
  emailVerified?: boolean
  uid?: string | null
}

type ManagedBusinessApplication = {
  id: string
  applicantName: string
  businessName: string
  applicationType: string
  status: string
  applicationDate?: string | null
}

type UserFormState = {
  firstName: string
  middleName: string
  lastName: string
  email: string
  password: string
  status: string
  emailVerified: boolean
}

const EMPTY_CREATE_FORM: UserFormState = {
  firstName: "",
  middleName: "",
  lastName: "",
  email: "",
  password: "",
  status: "active",
  emailVerified: true,
}

const ROLE_LABELS: Record<ManagedRole, string> = {
  staff: "Staff",
  treasury: "Treasury",
}

export default function AdminClient() {
  const router = useRouter()
  const auth = useMemo(() => getAuth(firebaseApp), [])

  const [authLoading, setAuthLoading] = useState(true)
  const [loginForm, setLoginForm] = useState({ email: "", password: "" })
  const [me, setMe] = useState<AdminRecord | null>(null)

  const [activeRole, setActiveRole] = useState<ManagedRole>("staff")
  const [usersByRole, setUsersByRole] = useState<Record<ManagedRole, ManagedUser[]>>({
    staff: [],
    treasury: [],
  })

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [createForm, setCreateForm] = useState<UserFormState>(EMPTY_CREATE_FORM)
  const [editId, setEditId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<UserFormState>(EMPTY_CREATE_FORM)
  const [businessApplications, setBusinessApplications] = useState<ManagedBusinessApplication[]>([])
  const [selectedBusinessIds, setSelectedBusinessIds] = useState<Set<string>>(new Set())
  const [businessLoading, setBusinessLoading] = useState(false)

  const isAuthed = Boolean(me)
  const activeUsers = usersByRole[activeRole] ?? []

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

  const apiRequest = useCallback(
    async (method: "GET" | "POST" | "PATCH" | "DELETE", payload?: Record<string, unknown>) => {
      const currentUser = auth.currentUser
      if (!currentUser) {
        throw new Error("No authenticated admin session.")
      }

      const idToken = await currentUser.getIdToken(true)
      const response = await fetch("/api/admin/users", {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: method === "GET" ? undefined : JSON.stringify(payload ?? {}),
      })

      let body: Record<string, any> = {}
      try {
        body = (await response.json()) as Record<string, any>
      } catch {
        body = {}
      }

      if (!response.ok) {
        throw new Error(String(body?.error ?? "Request failed."))
      }

      return body
    },
    [auth]
  )

  const apiBusinessRequest = useCallback(
    async (method: "GET" | "DELETE", payload?: Record<string, unknown>) => {
      const currentUser = auth.currentUser
      if (!currentUser) {
        throw new Error("No authenticated admin session.")
      }

      const idToken = await currentUser.getIdToken(true)
      const response = await fetch("/api/admin/business-applications", {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: method === "GET" ? undefined : JSON.stringify(payload ?? {}),
      })

      let body: Record<string, any> = {}
      try {
        body = (await response.json()) as Record<string, any>
      } catch {
        body = {}
      }

      if (!response.ok) {
        throw new Error(String(body?.error ?? "Request failed."))
      }

      return body
    },
    [auth]
  )

  const loadUsers = useCallback(async () => {
    try {
      const body = await apiRequest("GET")
      const staff = Array.isArray(body?.staff) ? (body.staff as ManagedUser[]) : []
      const treasury = Array.isArray(body?.treasury) ? (body.treasury as ManagedUser[]) : []

      setUsersByRole({
        staff,
        treasury,
      })

      setSelectedIds((prev) => {
        const availableIds = new Set((activeRole === "staff" ? staff : treasury).map((u) => u.id))
        const next = new Set<string>()
        prev.forEach((id) => {
          if (availableIds.has(id)) next.add(id)
        })
        return next
      })
    } catch (err) {
      console.error(err)
      toast.error(err instanceof Error ? err.message : "Failed to load users")
    }
  }, [activeRole, apiRequest])

  const loadBusinessApplications = useCallback(async () => {
    setBusinessLoading(true)
    try {
      const body = await apiBusinessRequest("GET")
      const applications = Array.isArray(body?.applications)
        ? (body.applications as ManagedBusinessApplication[])
        : []

      setBusinessApplications(applications)
      setSelectedBusinessIds((prev) => {
        const availableIds = new Set(applications.map((application) => application.id))
        const next = new Set<string>()
        prev.forEach((id) => {
          if (availableIds.has(id)) next.add(id)
        })
        return next
      })
    } catch (err) {
      console.error(err)
      toast.error(err instanceof Error ? err.message : "Failed to load business applications")
      setBusinessApplications([])
      setSelectedBusinessIds(new Set())
    } finally {
      setBusinessLoading(false)
    }
  }, [apiBusinessRequest])

  useEffect(() => {
    if (!isAuthed) {
      setUsersByRole({ staff: [], treasury: [] })
      setSelectedIds(new Set())
      setEditId(null)
      setBusinessApplications([])
      setSelectedBusinessIds(new Set())
      setBusinessLoading(false)
      return
    }

    loadUsers()
    loadBusinessApplications()
  }, [isAuthed, loadBusinessApplications, loadUsers])

  useEffect(() => {
    setSelectedIds(new Set())
    setEditId(null)
  }, [activeRole])

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

  const handleCreateUser = async () => {
    if (!createForm.email || !createForm.firstName || !createForm.lastName || !createForm.password) {
      toast.error("First name, last name, email, and password are required")
      return
    }

    try {
      await apiRequest("POST", {
        role: activeRole,
        firstName: createForm.firstName,
        middleName: createForm.middleName,
        lastName: createForm.lastName,
        email: createForm.email,
        password: createForm.password,
        status: createForm.status || "active",
        emailVerified: createForm.emailVerified,
      })

      setCreateForm(EMPTY_CREATE_FORM)
      await loadUsers()
      toast.success(`${ROLE_LABELS[activeRole]} user created`)
    } catch (err) {
      console.error(err)
      toast.error(err instanceof Error ? err.message : "Failed to create user")
    }
  }

  const startEdit = (user: ManagedUser) => {
    setEditId(user.id)
    setEditForm({
      firstName: user.firstName ?? "",
      middleName: user.middleName ?? "",
      lastName: user.lastName ?? "",
      email: user.email ?? "",
      password: "",
      status: user.status ?? "active",
      emailVerified: Boolean(user.emailVerified),
    })
  }

  const cancelEdit = () => {
    setEditId(null)
    setEditForm(EMPTY_CREATE_FORM)
  }

  const saveEdit = async (id: string) => {
    if (!editForm.email || !editForm.firstName || !editForm.lastName) {
      toast.error("First name, last name, and email are required")
      return
    }

    try {
      await apiRequest("PATCH", {
        role: activeRole,
        id,
        firstName: editForm.firstName,
        middleName: editForm.middleName,
        lastName: editForm.lastName,
        email: editForm.email,
        password: editForm.password || undefined,
        status: editForm.status || "active",
        emailVerified: editForm.emailVerified,
      })

      await loadUsers()
      cancelEdit()
      toast.success(`${ROLE_LABELS[activeRole]} user updated`)
    } catch (err) {
      console.error(err)
      toast.error(err instanceof Error ? err.message : "Failed to update user")
    }
  }

  const deleteUser = async (id: string) => {
    const confirmDelete = window.confirm(`Delete this ${ROLE_LABELS[activeRole].toLowerCase()} user?`)
    if (!confirmDelete) return

    try {
      await apiRequest("DELETE", { role: activeRole, id })
      setSelectedIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
      await loadUsers()
      toast.success("User deleted")
    } catch (err) {
      console.error(err)
      toast.error(err instanceof Error ? err.message : "Failed to delete user")
    }
  }

  const deleteSelectedUsers = async () => {
    if (selectedIds.size === 0) return
    const confirmDelete = window.confirm(`Delete selected ${ROLE_LABELS[activeRole].toLowerCase()} users?`)
    if (!confirmDelete) return

    try {
      await Promise.all(
        Array.from(selectedIds).map((id) =>
          apiRequest("DELETE", {
            role: activeRole,
            id,
          })
        )
      )
      setSelectedIds(new Set())
      await loadUsers()
      toast.success("Selected users deleted")
    } catch (err) {
      console.error(err)
      toast.error(err instanceof Error ? err.message : "Failed to delete selected users")
    }
  }

  const toggleSelectUser = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleSelectAllUsers = () => {
    if (activeUsers.length === 0) return
    if (selectedIds.size === activeUsers.length) {
      setSelectedIds(new Set())
      return
    }
    setSelectedIds(new Set(activeUsers.map((u) => u.id)))
  }

  const deleteSelectedBusinessApplications = async () => {
    if (selectedBusinessIds.size === 0) return

    const confirmDelete = window.confirm("Delete selected business applications?")
    if (!confirmDelete) return

    try {
      await apiBusinessRequest("DELETE", { ids: Array.from(selectedBusinessIds) })
      setSelectedBusinessIds(new Set())
      await loadBusinessApplications()
      toast.success("Selected business applications deleted")
    } catch (err) {
      console.error(err)
      toast.error(err instanceof Error ? err.message : "Failed to delete selected business applications")
    }
  }

  const toggleSelectBusinessApplication = (id: string) => {
    setSelectedBusinessIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleSelectAllBusinessApplications = () => {
    if (businessApplications.length === 0) return
    if (selectedBusinessIds.size === businessApplications.length) {
      setSelectedBusinessIds(new Set())
      return
    }
    setSelectedBusinessIds(new Set(businessApplications.map((application) => application.id)))
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

      <Card>
        <CardHeader>
          <CardTitle>Manage User Roles</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            {(["staff", "treasury"] as ManagedRole[]).map((role) => (
              <Button
                key={role}
                type="button"
                variant={activeRole === role ? "default" : "outline"}
                onClick={() => setActiveRole(role)}
              >
                {ROLE_LABELS[role]} ({usersByRole[role]?.length ?? 0})
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Create {ROLE_LABELS[activeRole]} User</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <div>
              <Label>First name</Label>
              <Input
                value={createForm.firstName}
                onChange={(e) => setCreateForm((prev) => ({ ...prev, firstName: e.target.value }))}
              />
            </div>
            <div>
              <Label>Middle name</Label>
              <Input
                value={createForm.middleName}
                onChange={(e) => setCreateForm((prev) => ({ ...prev, middleName: e.target.value }))}
              />
            </div>
            <div>
              <Label>Last name</Label>
              <Input
                value={createForm.lastName}
                onChange={(e) => setCreateForm((prev) => ({ ...prev, lastName: e.target.value }))}
              />
            </div>
            <div>
              <Label>Email</Label>
              <Input
                type="email"
                value={createForm.email}
                onChange={(e) => setCreateForm((prev) => ({ ...prev, email: e.target.value }))}
                placeholder={`${activeRole}@example.com`}
              />
            </div>
            <div>
              <Label>Password</Label>
              <Input
                type="password"
                value={createForm.password}
                onChange={(e) => setCreateForm((prev) => ({ ...prev, password: e.target.value }))}
                placeholder="Required"
              />
            </div>
            <div>
              <Label>Status</Label>
              <Input
                value={createForm.status}
                onChange={(e) => setCreateForm((prev) => ({ ...prev, status: e.target.value }))}
                placeholder="active"
              />
            </div>
          </div>

          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={createForm.emailVerified}
              onChange={(e) => setCreateForm((prev) => ({ ...prev, emailVerified: e.target.checked }))}
              className="h-4 w-4"
            />
            Mark email as verified
          </label>

          <Button onClick={handleCreateUser} className="w-full gap-2">
            <Plus className="h-4 w-4" /> Create {ROLE_LABELS[activeRole]} user
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>
            {ROLE_LABELS[activeRole]} users ({activeUsers.length})
          </CardTitle>
          <Button
            size="sm"
            variant="destructive"
            onClick={deleteSelectedUsers}
            disabled={selectedIds.size === 0}
          >
            Delete selected
          </Button>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    checked={activeUsers.length > 0 && selectedIds.size === activeUsers.length}
                    onChange={toggleSelectAllUsers}
                    aria-label="Select all users"
                  />
                </TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Verified</TableHead>
                <TableHead className="w-40">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {activeUsers.map((user) => {
                const isEditing = editId === user.id
                return (
                  <TableRow key={user.id}>
                    <TableCell>
                      <input
                        type="checkbox"
                        className="h-4 w-4"
                        checked={selectedIds.has(user.id)}
                        onChange={() => toggleSelectUser(user.id)}
                        aria-label={`Select ${user.email}`}
                      />
                    </TableCell>

                    <TableCell>
                      {isEditing ? (
                        <div className="grid gap-2">
                          <Input
                            value={editForm.firstName}
                            onChange={(e) => setEditForm((prev) => ({ ...prev, firstName: e.target.value }))}
                            placeholder="First"
                          />
                          <Input
                            value={editForm.middleName}
                            onChange={(e) => setEditForm((prev) => ({ ...prev, middleName: e.target.value }))}
                            placeholder="Middle"
                          />
                          <Input
                            value={editForm.lastName}
                            onChange={(e) => setEditForm((prev) => ({ ...prev, lastName: e.target.value }))}
                            placeholder="Last"
                          />
                        </div>
                      ) : (
                        <div className="font-medium">
                          {[user.firstName, user.middleName, user.lastName].filter(Boolean).join(" ")}
                        </div>
                      )}
                    </TableCell>

                    <TableCell className="text-sm text-gray-700">
                      {isEditing ? (
                        <div className="grid gap-2">
                          <Input
                            type="email"
                            value={editForm.email}
                            onChange={(e) => setEditForm((prev) => ({ ...prev, email: e.target.value }))}
                            placeholder="Email"
                          />
                          <Input
                            type="password"
                            value={editForm.password}
                            onChange={(e) => setEditForm((prev) => ({ ...prev, password: e.target.value }))}
                            placeholder="New password (optional)"
                          />
                        </div>
                      ) : (
                        user.email
                      )}
                    </TableCell>

                    <TableCell className="text-sm text-gray-700">
                      {isEditing ? (
                        <Input
                          value={editForm.status}
                          onChange={(e) => setEditForm((prev) => ({ ...prev, status: e.target.value }))}
                          placeholder="active"
                        />
                      ) : (
                        user.status || ""
                      )}
                    </TableCell>

                    <TableCell>
                      {isEditing ? (
                        <label className="inline-flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            className="h-4 w-4"
                            checked={editForm.emailVerified}
                            onChange={(e) => setEditForm((prev) => ({ ...prev, emailVerified: e.target.checked }))}
                          />
                          Verified
                        </label>
                      ) : (
                        <Badge
                          className={cn(
                            "capitalize",
                            user.emailVerified
                              ? "bg-green-100 text-green-800"
                              : "bg-amber-100 text-amber-800"
                          )}
                        >
                          {user.emailVerified ? "Verified" : "Unverified"}
                        </Badge>
                      )}
                    </TableCell>

                    <TableCell>
                      {isEditing ? (
                        <div className="flex items-center gap-2">
                          <Button size="sm" onClick={() => saveEdit(user.id)}>
                            <Save className="h-4 w-4" />
                          </Button>
                          <Button size="sm" variant="outline" onClick={cancelEdit}>
                            <X className="h-4 w-4" />
                          </Button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2">
                          <Button size="sm" variant="outline" onClick={() => startEdit(user)}>
                            <Edit3 className="h-4 w-4" />
                          </Button>
                          <Button size="sm" variant="destructive" onClick={() => deleteUser(user.id)}>
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })}

              {activeUsers.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-sm text-gray-500">
                    No {ROLE_LABELS[activeRole].toLowerCase()} users found.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Business Applications ({businessApplications.length})</CardTitle>
          <Button
            size="sm"
            variant="destructive"
            onClick={deleteSelectedBusinessApplications}
            disabled={selectedBusinessIds.size === 0 || businessLoading}
          >
            Delete selected
          </Button>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    checked={businessApplications.length > 0 && selectedBusinessIds.size === businessApplications.length}
                    onChange={toggleSelectAllBusinessApplications}
                    aria-label="Select all business applications"
                  />
                </TableHead>
                <TableHead>Applicant</TableHead>
                <TableHead>Business</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Application Date</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {businessApplications.map((application) => (
                <TableRow key={application.id}>
                  <TableCell>
                    <input
                      type="checkbox"
                      className="h-4 w-4"
                      checked={selectedBusinessIds.has(application.id)}
                      onChange={() => toggleSelectBusinessApplication(application.id)}
                      aria-label={`Select application ${application.id}`}
                    />
                  </TableCell>
                  <TableCell className="font-medium">{application.applicantName || "Unnamed Applicant"}</TableCell>
                  <TableCell>{application.businessName || "—"}</TableCell>
                  <TableCell>{application.applicationType || "—"}</TableCell>
                  <TableCell>{application.status || "Pending"}</TableCell>
                  <TableCell>
                    {application.applicationDate
                      ? (() => {
                          const parsed = new Date(application.applicationDate)
                          return Number.isNaN(parsed.getTime()) ? "—" : parsed.toLocaleDateString()
                        })()
                      : "—"}
                  </TableCell>
                </TableRow>
              ))}

              {!businessLoading && businessApplications.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-sm text-gray-500">
                    No business applications found.
                  </TableCell>
                </TableRow>
              )}

              {businessLoading && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-sm text-gray-500">
                    Loading business applications...
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
