/**
 * THE ONE CLOCK every per-instance cache and bucket in this directory reads
 * (code-health-2 CH2-38, A1-09). appleBucket.ts and searchCache.ts each used to
 * declare their own `Clock` and `realClock`, and feedCache.ts handed one
 * module's clock to the other's class: identical today, and one added method
 * away from a clock that satisfies only one of them. Tests pass a manual clock
 * (`{ now: () => t }`); production reads Date.now at each call, so a test that
 * replaces Date.now moves every default clock at once.
 */
export interface Clock {
  now(): number;
}

export const realClock: Clock = { now: () => Date.now() };
