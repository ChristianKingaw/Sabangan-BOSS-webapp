import { existsSync, statSync, readFileSync } from "fs"
import admin from "firebase-admin"
import path from "path"

/**
 * Initialize Firebase Admin SDK for server-side operations.
 * Uses service account credentials for authentication.
 */
function getFirebaseAdminApp(): admin.app.App {
  const existing = admin.apps.at(0)
  if (existing) return existing

  const isManagedRuntime =
    process.env.K_SERVICE ||
    process.env.FUNCTION_TARGET ||
    process.env.FUNCTION_NAME ||
    process.env.GOOGLE_CLOUD_PROJECT

  // Prefer ADC in managed runtimes (Firebase Hosting SSR / Cloud Functions / Cloud Run)
  let credential: admin.credential.Credential | undefined

  const envServiceAccountPath = process.env.FIREBASE_ADMIN_SERVICE_ACCOUNT_PATH
  const adcPath = process.env.GOOGLE_APPLICATION_CREDENTIALS

  const looksLikeWindowsPath = (value?: string) =>
    Boolean(value && /^[A-Za-z]:\\/.test(value))

  // In managed runtimes, always ignore local path-based credentials.
  if (isManagedRuntime) {
    if (envServiceAccountPath && (looksLikeWindowsPath(envServiceAccountPath) || !statSafeIsFile(envServiceAccountPath))) {
      delete process.env.FIREBASE_ADMIN_SERVICE_ACCOUNT_PATH
    }
    if (adcPath && (looksLikeWindowsPath(adcPath) || !statSafeIsFile(adcPath))) {
      delete process.env.GOOGLE_APPLICATION_CREDENTIALS
    }
  } else {
    // Local/dev: keep path-based credentials only when the file exists.
    if (envServiceAccountPath && !statSafeIsFile(envServiceAccountPath)) {
      delete process.env.FIREBASE_ADMIN_SERVICE_ACCOUNT_PATH
    }
    if (adcPath && !statSafeIsFile(adcPath)) {
      delete process.env.GOOGLE_APPLICATION_CREDENTIALS
    }
  }

  // Prefer explicit service account credentials (env JSON or local file).
  // Fall back to ADC when explicit credentials are not available.

  // 1) If explicit JSON is provided via env, use it
  const jsonEnv = process.env.FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON
  if (jsonEnv) {
    try {
      const parsed = JSON.parse(jsonEnv)
      credential = admin.credential.cert(parsed)
      if (!process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID && parsed.project_id) {
        process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = parsed.project_id
      }
    } catch {
      // ignore and continue to file fallback
      credential = undefined
    }
  }

  // 2) If a path is provided (env) or repo fallback exists, use it.
  // In managed runtimes we skip this and rely on ADC.
  if (!credential) {
    const envServiceAccountPathCandidate = isManagedRuntime
      ? undefined
      : process.env.FIREBASE_ADMIN_SERVICE_ACCOUNT_PATH ?? process.env.GOOGLE_APPLICATION_CREDENTIALS

    const candidatePaths = [
      envServiceAccountPathCandidate,
      path.resolve(process.cwd(), "database/data/sabangan-app-firebase-adminsdk-fbsvc-9d9378f051.json"),
      path.resolve(__dirname, "..", "database/data/sabangan-app-firebase-adminsdk-fbsvc-9d9378f051.json"),
    ].filter(Boolean) as string[]
    const serviceAccountPath = candidatePaths.find((p) => {
      try {
        return existsSync(p) && statSync(p).isFile()
      } catch {
        return false
      }
    })

    if (serviceAccountPath) {
      // Read and parse the service account JSON and pass the object to the SDK
      let parsedServiceAccount: any
      try {
        const raw = readFileSync(serviceAccountPath, "utf8")
        parsedServiceAccount = JSON.parse(raw)
        if (!process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID && parsedServiceAccount.project_id) {
          process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = parsedServiceAccount.project_id
        }
        credential = admin.credential.cert(parsedServiceAccount)
      } catch (err) {
        throw new Error(`Failed to read/parse service account JSON: ${String(err)}`)
      }
    }
  }

  // 3) Finally, try Application Default Credentials if nothing explicit found
  if (!credential) {
    try {
      credential = admin.credential.applicationDefault()
    } catch {
      credential = undefined
    }
  }

  if (!credential) {
    const envServiceAccountPathCandidate =
      process.env.FIREBASE_ADMIN_SERVICE_ACCOUNT_PATH ?? process.env.GOOGLE_APPLICATION_CREDENTIALS
    const checked = [
      envServiceAccountPathCandidate,
      path.resolve(process.cwd(), "database/data/sabangan-app-firebase-adminsdk-fbsvc-9d9378f051.json"),
      path.resolve(__dirname, "..", "database/data/sabangan-app-firebase-adminsdk-fbsvc-9d9378f051.json"),
    ]
      .filter(Boolean)
      .join(", ")

    const runtimeMsg = isManagedRuntime
      ? "Managed runtime detected, but ADC was unavailable."
      : "Local runtime detected."
    throw new Error(
      `${runtimeMsg} Missing Firebase Admin credentials. Checked paths: ${checked}. ` +
        `Set FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON or a valid FIREBASE_ADMIN_SERVICE_ACCOUNT_PATH, ` +
        `or configure Application Default Credentials.`
    )
  }

  const databaseURL =
    process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL ?? process.env.FIREBASE_DATABASE_URL ?? undefined

  const projectId =
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? process.env.FIREBASE_PROJECT_ID ?? undefined

  if (!databaseURL) {
    throw new Error(
      "Missing Firebase Realtime Database URL. Set NEXT_PUBLIC_FIREBASE_DATABASE_URL in .env.local"
    )
  }

  const initOpts: Record<string, unknown> = { credential, databaseURL }
  if (projectId) initOpts.projectId = projectId

  return admin.initializeApp(initOpts)
}

export const adminApp = getFirebaseAdminApp()
export const adminAuth = admin.auth(adminApp)
export const adminDb = admin.database(adminApp)
export const adminServerValue = admin.database.ServerValue

function statSafeIsFile(p: string) {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}
