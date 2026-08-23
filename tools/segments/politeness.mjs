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

/** THE CONTACT ADDRESS, written once. Three of the four User-Agents below carry
    it — `NIGHTLY_UA` has never had one, see its note — and it is the entire
    reason a publisher who dislikes us can write to us instead of silently
    blocking us. Which makes an address that is merely COPIED into three
    User-Agents a liability: it was already wrong in one of them. `tools/corpus/`
    shipped `sffan15@gmail.com`, an address that appears nowhere else in this
    repository except CLAUDE.md's note that `sffan15-sys` is a personal,
    separate-quota AWS account — an infrastructure login, not a contact. Every
    other contact address in this repository is this one. Ruled stale and folded
    onto this constant; see the PR body. */
export const CONTACT = "wjduvall@gmail.com";

/** Named by two of the four User-Agents below. */
export const REPO_URL = "https://github.com/JW-Incorporated/foray";

/** THE CLIENT. Feeds, transcripts, and anything else fetched on behalf of a
    listener. Honest, with a contact address.

    ONE DEFINITION, TEN DECLARATIONS REMOVED. This string was spelled out ten
    separate times — here, `tools/refresh/{scan,backfill-show,backfill-audio}.mjs`,
    `tools/classify/prepare-batch.mjs`, `tools/transcribe/fetch-audio.mjs`,
    `tools/harvest-{catalog,episodes}.mjs`, `tools/refresh-feeds.mjs` and
    `backend/src/config/env.ts` — and an eleventh site, `tools/refresh/dai.mjs`,
    had already drifted to a bare `Foray/0.1` with no way to reach us at all. The
    backend one is still where it was: `backend/src/` is a DENIED path in
    `tools/ci/path-policy.mjs` and a separately built service, so it is pinned to
    this constant by a test rather than made to import it. Publishers block on
    this string;
    #316 measured a Buzzsprout edge answering 403 to a copy carrying one extra
    product token and 206 to this one, which silently made 423 transcripts
    unmeasurable. So: one definition, and a scan in `politeness.test.mjs` that
    fails when a tracked file under `tools/` spells a User-Agent out for itself.

    It says Foray rather than 4a deliberately: it is the name every request from
    this repo has carried, and a User-Agent that changes is a new client to a
    rate limiter. #302 renamed the app and left this alone on purpose. */
export const UA = `Foray/0.1 (personal podcast client; contact ${CONTACT})`;

/** The AUDIO fetcher, for requests against an enclosure rather than a feed or
    a transcript. Two tools make those -- `tools/foray/verify-source-audio.mjs`
    and `tools/transcribe/ad-inflation.mjs` -- and it lives here for the same
    reason the gate does: there were THREE copies of this string and the third
    one was silently blocked.

    MEASURED 2026-08-23, five requests to one Buzzsprout enclosure, alternating,
    reproducible in both directions:

      ForayBot/0.1 (+https://github.com/...)                     206
      ForayBot/0.1 (ad-inflation scan; +https://github.com/...)  403
      Foray/0.1 (personal podcast client; ...)                   206

    The only difference is the extra `ad-inflation scan;` product token that
    `ad-inflation.mjs` had drifted into its private copy, and Buzzsprout's edge
    refuses it. Nothing announced this: a 403 has no body worth measuring, so
    the scan simply reported "could not tell" for every Buzzsprout show -- which
    is 423 timed transcripts, including the 337 of Being an Engineer that are
    already being anchored on the strength of an earlier measurement.

    So: do not add a product token, a mode name, or a run id to this string. The
    contact address and the repo URL are the honest part and they are enough. */
export const AUDIO_UA = `ForayBot/0.1 (+${REPO_URL}; ${CONTACT})`;

/** THE RESEARCH CORPUS fetcher (`tools/corpus/fetcher.mjs`). A DELIBERATELY
    DISTINCT TOKEN, kept distinct: it reads court PDFs and articles once each,
    obeys robots.txt, and is selected out of a robots file by the bare token
    `ForayCorpusBot` (`AGENT_TOKEN` in that module, which must keep matching the
    product token here). A publisher who wants to allow the corpus and refuse the
    client — or the reverse — can only express that if the tokens differ, and a
    research crawler honestly announcing itself as a research crawler is the
    politeness this project claims. Distinct ACTIVITY, distinct token.

    Its CONTACT ADDRESS was distinct too, and that part was simply a mistake; see
    CONTACT above. Nothing keys on the address — robots matching uses the token
    alone, and #316's 403 was a product token, not a comment field — so this is
    the safe half of the string to correct and the half that has to be right. */
export const CORPUS_UA = `ForayCorpusBot/1.0 (+${REPO_URL}; internal research corpus, one-shot fetches; contact: ${CONTACT})`;

/** Apple's public lookup API only — `itunes.apple.com/lookup` — never a
    publisher's host. Two copies of it existed, in `tools/refresh/resolve.mjs` and
    `tools/refresh/backfill-audio.mjs`; this is now the only one.

    BYTES DELIBERATELY UNCHANGED, and it CARRIES NO CONTACT ADDRESS. That is the
    same defect this change fixed in `dai.mjs`, and the two are not the same call.
    `dai.mjs` sent a TRUNCATION of UA — same product token, same version, contact
    field lopped off — to publisher hosts, which is unambiguously drift and was
    repaired. This is a distinct token aimed at one first-party API, so changing
    what it says is a decision about identity rather than a repair, and it is left
    for a founder rather than made silently here.

    The evidence that nobody chose it deliberately, recorded for whoever decides:
    `tools/harvest-catalog.mjs` calls THE SAME Apple endpoint under `UA`. Two
    identities for one endpoint is not a policy. */
export const NIGHTLY_UA = "foray-nightly/1.0";

/** Node's fetch sends `accept-language: *` by default, and Captivate's edge
    answers THAT with `404 Missing redirect URL` on every one of its
    `episodes.captivate.fm/episode/<guid>.mp3` redirectors. curl sends no
    Accept-Language and gets the 302 -- which is exactly the "it worked when I
    checked it by hand" that cost an afternoon in #226. The header cannot be
    deleted through fetch, so it is overwritten with a real language tag.
    Verified 2026-08-16 by `tools/foray/verify-source-audio.mjs`: `*` -> 404,
    `en` -> 302. Re-verified 2026-08-23 by the ad-inflation scan, which had no
    Accept-Language at all and drew 404 on every Captivate enclosure. */
export const ACCEPT_LANGUAGE = "en";

/** The complete way this project asks an audio host for two bytes.

    Both facts above are invisible in the response: a 403 and a 404 each arrive
    with no length to measure, so a probe missing either header does not crash
    -- it quietly reports "could not tell" and the operator blames the host. One
    definition, both fetchers, so a fix found by one is a fix the other has. */
export const AUDIO_PROBE_HEADERS = Object.freeze({
  range: "bytes=0-1",
  "user-agent": AUDIO_UA,
  "accept-language": ACCEPT_LANGUAGE,
});

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
