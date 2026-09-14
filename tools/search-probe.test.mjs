/* Tests for tools/search-probe.mjs (docs/search-plan.md S-01). Floored per
   tools/ci path-policy convention — see suite-integrity.test.js.

   WHAT THIS COVERS, deliberately split from test/search-probe-record.test.js:
   this file proves the MEASUREMENT MACHINERY is correct in isolation (median/
   p95 math, timing wrapper, the "skipped not failed" network contract, the
   validator that would catch a report silently dropping p95 or the
   X-Vercel-Cache/Cache-Control pairing) — everything driven by fakes and an
   injected fetch, no real catalogue and no real network. The other suite
   covers the WIRING into player/diagnostic-log.js and app.js. Neither is
   sufficient alone — the same split this repo's diagnostic-log/-record pair
   already uses, for the same reason. */

import test from "node:test";
import assert from "node:assert/strict";

import {
  median, p95, timeReps, localPassBattery, decodeStats, breadthRoundTrip,
  runProbe, formatTable, validateReport, QUERY_BATTERY, NON_ASCII_QUERY, REPS,
  indexPassBattery, PARITY_CASES, parityCase, parityBattery, targetRank,
  normaliseTitle, SCAN_REACH_CASES, SCAN_REACH_TARGETS, SCAN_MIN_QUERY_LENGTH,
} from "./search-probe.mjs";

/* ==================================================================== */
/* median / p95                                                         */
/* ==================================================================== */

test("median of an odd-length sorted array is the middle element", () => {
  // MUTATION: use the even-length branch unconditionally. 3 !== 2.
  assert.equal(median([1, 2, 3]), 2);
});

test("median of an even-length sorted array averages the two middle elements", () => {
  // MUTATION: drop the averaging and return either middle element alone.
  assert.equal(median([1, 2, 3, 4]), 2.5);
});

test("median of an empty array is null, not NaN or a thrown error", () => {
  // MUTATION: index into an empty array unconditionally -> NaN, and NaN
  // would silently poison every downstream report field.
  assert.equal(median([]), null);
});

test("p95 of 20 samples is the 19th (1-indexed), nearest-rank", () => {
  // ceil(0.95 * 20) = 19, so index 18 zero-based. MUTATION: use plain
  // Math.floor instead of ceil -> off-by-one, picks index 17 (the 18th).
  const sorted = Array.from({ length: 20 }, (_, i) => i + 1); // 1..20
  assert.equal(p95(sorted), 19);
});

test("p95 clamps to the last element rather than reading past the array", () => {
  // A 3-sample battery (e.g. the network round-trip's 3 MISS samples):
  // ceil(0.95*3)=3 -> index 2, the last element. MUTATION: no clamp ->
  // an index that could exceed length on a tiny sample set silently
  // returns undefined and formatTable would print "undefinedms".
  assert.equal(p95([10, 20, 30]), 30);
});

test("p95 of an empty array is null", () => {
  assert.equal(p95([]), null);
});

/* ==================================================================== */
/* timeReps                                                             */
/* ==================================================================== */

test("timeReps runs fn exactly `reps` times and returns sorted samples", () => {
  // MUTATION: off-by-one in the loop bound (< vs <=). calls !== 7.
  let calls = 0;
  const { samples } = timeReps(() => { calls += 1; }, 7);
  assert.equal(calls, 7);
  assert.equal(samples.length, 7);
  for (let i = 1; i < samples.length; i++) {
    assert.ok(samples[i] >= samples[i - 1], "samples must come back sorted ascending");
  }
});

test("timeReps carries the function's last return value through as `last`", () => {
  // MUTATION: return the FIRST call's result instead of the last. A search
  // battery relies on `last` being the hit-count-bearing result of the
  // final rep, and 1 !== 3 here catches either wrong index.
  let n = 0;
  const { last } = timeReps(() => { n += 1; return n; }, 3);
  assert.equal(last, 3);
});

test("timeReps never reports a negative duration", () => {
  // Uses process.hrtime.bigint(), which is monotonic; this pins that
  // property rather than trusting it silently. MUTATION: swap start/end
  // in the subtraction -> every sample goes negative.
  const { samples } = timeReps(() => {}, 5);
  for (const s of samples) assert.ok(s >= 0, `sample ${s} must not be negative`);
});

/* ==================================================================== */
/* localPassBattery                                                     */
/* ==================================================================== */

