/* `tools/mobile/prepare-webdir.mjs` — the native bundle's assembly (issue #36).
 *
 * What is actually at stake here, in order:
 *
 *   1. THE BUNDLE MUST CONTAIN EVERY FILE THE CLIENT FETCHES. Miss one and the
 *      app 404s on a device, where nobody is watching a console.
 *   2. THE BUNDLE MUST NOT CONTAIN `data/`'s PIPELINE INPUTS. They are 60 MB;
 *      `breadth-classification.json` alone is 16 MB.
 *   3. THE DERIVATION MUST NOT FAIL GREEN. The data list is read out of app.js
 *      rather than written down, so the interesting failure is not "wrong file"
 *      but "no files, small bundle, exit 0". Two tests below attack exactly that.
 *   4. THERE MUST BE NO SECOND COPY OF THE PLAYER. Everything is copied at build
 *      time from the real files; the closure test is what notices a player module
 *      the plan would have missed.
 *   5. THE CATALOGUE SLICE MUST STAY BOUNDED, AND MUST NOT LOSE A JOIN. Two data
 *      files are written as a bounded slice rather than copied, because their size
 *      is a function of the catalogue and the nightly refresh was about to break the
 *      build. That makes "the bundle got smaller" the expected outcome, so it stops
 *      being a signal — which is why an empty slice has to be a hard error, and why
 *      the show->artwork and show->collection-id joins are asserted through the REAL
 *      `player/foray-sources.js` functions rather than re-derived here.
 *
 * Most tests run against a synthetic repo in a temp directory, so they assert the
 * script's behaviour rather than today's file list. The ones that use the REAL repo
 * are marked, and they are the regression signal for the size cap and for the slice.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  REPO_ROOT, DEFAULT_OUT, MAX_BYTES, SHELL_FILES, EXCLUDED_FROM_BUNDLE,
  MIN_DERIVED_DATA_FILES, runtimeDataFiles, playerFiles, buildPlan, prepare,
  SHELL_ONLY_FILES, shellOnlyPlan, shellScriptTags, injectShellScripts,
  assertShellScriptsPresent, WebDirError,
  BUNDLED_ITEMS_PER_SHOW, PROJECTED_DATA, COPIED_WHOLE, discoverSlice,
  assertDiscoverSliceComplete, serializeSlice, sliceBytes, assertSlicesOnDisk, projectData,
  referencedSegmentIds, segmentSlice, segmentSourceSlice, assertForaySliceComplete,
  WHY_COPIED_WHOLE,
} from "./prepare-webdir.mjs";
import { createRequire } from "node:module";

/* The production join, imported the same way prepare-webdir.mjs imports it, so the
   slice's central promise is asserted against the code the app runs. */
import { artworkUrlsByShow, collectionIdsByShow } from "../../player/foray-sources.js";
/* The OTHER production join, ditto — this is the one the segment slice must be
   indistinguishable from (#327). */
import { hydrateForayItems, indexSegments, indexSources } from "../../player/foray-resolve.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");

/* ───────────────────────────── the derivation ───────────────────────────── */

test("every fetchJson(data/...) call in the real app.js is derived", () => {
  const src = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
  const derived = runtimeDataFiles(src);
  /* Cross-checked against an independent count of the call sites, so this does
     not simply re-run the same regex and agree with itself. `fetchJson(` also
     matches the function's own declaration, which is not a call — subtracting it
     is what makes the two counts comparable. */
  const callSites =
    (src.match(/fetchJson\(/g) || []).length - (src.match(/function fetchJson\(/g) || []).length;
  assert.equal(derived.length, callSites, "some fetchJson call was not derived into the plan");
  assert.ok(derived.includes("data/session.json"), "the session document must be in the bundle");
  assert.ok(derived.length >= MIN_DERIVED_DATA_FILES);
  for (const f of derived) assert.match(f, /^data\/[^/]+\.json$/);
});

test("data/ paths that are only mentioned, never fetched, stay out of the bundle", () => {
  const src = [
    '  forays: null,             // data/forays.json   — may be absent',
    '/* see the data/app-links.json research */',
    'const x = "data/catalog-breadth.json";',
    'await fetchJson("data/session.json");',
  ].join("\n");
  assert.deepEqual(runtimeDataFiles(src), ["data/session.json"]);
});

test("quote style does not change the derivation, and duplicates collapse", () => {
  const src = `fetchJson('data/a.json') fetchJson("data/b.json") fetchJson(\`data/c.json\`) fetchJson("data/a.json")`;
  assert.deepEqual(runtimeDataFiles(src), ["data/a.json", "data/b.json", "data/c.json"]);
});

test("a broken derivation is a hard error, not a small bundle", () => {
  /* THE FAILS-GREEN CASE, and the reason MIN_DERIVED_DATA_FILES exists. If
     fetchJson is renamed, the regex matches nothing; without this guard the
     script would cheerfully emit a shell with no session document, pass the size
     cap, and exit 0. The app would launch to an error card. */
  const fake = makeFakeRepo({ appSrc: 'await loadJson("data/session.json");' });
  assert.throws(() => buildPlan(fake), /Derived only 0 runtime data file/);
});

test("a fetched file that is not on disk fails the build", () => {
  const fake = makeFakeRepo({ extraFetches: ["data/not-generated-yet.json"] });
  assert.throws(() => buildPlan(fake), /not on disk/);
});

/* ────────────────────────────── the copy plan ───────────────────────────── */

test("the plan carries the shell, the player and nothing else from the root", () => {
  const plan = buildPlan(ROOT);
  for (const f of SHELL_FILES) assert.ok(plan.includes(f), `${f} missing from the plan`);
  assert.ok(plan.includes("player/client.js"));
  assert.ok(plan.includes("index.html"), "without index.html it is not a valid webDir");
});

test("no test file and no service worker is ever in the plan", () => {
  const plan = buildPlan(ROOT);
  const tests = plan.filter((f) => f.includes(".test."));
  assert.deepEqual(tests, [], "test suites must not ship to devices");
  for (const bad of EXCLUDED_FROM_BUNDLE) {
    assert.ok(!plan.includes(bad), `${bad} must never be bundled — the shell does not register it`);
  }
  assert.ok(!plan.includes("sw.js"));
});

test("no pipeline input is in the plan", () => {
  /* The named enemies. These are the files whose accidental inclusion is the
     whole reason the size cap exists. */
  const plan = buildPlan(ROOT);
  for (const big of [
    "data/breadth-classification.json",
    "data/catalog-breadth.json",
    "data/catalog-breadth-intl.json.gz",
    "data/episode-archive.json.gz",
    "data/transcript-availability.json",
  ]) {
    assert.ok(!plan.includes(big), `${big} is a pipeline input, not client data`);
  }
});

test("the plan is closed under the player's own imports", () => {
  /* The anti-fork test. `playerFiles` takes "every non-test .js in player/",
     which is correct only while the player is a flat directory of siblings. The
     day a module moves into `player/backends/`, this fails instead of shipping an
     app whose very first import 404s. */
  const plan = new Set(buildPlan(ROOT));
  const missing = [];
  for (const rel of plan) {
    if (!rel.startsWith("player/")) continue;
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    for (const m of src.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1]));
      if (!plan.has(target)) missing.push(`${rel} imports ${m[1]} -> ${target}, which is not bundled`);
    }
  }
  assert.deepEqual(missing, []);
});

test("index.html's own script and style references are all bundled", () => {
  const plan = new Set(buildPlan(ROOT));
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  for (const m of html.matchAll(/(?:src|href)="([^"#:]+\.(?:js|css|json|png))"/g)) {
    assert.ok(plan.has(m[1]), `index.html references ${m[1]} but the bundle does not carry it`);
  }
});

/* ──────────────────────────────── the output ────────────────────────────── */

test("prepare copies the plan and reports its size", () => {
  const fake = makeFakeRepo();
  const r = prepare({ root: fake, out: "www" });
  assert.ok(fs.existsSync(path.join(fake, "www", "index.html")));
  assert.ok(fs.existsSync(path.join(fake, "www", "data", "session.json")));
  assert.ok(fs.existsSync(path.join(fake, "www", "player", "client.js")));
  assert.equal(fs.existsSync(path.join(fake, "www", "sw.js")), false, "sw.js was copied into the bundle");
  assert.equal(fs.existsSync(path.join(fake, "www", "player", "client.test.js")), false);
  assert.equal(fs.existsSync(path.join(fake, "www", "data", "huge-pipeline-input.json")), false);
  assert.equal(r.total, r.files.reduce((n, f) => n + f.bytes, 0));
});

test("prepare rebuilds from scratch, so a removed file does not linger", () => {
  /* A stale file in a build artefact is how "we deleted that months ago" ends up
     on a device. */
  const fake = makeFakeRepo();
  prepare({ root: fake, out: "www" });
  fs.writeFileSync(path.join(fake, "www", "ghost.js"), "// left over");
  prepare({ root: fake, out: "www" });
  assert.equal(fs.existsSync(path.join(fake, "www", "ghost.js")), false);
});

test("exceeding the size cap fails loudly and names the biggest files", () => {
  /* #36 asks for this specifically: the cap must FAIL, not warn. */
  const fake = makeFakeRepo({ bigDataBytes: 400 * 1024 });
  assert.throws(
    () => prepare({ root: fake, out: "www", maxBytes: 100 * 1024 }),
    (e) => /exceeds the/.test(e.message) && /Largest files/.test(e.message) && /data\/taxonomy\.json/.test(e.message)
  );
});

test("prepare refuses an output directory it should not be deleting", () => {
  const fake = makeFakeRepo();
  /* `prepare` starts by recursively deleting its output. A typo'd --out is then a
     data-loss bug, so the path is constrained twice: inside the repo, and named
     `www`. CLAUDE.md § Never discard uncommitted work. */
  assert.throws(() => prepare({ root: fake, out: path.join("..", "www") }), /inside the repo/);
  assert.throws(() => prepare({ root: fake, out: "player" }), /named "www"/);
  assert.ok(fs.existsSync(path.join(fake, "player", "client.js")), "the guard let a real directory be deleted");
});

/* ─────────────────────── the real repo, today's numbers ─────────────────── */

test("REAL REPO: today's bundle is under the 3 MB cap", () => {
  /* Deliberately not mocked. This is the early-warning signal for the cap.

     IT USED TO SUM THE SOURCE FILES' SIZES, and that quietly stopped being the
     bundle: `data/discover.json` and `data/item-tags.json` are now written as a
     bounded slice, so the source sum is 1.2 MB larger than the thing that ships.
     Left alone, this test would have gone on failing on the next nightly refresh
     while the actual bundle sat at 1.78 MB — an alarm on a quantity nobody
     installs, which is worse than no alarm. So it builds the real bundle. */
  const r = withRealBundle((built) => built);
  assert.ok(
    r.total <= MAX_BYTES,
    `the bundle is ${(r.total / 1024 / 1024).toFixed(2)} MB, over the ${(MAX_BYTES / 1024 / 1024).toFixed(0)} MB cap`
  );
  assert.ok(r.total > 512 * 1024, `the bundle is only ${(r.total / 1024).toFixed(0)} KB — the plan has probably collapsed`);
  /* The source sum, for contrast, so the numbers in the PR are reproducible here
     rather than only in a commit message. */
  const sourceTotal = buildPlan(ROOT).reduce((n, rel) => n + fs.statSync(path.join(ROOT, rel)).size, 0);
  assert.ok(
    sourceTotal > r.total,
    `the bundle is not smaller than the files it is built from, so nothing is being sliced`
  );
});

/** Build the real bundle and hand it to `fn` as `(result, absOutDir)`, then delete
 *  it. Deliberately NOT `mobile/www`: that is the directory a developer's `cap sync`
 *  reads, and a suite that rebuilds it is a suite that can change what somebody is
 *  mid-way through testing on a device. `mobile/.gitignore`'s unanchored `www/`
 *  covers this path at any depth, and `assertSafeOut` requires the basename `www`. */
function withRealBundle(fn, opts = {}) {
  const outRel = path.join("mobile", ".bundle-under-test", "www");
  try {
    return fn(prepare({ root: ROOT, out: outRel, ...opts }), path.join(ROOT, outRel));
  } finally {
    fs.rmSync(path.join(ROOT, "mobile", ".bundle-under-test"), { recursive: true, force: true });
  }
}

test("REAL REPO: DEFAULT_OUT is the webDir capacitor.config.json declares", () => {
  /* The two would otherwise drift into "the script writes one directory and
     Capacitor bundles another", which produces an app running last week's code. */
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "mobile", "capacitor.config.json"), "utf8"));
  assert.equal(path.resolve(ROOT, DEFAULT_OUT), path.resolve(ROOT, "mobile", cfg.webDir));
});

test("REAL REPO: REPO_ROOT resolves to the repo, not to tools/mobile", () => {
  assert.ok(fs.existsSync(path.join(REPO_ROOT, "CLAUDE.md")));
  assert.equal(path.resolve(REPO_ROOT), path.resolve(ROOT));
});

/* ───────────────────────── the bounded catalogue slice ──────────────────── */

