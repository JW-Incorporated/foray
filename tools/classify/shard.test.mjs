/* The shard key: balanced, stable, and a PARTITION rather than a filter.
   Run: node --test tools/classify/shard.test.mjs

   The balance tests run against the REAL data/catalog-breadth.json and
   data/breadth-classification.json, not a fixture, because the defect they
   pin is a property of actual Apple collection ids: `Number(id) % 6` looks
   fine in the abstract and is 2.20x unbalanced on the shows that remain.
   A synthetic id set would have hidden it, which is how it shipped.

   They assert RATIOS and floors, never exact counts. The eligible set shrinks
   every time a classify batch lands, so a pinned count would be red by
   tomorrow lunchtime for a reason that has nothing to do with sharding. */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { fnv1a32, shardOf, parseShard } from "./labels.mjs";
import { selectFreshCandidates } from "./select.mjs";
import { parseArgs } from "./prepare-batch.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const readJson = (...p) => JSON.parse(readFileSync(join(ROOT, ...p), "utf8"));

const catalog = readJson("data", "catalog-breadth.json");
const classification = readJson("data", "breadth-classification.json");

/** Every show this pipeline still has to pass over — the set the fleet's finish
    date is actually a function of. */
const remaining = catalog.shows.filter((s) => {
  const e = classification.entries[String(s.apple_collection_id)];
  return !(e && e.source && e.source.startsWith("classify-agent-"));
});

/** The subset a fresh batch can draw from (a feed URL is required to fetch signal). */
const eligible = remaining.filter((s) => s.feed_url);

const SHARDS = 6;

function histogram(shows, keyFn) {
  const counts = new Array(SHARDS).fill(0);
  for (const s of shows) counts[keyFn(String(s.apple_collection_id))]++;
  return counts;
}
const spread = (counts) => Math.max(...counts) / Math.min(...counts);

/* ---------- the data itself, so a failure below is legible ---------- */

test("the real catalogue is present and large enough to measure balance on", () => {
  assert.ok(catalog.shows.length > 19_000, `expected ~19,787 shows, saw ${catalog.shows.length}`);
  assert.ok(remaining.length > 5_000, `expected thousands still needing a pass, saw ${remaining.length}`);
  assert.ok(eligible.length > 5_000, `expected thousands eligible, saw ${eligible.length}`);
});

/* ---------- the defect this replaces ---------- */

test("Number(id) % 6 is badly unbalanced over the shows that remain — the defect", () => {
  // Measured 2026-08-16 over 17,936 remaining: shard0 1,514 (8.4%) against
  // shard3 3,334 (18.6%). Finish time is the LARGEST shard, so shard0 runs dry
  // around day 12 and idles for over half the blitz.
  const counts = histogram(remaining, (id) => Number(id) % SHARDS);
  assert.ok(
    spread(counts) > 1.5,
    `the modulo key is expected to be badly unbalanced (it was 2.20x); measured ${spread(counts).toFixed(3)} ` +
      `over ${remaining.length} shows: ${counts.join(", ")}. If this is now balanced the ids changed shape — ` +
      `re-measure before concluding the hashed key is unnecessary.`
  );
});

test("Number(id) % 6 is nearly balanced over the WHOLE catalogue — why the skew was missed", () => {
  // The skew is a property of the REMAINDER: the 1,851 shows already classified
  // were taken in ascending-id order, which drained one residue class first.
  const counts = histogram(catalog.shows, (id) => Number(id) % SHARDS);
  assert.ok(
    spread(counts) < 1.2,
    `expected the whole-catalogue modulo spread to look harmless (~1.04x); measured ${spread(counts).toFixed(3)}`
  );
});

/* ---------- the fix ---------- */

test("the hashed key balances the shows that remain to within 10%", () => {
  const counts = histogram(remaining, (id) => shardOf(id, SHARDS));
  assert.ok(
    spread(counts) < 1.1,
    `hashed shard spread over ${remaining.length} remaining shows is ${spread(counts).toFixed(3)} (want < 1.10): ${counts.join(", ")}`
  );
});

test("the hashed key balances the eligible set to within 10%", () => {
  const counts = histogram(eligible, (id) => shardOf(id, SHARDS));
  assert.ok(
    spread(counts) < 1.1,
    `hashed shard spread over ${eligible.length} eligible shows is ${spread(counts).toFixed(3)}: ${counts.join(", ")}`
  );
});

test("no shard is starved — every one carries at least 14% of the remaining work", () => {
  // The failure mode being pinned is not "uneven", it is "a routine with nothing
  // to do". An even sixth is 16.7%; below ~14% a shard finishes early and burns
  // its scheduled runs printing CLASSIFY_BATCH_EMPTY.
  const counts = histogram(remaining, (id) => shardOf(id, SHARDS));
  const total = counts.reduce((a, b) => a + b, 0);
  counts.forEach((n, i) => {
    const pct = (n / total) * 100;
    assert.ok(pct >= 14, `shard ${i} holds only ${pct.toFixed(1)}% of remaining work (${n}/${total})`);
  });
});