test("localPassBattery reports one row per query, in battery order, with query_len set from the query's own length", () => {
  // MUTATION: report `shows.length` (the catalogue size) instead of the
  // query's length -- the whole point of "query length, never query text"
  // (docs/search-plan.md S-01, player/diagnostic-log.js's own rule) is that
  // the recorded number describes the QUERY, and this pins that source.
  const fakeShows = [{ title: "Alpha" }, { title: "Beta" }];
  const fakeSearch = (q) => fakeShows.filter((s) => s.title.toLowerCase().includes(q.toLowerCase()));
  const rows = localPassBattery(fakeSearch, fakeShows, ["a", "beta"], 3);
  assert.deepEqual(rows.map((r) => r.query_len), [1, 4]);
});

test("localPassBattery's hit count is the real search result length, not the rep count", () => {
  // MUTATION: report `reps` instead of `last.length` as hits. 3 !== 2.
  const fakeShows = [{ title: "Alpha" }, { title: "Also" }, { title: "Zeta" }];
  const fakeSearch = (q) => fakeShows.filter((s) => s.title.toLowerCase().startsWith(q));
  const rows = localPassBattery(fakeSearch, fakeShows, ["al"], 5);
  assert.equal(rows[0].hits, 2);
});

test("localPassBattery times each query REPS times independently, never sharing one measurement across queries", () => {
  // MUTATION: measure the whole battery once and divide -- calls per query
  // would then be uneven/shared and this count would be wrong.
  const calls = [];
  const fakeSearch = (q) => { calls.push(q); return []; };
  localPassBattery(fakeSearch, [], ["x", "yy"], 4);
  assert.equal(calls.filter((q) => q === "x").length, 4);
  assert.equal(calls.filter((q) => q === "yy").length, 4);
});

/* ==================================================================== */
/* decodeStats                                                          */
/* ==================================================================== */

test("decodeStats measures JSON.parse of the given text, not a fixed no-op", () => {
  // MUTATION: replace `JSON.parse(raw)` with `raw.length` (a cheap
  // stand-in). An invalid JSON string would then never throw, and this
  // test's real assertion is the throw below -- decodeStats must propagate
  // a parse failure rather than swallow it into a bogus timing.
  assert.throws(() => decodeStats("{not json"), /JSON/);
  const stats = decodeStats(JSON.stringify({ a: 1 }), 5);
  assert.equal(typeof stats.ms_median, "number");
  assert.equal(typeof stats.ms_p95, "number");
});

/* ==================================================================== */
/* breadthRoundTrip: skipped, not failed                                */
/* ==================================================================== */

test("breadthRoundTrip is SKIPPED, not thrown, when the origin is unreachable", () => {
  // MUTATION: let the fetch rejection propagate instead of being caught --
  // runProbe (and CI) would then go red for an offline runner, which S-01's
  // own acceptance line forbids ("network samples skipped, not failed").
  const failing = async () => { throw new Error("ENOTFOUND"); };
  return breadthRoundTrip({ fetchImpl: failing }).then((r) => {
    assert.equal(r.skipped, true);
    assert.match(r.reason, /ENOTFOUND/);
    assert.deepEqual(r.misses, []);
    assert.deepEqual(r.hits, []);
  });
});

test("breadthRoundTrip takes exactly 3 forced-MISS samples and 3 repeat-HIT samples", () => {
  // MUTATION: fold the two loops into one shared count of 3 total (3+3=6
  // becomes 3). The call-count assertion below distinguishes "3 total" from
  // "3 of each", which a naive single-loop rewrite would collapse.
  let calls = 0;
  const seenUrls = [];
  const fakeFetch = async (url) => {
    calls += 1;
    seenUrls.push(String(url));
    return { status: 200, headers: new Map([["cache-control", "public, max-age=300"], ["x-vercel-cache", "MISS"]]) };
  };
  return breadthRoundTrip({ fetchImpl: fakeFetch, runId: "t1" }).then((r) => {
    assert.equal(calls, 6);
    assert.equal(r.misses.length, 3);
    assert.equal(r.hits.length, 3);
    // The 3 MISS samples must be 3 DISTINCT queries (a real cache MISS needs
    // a query the cache has never seen); the 3 HIT samples must be the SAME
    // query repeated (a HIT needs to actually re-request something already
    // cached). MUTATION: reuse one query for all 6 calls -- this fails.
    const missUrls = seenUrls.slice(0, 3);
    const hitUrls = seenUrls.slice(3);
    assert.equal(new Set(missUrls).size, 3, "the 3 MISS samples must be 3 distinct queries");
    assert.equal(new Set(hitUrls).size, 1, "the 3 HIT samples must repeat one identical query");
  });
});

