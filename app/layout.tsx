import type React from "react"
import type { Metadata } from "next"
import { Geist, Geist_Mono } from "next/font/google"
import { NetworkStatus } from "@/components/network-status"
import { Toaster } from "@/components/ui/sonner"
import "./globals.css"

const _geist = Geist({ subsets: ["latin"] })
const _geistMono = Geist_Mono({ subsets: ["latin"] })

export const metadata: Metadata = {
  title: "Business One Stop Shop | Business Registration & Renewal",
  description:
    "Sabangan LGU through the Office of the Municipal Mayor will conduct Business One-Stop Shop (BOSS) to facilitate the renewal and registration of business establishments..",
  generator: "v0.app",
  icons: {
    icon: [
      {
        url: "/images/official-seal.png",
        media: "(prefers-color-scheme: light)",
      },
      {
        url: "/images/official-seal.png",
        media: "(prefers-color-scheme: dark)",
      },
      {
        url: "/images/official-seal.png",
        type: "image/svg+xml",
      },
    ],
    apple: "/images/official-seal.png",
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en">
      {/*
        Some browser extensions inject attributes into the DOM (for example
        `cz-shortcut-listen="true"`), which can cause React hydration
        warnings because the server-rendered HTML doesn't include them. We
        suppress hydration warnings for the body element to avoid noisy logs
        when the mismatch is caused by extensions (safe because body children
        still hydrate normally).
      */}
      <body suppressHydrationWarning className={`font-sans antialiased`}>
          <NetworkStatus />
        {children}
        <Toaster position="top-right" richColors />
      </body>
    </html>
  )
}
