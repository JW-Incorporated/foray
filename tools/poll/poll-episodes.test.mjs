/* The S-10 poller CLI (tools/poll/poll-episodes.mjs, PKG-08).
   Run:
   node --test tools/poll/poll-episodes.test.mjs

   No network, no database. The first two tests spawn a child `node` each,
   SEQUENTIALLY (node:test runs a file's tests one after another), to prove the
   exit code reaches the shell; neither passes --dry-run, so neither child
   loads a seed or the change index. Every other test calls runDryRun with an
   injected change index and a seed FIXTURE in a temp directory
   (data/watchlist-seed.json is not on main yet). Every test names the one-line
   mutation that turns it red; each was applied to poll-episodes.mjs, confirmed
   changed on disk, and seen to fail this suite.

   Harness audit (CLAUDE.md "a green test is not evidence"): the seed fixture
   rows have the shape build-watchlist-seed.mjs writes (show_id, title,
   feed_url, episode_count, pi_id, watch_reasons, tier, ...), and the fake
   index marks curated rows `c: true` in topRows exactly as top.json does, so
   the "changed" count cannot come from a curated row leaking into (c). */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DATABASE_URL_VARS, NO_DB_MESSAGE, resolveDatabaseUrl, runDryRun, main } from "./poll-episodes.mjs";
import * as sharedConfig from "../shows/config.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "poll-episodes.mjs");
const NOW = Date.UTC(2026, 9, 5, 12); // fixed so no test reads the clock

const tmp = () => mkdtempSync(path.join(tmpdir(), "poll-episodes-"));

/** A seed row as build-watchlist-seed.mjs writes it. */
const seedRow = (id, piId) => ({
  pi_id: piId,
  show_id: id,
  title: `Show ${id}`,
  feed_url: `https://feeds.${id}.example.com/rss`,
  watch_reasons: piId === null ? ["curated", "unmapped"] : ["curated"],
  episode_count: null,
  tier: "daily",
  next_due_at_ms: null,
  state: "active",
});

const SEED_ROWS = [seedRow("alpha", 11), seedRow("beta", 12), seedRow("gamma", null)];

function writeSeed(dir, rows = SEED_ROWS) {
  const p = path.join(dir, "seed.json");
  writeFileSync(p, JSON.stringify({ version: 1, built_at: "2026-10-01T00:00:00.000Z", pointer_release_tag: "t", rows }));
  return p;
}

const fakeIndex = () => ({
  ok: true,
  changedIds: new Set([11, 900, 901, 902]),
  idMap: { alpha: 11, beta: 12 },
  topRows: [
    { id: 11, t: "Show alpha", a: "", i: null, u: "https://feeds.alpha.example.com/rss", img: null, n: 10, c: true },
    { id: 900, t: "Top 900", a: "", i: null, u: "https://top.example.com/900.xml", img: null, n: 50, c: false },
    { id: 901, t: "Top 901", a: "", i: null, u: "https://top.example.com/901.xml", img: null, n: 50, c: false },
    { id: 902, t: "Top 902", a: "", i: null, u: "https://top.example.com/902.xml", img: null, n: 50, c: false },
  ],
});

const quiet = { log: () => {}, err: () => {} };

function scrubbedEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (DATABASE_URL_VARS.includes(k.toUpperCase())) delete env[k];
  return { ...env, ...extra };
}

test("no --dry-run and no DB env exits 0 naming gates G1 and G3", () => {
  // MUTATION: `log(NO_DB_MESSAGE); return 0;` -> `return 1;` -> red (status 1).
  const res = spawnSync(process.execPath, [CLI], { encoding: "utf8", timeout: 30_000, env: scrubbedEnv() });
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.match(res.stdout, /G1/);
  assert.match(res.stdout, /G3/);
  assert.ok(res.stdout.includes("HUMAN-ACTIONS.md"), res.stdout);
  assert.match(res.stdout, /nothing to do/);
});

test("no --dry-run with SHOWS_DATABASE_URL set refuses with exit 3", () => {
  // MUTATION: `log(LIVE_REFUSAL); return 3;` -> `return 0;` -> red (status 0).
  const res = spawnSync(process.execPath, [CLI], {
    encoding: "utf8",
    timeout: 30_000,
    env: scrubbedEnv({ SHOWS_DATABASE_URL: "postgres://user:pw@127.0.0.1:1/never" }),
  });
  assert.equal(res.status, 3, `stdout: ${res.stdout} stderr: ${res.stderr}`);
  assert.match(res.stdout, /live mode is not built \(PKG-10\); refusing/);
});

