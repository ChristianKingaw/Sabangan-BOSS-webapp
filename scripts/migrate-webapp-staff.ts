import { config as loadEnv } from "dotenv"
loadEnv({ path: ".env.local", override: true })
loadEnv()

const BASE_PATH = "users/webapp"

async function main() {
  const { adminDb } = await import("../lib/firebase-admin")
  const baseRef = adminDb.ref(BASE_PATH)
  const snap = await baseRef.get()

  if (!snap.exists()) {
    console.log(`No data found at ${BASE_PATH}; nothing to migrate.`)
    return
  }

  const data = snap.val() as Record<string, unknown>
  const staffExisting = (data["staff"] ?? {}) as Record<string, unknown>
  const adminExists = Object.prototype.hasOwnProperty.call(data, "admin")

  const updates: Record<string, unknown> = {}
  const migrated: string[] = []
  const skippedExisting: string[] = []
  const skippedNonObject: string[] = []

  for (const [key, value] of Object.entries(data)) {
    if (key === "staff" || key === "admin") {
      continue
    }

    if (typeof value !== "object" || value === null) {
      skippedNonObject.push(key)
      continue
    }

    if (Object.prototype.hasOwnProperty.call(staffExisting, key)) {
      skippedExisting.push(key)
      continue
    }

    updates[`${BASE_PATH}/staff/${key}`] = value
    updates[`${BASE_PATH}/${key}`] = null
    migrated.push(key)
  }

  if (!adminExists) {
    updates[`${BASE_PATH}/admin`] = {}
  }

  if (Object.keys(updates).length === 0) {
    console.log("No updates required. Existing staff/admin structure intact.")
    console.log(`Skipped already in staff: ${skippedExisting.join(", ") || "none"}`)
    console.log(`Skipped non-object entries: ${skippedNonObject.join(", ") || "none"}`)
    return
  }

  await adminDb.ref().update(updates)

  console.log(`Migrated to staff: ${migrated.length ? migrated.join(", ") : "none"}`)
  if (!adminExists) console.log("Created empty admin bucket.")
  if (skippedExisting.length) console.log(`Skipped already in staff: ${skippedExisting.join(", ")}`)
  if (skippedNonObject.length) console.log(`Skipped non-object entries: ${skippedNonObject.join(", ")}`)
  console.log("Done.")
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
