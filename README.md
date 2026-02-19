# eBOSS Sabangan Web App

This guide is for deploying the project on a new device and a different Firebase/GCP account.

## Architecture

The PDF export flow is:

1. Frontend calls `POST /api/export/docx-to-pdf`.
2. Next.js backend route renders DOCX templates with application data.
3. Backend calls converter endpoint for DOCX -> PDF.
4. Converter service (Express + LibreOffice in Docker/Cloud Run) returns PDF.
5. Backend returns PDF to frontend.

Important paths and APIs:

- Frontend calls:
  - `app/page.tsx`
  - `app/client/[id]/page.tsx`
- Backend routes:
  - `app/api/export/docx-to-pdf/route.ts`
  - `app/api/export/docx/route.ts`
  - `app/api/export/application-docs/route.ts`
  - `app/api/export/clearance-template/route.ts`
- Converter service:
  - `cloud-run-converter/server.js`
  - `GET /health`
  - `POST /convert/docx-to-pdf`
- Hosting rewrite:
  - `firebase.json` (`/api/convert/**` -> Cloud Run service `converter` in `asia-southeast1`)

## Prerequisites

- Node.js `22.x` (recommended)
- npm
- Docker Desktop
- Google Cloud SDK (`gcloud`)
- Firebase CLI (`firebase-tools`)
- Git

## 1) Clone and install

```bash
git clone <your-repo-url>
cd eBOSS-Sabangan
npm install
cd cloud-run-converter
npm install
cd ..
```

## 2) Create and configure Firebase/GCP project

1. Create a new Firebase project.
2. Enable Realtime Database, Authentication, and Storage in Firebase Console.
3. Register a Web App in Firebase and copy config values.
4. Set your CLI project:

```bash
firebase login
gcloud auth login
gcloud config set project YOUR_PROJECT_ID
firebase use --add
```

## 3) Configure environment files

Create/update these files in the project root:

### `.env.local` (safe for local + build)

```env
NEXT_PUBLIC_FIREBASE_DATABASE_NAMESPACE=users/webapp
NEXT_PUBLIC_FIREBASE_API_KEY=...
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=...
NEXT_PUBLIC_FIREBASE_PROJECT_ID=...
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=...
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=...
NEXT_PUBLIC_FIREBASE_APP_ID=...
NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID=...
NEXT_PUBLIC_FIREBASE_DATABASE_URL=https://<your-db>.firebasedatabase.app
CONVERTER_SERVICE_URL=https://converter-<hash>.asia-southeast1.run.app/convert/docx-to-pdf
REDIS_URL=redis://<user>:<password>@<host>:6379
PREVIEW_FORM_CACHE_TTL_SECONDS=600
```

### `.env` (used by Firebase frameworks deploy)

```env
CONVERTER_SERVICE_URL=https://converter-<hash>.asia-southeast1.run.app/convert/docx-to-pdf
```

### `.env.development.local` (local-only admin credentials)

```env
FIREBASE_ADMIN_SERVICE_ACCOUNT_PATH=C:\path\to\service-account.json
GOOGLE_APPLICATION_CREDENTIALS=C:\path\to\service-account.json
```

Do not put local credential paths in `.env.local` or `.env`.
They can break deployed SSR and cause `502/504` errors.

## 4) Deploy converter service (LibreOffice in Cloud Run)

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

Verify converter:

```bash
curl https://converter-<hash>.asia-southeast1.run.app/health
```

Expected: HTTP `200` and JSON health response.

## 5) Confirm Firebase rewrite

In `firebase.json`, keep:

```json
{
  "source": "/api/convert/**",
  "run": {
    "serviceId": "converter",
    "region": "asia-southeast1"
  }
}
```

Service name and region must match deployed Cloud Run converter.

## 6) Deploy web app (Hosting + SSR)

From project root:

```bash
firebase deploy --only hosting
```

For this project, this also updates the frameworks backend service (`ssrsabanganapp`).

## 7) Post-deploy checks

Check these endpoints:

- `https://<your-site>.web.app/api/health` -> `200`
- `https://<your-site>.web.app/api/export/clearance-template` -> `200`
- `https://<your-site>.web.app/templates/Sworn_Declaration_of_Gross_receipt.docx` -> `200`

Then test from UI:

1. Open a client record.
2. Trigger application preview / DOCX->PDF export.
3. Confirm PDF is returned without `502/500`.

## 8) How document templates are handled

Templates used by export routes:

- `templates/2025_new_business_form_template_with_tags_v2.docx`
- `templates/Sworn_Statement_of_Capital.docx`
- `templates/Sworn_Declaration_of_Gross_receipt.docx`
- `templates/2026 Mayor's Clearance.xlsx`

Runtime loader behavior:

1. Try local filesystem template path.
2. If missing, fallback to hosted static file under `public/templates/...`.

This avoids production `Template file not found on server` errors.

## 9) Troubleshooting

### `502 Bad Gateway` on `/api/export/docx-to-pdf`

- Usually upstream timeout/error in SSR route.
- Check logs:

```bash
gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=ssrsabanganapp" --project YOUR_PROJECT_ID --limit 50 --freshness=30m
```

### `500 Template file not found on server`

- Confirm `public/templates/*` files exist and redeploy.
- Confirm `GET /api/export/clearance-template` returns `200`.

### Converter unreachable

- Confirm `CONVERTER_SERVICE_URL` is correct in `.env` and `.env.local`.
- Confirm converter health endpoint returns `200`.

### `401 Missing or invalid Authorization header`

- Export routes require Firebase user token in production.
- Ensure user is authenticated in app before clicking preview/export.
