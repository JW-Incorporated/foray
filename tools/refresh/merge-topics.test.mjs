/* Per-episode topics (#292) — `tools/refresh/topics.mjs` and the seam it gives
 * `merge.mjs`, plus the committed catalogue's own re-derivation.
 *
 * WHY THIS SUITE EXISTS. Topics were assigned per SHOW and there was no way to
 * say otherwise: of the 99 shows with >= 8 episodes on committed `main`, 77
 * carried an identical topic set on every episode. The remedy is one optional
 * field on the edits file, and the ways it could go quietly wrong are all
 * silent-and-green: an override that MERGES with the show label instead of
 * replacing it, an empty override that removes an episode from the catalogue
 * while looking like a relabel, a bad node id filtered away so the episode keeps
 * the default nobody chose, or the whole seam being applied on one of the two
 * pipelines.
 *
 * EVERY TEST NAMES THE ONE-LINE MUTATION THAT KILLS IT, per CLAUDE.md § "A green
 * test is not evidence until you have broken it", and each mutation below was
 * applied and observed to fail before this file was committed.
 *
 * THE HARNESS IS NOT MORE FORGIVING THAN THE REAL THING. The merge tests run the
 * REAL `merge.mjs` as a subprocess against the REAL `data/taxonomy.json` and the
 * REAL copy rules, writing to a temp directory via the same env overrides the
 * nightly uses for its inputs. Nothing here is a stand-in for merge: the five
 * green-but-vacuous tests CLAUDE.md lists all failed because a fake answered a
 * way the real thing cannot, and a hand-rolled "merge-like" function would have
 * been the sixth.
 *
 * The floor for this suite lives in test/suite-integrity.test.js.            */

import { test } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { episodeTopics, topicKey, uniformTopicShows, substantialShows, TopicError, MAX_TOPICS } from "./topics.mjs";
import { pendingRecord } from "./backfill-show.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const MERGE = join(HERE, "merge.mjs");

const taxonomy = JSON.parse(readFileSync(join(ROOT, "data", "taxonomy.json"), "utf8"));
const nodeIds = new Set(taxonomy.nodes.map((n) => n.id));

// ------------------------------------------------------------ episodeTopics --

test("no override keeps the show-level label, because a uniform label is correct for a single-subject show", () => {
  /* The seed is not the defect and removing it would be the wrong fix: `Engines
     of Our Ingenuity` really is `history/technology` on all 38 episodes.
     KILLED BY: `if (editTopics === undefined) return [];` in episodeTopics —
     which empties every episode that the curator did not explicitly relabel, and
     resolve.mjs then drops them all. */
  const seed = ["history/technology"];
  assert.deepEqual(episodeTopics({ showTopics: seed, nodeIds }), seed);
  assert.deepEqual(episodeTopics({ showTopics: seed, editTopics: undefined, nodeIds }), seed);
  assert.deepEqual(episodeTopics({ showTopics: seed, editTopics: null, nodeIds }), seed);
});

test("an override REPLACES the show label rather than adding to it", () => {
  /* A curator who judges an episode to be about a borehole is making a statement
     about the whole label. Merging would leave `science/materials` on every
     Stuff You Should Know episode forever — the defect surviving its own fix,
     invisibly, because the episode would still "have new topics".
     KILLED BY: `return [...seed, ...editTopics];` */
  const out = episodeTopics({
    showTopics: ["history/technology", "science/materials"],
    editTopics: ["nature/earth-science"],
    nodeIds,
  });
  assert.deepEqual(out, ["nature/earth-science"]);
});

test("an empty override is refused, because it would EXCLUDE the episode rather than relabel it", () => {
  /* resolve.mjs drops an episode whose topic list holds nothing valid, and the
     product rule is label-never-exclude. `[]` must therefore be an error and not
     a way of saying "no topics".
     KILLED BY: deleting the `editTopics.length === 0` branch — `[]` then returns
     `[]` and the episode silently leaves the catalogue. */
  assert.throws(
    () => episodeTopics({ showTopics: ["history/technology"], editTopics: [], nodeIds, id: "x" }),
    (e) => e instanceof TopicError && e.code === "TOPICS_EMPTY"
  );
});