test("breadthRoundTrip records Cache-Control, X-Vercel-Cache and Age exactly as received, never assumed", () => {
  // MUTATION: hardcode `x_vercel_cache: "HIT"` instead of reading the
  // header -- §1.4 found the response is MISSING stale-while-revalidate
  // even though the source sets it, so this probe must report headers
  // literally rather than assume the source's intent landed.
  const fakeFetch = async () => ({
    status: 200,
    headers: new Map([
      ["cache-control", "public, max-age=300"], // note: no stale-while-revalidate, deliberately
      ["x-vercel-cache", "MISS"],
      ["age", "0"],
    ]),
  });
  return breadthRoundTrip({ fetchImpl: fakeFetch, runId: "t2" }).then((r) => {
    assert.equal(r.misses[0].cache_control, "public, max-age=300");
    assert.ok(!r.misses[0].cache_control.includes("stale-while-revalidate"));
    assert.equal(r.misses[0].x_vercel_cache, "MISS");
    assert.equal(r.misses[0].age, "0");
  });
});

/* ==================================================================== */
/* validateReport                                                       */
/* ==================================================================== */

function validReport() {
  return {
    v: 2,
    battery: QUERY_BATTERY.map((q) => ({ query_len: q.length, ms_median: 1, ms_p95: 2, hits: 0 })),
    decode: { ms_median: 1, ms_p95: 2 },
    /* S-03's section. `skipped: true` is the DEFAULT-VALID shape here, not a
       degraded one: a checkout with no data/show-index.tsv reports "no
       coverage" and is still a structurally valid report, exactly the way the
       network section behaves when the origin is unreachable. */
    index: { skipped: true, reason: "not on disk", rows: 0, decode: null, battery: [] },
    network: {
      skipped: false,
      misses: [{ ms: 1, status: 200, cache_control: "public, max-age=300", x_vercel_cache: "MISS", age: "0" }],
      hits: [{ ms: 1, status: 200, cache_control: "public, max-age=300", x_vercel_cache: "HIT", age: "1" }],
    },
    /* P-06's section. Like `index`, a skipped section is the DEFAULT-VALID
       shape — an offline runner is not a finding about the gate. */
    parity: { skipped: true, reason: "--no-network", cases: [] },
  };
}

test("validateReport accepts a well-formed report", () => {
  assert.deepEqual(validateReport(validReport()), []);
});

test("validateReport rejects a battery with the wrong number of rows (a dropped or duplicated query)", () => {
  // MUTATION: allow any non-empty battery array through.
  const r = validReport();
  r.battery = r.battery.slice(0, 1);
  assert.ok(validateReport(r).length > 0);
});

test("validateReport rejects a battery row missing p95 (mean-without-p95, explicitly forbidden by S-01)", () => {
  // MUTATION: only check for ms_median, never ms_p95.
  const r = validReport();
  delete r.battery[0].ms_p95;
  const errors = validateReport(r);
  assert.ok(errors.some((e) => /p95/.test(e)));
});

test("validateReport rejects a report with no decode stats", () => {
  const r = validReport();
  r.decode = {};
  assert.ok(validateReport(r).length > 0);
});

test("validateReport rejects a network section with no explicit skipped flag (silence is not \"no coverage\")", () => {
  // MUTATION: only validate network when it happens to be present, treating
  // a missing/malformed network section as fine by omission.
  const r = validReport();
  delete r.network.skipped;
  assert.ok(validateReport(r).length > 0);
});

test("validateReport rejects a Cache-Control value reported with no X-Vercel-Cache beside it (S-01's explicit reject case)", () => {
  // MUTATION: validate cache_control alone without cross-checking
  // x_vercel_cache -- this is verbatim S-01's own "Not acceptable" line.
  const r = validReport();
  r.network.misses[0].x_vercel_cache = null;
  const errors = validateReport(r);
  assert.ok(errors.some((e) => /X-Vercel-Cache/.test(e)));
});

test("validateReport does not require network samples when the section is honestly skipped", () => {
  // MUTATION: fail validation whenever misses/hits are empty, regardless of
  // the skipped flag -- that would make an offline CI runner unable to ever
  // pass --check, contradicting S-01's own "skipped, not failed" rule.
  const r = validReport();
  r.network = { skipped: true, reason: "origin unreachable: test", misses: [], hits: [] };
  assert.deepEqual(validateReport(r), []);
});

/* ==================================================================== */
/* formatTable                                                          */
/* ==================================================================== */

test("formatTable prints the query battery's median AND p95 on every row, never a mean alone", () => {
  // MUTATION: print only ms_median. The p95 substring assertion fails.
  const report = validReport();
  report.run_at = "2026-09-09T00:00:00.000Z";
  report.catalog_shows = 220;
  const text = formatTable(report);
  assert.match(text, /ms_median\s+ms_p95/);
  assert.match(text, /1\.000\s+2\.000/);
});

