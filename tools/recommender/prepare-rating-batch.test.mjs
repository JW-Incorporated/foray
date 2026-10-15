/* RV-08 (docs/roadmap/recommender-v1.md, D1, D7, D9): prepare-rating-batch.mjs.

   Fixtures only: the evidence sources are tools/recommender/fixtures/ (RV-03's),
   the gold set and the progress file are written to a fresh temp folder per
   test, and the persona profiles are the committed
   data/recommender/persona-profiles.json (read, never written). No network, no
   model call.

   Every test names the one-line mutation that turns it red; each was run. */

import { test } from "node:test";
import assert from "node:assert";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { STRIPPED_KEYS, loadSources } from "./evidence.mjs";
import { emptyProgress, lockPathFor, markRated } from "./progress.mjs";
import { eligibleShows, main, personaOrder, prepareBatch, progressKey } from "./prepare-rating-batch.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const FIX = path.join(HERE, "fixtures");
const ENV = {
  RECOMMENDER_CATALOG_PATH: path.join(FIX, "catalog.json"),
  RECOMMENDER_BREADTH_PATH: path.join(FIX, "catalog-breadth.json"),
  RECOMMENDER_CLASSIFICATION_PATH: path.join(FIX, "breadth-classification.json"),
  RECOMMENDER_EPISODE_ARCHIVE_PATH: path.join(FIX, "episode-archive.json.gz"),
  RECOMMENDER_AVAILABILITY_PATH: path.join(FIX, "no-such-transcript-availability.json"),
  RECOMMENDER_RSS_DIR: path.join(FIX, "rss"),
  RECOMMENDER_TRANSCRIPTS_DIR: path.join(FIX, "transcripts", "normalized"),
};
const PROFILES = path.join(ROOT, "data", "recommender", "persona-profiles.json");
const profilesDoc = () => JSON.parse(readFileSync(PROFILES, "utf8"));
const PERSONA_IDS = profilesDoc().personas.map((p) => p.id);
const NOW = Date.parse("2026-10-14T12:00:00Z");

/* The fixture shows with an evidence tier above none (RV-03's fixtures), plus
   444, whose tier is none. 999 is the breadth alias of tx-show, so it is left
   out, as RV-07's sampler would. */
const SET = {
  version: 1,
  mode: "pilot",
  seed: "test",
  shows: [
    { show_key: "111", roles: ["pilot", "retest"] },
    { show_key: "222", roles: ["pilot"] },
    { show_key: "444", roles: ["pilot"] },
    { show_key: "tx-show", roles: ["pilot", "retest", "isolated"] },
    { show_key: "333", roles: ["pilot", "isolated"] },
    { show_key: "note-only", roles: ["pilot", "holdout"] },
    { show_key: "555", roles: ["pilot", "retest"] },
    { show_key: "quiz-desk", roles: ["pilot"] },
    { show_key: "666", roles: ["pilot", "isolated"] },
    { show_key: "777", roles: ["gold"] },
  ],
};

