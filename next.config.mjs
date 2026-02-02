const rawOrigins = process.env.NEXT_DEV_ORIGINS
  ?.split(",")
  .map(o => o.trim())
  .filter(Boolean)

const defaultOrigins = [
  "http://192.168.43.97:3000",
]

if (process.env.NODE_ENV !== "production") {
  console.log(
    "allowedDevOrigins:",
    rawOrigins?.length ? rawOrigins : defaultOrigins
  )
}

/** @type {import("next").NextConfig} */
const nextConfig = {
  allowedDevOrigins: rawOrigins?.length ? rawOrigins : defaultOrigins,
}

export default nextConfig