/* ---------- stability: a show must never migrate between shards ---------- */

test("no show migrates between shards as the rest of the catalogue is classified", () => {
  /* The review's explicit warning: do NOT use index-in-list modulo. The eligible
     list shrinks as work completes, so an index-derived shard would move a show
     between runs — reintroducing both duplicate work and permanent gaps.

     This drives the real SELECTOR twice, against two differently-sized worlds,
     rather than calling shardOf() twice and comparing it to itself. The first
     version of this test did the latter, which holds for every possible
     implementation — including a deliberately unstable one — and so could not
     have caught the thing it was named for. Caught in review. */
  const world = eligible.slice(0, 3_000);
  const now = Date.now();
  const progress = { in_flight: {}, failed_fetch: {} };

  const ownerBefore = new Map();
  for (let i = 0; i < SHARDS; i++) {
    for (const s of selectFreshCandidates(world, classification, progress, now, Infinity, 3, `${i}/${SHARDS}`)) {
      ownerBefore.set(String(s.apple_collection_id), i);
    }
  }
  assert.equal(ownerBefore.size, world.length);

  // Now classify 60% of them — which is exactly what happens over the blitz —
  // and re-run the selector over the smaller world that remains.
  const done = new Set(world.filter((_, i) => i % 5 !== 0).map((s) => String(s.apple_collection_id)));
  const after = {
    version: 1,
    entries: Object.fromEntries(
      Object.entries(classification.entries).concat([...done].map((id) => [id, { source: "classify-agent-tier1", needs_review: false }]))
    )
  };

  let checked = 0;
  for (let i = 0; i < SHARDS; i++) {
    for (const s of selectFreshCandidates(world, after, progress, now, Infinity, 3, `${i}/${SHARDS}`)) {
      const id = String(s.apple_collection_id);
      assert.equal(i, ownerBefore.get(id), `show ${id} moved from shard ${ownerBefore.get(id)} to shard ${i} when 60% of the list was classified`);
      checked++;
    }
  }
  assert.ok(checked > 500, `expected the surviving 40% to be checked, only saw ${checked}`);
});

test("shard assignment is stable across process runs (a pinned digest, not a self-comparison)", () => {
  /* Pinned literals, so a "harmless" change to the hash shows up as a failing test
     rather than as the whole fleet silently re-partitioning mid-blitz and re-doing
     work it had already merged. The digest is the load-bearing assertion: the
     first version of this test pinned only fnv1a32("") — the offset basis, i.e.
     trivially true of an empty input — and `f(x) === f(x)`. Caught in review. */
  assert.equal(fnv1a32(""), 0x811c9dc5, "empty input is the FNV offset basis");
  assert.equal(fnv1a32("1434243584"), 2_660_217_645, "a pinned digest of a real Apple collection id");
  assert.equal(fnv1a32("abc"), 440_920_331);
  assert.equal(shardOf("1434243584", 6), 3, "and therefore a pinned shard");
  assert.notEqual(fnv1a32("1434243584"), fnv1a32("1434243585"));
  assert.equal(shardOf("1434243584", 6), shardOf(1434243584, 6), "number and string ids must agree");
});

test("shardOf spreads consecutive ids, which is the case modulo handles worst", () => {
  const counts = new Array(SHARDS).fill(0);
  for (let id = 1_500_000_000; id < 1_500_006_000; id++) counts[shardOf(id, SHARDS)]++;
  assert.ok(spread(counts) < 1.15, `consecutive-id spread ${spread(counts).toFixed(3)}: ${counts.join(", ")}`);
});

test("shardOf refuses a nonsensical shard count instead of returning NaN", () => {
  assert.throws(() => shardOf("123", 0), /positive integer/);
  assert.throws(() => shardOf("123", -1), /positive integer/);
  assert.throws(() => shardOf("123", 2.5), /positive integer/);
});

/* ---------- sharding is a PARTITION, not a filter ---------- */

test("the six shards cover the whole eligible set, with nothing dropped", () => {
  const progress = { in_flight: {}, failed_fetch: {} };
  const seen = new Set();
  for (let i = 0; i < SHARDS; i++) {
    for (const s of selectFreshCandidates(eligible, classification, progress, Date.now(), Infinity, 3, `${i}/${SHARDS}`)) {
      seen.add(String(s.apple_collection_id));
    }
  }
  assert.equal(
    seen.size,
    eligible.length,
    `sharding lost ${eligible.length - seen.size} shows. Shards must partition the catalogue, never filter it.`
  );
});

