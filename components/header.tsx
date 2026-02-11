"use client"

import Image from "next/image"
import { Button } from "@/components/ui/button"
import { LogOut, ArrowLeft } from "lucide-react"
import { cn } from "@/lib/utils"

type HeaderProps = {
  title?: string
  showLogout?: boolean
  onLogout?: () => void
  showBack?: boolean
  onBack?: () => void
  tall?: boolean
}

export default function Header({ title, showLogout, onLogout, showBack, onBack, tall }: HeaderProps) {
  const isTall = Boolean(tall)
  const logoSize = isTall ? 96 : 56
  const titleClass = isTall ? "font-semibold text-3xl text-white tracking-tight drop-shadow-[0_6px_18px_rgba(0,0,0,0.65)]" : "font-semibold text-lg text-primary-foreground"
  const containerPadding = isTall ? "py-8 md:py-10" : "py-3"
  const actionButtonClass = isTall
    ? "border-[#e67e22]/70 bg-[#e67e22]/20 text-white hover:bg-[#e67e22]/30 shadow-sm"
    : "bg-white text-primary hover:bg-orange-200"

  return (
    <header
      className={cn(
        "sticky top-0 z-40 w-full border-b backdrop-blur-sm",
        isTall
          ? "relative overflow-hidden border-transparent bg-gradient-to-br from-[#276221] via-[#1f5318] to-[#174111] text-white shadow-[0_14px_40px_rgba(0,0,0,0.35)]"
          : "border-border bg-primary text-primary-foreground"
      )}
    >
      {isTall && (
        <>
          <div className="pointer-events-none absolute inset-0 opacity-25">
            <div className="absolute -left-10 -top-12 h-44 w-44 rounded-full bg-[#f7d8b8]/25 blur-3xl" />
            <div className="absolute right-[-4rem] top-[-2rem] h-40 w-40 rounded-full bg-[#e67e22]/45 blur-3xl" />
            <div className="absolute bottom-[-3rem] left-1/3 h-36 w-36 rounded-full bg-[#f7d8b8]/18 blur-3xl" />
          </div>
          <div className="pointer-events-none absolute inset-0 mix-blend-screen opacity-55 bg-[radial-gradient(circle_at_18%_20%,rgba(230,150,90,0.12),transparent_42%),radial-gradient(circle_at_82%_10%,rgba(240,180,120,0.1),transparent_34%)]" />
          <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(135deg,rgba(255,255,255,0.04)_0%,rgba(255,255,255,0.0)_18%,rgba(255,255,255,0.05)_36%,rgba(255,255,255,0.0)_54%,rgba(255,255,255,0.04)_72%,rgba(255,255,255,0.0)_90%)]" />
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[3px] bg-gradient-to-r from-transparent via-[#e67e22] to-transparent" />
        </>
      )}

      <div
        className={cn(
          "w-full px-4 flex items-center",
          // center content when tall, keep space-between otherwise
          !isTall ? "justify-between" : "justify-center",
          containerPadding,
          isTall && "relative"
        )}
      >
        {isTall && (
          <div className="absolute -left-10 top-6 h-16 w-16 rotate-3 rounded-2xl bg-[#e67e22]/12 blur-sm shadow-[0_10px_40px_rgba(0,0,0,0.25)]" />
        )}

        <div className="flex items-center gap-4">
          <div
            className={cn(
              "rounded-full p-1",
              isTall && "border border-[#e67e22]/55 bg-white/8 shadow-lg shadow-black/35"
            )}
          >
            <Image
              src="/images/official-seal.png"
              alt="Municipality of Sabangan Official Seal"
              width={logoSize}
              height={logoSize}
              className={cn("rounded-full", isTall && "ring-2 ring-[#e67e22]/70")}
            />
          </div>
          <div className="flex flex-col gap-1">
            {isTall && (
              <span className="text-[11px] uppercase tracking-[0.35em] text-white/90 drop-shadow-[0_2px_8px_rgba(0,0,0,0.6)]">
                Republic of the Philippines · Cordillera Administrative Region
              </span>
            )}
            <span className={titleClass} style={{ fontFamily: "Algerian, serif" }}>
              MUNICIPALITY OF SABANGAN
            </span>
            {title && <span className={cn("text-xs", isTall ? "text-white/80" : "text-muted-foreground -mt-1")}>{title}</span>}
            {isTall && (
              <div className="flex flex-wrap items-center gap-2 text-[12px] text-white/85">
                <span className="rounded-full border border-[#e67e22] bg-[#e67e22] text-white px-3 py-1 uppercase tracking-[0.08em] backdrop-blur-sm shadow-sm">
                  Staff portal access
                </span>
                <span className="rounded-full border border-[#e67e22] bg-[#e67e22] text-white px-3 py-1 uppercase tracking-[0.08em]">
                  Sabangan, Mountain Province
                </span>
                <span className="rounded-full border border-[#e67e22] bg-[#e67e22] text-white px-3 py-1 uppercase tracking-[0.08em]">
                  Secure government system
                </span>
              </div>
            )}
          </div>
        </div>

        {(showBack || showLogout) && (
          // when tall, position actions absolutely to the right so main content stays centered
          isTall ? (
            <div className="absolute right-4 top-1/2 -translate-y-1/2 flex items-center gap-2">
              {showBack && (
                <Button variant="outline" className={actionButtonClass} onClick={onBack}>
                  <ArrowLeft className="h-4 w-4 mr-2" />
                  Back
                </Button>
              )}

              {showLogout && (
                <Button variant="destructive" className="hover:shadow-lg hover:scale-105 transition-all duration-200" onClick={onLogout}>
                  <LogOut className="h-4 w-4 mr-2" />
                  Logout
                </Button>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-2">
              {showBack && (
                <Button variant="outline" className={actionButtonClass} onClick={onBack}>
                  <ArrowLeft className="h-4 w-4 mr-2" />
                  Back
                </Button>
              )}

              {showLogout && (
                <Button variant="destructive" className="hover:shadow-lg hover:scale-105 transition-all duration-200" onClick={onLogout}>
                  <LogOut className="h-4 w-4 mr-2" />
                  Logout
                </Button>
              )}
            </div>
          )
        )}
      </div>
    </header>
  )
}
