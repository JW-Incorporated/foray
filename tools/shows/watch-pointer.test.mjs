/* Tests for the shows-index pointer watchdog (tools/shows/watch-pointer.mjs).
 *   Run: node --test tools/shows/watch-pointer.test.mjs
 *
 * The watchdog's whole value is that it goes red BEFORE loadChangeIndex()'s
 * ceiling is crossed, so the suite proves both edges of the alarm, every way a
 * pointer can be unusable, and that the alarm stays below the ceiling defined
 * in tools/refresh/candidates.mjs (imported from there and pinned by value, so
 * a change there is a visible decision here).
 *
 * Every test names the one-line mutation that makes it fail. All were run.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { CEILING_HOURS, DEFAULT_POINTER, THRESHOLD_HOURS, pointerVerdict, run } from "./watch-pointer.mjs";
import { MAX_INDEX_AGE_HOURS, loadChangeIndex } from "../refresh/candidates.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const SCRIPT = path.join(HERE, "watch-pointer.mjs");
const PUBLISHED = "2026-10-04T23:32:30.065Z";
const H = 3_600_000;
const at = (hours) => new Date(Date.parse(PUBLISHED) + hours * H).toISOString();

function tmpPointer(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watch-pointer-"));
  const file = path.join(dir, "shows-index-pointer.json");
  if (content !== undefined) fs.writeFileSync(file, content);
  return file;
}

function cli(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const healthy = JSON.stringify({ version: 2, published_at: PUBLISHED, asset_base_url: "https://example.invalid/x" });

// Mutation: THRESHOLD_HOURS = 24 * 9 (alarm at the ceiling instead of a day before) -> fails.
test("193 h old is red, with a one-line reason on stderr and exit 1", () => {
  const r = cli(["--pointer", tmpPointer(healthy), "--now", at(193)]);
  assert.equal(r.code, 1);
  assert.equal(r.out, "");
  assert.match(r.err, /^RED: shows-index pointer published_at 2026-10-04T23:32:30\.065Z is 193\.0h old/);
  assert.equal(r.err.trimEnd().split("\n").length, 1, "the reason is exactly one line");
});

// Mutation: THRESHOLD_HOURS = 24 * 7 (an alarm that fires on a healthy week) -> fails.
test("191 h old is green, exit 0", () => {
  const r = cli(["--pointer", tmpPointer(healthy), "--now", at(191)]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^ok: shows-index pointer published_at .* is 191\.0h old/);
});

// Mutation: `ageHours > thresholdHours` -> `ageHours >= thresholdHours` -> fails.
test("exactly 192 h is still green (red means OVER 192 h)", () => {
  assert.equal(pointerVerdict({ pointerText: healthy, now: Date.parse(at(192)) }).ok, true);
  assert.equal(pointerVerdict({ pointerText: healthy, now: Date.parse(at(192)) + 1 }).ok, false);
});

// Mutation: drop the Number.isNaN(publishedAt) guard (NaN > 192 is false -> green) -> fails.
test("a missing published_at is red", () => {
  const r = cli(["--pointer", tmpPointer(JSON.stringify({ version: 2 })), "--now", at(1)]);
  assert.equal(r.code, 1);
  assert.match(r.err, /^RED: pointer has no parseable published_at \(null\)/);
});

// Mutation: same guard dropped, or `Date.parse(raw)` accepted for any type -> fails.
test("an unparseable or non-string published_at is red", () => {
  for (const bad of ["not a date", "", 1759620750065, null, {}, [PUBLISHED]]) {
    const v = pointerVerdict({ pointerText: JSON.stringify({ published_at: bad }), now: Date.parse(at(1)) });
    assert.equal(v.ok, false, `published_at=${JSON.stringify(bad)} must be red`);
    assert.match(v.line, /no parseable published_at/);
  }
});

// Mutation: remove the readFileSync try/catch (crash with a stack trace, not one line) -> fails.
test("an unreadable (missing) pointer is red with one line", () => {
  const missing = tmpPointer(undefined);
  const r = cli(["--pointer", missing, "--now", at(1)]);
  assert.equal(r.code, 1);
  assert.match(r.err, /^RED: pointer unreadable \(/);
  assert.equal(r.err.trimEnd().split("\n").length, 1, "the reason is exactly one line");
});

// Mutation: remove the JSON.parse try/catch -> fails (throws instead of a verdict).
test("a pointer that is not JSON is red", () => {
  const r = cli(["--pointer", tmpPointer("{ truncated"), "--now", at(1)]);
  assert.equal(r.code, 1);
  assert.match(r.err, /^RED: pointer is not JSON/);
  assert.equal(pointerVerdict({ pointerText: "null", now: Date.parse(at(1)) }).ok, false);
});

// Mutation: `Date.now()` used even when --now is given, or a bad --now read as NaN -> green -> fails.
test("--now is honoured, and an unparseable --now is red rather than silently 'now'", () => {
  assert.equal(run(["--pointer", tmpPointer(healthy), "--now", at(500)]).code, 1);
  const r = run(["--pointer", tmpPointer(healthy), "--now", "yesterday-ish"]);
  assert.equal(r.code, 1);
  assert.match(r.line, /--now is not a parseable date/);
});

// Mutation: DEFAULT_POINTER pointing anywhere but data/shows-index-pointer.json -> fails.
test("with no --pointer it reads the real data/shows-index-pointer.json", () => {
  assert.equal(DEFAULT_POINTER, path.join(ROOT, "data", "shows-index-pointer.json"));
  const real = JSON.parse(fs.readFileSync(DEFAULT_POINTER, "utf8"));
  const r = run(["--now", new Date(Date.parse(real.published_at) + H).toISOString()]);
  assert.equal(r.code, 0, r.line);
});

// Mutation: candidates.mjs's MAX_INDEX_AGE_HOURS changed from `24 * 9`, loadChangeIndex's
// default retyped as a literal other than it (e.g. `maxAgeHours = 24 * 10`), CEILING_HOURS
// retyped as a literal other than 216, or THRESHOLD_HOURS raised to >= 216 -> fails. (No test
// can tell `CEILING_HOURS = 216` from the import; only a different value is visible.)
test("the alarm stays below loadChangeIndex's ceiling (imported from tools/refresh/candidates.mjs)", async () => {
  /* CH2-14 (T1-14): an import equality, not a regex over the source text. The
     ceiling is candidates.mjs's exported MAX_INDEX_AGE_HOURS; the pointer
     probes below prove loadChangeIndex's DEFAULT really is that number, which
     the import alone could not. */
  const ceiling = MAX_INDEX_AGE_HOURS;
  assert.equal(ceiling, 216, "loadChangeIndex's ceiling moved; re-derive THRESHOLD_HOURS deliberately");
  assert.equal(CEILING_HOURS, ceiling);
  const pointerPath = tmpPointer(healthy);
  const noFetch = async () => { throw new Error("probe: past the staleness check"); };
  const stale = await loadChangeIndex({ pointerPath, fetchImpl: noFetch, now: Date.parse(at(ceiling + 0.5)) });
  assert.match(stale.reason, new RegExp(`^pointer is stale: .*\\(ceiling ${ceiling}h\\)$`));
  const fresh = await loadChangeIndex({ pointerPath, fetchImpl: noFetch, now: Date.parse(at(ceiling - 0.5)) });
  assert.equal(fresh.reason, "fetch error: probe: past the staleness check");
  assert.ok(THRESHOLD_HOURS < ceiling, `alarm ${THRESHOLD_HOURS}h must be below the ${ceiling}h ceiling`);
  assert.ok(ceiling - THRESHOLD_HOURS >= 24, "shows-pointer-watch runs daily: the margin must be at least one day");
});