function workspace() {
  const dir = mkdtempSync(path.join(tmpdir(), "rv08-"));
  const setPath = path.join(dir, "gold-set.json");
  writeFileSync(setPath, JSON.stringify(SET));
  const progressPath = path.join(dir, "rating-progress.json");
  const batchesDir = path.join(dir, "batches");
  const lines = [];
  const run = (...argv) =>
    main(["--set", setPath, "--progress", progressPath, "--batches-dir", batchesDir, ...argv], {
      root: ROOT,
      env: ENV,
      now: NOW,
      log: (m) => lines.push(m),
      error: (m) => lines.push(`ERR ${m}`),
    });
  const batches = () => (existsSync(batchesDir) ? readdirSync(batchesDir).map((f) => JSON.parse(readFileSync(path.join(batchesDir, f), "utf8"))) : []);
  const progress = () => JSON.parse(readFileSync(progressPath, "utf8"));
  return { dir, setPath, progressPath, batchesDir, lines, run, batches, progress, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const prepare = (progress, opts) =>
  prepareBatch({
    set: SET,
    progress,
    profilesDoc: profilesDoc(),
    profilesSha256: "0".repeat(64),
    profilesPath: "data/recommender/persona-profiles.json",
    rubricPath: "docs/curation/rating-rubric-v1.md",
    sources: loadSources({ env: ENV }),
    role: "pilot",
    now: NOW,
    ...opts,
  });

const keysOf = (batch) => batch.shows.map((s) => s.show_key).sort();

/* Mutation: delete the `reserve(progress, ...)` line in prepareBatch -- the
   progress file has no in_flight entries and the second run picks the same
   three shows. */
test("reserves the batch's keys and a second run skips them", () => {
  const w = workspace();
  try {
    assert.equal(w.run("--role", "pilot", "--batch-size", "3"), 0);
    const [first] = w.batches();
    const inFlight = w.progress().in_flight;
    assert.deepEqual(Object.keys(inFlight).sort(), keysOf(first));
    for (const k of keysOf(first)) {
      assert.equal(inFlight[k].batch_id, first.batch_id);
      assert.equal(inFlight[k].reserved_at, new Date(NOW).toISOString());
    }
    assert.equal(w.run("--role", "pilot", "--batch-size", "3"), 0);
    const all = w.batches();
    assert.equal(all.length, 2);
    const second = all.find((b) => b.batch_id !== first.batch_id);
    assert.equal(keysOf(second).filter((k) => keysOf(first).includes(k)).length, 0, "the second batch never repeats an in-flight show");
    assert.equal(Object.keys(w.progress().in_flight).length, 6);
  } finally {
    w.done();
  }
});

/* Mutation: delete `if (pass > 1 && !roles.includes("retest")) continue;` in
   eligibleShows -- pass 2 picks 222 and quiz-desk, which are not retest shows. */
test("pass 2 selects only retest shows", () => {
  const progress = emptyProgress();
  markRated(progress, SET.shows.map((s) => s.show_key), { pass: 1, batchId: "pilot-1-joint-20261013-aaaaaaaa" });
  const { batch } = prepare(progress, { pass: 2 });
  assert.deepEqual(keysOf(batch), ["111", "555", "tx-show"]);
  assert.equal(batch.pass, 2);
  // A retest show not yet rated at pass 1 waits for it.
  const fresh = emptyProgress();
  markRated(fresh, ["111"], { pass: 1 });
  assert.deepEqual(eligibleShows(SET, fresh, { role: "pilot", pass: 2 }), ["111"]);
});

/* Mutation: `const listed = pid ? [pid] : personaIds;` -> `const listed =
   personaIds;` -- every show lists all 13 personas. */
test("isolated mode lists exactly one persona", () => {
  const pid = PERSONA_IDS[4];
  const { batch } = prepare(emptyProgress(), { mode: `isolated:${pid}` });
  assert.deepEqual(keysOf(batch), ["333", "666", "tx-show"], "only isolated shows");
  assert.equal(batch.mode, `isolated:${pid}`);
  for (const order of Object.values(batch.persona_order)) assert.deepEqual(order, [pid]);
  assert.match(batch.batch_id, /^pilot-1-isolated-[a-z0-9-]+-20261014-[0-9a-f]{8}$/, "no colon in the id: it is a file name");
  // An unknown persona refuses to build anything.
  assert.throws(() => prepare(emptyProgress(), { mode: "isolated:no-such-persona" }), /not a persona/);
});

/* Mutation: personaOrder returns `personaIds.slice()` (identity order) -- every
   show's list equals the profiles order. */
test("persona order is shuffled per show and seeded", () => {
  const a = prepare(emptyProgress(), {}).batch;
  const b = prepare(emptyProgress(), {}).batch;
  assert.equal(JSON.stringify(a), JSON.stringify(b), "the same inputs build a byte-identical batch");
  const orders = Object.values(a.persona_order).map((o) => o.join(","));
  assert.equal(new Set(orders).size, orders.length, "each show gets its own order");
  for (const o of Object.values(a.persona_order)) assert.deepEqual([...o].sort(), [...PERSONA_IDS].sort(), "a permutation of every persona");
  assert.ok(orders.every((o) => o !== PERSONA_IDS.join(",")), "never the profiles order");
  assert.deepEqual(personaOrder(PERSONA_IDS, "x", "111"), personaOrder(PERSONA_IDS, "x", "111"));
  assert.notDeepEqual(personaOrder(PERSONA_IDS, "x", "111"), personaOrder(PERSONA_IDS, "y", "111"));
  // Shows are position-shuffled, not set order.
  assert.notDeepEqual(a.shows.map((s) => s.show_key), eligibleShows(SET, emptyProgress(), { role: "pilot" }).filter((k) => k !== "444"));
});

/* Mutation: delete the `if (shard && shardOf(...) !== shard.index) continue;`
   line -- every shard run returns every key, so the shards overlap. */
test("shards partition: i/n over n runs covers every key once", () => {
  const set = { shows: Array.from({ length: 60 }, (_, i) => ({ show_key: String(1000 + i), roles: ["gold"] })) };
  for (const count of [2, 3, 5]) {
    const seen = [];
    for (let index = 0; index < count; index++) {
      const part = eligibleShows(set, emptyProgress(), { role: "gold", shard: { index, count } });
      assert.ok(part.length > 0, `shard ${index}/${count} is not empty`);
      seen.push(...part);
    }
    assert.deepEqual([...seen].sort(), set.shows.map((s) => s.show_key).sort(), `n=${count}: every key exactly once`);
  }
});

/* Mutation: delete `profiles_sha256: profilesSha256,` from the batch object --
   the batch carries no hash. */
test("the batch records the profiles sha256", () => {
  const w = workspace();
  try {
    assert.equal(w.run("--role", "pilot", "--batch-size", "2"), 0);
    const [batch] = w.batches();
    assert.equal(batch.profiles_sha256, createHash("sha256").update(readFileSync(PROFILES)).digest("hex"));
    assert.equal(batch.profiles_path, "data/recommender/persona-profiles.json");
    assert.equal(batch.rubric_path, "docs/curation/rating-rubric-v1.md");
    assert.equal(batch.rubric_version, 1);
    assert.ok(existsSync(path.join(ROOT, batch.rubric_path)), "the rubric path names a committed file");
  } finally {
    w.done();
  }
});

/* Mutation: delete the `if (args.dryRun) { ... return 0; }` branch -- the dry
   run writes the batch and the progress file. */
test("--dry-run reserves nothing", () => {
  const w = workspace();
  try {
    assert.equal(w.run("--role", "pilot", "--batch-size", "3", "--dry-run"), 0);
    assert.equal(existsSync(w.progressPath), false, "no progress file written");
    assert.deepEqual(w.batches(), [], "no batch file written");
    assert.match(w.lines.join("\n"), /dry run: would write .*rating-batch-pilot-1-joint-20261014-[0-9a-f]{8}\.json \(3 shows, ~\d+ tokens/);
  } finally {
    w.done();
  }
});

/* Mutation: in main, `return prepareLocked();` instead of through
   withProgressLock -- the prepare reserves and writes a batch while a merge
   holds the progress lock, and one of the two loses the other's records. */
test("a prepare holds the progress lock: refused and unwritten while another holds it", () => {
  const w = workspace();
  try {
    mkdirSync(lockPathFor(w.progressPath)); // a merge holds it
    const code = main(["--set", w.setPath, "--progress", w.progressPath, "--batches-dir", w.batchesDir, "--role", "pilot", "--batch-size", "3"], {
      root: ROOT,
      env: ENV,
      now: NOW,
      log: (m) => w.lines.push(m),
      error: (m) => w.lines.push(`ERR ${m}`),
      lockWaitMs: 100,
    });
    assert.equal(code, 1);
    assert.match(w.lines.join("\n"), /ERR .*rating-progress\.json is locked/);
    assert.equal(existsSync(w.progressPath), false, "nothing reserved");
    assert.deepEqual(w.batches(), [], "no batch file written");

    rmSync(lockPathFor(w.progressPath), { recursive: true });
    assert.equal(w.run("--role", "pilot", "--batch-size", "3"), 0);
    assert.equal(Object.keys(w.progress().in_flight).length, 3);
    assert.equal(existsSync(lockPathFor(w.progressPath)), false, "the prepare releases its lock");
  } finally {
    w.done();
  }
});

/* Mutation: progressKey returns `String(showKey)` for every mode -- the second
   persona's isolated batch finds every show in flight and builds nothing. */
test("isolated reservations are per persona and never block a joint pass", () => {
  const progress = emptyProgress();
  const a = prepare(progress, { mode: `isolated:${PERSONA_IDS[0]}` });
  const b = prepare(progress, { mode: `isolated:${PERSONA_IDS[1]}` });
  assert.deepEqual(keysOf(b.batch), keysOf(a.batch), "a second persona rates the same isolated shows side by side");
  assert.ok(progress.in_flight[progressKey("tx-show", `isolated:${PERSONA_IDS[0]}`)]);
  assert.equal(progressKey("tx-show", `isolated:${PERSONA_IDS[0]}`), `tx-show@isolated:${PERSONA_IDS[0]}`);
  const joint = prepare(progress, {});
  assert.ok(keysOf(joint.batch).includes("tx-show"), "the joint pass is not blocked by isolated reservations");
});

/* Mutation: `packs.push(raterPack(pack))` -> `packs.push(pack)` -- the audit
   list `stripped` (and the stripped key names in it) reaches the rater. */
test("the batch carries rater packs: no stripped list, no hidden keys", () => {
  const { batch } = prepare(emptyProgress(), { batchSize: 20 });
  const text = JSON.stringify(batch);
  assert.ok(!text.includes('"stripped"'), "no audit list in the batch");
  for (const k of STRIPPED_KEYS) assert.ok(!text.includes(`"${k}":`), `the batch never carries ${k}`);
});

/* Mutation: delete the `if (pack.tier === "none") { ... continue; }` block --
   444 is packed and reserved. */
test("a show at evidence tier none is skipped and never reserved", () => {
  const progress = emptyProgress();
  const { batch, skippedNone } = prepare(progress, { batchSize: 20 });
  assert.deepEqual(skippedNone, ["444"]);
  assert.ok(!keysOf(batch).includes("444"));
  assert.ok(!("444" in progress.in_flight));
  assert.equal(batch.shows.length, 8, "the batch fills from the rest of the set");
});
