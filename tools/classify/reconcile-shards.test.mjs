/* Shard reconciliation — two jobs, and both are the point.
 *
 *   1. Prove the MERGE SEMANTICS, against fixtures: that it is a true union,
 *      that disjointness is enforced rather than assumed, and that nothing is
 *      ever dropped. Every guard is exercised by deliberately violating it and
 *      asserting the merge refuses and writes nothing — a checker only ever run
 *      on good data is not a checker.
 *
 *      Disjointness in particular can only be tested here. Once the shards are
 *      merged into one object, an id physically cannot appear twice, so the
 *      merged file carries no evidence of a collision that was resolved. The
 *      collision has to be caught at merge time or not at all.
 *
 *   2. Gate the COMMITTED data: every one of the 19,787 shows still has a
 *      non-empty `topics` and a `source`, every topic id is a real taxonomy
 *      node, no demoted topic overlaps a live one, and the numbers this file's
 *      own `provenance.reconciled_shards` block advertises agree with what is
 *      actually in it. A provenance block that can drift from its file is a
 *      claim, not a record.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  reconcile,
  auditNoRegression,
  isAgentRow,
  laneOf,
  keyForRow,
  laneForRow,
  keysForRow,
  shardIndexOf,
  SHARD_KEY_CUTOVER,
  DEFAULT_SHARDS,
  DEFAULT_SHARD_COUNT
} from "./reconcile-shards.mjs";
import { shardOf } from "./labels.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));

/* ------------------------------------------------------------- fixtures */

const agent = (over = {}) => ({
  topics: ["science"],
  confidence: "high",
  source: "classify-agent-tier1",
  topic_confidences: [{ node: "science", confidence: 0.9 }],
  needs_review: false,
  rationale: "A reason.",
  display_title: "A Show",
  blurb: "A blurb about the show.",
  display_copy_ok: true,
  tier: 1,
  batch_id: "b1",
  classified_at: "2026-08-16T00:00:00.000Z",
  ...over
});
const genre = (topics) => ({ topics, confidence: "low", source: "genre-map" });

/* Ids chosen so their lane is THE SAME UNDER BOTH SHARD KEYS: for each of these,
   `Number(id) % 6` and `fnv1a32(String(id)) % 6` agree. That keeps every fixture
   below independent of which era a row is dated into, so the negative lane tests
   mean what they say. PR #203 changed the key mid-flight, and the era-specific
   behaviour has its own tests (`keyForRow`, `laneForRow`, and the pre/post
   cutover pair) using ids where the two keys deliberately DISAGREE. Pinned by
   the fixture-integrity test immediately below. */
const ID = { l0: "1008", l1: "1003", l2: "1004", l3: "1023", l4: "1000", l5: "1007", l0b: "1026" };

function baseFile(over = {}) {
  return {
    version: 1,
    built_at: "2026-08-01T00:00:00.000Z",
    provenance: { produced_by: "tools/classify/merge-results.mjs" },
    entries: {
      [ID.l0]: genre(["science", "nature"]),
      [ID.l1]: genre(["food"]),
      [ID.l2]: genre(["history"]),
      [ID.l3]: agent({ topics: ["music"], batch_id: "incumbent" }),
      [ID.l4]: { topics: ["comedy"], source: "llm-title-genre", confidence: "low" },
      [ID.l5]: genre(["sports"]),
      ...over
    }
  };
}
const shard = (i, entries, over = {}) => ({ branch: `reclassify-${i}`, index: i, head: `h${i}`, file: { version: 1, entries }, ...over });

const TAX = new Set(["science", "nature", "food", "history", "music", "comedy", "sports", "space", "food/grilling-bbq"]);

const run = (base, shards, opts = {}) => reconcile({ base, shards, shardCount: DEFAULT_SHARD_COUNT, taxonomyIds: TAX, ...opts });

/* ------------------------------------------------- 0. the fixtures hold */

test("every fixture id lands in the same lane under BOTH shard keys", () => {
  /* If this fails, the negative lane tests below stop testing anything: an id
     whose modulo lane and hashed lane differ is legitimately in two lanes, so
     it can never be "off-lane" for either of them. Pick new ids rather than
     relaxing this. */
  for (const [name, id] of Object.entries(ID)) {
    assert.equal(laneOf(id, DEFAULT_SHARD_COUNT), shardOf(id, DEFAULT_SHARD_COUNT), `fixture ${name} (${id}) is ambiguous`);
  }
  // and they cover all six lanes, so "every lane rejects every other" is real
  const lanes = ["l0", "l1", "l2", "l3", "l4", "l5"].map((k) => laneOf(ID[k], DEFAULT_SHARD_COUNT));
  assert.deepEqual(lanes, [0, 1, 2, 3, 4, 5]);
  assert.equal(laneOf(ID.l0b, DEFAULT_SHARD_COUNT), 0, "l0b must share l0's lane");
});

/* ------------------------------------------------- 1. the union itself */

test("a shard agent row replaces a base-layer row", () => {
  const { entries, errors } = run(baseFile(), [shard(0, { [ID.l0]: agent({ topics: ["space"] }) })]);
  assert.deepEqual(errors, []);
  assert.equal(entries[ID.l0].source, "classify-agent-tier1");
  assert.deepEqual(entries[ID.l0].topics, ["space"]);
});

test("a base row for a show no shard touched is preserved unchanged", () => {
  const base = baseFile();
  const { entries } = run(base, [shard(0, { [ID.l0]: agent({ topics: ["space"] }) })]);
  assert.deepEqual(entries[ID.l1], base.entries[ID.l1]);
  assert.deepEqual(entries[ID.l5], base.entries[ID.l5]);
});

