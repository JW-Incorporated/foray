/* End-to-end pipeline test against a small in-memory fixture `podcasts`
   table (node:sqlite) — covers: full D1+D13+shard-build run, id-map
   fail-closed behaviour, shard size ceiling enforcement, and the
   determinism acceptance criterion (two runs over the same fixture
   produce byte-identical output artifacts). No network, no real dump. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gzipSync } from "node:zlib";
import { DUMP_COLUMNS, NEWEST_SNAPSHOT_ASSET } from "./config.mjs";
import {
  buildNewestSnapshot, loadPreviousNewest, parseNewestSnapshot, runPipeline, runPipelineWithBaseline,
  writeBuildOutput,
} from "./import-dump.mjs";
import { buildChanged } from "./shard-build.mjs";

const NOW = Date.parse("2026-09-05T00:00:00Z");
const monthsAgo = (n) => Math.floor((NOW - n * (365.25 / 12) * 24 * 60 * 60 * 1000) / 1000);

function buildFixtureDb(rows) {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE podcasts (
    id INTEGER PRIMARY KEY, url TEXT, podcastGuid TEXT, itunesId INTEGER,
    title TEXT, itunesAuthor TEXT, itunesOwnerName TEXT, description TEXT,
    imageUrl TEXT, language TEXT, dead INTEGER, episodeCount INTEGER,
    lastUpdate INTEGER, newestItemPubdate INTEGER, oldestItemPubdate INTEGER,
    popularityScore INTEGER, explicit INTEGER, host TEXT,
    category1 TEXT, category2 TEXT, category3 TEXT, category4 TEXT, category5 TEXT,
    category6 TEXT, category7 TEXT, category8 TEXT, category9 TEXT, category10 TEXT
  )`);
  const cols = DUMP_COLUMNS;
  const stmt = db.prepare(`INSERT INTO podcasts (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`);
  for (const row of rows) {
    stmt.run(...cols.map((c) => (row[c] === undefined ? null : row[c])));
  }
  return db;
}

const fixtureRow = (over = {}) => ({
  id: 1, url: "https://feeds.example.com/show1", podcastGuid: null, itunesId: null,
  title: "Show One", itunesAuthor: "Author One", itunesOwnerName: null,
  description: "", imageUrl: null, language: "en", dead: 0, episodeCount: 10,
  lastUpdate: monthsAgo(1), newestItemPubdate: monthsAgo(1), oldestItemPubdate: monthsAgo(30),
  popularityScore: 10, explicit: 0, host: "example.com",
  ...over,
});

test("runPipeline: full run over a small fixture — filter, dedupe, id-map all agree", () => {
  const rows = [
    fixtureRow({ id: 1, title: "Show One", itunesAuthor: "Author One", popularityScore: 100 }),
    /* A DISTINCT url, deliberately. This row exists to prove `dead` is filtered
       before dedupe sees it — but `fixtureRow`'s default url is show1's, which
       is also the curated entry's feed_url, so on the default it was ALSO a
       curated row. Once curated rows became exempt from D1 (identity.mjs's
       `curatedKeys`) this fixture asserted two contradictory things at once and
       the exemption, correctly, rescued it. The dead-row intent is kept here;
       the exemption gets its own test below rather than riding on an accident. */
    fixtureRow({ id: 2, url: "https://feeds.example.com/dead-show", title: "Dead Show", dead: 1, popularityScore: 5 }),
    fixtureRow({ id: 3, url: "https://feeds.example.com/show1", title: "Show One Dup", podcastGuid: null, itunesId: 555, popularityScore: 50 }), // same feed url as show 1's curated entry but different dump row -- distinct group by title
  ];
  const db = buildFixtureDb(rows);
  const curatedShows = [{ show_id: "show-one", title: "Show One", feed_url: "https://feeds.example.com/show1" }];
  try {
    const result = runPipeline(db, { curatedShows, now: NOW });
    assert.equal(result.totalRows, 3);
    assert.equal(result.d1Counts.dead, 1);
    assert.equal(result.canonical.length, 2); // dead one filtered before dedupe ever sees it
    assert.deepEqual(result.missing, []);
    assert.ok(Object.values(result.idMap).includes(1) || Object.values(result.idMap).includes(3));
  } finally {
    db.close();
  }
});

