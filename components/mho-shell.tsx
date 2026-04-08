"use client"

import React, { type ReactNode, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { getAuth, onAuthStateChanged, signOut } from "firebase/auth"
import { app as firebaseApp } from "@/database/firebase"
import { cn } from "@/lib/utils"

type MhoNavKey = "dashboard" | "clients"

type MhoShellProps = {
  activeNav: MhoNavKey
  title: string
  description?: string
  children: ReactNode
}

const NAV_ITEMS: Array<{ key: MhoNavKey; label: string; href: string }> = [
  { key: "dashboard", label: "Dashboard", href: "/mho/home" },
  { key: "clients", label: "Clients", href: "/mho/clients" },
]

export default function MhoShell({ activeNav, title, description, children }: MhoShellProps) {
  const router = useRouter()
  const auth = useMemo(() => getAuth(firebaseApp), [])
  const [loading, setLoading] = useState(true)
  const [signingOut, setSigningOut] = useState(false)
  const [email, setEmail] = useState("")

  useEffect(() => {
    let cancelled = false

    const applyAuthUser = (user: ReturnType<typeof getAuth>["currentUser"]) => {
      if (cancelled) return

      if (!user) {
        setEmail("")
        setLoading(false)
        router.replace("/mho")
        return
      }

      setEmail(user.email ?? "")
      setLoading(false)
    }

    setLoading(true)
    const unsubscribe = onAuthStateChanged(
      auth,
      (user) => {
        applyAuthUser(user)
      },
      () => {
        if (cancelled) return
        setEmail("")
        setLoading(false)
        router.replace("/mho")
      }
    )

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [auth, router])

  const handleSignOut = async () => {
    setSigningOut(true)
    try {
      await signOut(auth)
      router.replace("/mho")
    } finally {
      setSigningOut(false)
    }
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <aside className="fixed left-0 top-0 hidden h-screen w-64 border-r border-slate-200 bg-white md:block">
        <div className="flex h-full flex-col p-4">
          <div className="mb-6 border-b border-slate-200 pb-4">
            <p className="text-lg font-semibold text-slate-900">Municipal Health Office</p>
            <p className="mt-1 text-xs text-slate-500">{email || "MHO account"}</p>
          </div>

          <nav className="flex flex-1 flex-col gap-2">
            {NAV_ITEMS.map((item) => (
              <Link
                key={item.key}
                href={item.href}
                className={cn(
                  "rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  activeNav === item.key
                    ? "bg-blue-600 text-white"
                    : "text-slate-700 hover:bg-slate-100"
                )}
              >
                {item.label}
              </Link>
            ))}
          </nav>

          <button
            type="button"
            onClick={handleSignOut}
            disabled={signingOut || loading}
            className="mt-4 inline-flex w-full items-center justify-center rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
          >
            {signingOut ? "Signing out..." : "Logout"}
          </button>
        </div>
      </aside>

      <main className="min-h-screen p-4 md:ml-64 md:p-8">
        <div className="mb-4 rounded-lg border border-slate-200 bg-white p-3 md:hidden">
          <p className="text-xs text-slate-500">{email || "MHO account"}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {NAV_ITEMS.map((item) => (
              <Link
                key={item.key}
                href={item.href}
                className={cn(
                  "rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  activeNav === item.key
                    ? "bg-blue-600 text-white"
                    : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                )}
              >
                {item.label}
              </Link>
            ))}
          </div>
          <button
            type="button"
            onClick={handleSignOut}
            disabled={signingOut || loading}
            className="mt-3 inline-flex w-full items-center justify-center rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
          >
            {signingOut ? "Signing out..." : "Logout"}
          </button>
        </div>

        <div className="mb-6">
          <h1 className="text-2xl font-semibold text-slate-900 md:text-3xl">{title}</h1>
          {description ? <p className="mt-1 text-sm text-slate-600">{description}</p> : null}
        </div>

        {loading ? <p className="text-sm text-slate-600">Loading MHO workspace...</p> : children}
      </main>
    </div>
  )
}
