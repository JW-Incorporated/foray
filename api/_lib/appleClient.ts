import { DEFAULT_FEED_USER_AGENT } from "../../backend/src/feeds/userAgent";

/**
 * THE ONE APPLE SEARCH CLIENT (code-health-2 CH2-39, A1-07).
 *
 * Episode search (`api/episodes/search.ts`, `entity=podcastEpisode`) and the
 * show directory (`api/_lib/appleShowSearch.ts`, `entity=podcast`) each used
 * to hand-roll this call: the same URL constant, the same headers, the same
 * two error strings, and two timeouts justified by comments that contradicted
 * each other. The next tuning of one after an Apple incident would have left
 * the other on the old value with the old justification. Now the wire is here
 * once, and each caller names only what is genuinely its own: the entity, the
 * number of rows, and its timeout.
 *
 * THE TIMEOUT IS THE CALLER'S, and the two callers disagree on purpose until
 * the founder rules (docs/roadmap/code-health-2.md §1, question 3):
 *   - show directory 2 s — measured 2026-09-12 over 25 listener queries
 *     against `entity=podcast`: 52 ms min, 266 ms median, 698 ms max; the
 *     pass runs on every show search, so 2 s bounds what a hung Apple costs
 *     the typeahead (appleShowSearch.ts note (6)).
 *   - episode search 8 s — unmeasured. Nobody has timed `entity=podcastEpisode`;
 *     the default is to keep 8 s until somebody does.
 *
 * THE ANSWER. `results` is Apple's `results` array as sent (each caller maps
 * its own rows); `error` is non-null exactly when there is no answer:
 *   - `Apple search HTTP <status>` for a non-2xx response;
 *   - `Apple search fetch error: <message>` for everything else that failed —
 *     the transport, the timeout's abort, a body that is not a JSON object,
 *     or a body whose `results` is not a list. An absent `results` is an
 *     empty answer.
 * The timer covers the body read as well as the headers, and is always
 * cleared.
 *
 * The User-Agent is the product's one outbound identity, imported and never
 * restated (round-3 audit, arch-drift-14; #316 cost 423 transcripts to one
 * drifted copy). `tools/segments/politeness.test.mjs` refuses a spelled-out
 * one anywhere under api/.
 */
export const APPLE_SEARCH_URL = "https://itunes.apple.com/search";

export type AppleEntity = "podcast" | "podcastEpisode";

export interface AppleSearchOptions {
  fetchImpl?: typeof fetch;
  /** Required: each caller owns its budget (see the header). */
  timeoutMs: number;
}

export interface AppleSearchAnswer<T> {
  results: T[];
  error: string | null;
}

export async function appleSearch<T = unknown>(
  entity: AppleEntity,
  term: string,
  limit: number,
  { fetchImpl = fetch, timeoutMs }: AppleSearchOptions
): Promise<AppleSearchAnswer<T>> {
  const url =
    `${APPLE_SEARCH_URL}?entity=${entity}&limit=${encodeURIComponent(String(limit))}` +
    `&term=${encodeURIComponent(term)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      headers: { "User-Agent": DEFAULT_FEED_USER_AGENT, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) return { results: [], error: `Apple search HTTP ${res.status}` };
    const body = (await res.json()) as { results?: unknown };
    const results = body.results ?? []; // a `null` body throws here: no answer, not an empty one
    if (!Array.isArray(results)) throw new TypeError("results is not a list");
    return { results: results as T[], error: null };
  } catch (err) {
    return { results: [], error: `Apple search fetch error: ${(err as Error).message}` };
  } finally {
    clearTimeout(timer);
  }
}