test("an OLDER agent re-pass never displaces the incumbent", () => {
  const base = baseFile();
  const older = agent({ topics: ["food"], batch_id: "repass", classified_at: "2026-08-01T00:00:00.000Z" });
  const { entries, stats } = run(base, [shard(3, { [ID.l3]: older })]);
  assert.deepEqual(entries[ID.l3], base.entries[ID.l3], "incumbent must win");
  assert.equal(entries[ID.l3].batch_id, "incumbent");
  assert.equal(stats.shards[0].incumbent_kept, 1);
  assert.equal(stats.adopted_total, 0);
  assert.equal(stats.refreshed_total, 0);
});

test("an equal timestamp keeps the incumbent, so an inherited row never churns", () => {
  /* Shards 1..5 each carry 144 rows inherited byte-identically from
     `origin/reclassify`. They must be no-ops, not re-adoptions. */
  const base = baseFile();
  const same = { ...base.entries[ID.l3] };
  const { entries, stats } = run(base, [shard(3, { [ID.l3]: same })]);
  assert.deepEqual(entries[ID.l3], base.entries[ID.l3]);
  assert.equal(stats.shards[0].incumbent_kept, 1);
  assert.equal(stats.shards[0].refreshed, 0);
});

test("a NEWER agent re-pass refreshes the incumbent and is counted separately", () => {
  const base = baseFile();
  const newer = agent({ topics: ["food"], batch_id: "repass", classified_at: "2026-08-20T00:00:00.000Z" });
  const { entries, stats } = run(base, [shard(3, { [ID.l3]: newer })]);
  assert.equal(entries[ID.l3].batch_id, "repass");
  assert.deepEqual(entries[ID.l3].topics, ["food"]);
  assert.equal(stats.shards[0].refreshed, 1);
  assert.equal(stats.refreshed_total, 1);
  assert.equal(stats.adopted_total, 0, "a refresh adds no NEW agent row");
  assert.equal(stats.agent_rows_after, stats.baseline.agent_rows, "the agent count must not move on a refresh");
});

test("a refresh still demotes what it displaced, even against another agent row", () => {
  const base = baseFile();
  const newer = agent({ topics: ["food"], batch_id: "repass", classified_at: "2026-08-20T00:00:00.000Z" });
  const { entries } = run(base, [shard(3, { [ID.l3]: newer })]);
  assert.deepEqual(entries[ID.l3].superseded_topics, ["music"]);
  assert.equal(entries[ID.l3].superseded_source, "classify-agent-tier1");
});

test("a re-pass with no timestamp on either side keeps the incumbent", () => {
  const base = baseFile({ [ID.l3]: agent({ topics: ["music"], batch_id: "incumbent", classified_at: undefined }) });
  const { entries, stats } = run(base, [shard(3, { [ID.l3]: agent({ topics: ["food"], classified_at: undefined }) })]);
  assert.equal(entries[ID.l3].batch_id, "incumbent");
  assert.equal(stats.refreshed_total, 0);
});

test("a newer re-pass is lane-checked like any other adoption", () => {
  const base = baseFile();
  const newer = agent({ topics: ["food"], classified_at: "2026-08-20T00:00:00.000Z" });
  const { entries, errors } = run(base, [shard(1, { [ID.l3]: newer })]);
  assert.equal(entries, null);
  assert.match(errors[0], /fall outside lane 1/);
});

test("an INHERITED off-lane row is exempt from the lane check", () => {
  /* Shards 1..5 carry 144 rows each inherited from `origin/reclassify`, and
     reclassify-0 carries 1,807 — they span every lane. Byte-identical means
     the shard never ran it, so it is not off-lane work. */
  const base = baseFile();
  const inherited = { ...base.entries[ID.l3] };
  const { entries, errors, stats } = run(base, [shard(1, { [ID.l3]: inherited })]);
  assert.deepEqual(errors, []);
  assert.deepEqual(entries[ID.l3], base.entries[ID.l3]);
  assert.equal(stats.shards[0].incumbent_kept, 1);
  assert.equal(stats.shards[0].off_lane, 0);
});

test("an off-lane row that DIFFERS is caught even when its timestamp is OLDER", () => {
  /* The exemption is byte-identity, not "not newer". An older-but-different
     off-lane row is still evidence the shard worked outside its slice, and
     an earlier draft of this file let it through silently. */
  const base = baseFile();
  const older = agent({ topics: ["food"], classified_at: "2026-01-01T00:00:00.000Z" });
  const { entries, errors } = run(base, [shard(1, { [ID.l3]: older })]);
  assert.equal(entries, null, "an off-lane difference must abort, not be discarded quietly");
  assert.match(errors[0], /fall outside lane 1/);
  assert.match(errors[0], /lane 1/);
});

test("an off-lane row that differs is caught on an EQUAL timestamp too", () => {
  const base = baseFile();
  const same = agent({ topics: ["food"], classified_at: base.entries[ID.l3].classified_at });
  const { entries, errors } = run(base, [shard(1, { [ID.l3]: same })]);
  assert.equal(entries, null);
  assert.match(errors[0], /fall outside lane 1/);
});

test("an IN-LANE row that differs but is not newer keeps the incumbent, quietly", () => {
  const base = baseFile();
  const older = agent({ topics: ["food"], classified_at: "2026-01-01T00:00:00.000Z" });
  const { entries, errors, stats } = run(base, [shard(3, { [ID.l3]: older })]);
  assert.deepEqual(errors, [], "in its own lane, an older re-pass is a no-op, not an error");
  assert.deepEqual(entries[ID.l3], base.entries[ID.l3]);
  assert.equal(stats.shards[0].incumbent_kept, 1);
});

test("the entry count never changes and no id is dropped", () => {
  const base = baseFile();
  const { entries } = run(base, [
    shard(0, { [ID.l0]: agent({ topics: ["space"] }) }),
    shard(1, { [ID.l1]: agent({ topics: ["food"] }) })
  ]);
  assert.equal(Object.keys(entries).length, Object.keys(base.entries).length);
  for (const id of Object.keys(base.entries)) assert.ok(id in entries, `${id} dropped`);
});

