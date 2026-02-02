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
  const serviceAccountPath = process.env.FIREBASE_ADMIN_SERVICE_ACCOUNT_PATH
  
  let credential
  if (serviceAccountPath) {
    credential = cert(serviceAccountPath)
  } else {
    // Fallback to the local service account file
    const localPath = path.resolve(
      process.cwd(),
      "database/data/sabangan-app-firebase-adminsdk-fbsvc-9d9378f051.json"
    )
    credential = cert(localPath)
  }

  return initializeApp({
    credential,
    databaseURL: process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL,
  })
}

export const adminApp = getFirebaseAdminApp()
export const adminAuth = getAuth(adminApp)
export const adminDb = getDatabase(adminApp)
