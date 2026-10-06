/* Due-set selection and the weekly request projection for the S-10 watchlist
   poller (PKG-06, docs/roadmap/shows-search.md).

   WHAT THIS IS FOR. The dry-run (PKG-08) calls selectDue to say which feeds a
   run WOULD fetch, and weeklyProjection to say how many requests a week the
   watchlist costs. Founder gate G9 (docs/roadmap/shows-search.md §1; default
   N = 5,000, target < 40,000 requests/week) is judged against that
   projection, so its arithmetic is stated here and pinned by
   select-due.test.mjs. Pure: no I/O, no clock reads (the caller passes nowMs).

   ROW SHAPE: { pi_id: number|null, feed_url: string, tier: string,
   next_due_at_ms: number|null, state: "active"|"dead", watch_reasons: string[] }.

   selectDue RULES, in order:
   1. state === "dead" -> skipped.dead.
   2. next_due_at_ms > nowMs -> skipped.notDue. A null next_due_at_ms is due.
   3. A feed_url that `new URL()` throws on -> skipped.badUrl (never thrown).
   4. Sort the rest by next_due_at_ms ascending (null first), then pi_id
      ascending with null AFTER every number.
   5. Walk: take a row only when budget.msUntilAllowed(host, nowMs) === 0 and
      the host has fewer than perHostCap rows taken; otherwise skipped.perHostCap.
      recordRequestStart is NOT called: the dry-run never advances the budget
      clock, so only a budget the caller primed (a host in backoff) blocks.
   6. Stop once due.length === perRunCap; every remaining candidate counts
      skipped.perRunCap.
   A null-pi_id row (an unmapped curated show) is eligible and counted in hosts.
   hosts maps hostname (lowercased, as PolitenessBudget.hostOf) -> rows taken.

   weeklyProjection: each active row contributes 604_800_000 /
   TIER_INTERVAL_MS[tier] requests a week (daily = 7, weekly = 1); a dead row
   contributes 0 and is not counted in rows. An unknown tier throws RangeError. */

import { PolitenessBudget } from "./politeness.mjs";
import { TIER_INTERVAL_MS } from "./tiers.mjs";

const WEEK_MS = 604_800_000;

function hostOrNull(feedUrl) {
  try {
    return new URL(feedUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function byDueThenPiId(a, b) {
  const da = a.row.next_due_at_ms;
  const db = b.row.next_due_at_ms;
  if (da !== db) {
    if (da == null) return -1;
    if (db == null) return 1;
    return da - db;
  }
  const pa = a.row.pi_id;
  const pb = b.row.pi_id;
  if (pa === pb) return 0;
  if (pa == null) return 1;
  if (pb == null) return -1;
  return pa - pb;
}

export function selectDue(watchlist, { nowMs, perRunCap = 300, budget = new PolitenessBudget(), perHostCap = 20 } = {}) {
  if (!Number.isFinite(nowMs)) throw new TypeError("selectDue: nowMs must be a finite number");
  const skipped = { dead: 0, notDue: 0, perRunCap: 0, perHostCap: 0, badUrl: 0 };
  const candidates = [];
  for (const row of watchlist) {
    if (row.state === "dead") {
      skipped.dead += 1;
      continue;
    }
    if (row.next_due_at_ms != null && row.next_due_at_ms > nowMs) {
      skipped.notDue += 1;
      continue;
    }
    const host = hostOrNull(row.feed_url);
    if (host === null) {
      skipped.badUrl += 1;
      continue;
    }
    candidates.push({ row, host });
  }
  candidates.sort(byDueThenPiId);

  const due = [];
  const taken = new Map();
  for (let i = 0; i < candidates.length; i++) {
    if (due.length === perRunCap) {
      skipped.perRunCap += candidates.length - i;
      break;
    }
    const { row, host } = candidates[i];
    const count = taken.get(host) ?? 0;
    if (budget.msUntilAllowed(host, nowMs) === 0 && count < perHostCap) {
      due.push(row);
      taken.set(host, count + 1);
    } else {
      skipped.perHostCap += 1;
    }
  }
  return { due, skipped, hosts: Object.fromEntries(taken) };
}

export function weeklyProjection(watchlist) {
  const byTier = {};
  let requestsPerWeek = 0;
  for (const row of watchlist) {
    if (row.state !== "active") continue;
    if (!Object.hasOwn(TIER_INTERVAL_MS, row.tier)) throw new RangeError("unknown tier: " + row.tier);
    const perWeek = WEEK_MS / TIER_INTERVAL_MS[row.tier];
    const slot = Object.hasOwn(byTier, row.tier) ? byTier[row.tier] : (byTier[row.tier] = { rows: 0, requestsPerWeek: 0 });
    slot.rows += 1;
    slot.requestsPerWeek += perWeek;
    requestsPerWeek += perWeek;
  }
  return { requestsPerWeek, byTier };
}
