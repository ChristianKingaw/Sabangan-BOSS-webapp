import { createClient } from "redis"

type RedisClient = ReturnType<typeof createClient>

type GlobalRedisState = {
  __previewRedisClient?: RedisClient
  __previewRedisClientPromise?: Promise<RedisClient | null>
  __previewRedisUnavailableLogged?: boolean
}

const globalRedisState = globalThis as typeof globalThis & GlobalRedisState

const getRedisUrl = () =>
  process.env.REDIS_URL?.trim() ||
  process.env.UPSTASH_REDIS_URL?.trim() ||
  process.env.KV_URL?.trim() ||
  ""

export async function getRedisClient(): Promise<RedisClient | null> {
  const redisUrl = getRedisUrl()
  if (!redisUrl) {
    return null
  }

  if (globalRedisState.__previewRedisClient?.isOpen) {
    return globalRedisState.__previewRedisClient
  }

  // If a previous client disconnected, clear stale references so we can reconnect.
  if (globalRedisState.__previewRedisClient && !globalRedisState.__previewRedisClient.isOpen) {
    try {
      globalRedisState.__previewRedisClient.destroy()
    } catch {}
    globalRedisState.__previewRedisClient = undefined
    globalRedisState.__previewRedisClientPromise = undefined
  }

  if (!globalRedisState.__previewRedisClientPromise) {
    const client = createClient({
      url: redisUrl,
      socket: {
        keepAlive: true,
        reconnectStrategy: (retries) => Math.min(retries * 200, 5_000),
      },
      pingInterval: 30_000,
    })

    client.on("error", (err) => {
      if (!globalRedisState.__previewRedisUnavailableLogged) {
        globalRedisState.__previewRedisUnavailableLogged = true
        console.warn("Redis client error. Preview cache is temporarily bypassed.", err)
      }
    })
    client.on("ready", () => {
      globalRedisState.__previewRedisUnavailableLogged = false
    })
    client.on("end", () => {
      globalRedisState.__previewRedisClient = undefined
      globalRedisState.__previewRedisClientPromise = undefined
    })

    globalRedisState.__previewRedisClientPromise = client
      .connect()
      .then(() => {
        globalRedisState.__previewRedisUnavailableLogged = false
        globalRedisState.__previewRedisClient = client
        return client
      })
      .catch((err) => {
        if (!globalRedisState.__previewRedisUnavailableLogged) {
          globalRedisState.__previewRedisUnavailableLogged = true
          console.warn("Unable to connect to Redis. Preview cache is bypassed.", err)
        }
        globalRedisState.__previewRedisClientPromise = undefined
        try {
          client.destroy()
        } catch {}
        return null
      })
  }

  return globalRedisState.__previewRedisClientPromise ?? null
}