test("an id outside the taxonomy is refused, not filtered away", () => {
  /* Filtering is the trap: `["history/tech"]` (a typo) would filter to `[]` and
     fall back to the show default, so the curator's judgement is discarded and
     the episode keeps the exact label #292 is about — with nothing printed.
     KILLED BY: `const unknown = [];` or replacing the throw with
     `return editTopics.filter(t => nodeIds.has(t))`. */
  assert.throws(
    () => episodeTopics({ showTopics: ["history/technology"], editTopics: ["history/tech"], nodeIds, id: "x" }),
    (e) => e instanceof TopicError && e.code === "TOPICS_UNKNOWN" && /history\/tech/.test(e.message)
  );
  // A partly-valid override is refused too — one good id must not launder a bad one.
  assert.throws(
    () => episodeTopics({ showTopics: [], editTopics: ["nature/earth-science", "nope"], nodeIds, id: "x" }),
    (e) => e.code === "TOPICS_UNKNOWN"
  );
});

test("an override longer than the cap is refused, the way an over-long tag list is", () => {
  /* `tags` is bounded 5-12 in the same preflight and `topics` was not, which
     nothing downstream would have caught: the two integrity suites check
     non-empty and resolvable, never length.
     KILLED BY: `if (false) {` on the MAX_TOPICS branch in topics.mjs.
     Also asserts the cap is not off by one, because a bound that refuses the
     legal maximum is the version of this that gets deleted rather than fixed. */
  const five = ["history/technology", "science/materials", "culture/books", "nature/pets", "society/law"];
  assert.equal(episodeTopics({ showTopics: [], editTopics: five, nodeIds }).length, MAX_TOPICS);
  assert.throws(
    () => episodeTopics({ showTopics: [], editTopics: [...five, "culture/art"], nodeIds, id: "x" }),
    (e) => e.code === "TOPICS_TOO_MANY"
  );
});

test("a non-array override is refused rather than spread into characters", () => {
  // KILLED BY: deleting the `Array.isArray(editTopics)` branch — a bare string
  // "history/technology" then reaches the nodeIds filter as an array of letters.
  assert.throws(
    () => episodeTopics({ showTopics: [], editTopics: "history/technology", nodeIds, id: "x" }),
    (e) => e.code === "TOPICS_NOT_ARRAY"
  );
});

// ----------------------------------------------------------------- topicKey --

test("topicKey is order-insensitive, so a re-ordered label is the SAME label", () => {
  /* This is what stops the uniformity report from being fooled. Without it,
     re-ordering 23 episodes' topic arrays would "fix" Stuff You Should Know on
     paper while changing nothing a reader would notice.
     KILLED BY: removing `.sort()` from topicKey. */
  assert.equal(topicKey(["b", "a"]), topicKey(["a", "b"]));
  assert.notEqual(topicKey(["a", "b"]), topicKey(["a", "c"]));
  // KILLED BY: removing `new Set(...)` — a duplicated id would read as a new label.
  assert.equal(topicKey(["a", "a", "b"]), topicKey(["a", "b"]));
});

// -------------------------------------------------------- uniformity report --

test("uniformTopicShows reports a show only when EVERY episode carries one topic set", () => {
  // KILLED BY: `if (keys.size === 1) continue;` (the inverted guard), which
  // reports exactly the shows that are already fine.
  const items = [
    ...Array.from({ length: 8 }, (_, i) => ({ show: "Same", title: `s${i}`, topics: ["history/technology"] })),
    ...Array.from({ length: 8 }, (_, i) => ({ show: "Varies", title: `v${i}`, topics: [i ? "history/technology" : "culture/books"] })),
  ];
  const out = uniformTopicShows(items, { minEpisodes: 8 });
  assert.deepEqual(out.map((r) => r.show), ["Same"]);
  assert.equal(out[0].episodes, 8);
});

