import { config as loadEnv } from "dotenv"
loadEnv({ path: ".env.local", override: true })
loadEnv()

import { createInterface } from "node:readline/promises"
import { stdin as input, stdout as output } from "node:process"

import { createHash } from "node:crypto"

// Simple interactive CLI to create an admin Auth user and metadata entry in Realtime DB at users/webapp/admin

type Answers = {
  firstName: string
  middleName?: string
  lastName: string
  email: string
  password: string
  createdByEmail?: string
  emailVerified: boolean
}

const REQUIRED_ENV_VARS = [
  "NEXT_PUBLIC_FIREBASE_API_KEY",
  "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN",
  "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
  "NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET",
  "NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID",
  "NEXT_PUBLIC_FIREBASE_APP_ID",
  "NEXT_PUBLIC_FIREBASE_DATABASE_URL",
]

function ensureEnv() {
  const missing = REQUIRED_ENV_VARS.filter((k) => !process.env[k])
  if (missing.length) {
    throw new Error(`Missing env vars: ${missing.join(", ")}. Check .env.local.`)
  }
}

function printHelp() {
  console.log(`Add an admin user (Firebase Auth + Realtime DB)

Required:
  --firstName John
  --lastName Doe
  --email john@example.com
  --password StrongPass123!

Optional:
  --middleName Middle
  --createdByEmail admin@example.com
  --emailVerified true|false (default true)

Example:
  pnpm tsx scripts/add-admin.tsx --firstName Jane --lastName Doe --email jane@example.com --password P@ssw0rd! --createdByEmail admin@example.com --emailVerified true

You can also run without flags and enter values interactively.
`)
}

async function promptUser(): Promise<Answers> {
  const rl = createInterface({ input, output })

  const ask = async (question: string) => (await rl.question(question)).trim()

  const firstName = await ask("First name: ")
  const middleName = await ask("Middle name (optional): ")
  const lastName = await ask("Last name: ")
  const email = await ask("Email: ")
  const password = await ask("Password: ")
  const createdByEmail = await ask("Created by email (optional): ")
  const emailVerifiedAns = (await ask("Email verified? (Y/n): ")).toLowerCase()
  const emailVerified = emailVerifiedAns === "" || emailVerifiedAns === "y" || emailVerifiedAns === "yes" || emailVerifiedAns === "true"

  rl.close()
  return {
    firstName,
    middleName: middleName || undefined,
    lastName,
    email,
    password,
    createdByEmail: createdByEmail || undefined,
    emailVerified,
  }
}

function hashPassword(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

async function main() {
  ensureEnv()

  printHelp()
  const answers = await promptUser()
  if (!answers.firstName || !answers.lastName || !answers.email || !answers.password) {
    throw new Error("Missing required fields.")
  }

  const [{ adminAuth, adminDb }, { ServerValue }] = await Promise.all([
    import("../lib/firebase-admin"),
    import("firebase-admin/database"),
  ])

  const email = answers.email.trim().toLowerCase()
  const password = answers.password
  const emailVerified = answers.emailVerified ?? true

  const rawNamespace =
    process.env.NEXT_PUBLIC_DATABASE_NAMESPACE ??
    process.env.NEXT_PUBLIC_FIREBASE_DATABASE_NAMESPACE ??
    "users/webapp"

  const namespace = rawNamespace.endsWith("/admin") ? rawNamespace : `${rawNamespace}/admin`

  // Create Firebase Auth user first so login works.
  const authUser = await adminAuth
    .createUser({
      email,
      password,
      emailVerified,
      displayName: [answers.firstName, answers.lastName].filter(Boolean).join(" "),
    })
    .catch((err) => {
      throw new Error(`Failed to create Auth user: ${String(err)}`)
    })

  const adminRef = adminDb.ref(namespace)
  const newRef = adminRef.push()
  if (!newRef.key) {
    throw new Error("Failed to allocate database key")
  }

  const record: Record<string, unknown> = {
    firstName: answers.firstName,
    lastName: answers.lastName,
    email,
    createdAt: ServerValue.TIMESTAMP,
    createdByEmail: answers.createdByEmail ?? null,
    emailVerified,
    uid: authUser.uid,
    passwordHash: hashPassword(password),
  }

  if (answers.middleName && answers.middleName.trim().length > 0) {
    record.middleName = answers.middleName.trim()
  }

  await newRef.set(record)

  console.log("Created admin user")
  console.log(`  Auth UID: ${authUser.uid}`)
  console.log(`  DB Key : ${newRef.key}`)
  console.log(`  Path   : ${namespace}/${newRef.key}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