test("DATABASE_URL_VARS is exactly SHOWS_DATABASE_URL then DATABASE_URL", () => {
  // MUTATION: reorder to ["DATABASE_URL", "SHOWS_DATABASE_URL"] -> red.
  assert.deepEqual(DATABASE_URL_VARS, ["SHOWS_DATABASE_URL", "DATABASE_URL"]);
  assert.deepEqual(resolveDatabaseUrl({ DATABASE_URL: "b", SHOWS_DATABASE_URL: "a" }), { url: "a", varName: "SHOWS_DATABASE_URL" });
  assert.deepEqual(resolveDatabaseUrl({ DATABASE_URL: "b" }), { url: "b", varName: "DATABASE_URL" });
  assert.deepEqual(resolveDatabaseUrl({ SHOWS_DATABASE_URL: "" }), { url: null, varName: null });
});

test("runDryRun with a fake changeIndex writes the summary shape and fetched is 0", async () => {
  // MUTATION: delete the `projection,` key from the summary object -> red.
  // MUTATION: drop `topN` from the buildWatchlist call in runDryRun (falls back
  // to 5000, so changed row 902 is no longer cut) -> red (watchlist.total 6).
  const dir = tmp();
  try {
    const outPath = path.join(dir, "nested", "out.json");
    let loaderCalled = false;
    const res = await runDryRun({
      seedPath: writeSeed(dir),
      outPath,
      nowMs: NOW,
      topN: 2, // top.json's first two NON-curated rows: 900 and 901 (902 is changed but cut)
      changeIndex: fakeIndex(),
      loadIndex: async () => { loaderCalled = true; return { ok: false, reason: "must not be called" }; },
      ...quiet,
    });
    assert.equal(res.code, 0);
    assert.equal(loaderCalled, false, "an injected changeIndex replaces loadChangeIndex");
    const onDisk = JSON.parse(readFileSync(outPath, "utf8"));
    assert.deepEqual(onDisk, res.summary);
    assert.deepEqual(Object.keys(onDisk), [
      "version", "now", "top_n", "seed_rows", "seed_status", "change_index", "watchlist", "due", "skipped", "projection", "fetched",
    ]);
    assert.equal(onDisk.version, 1);
    assert.equal(onDisk.now, "2026-10-05T12:00:00.000Z");
    assert.equal(onDisk.fetched, 0);
    assert.equal(onDisk.seed_rows, 3);
    assert.equal(onDisk.seed_status, "ok");
    assert.deepEqual(onDisk.change_index, { ok: true, changed: 4, top_rows: 4 });
    assert.equal(onDisk.watchlist.total, 5); // 3 curated + 900 + 901
    assert.equal(onDisk.watchlist.mapped, 4); // gamma is unmapped
    assert.deepEqual(onDisk.watchlist.byReason, { changed_in_dump: 3, curated: 3, unmapped: 1 });
    assert.deepEqual(onDisk.watchlist.byTier, { daily: 3, weekly: 2 });
    assert.equal(onDisk.due.count, 5);
    assert.deepEqual(onDisk.due.byHost, {
      "top.example.com": 2,
      "feeds.alpha.example.com": 1,
      "feeds.beta.example.com": 1,
      "feeds.gamma.example.com": 1,
    });
    assert.deepEqual(onDisk.due.sample[0], { pi_id: 11, title: "Show alpha", feed_url: "https://feeds.alpha.example.com/rss", tier: "daily" });
    assert.equal(onDisk.due.sample.at(-1).pi_id, null, "the unmapped curated row sorts last and is still due");
    assert.deepEqual(onDisk.skipped, { dead: 0, notDue: 0, perRunCap: 0, perHostCap: 0, badUrl: 0 });
    assert.equal(onDisk.projection.requestsPerWeek, 3 * 7 + 2 * 1);
    assert.deepEqual(onDisk.projection.byTier, { daily: { rows: 3, requestsPerWeek: 21 }, weekly: { rows: 2, requestsPerWeek: 2 } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed change index still yields a dry run from the seed alone", async () => {
  // MUTATION: add `if (!indexOk) throw new Error(change_index.reason);` after
  // the change_index record -> red (rejects instead of code 0).
  const dir = tmp();
  try {
    const outPath = path.join(dir, "out.json");
    const res = await runDryRun({
      seedPath: writeSeed(dir),
      outPath,
      nowMs: NOW,
      loadIndex: async () => ({ ok: false, reason: "pointer is stale: test" }),
      ...quiet,
    });
    assert.equal(res.code, 0);
    const s = JSON.parse(readFileSync(outPath, "utf8"));
    assert.deepEqual(s.change_index, { ok: false, reason: "pointer is stale: test" });
    assert.ok(s.due.count > 0);
    assert.equal(s.due.count, 3);
    assert.equal(s.watchlist.total, 3);
    // the seed's numeric pi_id survives an ok:false index (buildWatchlist rule (a))
    assert.equal(s.watchlist.mapped, 2);
    assert.equal(s.projection.requestsPerWeek, 21);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the printed line carries the 40,000 target", async () => {
  // MUTATION: delete ` (target < ${TARGET_REQUESTS_PER_WEEK})` from the line -> red.
  const dir = tmp();
  try {
    const lines = [];
    const res = await runDryRun({
      seedPath: writeSeed(dir),
      outPath: path.join(dir, "out.json"),
      nowMs: NOW,
      topN: 2,
      changeIndex: fakeIndex(),
      log: (l) => lines.push(l),
      err: () => {},
    });
    assert.deepEqual(lines, [res.line]);
    assert.equal(res.line, "dry-run: 5 due of 5 watched; 23/week projected at N=2 (target < 40000); fetched 0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an absent default seed degrades to an empty run; a named missing or malformed seed exits 1", async () => {
  // MUTATION: in loadSeed, drop `&& !required` from the ENOENT branch -> red
  // (a named missing seed returns 0 and writes a file).
  // MUTATION: delete the `!Array.isArray(seed.rows)` check -> red (buildWatchlist
  // throws on a seed with no rows instead of exit 1).
  const dir = tmp();
  try {
    const missing = path.join(dir, "no-such-seed.json");
    const errs = [];
    const absent = await runDryRun({
      seedPath: missing,
      outPath: path.join(dir, "absent.json"),
      nowMs: NOW,
      changeIndex: { ok: false, reason: "late" },
      log: () => {},
      err: (l) => errs.push(l),
    });
    assert.equal(absent.code, 0);
    assert.equal(absent.summary.seed_rows, 0);
    assert.match(absent.summary.seed_status, /^missing: no seed at /);
    assert.equal(absent.summary.due.count, 0);
    assert.ok(errs.some((l) => l.includes("continuing with no seed rows")), errs.join("\n"));

    const namedOut = path.join(dir, "named.json");
    const named = await main({ argv: ["--dry-run", "--seed", missing, "--out", namedOut], changeIndex: { ok: false, reason: "late" }, ...quiet });
    assert.equal(named, 1);
    assert.equal(existsSync(namedOut), false);

    const badSeed = path.join(dir, "bad.json");
    writeFileSync(badSeed, JSON.stringify({ version: 1 }));
    const badOut = path.join(dir, "bad-out.json");
    const bad = await runDryRun({ seedPath: badSeed, outPath: badOut, nowMs: NOW, changeIndex: { ok: false, reason: "late" }, ...quiet });
    assert.equal(bad.code, 1);
    assert.equal(existsSync(badOut), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---- CH2-12 (docs/roadmap/code-health-2.md, T1-12): one DATABASE_URL rule ---- */

test("a whitespace-only DATABASE_URL is UNSET: no --dry-run exits 0, not the live refusal; the resolver is config.mjs's", async () => {
  // MUTATION: a private `if (env[v])` resolver back in poll-episodes.mjs -> red
  // (exit 3 LIVE_REFUSAL, and the identity check). The rule is load-postgres's
  // (whitespace is unset), shared through tools/shows/config.mjs.
  const lines = [];
  const code = await main({ argv: [], env: { DATABASE_URL: " ", SHOWS_DATABASE_URL: "\t" }, log: (l) => lines.push(l), err: () => {} });
  assert.equal(code, 0);
  assert.deepEqual(lines, [NO_DB_MESSAGE]);
  assert.equal(resolveDatabaseUrl, sharedConfig.resolveDatabaseUrl);
  assert.equal(DATABASE_URL_VARS, sharedConfig.DATABASE_URL_VARS);
});

/** Every module specifier `file` imports (static, re-export, bare and dynamic). */
function specifiersOf(file) {
  const src = readFileSync(file, "utf8");
  const re = /(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g;
  return [...src.matchAll(re)].map((m) => m[1]);
}

test("importing tools/shows/config.mjs loads neither pg-copy-streams, pg nor node:sqlite (this CLI's import contract)", () => {
  // MUTATION: `import { from } from "pg-copy-streams";` (or "node:sqlite") added
  // to tools/shows/config.mjs, or to anything it imports -> red.
  const seen = new Set();
  const external = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const spec of specifiersOf(file)) {
      if (spec.startsWith(".")) walk(path.resolve(path.dirname(file), spec));
      else external.add(spec);
    }
  };
  walk(path.join(HERE, "..", "shows", "config.mjs"));
  for (const heavy of ["pg-copy-streams", "pg", "node:sqlite", "sqlite"]) {
    assert.ok(!external.has(heavy), `config.mjs's import graph pulls ${heavy}: ${[...external].join(", ")}`);
  }
  assert.ok(seen.size >= 2, "the walk followed config.mjs's relative imports");
});
