"use client"

import React from "react"
import Link from "next/link"
import MhoShell from "@/components/mho-shell"

export default function MhoHomePage() {
  return (
    <MhoShell
      activeNav="dashboard"
      title="MHO Dashboard"
      description="Quick actions for sanitary permits and health office records."
    >
      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-900">Client Applications</h2>
          <p className="mt-2 text-sm text-slate-600">
            View business applications and generate sanitary permits for clients who have paid their sanitary inspection fees.
          </p>
          <Link
            href="/mho/clients"
            className="mt-4 inline-flex items-center rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            Open Clients
          </Link>
        </div>
      </div>
    </MhoShell>
  )
}
