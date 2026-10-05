/* Per-host request budget + exponential backoff for the S-10 watchlist poller
   (PKG-06, docs/roadmap/shows-search.md).

   Port of backend/src/feeds/politeness.ts; politeness.test.mjs pins the constants.
   Not tools/segments/politeness.mjs: that is the transcript-fetch policy (1.2 s);
   feed polling mirrors backend/src/feeds/politeness.ts because PKG-10's live path
   will run there.

   WHY PER HOST. One host serves dozens of feeds (every Libsyn / Megaphone /
   Buzzsprout show), so the budget is keyed on hostname; spacing requests per
   FEED would still hammer one host during a batch.

   THE RULES, identical to the TypeScript, so either side can be checked against
   the other:
   - A host never requested is allowed at once (lastRequestAt starts at
     -Infinity, not 0).
   - msUntilAllowed(host, now) = max(0, blockedUntil - now,
     lastRequestAt + minIntervalMs - now).
   - recordFailure: consecutiveFailures += 1; backoff = min(backoffMaxMs,
     backoffBaseMs * 2 ** (consecutiveFailures - 1)); blockedUntil = now +
     backoff; returns backoff.
   - recordSuccess clears the failure count and the block (not the spacing).
   - hostOf lowercases the URL's hostname and returns the input unchanged when
     it does not parse.
   The TS file's KNOWN_DAI_HOSTS / hostSuggestsDai are not part of the budget
   and are not ported. */

export const DEFAULT_CONFIG = Object.freeze({
  minIntervalMs: 2000,
  backoffBaseMs: 5000,
  backoffMaxMs: 900000, // 15 * 60_000 -- 15 minutes
});

export class PolitenessBudget {
  #config;
  #hosts = new Map();

  constructor(config = {}) {
    this.#config = { ...DEFAULT_CONFIG, ...config };
  }

  #stateFor(host) {
    let s = this.#hosts.get(host);
    if (!s) {
      s = { lastRequestAt: Number.NEGATIVE_INFINITY, consecutiveFailures: 0, blockedUntil: 0 };
      this.#hosts.set(host, s);
    }
    return s;
  }

  static hostOf(url) {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return url;
    }
  }

  /** Ms to wait before it is polite to request `host` again (0 = go now). */
  msUntilAllowed(host, now = Date.now()) {
    const s = this.#stateFor(host);
    const blockedFor = s.blockedUntil - now;
    const spacedFor = s.lastRequestAt + this.#config.minIntervalMs - now;
    return Math.max(0, blockedFor, spacedFor);
  }

  /** Call immediately before issuing a request to `host`. */
  recordRequestStart(host, now = Date.now()) {
    this.#stateFor(host).lastRequestAt = now;
  }

  /** Call after a successful (non-429/5xx) response. */
  recordSuccess(host) {
    const s = this.#stateFor(host);
    s.consecutiveFailures = 0;
    s.blockedUntil = 0;
  }

  /** Call after a 429 or 5xx -- applies exponential backoff for this host. */
  recordFailure(host, now = Date.now()) {
    const s = this.#stateFor(host);
    s.consecutiveFailures += 1;
    const backoff = Math.min(
      this.#config.backoffMaxMs,
      this.#config.backoffBaseMs * 2 ** (s.consecutiveFailures - 1),
    );
    s.blockedUntil = now + backoff;
    return backoff;
  }

  consecutiveFailuresFor(host) {
    return this.#stateFor(host).consecutiveFailures;
  }
}