test("formatTable renders \"no coverage\" rather than a fabricated row when network is skipped", () => {
  // MUTATION: print an empty misses/hits table silently instead of naming
  // the skip -- a reader must not confuse \"nothing printed\" with \"zero
  // latency\", the exact confusion \"no coverage\" exists to prevent.
  const report = validReport();
  report.run_at = "x";
  report.catalog_shows = 1;
  report.network = { skipped: true, reason: "origin unreachable: test", misses: [], hits: [] };
  const text = formatTable(report);
  assert.match(text, /no coverage/);
  assert.match(text, /origin unreachable: test/);
});

/* ==================================================================== */
/* runProbe: end to end against the REAL committed catalogue            */
/* ==================================================================== */

test("runProbe(--no-network) produces a structurally valid report over the REAL catalogue with real search-engine.js", async () => {
  // The one integration point deliberately NOT faked: the real
  // search-engine.js and the real committed data/catalog-client.json, so a
  // change to either one that breaks the probe is caught here rather than
  // only in the fake-driven unit tests above.
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const SearchEngine = require("../search-engine.js");
  const report = await runProbe({ searchShows: SearchEngine.searchShows, noNetwork: true });
  assert.equal(validateReport(report).length, 0, JSON.stringify(validateReport(report)));
  assert.equal(report.network.skipped, true);
  assert.equal(report.network.reason, "--no-network");
  assert.equal(report.battery.length, QUERY_BATTERY.length);
  // The non-ASCII battery entry's query_len must be the QUERY's length, not
  // some placeholder -- pins the "query length, never query text" contract
  // this file shares with player/diagnostic-log.js.
  const nonAsciiRow = report.battery[report.battery.length - 1];
  assert.equal(nonAsciiRow.query_len, NON_ASCII_QUERY.length);
});

test("REPS is 20, matching S-01's own \"20 reps\" acceptance line, not some other constant", () => {
  // A weak but real guard: dropping this to e.g. 1 would pass every other
  // test in this file (they parametrize reps explicitly) while silently
  // violating the card's own stated rep count for the default CLI run.
  assert.equal(REPS, 20);
});


/* ---------------------------------------------- S-03: the index battery ---- */

function validIndexSection() {
  return {
    skipped: false, reason: null, rows: 10113, bytes: 446334,
    decode: { ms_median: 47, ms_p95: 78 },
    battery: QUERY_BATTERY.map((q) => ({
      query_len: q.length,
      prefix_hits: 1, prefix_ms_median: 0.004, prefix_ms_p95: 0.013,
      scan_hits: 0, scan_ms_median: 8, scan_ms_p95: 13, scan_reached: true,
    })),
    /* The REACH rows (defect 1, 2026-09-13) are part of a valid index section
       now: a report that carries the scan's latency saving and not its reach
       cost is exactly the half-measurement `validateReport` was extended to
       refuse. */
    reach: SCAN_REACH_CASES.map((c) => ({
      query_len: c.query.length,
      prefix_hits: 1, prefix_ms_median: 0.004, prefix_ms_p95: 0.013,
      scan_hits: 3, scan_ms_median: 8, scan_ms_p95: 13, scan_reached: true,
      reach_target: c.target, reach_rank_without_scan: null, reach_rank_with_scan: 4, reach_lost: true,
    })),
  };
}

test("indexPassBattery reports the prefix pass and the scan pass SEPARATELY, never as one number", () => {
  /* The two run at different moments and are graded against different
     budgets: the prefix pass sits on a KEYSTROKE (16 ms frame), the scan on
     the DEBOUNCE TICK. One averaged column would read as "the index costs
     ~20 ms", which is true of neither pass and is the exact shape S-01's
     "never a mean" rule exists to forbid.

     Driven by fakes with known return lengths — this asserts the SHAPE of the
     report, not the speed of a real index (test/show-index.test.js measures
     that against the committed file).

     MUTATION: have indexPassBattery return one `ms_median` per row, averaged
     over both passes. The four-field assertion below fails. */
  const prefix = (q) => new Array(q.length).fill(0);
  const scan = (q) => new Array(q.length * 2).fill(0);
  const rows = indexPassBattery(prefix, scan, { keys: [], rows: [] }, ["ab", "cde"], 3);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.prefix_hits), [2, 3]);
  assert.deepEqual(rows.map((r) => r.scan_hits), [4, 6]);
  /* `scan_reached` says whether app.js would EVER pay this row's scan cost.
     Without the column, a table row showing a 331 ms scan for "l" reads as a
     cost the app pays; it never does.

     IT MIRRORS THE APP'S GATE, AND THAT GATE CHANGED (defect 1, 2026-09-13):
     it was `prefix_hits < 10` and is now a floor on query LENGTH, because the
     count gate was measured to cost reach. "ab" is two characters and below
     the floor; "cde" is three and above it.
     MUTATION: hardcode `scan_reached: true`, or leave the old
     `prefix_hits < 10` expression in place. Either way "ab" and "cde" stop
     disagreeing and this goes red. */
  assert.deepEqual(rows.map((r) => r.scan_reached), [false, true]);
  assert.equal(SCAN_MIN_QUERY_LENGTH, 3,
    "the mirrored floor must match app.js's SHOW_SCAN_MIN_QUERY_LENGTH — a drift here makes the column report a policy the app does not have");
  for (const r of rows) {
    for (const k of ["prefix_ms_median", "prefix_ms_p95", "scan_ms_median", "scan_ms_p95"]) {
      assert.equal(typeof r[k], "number", `${k} must be reported in its own right`);
    }
  }
});