/* WHAT THESE ARE DEFENDING, in order of how quietly it fails:
 *
 *   a. THE ARTWORK AND CREDIT JOINS. `player/foray-sources.js` maps show -> artwork
 *      (#27's lock screen) and show -> Apple collection id, and reads the first
 *      USABLE item per show in document order — not the first item, a distinction
 *      today's data hides and one test below is entirely about. Every count-based
 *      check here passes if the slice is emitted in recency order instead; the join
 *      checks are the only ones that do not, and the cost of missing it is a car head
 *      unit showing the app icon weeks later with the build green.
 *   b. AN EMPTY SLICE. This whole change makes the bundle SMALLER, so "smaller than
 *      expected" is not a signal any longer. A renamed `items` key has to be a hard
 *      error, or it is a blank home screen that passes every budget.
 *   c. THE BOUND ITSELF. The point of the slice is that it is O(shows x topics) and
 *      not O(episodes). A selection rule that is secretly proportional to the
 *      catalogue would look completely correct today and fail in a month, which is
 *      exactly the failure this change is fixing.
 */

test("the slice keeps every show, and keeps each show's first item in document order", () => {
  const { discover } = makeCatalogue({ shows: 4, episodes: 5 });
  const slice = discoverSlice(discover, { perShow: 2 });
  const shows = new Set(slice.items.map((i) => i.show));
  assert.equal(shows.size, 4, "a show was dropped entirely");
  for (let s = 0; s < 4; s++) {
    /* `s{s}-e0` is the OLDEST episode of each show, so a plain "newest 2" rule drops
       it — and it is the one both joins read. */
    assert.ok(slice.items.some((i) => i.id === `s${s}-e0`), `Show ${s} lost its join anchor`);
  }
  assert.equal(slice.items.length, 4 * 2 + 1, "expected 2 per show plus the topic top-up");
});

test("the slice picks the NEWEST items, not simply the first ones", () => {
  const { discover } = makeCatalogue({ shows: 2, episodes: 5 });
  const slice = discoverSlice(discover, { perShow: 3 });
  const ids = slice.items.map((i) => i.id);
  /* e4 is newest, e3 next, e0 is the anchor. e1 and e2 are the ones to leave behind. */
  for (const id of ["s0-e4", "s0-e3", "s1-e4", "s1-e3"]) {
    assert.ok(ids.includes(id), `${id} is among the newest and should be bundled`);
  }
  assert.ok(!ids.includes("s1-e1"), "s1-e1 is neither newest nor an anchor");
});

test("the slice is emitted in document order, whatever order it selected in", () => {
  /* The property the joins depend on. Not an aesthetic one: see the section header. */
  const { discover } = makeCatalogue({ shows: 3, episodes: 4 });
  const slice = discoverSlice(discover, { perShow: 2 });
  const sourceIndex = new Map(discover.items.map((it, i) => [it.id, i]));
  const positions = slice.items.map((it) => sourceIndex.get(it.id));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), "the slice is not in document order");
});

test("the slice keeps every topic, including one only an unpicked item carries", () => {
  const { discover } = makeCatalogue({ shows: 4, episodes: 5 });
  const slice = discoverSlice(discover, { perShow: 2 });
  const topicsOf = (d) => new Set(d.items.flatMap((i) => i.topics));
  assert.ok(topicsOf(discover).has("branch9/rare"));
  assert.deepEqual(
    [...topicsOf(discover)].filter((t) => !topicsOf(slice).has(t)),
    [],
    "a topic lost every item, so #/subject/<topic> would render empty in the app"
  );
  /* And it was genuinely a top-up, not luck: the carrier is neither the anchor nor
     the newest episode of its show. */
  assert.ok(slice.items.some((i) => i.id === "s0-e3"), "the rare topic's only carrier is missing");
});

test("THE BOUND: adding episodes to existing shows does not grow the slice", () => {
  /* THE WHOLE ARGUMENT, as a test. The nightly refresh adds episodes to shows that
     are already in the catalogue — shows have been flat at 213 since 2026-07-13
     while episodes went 764 -> 1534. If the slice is O(episodes) this fails; if it
     is O(shows x topics) the two byte counts are equal. */
  const small = makeCatalogue({ shows: 5, episodes: 4 }).discover;
  const big = makeCatalogue({ shows: 5, episodes: 40 }).discover;
  assert.equal(big.items.length, small.items.length * 10);
  const a = discoverSlice(small, { perShow: 3 });
  const b = discoverSlice(big, { perShow: 3 });
  assert.equal(b.items.length, a.items.length, "the slice grew with the catalogue");
  /* Byte-for-byte equal except for the item ids and dates the bigger catalogue
     names, so compare the count and the shape rather than the text. */
  assert.equal(new Set(b.items.map((i) => i.show)).size, 5);
  assert.equal(b.bundled_from.items, big.items.length);
  assert.equal(b.bundled_from.kept, b.items.length);
});

test("THE BOUND: a new SHOW does cost items, which is the growth worth hearing about", () => {
  /* The other half. The budget in PROJECTED_DATA is calibrated in these units, so
     this is what the budget is measuring. */
  const four = discoverSlice(makeCatalogue({ shows: 4, episodes: 6 }).discover, { perShow: 3 });
  const five = discoverSlice(makeCatalogue({ shows: 5, episodes: 6 }).discover, { perShow: 3 });
  assert.equal(five.items.length - four.items.length, 3, "a new show should cost perShow items");
});

test("perShow is the only knob, and it holds at 1", () => {
  const { discover } = makeCatalogue({ shows: 4, episodes: 5 });
  const one = discoverSlice(discover, { perShow: 1 });
  assert.equal(new Set(one.items.map((i) => i.show)).size, 4, "every show must survive even at 1");
  assert.equal(assertDiscoverSliceComplete(discover, one), true);
  assert.throws(() => discoverSlice(discover, { perShow: 0 }), WebDirError);
  assert.throws(() => discoverSlice(discover, { perShow: 2.5 }), WebDirError);
});

test("a discover document with no items is a hard error, not an empty catalogue", () => {
  /* THE FAILS-GREEN CASE for the slice. Every equality check in
     assertDiscoverSliceComplete compares the slice against the source, so an empty
     source and an empty slice AGREE. This guard is what stops that being a pass. */
  assert.throws(() => discoverSlice({ version: 1 }), /no non-empty "items" array/);
  assert.throws(() => discoverSlice({ items: [] }), /no non-empty "items" array/);
  assert.throws(() => discoverSlice({ items: {} }), WebDirError);
});

test("REAL REPO: a renamed show field is a hard error, not a 93-item catalogue", () => {
  /* THE SECOND FAILS-GREEN CASE, found by a reviewer probing the first one. `show` is
     the grouping key AND the join key. Rename it and every item lands in one anonymous
     bucket, which gets `perShow` slots — so the bundle ships 93 of 1,534 episodes,
     under its per-file budget, under the 3 MB cap, with no show lost (a document with
     no shows loses none) and both join maps comparing empty against empty.

     Run against the REAL document rather than a fixture, because the number is the
     point: this is what a one-word pipeline rename would have shipped. */
  const source = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "discover.json"), "utf8"));
  const renamed = { ...source, items: source.items.map(({ show, ...rest }) => ({ ...rest, show_name: show })) };
  assert.throws(
    () => discoverSlice(renamed),
    (e) => e instanceof WebDirError && /have no usable "show"/.test(e.message) && /loses no shows/.test(e.message)
  );
  /* A HANDFUL of show-less items must NOT break the build: an unclassifiable episode
     is a data condition, not a pipeline failure, and failing here would stop a nightly
     refresh for it. The guard is proportional for exactly this reason. */
  const few = { ...source, items: source.items.map((it, i) => (i < 20 ? { ...it, show: "" } : it)) };
  assert.equal(assertDiscoverSliceComplete(few, discoverSlice(few)), true);

  /* And the same vacuity in the topic dimension. */
  const untopiced = { ...source, items: source.items.map(({ topics, ...rest }) => rest) };
  assert.throws(
    () => assertDiscoverSliceComplete(untopiced, discoverSlice(untopiced)),
    (e) => e instanceof WebDirError && /trivially true and means nothing/.test(e.message)
  );
});

test("the slice carries every field of every item it keeps, unchanged", () => {
  /* Field trimming was measured and rejected (see the module header): the bundle
     shows FEWER items, never thinner ones. If that ever changes it must be a
     deliberate edit with its own reasoning, not a drift. */
  const { discover } = makeCatalogue({ shows: 3, episodes: 4 });
  const byId = new Map(discover.items.map((i) => [i.id, i]));
  for (const item of discoverSlice(discover, { perShow: 2 }).items) {
    assert.deepEqual(item, byId.get(item.id), `${item.id} was rewritten on the way into the bundle`);
  }
});

test("the slice preserves top-level keys it has never heard of", () => {
  const { discover } = makeCatalogue({ shows: 2, episodes: 3 });
  const slice = discoverSlice({ ...discover, generated_by: "tools/refresh/merge.mjs" }, { perShow: 1 });
  assert.equal(slice.generated_by, "tools/refresh/merge.mjs");
  assert.equal(slice.version, 1);
  /* And it says what it is, because 622 of 1534 items and a broken pool look the
     same on a device otherwise. */
  assert.deepEqual(slice.bundled_from, { items: 6, per_show: 1, kept: 3 });
});

test("assertDiscoverSliceComplete is a real guard and not decoration", () => {
  /* The anti-`if (false)` test, in the four directions that matter. Written directly
     against the assertion rather than through `prepare`, for the reason
     assertShellScriptsPresent's own test gives. */
  const { discover } = makeCatalogue({ shows: 4, episodes: 5 });
  const good = discoverSlice(discover, { perShow: 2 });
  assert.equal(assertDiscoverSliceComplete(discover, good), true);

  /* 1. a lost show */
  assert.throws(
    () => assertDiscoverSliceComplete(discover, { items: good.items.filter((i) => i.show !== "Show 2") }),
    (e) => e instanceof WebDirError && /dropped 1 show/.test(e.message) && /lock screen/.test(e.message)
  );
  /* 2. a lost topic */
  assert.throws(
    () => assertDiscoverSliceComplete(discover, { items: good.items.filter((i) => i.id !== "s0-e3") }),
    (e) => e instanceof WebDirError && /topic\(s\) with no items/.test(e.message)
  );
  /* 3. AN ORDER CHANGE ONLY — every show present, every topic present, same items,
        same byte count. This is the mutation the counting checks cannot see. */
  const reordered = { ...good, items: [...good.items].reverse() };
  assert.equal(new Set(reordered.items.map((i) => i.show)).size, 4);
  assert.throws(
    () => assertDiscoverSliceComplete(discover, reordered),
    (e) => e instanceof WebDirError && /artworkUrlsByShow/.test(e.message)
  );
  /* 4. THE COLLECTION-ID JOIN ON ITS OWN. Deleting only this check survived a first
        mutation run: every case above trips the ARTWORK check first, which throws, so
        the credit-link check was never reached by any test. So this slice keeps the
        artwork maps identical and moves only the collection id — which is the real
        shape of the failure too, since an id and an artwork URL come from different
        halves of the refresh pipeline. */
  const cidOnly = {
    ...good,
    items: good.items.map((it, i) => (i === 0 ? { ...it, apple_collection_id: 999999 } : it)),
  };
  assert.deepEqual([...artworkUrlsByShow(cidOnly)], [...artworkUrlsByShow(discover)]);
  assert.throws(
    () => assertDiscoverSliceComplete(discover, cidOnly),
    (e) => e instanceof WebDirError && /collectionIdsByShow/.test(e.message) && /Apple search link/.test(e.message)
  );
  /* 5. and an empty slice, which is the shape a broken projection produces */
  assert.throws(() => assertDiscoverSliceComplete(discover, { items: [] }), WebDirError);
  /* 6. A SLICE LARGER THAN ITS SOURCE. Every check above asks "did the slice lose
        anything", which an entirely unsliced document passes — so the guard is
        one-directional without this, and a first mutation run proved it by deleting
        the bound and staying green. */
  assert.throws(
    () => assertDiscoverSliceComplete({ items: discover.items.slice(0, 2) }, good),
    (e) => e instanceof WebDirError && /cannot be larger than what it is a slice of/.test(e.message)
  );
  /* Equal sizes stay legal: a document small enough that the slice is the whole thing
     is what every fixture here looks like, and shell-invariants asserts the REAL
     document actually shrinks. */
  assert.equal(assertDiscoverSliceComplete(good, good), true);
});

