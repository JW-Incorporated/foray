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
  /* 38 -> 47 with #225: a failed TAP is an entry rather than a stage, because the
     tap the record exists to explain is a cold start with no seam to hang a stage
     on. Nine, and three of them exist because something was caught rather than
     imagined — a test that passed vacuously (`lineFor` renders a missing field and
     a null one identically, so only the stored entry can tell them apart), a
     sanitiser that coerced twice and could be handed one string for the check and
     another for the value, and a mashed button that evicted the very seam rows
     explaining why it was dead.
     21 -> 22: the bridge between the page and this record was covered by neither
     suite, and transposing its two arguments left everything green. */
  /* 50 -> 55 with S-01 (docs/search-plan.md, kanban t_46366383): a new
     `search` entry kind on PlayerDiagnostics — query length only, never the
     query text, per this suite's own §7. */
  "player/diagnostic-log.test.js": 101, // review 2026-09-23 (fix/founder-reports-2026-09-23): a write before a slow hydration is HELD and written after the adopted ring (real DurableStore), the next write flushes by itself, the give-up force, a Clear drops what was held; the webkit door's skip is a row under the dashed command and the spec action is refused; 96 -> 101 // merge of fix/fr-diag (2026-09-23 founder record: recorded 939, entries 0, no build row): the clear mark, the build kept outside the ring, the MISSING gap line naming key+tiers, the boot row's hydration flag; 89 -> 96 // founder 2026-09-23 (fix/founder-reports-2026-09-23): a dropped duplicate press is a remote row saying dup=y, counted on the header apart from unhandled; the webkit door joins REMOTE_ORIGINS; 88 -> 89 // founder 2026-09-23 ("my car resumed Spotify"): the `remote` row (what the native side received, from which door, handled or not) and its header line; `via=` on a nowplaying row so a pause is a write; the plugin's own session acts are session kinds; 83 -> 88 // 2026-09-22 audit (L2), founder report 3: a `build` row per boot and a `build …` header line; 81 -> 83 // 2026-09-22 audit (L2), founder report 2: an unexplained stop carries hiddenFor + the element's readyState/networkState/error; a stall with no seam is a coalesced `media` row; an external play is a `transport` row; session rows carry hiddenFor; 76 -> 81 // #685 (2026-09-13): the voiceProbe line says rendered-vs-estimated and flags an impossible RTF; a synthesis-failed refusal keeps its numbers; 74 -> 76 // client audit (2026-09-12): the search row's one vocabulary + `hidden`, and the epMs/ctaMs fields; 72 -> 74 // K-01 (2026-09-12): the voiceProbe row — named fields only, null-not-zero on a refusal, and both report lines; 68 -> 72 // L-06 + M-03 (2026-09-12): the `nowplaying`, `session` and `transport` entries; 57 -> 68 // FD-01 (2026-09-10): the `data` entry's vocabulary and its line; 55 -> 57
  "player/diagnostic-record.test.js": 25, // 2026-09-23 founder record (fix/fr-diag): the bounded wait on hydration (a hung IndexedDB no longer costs the boot and build rows) and a Clear that keeps the build on the header; 23 -> 25
  "player/episode-link.test.js": 6,
  /* The durable store (#40). Both of these guard against silent DATA LOSS
     rather than a wrong answer on screen, which makes them the two suites in
     `player/` whose deletion would be hardest to notice: everything keeps
     rendering, and a listener's place quietly stops surviving the week. */
  "player/durable-store.test.js": 87, // 2026-09-22 audit (theme J, R10): the native Preferences tier the header had promised since #40 — absent on the web, survives a WebView sweep, first word in hydration, owned keys only, purge reaches it, and client.js wires it; 81 -> 87 // 2026-09-22 audit (theme J): a key localStorage refused while IndexedDB took it is not reverted next launch, nor pushed down over the good copy — three keys, the mark clearing, a refused removal, the ledger as bookkeeping, purge, a corrupt ledger; 74 -> 81
  "player/idb-tier.test.js": 23,
  /* New with M3 (kanban card t_c7199b13): the event queue moved off a
     synchronous `cp_events` localStorage rewrite into its own IndexedDB
     database. Covers append/flush never throwing, batching, the two id
     spaces (durable + fallback ring), and the two behaviours the design
     calls out by name — quota exhaustion (not lost, surfaced via health(),
     never thrown) and the 5,000-row retention cap. */
  "player/event-log.test.js": 36, // 2026-09-22 audit (theme J, R11): purge() empties the buffer, the ring and IndexedDB and re-reads to prove it; a deaf store and a refused clear are failures, never throws. The suite already stood at 32 against 20, so this closes that slack too; 20 -> 36
  /* 83 -> 87 with #225: the page's two failure guards now reach the field record.
     Two of the four exist to keep the instrument from becoming the outage it was
     built to explain — one pins that the message is on screen BEFORE the record is
     touched (the obvious version of it could not see the order at all), and one
     that an error too hostile to read still produces both. */
  /* 87 -> 95 with #29's wiring, then 95 -> 87 with D-01 (2026-09-06): the
     diagnostic Foray (`tts-locked-screen-check`) and its eight tests were
     deleted once V-01's Audition button replaced it for the human tests it
     existed to support. See HUMAN-ACTIONS #29 and docs/curation/
     tts-locked-screen-check.md (kept as the historical record). */
  "player/foray-playback.test.js": 91, // 2026-09-23 merge of the audit lanes: L2 (the Foray page paints its main button from `running`, "Start over" on a finished Foray; +2) and L8 (#236: the suite runs on the frozen fixture, plus "every segment of every committed Foray in data/ resolves"; +2) both landed; 87 -> 91
  /* 2026-09-18, founder: "the podcast I was listening to should still be in the
     now playing ribbon". The POINTER to the last ordinary episode — position is
     not stored here, `cp_pos:` has owned that since #26, and two of these tests
     exist only to pin that separation. */
  "player/episode-progress.test.js": 23, // 2026-09-22 audit theme L: `episodeProgress`, the one reading of a stored position (played / in-progress / sampled / unplayed) that Jump back in and the episode rows share, on position-store's own thresholds; 19 -> 23
  /* 2026-09-22 (audit L2, founder report 3): which build wrote a diagnostics
     record — the web deploy id on both hosts and the native build number in the
     shell, each from where only it is known. New suite. */
  "player/build-stamp.test.js": 7, // 2026-09-23: each half of the stamp is bounded, so a bridge or a bundle read that never answers still yields a row; 5 -> 7
  "player/foray-progress.test.js": 59, // FD-05 (2026-09-10): a Foray gone from the directory reads `dropped`; 58 -> 59
  "player/foray-queue.test.js": 38, // F-90 (2026-09-11): the jingle item asset is the interlude asset; 37 -> 38
  /* The interlude jingle (queue-manager.js §13): the rule, the element wrapper
     and the committed placeholder asset's measured properties. The seam CLOCK
     it rides is floored under queue-manager.test.js. */
  "player/interlude.test.js": 16,
  /* 54 -> 59 with #29's `withDiagnosticUnlock`, then 59 -> 54 with D-01
     (2026-09-06): the one-id shell-unlock exception and its five tests were
     deleted with the diagnostic Foray once V-01 shipped an in-app Audition
     button to replace it. */
  /* +1 audit finding E (2026-09-12): `isGeneratedDraft`, the one home of the
     generated-draft predicate; 62 -> 63. +6 (2026-09-12): the show IDENTIFIER
     carried onto every tape entry (`showIdFromSourceId`, `show_id`,
     `source_id`) so a running order can link a beat to its show page, and
     F-103's `resolveCites`, which denormalises a narration beat's citations
     against the same two documents rather than having them shipped twice in
     data/forays.json; 63 -> 69. */
  "player/foray-resolve.test.js": 69,
  /* The Foray directory (FD-03, 2026-09-10): the mechanism that lets a phone see
     a new Foray without a store build. Floored with zero slack because each of
     its three rules — never block first paint, never adopt an unvalidated set,
     never drop a cached set on a network error — is one deleted test away from
     a phone that either hangs on a dead cell or plays a torn deploy. The page-
     level half is test/foray-directory.test.js, floored separately below. */
  "player/foray-directory.test.js": 30, // +1 audit finding E (2026-09-12): the cache row carries `partial` instead of dropping it; 29 -> 30
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
  "player/transport-reconcile.test.js": 80, // review 2026-09-23: the rate restore waits for REAL hydration, not the record's 5 s bound (mocked timers, store released after the bound); 79 -> 80 // visual pass 1 (2026-09-23): ↺15 nudges inside a clip (sheet and mini bar), the clip row shows only for a Foray; 76 -> 79 // 2026-09-23 audit sweep: part 10 — an id-less play keeps the pointer, the lock screen shows a restored bar's position, a late-hydrated speed reaches a booted player (and does not overrule a choice), Jump back in's Foray rows read the live runtime; 71 -> 76 (L2's later cells had taken it to 71 unfloored) // 2026-09-22 audit (L2): part 9 — a Foray played last takes the bar and one press resumes it; an episode played after keeps it; 64 -> 66 // 2026-09-22 audit (L2): part 8 — a booted shell writes both halves of the build stamp (founder report 3); 63 -> 64 // 2026-09-22 audit (L2): part 7 — the backend writes the element's state onto an unexplained pause (founder report 2); 62 -> 63 // 2026-09-22 audit (L2): part 6 — founder report 1: the element drives the position writer, the reconcile corrects towards playing, and the native background/route/interruption events flush and pause/reconcile; 57 -> 62 // 2026-09-22 audit (L2): part 5 — the head unit's stop pauses without unregistering anything; next/previous appear when the page offers them; 55 -> 57 // 2026-09-22 audit (L2): part 5 — a failed episode load says so and play() returns false; `waiting` paints Buffering; 53 -> 55 // 2026-09-22 audit (L2): part 5 — a superseded load neither moves its successor's playhead, claims `playheadItemId`, nor stops the newer load when it fails; 50 -> 53 // 2026-09-22 audit (L2): part 5 — Foray-clock seeks land inside the item (out-point stays armed, a bridge has no start_sec), "››" is disabled at the end, a finished Foray can be scrubbed; 46 -> 50 // 2026-09-22 audit (L2): part 5 — a cold start reads `resumeOffset`, play after the end starts over, and the Jump back in card shows the raw row; 43 -> 46 // 2026-09-22 audit (L2): part 5 — one episode seek for every surface (restored bar, ended episode, both clamps, empty bar on an unknown duration); 39 -> 43 // 2026-09-22 audit (L2): part 5 — the card, the lock screen and the Foray page read `transportIsRunning()`; a finished Foray starts over; 35 -> 39 // #689 (2026-09-14): part 4 — the four founder reports from one car session, as episode tests rather than Foray ones; 27 -> 34
  /* The lock screen and the car (#27). Floored high on purpose: four product
     decisions live in that module — publisher credit in `artist`, previous/next
     as segments, the Foray's clock in `setPositionState`, and a seam beat that
     reports PLAYING — and every one of them is a single-line edit away from its
     opposite, on a surface nobody sees in a browser tab.

     **Zero slack, deliberately.** The first draft floored it at 110 against 116
     actual, and the pre-push review proved what that bought: all four pins could
     be deleted and the floor stayed green — the exact failure this file exists to
     make loud. Raise it when the suite grows. */
  "player/media-session.test.js": 152, // founder 2026-09-23 (fix/founder-reports-2026-09-23): the merge of fr-media (the pause and the clear are reported writes; client.js records foray:remote) and fr-lockscreen-skip (any seekOffset lands as our step) — the suite stood at 152; 148 -> 152 // 2026-09-23 founder report: the platform's seekOffset is IGNORED — the lock screen steps ±15/30 like the in-page buttons (the inverse pin was the defect). The suite already stood at 148 against 147; 147 -> 148 // 2026-09-22 audit (L2): a remote stop pauses and keeps the session; an episode's next/previous are the page's (the no-next pin was rewritten, R2); 146 -> 147 // 2026-09-22: client.js defers the shim-counter read past the shim's own flush (the founder's sent=0). The suite was already at 145 against a floor of 143 -- two cells had landed without a bump, so this closes that slack too; 143 -> 146 // 2026-09-21: the write and the report agree — a throwing metadata assignment is reported as failed and does not poison the dedupe; 140 -> 143 // client audit (2026-09-12): no raw NUL byte in player/*.js — a binary file is invisible to every search; 139 -> 140 // L-06 (2026-09-12): the Apple Podcasts parity rule + the onWrite hook; 132 -> 139 // F-89 (2026-09-11): a jingle item is credited to 4a; 131 -> 132
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
  /* The default narration voice (founder decision 2026-09-10: Samantha).
     One pure rule read by two surfaces — `client.js` for what narration
     speaks with, `app.js` for which row is selected — so a deleted test here
     is a default that can silently drift back to #491's "best installed
     voice of any name", the exact behaviour the founder overruled. */
  "player/default-voice.test.js": 10,
  /* Continuous playback's rules (NE-13, docs/native-engine-plan.md §5.5): what
     plays after an episode, the eight hops the page plans for the native
     engine, and the once-only ledger for what that engine played while the
     page slept. The suite READS its fixtures (player/parity/fixtures/continuation,
     whose case count is floored in player/parity/floors.json), so a deleted test
     here is a rule nothing asserts any more. */
  "player/continuation.test.js": 11,
  "player/queue-manager.test.js": 144, // 2026-09-22 audit (L2): the position timer arms on the ELEMENT playing too (founder report 1); the suite was already at 143 against 132, so this also closes that slack; 132 -> 144 // client audit (2026-09-12): `_resumeNarration` reads the transport — fromStart, refused, and no-answer; 129 -> 132 // L-05 (2026-09-12): pause/resume/stop for spoken narration; 115 -> 129 // +1: L-03 position-increases acceptance (2026-09-10)
  "player/queue-state.test.js": 58, // 2026-09-22 audit (L2): `elementResumed` — interrupted -> playing with no audio effect, and nothing from any other state; 56 -> 58
  "player/seam-gap.test.js": 16,
  /* The SegmentStrip (#128) — the element that makes a Foray legible as
     something other than a playlist. Floored with no slack because what it
     holds down is a set of DESIGN decisions, each a single line from its
     opposite and none of them visible in a passing render: that a capsule is a
     source EPISODE and not a show (two episodes of one podcast are two hard
     cuts the listener hears), that the seam survives greyscale, that a narrator
     bridge is an item rather than a gap, that no two touching capsules share a
     tone, and that both themes' palettes clear 3:1. Every test names the
     mutation that kills it. */
  "player/segment-strip.test.js": 48, // 2026-09-22 audit theme L: `stripTally`, the Foray header's counts from the strip's own model — clips are tape, and an unmeasured duration makes the runtime an estimate; 46 -> 48 // the card strip (founder report, 2026-09-12): back-to-back bridges merge into one bar, and `.fy-strip--static` clips to one line; 27 -> 49
  /* 41 -> 45 (2026-09-22 audit, theme F): a vertical flick that starts on the
     sticky strip ends as a SCROLL, never a zoom (it used to seek on release);
     a sideways drag and a hold-then-drift still scrub. */
  "player/strip-scrub-gesture.test.js": 45,
  /* Drag the Now Playing sheet down to dismiss it (founder report,
     2026-09-13). Same pure-state-machine shape as the scrub gesture above and
     floored for the same reason: the numbers ARE the product decision — how
     far a thumb must travel, what counts as a flick, and the eligibility rule
     that keeps a scroll through a long episode description from throwing the
     sheet away. Every test names the mutation that kills it, and each was run. */
  "player/sheet-drag-dismiss.test.js": 15,
  /* The other half of the same report: the sheet is WIRED, opens at the top,
     scrolls inside itself, and is a full-height overlay whose `[hidden]`
     attribute still hides it. A source-text suite (client.js builds DOM at
     import and cannot be loaded under node — see its own header), floored
     because a perfect gesture module wired to nothing passes every other test
     in this repo.
     16 -> 24 (2026-09-22 audit, merged): L5 -- emptied hook/timing paragraphs
     are hidden, and an ordinary episode that fails to play says so on the bar
     and in the sheet (+2); L3, themes E/F -- the sheet is a named modal dialog
     opened through app.js's sheet owner with the topbar kept reachable, Stop
     releases the owner, the artwork opens the player, Stop and Close sit at
     opposite ends of their row, and one finger drives the drag (+6). */
  "player/now-playing-sheet.test.js": 24,
  "player/seek-policy.test.js": 33,
  /* The wire between the page and on-device speech (#29). Floored with no
     slack, because what it holds down is a connection that was ABSENT for
     months without a single test going red: `PlayerQueueManager` took a `tts`
     option, `_speakNarration` was complete, and nothing anywhere passed one, so
     the whole narration path was dead code that all its own unit tests passed.
     The last test in the suite is deliberately a source-level guard on
     `client.js`'s call site — a weak test, and the only one in the repo that
     turns red if that one line is deleted again. */
  /* 11 -> 14 (2026-09-05): the bridge now also carries `listVoices()`, whose
     one non-obvious case is a SHELL BUILT BEFORE IT EXISTED -- the bundle holds a
     flattened build-time copy of `foray-tts.js`, so "the module loaded but has
     no such method" is a real state and not defensiveness. */
  /* K-01's instrument (docs/bundled-voice-plan.md). The one property that makes
     a measurement worth having: it never reports a number it did not measure.
     Zero slack, and the reason is specific to this suite — most of its tests
     kill a mutation of the form "a guard replaced by a default that looks like
     a pass" (RTF 0 instead of null, an unmeasured ceiling treated as met, a
     native answer with no `ok` read as success). A record that says "RTF 0.00,
     locked screen fine" because nothing ran is a record that gets pasted into a
     decision, and every one of those tests is one edit from allowing it. */
  "player/kokoro-probe.test.js": 41, // #685 (2026-09-13): the zero-is-not-a-pass floor, the rendered-vs-estimated divisor, the three copies of the synthesis vocabulary, and CPU-is-the-whole-path; 30 -> 41 // K-01 (2026-09-12): the passage is phonemized, so "refuses before the bridge" and "reaches the bridge" are two tests; 29 -> 30
  /* The native engine's parity harness (NE-03, docs/native-engine-plan.md §6).
     Zero slack. `run.test.js` is one test per fixture case (a loop, counted
     once here) plus the codec, comparator, schema and scenario-driver rules
     the Swift ForayEngineParity library is ported from; `coverage.test.js` is
     the guard that every rule in fifteen player suites is fixtured, mapped to
     an XCTest, excluded with a reason, or owed with a card. The fixture
     families' own case counts are floored in player/parity/floors.json and
     enforced by "parity fixture families hold their floors" below, so deleting
     fixture cases is loud here too, not only in the suite that reads them. */
  "player/parity/run.test.js": 32, // NE-12j: the media-actions adapter records real arity and refuses a press the OS could never deliver; 31 -> 32
  "player/parity/coverage.test.js": 24, // NE-13: the continuation capability owes nothing, because its family is JS-only (plan C-2); 23 -> 24 // NE-12j: media-session is wholly classified — media-episode, an exclusion, or NE-29j's Foray half in the foray capability's family; 22 -> 23 // NE-07j: a suite whose recording card has landed (queue-state, playback-rate) owes nothing and is fixtured into its own family only; 21 -> 22
  /* NE-10j: the rows and number-format families. rows.test.js is what makes
     them a RECORDING — every recorded row is rebuilt from the real builders,
     and the page's own PositionStore, on the wall clock, writes the recorded
     bytes. engine-contract.test.js pins OWNED_PREFIXES against both the rows
     the family records and every cp_ key the app spells, in both directions:
     a missed row is a clobber, an extra one is a store that stops saving. */
  "player/parity/rows.test.js": 4,
  "player/engine-contract.test.js": 3,
  /* NE-08: the suites that READ their fixtures (plan §6.3). Each test runs the
     `transport` / `resume-rules` cases that name it, so the one file is the JS
     assertion and the Swift port's case list (NE-09). Zero slack: a deleted
     test here is a rule whose cases no JS test asserts any more, and the
     coverage guard would still count those cases as fixtured. The families'
     case counts are floored separately in player/parity/floors.json. */
  "player/transport-policy.test.js": 16,
  "player/position-store.test.js": 10,
  "player/tts-bridge.test.js": 29, // K-01 (2026-09-12): the kokoroProbe delegate — one memoised load, an older shell build, and the shared-instance pin; 25 -> 29 // L-05 (2026-09-12): the transport half of the bridge; 20 -> 25
  /* The app's name on the surfaces users read (#302), 6 -> 8 when the two
     published legal documents were added, 8 -> 21 when the shipped UI copy that
     suite had only RECORDED as a known gap was renamed and pinned -- twenty
     strings, two of which the gap record itself had missed. Zero slack,
     deliberately: every assertion here is a single string in a single file, so
     each is exactly one careless edit from its opposite, and #302 exists because
     reverting one of them passed the whole suite. */
  "test/app-name.test.js": 21,
  /* Back-navigation (kanban t_0faae03f, Wyatt 2026-09-05): the ‹ button must
     go back one real step, not always Home — see the suite's own header
     for the full journey list this covers.
     9 -> 11 with U-02 (docs/ui-transition-plan.md, kanban t_806e5d01): the
     tab bar's own links compose with the SAME back-stack rather than
     needing a special case, and a deep link into a tab-owned route is a
     cold open like any other -- two more journeys added to the list this
     suite already existed to protect. */
  "test/back-navigation.test.js": 13, // 2026-09-22: the step comes from the real history entry (a forward tap onto the page two back; a reload keeps ‹) and a removed playlist is not one ‹ away; 11 -> 13
  /* Collapsing page header reappears on scroll-up (kanban t_0faae03f, same
     report): the header must un-hide on any upward scroll, not only at the
     literal top of the page. */
  /* 6 -> 8 (2026-09-22 audit, theme I): the reappearing header publishes its
     height, and styles.css pins the Foray transport beneath a SHOWING header
     instead of behind it. */
  "test/collapsing-header-scroll.test.js": 8,
  /* The onboarding sheet mounts once per VISIT, not once per persisted flag
     (found 2026-09-13 by the Playwright drawer spec: two `#first-time-sheet`
     nodes, duplicate ids, three-minute click timeouts behind them). Floored
     because the browser suite only catches it when the machine is slow enough
     to lose the race — green on a quiet box, red under load — so these
     timing-free assertions are the reliable half of the guard. */
  "test/onboarding-sheet-once.test.js": 6,
  /* A new page starts at the top, and ‹ puts you back where you were
     (founder report, 2026-09-13). Floored because BOTH halves are one-line
     deletions away and only one of them is visible: losing the scroll-to-top
     reproduces the reported bug, and losing the back-step restore quietly
     ruins every deep browse instead — the failure mode that has no bug report
     because it feels like the app forgetting rather than like a defect. */
  "test/route-scroll-position.test.js": 14, // 2026-09-22: a tab tap onto the page two back starts at the top, and an async page's clamped restore lands at its terminal paint without filing the clamp; 11 -> 14
  /* 2026-09-22, audit: the router's own rules — safe decoding on every param
     route, one playlist-route spelling, a first route that throws cannot skip
     init()'s wiring, a bare URL is #/, ?foray= enters once per tab, the current
     tab scrolls to top, a show page reports its terminal paint. Two cells boot
     the REAL init(). */
  "test/router.test.js": 13, // 2026-09-22: + screen state in the address (subject queue for any branch, deterministic; the Search query; the in-show search); 8 -> 13
  /* 2026-09-22, audit theme B: async work knows which page asked for it. The
     harness answers a region selector with the SAME element across pages, as a
     browser does — the forgiving fake would have hidden the show-A-into-B bug. */
  "test/async-identity.test.js": 7,
  /* Where `api/*` actually lives, and the CSP entry that lets the client reach
     it. Floored because this is the suite standing between the app and a
     REGRESSION THAT LOOKS LIKE NOTHING: every caller degrades a failed api
     fetch to the bundled slice, so reverting any one line here restores "3
     episodes a show" silently, with a green suite and no error anywhere. Seven
     mutations named in the file's header; all seven were run and are red. */
  "test/api-origin.test.js": 5,
  "test/app-security.test.js": 26,
  "test/episode-page.test.js": 8,
  /* 2026-09-18, founder: "Only forays are in the jump back in section, podcasts
     and playlists should be there too." The episode card existed but was
     unreachable — it read cp_lastpick, written only for discover-pool episodes. */
  /* The card button that became a pause button (founder, 2026-09-22: "the pause
     button on jump back in does not work"). ZERO SLACK: five of the seven cells
     drive `bindPlay` FOR REAL through a captured click handler, and they are the
     only thing in the repo that can tell a transport branch that EXISTS from one
     that is REACHED. The two source-text cells guard the seam to
     `player/client.js`, where a rename would otherwise make the card silently go
     back to restarting episodes rather than throwing. */
  "test/card-play-pause.test.js": 7, // 2026-09-22: new -- a card showing the pause glyph must pause, and the paused current item must resume rather than restart
  "test/foray-ribbon-restore.test.js": 5, // 2026-09-23 audit sweep: the Jump back in rows are read through a live resolver behind forayViewOpts(); 4 -> 5 // 2026-09-22 audit (L2): new -- the ribbon asks for the Foray played last first, through the forayViewOpts() gate, and falls back to the episode pointer
  /* 2026-09-22, audit theme A: "playable" means a snapshot with audio, not
     curated-pool membership. ZERO SLACK: most cells reboot app.js over the same
     storage to model a reload, which is the only place the defect lived. */
  "test/playable-episodes.test.js": 12, // 2026-09-22: new -- Up Next, History, Saved, continuous playback, Open episode and #/show/pi: all survive a reload
  "test/jump-back-in-kinds.test.js": 19, // 2026-09-22 audit: the card reads the RAW stored position, never the collapsed resume offset (a finished episode said "180 min left"); 18 -> 19 // 2026-09-21: episodes get a progress bar too — the reader no longer needs the player booted, and a duration the feed omitted comes from the position store; 14 -> 18
  /* Audit 2026-09-22, theme C: the four listener-facing formatters (fmtDur,
     countLabel/playlistLengthLabel, joinMeta, fmtDate) and the surfaces that
     used to do each by hand — "1h 0m", "1 parts", "Show ·  · date", "Invalid
     Date". ZERO SLACK: every cell is the only one pinning its surface. */
  "test/format-helpers.test.js": 11, // 2026-09-22: new
  /* Audit 2026-09-22, theme D: a control's text and its accessible name move
     together — the Save/Follow toggles, the play buttons and their player-side
     repaint, the Foray main button's four states, the running order's
     playing/played rows, the down-vote chips, the 4 Hz notice line — plus the
     standing rule that no control's text in app.js or player/client.js is
     written except through the label helpers. ZERO SLACK. */
  "test/toggle-labels.test.js": 12, // 2026-09-22: new
  /* Visual pass 1 (2026-09-23, docs/audit/status.tsv qa 43/54/59/78, persona
     10/40/58 — the founder-approved visual changes). Card anatomy: no <button>
     inside an <a> (three cards restructured as stretched-link cards), the
     two-tier episode row, one pill, one artwork treatment, one tag shape.
     Transport: the mini bar's second control, the seek pair that stays a seek
     pair, the labelled clip rows, one nudge. Zero slack: each is a one-line
     revert from the audit's finding. */
  "test/card-anatomy.test.js": 10, // review of the pass (2026-09-23): the banner test became "the banner is gone" (its renderer had no caller), the template walker sees nested templates, one tag tint, rows on --radius-lg, the rhythm above the first card; 8 -> 10
  "test/transport-controls.test.js": 9, // review of the pass (2026-09-23): the sheet's Play is the bar's Play scaled, the second row is one treatment with no second Close, the clip buttons keep their aria-labels; 7 -> 9
  /* Review of the pass (2026-09-23): "Vibe Coding &#038; Linux" shipped in
     data/discover.json as text. Entities are decoded where they enter data/
     (tools/refresh/entities.mjs) and this suite fails on any left behind. */
  "test/data-entities.test.js": 2,
  /* Audit 2026-09-22, theme H + the jargon ledger: no production vocabulary
     (segment, beat, act, piece, running order) in any listener-facing literal
     of app.js or the player modules — read by a small lexer that is itself
     pinned to see templates and interpolations — and each string that outlived
     its cause (pull to refresh, the home-screen builder, browser copy in the
     shell, the four-queue popup, raw resolver reasons) stays gone, with the
     behaviour behind the copy. ZERO SLACK. */
  "test/listener-copy.test.js": 13, // 2026-09-22: new
  /* 2026-09-18, founder: Lex's episode list reloading from the network on every
     visit. Most of this suite is the three ways a cache goes subtly wrong. */
  "test/show-episodes-cache.test.js": 10,
  /* 2026-09-21, founder: "the show description looks like it's something we
     generated. Is there a field from the show's host that we can pull instead?"
     There was, and the API had been returning it all along — fetchShowEpisodes
     discarded it. Mostly guards that it cannot quietly revert to ours, and that
     arbitrary feed text cannot become markup. */
  "test/show-description-source.test.js": 13,
  /* 2026-09-17, founder: episode descriptions carry clickable links and clickable
     timestamps that seek. This is the one function in app.js that turns untrusted
     publisher text into markup, so about half of it is injection cases. */
  "test/episode-description-links.test.js": 25, // +3 (2026-09-18): the notes collapse into a closed <details> so artwork leads the page, the timestamps still bind inside it, and chapters stay out of it
  /* Stage 3 of docs/episode-pages-plan.md — epRow/archivedRow/bannerHtml
     title links to #/episode/:id (kanban card t_51e5d7bc). Floored at its
     exact current count: this is a small, deliberately-scoped regression
     suite (title link + PR #357 unchanged-controls checks), so any change to
     its size is worth a second look. */
  "test/episode-row-links.test.js": 4, // review of visual pass 1 (2026-09-23): the bannerHtml test was deleted WITH bannerHtml — the function had no caller since the U-11 cutover, and a test on unreachable markup is not coverage (test/card-anatomy.test.js asserts it stays gone); 5 -> 4
  /* The Foray running order's rows (founder report 2026-09-12): every beat
     links to its show page, the curation-code gutter is gone, and a narration
     beat is credited "AI Narrator" with a collapsible transcript. Floored at
     its exact landing count because three of its tests are DEGRADE tests —
     "an unjoinable show is plain text, never a dead link", "a narration beat
     with no cites draws no Sources block", "no committed Foray renders a
     curation code" — and a degrade test is the kind that looks redundant to a
     reader who does not know what it is holding down. */
  "test/foray-row-links.test.js": 18,
  /* Visible explicit-content ("E") badge (kanban card t_02c6bb0b):
     explicitBadge() itself, its four call sites (epRow, archivedRow,
     renderEpisode, renderShow at both episode- and show-level), and a check
     that Family Mode's pre-existing poolFiltered() filter still fires
     unchanged — the badge is additive, not a replacement for that filter. */
  "test/explicit-badge.test.js": 9,
  "test/first-time-onboarding.test.js": 28, // U-09 audit fix (2026-09-10): +2 — the picks re-deal and repaint the FIRST Home, and the pre-pick deal's memory is undone
  /* Duplicate-ID guard for HUMAN-ACTIONS.md's own numbering rule (full-repo
     review finding L3, 2026-08-31). Two tests: the file has numbered items,
     and no numeric ID repeats. */
  "test/human-actions-integrity.test.js": 6, // L8 review (2026-09-23): the founder queue and STATE.md may not point at a retired Foray; 2 -> 6 (5 on disk before it)
  /* "Delete my data" (#42). Zero slack, like media-session above and for the same
     reason: what this suite guards is a PROMISE — both tiers cleared, the server
     rows really deleted, no success message over a failure, and a confirmation a
     stray tap cannot satisfy. Every one of those is one edit from its opposite,
     and the published privacy policy and Play declaration both now rest on them.
     A deleted test here is a false statement in a store submission. */
  "test/data-deletion.test.js": 58, // 2026-09-22 audit: "Delete everything" is red under ui-v2 and the drawer item is not gold; 57 -> 58 // 2026-09-22 audit (theme J, R11): the foray_events queue is purged with everything else, a queue that will not clear is not called clear, a store with no queue is not a success, no status line speaks storage jargon or a count, every store the code opens sits in a deleted-or-kept ledger, and the policy says so; 51 -> 57
  /** The field record's surface (#264) — see the note beside the two `player/`
      halves above. */
  "test/diagnostics-surface.test.js": 19,
  /* The Foray directory AT THE PAGE (FD-03/04/05/01, 2026-09-10): the real app.js
     mounted over the real directory module, resolver, resume store and field
     record. What only this suite can see is the ORDER in init() — cache read
     before the bundle fetches, boot choice before route(), pointer fetch after
     route() and never awaited — and the FD-05 playback cases (a swap mid-session
     leaves the queue and the playhead alone; a vanished Foray reads `dropped`;
     the seam prefetch never warms an unvalidated set's audio). Zero slack. */
  "test/foray-directory.test.js": 16, // +1 L8 (2026-09-22, #236): FD-05 reads its published Foray off the data, with a readable precondition instead of a hard-coded id // +1 F-92 (2026-09-12): a partial seed at the live version is fetched whole once, and the switch then lists the generated draft
  /* "Show draft Forays" (2026-09-11, Wyatt: "I can't see these forays in the
     app"): the founder's test-track switch AT THE PAGE — the real app.js over
     the real resolver and the real data. What only this suite can see is that
     the switch OFF is byte-identical to an app with no switch (three renders,
     four builds, one answer), that ON lists the generated drafts on #/forays,
     Home and a show page and opens + plays them through the published Foray's
     own path, that `?foray=` is untouched either way, and that the drawer
     toggle re-renders without closing the drawer. Eight mutations named in the
     header, each run and seen red. Zero slack: the OFF half is the visitor
     rule's promise, and every one of these is one edit from its opposite. */
  /* K-01's founder switch, the drawer half. Same shape as the drafts switch
     directly below and floored for the same reason: the OFF half is a promise
     that a listener's drawer is byte-identical to one with no switch in it, and
     the ON half is a 90-second CPU burn behind two deliberate taps. Both are one
     edit from their opposite. */
  "test/voice-probe-switch.test.js": 14,
  "test/draft-forays-switch.test.js": 10,
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
  /* FD-06 (docs/foray-directory-plan.md): `vercel.json`'s `headers` block. The
     phone path lives or dies on one line of it — `Access-Control-Allow-Origin: *`
     on `/data/` — and a missing header fails SILENTLY on a phone (the shell's
     refresh reports `offline` and the seed keeps playing), which is why it needs
     a pin nothing in `api/test/` provides (that suite reads `functions`, not
     `headers`). Four tests: CORS present on every rule that serves the
     directory, CORS scoped to `/data/`, #606's Cache-Control split intact, rule
     order. Zero slack. */
  "test/vercel-headers.test.js": 4,
  /* V-01: the narration voice picker's drawer surface — reachable in the
     drawer, the acceptance fixture's 2 installed + N greyed rows, Web
     Speech's no-install-state case, selecting a row, Audition's exact
     counting line, the voiceFallback notice, and close controls. Same split
     as diagnostics-surface.test.js: `player/queue-manager.test.js` covers
     the manager's own voice logic in isolation; this is the app.js surface
     nothing else can see.
     11 -> 22 (2026-09-22 audit, merged): the floor had drifted to eleven under
     a nineteen-test suite; L4 added the one-radio-group cell (qa row 81) and L3
     the two "a rebuild must not throw focus out of the sheet" cells. Set to the
     post-merge count. */
  "test/voice-settings.test.js": 22,
  /* Theme F of the 2026-09-22 audit: tap targets sized by a RULE. Enumerates
     every control the audit measured below 44px and requires a 44px hit area
     by size or by the one `:where(...)::after` rule, checks that rule's shape,
     and pins the gesture findings (the strip's vertical flick, the scrubber's
     touch-action, the double home-indicator inset, Stop vs Close, hover vs
     playing). Sixteen tests, each mutation-checked red. */
  "test/tap-targets.test.js": 18, // visual pass 1 (2026-09-23): the mini bar's ↺15 and the clip rows' text buttons join the measured list; 16 -> 18 (two sweep tests had landed unfloored)
  /* Theme E of the same audit: ONE owner for "a modal is open" — focus in and
     back, `inert`, Tab trap, Escape, one instance, the body lock derived from
     what is open (the back-gesture scroll-lock leak) — plus focus and the
     thumb surviving Up Next's rebuild, and the strip's click suppression.
     Seventeen tests over a small DOM with real parent links and focus, each
     mutation-checked red. */
  "test/modal-and-focus.test.js": 26, // 2026-09-23 audit sweep (qa row 80): part 5 — a route lands lost focus on the page heading (or #view), names the document, leaves surviving focus and announces instead, is silent on a same-page re-render, and pageDidPaint renames an async page; 21 -> 26 (L3 took it to 21 unfloored)
  /* S-08's mechanical privacy tripwire: SHOWS_SEARCH_OFF_DEVICE flag detection
     (source and env), the pinned current-sentence check, the core AND-gate
     that fails release builds only when the flag is on AND the old sentence
     is still present, and the HUMAN-ACTIONS.md G5 cross-reference. Floored at
     5 -> 6 with D-01 (2026-09-06): a sixth test added, scanning player/,
     app.js and data/ for the diagnostic Foray instrument's three identifying
     strings (HUMAN-ACTIONS.md #29) so it cannot silently come back into a
     release build once deleted. */
  "test/release-gates.test.js": 14, // K-06 (2026-09-12): the espeak licence gate, the model pin table, the notices file and the 150 MB app-size ceiling; 7 -> 14 // S-07/G1 (2026-09-12): +1 — the Option-B contract, that §2 states the Shows-search lookup is unconditional rather than merely dropping the old promise; 6 -> 7
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
  /* The full-phrase show-name RESCUE's single-token gate (see the H bug
     kanban t_0eb5f4e1, filed from the t_711dce13 red-team fleet): a
     one-word show-name query in the topic box (e.g. "volts", "radiolab")
     could never reach the rescue because it was gated on
     `interp.groups.length >= 2`. Floored because the live-catalogue battery
     alone regressed silently -- the bug shipped on main with every existing
     suite green. Pins the loosened `>= 1` gate, that `wouldPassGate` still
     short-circuits the rescue for items that already qualify normally (the
     n=1 analogue of the existing "crime junkie" invariant), and the
     11-of-23 one-word shows the bug report measured against real data. */
  "test/search-showname-rescue.test.js": 7,
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
     data-deletion and app-security.

     Raised 33 -> 38 for #558's three code defects (requirements-audit items
     1-3): renderDrawer's missing `|| ""` guard plus playlists()'s missing
     `created` backfill (two tests — the crash and the backfill are separate
     failure modes), bindPlay never stamping last_played_at for an in-app
     playlist play (two tests — the positive case and that a non-playlist
     play never fabricates one), and searchWithRelaxation's `relaxed` signal
     being discarded by buildPlaylist instead of disclosed on the page. */
  "test/playlist-durability.test.js": 38,
  /* #/show/:id, Stage 1 of docs/show-pages-plan.md. Floored because the join it
     guards (show_id first, title-alias fallback for Lingthusiasm) fails
     silently in exactly the way #276's playlist decay did: a dropped fallback
     entry renders zero episodes rather than an error, on one specific show,
     and nothing else in the repo would notice. Every test names its mutation;
     see the suite header for the full list of what each test pins.

     Raised 39 -> 43 for show ARTWORK, which fails the same silent way: 53 of
     catalog.json's 220 shows carry `artwork_url: null`, every render site took
     its else-branch, and the result was a flat grey tile that reads as one
     broken show rather than a quarter of the catalogue. The four added tests
     pin the discover-pool fallback; that a genuine absence still renders the
     placeholder rather than a broken image; that its memoised pool index
     follows the pool it was built from (rendered twice on purpose — this
     harness gives every test a fresh vm context and a browser gives a whole
     session ONE); and the implication over the real data, pool has artwork
     => the show resolves artwork.
     2026-09-14, +1 (issue #687): two tests here CHANGED SUBJECT rather than
     being deleted, and one was added. They used to pin that a breadth show
     and a curated show with zero discover-pool episodes get DIFFERENT empty
     copy — and both of those strings were the ones the founder told us to
     stop shipping ("don't blame it on 4a"), the first of which is #687's bug.
     The tier distinction went with them, deliberately: `tier` is a fact about
     which ingestion path found the show, invisible and unactionable to a
     listener. What the two tests now pin is what they were really protecting —
     a breadth show_id RESOLVES rather than 404ing, and neither kind of show
     claims to be empty while its fetch is in flight — and the third asserts
     the copy itself, at the two states most likely to regress. The four
     OUTCOME states those two used to conflate are floored separately at
     test/show-episode-load-states.test.js. 43 -> 44. */
  "test/show-page.test.js": 44,
  /* Founder reports, 2026-09-13. The "Show more episodes" control came out of
     the show page, so show-page-pagination.test.js was RE-POINTED rather than
     shrunk — same five tests, now pinning the absence of the control, the
     absence of a silent auto-pager in its place, and the count label the
     founder had deleted. Its floor is deliberately unchanged: this file is the
     one that would have noticed a quiet gutting, and a removal that keeps its
     coverage should not need to lower anything.
     show-page-search.test.js gained the eighth: the founder's actual bug,
     pinned from the search side — no Show more control may sit under a set of
     scoped search results, which is the case the pagination suite could not
     see because none of its tests ever typed a query. */
  "test/show-page-pagination.test.js": 5,
  "test/show-page-search.test.js": 8,

  /* The third founder report of 2026-09-13: the now-playing bar must be off
     the screen while a soft keyboard is up (it used to ride up onto the top of
     the keyboard on the first scroll). Floored on its own rather than folded
     into a show-page suite because the mechanism is global chrome — the
     keyboard can open on any screen with a text field — and because most of
     what it guards is the fix's escape hatches: the two independent ways the
     bar comes BACK, and the no-visualViewport fail-open. Those are exactly the
     assertions a future edit is most likely to drop as redundant. */
  "test/now-playing-keyboard.test.js": 7,
  /* 2026-09-17, founder: the page must not pan sideways and a double tap on a
     transport control must not zoom. Declaration-level pins — neither gesture is
     reproducible in this process; the file says so in its own header. */
  "test/no-horizontal-scroll.test.js": 11, // 2026-09-23, founder: "Remove the zoom functionality." — the 'keep pinch' pin is inverted and three layers join it (root touch-action, the gesturestart guard, the shell's zoomEnabled: false); 8 -> 11

  /* The bottom edge of the screen while a soft keyboard is up — three founder
     reports from 2026-09-14, on build 2026091419, all on the search page.
     Floored as one suite because all three are answered by state that has to
     survive things it previously did not:

       the tab bar yields to the keyboard    ("when the search bar is up, this
                                              home ribbon should go away")
       the pill stops re-docking every frame ("the search text box moves a
                                              bunch and tries to stay above
                                              the keyboard")
       a downward scroll dismisses           ("the keyboard should naturally
                                              collapse")

     THE THREE MOST DELETABLE-LOOKING ASSERTIONS IN IT, named because a floor
     cannot see which tests it is holding up and these are the ones a future
     edit would call redundant:

       - "setBodyClass still discards the page-scoped classes". The allowlist
         reads like a bug ("why not just keep everything?") until you see that
         `sh-compose` reserves room for a bar that exists on one screen.
       - "the tab bar stays while results are being read with the field
         blurred". This is a DELIBERATE narrowing — the predicate beside it is
         right there and looks like it should be reused — and getting it wrong
         traps a listener on the search page with no navigation.
       - "resize is NOT throttled". The throttle is the fix; the exemption
         looks like an oversight and is the thing keeping the mini-player off
         the top of the keyboard.
       - "styles.css parses to the end". It looks like it belongs to no
         feature, and it belongs to all of them: this change shipped a
         comment closer with no opener into styles.css, every brace still
         balanced, every text-reading node suite stayed green, and Chromium
         silently discarded the last ~800 rules of the file. A CSS syntax
         error has no error.

     The neighbouring files keep their own subjects: search-field-bottom.js
     owns where the pill sits, now-playing-keyboard.test.js owns the keyboard
     DETECTOR, collapsing-header-scroll.test.js owns the header. */
  "test/keyboard-chrome-and-scroll.test.js": 16,

  /* Kanban t_d5079285 (recreated — was mistakenly archived as t_623d16a7) —
     episode page: publish date (A1.2), full episode description additive to
     the curated hook (A1.1), chapter markers as a genuinely separate
     mechanism from foray segments (A1.5, Joey's Q5 answer), and the show
     page's newest-first sort with no filter controls (Joey's Q7 answer).
     Every test names its mutation; see the suite header for the full list
     of what each test pins. */
  "test/episode-page-publish-date-description-chapters.test.js": 12,

  /* Episodes section under Shows search (S-07, kanban t_6baccaa0): six
     mutations named and killed in the file's own header — rendering,
     Apple-vs-live captioning, empty-result absence, offline skip, stale
     response drop, and in-app playability of a result. */
  "test/episode-search.test.js": 18, // adversarial review (2026-09-12): the three defects the P-05 episode tier shipped with — a search paint writing the endpoint's thinner row shape back over a REAL stored episode's snapshot, a show-page save that could never dedup against its own endpoint copy, and the show index landing mid-query clearing an answered episode section; 14 -> 18 // P-05 piece 2 (docs/search-parity-plan.md, 2026-09-12): the INSTANT EPISODE TIER — the first half of the two-pass shape, over the listener's own cp_saved/cp_queue. Paints on the keystroke before any network call, matches the show name as well as the title, merges the endpoint's copy of a saved episode instead of duplicating it, never lets the Apple caption label a local row, survives a dead endpoint, answers offline, refuses state.itemIndex as a source, and clears a previous query's rows; 6 -> 14


  /* The home screen's geometry under DEVICE conditions. Floored because every
     defect it pins was invisible in a desktop browser — all four turn on
     `env(safe-area-inset-top)`, which is 0 on a desktop and ~59px on a notched
     iPhone, so nothing in CI or in anyone's browser would have caught them and
     they reached TestFlight. The suite evaluates the real stylesheet's box
     model (var/env/calc, border-box arithmetic) at both inset values rather
     than grepping for strings, so a fix that merely mentions `env()` still
     fails. Every test names the one-line mutation that kills it; six mutations
     across these five tests were run and all six went red. A review round then
     found four MORE wrong stylesheets the first draft passed — see that file's
     header for what each of them broke and which line now stops it. */
  /* 6 -> 8 (2026-09-22 audit): Home v2's element no longer inherits `.home`'s
     one-screen floor through its second class (it always scrolled by the tab
     bar's height), and a stretch card's bridge line is a row of its own. */
  "test/home-layout.test.js": 9, // review of visual pass 1 (2026-09-23): a snapped rail card rests on the gutter (scroll-padding equals the rail padding); 8 -> 9 // U-11 cutover (2026-09-06, kanban t_a3f01c8a): BUG 5's flag-off #banner-slot test retired with cp_ui_v2 (renderHome always renders Home v2 now, which has no #banner-slot); 7 -> 6

  /* Stage 3b of docs/show-pages-plan.md — full per-show RSS ingestion
     (kanban card t_567b570f): renders the curated pool synchronously so
     the page is never blank while the endpoint fetch is in flight, swaps
     in the full-catalogue list on success, degrades to the curated pool
     on any fetch failure (never blank), proves every full-catalogue
     episode is in-app playable (real audio_url, no link-out), and surfaces
     a stale-cache note rather than hiding it. Client wiring only — see
     backend/test/showEpisodesStore.test.ts and ingestShowFeed.test.ts for
     the ingestion/storage side. */
  "test/show-pages-3b-full-catalogue.test.js": 7,

  /* Issue #687: the show page's episode region has four states and ONE
     WRITER. Founder screenshot, 2026-09-14, with "Couldn't load this show's
     episodes right now." and "Fetching this show's episodes… Check back
     soon." on screen at the same time.

     ITS OWN SUITE, not additions to show-pages-3b above, because the subject
     is different in kind. That file is about the FETCH — does the endpoint
     get called, does a row come back playable, does a failure degrade. This
     one is about the CONTRADICTION that was possible between two regions
     describing one outcome, and the reason it was possible: the body was
     composed inline in the initial innerHTML, painted once before the fetch
     resolved, and exactly one of three terminal outcomes ever wrote it
     again. A suite whose subject is "these two can never disagree" reads as
     noise inside a suite whose subject is "the endpoint works".

     THE ASSERTION MOST AT RISK, named for the same reason as the suite
     above: "a curated show keeps its real rows when the full-list fetch
     fails". It looks like it contradicts the failure states around it. It is
     the branch that stops a careless version of this fix from deleting
     playable content in order to display an error about content the listener
     cannot tell is missing. */
  "test/show-episode-load-states.test.js": 15, // 2026-09-22 audit theme G: the failed body's "Try again" re-runs the same fetch; "couldn't refresh" is said only once a refresh has failed and is cleared by one that succeeds; the description paints on the empty branch too; 10 -> 15 // 2026-09-22 audit: the loading+CURATED cell, the one quadrant the case list never covered — and the one the subtitle/body contradiction lived in; 9 -> 10
  /* The three-state convention everywhere ELSE (audit 2026-09-22, theme G):
     "No shows here yet." / "0 shows" over a failed catalogue, "Show not found."
     for a dead endpoint, not-found pages with no ‹, and #/forays painting "0
     forays" whenever the player module had not evaluated. The one to guard
     hardest is "#/forays waits for the player instead of saying there are no
     Forays": it is the one a "simplify renderForays back to synchronous" edit
     would silently undo, because every existing harness mounts with the bridge
     already present. */
  "test/load-states.test.js": 29, // 2026-09-22 persona #28: while the playlist scan behind the Shows search results is owed the section says "Still looking for playlists…", and a scan that throws still ends it; 27 -> 29 // 2026-09-22 persona #43, cold boot: "Loading 4a…" before the first await, a boot failure with Try again, the first route() not waiting on the search-only documents, their arrival replacing the scorer's ctx, and a playlist build waiting for them while they are in flight; 22 -> 27 // 2026-09-22 persona #4: a play button whose play() throws or refuses reports it to the player bar instead of swallowing the tap; 21 -> 22 // 2026-09-22 theme L: rows say "Played"/"NN min left", "played" survives the history ring rotating, a subject card totals only a fully-timed list; 18 -> 21 // 2026-09-22 theme L: the Foray header counts the strip's clips and heard shows, says "about" over an estimated runtime, and never promises "listed below" for a clip the page cannot list; 14 -> 18 // 2026-09-22: the Shows search says "Searching for …" until the catalogue, directory and shard passes have all answered, scopes its empty note to shows, and offers Try again (a failed pass) or the subject's categories (a label query) instead of a dead end; 10 -> 14 // 2026-09-22: new

  /* Requirements A3.2/A3.3 — category browse + all-shows index (kanban card
     "Build: category browse — linkify taxonomy chips + all-shows index"):
     the taxonomy-chip link itself, the showsForCategory overlap join against
     the real catalogue, renderCategory/renderAllShows (including honest
     unknown-category/empty-catalogue states), the two new routes, and the
     menu's "Shows" entry as the one affordance that replaced the removed
     "Browse all shows" link (and that the link is gone). Every test names
     its mutation; see the suite header for the full list of what each test
     pins. */
  "test/category-browse.test.js": 17, // #684 report 1 (the browse tiles return 0 results): the root/leaf mismatch that made 32 of 41 tiles empty, pinned structurally on the committed catalogue; the tile linking to #/shows/q/<label> rather than #/category/:id; the ampersand round trip through the hash; the new route and its undecodable-hash guard; and — the one that must not be dropped — that #/category/:id is NOT dead, because the show page's own chips still lead there and every id THEY can emit lands on a page with at least that show on it. 11 -> 17

  /* Stage 2 of docs/show-pages-plan.md — show search (kanban card
     t_1c9afc67): SearchEngine.searchShows against the real catalogue,
     scope-boundary proof that the topic scorer is untouched, and the
     search as the Shows page's own affordance (distinct form, distinct
     results list, honest empty state, absent from Home). Every test names
     its mutation; see the suite header for the full list of what each
     test pins.

     Raised 11 -> 17 for U-05 (docs/ui-transition-plan.md, kanban
     t_53381ee4): two tests pinning that a v1 (flag-off) listener gets
     neither the new Playlists-search section nor the new browse-subjects
     pill row this card adds to renderAllShows -- the "offline behaviour
     unchanged" half of the card's own acceptance line, which is exactly
     the accumulation this suite's floor exists to prevent regressing
     unnoticed. */
  "test/show-search.test.js": 15, // U-11 cutover (2026-09-06, kanban t_a3f01c8a): the two v1/flag-off tests ("no Playlists-search section at all"; "no browse-subjects pill row") were retired along with cp_ui_v2 — ui2On() always returns true now, so those guards are unreachable; the surviving "no matching playlist" test was kept, renamed. 17 -> 15
  /* S-01 (docs/search-plan.md, kanban t_46366383): the WIRING of
     app.js's renderShowSearchResults into the diagnostics record — one
     recordSearch call per completed query, qLen only (never the query
     text, the card's own MUTATION line), local/net hit counts, the
     local-only/local+net/superseded path field, and that a missing or
     throwing bridge never breaks the search itself. */
  "test/search-probe-record.test.js": 9,
  /* The S-deck's client half (docs/search-plan.md, cards S-02 to S-05).
     Four suites rather than one addition to show-search.test.js, because they
     fail independently and for different reasons — which is the same argument
     the field-record trio at the top of this file makes:

       `show-search-live.test.js`     S-02/S-03's LOAD BEHAVIOUR: a keystroke
                                      paints locally and fires no fetch; ten
                                      keystrokes inside 250 ms produce one
                                      costly pass; submit skips the debounce;
                                      clearing restores the A-Z list; the
                                      index is fetched zero times before the
                                      box is focused and once after, and a
                                      504 on it is invisible to the listener.
       `show-search-ranking.test.js`  S-04's RULE: four buckets, curated
                                      before breadth, the popularity prior
                                      BUCKETED (never raw — `chart_rank` is
                                      per-genre and from one harvest), and a
                                      determinism check over the real
                                      catalogue in two input orders. Plus
                                      P-03b's REFUSAL: the author is not a
                                      ranking signal, pinned on the real
                                      Apple strings that measured worse.
       `show-index.test.js`           S-03's CLIENT half over the real
                                      committed data/show-index.tsv: the sort
                                      order the binary search depends on,
                                      parity with a reference linear filter
                                      on the whole 12-query probe battery,
                                      the gzipped budget, and the id shape a
                                      tapped result resolves through.
       `show-search-cache.test.js`    S-05's hot-query cache: a repeat fires
                                      zero requests, a failure is not cached,
                                      the bound clears rather than grows, and
                                      no query text reaches localStorage.

     A single merged suite would let any one of those four be gutted while the
     others kept the file's count up, which is precisely what a floor cannot
     see. */
  "test/show-search-live.test.js": 10,
  "test/show-search-ranking.test.js": 16, // P-08 (docs/search-parity-plan.md, 2026-09-12): the MATCH TIER is interposed above the bucket, so the popularity prior can speak across prefix and word-start — four tests (the charting word-start row wins; the bucket still breaks the tie the prior cannot; the exact/mid-word edges hold against the prior; and the real committed index puts nothing worse-banded above the show the listener meant); 12 -> 16 // P-03b (docs/search-parity-plan.md, 2026-09-12): the author bucket was BUILT, measured against the live directory over 20 host-name queries, and refused — two tests pin the refusal on the real Apple strings (`tim ferriss` promotes his audiobooks over his show; `andrew huberman` promotes three SEO-stuffed artist fields over Huberman Lab); 10 -> 12 // client audit (2026-09-12): the server twin is pinned mechanically — backend/src/catalog/searchBreadthShows.ts’s bucket table is read and compared to this file’s, so a fifth bucket cannot land on one side only; 9 -> 10
  "test/show-index.test.js": 11,
  /* The search PAGE's chrome, as opposed to the search itself (founder
     reports, 2026-09-13): no catalogue subtitle, the browse furniture hides
     while the field is in use, and the search field lives inside `.page-head`
     so the collapsing header carries it. Its own suite rather than additions
     to show-search*.test.js because none of it touches matching, ranking or
     the network — it is where things are rendered and when they are hidden,
     and it would be invisible inside a file whose subject is what a query
     returns. The scroll MECHANISM it depends on stays floored separately at
     test/collapsing-header-scroll.test.js.
     2026-09-13, same day: the founder moved the search field to the BOTTOM of
     the page ("model it after most other text boxes, for example in the
     Claude app or Apple Podcasts"), superseding his own scroll-up report. The
     three tests that pinned the field INSIDE `.page-head` were rewritten to
     pin the negative — not in the header, header back to one shape, no field
     on the category page — so the count is unchanged at 15 and the file's
     subject is unchanged with it. The positive lives next door. */
  "test/search-page-chrome.test.js": 15,
  /* The bottom-docked search field itself (founder, 2026-09-13). A SEPARATE
     file rather than more tests in the one above, because its subject is the
     bottom EDGE of the screen and not the search page's content: where
     `#sh-compose` sits in a stacking order it shares with `.tab-bar` (55) and
     `#foray-player` (60), how `--sh-dock` composes the room those two take,
     and the `--kb-inset` measurement installKeyboardChrome now publishes
     alongside `body.kb-open` so the field rides above the keyboard instead of
     behind it. That last part is shared ground with
     test/now-playing-keyboard.test.js, which owns the DETECTOR; this file
     owns the measurement derived from it, and asserts the two never split.
     Same day, +9: the founder checked Apple Podcasts on his own phone and
     sent screenshots ("they seem to have nailed it"), which settled the shape
     against a guess — a floating translucent pill inset from both edges with
     content reading through it, a circular companion button that arrives with
     the keyboard, a leading magnifier and no microphone, and Escape and that
     button as one code path. 22 -> 31.
     2026-09-14, +3: the founder deleted the Go button from inside the pill
     ("since the search results are live, the 'go' button is useless"), which
     is three separate claims and not one — the trailing slot is empty, the
     `submit` path SURVIVED the control (it is what a phone keyboard's return
     key fires, and how the keyboard is dismissed from inside the field), and
     neither of the two CSS rules that styled it is left selecting nothing.
     The middle one is the reason this is not a one-line deletion, and a floor
     that let it be deleted would let the return key stop working with every
     other test in this file still green. 31 -> 34. */
  "test/search-field-bottom.test.js": 36, // +2 (2026-09-17): focusing the field scrolls the page to the top, and re-baselines lastScrollY to the position it moved to — the founder's "it jumps down to the bottom" report
  "test/show-search-cache.test.js": 12, // client audit (2026-09-12): the EPISODE half of S-05 — its own hot-query cache, the pre-fetch token check, and the one record that now carries epMs/ctaMs; 6 -> 12
  /* S-05 (4a-shows-pipeline-plan.md §3.2, kanban t_546eac9f): the shard-index
     client's PURE functions in search-engine.js — tokenising a query into a
     shard key with the same NFKD-fold the builder uses, picking the longest
     token's shard, filtering a shard's rows by every remaining token (AND),
     and ranking exact > prefix > word-start > substring with a curated tie-
     break and the shard's own popularity order preserved beneath it. Own
     suite rather than folded into show-search-ranking.test.js because its
     subject is a different data source entirely (the shard row shape, not
     the title-only show-index.tsv/catalogue), and it is pinned against the
     real tools/shows/shard-build.mjs builder rather than trusted by
     inspection — two of the seventeen tests import that file directly and
     assert agreement over a fixture vocabulary. */
  "test/show-search-shard.test.js": 19,
  /* S-05 (4a-shows-pipeline-plan.md §3.2, kanban t_546eac9f): the offline
     rule (D9) — the shard fetch is skipped, not attempted-and-failed, when
     `navigator.onLine === false`, painting zero shard requests and showing
     "Showing shows available offline"; plus `showById`'s `pi:` resolution
     and the `#/show/pi:<n>` route a shard result opens. Own suite because
     its subject is the OFFLINE/network-skip contract and the new id space,
     neither of which show-search-shard.test.js's pure-function tests touch
     (those never construct a DOM or a fetch at all). */
  "test/offline-search.test.js": 13,
  /* S-06 (2026-09-12): the Apple fall-through is asked for only on a genuine local miss,
     its rows render and cache like any other breadth row, and a breadth show page survives
     a cold open. Restored with the card after a merge took main's side on app.js. */
  "test/show-search-fallthrough.test.js": 27, // #684 report 2: the list only ever grows DOWNWARD — a later pass appends beneath what is painted instead of re-ranking the whole list under the listener, and its additions are still ranked among themselves; plus the empty-state note naming no catalogue of ours (founder, 2026-09-13: "don't blame it on 4a"). 24 -> 27 // adversarial review (2026-09-12): a degraded/rate-limited directory answer is HTTP 200 and was cached as an answer for the session (with the fixture that could not model it, and the telemetry that hid it), the title dedup missed the subtitle divergence the committed catalogue already carries, and the show index landing mid-query replaced the painted list instead of merging into it; 19 -> 24 // P-03 (docs/search-parity-plan.md, 2026-09-12): the BYLINE — the half of "index the author" that survived measurement. A directory row renders its author, a row without one renders no byline element (the shared curated callers stay byte-identical), and the string is escaped rather than trusted; 16 -> 19 // P-02 (docs/search-parity-plan.md, 2026-09-12): the directory became a SECOND PASS instead of a last resort — the reversal itself, the `tim` case that kills every count threshold, the 3-character floor in both directions, Apple's duplicate-title collapse and its catalogue-row boundary, "a failed directory pass leaves the local list exactly as it was", the directory's own hot-query cache, and the two-language pin on the normalised-title rule; 10 -> 16 // client audit (2026-09-12): Apple's ranking survives the merge instead of being re-sorted A-Z; 7 -> 10
  /* REACH (defect 1, 2026-09-13): can the app answer with a row the device is
     already holding? Floored new rather than folded into show-search*.test.js
     because it is the only suite that runs the app over the COMMITTED
     data/show-index.tsv with no endpoint answering at all — the three suites
     beside it each cover a correct component (the scan finds, the comparator
     orders, the directory is asked) and none of them could see the app simply
     not calling the scan, which is how a `chart_rank` 1 show went missing from
     the client's answer at any position. */
  "test/show-search-reach.test.js": 5,
  /* U-05 (docs/ui-transition-plan.md, kanban t_53381ee4, resolves issue
     #135): the Playlists results section under Shows/Episodes on the Shows
     page, plus the "Create a playlist about X" CTA. Floored new rather than
     folded into show-search.test.js because it pins a genuinely separate
     concern -- D5/D7's own-playlist-match + generated-candidate logic and
     the D8 CTA retarget -- with its own scope-boundary proof that
     search-engine.js's scorer is untouched (the card's explicit "ranking is
     presentation-only" line). 18 tests: playlistMatchesQuery's title/topics/
     case-insensitivity/empty-query rules (4), generatedPlaylistCandidatesForQuery
     reusing state.cardSlots with no new backend (3), the Shows-page section's
     own-first-then-generated order and badge and de-dupe and honest-quiet
     behavior (4), the CTA's gating/copy/no-second-creation-path rules (3),
     the whole section gated off for a v1 listener (1), and two scope-boundary
     proofs that neither SearchEngine's exports nor its scoring output moved
     (2, mirroring show-search.test.js's own such test). Every test names its
     mutation; see the suite header for the full list of what each pins. */
  "test/search-playlists.test.js": 19, // client audit (2026-09-12): topicSearchStatus and buildPlaylist score a query once, through one extracted pass; 17 -> 19 // U-11 cutover (2026-09-06, kanban t_a3f01c8a): the v1/flag-off "no Playlists section, no pill row, no CTA" test was retired along with cp_ui_v2 — ui2On() always returns true now, so that off-state is unreachable. 18 -> 17
  /* Home information architecture (founder instruction, 2026-09-03: "the
     home page has so much clutter. Menu should have the following pages:
     Home, Shows, Playlists, Forays, Up Next."). The move matrix: each of
     the four surfaces that left Home (vouch row, show search, playlist
     builder, foray list) asserted absent there AND present on its menu
     page, the drawer pinned to exactly those five entries in order, the
     new #/forays route, and "Up Next" proven to be a page over real
     cp_queue state rather than a slot filled to match the list. Floored
     because the failure it guards is ACCUMULATION — Home regrew its
     clutter one "just one more row" at a time, and a suite that can be
     deleted in an auto-merged PR guards nothing. Every test names its
     mutation; see the suite header. */
  "test/home-information-architecture.test.js": 10, // U-11 cutover (2026-09-06, kanban t_a3f01c8a): the v1/flag-off "foray list renders on #/forays and not on Home" + "Jump back in moved" tests were retired — Home always renders Home v2 now, which intentionally DOES show a "Jump back in" row (covered by test/home-v2.test.js); the ".home renders banner+cards4 and nothing else" test was rewritten to pin Home v2's shape instead. 12 -> 10

  /* U-03 (docs/ui-transition-plan.md, kanban t_6e8343b6): Home v2's four
     sections plus the greeting, behind cp_ui_v2, with the exploration floor
     (D1/#123). Floored for the same reason as the suite above: the floor
     itself ("Forays for you"/"Episodes for you" always reserve a visibly-
     labelled stretch slot with its bridge line) is a product decision Wyatt
     made explicitly to resolve a founder gate, and it is exactly the kind
     of thing that regresses silently — nobody notices a personalization
     feed slowly stopped surprising anyone. Every test names its mutation;
     see the suite header. */
  "test/home-v2.test.js": 9, // F14 (2026-09-08): generated playlists are interest leaves, not card slots
  "test/home-v2-real-data.test.js": 5, // U-03 audit fix (2026-09-10): Home v2 over the committed data/*.json at insets 0/59; the Forays-for-you floor's documented fallback with one published Foray
  /* Starred shows (follow-lite), requirement A2.4 / Joey's Q2 answer.
     Kanban card "Build: starred shows (follow-lite) + dedicated Starred
     Shows page". Floored because this is exactly the #276/show-pages
     shape: a per-device marker whose decay (a dropped guard, a wrong
     storage key, a missing route branch) is silently wrong rather than a
     crash, and nothing else in the repo would notice. Every test names
     its mutation; see the suite header for the full list of what each
     test pins.

     Raised 8 -> 9 with the show-artwork fallback: a starred entry is a
     snapshot, so it keeps `artwork_url: null` forever for the 53 shows
     harvested without one, and the row now resolves through the live show
     record. Without a test the fallback is the one artwork call site nothing
     would notice losing. */
  "test/starred-shows.test.js": 9,
  /* "Up Next" listening queue, Stage 1 of docs/listening-queue-plan.md
     (kanban card t_f4da81f5). Floored because the queue's own decay path
     (an id ageing out of the pool, or the queue emptying) is exactly the
     #276/show-pages shape: silently wrong is the failure mode, not a crash.
     Every test names its mutation; see the suite header for the full list
     of what each test pins. */
  "test/up-next-queue.test.js": 13,
  /* Library screen (#/library, `docs/ux/foray-mockup.jsx`'s LibraryScreen,
     kanban card t_a1e7a69c). Floored for the same reason up-next-queue is:
     the four sections' decay path (an aged-out saved/history id, an empty
     playlist/queue) is the #276 shape, silently wrong rather than a crash.
     Also pins that Playlists/Up Next stay LINKED summaries rather than
     embedded row lists, and that no interpolated href on the page bypasses
     the in-app hash-route/safeUrl composition every other page uses. */
  "test/library-screen.test.js": 17, // 2026-09-22: Forays and Followed shows are Library sections, one name for #/shows, the ↻ refreshes in place; 11 -> 17 (L1's in-place Up Next reorder cell went at integration: L3's afterQueueMove fixes the same finding and is pinned in test/modal-and-focus.test.js)
  /* Settings drawer stays open on toggle (Joey, 2026-08-31, t_0c09d83a): the
     three toggles' click handlers, plus the two real-navigation regression
     guards. */
  /* The drawer leaves when it is used (founder, 2026-09-23: "the menu should
     automatically collapse"). One owner rule in the capture phase, the two
     declared stays (toggles, the Developer summary), the overlay and scrim
     each closing only their own thing, focus back to the ☰, and the founder's
     exact tap sequence. Floored at its count: every cell is one mutation. */
  "test/drawer-ownership.test.js": 11,
  "test/drawer-settings-toggle.test.js": 13, // 2026-09-22 audit (R7, R8): "Open in" and its dead code are gone (replacing the test of its switch), and the founder tools sit in one collapsed Developer group above Delete my data; 12 -> 13 // client audit (2026-09-12): the sixth switch (cp_interlude, disclosed since FD-06 with no control), the one `drawerToggle` shape, and the retired ui-v2 debris; 6 -> 12
  /* "Up Next" auto-advance (docs/listening-queue-plan.md §8 addendum, kanban
     card t_b9880844). Floored for the same reason as up-next-queue.test.js
     above: the auto-advance decision path (off-by-default, queue-origin
     scoping, end-of-queue stop, mid-playback removal) is exactly the shape
     of silent-wrong-behavior this repo's floors exist to catch, not a crash
     path any other suite would notice going missing. Every test names its
     mutation; see the suite header for the full list of what each pins. */
  /* The page's wiring around those rules (NE-13): app.js delegates to them,
     re-sends the plan when the Continuous playback switch moves mid-episode,
     and writes `cp_engine_applied` before logging a replayed advance or
     position. Each is one deleted line from a car that plays the wrong thing,
     or a history that counts a drive twice. */
  "test/engine-continuation.test.js": 6,
  "test/up-next-autoadvance.test.js": 11, // 2026-09-22: rewritten for the continuous-playback ruling (on by default, Up Next first, then the chosen list, unplayable rows passed over); 6 -> 11
  /* U-07's Interests page (docs/ui-transition-plan.md D6, kanban card
     t_1cb3688a). Floored for the same reason as up-next-queue.test.js: a
     wrong row set, a wrong slider range, or a drag that silently fails to
     persist are all silent-wrong-behavior, not a crash any other suite
     would notice. Every test names its mutation; see the suite header. */
  "test/interests-page.test.js": 14, // 2026-09-22 audit (theme J + persona jargon ledger): a missing taxonomy.json writes nothing over the profile, an id the taxonomy dropped survives a save, and no raw taxonomy id or "Reset to learned" on the page; 11 -> 14
  /* The root-node interest bug this same card fixes (D6): loadInterests()
     used to seed leaf nodes only, silently dropping a root-level interest
     on the next save. Floored separately from interests-page.test.js
     because it pins the DATA layer (loadInterests/saveInterests/
     nudgeTopics), not the page — either could regress without the other
     noticing. Includes the MUTATION TEST the card asks for by name
     (restore leafNodes() as the seed set -> red). */
  "test/interests-roots.test.js": 8,
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
  /* Thin anchors (#209): "Electrical Circuit Design Dummies" returned
     game-design and personal-finance content, not electronics, because a
     real but catalogue-thin, unmodeled token ("circuit") could be silently
     outvoted by a commoner co-token ("design") under OR semantics. Floored
     because the fixture half of this suite is the only place the exact
     failure shape is reproduced under full control (a synthetic pool sized
     so corpusDF crosses THIN_ANCHOR_DF deliberately), and the live-catalogue
     half is the literal reproduction of Joey's bug report -- deleting either
     would let the thin-anchor gate regress silently the way the original
     bug shipped silently. Every test names the mutation that kills it. */
  "test/search-thin-anchor.test.js": 10,
  "test/search-plural-scaling.test.js": 4,
  /* One generation per page load (#233). Floored because the thing it guards is
     invisible in the product: a mismatched code/data pair renders, it just
     renders the wrong program's reading of today's document. Every test in there
     was mutation-checked — see the suite header.
     32 -> 51 on 2026-09-03 (HUMAN-ACTIONS #37). `sw.js` was allowlisted on the
     evidence that THIS suite pins its behaviour; with a floor 19 below the real
     count, an auto-merged `test/` change could thin it while the claim stayed
     green. Zero slack from here on, for the reason media-session has none. */
  "test/sw-generation.test.js": 52, // S-03 (2026-09-12): +1 — cachePut's untracked-path branch is load-bearing now that data/show-index.tsv uses it; 51 -> 52
  /* U-01 (docs/ui-transition-plan.md): the ui-v2 token scope. Four tests --
     the nine tokens' names+values, the "no raw hex leaks outside the block"
     mutation guard, the amber/violet consumption check, and the self-hosted
     font-src proof. Zero slack: each one guards a distinct way the token
     system could quietly stop being a token system.
     4 -> 8 (2026-09-22 audit, theme I): the four above enumerate what v2
     ADDED, and passed while five v1 tokens leaked onto every v2 page on a
     phone set to Light. The new four enumerate what live rules READ (every
     name owned by body.ui-v2, component-scoped, JS-written or structural),
     re-own everything a colour-scheme query can change, check the JS-written
     claim, and resolve the cascade for "Delete everything" to the danger
     token. */
  "test/ui-tokens.test.js": 22, // review of visual pass 1 (2026-09-23): the resting star is --muted, one colour-scheme + one focus ring, note links are authored, violet primaries are never on the card radius, row/card titles are the display face; 17 -> 22 // visual pass 1 (2026-09-23): the radius, type and elevation families are enforced like the palette; the two heading kinds; one wordmark; 11 -> 17 // 2026-09-23 audit sweep (qa row 79): --faint paints no text or live control; --muted is readable on every surface; the --faint utility has no user; 8 -> 11
  /* 2026-09-23 audit sweep: docs/audit/status.tsv has one row per finding under its own title, refuted/deliberate verdicts are kept, and the README table agrees. */
  "test/audit-status.test.js": 3,
  /* U-02 (docs/ui-transition-plan.md, kanban t_806e5d01): the cp_ui_v2 flag
     and the four-tab bar shell. Eleven tests -- off by default, all four
     tabs in order when on, removed (not hidden) when turned back off, the
     native-shell default and its override by an explicit choice (two
     tests plus the plain web-default case), every route mapping to
     exactly one current tab, all 13 routes still resolving with the flag
     on, the Library tab's href, and the two CSS box-model checks that pin
     the "bar and mini-player never overlap content" acceptance line at
     both insets. Zero slack: each one guards a distinct way this flag or
     its bar could quietly stop doing what U-02 asks.
     11 -> 12 with U-06 (kanban t_bd3f749a): the Create tab's href moved
     from #/playlists to its own #/create screen, pinned separately from
     the route-mapping/all-routes tests above (which were updated in place,
     not counted here) because a regression that reverted just the href
     while leaving tabForHash's mapping correct would otherwise pass. */
  "test/tab-bar.test.js": 8, // U-11 cutover (2026-09-06, kanban t_a3f01c8a): cp_ui_v2 is retired — ui2On() always returns true, so the off-by-default, native-shell-default, and explicit-off-overrides-native tests (4 of them) no longer have a flag-off state to assert against; replaced with one "always renders" test. 12 -> 8
  /* U-06's Create screen (docs/ui-transition-plan.md D7+D8, kanban card
     t_bd3f749a): the Foray | Playlist toggle with Foray permanently
     disabled and honestly labelled, and Playlist mode reusing the real
     buildPlaylist() so a playlist built from Create lands on the same
     #/playlist/:id destination and cp_playlists entry the old Playlists
     page's own form produces. Eight tests, floored with no slack: the
     disabled-Foray control is a product promise (D8 — the pipeline exists,
     its key/segment pool don't) and each test is one line from silently
     no longer holding it. Every test names the mutation that kills it. */
  "test/create-page.test.js": 9, // 2026-09-22: a suggestion pill builds from one tap (persona 26); 8 -> 9
  // tools/ is allowlisted for auto-merge too (T3 in automerge-nightly.yml),
  // so suites under it need the same floor.
  /* The icons are generated from tools/brand/4a-logo.png, and this suite is the
     only thing stopping someone editing a committed PNG by hand. Six of its
     seven claimed mutations were run and killed; the seventh is documented in
     the suite as deliberately uncovered, with the reason.

     THE FLOOR IS 10, AND THE SUITE RUNS 14. Not a mistake: the counter above is
     `/^s*test(/gm`, which counts call sites, and six of those runs come from
     two calls inside a loop over SIZES. The loop's own inputs are pinned by
     "SIZES still names exactly the three icons we publish", so an entry cannot
     be dropped to shed tests while the static count holds still. */
  "tools/brand/build-icons.test.mjs": 10,
  /* 2026-09-21, founder: "$134 for this month. Most of that was build CPU
     minutes." The Vercel Ignored Build Step. Most of this suite is the FAILING
     OPEN — a rule that wrongly skips leaves production on older bytes, and the
     saving is a few cents, so every uncertain case must build. */
  "tools/web/vercel-should-build.test.mjs": 23, // 2026-09-23: previews are opt-in (label or preview/ branch); 17 -> 23
  /* 82 -> 84: the app icon's deny entry, and the reason it is a DENY rather than
     an entry in that file's `ACKNOWLEDGED_UNDENIED_GATES` beside its own
     neighbour. Pinned as a named test because the gate-script scan there is
     satisfied either way — moving `inject-app-icon.mjs` from denied to
     acknowledged would keep every check green while re-opening the exposure, and
     what that exposure ships is Capacitor's placeholder on the App Store product
     page, with no manual upload available to correct it.
     84 -> 88 on 2026-09-03 (HUMAN-ACTIONS #37). The four added tests pin the
     ONE thing that decides whether a nightly-refresh PR merges without a human:
     that `deploy-manifest.json` and `sw.js` are on ALLOWED_PREFIXES. Removing
     either entry restores the state in which every nightly PR sat green and
     unmerged, and nothing else in the repo would say so. */
  "tools/ci/path-policy.test.mjs": 90, // 2026-09-22: +1 (and the one-test slack closed) -- tools/release/ is denied; 88 -> 90
  /* The LF-checkout guard on the deploy manifest. Small, and every test is one
     branch of a function whose whole job is to refuse. The load-bearing one is
     the binary exclusion: both committed icons really do carry `\r\n` bytes, so
     dropping it fires the guard on a clean Linux runner and blocks
     `data-and-site` for the entire repo. All 10 named mutations were run and
     killed. */
  "tools/ci/crlf-guard.test.mjs": 10,
  /* The Foray directory pointer (FD-02): `data/forays-directory.json`, written
     and checked by generate-manifest.mjs. 16 pure-function tests on scratch
     trees plus 8 that run the REAL CLI as a subprocess against a synthetic LF
     tree — the only way `--check` can be driven to red on the Windows autocrlf
     checkout, where the real tree is refused by the CRLF guard first. The
     load-bearing ones: a stale pointer and a missing pointer both turn --check
     red by name, and --write is idempotent (a second run is byte-identical), so
     manifest-autofix does not push a built_at-only commit to every PR. Seven
     load-bearing mutations (named in the suite header) were run and killed;
     the other 17 are named in their tests. */
  /* +4 audit finding C (2026-09-12): the rollback clause — a real `git revert`
     end to end (the restored OLD built_at, the base-branch floor, the player-side
     `isOlderThan` verdict), byte-idempotence under every floor shape, the
     --check message, the best-effort degrade with no git, and the stale-branch
     case the merge-base floor must NOT restamp; 24 -> 29. */
  "tools/ci/forays-directory.test.mjs": 29,
  /* +12 (machinery audit, 2026-09-12): the checks-missing self-heal had three
     holes — sweep-only, keyed on `pr.updatedAt` (which this workflow's own label
     writes reset), and firing only when ALL required checks were missing — plus
     the duplicate-dispatch guard, which 85% of dispatched CI runs needed.
     85 -> 97. */
  "tools/ci/pr-triage.test.mjs": 97,
  "tools/ci/run-suites.test.mjs": 36,
  /* The parity recorder (NE-03): --check in npm test, authored cases never
     overwritten, every new or changed case handed to swift-pending.json with
     its port card, and --mutate's kill/survive/pending verdicts with a no-op
     control. Zero slack. */
  "tools/parity/record.test.mjs": 17, // NE-13: a jsOnly family (the continuation hops, plan C-2) records with no port card and owes swift-pending nothing; 16 -> 17 // NE-12j: --mutate on the 15/30 rule is killed by the media-episode fixtures as well as the JS test, now that the family is recorded; 15 -> 16 // NE-07j: a --family record never vouches for another family's unrecorded ids, so that family's authored cases still reach swift-pending; 14 -> 15
  /* THE TYPE GATE, and the reason it is floored at all. Until 2026-09-12 no CI
     job in this repo had ever run `tsc` or `eslint`: `backend/package.json`
     defined `typecheck` and nothing called it, so the TypeScript backend was
     ungated and four real TS2532 errors sat in the tree. The gate now lives in
     one `- run:` line of `ci.yml`, which is one careless "simplify CI" edit from
     being gone with nothing to say so. Deleting it now takes this suite with it.
     Text assertions over workflow YAML — the same idiom as
     tools/mobile/ios-workflow.test.mjs, and the same honest limit: it catches a
     step being deleted, not a step that runs and does nothing. */
  "tools/ci/ci-workflow.test.mjs": 5,
  /* The deck-drift rule (machinery audit finding 6). Decks whose PRs edit the
     deck in the same commit had a 0% false-claim rate; the drift is all in the
     ones where the marker floats free of the merge, and it runs both ways — one
     card claimed work that did not exist while three hid work that did. The
     STRONG version ("every card is DONE-with-a-merged-PR or listed as
     outstanding") was rejected as unwritable without false alarms; see the
     module header. 10 fixture tests naming their mutations, plus 3 that run the
     rules against the real docs/ tree — the last of which is the gate. */
  "tools/ci/deck-claims.test.mjs": 13,
  // The classify fleet. `no-exclusion` is the founder's "label, never filter"
  // ruling made mechanical — of everything floored in this file it is the one
  // whose deletion would be hardest to notice and most expensive to discover,
  // because the thing it guards is an absence.
  "tools/classify/no-exclusion.test.mjs": 25,
  "tools/classify/reconcile-shards.test.mjs": 75,
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
  /* S-01 (docs/search-plan.md, kanban t_46366383): the measurement machinery
     for the search probe (median/p95, timing wrapper, "skipped not failed"
     network contract, the report validator) -- driven by fakes and an
     injected fetch, no real catalogue/network. See
     test/search-probe-record.test.js for the wiring/mutation-guard half. */
  "tools/search-probe.test.mjs": 50, // defect 1 (2026-09-13): +5 — the index battery gained REACH columns beside `scan_reached`, which reported only what a skipped scan SAVES; the rank of a named target show with the scan and without it, a null-not-fabricated rank where no target is named, the lowercase/trimmed key lookup, the validator that refuses a report carrying the latency half and not the reach half, and a pin on `daily`/The Daily so the case the audit found cannot quietly leave the list; 45 -> 50 // P-06 (docs/search-parity-plan.md §2.1, 2026-09-13): +15 — the THREE NAMED PARITY CASES (`tim ferriss`, `lex fridman`, `sam harris`) become a battery of their own, asked plain AND with `fallthrough=1` so that "one row" cannot read as a thin catalogue instead of a gate that was never asked; the target show's 1-indexed rank rides along because `tim ferriss` measured 1 -> 14 rows while The Tim Ferriss Show slid from first to third, and a count-only table calls that an unqualified win; the validator now refuses a report that dropped the section, a case, either column, or the titles; 30 -> 45 // S-03/S-08 (2026-09-12): +3 — the index battery reports the prefix and scan passes separately, and the validator refuses a report that lost either p95 or the whole section; 27 -> 30
  /* S-03 (docs/search-plan.md): the BUILD half of the show index — the merge,
     the in_curated dedupe, the chart_rank cut, the control-character sanitiser,
     the four-column row shape, and the parity of the committed
     data/show-index.tsv with what this script derives. Its sibling,
     test/show-index.test.js, pins the same file from the CLIENT side; both are
     needed because the sort order is a contract between two files and either
     side can break it alone. */
  "tools/build-show-index.test.mjs": 9,
  /* The Windows entrypoint-guard class (machinery audit finding 3). A main-
     module check written as ``import.meta.url === `file://${process.argv[1]}` ``
     can never be true on Windows, so the script's CLI silently does nothing and
     EXITS 0 — `tools/build-catalog-client.mjs --check`, the documented
     regenerate/verify command, certified a catalogue it never looked at. Every
     developer here is on Windows and nothing in CI runs there, so the class is
     invisible from both ends. Floored because the scan is over every tracked
     `.mjs`/`.js` rather than a list: the list is the thing that goes stale, and
     this bug survived in the one file nobody thought to check while seven others
     had already been fixed. */
  "tools/entrypoint-guards.test.mjs": 4,
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
  /* +1 (generation finding F-49): a Foray whose tape §4.5 tier 2 minted THIS
     RUN resolves against the pool the candidate carries, and its seconds land
     on the listener's clock. Before it, a generated Foray with any tier-2 tape
     failed here on an unknown segment_id. */
  /* +2 (generation finding F-74): #65 §2 is now a rule about ANCHORS rather than
     about the `dai_suspected` flag alone — a played segment from a DAI-stitched
     feed is accepted when it carries both of ADR-0007's boundary phrases and
     refused when it carries a timestamp only. Both branches are pinned, and so is
     the half-anchored case. */
  /* LOWERED 130 -> 129 by Q-04: the D5 triple/IQR/mean-deviation cases (7) and
     D3's (1) went with their rules; the pair clause gained six (reported on
     pre-Q-01 tape, gated on a Q-01 Foray, the CLI exit, the row fields, the
     IQR still reported, the helper) and M4's restatement three. */
  "tools/foray/check-forays.test.mjs": 161, // L8 review (2026-09-23): §0 and slot headers declared again, by doc path, so a doc cannot lose them silently; 160 -> 161. L8 (2026-09-22): the pipeline's own words (beat, segment, act, running order) refused in Foray copy — the audit found "eight beats of a forty-beat history" as a title; 159 -> 160. // K-02 (2026-09-12): the phoneme rules — inert on every legacy item, red when one lexicon override is dropped; 129 -> 140. F-103 (2026-09-12): `cites` — the shape, the two resolvability rules (in the pool, AND played by this Foray), the internal-page-record refusal, the dedup and the url rule, each with its own mutation; 140 -> 154. L4-on-roleless (2026-09-15): L4 left the L2/L3 loop, whose `if (!p.role) continue` it had been inheriting — no generated Foray records a role, so the rule had never run on generated tape; 158 -> 159
  /* G-21c fixture-before-emit (F-89). Seven DECLARATIONS, not seven tests: two
     of them sit inside a loop over `ACCEPTED_SHAPES` and expand to one test per
     accepted value (~30 today), so the floor is the count of `test(` lines this
     file's regex sees. Zero slack. The two loop-body declarations are the gate
     itself — every shape the checker accepts must be carried by a committed
     Foray, or be listed in `KNOWN_UNCOVERED` and asserted still uncovered — and
     the source-scan test is what stops a new accepted literal reaching the
     checker without joining the enumeration. Delete any of them and a shape can
     again reach `data/` before a consumer has seen it in CI. */
  "tools/foray/fixture-coverage.test.mjs": 7,
  /* L8 (2026-09-22, #236's last step): the FROZEN fixture — verbatim copies of
     four real Forays that the player suites exercise by id, so `data/` can
     retire or re-curate them without a test migration. Five tests hold it to
     what it claims: it passes the real checker (and the CLI), it contains
     exactly what its Forays play, it still carries the shapes the suites need,
     and TEXTURE_CADENCE_SEC is still what measure-cadence measures on it. */
  "tools/foray/frozen-fixture.test.mjs": 5,
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
  /* The benchmark harness over generation reports (roadmap G-42a). Zero slack.
     What it guards is a class of quiet lie rather than a crash: the harness
     turns `report.json` into the rows of `docs/curation/generation-kpis.md`,
     which is what the roadmap's §1.2 acceptance table will be read off and what
     G-42b will diff once D11 lands. Its failure modes are all plausible-looking
     numbers — a `?? 0` that reports "0 seed-lost beats" for a run that never
     measured them, a *proposed* target printed as though D0 had confirmed it, a
     clip mean taken over the 6 clips a run minted instead of the 10 it played.
     Thirteen of the 38 tests exist only to kill `?? 0`, and two more pin the
     COMMITTED table against the COMMITTED baseline — the archived reports live
     on the generation host, not in this repo, so that pair is the only thing
     that can catch a hand-edited cell in the deck. */
  /* RAISED 38 -> 40 by F-101: the two first-attempt units are separate
     columns and an undeclared unit is never guessed into one; `tape_share`
     reads the renamed report field and falls back to the old name. */
  "tools/generation-bench/run.test.mjs": 40,
  /* The keyless-run transport (#697). This suite is the ONLY thing in the repo
     that can notice the relay losing a behaviour, and every one of those
     behaviours was bought by a finding that cost a run something: I-23's
     ~15-minute deadlock (identity is the request, not the body; `/reset` clears
     the map and the queue together), I-10's stale answer served to a legitimate
     re-ask, I-06's fence strip AND its count, I-19's `agent_ms` kept apart from
     `wall_ms`, I-22's per-request `tools`, F-67's readable-before-answered
     prompt, and P-01's concurrency. Nothing in `backend/src/` knows this
     transport exists — that is the point of it — so nothing there would go red
     if it regressed; a run would simply hang, or publish orchestrator latency
     as pipeline latency. The 12 mutations named in the suite header were each
     applied and observed to fail before it landed. */
  "tools/generation/relay.test.mjs": 27,
  /* #703: the corpus-warming launcher. Small on purpose — the work is in
     backend/src/cli/warmTranscriptIndex.ts and pinned by its own suite — but a
     launcher that spawns an entry that no longer exists fails quietly, and a
     run then proceeds on the cold corpus this issue was filed about. */
  "tools/generation/warm-transcript-index.test.mjs": 5,
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
     size cap, closed in advance this time.

     THEY ROSE AGAIN ON 2026-08-23, from 52 and 46, when the SEGMENT POOL stopped
     being copied whole (#327). Thirteen of `prepare-webdir`'s tests are that slice,
     and the floor is EXACT again rather than carrying the two tests of slack the
     first draft of this entry left: slack in a floor is the number of tests a later
     auto-merging PR may delete without CI noticing, which is the whole failure this
     file exists to prevent. And
     the three not to lose are again the ones a reader would not guess at:

       - "the slice keeps BOTH rows of a duplicated id, because the join reads the
         last one". `indexSegments` is `Map.set` in document order, so the LAST row
         sharing an id wins; a "first match" slice keeps the right id, the right count
         and the right budget and plays the wrong ninety seconds. It CANNOT FAIL ON
         TODAY'S DATA — the real pool has no duplicate ids — and it is the segment
         version of the artwork-anchor test above.
       - "the slice keeps a DRAFT Foray's segments". A draft is reachable by id
         (`?foray=`), which is how a Foray is tested before publishing, so slicing
         against `listableForays` would look like a tightening and ship a Foray that
         resolves to nothing.
       - "REAL REPO: nothing in the app browses the segment pool". That is the PREMISE
         the slice rests on — it is exactly the referenced set, with no topic top-up,
         because nothing enumerates the pool. Delete it and the day somebody adds a
         segment browse surface, it renders empty in the app and full on the web.

     `shell-invariants` gained one: the same slice against TODAY'S real documents,
     independently of the fixture suite. */
  "tools/mobile/prepare-webdir.test.mjs": 84, // 2026-09-22 audit (L2), founder report 3: the bundle carries build-stamp.json with the committed deploy_id; 83 -> 84 // +1 audit finding E (2026-09-12): seedCarries is exactly the negation of the one `isGeneratedDraft`; 82 -> 83 // K-01/K-06 (2026-09-12): the probe passage ships into the shell and a model never does; 78 -> 82 // FD-04 (2026-09-10): the seed is a subset of the directory's files; the seed pointer is optional; 72 -> 74. F-92 (2026-09-12): the seed leaves generated drafts to the directory — the rule on the fixture, the verifier as a reached guard, and the real repo's draft absent from the real bundle; 74 -> 77. S-03 (2026-09-12): the unpinned show index is named, bundled and budgeted; 77 -> 78
  "tools/mobile/shell-invariants.test.mjs": 75, // NE-05 (docs/native-engine-plan.md): the Swift parity library imports no XCTest, reads player/parity in place (no .json copy under the core) and keeps the FORAY_PARITY_DIR / PARITY_REPORT / family-line interface; both XCTest wrappers run the compare and seam-gap families and the whole manifest, and the registry holds both runners; 73 -> 75 // NE-02 (docs/native-engine-plan.md): the core's reducer and its tests are copies whose headers name the ios/ source @ adde5e12 and say ios/ is frozen reference; every one of the 34 original reducer tests survives in the copy, by name; 71 -> 73 // NE-01 (docs/native-engine-plan.md): foray-engine-core is pure (no deps, Foundation-only sources, no XCTest in the parity library); foray-audio links it by path and keeps one product (the scheme list); engineHello is an iOS-only stub that answers from the core; the Preferences pin is test-only and cannot compile out; the page never configures a Preferences group; 66 -> 71 // review 2026-09-23 (fix/founder-reports-2026-09-23): every command the shim and the Java can emit is in REMOTE_COMMANDS; the resume supersedes (no setActive), a pause inside an interruption takes no hold, a lost hold is retaken; the re-assert generation moves with the state and nothing on stateQueue waits on the network (two suites; the runtime count is 70, the static one 66); 64 -> 66 // founder 2026-09-23 (fix/founder-reports-2026-09-23): the shim's webkit door is in the record's vocabulary, and the Swift header + docs state the two-publisher tee model rather than same-tick ordering; fr-ui's two literal-interval pins deleted with the mechanism they pinned; 62 -> 64 // founder 2026-09-23: setActive only from holdSession/releaseSession off the pause transition; a paused transport stays on the lock screen and re-asserts on background; the seek pair has one source on both natives; the toggle resolves from state; every transport event names its door; Android stays READY while paused; 57 -> 62 // +4: the L-05 plugin methods and the M-03 session needle/event name (2026-09-12) // +1: iOS plugin never calls setActive (F11/F13, 2026-09-09); +1: Swift writes the L-02 log needle (2026-09-10)
  /* 2026-09-04: the bundle's JS/CSS is minified (comments + whitespace, identifiers
     kept) and its JSON re-serialised on the way in — docs/mobile-shell.md §3.4.
     `minify.test.mjs` pins the transform (nothing renamed, nothing rewritten, only
     .js/.css touched, the pinned esbuild); the seven tests added to
     prepare-webdir.test.mjs (65 -> 72) pin its place in the build: derived from
     the SOURCE text before anything is minified, never written back over the
     source, deterministic, and the real bundle under `node --check`. tools/mobile/
     is now its own runner group (it carries esbuild), so these run after an
     `npm ci` there rather than from the root; shell-invariants (47 -> 50 on disk,
     floor raised to 50) pins that mobile/package.json's prepare:webdir installs it. */
  "tools/mobile/minify.test.mjs": 8,
  /* `foray-tts`'s JS-side interface (docs/research/on-device-tts.md, this
     card). Guards two things nothing else checks: that a lexicon entry with
     `ipa: null` never becomes a guessed pronunciation override (a silent
     mispronunciation risk, not a crash, so nothing else would catch it), and
     that a native call failure/absence always falls back to Web Speech rather
     than rejecting into a caller's promise chain.

     22 -> 38 (2026-09-05, voice selection). The defect that prompted those is
     native and untestable from Node -- iOS asked `AVSpeechSynthesisVoice(language:)`
     for the SYSTEM DEFAULT voice, the compact/robotic tier, and never for the
     installed Enhanced/Premium ones. What this suite can and does pin is the JS
     half: that a `voice` request reaches the native payload at all, that the Web
     Speech fallback applies one, that a voice which is not installed is REPORTED
     rather than silently substituted, and that `listVoices()` answers on every
     path without throwing. */
  /* K-06's model pins. What stands between "the upstream repository re-uploaded
     this file" and "our app executes whatever is now at that URL" is one hash
     comparison, and the load-bearing test here is that an UNPINNED entry never
     verifies however right the bytes are. Zero slack. */
  "tools/mobile/fetch-models.test.mjs": 18, // K-01 (2026-09-12): the pins are FILLED, and `bundle` decides what reaches a phone; 16 -> 18
  /* The weights-into-the-app step. New with the filled pins (2026-09-12): the
     failure it guards is a build that fetched 82 MB correctly and put it where
     the app does not look — green, uploaded, and answering `model-absent` to a
     founder holding a locked phone. Zero slack, same as its sibling above. */
  "tools/mobile/inject-models.test.mjs": 7,
  /* The phoneme-to-id table and the ids that were mapped through it. The ids
     are the ONLY thing the phone ever sees of our text (deck §4: no G2P ships),
     so a wrong one is not a crash and not silence — it is a different phoneme,
     sung fluently, inside a measurement a founder then quotes. This suite needs
     neither Python nor misaki, which is the point: it re-checks on every CI run
     a file that CI could not have produced. */
  "tools/mobile/kokoro-vocab.test.mjs": 7,
  "tools/mobile/foray-tts.test.mjs": 62, // #685 (2026-09-13): a refusal carries the numbers the phone did produce, and a native payload cannot spread its way into a success; 60 -> 62 // K-01 (2026-09-12): the probe is a SEPARATE call with no Web Speech ladder under it; 53 -> 60 // L-05 (2026-09-12): pause/resume/stop/state on all three paths; 45 -> 53
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
  /* Release reliability (founder, 2026-09-22: "these releases are usually quite
     rocky and fail on a somewhat regular basis"). ZERO SLACK, for the reason
     media-session has none: the STRINGS are the whole mechanism here, and a
     marker that stops matching what altool prints fails SILENTLY -- an
     unclassified failure still retries, so nothing ever goes red. A deleted cell
     would read as coverage of a list that had quietly stopped discriminating. */
  "tools/release/upload-retry.test.mjs": 14, // 2026-09-22: new -- which store-upload failures are worth trying again
  "tools/release/watch-release.test.mjs": 38, // 2026-09-22: new -- the release watchdog + trigger (reliability plan pieces 2 and 3), replayed against the real 00:28 partial failure; 2026-09-23: +2, G2 replays the real 09-06 summary log ("not reached" is unknown, the job decides); +1, the Fetch step executed against an expired (404) summary log
  "tools/mobile/foray-media-session.test.mjs": 98, // review 2026-09-23: a WebKit-door press and an Android Media3 action are recorded under the record's dashed command (remoteCommandFor at the one seam); 95 -> 98 // founder 2026-09-23 (fix/founder-reports-2026-09-23): a BEHAVING fake WebKit reads what its own Now Playing entry would show (the "4a / unknown / unknown" state on main); the severing mutation test inverted; one press through two doors is applied once (both orders, the third copy, the window's end, a same-surface double tap, Android untouched); a WebKit-delivered press is a foray:remote row; inspect().tee; 88 -> 95 // 2026-09-23 founder report ("On the lock screen, it's 10s in both directions"): the iOS takeover mirrors the page's handlers, metadata and playbackState onto WebKit's own session — never seekto — so a press on WebKit's client reaches the page; wrap-mode reaches the prototype without looping; a refused mirror costs nothing; uninstall takes it all back. The suite stood at 81 against 80; 80 -> 88 // 2026-09-22: `sends` cannot be read in the turn of the write, against the REAL default scheduler; 79 -> 80 // M-03 (2026-09-12): the session event reaches the page; 75 -> 79
  /* iOS on a runner (#38). These four are the only tests in the repo that can be
     run for a macOS-only feature by someone with no Mac, which makes their
     deletion unusually attractive to a future session that finds them
     inconvenient. `ios-workflow` is the one to be most careful with: it is the
     only thing in the repo asserting that the iOS job stays OFF the required-check
     list, that its path filter stays narrow (macOS runners bill at 10x), that
     every `xcodebuild ... build` stays unsigned so the job can run with no Apple
     credentials, and that `ci.yml`'s `ios-kit` — the repo's only compiled Swift —
     is still there. Nothing else covers any of that.

     26 -> 41 ON 2026-09-03, when `inject-background-audio.mjs` gained the second
     edit a generated Info.plist needs: `ITSAppUsesNonExemptEncryption`, the key
     Apple named to the founder that stops App Store Connect asking the encryption
     questions on every upload. Fifteen tests, and the one not to lose is "an
     existing `true` is REFUSED, never quietly flipped to false" — every other edit
     in that file MERGES with what it finds, because a background mode somebody
     added is data. This value is not data, it is a legal statement about the
     binary, and a script that overwrites it has made a false declaration in a
     store submission on somebody's behalf. Two more have no other check anywhere:
     the strict `--encryption` parse (JavaScript's truthiness turns `--encryption
     fasle` into the OPPOSITE declaration, silently, on a green run) and the test
     that asserts the REASONING for `false` is still written beside the key — the
     only defence against the declaration outliving the facts that make it true.

     34 -> 45 for `ios-workflow`, in the same change. Five of those eleven are about
     two steps that did not exist: the icon injection and the encryption
     declaration. The one not to lose there is "both generated-project edits happen
     AFTER `cap add ios` and BEFORE any build" — nothing pinned that order before,
     and both ways of getting it wrong are invisible in the build's own output.

     THE OTHER FOUR ARE THE BUILD NUMBER, and they guard the thing that stopped
     TestFlight entirely: Capacitor ships `CURRENT_PROJECT_VERSION = 1` and never
     moves it, so run 33815045229 took version 1 and every later upload was
     rejected as a duplicate — the founder could receive no new build at all. The
     one not to lose is "the build number is READ BACK out of the archive before
     the upload is spent": a build-setting override that does not reach the bundle
     is completely silent, and its only other symptom is the same altool error ten
     minutes later with nothing pointing at the step that caused it.

     `inject-app-icon` IS NEW, and floored at its exact count with no slack. A
     build reached TestFlight on 2026-09-03 wearing Capacitor's placeholder icon,
     because nothing wired 4a's icon into the generated asset catalog and nothing
     ever looked. The three not to lose, because a reader would not guess at them:

       - "--check compares BYTES, so Capacitor's placeholder does not satisfy it".
         The placeholder sits at exactly the declared filename and is also
         1024x1024, so every check shaped like `test -f` passes on the bug itself.
       - "a catalog with no 1024 slot is REFUSED rather than partially filled".
         Apple removed App Store Connect's icon upload in Xcode 14; the PUBLIC
         LISTING icon is extracted from the uploaded binary's asset catalog. A
         partial write ships a store page with no icon and cannot be fixed without
         a new build.
       - "REAL REPO: the committed icon-1024.png is what the App Store will
         accept". It CANNOT FAIL ON TODAY'S FILE — CLAUDE.md's point 5 — and it is
         the only thing between a future icon regeneration that reintroduces an
         alpha channel and a submission Apple rejects after the upload and the
         wait. */
  "tools/mobile/inject-app-icon.test.mjs": 27,
  /* inject-splash (2026-09-06): the splash and the Android launcher icon were
     Capacitor's placeholders on every build to 2026090603. Same rules as
     inject-app-icon: byte-level --check, refuse a half fix. Floored exact. */
  "tools/mobile/inject-splash.test.mjs": 19,
  "tools/mobile/inject-background-audio.test.mjs": 41,
  "tools/mobile/ios-ci.test.mjs": 137, // founder 2026-09-23: section 3d reads taken-over-severed for a live object taken over with no tee onto WebKit's MediaSession — the state that shipped as "4a / unknown / unknown"; 136 -> 137 // +7: L-02 takeover verdict + reached needle (2026-09-10); +4: M-03 session needle (2026-09-12)
  /* The embedded-framework plist rules (2026-09-13). Release run 34739630705
     archived, exported, and was REJECTED by App Store Connect: the ONNX Runtime
     xcframework Microsoft ships carries no `MinimumOSVersion`, which altool
     requires of every embedded framework (errors 90360/90530). Floored with no
     slack, because two different things in here are one edit from silence — the
     patch (which must refuse to report success when it found nothing to patch)
     and the verify (which must refuse to pass when it cannot find the frameworks
     it exists to check). The fixture is the real 613-byte upstream plist, so the
     first test is evidence rather than restatement. 36 -> 40 after the first CI
     run found the other half of the problem: the resolved tree also holds
     Capacitor's and Cordova's xcframeworks, correctly built and stored as BINARY
     plists, so the patcher must touch only what is actually missing the key and
     must never change a vendored plist's format. */
  "tools/mobile/ios-embedded-frameworks.test.mjs": 40,
  "tools/mobile/ios-workflow.test.mjs": 43, // +4 (2026-09-13): the MinimumOSVersion patch runs before both builds, off one resolved SwiftPM tree, with the deployment target READ not written, and the built device bundle is read back

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
  /* ROSE FROM 8 ON 2026-08-23, when classification stopped reading only the
     last hop of the redirect chain. The eight it had covered the host matcher,
     which was never the bug: `spreaker.com` was on the list the whole time and
     still cleared 2,470 timed transcripts, because the chain
     `dts.podtrac.com -> api.spreaker.com -> <cloudfront hash>` was judged on
     its end. The twelve added cover the walk itself — the hop cap, the per-hop
     politeness gate, partial chains, and the single authorship of the `reason`
     sentence that `--reclassify` would otherwise respell offline. */
  "tools/refresh/dai.test.mjs": 20,
  /* Review of visual pass 1 (2026-09-23): the one entity decoder the feed scan,
     the show backfill and the classification merge all read. Zero slack. */
  "tools/refresh/entities.test.mjs": 5,
  /* Android on a runner (#245). ZERO SLACK, deliberately, and for a reason the iOS
     entry above does not have. Two of these 26 tests are the ONLY thing in the repo
     that notices if the Android job stops checking that `cap sync` still wires
     `foray-audio` into the generated project and that its library manifest still
     merges — and `mobile/android/` is not committed, so there is no file any other
     test can read to check either one. If those checks leave the workflow, the
     `mediaPlayback` foreground service and the Media3 lock screen drop out of the
     APK and every build in this repo still reports green.

     ALL 26 WERE MUTATION-TESTED, 36 mutations, none surviving — and three of them
     were VACUOUS on the first round, each because the assertion matched the
     workflow's own comment or an error message instead of the check (see the file's
     `stepCode()` header). That is the CLAUDE.md § "A green test is not evidence"
     failure in a file whose fixture is the thing it tests, which is the most
     forgiving fixture there is. Raise this number when the suite grows; do not
     lower it.

     27 -> 59 WHEN `android-release.yml` LANDED — the Play submission path. The 32
     added assert a SECOND workflow from the same file, on purpose: the two are one
     decision. `android-build.yml` must keep reading no secret and booting no
     emulator so it stays runnable on any fork; `android-release.yml` is where the
     signing key and the emulator live. Split across two suites, one half could be
     deleted while the other stayed green and looked like it covered the topic.

     THE THREE NOT TO LOSE, because a reader would not guess at them:
       - "the decoded keystore is written OUTSIDE the directory that gets uploaded".
         The artifact upload publishes `$RUNNER_TEMP/android-release` to anyone who
         can see the repo. A keystore one directory deeper is the founder's upload
         key on the internet, from a run that looks entirely routine. THE FIRST
         VERSION OF THIS TEST WAS VACUOUS: it asserted the two paths were different
         strings, which `…/android-release` and `…/android-release/keys` both are.
       - "both signing outcomes are VERIFIED". The quiet failure is the KEYED one —
         a key installed, the wiring silently not applied, a green run, and Play
         rejecting the upload a fortnight later. Asserting the UNKEYED branch too is
         what makes an inverted condition fail on whichever branch it takes.
       - "the emulator job cannot gate the artefact". A cold emulator boot is the
         only genuinely flaky thing in this repo (mp1-background-audio.md §6.2), and
         the .aab is the critical path to a submission. One `needs:` would put the
         flake in front of the artefact.

     61 -> 62 (R-05, docs/release-lockstep-plan.md): "android-release.yml is the
     PR-time check and the by-hand exception path — never an upload path". The
     file holds no Play credential and no store-upload action, the upload action
     appears in EXACTLY ONE `.github` file (the android-bundle composite that
     `release.yml` calls), and the workflow's own header says so. A second path
     to a store is the drift that produced the R-01 TestFlight flood. */
  /* K-02 and K-03 (docs/bundled-voice-plan.md): the two stages that run on OUR
     machines and never on a phone. Both suites drive the real Python through
     the real interpreter, because "test the Python by running it" and "test
     nothing" were the only honest options in a Node-only test tree.

     THE FLOOR IS PROTECTING THE REFUSALS more than the arithmetic. misaki is
     not installed here or on CI, so most of what these two files pin is that a
     missing backend produces a non-zero exit and a command that fixes it —
     never a phoneme string nobody produced, never an audition clip a founder
     could not tell from a real one. Those are the tests somebody deleting "the
     ones that only test the failure path" would take first, and they are the
     reason this card is not a way to publish a mispronounced Foray. */
  "tools/narration/phonemize.test.mjs": 13,
  "tools/narration/render-audition.test.mjs": 12,
  "tools/mobile/android-workflow.test.mjs": 62,
  /* Wiring the signing config into a project nobody commits. ZERO SLACK.
     `mobile/android/` is regenerated on every build, so the only evidence the
     release signing config ever reaches Gradle is that this script ran and its
     `--check` pass agreed. If it silently does nothing, `bundleRelease` emits an
     UNSIGNED bundle and prints BUILD SUCCESSFUL. The one not to lose is "a MENTION
     of the include is not a wiring": the script writes a COMMENT naming
     `foray-signing.gradle` directly above the apply line, so a substring check
     would report a commented-out wiring as wired. */
  "tools/mobile/wire-signing.test.mjs": 11,
  /* R-02 (docs/release-lockstep-plan.md): the single version source both the
     iOS and Android release workflows call identically. Floored at its full
     count because every test pins one of the card's own acceptance criteria —
     monotonicity across a day boundary and within one day, the runOfDay 1-99
     bound, UTC-only date math, the Play int32 versionCode ceiling
     (2,099,123,199 < 2,147,483,647), the semver reset rule, and — the one that
     stands in for "the same call from both workflow shells prints the
     identical pair" — spawning the CLI twice with pinned inputs and diffing
     stdout byte-for-byte. */
  "tools/mobile/version.test.mjs": 22,
  /* R-03 (docs/release-lockstep-plan.md): release.yml's own pure-function
     decisions (playReadiness/releaseGuard/isAncestorOfMain) and the workflow
     invariant suite that pins it and the two composite actions it factors
     shared build steps into. Registered the same day both suites were
     written, per R-02's own precedent for this map. */
  "tools/mobile/release-ci.test.mjs": 15,
  "tools/mobile/release-workflow.test.mjs": 29, // +4 (2026-09-13): the release composite is a THIRD build path — it patches the ONNX Runtime plist before archiving, archives from the patched tree, and reads the archive back before export/upload

  /* The launch verdict (the `android-smoke` job's brain). ZERO SLACK. This is the
     only thing in the repo that can judge a RUNNING Android app, and its risk is
     entirely one-directional: a verdict too generous reports a launch for a page
     that never loaded, with a green tick and a JSON report attached. The two not
     to lose are "about:blank is a FAILURE" — a WebView exposes a DevTools target
     BEFORE the page loads, so an incurious probe gets a healthy answer from a
     blank page — and "the bridge must answer from OUR Java", where `platform:
     "android"` is set in ForayAudioPlugin.java and nowhere else. That second one
     is the closest relative in this repo of #269, where an Android fixture
     answered `running: true` and the fake was the only place the code worked. */
  "tools/mobile/webview-probe.test.mjs": 16, // 2026-09-22 (audit, persona #43): app.js now paints a boot line into #view before its first await, so a view still holding it is a failed launch, not a certified one; 15 -> 16

  /* M1 (full-repo review 2026-08-31): the byte-ceiling guards shared by
     scan.mjs and refresh-feeds.mjs. Covers all three defenses named in the
     finding — reject an implausible declared Content-Length before
     download, abort mid-stream once the decompressed byte ceiling is
     crossed (the chunked/endless-response case that a Content-Length check
     alone cannot catch), and cap the item count after parsing — plus the
     end-to-end wiring through fetchFeedCapped. */
  "tools/refresh/fetch-limits.test.mjs": 14,
  /* S-11: the curated-scan-selection and curation-candidates helpers behind
     scan.mjs --source index (4a-shows-pipeline-plan.md card S-11). The
     fail-OPEN behaviour for a curated show absent from S-04's id-map is the
     one test here that must never be weakened -- it is what stops a join
     gap in the release from silently starving a feed of scans, which is
     the exact "we miss episodes if nothing refreshes them" bug this card
     exists to fix. */
  "tools/refresh/candidates.test.mjs": 19,

  "tools/refresh/enclosure.test.mjs": 18,
  /* Per-episode topics (#292). ZERO SLACK. This suite is the only thing between
     the catalogue and a return to show-level labelling — 77 of the 99 shows with
     >= 8 episodes carried one identical topic set on every episode, and the two
     ways that comes back are both silent: an override that MERGES with the show
     seed instead of replacing it, or a bad node id filtered away so the episode
     quietly keeps the default. Both leave every count unchanged.
     ONE of the 16 is a REAL-REPO pin on the nine shows re-derived in that PR, and
     it is why deleting this file would be worth someone's while: it is the only
     assertion that those 126 episodes still carry per-episode topics. It holds a
     per-show floor on distinct topic sets (normally half the episode count) and
     a `>=` floor on the episode count, because label-never-exclude means a "fix"
     that improves uniformity by DROPPING episodes must fail while the nightly
     ADDING episodes must not. Two review rounds shaped that line: the first
     caught a `>= 2` distinctness test under which 22 of 23 episodes could be
     re-seeded green, the second caught an `===` count test that would have
     reddened the nightly within a day. A second REAL-REPO test pins taxonomy
     validity across the whole catalogue.
     All 19 mutations run against it were killed, and two false-alarm probes
     (a comment-only edit to scan.mjs; one new nightly episode) were confirmed to
     stay green. Each test names its own mutation. */
  "tools/refresh/merge-topics.test.mjs": 16,
  /* The nightly's deploy-manifest step (HUMAN-ACTIONS #37). Floored because its
     failure mode is silence: if merge.mjs stops restamping the manifest,
     nothing goes red — `manifest-autofix.yml` pushes the `github-actions[bot]`
     fixup commit again, and `protect-main`'s
     `require_extra_approval_for_unattributed_changes` then makes the nightly PR
     need an approval its own author is forbidden by GitHub to give. That is
     PR #443 and PR #456 on 2026-09-03, both green and both stuck. All 9
     mutations were run and killed; each test names its own. */
  "tools/refresh/manifest-step.test.mjs": 9,
  /* The nightly watchdog (#290). ZERO SLACK, for the reason media-session and
     data-deletion are floored that way: what this suite holds down is a set of
     decisions each one line from its opposite, on a check nobody watches run.
     It is also the suite most able to look fine while pinning nothing — a
     watchdog fixture that is healthy makes every assertion pass while the alarm
     is wired to nothing. The committed fixtures are the real 2026-08-20 failure
     rebuilt from git, and two of these tests exist purely to pin that they
     still are. All were mutation-killed; the mutation is named in each.
     47 -> 62 in the pre-push review round, which found that the guard could
     stall the pipeline with no documented way to clear it and that the digest
     fetch failed OPEN on any API error that was not a 404. 62 -> 71 with S-01
     (issue: nightly digest publish failed since 09-01 with "Argument list too
     long"): refreshRunVerdict()/`--mode run-failed` answers a question neither
     `absence` nor `overwrite` could — "did today's scheduled nightly-refresh
     run itself succeed", independent of any digest/PR state. */
  "tools/refresh/watch-nightly.test.mjs": 71,
  /* S-01's other half: proves the actual bash in nightly-refresh.yml's
     "Publish digest to refresh-digest branch" step, not a JS reimplementation
     of it. Extracts the real `run:` block, shims `gh`/`jq`, and round-trips a
     synthetic 2MB resolved.json through it end to end — the acceptance
     criterion the card asked for. One test, deliberately: this is an
     integration proof of the fix, not a table of unit cases. */
  "tools/refresh/publish-digest.test.mjs": 1,
  "tools/segments/sweep-transcripts.test.mjs": 38,
  "tools/segments/transcript-normalize.test.mjs": 24,
  "tools/segments/merge-segments.test.mjs": 39,
  "tools/segments/prepare-segment-batch.test.mjs": 78,
  /* The free-transcript acquisition step (#104 follow-up): the join that
     produces the coverage number, the fetcher that acquires what it finds, and
     the host gate they share. Floored together because they fail together in
     the same way — each exists to stop a confident wrong number or a rude
     request from looking like success.

     `transcript-coverage` is the join between `data/discover.json` and
     `data/transcript-availability.json`. It was written because there wasn't
     one: the two files share no episode key, so every attempt to ask how many
     curated episodes have a free transcript answered 0 while the index held
     8,012 of them. Its guard tests pin that a broken index is an ERROR rather
     than 0% coverage — including the three ways that go wrong separately
     (never swept, a partial key collapse, and the backstop carrying the join).

     `fetch-transcripts` is the only file in the repo that requests a transcript
     body. Three of its tests are boundary guards rather than behaviour: it must
     never fetch audio by URL, it must abandon a response whose Content-Type
     says audio even when the feed declared otherwise (#108 is a `[gate]`), and
     a feed guid must not be able to choose where the repo writes files.

     `politeness` holds the per-host gate both fetchers use. It exists because
     of what this file used to claim and could not back up — see below.

     ON THE MUTATION CLAIM, WHICH THIS COMMENT PREVIOUSLY OVERSTATED.
     An earlier version said "All 19 were mutation-killed". That was true of the
     19 mutations the author wrote, and it was not the same statement as "this
     suite is well pinned". A reviewer ran 10 fresh mutations: 8 died and 2
     survived — `MIN_HOST_INTERVAL_MS` to 0, and `retryAfterMs` to always-null.
     Both survivors were the politeness layer, which had no test at all while
     three file headers described it in detail. The prose was strongest exactly
     where the coverage was thinnest, and two real bugs were living there: a
     `Retry-After` that paused one worker while its siblings kept firing, and a
     `?? ` that could not fall back from a zero wait.

     Both survivors are now killed by `politeness.test.mjs`, and the layer they
     cover was extracted from two drifting copies. The lesson is the floor's, not
     the tests': a mutation claim is only as good as the mutations someone else
     would think to write, so this comment now names what the suite pins rather
     than asserting a score. */
  "tools/segments/transcript-coverage.test.mjs": 12,
  "tools/segments/fetch-transcripts.test.mjs": 11,
  "tools/segments/politeness.test.mjs": 7,
  /* S-04a: the PodcastIndex dump import/shard-build pipeline (kanban
     t_835d1a3c). Six suites because the pipeline is deliberately split into
     independently-testable stages (config, filter, dedupe, shard-build,
     identity, state) plus one integration suite over an in-memory
     node:sqlite fixture — the same shape tools/corpus/db.test.mjs uses for
     its own migration+ingest pipeline. Floored individually so a change
     that silently drops, say, the id-map fail-closed test is caught by
     name rather than by a combined count going down by one among many. */
  "tools/shows/dedupe.test.mjs": 9,
  "tools/shows/filter.test.mjs": 11,
  "tools/shows/identity.test.mjs": 2,
  "tools/shows/import-dump.test.mjs": 5,
  "tools/shows/shard-build.test.mjs": 14,
  "tools/shows/state.test.mjs": 6,
  /* S-04b: GitHub Release publishing + the run-then-publish orchestration
     (kanban t_3a896057), gated on S-04a above. publish-release.test.mjs
     unit-tests each piece (tag sanitization, the fail-closed idempotency
     check, asset listing, the gh invocation, the pointer payload shape)
     against a faked `gh`; run-and-publish.test.mjs is the end-to-end
     acceptance test the card's own criterion asks for — "two full runs on
     the same dump version -> no new release" — proven against the REAL
     control flow (runAndPublish), not each piece in isolation, covering
     both idempotency paths (S-04a's own state.json skip, and the
     independent release-already-exists check that catches a lost
     state.json). */
  "tools/shows/publish-release.test.mjs": 18,
  "tools/shows/run-and-publish.test.mjs": 6,
  /* Fresh-context review finding (2026-09-05): runBuild spawns
     import-dump.mjs as a real child process, and Node does NOT
     auto-inherit process.execArgv (e.g. --experimental-sqlite) into a
     spawned child — every other test in run-and-publish.test.mjs injects
     a fake `exec`, which hid this gap completely. This suite spawns a
     REAL node subprocess (no fake exec anywhere) to prove the forwarding
     actually reaches the child's argv. */
  "tools/shows/run-and-publish-execargv.test.mjs": 1,
  /* The breadth prioritiser and its yield report (#114). Floored for the same
     reason politeness.test.mjs is, and the reason is not hypothetical here
     either: the first draft of `rank-breadth.mjs` had a seed hash that produced
     a 20x skew across the explore arm's first draws, and it was invisible in
     every sample it produced. The two things worth protecting are the ones
     nobody can eyeball —

       rank-breadth   the SHRINKAGE (a 1-of-1 host must not outrank a 10-of-12
                      one) and the SAMPLER (the explore arm must be uniform, or
                      the run's only unbiased estimate silently is not one).
       breadth-yield  the DENOMINATOR (per feed swept, failures included) and
                      the DAI classification. Every way the yield number can be
                      wrong makes it bigger, and the number gets multiplied by
                      19,000 to decide whether to spend the rest of the budget.

     Both suites were mutation-run before commit; each test names the mutation
     it kills, per this file's own standard. */
  "tools/segments/rank-breadth.test.mjs": 22,
  "tools/segments/breadth-yield.test.mjs": 36,
  /* The scan that settled tranche 1's seven suspects — 2,821 timed
     transcripts, 71% of that tranche's anchorable haul, previously dropped on a
     hostname heuristic. Its arithmetic decides supply, so every step of it is
     pinned: what is worth probing, bytes to seconds, the worst-case statistic
     (deliberately NOT the median the verdict uses), the insert threshold from
     both sides, and a recomputation of all seven committed verdicts from the
     byte counts filed beside them. */
  "tools/segments/measure-suspects.test.mjs": 57,
  /* The audit of that scan's own acquittals (#323 follow-up). It re-asks every
     `measured_clean` show — 5,381 timed transcripts, half the anchorable corpus
     — the question the four-cell probe grid asked flightcast, because the
     ranged GET those acquittals rest on is now known to be spoofable. Floored
     because the suite's centre of gravity is one distinction that a single edit
     erases: a grid nobody answered must never read as a grid that agreed with
     itself. That is ADR-0008's HEAD failure restated in a new unit, and it is
     the failure that would silently re-certify shows nothing has measured. */
  "tools/segments/regrid-clean.test.mjs": 25,
  /* The Google Play submission package in `docs/store/play/` — the banner, the
     four phone screenshots, the two descriptions and the README a founder
     pastes out of. Floored because everything it guards fails LATE and
     elsewhere: an off-size banner or an 81-character short description does not
     break anything here, it bounces at the Console weeks later, and by then
     nobody remembers which of these files is generated and which is hand-cut.
     Three of its fourteen are the icon-suite guard applied to the banner (decode
     the committed PNG, re-render from the brand master, compare pixels), and
     two more are the ban on unverifiable scale claims and on company-size
     signalling — both founder rulings, both previously enforced only by someone
     remembering.

     THE FLOOR ROSE FROM 14 TO 21 when Play rejected the submission's icon and
     `docs/store/play/app-icon-512.png` was added to answer it. Those seven are
     the highest-value tests in the file and the least obviously necessary,
     which is the combination a floor exists for: one of them asserts colour
     type 6 where every other PNG assertion in this repo asserts 2, and it looks
     exactly like a copy-paste error someone would "fix". Play requires an alpha
     channel and the App Store rejects one, so the inversion is the whole
     point. */
  "tools/store/play-listing.test.mjs": 21,
  "tools/transcribe/fetch-audio.test.mjs": 64,
  /* ADR-0008's decode-and-compare: the instrument the cheap ones defer to.
     Floored because everything expensive about it — the download, the PyAV
     demux — is deliberately OUTSIDE CI, so what remains is the arithmetic that
     turns a decoded duration into a verdict, and there is nothing above it to
     catch a mistake there. The two rules most worth keeping are the ones a
     measurement forced rather than a design chose: the container's own duration
     is a CLAIM and never a reading (flightcast's headers over-declare by 3.8s
     on a clean file and 8.4s on an inserting one, so counting it produced a
     false `undecidable` on a 30MB answer), and a decode is allowed to condemn a
     show on one observation while never acquitting one on a host already caught
     under-declaring. */
  "tools/transcribe/decode-compare.test.mjs": 31,
  "tools/transcribe/ad-inflation.test.mjs": 43,
  /* The transcription work order. Zero slack, because what it guards is not
     logic but a PROMISE MADE TO A MACHINE THAT IS ALREADY RUNNING: a worker box
     consumes data/transcription-queue.json in rank order, so any change that
     renumbers, reorders or deletes an entry silently re-points a log that has
     already been written. Half these tests assert on the committed artefact
     rather than on the producer, which is deliberate — data/ auto-merges with no
     human read, so a hand-edit is the likelier corruption. 28 mutations killed,
     each named in the test that kills it; one of them (the audio-hours estimate
     relabelled `measured`) survived the first round because the assertion only
     read the shipped file, and the producer assertion that kills it was added
     for exactly that reason. */
  "tools/transcribe/build-transcription-queue.test.mjs": 26,
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

test("no suite is floored twice", () => {
  /* THIS PR SHIPPED THAT BUG. `tools/refresh/dai.test.mjs` appeared twice in
     FLOORS, at 20 and then at 8. A JavaScript object literal keeps the LAST
     value, so the effective floor silently became 8, and the suite could have
     shed twelve tests with every check green.

     Nothing in the repo noticed, and nothing could: by the time any test reads
     `FLOORS`, the duplicate is gone -- `Object.entries` returns one entry, with
     the wrong number. The only place the truth survives is the source text, so
     that is what this reads.

     This is the file's own two-step-gutting failure mode, arriving through a
     merge rather than through intent: raise the floor in PR 1, re-add the key
     lower down in PR 2, and the guard quietly drops.

     MUTATION: re-add a second `"tools/refresh/dai.test.mjs": 8,` line and this
     fails with both values named. Run before trusting. */
  const src = fs.readFileSync(path.join(ROOT, SELF), "utf8");
  const body = src.slice(src.indexOf("const FLOORS = {"), src.indexOf("const BACKEND_FLOORS"));
  const seen = new Map();
  for (const m of body.matchAll(/^\s*"([^"]+)"\s*:\s*(\d+)/gm)) {
    if (seen.has(m[1])) {
      assert.fail(
        `${m[1]} is floored twice, at ${seen.get(m[1])} and ${m[2]}. The object literal keeps the LAST one, so the effective floor is ${m[2]}.`
      );
    }
    seen.set(m[1], m[2]);
  }
  assert.ok(seen.size > 0, "parsed no floors at all -- the regex or the block markers moved");
});

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
  /* Anthropic provider error-path coverage (kanban card t_550d289f): mock-client
     tests for the constructor dry-run guard, budget-guard call-site wiring, and
     malformed-JSON/no-text-block error paths across all 5 real provider classes,
     plus the shared parseWithRetry helper extracted from their copy-pasted
     private implementations. */
  /* +2 (WS-C): the §4.4 side of F-38 — the prompt asks for a beat `kind`
     and the parser accepts one, while a reply that omits it still parses. */
  "test/AnthropicDeepenActBuilder.test.ts": 9,
  "test/AnthropicEnricher.test.ts": 10,
  "test/AnthropicExternalResearcher.test.ts": 9,
  "test/AnthropicPromptUnderstander.test.ts": 10, // L8 review (2026-09-23): INTERNAL_VOCABULARY reaches the generator — prompt rule + toListenerWords scrub in forayCopy/slotsFromSpine; 9 -> 10
  /* Raised from 8 by WS-L (F-63): what actually reaches the model — the quoted
     transcript windows and the one seed rule when the research map has them,
     neither when it does not, and the seed the reply carries back. */
  "test/AnthropicSpineBuilder.test.ts": 18, // L8 review (2026-09-23): INTERNAL_VOCABULARY reaches the generator — prompt rule + toListenerWords scrub in forayCopy/slotsFromSpine; 11 -> 18 (17 on disk before it)
  "test/archetypes.test.ts": 7,
  "test/budgetGuard.test.ts": 6,
  "test/candidateExtractor.test.ts": 8,
  "test/conditionalGet.test.ts": 9,
  "test/copyRules.test.ts": 6, // L8 review (2026-09-23): INTERNAL_VOCABULARY reaches the generator — prompt rule + toListenerWords scrub in forayCopy/slotsFromSpine; 5 -> 6. L8 (2026-09-22): Foray titles/summaries/slot titles against BANNED + INTERNAL_VOCABULARY, and its no-false-positive twin; 3 -> 5
  "test/createEnricher.test.ts": 1,
  /* Generation pipeline §4.0-4.1 (kanban card t_825eee4c). */
  "test/createPromptUnderstander.test.ts": 1,
  "test/dataSchemaCompliance.test.ts": 8,
  "test/dedup.test.ts": 17,
  "test/duration.test.ts": 12,
  /* DAILY_BUDGET_USD env parsing (L5): rejects negative / NaN / empty /
     over-cap values at startup instead of silently substituting the
     default, and leaves a genuinely unset variable on its fallback. */
  "test/env.test.ts": 11,
  "test/events.test.ts": 15,
  "test/html.test.ts": 8,
  "test/interestLearning.test.ts": 30,
  "test/itunes.test.ts": 3,
  "test/ladderBuilder.test.ts": 13,
  "test/ladderIntegrity.test.ts": 11,
  "test/ladderProgress.test.ts": 8,
  "test/learningJob.test.ts": 4,
  /* Anthropic provider error-path coverage (kanban card t_550d289f): the
     shared parseWithRetry/parseLastJsonBlock helper extracted from the 5
     real Anthropic provider classes' identical private copies. */
  /* K-02 (docs/bundled-voice-plan.md): the phonemize stage. The property this
     floor protects is not the arithmetic — it is that a Foray PUBLISHES whether
     or not the phonemizer worked. The bundled voice is an upgrade to how
     narration sounds, not a new way for generation to fail, and half this suite
     is mutations of exactly that: a throwing subprocess, a half-answer with no
     vocab, a missing interpreter. Delete those and a missing system package
     takes down a written Foray after the writer has spent its tokens. */
  "test/phonemize.test.ts": 12,
  "test/parseWithRetry.test.ts": 17,
  "test/parser.test.ts": 29,
  "test/personas.test.ts": 6,
  "test/podcastIndex.test.ts": 3,
  "test/politeness.test.ts": 9,
  "test/poolIntegrity.test.ts": 6,
  /* Generation pipeline §4.0-4.1 (kanban card t_825eee4c): §9.4's ruling
     ("prompts are discarded") enforced structurally — this suite scans the
     generation-stage source for persistence primitives and proves a full
     understand-prompt run touches no file on disk. */
  /* WS-H raised this from 4: `transcriptTextIndex.ts` is the second module
     allowed to write under `data-local/`, and the added case holds its cache
     to §9.4 the way the evidence cache’s is — podcast words keyed by show id,
     never the claim a search ran for. */
  "test/promptNoPersistence.test.ts": 5,
  "test/property/dedup.property.test.ts": 5,
  "test/property/duration.property.test.ts": 5,
  "test/property/html.property.test.ts": 4,
  "test/property/interestWeight.property.test.ts": 3,
  "test/redirect.test.ts": 6,
  "test/scoring.test.ts": 17,
  "test/sessionBuilder.test.ts": 12,
  "test/stubEnricher.test.ts": 6,
  "test/userInterests.test.ts": 17,
  /* #703: the warm pass's feed parsing, which is what decides whether a
     reconciled episode comes out SEARCHABLE only or also MINTABLE — a duration
     read as 58 rather than 3501 makes an episode rank and then yield nothing. */
  "test/warmTranscriptIndex.test.ts": 13,
  /* Generation pipeline §4.0-4.1 (kanban card t_825eee4c): §3's input
     schema, `author_id` required and carried from day one per §1.3. */
  "test/generationRequest.test.ts": 5,
  /* Generation pipeline §4.1's safety-first module: forbidden-topics
     checker, unit-tested and committed rather than a system prompt, per
     the doc's own explicit requirement. */
  "test/safetyCheck.test.ts": 11,
  /* Generation pipeline §4.1 end to end: safety, then clarity, then intent,
     in that order, with no retry loop on rejection and never more than one
     clarify round. */
  "test/understandPrompt.test.ts": 7,
  /* §4.2's catalogue lookup: concept matching against the semantic index and
    tape-availability counting against discover.json/item-tags.json, both
    proven against a small deterministic fixture catalogue (not the real
    one, so a future catalogue-content change can't silently pass or fail
    this suite). */
  "test/catalogueLookup.test.ts": 9,
  /* §4.2 end to end: buildResearchShape against the REAL catalogue for tape
    accuracy, and the cheap-first ordering (external research fires ONLY
    for a genuine catalogue gap) against an injected no-tape fixture so the
    assertion doesn't drift as the real catalogue grows. */
  /* Raised from 11 by WS-L (F-63): §4.2 now also returns what the tape SAYS
     about each candidate — the top transcript windows, quoted — and the added
     cases pin the quoting, the four honest reasons a window list can be empty,
     the lineage gate running before any episode is opened, and one window per
     episode, best first. */
  /* Raised to 18 by F-73: the quoted window's duration band is what every
     generated tape segment ends up being cut from (§4.3 seeds a beat with these
     seconds and F-68 confines §4.5's search to them), so it is now sized against
     `narration-craft.md` §0's own mean floor rather than against prompt length
     alone — asserted on the constants and measured on a real window. */
  "test/researchShape.test.ts": 18,
  /* The §4.0-§4.9 orchestrator (runPipeline.ts). Floored because it is the ONLY
     suite that exercises the chain as a chain: every stage has its own tests and
     all of them stayed green while nothing joined the stages together, which is
     how the pipeline reached "all nine stages built" with no way to run them.
     Four of its cases pin whole-Foray properties the first real run failed on —
     the §4.7 disclosure, and the runtime the checker recomputes. */
  /* +1 (F-49): the orchestrator hands finalize the tier-2 segments and source
     rows sourcing minted, without which the candidate names tape nothing can
     resolve. */
  /* +3 (F-91): the topic is decided BEFORE the research map and the spine with
     the archive's supply in view — a subject no candidate topic's family can
     carry stops `no-supply` with the spine builder never called; run 8's
     prompt proceeds under the engineering candidate that carries *Being an
     Engineer*; a resolution with supply is left alone and recorded `best`. */
  "test/runPipeline.test.ts": 31, // L8 review (2026-09-23): INTERNAL_VOCABULARY reaches the generator — prompt rule + toListenerWords scrub in forayCopy/slotsFromSpine; 16 -> 31 (28 on disk before it)
  /* §4.3's spine types: SpineSchema (strict, no per-act voice field),
     isClaimShaped (claim- vs topic-shaped beats), and validateSpine
     (§3's shape budgets with ±15% tolerance, the ~30% exploration
     floor). Kanban card t_96a97be9. */
  "test/spineTypes.test.ts": 28,
  /* §4.3 end to end: buildSpine() against StubSpineBuilder for every
     duration tier (shape budgets, claim-shape, exploration floor,
     single spine-level voice all actually hold), plus InvalidSpineError
     on a deliberately broken builder. Kanban card t_96a97be9. */
  /* Raised from 6 by WS-L (F-63): the stub writes beats FROM the research map's
     quoted tape windows, out of the window's own words, and leaves the spine
     seedless when the map quoted nothing. */
  "test/buildSpine.test.ts": 9,
  /* §4.4 end to end (kanban card t_c963701a): deepenActs() fans out
     builder.deepenAct() once per act IN PARALLEL, always passing the
     FULL spine. Covers shape/count correctness, the full-spine-context
     regression guard, genuine-parallelism proof, and explicit
     failure-isolation (one retry per act, then fail the whole build). */
  /* Raised from 12 by F-49's argument cap: at most a third of a slot's beats
     may be tagged `argument` (run 2 tagged 29 of 35 and lost every one of them
     to §4.5's skip-tape branch). The added cases pin the rounding, the
     re-tagging order, the warning field, idempotence, the resumed-act path, the
     stub's own obedience, and a replay over run 2's real deepen output. */
  /* Raised from 21 by WS-L (F-63): a beat's tape seed has to survive the stage —
     kept by the stub, restored in code when a builder drops it, never re-pointed
     when the builder changed a slot's beat count, and restored on a resumed act
     checkpointed before seeds existed. */
  "test/deepenActs.test.ts": 25,
  /* §4.5-4.6 end to end (kanban card t_648fbae7): sourceBeats() resolves
     every beat to a tier-1 segments.json hit, a tier-2 transcript-archive
     extraction, a tier-3 transcription-queue-candidate narration fallback,
     or a Patch/Carry narration assignment — never changing which beats
     exist, and never fetching/persisting any audio bytes. */
  /* WS-C (docs/curation/generation-fix-plan-2026-09-09.md) raised this from 8:
     run 1's tape anchors were 5-of-22 on topic, and the added cases pin each of
     the four things that fixes — argument beats skip tape (F-38), tier 1 scores
     against the transcript window not a curator note (F-06/F-29), tier 2 needs
     the claim's words around its anchor and mints a cue-cut segment rather than
     a word run (F-24/F-33), and a candidate must share the Foray's taxonomy
     lineage (F-23/F-29) — plus a replay of the real beat-4/beat-5 claims
     against the real data/segments.json. */
  /* Raised from 35 by F-49: sourcing now says WHY each narrated beat got no
     tape (best candidate, score, bar, gate — per tier), refuses to mint tape
     whose audio cannot be honestly registered, and is replayed over run 2's own
     35 beats so the diagnosis is a test rather than a paragraph. */
  /* WS-H (F-06/F-49) raised this from 49: tier 2 now finds its candidate
     episodes by searching the archive’s transcript TEXT, so the suite pins
     both halves — tape minted from an episode whose title says nothing, and
     run 1’s Chernobyl/griddle/San Bruno mis-anchors still refused with the
     text search switched on — plus two offline cases that skip by name on a
     checkout without `data-local/transcripts/`. */
  /* F-61/F-62 raised this from 59: tier 2 picks its window by overlap and mints
     its anchors from the tape's own words, so the suite pins the window search
     and its relevance floor (including the rare-word count that refuses a
     window carried by one unusual word), anchors quoted verbatim at the span's
     boundary cues, growth toward the claim rather than symmetric padding, and
     the three run-1 mis-anchors refused by the FLOOR rather than by the
     verbatim rule that used to carry them. The offline cases now find the real
     bodies however the machine holds them, and skip by name when it holds
     none. */
  /* Raised from 72 by WS-L (F-63): a seeded beat opens its own episode first,
     the seed never lowers a floor or slips an off-branch show past the lineage
     gate, the trace says whether the seed won, and one offline case runs the
     run-2 intent through research-shape, a stub spine seeded from its windows,
     deepening and sourcing against the real archive. */
  /* Raised from 79 by F-73: both tiers now keep a D-tier LENGTH ledger as well as
     M3/M4 — the running mean floor (D3), the short-segment run (D2), the uniform
     triple (D5's first clause, the one gate here that is a preference and gets
     relaxed rather than costing a beat its tape) and M4's runtime clause — and
     the tier-2 cut grows towards a varying target instead of stopping at
     `MIN_TAPE_SEGMENT_SEC`. The added cases pin each gate's refusal, its
     fall-through to another episode, its small-count exemption, and the ladder
     the interquartile floor is sized against. */
  /* 111 once F-72 merged alongside it: the seed window is judged on share alone
     and the trace says when that floor DECIDED, and those twelve cases had no
     floor of their own. Raised here rather than left as slack, for the reason at
     the top of this file — slack is what lets a gate be deleted with CI green. */
  /* 130 with F-80: D5's triple clause is a rule at placement, not a preference —
     the tier-2 walk cuts the same window to a length outside the band before it
     gives a candidate up, names `d5-triple` when no cut escapes, and the
     tape-relevance row records when the clause chose a length. The fixtures
     that filled a Foray with one length now alternate, because three of one
     length is exactly what the rule refuses. */
  /* LOWERED 130 -> 119 by Q-01/Q-04 (docs/curation/listening-quality-plan.md),
     deliberately and in the open: seventeen cases pinned rules Q-04 retired —
     D3's running mean (3), the interquartile re-cut pass (6), the 105/165/135/
     210 s ladder (1), M4's whole-episode runtime share (3) and F-80's triple
     clause chooser (4) — and six new ones pin what replaced them: M4's one-
     long-clip and beyond-the-longest-clip clauses (3), and the tier-2 clip as
     the thought around the claim with D5's pair clause asked of it (3). The
     extension itself has its own floored suite below (`tapeExtent.test.ts`). */
  /* RAISED 119 -> 124 by F-96 (Q-01 pass 2): the seed path extended, the
     same-stretch merge (one clip, two beats), the gap and act-boundary
     refusals, `seedLost` on a seeded beat that ends as narration, and the
     end-to-end thesis case; the two ledger cases that pinned "a second beat
     on the same episode is refused" now ask it across an act boundary. */
  /* RAISED 124 -> 127 by F-101: `placementAllows` is the ONE length-rule
     predicate, asked by the tier that places a clip and the tier that grows
     one — the merge's hand-mirrored copy of M4's runtime clause is gone. */
  /* RAISED 127 -> 128 by F-102 — ONE net case, while four were rewritten in
     place. D5's pair clause stopped being a placement veto (it could only ever
     be satisfied by playing less tape, and on the real archive it cost four
     seeded beats theirs), so the four cases that pinned the veto now pin its
     absence: the pool segment that makes a pair is PLACED, the full thought is
     placed and MARKED rather than re-cut shorter, no beat is narrated for a
     length, and `placementAllows` does not consult the clause on either path.
     The added one is the case that NEVER SKIPS: it logs whether the offline
     block ran and asserts that only a missing archive can skip it. That block
     holds the two assertions guarding TAPE YIELD, CI structurally cannot run
     it, and its silence is how F-102 survived a day with main's `backend` job
     reporting `129 tests | 5 skipped` and green while both were red here.
     (This floor counts `it(`/`test(` statically; Vitest reports 130 for the
     same file, two cases being written in the multi-line `it(
 "name",`
     form. The two numbers have always differed by two; only this one is the
     floor.) */
  "test/sourceBeats.test.ts": 128,
  /* Q-04: the checker's D5 arithmetic mirrored in `d5Pair.ts` — the pair
     clause that replaced F-80's triple — pinned to `check-forays.mjs`'s own
     `d5UniformPairs` row by row (run in a Node subprocess, the only way that
     file loads on a checkout with a space in its path). `d5Triple.test.ts` (5)
     went with the rule it pinned. */
  /* UNCHANGED AT 5 BY F-102, one case swapped for another: `d5EscapeBelow` —
     the function that told sourcing how far to CUT a clip back so a pair would
     escape — is deleted, and the case that pinned its arithmetic is replaced by
     one asserting this module exports no function returning a LENGTH at all.
     The mirror-to-the-checker case is untouched; the arithmetic did not change,
     only who obeys it. */
  "test/d5Pair.test.ts": 5,
  /* Q-01: `tapeExtent.ts` — the claim window extended to the thought around it
     (turn and sentence boundaries, the host's question, the relevance walk and
     its measured floor, the hole in the tape, the ceiling, the anchors) and the
     hand-set numbers pinned. Every case names its mutation. */
  /* RAISED 11 -> 13 by F-96: the claim and the thesis scored as two shares
     (run 9's live timidity, the mutation being the old union query), and the
     cut never shortening an extent below the boundary it found. */
  "test/tapeExtent.test.ts": 13,
  /* WS-H’s new module: the BM25 index over the normalised cue text, its disk
     cache and the invalidation that makes a re-transcribed episode rebuild it,
     and the Null implementation CI actually runs. Raised to 12 by F-61: the
     idf a search scored with is carried out to tier 2's window search. */
  /* #703: the two rules that decide what of the corpus on disk is readable —
     the file-naming key the fetcher actually wrote, and the letter-spaced-cue
     refusal — plus the coverage count that makes a blind spot impossible to
     miss. Every case names the mutation it kills; four of them are the 990
     dark Becker's episodes and the sigma-nutrition cover page that was served
     as tape on a germ-theory Foray. */
  "test/transcriptCorpus.test.ts": 19,
  "test/transcriptTextIndex.test.ts": 13,
  /* §4.7 end to end (kanban card t_5a8b77c3): writeNarration() writes one
     page per narration beat (mode budgets, per-claim sources array),
     always through a genuinely separate verifier call (never the writer —
     proven with a spy test), the exact check-forays.mjs-compatible
     disclosure template, and decideConnectiveNarration()'s seam-position
     table for tape-adjacent beats needing short connective narration. */
  /* WS-A raised this from 25: the suite now replays run 1's own failures
     through the two-step, per-slot writer — the fabricated citation, the
     griddle slug, the two-word span, the purpose quoted back, the
     zero-source Frame — and pins the dry-run path to quoting real held text. */
  /* F-50/F-51 (generation run 2) raised this from 40: run 2's own act 1 p2 —
     a purpose the retrieved document contradicts — is now a fixture, and the
     suite pins both halves of the fix (a page that reports the tension passes
     and is flagged on both sides; a third rejection keeps the page unverified
     instead of throwing), plus the per-slot resume hooks and the cue provider
     the default evidence gatherer was silently dropping. */
  /* F-60 raised this from 55: run 2's act 1 p5 — a Carry page whose retrieval
     came back empty — now makes ZERO writer calls and comes out as an
     unverified hand-off the gate refuses, and the two former throw sites (no
     evidence, and no page ever produced) are pinned as degrade paths so the
     surviving `NarrationWriteError` guards the beat count and nothing else. */
  /* +1 (Q-03): the stub builders offer the per-act contract, so a dry run pays
     one write and one verify for an act and never the per-slot calls. */
  /* LOWERED 70 -> 49 by F-100, deliberately, and this is the reasoning the
     header asks for. The suite above was written against the per-slot,
     per-page orchestration runs 1-8 used. Q-03 replaced that orchestration
     with one writer call per ACT and left the old one standing as a
     "fallback"; F-100 established that the fallback could not run — both
     builder factories return builders that implement the per-act contract —
     and deleted it. The 21 tests that went with it are of two kinds:
       - CALL ECONOMICS of a path that no longer exists (G-34's merged
         select+prose call and its retry levers, "two calls per SLOT", the
         per-slot resume hooks, the per-slot parallelism, F-60's
         degrade-before-the-first-call). The act path's own economics are
         measured in actNarration.test.ts, which is unchanged at 38.
       - DUPLICATES of a rule that is now asserted once. Every mechanical
         rule the deleted tests drove — the quote gate, the entity decode,
         publication read off the document, F-42's span floor, F-46's
         purpose echo, F-45's negative record, F-35's accumulating note —
         is still asserted in this file, now THROUGH THE ACT PATH, and is
         additionally pinned as a pure unit test in narrationRules.test.ts
         (floored at 21, untouched).
     What is genuinely gone with the path, and is named in the F-100 ledger
     entry rather than quietly dropped: F-60's "a content page whose pack is
     empty is degraded to a hand-off before any call", which has no act-path
     equivalent (an unsupported seam is kept unverified for the gate
     instead), and F-50's self-reported `purposeRevised` flag, whose only
     producers were the deleted per-page reply shapes. */
  "test/writeNarration.test.ts": 49,
  /* Stage 3b (kanban t_567b570f, docs/show-pages-plan.md §Stage 3): shared
     catalogue store CRUD (scoping by show_id, upsert-not-duplicate on
     (show_id, guid), published_at ordering, feed-state round-trip). */
  "test/showEpisodesStore.test.ts": 5,
  /* Stage 3b end to end: fetches+parses+upserts through the real parser,
     proves the chapters JSON body is never dereferenced during ingestion
     (only the pointer is stored), TTL cache-hit/expiry behavior, and the
     never-blank-page degrade contract (cached_stale / no_cache_error) on a
     feed fetch failure — plus that a missing enclosure never fabricates an
     audio_url. */
  "test/ingestShowFeed.test.ts": 8,
  /* §4.8 end to end (kanban card t_7f410ffc): within-act stitching rules
     (silence bridge, jingle marks cuts, measured cadence, coverage
     hard-gate), the forward-only cross-act continuity Builder (§6.2),
     forayItems.ts's mapping to the real data/forays.json schema (with
     an internal-field-leak guard), and the cadence-measurement CLI. */
  /* RAISED 7 -> 17 by F-103: the derived `cites` shape a narrated beat
     publishes — what each source kind reduces to, that an unverified or
     never-verified page publishes none, that an empty result omits the field
     rather than shipping `[]`, the dedup, the non-http url drop, and the leak
     guard now that `sources`/`verified` actually reach this module. */
  "test/forayItems.test.ts": 17,
  "test/measureCadence.test.ts": 3,
  "test/smoothSeam.test.ts": 8,
  /* RAISED 9 -> 10 by F-96: a clip carrying two beats plays once. */
  /* RAISED 10 -> 13 by F-103: this module is the hop the writer's provenance
     used to die at, so the three tests are that `sources`/`verified` survive
     it — from a beat page, from a connective page (the branch a Frame's tape
     citation takes), and with `verified: false` copied verbatim rather than
     interpreted here. */
  "test/stitchAct.test.ts": 13,
  "test/stitchForay.test.ts": 4,
  /* A3.1/Q3 (kanban t_8d1a6a58): backend/src/catalog/breadthCatalog.ts +
     searchBreadthShows.ts — show search over the FULL breadth catalogue
     (curated + ~10k breadth tier), not just the 220 curated shows the
     client ships. Fixture-based ranking tests plus real-catalogue
     integration checks (merge/dedupe correctness against the committed
     data/catalog.json + data/catalog-breadth.json). */
  /* RAISED 11 -> 17 by the client audit (2026-09-12): searchBreadthShows now
     applies search-engine.js’s four-bucket rule with its popularity prior, so
     the endpoint TRUNCATES to `limit` under the order the client will display
     rather than under an order nobody sees. Six tests: the four buckets, the
     bucketed prior, the row shape (no dead `rank`, a live `chart_rank`), and
     three agreement tests that load the real search-engine.js in a node:vm and
     compare bucket for bucket and row for row over the real catalogue. */
  /* RAISED 17 -> 18 by P-08 (docs/search-parity-plan.md, 2026-09-12): the
     `limit` cut is now taken with the popularity prior compared ABOVE the
     prefix/word-start distinction, so a query with more than 25 title-initial
     matches no longer spends all 25 slots on unranked ones. The added test is
     the real-catalogue proof — for "history", *Dan Carlin's Hardcore History*
     is IN the 25 rows the endpoint sends, where before it was not in the reply
     at all and reached the listener only via Apple's directory. */
  "test/breadthCatalog.test.ts": 18,
  /* §4.9 end to end (kanban card t_0b1729d6): finalizeForay() validates
     a candidate against the real check-forays.mjs/check-narration.mjs
     and only returns a writable record on a clean pass; stageTiming.ts
     is §6.3's minimal batch-pipeline scope (real per-stage wall-clock
     timing, nothing speculative — see that module's own doc comment for
     why no live-generation-lead monitoring is built here). */
  /* +3 (F-49): the candidate's own minted tier-2 segments and source rows are
     merged into the pool and registry the checker is handed, never shadowing a
     committed row. */
  /* FD-07 / F-78: the minted tier-2 row against the real merge-segments --check gate,
     one named mutation per required field. */
  "test/mintedSegmentRow.test.ts": 18,
  /* FD-07 / F-75: the publish branch is cut from origin/main and pushes exactly one commit. */
  /* +7 (G-21c): the written files are gated by the app's real-data suites —
     a red suite refuses (assertion printed, bytes restored, branch abandoned),
     --force proceeds and the PR body lists the failing assertions, a green
     run touches nothing, detached-HEAD restore, a file that did not exist is
     removed again, and the refusal lands on report.json as publish_refused.
     One named mutation per test. */
  /* F-88 +1: the PR body names every page verified by synthesis and the
     pages it rests on. */
  /* RAISED 20 -> 26 by F-98: the superseded row rewritten in place, the draft
     runtimes restated, --supersedes and the PR body paragraphs. */
  /* +5 audit findings A/B/D (2026-09-12): `--force` implies `hold` (parseArgs,
     three tests), the verdict telling the operator to delete a KNOWN_UNCOVERED
     entry, and the PR body no longer claiming check-narration.mjs checked this
     Foray; 26 -> 31. */
  "test/publishForay.test.ts": 31,
  /* G-21c: REAL_DATA_SUITES names the four roadmap suites and every other
     suite the repo grep finds reading data/forays.json, data/segments.json or
     data/segment-sources.json (the list cannot rot); the TAP parser (one
     `not ok` → one failure with name/error/location, describe parents
     skipped, load failures attributed by name); the runner's cwd/flags and
     its three broken-run shapes; the summary and failure lines. One named
     mutation per test. */
  /* +4 audit finding B (2026-09-12): the fixture-coverage suite joins the gate,
     the check-forays loader counts as a real-data read, and knownUncoveredGuidance;
     15 -> 19. (Spelled without the call syntax on purpose: REAL_DATA_READ_RE now
     matches that name, and this file is one of the suites it greps.) */
  "test/publishSuites.test.ts": 19,
  /* F-98: deterministic post-seeding, the seed floor and its one re-ask —
     the scorer and its floor, the M4 ledger an assigned seed faces, the
     summary line, and the re-ask that is kept only when it is better. */
  "test/postSeedSpine.test.ts": 15,
  /* G-25: spine seeding ledger (M4-derived caps) and seed order. */
  /* RAISED 5 -> 6 by F-96: the seeding line's merged / pool-short / seedLost
     counts. */
  "test/spineSeeding.test.ts": 6,
  /* G-30: self-resuming runs, abort on a refused partial, notification hook, id suffixing. */
  "test/generateForaysHandsFree.test.ts": 20,
  /* +1 audit finding E (2026-09-12): this package's `isGeneratedDraft` agrees
     with player/foray-resolve.js over the whole truth table; 8 -> 9. */
  "test/finalizeForay.test.ts": 9,
  /* The `data/segment-sources.json` row a minted tier-2 segment needs, and the
     refusals that stop this pipeline writing one it cannot vouch for — an
     unknown DAI verdict above all, which ADR-0007 gates seek precision on. */
  "test/audioSourceLookup.test.ts": 9,
  "test/stageTiming.test.ts": 5,
  /* WS-D2 streaming publish (generation fix plan 2026-09-09): the partial
     candidate written after each act, the driver's per-act rewrite, and the
     private status read path. */
  /* Requirements §8.10 raised this from 4: the driver passes the checkpoint
     key as `sessionId`, which is the only thing that arms EPISODE_BUDGET_USD. */
  "test/generateForays.test.ts": 5,
  "test/generationStatus.test.ts": 4,
  "test/partialCandidate.test.ts": 6,
  /* F-79: a partial candidate is judged on the PROJECTED whole for the
     share-of-whole rules (M4, D2-end, D4-share) and on itself for every
     monotone rule — run 5 was aborted on an M4 share computed over a one-act
     slice. Q-04 retired D3 and D5's interquartile clause and F-101 took them
     out of the table. */
  /* RAISED 7 -> 8 by F-96: a merged beat's clip is projected once. */
  "test/partialProjection.test.ts": 8,
  /* F-101 — the generalising guard the stale table needed. It drives the REAL
     `tools/foray/check-forays.mjs` over mutated fixtures in a child process
     (Vitest cannot import the `.mjs` on a path with a space) and asserts every
     pattern in `PROJECTED_RULE_PATTERNS` matches a line the checker actually
     emits, so a renamed or retired rule turns the table red instead of
     silently reclassifying a share-of-whole rule as monotone. */
  "test/partialProjectionRules.test.ts": 3,
  /* F-87 (#315): a tape window whose cut ends past the episode's declared
     duration is refused at sourcing (`past-duration`), never clamped; the
     trace carries both numbers; the projection inherits the rule. Fixture is
     run 7 attempt 3's 2375.72 s cut on a 2071 s episode. */
  "test/pastDuration.test.ts": 7,
  /* WS-F robustness (docs/curation/generation-fix-plan-2026-09-09.md), closing
     F-03, F-04, F-11, F-13, F-17 and F-18 from generation run 1:
       checkpoint / runPipelineCheckpoint — per-stage resume inside ONE Foray,
         the store's own rules and then the whole pipeline driven through it
         (a narration failure costs the narration, not the spine);
       spineStructure — the §4.3->§4.4 gate, with run 1's real 3-act / 6-slot /
         31-beat spine as the fixture it must keep passing;
       researchTopicFilter — the `Ai` leak, asserted against the REAL semantic
         index and taxonomy because the leak is a property of that data;
       models — one file holds every model id, plus the grep that fails when a
         new literal appears anywhere in src/;
       generateForaysArgs — the --budget-usd flag and what it actually moves. */
  "test/checkpoint.test.ts": 14,
  "test/generateForaysArgs.test.ts": 10,
  "test/models.test.ts": 7,
  "test/researchTopicFilter.test.ts": 17,
  /* F-59 (docs/curation/generation-run-2026-09-09.md): the topic resolver's
     fusion magnet. Run 2's production-ML prompt resolved to
     `engineering/energy-fusion` on two words — `engineering`, free to every
     child of that root, and `systems`, from the label — and §4.5's lineage gate
     then refused every AI show in the archive. Asserted against the REAL
     taxonomy and semantic index, with run 2's own topic text, plus run 1's as
     the resolution the fix must not move. */
  "test/resolveTopic.test.ts": 14,
  /* F-51 raised this from 10: `narrate:<act>:<slot>` keys, so a run that dies
     partway through an act re-pays only for the slots that never landed, and
     the per-Foray budget cap the batch path left inert by never passing a
     sessionId. */
  "test/runPipelineCheckpoint.test.ts": 13,
  /* G-32: acts narrated in parallel, stitch and continuity in act order. Seven
     cases latch the writer to PROVE overlap (acts start while act 1 is held,
     the cap holds, a failure still banks in-flight acts and never starts
     queued ones); seven drive the real pipeline — act 1 ready while later acts
     are held, boundary order under reversed completion order, the checkpoint
     key set identical to the serial pipeline's, a crash resumed by narrating
     only the missing acts, the cap at 1 and at 4, and the report's per-act
     timings. */
  "test/parallelActs.test.ts": 14,
  /* Raised from 14 by WS-L (F-63): the per-act seeded-beat floor — enforced only
     when the research map quoted windows, never satisfiable by an invented
     episode id, and thrown rather than reported. */
  "test/spineStructure.test.ts": 19,
  /* F-86: the spine is re-asked once with the structural violations named
     before the run fails — pipeline banks only the passing spine, the
     re-ask is metered and reported, `SPINE_STRUCTURAL_REASKS` caps it. */
  "test/spineReask.test.ts": 7,
  /* WS-C: §4.5's topic gate (taxonomyFamily.ts). A family is a node's LINEAGE
     in data/taxonomy.json — itself, its ancestors, its descendants — not a
     shared first path segment, which would put every sibling trade in scope of
     every other. Unit-tested against the REAL committed catalogue files,
     pinning relationships rather than counts, because the finding it closes
     (F-29) is precisely two real files that were never joined. */
  "test/taxonomyFamily.test.ts": 18,
  /* F-91: supply-aware topic resolution (topicSupply.ts). `measureTopicSupply`
     counts, per candidate topic, the archive entries and pool segments the
     lineage gate admits — through the SAME predicates §4.5 applies — and
     `chooseTopic` lets that count break a tie the word scorer could not,
     within MIN_TOPIC_SUPPLY and TOPIC_SUPPLY_SCORE_FLOOR; no supply anywhere is
     a `no-supply` verdict the pipeline stops on before the spine. Run 8's two
     prompts are replayed against the REAL taxonomy and semantic index. */
  "test/topicSupply.test.ts": 19,
  /* WS-B veracity metrics (generation fix plan 2026-09-09): the grounded-quote /
     attribution-stability / tape-relevance metrics and the publish gate, plus
     the process-wide token-usage collector every Anthropic builder feeds. */
  "test/usageTracking.test.ts": 4,
  /* F-50/F-51 raised this from 31: `unverifiedPages` (the count the publish
     gate now refuses on, replacing writeNarration's throw) and
     `purposeRevisedPages` (reported, never gated). */
  /* RAISED 43 -> 47 by F-101: `computeFirstAttemptPassRates` emits the pages
     and beats units separately and declares which the legacy scalar carries;
     `computeListeningShares` says its denominator in the field name. */
  "test/veracityMetrics.test.ts": 47,
  /* WS-A evidence-first narration (generation fix plan 2026-09-09): the
     per-beat evidence pack (tape cue window + up to three retrieved print
     passages, cached by claim hash) and the mechanical narration rules run 1's
     writer kept breaking — every fixture in the second suite is a span,
     publication or sentence a page actually shipped in that run. */
  /* F-60 raised this from 19: an empty retrieval for a page that CARRIES
     content is asked once more with the purpose stripped to its distinctive
     nouns, cached under that second query's own key, and a cached emptiness
     stops being a cache hit after 24 hours. G-35 raised it from 27: the two
     queries now run concurrently (latched retriever proves the overlap, first
     non-empty answer wins) and F-77 says what emptiness may be cached — only a
     confirmed "two queries, nothing", for EVIDENCE_EMPTY_TTL_MS. */
  "test/gatherEvidence.test.ts": 37,
  /* G-35's prefetch stage (evidencePrefetch.ts): every page's evidence in one
     bounded fan-out after `source`, memoised so writeNarration makes zero
     retrieval calls; the concurrency cap is proven with latches. */
  "test/evidencePrefetch.test.ts": 7,
  "test/narrationRules.test.ts": 21,
  /* F-81 (generation run 5): a Frame's source is the tape it introduces.
     The `{kind: "tape", segmentId, quote?}` source shape, the mechanical
     gate on it (window held, echo spoken in the window under the anchor
     canonicalisation, connective modes only), the verifier handed the
     window as the holding document, the run-5 Frame text accepted end to
     end, and — pinned as unchanged — a source-less page that states a fact
     is still refused. One named mutation per test. */
  "test/frameTapeSource.test.ts": 24,
  /* F-82 (generation run 6): a connective page cites the adjacent tape it
     restates. A page holds the windows of BOTH segments beside it in play
     order (across slot edges), the prefetch stage keys on them so the hit
     rate stays 1, a content beat with no print but a neighbouring window
     is written as a Hinge from that tape instead of degraded, a phrase from
     the previous segment cited to the next one is refused and the note
     names the window that says it, the four run-6 pages are accepted end
     to end, `tapeCitedPages` counts, and — pinned as unchanged — a page
     with no source that states a fact is still refused. One named
     mutation per test. */
  /* LOWERED 19 -> 17 by F-100. The orchestrator half of this suite drove
     the per-slot path with a scripted per-page writer; it now drives the
     act path with the stub builders, which is what production and
     `--dry-run` run. Two tests went rather than moved, both because the
     rule they pinned was superseded before F-100 and only the test
     survived: "a content page that DID find print stays a Carry" (F-97
     assigns a seam's mode AFTER writing, from what it rests on, so no one
     can state the mode before the verifier answers — `isTapeClaim`'s mode
     rule is pinned directly in frameTapeSource.test.ts), and "a content
     page with neither print nor tape beside it is still degraded unwritten"
     (F-60's degrade-before-the-first-call was part of the deleted path).
     Everything else in the F-82 finding — both windows held and positioned,
     a phrase cited to the wrong window refused with the right one named,
     the four run-6 pages accepted end to end — is asserted unchanged. */
  "test/hingeTapeSource.test.ts": 17,
  /* F-84: a tier-2 cut at a start the pool holds reuses the pool's row and
     nothing is minted; the runtime follows the reused cut; the committed row
     wins an id tie in the runtime clock; an unrelated start still mints; a
     refused pool cut refuses the candidate rather than minting beside it;
     publish refuses the suffixed sibling, the same-start well-formed id and
     the same-id different cut, accepts the idempotent twin, and finalize
     throws before the checkers; and the half-second start rule is pinned in
     numbers. One named mutation per test. */
  /* RAISED 11 -> 17 by F-98: a draft mint superseded by a longer cut at the
     same start — when sourcing may re-cut a committed row, when F-84 reuse
     stands, and what the collision gate admits. */
  "test/mintDedupe.test.ts": 17,
  /* F-88 (run 7 attempt 4): nine thesis Hinges kept unverified because
     print retrieval finds nothing for a generalisation. Synthesis
     verification — the Hinge is written from the Foray's own verified pages
     and verified as a fair generalisation of them, recorded as
     `verification: { kind: "synthesis", restsOn, attempt }`; a Hinge naming
     a case no verified page covers stays unverified (the mutation test); a
     Patch never goes through it; the gate counts `synthesisVerifiedPages`
     separately and treats them as verified. One named mutation per test. */
  /* LOWERED 17 -> 8 by F-100. F-88 shipped as a SEPARATE PASS over pages
     the per-page path had degraded to `unverifiedReason: "no-evidence"`.
     Q-03/F-97 superseded it — the act writer is handed the earlier acts'
     verified pages as documents and the act verifier answers which act
     sources each seam rests on, in the call it was already making — and
     after Q-03 the pass could not run at all, because the act path never
     emits `no-evidence`. The pass is deleted and its nine tests with it.
     What remains, and is what F-97 consumes: which pages may be ground
     (never a page that itself rests on pages; never a source-less one),
     the id and document conventions the writer, the verifier and
     `verification.restsOn` share, and the gate counting these pages
     separately while treating them as verified. The end-to-end property —
     ground reaching the act and a seam resting on `p<n>` — is asserted in
     actNarration.test.ts, which is unchanged at 38. */
  "test/synthesisVerify.test.ts": 8,
  /* Q-02/Q-03/Q-05 (listening-quality deck; ledger F-95): narration written
     per ACT and verified per BEAT. A four-beat, two-clip act passes on all
     four in two calls with one page per seam; a mutation dropping a beat from
     the prose is red (the verifier names it, the retry edits the act, the
     seam is kept unverified for the gate); an Intro before each clip names the
     show, is absent when the host introduces the guest in the clip, is one
     clause for a same-episode follow-on, and is refused in code when it
     repeats the clip's first sentences; the listening KPIs
     (`narrationPagesPerSeam`, `narrationShare`, `tapeShare`, `introRestates`,
     `narrationCallsPerAct`, a beat-level `firstAttemptPassRate`); the seam
     plan and Intro rules; the two prompts; the stitcher's one item per seam.
     F-97 (Q-03 pass 2, after run 9 did not converge): support is act-scoped
     — a bridge seam resting only on the previous clip's window passes and
     its sources are what the verifier answered; the mode is assigned after
     writing (a tape-only bridge is a Frame, valid under the per-page rules);
     a clean Intro survives a retry for another seam (frozen, verbatim,
     pagesDropped 0); a contested-record assertion is refused with the
     sentence quoted; the verifier re-checks only what changed; F-88's ground
     reaches the act; the validator's zero-source rules are act-scoped.
     One named mutation per test. */
  "test/actNarration.test.ts": 52,
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

