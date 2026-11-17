import { CircuitBreaker } from './circuit-breaker.js';
import { RateLimiter } from './rate-limiter.js';

describe('CircuitBreaker', () => {
  let now = 0;
  const clock = () => now;
  beforeEach(() => {
    now = 0;
  });

  it('opens after N consecutive failures and refuses calls while open', () => {
    const breaker = new CircuitBreaker(3, 10_000, clock);
    for (let i = 0; i < 3; i++) {
      expect(breaker.tryAcquire()).toBe(true);
      breaker.onFailure();
    }
    expect(breaker.snapshot().state).toBe('OPEN');
    expect(breaker.tryAcquire()).toBe(false);
    expect(breaker.retryAfterMs()).toBe(10_000);
  });

  it('a success resets the failure count', () => {
    const breaker = new CircuitBreaker(3, 10_000, clock);
    breaker.onFailure();
    breaker.onFailure();
    breaker.onSuccess();
    breaker.onFailure();
    expect(breaker.tryAcquire()).toBe(true);
  });

  it('lets exactly one probe through after the open period, then closes on success', () => {
    const breaker = new CircuitBreaker(1, 10_000, clock);
    breaker.onFailure();
    now = 10_000;
    expect(breaker.tryAcquire()).toBe(true); // the probe
    expect(breaker.tryAcquire()).toBe(false); // no second probe concurrently
    breaker.onSuccess();
    expect(breaker.snapshot().state).toBe('CLOSED');
    expect(breaker.tryAcquire()).toBe(true);
  });

  it('re-opens if the probe fails', () => {
    const breaker = new CircuitBreaker(5, 10_000, clock);
    for (let i = 0; i < 5; i++) breaker.onFailure();
    now = 10_000;
    expect(breaker.tryAcquire()).toBe(true);
    breaker.onFailure();
    expect(breaker.tryAcquire()).toBe(false);
    expect(breaker.retryAfterMs()).toBe(10_000);
  });

  it('openFor() honours a provider-specified wait', () => {
    const breaker = new CircuitBreaker(5, 60_000, clock);
    breaker.openFor(5_000);
    expect(breaker.retryAfterMs()).toBe(5_000);
  });
});

describe('RateLimiter', () => {
  let now = 0;
  const clock = () => now;
  beforeEach(() => {
    now = 0;
  });

  it('allows a burst up to capacity then refills over time', () => {
    const limiter = RateLimiter.perMinute(2, clock);
    expect(limiter.tryTake()).toBe(true);
    expect(limiter.tryTake()).toBe(true);
    expect(limiter.tryTake()).toBe(false);
    expect(limiter.waitMs()).toBe(30_000);
    now = 30_000;
    expect(limiter.tryTake()).toBe(true);
  });

  it('pause() stops all requests until the given time (after a 429)', () => {
    const limiter = RateLimiter.perMinute(100, clock);
    limiter.pause(20_000);
    expect(limiter.tryTake()).toBe(false);
    expect(limiter.waitMs()).toBe(20_000);
    now = 20_000;
    expect(limiter.tryTake()).toBe(true);
  });
});
