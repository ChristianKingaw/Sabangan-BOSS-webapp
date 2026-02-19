"use client"

import React, { type ReactNode, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { getAuth, onAuthStateChanged, signOut } from "firebase/auth"
import { app as firebaseApp } from "@/database/firebase"
import { cn } from "@/lib/utils"

type TreasuryNavKey = "dashboard" | "clients"

type TreasuryShellProps = {
  activeNav: TreasuryNavKey
  title: string
  description?: string
  children: ReactNode
}

const NAV_ITEMS: Array<{ key: TreasuryNavKey; label: string; href: string }> = [
  { key: "dashboard", label: "Dashboard", href: "/treasury/home" },
  { key: "clients", label: "Clients", href: "/treasury/clients" },
]

export default function TreasuryShell({ activeNav, title, description, children }: TreasuryShellProps) {
  const router = useRouter()
  const auth = useMemo(() => getAuth(firebaseApp), [])
  const [loading, setLoading] = useState(true)
  const [signingOut, setSigningOut] = useState(false)
  const [email, setEmail] = useState("")

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (!user) {
        router.replace("/treasury")
        return
      }
      setEmail(user.email ?? "")
      setLoading(false)
    })

    return unsubscribe
  }, [auth, router])

  const handleSignOut = async () => {
    setSigningOut(true)
    try {
      await signOut(auth)
      router.replace("/treasury")
    } finally {
      setSigningOut(false)
    }
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <aside className="fixed left-0 top-0 hidden h-screen w-64 border-r border-slate-200 bg-white md:block">
        <div className="flex h-full flex-col p-4">
          <div className="mb-6 border-b border-slate-200 pb-4">
            <p className="text-lg font-semibold text-slate-900">Treasury</p>
            <p className="mt-1 text-xs text-slate-500">{email || "treasury account"}</p>
          </div>

          <nav className="flex flex-1 flex-col gap-2">
            {NAV_ITEMS.map((item) => (
              <Link
                key={item.key}
                href={item.href}
                className={cn(
                  "rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  activeNav === item.key
                    ? "bg-emerald-700 text-white"
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
            className="mt-4 inline-flex w-full items-center justify-center rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-60"
          >
            {signingOut ? "Signing out..." : "Logout"}
          </button>
        </div>
      </aside>

      <main className="min-h-screen p-4 md:ml-64 md:p-8">
        <div className="mb-4 rounded-lg border border-slate-200 bg-white p-3 md:hidden">
          <p className="text-xs text-slate-500">{email || "treasury account"}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {NAV_ITEMS.map((item) => (
              <Link
                key={item.key}
                href={item.href}
                className={cn(
                  "rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  activeNav === item.key
                    ? "bg-emerald-700 text-white"
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
            className="mt-3 inline-flex w-full items-center justify-center rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-60"
          >
            {signingOut ? "Signing out..." : "Logout"}
          </button>
        </div>

        <div className="mb-6">
          <h1 className="text-2xl font-semibold text-slate-900 md:text-3xl">{title}</h1>
          {description ? <p className="mt-1 text-sm text-slate-600">{description}</p> : null}
        </div>

        {loading ? <p className="text-sm text-slate-600">Loading treasury workspace...</p> : children}
      </main>
    </div>
  )
}
