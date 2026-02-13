# Cloud Run Converter Service

A Docker-based service for DOCX/PDF and image conversion using LibreOffice.

## Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/convert/docx-to-pdf` | POST | Convert DOCX to PDF (multipart, field: `file`) |
| `/convert/image-to-pdf` | POST | Convert PNG/JPEG to PDF (multipart, field: `file`) |
| `/convert/images-to-pdf` | POST | Merge multiple images into PDF (multipart, field: `files`) |

## Deployment to Cloud Run

### Prerequisites
- [Google Cloud SDK](https://cloud.google.com/sdk/docs/install) installed
- A Google Cloud project with billing enabled
- Docker installed (optional, for local testing)

### Step 1: Set your project
```bash
gcloud config set project YOUR_PROJECT_ID
```

### Step 2: Enable required APIs
```bash
gcloud services enable cloudbuild.googleapis.com run.googleapis.com
```

### Step 3: Build and deploy
```bash
cd cloud-run-converter

# Build and deploy in one command
gcloud run deploy converter \
  --source . \
  --region asia-southeast1 \
  --platform managed \
  --allow-unauthenticated \
  --memory 1Gi \
  --timeout 300
```

> **Note:** `--allow-unauthenticated` makes the service public. For production, you may want to configure IAM or use Firebase Auth validation in the service.

### Step 4: Deploy Firebase Hosting
After Cloud Run is deployed, deploy Firebase Hosting to activate the rewrite rule:
```bash
firebase deploy --only hosting
```

## How it works

1. Your frontend calls `/api/convert/docx-to-pdf` (same domain)
2. Firebase Hosting rewrites `/api/convert/**` requests to Cloud Run
3. Cloud Run runs LibreOffice headless to convert the file
4. The PDF is returned to the frontend

## Local Testing

```bash
cd cloud-run-converter
npm install
npm start
```

Then test with:
```bash
curl -X POST -F "file=@test.docx" http://localhost:8080/convert/docx-to-pdf -o output.pdf
```

## Updating the service

After making changes, redeploy:
```bash
cd cloud-run-converter
gcloud run deploy converter --source . --region asia-southeast1
```