test("all six shards merge into one file, each contributing its own lane", () => {
  const shards = [0, 1, 2, 3, 4, 5].map((i) =>
    shard(i, { [ID["l" + i]]: agent({ topics: ["space"], batch_id: `s${i}` }) })
  );
  const { entries, stats, errors } = run(baseFile(), shards);
  assert.deepEqual(errors, []);
  assert.equal(stats.adopted_total, 5, "lane 3 is an incumbent, so five adoptions");
  for (const i of [0, 1, 2, 4, 5]) assert.equal(entries[ID["l" + i]].batch_id, `s${i}`);
  assert.equal(entries[ID.l3].batch_id, "incumbent");
});

test("the headline numbers are internally consistent", () => {
  const { stats } = run(baseFile(), [
    shard(0, { [ID.l0]: agent({ topics: ["space"] }) }),
    shard(1, { [ID.l1]: agent({ topics: ["food"] }) })
  ]);
  assert.equal(stats.adopted_total, stats.shards.reduce((n, s) => n + s.adopted, 0));
  assert.equal(stats.agent_rows_after, stats.baseline.agent_rows + stats.adopted_total);
  assert.equal(stats.no_agent_pass, stats.entries - stats.agent_rows_after);
});

test("re-running against its own output adopts nothing more (idempotent)", () => {
  const base = baseFile();
  const shards = [shard(0, { [ID.l0]: agent({ topics: ["space"] }) })];
  const first = run(base, shards);
  const second = run({ ...base, entries: first.entries }, shards);
  assert.deepEqual(second.errors, []);
  assert.equal(second.stats.adopted_total, 0);
  assert.deepEqual(second.entries, first.entries);
});

/* --------------------------- 2. cross-shard conflicts resolve, disjointness within the resolved set is still checked */

test("two shards claiming the same show resolves by newest classified_at, not a fatal error", () => {
  /* SUPERSEDED 2026-08-31 (rule 3b, see reconcile-shards.mjs header): a
     cross-shard double-claim is no longer treated as an unexplainable
     collision requiring a human — it is resolved exactly like an
     agent-vs-incumbent conflict (rule 3), newest `classified_at` wins. This
     reflects reality found in the live branches on 2026-08-31: ~30 real
     double-claims, all produced by the legacy/hashed key split (rule 4), each
     with a genuine days-to-weeks timestamp gap, not a coin-flip tie. */
  const laneless = (name, entries) => ({ branch: name, index: null, head: name, file: { version: 1, entries } });
  const { entries, errors, stats } = run(baseFile(), [
    laneless("classify-a", { [ID.l0]: agent({ topics: ["space"], batch_id: "a", classified_at: "2026-08-10T00:00:00.000Z" }) }),
    laneless("classify-b", { [ID.l0]: agent({ topics: ["food"], batch_id: "b", classified_at: "2026-08-20T00:00:00.000Z" }) })
  ]);
  assert.deepEqual(errors, []);
  assert.deepEqual(entries[ID.l0].topics, ["food"], "the newer claim (classify-b) wins");
  assert.equal(stats.cross_shard_conflicts.length, 1);
  assert.equal(stats.cross_shard_conflicts[0].winner, "classify-b");
});

test("a cross-shard conflict tie (equal or missing timestamps) keeps the first-seen claim, never guesses beyond that", () => {
  const laneless = (name, entries) => ({ branch: name, index: null, head: name, file: { version: 1, entries } });
  const { entries, stats } = run(baseFile(), [
    laneless("classify-a", { [ID.l0]: agent({ topics: ["space"], batch_id: "a", classified_at: null }) }),
    laneless("classify-b", { [ID.l0]: agent({ topics: ["food"], batch_id: "b", classified_at: null }) })
  ]);
  assert.deepEqual(entries[ID.l0].topics, ["space"], "no signal to break the tie: first-seen (classify-a) is kept, not overwritten");
  assert.equal(stats.cross_shard_conflicts[0].winner, "classify-a");
});