test("a curated show is exempt from D1 — dead, thin or years stale, it stays in the list", () => {
  /* THE FIRST REAL RUN'S FINDING, pinned. 16 of 220 curated shows never reached
     the id-map because D1 dropped them: LeVar Burton Reads (last episode May
     2024), The Robot Brains (August 2023), Black Box Down (June 2023) — all
     three still serving a full back catalogue over HTTP 200 today. A finished
     podcast is not a dead one, and dropping it would REMOVE from the app
     content a listener can play right now.

     MUTATION THAT KILLS THIS: delete the `isCuratedRow` branch in
     applyD1Filter. All three rows fail D1, `canonical` comes back empty and
     every curated show lands in `missing`. Ran it — red. */
  const rows = [
    fixtureRow({ id: 10, url: "https://feeds.example.com/finished", title: "Finished Show",
      newestItemPubdate: monthsAgo(30) }),                                   // stale
    fixtureRow({ id: 11, url: "https://feeds.example.com/gone", title: "Gone Show", dead: 1 }), // dead
    fixtureRow({ id: 12, url: "https://feeds.example.com/thin", title: "Thin Show", episodeCount: 1 }), // too few
  ];
  const db = buildFixtureDb(rows);
  const curatedShows = [
    { show_id: "finished", title: "Finished Show", feed_url: "https://feeds.example.com/finished" },
    { show_id: "gone", title: "Gone Show", feed_url: "https://feeds.example.com/gone" },
    { show_id: "thin", title: "Thin Show", feed_url: "https://feeds.example.com/thin" },
  ];
  try {
    const result = runPipeline(db, { curatedShows, now: NOW });
    assert.deepEqual(result.missing, [], "no curated show may be dropped by D1");
    assert.equal(result.d1Counts.curated_exempt, 3, "all three were kept BY the exemption, not by passing");
    assert.equal(result.canonical.length, 3);
    assert.deepEqual(
      Object.keys(result.idMap).sort(), ["finished", "gone", "thin"],
      "every curated show must resolve to a pi_id"
    );
  } finally {
    db.close();
  }
});

test("dedupe hands a group to its curated member, so the id-map join cannot miss", () => {
  /* WHY THIS IS SEPARATE FROM THE EXEMPTION. Odd Lots publishes daily and
     passes D1 on every measure, and the first real run still reported it
     unmapped. The exemption cannot explain that one: the cause is a show with
     SEVERAL feeds in the dump, where D13's default pick (has an Apple id, else
     most recently updated) chose a sibling row whose url and itunesId are not
     the ones `data/catalog.json` carries. The show survives, the join misses,
     and it reads as "missing" either way.

     MUTATION THAT KILLS THIS: drop the `curatedMembers` scope in
     pickCanonical. The sibling (id 21, which holds the itunesId) wins the
     group, the curated feed url is no longer in `canonical`, and `missing`
     names the show. Ran it — red. */
  const rows = [
    fixtureRow({ id: 20, url: "https://feeds.example.com/oddlots", title: "Odd Lots",
      podcastGuid: "same-guid", itunesId: null, popularityScore: 90 }),
    fixtureRow({ id: 21, url: "https://feeds.example.com/oddlots-mirror", title: "Odd Lots",
      podcastGuid: "same-guid", itunesId: 999, popularityScore: 10 }),
  ];
  const db = buildFixtureDb(rows);
  const curatedShows = [
    { show_id: "odd-lots", title: "Odd Lots", feed_url: "https://feeds.example.com/oddlots" },
  ];
  try {
    const result = runPipeline(db, { curatedShows, now: NOW });
    assert.deepEqual(result.missing, []);
    assert.equal(result.canonical.length, 1, "the two feeds are still one show");
    assert.equal(result.idMap["odd-lots"], 20, "the curated feed's row must be the canonical one");
  } finally {
    db.close();
  }
});

