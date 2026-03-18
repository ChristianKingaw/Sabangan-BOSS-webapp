# eBOSS Sabangan

<p align="center">
  <strong>LGU Business One Stop Shop Platform</strong><br/>
  Business Applications, Mayor's Clearance, Treasury, and LGU Status in one system.
</p>

<p align="center">
  <img alt="Next.js" src="https://img.shields.io/badge/Next.js-15-black?logo=nextdotjs" />
  <img alt="React" src="https://img.shields.io/badge/React-18-149eca?logo=react" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5-3178c6?logo=typescript&logoColor=white" />
  <img alt="Firebase" src="https://img.shields.io/badge/Firebase-Realtime%20DB%20%2B%20Auth-f57c00?logo=firebase&logoColor=white" />
  <img alt="Tailwind" src="https://img.shields.io/badge/TailwindCSS-3-0ea5e9?logo=tailwindcss&logoColor=white" />
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> ·
  <a href="#screenshots">Screenshots</a> ·
  <a href="#project-layout">Project Layout</a> ·
  <a href="docs/PROJECT_DOCUMENTATION.md">Technical Docs</a>
</p>

> [!TIP]
> Looking for maintainer-level details? Open [docs/PROJECT_DOCUMENTATION.md](docs/PROJECT_DOCUMENTATION.md).

## Table of Contents

- [At A Glance](#at-a-glance)
- [What This System Covers](#what-this-system-covers)
- [Screenshots](#screenshots)
- [Stack](#stack)
- [Quick Start](#quick-start)
- [Environment Variables](#environment-variables)
- [Converter Service (DOCX to PDF)](#converter-service-docx-to-pdf)
- [Run and Deploy](#run-and-deploy)
- [Project Layout](#project-layout)
- [Troubleshooting](#troubleshooting)

## At A Glance

- Unified staff workspace for business permits, clearance processing, treasury, and status board operations.
- Document-heavy workflow support: DOCX generation, PDF conversion, and printable exports.
- Firebase-centered architecture with Next.js App Router APIs.
- Production path includes Firebase Hosting + Cloud Run converter service.

## What This System Covers

### Staff Portal (`/`)

- Staff sign-in with Firebase Auth and verification checks.
- Business application review with filtering, status updates, and requirement validation.
- Requirement review workspace at `/client/[id]` with document approvals/rejections.
- Document workflows for DOCX preview, PDF conversion, merged output, and printing.
- Built-in messenger for staff-client communication.

### Mayor's Clearance Workflow

- Clearance application and barangay requirement review.
- Approval/rejection with reason tracking.
- Yearly/monthly records generation and export-ready data support.

### LGU Status Board (`/lgu-status`)

- Public office open/closed status and advisory notes.
- Mayor availability and expected return tracking.
- Featured event and upcoming events management.

### Additional Portals

- `/admin`: user management and business application cleanup tools.
- `/treasury`: fee assessment, Cedula/OR handling, and client transaction processing.

## Screenshots

| Staff Login | Treasury Login |
|---|---|
| ![BOSS Staff Login](docs/screenshots/boss-signin.png) | ![Treasury Login](docs/screenshots/treasury-signin.png) |

## Stack

| Layer | Tech |
|---|---|
| Frontend | Next.js 15, React 18, TypeScript |
| UI | Tailwind CSS, Radix UI, lucide-react |
| API | Next.js Route Handlers (`app/api/*`) |
| Data/Auth | Firebase Realtime Database, Firebase Auth |
| Server Admin SDK | firebase-admin |
| Documents | docxtemplater, pizzip, pdf-lib, exceljs, docx-preview |
| Converter | Express + LibreOffice (`cloud-run-converter`) |
| Cache (optional) | Redis / Upstash-compatible URL |

## Quick Start

### Prerequisites

- Node.js 22.x
- npm (or pnpm)
- Docker Desktop (for local converter)
- Firebase CLI (`firebase-tools`)
- Google Cloud SDK (`gcloud`) for Cloud Run deployment

### Install

```bash
# root app
npm install

# converter service
cd cloud-run-converter
npm install
cd ..
```

### Firebase CLI setup

```bash
firebase login
firebase use --add
gcloud auth login
gcloud config set project YOUR_PROJECT_ID
```

## Environment Variables

Create `.env.local` in the project root:

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

# Optional cache
REDIS_URL=redis://user:password@host:6379
PREVIEW_FORM_CACHE_TTL_SECONDS=600
PREVIEW_FORM_CACHE_VERSION=1
```

Optional local admin SDK credentials (`.env.development.local`):

```env
FIREBASE_ADMIN_SERVICE_ACCOUNT_PATH=C:\path\to\service-account.json
GOOGLE_APPLICATION_CREDENTIALS=C:\path\to\service-account.json
```

Production-safe deployment `.env` sample:

```env
CONVERTER_SERVICE_URL=https://converter-<hash>.asia-southeast1.run.app/convert/docx-to-pdf
```

## Converter Service (DOCX to PDF)

The converter is a separate service under `cloud-run-converter`.

Exposed endpoints:

- `GET /health`
- `POST /convert/docx-to-pdf`
- `POST /convert/image-to-pdf`
- `POST /convert/images-to-pdf`

Local Docker run:

```bash
cd cloud-run-converter
docker build -t eboss-converter .
docker run --rm -p 8080:8080 --name eboss-converter eboss-converter
```

Health check:

```bash
curl http://127.0.0.1:8080/health
```

## Run and Deploy

### Local development

```bash
npm run dev
```

Open:

- `http://localhost:3000`
- `http://localhost:3000/lgu-status`
- `http://localhost:3000/admin`
- `http://localhost:3000/treasury`

### Production build

```bash
npm run build
npm run start
```

### Firebase Hosting deploy

```bash
firebase deploy --only hosting
```

## GitHub Repository Guide

Browse these first if you are reviewing the project on GitHub:

- [README.md](README.md): onboarding and high-level overview
- [docs/PROJECT_DOCUMENTATION.md](docs/PROJECT_DOCUMENTATION.md): architecture, API map, and operations
- [app](app): pages and API route handlers
- [components](components): shared UI and reusable components
- [database](database): Firebase data helpers
- [lib](lib): utilities and integration modules
- [cloud-run-converter](cloud-run-converter): DOCX/PDF conversion service
- [public/templates](public/templates): document templates

## Project Layout

```text
app/                    # Next.js App Router pages and API route handlers
components/             # Shared React components and UI primitives
database/               # Firebase Realtime Database data access helpers
lib/                    # Server/client utility modules and integrations
cloud-run-converter/    # LibreOffice conversion microservice
docs/screenshots/       # UI screenshots used in documentation
public/templates/       # Document templates and static files
```

## Troubleshooting

- DOCX to PDF returns 500/502:
  - Verify converter health endpoint is reachable.
  - Verify `CONVERTER_SERVICE_URL` is valid.
- Firebase Admin initialization errors:
  - Set `FIREBASE_ADMIN_SERVICE_ACCOUNT_PATH` or `FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON`.
- Missing database URL:
  - Set `NEXT_PUBLIC_FIREBASE_DATABASE_URL`.

---

For full architecture, API inventory, and maintenance runbook, see [docs/PROJECT_DOCUMENTATION.md](docs/PROJECT_DOCUMENTATION.md).
