import { readFile } from 'fs/promises'
import path from 'path'
import { NextResponse } from 'next/server'

export const dynamic = "force-static"

export async function GET() {
  try {
    const p = path.resolve(process.cwd(), 'database', 'data', 'data.json')
    const content = await readFile(p, 'utf8')
    const json = JSON.parse(content)
    // prefer mobileApp then mobileapp
    const usersNode = json?.users?.mobileApp ?? json?.users?.mobileapp ?? json?.users?.['mobile-app'] ?? null
    return NextResponse.json({ users: usersNode })
  } catch (err) {
    return NextResponse.json({ users: null, error: String(err) }, { status: 500 })
  }
}