test("validateReport accepts a populated index section and rejects one that lost a pass's p95", () => {
  /* The contract the doc's after-table quotes from. A report that silently
     stopped reporting the scan pass's p95 would still print a plausible table
     and still exit 0 — the same "stat quietly disappeared" failure the
     battery and network validators already guard.

     MUTATION: check only `prefix_ms_p95`. The second half goes green when it
     must not. */
  const ok = validReport();
  ok.index = validIndexSection();
  assert.deepEqual(validateReport(ok), []);

  const missing = validReport();
  missing.index = validIndexSection();
  delete missing.index.battery[0].scan_ms_p95;
  assert.ok(validateReport(missing).some((e) => /p95/.test(e)));

  const short = validReport();
  short.index = validIndexSection();
  short.index.battery = short.index.battery.slice(0, 2);
  assert.ok(validateReport(short).length > 0);
});

/* -------------------------------------------- defect 1: the REACH columns -- */

test("indexPassBattery reports REACH beside cost: where a named target lands WITH the scan and WITHOUT it", () => {
  /* THE COLUMN THE TABLE WAS MISSING. `scan_reached` said what skipping the
     scan SAVES and its comment called the saving "never paid in the app";
     nobody had asked what the skip COSTS. For `daily` the answer measured
     2026-09-13 over the committed index is: The Daily is absent from the
     index's answer without the scan and 17th with it — a REACH gap, not the
     ranking gap P-10 already owns.

     Driven by fakes with known contents, so this asserts the SHAPE of the
     measurement and not the speed or the contents of the real index (the
     probe's own --no-network run and test/show-search-reach.test.js cover
     those). The prefix pass here cannot see the target and the scan can,
     which is exactly the committed index's shape for `daily`.

     MUTATION: compute `reach_rank_without_scan` from the same merged list as
     `reach_rank_with_scan` (or from the scan's rows). The target stops being
     absent in the no-scan column, `reach_lost` goes false, and this goes
     red — which is the shape of a probe that reports a reach gap as fine. */
  const target = "The Daily";
  const prefix = () => [{ title: "Daily Dose of Dana" }, { title: "Daily Stoic" }];
  const scan = () => [{ title: "Some Other Show" }, { title: target }];
  const rows = indexPassBattery(prefix, scan, { keys: [], rows: [] }, ["daily"], 2,
    { targets: { daily: target } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reach_target, target);
  assert.equal(rows[0].reach_rank_without_scan, null,
    "absent without the scan — `null` and not 0, because a 0 would read as \"first\"");
  assert.equal(rows[0].reach_rank_with_scan, 4,
    "and present with it, at its position in the merged answer");
  assert.equal(rows[0].reach_lost, true,
    "`reach_lost` is the finding named as a boolean so a table scan cannot miss it");
});

test("a battery row with no named target reports null reach, never a fabricated rank", () => {
  /* `QUERY_BATTERY`'s twelve queries have no named target between them, which
     is why the reach cases are a separate list. A row with nothing to look for
     has to say so: inventing a rank (say, the first row's) would make the
     reach column read as "found it" for every timing query in the table and
     quietly destroy the one signal it was added to carry.

     MUTATION: default `target` to the first row's title when the map has no
     entry. `reach_target` stops being null and this goes red. */
  const rows = indexPassBattery((q) => new Array(q.length).fill({ title: "Anything" }),
    () => [{ title: "Anything Else" }], { keys: [], rows: [] }, ["zzqx"], 2, { targets: {} });
  assert.equal(rows[0].reach_target, null);
  assert.equal(rows[0].reach_rank_without_scan, null);
  assert.equal(rows[0].reach_rank_with_scan, null);
  assert.equal(rows[0].reach_lost, null,
    "null, not false — \"nothing was looked for\" and \"nothing was lost\" are different statements");
});

test("the reach cases are keyed lowercase and matched on the trimmed query, so a typed-in query still finds its target", () => {
  /* The reach battery is fed query strings, and the app's own gate trims
     before it measures length. A lookup that missed on case or on a stray
     space would silently return the no-target shape above — a null reach
     column that looks like "nothing to report" rather than a lookup that
     failed, which is the quiet kind of wrong this file's validator cannot see.

     MUTATION: key `SCAN_REACH_TARGETS` by the raw query and look up with the
     raw query. " Daily " misses, `reach_target` is null, and this goes red. */
  const target = SCAN_REACH_TARGETS.daily;
  assert.ok(target, "premise: `daily` is one of the named reach cases");
  const rows = indexPassBattery(() => [], () => [{ title: target }],
    { keys: [], rows: [] }, [" Daily "], 2);
  assert.equal(rows[0].reach_target, target);
  assert.equal(rows[0].reach_rank_with_scan, 1);
});

test("validateReport refuses an index section that carries the scan's latency saving and not its reach cost", () => {
  /* The half-measurement, made impossible to ship silently. A report that
     dropped the reach rows would still print a full cost table and still exit
     0 — which is precisely how the defect survived: the probe reported the
     skipped scan as a saving, every column was correct, and the missing column
     was the one that mattered.

     MUTATION: drop the `report.index.reach` checks from validateReport. All
     three cases below go green when they must not. */
  const ok = validReport();
  ok.index = validIndexSection();
  assert.deepEqual(validateReport(ok), []);

  const gone = validReport();
  gone.index = validIndexSection();
  delete gone.index.reach;
  assert.ok(validateReport(gone).some((e) => /reach/.test(e)),
    "a section with no reach rows at all must be invalid");

  const oneRank = validReport();
  oneRank.index = validIndexSection();
  delete oneRank.index.reach[0].reach_rank_without_scan;
  assert.ok(validateReport(oneRank).some((e) => /reach_rank_without_scan/.test(e)),
    "and so must one that reports where the show landed without saying whether it was there at all");

  const unnamed = validReport();
  unnamed.index = validIndexSection();
  unnamed.index.reach[0].reach_target = null;
  assert.ok(validateReport(unnamed).some((e) => /reach_target/.test(e)),
    "two ranks with no named show between them are unverifiable");
});

test("SCAN_REACH_CASES names `daily`/The Daily — the case the audit found, not a battery someone tuned afterwards", () => {
  /* A weak but real guard, in the same spirit as the REPS test above. The
     reach columns are worth exactly as much as the cases they are run over,
     and dropping `daily` from the list would leave the machinery intact,
     the validator green, and the one measured reach gap unobserved.

     MUTATION: remove the `daily` entry. This goes red rather than the suite
     quietly measuring four queries that never had a gap. */
  const daily = SCAN_REACH_CASES.find((c) => c.query === "daily");
  assert.ok(daily, "the reach battery must still carry the case it was written for");
  assert.equal(daily.target, "The Daily");
  assert.equal(SCAN_REACH_TARGETS[daily.query], daily.target,
    "and the lookup map must be derived from the case list, not maintained beside it");
});

test("validateReport rejects an index section with no explicit skipped flag", () => {
  /* Same rule as the network section: an absent index must say "no coverage",
     not be silent. A report with no `index` key at all is the shape a
     pre-S-03 tool would produce, and reading that as "the index is fast" is
     exactly the inference this validator exists to make impossible.

     MUTATION: drop the index-section check from validateReport. Red. */
  const r = validReport();
  delete r.index;
  assert.ok(validateReport(r).some((e) => /index section/.test(e)));
});

/* ==================================================================== */
/* P-06 — the three named parity cases (docs/search-parity-plan.md §2.1) */
/* ==================================================================== */

/** A fake /api/shows/search. `directoryRows` is what it returns when
    `fallthrough=1` is present, `plainRows` what it returns without — so a
    server that IGNORES the flag is expressed by passing the same array for
    both, which is precisely the state P-02 removed. */
function fakeSearchEndpoint({ plainRows, directoryRows, attempted = true, seen = [] }) {
  return async (url) => {
    seen.push(url);
    const flagged = url.includes("fallthrough=1");
    const rows = flagged ? directoryRows : plainRows;
    return {
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        query: "q",
        shows: rows,
        degraded: false,
        fallthrough: flagged ? { attempted, error: null, cached: false } : { attempted: false },
      }),
    };
  };
}

