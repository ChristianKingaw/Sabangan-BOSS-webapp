import { NextResponse } from "next/server"

export const runtime = "nodejs"

/**
 * Simple server-side proxy to fetch files (e.g. Firebase Storage) so the browser
 * doesn't run into CORS restrictions. Restrict allowed hosts to avoid open proxy abuse.
 */
export async function GET(req: Request) {
  try {
    const url = req instanceof Request ? new URL(req.url).searchParams.get("url") : null
    if (!url) {
      return NextResponse.json({ error: "Missing url parameter" }, { status: 400 })
    }

    // Only allow Firebase Storage (and data:) by default. Adjust as needed.
    const allowedHost = ["firebasestorage.googleapis.com"]
    const parsed = new URL(url)
    if (!allowedHost.includes(parsed.hostname)) {
      return NextResponse.json({ error: "Host not allowed" }, { status: 403 })
    }

    const resp = await fetch(url)
    if (!resp.ok) {
      return NextResponse.json({ error: "Upstream fetch failed" }, { status: resp.status })
    }

    const buffer = await resp.arrayBuffer()
    const headers = new Headers()
    const contentType = resp.headers.get("content-type") || "application/octet-stream"
    headers.set("Content-Type", contentType)
    // Allow the app to fetch this resource from browser
    headers.set("Access-Control-Allow-Origin", "*")

    return new NextResponse(new Uint8Array(buffer), { status: 200, headers })
  } catch (err) {
    console.error("Proxy error:", err)
    return NextResponse.json({ error: "Server error" }, { status: 500 })
  }
}
