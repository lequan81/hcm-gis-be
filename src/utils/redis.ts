/**
 * Redis Cache Utility — uses Bun's built-in native Redis client.
 * 
 * Gracefully degrades to no-op if Redis is unavailable or disabled.
 * All cache operations are fire-and-forget safe.
 */

import { RedisClient } from "bun";
import { env } from "../config";
import { log } from "./logger";

const CACHE_PREFIX = "hcm:";

let client: RedisClient | null = null;
let available = false;

/**
 * Initialize the Redis connection. Should be called once at startup.
 */
export async function initRedis(): Promise<boolean> {
  if (!env.REDIS_ENABLED) {
    log("INFO", "Redis caching disabled (REDIS_ENABLED=false)");
    return false;
  }

  try {
    client = new RedisClient(env.REDIS_URL);
    // Test the connection
    await client.set(`${CACHE_PREFIX}healthcheck`, "ok");
    available = true;
    log("INFO", `Redis connected: ${env.REDIS_URL}`);
    return true;
  } catch (err: any) {
    log("WARN", `Redis unavailable (${err?.message}). Using in-memory fallback.`);
    client = null;
    available = false;
    return false;
  }
}

export function isRedisAvailable(): boolean {
  return available;
}

export async function cacheGet(key: string): Promise<string | null> {
  if (!available || !client) return null;
  try {
    return await client.get(`${CACHE_PREFIX}${key}`);
  } catch {
    return null;
  }
}

export async function cacheSet(key: string, value: string, ttlSecs: number = 3600): Promise<void> {
  if (!available || !client) return;
  try {
    const fullKey = `${CACHE_PREFIX}${key}`;
    await client.set(fullKey, value);
    await client.expire(fullKey, ttlSecs);
  } catch { /* Silent fallback */ }
}

export async function cacheDel(key: string): Promise<void> {
  if (!available || !client) return;
  try {
    await client.del(`${CACHE_PREFIX}${key}`);
  } catch { /* Silent fallback */ }
}

/**
 * Redis-backed rate limiter using INCR + EXPIRE.
 * Returns { limited, remaining } or null if Redis is unavailable.
 */
export async function redisRateLimit(
  ip: string,
  limit: number,
  windowSecs: number
): Promise<{ limited: boolean; remaining: number } | null> {
  if (!available || !client) return null;
  try {
    const key = `${CACHE_PREFIX}ratelimit:${ip}`;
    const count = await client.incr(key);
    if (count === 1) {
      await client.expire(key, windowSecs);
    }
    return { limited: count > limit, remaining: Math.max(0, limit - count) };
  } catch {
    return null;
  }
}

/**
 * Gracefully close the Redis connection.
 */
export async function closeRedis(): Promise<void> {
  if (client) {
    try {
      await client.close();
    } catch { /* ignore */ }
    client = null;
    available = false;
    log("INFO", "Redis connection closed");
  }
}