// Mutation: drop the `stale at` clause from the red line -> fails.
test("the red line says when the pointer actually goes stale", () => {
  const v = pointerVerdict({ pointerText: healthy, now: Date.parse(at(200)) });
  assert.match(v.line, /stale at 2026-10-13T23:32:30\.065Z/);
});

// Mutation: move the job back into nightly-watch.yml (manually disabled, so it
// would never run), make the cron less than daily, or widen the token -> fails.
test("the watchdog runs daily in its own read-only workflow, not in the disabled nightly-watch.yml", () => {
  const wf = path.join(ROOT, ".github", "workflows");
  const yml = fs.readFileSync(path.join(wf, "shows-pointer-watch.yml"), "utf8");
  assert.match(yml, /^\s+run: \|\n\s+if node tools\/shows\/watch-pointer\.mjs; then exit 0; fi$/m);
  const cron = yml.match(/^\s+- cron: "(\d+) (\d+) \* \* \*"$/m);
  assert.ok(cron, "shows-pointer-watch.yml must run every day (the 24h margin assumes it)");
  assert.notEqual(cron[1], "0", "keep the cron off :00");
  const perms = yml.match(/^permissions:\n((?:[ #].*\n|\n)*)/m);
  assert.ok(perms, "no top-level permissions block");
  const scopes = [...perms[1].matchAll(/^ {2}([\w-]+): (\w+)/gm)].map((m) => `${m[1]}: ${m[2]}`);
  assert.deepStrictEqual(scopes, ["contents: read", "actions: read"]);
  assert.doesNotMatch(yml, /secrets\./, "the watchdog holds no secret");
  assert.doesNotMatch(fs.readFileSync(path.join(wf, "nightly-watch.yml"), "utf8"), /watch-pointer/);
});