test("the anchor is the item the JOIN reads, not simply the first one", () => {
  /* FOUND BY ASKING WHETHER "keep each show's first item" WAS ACTUALLY SUFFICIENT,
     and it was not. Both joins SKIP an item with no artwork (or no valid collection
     id) and take the next one that has some, so the item they read is the first
     USABLE one. Today every one of the catalogue's 1,534 items carries both, so the
     two rules agree and the bug is invisible — it would have appeared as the nightly
     build failing, blaming the slice, on the day one artwork-less episode arrived.

     Note what the wrong rule does here: it does not lose the show, or the topic, or
     go over budget. It silently attaches episode c's artwork to a show the website
     shows episode b's for. */
  const doc = {
    version: 1,
    items: [
      { id: "a", show: "S", artwork_url: "", apple_collection_id: null, release_date: "2026-01-01", topics: ["t/x"] },
      { id: "b", show: "S", artwork_url: "https://art/1.png", apple_collection_id: 11, release_date: "2026-01-02", topics: ["t/x"] },
      { id: "c", show: "S", artwork_url: "https://art/2.png", apple_collection_id: 22, release_date: "2026-01-03", topics: ["t/x"] },
    ],
  };
  assert.equal(artworkUrlsByShow(doc).get("S"), "https://art/1.png");

  const slice = discoverSlice(doc, { perShow: 2 });
  assert.equal(assertDiscoverSliceComplete(doc, slice), true);
  assert.equal(artworkUrlsByShow(slice).get("S"), "https://art/1.png");
  assert.equal(collectionIdsByShow(slice).get("S"), 11);
  assert.ok(slice.items.some((i) => i.id === "b"), "the item both joins read was dropped");

  /* A show with NO usable artwork anywhere contributes no entry to the map, so the
     anchor must not go hunting through the whole show for one. */
  const none = {
    items: [
      { id: "p", show: "T", artwork_url: "", apple_collection_id: null, release_date: "2026-01-01", topics: ["t/y"] },
      { id: "q", show: "T", artwork_url: "", apple_collection_id: null, release_date: "2026-01-02", topics: ["t/y"] },
      { id: "r", show: "T", artwork_url: "", apple_collection_id: null, release_date: "2026-01-03", topics: ["t/y"] },
    ],
  };
  const thin = discoverSlice(none, { perShow: 1 });
  assert.equal(artworkUrlsByShow(none).size, 0);
  assert.equal(thin.items.length, 1, "an unjoinable show should still cost one item, not three");
  assert.equal(assertDiscoverSliceComplete(none, thin), true);
});

test("the artwork the app would show is the artwork the website shows", () => {
  /* Asserted through the REAL production functions rather than by re-deriving the
     rule here, which is why they are imported into prepare-webdir.mjs at all. A
     second copy of the join would agree with itself while the app disagreed. */
  const { discover } = makeCatalogue({ shows: 4, episodes: 5 });
  const slice = discoverSlice(discover, { perShow: 2 });
  assert.deepEqual([...artworkUrlsByShow(slice)], [...artworkUrlsByShow(discover)]);
  assert.deepEqual([...collectionIdsByShow(slice)], [...collectionIdsByShow(discover)]);
  /* The fixture has to be able to tell the difference, or this proves nothing. */
  const wrong = { items: [...discover.items].reverse() };
  assert.notDeepEqual([...artworkUrlsByShow(wrong)], [...artworkUrlsByShow(discover)]);
});

test("data/item-tags.json is COPIED WHOLE, and the bundle proves it byte for byte", () => {
  /* THE FINDING THAT REVERTED HALF OF THIS CHANGE, kept as a test so nobody has to
     rediscover it. Trimming item-tags.json to the bundled pool takes it from 295 KB
     to 121 KB and looks obviously safe: search only ever looks a tag list up by an
     item it is already scoring.

     But `search-engine.js`'s `tagDF()` walks Object.values() of the WHOLE map, so
     cutting 1,561 entries to 649 changes what every threshold in the query
     interpreter sees. It used to change it by ARITHMETIC: `tagDF` returned an
     absolute count against absolute thresholds (over 60 deleted a term from query
     expansion, over 25 cut its weight to 0.4x, and `scoreMatch` bucketed a
     multiplier at 10 and 30), so the trim scaled every df by ~0.42 and 66 of the
     1,366 terms changed expansion bucket — `war` 72 -> 24, deleted as too broad on
     the website and at full weight in the app.
     #275 fixed that half: `tagDF` is a fraction of the map it walked, so a trim
     scales numerator and denominator together. What survives is SAMPLING — the slice
     is three items per show, stratified by show and skewed by topic — and it is
     still 12 expansion buckets and 62 multipliers. The app would rank differently
     from the website, on a phone, with every guard in prepare-webdir.mjs green. The
     test below measures both numbers so the refusal cannot rot into a quotation.

     So it is copied, and the copy is asserted on the bytes. THE MUTATION THIS KILLS
     is somebody adding it back to PROJECTED_DATA — which is a reasonable-looking
     174 KB saving. */
  const fake = makeFakeRepo({ catalogue: makeCatalogue({ shows: 4, episodes: 6 }) });
  prepare({ root: fake, out: "www", perShow: 2 });
  for (const rel of COPIED_WHOLE) {
    assert.deepEqual(
      fs.readFileSync(path.join(fake, "www", rel)),
      fs.readFileSync(path.join(fake, rel)),
      `${rel} is not byte-identical in the bundle`
    );
  }
  assert.ok(COPIED_WHOLE.includes("data/item-tags.json"));
  /* And it is not in PROJECTED_DATA, which is the list that would trim it. */
  assert.equal(PROJECTED_DATA.some((sp) => COPIED_WHOLE.includes(sp.rel)), false);

  /* THE GUARD ITSELF, REACHED. A first mutation run deleted the COPIED_WHOLE loop
     inside `assertSlicesOnDisk` and this test stayed green, because everything above
     reads the two files directly — it proves `prepare` copies, not that anything
     would NOTICE if it stopped. So corrupt the bundled copy and demand the throw. */
  const bundled = path.join(fake, "www", "data", "item-tags.json");
  const whole = JSON.parse(fs.readFileSync(bundled, "utf8"));
  delete whole.tags[Object.keys(whole.tags)[0]];
  fs.writeFileSync(bundled, serializeSlice(whole));
  assert.throws(
    () => assertSlicesOnDisk(path.join(fake, "www"), fake),
    (e) => /not byte-identical to the source/.test(e.message) && /tagDF/.test(e.message)
  );
});

test("REAL REPO: trimming item-tags STILL re-ranks the app, on sampling now rather than arithmetic (#275)", () => {
  /* The measurement behind the test above, executed rather than quoted, so the
     refusal cannot quietly stop being true. #275 landed and this test changed
     shape — which is what it was written to do — but the refusal survived, and the
     reason is worth having in one place because the obvious reading of #275 is
     that it made the trim free.

     WHAT #275 FIXED. `tagDF` was an absolute count against absolute thresholds, so
     trimming 1,561 entries to 649 divided every df by ~2.4 and 66 terms changed
     expansion bucket on that arithmetic alone — `war` 72 → 24, deleted from the
     expansion on the web and at full weight on the phone. `tagDF` is now a fraction
     of the map it walked, so a trim scales numerator and denominator together and
     that whole class of divergence is gone. `war` is 4.61% of the whole map and
     3.70% of the trimmed one: same bucket, no divergence at all.

     WHAT IS LEFT, AND WHY IT IS STILL A NO. The bundled slice is not a
     representative sample of the catalogue — it is three items per show plus every
     session episode, so it is stratified by SHOW and therefore skewed by TOPIC.
     Measured: 12 terms still change expansion bucket and 62 change score
     multiplier, because their share of the slice genuinely differs from their share
     of the catalogue. `comedy` is 10.70% of the whole map and 8.47% of the slice, so
     the website deletes it from expansions as too broad and the app would keep it at
     0.4x; `world-war` is 2.95% and 1.69%, demoted on the web and full weight on the
     phone. That is a smaller and better-understood divergence than the one #274
     found — sampling rather than arithmetic, 12 terms rather than 66 — but it is the
     same failure in kind, and ~181 KB does not buy it.

     WHAT WOULD BUY IT, named so the next attempt starts here rather than at the
     beginning: ship the trimmed map PLUS a precomputed df table (term → count, and
     the map size), which is the second option #275 itself lists and is now the
     cheap one — the fraction is already the quantity search reads, so the sidecar
     is ~1,400 numbers and the app and the website would agree EXACTLY rather than
     approximately. That recovers most of the ~181 KB and is a bundle change, not a
     search-quality one.

     THIS TEST GOES RED THE DAY THE TRIM BECOMES SAFE, deliberately, exactly as its
     previous version did. `moved > 0` is the refusal; the ratio assertion under it
     is the part that fails if somebody reverts `tagDF` to a count, because then
     the two rules agree again and the improvement disappears. */
  const require_ = createRequire(import.meta.url);
  const SE = require_(path.join(ROOT, "search-engine.js"));
  const read = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));
  const itemTags = read("data/item-tags.json");
  const session = read("data/session.json");
  const slice = discoverSlice(read("data/discover.json"));

  const pool = new Set([...Object.keys(session.episodes ?? {}), ...slice.items.map((i) => i.id)]);
  const trimmed = { tags: {} };
  for (const [id, tags] of Object.entries(itemTags.tags)) if (pool.has(id)) trimmed.tags[id] = tags;
  assert.ok(Object.keys(trimmed.tags).length < Object.keys(itemTags.tags).length * 0.6);

  /* The vocabulary tagDF can be called with: concept terms plus ALIASES, since a
     typed token reaches tagDF as itself and an alias is added as a term. */
  const terms = new Set();
  for (const c of Object.values(read("data/semantic-index.json").concepts ?? {})) {
    for (const t of c.terms ?? []) terms.add(t);
  }
  for (const [k, vs] of Object.entries(SE.ALIASES)) { terms.add(k); vs.forEach((v) => terms.add(v)); }

  const whole = { itemTags }, part = { itemTags: trimmed };
  /* READ FROM THE ENGINE, not mirrored, and the first version of this line only got
     halfway there. It was an inline `df > 60 ? "delete" : df > 25 ? ...`, which #275
     would have left comparing a fraction against 60 — every term "full", zero moved,
     and the assertion below would have gone red claiming the trim was safe when
     nothing of the kind had been measured. Reading the CONSTANTS from the engine and
     rewriting the COMPARISON fixed the values and kept the copy; review caught that,
     so the RULE comes from the engine now too. */
  const bucket = (df) => SE.expansionBucket(df);
  const moved = [...terms].filter((t) => bucket(SE.tagDF(t, whole)) !== bucket(SE.tagDF(t, part)));
  const movedMultiplier = [...terms].filter(
    (t) => SE.dfMultiplier(SE.tagDF(t, whole)) !== SE.dfMultiplier(SE.tagDF(t, part))
  );
  /* The pre-#275 rule, on the same two maps. This is the only place in
     tools/mobile/ that still knows what it was, and it is here to be beaten. */
  const absolute = (n) => (n > 60 ? "delete" : n > 25 ? "0.4x" : "full");
  const movedAbsolute = [...terms].filter((t) => absolute(SE.tagCount(t, whole)) !== absolute(SE.tagCount(t, part)));

  /* THE MARGIN IS THIN, AND THE INSTRUCTION IS DELIBERATELY NOT "DELETE THIS TEST".
     12 of 1,366 is a sampling residue on a slice the nightly rebuilds, so one refresh
     could take it to 0 without anybody having decided anything. The version this
     replaced had 20-against-66 of headroom; this one has 12 against zero. So the
     failure message has to be honest about what a red run means here: evidence, not a
     verdict, and ~181 KB is not worth acting on one night's data. */
  assert.ok(
    moved.length > 0,
    `no term changes expansion bucket on the trim (multipliers: ${movedMultiplier.length}) — the ` +
      `divergence COPIED_WHOLE refuses may have gone, which would make trimming ` +
      `data/item-tags.json correct and worth ~181 KB. DO NOT act on one run: this is a ` +
      `sampling residue of 12 terms on a slice the nightly rebuilds, so re-measure across ` +
      `several refreshes, and prefer the precomputed-df-table follow-up named above — it ` +
      `makes the app and the website agree exactly rather than approximately. See COPIED_WHOLE.`
  );
  assert.ok(
    moved.length * 2 < movedAbsolute.length,
    `the trim moves ${moved.length} expansion buckets against ${movedAbsolute.length} under the pre-#275 ` +
      `absolute rule — normalising tagDF was supposed to remove the arithmetic half of this divergence ` +
      `(measured 12 against 66), so if the two are now within 2x, tagDF is probably reading a count again`
  );
  /* #274's headline example, named because it is the one the docs quote: the term
     whose 72 → 24 made the app and the website disagree is no longer a divergence
     at all. Asserted rather than narrated, so the claim cannot rot. */
  assert.equal(bucket(SE.tagDF("war", whole)), bucket(SE.tagDF("war", part)));
  assert.notEqual(absolute(SE.tagCount("war", whole)), absolute(SE.tagCount("war", part)));
  /* And the multipliers, which are the larger half of what is left. Reported in the
     message rather than bounded, because the honest claim is "still nonzero". */
  assert.ok(movedMultiplier.length > 0, `no term changes score multiplier either (${movedMultiplier.length}) — see above, the trim may be safe`);
});

