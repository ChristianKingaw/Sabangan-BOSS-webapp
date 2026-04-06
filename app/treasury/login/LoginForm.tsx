"use client"

import React, { useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { FirebaseError } from "firebase/app"
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut } from "firebase/auth"
import { app as firebaseApp } from "@/database/firebase"

const TREASURY_EMAIL_STORAGE_KEY = "bossTreasuryEmail"

const parseApiBody = async (response: Response) => {
  try {
    return (await response.json()) as Record<string, unknown>
  } catch {
    return {} as Record<string, unknown>
  }
}

export default function LoginForm() {
  const router = useRouter()
  const auth = useMemo(() => getAuth(firebaseApp), [])
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [remember, setRemember] = useState(false)
  const [loading, setLoading] = useState(false)
  const [checkingAuth, setCheckingAuth] = useState(true)
  const [error, setError] = useState("")
  const [success, setSuccess] = useState("")

  const verifyTreasuryAccess = async (idToken: string) => {
    const response = await fetch("/api/treasury/auth-profile", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${idToken}`,
      },
      cache: "no-store",
    })
    const body = await parseApiBody(response)
    if (!response.ok) {
      throw new Error(
        String(body.error ?? "Authenticated user is not authorized for treasury access.")
      )
    }
  }

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(
      auth,
      (user) => {
        if (user) {
          void (async () => {
            try {
              const idToken = await user.getIdToken()
              await verifyTreasuryAccess(idToken)
              router.replace("/treasury/home")
            } catch (err) {
              await signOut(auth)
              setError(err instanceof Error ? err.message : "Treasury access is not authorized.")
            } finally {
              setCheckingAuth(false)
            }
          })()
          return
        }
        setCheckingAuth(false)
      },
      () => {
        setError("Unable to verify authentication state. Please sign in.")
        setCheckingAuth(false)
      }
    )
    return unsubscribe
  }, [auth, router])

  useEffect(() => {
    if (typeof window === "undefined") return
    const rememberedEmail = localStorage.getItem(TREASURY_EMAIL_STORAGE_KEY)
    if (rememberedEmail) {
      setEmail(rememberedEmail)
      setRemember(true)
    }
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError("")
    setSuccess("")

    const normalizedEmail = email.trim().toLowerCase()
    if (!normalizedEmail) return setError("Email is required")
    if (!password) return setError("Password is required")

    setLoading(true)
    try {
      await signInWithEmailAndPassword(auth, normalizedEmail, password)

      if (typeof window !== "undefined") {
        if (remember) {
          localStorage.setItem(TREASURY_EMAIL_STORAGE_KEY, normalizedEmail)
        } else {
          localStorage.removeItem(TREASURY_EMAIL_STORAGE_KEY)
        }
      }

      setSuccess("Signed in successfully. Verifying treasury access...")
      setPassword("")
    } catch (err) {
      if (auth.currentUser) {
        await signOut(auth)
      }
      if (err instanceof FirebaseError) {
        if (err.code === "auth/user-not-found") {
          setError("Account not found. Please contact an administrator.")
        } else if (err.code === "auth/wrong-password" || err.code === "auth/invalid-credential") {
          setError("Invalid email or password.")
        } else {
          setError(err.message || "Unexpected authentication error.")
        }
      } else {
        setError(err instanceof Error ? err.message : "Unexpected error")
      }
    } finally {
      setLoading(false)
    }
  }

  if (checkingAuth) {
    return (
      <div className="bg-white rounded-xl p-6 shadow-sm border border-border max-w-sm mx-auto text-center">
        <p className="text-sm text-muted-foreground">Checking authentication...</p>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="bg-white rounded-xl p-6 shadow-sm border border-border max-w-sm mx-auto">
        {error ? <div className="text-sm text-red-600 mb-2">{error}</div> : null}
        {success ? <div className="text-sm text-green-600 mb-2">{success}</div> : null}

        <div className="mb-4 text-center">
          <label className="block text-sm font-medium text-muted-foreground mb-1 text-center">Email</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full max-w-[320px] mx-auto rounded-md border border-gray-200 px-3 py-2 bg-gray-50 text-center focus:outline-none focus:ring-2 focus:ring-[#276221]"
            placeholder="you@organization.com"
            required
            aria-label="Treasury email"
          />
        </div>

        <div className="mb-3 text-center">
          <label className="block text-sm font-medium text-muted-foreground mb-1 text-center">Password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full max-w-[320px] mx-auto rounded-md border border-gray-200 px-3 py-2 bg-gray-50 text-center focus:outline-none focus:ring-2 focus:ring-[#276221]"
            placeholder="••••••••"
            required
            aria-label="Treasury password"
          />
        </div>

        <div className="flex items-center justify-center text-sm mb-4">
          <label className="inline-flex items-center gap-2">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="h-4 w-4" />
            <span className="text-muted-foreground">Remember me</span>
          </label>
        </div>

        <div>
          <button
            type="submit"
            disabled={loading}
            className="w-full inline-flex justify-center items-center gap-2 rounded-md bg-[#276221] px-4 py-2 text-white hover:bg-[#1f5318] disabled:opacity-60"
          >
            {loading ? "Signing in..." : "Sign in"}
          </button>
        </div>

        <p className="text-xs text-gray-500 mt-3">
          Credentials are validated by Firebase Auth and treasury role verification.
        </p>
      </div>
    </form>
  )
}