test("a show one episode under the threshold is not reported, and the denominator agrees with it", () => {
  /* The report's headline is "N of M". If the two used different thresholds the
     fraction would be nonsense in a way no green test would notice.
     KILLED BY: `if (eps.length <= minEpisodes) continue;` in uniformTopicShows
     (off-by-one against substantialShows, which keeps `>= minEpisodes`). */
  const items = Array.from({ length: 7 }, (_, i) => ({ show: "Small", title: `s${i}`, topics: ["culture/books"] }));
  assert.deepEqual(uniformTopicShows(items, { minEpisodes: 8 }), []);
  assert.equal(substantialShows(items, { minEpisodes: 8 }), 0);
  items.push({ show: "Small", title: "s7", topics: ["culture/books"] });
  assert.equal(uniformTopicShows(items, { minEpisodes: 8 }).length, 1);
  assert.equal(substantialShows(items, { minEpisodes: 8 }), 1);
});

test("REAL REPO: the nine shows judged to RANGE now vary per episode, and none lost items", () => {
  /* A regression pin on the data, not the code, and deliberately so (CLAUDE.md
     § "A test that cannot fail on today's data is not worthless"). The cheapest
     way to undo #292 is a future pass that re-seeds these shows from
     catalog.json; this is the only thing in the repo that would notice.
     The item counts are asserted because label-never-exclude is the governing
     rule: a re-derivation that "fixes" uniformity by dropping episodes must fail.
     KILLED BY: setting any one of these shows' episodes back to a single shared
     topic set in data/discover.json. */
  const discover = JSON.parse(readFileSync(join(ROOT, "data", "discover.json"), "utf8"));
  /* show -> [episodes at the time of #292, floor on distinct topic sets].
     The floor is normally half the episode count, which every show clears with
     room: SYSK 21 distinct against 12, 99% Invisible 15 against 8, Huberman 15
     against 9, Freakonomics 11 against 6.

     SOFTWARE ENGINEERING DAILY IS THE ONE EXPLICIT EXCEPTION, at 5 rather than
     6, and the reason is written here rather than left as a number: it sits at
     exactly 6 distinct of 11, with five episodes legitimately sharing
     `computing/software-engineering` + `engineering/ai-robotics` because that is
     genuinely what they are about. At a floor of 6 a single honest future
     relabel onto an existing set would red CI with a message claiming the show
     "collapsed back toward one label" — a false alarm on an improvement, which
     is how a true alarm gets ignored. 5 is still five times the pre-#292 state
     of 1. The show is the least-differentiated of the nine and is arguably
     under-derived; that is the thing to fix, not the floor. */
  const expected = {
    "Stuff You Should Know": [23, 12],
    "The Rest Is History": [17, 9],
    "Huberman Lab": [17, 9],
    "99% Invisible": [15, 8],
    "Ologies with Alie Ward": [12, 6],
    "Unexplainable": [12, 6],
    "Freakonomics Radio": [11, 6],
    "Software Engineering Daily": [11, 5],
    "Being an Engineer": [9, 5],
  };
  const thin = [];
  for (const [show, [count, floor]] of Object.entries(expected)) {
    const eps = discover.items.filter((i) => i.show === show);
    /* `>=`, NOT `===`, AND THE DIFFERENCE IS A LIVE OUTAGE. All nine of these are
       curated shows in data/catalog.json, so `scan.mjs` polls their feeds every
       night and they GAIN episodes constantly — the 2026-08-21 nightly added to
       four of them in one run. An equality assertion therefore reds
       `data-and-site` on the next nightly PR, which never auto-merges, which
       leaves the digest unconsumed, which reds `watch-nightly --mode absence` the
       evening after. Expected time to failure: one night. A review round caught
       this by appending one synthetic episode and watching the suite go red.
       What the assertion is FOR is label-never-exclude, and `>=` says exactly
       that: episodes may arrive, none may leave. */
    assert.ok(eps.length >= count, `${show}: ${eps.length} episodes, expected at least ${count} — nothing may leave the catalogue`);
    const distinct = new Set(eps.map((e) => topicKey(e.topics)));
    /* A REAL FLOOR, NOT `> 1`. A review round caught the weaker form: at
       `distinct.size >= 2` a future pass could re-seed 22 of Stuff You Should
       Know's 23 episodes from catalog.json and this test would still pass —
       the whole defect back, with one exception left as camouflage. */
    if (distinct.size < floor) thin.push(`${show} (${distinct.size} distinct topic sets, need ${floor})`);
  }
  assert.deepEqual(thin, [], `these shows collapsed back toward one label: ${thin.join(", ")}`);
});