test("prepare WRITES the slice rather than copying the file", () => {
  /* THE MUTATION THIS KILLS: reverting the sliced branch in `prepare` to a plain
     copyFileSync. Everything else stays green — the file is present, the bundle is
     valid, the cap passes — and the bundle silently goes back to being O(episodes). */
  const fake = makeFakeRepo({ catalogue: makeCatalogue({ shows: 4, episodes: 8 }) });
  prepare({ root: fake, out: "www", perShow: 2 });
  const read = (rel) => JSON.parse(fs.readFileSync(path.join(fake, "www", rel), "utf8"));
  const source = (rel) => JSON.parse(fs.readFileSync(path.join(fake, rel), "utf8"));

  const bundled = read("data/discover.json");
  assert.equal(source("data/discover.json").items.length, 32);
  assert.equal(bundled.items.length, 9, "the bundled discover.json is not a slice");
  assert.ok(
    fs.statSync(path.join(fake, "www", "data", "discover.json")).size <
      fs.statSync(path.join(fake, "data", "discover.json")).size,
    "the bundled discover.json is not smaller than the source"
  );
  assert.equal(assertDiscoverSliceComplete(source("data/discover.json"), bundled), true);

  /* Every bundled item can still be searched with its own tags, and so can every
     item that is NOT bundled — the tag map is copied whole on purpose. */
  const tags = read("data/item-tags.json");
  for (const item of source("data/discover.json").items) {
    assert.ok(item.id in tags.tags, `${item.id} lost its tags`);
  }

  /* The COPIED files are untouched — this slices one file, it does not rewrite the
     data directory. */
  assert.equal(
    fs.readFileSync(path.join(fake, "www", "data", "taxonomy.json"), "utf8"),
    fs.readFileSync(path.join(fake, "data", "taxonomy.json"), "utf8")
  );
  /* And the SOURCE is untouched, the same property the index.html injection has. */
  assert.equal(source("data/discover.json").items.length, 32);
});

test("a per-file budget failure is loud, names the knob, and is not the 3 MB cap", () => {
  /* THE MUTATION THIS KILLS: deleting the `assertSlicesOnDisk` call from `prepare`.
     The budget is enforced nowhere else, so with the call gone this is the only
     failing test — and it fails for the right reason, on the bytes on disk.

     The fixture is 300 shows of padded items, which is a slice over the 800 KB
     budget while the whole bundle stays far under 3 MB. That separation is the
     point: the two numbers answer different questions. */
  const fake = makeFakeRepo({ catalogue: makeCatalogue({ shows: 300, episodes: 4, hookBytes: 800 }) });
  assert.throws(
    () => prepare({ root: fake, out: "www", perShow: 3 }),
    (e) =>
      /data\/discover\.json is [\d.]+ KB, over its 800\.0 KB budget/.test(e.message) &&
      /BUNDLED_ITEMS_PER_SHOW/.test(e.message) &&
      /not the 3 MB bundle cap/.test(e.message)
  );
  /* Lowering the knob is the documented fix, and it works. */
  const r = prepare({ root: fake, out: "www", perShow: 1 });
  assert.ok(r.total < MAX_BYTES);
});

test("a slice that throws leaves the last good bundle on disk", () => {
  /* `prepare` deletes its output before writing. If the projection ran after that,
     a renamed `items` key would leave an EMPTY www/ behind — which `cap sync` would
     package without complaint. So the slices are built first. */
  const fake = makeFakeRepo();
  prepare({ root: fake, out: "www" });
  const before = fs.readFileSync(path.join(fake, "www", "data", "discover.json"), "utf8");
  fs.writeFileSync(path.join(fake, "data", "discover.json"), JSON.stringify({ version: 1, entries: [] }));
  assert.throws(() => prepare({ root: fake, out: "www" }), /no non-empty "items" array/);
  assert.equal(fs.readFileSync(path.join(fake, "www", "data", "discover.json"), "utf8"), before);
});

test("a sliced file that app.js no longer fetches is a hard error, not a dead rule", () => {
  /* A slicing rule for a file nobody loads has silently stopped being tested. The
     reverse of MIN_DERIVED_DATA_FILES: that guards the plan against losing files,
     this guards the projections against outliving them. */
  const fake = makeFakeRepo();
  const appSrc = fs.readFileSync(path.join(fake, "app.js"), "utf8");
  fs.writeFileSync(path.join(fake, "app.js"), appSrc.replace('await fetchJson("data/discover.json");\n', ""));
  assert.throws(
    () => prepare({ root: fake, out: "www" }),
    (e) => /PROJECTED_DATA describes data\/discover\.json/.test(e.message) && /delete the entry deliberately/.test(e.message)
  );
});

test("every PROJECTED_DATA entry carries a projection, a verification and a budget", () => {
  /* A spec with no `verify` would slice silently, and a spec with no `maxBytes` would
     have `undefined` compared against with `>`, which is false — a budget that can
     never fail. Both are one careless entry away the next time this list grows. */
  assert.deepEqual(PROJECTED_DATA.map((p) => p.rel), [
    "data/discover.json", "data/segments.json", "data/segment-sources.json",
  ]);
  /* ORDER-INDEPENDENCE, ASSERTED RATHER THAN ORDER. The first draft of this test
     pinned segments-before-sources and said the second is derived from the first —
     which is NOT what the code does: `segmentSourceSlice` recomputes the segment
     slice from the SOURCE documents, precisely so the two entries do not depend on
     the order they are listed in, and verification is a separate second pass anyway.
     A pin with a false reason is worse than no pin, because the next reader fixes
     the wrong side of it. So this asserts the property that is actually true.

     AND THE FIRST VERSION OF *THAT* WAS DECORATION TOO, which a reviewer proved by
     making a projection genuinely order-dependent and watching all 65 tests pass.
     It re-projected each spec into a LOCAL loop, which is not the loop `projectData`
     runs, so no amount of order-dependence inside the real one could reach it. The
     only honest way to test "the order does not matter" is to REORDER THE ARRAY
     `projectData` ITERATES and run the real thing, which is what this now does.

     AND IT CANNOT FAIL TODAY — said out loud rather than left for the next person to
     discover, per CLAUDE.md § "A green test is not evidence", point 5. `projectData`
     hands `project` only `{ perShow, source }`, and `source` reads off disk, so a
     projection has no channel through which to see what was projected before it:
     order-independence is currently structural, not earned. Three mutations were run
     against this test and all three survived, for that reason.

     WHAT WOULD MAKE IT FAIL, so the guard has a named job: handing `bundled` to
     `project` as well as to `verify` — "for symmetry" — and then using it, because
     `bundled` resolves to the already-built slice or falls back to the source
     document depending on what has run. That is a two-line change, both lines of
     which look like tidying, and it would make the bundle depend on the order of a
     literal array. This is the test that would notice. */
  const fakeRepo = makeFakeRepo();
  const asListed = projectData(fakeRepo);
  const listedOrder = PROJECTED_DATA.map((p) => p.rel);
  let asReversed;
  try {
    /* Mutating an exported array is not something to do casually — it is done here
       because the property under test is a property OF that array's order, and a
       copy cannot express it. Restored in `finally` so a failing assertion cannot
       leave the module reversed for every test that runs after this one. */
    PROJECTED_DATA.reverse();
    asReversed = projectData(fakeRepo);
  } finally {
    PROJECTED_DATA.reverse();
  }
  assert.deepEqual(PROJECTED_DATA.map((p) => p.rel), listedOrder, "PROJECTED_DATA was left reversed");
  /* The reversal really happened, or this compares a run against itself. */
  assert.notDeepEqual([...listedOrder].reverse(), listedOrder, "PROJECTED_DATA is a palindrome; reversing proves nothing");
  for (const spec of PROJECTED_DATA) {
    assert.equal(
      serializeSlice(asReversed.get(spec.rel)),
      serializeSlice(asListed.get(spec.rel)),
      `${spec.rel} projects differently depending on where it sits in PROJECTED_DATA`
    );
  }
  for (const spec of PROJECTED_DATA) {
    assert.equal(typeof spec.project, "function", `${spec.rel} has no projection`);
    assert.equal(typeof spec.verify, "function", `${spec.rel} has no verification`);
    assert.equal(typeof spec.maxBytes, "number", `${spec.rel} has no budget`);
    assert.ok(spec.maxBytes > 0, `${spec.rel}'s budget is not a positive number of bytes`);
    /* And it says what a breach MEANS. The three budgets are breached for three
       unrelated reasons — catalogue growth, authored Forays, wider Forays — and a
       message that gives discover.json's advice for a segment overrun sends the next
       reader to lower BUNDLED_ITEMS_PER_SHOW, which would not move that file by a
       byte. */
    assert.equal(typeof spec.whenBreached, "string", `${spec.rel} does not say what a breach means`);
    assert.ok(spec.whenBreached.length > 60, `${spec.rel}'s breach note is too short to be advice`);
  }
  /* Same rule for the list that refuses to slice: a file copied whole with no reason
     attached is exactly the state somebody optimises away. Asserted as identical key
     sets rather than defended with a `??` fallback, which would be a branch that can
     never fire. */
  assert.deepEqual([...COPIED_WHOLE].sort(), Object.keys(WHY_COPIED_WHOLE).sort());
  for (const rel of COPIED_WHOLE) {
    assert.ok(WHY_COPIED_WHOLE[rel].length > 60, `${rel} is copied whole with no reason given`);
  }
  const fake = makeFakeRepo();
  assert.equal(projectData(fake).size, PROJECTED_DATA.length);
});

test("the reported slice size is the size on disk, not a UTF-16 character count", () => {
  /* `--list` prints a size and the build enforces one. They came from
     `String.length` and `fs.statSync().size` respectively — UTF-16 code units against
     UTF-8 bytes — which differed by 130 bytes on today's catalogue and grows with
     every non-ASCII episode title. A dry run could report "under budget" for a build
     that then failed it. */
  const doc = { version: 1, items: [{ id: "a", show: "S", title: "Café — naïve 日本", topics: [] }] };
  assert.ok(sliceBytes(doc) > serializeSlice(doc).length, "the fixture has no multi-byte characters");

  const fake = makeFakeRepo();
  const r = prepare({ root: fake, out: "www" });
  for (const spec of PROJECTED_DATA) {
    const onDisk = r.files.find((f) => f.rel === spec.rel).bytes;
    assert.equal(onDisk, sliceBytes(projectData(fake).get(spec.rel)), `${spec.rel} is mis-measured`);
  }
});

/* ───────────────────────── the Foray segment slice (#327) ───────────────── */

/** The three fixture documents, and the pair-shaped arguments the assertion takes. */
function forayFixture() {
  const { forays, segments, sources } = makeForayDocs();
  const full = { segments, sources };
  const sliced = {
    segments: segmentSlice(segments, forays),
    sources: segmentSourceSlice(sources, segments, forays),
  };
  return { forays, segments, sources, full, sliced };
}

/** Hydrate every Foray in `doc` against a pair of documents, through the REAL
 *  resolver — the same three lines `assertForaySliceComplete` runs, written out here
 *  so the tests can assert on the join directly rather than only through the guard
 *  they are trying to prove. */
function hydrateAll(foraysDoc, { segments, sources }) {
  const s = indexSegments(segments);
  const r = indexSources(sources);
  return foraysDoc.forays.map((f) => hydrateForayItems(f, { segments: s, sources: r }));
}

test("the slice keeps exactly the segments the bundled Forays reference", () => {
  const { forays, segments, sliced } = forayFixture();
  const ids = referencedSegmentIds(forays);
  /* Six ids across two Forays; the narration bridge contributes none. */
  assert.deepEqual([...ids].sort(), ["a#100", "b#200", "c#300", "d#400", "dup#7", "orphan#1"]);

  /* The pool really is bigger than the slice, or nothing below means anything. */
  assert.equal(segments.segments.length, 10);
  assert.equal(sliced.segments.segments.length, 7);
  for (const id of ids) {
    assert.ok(sliced.segments.segments.some((s) => s.id === id), `${id} is referenced and was dropped`);
  }
  /* And NOTHING else — the whole point of #327 is the ~160 KB that was neither
     referenced nor reachable. */
  for (const s of sliced.segments.segments) assert.ok(ids.has(s.id), `${s.id} is in the slice and nothing references it`);
  assert.equal(sliced.segments.segments.some((s) => s.id.startsWith("x#") || s.id.startsWith("y#")), false);

  /* `bundled_from`, so a device with 7 of 10 is distinguishable from a broken one. */
  assert.deepEqual(sliced.segments.bundled_from, { segments: 10, referenced: 6, kept: 7 });
  /* Top-level keys the projection has never heard of survive, same as discoverSlice. */
  assert.equal(sliced.segments.version, 1);
  assert.equal(sliced.segments.built_at, "2026-01-01T00:00:00.000Z");
  assert.equal(sliced.segments.notes, segments.notes);
  assert.deepEqual(sliced.segments.provenance, segments.provenance);
});

test("the slice keeps a DRAFT Foray's segments, because a draft is reachable by id", () => {
  /* THE MUTATION THIS KILLS: `allForays` -> `listableForays` in
     `referencedSegmentIds`. It looks like a tightening — why ship an unpublished
     Foray's segments? — and `forayVisibility` makes a draft visible to anyone who
     asks for it by id, which is how the founder tests one before publishing
     (HUMAN-ACTIONS.md #2). The result would be a Foray that opens in the app and
     resolves to an empty running order, with every count and budget green.
     ALL THREE REAL Forays are drafts today, so the published-only rule references
     ZERO segments and `segmentSlice`'s own guard fires instead — which is the guard
     working, not this test being unnecessary: the day one Foray is published, that
     guard goes quiet and this is the only thing left watching. */
  const { forays, sliced } = forayFixture();
  const draft = forays.forays.find((f) => f.status === "draft");
  assert.ok(draft, "the fixture has no draft Foray, so this test cannot fail");
  for (const item of draft.items) {
    assert.ok(
      sliced.segments.segments.some((s) => s.id === item.segment_id),
      `${item.segment_id} belongs to a draft Foray and was sliced away`
    );
  }
  /* And those ids are referenced by NOTHING ELSE, or the published half would carry
     them anyway and the mutation would survive. */
  const published = forays.forays.filter((f) => f.status === "published");
  const publishedIds = referencedSegmentIds({ forays: published });
  assert.equal(publishedIds.has("d#400"), false);
  assert.equal(publishedIds.has("c#300"), false);
});

