import { NextResponse } from "next/server"
import fs from "fs/promises"
import path from "path"

// Template lives in the repository's templates directory.
const TEMPLATE_PATH = path.join(process.cwd(), "templates", "2026 Mayor's Clearance.xlsx")

// Use the Node.js runtime so we can read from the filesystem.
export const runtime = "nodejs"

export async function GET() {
  try {
    const buffer = await fs.readFile(TEMPLATE_PATH)

    return new NextResponse(buffer, {
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
