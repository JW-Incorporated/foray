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
  "player/diagnostic-log.test.js": 50,
  "player/diagnostic-record.test.js": 23,
  "player/episode-link.test.js": 6,
  /* The durable store (#40). Both of these guard against silent DATA LOSS
     rather than a wrong answer on screen, which makes them the two suites in
     `player/` whose deletion would be hardest to notice: everything keeps
     rendering, and a listener's place quietly stops surviving the week. */
  "player/durable-store.test.js": 74,
  "player/idb-tier.test.js": 23,
  /* New with M3 (kanban card t_c7199b13): the event queue moved off a
     synchronous `cp_events` localStorage rewrite into its own IndexedDB
     database. Covers append/flush never throwing, batching, the two id
     spaces (durable + fallback ring), and the two behaviours the design
     calls out by name — quota exhaustion (not lost, surfaced via health(),
     never thrown) and the 5,000-row retention cap. */
  "player/event-log.test.js": 20,
  /* 83 -> 87 with #225: the page's two failure guards now reach the field record.
     Two of the four exist to keep the instrument from becoming the outage it was
     built to explain — one pins that the message is on screen BEFORE the record is
     touched (the obvious version of it could not see the order at all), and one
     that an error too hostile to read still produces both. */
  "player/foray-playback.test.js": 87,
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
  /* The SegmentStrip (#128) — the element that makes a Foray legible as
     something other than a playlist. Floored with no slack because what it
     holds down is a set of DESIGN decisions, each a single line from its
     opposite and none of them visible in a passing render: that a capsule is a
     source EPISODE and not a show (two episodes of one podcast are two hard
     cuts the listener hears), that the seam survives greyscale, that a narrator
     bridge is an item rather than a gap, that no two touching capsules share a
     tone, and that both themes' palettes clear 3:1. Every test names the
     mutation that kills it. */
  "player/segment-strip.test.js": 27,
  "player/strip-scrub-gesture.test.js": 41,
  "player/seek-policy.test.js": 33,
  /* The app's name on the surfaces users read (#302), 6 -> 8 when the two
     published legal documents were added, 8 -> 21 when the shipped UI copy that
     suite had only RECORDED as a known gap was renamed and pinned -- twenty
     strings, two of which the gap record itself had missed. Zero slack,
     deliberately: every assertion here is a single string in a single file, so
     each is exactly one careless edit from its opposite, and #302 exists because
     reverting one of them passed the whole suite. */
  "test/app-name.test.js": 21,
  "test/app-security.test.js": 26,
  "test/episode-page.test.js": 8,
  /* Stage 3 of docs/episode-pages-plan.md — epRow/archivedRow/bannerHtml
     title links to #/episode/:id (kanban card t_51e5d7bc). Floored at its
     exact current count: this is a small, deliberately-scoped regression
     suite (title link + PR #357 unchanged-controls checks), so any change to
     its size is worth a second look. */
  "test/episode-row-links.test.js": 5,
  /* Visible explicit-content ("E") badge (kanban card t_02c6bb0b):
     explicitBadge() itself, its four call sites (epRow, archivedRow,
     renderEpisode, renderShow at both episode- and show-level), and a check
     that Family Mode's pre-existing poolFiltered() filter still fires
     unchanged — the badge is additive, not a replacement for that filter. */
  "test/explicit-badge.test.js": 9,
  "test/first-time-onboarding.test.js": 10,
  /* Duplicate-ID guard for HUMAN-ACTIONS.md's own numbering rule (full-repo
     review finding L3, 2026-08-31). Two tests: the file has numbered items,
     and no numeric ID repeats. */
  "test/human-actions-integrity.test.js": 2,
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
  /* S-08's mechanical privacy tripwire: SHOWS_SEARCH_OFF_DEVICE flag detection
     (source and env), the pinned current-sentence check, the core AND-gate
     that fails release builds only when the flag is on AND the old sentence
     is still present, and the HUMAN-ACTIONS.md G5 cross-reference. Floored at
     5 because this is the gate S-05's shard search must ship behind — a test
     quietly deleted here is a release build free to ship off-device search
     while the privacy policy still swears it never happens. */
  "test/release-gates.test.js": 5,
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
     data-deletion and app-security. */
  "test/playlist-durability.test.js": 33,
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
     => the show resolves artwork. */
  "test/show-page.test.js": 43,

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
  "test/home-layout.test.js": 5,

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

  /* Requirements A3.2/A3.3 — category browse + all-shows index (kanban card
     "Build: category browse — linkify taxonomy chips + all-shows index"):
     the taxonomy-chip link itself, the showsForCategory overlap join against
     the real catalogue, renderCategory/renderAllShows (including honest
     unknown-category/empty-catalogue states), the two new routes, and the
     menu's "Shows" entry as the one affordance that replaced the removed
     "Browse all shows" link (and that the link is gone). Every test names
     its mutation; see the suite header for the full list of what each test
     pins. */
  "test/category-browse.test.js": 11,

  /* Stage 2 of docs/show-pages-plan.md — show search (kanban card
     t_1c9afc67): SearchEngine.searchShows against the real catalogue,
     scope-boundary proof that the topic scorer is untouched, and the
     search as the Shows page's own affordance (distinct form, distinct
     results list, honest empty state, absent from Home). Every test names
     its mutation; see the suite header for the full list of what each
     test pins. */
  "test/show-search.test.js": 11,
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
  "test/home-information-architecture.test.js": 11,
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
  /* Settings drawer stays open on toggle (Joey, 2026-08-31, t_0c09d83a): the
     three toggles' click handlers, plus the two real-navigation regression
     guards. */
  "test/drawer-settings-toggle.test.js": 6,
  /* "Up Next" auto-advance (docs/listening-queue-plan.md §8 addendum, kanban
     card t_b9880844). Floored for the same reason as up-next-queue.test.js
     above: the auto-advance decision path (off-by-default, queue-origin
     scoping, end-of-queue stop, mid-playback removal) is exactly the shape
     of silent-wrong-behavior this repo's floors exist to catch, not a crash
     path any other suite would notice going missing. Every test names its
     mutation; see the suite header for the full list of what each pins. */
  "test/up-next-autoadvance.test.js": 6,
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
  "test/sw-generation.test.js": 51,
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
  "tools/ci/path-policy.test.mjs": 88,
  /* The LF-checkout guard on the deploy manifest. Small, and every test is one
     branch of a function whose whole job is to refuse. The load-bearing one is
     the binary exclusion: both committed icons really do carry `\r\n` bytes, so
     dropping it fires the guard on a clean Linux runner and blocks
     `data-and-site` for the entire repo. All 10 named mutations were run and
     killed. */
  "tools/ci/crlf-guard.test.mjs": 10,
  "tools/ci/pr-triage.test.mjs": 85,
  "tools/ci/run-suites.test.mjs": 36,
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
  "tools/mobile/prepare-webdir.test.mjs": 72,
  "tools/mobile/shell-invariants.test.mjs": 50,
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
     than rejecting into a caller's promise chain. */
  "tools/mobile/foray-tts.test.mjs": 22,
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
  "tools/mobile/inject-background-audio.test.mjs": 41,
  "tools/mobile/ios-ci.test.mjs": 89,
  "tools/mobile/ios-workflow.test.mjs": 45,
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
         flake in front of the artefact. */
  "tools/mobile/android-workflow.test.mjs": 61,
  /* Wiring the signing config into a project nobody commits. ZERO SLACK.
     `mobile/android/` is regenerated on every build, so the only evidence the
     release signing config ever reaches Gradle is that this script ran and its
     `--check` pass agreed. If it silently does nothing, `bundleRelease` emits an
     UNSIGNED bundle and prints BUILD SUCCESSFUL. The one not to lose is "a MENTION
     of the include is not a wiring": the script writes a COMMENT naming
     `foray-signing.gradle` directly above the apply line, so a substring check
     would report a commented-out wiring as wired. */
  "tools/mobile/wire-signing.test.mjs": 11,
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
  "tools/mobile/webview-probe.test.mjs": 15,

  /* M1 (full-repo review 2026-08-31): the byte-ceiling guards shared by
     scan.mjs and refresh-feeds.mjs. Covers all three defenses named in the
     finding — reject an implausible declared Content-Length before
     download, abort mid-stream once the decompressed byte ceiling is
     crossed (the chunked/endless-response case that a Content-Length check
     alone cannot catch), and cap the item count after parsing — plus the
     end-to-end wiring through fetchFeedCapped. */
  "tools/refresh/fetch-limits.test.mjs": 14,

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
  "test/AnthropicDeepenActBuilder.test.ts": 7,
  "test/AnthropicEnricher.test.ts": 10,
  "test/AnthropicExternalResearcher.test.ts": 9,
  "test/AnthropicPromptUnderstander.test.ts": 9,
  "test/AnthropicSpineBuilder.test.ts": 8,
  "test/archetypes.test.ts": 7,
  "test/budgetGuard.test.ts": 6,
  "test/candidateExtractor.test.ts": 8,
  "test/conditionalGet.test.ts": 9,
  "test/copyRules.test.ts": 3,
  "test/createEnricher.test.ts": 1,
  /* Generation pipeline §4.0-4.1 (kanban card t_825eee4c). */
  "test/createPromptUnderstander.test.ts": 1,
  "test/dataSchemaCompliance.test.ts": 8,
  "test/dedup.test.ts": 17,
  "test/duration.test.ts": 12,
  /* DAILY_BUDGET_USD env parsing (L5): rejects negative / NaN / empty /
     over-cap values at startup instead of silently substituting the
     default, and leaves a genuinely unset variable on its fallback. */
  "test/env.test.ts": 10,
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
  "test/parseWithRetry.test.ts": 9,
  "test/parser.test.ts": 29,
  "test/personas.test.ts": 6,
  "test/podcastIndex.test.ts": 3,
  "test/politeness.test.ts": 9,
  "test/poolIntegrity.test.ts": 6,
  /* Generation pipeline §4.0-4.1 (kanban card t_825eee4c): §9.4's ruling
     ("prompts are discarded") enforced structurally — this suite scans the
     generation-stage source for persistence primitives and proves a full
     understand-prompt run touches no file on disk. */
  "test/promptNoPersistence.test.ts": 3,
  "test/property/dedup.property.test.ts": 5,
  "test/property/duration.property.test.ts": 5,
  "test/property/html.property.test.ts": 4,
  "test/property/interestWeight.property.test.ts": 3,
  "test/redirect.test.ts": 6,
  "test/scoring.test.ts": 17,
  "test/sessionBuilder.test.ts": 12,
  "test/stubEnricher.test.ts": 6,
  "test/userInterests.test.ts": 17,
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
  "test/researchShape.test.ts": 11,
  /* §4.3's spine types: SpineSchema (strict, no per-act voice field),
     isClaimShaped (claim- vs topic-shaped beats), and validateSpine
     (§3's shape budgets with ±15% tolerance, the ~30% exploration
     floor). Kanban card t_96a97be9. */
  "test/spineTypes.test.ts": 26,
  /* §4.3 end to end: buildSpine() against StubSpineBuilder for every
     duration tier (shape budgets, claim-shape, exploration floor,
     single spine-level voice all actually hold), plus InvalidSpineError
     on a deliberately broken builder. Kanban card t_96a97be9. */
  "test/buildSpine.test.ts": 6,
  /* §4.4 end to end (kanban card t_c963701a): deepenActs() fans out
     builder.deepenAct() once per act IN PARALLEL, always passing the
     FULL spine. Covers shape/count correctness, the full-spine-context
     regression guard, genuine-parallelism proof, and explicit
     failure-isolation (one retry per act, then fail the whole build). */
  "test/deepenActs.test.ts": 10,
  /* §4.5-4.6 end to end (kanban card t_648fbae7): sourceBeats() resolves
     every beat to a tier-1 segments.json hit, a tier-2 transcript-archive
     extraction, a tier-3 transcription-queue-candidate narration fallback,
     or a Patch/Carry narration assignment — never changing which beats
     exist, and never fetching/persisting any audio bytes. */
  "test/sourceBeats.test.ts": 8,
  /* §4.7 end to end (kanban card t_5a8b77c3): writeNarration() writes one
     page per narration beat (mode budgets, per-claim sources array),
     always through a genuinely separate verifier call (never the writer —
     proven with a spy test), the exact check-forays.mjs-compatible
     disclosure template, and decideConnectiveNarration()'s seam-position
     table for tape-adjacent beats needing short connective narration. */
  "test/writeNarration.test.ts": 19,
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
  "test/forayItems.test.ts": 7,
  "test/measureCadence.test.ts": 3,
  "test/smoothSeam.test.ts": 8,
  "test/stitchAct.test.ts": 9,
  "test/stitchForay.test.ts": 4,
  /* A3.1/Q3 (kanban t_8d1a6a58): backend/src/catalog/breadthCatalog.ts +
     searchBreadthShows.ts — show search over the FULL breadth catalogue
     (curated + ~10k breadth tier), not just the 220 curated shows the
     client ships. Fixture-based ranking tests plus real-catalogue
     integration checks (merge/dedupe correctness against the committed
     data/catalog.json + data/catalog-breadth.json). */
  "test/breadthCatalog.test.ts": 11,
  /* §4.9 end to end (kanban card t_0b1729d6): finalizeForay() validates
     a candidate against the real check-forays.mjs/check-narration.mjs
     and only returns a writable record on a clean pass; stageTiming.ts
     is §6.3's minimal batch-pipeline scope (real per-stage wall-clock
     timing, nothing speculative — see that module's own doc comment for
     why no live-generation-lead monitoring is built here). */
  "test/finalizeForay.test.ts": 5,
  "test/stageTiming.test.ts": 5,
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
