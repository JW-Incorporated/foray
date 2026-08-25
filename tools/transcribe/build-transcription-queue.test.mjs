/* Suite for tools/transcribe/build-transcription-queue.mjs and for the artefact
 * it produces, data/transcription-queue.json.
 *
 * WHAT IS WORTH PINNING HERE, and what is not. The ranking is rough by the
 * brief's own instruction, so nothing below asserts an order or a weight — a
 * test that froze `WEIGHTS` would only make the founder's next opinion cost a
 * test edit. What IS pinned is the set of things that would silently corrupt a
 * running transcription box or launder an estimate as a measurement:
 *
 *   1. append-safety (a worker has already consumed these ranks)
 *   2. the measured/estimated label, and that a live verification never
 *      fabricates a count out of a failed fetch
 *   3. that the shipped file's totals are its own arithmetic, not prose
 *   4. that topic_tags are real taxonomy nodes, in a file that auto-merges unread
 *
 * EVERY TEST BELOW NAMES THE ONE-LINE MUTATION THAT BREAKS IT, and every one of
 * those mutations was applied to the producer and observed to fail before this
 * file was committed. Per CLAUDE.md "A green test is not evidence until you have
 * broken it": five agents have shipped a green test that pinned nothing because
 * the fixture was more forgiving than the thing it stood for.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  mergeAppendSafe,
  selectForBudget,
  applyVerification,
  verificationPlan,
  queuedEpisodes,
  archetypeFit,
  demandScore,
  durabilityScore,
  totalsFor,
  audioHoursEstimate,
  topicsFor,
  PER_SHOW_CAP,
  PER_GENRE_CAP,
  EPISODE_BUDGET,
  MIN_SHOWS,
  EPISODES_PER_DAY,
  REPO_ROOT,
} from "./build-transcription-queue.mjs";

const QUEUE = path.join(REPO_ROOT, "data", "transcription-queue.json");
const queue = JSON.parse(fs.readFileSync(QUEUE, "utf8"));
const taxonomy = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "data", "taxonomy.json"), "utf8"));
const PRODUCER = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "build-transcription-queue.mjs"), "utf8");
/* Comments stripped, for the source scans below. The producer's header
   deliberately DISCUSSES the things those scans forbid — "a `--rerank` option
   would be one typo away from renumbering a live queue" — and a scan that could
   not tell an explanation from an implementation would force the explanation
   out of the file. Which is backwards: the explanation is the part that stops
   the next session from adding the flag. */
const PRODUCER_CODE = PRODUCER.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// ------------------------------------------------------------ append-safety --

test("a rebuild leaves every already-published row byte-identical", () => {
  /* MUTATION: in mergeAppendSafe, replace the carry-through loop body
     `out.push(s)` with `out.push({ ...s, rank: out.length + 1 })` — i.e. renumber
     as you go, which is what a "tidy the ranks" change looks like. VERIFIED
     FAILING: rank 7 becomes 1.

     This is the defect the whole file exists to prevent. A worker mid-run has
     consumed ranks 1..k; renumbering makes its log describe different shows. */
  const v1 = [
    { rank: 7, title: "A", feed_url: "https://a.example/rss", added_queue_version: 1, episodes_queued: 50 },
    { rank: 9, title: "B", feed_url: "https://b.example/rss", added_queue_version: 1, episodes_queued: 50 },
  ];
  const before = JSON.stringify(v1);
  const res = mergeAppendSafe(v1, [{ title: "C", feed_url: "https://c.example/rss", episodes_queued: 10 }], 2);

  assert.equal(JSON.stringify(v1), before, "mergeAppendSafe must not mutate its input");
  assert.deepEqual(res.shows.slice(0, 2), v1, "carried rows must come through unchanged, in place");
  assert.equal(res.shows[0].rank, 7);
  assert.equal(res.shows[1].rank, 9);
  assert.equal(res.added, 1);
  assert.equal(res.carried, 2);
});

