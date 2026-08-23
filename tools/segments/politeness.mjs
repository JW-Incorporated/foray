/* Politeness — one host gate, shared by everything in this directory that
   makes a request (epic #102).

   WHY THIS EXISTS. `sweep-transcripts.mjs` grew a per-host throttle, and
   `fetch-transcripts.mjs` was written by copying it. Two copies of a policy is
   the failure `tools/ci/path-policy.mjs` was extracted to prevent, and this one
   had already started to drift on arrival: the copy silently dropped the
   sweep's backoff jitter, so four workers taking a 5xx on the same host retried
   in lockstep at exactly 2000ms and then 4000ms. Both copies also carried the
   same two bugs below, which meant fixing either one fixed nothing.

   THE BUG THIS MODULE EXISTS TO FIX: `Retry-After` used to pause one worker.
   The gate map was only ever pushed forward by the worker that took the slot,
   so a 429 carrying `Retry-After: 60` stopped the task that received it while
   its three siblings kept firing at the 1.2s minimum — roughly fifty more
   requests into a host during the exact window it asked for silence. That is
   the behaviour that gets a project blocked, and being blocked costs far more
   than the transcripts a fast sweep would have gained. `holdHost()` moves the
   gate for the WHOLE host, so one 429 quiets every worker.

   `Retry-After: 0` USED TO MEAN NO BACKOFF AT ALL. The old code did
   `retryAfterMs(res) ?? backoff`, and `??` does not fall back from 0 — so a
   literal `0`, or any HTTP-date at or behind our clock (a second of skew is
   enough), produced a zero wait and all three attempts fired back to back.
   `retryAfterMs` now returns null for anything <= 0, so the caller's backoff
   takes over.

   Pure except for `Date.now()` and the sleep, both injectable, so the tests
   below run in milliseconds instead of minutes.                              */

/** Honest, with a contact address. Do not change this without changing it in
    `tools/refresh/` too — publishers who block us will block on this string.
    It says Foray rather than 4a deliberately: it is the name every request from
    this repo has carried, and a User-Agent that changes is a new client to a
    rate limiter. */
export const UA = "Foray/0.1 (personal podcast client; contact wjduvall@gmail.com)";

/** Per host, not global. This catalogue's feeds cluster onto a handful of CDNs,
    so N workers are otherwise N simultaneous hits on one host. */
export const MIN_HOST_INTERVAL_MS = 1200;
export const BASE_BACKOFF_MS = 2000;
/** A host asking for longer than this is telling us to come back another day. */
export const MAX_RETRY_AFTER_MS = 60_000;

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Requests are gated per host; an unparseable URL shares one bucket, which is
    the conservative direction (over-throttle rather than under). */
export function hostKey(url) {
  try {
    return new URL(String(url)).host || "unknown";
  } catch {
    return "unknown";
  }
}

/* Module-level on purpose: the gate is a property of the process talking to a
   host, not of any one caller, which is the whole point of holdHost(). */
const nextAllowedByHost = new Map();

/** Test seam. Never called by the tools — a run that reset its own gates would
    be a run with no throttle. */
export function resetHostGates() {
  nextAllowedByHost.clear();
}

/** Claims the next slot for this URL's host and waits for it.
    Returns the milliseconds waited, so a caller (or a test) can see the gate. */
export async function awaitHostSlot(url, { minIntervalMs = MIN_HOST_INTERVAL_MS, sleep = defaultSleep, now = Date.now } = {}) {
  const host = hostKey(url);
  const t = now();
  const earliest = Math.max(t, nextAllowedByHost.get(host) || 0);
  nextAllowedByHost.set(host, earliest + minIntervalMs);
  const wait = earliest - t;
  if (wait > 0) await sleep(wait);
  return wait;
}

/** Pushes the gate for an ENTIRE host out by `ms`, so every worker waits, not
    just the one that was told to. This is the difference between honouring a
    429 and appearing to. Returns the deadline it set, or 0 for a no-op. */
export function holdHost(url, ms, { now = Date.now } = {}) {
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  const host = hostKey(url);
  const until = now() + ms;
  if (until > (nextAllowedByHost.get(host) || 0)) nextAllowedByHost.set(host, until);
  return until;
}

/** `Retry-After` as milliseconds: delta-seconds or an HTTP-date, capped.
    **Null for anything at or below zero** — see the header. Null means "the
    header told us nothing usable", which is the caller's cue to back off on its
    own schedule rather than not at all. */
export function retryAfterMs(res, { maxMs = MAX_RETRY_AFTER_MS, now = Date.now } = {}) {
  const raw = res?.headers?.get?.("retry-after");
  if (!raw) return null;

  const secs = Number(raw);
  if (Number.isFinite(secs)) {
    const ms = secs * 1000;
    return ms > 0 ? Math.min(ms, maxMs) : null;
  }

  const when = Date.parse(raw);
  if (!Number.isFinite(when)) return null;
  const ms = when - now();
  return ms > 0 ? Math.min(ms, maxMs) : null;
}

/** Exponential backoff with jitter. The jitter is not decoration: without it,
    every worker that took the same 5xx retries at the same millisecond, which
    is a small thundering herd aimed at a host that is already struggling. */
export function backoffMs(attempt, { base = BASE_BACKOFF_MS, jitterMs = 500, random = Math.random } = {}) {
  return base * 2 ** Math.max(0, attempt - 1) + Math.floor(random() * jitterMs);
}

/** The one call a retry loop needs: honour `Retry-After` when the host sent
    something usable, else back off, and either way quiet the whole host. */
export function waitBeforeRetry(url, res, attempt, opts = {}) {
  const asked = res ? retryAfterMs(res, opts) : null;
  const wait = asked ?? backoffMs(attempt, opts);
  holdHost(url, wait, opts);
  return wait;
}
