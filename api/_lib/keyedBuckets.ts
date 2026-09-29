import { SlidingWindowBucket, realClock, type Clock } from "./appleBucket";

/**
 * One sliding-window bucket per key (round-3 audit, search-api-css-4 and
 * security-10): per show for outbound feed fetches, per client IP in front of
 * the shared Apple buckets. The number of keys is capped, oldest first, so the
 * limiter cannot itself become the unbounded memory it exists to prevent.
 *
 * Per warm instance, like every cache and bucket in this directory: Vercel may
 * run several instances, and a cold start begins empty. This bounds what ONE
 * caller can make ONE instance do. It is not a global rate.
 */
export class KeyedBuckets {
  private readonly capacity: number;
  private readonly windowMs: number;
  private readonly clock: Clock;
  private readonly maxKeys: number;
  private buckets = new Map<string, SlidingWindowBucket>();

  constructor(capacity: number, windowMs: number, clock: Clock = realClock, maxKeys = 2000) {
    this.capacity = capacity;
    this.windowMs = windowMs;
    this.clock = clock;
    this.maxKeys = Math.max(1, Math.floor(maxKeys));
  }

  tryConsume(key: string): boolean {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      while (this.buckets.size >= this.maxKeys) {
        this.buckets.delete(this.buckets.keys().next().value as string);
      }
      bucket = new SlidingWindowBucket(this.capacity, this.windowMs, this.clock);
      this.buckets.set(key, bucket);
    }
    return bucket.tryConsume();
  }

  /** Test-only observability. */
  size(): number {
    return this.buckets.size;
  }

  /** Test-only: module-scope buckets outlive a single test. */
  clear(): void {
    this.buckets.clear();
  }
}
