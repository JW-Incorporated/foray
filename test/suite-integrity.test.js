/* Guard on the guards.
 *
 * WHY THIS EXISTS
 * `test/`, `player/` and `tools/` are in the auto-merge allowlist
 * (.github/workflows/automerge-nightly.yml), so an agent-authored PR touching
 * them can land with no human read. That creates one specific hole the path
 * allowlist cannot close by itself: a PR that DELETES or GUTS a test suite
 * still passes CI, because a suite with nothing in it passes trivially. The
 * attack (or, far more likely, the accident) is two steps — weaken the gate in
 * PR 1, land the thing it would have caught in PR 2 — and nothing between those
 * two steps involves a human.
 *
 * So: every suite carries a committed floor. Removing tests fails the build.
 *
 * ADDING tests is always fine and never requires touching this file. Raising a
 * floor is encouraged when a suite grows meaningfully. LOWERING one is the
 * deliberate act this file exists to make visible — do it in a PR that says why,
 * and note that this file is itself allowlisted, so the honest protection here
 * is that gutting the gate now requires editing two files instead of one, in a
 * diff that the weekly merge audit surfaces.
 *
 * This is a floor, not a coverage metric. It cannot tell a real test from
 * `test("x", () => {})`. It only makes deletion loud.
 *
 * WHY `tools/` IS SCANNED, AND SCANNED RECURSIVELY (issue #137)
 * This file shipped covering only `player/` and `test/`, which left the exact
 * hole it was written to close: `tools/` is Tier 3 of the same allowlist, and
 * `tools/refresh/*.test.mjs` had no floor and was not discovered either. A bot
 * PR could have gutted the refresh-pipeline tests, passed CI and auto-merged.
 *
 * The scan is recursive rather than a flat readdir of three directories
 * because `tools/` is a tree, not a folder: work lands in `tools/refresh/`,
 * `tools/segments/`, `tools/transcribe/` and whatever comes next. A flat scan
 * would have to be edited every time a subdirectory appeared, which is the
 * same "someone has to remember" failure that produced this issue. Recursing
 * means the NEXT suite is caught the day it lands, by a check nobody had to
 * update.
 *
 * A scanned directory that does not exist yet is not a failure — see
 * findSuites(). Several `tools/` subtrees are being created right now, and a
 * check that hard-failed on their absence would be red for reasons unrelated
 * to test integrity. The failing direction that matters is the other one: a
 * suite that EXISTS on disk with no committed floor.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

/* suite -> minimum number of top-level test() declarations. */
const FLOORS = {
  /* The durable store (#40). Both of these guard against silent DATA LOSS
     rather than a wrong answer on screen, which makes them the two suites in
     `player/` whose deletion would be hardest to notice: everything keeps
     rendering, and a listener's place quietly stops surviving the week. */
  "player/durable-store.test.js": 74,
  "player/idb-tier.test.js": 23,
  "player/foray-playback.test.js": 62,
  "player/foray-progress.test.js": 58,
  "player/foray-queue.test.js": 29,
  "player/foray-resolve.test.js": 42,
  "player/foray-sources.test.js": 24,
  "player/html-audio-backend.test.js": 83,
  /* The lock screen and the car (#27). Floored high on purpose: four product
     decisions live in that module — publisher credit in `artist`, previous/next
     as segments, the Foray's clock in `setPositionState`, and a seam beat that
     reports PLAYING — and every one of them is a single-line edit away from its
     opposite, on a surface nobody sees in a browser tab.

     **Zero slack, deliberately.** The first draft floored it at 110 against 116
     actual, and the pre-push review proved what that bought: all four pins could
     be deleted and the floor stayed green — the exact failure this file exists to
     make loud. Raise it when the suite grows. */
  "player/media-session.test.js": 129,
  "player/queue-manager.test.js": 89,
  "player/queue-state.test.js": 56,
  "player/seam-gap.test.js": 16,
  "player/seek-policy.test.js": 33,
  "test/app-security.test.js": 20,
  /* "Delete my data" (#42). Zero slack, like media-session above and for the same
     reason: what this suite guards is a PROMISE — both tiers cleared, the server
     rows really deleted, no success message over a failure, and a confirmation a
     stray tap cannot satisfy. Every one of those is one edit from its opposite,
     and the published privacy policy and Play declaration both now rest on them.
     A deleted test here is a false statement in a store submission. */
  "test/data-deletion.test.js": 51,
  /* The standing gate on topic ids in `data/*.json`. Floored because the metric
     it protects is gameable in exactly one direction: a misspelled `food/bakin`
     reads as "has a child" to the root-dumping report and silently erases a
     root-only pair, so a deleted gate would make the number look better. */
  "test/data-topic-integrity.test.js": 12,
  // tools/ is allowlisted for auto-merge too (T3 in automerge-nightly.yml),
  // so suites under it need the same floor.
  "tools/ci/path-policy.test.mjs": 82,
  "tools/ci/pr-triage.test.mjs": 85,
  "tools/ci/run-suites.test.mjs": 36,
  // The classify fleet. `no-exclusion` is the founder's "label, never filter"
  // ruling made mechanical — of everything floored in this file it is the one
  // whose deletion would be hardest to notice and most expensive to discover,
  // because the thing it guards is an absence.
  "tools/classify/no-exclusion.test.mjs": 25,
  "tools/classify/reconcile-shards.test.mjs": 72,
  /* Guards the metric the whole classification effort is judged on. Its per-item
     ("fully root-only") number is the one that maps to product behaviour; the
     pair count is not, and #205 measured why. A deleted suite here would let the
     definition drift silently, which is how a metric stops meaning anything. */
  "tools/classify/root-dumping-report.test.mjs": 31,
  "tools/classify/shard.test.mjs": 23,
  "tools/classify/transcript-label.test.mjs": 29,
  /* The destructive-rewrite guard. `classify-breadth.mjs` rebuilt
     data/breadth-classification.json from scratch until 2026-08; running that
     version today would delete 19,278 agent rows and leave valid JSON and a
     green CI behind it. This suite is the reason that cannot come back. */
  "tools/classify-breadth.test.mjs": 29,
  "tools/foray/check-forays.test.mjs": 81,
  /* The native shell (#36). `shell-invariants` is the one to be most careful
     with: four of the five things it pins are properties of files OUTSIDE
     tools/ — the root package.json staying dependency-free, index.html's CSP,
     app.js not registering a service worker in the shell, and the repo's ios/
     scaffold surviving. Nothing else in the repo checks any of those, so
     deleting this suite would silently un-guard all four. */
  "tools/mobile/prepare-webdir.test.mjs": 17,
  "tools/mobile/shell-invariants.test.mjs": 27,
  /* iOS on a runner (#38). These four are the only tests in the repo that can be
     run for a macOS-only feature by someone with no Mac, which makes their
     deletion unusually attractive to a future session that finds them
     inconvenient. `ios-workflow` is the one to be most careful with: it is the
     only thing in the repo asserting that the iOS job stays OFF the required-check
     list, that its path filter stays narrow (macOS runners bill at 10x), that
     every `xcodebuild ... build` stays unsigned so the job can run with no Apple
     credentials, and that `ci.yml`'s `ios-kit` — the repo's only compiled Swift —
     is still there. Nothing else covers any of that. */
  "tools/mobile/inject-background-audio.test.mjs": 26,
  "tools/mobile/ios-ci.test.mjs": 89,
  "tools/mobile/ios-workflow.test.mjs": 34,
  "tools/mobile/probe/install-probe.test.mjs": 39,
  "tools/refresh/dai.test.mjs": 8,
  "tools/refresh/enclosure.test.mjs": 18,
  "tools/segments/sweep-transcripts.test.mjs": 26,
  "tools/segments/transcript-normalize.test.mjs": 24,
  "tools/segments/merge-segments.test.mjs": 39,
  "tools/transcribe/fetch-audio.test.mjs": 64,
  "tools/transcribe/ad-inflation.test.mjs": 20,
  "tools/corpus/fetcher.test.mjs": 23,
  "tools/corpus/extract.test.mjs": 21,
  "tools/corpus/db.test.mjs": 20,
  "tools/corpus/manifest.test.mjs": 24,
  "tools/corpus/export-index.test.mjs": 24,
  "tools/corpus/chunk.test.mjs": 16,
  "tools/corpus/ftsquery.test.mjs": 21,
  "tools/corpus/eval.test.mjs": 28,
  "tools/corpus/ingest.test.mjs": 12,
  "tools/corpus/embeddings.test.mjs": 39,
  "tools/corpus/search.test.mjs": 25,
  "tools/corpus/backfill.test.mjs": 26,
};

