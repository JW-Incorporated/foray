/**
 * Server-side token bucket for `api/episodes/search.ts`'s Apple fallback
 * (S-07, kanban t_6baccaa0). Caps calls to `itunes.apple.com/search` at
 * <=20/min, shared across every query this warm function instance handles.
 *
 * HONEST LIMITATION (see design note on t_6baccaa0): Vercel serverless
 * functions are not guaranteed to be one long-lived process — a cold start
 * gets a fresh bucket, and concurrent warm instances each get their own.
 * This is therefore a best-effort per-instance ceiling, not a hard global
 * cap across the whole deployment. A true global cap needs shared state
 * (Redis/KV) which is new infra out of this card's scope. Documented here
 * rather than silently overclaiming "the bucket never exceeds 20/min"
 * globally — the acceptance criterion is about ONE instance under a
 * synthetic burst, which this satisfies exactly.
 *
 * Sliding-window log rather than a classic leaky/token-bucket refill timer:
 * simpler to reason about and to test with a fake clock (no interval timers
 * to fake), and the two are equivalent for a fixed-rate cap like this one.
 */

export interface Clock {
  now(): number;
}

export const realClock: Clock = { now: () => Date.now() };

export class SlidingWindowBucket {
  private readonly capacity: number;
  private readonly windowMs: number;
  private readonly clock: Clock;
  private timestamps: number[] = [];

  constructor(capacity: number, windowMs: number, clock: Clock = realClock) {
    this.capacity = capacity;
    this.windowMs = windowMs;
    this.clock = clock;
  }

  /** Drops timestamps older than the window, in place. */
  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    let i = 0;
    while (i < this.timestamps.length && this.timestamps[i] <= cutoff) i++;
    if (i > 0) this.timestamps = this.timestamps.slice(i);
  }

  /**
   * Attempts to consume one slot. Returns true and records the call if
   * under capacity within the trailing window; returns false (and records
   * nothing) if the bucket is full — the caller never overshoots by
   * allowing a call it then can't fit.
   */
  tryConsume(): boolean {
    const now = this.clock.now();
    this.prune(now);
    if (this.timestamps.length >= this.capacity) return false;
    this.timestamps.push(now);
    return true;
  }

  /** Current count within the trailing window, for tests/observability. */
  currentCount(): number {
    this.prune(this.clock.now());
    return this.timestamps.length;
  }
}

export const APPLE_BUCKET_CAPACITY = 20;
export const APPLE_BUCKET_WINDOW_MS = 60_000;

/** Module-level singleton — shared across every request this warm instance handles. */
export const appleSearchBucket = new SlidingWindowBucket(APPLE_BUCKET_CAPACITY, APPLE_BUCKET_WINDOW_MS);
