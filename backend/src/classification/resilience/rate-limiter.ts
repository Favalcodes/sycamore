/**
 * Token bucket that keeps us inside the provider's request quota
 * (Gemini's free tier allows only a handful of requests per minute).
 * Exceeding it would only produce 429s, so we pace ourselves instead.
 */
export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private pausedUntil = 0;

  constructor(
    private readonly capacity: number,
    private readonly refillPerMs: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.lastRefill = now();
  }

  static perMinute(requests: number, now?: () => number): RateLimiter {
    return new RateLimiter(requests, requests / 60_000, now);
  }

  tryTake(): boolean {
    this.refill();
    if (this.now() < this.pausedUntil || this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  /** After a 429, stop sending until the provider's suggested time. */
  pause(ms: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + ms);
    this.tokens = 0;
  }

  /** Milliseconds until the next request could be sent. */
  waitMs(): number {
    this.refill();
    const pause = Math.max(0, this.pausedUntil - this.now());
    const refill =
      this.tokens >= 1 ? 0 : Math.ceil((1 - this.tokens) / this.refillPerMs);
    return Math.max(pause, refill);
  }

  private refill(): void {
    const now = this.now();
    this.tokens = Math.min(
      this.capacity,
      this.tokens + (now - this.lastRefill) * this.refillPerMs,
    );
    this.lastRefill = now;
  }
}