test("the slice keeps BOTH rows of a duplicated id, because the join reads the last one", () => {
  /* THE SEGMENT-SHAPED VERSION OF #274'S "keep each show's first item is WRONG", and
     it CANNOT FAIL ON TODAY'S DATA: the real pool has no duplicate ids. Written
     deliberately anyway (CLAUDE.md § "A green test is not evidence", point 5) —
     `indexSegments` is `Map.set` over the document in order, so the LAST row sharing
     an id wins, and the day a re-extraction reuses one, a "first match" slice hands
     the app a segment with different timestamps out of a different episode. Same id,
     same count, same bytes, wrong ninety seconds. */
  const { forays, segments, sources, full, sliced } = forayFixture();
  assert.equal(segments.segments.filter((s) => s.id === "dup#7").length, 2, "the fixture lost its duplicate");
  /* The two rows really differ, or keeping either would be the same thing. */
  assert.equal(indexSegments(segments).get("dup#7").item_id, "ep-c");
  assert.equal(indexSegments(segments).get("dup#7").start_sec, 900);

  assert.equal(sliced.segments.segments.filter((s) => s.id === "dup#7").length, 2);
  assert.equal(indexSegments(sliced.segments).get("dup#7").start_sec, 900);

  /* THE WRONG RULE, run: keep the first row matching each referenced id. It passes
     every count — the id is present, the source is present, the slice is smaller —
     and only the re-run join can tell. */
  const firstMatch = {
    ...sliced.segments,
    segments: sliced.segments.segments.filter((s, i, all) => all.findIndex((o) => o.id === s.id) === i),
  };
  assert.equal(new Set(firstMatch.segments.map((s) => s.id)).size, new Set(sliced.segments.segments.map((s) => s.id)).size);
  assert.throws(
    () => assertForaySliceComplete(forays, full, { segments: firstMatch, sources: sliced.sources }),
    (e) => e instanceof WebDirError && /hydrates differently/.test(e.message) && /LAST row sharing an id/.test(e.message)
  );
  /* And the honest slice does not throw. */
  assert.equal(assertForaySliceComplete(forays, full, sliced), true);
  assert.ok(sources.sources.length > sliced.sources.sources.length);
});

test("a narration bridge references no segment and survives the slice untouched", () => {
  /* `referencedSegmentIds` discriminates on `type` the way `hydrateForayItems` does.
     A bridge carries no `segment_id`, so a rule that scanned for the FIELD rather
     than the TYPE would still work today — and would start pulling segments into the
     bundle the moment a bridge grew a reference field for any other reason. */
  const { forays, full, sliced } = forayFixture();
  const before = hydrateAll(forays, full);
  const after = hydrateAll(forays, sliced);
  const bridges = before[0].items.filter((i) => i.type === "narration");
  assert.equal(bridges.length, 1, "the fixture has no narration bridge");
  assert.deepEqual(after[0].items.filter((i) => i.type === "narration"), bridges);
});

test("the segment-source slice keeps every episode a kept segment plays out of", () => {
  const { sources, sliced } = forayFixture();
  const kept = sliced.sources.sources.map((s) => s.id).sort();
  assert.deepEqual(kept, ["ep-a", "ep-b", "ep-c"]);
  /* De-duplicated, not counted: `ep-a` carries three of the kept segments. */
  assert.equal(sliced.sources.sources.filter((s) => s.id === "ep-a").length, 1);
  /* The registry rows nothing needs are gone — the other half of #327's dead weight. */
  assert.equal(sources.sources.length, 5);
  assert.deepEqual(sliced.sources.bundled_from, { sources: 5, referenced: 4, kept: 3 });
  /* Unknown top-level keys survive on THIS side too. Asserted separately because the
     two projections are separate functions: the first draft checked only the segment
     document, so dropping `notes` in `segmentSourceSlice` alone would have passed. */
  assert.equal(sliced.sources.notes, sources.notes);
  assert.deepEqual(sliced.sources.provenance, sources.provenance);
  /* `referenced` is 4 and `kept` is 3 because `orphan#1` plays out of `ep-gone`,
     which no registry has. That is a data defect tools/foray/check-forays.mjs owns,
     and the slice must be legible about it rather than fail the mobile build. */
});

test("assertForaySliceComplete is a real guard and not decoration", () => {
  /* The anti-`if (false)` test, in every direction the assertion claims to cover.
     Written directly against the assertion rather than through `prepare`, for the
     reason assertShellScriptsPresent's own test gives. */
  const { forays, segments, sources, full, sliced } = forayFixture();
  assert.equal(assertForaySliceComplete(forays, full, sliced), true);

  /* 1. A REFERENCED SEGMENT REMOVED FROM THE SLICE — the headline failure #327 asks
        to see, and the reason this function exists. */
  assert.throws(
    () =>
      assertForaySliceComplete(forays, full, {
        ...sliced,
        segments: { ...sliced.segments, segments: sliced.segments.segments.filter((s) => s.id !== "b#200") },
      }),
    (e) => e instanceof WebDirError && /dropped 1 segment\(s\)/.test(e.message) && /"b#200"/.test(e.message)
  );

  /* 2. A REGISTRY ROW REMOVED — the second hop, checked on its own so a lost episode
        does not have to be inferred from a resolver diff. */
  assert.throws(
    () =>
      assertForaySliceComplete(forays, full, {
        ...sliced,
        sources: { ...sliced.sources, sources: sliced.sources.sources.filter((s) => s.id !== "ep-b") },
      }),
    (e) => e instanceof WebDirError && /dropped 1 episode\(s\)/.test(e.message) && /"ep-b"/.test(e.message)
  );

  /* 3. THE JOIN RE-RUN, ON ITS OWN — covered by the duplicate-id test above, which is
        the only mutation that reaches it: it keeps every referenced id and every
        needed episode and still resolves to a different Foray. Named here so the
        mechanism is not left implicit (CLAUDE.md § "A green test is not evidence",
        point 4). */

  /* 4. A SLICE LARGER THAN ITS SOURCE. Every check above asks "did the slice lose
        anything", which an entirely unsliced document passes — so the guard is
        one-directional without this. */
  assert.throws(
    () =>
      assertForaySliceComplete(
        forays,
        { segments: { ...segments, segments: segments.segments.slice(0, 2) }, sources },
        sliced
      ),
    (e) => e instanceof WebDirError && /cannot be larger than what it is a slice of/.test(e.message)
  );
  assert.throws(
    () =>
      assertForaySliceComplete(forays, { segments, sources: { ...sources, sources: sources.sources.slice(0, 1) } }, sliced),
    (e) => e instanceof WebDirError && /cannot be larger than what it is a slice of/.test(e.message)
  );

  /* 5. NO FORAYS AT ALL — "every referenced segment survived" is trivially true of
        nothing, and the bundle would ship an empty pool on the strength of it. */
  assert.throws(
    () => assertForaySliceComplete({ forays: [] }, full, sliced),
    (e) => e instanceof WebDirError && /carries no Forays/.test(e.message)
  );

  /* 6. THE POOL NO LONGER CARRIES ANY REFERENCED ID. Same vacuity, one document
        further along: the comparison would be an empty set against an empty set. */
  const strangers = { ...segments, segments: segments.segments.map((s) => ({ ...s, id: `other-${s.id}` })) };
  assert.throws(
    () => assertForaySliceComplete(forays, { segments: strangers, sources }, { segments: strangers, sources }),
    (e) => e instanceof WebDirError && /compares nothing against nothing/.test(e.message)
  );

  /* 7. THE JOIN IS BROKEN UPSTREAM, so both sides hydrate nothing and "identical" is
        meaningless. THIS IS #328'S LESSON, which found a validator that accepted 9
        broken segments because it asked "is this resolvable" instead of "does this
        play these words": every check here is a comparison, and a comparison agrees
        enthusiastically when both sides are empty. */
  const noSources = { ...sources, sources: [] };
  assert.throws(
    () => assertForaySliceComplete(forays, { segments, sources: noSources }, { segments: sliced.segments, sources: noSources }),
    (e) => e instanceof WebDirError && /compares empty against empty/.test(e.message)
  );

  /* 8. Equal sizes stay legal — a pool small enough that the slice is the whole thing
        is legitimate, and the REAL documents are asserted to actually shrink in
        shell-invariants. */
  assert.equal(assertForaySliceComplete(forays, sliced, sliced), true);
});

test("an empty segments, sources or forays document is a hard error, not an empty pool", () => {
  /* The fails-green shape, three times. Each of these produces a bundle that is
     small, silent, under every budget, and gives every Foray in the app an empty
     running order. */
  const { forays, segments, sources } = makeForayDocs();
  assert.throws(() => segmentSlice({ version: 1, entries: [] }, forays), (e) => /no non-empty "segments" array/.test(e.message));
  assert.throws(() => segmentSlice({ version: 1, segments: [] }, forays), (e) => /no non-empty "segments" array/.test(e.message));
  assert.throws(
    () => segmentSourceSlice({ version: 1, rows: [] }, segments, forays),
    (e) => /no non-empty "sources" array/.test(e.message)
  );
  /* A Foray document that references nothing — renamed, malformed, or its items no
     longer saying `type: "segment"`, which is the field the resolver dispatches on. */
  assert.throws(() => segmentSlice(segments, { forays: [] }), (e) => /references a single segment/.test(e.message));
  const retyped = { forays: forays.forays.map((f) => ({ ...f, items: f.items.map((i) => ({ ...i, type: "clip" })) })) };
  assert.throws(() => segmentSlice(segments, retyped), (e) => /type "segment"/.test(e.message));
});

test("THE BOUND: a thousand new segments in the pool cost the bundle nothing", () => {
  /* THE WHOLE POINT, as a number. `data/segments.json` is the one file in this
     bundle designed to grow without bound, and before #327 it was copied verbatim:
     ~1.0 KB of bundle per segment across the two files, against ~740 KB of headroom.
     A slice keyed on what the Forays reference is O(Forays), not O(pool), so an
     extraction batch costs zero bundle bytes until somebody authors against it.

     If anyone makes the selection proportional to the pool again, this is the test
     that fails, and it fails with the number of bytes the batch would have cost. */
  const { forays, segments, sources } = makeForayDocs();
  const template = segments.segments[0];
  const grown = { ...segments, segments: [...segments.segments] };
  const grownSources = { ...sources, sources: [...sources.sources] };
  for (let n = 0; n < 1000; n++) {
    grown.segments.push({ ...template, id: `batch-${n}#1`, item_id: `batch-ep-${n}` });
    grownSources.sources.push({ id: `batch-ep-${n}`, show: `Batch show ${n}`, title: `Batch ${n}`, audio_url: `https://a.example/${n}.mp3` });
  }
  /* THE COUNTERFACTUAL FIRST, because it is what makes the rest matter. */
  assert.ok(sliceBytes(grown) + sliceBytes(grownSources) > 200 * 1024, "the synthetic batch is too small to prove anything");

  /* Compared on the ARRAYS, not the whole documents, and the five bytes of
     difference are the reason: `bundled_from` reports the pool it was cut from, so
     `{"segments":10}` becomes `{"segments":1010}`. That number growing while the
     payload does not is the slice working, so asserting on the payload is asserting
     on the property — and the whole-document budget a few tests down is what would
     notice if the metadata ever became the thing that grew. */
  const payload = (d, key) => Buffer.byteLength(JSON.stringify(d[key]), "utf8");
  const before = payload(segmentSlice(segments, forays), "segments") + payload(segmentSourceSlice(sources, segments, forays), "sources");
  const after = payload(segmentSlice(grown, forays), "segments") + payload(segmentSourceSlice(grownSources, grown, forays), "sources");
  assert.equal(after, before, `a 1,000-segment batch moved the slice from ${before} to ${after} bytes`);
  /* And the whole documents moved only by the width of that counter. */
  const whole = sliceBytes(segmentSlice(grown, forays)) - sliceBytes(segmentSlice(segments, forays));
  assert.ok(whole < 16, `the sliced document grew ${whole} bytes, which is more than a counter`);
  assert.equal(assertForaySliceComplete(forays, { segments: grown, sources: grownSources }, {
    segments: segmentSlice(grown, forays),
    sources: segmentSourceSlice(grownSources, grown, forays),
  }), true);
});

