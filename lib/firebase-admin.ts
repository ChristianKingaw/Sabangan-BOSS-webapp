import { existsSync } from "fs"
import { initializeApp, getApps, cert, type App } from "firebase-admin/app"
import { getAuth } from "firebase-admin/auth"
import { getDatabase } from "firebase-admin/database"
import path from "path"

/**
 * Initialize Firebase Admin SDK for server-side operations.
 * Uses service account credentials for authentication.
 */
function getFirebaseAdminApp(): App {
  if (getApps().length > 0) {
    return getApps()[0]
  }

  // Try to load service account from environment variable first
  const envServiceAccountPath =
    process.env.FIREBASE_ADMIN_SERVICE_ACCOUNT_PATH ?? process.env.GOOGLE_APPLICATION_CREDENTIALS

  // Prefer env-provided path if it exists; otherwise fall back to the repo copy
  const serviceAccountPath =
    envServiceAccountPath && existsSync(envServiceAccountPath)
      ? envServiceAccountPath
      : path.resolve(
          process.cwd(),
          "database/data/sabangan-app-firebase-adminsdk-fbsvc-9d9378f051.json"
        )

  const credential = cert(serviceAccountPath)

  const databaseURL =
    process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL ?? process.env.FIREBASE_DATABASE_URL ?? undefined

  if (!databaseURL) {
    throw new Error(
      "Missing Firebase Realtime Database URL. Set NEXT_PUBLIC_FIREBASE_DATABASE_URL in .env.local"
    )
  }

  return initializeApp({
    credential,
    databaseURL,
  })
}

export const adminApp = getFirebaseAdminApp()
export const adminAuth = getAuth(adminApp)
export const adminDb = getDatabase(adminApp)