test("REAL REPO: every topic in the catalogue is a taxonomy node id", () => {
  /* test/data-topic-integrity.js owns this for `data/`; it is repeated here
     because THIS suite's subject is the code that writes topics, and a merge that
     could emit an unknown id would be caught by the wrong file's failure.
     KILLED BY: putting `"history/tech"` on any item in data/discover.json. */
  const discover = JSON.parse(readFileSync(join(ROOT, "data", "discover.json"), "utf8"));
  const bad = discover.items.flatMap((i) => (i.topics || []).filter((t) => !nodeIds.has(t)).map((t) => `${i.id}:${t}`));
  assert.deepEqual(bad, []);
});

// ------------------------------------------------- the real merge.mjs, run --

/** A throwaway data dir + a real merge run. `discover`/`tags` are the files the
    run mutates; the taxonomy and the copy rules come from the real repo. */
function runMerge({ resolved, edits }) {
  const dir = mkdtempSync(join(tmpdir(), "foray-merge-"));
  const path = (f) => join(dir, f);
  writeFileSync(path("resolved.json"), JSON.stringify({ resolved }));
  writeFileSync(path("edits.json"), JSON.stringify(edits));
  writeFileSync(path("discover.json"), JSON.stringify({ built_at: "x", items: [] }));
  writeFileSync(path("item-tags.json"), JSON.stringify({ built_at: "x", tags: {} }));
  let status = 0, stderr = "", stdout = "";
  try {
    stdout = execFileSync(process.execPath, [MERGE], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        RESOLVED_PATH: path("resolved.json"),
        EDITS_PATH: path("edits.json"),
        MERGE_DISCOVER_PATH: path("discover.json"),
        MERGE_TAGS_PATH: path("item-tags.json"),
      },
    });
  } catch (e) {
    status = e.status ?? 1;
    stdout = e.stdout || "";
    stderr = e.stderr || "";
  }
  const discover = JSON.parse(readFileSync(path("discover.json"), "utf8"));
  rmSync(dir, { recursive: true, force: true });
  return { status, stdout, stderr, items: discover.items };
}

/** A resolved record built by the BACKFILL path's own `pendingRecord`, so the
    field name merge reads is the field name that path writes. */
function resolvedFromBackfill(over = {}) {
  const show = {
    show_id: "sysk", title: "Stuff You Should Know", apple_collection_id: 1,
    artwork_url: "https://example.test/a.jpg",
    taxonomy_node_ids: ["history/technology", "science/materials"],
  };
  const { record } = pendingRecord(show, {
    title: "Kola: The World's Deepest Hole", guid: "g1",
    pubDate: "Wed, 04 Feb 2026 07:00:00 +0000", description: "A borehole.",
    "itunes:duration": "00:45:00", "itunes:explicit": "no",
    enclosure: { "@_url": "https://example.test/1.mp3", "@_type": "audio/mpeg", "@_length": "1" },
  });
  return {
    id: "sysk--kola", show: record.show, title: record.title,
    apple_collection_id: record.apple_collection_id, apple_track_id: 11,
    apple_episode_url: null, release_date: record.release_date,
    duration_min: record.duration_min, duration_sec: record.duration_sec,
    audio_url: record.audio_url, audio_type: record.audio_type, audio_bytes: record.audio_bytes,
    artwork_url: record.artwork_url, topics: record.topics, explicit: false,
    ...over,
  };
}