test("prepare WRITES both segment slices rather than copying them", () => {
  /* THE MUTATION THIS KILLS: reverting either sliced branch in `prepare` to a plain
     copyFileSync, which is what the file did before #327. Everything else stays
     green — both files are present, the bundle is valid, the cap passes — and the
     bundle silently goes back to being O(pool). */
  const fake = makeFakeRepo();
  prepare({ root: fake, out: "www", perShow: 2 });
  const read = (rel) => JSON.parse(fs.readFileSync(path.join(fake, "www", rel), "utf8"));
  const source = (rel) => JSON.parse(fs.readFileSync(path.join(fake, rel), "utf8"));

  assert.equal(source("data/segments.json").segments.length, 10);
  assert.equal(read("data/segments.json").segments.length, 7);
  assert.equal(source("data/segment-sources.json").sources.length, 5);
  assert.equal(read("data/segment-sources.json").sources.length, 3);
  for (const rel of ["data/segments.json", "data/segment-sources.json"]) {
    assert.ok(
      fs.statSync(path.join(fake, "www", rel)).size < fs.statSync(path.join(fake, rel)).size,
      `the bundled ${rel} is not smaller than the source`
    );
  }

  /* THE END-TO-END PROPERTY, on the bytes that ship: every Foray in the BUNDLED
     forays.json resolves identically against the BUNDLED pair and the repo's. */
  const bundledForays = read("data/forays.json");
  assert.deepEqual(
    hydrateAll(bundledForays, { segments: read("data/segments.json"), sources: read("data/segment-sources.json") }),
    hydrateAll(bundledForays, { segments: source("data/segments.json"), sources: source("data/segment-sources.json") })
  );
  /* And the resolver really produced something, or the line above compares empty
     against empty — the same guard the assertion carries, restated where a reader
     of this test can see it. */
  const played = hydrateAll(bundledForays, {
    segments: read("data/segments.json"), sources: read("data/segment-sources.json"),
  }).reduce((n, r) => n + r.items.filter((i) => i.type === "segment").length, 0);
  assert.equal(played, 5, "the bundled documents resolve to a different number of segments");

  /* The SOURCE documents are untouched — this slices two files, it does not rewrite
     the data directory. */
  assert.equal(source("data/segments.json").segments.length, 10);
});

test("data/forays.json is COPIED WHOLE, because it is the slice's selector", () => {
  /* THE MUTATION THIS KILLS: adding forays.json to PROJECTED_DATA, or "tidying" the
     bundle's copy. It is the SELECTOR — slice or reorder it and the segments it names
     go out of the bundle with it, leaving a Foray that is listed in the app and
     resolves to an empty running order. It is 20 KB and bounded by how many Forays
     exist, so there is nothing to gain and a silent empty running order to lose. */
  assert.ok(COPIED_WHOLE.includes("data/forays.json"));
  assert.equal(PROJECTED_DATA.some((sp) => sp.rel === "data/forays.json"), false);
  const fake = makeFakeRepo();
  prepare({ root: fake, out: "www" });
  /* THE GUARD ITSELF, REACHED, for the reason the item-tags test gives: reading the
     two files and finding them equal proves `prepare` copies, not that anything
     would notice if it stopped. */
  const bundled = path.join(fake, "www", "data", "forays.json");
  const doc = JSON.parse(fs.readFileSync(bundled, "utf8"));
  doc.forays = doc.forays.filter((f) => f.status === "published");
  fs.writeFileSync(bundled, serializeSlice(doc));
  assert.throws(
    () => assertSlicesOnDisk(path.join(fake, "www"), fake),
    (e) => /not byte-identical to the source/.test(e.message) && /SELECTOR/.test(e.message)
  );
});

test("a segment slice over its budget names the budget, not the 3 MB cap", () => {
  /* THE MUTATION THIS KILLS: deleting `assertSlicesOnDisk`'s budget check for these
     two entries. The fixture authors one enormous Foray — deliberate product growth,
     which is exactly what this budget is the alarm for, as opposed to the catalogue
     growth `discover.json`'s budget watches. */
  const { forays, segments, sources } = makeForayDocs();
  const big = { ...segments, segments: [...segments.segments] };
  const items = [];
  for (let n = 0; n < 400; n++) {
    big.segments.push({
      ...segments.segments[0], id: `huge-${n}#1`, item_id: "ep-a",
      why: "w".repeat(300),
    });
    items.push({ type: "segment", slot: "one", label: `H-${n}`, segment_id: `huge-${n}#1`, role: "example" });
  }
  const bigForays = {
    ...forays,
    forays: [...forays.forays, { id: "huge-1", kind: "deep-dive", status: "published", title: "Huge", slots: [{ id: "one", title: "One" }], items }],
  };
  const fake = makeFakeRepo({ forays: { forays: bigForays, segments: big, sources } });
  assert.throws(
    () => prepare({ root: fake, out: "www" }),
    (e) =>
      /data\/segments\.json is [\d.]+ KB, over its 100\.0 KB budget/.test(e.message) &&
      /not the 3 MB bundle cap/.test(e.message)
  );
});

/* ─────────────────── the real repo: the slice, and the year ──────────────── */

test("REAL REPO: the slice keeps every show, every topic and both joins", () => {
  const source = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "discover.json"), "utf8"));
  const slice = discoverSlice(source);
  assert.ok(source.items.length > 1000, `discover.json has only ${source.items.length} items`);
  assert.equal(assertDiscoverSliceComplete(source, slice), true);
  assert.ok(
    slice.items.length < source.items.length,
    `the slice kept all ${slice.items.length} items, so it is not slicing`
  );
  assert.equal(
    new Set(slice.items.map((i) => i.show)).size,
    new Set(source.items.map((i) => i.show)).size,
    "the real slice lost a show"
  );
});

test("REAL REPO: a year of nightly refreshes adds no bundle bytes", () => {
  /* THE ARITHMETIC IN THE PR, EXECUTED. Measured over 2026-07-19..08-18 the nightly
     refresh added ~22 episodes a night to shows already in the catalogue, and no
     shows: 213 since 2026-07-13, while episodes went 764 -> 1534. So a year is
     ~8,000 more episodes of the same 213 shows, and this synthesises exactly that
     and slices both.

     If anyone makes the selection proportional to the catalogue again, this is the
     test that fails, and it fails with the number of bytes a year would cost. */
  const source = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "discover.json"), "utf8"));
  const grown = { ...source, items: [...source.items] };
  const shows = [...new Set(source.items.map((i) => i.show))];
  const template = source.items[0];
  for (let n = 0; n < 8000; n++) {
    grown.items.push({
      ...template,
      id: `synthetic-${n}`,
      show: shows[n % shows.length],
      /* Newer than anything real, so a recency rule would prefer these over every
         existing item — the slice must still be the same SIZE. */
      release_date: "2027-01-01",
    });
  }
  const before = discoverSlice(source);
  const after = discoverSlice(grown);
  const bytes = (d) => serializeSlice(d).length;

  /* THE COUNTERFACTUAL FIRST, because it is the number that makes the rest matter:
     copied whole, a year of this is a 9.6 MB file inside a 3 MB bundle. */
  assert.ok(
    bytes(grown) > 9 * 1024 * 1024,
    `the synthetic year is only ${(bytes(grown) / 1024 / 1024).toFixed(2)} MB, so it is not a year`
  );

  assert.ok(
    Math.abs(bytes(after) - bytes(before)) < bytes(before) * 0.05,
    `a year of nightlies moved the slice from ${bytes(before)} to ${bytes(after)} bytes`
  );
  /* Item counts move slightly where bytes do not, and the reason is the topic top-up
     doing its job: 8,000 items newer than everything real push some per-show picks
     off items that were a topic's only carrier, and the top-up reaches back for
     them. 622 -> 654, about 5%. A real year is gentler than this — real new episodes
     carry real topics — so this is the conservative direction. */
  assert.ok(
    after.items.length < before.items.length * 1.1,
    `the slice went from ${before.items.length} to ${after.items.length} items`
  );
  const budget = PROJECTED_DATA.find((p) => p.rel === "data/discover.json").maxBytes;
  assert.ok(bytes(after) < budget, `a year of nightlies would breach the ${budget / 1024} KB budget`);
  assert.equal(assertDiscoverSliceComplete(grown, after), true);
});

test("REAL REPO: the sliced bundle, its budgets and the headroom that is left", () => {
  withRealBundle((r, absOut) => {
    const by = (rel) => r.files.find((f) => f.rel === rel).bytes;
    for (const spec of PROJECTED_DATA) {
      assert.ok(
        by(spec.rel) <= spec.maxBytes,
        `${spec.rel} is ${(by(spec.rel) / 1024).toFixed(1)} KB, over its ${spec.maxBytes / 1024} KB budget`
      );
      /* Not vacuously under it either: a budget an order of magnitude above the
         thing it measures is not a budget. */
      assert.ok(by(spec.rel) > spec.maxBytes * 0.25, `${spec.rel}'s budget is far too loose to be a signal`);
    }
    assert.ok(by("data/discover.json") < 900 * 1024, "the sliced discover.json is not the size this change claims");

    /* ── THE HEADROOM, AND WHAT IT IS NOW DENOMINATED IN ───────────────────────
       HISTORY, because this pair of numbers has been wrong twice and the shape of
       the wrongness is the useful part.

       The catalogue slice took the bundle 2.98 MB -> 1.96 MB and these thresholds
       were set at 2.2 MB and 900 KB. On 2026-08-23 the first real
       segment-extraction batch took the pool from 69 segments to 212 and the
       registry from 19 to 64; both files were copied verbatim (no `PROJECTED_DATA`
       entry, so the plan took them as-is) and the bundle went 2.11 -> 2.26 MB in one
       commit. Both assertions fired and were RE-BASELINED to 2.4 MB and 600 KB,
       tight, with the reasoning written here.

       THAT WAS NOT A FIX, and the comment said so: the pool is the one file in this
       bundle DESIGNED to grow without bound, it cost ~1.0 KB of bundle per segment
       across the two files, and ~740 KB of headroom was therefore ~745 more segments
       — against a file whose entire purpose is to keep getting bigger. Worse, none of
       it was reachable: the three committed Forays referenced 57 of the 212, so ~160
       KB of the bundle was pool the app had no way to play.

       #327 SLICED IT, and the re-baseline is undone rather than kept: 2.26 -> 2.10
       MB, with `data/discover.json` byte-for-byte unchanged at 704.6 KB.

       WHAT THE HEADROOM BUYS NOW IS NOT MEASURED IN SEGMENTS ANY MORE, and that is
       the whole result. A segment that no Foray references costs the bundle ZERO
       bytes, so the pool can go to 10,000 and this number does not move ("THE BOUND"
       above proves it at 1,000). What the ~920 KB buys is:
         - ~230 nights of `data/item-tags.json`, which is COPIED WHOLE on purpose and
           grows ~4 KB a night. That is the one deliberately-unbounded thing left, and
           when this assertion next goes red THAT is what it will be about — the fix
           is the df sidecar named in `COPIED_WHOLE`'s comment, not another
           re-baseline.
         - ~30 new Forays, at ~15 KB of segments plus up to ~15 KB of registry each.

       SO THE TWO ASSERTIONS NOW SAY DIFFERENT THINGS, which is what the old pair did
       not: they could both only see the TOTAL, so 143 unreachable segments looked
       exactly like ordinary growth and neither could say which it was. */

    /* A. THE TOTAL, at ~100 nights of the one file that is unbounded on purpose.
          Loose enough not to fire on ordinary work, tight enough to fire ~130 nights
          before the 3 MB cap does — so the alarm still arrives with time to act.

          ONE ASSERTION, NOT TWO. The pair this replaces was `total < 2.4 MB` AND
          `MAX_BYTES - total > 600 KB`, which look like two alarms and are one
          predicate about one quantity — and the first draft of this rewrite made
          them EXACTLY the same predicate (`3 MB - 512 KB` is `2.5 MB`), so the
          second could never fire. That is the #274 shape: a branch that reads as a
          guard and is unreachable. The second alarm is now B, which is about a
          different quantity, because two alarms are only worth having if they can
          go off separately. */
    assert.ok(
      r.total < 2.5 * 1024 * 1024,
      `the bundle is ${(r.total / 1024 / 1024).toFixed(2)} MB, leaving ` +
        `${((MAX_BYTES - r.total) / 1024).toFixed(0)} KB of headroom under the 3 MB cap`
    );

    /* B. THE DATA HALF ON ITS OWN, which is a different quantity from A and can go
          off without it. The bundle has two halves that grow for unrelated reasons:
          `data/` (1,254 KB today — the catalogue, the tags, the pool) and everything
          else (897 KB — `player/` grew 66 KB -> 480 KB in the fourteen days to
          2026-08-18). A total-only alarm cannot say which one moved, and that is
          exactly why #328 read as ordinary growth. 1.5 MB is ~282 KB above today's
          1,254 KB: ~70 nights of `item-tags.json`, or one pipeline input in the plan. */
    const dataBytes = r.files.filter((f) => f.rel.startsWith("data/")).reduce((n, f) => n + f.bytes, 0);
    assert.ok(
      dataBytes < 1.5 * 1024 * 1024,
      `the bundle's data/ half is ${(dataBytes / 1024).toFixed(0)} KB — something in data/ stopped being bounded`
    );
    assert.ok(dataBytes > 512 * 1024, `the bundle's data/ half is only ${(dataBytes / 1024).toFixed(0)} KB — the plan has collapsed`);

    /* C. THE POOL, DENOMINATED IN THE POOL — the assertion whose absence let #328
          through. A ratio and not a byte count, so it is scale-free: it holds when
          the pool is 212 segments and when it is 20,000, and it fails the moment
          either file goes back to being copied. */
    for (const rel of ["data/segments.json", "data/segment-sources.json"]) {
      const bundled = by(rel);
      const onDisk = fs.statSync(path.join(ROOT, rel)).size;
      assert.ok(
        bundled < onDisk * 0.5,
        `the bundled ${rel} is ${(bundled / 1024).toFixed(1)} KB of a ${(onDisk / 1024).toFixed(1)} KB ` +
          `source — more than half the pool is in the bundle, so it is being copied, not sliced`
      );
    }
    /* And the count is EXACT, which no ratio can be: the slice is the referenced set,
       so this is the number of segments today's Forays name and nothing else. */
    const forays = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "forays.json"), "utf8"));
    const bundledSegments = JSON.parse(fs.readFileSync(path.join(absOut, "data", "segments.json"), "utf8"));
    const referenced = referencedSegmentIds(forays);
    assert.ok(referenced.size > 0, "today's Forays reference no segments at all");
    assert.deepEqual(
      new Set(bundledSegments.segments.map((s) => s.id)),
      referenced,
      "the bundled pool is not exactly the set today's Forays reference"
    );

    /* And the re-read guard really ran against the bytes on disk. */
    assert.equal(assertSlicesOnDisk(absOut, ROOT), true);
  });
});