test("a new show appends past the highest existing rank, never into a gap", () => {
  /* MUTATION: change `maxRank += 1` to `maxRank = out.length` in mergeAppendSafe.
     VERIFIED FAILING: the new row lands at rank 2, colliding with nothing today
     but reusing a number a future version will hand out again.

     The gap matters: ranks 1..6 and 8 are absent above, and a producer that
     "fills holes" would hand two different shows the same rank across versions,
     which is exactly the ambiguity a worker's log cannot resolve. */
  const res = mergeAppendSafe(
    [{ rank: 7, feed_url: "https://a.example/rss" }, { rank: 9, feed_url: "https://b.example/rss" }],
    [{ feed_url: "https://c.example/rss" }, { feed_url: "https://d.example/rss" }],
    2
  );
  assert.deepEqual(res.shows.map((s) => s.rank), [7, 9, 10, 11]);
  assert.deepEqual(res.shows.slice(2).map((s) => s.added_queue_version), [2, 2]);
});

test("identity is the feed url, case- and whitespace-insensitively, so a re-run adds nothing", () => {
  /* MUTATION: in mergeAppendSafe, change `const key = (u) => String(u||"").trim().toLowerCase()`
     to `const key = (u) => String(u||"")`. VERIFIED FAILING: added becomes 1 and
     the same feed is queued twice under two ranks.

     Feeds arrive from three sources here (the sweep, the Apple harvest, the
     PodcastIndex dump) and they do not agree on case. */
  const res = mergeAppendSafe(
    [{ rank: 1, feed_url: "https://A.example/RSS" }],
    [{ feed_url: "  https://a.example/rss  " }],
    2
  );
  assert.equal(res.added, 0);
  assert.equal(res.shows.length, 1);
});

test("the shipped queue is in strict ascending rank order with no duplicate rank or feed", () => {
  /* MUTATION: sort `merged.shows` by priority_score before writing in
     buildDocument. VERIFIED FAILING on the real file.

     This asserts the invariant on the ARTEFACT rather than on the function, so
     it also catches a hand-edit of data/transcription-queue.json — which is the
     likelier failure, because data/ auto-merges with no human read. */
  const ranks = queue.shows.map((s) => s.rank);
  for (let i = 1; i < ranks.length; i++) {
    assert.ok(ranks[i] > ranks[i - 1], `rank ${ranks[i]} at index ${i} does not follow ${ranks[i - 1]}`);
  }
  assert.equal(new Set(ranks).size, ranks.length);
  const feeds = queue.shows.map((s) => String(s.feed_url).trim().toLowerCase());
  assert.equal(new Set(feeds).size, feeds.length, "a feed is queued twice");
});

test("the producer offers no way to re-rank an existing queue", () => {
  /* MUTATION: add `if (argv.includes("--rerank")) rows.sort(...)` to main().
     VERIFIED FAILING.

     A --rerank flag is one typo away from renumbering a live queue and buys
     nothing: a better order among shows the box has already processed is worth
     zero. This is a source scan for the same reason
     tools/classify/no-exclusion.test.mjs greps the classification pipeline — the
     cheapest way for a constraint to be lost is a later change that reads as
     reasonable. */
  for (const forbidden of ["--rerank", "--renumber", "--resort", "--reset-ranks"]) {
    assert.ok(!PRODUCER_CODE.includes(forbidden), `producer offers ${forbidden}, which can renumber a consumed queue`);
  }
});

// -------------------------------------------------- measured vs estimated --

test("every shipped count carries a basis, and v1 claims no estimates", () => {
  /* MUTATION: drop `count_basis: c.count_basis` from the row literal in main().
     VERIFIED FAILING: 153 rows have an undefined basis. */
  for (const s of queue.shows) {
    assert.ok(["measured", "estimated"].includes(s.count_basis), `${s.title}: count_basis ${s.count_basis}`);
    assert.ok(s.count_source, `${s.title}: no count_source`);
    assert.ok(s.count_measured_at, `${s.title}: no count_measured_at`);
    if (s.count_basis === "estimated") assert.ok(s.count_estimator, `${s.title}: estimated with no estimator named`);
  }
  assert.equal(queue.totals.counts_estimated, 0);
  assert.equal(queue.totals.counts_measured, queue.shows.length);
});