const EDIT = { hook: "During the Cold War the USSR drilled eight miles straight down.", tags: ["kola", "borehole", "cold-war", "drilling", "geology"] };

test("merge writes the agent's per-episode topics over the show-level seed", () => {
  /* The whole feature, through the real script.
     KILLED BY: `topics: ep.topics,` in merge.mjs (the pre-#292 line). */
  const { status, items } = runMerge({
    resolved: [resolvedFromBackfill()],
    edits: { "sysk--kola": { ...EDIT, topics: ["nature/earth-science", "history/technology"] } },
  });
  assert.equal(status, 0);
  assert.equal(items.length, 1);
  assert.deepEqual(items[0].topics, ["nature/earth-science", "history/technology"]);
});

test("merge keeps the show-level seed when the edit says nothing about topics", () => {
  /* The show default has to stay free, or every nightly episode of every
     single-subject show needs a hand-written topic list.
     KILLED BY: `topics: episodeTopics({ showTopics: [], ... })` in merge.mjs. */
  const { status, items } = runMerge({
    resolved: [resolvedFromBackfill()],
    edits: { "sysk--kola": EDIT },
  });
  assert.equal(status, 0);
  assert.deepEqual(items[0].topics, ["history/technology", "science/materials"]);
});

test("a bad topic id is refused by the SAME preflight as the copy rules, naming the item", () => {
  /* The preflight is where it has to happen: that loop runs before a single byte
     is written, so one bad override cannot half-write the catalogue, and the
     operator gets the item id rather than a stack trace.
     KILLED BY: `if (false && e.topics !== undefined) {` in merge.mjs's preflight
     — the run then dies on an uncaught TopicError inside the item loop, and
     stderr carries a stack instead of COPY RULE FAILURES.

     THE `items` ASSERTION CANNOT FAIL ON TODAY'S CODE and is deliberate
     (CLAUDE.md § "A test that cannot fail on today's data is not worthless"):
     merge writes only after every item is built, so nothing is partial today.
     It is here so that a future merge which streams its writes has to notice
     that label-never-exclude is what makes the ordering load-bearing. */
  const { status, stderr, items } = runMerge({
    resolved: [resolvedFromBackfill({ id: "sysk--a" }), resolvedFromBackfill({ id: "sysk--b", apple_track_id: 12 })],
    edits: {
      "sysk--a": EDIT,
      "sysk--b": { ...EDIT, topics: ["history/tech"] },
    },
  });
  assert.equal(status, 1);
  assert.match(stderr, /COPY RULE FAILURES/);
  // Quoted, so `[null]` and `[""]` — real hand-edit typos — stay legible.
  assert.match(stderr, /sysk--b: not taxonomy node ids: "history\/tech"/);
  assert.deepEqual(items, [], "a refused override must not half-write the catalogue");
});