for (const [rel, floor] of Object.entries(FLOORS)) {
  test(`${rel} still exists and has >= ${floor} tests`, () => {
    const full = path.join(ROOT, rel);
    assert.ok(
      fs.existsSync(full),
      `${rel} is missing. Deleting a suite is not a valid way to make CI pass.`
    );
    const src = fs.readFileSync(full, "utf8");
    const count = (src.match(/^\s*test\(/gm) || []).length;
    assert.ok(
      count >= floor,
      `${rel} has ${count} tests but the committed floor is ${floor}. ` +
        `If you removed tests on purpose, lower the floor in test/suite-integrity.test.js ` +
        `in the same PR and say why.`
    );
  });
}

/* The source trees that can auto-merge without a human read, and therefore the
 * trees whose suites must all be floored. This list tracks Tiers 3–4 of
 * ALLOWED_PREFIXES in tools/ci/path-policy.mjs.
 *
 * `backend/` is NOT here, and that is now a statement about mechanics rather
 * than about policy — see BACKEND_FLOORS below. This constant is pinned to
 * SCANNED_DIRS in tools/ci/run-suites.mjs (the closure test at the bottom
 * asserts the two scans agree), and the CI runner does not run backend's
 * TypeScript suites: they belong to the separate, required `backend` job. So
 * adding "backend" here would either break that pin or silently duplicate a CI
 * job. The floor is enforced by its own scan instead. */
const SCANNED_DIRS = ["player", "test", "tools"];

/* backend/test/ became auto-mergeable on 2026-08-16 (PR #175's blocker), so its
 * suites need the same protection as everything else in the allowlist — and
 * they need it for a sharper reason than the others.
 *
 * The `backend` check is REQUIRED. The whole argument for letting test-only
 * backend changes land unread is "a wrong assertion turns that check red". A PR
 * that DELETES the assertions turns it green. That is the exact two-step
 * gutting this file was written for (weaken the gate in PR 1, land the thing it
 * would have caught in PR 2), and until this list existed both steps could have
 * auto-merged with no human.
 *
 * Separate from FLOORS because these are `.test.ts`, run by the `backend` job
 * via `npm test` in backend/, not by tools/ci/run-suites.mjs. */
const BACKEND_FLOORS = {
  "test/archetypes.test.ts": 7,
  "test/budgetGuard.test.ts": 6,
  "test/candidateExtractor.test.ts": 8,
  "test/conditionalGet.test.ts": 6,
  "test/copyRules.test.ts": 3,
  "test/createEnricher.test.ts": 1,
  "test/dataSchemaCompliance.test.ts": 8,
  "test/dedup.test.ts": 17,
  "test/duration.test.ts": 12,
  "test/events.test.ts": 15,
  "test/html.test.ts": 8,
  "test/interestLearning.test.ts": 30,
  "test/itunes.test.ts": 3,
  "test/ladderBuilder.test.ts": 13,
  "test/ladderIntegrity.test.ts": 11,
  "test/ladderProgress.test.ts": 8,
  "test/learningJob.test.ts": 4,
  "test/parser.test.ts": 29,
  "test/personas.test.ts": 6,
  "test/podcastIndex.test.ts": 3,
  "test/politeness.test.ts": 9,
  "test/poolIntegrity.test.ts": 6,
  "test/property/dedup.property.test.ts": 5,
  "test/property/duration.property.test.ts": 5,
  "test/property/html.property.test.ts": 4,
  "test/property/interestWeight.property.test.ts": 3,
  "test/redirect.test.ts": 6,
  "test/scoring.test.ts": 17,
  "test/sessionBuilder.test.ts": 12,
  "test/stubEnricher.test.ts": 6,
  "test/userInterests.test.ts": 17,
};

/* `it(` as well as `test(`: backend's suites use both spellings. */
const TS_TEST_RE = /^\s*(test|it)\(/gm;

for (const [rel, floor] of Object.entries(BACKEND_FLOORS)) {
  test(`backend/${rel} still exists and has >= ${floor} tests`, () => {
    const full = path.join(ROOT, "backend", rel);
    assert.ok(
      fs.existsSync(full),
      `backend/${rel} is missing. backend/test/ can auto-merge now, so deleting a ` +
        `suite is not a valid way to make the required 'backend' check pass.`
    );
    const count = (fs.readFileSync(full, "utf8").match(TS_TEST_RE) || []).length;
    assert.ok(
      count >= floor,
      `backend/${rel} has ${count} tests but the committed floor is ${floor}. ` +
        `If you removed tests on purpose, lower the floor in ` +
        `test/suite-integrity.test.js in the same PR and say why.`
    );
  });
}

test("every backend suite on disk is covered by a floor", () => {
  const found = findSuites("backend/test", /\.test\.ts$/)
    .map((f) => f.replace(/^backend\//, ""))
    .sort();
  const unfloored = found.filter((f) => !(f in BACKEND_FLOORS));
  assert.deepStrictEqual(
    unfloored,
    [],
    "these backend suites have no committed floor — add them to BACKEND_FLOORS " +
      "in test/suite-integrity.test.js with the suite's current test count:\n" +
      unfloored.join("\n")
  );
});

/* `.mjs` matters: every suite under tools/ is an ES module, and the original
 * scan matched `.test.js` only — which is precisely why 26 tests sat
 * undiscovered. Match the naming convention, not one file extension. */
const SUITE_RE = /\.test\.(js|mjs|cjs)$/;

/* This file is excluded from its own scan: it is the floor list, not a floored
 * suite, and listing it would need a floor on the number of floors. */
const SELF = "test/suite-integrity.test.js";

function findSuites(relDir, match = SUITE_RE) {
  const abs = path.join(ROOT, relDir);
  // Missing is fine (see the header): a directory that has not been created
  // yet simply contributes no suites, and starts contributing the moment it
  // does. Existing-but-unfloored is what this scan is here to catch.
  if (!fs.existsSync(abs)) return [];
  const out = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = `${relDir}/${entry.name}`;
    if (entry.isDirectory()) {
      // Vendored/generated trees are not ours to floor.
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      out.push(...findSuites(rel, match));
    } else if (match.test(entry.name)) {
      out.push(rel);
    }
  }
  return out;
}

test("every suite on disk is covered by a floor", () => {
  // A new suite that nobody floors is a gate that can be silently deleted
  // later. Catch it at the moment it is added, which is the only cheap moment.
  const found = SCANNED_DIRS.flatMap((d) => findSuites(d))
    .filter((f) => f !== SELF)
    .sort();

  const unfloored = found.filter((f) => !(f in FLOORS));
  assert.deepStrictEqual(
    unfloored, [],
    "these suites have no committed floor — add them to FLOORS in " +
      "test/suite-integrity.test.js with the suite's current test count:\n" +
      unfloored.join("\n")
  );
});

/* Node's own default test discovery matches more spellings than this repo's
 * convention does — `*-test.js`, `*_test.js`, `test-*.js`, `test.js`, and
 * anything under a `test/` directory. SUITE_RE matches only `*.test.*`. So a
 * file named `dai-test.mjs` is invisible to BOTH this scan and the CI runner:
 * they agree perfectly, the closure test below passes, and the file is dark —
 * while `npm test` inside a package would run it, so its author sees it pass
 * locally.
 *
 * `test-*` is deliberately NOT flagged: tools/test-search.mjs is a script, not
 * a suite, and an allowlist for it would be the hand-maintained list this
 * whole mechanism exists to delete. The three spellings below have no such
 * collision, so they can be rejected outright. */
const NEAR_MISS_RE = /(^|[-_])test\.(js|mjs|cjs)$/;

test("no file is named in a way discovery cannot see", () => {
  const nearMisses = SCANNED_DIRS.flatMap((d) => findSuites(d, NEAR_MISS_RE))
    .filter((f) => !SUITE_RE.test(f))
    .sort();
  assert.deepStrictEqual(
    nearMisses, [],
    "these look like test files but do not match this repo's convention " +
      "(*.test.js/.mjs/.cjs), so neither the floor check nor tools/ci/run-suites.mjs " +
      "will see them — rename them:\n" + nearMisses.join("\n")
  );
});

/* CLOSING THE LOOP (issue #140)
 *
 * Everything above proves a suite exists and is big enough. None of it proves
 * the suite RUNS. Until #140, CI named each suite directory in its own step,
 * so the two mechanisms could drift in the one direction that matters: a suite
 * floored here (protected from deletion) but executed nowhere. That reads as
 * coverage and is not — strictly worse than no floor at all.
 *
 * CI now runs `node tools/ci/run-suites.mjs`, which discovers suites the same
 * way this file does. The test below asserts the two agree, in both
 * directions, so they cannot silently diverge:
 *
 *   - everything the runner would execute is floored here (previous test),
 *   - everything floored here is in the runner's plan,
 *   - and the runner's plan is exactly this file's own independent scan.
 *
 * The last one is what catches a NARROWING of discovery — dropping `.cjs`,
 * dropping a scanned tree, an exclusion added to the runner. Both scans have
 * to be edited in the same way, in the same PR, for coverage to shrink
 * quietly, and by then it is a deliberate act in a visible diff. The
 * duplicated discovery logic is deliberate — importing findSuites from the
 * runner would make the comparison below a tautology — though be honest about
 * what it buys: one implementation and one copy, written together, mostly
 * catches ACCIDENTS. The hard guarantee against a total narrowing (a plan so
 * small it no longer contains these checks) is the runner's ANCHOR_SUITES,
 * asserted below.
 *
 * `plan.errors` is the runner refusing to guess — a suite under a
 * dependency-carrying package.json with no `test` script. Failing here means
 * CI would not have run it. */
test("every suite on disk is executed by the CI runner", async () => {
  const { planSuiteRuns, missingAnchors } = await import("../tools/ci/run-suites.mjs");
  const plan = planSuiteRuns(ROOT);

  // The runner refuses to run a plan missing these (they are the suites that
  // verify discovery itself, this file among them). Asserted here too so the
  // failure names the cause rather than showing up as a plan/scan mismatch.
  assert.deepStrictEqual(
    missingAnchors(plan), [],
    "the CI runner's anchor suites are not in its own plan — discovery is broken"
  );

  assert.deepStrictEqual(
    plan.errors, [],
    "tools/ci/run-suites.mjs cannot build a complete plan:\n" + plan.errors.join("\n")
  );

  const planned = plan.groups.flatMap((g) => g.suites).sort();
  const found = SCANNED_DIRS.flatMap((d) => findSuites(d)).sort();
  assert.deepStrictEqual(
    planned, found,
    "the CI runner's plan and this file's scan disagree about what the suites " +
      "are. Whichever one is narrower is the bug: a suite in one and not the " +
      "other is either floored-but-unrun or run-but-unprotected."
  );

  const flooredButUnrun = Object.keys(FLOORS)
    .filter((f) => !planned.includes(f))
    .sort();
  assert.deepStrictEqual(
    flooredButUnrun, [],
    "these suites have a committed floor but would not be executed by " +
      "tools/ci/run-suites.mjs — a floor on a suite nobody runs protects " +
      "nothing:\n" + flooredButUnrun.join("\n")
  );
});
