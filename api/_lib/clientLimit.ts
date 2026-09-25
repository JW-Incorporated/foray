import { KeyedBuckets } from "./keyedBuckets";

/**
 * ONE CALLER CANNOT SPEND EVERYONE'S APPLE BUDGET (round-3 audit, security-10).
 *
 * The Apple buckets (20 calls a minute, per warm instance) are shared by every
 * caller, so one script sending unique queries drained the directory and
 * episode search for every listener on that instance. Three guards sit in
 * front of them, on the two paths that spend a slot:
 *   - a per-client bucket keyed on the caller's IP (Vercel's x-forwarded-for),
 *     checked AFTER the answer caches (a cached answer costs nobody anything)
 *     and BEFORE the shared bucket;
 *   - a query length window: under QUERY_MIN_CHARS (after normalising) is not
 *     worth a slot, and over QUERY_MAX_CHARS is refused outright;
 *   - a stronger cache-key normalisation, so trivial variants ("Sleep?",
 *     "  sleep ") share one cached answer instead of each spending a slot.
 *
 * Per warm instance, like the buckets it guards: it slows one abuser on one
 * instance and does not raise the shared ceiling (Apple's own limit is per
 * egress IP). It is not a global rate.
 */
export const QUERY_MIN_CHARS = 2;
export const QUERY_MAX_CHARS = 200;
export const PER_CLIENT_APPLE_CALLS_PER_MINUTE = 8;
export const CLIENT_LIMITED_ERROR = "too many searches from this connection — try again shortly";
export const QUERY_TOO_LONG_ERROR = `q must be at most ${QUERY_MAX_CHARS} characters`;
export const QUERY_TOO_SHORT_ERROR = `q needs at least ${QUERY_MIN_CHARS} letters or digits to search the directory`;

/** Per-client budget for the EPISODE search's Apple calls (api/episodes/search.ts). */
export const appleCallerBuckets = new KeyedBuckets(PER_CLIENT_APPLE_CALLS_PER_MINUTE, 60_000);
/** A SEPARATE per-client budget for the SHOW directory fall-through
    (appleShowSearch). The client asks both endpoints on every query, so one
    shared budget let a single listener spend two slots per query and be
    refused after about four fresh queries a minute, and it undid the
    endpoint separation appleShowSearch.ts's note (3) keeps for the shared
    buckets (round-3 review, L4). Each endpoint now meters its own calls. */
export const appleShowCallerBuckets = new KeyedBuckets(PER_CLIENT_APPLE_CALLS_PER_MINUTE, 60_000);

/** Case, width, punctuation and spacing folded: the text a cache keys on. */
export function normalizeSearchText(q: string): string {
  return String(q ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

type Headers = Record<string, string | string[] | undefined> | undefined;

/** The caller's IP as Vercel reports it (first x-forwarded-for hop), or a
    shared "unknown" bucket when no header says. */
export function clientKey(headers: Headers): string {
  const pick = (name: string): string | null => {
    const v = headers?.[name];
    const s = Array.isArray(v) ? v[0] : v;
    return typeof s === "string" && s.trim() ? s : null;
  };
  const forwarded = pick("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return pick("x-real-ip")?.trim() ?? "unknown";
}
