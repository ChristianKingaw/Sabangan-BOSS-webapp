"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.realtimeDb = exports.db = exports.app = void 0;
var app_1 = require("firebase/app");
var firestore_1 = require("firebase/firestore");
var database_1 = require("firebase/database");
var firebaseConfig = {
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
    measurementId: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID,
    databaseURL: process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL,
};
function createFirebaseApp() {
    if ((0, app_1.getApps)().length > 0) {
        return (0, app_1.getApp)();
    }
    return (0, app_1.initializeApp)(firebaseConfig);
}
exports.app = createFirebaseApp();
exports.db = (0, firestore_1.getFirestore)(exports.app);
exports.realtimeDb = (0, database_1.getDatabase)(exports.app);