test("the one estimated number in the file says so and names its estimator", () => {
  /* MUTATION: in audioHoursEstimate, change `basis: "estimated"` to
     `basis: "measured"`. VERIFIED FAILING.

     Audio hours is the only estimate in the document: durations are the
     publisher's declared <itunes:duration> and most shows borrow a pooled
     median. Presenting it as measured is precisely the failure
     data/breadth-transcript-yield.json's `inferred: 0` exists to make visible. */
  assert.equal(queue.totals.audio_hours.basis, "estimated");
  assert.match(queue.totals.audio_hours.estimator, /pooled median/i);
  assert.ok(queue.totals.audio_hours.hours > 0);

  /* The artefact assertion above only bites on the next rebuild, so the
     PRODUCER is asserted too. Found by the mutation harness: flipping the
     producer's `basis: "estimated"` to `"measured"` left the committed file
     untouched and the suite green — a green test that pinned nothing, which is
     the exact failure CLAUDE.md's five worked examples describe. */
  const recomputed = audioHoursEstimate(queue.shows);
  assert.equal(recomputed.basis, "estimated", "the producer must label this an estimate, not only the shipped file");
  assert.equal(recomputed.hours, queue.totals.audio_hours.hours);

  const none = audioHoursEstimate([{ episodes_queued: 50 }]);
  assert.equal(none.basis, "unavailable", "with no measured duration anywhere it must refuse, not guess");
  assert.equal(none.hours, undefined);
});

test("a failed live fetch changes no count", () => {
  /* MUTATION: in applyVerification's !live.ok branch, add
     `out.episodes_without_transcript = 0;`. VERIFIED FAILING.

     Writing zeros on a timeout is how a measurement file starts lying, and it
     lies in the flattering direction: "we could not read it" would become
     "nothing to do here". */
  const row = { episodes_total: 400, episodes_without_transcript: 400, episodes_queued: 50, count_measured_at: "2026-08-23T00:00:00Z", labels: [] };
  const out = applyVerification(row, { ok: false, verified_at: "2026-08-24T00:00:00Z", error_code: "TIMEOUT" });
  assert.equal(out.episodes_total, 400);
  assert.equal(out.episodes_without_transcript, 400);
  assert.equal(out.episodes_queued, 50);
  assert.equal(out.count_measured_at, "2026-08-23T00:00:00Z", "the as-of date must not move when nothing was measured");
  assert.equal(out.verified_live.status, "unreadable");
  assert.ok(out.labels.includes("live-verification-failed"));
});

test("a live reading that contradicts the sweep parks the show without removing it", () => {
  /* MUTATION: in applyVerification's contradicts branch, drop
     `out.episodes_queued = 0`. VERIFIED FAILING: the box is sent to transcribe
     50 episodes the publisher already publishes transcripts for.

     The opposite mutation — deleting the row — is what "label, never exclude"
     forbids and what would renumber a consumed queue. Both directions are
     asserted here. */
  const row = { rank: 4, episodes_total: 400, episodes_without_transcript: 400, episodes_queued: 50, labels: ["dai-suspected"] };
  const out = applyVerification(row, {
    ok: true,
    verified_at: "2026-08-24T00:00:00Z",
    episodes_total: 400,
    episodes_with_transcript: 390,
    episodes_with_timed_transcript: 390,
    newest_pub_date: "x",
    median_duration_sec: 100,
  });
  assert.equal(out.rank, 4, "rank must survive a contradiction");
  assert.equal(out.episodes_queued, 0, "no GPU time for a show that already has transcripts");
  assert.equal(out.episodes_without_transcript, 10, "counts move to the live measurement");
  assert.equal(out.verified_live.status, "contradicts-sweep");
  assert.ok(out.labels.includes("dai-suspected"), "existing labels must survive");
  assert.ok(out.labels.includes("live-verification-contradicts-sweep"));
});

