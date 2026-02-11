import { NextResponse } from "next/server"

export async function GET() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "cache-control": "no-store, no-cache, must-revalidate",
      "x-connection-check": "true",
    },
  })
}
