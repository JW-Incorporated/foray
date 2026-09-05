// Token bucket unit tests for api/episodes/appleBucket.ts (S-07, kanban
// t_6baccaa0). Acceptance: "the bucket never exceeds 20/min under a
// synthetic burst (fake clock)".
import { test } from "node:test";
import assert from "node:assert";
import { SlidingWindowBucket } from "../episodes/appleBucket.ts";

class FakeClock {
  constructor(t = 0) {
    this.t = t;
  }
  now() {
    return this.t;
  }
  advance(ms) {
    this.t += ms;
  }
}

test("allows exactly `capacity` calls within one window, then refuses the next", () => {
  const clock = new FakeClock(0);
  const bucket = new SlidingWindowBucket(20, 60_000, clock);

  for (let i = 0; i < 20; i++) {
    assert.strictEqual(bucket.tryConsume(), true, `call #${i + 1} should be allowed`);
  }
  // The 21st call in the same instant must be refused — this is the core
  // acceptance criterion: never exceed 20/min under a synthetic burst.
  assert.strictEqual(bucket.tryConsume(), false);
  assert.strictEqual(bucket.currentCount(), 20);
});

test("a burst of 1000 calls in one instant yields exactly 20 successes", () => {
  const clock = new FakeClock(0);
  const bucket = new SlidingWindowBucket(20, 60_000, clock);
  let successes = 0;
  for (let i = 0; i < 1000; i++) {
    if (bucket.tryConsume()) successes++;
  }
  assert.strictEqual(successes, 20);
});

test("refused calls are not recorded — a refusal never later evicts a real slot", () => {
  const clock = new FakeClock(0);
  const bucket = new SlidingWindowBucket(2, 60_000, clock);
  assert.strictEqual(bucket.tryConsume(), true);
  assert.strictEqual(bucket.tryConsume(), true);
  // Ten refused attempts.
  for (let i = 0; i < 10; i++) assert.strictEqual(bucket.tryConsume(), false);
  assert.strictEqual(bucket.currentCount(), 2, "refused attempts must not be recorded as consumed slots");
});

test("capacity frees up once the window slides past the oldest calls", () => {
  const clock = new FakeClock(0);
  const bucket = new SlidingWindowBucket(20, 60_000, clock);
  for (let i = 0; i < 20; i++) assert.strictEqual(bucket.tryConsume(), true);
  assert.strictEqual(bucket.tryConsume(), false);

  // Advance past the window entirely — every old timestamp should be pruned.
  clock.advance(60_001);
  assert.strictEqual(bucket.currentCount(), 0);
  for (let i = 0; i < 20; i++) assert.strictEqual(bucket.tryConsume(), true, `post-window call #${i + 1} should be allowed`);
  assert.strictEqual(bucket.tryConsume(), false);
});

test("a rolling window: calls spaced exactly at the boundary behave correctly (no off-by-one)", () => {
  const clock = new FakeClock(0);
  const bucket = new SlidingWindowBucket(2, 1000, clock);
  assert.strictEqual(bucket.tryConsume(), true); // t=0
  clock.advance(500);
  assert.strictEqual(bucket.tryConsume(), true); // t=500
  clock.advance(400);
  // t=900: both t=0 and t=500 are still within the last 1000ms window.
  assert.strictEqual(bucket.tryConsume(), false);
  clock.advance(101);
  // t=1001: the t=0 call is now outside the window (cutoff=1); one slot frees.
  assert.strictEqual(bucket.tryConsume(), true);
});

test("sustained load at exactly the allowed rate never gets refused", () => {
  // Simulates one call every 3 seconds for 5 minutes (20/min sustained rate)
  // — a caller respecting the limit organically must never be refused.
  const clock = new FakeClock(0);
  const bucket = new SlidingWindowBucket(20, 60_000, clock);
  for (let i = 0; i < 100; i++) {
    assert.strictEqual(bucket.tryConsume(), true, `steady-rate call #${i + 1} should be allowed`);
    clock.advance(3_000);
  }
});
