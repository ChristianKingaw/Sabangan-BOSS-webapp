import React from "react"
import Header from "@/components/header"
import LoginForm from "./login/LoginForm"

export default function MhoPage() {
  return (
    <div className="min-h-screen bg-background flex flex-col">
      <Header tall />

      <main className="flex-1 flex items-center justify-center px-4">
        <div className="w-full max-w-md">
          <div className="bg-white/60 backdrop-blur-sm border border-border rounded-2xl p-8 shadow-lg">
            <h1 className="text-3xl font-extrabold mb-2 text-center">MHO Sign in</h1>
            <p className="text-sm text-muted-foreground mb-6 text-center">
              Sign in with your Municipal Health Office account to manage sanitary permits.
            </p>
            <LoginForm />
          </div>
        </div>
      </main>
    </div>
  )
}
