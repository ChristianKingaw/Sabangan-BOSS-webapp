import { NextRequest } from "next/server"

export function getRequestPublicOrigin(request: NextRequest): string {
  const forwardedHost = request.headers.get("x-forwarded-host")
  const host = forwardedHost || request.headers.get("host")
  const forwardedProto = request.headers.get("x-forwarded-proto")

  if (host) {
    const isLocalHost = host.startsWith("localhost") || host.startsWith("127.0.0.1")
    const protocol = forwardedProto || (isLocalHost ? "http" : "https")
    return `${protocol}://${host}`
  }

  return request.nextUrl.origin
}