test("runPipeline: id-map fails closed — a curated show with no matching row is reported, never silently dropped", () => {
  const rows = [fixtureRow({ id: 1, url: "https://feeds.example.com/show1" })];
  const db = buildFixtureDb(rows);
  const curatedShows = [
    { show_id: "show-one", title: "Show One", feed_url: "https://feeds.example.com/show1" },
    { show_id: "ghost-show", title: "Ghost Show", feed_url: "https://nowhere.example.com/feed" },
  ];
  try {
    const result = runPipeline(db, { curatedShows, now: NOW });
    assert.equal(result.missing.length, 1);
    assert.equal(result.missing[0].show_id, "ghost-show");
  } finally {
    db.close();
  }
});

test("writeBuildOutput: throws ID_MAP_INCOMPLETE and writes nothing when a curated show is unmapped", async () => {
  const rows = [fixtureRow({ id: 1, url: "https://feeds.example.com/show1" })];
  const db = buildFixtureDb(rows);
  const curatedShows = [{ show_id: "ghost-show", title: "Ghost Show", feed_url: "https://nowhere.example.com/feed" }];
  const outDir = mkdtempSync(join(tmpdir(), "shows-build-"));
  try {
    const result = runPipeline(db, { curatedShows, now: NOW });
    await assert.rejects(
      () => writeBuildOutput(result, { outDir, exportVersion: "v1" }),
      (err) => err.code === "ID_MAP_INCOMPLETE" && /ghost-show/.test(err.message),
    );
    // The fail-closed guarantee is that NOTHING is written on this path —
    // not shards, not top.json, nothing — so a partial/inconsistent build
    // never lands on disk. Assert the directory is genuinely empty, not
    // just that the right error was thrown (a partial-write regression
    // must fail this test).
    const { readdirSync } = await import("node:fs");
    assert.deepEqual(readdirSync(outDir), [], "outDir must be empty when the id-map check fails");
  } finally {
    db.close();
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("writeBuildOutput: enforces the top.json size budget", async () => {
  const rows = [fixtureRow({ id: 1, url: "https://feeds.example.com/show1" })];
  const db = buildFixtureDb(rows);
  const curatedShows = [{ show_id: "show-one", title: "Show One", feed_url: "https://feeds.example.com/show1" }];
  const outDir = mkdtempSync(join(tmpdir(), "shows-build-"));
  try {
    const result = runPipeline(db, { curatedShows, now: NOW });
    // Force an oversized top.json by padding one row's title well past the
    // 900KB budget (MAX_TOP_JSON_BYTES, config.mjs — raised from 250KB to
    // 900KB in t_30a53ba2 against a measured real-dump top.json size).
    result.top[0].t = "x".repeat(1_000_000);
    await assert.rejects(
      () => writeBuildOutput(result, { outDir, exportVersion: "v1" }),
      (err) => err.code === "TOP_TOO_LARGE",
    );
    const { readdirSync } = await import("node:fs");
    assert.deepEqual(readdirSync(outDir), [], "outDir must be empty when the size budget check fails");
  } finally {
    db.close();
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("acceptance: two builds over the same fixture produce byte-identical output artifacts", async () => {
  const rows = Array.from({ length: 20 }, (_, i) => fixtureRow({
    id: i + 1,
    url: `https://feeds.example.com/show${i + 1}`,
    title: `Show ${i + 1}`,
    itunesAuthor: `Author ${i % 3}`,
    popularityScore: (i * 37) % 97, // scrambled, not insertion-ordered
  }));
  const curatedShows = [{ show_id: "show-one", title: "Show 1", feed_url: "https://feeds.example.com/show1" }];

  async function buildOnce() {
    const db = buildFixtureDb(rows);
    const outDir = mkdtempSync(join(tmpdir(), "shows-build-"));
    try {
      const result = runPipeline(db, { curatedShows, now: NOW });
      await writeBuildOutput(result, { outDir, exportVersion: "v1", builtAt: "2026-09-05T00:00:00.000Z" });
      return outDir;
    } finally {
      db.close();
    }
  }

  const dirA = await buildOnce();
  const dirB = await buildOnce();
  try {
    for (const file of ["manifest.json", "top.json", "id-map.json", "changed.json", NEWEST_SNAPSHOT_ASSET]) {
      const a = await readFile(join(dirA, file));
      const b = await readFile(join(dirB, file));
      assert.ok(a.equals(b), `${file} differs between two runs over the same fixture`);
    }
    /* data-tools-14: runPipeline was handed no prior-release snapshot, so the
       build says it has no baseline instead of listing every show as changed. */
    assert.deepEqual(JSON.parse(await readFile(join(dirA, "changed.json"), "utf8")), { baseline: false, changed: null });
    // Spot-check a shard too.
    const shardA = readFileSync(join(dirA, "shards", "sh.json.gz"));
    const shardB = readFileSync(join(dirB, "shards", "sh.json.gz"));
    assert.ok(shardA.equals(shardB), "shards/sh.json.gz differs between two runs over the same fixture");
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

test("writeBuildOutput: manifest's shard_inventory reports the real per-shard size, and shards_published is false", async () => {
  // Fable ruling FR-t_30a53ba2-1: shards are still built and size-validated
  // but never uploaded as a release asset (GitHub's 1,000-asset-per-release
  // ceiling). The manifest must say so explicitly, and shard_inventory's
  // gz_bytes must match the shard file actually written to disk — a
  // fresh-context review flagged an earlier version of this as an
  // unverified array-alignment assumption (gz_bytes read out of a sibling
  // array by position rather than off the same entry as the gzip buffer).
  const rows = Array.from({ length: 20 }, (_, i) => fixtureRow({
    id: i + 1,
    url: `https://feeds.example.com/show${i + 1}`,
    title: `Show ${i + 1}`,
    itunesAuthor: `Author ${i % 3}`,
    popularityScore: (i * 37) % 97,
  }));
  const curatedShows = [{ show_id: "show-one", title: "Show 1", feed_url: "https://feeds.example.com/show1" }];
  const db = buildFixtureDb(rows);
  const outDir = mkdtempSync(join(tmpdir(), "shows-build-"));
  try {
    const result = runPipeline(db, { curatedShows, now: NOW });
    const manifest = await writeBuildOutput(result, { outDir, exportVersion: "v1", builtAt: "2026-09-05T00:00:00.000Z" });

    assert.equal(manifest.shards_published, false);
    assert.equal(manifest.shard_inventory.length, manifest.shard_count);

    for (const entry of manifest.shard_inventory) {
      const onDisk = readFileSync(join(outDir, "shards", `${entry.key}.json.gz`));
      assert.equal(entry.gz_bytes, onDisk.length, `shard_inventory gz_bytes for "${entry.key}" must match the real file size`);
      assert.ok(entry.row_count > 0, `shard_inventory row_count for "${entry.key}" must be positive`);
    }
  } finally {
    db.close();
    rmSync(outDir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------ #1033: the baseline -- */

const PREV_EXPORT = "Sat, 03 Oct 2026 23:18:00 GMT";
const BASE_URL = "https://github.com/org/repo/releases/download/shows-index-prev";

function snapshotGz(newest, { exportVersion = PREV_EXPORT, version = 1 } = {}) {
  return gzipSync(Buffer.from(JSON.stringify({ version, export_version: exportVersion, count: Object.keys(newest).length, newest })));
}

/** A committed-pointer stand-in plus a fake public fetch. `serve` is the body
    (Buffer) for the snapshot URL, a status number, or an Error to throw. */
async function baselineFixture(serve, { pointer = { export_version: PREV_EXPORT, asset_base_url: BASE_URL } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "shows-baseline-"));
  const pointerPath = join(dir, "shows-index-pointer.json");
  if (pointer !== null) await writeFile(pointerPath, JSON.stringify(pointer));
  const requests = [];
  const fetchImpl = async (url, opts = {}) => {
    requests.push({ url, opts });
    if (serve instanceof Error) throw serve;
    if (typeof serve === "number") return new Response("Not Found", { status: serve });
    return new Response(serve, { status: 200 });
  };
  return { dir, pointerPath, fetchImpl, requests, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const baselineRows = () => [
  fixtureRow({ id: 1, url: "https://feeds.example.com/one", title: "Alpha One", newestItemPubdate: monthsAgo(1) }),
  fixtureRow({ id: 2, url: "https://feeds.example.com/two", title: "Bravo Two", newestItemPubdate: monthsAgo(2) }),
  fixtureRow({ id: 3, url: "https://feeds.example.com/three", title: "Charlie Three", newestItemPubdate: monthsAgo(3) }),
];
const baselineCurated = [{ show_id: "alpha-one", title: "Alpha One", feed_url: "https://feeds.example.com/one" }];

test("#1033 snapshot round-trip: the asset a build writes is the baseline the next run reads back", async () => {
  /* MUTATION THAT KILLS THIS: delete the `writeFile(join(outDir,
     NEWEST_SNAPSHOT_ASSET), snapshotGz)` line in writeBuildOutput. The build
     still writes changed.json, but no snapshot exists for the release to
     ship, so the next week has no baseline again (readFile ENOENT here).
     Second mutation: store `null` instead of 0 for a dateless row in
     buildNewestSnapshot. parseNewestSnapshot rejects the whole snapshot (and
     buildChanged would call that row changed every week). Ran both: red. */
  const db = buildFixtureDb(baselineRows());
  const outDir = mkdtempSync(join(tmpdir(), "shows-build-"));
  try {
    const result = runPipeline(db, { curatedShows: baselineCurated, now: NOW });
    const manifest = await writeBuildOutput(result, { outDir, exportVersion: "v-next", builtAt: "2026-10-04T00:00:00.000Z" });
    const parsed = parseNewestSnapshot(await readFile(join(outDir, NEWEST_SNAPSHOT_ASSET)), { expectedExportVersion: "v-next" });
    assert.equal(parsed.ok, true, parsed.reason);
    assert.deepEqual(parsed.previousNewest, { 1: monthsAgo(1), 2: monthsAgo(2), 3: monthsAgo(3) });
    assert.equal(manifest.newest_snapshot.count, 3);
    assert.equal(manifest.newest_snapshot.asset, NEWEST_SNAPSHOT_ASSET);
    // A byte-identical re-import diffed against its own snapshot reports nothing.
    assert.deepEqual(buildChanged(result.canonical, parsed.previousNewest), { baseline: true, changed: [] });

    // A dateless row is listed as 0: unchanged next week, changed once it gains a date.
    const dateless = [{ id: 7, newestItemPubdate: null }];
    const snap = buildNewestSnapshot(dateless, { exportVersion: "v" });
    assert.deepEqual(snap.newest, { 7: 0 });
    const back = parseNewestSnapshot(gzipSync(Buffer.from(JSON.stringify(snap))));
    assert.equal(back.ok, true, back.reason);
    assert.deepEqual(buildChanged(dateless, back.previousNewest), { baseline: true, changed: [] });
    assert.deepEqual(buildChanged([{ id: 7, newestItemPubdate: 5 }], back.previousNewest), { baseline: true, changed: [7] });
  } finally {
    db.close();
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("#1033 the downloaded previous snapshot reaches buildChanged (baseline:true, only real changes)", async () => {
  /* MUTATION THAT KILLS THIS: in runPipelineWithBaseline, hand runPipeline
     `previousNewest: null` (the old hard-coded `const previousNewest = null`
     in main). changed.json goes back to { baseline:false, changed:null }.
     Ran it: red. */
  const prev = { 1: monthsAgo(4), 2: monthsAgo(2) }; // 1 advanced, 2 unchanged, 3 new since last release
  const fx = await baselineFixture(snapshotGz(prev));
  const db = buildFixtureDb(baselineRows());
  const logs = [];
  try {
    const { result, baseline } = await runPipelineWithBaseline(db, {
      curatedShows: baselineCurated, now: NOW, pointerPath: fx.pointerPath, fetchImpl: fx.fetchImpl, log: (m) => logs.push(m),
    });
    assert.deepEqual(result.changed, { baseline: true, changed: [1, 3] });
    assert.equal(baseline.count, 2);
    assert.equal(fx.requests.length, 1);
    assert.equal(fx.requests[0].url, `${BASE_URL}/${NEWEST_SNAPSHOT_ASSET}`, "fetched from the committed pointer's asset_base_url");
    const headers = new Headers(fx.requests[0].opts.headers || {});
    assert.equal(headers.has("authorization"), false, "a public asset: no token is sent");
    assert.ok(logs.some((m) => /^BASELINE: 2 ids from /.test(m)), logs.join("\n"));
  } finally {
    db.close();
    fx.cleanup();
  }
});

test("#1033 a failed download keeps baseline:false, logs why, and never fails the run", async () => {
  /* MUTATIONS THAT KILL THIS: (a) delete the `if (!res.ok)` guard in
     loadPreviousNewest, so a 404 page is parsed as a snapshot (the reason
     stops naming HTTP 404); (b) rethrow from the fetch catch instead of
     returning, so a network error escapes to the outer catch (the reason
     stops naming the download). Ran both: red. */
  const cases = [
    { name: "404 (a release from before #1033)", serve: 404, reason: /HTTP 404/ },
    { name: "network error", serve: Object.assign(new Error("getaddrinfo ENOTFOUND github.com"), { code: "ENOTFOUND" }), reason: /^download failed: getaddrinfo ENOTFOUND/ },
    { name: "no pointer file", serve: snapshotGz({ 1: 1 }), pointer: null, reason: /no readable pointer/ },
    { name: "pointer without asset_base_url", serve: snapshotGz({ 1: 1 }), pointer: { export_version: PREV_EXPORT }, reason: /no https asset_base_url/ },
  ];
  for (const c of cases) {
    const fx = await baselineFixture(c.serve, c.pointer === undefined ? {} : { pointer: c.pointer });
    const db = buildFixtureDb(baselineRows());
    const logs = [];
    try {
      const { result, baseline } = await runPipelineWithBaseline(db, {
        curatedShows: baselineCurated, now: NOW, pointerPath: fx.pointerPath, fetchImpl: fx.fetchImpl, log: (m) => logs.push(m),
      });
      assert.deepEqual(result.changed, { baseline: false, changed: null }, c.name);
      assert.equal(baseline.previousNewest, null, c.name);
      assert.match(baseline.reason, c.reason, c.name);
      assert.ok(logs.some((m) => m.startsWith("NO_BASELINE: ")), `${c.name}: the reason is logged`);
      assert.equal(result.canonical.length, 3, `${c.name}: the build itself still ran`);
    } finally {
      db.close();
      fx.cleanup();
    }
  }
});

test("#1033 never {}: an empty, malformed or mismatched snapshot is no baseline, not an all-changed diff", async () => {
  /* The data-tools-14 regression (shard-build.test.mjs pins buildChanged's
     half): `{}` as previousNewest lists EVERY show as changed and calls it a
     real index. MUTATIONS THAT KILL THIS: (a) make loadPreviousNewest's
     failure value `previousNewest: {}` instead of null; (b) delete the
     `count === 0` check in parseNewestSnapshot, so an empty snapshot passes
     as {}. Either one turns these into { baseline:true, changed:[1,2,3] }.
     Ran both: red. */
  const bad = [
    { name: "empty map", body: snapshotGz({}) },
    { name: "non-numeric value", body: snapshotGz({ 1: "yesterday" }) },
    { name: "wrong schema version", body: snapshotGz({ 1: 1 }, { version: 2 }) },
    { name: "another release's snapshot", body: snapshotGz({ 1: 1 }, { exportVersion: "Sat, 26 Sep 2026 23:18:00 GMT" }) },
    { name: "not gzip", body: Buffer.from("<html>rate limited</html>") },
  ];
  for (const c of bad) {
    const fx = await baselineFixture(c.body);
    const db = buildFixtureDb(baselineRows());
    try {
      const loaded = await loadPreviousNewest({ pointerPath: fx.pointerPath, fetchImpl: fx.fetchImpl });
      assert.equal(loaded.previousNewest, null, `${c.name}: null, never {}`);
      const { result } = await runPipelineWithBaseline(db, {
        curatedShows: baselineCurated, now: NOW, pointerPath: fx.pointerPath, fetchImpl: fx.fetchImpl, log: () => {},
      });
      assert.deepEqual(result.changed, { baseline: false, changed: null }, c.name);
    } finally {
      db.close();
      fx.cleanup();
    }
  }
  // And the failure path itself: a 404 is null too, not {}.
  const fx = await baselineFixture(404);
  try {
    assert.equal((await loadPreviousNewest({ pointerPath: fx.pointerPath, fetchImpl: fx.fetchImpl })).previousNewest, null);
  } finally {
    fx.cleanup();
  }
});

/* ---- CH2-12 (docs/roadmap/code-health-2.md, T1-12 / T1-03) ---- */

test("writeBuildOutput: under the unmapped ceiling it warns naming the show, builds, and records curated.total", async () => {
  // Characterization of the guard before it moved to config.mjs's
  // checkMissingMapping (shared with load-postgres.mjs).
  // MUTATION: drop the under-ceiling console.warn in checkMissingMapping -> red.
  // MUTATION: `curatedTotal` not returned to writeBuildOutput (manifest total undefined) -> red.
  const rows = Array.from({ length: 20 }, (_, i) =>
    fixtureRow({ id: i + 1, url: `https://feeds.example.com/s${i}`, title: `Distinct Show ${i}`, itunesAuthor: `Author ${i}` }));
  const curatedShows = [
    ...rows.map((r, i) => ({ show_id: `s-${i}`, title: r.title, feed_url: r.url })),
    { show_id: "ghost-show", title: "Ghost Show", feed_url: "https://nowhere.example.com/feed" },
  ];
  const db = buildFixtureDb(rows);
  const outDir = mkdtempSync(join(tmpdir(), "shows-build-"));
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    const result = runPipeline(db, { curatedShows, now: NOW });
    assert.equal(result.missing.length, 1);
    const manifest = await writeBuildOutput(result, { outDir, exportVersion: "v1", builtAt: "2026-09-05T00:00:00.000Z" });
    assert.equal(manifest.curated.total, 21);
    assert.equal(manifest.curated.mapped, 20);
    assert.deepEqual(manifest.curated.unmapped, [{ show_id: "ghost-show", title: "Ghost Show" }]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /^WARN: 1 of 21 curated show\(s\) are not in this dump/);
    assert.match(warnings[0], /ghost-show \(Ghost Show\)/);
  } finally {
    console.warn = realWarn;
    db.close();
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("checksumFile streams a sha256 of the dump, and import-dump.mjs hashes --dump-file through it", async () => {
  // MUTATION: checksumFile hashing anything but the file's bytes -> red.
  // MUTATION: an inline createReadStream/createHash copy back in import-dump.mjs's main -> red.
  const { checksumFile } = await import("./config.mjs");
  const dir = mkdtempSync(join(tmpdir(), "shows-checksum-"));
  try {
    const p = join(dir, "dump.db");
    const bytes = Buffer.from("not really sqlite, just bytes\n".repeat(5000));
    await writeFile(p, bytes);
    const { createHash } = await import("node:crypto");
    assert.equal(await checksumFile(p), createHash("sha256").update(bytes).digest("hex"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const src = readFileSync(new URL("./import-dump.mjs", import.meta.url), "utf8");
  assert.match(src, /import \{[^}]*\bchecksumFile\b[^}]*\} from "\.\/config\.mjs"/);
  assert.match(src, /await checksumFile\(dumpFileArg\)/);
  assert.doesNotMatch(src, /createReadStream/);
});

test("CH2-31: no local already-built marker — import-dump.mjs always builds, releaseExists is the one idempotency rule", () => {
  /* T1-15: state.mjs's "durable" marker file was never committed or
     cached, so its SKIP branch could fire only on a persistent workstation.
     It is deleted; this is the honest guard for the deletion.
     MUTATION: put `import { alreadyBuilt } from "./state.mjs"` (or an
     alreadyBuilt check) back in import-dump.mjs -> red. Ran it: red. */
  const src = readFileSync(new URL("./import-dump.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /\balreadyBuilt\b/);
  assert.doesNotMatch(src, /\.\/state\.mjs/);
  assert.doesNotMatch(src, /^\s*console\.log\(`SKIP:/m);
});
