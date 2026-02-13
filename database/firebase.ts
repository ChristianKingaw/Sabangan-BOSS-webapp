import { initializeApp, getApp, getApps, type FirebaseApp } from "firebase/app"
import { getFirestore } from "firebase/firestore"
import { getDatabase } from "firebase/database"
import { getAuth, initializeAuth, browserLocalPersistence, type Auth } from "firebase/auth"

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  measurementId: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID,
  databaseURL: process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL,
}

function createFirebaseApp(): FirebaseApp {
  if (getApps().length > 0) {
    return getApp()
  }
  return initializeApp(firebaseConfig)
}

export const app = createFirebaseApp()

// Initialize auth with browserLocalPersistence BEFORE any other SDK
// This ensures user sessions persist across page refreshes
let firebaseAuth: Auth | null = null
if (typeof window !== "undefined") {
  try {
    // Try to initialize with persistence first
    firebaseAuth = initializeAuth(app, { persistence: browserLocalPersistence })
  } catch (err) {
    // Already initialized - get the existing instance
    if (err instanceof Error && err.message.includes("already exists")) {
      firebaseAuth = getAuth(app)
    } else {
      console.error("Failed to initialize auth:", err)
      firebaseAuth = getAuth(app)
    }
  }
}

export const auth = firebaseAuth
export const db = getFirestore(app)
export const realtimeDb = getDatabase(app)