test("an off-lane show is fatal — this is the issue-#203 fail-open guard", () => {
  /* A shard whose `--shard` argument did not expand selected from the WHOLE
     catalogue, so its rows land in every residue, not just its own. */
  const { entries, errors } = run(baseFile(), [shard(0, { [ID.l1]: agent({ topics: ["food"] }) })]);
  assert.equal(entries, null);
  assert.match(errors[0], /fall outside lane 0/);
  assert.match(errors[0], /#203/);
});

test("every lane rejects every other lane's shows", () => {
  for (const claim of [0, 1, 2, 3, 4, 5]) {
    for (const actual of [0, 1, 2, 3, 4, 5]) {
      if (claim === actual || actual === 3) continue; // lane 3's fixture is an incumbent
      const { errors } = run(baseFile(), [shard(claim, { [ID["l" + actual]]: agent({ topics: ["space"] }) })]);
      assert.equal(errors.length, 1, `shard ${claim} accepted a lane-${actual} show`);
      assert.match(errors[0], new RegExp(`fall outside lane ${claim}`));
    }
  }
});

test("a shard that ran unsharded has every foreign lane reported", () => {
  const wholeCatalogue = {};
  for (const k of ["l0", "l1", "l2", "l4", "l5"]) wholeCatalogue[ID[k]] = agent({ topics: ["space"] });
  const { entries, errors } = run(baseFile(), [shard(2, wholeCatalogue)]);
  assert.equal(entries, null);
  assert.equal(errors.length, 1, "one error per branch now, listing every foreign row");
  assert.match(errors[0], /4 of 5 of its own rows fall outside lane 2/);
  assert.ok(errors.every((e) => /fall outside lane/.test(e)));
});

test("off-lane rows are counted per shard so the report names the culprit", () => {
  /* Errors abort the merge, so the count is read off the error list itself. */
  const { errors } = run(baseFile(), [
    shard(4, { [ID.l0]: agent({ topics: ["space"] }), [ID.l1]: agent({ topics: ["food"] }) })
  ]);
  assert.equal(errors.length, 1);
  assert.ok(errors[0].startsWith("reclassify-4:"));
  assert.match(errors[0], /2 of 2 of its own rows/);
});

/* ------------------------------------------------- 3. refusing bad input */

test("an incoming row with empty topics is refused, not merged", () => {
  const { entries, errors } = run(baseFile(), [shard(0, { [ID.l0]: agent({ topics: [] }) })]);
  assert.equal(entries, null);
  assert.match(errors[0], /empty topics/);
});

test("an unknown taxonomy node is fatal", () => {
  const { entries, errors } = run(baseFile(), [shard(0, { [ID.l0]: agent({ topics: ["food/bakin"] }) })]);
  assert.equal(entries, null);
  assert.match(errors[0], /unknown taxonomy node "food\/bakin"/);
});

test("a show the base catalogue does not contain is refused, never invented", () => {
  const { entries, errors } = run(baseFile(), [shard(0, { "1200": agent({ topics: ["space"] }) })]);
  assert.equal(entries, null);
  assert.match(errors[0], /not in the base catalogue/);
});

test("an unreadable shard file is an error, not a silent skip", () => {
  const { errors } = run(baseFile(), [{ branch: "reclassify-0", index: 0, file: null }]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /unreadable classification file/);
});

test("the taxonomy check can be skipped, and then unknown nodes pass through", () => {
  const { errors } = reconcile({
    base: baseFile(),
    shards: [shard(0, { [ID.l0]: agent({ topics: ["anything"] }) })],
    taxonomyIds: null
  });
  assert.deepEqual(errors, []);
});

/* --------------------------- 4. the reclassify-2 shape: no base layers */

test("a shard file carrying ONLY agent rows contributes them and removes nothing", () => {
  /* reclassify-2's file is 2,988 entries, all `classify-agent-tier1`, with no
     genre-map or llm-title-genre rows — commit cd36248 rewrote the file
     instead of merging into it. Merging into the base rather than checking
     its file out is what makes that harmless. */
  const base = baseFile();
  const { entries, stats, errors } = run(base, [shard(2, { [ID.l2]: agent({ topics: ["history"], batch_id: "s2" }) })]);
  assert.deepEqual(errors, []);
  assert.equal(Object.keys(entries).length, Object.keys(base.entries).length);
  assert.equal(entries[ID.l2].batch_id, "s2");
  assert.equal(stats.shards[0].carries_base_layers, false, "the anomaly must be reported, not hidden");
  for (const id of [ID.l0, ID.l1, ID.l4, ID.l5]) {
    assert.deepEqual(entries[id], base.entries[id], `${id} lost its base layer`);
  }
});

test("carries_base_layers is true for a normally-shaped shard file", () => {
  const { stats } = run(baseFile(), [shard(0, { [ID.l0]: agent({ topics: ["space"] }), [ID.l0b]: genre(["food"]) })]);
  assert.equal(stats.shards[0].carries_base_layers, true);
});

/* -------------------------------- 5. nothing may lose a classification */

test("a base topic the agent row does not carry is demoted, not deleted", () => {
  const { entries } = run(baseFile(), [shard(0, { [ID.l0]: agent({ topics: ["space"] }) })]);
  assert.deepEqual(entries[ID.l0].topics, ["space"]);
  assert.deepEqual(entries[ID.l0].superseded_topics, ["science", "nature"]);
  assert.equal(entries[ID.l0].superseded_source, "genre-map");
});

test("superseded_topics is absent when the agent row keeps every base topic", () => {
  const { entries, stats } = run(baseFile(), [shard(0, { [ID.l0]: agent({ topics: ["science", "nature", "space"] }) })]);
  assert.ok(!("superseded_topics" in entries[ID.l0]));
  assert.equal(stats.superseded_rows, 0);
});

test("superseded_topics never overlaps topics", () => {
  const { entries } = run(baseFile(), [shard(0, { [ID.l0]: agent({ topics: ["science", "space"] }) })]);
  assert.deepEqual(entries[ID.l0].superseded_topics, ["nature"]);
  for (const t of entries[ID.l0].superseded_topics) assert.ok(!entries[ID.l0].topics.includes(t));
});

test("the demotion is not a union — the coarse secondary stays out of topics", () => {
  /* PR #198 measured that writing the genre map's whole topic list onto a
     judged row makes classification worse (root-only pairs 9,741 -> 10,502). */
  const { entries } = run(baseFile(), [shard(4, { [ID.l4]: agent({ topics: ["food/grilling-bbq"] }) })]);
  assert.deepEqual(entries[ID.l4].topics, ["food/grilling-bbq"]);
  assert.equal(entries[ID.l4].superseded_source, "llm-title-genre");
});

test("topic_count_vs_base counts all three directions", () => {
  const { stats } = run(baseFile(), [
    shard(0, { [ID.l0]: agent({ topics: ["space"] }) }),                     // 2 -> 1
    shard(1, { [ID.l1]: agent({ topics: ["food"] }) }),                      // 1 -> 1
    shard(2, { [ID.l2]: agent({ topics: ["history", "science"] }) })          // 1 -> 2
  ]);
  assert.deepEqual(stats.topic_count_vs_base, { fewer: 1, same: 1, more: 1 });
});

/* ------------------------------------ 6. the copy-flag normalisation */

test("a missing display_title cannot also be display_copy_ok", () => {
  const { entries, stats } = run(baseFile(), [shard(0, { [ID.l0]: agent({ topics: ["space"], display_title: null }) })]);
  assert.equal(entries[ID.l0].display_copy_ok, false);
  assert.equal(entries[ID.l0].needs_review, true);
  assert.ok(entries[ID.l0].display_copy_notes.includes("display_title: missing"));
  assert.equal(stats.display_flags_normalised, 1);
});

test("a missing blurb is normalised the same way", () => {
  const { entries } = run(baseFile(), [shard(0, { [ID.l0]: agent({ topics: ["space"], blurb: "   " }) })]);
  assert.equal(entries[ID.l0].display_copy_ok, false);
  assert.ok(entries[ID.l0].display_copy_notes.includes("blurb: missing"));
});

test("a row already flagged display_copy_ok:false is left alone and not re-counted", () => {
  const row = agent({ topics: ["space"], display_title: null, display_copy_ok: false, display_copy_notes: ["display_title: missing"] });
  const { entries, stats } = run(baseFile(), [shard(0, { [ID.l0]: row })]);
  assert.equal(stats.display_flags_normalised, 0);
  assert.deepEqual(entries[ID.l0].display_copy_notes, ["display_title: missing"]);
});

test("a well-formed row is not touched by the normaliser", () => {
  const { entries, stats } = run(baseFile(), [shard(0, { [ID.l0]: agent({ topics: ["space"] }) })]);
  assert.equal(stats.display_flags_normalised, 0);
  assert.equal(entries[ID.l0].display_copy_ok, true);
  assert.equal(entries[ID.l0].needs_review, false);
  assert.ok(!("_normalised" in entries[ID.l0]));
});

/* ------------------------------------------------ 7. the helpers */

test("isAgentRow accepts any agent tier and rejects everything else", () => {
  assert.equal(isAgentRow({ source: "classify-agent-tier1" }), true);
  assert.equal(isAgentRow({ source: "classify-agent-tier2" }), true);
  assert.equal(isAgentRow({ source: "genre-map" }), false);
  assert.equal(isAgentRow({ source: "llm-title-genre" }), false);
  assert.equal(isAgentRow({}), false, "a sourceless row is not an agent row");
  assert.equal(isAgentRow(null), false);
});

test("laneOf mirrors prepare-batch's `Number(id) % N === i`", () => {
  assert.equal(laneOf("600", 6), 0);
  assert.equal(laneOf("1459232606", 6), 1459232606 % 6);
  assert.equal(laneOf("not-a-number", 6), null);
  assert.equal(laneOf("600", 0), null);
});

test("keyForRow reads the era off the row's own classified_at", () => {
  /* PR #203 changed the shard key at SHARD_KEY_CUTOVER. A row selected before it
     was sharded by the legacy modulo key, one selected after by the hash. */
  assert.equal(keyForRow({ classified_at: "2026-08-16T00:00:00.000Z" }).name, "legacy");
  assert.equal(keyForRow({ classified_at: "2026-08-18T00:00:00.000Z" }).name, "hashed");
  assert.equal(keyForRow({ classified_at: SHARD_KEY_CUTOVER }).name, "hashed", "the cutover instant itself is post-change");
});

test("a row with no timestamp reads legacy, not hashed", () => {
  /* Defaulting to hashed would reject the entire existing corpus: every row that
     predates the classified_at field also predates the key change. */
  assert.equal(keyForRow({}).name, "legacy");
  assert.equal(keyForRow(null).name, "legacy");
  assert.equal(keyForRow({ classified_at: 12345 }).name, "legacy");
});

test("laneForRow places a row by its own era's key", () => {
  const id = "1459232606";
  assert.notEqual(laneOf(id, 6), shardOf(id, 6), "this id must differ across the keys for the test to mean anything");
  assert.equal(laneForRow(id, { classified_at: "2026-08-16T00:00:00.000Z" }, 6), laneOf(id, 6));
  assert.equal(laneForRow(id, { classified_at: "2026-08-18T00:00:00.000Z" }, 6), shardOf(id, 6));
});

test("a POST-cutover row is lane-checked by the hashed key, and accepted", () => {
  /* The regression this guards: checking the legacy key for everything would
     reject every row a post-#203 batch produces. */
  const base = baseFile();
  let id = null;
  for (let n = 100000; n < 300000; n++) {
    const k = String(n);
    if (shardOf(k, 6) === 0 && laneOf(k, 6) !== 0) { id = k; break; }
  }
  assert.ok(id, "expected an id the hash puts in lane 0 and modulo does not");
  base.entries[id] = genre(["science"]);
  const row = agent({ topics: ["space"], classified_at: "2026-08-20T00:00:00.000Z" });
  const { entries, errors } = run(base, [shard(0, { [id]: row })]);
  assert.deepEqual(errors, [], "a post-cutover row must be judged by the hashed key");
  assert.equal(entries[id].source, "classify-agent-tier1");
});

test("a row placed in-lane by EITHER key is accepted, even if its era 'should' use the other one", () => {
  /* SUPERSEDED 2026-08-31 (see reconcile-shards.mjs PASS 1a/1b and rule 4's
     doc comment): the original design judged a row by ONE key, chosen from
     its own `classified_at` against the #203 cutover instant. Measured
     2026-08-31, that assumption is false for five of the six live branches —
     their committed `prepare-batch.mjs` never merged #203 and computes the
     legacy key unconditionally regardless of when a row was produced, so a
     row's timestamp says nothing reliable about which key selected it.
     `keysForRow()` now tries both and accepts a match from either — this
     row's hashed lane is 0 (matching this shard) even though its timestamp
     predates the cutover, and that is exactly the shape of row the live
     fleet actually produces, so it must be accepted, not rejected. */
  const base = baseFile();
  let id = null;
  for (let n = 100000; n < 300000; n++) {
    const k = String(n);
    if (shardOf(k, 6) === 0 && laneOf(k, 6) !== 0) { id = k; break; }
  }
  base.entries[id] = genre(["science"]);
  const row = agent({ topics: ["space"], classified_at: "2026-08-10T00:00:00.000Z" });
  const { entries, errors } = run(base, [shard(0, { [id]: row })]);
  assert.deepEqual(errors, [], "either key matching this shard's lane is enough, regardless of the row's era");
  assert.equal(entries[id].source, "classify-agent-tier1");
});

test("a row off-lane under BOTH keys is still fatal — the real #203 fail-open guard", () => {
  /* This is the case that must never slip through: a row that is off-lane no
     matter which key placed it is exactly what an unsharded (`--shard` failed
     open) run produces. */
  const base = baseFile();
  let id = null;
  // Find an id that is off-lane-0 under BOTH keys.
  for (let n = 100000; n < 300000; n++) {
    const k = String(n);
    if (shardOf(k, 6) !== 0 && laneOf(k, 6) !== 0) { id = k; break; }
  }
  assert.ok(id, "expected an id off-lane-0 under both keys");
  base.entries[id] = genre(["science"]);
  const row = agent({ topics: ["space"], classified_at: "2026-08-10T00:00:00.000Z" });
  const { entries, errors } = run(base, [shard(0, { [id]: row })]);
  assert.equal(entries, null, "a row off-lane under both keys must still be refused");
  assert.match(errors[0], /fall outside lane 0/);
});

test("keysForRow: returns both keys when they agree, one when only one matches, none when neither does", () => {
  const id = "1459232606"; // legacy and hashed lanes deliberately differ for this id (asserted above)
  const legacyLane = laneOf(id, 6);
  const hashedLane = shardOf(id, 6);
  assert.notEqual(legacyLane, hashedLane);
  const legacyMatches = keysForRow(id, {}, 6, legacyLane).map((k) => k.name);
  assert.deepEqual(legacyMatches, ["legacy"]);
  const hashedMatches = keysForRow(id, {}, 6, hashedLane).map((k) => k.name);
  assert.deepEqual(hashedMatches, ["hashed"]);
  const neitherLane = [0, 1, 2, 3, 4, 5].find((l) => l !== legacyLane && l !== hashedLane);
  assert.deepEqual(keysForRow(id, {}, 6, neitherLane), []);
});

test("a MIXED-ERA branch merges, because each row is judged by its own key", () => {
  /* This is what every branch becomes from the next shard run onward, and it is
     why a per-BRANCH purity rule was rejected: it would refuse this. */
  const base = baseFile();
  let hashedId = null;
  for (let n = 100000; n < 300000; n++) {
    const k = String(n);
    if (shardOf(k, 6) === 0 && laneOf(k, 6) !== 0) { hashedId = k; break; }
  }
  base.entries[hashedId] = genre(["science"]);
  const { entries, errors, stats } = run(base, [
    shard(0, {
      [ID.l0]: agent({ topics: ["space"], classified_at: "2026-08-10T00:00:00.000Z" }),   // legacy era
      [hashedId]: agent({ topics: ["nature"], classified_at: "2026-08-20T00:00:00.000Z" }) // hashed era
    })
  ]);
  assert.deepEqual(errors, [], "a legacy/hashed mixture on one branch is legitimate");
  assert.equal(stats.adopted_total, 2);
  assert.equal(stats.shards[0].shard_key, "hashed+legacy", "the report must name both eras");
  assert.deepEqual(entries[ID.l0].topics, ["space"]);
  assert.deepEqual(entries[hashedId].topics, ["nature"]);
});

test("the error message names the era, so a lane failure is diagnosable", () => {
  const base = baseFile();
  const { errors } = run(base, [shard(1, { [ID.l0]: agent({ topics: ["space"] }) })]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /reclassify-1: 1 of 1 of its own rows fall outside lane 1/);
  assert.match(errors[0], /legacy lane 0/);
  assert.match(errors[0], /#203/);
});

test("shardIndexOf reads the lane off the branch name", () => {
  assert.equal(shardIndexOf("reclassify-4"), 4);
  assert.equal(shardIndexOf("reclassify"), null);
  assert.equal(DEFAULT_SHARDS.map(shardIndexOf).join(","), "0,1,2,3,4,5");
  assert.equal(DEFAULT_SHARDS.length, DEFAULT_SHARD_COUNT);
});

/* -------------------------------- 8. the no-regression audit itself */

test("auditNoRegression is clean for a correct merge", () => {
  const base = baseFile();
  const { entries } = run(base, [shard(0, { [ID.l0]: agent({ topics: ["space"] }) })]);
  assert.deepEqual(auditNoRegression(base, entries), []);
});

test("auditNoRegression catches a dropped entry", () => {
  const base = baseFile();
  const entries = { ...base.entries };
  delete entries[ID.l1];
  assert.deepEqual(auditNoRegression(base, entries), [`${ID.l1}: entry dropped`]);
});

test("auditNoRegression catches an emptied topics list", () => {
  const base = baseFile();
  const entries = { ...base.entries, [ID.l1]: { ...base.entries[ID.l1], topics: [] } };
  assert.match(auditNoRegression(base, entries)[0], /ends with no topics/);
});

test("auditNoRegression catches a lost source", () => {
  const base = baseFile();
  const entries = { ...base.entries, [ID.l1]: { topics: ["food"] } };
  assert.match(auditNoRegression(base, entries)[0], /ends with no source/);
});

test("auditNoRegression catches an agent row downgraded to a base layer", () => {
  const base = baseFile();
  const entries = { ...base.entries, [ID.l3]: genre(["music"]) };
  assert.match(auditNoRegression(base, entries)[0], /lost its agent classification/);
});

test("auditNoRegression catches a topic that vanished with nowhere to be found", () => {
  const base = baseFile();
  const entries = { ...base.entries, [ID.l0]: agent({ topics: ["space"] }) }; // no superseded_topics
  assert.match(auditNoRegression(base, entries)[0], /topics vanished entirely: science, nature/);
});

test("auditNoRegression accepts a topic demoted into superseded_topics", () => {
  const base = baseFile();
  const entries = { ...base.entries, [ID.l0]: agent({ topics: ["space"], superseded_topics: ["science", "nature"] }) };
  assert.deepEqual(auditNoRegression(base, entries), []);
});

/* --------------------------------- 9. the CLI, end to end via --from-dir */

/* `--from-dir` exists so the CLI can be driven with no git refs and no
 * network. These run the real binary in a temp dir, because `parseArgs`'s
 * refuse-rather-than-guess behaviour and the write path are the parts a unit
 * test of `reconcile()` cannot reach. */
const CLI = path.join(ROOT, "tools", "classify", "reconcile-shards.mjs");

/* `t.after` rather than a trailing rmSync: a failing assertion used to leak the
   mkdtemp directory, and a test suite that litters /tmp on every red run is its
   own small mess. */
function cliFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reconcile-cli-"));
  if (t) t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const base = baseFile();
  fs.writeFileSync(path.join(dir, "base.json"), JSON.stringify(base, null, 2) + "\n");
  fs.mkdirSync(path.join(dir, "shards"));
  for (const i of [0, 1, 2, 3, 4, 5]) {
    const entries = i === 0 ? { [ID.l0]: agent({ topics: ["space"], batch_id: "cli" }) } : {};
    fs.writeFileSync(path.join(dir, "shards", `reclassify-${i}.json`), JSON.stringify({ version: 1, entries }, null, 2) + "\n");
  }
  fs.writeFileSync(path.join(dir, "taxonomy.json"), JSON.stringify({ nodes: [...TAX].map((id) => ({ id })) }, null, 2) + "\n");
  return dir;
}

function runCli(dir, args, opts = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      BREADTH_CLASSIFICATION_PATH: path.join(dir, "base.json"),
      TAXONOMY_PATH: path.join(dir, "taxonomy.json"),
      ...opts.env
    }
  });
}

