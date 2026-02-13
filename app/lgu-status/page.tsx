import LguStatusClient from "./LguStatusClient"

// Keep this page fully dynamic; render the client component directly.
export const dynamic = "force-dynamic"

export default function LguStatusPage() {
  return <LguStatusClient />
}