const prow = (title) => ({ show_id: title.replace(/\W+/g, ""), title });

test("PARITY_CASES is exactly the three queries §2.1 names as the defect, each with the show the listener meant", () => {
  /* THE NAMES ARE THE CONTRACT. P-06 exists because "one row for tim ferriss"
     was invisible for three days; a later edit that quietly drops a query, or
     retargets `sam harris` at something other than Making Sense, un-names the
     defect and the regression goes silent again.

     MUTATION: drop any entry, reorder them, or change a `target` string. Red. */
  assert.deepEqual(PARITY_CASES.map((c) => c.query), ["tim ferriss", "lex fridman", "sam harris"]);
  assert.deepEqual(PARITY_CASES.map((c) => c.target), [
    "The Tim Ferriss Show", "Lex Fridman Podcast", "Making Sense with Sam Harris",
  ]);
});

test("parityCase asks the endpoint TWICE — once plain, once with fallthrough=1 — and never only once", async () => {
  /* The pair IS the measurement. Asking only the flagged form would report
     "14 rows for tim ferriss" with nothing to compare it against, and the
     §2.1 defect (1 and 1) would be indistinguishable from a thin catalogue.

     MUTATION: delete either `get()` call in parityCase. The length check and
     the url assertions below go red. */
  const seen = [];
  const fetchImpl = fakeSearchEndpoint({ plainRows: [prow("A")], directoryRows: [prow("A"), prow("B")], seen });
  await parityCase(PARITY_CASES[0], { origin: "https://x.test", fetchImpl });
  assert.equal(seen.length, 2);
  assert.ok(seen.some((u) => !u.includes("fallthrough=1")), "one request must be unflagged");
  assert.ok(seen.some((u) => u.includes("fallthrough=1")), "one request must carry fallthrough=1");
  assert.ok(seen.every((u) => u.includes("tim%20ferriss")), "both requests must carry the case's own query, encoded");
});

