import { config as loadEnv } from "dotenv"
loadEnv({ path: ".env.local", override: true })
loadEnv()

import { createHash } from "node:crypto"
import { createInterface } from "node:readline/promises"
import { stdin as input, stdout as output } from "node:process"

type Args = {
  firstName?: string
  middleName?: string
  lastName?: string
  email?: string
  password?: string
  createdByEmail?: string
  emailVerified?: boolean
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

function parseArgs(argv: string[]): Args {
  const args: Args = {}
  for (let i = 0; i < argv.length; i++) {
    const curr = argv[i]
    if (!curr.startsWith("--")) continue
    const key = curr.slice(2)
    const next = argv[i + 1]
    const hasValue = next !== undefined && !next.startsWith("--")
    switch (key) {
      case "firstName":
        if (hasValue) args.firstName = next
        break
      case "middleName":
        if (hasValue) args.middleName = next
        break
      case "lastName":
        if (hasValue) args.lastName = next
        break
      case "email":
        if (hasValue) args.email = next
        break
      case "password":
        if (hasValue) args.password = next
        break
      case "createdByEmail":
        if (hasValue) args.createdByEmail = next
        break
      case "emailVerified":
        if (hasValue) {
          const val = next.toLowerCase()
          args.emailVerified = val === "true" || val === "1" || val === "yes"
        } else {
          args.emailVerified = true
        }
        break
      case "help":
      case "h":
        printHelp()
        process.exit(0)
      default:
        break
    }
  }
  return args
}

function printHelp() {
  console.log(`Add a staff user (Firebase Auth + Realtime DB)

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
  pnpm tsx scripts/add-staff.ts --firstName Jane --lastName Doe --email jane@example.com --password P@ssw0rd! --createdByEmail admin@example.com --emailVerified true

You can also run without flags and enter values interactively.
`)
}

function hashPassword(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

async function promptMissing(args: Args): Promise<Args> {
  const rl = createInterface({ input, output })
  const merged: Args = { ...args }

  const ask = async (question: string, existing?: string) => {
    if (existing) return existing
    const answer = await rl.question(question)
    return answer.trim()
  }

  merged.firstName = await ask("First name: ", merged.firstName)
  merged.middleName = await ask("Middle name (optional): ", merged.middleName)
  merged.lastName = await ask("Last name: ", merged.lastName)
  merged.email = await ask("Email: ", merged.email)
  merged.password = await ask("Password: ", merged.password)
  merged.createdByEmail = await ask("Created by email (optional): ", merged.createdByEmail)

  if (merged.emailVerified === undefined) {
    const ans = (await rl.question("Email verified? (Y/n): ")).trim().toLowerCase()
    merged.emailVerified = ans === "" || ans === "y" || ans === "yes" || ans === "true"
  }

  merged.middleName = merged.middleName || undefined
  merged.createdByEmail = merged.createdByEmail || undefined

  rl.close()
  return merged
}

async function main() {
  ensureEnv()

  const parsed = parseArgs(process.argv.slice(2))
  const args = await promptMissing(parsed)
  if (!args.firstName || !args.lastName || !args.email || !args.password) {
    printHelp()
    throw new Error("Missing required fields. See help above.")
  }

  // Load admin SDK after env vars are in place
  const [{ adminAuth, adminDb }, { ServerValue }] = await Promise.all([
    import("../lib/firebase-admin"),
    import("firebase-admin/database"),
  ])

  const email = args.email.trim().toLowerCase()
  const password = args.password
  const emailVerified = args.emailVerified ?? true

  const rawNamespace =
    process.env.NEXT_PUBLIC_DATABASE_NAMESPACE ??
    process.env.NEXT_PUBLIC_FIREBASE_DATABASE_NAMESPACE ??
    "users/webapp"

  const namespace = rawNamespace.endsWith("/staff") ? rawNamespace : `${rawNamespace}/staff`

  // Create Firebase Auth user first so login works.
  const authUser = await adminAuth
    .createUser({
      email,
      password,
      emailVerified,
      displayName: [args.firstName, args.lastName].filter(Boolean).join(" "),
    })
    .catch((err) => {
      throw new Error(`Failed to create Auth user: ${String(err)}`)
    })

  const staffRef = adminDb.ref(namespace)
  const newRef = staffRef.push()
  if (!newRef.key) {
    throw new Error("Failed to allocate database key")
  }

  const record: Record<string, unknown> = {
    firstName: args.firstName,
    lastName: args.lastName,
    email,
    passwordHash: hashPassword(password),
    createdAt: ServerValue.TIMESTAMP,
    createdByEmail: args.createdByEmail ?? null,
    emailVerified,
    uid: authUser.uid,
  }

  if (args.middleName && args.middleName.trim().length > 0) {
    record.middleName = args.middleName.trim()
  }

  await newRef.set(record)

  console.log("Created staff user")
  console.log(`  Auth UID: ${authUser.uid}`)
  console.log(`  DB Key : ${newRef.key}`)
  console.log(`  Path   : ${namespace}/${newRef.key}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})