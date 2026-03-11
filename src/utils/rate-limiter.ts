export class RateLimiter {
  private store: Map<string, { count: number; resetTime: number }> = new Map();
  
  constructor(private windowMs: number, private maxRequests: number) {
    // Cleanup stale entries every 5 minutes
    setInterval(() => this.cleanup(), 5 * 60 * 1000);
  }

  isRateLimited(ip: string): boolean {
    const now = Date.now();
    let record = this.store.get(ip);

    // Initial or expired record
    if (!record || now > record.resetTime) {
      this.store.set(ip, { count: 1, resetTime: now + this.windowMs });
      return false;
    }

    // Existing record within window
    if (record.count >= this.maxRequests) {
      return true; // Rate limited!
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
