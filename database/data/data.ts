import { realtimeDb } from "../firebase"
import { ref, get } from "firebase/database"
import fs from "fs/promises"
import path from "path"

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

async function fetchAdminFallback() {
  try {
    const admin = await import("firebase-admin")
    const saPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.FIREBASE_ADMIN_SDK_PATH
    if (!saPath) {
      throw new Error("No service account path set in GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_ADMIN_SDK_PATH")
    }
    const abs = path.resolve(process.cwd(), saPath)
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
