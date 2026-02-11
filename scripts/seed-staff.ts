// scripts/seed-staff.ts
import { config as loadEnv } from "dotenv"
loadEnv({ path: ".env.local", override: true })
loadEnv()
import { ref, push, set, serverTimestamp } from "firebase/database"
import { createHash } from "node:crypto"

const REQUIRED_ENV_VARS = [
  "NEXT_PUBLIC_FIREBASE_API_KEY",
  "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN",
  "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
  "NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET",
  "NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID",
  "NEXT_PUBLIC_FIREBASE_APP_ID",
  "NEXT_PUBLIC_FIREBASE_DATABASE_URL",
]

for (const key of REQUIRED_ENV_VARS) {
  if (!process.env[key]) {
    throw new Error(`Missing env var ${key}. Check .env.local before running the seed script.`)
  }
}

async function main() {
  const { realtimeDb } = await import("../database/firebase")
  const rawNamespace =
    process.env.NEXT_PUBLIC_DATABASE_NAMESPACE ??
    process.env.NEXT_PUBLIC_FIREBASE_DATABASE_NAMESPACE ??
    "users/webapp"
  const namespace = rawNamespace.endsWith("/staff") ? rawNamespace : `${rawNamespace}/staff`
  const staffRef = ref(realtimeDb, namespace)
  const newRef = push(staffRef)
  if (!newRef.key) throw new Error("Failed to allocate key")
  return
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})