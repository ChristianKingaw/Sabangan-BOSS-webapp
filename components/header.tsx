"use client"

import Image from "next/image"
import { Button } from "@/components/ui/button"
import { LogOut, ArrowLeft } from "lucide-react"

type HeaderProps = {
  title?: string
  showLogout?: boolean
  onLogout?: () => void
  showBack?: boolean
  onBack?: () => void
  tall?: boolean
}

export default function Header({ title, showLogout, onLogout, showBack, onBack, tall }: HeaderProps) {
  const logoSize = tall ? 64 : 44
  const titleClass = tall ? "font-semibold text-2xl text-primary-foreground" : "font-semibold text-lg text-primary-foreground"

  return (
    <header className="sticky top-0 z-40 w-full border-b border-border bg-primary backdrop-blur-sm">
      <div className={`container mx-auto px-4 ${tall ? "py-8" : "py-3"} flex items-center justify-between`}>
        <div className="flex items-center gap-4">
          <Image
            src="/images/official-seal.png"
            alt="Municipality of Sabangan Official Seal"
            width={logoSize}
            height={logoSize}
            className="rounded-full"
          />
          <div className="flex flex-col">
            <span className={titleClass} style={{ fontFamily: "Algerian, serif" }}>MUNICIPALITY OF SABANGAN</span>
            {title && <span className="text-xs text-muted-foreground -mt-1">{title}</span>}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {showBack && (
            <Button variant="outline" className="bg-white text-primary hover:bg-gray-100" onClick={onBack}>
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back
            </Button>
          )}

          {showLogout && (
            <Button variant="outline" className="bg-white text-primary hover:bg-gray-100" onClick={onLogout}>
              <LogOut className="h-4 w-4 mr-2" />
              Logout
            </Button>
          )}
        </div>
      </div>
    </header>
  )
}