/* SWIFT FLOORS (NE-02). The native engine's pure core,
 * mobile/plugins/foray-audio/foray-engine-core, is compiled and tested only on
 * a CI Mac (ci.yml's ios-kit, `swift test` on the core): nobody who writes
 * this repo can run it, so a PR that deletes XCTests there reads as green to
 * everyone. mobile/ is not auto-merge territory the way test/ and tools/ are,
 * but the reason for a floor is the same: deletion should take an edit to two
 * files. Counted as `func test…(` in the code with comments stripped, so a
 * commented-out test does not count.
 *
 * Named files only, with no "every Swift file has a floor" closure: the
 * core's parity wrappers run one XCTest over a whole fixture family, and
 * those families are floored in player/parity/floors.json instead.
 *
 * MUTATION: delete testStopWhileIdleIsNoOp from the core's
 * PlayerQueueStateTests.swift, or wrap it in a block comment -> red. */
const SWIFT_FLOORS = {
  /* Copied with the reducer from ios/ForayKit @ adde5e12 (NE-02). NE-07s adds
     parity cases beside them and must never drop one: they are the proof the
     extension kept the behaviour the scaffold already had.
     tools/mobile/shell-invariants.test.mjs also pins them BY NAME against the
     frozen ios/ original, which a count cannot do. */
  "mobile/plugins/foray-audio/foray-engine-core/Tests/ForayEngineCoreTests/PlayerQueueStateTests.swift": 34,
  "mobile/plugins/foray-audio/foray-engine-core/Tests/ForayEngineCoreTests/ParityStubTests.swift": 6,
};

