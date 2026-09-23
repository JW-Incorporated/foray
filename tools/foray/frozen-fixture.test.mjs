/* The FROZEN fixture — `tools/foray/fixtures/frozen/` — held to what it claims
 * to be (#236's last step, 2026-09-22).
 *
 * WHY IT EXISTS. `data/forays.json` is live curation, and six suites used
 * specific live Forays as their fixture: `grilling-history-1` (a draft kept,
 * superseded, for no reason but its shape), `grilling-history-2`,
 * `capital-types-1` and `what-engineers-actually-do-all-day-e08236`. Measured
 * before this change: deleting `grilling-history-1` alone turned 92 tests red
 * across `player/foray-playback.test.js` (80), `player/foray-sources.test.js`
 * (3), `player/media-session.test.js` (1), `test/foray-row-links.test.js` (1),
 * `tools/foray/fixture-coverage.test.mjs` (1) and
 * `tools/foray/check-forays.test.mjs` (6); deleting `capital-types-1` turned 37
 * red. So no Foray could be retired or re-curated without a governed-test
 * migration — backwards for the product's core activity. The fixture is a
 * VERBATIM copy of those four Forays plus exactly the pool rows and episodes
 * they play, and the suites that need a particular shape read it instead.
 *
 * WHAT THIS FILE PINS, so the fixture cannot rot into something a suite is
 * quietly more forgiving of than the real data (CLAUDE.md, "A green test is
 * not evidence until you have broken it"):
 *   1. it passes the real checker, CLI and all, with zero errors — so every
 *      suite that reads it is reading a Foray the publish gate would accept;
 *   2. it is self-contained and minimal: every played segment and its episode
 *      are present, and nothing else is — a stray row would be a second,
 *      unreviewed copy of live data that nobody plays;
 *   3. it still carries the shapes the suites need, named by id;
 *   4. `TEXTURE_CADENCE_SEC` is still what `measure-cadence.mjs` measures on
 *      the Foray it cites, now that that Foray exists only here.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { checkForays, loadFiles } from "./check-forays.mjs";
import { computeCadence, FROZEN_ROOT } from "./measure-cadence.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const frozen = loadFiles(FROZEN_ROOT);
const forays = frozen.forays.forays;

test("the frozen fixture is where measure-cadence and the suites look for it", () => {
  assert.equal(path.resolve(FROZEN_ROOT), path.join(HERE, "fixtures", "frozen"));
  assert.ok(forays.length > 0, "the frozen fixture holds no Forays");
});

test("the frozen fixture passes the real checker with zero errors, and the CLI exits 0 on it", () => {
  /* MUTATION: delete one pool row a frozen Foray plays from
     fixtures/frozen/data/segments.json -> both halves go red. */
  const { errors } = checkForays(frozen);
  assert.deepEqual(errors, [], errors.join("\n"));
  const out = execFileSync(process.execPath, [path.join(HERE, "check-forays.mjs"), "--root", FROZEN_ROOT], { encoding: "utf8" });
  assert.match(out, /forays ok/);
});

test("the frozen fixture is self-contained and minimal: exactly the rows and episodes its Forays play", () => {
  /* MUTATION: append any live pool row to fixtures/frozen/data/segments.json
     -> "unplayed pool rows" names it. */
  const played = new Set(forays.flatMap((f) => f.items.filter((i) => i.type === "segment").map((i) => i.segment_id)));
  const pool = frozen.segments.segments.map((s) => s.id);
  assert.deepEqual(pool.filter((id) => !played.has(id)), [], "unplayed pool rows in the frozen fixture");
  assert.deepEqual([...played].filter((id) => !pool.includes(id)), [], "played segments missing from the frozen pool");
  const episodes = new Set(frozen.segments.segments.map((s) => s.item_id));
  const registered = frozen.sources.sources.map((s) => s.id);
  assert.deepEqual(registered.filter((id) => !episodes.has(id)), [], "episodes no frozen row cuts from");
  assert.deepEqual([...episodes].filter((id) => !registered.includes(id)), [], "frozen rows whose episode is not registered");
  const topics = new Set((frozen.taxonomy?.nodes || []).map((n) => n.id));
  for (const f of forays) assert.ok(topics.has(f.topic), `${f.id}'s topic ${f.topic} is not in the frozen taxonomy`);
});

test("the frozen fixture still carries the shapes the suites that read it need", () => {
  /* Named by id, deliberately: these are the ids the suites open, and a frozen
     fixture is the one place where a pinned id costs nothing — it never
     changes editorially. Each shape is the reason a suite reads it:
       grilling-history-1  long, unbridged, multi-episode (foray-playback's
                           transport tests; foray-sources; measure-cadence),
                           and superseded (check-forays' supersession rule)
       grilling-history-2  short, with cross-episode seams (the speed tests)
       capital-types-1     published, and two episodes of one show
                           (segment-strip's capsule tests)
       what-engineers-…    generated, ~40 narration items (segment-strip §8) */
  const by = (id) => forays.find((f) => f.id === id);
  const g1 = by("grilling-history-1");
  assert.ok(g1 && g1.items.length >= 30 && g1.items.every((i) => i.type === "segment"), "grilling-history-1: long and unbridged");
  assert.equal(g1.superseded_by, "grilling-history-2");
  assert.ok(by("grilling-history-2"), "grilling-history-2");
  assert.equal(by("capital-types-1")?.status, "published");
  const gen = by("what-engineers-actually-do-all-day-e08236");
  assert.ok(gen?.generated && gen.items.filter((i) => i.type === "narration").length >= 20, "a generated Foray with its narration");
});

test("TEXTURE_CADENCE_SEC is still what measure-cadence measures on the Foray it cites", () => {
  /* The constant's provenance note (backend/src/generation/stitchAct.ts) cites
     a measurement on grilling-history-1: 17 cut-gaps, median 155.34 s, mean
     216.06 s, rounded down to 155. That Foray now exists only in the frozen
     fixture, so this is the test that keeps the note TRUE — re-run from the
     repo, not remembered. Read from the TypeScript source by pattern because
     this suite has no TS toolchain (backend's own suite pins the constant's
     value; this pins where it came from).

     MUTATION: change TEXTURE_CADENCE_SEC to 156 -> red. */
  const { cutGaps, median, mean, totalRuntimeSec } = computeCadence(frozen.forays, frozen.segments, "grilling-history-1");
  assert.equal(cutGaps.length, 17);
  assert.ok(Math.abs(median - 155.34) < 0.005, `median is ${median}, the citation says 155.34`);
  assert.ok(Math.abs(mean - 216.06) < 0.005, `mean is ${mean}, the citation says 216.06`);
  assert.ok(Math.abs(totalRuntimeSec - 3673.03) < 0.005, `runtime is ${totalRuntimeSec}`);
  const src = fs.readFileSync(path.join(REPO_ROOT, "backend/src/generation/stitchAct.ts"), "utf8");
  const constant = /export const TEXTURE_CADENCE_SEC = (\d+);/.exec(src);
  assert.ok(constant, "TEXTURE_CADENCE_SEC is no longer a plain exported constant in stitchAct.ts");
  assert.equal(Number(constant[1]), Math.floor(median), "the constant is the measured median rounded down");
});
