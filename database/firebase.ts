import dotenv from "dotenv"
import path from "path"

// Load .env.local first (Next.js convention), then fallback to .env
try {
  if (typeof process !== "undefined" && process) {
    dotenv.config({ path: path.resolve(process.cwd(), ".env.local") })
    dotenv.config()
  }
} catch (err) {
  // Some environments may not provide stdio/TTY; ignore dotenv failures here
}
import { initializeApp, getApp, getApps, type FirebaseApp } from "firebase/app"
import { getFirestore } from "firebase/firestore"
import { getDatabase } from "firebase/database"

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
export const db = getFirestore(app)
export const realtimeDb = getDatabase(app)