import { existsSync, readdirSync, statSync, readFileSync } from "fs"
import admin from "firebase-admin"
import path from "path"

const DEFAULT_ADMIN_APP_NAME = "__eboss_admin__"

function normalizeDatabaseUrl(value?: string) {
  const trimmed = value?.trim()
  if (!trimmed) return undefined
  return trimmed.replace(/\/+$/, "")
}

function getConfiguredDatabaseUrl() {
  return normalizeDatabaseUrl(
    process.env.FIREBASE_DATABASE_URL ?? process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL
  )
}

/**
 * Initialize Firebase Admin SDK for server-side operations.
 * Uses service account credentials for authentication.
 */
function getFirebaseAdminApp(): admin.app.App {
  const appName = normalizeAppName(process.env.FIREBASE_ADMIN_APP_NAME)
  const configuredDatabaseURL = getConfiguredDatabaseUrl()

  // Prefer a dedicated named app to avoid accidentally reusing a pre-initialized
  // [DEFAULT] app that may point to a different RTDB instance in managed runtimes.
  try {
    return admin.app(appName)
  } catch {
    // app not initialized yet
  }

  const existingDefaultApp = admin.apps
    .filter((app): app is admin.app.App => app != null)
    .find((app) => app.name === "[DEFAULT]")
  if (existingDefaultApp && configuredDatabaseURL) {
    const existingDefaultUrl = normalizeDatabaseUrl(
      (existingDefaultApp.options as { databaseURL?: string } | undefined)?.databaseURL
    )
    if (existingDefaultUrl === configuredDatabaseURL) {
      return existingDefaultApp
    }
  }

  const configuredProjectId = getConfiguredProjectId()

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
    let parsed: admin.ServiceAccount | undefined
    try {
      parsed = JSON.parse(jsonEnv) as admin.ServiceAccount
    } catch {
      // ignore and continue to file fallback
      credential = undefined
    }

    if (!credential && parsed) {
      const parsedProjectId = readServiceAccountProjectId(parsed)
      assertProjectIdsMatch(
        configuredProjectId,
        parsedProjectId,
        "FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON"
      )
      credential = admin.credential.cert(parsed)
      if (!process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID && parsedProjectId) {
        process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = parsedProjectId
      }
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
      ...findServiceAccountFallbackPaths(configuredProjectId),
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
      } catch (err) {
        throw new Error(`Failed to read/parse service account JSON: ${String(err)}`)
      }

      const parsedProjectId = readServiceAccountProjectId(parsedServiceAccount)
      assertProjectIdsMatch(
        configuredProjectId,
        parsedProjectId,
        `service account file "${serviceAccountPath}"`
      )
      if (!process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID && parsedProjectId) {
        process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = parsedProjectId
      }
      credential = admin.credential.cert(parsedServiceAccount)
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
    const checked = [envServiceAccountPathCandidate, ...findServiceAccountFallbackPaths(configuredProjectId)]
      .filter(Boolean)
      .join(", ")

    const runtimeMsg = isManagedRuntime
      ? "Managed runtime detected, but ADC was unavailable."
      : "Local runtime detected."
    const configuredProjectMsg = configuredProjectId
      ? ` Configured projectId: "${configuredProjectId}".`
      : ""
    throw new Error(
      `${runtimeMsg}${configuredProjectMsg} Missing Firebase Admin credentials. Checked paths: ${checked}. ` +
        `Set FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON or a valid FIREBASE_ADMIN_SERVICE_ACCOUNT_PATH, ` +
        `or configure Application Default Credentials.`
    )
  }

  const databaseURL = configuredDatabaseURL

  const projectId =
    process.env.FIREBASE_PROJECT_ID ?? process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? undefined

  if (!databaseURL) {
    throw new Error(
      "Missing Firebase Realtime Database URL. Set FIREBASE_DATABASE_URL or NEXT_PUBLIC_FIREBASE_DATABASE_URL in .env.local"
    )
  }

  const initOpts: Record<string, unknown> = { credential, databaseURL }
  if (projectId) initOpts.projectId = projectId

  if (existingDefaultApp) {
    const existingDefaultUrl = normalizeDatabaseUrl(
      (existingDefaultApp.options as { databaseURL?: string } | undefined)?.databaseURL
    )
    if (existingDefaultUrl && existingDefaultUrl !== databaseURL) {
      console.warn(
        `[firebase-admin] Existing default app databaseURL "${existingDefaultUrl}" differs from configured "${databaseURL}". ` +
          `Initializing isolated app "${appName}" to avoid cross-database reads.`
      )
    } else if (existingDefaultUrl === databaseURL) {
      return existingDefaultApp
    }
  }

  return admin.initializeApp(initOpts, appName)
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

function findServiceAccountFallbackPaths(projectIdHint?: string) {
  const filenamePattern = /^[a-z0-9-]+-firebase-adminsdk-[a-z0-9]+-[a-z0-9]+\.json$/i
  const normalizedProjectIdHint = projectIdHint?.trim().toLowerCase()
  const expectedPrefix = normalizedProjectIdHint
    ? `${normalizedProjectIdHint}-firebase-adminsdk-`
    : undefined
  const candidateDirs = [
    path.resolve(process.cwd(), "database/data"),
    path.resolve(__dirname, "..", "database/data"),
  ]

  const discovered: string[] = []
  for (const dir of candidateDirs) {
    try {
      const files = readdirSync(dir, { withFileTypes: true })
      for (const file of files) {
        const normalizedFilename = file.name.toLowerCase()
        if (
          file.isFile() &&
          filenamePattern.test(normalizedFilename) &&
          (!expectedPrefix || normalizedFilename.startsWith(expectedPrefix))
        ) {
          discovered.push(path.resolve(dir, file.name))
        }
      }
    } catch {
      // ignore missing/unreadable directories
    }
  }

  return Array.from(new Set(discovered))
}

function getConfiguredProjectId() {
  return normalizeProjectId(
    process.env.FIREBASE_PROJECT_ID ?? process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID
  )
}

function normalizeProjectId(value?: string) {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function normalizeAppName(value?: string) {
  const trimmed = value?.trim()
  return trimmed ? trimmed : DEFAULT_ADMIN_APP_NAME
}

function readServiceAccountProjectId(
  serviceAccount: Pick<admin.ServiceAccount, "projectId"> & { project_id?: string }
) {
  return normalizeProjectId(serviceAccount.project_id ?? serviceAccount.projectId)
}

function assertProjectIdsMatch(
  configuredProjectId: string | undefined,
  credentialProjectId: string | undefined,
  source: string
) {
  if (!configuredProjectId || !credentialProjectId || configuredProjectId === credentialProjectId) {
    return
  }

  throw new Error(
    `Firebase Admin credential project mismatch. Configured projectId is "${configuredProjectId}" but ${source} belongs to "${credentialProjectId}". ` +
      `Use credentials from the configured project, or update NEXT_PUBLIC_FIREBASE_PROJECT_ID/FIREBASE_PROJECT_ID to match.`
  )
}