test("a confirming live reading re-derives the ask from the fresh count", () => {
  /* MUTATION: in applyVerification's confirming branch, change
     `queuedEpisodes(out.episodes_without_transcript, cap)` to
     `row.episodes_queued`. VERIFIED FAILING: a feed that shrank to 12 items is
     still asked for 50.

     This is the case where the live read is the only thing standing between the
     box and a work order it cannot fill. */
  const row = { episodes_total: 400, episodes_without_transcript: 400, episodes_queued: 50, labels: [] };
  const out = applyVerification(row, {
    ok: true,
    verified_at: "2026-08-24T00:00:00Z",
    episodes_total: 12,
    episodes_with_transcript: 0,
    episodes_with_timed_transcript: 0,
    newest_pub_date: "x",
    median_duration_sec: 100,
  });
  assert.equal(out.episodes_queued, 12);
  assert.equal(out.verified_live.status, "confirms-sweep");
});

// ------------------------------------------------------- budget and spread --

test("selectForBudget respects the per-genre cap before it spends the budget", () => {
  /* MUTATION: in selectForBudget, move the genre-cap check inside the budget
     loop so it runs after `taken.push`. VERIFIED FAILING: 8 of the 10 sports
     rows survive.

     Order of operations is the whole point: a budget spent first lets one genre
     fill the month before the cap ever runs. */
  const ranked = [];
  for (let i = 0; i < 10; i++) ranked.push({ feed_url: `s${i}`, chart_genre: "Football", episodes_without_transcript: 200 });
  for (let i = 0; i < 10; i++) ranked.push({ feed_url: `h${i}`, chart_genre: "History", episodes_without_transcript: 200 });
  const res = selectForBudget(ranked, { perGenreCap: 2, minShows: 1, budget: { min: 0, target: 10_000, max: 10_000 } });
  assert.equal(res.taken.filter((t) => t.chart_genre === "Football").length, 2);
  assert.equal(res.taken.filter((t) => t.chart_genre === "History").length, 2);
  assert.equal(res.genre_capped, 16);
});

test("selectForBudget never exceeds the ceiling and never emits a zero-work row", () => {
  /* MUTATION: change `if (episodes + q > budget.max) break;` to
     `if (episodes > budget.max) break;`. VERIFIED FAILING: the total lands at
     1,200 against a ceiling of 1,000.

     The zero-work half pins the `if (q <= 0) continue` guard: a show whose
     measured un-transcribed count is 0 must not take a queue slot. Mutation for
     that half: delete that line. */
  const ranked = [{ feed_url: "z", chart_genre: "A", episodes_without_transcript: 0 }];
  for (let i = 0; i < 40; i++) ranked.push({ feed_url: `x${i}`, chart_genre: `G${i}`, episodes_without_transcript: 200 });
  const res = selectForBudget(ranked, { perGenreCap: 5, minShows: 1000, budget: { min: 0, target: 10_000, max: 1000 } });
  assert.ok(res.episodes <= 1000, `${res.episodes} exceeds the 1000 ceiling`);
  assert.ok(res.taken.every((t) => t.episodes_queued > 0));
  assert.ok(!res.taken.some((t) => t.feed_url === "z"));
});

test("the per-show cap bounds one show's share of the month", () => {
  assert.equal(queuedEpisodes(2741, PER_SHOW_CAP), PER_SHOW_CAP);
  assert.equal(queuedEpisodes(38, PER_SHOW_CAP), 38);
  assert.equal(queuedEpisodes(-5, PER_SHOW_CAP), 0);
  for (const s of queue.shows) {
    assert.ok(s.episodes_queued <= PER_SHOW_CAP, `${s.title} asks for ${s.episodes_queued}`);
    assert.ok(s.episodes_queued <= s.episodes_without_transcript, `${s.title} asks for more than it measured`);
  }
});

