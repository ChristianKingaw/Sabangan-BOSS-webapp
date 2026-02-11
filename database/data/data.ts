import { realtimeDb } from "../firebase.js"
import { ref, get } from "firebase/database"
import fs from "fs/promises"
import path from "path"
import { fileURLToPath } from "url"

async function writeOut(data: unknown) {
  const outPath = path.resolve(process.cwd(), "database", "data", "data.json")
  await fs.writeFile(outPath, JSON.stringify(data, null, 2), "utf8")
  console.log(`Wrote data to ${outPath}`)
}

async function fetchClient() {
  const rootRef = ref(realtimeDb, "/")
  const snap = await get(rootRef)
  return snap.exists() ? snap.val() : null
}

const scriptDir = typeof __dirname !== "undefined" ? __dirname : path.dirname(fileURLToPath(import.meta.url))

async function resolveServiceAccountPath() {
  const envPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.FIREBASE_ADMIN_SDK_PATH
  if (envPath) {
    const resolvedEnvPath = path.isAbsolute(envPath) ? envPath : path.resolve(process.cwd(), envPath)
    try {
      await fs.access(resolvedEnvPath)
      return resolvedEnvPath
    } catch (err) {
      console.warn(`Configured service account path not found: ${resolvedEnvPath}`)
    }
  }

  const candidateDirs = Array.from(
    new Set([
      path.join(process.cwd(), "database", "data"),
      scriptDir,
      process.cwd(),
    ]),
  )

  const knownNames = [
    "service-account.json",
    "sabangan-app-firebase-adminsdk-fbsvc-9d9378f051.json",
  ]

  for (const dir of candidateDirs) {
    for (const name of knownNames) {
      const candidate = path.join(dir, name)
      try {
        await fs.access(candidate)
        return candidate
      } catch (err) {
        // keep searching
      }
    }

    try {
      const entries = await fs.readdir(dir)
      const fallback = entries.find((entry) => entry.endsWith(".json") && entry.includes("firebase-adminsdk"))
      if (fallback) {
        return path.join(dir, fallback)
      }
    } catch (err) {
      // ignore directory read issues for this dir and continue searching
    }
  }

  throw new Error(
    `No service account path set in env and no default service account JSON found in: ${candidateDirs.join(", ")}`,
  )
}

async function fetchAdminFallback() {
  try {
    const admin = await import("firebase-admin")
    const abs = await resolveServiceAccountPath()
    const raw = await fs.readFile(abs, "utf8")
    const serviceAccount = JSON.parse(raw)
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL,
      })
    }
    const db = admin.database()
    const refRoot = db.ref("/")
    const snap = await refRoot.once("value")
    return snap.val()
  } catch (err: any) {
    throw new Error(`Admin fallback failed: ${err && err.message ? err.message : err}`)
  }
}

async function fetchAndWrite() {
  try {
    const data = await fetchClient()
    await writeOut(data)
  } catch (err: any) {
    // Permission denied or similar - attempt admin fallback if available
    console.error("Failed to fetch with client SDK:", err && err.message ? err.message : err)
    if ((err && String(err).toLowerCase().includes("permission denied")) || (err && String(err).toLowerCase().includes("can't determine firebase database url"))) {
      try {
        const data = await fetchAdminFallback()
        await writeOut(data)
        return
      } catch (adminErr: any) {
        console.error(adminErr && adminErr.message ? adminErr.message : adminErr)
        console.error("To use the admin fallback: install 'firebase-admin' and set 'GOOGLE_APPLICATION_CREDENTIALS' to your service account JSON path.")
      }
    }
    console.error("Failed to fetch or write data:", err)
    process.exitCode = 1
  }
}

if (require.main === module) {
  fetchAndWrite()
}

export default fetchAndWrite
