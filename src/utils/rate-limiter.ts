import { redisRateLimit, isRedisAvailable } from "./redis";

export class RateLimiter {
  private store: Map<string, { count: number; resetTime: number }> = new Map();
  
  constructor(private windowMs: number, private maxRequests: number) {
    // Cleanup stale entries every 5 minutes
    setInterval(() => this.cleanup(), 5 * 60 * 1000);
  }

  /**
   * Check if an IP is rate-limited.
   * Uses Redis if available for persistence across restarts, 
   * otherwise falls back to in-memory Map.
   */
  async isRateLimited(ip: string): Promise<boolean> {
    // Try Redis first
    if (isRedisAvailable()) {
      const result = await redisRateLimit(ip, this.maxRequests, Math.ceil(this.windowMs / 1000));
      if (result !== null) return result.limited;
    }

    // In-memory fallback
    return this.isRateLimitedInMemory(ip);
  }

  private isRateLimitedInMemory(ip: string): boolean {
    const now = Date.now();
    let record = this.store.get(ip);

    if (!record || now > record.resetTime) {
      this.store.set(ip, { count: 1, resetTime: now + this.windowMs });
      return false;
    }

    if (record.count >= this.maxRequests) {
      return true;
    }

    record.count++;
    return false;
  }

  private cleanup() {
    const now = Date.now();
    for (const [ip, record] of this.store.entries()) {
      if (now > record.resetTime) {
        this.store.delete(ip);
      }
    }
  }
}