for (const [rel, floor] of Object.entries(SWIFT_FLOORS)) {
  test(`${rel} still exists and has >= ${floor} XCTest methods`, () => {
    const full = path.join(ROOT, rel);
    assert.ok(fs.existsSync(full), `${rel} is missing. Deleting a Swift suite is not a valid way to make CI pass.`);
    const code = fs.readFileSync(full, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    const count = (code.match(/\bfunc\s+test\w*\s*\(/g) || []).length;
    assert.ok(
      count >= floor,
      `${rel} has ${count} XCTest methods but the committed floor is ${floor}. ` +
        `If you removed tests on purpose, lower SWIFT_FLOORS in test/suite-integrity.test.js ` +
        `in the same PR and say why.`
    );
  });
}

/* PARITY FIXTURE FLOORS (NE-03). The native engine's fixtures live as data in
 * player/parity/fixtures/<family>/*.json, not as test() calls, so the FLOORS
 * table above cannot see a deleted case: the suite that reads them runs one
 * test per case and would simply run fewer. player/parity/floors.json holds a
 * minimum per family, written by tools/parity/record.mjs (raise-only unless
 * --lower-floors is passed, visibly), and this reads it against the fixtures on
 * disk — the same two-file friction as FLOORS: gutting a family now takes an
 * edit to floors.json AND the fixture, in a diff the merge audit shows.
 * MUTATION: delete one case from fixtures/seam-gap/seam-gap.json -> red. */
test("parity fixture families hold their floors, and every family has one", () => {
  const PARITY = path.join(ROOT, "player", "parity");
  const floorsFile = path.join(PARITY, "floors.json");
  assert.ok(fs.existsSync(floorsFile), "player/parity/floors.json is missing");
  const floors = JSON.parse(fs.readFileSync(floorsFile, "utf8")).families || {};
  const base = path.join(PARITY, "fixtures");
  const onDisk = {};
  for (const fam of fs.existsSync(base) ? fs.readdirSync(base) : []) {
    const dir = path.join(base, fam);
    if (!fs.statSync(dir).isDirectory()) continue;
    onDisk[fam] = fs.readdirSync(dir).filter((f) => f.endsWith(".json"))
      .reduce((n, f) => n + JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")).cases.length, 0);
  }
  for (const [fam, floor] of Object.entries(floors)) {
    assert.ok(fam in onDisk, `parity family ${fam} is floored at ${floor} but has no fixtures on disk`);
    assert.ok(onDisk[fam] >= floor, `parity family ${fam} has ${onDisk[fam]} cases but its floor is ${floor}`);
  }
  const unfloored = Object.keys(onDisk).filter((f) => !(f in floors));
  assert.deepStrictEqual(unfloored, [], "parity families with no floor (run tools/parity/record.mjs)");
  assert.ok(Object.keys(onDisk).length > 0, "no parity fixtures at all: the seam-gap family is seeded by NE-03");
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

/* A POINTER TO A SUITE POINTS AT ONE THAT EXISTS (review 2026-09-23).
 * Suites cite each other in comments — "test/x.test.js pins the other half" —
 * and a reader who follows a pointer to a file that is not there concludes the
 * behaviour is unpinned. test/keyboard-chrome-and-scroll.test.js pointed at a
 * test/sheet-owner.test.js that never existed (the cells are in
 * modal-and-focus). Scans the root and player suites for repo-relative suite
 * paths; a path preceded by another segment (`api/test/…`) is someone else's.
 * MUTATION: put `test/sheet-owner.test.js` back in that comment -> red. */
test("every suite a root or player suite names in its text exists", () => {
  const SUITE_REF = /(?<![\w/.-])((?:test|player|tools\/[\w-]+(?:\/[\w-]+)*)\/[\w.-]+\.test\.(?:js|mjs|cjs|ts))/g;
  const dangling = [];
  /* SELF is skipped: its floor list names backend suites by their package-relative
     path (`test/x.test.ts` under backend/). Elsewhere a `.ts` suite is backend's too. */
  for (const rel of [...findSuites("test"), ...findSuites("player")].filter((f) => f !== SELF)) {
    const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
    for (const m of text.matchAll(SUITE_REF)) {
      const exists = fs.existsSync(path.join(ROOT, m[1])) || fs.existsSync(path.join(ROOT, "backend", m[1]));
      if (!exists) dangling.push(`${rel} -> ${m[1]}`);
    }
  }
  assert.deepStrictEqual([...new Set(dangling)].sort(), [],
    "these suites cite a suite that does not exist:\n" + [...new Set(dangling)].join("\n"));
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
