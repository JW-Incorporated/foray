/* One poll cycle of the S-10 watchlist poller, with no database (PKG-10 core,
   docs/roadmap/shows-search.md).

   WHAT THIS IS. The live path's loop body, built from the parts PKG-05/06 already
   pinned: selectDue (select-due.mjs) picks the due rows, fetchFeedConditional
   (fetch-feed.mjs) asks each publisher "changed since <etag>?", the per-host
   PolitenessBudget (politeness.mjs) hears how each host answered, applySuccess /
   applyFailure (tiers.mjs) move the feed's tier and state, and nextDueAt
   reschedules it. Per-feed poll state lives behind an injected `store`; the only
   store shipped is the in-memory Map below.

   WHAT THIS IS NOT. It parses no episodes and writes no DB (G1/G3 and PKG-02
   gate that), and nothing calls it yet: tools/poll/poll-episodes.mjs keeps its
   live-mode exit 3. It is proven against a loopback node:http fixture in
   poll-cycle.test.mjs and is never pointed at a real publisher here.

   STORE CONTRACT. store.get(feedUrl) -> state | undefined, store.set(feedUrl,
   state). State: { etag, lastModified, tier, consecutiveFailures, state,
   firstNotFoundAtMs, next_due_at_ms }. Keyed on feed_url because a curated row
   can have a null pi_id. A feed with no stored state starts from its row:
   row.tier, row.state, row.next_due_at_ms, no validators, no failures.

   THE RULES:
   - Selection runs on the rows with their stored tier/state/next_due_at_ms laid
     over them, so a feed the store marked dead or not-yet-due is skipped.
   - Feeds are fetched one at a time (never concurrently). Each fetch is preceded
     by budget.recordRequestStart(host, nowMs). Spacing requests to one host
     WITHIN a run (minIntervalMs) is not enforced here -- every request in a run
     is stamped at nowMs -- so perHostCap is what bounds a run's burst on one
     host; the live wiring must add the real wait before pointing this at
     publishers.
   - Success is any 2xx or 304 that fetchFeedConditional returned without an
     `error`: budget.recordSuccess(host), applySuccess. The validators are
     replaced by the response's (a 304 returns the prior ones). The `error`
     clause exists for one case: a 200 whose declared Content-Length exceeds the
     cap comes back as status 200, body null, with an error -- that is a failed
     poll, not a success that would wipe the stored ETag.
   - Anything else is a failure: applyFailure({ status, nowMs }) (410 dead at
     once, 404 dead from day 30, 5 in a row -> backoff). Only a 429 or 5xx is a
     HOST failure (budget.recordFailure) -- politeness.mjs's rule; a 404/410 is
     the feed's problem, and a status 0 (network error, timeout, oversize body)
     is not a host signal the budget was specified for. A failure keeps the
     stored validators.
   - next_due_at_ms = nextDueAt(newTier, nowMs) for every fetched feed, dead or
     not (a dead feed is never selected again, so its due time is moot).
   Returns { outcomes: [{ feed_url, pi_id, status, notModified, ok, error?,
   tier, state, next_due_at_ms }], skipped, hosts } -- skipped and hosts straight
   from selectDue. */

import { PolitenessBudget } from "./politeness.mjs";
import { selectDue } from "./select-due.mjs";
import { applyFailure, applySuccess, nextDueAt } from "./tiers.mjs";
import { fetchFeedConditional } from "./fetch-feed.mjs";

/** The in-memory store: a Map behind the get/set interface. */
export function createMemoryStore(entries = []) {
  const map = new Map(entries);
  return {
    get: (feedUrl) => map.get(feedUrl),
    set: (feedUrl, state) => {
      map.set(feedUrl, state);
    },
    entries: () => [...map.entries()],
  };
}

function initialState(row) {
  return {
    etag: null,
    lastModified: null,
    tier: row.tier,
    consecutiveFailures: 0,
    state: row.state ?? "active",
    firstNotFoundAtMs: null,
    next_due_at_ms: row.next_due_at_ms ?? null,
  };
}

function isSuccess(status) {
  return status === 304 || (status >= 200 && status < 300);
}

function isHostFailure(status) {
  return status === 429 || status >= 500;
}

export async function runPollCycle({
  rows,
  store,
  fetchImpl,
  nowMs,
  budget = new PolitenessBudget(),
  perRunCap,
  perHostCap,
  fetchOpts = {},
} = {}) {
  if (!Number.isFinite(nowMs)) throw new TypeError("runPollCycle: nowMs must be a finite number");
  if (!store || typeof store.get !== "function" || typeof store.set !== "function") {
    throw new TypeError("runPollCycle: store must have get(feedUrl) and set(feedUrl, state)");
  }

  const stateOf = new Map();
  const effective = rows.map((row) => {
    const st = store.get(row.feed_url) ?? initialState(row);
    stateOf.set(row, st);
    return { ...row, tier: st.tier, state: st.state, next_due_at_ms: st.next_due_at_ms, __row: row };
  });

  const selectOpts = { nowMs, budget };
  if (perRunCap !== undefined) selectOpts.perRunCap = perRunCap;
  if (perHostCap !== undefined) selectOpts.perHostCap = perHostCap;
  const { due, skipped, hosts } = selectDue(effective, selectOpts);

  const outcomes = [];
  for (const eff of due) {
    const row = eff.__row;
    const prior = stateOf.get(row);
    const host = PolitenessBudget.hostOf(row.feed_url);
    budget.recordRequestStart(host, nowMs);
    const res = await fetchFeedConditional(
      row.feed_url,
      { etag: prior.etag, lastModified: prior.lastModified },
      { ...fetchOpts, fetchImpl },
    );

    const ok = !res.error && isSuccess(res.status);
    let next;
    if (ok) {
      budget.recordSuccess(host);
      next = { ...applySuccess(prior), etag: res.etag, lastModified: res.lastModified };
    } else {
      if (isHostFailure(res.status)) budget.recordFailure(host, nowMs);
      next = applyFailure(prior, { status: res.status, nowMs });
    }
    next.next_due_at_ms = nextDueAt(next.tier, nowMs);
    store.set(row.feed_url, next);

    const outcome = {
      feed_url: row.feed_url,
      pi_id: row.pi_id ?? null,
      status: res.status,
      notModified: res.notModified,
      ok,
      tier: next.tier,
      state: next.state,
      next_due_at_ms: next.next_due_at_ms,
    };
    if (res.error) outcome.error = res.error;
    outcomes.push(outcome);
  }
  return { outcomes, skipped, hosts };
}
