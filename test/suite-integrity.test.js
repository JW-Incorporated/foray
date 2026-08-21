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
  /* The field record (#264). Three suites, floored separately BECAUSE they cover
     different things and any one of them can be deleted without the others
     noticing — which is precisely the shape #266's mutation round found, where a
     central mechanism survived in two suites before the third caught it.

       `diagnostic-log.test.js`     the mechanism: the ring, the sequence number,
                                    the cap and its eviction DIRECTION, the
                                    durable-on-write property, the parse table,
                                    and the rule that no telemetry TEXT is ever
                                    stored. 41 mutations killed, each named in
                                    the test that kills it.
       `diagnostic-record.test.js`  the wiring, through the real client, the real
                                    manager and the real backend over a real seam.
                                    The only thing in the repo that would
                                    notice a telemetry FORMAT change silently
                                    emptying the record, and the suite a review
                                    round grew by seven. 26 mutations killed.
       `diagnostics-surface.test.js` the drawer item and the sheet: reachable on a
                                    phone, copyable, and — asserted, not assumed —
                                    making no network request and never entering
                                    the ungated `cp_events` pipeline. 22 mutations
                                    killed, one of which is why that suite boots the
                                    real `init()`.

     Zero slack, like media-session and data-deletion below and for the same
     reason: what these guard is a set of decisions each one edit from its
     opposite. Raise them when the suites grow. */
  "player/diagnostic-log.test.js": 38,
  "player/diagnostic-record.test.js": 21,
  /* The durable store (#40). Both of these guard against silent DATA LOSS
     rather than a wrong answer on screen, which makes them the two suites in
     `player/` whose deletion would be hardest to notice: everything keeps
     rendering, and a listener's place quietly stops surviving the week. */
  "player/durable-store.test.js": 74,
  "player/idb-tier.test.js": 23,
  "player/foray-playback.test.js": 83,
  "player/foray-progress.test.js": 58,
  "player/foray-queue.test.js": 37,
  "player/foray-resolve.test.js": 54,
  "player/foray-sources.test.js": 24,
    /* 108 -> 109 with #264: a telemetry sink that throws must not reject a load. That
     became reachable when `player/client.js` gave this backend its first real sink —
     two `_emit` calls sit inside a Promise executor — so the guard and its test landed
     together. */
  /* 109 -> 112 with #267: the three tests that pin the stop epoch the
     autoplay-refusal recovery's continuation re-reads. They guard an inverted
     #263 — audio starting while the machine says `interrupted` — and each
     survives the others' mutations (audio, the boundary's arming order, and the
     reject branch's report are three separate lines), so a floor that allowed one
     to be dropped would allow exactly a third of it. */
  "player/html-audio-backend.test.js": 112,
  /* What the player believes after an interruption it could not observe (#263).
     Floored because this suite is the only thing in the repo that boots
     `player/client.js` for real, and the cheapest way to lose that is for
     somebody to find its DOM stub inconvenient. The three facts it holds down
     are all a single line from reverting: the surface reconciles against the
     element on becoming visible, the reconcile never starts audio, and a
     position nobody could read is never written down.

     25 -> 27 with #267: part 2b, which is the only place in the repo that asserts
     the refusal-recovery window is REACHABLE from the reconcile — a claim about the
     manager and the backend together, invisible from either suite alone. It is also
     the only test here constructed with `prefetch: true`, i.e. the only one that can
     see a code path nothing in production enables. That is precisely what makes it
     easy to delete as "testing a dead feature", and precisely why it is floored. */
  "player/transport-reconcile.test.js": 27,
  /* The lock screen and the car (#27). Floored high on purpose: four product
     decisions live in that module — publisher credit in `artist`, previous/next
     as segments, the Foray's clock in `setPositionState`, and a seam beat that
     reports PLAYING — and every one of them is a single-line edit away from its
     opposite, on a surface nobody sees in a browser tab.

     **Zero slack, deliberately.** The first draft floored it at 110 against 116
     actual, and the pre-push review proved what that bought: all four pins could
     be deleted and the floor stayed green — the exact failure this file exists to
     make loud. Raise it when the suite grows. */
  "player/media-session.test.js": 131,
  /* Playback speed (#242). Floored with ZERO SLACK, like media-session and
     data-deletion above and for the same reason: what this suite guards is a set of
     PRODUCT decisions, each one edit from its opposite and none of them visible in
     a browser tab. Which speeds exist (copied from Apple Podcasts, Spotify,
     YouTube, Pocket Casts, Overcast and Audible rather than invented); that 2x is
     the top, because a Foray pays per seam and #224 is the weakest path; that the
     key is `cp_rate`, whose rename would forget every listener's speed; and that a
     stale stored value SNAPS onto the ladder rather than resetting to 1x. Raise it
     when the suite grows. */
  "player/playback-rate.test.js": 22,
  "player/queue-manager.test.js": 99,
  "player/queue-state.test.js": 56,
  "player/seam-gap.test.js": 16,
  "player/seek-policy.test.js": 33,
  "test/app-security.test.js": 22,
  /* "Delete my data" (#42). Zero slack, like media-session above and for the same
     reason: what this suite guards is a PROMISE — both tiers cleared, the server
     rows really deleted, no success message over a failure, and a confirmation a
     stray tap cannot satisfy. Every one of those is one edit from its opposite,
     and the published privacy policy and Play declaration both now rest on them.
     A deleted test here is a false statement in a store submission. */
  "test/data-deletion.test.js": 51,
  /** The field record's surface (#264) — see the note beside the two `player/`
      halves above. */
  "test/diagnostics-surface.test.js": 19,
  /* The standing gate on topic ids in `data/*.json`. Floored because the metric
     it protects is gameable in exactly one direction: a misspelled `food/bakin`
     reads as "has a child" to the root-dumping report and silently erases a
     root-only pair, so a deleted gate would make the number look better. */
  "test/data-topic-integrity.test.js": 12,
  /* The code citations in the two store-submission documents. Same argument as
     data-deletion above and the same stakes: what this suite guards is whether a
     document going to a store reviewer describes the code that shipped. It is
     also the suite most tempting to delete, because it is the only one that goes
     red for a reason in a `.md` file — the 27 line numbers it replaced went stale
     precisely because correcting them was somebody's optional courtesy. */
  "test/legal-citations.test.js": 12,
  /* The shared search matcher (#218/#219). Floored because both of the things it
     pins are invisible when they break. Loosening the prefix guard buys recall
     and reintroduces a documented collision flood that only the ~170-second
     battery would notice, and only if a catalogue item happens to carry the
     colliding word that day. Deleting the reimplementation scan re-opens the
     drift that produced THREE copies of hitText/hitTag, two of them looser than
     the ranker they claimed to describe. Every test in there was
     mutation-checked — see the suite header. */
  "test/search-matcher.test.js": 22,
  /* The rich/sparse/empty tiering and the ranking prefix the narrow branch shows
     (#216). Floored because the battery cannot stand in for it: the disagreement
     it pins only reaches the page on a sparse or single-show query, and no query
     on main's pool is currently both, so every test in there would read as
     redundant to someone measuring the battery alone. Two of them are the only
     places anything asserts that the strong bar stays RELATIVE and that a
     prefix-admitted result does not count toward RICH_MIN -- an absolute bar and
     a candidate-counted `sparse` are both one line, both pass the battery, and
     both silently break a whole class of query. Every test in there was
     mutation-checked, with the killing mutation named in the test.
     11 -> 13 on 2026-08-21 (#301): the two new ones are the reproduction of the
     relative bar's cost -- improving a query's best match can empty it -- and the
     bound that keeps it survivable, that no OTHER result's improvement can evict
     anything. The first is a defect pinned on purpose and says so; deleting
     either without reading #301 would take the only record of a hazard the
     battery can see only as an unrelated-looking status regression. */
  "test/search-tiering.test.js": 13,
  /* Saved playlists must not decay (#276). Floored with ZERO SLACK, like
     data-deletion above and for the same reason: what it guards is a set of
     decisions each one line from its opposite, on a failure that is invisible on
     the day it is introduced. `.filter(Boolean)` back in the row mapping, a
     `filter` in the migration instead of a stub, one more field in
     PLAYLIST_PART_FIELDS — none of those breaks a render, and the listener who
     notices is weeks away and cannot tell an aged-out playlist from a badly built
     one. Two tests are also the only place the REAL builder is run against the
     REAL catalogue and then has the pool taken away underneath it, which is the
     only form the reproduction can take. Every test names the mutation that kills
     it — see the suite header for how the coverage divides against
     data-deletion and app-security. */
  "test/playlist-durability.test.js": 33,
  /* #301's bound, over the REAL catalogue: improving a result the ranking keeps
     below the top one must never empty its query or drop a bar-clearer. One test,
     floored at one, because the alternative to a floor here is a suite that can be
     deleted in a PR nobody reads -- and this is the only place a #301-shaped claim
     meets real score distributions, which is where two of its exclusions came from
     (an already-empty query, and a clearer lost to the per-show cap rather than the
     bar). It catches two of the four bar rewrites on today's pool; the fixture
     suite above catches all four, and both files say so. */
  "test/search-bar-exposure.test.js": 1,
  /* The document-frequency SCALE (#275): tagCount vs tagDF, the three threshold
     fractions, and the two invariances the fix buys -- growth and proportional
     subsetting. Floored because what it guards is an ABSENCE OF DRIFT, which no
     single-corpus assertion can see: the whole 120-check battery was green
     throughout the month in which 52 terms silently crossed the expansion
     threshold, and it would be green again the day somebody "simplified" tagDF
     back to a count. Every test in there carries the mutation that kills it, and the
     growth and subset tests each carry a WITNESS that the absolute rule moves --
     without which they pass on a tagDF that returns a constant. (Only the growth one
     is real-repo; the subset one is a fixture, because the real slice is topically
     skewed and its measurement belongs with the refusal to trim, in
     tools/mobile/prepare-webdir.test.mjs.)
     WHAT THIS FLOOR DOES NOT PROTECT, so it is not read as more than it is: the
     VALUES. That suite reads every threshold back from search-engine.js, so retuning
     one passes it. The ceiling on TAG_DF_COMMON is a product judgement guarded by
     tools/test-search.mjs's "parenting" case. */
  "test/search-df-scaling.test.js": 10,
  /* One generation per page load (#233). Floored because the thing it guards is
     invisible in the product: a mismatched code/data pair renders, it just
     renders the wrong program's reading of today's document. Every test in there
     was mutation-checked — see the suite header. */
  "test/sw-generation.test.js": 32,
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
  /* 82 since #226 (PR #237) added "Foray #1 is labelled superseded". Raised in a
     follow-up rather than in that PR, which is the mistake this floor exists to
     catch: it left one test of slack, and slack is what lets the new gate be
     deleted later with CI green. Zero slack here, deliberately, as at the top.

     110 since #236 extracted the boundary fixture. That change moved the #182
     acceptance proofs off `grilling-history-1` and onto
     `tools/foray/fixtures/boundary/`, and it is a NET addition: three per-Foray
     literal pins collapsed into one derived law, and eight proofs were added —
     seven the live data could not host (the fixture control, the
     CLI-on-the-fixture control, the id seam between the two data sets, the
     held-back invariant, the 21 s D1 slack, the M4 boundary in both directions,
     and the exhaustive 435-swap D5 isolation search) plus one review added: each
     curation doc's §0 summary against the checker's report, which nothing checked
     once the runtime and mean literals went.

     The control is the one to look at first if this ever has to be lowered: "the
     boundary fixture itself passes with zero errors" is what stops every proof
     below it from becoming a demonstration that broken data is broken. */
  "tools/foray/check-forays.test.mjs": 110,
  /* The narration evidence gate (#247, and the founder's citation rulings of
     2026-08-19). Zero slack, and for a sharper reason than most suites here.

     Three of its tests are the only mechanical defence in the repo against the
     specific failure the founder named — an agent inventing a plausible fact:
     "a number in a claim that appears in none of its fetched spans", "a claim
     whose text carries a digit cannot declare tier 1", and "a tier 2 claim may
     not rest on inference". Delete them and the pipeline still runs, still goes
     green, and starts asserting figures nobody fetched, in the house voice, at
     the right length. `narration-craft.md` §6e is the reason that is not
     recoverable downstream: bad narration does not announce itself.

     Two more are the only enforcement of ruling 3, that references are never
     read aloud: "reference apparatus may not appear in a spoken line" and its
     bare-domain/page-citation twin.

     And the fixture is deliberately the real committed artifacts rather than a
     hand-built one, because a hand-built narration fixture is precisely the
     "more forgiving than the thing it stood for" shape this file's own header
     warns about. That coupling is a feature: these tests fail if the committed
     thread stops being clean. */
  "tools/foray/check-narration.test.mjs": 49,
  /* The narration pipeline's dry run (#247). Zero slack. Two of its tests are
     the only things standing between this repo and a paid API call: one asserts
     `synthesize()` refuses without a key, and one greps every `.mjs` in
     `tools/narrate/` for a `fetch(`, a defaulted transport, an `sk_` literal or
     a key read from the environment. Deleting them takes the spend guard with
     them and nothing else in the repo replaces it. A third — "the dry run counts
     the characters of the REAL request body" — is what stops the cost estimate
     and the request payload drifting apart, which is the failure mode that turns
     a $6 projection into a bill nobody predicted. */
  "tools/narrate/narrate.test.mjs": 61,
  /* The native shell (#36). `shell-invariants` is the one to be most careful
     with: four of the five things it pins are properties of files OUTSIDE
     tools/ — the root package.json staying dependency-free, index.html's CSP,
     app.js not registering a service worker in the shell, and the repo's ios/
     scaffold surviving. Nothing else in the repo checks any of those, so
     deleting this suite would silently un-guard all four.

     THE FLOORS ROSE ON 2026-08-18, from 27 and 44, when the bundle stopped
     carrying the whole catalogue. Twenty-four of `prepare-webdir`'s tests are the
     bounded catalogue slice, and the three not to lose are the three a reader would
     not guess at:

       - the slice's show->artwork and show->collection-id joins are asserted
         IDENTICAL to the full document's, through `player/foray-sources.js` itself,
         because every count-based check passes when the slice is emitted in the wrong
         order and only that one fails;
       - "the anchor is the item the JOIN reads, not simply the first one" is the only
         thing standing between a future artwork-less episode and a failed nightly
         build, and it cannot fail on today's data;
       - "REAL REPO: trimming item-tags to the bundled pool WOULD re-rank the app" is
         the measurement behind a refusal. Trimming that file is a free-looking 174 KB
         that silently moves 176 query terms' score multipliers in the app and not on
         the web. Delete that test and the next person takes the 174 KB.

     `shell-invariants` gained two, one of which pins the slice's per-file budget —
     the same self-referential hole that `MAX_BYTES = 30 * 1024 * 1024` opened in the
     size cap, closed in advance this time. */
  "tools/mobile/prepare-webdir.test.mjs": 52,
  "tools/mobile/shell-invariants.test.mjs": 46,
  /* The foreground service's web half (#27's Android half, on #37). Zero slack, and
     for the reason `media-session.test.js` above gives: what this suite guards is
     mostly a set of single-line edits away from their opposites, on a surface nobody
     sees in a browser tab. Two in particular have no other check anywhere —
     `activeCount`'s prune, without which an autoplay-refused play() leaves the
     foreground service running for the whole session, and the settle window's two
     bounds, which sit between #239's 20 s hidden load deadline and Blink's 30 s
     `kRecentAudioDelay` with 5 s of room in total.

     THE STATIC COUNT IS 53 AND THE RUN COUNT IS 57, and the gap is not a discrepancy:
     two of those 53 `test()` declarations sit inside `for` loops over the exported
     RELEASE_EVENTS and ACQUIRE_EVENTS lists, so they expand into six runs. The floor is
     the static count, because a regex over source is what this file measures. Raise it
     when the suite grows. */
  "tools/mobile/foray-audio-shell.test.mjs": 83,
  /* #27's Android half: the `navigator.mediaSession` polyfill that feeds a native
     Media3 session and routes transport presses back into the page
     (docs/android-lock-screen.md). The floor matters here for the reason that doc's
     §8 gives: nothing in it has run on a device, so this suite against fakes is the
     only thing standing between a lock screen that works and one that silently says
     the wrong episode. Section 7 of that doc maps each mechanism to the mutation that
     kills it, which is where to look before concluding these are vacuous. */
  "tools/mobile/foray-media-session.test.mjs": 67,
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
  /* The one-shot that gets a newly curated show's back catalogue into the pipeline
     (#279). The floor matters because the whole script exists to make one silent
     failure impossible — a backfill that reports success while emitting nothing, or
     emitting rows `resolve.mjs` can only drop — and the tests that pin that are the
     easiest ones in the repo for a later session to find inconvenient.

     THIS COMMENT PREVIOUSLY CLAIMED "seventeen mutations were run ... the one that
     came back green found dead code rather than a hole in the tests." THAT CLAIM WAS
     FALSE and it is recorded here rather than quietly deleted, because a false
     evidence claim is worse than none: the next reader stops checking. Review of
     PR #289 re-ran the mutations and 18 of 20 SURVIVED, for one structural reason —
     every invariant that mattered lived inside `main()`, which is not exported and
     which no test called, so it was unreachable by construction. That included the
     `NO_MATCH` guard this whole script exists for.
     The fix was to move those guards into exported functions (`feedItems`,
     `selectEpisodes`, `buildPayload`, `resolveOutPath`) and pin them. **Twenty
     mutations were then run against this suite and twenty were killed**; each test
     names its own. A second review round found two of the first ten had been claimed
     too early — a `??`-for-`||` in `feedItems` that let an empty `<item/>` through as
     a one-element array, and four loose-equality survivors under `assert.deepEqual` —
     so the count above is the re-run, not the first pass.

     WHAT IS STILL UNCOVERED, said plainly so "twenty killed" cannot be read as more
     than it is: `main()`'s WIRING. Deleting the `writeFileSync`, inverting the
     `--dry-run` branch, or dropping the throttle still leaves this suite green,
     because `main()` fetches over the network and is not exported. Every guard it
     used to hold is now tested; the plumbing between them is not.
     The floor is 24 because that is the count, with no slack. */
  "tools/refresh/backfill-show.test.mjs": 24,
  "tools/refresh/dai.test.mjs": 8,
  "tools/refresh/enclosure.test.mjs": 18,
  /* The nightly watchdog (#290). ZERO SLACK, for the reason media-session and
     data-deletion are floored that way: what this suite holds down is a set of
     decisions each one line from its opposite, on a check nobody watches run.
     It is also the suite most able to look fine while pinning nothing — a
     watchdog fixture that is healthy makes every assertion pass while the alarm
     is wired to nothing. The committed fixtures are the real 2026-08-20 failure
     rebuilt from git, and two of these 62 tests exist purely to pin that they
     still are. All 62 were mutation-killed; the mutation is named in each.
     47 -> 62 in the pre-push review round, which found that the guard could
     stall the pipeline with no documented way to clear it and that the digest
     fetch failed OPEN on any API error that was not a 404. */
  "tools/refresh/watch-nightly.test.mjs": 62,
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