test("THE §2.1 DEFECT HAS A SIGNATURE: a server that ignores the flag reports gain 0 with both columns equal", async () => {
  /* This is the exact shape measured on 2026-09-13 against the live endpoint:
     `tim ferriss` returned ONE row with the flag and ONE without it. Pinned so
     that a re-introduction of `&& results.length === 0` in
     api/shows/search.ts cannot pass as "the catalogue is small".

     MUTATION: have parityCase report the flagged count for both columns, or
     compute `gain` from anything but the difference. Red. */
  const same = [prow("The Tim Ferriss Show")];
  const c = await parityCase(PARITY_CASES[0], {
    origin: "https://x.test",
    fetchImpl: fakeSearchEndpoint({ plainRows: same, directoryRows: same, attempted: false }),
  });
  assert.equal(c.plain_rows, 1);
  assert.equal(c.directory_rows, 1);
  assert.equal(c.gain, 0);
  assert.equal(c.fallthrough_attempted, false);
});

test("parityCase reports the first THREE titles for each column, and fewer only when fewer exist", async () => {
  /* P-06 asks for titles, not only counts, and three of them. MUTATION:
     slice(0, 1), or report titles for the flagged column only. Red. */
  const c = await parityCase(PARITY_CASES[1], {
    origin: "https://x.test",
    fetchImpl: fakeSearchEndpoint({
      plainRows: [prow("Lex Fridman Podcast")],
      directoryRows: [prow("Lex Fridman Podcast"), prow("B"), prow("C"), prow("D")],
    }),
  });
  assert.deepEqual(c.plain_titles, ["Lex Fridman Podcast"]);
  assert.deepEqual(c.directory_titles, ["Lex Fridman Podcast", "B", "C"]);
});

test("targetRank is 1-INDEXED and null when the show the listener meant is absent", () => {
  /* A 0 would read as "first" in every table this feeds and mean "first" only
     by accident. MUTATION: return the raw findIndex. `2 !== 1` here, and the
     absent case silently becomes -1. */
  assert.equal(targetRank([prow("A"), prow("The Tim Ferriss Show")], "The Tim Ferriss Show"), 2);
  assert.equal(targetRank([prow("A")], "The Tim Ferriss Show"), null);
});

test("targetRank matches on the NORMALISED title, so punctuation and case cannot hide the target", () => {
  /* Apple's rows are whatever a publisher typed. MUTATION: compare raw
     strings — "Making Sense with Sam Harris!" stops matching and every table
     reports the target as absent, which reads as a far worse regression than
     the punctuation it actually is. */
  assert.equal(targetRank([{ show_id: "1", title: "Making Sense with Sam Harris!" }], "Making Sense with Sam Harris"), 1);
  assert.equal(normaliseTitle("Making Sense with Sam Harris!"), "making sense with sam harris");
});