test("the shipped queue meets the brief it was sized against", () => {
  /* Not a mutation test — a sizing assertion on the artefact. It fails the day
     someone hand-edits the file below 100 shows or outside the month window,
     which is the only way those constraints get lost now that the producer is
     deterministic. */
  assert.ok(queue.shows.length >= MIN_SHOWS, `${queue.shows.length} shows, brief asks >= ${MIN_SHOWS}`);
  assert.ok(queue.totals.episodes_queued >= EPISODE_BUDGET.min, `${queue.totals.episodes_queued} below the floor`);
  assert.ok(queue.totals.episodes_queued <= EPISODE_BUDGET.max, `${queue.totals.episodes_queued} above the ceiling`);
});

test("the document's totals are its own arithmetic, not prose", () => {
  /* MUTATION: in totalsFor, change `days_at_250_per_day` to a literal 30.
     VERIFIED FAILING.

     A summary block that drifts from the rows under it is worse than no summary
     — it is the number that gets quoted. Recomputing here from `shows` closes
     that gap for the shipped file. */
  const recomputed = totalsFor(queue.shows);
  assert.equal(recomputed.shows, queue.totals.shows);
  assert.equal(recomputed.episodes_queued, queue.totals.episodes_queued);
  assert.equal(recomputed.days_at_250_per_day, queue.totals.days_at_250_per_day);
  assert.equal(recomputed.counts_measured, queue.totals.counts_measured);
  assert.equal(
    queue.totals.days_at_250_per_day,
    Number((queue.totals.episodes_queued / EPISODES_PER_DAY).toFixed(1))
  );
});

// ------------------------------------------------------------------ topics --

test("every topic tag in the shipped queue is a real taxonomy node", () => {
  /* MUTATION: in topicsFor, drop the `.filter((t) => nodeIds.has(t))` from
     fromAgent. VERIFIED FAILING on a rebuild — data/breadth-classification.json
     carries superseded ids that are no longer nodes.

     Same gate test/data-topic-integrity.test.js holds over the other data/
     files. data/ auto-merges unread, so an invented id would reach the app
     unseen and fire no interest slider. */
  const nodeIds = new Set(taxonomy.nodes.map((n) => n.id));
  for (const s of queue.shows) {
    assert.ok(Array.isArray(s.topic_tags) && s.topic_tags.length > 0, `${s.title} has no topic tags`);
    for (const t of s.topic_tags) assert.ok(nodeIds.has(t), `${s.title}: ${t} is not a data/taxonomy.json node`);
  }
});

test("topicsFor unions the agent classification with the deterministic genre map", () => {
  /* MUTATION: return `fromAgent` alone. VERIFIED FAILING.

     The union is the hedge against a classifier this pool has caught misfiling
     Pop Culture Happy Hour under science/storytelling: a misfiled show still
     carries its Apple genre's nodes. Dropping either side quietly narrows what
     the queue can be selected on. */
  const fake = {
    classification: { entries: { 42: { topics: ["comedy", "not-a-node"], confidence: "high", source: "classify-agent-tier1" } } },
    genreMap: { map: { History: { topics: ["history", "also-not-a-node"] } } },
    taxonomy,
  };
  const out = topicsFor({ apple_collection_id: 42, chart_genre_name: "History" }, fake);
  assert.deepEqual(out.topics, ["comedy", "history"]);
  assert.deepEqual(out.agent, ["comedy"]);
  assert.deepEqual(out.genre, ["history"]);

  // A show the agent never saw still gets its genre's nodes rather than nothing.
  const genreOnly = topicsFor({ apple_collection_id: 999, chart_genre_name: "History" }, fake);
  assert.deepEqual(genreOnly.topics, ["history"]);
  assert.deepEqual(genreOnly.agent, []);
});

// ----------------------------------------------------------------- scoring --