test("REAL REPO: every segment today's Forays reference resolves out of the bundle", () => {
  /* THE END-TO-END PROPERTY ON THE REAL DATA, and the one whose failure is invisible:
     a Foray whose items resolve to nothing in the app and play fine on the website.
     Asserted by re-running the REAL resolver over the bundled pair and the repo's
     pair and demanding the same answer — not by re-deriving the selection rule. */
  withRealBundle((r, absOut) => {
    const read = (dir, rel) => JSON.parse(fs.readFileSync(path.join(dir, rel), "utf8"));
    const forays = read(absOut, "data/forays.json");
    const bundled = { segments: read(absOut, "data/segments.json"), sources: read(absOut, "data/segment-sources.json") };
    const repo = { segments: read(ROOT, "data/segments.json"), sources: read(ROOT, "data/segment-sources.json") };

    /* The slice really is a slice of today's documents, or the comparison is between
       a document and itself. */
    assert.ok(repo.segments.segments.length > bundled.segments.segments.length, "the real pool is not being sliced");
    assert.ok(repo.sources.sources.length > bundled.sources.sources.length, "the real registry is not being sliced");

    const before = hydrateAll(forays, repo);
    const after = hydrateAll(forays, bundled);
    const played = before.reduce((n, h) => n + h.items.filter((i) => i.type === "segment").length, 0);
    /* NOT VACUOUS: the comparison below agrees enthusiastically when both sides are
       empty, which is #328's lesson in one line. 57 segments across three Forays. */
    assert.ok(played >= 50, `the real documents resolve to only ${played} segment entries`);
    assert.deepEqual(after, before);

    /* Re-asserted through the guard as well, so deleting the join re-run inside
       `assertForaySliceComplete` fails here AND in the fixture suite AND in
       shell-invariants. */
    assert.equal(assertForaySliceComplete(forays, repo, bundled), true);
    assert.ok(r.total < MAX_BYTES);
  });
});

test("REAL REPO: nothing in the app browses the segment pool — the slice's premise, as a test", () => {
  /* THE RULING #327 ASKED FOR, checked rather than assumed, and pinned because it is
     a PREMISE: the slice is exactly the referenced set, which is only safe while
     nothing enumerates the pool. `discover.json` needs a topic top-up precisely
     because `app.js` routes `#/subject/<topic>` off it; a segment's `topic` has no
     such reader, so there is no analogue to build.

     If a future change adds a segment browse surface — "clips from this episode", a
     segment search, a topic index over the pool — this test fails, and the right
     answer then is a top-up rule and a bigger budget, NOT deleting this. */
  const app = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
  const uses = app
    .split("\n")
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => /\bstate\.(segments|segmentSources)\b/.test(line));
  assert.ok(uses.length >= 2, "app.js no longer mentions the segment documents at all — the derivation has moved");
  for (const [n, line] of uses) {
    const isFetchAssignment = /state\.forays,\s*state\.segments,\s*state\.segmentSources/.test(line);
    /* The one and only read: handed whole to player/client.js's resolve(), which
       indexes BY ID and looks up only the ids the Foray names. */
    const isResolveArgument = /(segmentsDoc|sourcesDoc):\s*state\.(segments|segmentSources)/.test(line);
    assert.ok(
      isFetchAssignment || isResolveArgument,
      `app.js:${n} reads the segment pool somewhere new — ${line.trim()}\n` +
        `The mobile bundle ships ONLY the segments the bundled Forays reference ` +
        `(tools/mobile/prepare-webdir.mjs, #327), so any surface that enumerates the pool ` +
        `renders empty in the app and populated on the web.`
    );
  }
  /* `player/` too, because §3.3 states the premise over `app.js` AND `player/`, and a
     test that pins less than the doc claims is how the doc becomes wrong. The player
     is allowed to READ both documents — that is `foray-resolve.js`'s whole job — so
     the thing to forbid is ENUMERATION: iterating the pool rather than looking an id
     up in it. `indexSegments`/`indexSources` iterate exactly once each, to build the
     indexes, and both are in `foray-resolve.js`. */
  const playerDir = path.join(ROOT, "player");
  const playerModules = fs.readdirSync(playerDir).filter((n) => n.endsWith(".js") && !n.endsWith(".test.js"));
  const poolReaders = [];
  for (const f of playerModules) {
    const src = fs.readFileSync(path.join(playerDir, f), "utf8");
    const readsPool = /\bsegmentsDoc\b|\bsourcesDoc\b|indexSegments|indexSources/.test(src);
    if (!readsPool) continue;
    poolReaders.push(f);
    assert.ok(
      f === "foray-resolve.js" || f === "client.js",
      `player/${f} reads the segment documents. Only foray-resolve.js (the join) and ` +
        `client.js (the bridge) may, because the mobile bundle ships ONLY the segments the ` +
        `bundled Forays reference (#327) — anything that enumerates the pool renders short ` +
        `in the app and complete on the web.`
    );
  }

  /* NOT VACUOUS: if that pattern stopped matching, the loop above would run zero times
     and pass without having read anything — the "fails green" shape this file's header
     names as the interesting failure. Two modules read these documents today, and they
     are the two the assertion allows, so the allow-list is doing work rather than
     describing an empty set. */
  assert.ok(playerModules.length > 10, `only ${playerModules.length} player modules were scanned`);
  assert.deepEqual(poolReaders.sort(), ["client.js", "foray-resolve.js"]);

  /* And the two files that have no business reading the pool still do not touch it.
     Matched on the DOCUMENTS and the JOIN KEY rather than on the word "segment":
     `search-engine.js` says "hyphen SEGMENT" in a comment about regex caching, and a
     test that fails on prose is a test somebody deletes. */
  const POOL_REFERENCE = /data\/segments\.json|data\/segment-sources\.json|\bsegment_id\b|state\.segment/;
  for (const rel of ["search-engine.js", "index.html"]) {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    assert.equal(POOL_REFERENCE.test(src), false, `${rel} reads the segment pool now — re-check the slice's premise`);
  }
  /* The pattern is not vacuous: it matches where the pool really is read. */
  assert.equal(POOL_REFERENCE.test(app), true, "the pool-reference pattern no longer matches app.js");
});

/* ──────────────────────────────── the fixture ───────────────────────────── */

/** A minimal repo shaped like this one: the shell files, a flat `player/` with
 *  one import between modules and one test file, and a `data/` holding both
 *  client data and a pipeline input. */
function makeFakeRepo({
  appSrc = null,
  extraFetches = [],
  bigDataBytes = 0,
  catalogue = makeCatalogue(),
  forays = makeForayDocs(),
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foray-webdir-"));
  /* Nine, the number `app.js` actually fetches. It used to be six, which is exactly
     MIN_DERIVED_DATA_FILES — so any test that removes one fetch tripped the
     derivation floor before reaching the behaviour it was about. */
  const fetches = [
    "data/session.json", "data/taxonomy.json", "data/discover.json",
    "data/item-tags.json", "data/forays.json", "data/segments.json",
    "data/segment-sources.json", "data/semantic-index.json", "data/validated-links.json",
    ...extraFetches,
  ];
  const src = appSrc ?? fetches.map((f) => `await fetchJson("${f}");`).join("\n");

  const write = (rel, body) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  };
  write("app.js", src);
  for (const f of SHELL_FILES) if (f !== "app.js") write(f, `/* ${f} */`);
  /* index.html needs a REAL head, because `prepare` injects the shell-only script
     tags before `</head>` and refuses to guess when the anchor is missing. Written
     with the CSP meta in it so the ordering assertion — tags after the policy, not
     before it — has something to be about. */
  write(
    "index.html",
    '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
      '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'">\n' +
      "<title>Foray</title>\n</head>\n<body>\n<script src=\"app.js\"></script>\n</body>\n</html>\n"
  );
  /* The shell-only sources live outside the site's own tree, so they are not
     covered by the SHELL_FILES loop above. */
  for (const f of SHELL_ONLY_FILES) write(f.src, "/* the shell's foreground-service bridge */\n");
  write("sw.js", 'const CACHE = "foray-v4";');
  write("player/client.js", 'import { x } from "./queue-manager.js";');
  write("player/queue-manager.js", "export const x = 1;");
  write("player/client.test.js", "// a suite, must not ship");
  write("data/huge-pipeline-input.json", "{}");
  /* The two SLICED documents, plus the session document the tag slice keys against.
     They cannot be `{}` any more: `prepare` writes these two as a bounded slice
     rather than copying them, and it refuses a document with no catalogue in it. */
  write("data/discover.json", JSON.stringify(catalogue.discover, null, 2) + "\n");
  write("data/item-tags.json", JSON.stringify(catalogue.itemTags, null, 2) + "\n");
  write("data/session.json", JSON.stringify(catalogue.session, null, 2) + "\n");
  /* The three FORAY documents (#327). Two of them are sliced and the third is the
     selector, so `{}` no longer does: `prepare` refuses a pool with no segments and
     refuses a Foray document that references none. */
  write("data/forays.json", JSON.stringify(forays.forays, null, 2) + "\n");
  write("data/segments.json", JSON.stringify(forays.segments, null, 2) + "\n");
  write("data/segment-sources.json", JSON.stringify(forays.sources, null, 2) + "\n");
  for (const f of fetches) {
    if (!fs.existsSync(path.join(root, f))) write(f, "{}");
  }
  /* The size-cap fixture pads a file that is COPIED, not sliced: padding a sliced
     one would trip its per-file budget first and the test would pass for the wrong
     reason. `taxonomy.json` is a plain copy. */
  if (bigDataBytes) write("data/taxonomy.json", "x".repeat(bigDataBytes));
  /* `extraFetches` names files that must be MISSING, so undo the loop for them. */
  for (const f of extraFetches) fs.rmSync(path.join(root, f), { force: true });
  return root;
}

/**
 * A synthetic catalogue shaped like the real one in the four ways the slice cares
 * about, because a fixture that is merely well-formed proves nothing here:
 *
 *   1. DOCUMENT ORDER IS NOT RECENCY ORDER — each show's FIRST item is its OLDEST.
 *      A "newest N per show" rule that forgot the join anchor would drop exactly
 *      that item, and `artworkUrlsByShow` reads exactly that item.
 *   2. ARTWORK AND COLLECTION IDS DIFFER WITHIN A SHOW, as they do in the real
 *      document (461 distinct artwork URLs across 213 shows). Otherwise picking the
 *      wrong item per show would produce an identical map and prove nothing.
 *   3. ONE TOPIC LIVES ONLY ON AN ITEM THE PER-SHOW CAP WOULD MISS, so the topic
 *      top-up is load-bearing rather than incidentally satisfied.
 *   4. Tags exist for every item AND for the session's own episodes, which are in
 *      the pool but not in `discover.json`.
 */
function makeCatalogue({ shows = 4, episodes = 5, hookBytes = 0 } = {}) {
  const items = [];
  for (let s = 0; s < shows; s++) {
    for (let e = 0; e < episodes; e++) {
      /* e0 is the OLDEST, so document order is the reverse of recency and the join
         anchor is exactly the item a "newest N" rule would leave behind. Built
         through Date rather than by padding a day number: `2026-01-40` is not a date,
         it parses to NaN, and the first draft of this fixture silently made every
         episode past the 31st the oldest in its show. */
      const date = new Date(Date.UTC(2026, 0, 1 + e)).toISOString().slice(0, 10);
      const topics = [`branch${s % 3}/topic${s}`];
      /* Property 3: the last-but-one episode of show 0 is the only carrier of
         `rare`, and with perShow 2 it is picked neither as the anchor (e0) nor as
         the newest (e4). */
      if (s === 0 && e === episodes - 2) topics.push("branch9/rare");
      items.push({
        id: `s${s}-e${e}`,
        show: `Show ${s}`,
        title: `Show ${s} episode ${e}`,
        apple_collection_id: 1000 + s * 100 + e,
        release_date: date,
        duration_min: 40 + e,
        artwork_url: `https://art.example/s${s}-e${e}.png`,
        topics,
        hook: hookBytes ? "h".repeat(hookBytes) : `A hook for show ${s} episode ${e}.`,
      });
    }
  }
  const tags = {};
  for (const it of items) tags[it.id] = [`tag-${it.id}`];
  /* Session episodes are pool members with no discover entry, and they have tags. */
  const episodesById = {};
  for (const id of ["session-a", "session-b"]) {
    episodesById[id] = { show: "Session Show", title: id, topics: ["branch0/topic0"] };
    tags[id] = [`tag-${id}`];
  }
  return {
    discover: { version: 1, built_at: "2026-01-01T00:00:00.000Z", items },
    itemTags: { version: 1, built_at: "2026-01-01T00:00:00.000Z", tags },
    session: { session_id: "fixture", episodes: episodesById },
  };
}

