import { NextRequest, NextResponse } from "next/server"
import { loadTemplateBuffer } from "@/lib/docx/loadTemplateBuffer"
import { getRequestPublicOrigin } from "@/lib/http/getRequestPublicOrigin"

// Template lives in the repository's templates directory.
const TEMPLATE_PATH = "templates/2026 Mayor's Clearance.xlsx"

// Use the Node.js runtime so we can read from the filesystem.
export const runtime = "nodejs"

export const dynamic = "force-dynamic"
export const revalidate = 0

export async function GET(request: NextRequest) {
  try {
    const publicOrigin = getRequestPublicOrigin(request)
    const buffer = await loadTemplateBuffer(TEMPLATE_PATH, publicOrigin)

    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": "attachment; filename=\"2026 Mayor's Clearance.xlsx\"",
        "Cache-Control": "public, max-age=86400",
      },
    })
  } catch (err) {
    console.error("Failed to serve Mayor's Clearance template", err)
    return NextResponse.json({ error: "Template file not found on server" }, { status: 500 })
  }
}