test("the six shards are pairwise disjoint, so no show is classified twice", () => {
  const progress = { in_flight: {}, failed_fetch: {} };
  const owner = new Map();
  for (let i = 0; i < SHARDS; i++) {
    for (const s of selectFreshCandidates(eligible, classification, progress, Date.now(), Infinity, 3, `${i}/${SHARDS}`)) {
      const id = String(s.apple_collection_id);
      assert.ok(!owner.has(id), `show ${id} is claimed by both shard ${owner.get(id)} and shard ${i}`);
      owner.set(id, i);
    }
  }
});

test("an unsharded run still sees every eligible show", () => {
  const progress = { in_flight: {}, failed_fetch: {} };
  const all = selectFreshCandidates(eligible, classification, progress, Date.now(), Infinity, 3, null);
  assert.equal(all.length, eligible.length);
});

/* ---------- --shard now fails LOUD, where it used to fail open ---------- */

test("parseShard accepts a well-formed spec", () => {
  assert.deepEqual(parseShard("0/6"), { index: 0, count: 6 });
  assert.deepEqual(parseShard("5/6"), { index: 5, count: 6 });
  assert.deepEqual(parseShard(" 3 / 6 "), { index: 3, count: 6 });
});

test("parseShard treats a genuinely ABSENT flag as 'the whole catalogue'", () => {
  // The fail-loud direction matters: a bad shard refuses to RUN. It never drops
  // a show, and an omitted flag is still a legal, complete pass.
  assert.equal(parseShard(null), null);
  assert.equal(parseShard(undefined), null);
});

test('parseShard throws on "" — the unset-variable case, which is how a routine misconfigures', () => {
  /* A routine whose command reads `--shard "$SHARD"` with SHARD unset passes an
     empty string. Treating that as "the whole catalogue" is indistinguishable from
     a deliberate unsharded run and silently does six times the work — exactly the
     bug the fail-loud change exists to close. The first version of this suite
     actively blessed "" as deliberate. Caught in review. */
  assert.throws(() => parseShard(""), /empty value/);
  assert.throws(() => parseShard("   "), /empty value/);
});

test("parseArgs distinguishes a valueless --shard from an absent one", () => {
  // `--shard` written last, or immediately before another flag, must not read as
  // "no shard". parseArgs yields "", which parseShard then rejects.
  assert.equal(parseArgs(["--shard"]).shard, "", "a trailing --shard is present-but-valueless");
  assert.equal(parseArgs(["--shard", "--mode", "fresh"]).shard, "", "the next flag is not the shard's value");
  assert.equal(parseArgs(["--mode", "fresh"]).shard, null, "absent means absent");
  assert.equal(parseArgs(["--shard", "2/6"]).shard, "2/6");

  // And the two forms then diverge at parseShard, which is where main() checks.
  assert.throws(() => parseShard(parseArgs(["--shard"]).shard), /empty value/);
  assert.throws(() => parseShard(parseArgs(["--shard", "--mode", "fresh"]).shard), /empty value/);
  assert.equal(parseShard(parseArgs(["--mode", "fresh"]).shard), null);
  assert.deepEqual(parseShard(parseArgs(["--shard", "2/6"]).shard), { index: 2, count: 6 });
});

test("the numeric flags fail loud too, instead of becoming a silent empty batch", () => {
  // `--batch-size abc` used to become NaN, `slice(0, NaN)` became [], and the run
  // printed CLASSIFY_BATCH_EMPTY — a no-op that looks exactly like "the pass is
  // complete".
  assert.throws(() => parseArgs(["--batch-size", "abc"]), /positive integer/);
  assert.throws(() => parseArgs(["--batch-size", "0"]), /positive integer/);
  assert.throws(() => parseArgs(["--batch-size"]), /positive integer/);
  assert.throws(() => parseArgs(["--episodes-per-show", "-1"]), /positive integer/);
  assert.equal(parseArgs([]).batchSize, 60, "the default is the sharded-cadence batch size");
  assert.equal(parseArgs(["--batch-size", "45"]).batchSize, 45);
});

test("parseShard throws on 6/6 — the out-of-range typo that used to fail open", () => {
  assert.throws(() => parseShard("6/6"), /i must be < N/);
});

test("parseShard throws on garbage rather than silently running unsharded", () => {
  for (const bad of ["abc", "1", "/6", "6/", "1/2/3", "-1/6", "1.5/6", "1 6"]) {
    assert.throws(() => parseShard(bad), /--shard/, `expected ${JSON.stringify(bad)} to throw`);
  }
});

test("parseShard throws on 0/0 instead of processing everything six times over", () => {
  assert.throws(() => parseShard("0/0"), /--shard/);
});

test("selectFreshCandidates propagates a malformed --shard rather than running unsharded", () => {
  // This is the whole point of failing loud: one typo in one routine's config
  // used to mean that routine quietly re-did the entire catalogue.
  assert.throws(
    () => selectFreshCandidates(eligible.slice(0, 10), classification, { in_flight: {}, failed_fetch: {} }, Date.now(), 5, 3, "6/6"),
    /--shard/
  );
});
