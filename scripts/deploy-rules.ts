import admin from "firebase-admin"
import { readFileSync, existsSync } from "fs"
import path from "path"
import dotenv from "dotenv"

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") })
dotenv.config({ path: path.resolve(process.cwd(), ".env") })

const serviceAccountPath =
  process.env.FIREBASE_ADMIN_SERVICE_ACCOUNT_PATH ||
  "database/data/sabangan-webapp-tourism-firebase-adminsdk-fbsvc-bb4bef7b25.json"

const rulesPath = process.env.FIREBASE_DATABASE_RULES_PATH || "database.rules.json"
const databaseURL =
  process.env.FIREBASE_DATABASE_URL || process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL

const absolutePath = path.resolve(process.cwd(), serviceAccountPath)

if (!existsSync(absolutePath)) {
  console.error("Service account file not found:", absolutePath)
  process.exit(1)
}

if (!databaseURL) {
  console.error(
    "Missing database URL. Set FIREBASE_DATABASE_URL or NEXT_PUBLIC_FIREBASE_DATABASE_URL before deploying rules."
  )
  process.exit(1)
}
const resolvedDatabaseURL = databaseURL

const serviceAccount = JSON.parse(readFileSync(absolutePath, "utf8"))

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: resolvedDatabaseURL
})

async function deployRules() {
  console.log("=== Deploying Realtime Database Rules ===\n")

  const absoluteRulesPath = path.resolve(process.cwd(), rulesPath)

  if (!existsSync(absoluteRulesPath)) {
    console.error("Rules file not found:", absoluteRulesPath)
    process.exit(1)
  }

  const rulesContent = JSON.parse(readFileSync(absoluteRulesPath, "utf8"))
  const normalizedRules = rulesContent?.rules ?? rulesContent
  if (!normalizedRules || typeof normalizedRules !== "object") {
    console.error("Invalid rules payload. Expected an object or { rules: { ... } } format.")
    process.exit(1)
  }

  console.log(`Rules source: ${absoluteRulesPath}`)
  console.log(`Database URL: ${resolvedDatabaseURL}`)
  console.log("Rules preview:")
  console.log(JSON.stringify(rulesContent, null, 2).slice(0, 500) + "...\n")

  const accessToken = await admin.credential.cert(serviceAccount).getAccessToken()

  const baseDatabaseURL = resolvedDatabaseURL.replace(/\/+$/, "")
  const url = `${baseDatabaseURL}/.settings/rules.json?access_token=${accessToken.access_token}`

  const response = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rules: normalizedRules })
  })

  if (!response.ok) {
    const errorText = await response.text()
    console.error("Failed to deploy rules:", response.status, errorText)
    process.exit(1)
  }

  console.log("Rules deployed successfully!")

  const verifyUrl = `${baseDatabaseURL}/.settings/rules.json?access_token=${accessToken.access_token}`
  const verifyResp = await fetch(verifyUrl)
  if (verifyResp.ok) {
    const currentRulesPayload = await verifyResp.json()
    const currentRules = currentRulesPayload?.rules ?? currentRulesPayload
    const mhoIndex = currentRules?.users?.webapp?.mho?.[".indexOn"] ?? null
    console.log("\nVerified - Treasury rules exist:", !!currentRules?.Treasury)
    console.log("Verified - users/webapp/mho .indexOn:", JSON.stringify(mhoIndex))
  }

  await admin.app().delete()
}

deployRules().catch(async (err) => {
  console.error("Error:", err)
  try {
    await admin.app().delete()
  } catch {}
  process.exitCode = 1
})