test("scan.mjs seeds topics from the SHOW and from nothing else, so the nightly needs no matching change", () => {
  /* A SOURCE-TEXT assertion, and it is here under protest — `scan.mjs` is a main
     script with no exported record builder, so there is nothing to call. The
     alternative was worse: a review round caught the test below claiming to pin
     "both pipelines" while every record in it came from `backfill-show.mjs`.
     Mutating scan.mjs left the whole suite green, which is #211/#219/#249's exact
     shape — "both sides agree" asserted, one side pinned.

     What it holds: the nightly emits `topics` (the field merge.mjs overrides),
     seeded from the show. If that ever becomes a per-episode assignment inside
     scan.mjs, there are two topic seams again and this goes red.
     WHAT IT DOES NOT CATCH, said plainly so the next reader does not over-trust
     it: the property-match below sees OBJECT-LITERAL keys only. A review round
     probed it with a statement-form seam — `pending[pending.length - 1].topics =
     ["culture/books"];` — and the suite stayed green, which is the exact defect
     the test exists for. Hence the second assertion: no assignment TO a `.topics`
     property anywhere in the file. Between them the two cover both spellings a
     second seam can take. A third spelling (`Object.assign`, a computed key)
     would still slip past, and that is the honest limit of reading source text.

     KILLED BY: changing `topics: show.taxonomy_node_ids || []` in scan.mjs — to a
     different field name, or to anything episode-derived — or by adding
     `rec.topics = …` anywhere in it. */
  const src = readFileSync(join(HERE, "scan.mjs"), "utf8");
  /* The value match tolerates a trailing `// comment`, because it must not red
     the nightly over a comment: the probe round found `topics: show.taxonomy_node_ids || [],  // seed`
     went red under the stricter `,\s*$`, and a false alarm on a comment-only edit
     is how a real alarm gets ignored. */
  const assignments = [...src.matchAll(/^\s*topics:\s*(.+?),\s*(?:\/\/.*)?$/gm)].map((m) => m[1].trim());
  assert.deepEqual(assignments, ["show.taxonomy_node_ids || []"],
    "scan.mjs must seed topics from the show and must not gain a second topic seam");
  assert.ok(!/\.topics\s*=[^=]/.test(src),
    "scan.mjs assigns to a .topics property — that is a second, per-episode topic seam");
});

test("the backfill path and the nightly path reach the SAME topic seam, by writing the same field", () => {
  /* #211/#219/#249 are all one shape: two paths that had to agree and did not.
     `scan.mjs` and `backfill-show.mjs` are two producers of one pending shape, and
     the override lives at their single point of convergence — merge.

     THIS TEST PINS THE BACKFILL SIDE ONLY. `fromScan` below is hand-built and
     proves nothing about scan.mjs; the test directly above is what holds that
     side, and it has to read source text because scan.mjs exports nothing. Said
     plainly because an earlier draft of this comment claimed both, which is the
     coverage overclaim that makes a suite read as more than it is.
     KILLED BY: renaming `topics` to anything else in backfill-show.mjs's
     `pendingRecord` — the seed then arrives as undefined and the "no override"
     case writes `[]` instead of the show label. */
  const fromBackfill = resolvedFromBackfill();
  assert.deepEqual(fromBackfill.topics, ["history/technology", "science/materials"]);
  // A scan-shaped record: the same field, seeded the same way, hand-built here
  // because scan.mjs is a main script with no exported record builder.
  const fromScan = { ...fromBackfill, id: "sysk--scan", apple_track_id: 13, topics: ["history/technology", "science/materials"] };

  const seeded = runMerge({
    resolved: [fromBackfill, fromScan],
    edits: { "sysk--kola": EDIT, "sysk--scan": EDIT },
  });
  assert.equal(seeded.status, 0);
  assert.deepEqual(seeded.items.map((i) => i.topics), [
    ["history/technology", "science/materials"],
    ["history/technology", "science/materials"],
  ]);

  const overridden = runMerge({
    resolved: [fromBackfill, fromScan],
    edits: {
      "sysk--kola": { ...EDIT, topics: ["nature/earth-science"] },
      "sysk--scan": { ...EDIT, topics: ["nature/earth-science"] },
    },
  });
  assert.equal(overridden.status, 0);
  assert.deepEqual(overridden.items.map((i) => i.topics), [["nature/earth-science"], ["nature/earth-science"]]);
});