/**
 * The three Foray documents, shaped like the real ones in the six ways the segment
 * slice cares about — because a fixture that is merely well-formed proves nothing
 * here, and "keep the whole pool" passes any fixture where everything is referenced.
 *
 *   1. THE POOL CARRIES SEGMENTS NO FORAY REFERENCES (`x#1`, `x#2`, `y#1`), and the
 *      registry carries episodes no kept segment plays out of (`ep-x`, `ep-y`).
 *      They are the ~160 KB #327 is about; without them the slice is the identity
 *      function and every assertion below is vacuous.
 *   2. ONE FORAY IS A DRAFT, and it is the only referrer of `d#400` and `c#300`.
 *      `forayVisibility` makes a draft reachable by id, so a slice keyed on
 *      `listableForays` ships a Foray that resolves to nothing — and that rule
 *      passes every count, every budget and the whole published half of the join.
 *      ALL THREE of the real Forays are drafts today, so that rule references zero
 *      segments — see the hard error in `segmentSlice` and the test for it below.
 *   3. TWO ROWS SHARE THE ID `dup#7`, WITH DIFFERENT `item_id` AND TIMESTAMPS.
 *      `indexSegments` is `Map.set` in document order, so the LAST one wins; a slice
 *      that kept "the first row matching a referenced id" keeps the right id, the
 *      right count and the right budget, and plays different seconds of a different
 *      episode. This CANNOT FAIL ON TODAY'S DATA — the real pool has no duplicate
 *      ids — and it is written deliberately, per CLAUDE.md § "A green test is not
 *      evidence": it is the only thing between a future re-extraction that reuses an
 *      id and a listener hearing the wrong clip.
 *   4. A FORAY CARRIES A NARRATION BRIDGE (`type: "narration"`), which has no
 *      `segment_id` to resolve. `referencedSegmentIds` discriminates on `type` the
 *      way `hydrateForayItems` does, and a bridge must survive the slice untouched.
 *   5. `orphan#1` IS IN THE POOL AND ITS EPISODE IS NOT IN THE REGISTRY, so the join
 *      drops it — against the full documents AND against the slice, identically.
 *      That is what makes the `dropped` half of the comparison non-empty, and a
 *      slice is not allowed to create a drop or to hide one.
 *   6. TWO KEPT SEGMENTS SHARE `ep-a`, so the registry slice has to de-duplicate
 *      rather than count.
 */
function makeForayDocs() {
  const seg = (id, item_id, start_sec, extra = {}) => ({
    id, item_id, start_sec, end_sec: start_sec + 60,
    topic: "fixture/topic", why: `why ${id}`, confidence: "high", ...extra,
  });
  /* Document order matters and is not id order: the unreferenced rows are
     interleaved, so "the slice is a prefix" and "the slice is contiguous" are both
     false and a filter is the only rule that works. */
  const segments = {
    version: 1,
    built_at: "2026-01-01T00:00:00.000Z",
    /* The real document carries `notes` and `provenance` beside `segments`, and the
       projection spreads unknown top-level keys through rather than naming the ones
       it knows. A fixture without them is more forgiving than the thing it stands
       for: it could not tell a projection that dropped them from one that did not. */
    notes: "A fixture, shaped like data/segments.json.",
    provenance: { batches: ["fixture-a"] },
    segments: [
      seg("a#100", "ep-a", 100),
      seg("x#1", "ep-x", 10),
      seg("b#200", "ep-b", 200),
      seg("dup#7", "ep-a", 10),
      seg("y#1", "ep-y", 20),
      seg("c#300", "ep-c", 300),
      seg("dup#7", "ep-c", 900),
      seg("x#2", "ep-x", 30),
      seg("d#400", "ep-a", 400),
      seg("orphan#1", "ep-gone", 500),
    ],
  };
  const src = (id, show) => ({ id, show, title: `${show} episode`, audio_url: `https://audio.example/${id}.mp3` });
  const sources = {
    version: 1,
    built_at: "2026-01-01T00:00:00.000Z",
    notes: "A fixture, shaped like data/segment-sources.json.",
    provenance: { batches: ["fixture-a"] },
    sources: [src("ep-a", "Show A"), src("ep-x", "Show X"), src("ep-b", "Show B"), src("ep-c", "Show C"), src("ep-y", "Show Y")],
  };
  const forays = {
    version: 1,
    built_at: "2026-01-01T00:00:00.000Z",
    forays: [
      {
        id: "published-1",
        kind: "deep-dive",
        status: "published",
        title: "A published Foray",
        slots: [{ id: "one", title: "Slot one" }],
        items: [
          { type: "segment", slot: "one", label: "A-1", segment_id: "a#100", role: "explanation" },
          { type: "narration", slot: "one", label: "N-1", text: "A bridge between two clips." },
          { type: "segment", slot: "one", label: "A-2", segment_id: "dup#7", role: "example" },
          { type: "segment", slot: "one", label: "A-3", segment_id: "b#200", role: "example" },
          { type: "segment", slot: "one", label: "A-4", segment_id: "orphan#1", role: "example" },
        ],
      },
      {
        id: "draft-1",
        kind: "deep-dive",
        status: "draft",
        title: "A draft Foray, reachable by id",
        slots: [{ id: "two", title: "Slot two" }],
        items: [
          { type: "segment", slot: "two", label: "B-1", segment_id: "d#400", role: "explanation" },
          { type: "segment", slot: "two", label: "B-2", segment_id: "c#300", role: "example" },
        ],
      },
    ],
  };
  return { forays, segments, sources };
}

/* ───────── the shell-only script, which is the one thing that is not a copy ──── */

test("the shell's foreground-service bridge really is on disk where the plan says", () => {
  /* REAL REPO. A missing source is a hard error rather than a skip, and this is the
     test that says the path in SHELL_ONLY_FILES is not a typo today. Rename the
     plugin's web/ directory and the bundle would otherwise lose its only link to
     the native foreground service while staying under the size cap, building,
     installing and playing. */
  const files = shellOnlyPlan(ROOT);
  assert.ok(files.length >= 1, "there is no shell-only file at all any more");
  for (const f of files) {
    assert.ok(fs.existsSync(path.join(ROOT, f.src)), `${f.src} is missing`);
    assert.ok(!f.dest.includes("/"), `${f.dest} should sit at the bundle root`);
  }
});

test("a missing shell-only source is a hard error, not a smaller bundle", () => {
  const fake = makeFakeRepo();
  for (const f of SHELL_ONLY_FILES) fs.rmSync(path.join(fake, f.src), { force: true });
  assert.throws(
    () => prepare({ root: fake, out: path.join("mobile", "www") }),
    (e) => /shell-only files are missing/.test(e.message) && /background audio/.test(e.message)
  );
});

test("the script tag is derived from the file list, so the two cannot drift", () => {
  /* Writing the filename twice is how a rename lands the file in the bundle and
     leaves the tag pointing at the old name — a 404 in the app and nothing else. */
  const tags = shellScriptTags([{ src: "a/b/c.js", dest: "c.js", module: true }]);
  assert.deepEqual(tags, ['<script type="module" src="c.js"></script>']);
  const classic = shellScriptTags([{ src: "a/b/c.js", dest: "c.js" }]);
  assert.deepEqual(classic, ['<script src="c.js"></script>']);
  for (const tag of shellScriptTags()) {
    const dest = /src="([^"]+)"/.exec(tag)[1];
    assert.ok(
      SHELL_ONLY_FILES.some((f) => f.dest === dest),
      `${tag} points at ${dest}, which is not in SHELL_ONLY_FILES`
    );
  }
});

test("the tags go inside the head, after the CSP meta rather than before it", () => {
  const html =
    '<!doctype html>\n<head>\n<meta charset="utf-8">\n' +
    '<meta http-equiv="Content-Security-Policy" content="script-src \'self\'">\n' +
    "</head>\n<body></body>\n";
  const out = injectShellScripts(html);
  assert.equal(out.changed, true);
  const tag = shellScriptTags()[0];
  const at = out.html.indexOf(tag);
  assert.ok(at > out.html.indexOf("Content-Security-Policy"), "the tag landed ahead of the policy that allows it");
  assert.ok(at < out.html.indexOf("</head>"), "the tag landed outside the head");
  assert.ok(at < out.html.indexOf("<body>"));
});

test("injection is idempotent, because cap sync and CI both re-run it", () => {
  const html = "<head>\n</head>\n<body></body>";
  const once = injectShellScripts(html);
  const twice = injectShellScripts(once.html);
  assert.equal(twice.changed, false);
  assert.equal(twice.html, once.html);
  const tag = shellScriptTags()[0];
  assert.equal(twice.html.split(tag).length - 1, 1, "the tag was added twice");
});

test("an index.html with no </head> is refused rather than guessed at", () => {
  assert.throws(() => injectShellScripts("<html><body>no head</body></html>"), WebDirError);
  assert.throws(() => injectShellScripts(""), WebDirError);
  assert.throws(
    () => injectShellScripts("<head></head><!-- </head> --><body></body>"),
    (e) => e instanceof WebDirError && /more than once/.test(e.message)
  );
});

test("assertShellScriptsPresent is a real guard and not decoration", () => {
  /* The anti-fails-green check, tested directly for the reason
     inject-background-audio.mjs's assertModePresent gives: an adversarial pass
     replaced that one's inline version with `if (false)` and the suite stayed
     green. Every failure mode in injectShellScripts degrades to "returned the
     input unchanged and reported success" without this. */
  const good = injectShellScripts("<head>\n</head><body></body>").html;
  assert.equal(assertShellScriptsPresent(good), true);
  assert.throws(() => assertShellScriptsPresent("<head></head><body></body>"), WebDirError);
  /* Present, but AFTER the head — CSP-governed markup order is the whole reason the
     position matters, so a tag in the body must fail too. */
  const tag = shellScriptTags()[0];
  assert.throws(
    () => assertShellScriptsPresent(`<head></head><body>${tag}</body>`),
    (e) => e instanceof WebDirError && /after <\/head>/.test(e.message)
  );
});

test("prepare copies the shell-only file and leaves the tag in the written index.html", () => {
  const fake = makeFakeRepo();
  const r = prepare({ root: fake, out: path.join("mobile", "www") });
  const outDir = path.join(fake, "mobile", "www");
  for (const f of SHELL_ONLY_FILES) {
    assert.ok(fs.existsSync(path.join(outDir, f.dest)), `${f.dest} is not in the bundle`);
    assert.ok(r.files.some((x) => x.rel === f.dest), `${f.dest} is not in the reported file list`);
  }
  /* Read off DISK, not out of the returned value: a write that did not land is the
     case an in-memory assertion cannot see. */
  const written = fs.readFileSync(path.join(outDir, "index.html"), "utf8");
  assert.equal(assertShellScriptsPresent(written), true);

  /* THE REPORTED SIZE MUST INCLUDE THE INJECTION, and the first version of this
     assertion could not tell. It compared `r.total` against the sum of `r.files`
     bytes — but `prepare()` DEFINES `total` as exactly that sum, so it held no matter
     when the measurement happened, which is the "passes with the mechanism deleted"
     shape this repo keeps paying for. The real guarantee is that sizes are taken AFTER
     the write, so it is checked against the source file and against the disk. */
  const sourceBytes = fs.statSync(path.join(fake, "index.html")).size;
  const reported = r.files.find((f) => f.rel === "index.html");
  assert.ok(reported, "index.html is not in the reported file list");
  assert.equal(
    reported.bytes,
    fs.statSync(path.join(outDir, "index.html")).size,
    "the reported size of index.html is not the size on disk"
  );
  assert.ok(
    reported.bytes > sourceBytes,
    `index.html was reported as ${reported.bytes} B, not more than the ${sourceBytes} B source — ` +
      `the size was measured before the script tags were injected.`
  );
  const expectedGrowth = shellScriptTags().reduce((n, t) => n + t.length + 1, 0);
  assert.equal(
    reported.bytes - sourceBytes,
    expectedGrowth,
    "the bundled index.html grew by something other than the injected tags"
  );
});

test("the SITE's index.html is not modified — the injection is to the copy only", () => {
  /* The bundle's index.html differs from the root's by one line, and the direction
     that must never happen is the other one. A shell-only script tag in the file
     GitHub Pages serves would 404 for every real visitor. */
  const fake = makeFakeRepo();
  const before = fs.readFileSync(path.join(fake, "index.html"), "utf8");
  prepare({ root: fake, out: path.join("mobile", "www") });
  assert.equal(fs.readFileSync(path.join(fake, "index.html"), "utf8"), before);
});

test("REAL REPO: the site's index.html carries no shell-only tag", () => {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  for (const f of SHELL_ONLY_FILES) {
    assert.ok(
      !html.includes(f.dest),
      `index.html references ${f.dest}, which only exists inside the native bundle — ` +
        `the website would 404 on it.`
    );
  }
});
