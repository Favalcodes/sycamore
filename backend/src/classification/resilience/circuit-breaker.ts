export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/**
 * Stops hammering a provider that is down.
 *
 *  CLOSED    — calls flow; consecutive failures are counted.
 *  OPEN      — after `failureThreshold` consecutive failures, calls are refused
 *              for `openMs`; work is deferred rather than burning attempts.
 *  HALF_OPEN — once `openMs` has passed, one probe call is let through. Success
 *              closes the circuit; failure re-opens it.
 *
 * State is per process. With several worker instances each trips on its own,
 * which is acceptable; a shared breaker would live in Redis.
 */
export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private consecutiveFailures = 0;
  private openedAt = 0;
  private probeInFlight = false;

  constructor(
    private readonly failureThreshold: number,
    private readonly openMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Whether a call may proceed now. Claims the single probe slot when half-open. */
  tryAcquire(): boolean {
    if (this.state === 'CLOSED') return true;
    if (this.state === 'OPEN') {
      if (this.now() - this.openedAt < this.openMs) return false;
      this.state = 'HALF_OPEN';
    }
    if (this.probeInFlight) return false;
    this.probeInFlight = true;
    return true;
  }

  onSuccess(): void {
    this.state = 'CLOSED';
    this.consecutiveFailures = 0;
    this.probeInFlight = false;
  }

  onFailure(): void {
    this.probeInFlight = false;
    this.consecutiveFailures += 1;
    if (
      this.state === 'HALF_OPEN' ||
      this.consecutiveFailures >= this.failureThreshold
    ) {
      this.state = 'OPEN';
      this.openedAt = this.now();
    }
  }

  /** Open the circuit immediately for a known period (e.g. provider says "retry in 40s"). */
  openFor(ms: number): void {
    this.state = 'OPEN';
    this.probeInFlight = false;
    this.openedAt = this.now() - this.openMs + ms;
  }

  /** Milliseconds until a probe is allowed (0 when calls may proceed). */
  retryAfterMs(): number {
    if (this.state !== 'OPEN') return 0;
    return Math.max(0, this.openMs - (this.now() - this.openedAt));
  }

  snapshot() {
    return {
      state:
        this.state === 'OPEN' && this.retryAfterMs() === 0
          ? 'HALF_OPEN'
          : this.state,
      consecutiveFailures: this.consecutiveFailures,
      retryAfterMs: this.retryAfterMs(),
    };
  }
}
