# Firebase setup (client)

This folder contains a small Firebase client initializer for use in client components.

Create a `.env.local` in the project root with these variables (replace values):

```
NEXT_PUBLIC_FIREBASE_API_KEY=your_api_key
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=your_project.firebaseapp.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID=your_project_id
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=your_project.appspot.com
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=your_messaging_sender_id
NEXT_PUBLIC_FIREBASE_APP_ID=your_app_id
NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID=your_measurement_id

If you use the Realtime Database, also add:

```
NEXT_PUBLIC_FIREBASE_DATABASE_URL=https://your_project-default-rtdb.region.firebasedatabase.app
```
```

Usage example:

```ts
import { db } from "../database/firebase"
import { collection, getDocs } from "firebase/firestore"

const snapshot = await getDocs(collection(db, "clients"))
```

Notes:
- This file initializes the Firebase *client* SDK and is intended for use in browser code.
- For server-side or admin operations use the Firebase Admin SDK and secure server-only credentials.
