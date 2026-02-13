import { readFile } from 'fs/promises'
import path from 'path'
import { NextResponse } from 'next/server'

export const dynamic = "force-static"

type BusinessEntry = {
  meta?: {
    applicantUid?: string
    applicantName?: string
    businessName?: string
  }
  form?: {
    applicantUid?: string
    businessName?: string
    firstName?: string
    middleName?: string
    middle?: string
    middle_name?: string
    lastName?: string
  }
  [key: string]: unknown
}

export async function GET(request: Request) {
  try {
    const p = path.resolve(process.cwd(), 'database', 'data', 'data.json')
    const content = await readFile(p, 'utf8')
    const json = JSON.parse(content)

    // return the business applications node
    const node = (json?.business?.business_application ?? null) as Record<string, BusinessEntry> | null

    // allow optional query `name` or `uid` to filter results
    const url = new URL(request.url)
    const name = url.searchParams.get('name')
    const uid = url.searchParams.get('uid')

    if (uid && node) {
      const filteredByUid: Record<string, any> = {}
      Object.entries(node).forEach(([id, payload]) => {
        const applicantUid = String(payload?.meta?.applicantUid ?? payload?.form?.applicantUid ?? "").trim()
        if (applicantUid && applicantUid === uid) {
          filteredByUid[id] = payload
        }
      })
      return NextResponse.json({ business: filteredByUid })
    }

    if (name && node) {
      const target = String(name).trim().toLowerCase()
      const filtered: Record<string, any> = {}
      Object.entries(node).forEach(([id, payload]) => {
        const businessName = String(payload?.form?.businessName ?? payload?.meta?.businessName ?? "").trim().toLowerCase()
        const metaApplicant = String(payload?.meta?.applicantName ?? "").trim().toLowerCase()
        const formFirst = String(payload?.form?.firstName ?? "").trim()
        const formMiddle = String(payload?.form?.middleName ?? payload?.form?.middle ?? payload?.form?.middle_name ?? "").trim()
        const formLast = String(payload?.form?.lastName ?? "").trim()
        const formApplicant = [formFirst, formMiddle, formLast].filter(Boolean).join(" ").toLowerCase()

        if (businessName === target || metaApplicant === target || formApplicant === target) {
          filtered[id] = payload
        }
      })
      return NextResponse.json({ business: filtered })
    }

    return NextResponse.json({ business: node })
  } catch (err) {
    return NextResponse.json({ business: null, error: String(err) }, { status: 500 })
  }
}