test("CLI: --from-dir merges without touching git, and writes the file", (t) => {
  const dir = cliFixture(t);
  const r = runCli(dir, ["--from-dir", path.join(dir, "shards")]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /agent-classified 1 -> 2/);
  const out = JSON.parse(fs.readFileSync(path.join(dir, "base.json"), "utf8"));
  assert.equal(out.entries[ID.l0].batch_id, "cli");
  assert.equal(out.provenance.reconciled_shards.adopted_total, 1);
  assert.equal(out.provenance.reconciled_shards.shards.length, 6);
});

test("CLI: --dry-run reports the same numbers and writes nothing", (t) => {
  const dir = cliFixture(t);
  const before = fs.readFileSync(path.join(dir, "base.json"), "utf8");
  const r = runCli(dir, ["--from-dir", path.join(dir, "shards"), "--dry-run"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /--dry-run: nothing written/);
  assert.equal(fs.readFileSync(path.join(dir, "base.json"), "utf8"), before, "--dry-run wrote to the file");
});

test("CLI: re-running is idempotent, byte for byte except built_at", (t) => {
  const dir = cliFixture(t);
  runCli(dir, ["--from-dir", path.join(dir, "shards")]);
  const first = JSON.parse(fs.readFileSync(path.join(dir, "base.json"), "utf8"));
  runCli(dir, ["--from-dir", path.join(dir, "shards")]);
  const second = JSON.parse(fs.readFileSync(path.join(dir, "base.json"), "utf8"));
  assert.deepEqual(second.entries, first.entries);
  assert.equal(second.provenance.reconciled_shards.adopted_total, 0, "the second run adopts nothing");
});

test("CLI: an unknown option is refused, not ignored", (t) => {
  const dir = cliFixture(t);
  const r = runCli(dir, ["--from-dir", path.join(dir, "shards"), "--batch-size", "60"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown option "--batch-size"/);
});

test("CLI: an empty --shards list is refused rather than writing a no-op file", (t) => {
  /* `--shards ""` used to filter down to zero branches and then write a file
     whose provenance recorded six shards as `[]` — a run that looks like it
     succeeded and reconciled nothing. */
  const dir = cliFixture(t);
  const before = fs.readFileSync(path.join(dir, "base.json"), "utf8");
  const r = runCli(dir, ["--from-dir", path.join(dir, "shards"), "--shards", ""]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no shard branches/i);
  assert.equal(fs.readFileSync(path.join(dir, "base.json"), "utf8"), before);
});

test("CLI: a non-numeric --shard-count is refused", (t) => {
  const dir = cliFixture(t);
  const r = runCli(dir, ["--from-dir", path.join(dir, "shards"), "--shard-count", "abc"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--shard-count/);
});

test("CLI: an off-lane shard file aborts with exit 1 and writes nothing", (t) => {
  const dir = cliFixture(t);
  const before = fs.readFileSync(path.join(dir, "base.json"), "utf8");
  fs.writeFileSync(
    path.join(dir, "shards", "reclassify-1.json"),
    JSON.stringify({ version: 1, entries: { [ID.l0]: agent({ topics: ["space"] }) } }, null, 2) + "\n"
  );
  const r = runCli(dir, ["--from-dir", path.join(dir, "shards")]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /fall outside lane/);
  assert.equal(fs.readFileSync(path.join(dir, "base.json"), "utf8"), before);
});

/* ================================================================ */
/* 10. THE GATE — the committed data itself.                         */
/* ================================================================ */

const FILE = readJson("data/breadth-classification.json");
const TAXONOMY = new Set(readJson("data/taxonomy.json").nodes.map((n) => n.id));
const REC = FILE.provenance?.reconciled_shards ?? null;

test("every catalogued show still has a non-empty topics list and a source", () => {
  const bad = [];
  for (const [id, e] of Object.entries(FILE.entries)) {
    if (!Array.isArray(e?.topics) || e.topics.length === 0) bad.push(`${id}: no topics`);
    else if (typeof e.source !== "string" || !e.source) bad.push(`${id}: no source`);
  }
  assert.deepEqual(bad.slice(0, 20), [], `${bad.length} shows lost their classification`);
});

test("every topic id in the breadth file is a real taxonomy node", () => {
  const bad = new Map();
  for (const [id, e] of Object.entries(FILE.entries)) {
    for (const t of e.topics ?? []) if (!TAXONOMY.has(t)) bad.set(t, (bad.get(t) ?? 0) + 1);
    for (const t of e.superseded_topics ?? []) if (!TAXONOMY.has(t)) bad.set(`superseded:${t}`, (bad.get(`superseded:${t}`) ?? 0) + 1);
    void id;
  }
  assert.deepEqual([...bad.entries()], [], "unknown taxonomy nodes in data/breadth-classification.json");
});

test("no demoted topic is also a live topic on the same show", () => {
  const bad = [];
  for (const [id, e] of Object.entries(FILE.entries)) {
    for (const t of e.superseded_topics ?? []) if (e.topics.includes(t)) bad.push(`${id}: ${t}`);
  }
  assert.deepEqual(bad, []);
});

test("superseded_source names a layer that actually exists in this pipeline", () => {
  const KNOWN = new Set(["genre-map", "llm-title-genre", "classify-agent-tier1", "classify-agent-tier2"]);
  const seen = new Set();
  for (const e of Object.values(FILE.entries)) if ("superseded_source" in e) seen.add(e.superseded_source);
  assert.ok(seen.size > 0, "the merge demoted nothing at all, which contradicts superseded_rows");
  for (const s of seen) assert.ok(KNOWN.has(s), `unknown superseded_source: ${s}`);
});

test("a row carrying superseded_topics carries a non-empty list", () => {
  const bad = [];
  for (const [id, e] of Object.entries(FILE.entries)) {
    if ("superseded_topics" in e && (!Array.isArray(e.superseded_topics) || e.superseded_topics.length === 0)) bad.push(id);
  }
  assert.deepEqual(bad, []);
});

/* FLOORS, committed as constants for the same reason `test/suite-integrity.js`
 * commits suite counts: a number that lives only in the file it describes
 * cannot catch that file shrinking. These are NOT read from the file.
 *
 * Raise them when a classify batch legitimately lands more. Never lower one
 * without saying why in the commit message — a drop means shows lost their
 * classification, which is the one thing this pipeline may never do. */
const FLOOR = {
  entries: 19787,      // the breadth catalogue. Exact: nothing may leave it.
  agent_rows: 19278,   // reconciled 2026-08-17 from the six shard branches
};

test("the catalogue is exactly its committed size — nothing may leave it", () => {
  assert.equal(Object.keys(FILE.entries).length, FLOOR.entries);
});

test("agent-classified shows never drop below the committed floor", () => {
  const agentRows = Object.keys(FILE.entries).filter((id) => isAgentRow(FILE.entries[id])).length;
  assert.ok(
    agentRows >= FLOOR.agent_rows,
    `agent-classified shows fell to ${agentRows}, below the committed floor of ${FLOOR.agent_rows}. ` +
    "A classification was lost. If this is a deliberate re-baseline, say why and raise the floor."
  );
});

/* The rest of this block describes the reconciliation EVENT, not the current
 * file, so it is asserted only while the record is present. It can legitimately
 * go absent or go stale: `merge-results.mjs` rewrites `built_at` and the
 * counts on every batch, and only spreads `provenance` (fixed in this change)
 * rather than preserving the numbers. So these must never be gates on the
 * live counts — the floors above are. */
test("the reconciliation record, if present, is internally consistent", () => {
  if (!REC) return; // a later batch may have rewritten provenance; the floors still hold
  assert.equal(REC.baseline.agent_rows + REC.adopted_total, REC.agent_rows_after, "the union does not add up");
  assert.equal(REC.shards.reduce((n, s) => n + s.adopted, 0), REC.adopted_total, "the per-shard adoptions do not sum to the total");
  assert.equal(REC.shards.reduce((n, s) => n + s.refreshed, 0), REC.refreshed_total, "the per-shard refreshes do not sum to the total");
  assert.equal(REC.baseline.entries, FLOOR.entries);
  assert.equal(REC.adopted_total + REC.refreshed_total, REC.rows_replaced, "rows_replaced must be adoptions plus refreshes");
});

test("the reconciliation record, if present, names all six shards one per lane", () => {
  if (!REC) return;
  assert.equal(REC.shard_count, DEFAULT_SHARD_COUNT);
  assert.deepEqual(REC.shards.map((s) => s.branch), DEFAULT_SHARDS);
  assert.deepEqual(REC.shards.map((s) => s.lane), [0, 1, 2, 3, 4, 5]);
  for (const s of REC.shards) assert.ok(s.head, `${s.branch} has no recorded head commit`);
});

test("every agent row sits in some lane of the recorded shard count", () => {
  /* The merged object cannot show a collision, but it CAN show an id that no
     shard's lane covers — which would mean the recorded provenance is fiction. */
  const shardCount = REC?.shard_count ?? DEFAULT_SHARD_COUNT;
  const lanes = new Set(REC ? REC.shards.map((s) => s.lane) : [0, 1, 2, 3, 4, 5]);
  const bad = [];
  for (const id of Object.keys(FILE.entries)) {
    if (!isAgentRow(FILE.entries[id])) continue;
    if (!lanes.has(laneForRow(id, FILE.entries[id], shardCount))) bad.push(id);
  }
  assert.deepEqual(bad, [], "agent rows outside every recorded shard lane");
});
