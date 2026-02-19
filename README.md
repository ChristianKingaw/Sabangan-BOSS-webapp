# eBOSS Sabangan Web App

## Introduction

eBOSS Sabangan is a web-based Business One Stop Shop (BOSS) system for LGU staff.  
It centralizes business application review, document validation, Mayor's Clearance processing, treasury fee assessment, and LGU status announcements in one platform.

## Screenshots

### BOSS Staff Login

![BOSS Staff Login](docs/screenshots/boss-signin.png)

### Treasury Login

![Treasury Login](docs/screenshots/treasury-signin.png)

## Features

### Main System (`/`)

- Staff authentication (Firebase Auth login, email verification checks)
- Home dashboard with live counters and recent notifications
- Built-in messenger for staff-client conversations
- Business Application module:
  - Search and filter applications
  - Status tracking (pending/approved/rejected/updated)
  - Open each record for requirement review
- Requirement review page (`/client/[id]`):
  - View uploaded files per requirement
  - Approve or reject with notes
  - DOCX preview and print
  - Application form preview (DOCX/PDF), merge approved requirement PDFs, then print
  - Cedula and Official Receipt payment visibility (from treasury data)
- Mayor's Clearance Application module:
  - Search/filter by status and date
  - Review Barangay Clearance uploads
  - Approve/reject Barangay requirement files with reason
- Mayor's Clearance Records module:
  - Build yearly/monthly clearance records
  - Generate and download Mayor's Clearance Excel files
  - Includes approved clearance and approved business-based records
- DOCX and PDF exports via API routes:
  - `/api/export/docx`
  - `/api/export/docx-to-pdf`
  - `/api/export/application-docs`
  - `/api/export/clearance-template`

### LGU Status System (`/lgu-status`)

- Municipality status board management:
  - Open/closed status
  - Office hours
  - Public note/advisory
- Mayor availability management:
  - Availability state (available, in meeting, on field, on leave, unavailable)
  - Expected return date
- Featured event broadcast:
  - Enable/disable featured event
  - Title, subtitle, date/time, location, category, details, banner URL
- Upcoming events manager:
  - Add/edit/delete events
  - Live sync to Realtime Database
- Manual refresh and "last updated" tracking

### Other Modules

- Admin module (`/admin`): manage staff/treasury users and business-application cleanup
- Treasury module (`/treasury`): fee assessment computation, Cedula/OR capture, and client transaction records

## Framework and Tech Stack

- Frontend: `Next.js 15`, `React 18`, `TypeScript`
- UI: `Tailwind CSS`, `Radix UI`, `lucide-react`
- Backend: Next.js Route Handlers (`app/api/*`, Node runtime)
- Database/Auth/Hosting: `Firebase` (Realtime Database, Authentication, Hosting, optional Firestore indexes)
- Server-side Firebase access: `firebase-admin`
- Document processing:
  - `docxtemplater` + `pizzip` for DOCX templating
  - `pdf-lib` for PDF merging
  - `exceljs` for Mayor's Clearance spreadsheets
  - `docx-preview` for browser DOCX previews
- DOCX to PDF conversion service: `Express` + `LibreOffice` in Docker/Cloud Run (`cloud-run-converter`)
- Optional preview cache: `Redis` (`REDIS_URL`, `UPSTASH_REDIS_URL`, or `KV_URL`)

## Installation

### 1) Prerequisites

- Node.js `22.x` (recommended)
- npm
- Docker Desktop
- Firebase CLI (`firebase-tools`)
- Google Cloud SDK (`gcloud`) for Cloud Run deployment
- Git

### 2) Clone and install dependencies

```bash
git clone <your-repo-url>
cd eBOSS-Sabangan
npm install
cd cloud-run-converter
npm install
cd ..
```

## Firebase Setup

### 1) Create and configure Firebase project

1. Create a Firebase project.
2. Enable these services:
   - Authentication (Email/Password)
   - Realtime Database
   - Storage
3. Register a Web App and copy Firebase config values.

### 2) Configure CLI to your project

```bash
firebase login
firebase use --add
gcloud auth login
gcloud config set project YOUR_PROJECT_ID
```

### 3) Create environment files

Create `.env.local` in project root:

```env
NEXT_PUBLIC_FIREBASE_DATABASE_NAMESPACE=users/webapp

NEXT_PUBLIC_FIREBASE_API_KEY=your_api_key
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=your_project.firebaseapp.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID=your_project_id
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=your_project.appspot.com
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=your_sender_id
NEXT_PUBLIC_FIREBASE_APP_ID=your_app_id
NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID=your_measurement_id
NEXT_PUBLIC_FIREBASE_DATABASE_URL=https://your-db-name.firebasedatabase.app

CONVERTER_SERVICE_URL=http://127.0.0.1:8080/convert/docx-to-pdf

# Optional
REDIS_URL=redis://user:password@host:6379
PREVIEW_FORM_CACHE_TTL_SECONDS=600
PREVIEW_FORM_CACHE_VERSION=1
```

For local admin SDK auth (optional but recommended in local dev), add `.env.development.local`:

```env
FIREBASE_ADMIN_SERVICE_ACCOUNT_PATH=C:\path\to\your-service-account.json
GOOGLE_APPLICATION_CREDENTIALS=C:\path\to\your-service-account.json
```

For hosting/framework deployment, keep `.env` minimal and deployment-safe:

```env
CONVERTER_SERVICE_URL=https://converter-<hash>.asia-southeast1.run.app/convert/docx-to-pdf
```

Notes:
- Do not put local Windows credential paths in deploy-time `.env` for production hosting.
- This repo currently expects Realtime Database URL to be present for server routes.

## Docker Setup for DOCX to PDF

The converter service lives in `cloud-run-converter` and exposes:
- `GET /health`
- `POST /convert/docx-to-pdf`

### Local Docker run

```bash
cd cloud-run-converter
docker build -t eboss-converter .
docker run --rm -p 8080:8080 --name eboss-converter eboss-converter
```

Health check:

```bash
curl http://127.0.0.1:8080/health
```

If this is running, the app can convert DOCX to PDF locally.  
`/api/export/docx-to-pdf` already has a local fallback to `http://127.0.0.1:8080/convert/docx-to-pdf`.

### Cloud Run deployment (optional)

```bash
cd cloud-run-converter
gcloud services enable cloudbuild.googleapis.com run.googleapis.com artifactregistry.googleapis.com
gcloud run deploy converter \
  --source . \
  --region asia-southeast1 \
  --platform managed \
  --allow-unauthenticated \
  --memory 1Gi \
  --timeout 300
```

Then ensure `firebase.json` rewrite points to this service:

```json
{
  "source": "/api/convert/**",
  "run": {
    "serviceId": "converter",
    "region": "asia-southeast1"
  }
}
```

## Run the System

From project root:

```bash
npm run dev
```

Open:
- `http://localhost:3000` (main staff portal)
- `http://localhost:3000/lgu-status` (LGU status board)
- `http://localhost:3000/admin` (admin module)
- `http://localhost:3000/treasury` (treasury module)

## Deploy Web App (Firebase Hosting + SSR)

```bash
firebase deploy --only hosting
```

## Quick Troubleshooting

- `500/502` on DOCX->PDF export:
  - Confirm converter is running and reachable (`/health`).
  - Check `CONVERTER_SERVICE_URL`.
- `Missing Firebase Admin credentials`:
  - Set `FIREBASE_ADMIN_SERVICE_ACCOUNT_PATH` or `FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON`.
- `Missing Firebase Realtime Database URL`:
  - Set `NEXT_PUBLIC_FIREBASE_DATABASE_URL` in `.env.local`.
