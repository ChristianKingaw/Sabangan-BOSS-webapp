"use client"

import React from "react"
import Link from "next/link"
import TreasuryShell from "@/components/treasury-shell"

export default function TreasuryHomePage() {
  return (
    <TreasuryShell
      activeNav="dashboard"
      title="Treasury Dashboard"
      description="Quick actions for business application records."
    >
      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-900">Client Transactions</h2>
          <p className="mt-2 text-sm text-slate-600">
            Open the Clients page to search submitted applications and save Cedula or Official Receipt numbers.
          </p>
          <Link
            href="/treasury/clients"
            className="mt-4 inline-flex items-center rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800"
          >
            Open Clients
          </Link>
        </div>
      </div>
    </TreasuryShell>
  )
}