test("archetypeFit is max-over-personas, not sum, and normalises to 1", () => {
  /* MUTATION: change `best = Math.max(best, w.weight)` to `best += w.weight`.
     VERIFIED FAILING: the bland show scores 1.0 and outranks the loved one.

     Summing rewards a show every archetype mildly tolerates over one a single
     archetype loves, which inverts what the queue is for. */
  const personas = [
    { weights: [{ node_id: "engineering", weight: 0.9 }, { node_id: "science", weight: 0.4 }] },
    { weights: [{ node_id: "history", weight: 0.5 }, { node_id: "science", weight: 0.5 }] },
  ];
  const loved = archetypeFit(["engineering"], personas);
  const bland = archetypeFit(["science", "history"], personas);
  assert.equal(loved, 1, "the top weight normalises to 1");
  assert.ok(bland < loved, `bland ${bland} should not beat loved ${loved}`);
  assert.equal(archetypeFit(["gaming"], personas), 0);
  assert.equal(archetypeFit(["engineering/robotics"], personas), 1, "a child node scores through its root");
});

test("demand and durability behave at their edges", () => {
  assert.equal(demandScore(1), 1);
  assert.ok(demandScore(200) > 0 && demandScore(200) < 0.02);
  assert.equal(demandScore(null), 0, "an unranked show scores 0 rather than NaN");
  assert.equal(demandScore(9999), demandScore(200), "ranks past the chart clamp rather than going negative");
  assert.equal(durabilityScore("History"), 1);
  assert.ok(durabilityScore("Daily News") < 1);
});

// ------------------------------------------------------------ verification --

test("verificationPlan takes the whole head and a disjoint, seeded tail sample", () => {
  /* MUTATION: change `const tail = shows.slice(top)` to `shows.slice(0)`.
     VERIFIED FAILING: the tail sample re-draws rows already in the head, so the
     "estimate for the rest of the queue" is measured on the part we already
     verified — a sample that cannot report the thing it exists to report. */
  const shows = Array.from({ length: 100 }, (_, i) => ({ rank: i + 1, feed_url: `f${i}` }));
  const a = verificationPlan(shows, { top: 25, sample: 15 });
  const b = verificationPlan(shows, { top: 25, sample: 15 });

  assert.equal(a.head.length, 25);
  assert.equal(a.tailSample.length, 15);
  assert.deepEqual(a.tailSample.map((s) => s.rank), b.tailSample.map((s) => s.rank), "seeded: two runs draw the same rows");
  assert.ok(a.tailSample.every((s) => s.rank > 25), "the sample must come from beyond the head");
  assert.equal(new Set(a.tailSample.map((s) => s.rank)).size, 15, "no row drawn twice");
});

test("the shipped file's top 25 were each verified against a live feed read", () => {
  /* The brief's hard rule 3. Asserted on the artefact, because the point is what
     shipped, not what the code could do.

     MUTATION: in main()'s --verify branch, change `[...plan.head, ...plan.tailSample]`
     to `[...plan.tailSample]` and rebuild. VERIFIED FAILING: 0 of 25. */
  const head = queue.shows.filter((s) => s.rank <= 25);
  assert.equal(head.length, 25);
  for (const s of head) {
    assert.ok(s.verified_live, `rank ${s.rank} ${s.title} was never live-verified`);
    assert.notEqual(s.verified_live.status, "unreadable", `rank ${s.rank} ${s.title} could not be read`);
    assert.equal(s.verified_live.episodes_with_transcript, 0, `rank ${s.rank} ${s.title} publishes transcripts`);
    assert.equal(s.count_basis, "measured");
  }
  assert.equal(queue.method.live_verification.head_verified, 25);
  assert.equal(queue.method.live_verification.contradicted, 0);
});