test("A ROW COUNT CAN IMPROVE WHILE THE TARGET SINKS, and parityCase reports both so it cannot hide", async () => {
  /* MEASURED, 2026-09-13, and the reason this test exists: `tim ferriss` goes
     1 -> 14 rows on feat/search-parity while The Tim Ferriss Show goes from
     rank 1 to rank 3, behind two obscure Apple rows whose titles merely START
     with "tim ferriss" (rankShows buckets prefix above word-start). A table of
     counts alone reads that as an unqualified win.

     MUTATION: drop either target-rank field from parityCase's return. Red. */
  const c = await parityCase(PARITY_CASES[0], {
    origin: "https://x.test",
    fetchImpl: fakeSearchEndpoint({
      plainRows: [prow("The Tim Ferriss Show")],
      directoryRows: [prow("Tim Ferriss The 4-Hour Body"), prow("Tim Ferriss Podcast"), prow("The Tim Ferriss Show")],
    }),
  });
  assert.equal(c.gain, 2, "the count improved");
  assert.equal(c.plain_target_rank, 1);
  assert.equal(c.directory_target_rank, 3, "and the show the listener typed sank to third");
});

test("parityBattery is SKIPPED, not thrown, when the origin is unreachable", async () => {
  /* Same contract as breadthRoundTrip: an offline runner is not a finding
     about the gate. MUTATION: let the rejection propagate — the probe exits
     non-zero on a dev machine with no egress and the whole report is lost. */
  const boom = async () => { throw new Error("ENOTFOUND"); };
  const r = await parityBattery({ origin: "https://x.test", fetchImpl: boom });
  assert.equal(r.skipped, true);
  assert.match(r.reason, /ENOTFOUND/);
  assert.deepEqual(r.cases, []);
});

test("parityBattery runs every case in PARITY_CASES, in order", async () => {
  // MUTATION: break out of the loop after the first case. 3 !== 1.
  const r = await parityBattery({
    origin: "https://x.test",
    fetchImpl: fakeSearchEndpoint({ plainRows: [prow("A")], directoryRows: [prow("A"), prow("B")] }),
  });
  assert.equal(r.skipped, false);
  assert.deepEqual(r.cases.map((c) => c.query), PARITY_CASES.map((c) => c.query));
});

test("validateReport rejects a report with no parity section at all", () => {
  /* The silent regression P-06 exists to prevent is not a wrong number, it is
     a section that quietly stopped being reported. MUTATION: drop the parity
     check from validateReport. Red. */
  const r = validReport();
  delete r.parity;
  assert.ok(validateReport(r).some((e) => /parity section/.test(e)));
});

test("validateReport rejects a populated parity section that lost a case", () => {
  // MUTATION: accept any non-empty cases array. Red.
  const r = validReport();
  r.parity = {
    skipped: false, reason: null,
    cases: [{ query: "tim ferriss", plain_rows: 1, directory_rows: 14, plain_titles: [], directory_titles: [] }],
  };
  assert.ok(validateReport(r).some((e) => /exactly 3 cases/.test(e)));
});

test("validateReport rejects a parity case reporting only the flagged column", () => {
  /* One count cannot show that the directory pass was inert, and that is the
     whole measurement. MUTATION: check only directory_rows. Red. */
  const r = validReport();
  r.parity = {
    skipped: false, reason: null,
    cases: PARITY_CASES.map((c) => ({ query: c.query, directory_rows: 14, plain_titles: [], directory_titles: [] })),
  };
  assert.ok(validateReport(r).some((e) => /plain_rows/.test(e)));
});

test("validateReport rejects a parity case that reports counts but no titles", () => {
  // MUTATION: drop the titles check. Red — and P-06 asked for titles by name.
  const r = validReport();
  r.parity = {
    skipped: false, reason: null,
    cases: PARITY_CASES.map((c) => ({ query: c.query, plain_rows: 1, directory_rows: 14 })),
  };
  assert.ok(validateReport(r).some((e) => /first-three titles/.test(e)));
});

test("formatTable says no coverage for a skipped parity section, never a fabricated row", () => {
  // MUTATION: print an empty table instead. Red.
  const out = formatTable({ ...validReport(), v: 3, run_at: "t", catalog_shows: 220 });
  assert.match(out, /parity cases \(§2\.1\): no coverage/);
});

test("formatTable calls out the inert-directory state in words, not only in a zero", () => {
  /* A column of zeroes in a gain column is easy to read past in a CI log.
     MUTATION: drop the every()-gain-zero line. Red. */
  const inert = PARITY_CASES.map((c) => ({
    query: c.query, target: c.target,
    plain_rows: 1, plain_titles: [c.target], plain_target_rank: 1,
    directory_rows: 1, directory_titles: [c.target], directory_target_rank: 1,
    gain: 0, fallthrough_attempted: false, plain_ms: 1, directory_ms: 1,
  }));
  const out = formatTable({
    ...validReport(), v: 3, run_at: "t", catalog_shows: 220,
    parity: { skipped: false, reason: null, cases: inert },
  });
  assert.match(out, /the directory pass is inert/);
});