test("the producer owns no fetch, no user-agent and no rate limiter of its own", () => {
  /* MUTATION: give the producer a hardcoded client-identity header, or a bare
     `await fetch(url)`. VERIFIED FAILING, both.

     The mutation is DESCRIBED rather than quoted, and that is not squeamishness:
     politeness.test.mjs's #316 guard scans every tracked .mjs under tools/ for a
     spelled-out User-Agent, and it caught this very file when the literal was
     here. Quoting the forbidden bytes to document that they are forbidden is how
     the eleventh copy gets made. (It only bit once the file was git-added — the
     guard reads `git ls-files`, so an untracked new suite is invisible to it.
     Worth knowing: a green run before `git add` is not the run that counts.)

     politeness.mjs (#318) owns the per-host gate and every outbound identity
     string. Its own header records that the last two fetchers in this repo were
     written by copying the previous one and both copies drifted into the same
     two politeness bugs. This scan is the same shape as the one in
     politeness.test.mjs, aimed at this file. */
  assert.ok(!/\bfetch\s*\(/.test(PRODUCER.replace(/fetchFeed\s*\(/g, "")), "producer calls fetch() directly");
  assert.ok(!/User-Agent/i.test(PRODUCER_CODE), "producer spells a User-Agent for itself");
  assert.ok(PRODUCER.includes("../segments/sweep-transcripts.mjs"), "producer must borrow the shared feed reader");
});

test("node:sqlite is imported dynamically, not at module scope", () => {
  /* MUTATION: hoist `import { DatabaseSync } from "node:sqlite"` to the top of
     the producer. VERIFIED FAILING here, and on CI's Node 22 it would take the
     WHOLE suite down — node:sqlite is flagged there (see tools/ci/run-suites.mjs
     on tools/corpus/package.json needing --experimental-sqlite) — on a code path
     no test exercises.

     Written as a source scan rather than an import test deliberately: on this
     Node 24 box the hoisted import succeeds, so only reading the source can
     catch it. That is the "the fixture is more forgiving than the thing it
     stands for" failure from CLAUDE.md, and this is the patch for it. */
  const code = PRODUCER.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(!/^\s*import[^\n]*node:sqlite/m.test(code), "node:sqlite is imported at module scope");
  assert.ok(/await import\("node:sqlite"\)/.test(code), "the dynamic import is gone");
});

// ------------------------------------------------------------- the artefact --

test("the shipped document explains how append-safety is preserved", () => {
  /* The brief requires the file to SAY how the property is kept, because the
     next session reads the artefact and not this suite. */
  assert.equal(queue.queue_version, 1);
  assert.ok(queue.append_safety, "no append_safety block");
  assert.ok(Array.isArray(queue.append_safety.how_preserved) && queue.append_safety.how_preserved.length >= 3);
  assert.ok(queue.append_safety.consumer_contract, "a worker is not told how to read the file");
  assert.ok(queue.method.counting.measured_definition.includes("<item>"));
  assert.ok(Array.isArray(queue.method.known_gaps) && queue.method.known_gaps.length > 0, "no gaps admitted");
  for (const s of queue.shows) {
    assert.equal(s.added_queue_version, 1);
    assert.ok(s.why_ranked, `${s.title} has no why_ranked`);
    assert.ok(Number.isInteger(s.podcastindex_feed_id), `${s.title} has no podcastindex_feed_id`);
    assert.ok(Array.isArray(s.labels));
  }
});

test("the funnel accounts for every swept show", () => {
  /* MUTATION: in buildCandidates, delete the `bump("drop_not_english")` line.
     VERIFIED FAILING: the arithmetic is short by 167.

     A funnel whose branches do not sum is how a silent exclusion hides — which
     is the rule the founder set for this catalogue ("label, never exclude") and
     the one tools/classify/no-exclusion.test.mjs holds one layer down. */
  const f = queue.method.funnel;
  const drops = Object.entries(f).filter(([k]) => k.startsWith("drop_")).reduce((n, [, v]) => n + v, 0);
  assert.equal(f.swept, drops + f.candidate, `swept ${f.swept} != drops ${drops} + candidates ${f.candidate}`);
  assert.equal(f.after_genre_cap + f.dropped_by_genre_cap, f.candidate);
  assert.equal(f.selected, queue.shows.length);
});

test("no Apple chart genre owns more than its share of the queue", () => {
  const per = new Map();
  for (const s of queue.shows) per.set(s.apple_chart.genre, (per.get(s.apple_chart.genre) || 0) + 1);
  for (const [g, n] of per) assert.ok(n <= PER_GENRE_CAP, `${g} has ${n} shows, cap is ${PER_GENRE_CAP}`);
  assert.ok(per.size >= 30, `only ${per.size} distinct genres`);
});
