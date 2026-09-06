import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  readMarketingVersion,
  buildNumber,
  bumpMarketingVersion,
  VersionError,
  PLAY_VERSION_CODE_CEILING,
  VERSION_FILE,
} from "./version.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "version.mjs");

function tmpVersionFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foray-version-test-"));
  const file = path.join(dir, "VERSION");
  fs.writeFileSync(file, content, "utf8");
  return file;
}

test("mobile/VERSION is tracked, seeded, and readable as-is", () => {
  assert.ok(fs.existsSync(VERSION_FILE), "mobile/VERSION must exist and be tracked");
  const version = readMarketingVersion();
  assert.match(version, /^\d+\.\d+\.\d+$/);
});

test("readMarketingVersion trims trailing newline/whitespace", () => {
  const file = tmpVersionFile("1.2.3\n");
  assert.equal(readMarketingVersion(file), "1.2.3");
});

test("readMarketingVersion rejects a 'v' prefix", () => {
  const file = tmpVersionFile("v1.2.3\n");
  assert.throws(() => readMarketingVersion(file), VersionError);
});

test("readMarketingVersion rejects a pre-release tag", () => {
  const file = tmpVersionFile("1.2.3-beta.1\n");
  assert.throws(() => readMarketingVersion(file), VersionError);
});

test("readMarketingVersion rejects a missing file", () => {
  assert.throws(() => readMarketingVersion("/nonexistent/path/VERSION"), VersionError);
});

test("buildNumber: monotonic across two runs in one day", () => {
  const now = new Date("2026-09-06T12:00:00Z");
  const run1 = buildNumber({ now, runOfDay: 1 });
  const run2 = buildNumber({ now, runOfDay: 2 });
  assert.ok(run2 > run1, `${run2} should be > ${run1}`);
  assert.equal(run1, 2026090601);
  assert.equal(run2, 2026090602);
});

test("buildNumber: monotonic across a day boundary (day D run 99 < day D+1 run 1)", () => {
  const dayD = buildNumber({ now: new Date("2026-09-06T23:59:59Z"), runOfDay: 99 });
  const dayD1 = buildNumber({ now: new Date("2026-09-07T00:00:00Z"), runOfDay: 1 });
  assert.ok(dayD1 > dayD, `${dayD1} should be > ${dayD}`);
  assert.equal(dayD, 2026090699);
  assert.equal(dayD1, 2026090701);
});

test("buildNumber: uses UTC fields, not local time zone", () => {
  // 2026-09-06T23:30:00-05:00 is 2026-09-07T04:30:00Z — must land on the 7th.
  const now = new Date("2026-09-06T23:30:00-05:00");
  assert.equal(buildNumber({ now, runOfDay: 1 }), 2026090701);
});

test("buildNumber: rejects runOfDay outside 1-99", () => {
  const now = new Date("2026-09-06T00:00:00Z");
  assert.throws(() => buildNumber({ now, runOfDay: 0 }), VersionError);
  assert.throws(() => buildNumber({ now, runOfDay: 100 }), VersionError);
  assert.throws(() => buildNumber({ now, runOfDay: 1.5 }), VersionError);
});

test("buildNumber: rejects an invalid Date", () => {
  assert.throws(() => buildNumber({ now: new Date("not-a-date"), runOfDay: 1 }), VersionError);
});

test("buildNumber: worst case (2099-12-31, run 99) fits Play's int32 versionCode ceiling", () => {
  const worstCase = buildNumber({ now: new Date("2099-12-31T00:00:00Z"), runOfDay: 99 });
  assert.equal(worstCase, 2099123199);
  // Stated explicitly, per the card's acceptance criterion: 2,099,123,199 is
  // comfortably under Play's 2,147,483,647 (2^31 - 1) ceiling for a signed
  // 32-bit versionCode, with ~48.4 million of headroom to spare.
  assert.ok(worstCase < PLAY_VERSION_CODE_CEILING, `${worstCase} must be < ${PLAY_VERSION_CODE_CEILING}`);
  assert.equal(PLAY_VERSION_CODE_CEILING, 2147483647);
});

test("bumpMarketingVersion: patch increments only the patch digit", () => {
  const file = tmpVersionFile("1.2.3\n");
  assert.equal(bumpMarketingVersion("patch", file), "1.2.4");
  assert.equal(readMarketingVersion(file), "1.2.4");
});

test("bumpMarketingVersion: minor increments minor and resets patch", () => {
  const file = tmpVersionFile("1.2.3\n");
  assert.equal(bumpMarketingVersion("minor", file), "1.3.0");
});

test("bumpMarketingVersion: major increments major and resets minor+patch", () => {
  const file = tmpVersionFile("1.2.3\n");
  assert.equal(bumpMarketingVersion("major", file), "2.0.0");
});

test("bumpMarketingVersion: rejects an unknown part", () => {
  const file = tmpVersionFile("1.2.3\n");
  assert.throws(() => bumpMarketingVersion("bogus", file), VersionError);
});

test("bumpMarketingVersion: never touches the tracked mobile/VERSION file (isolation check)", () => {
  const before = readMarketingVersion();
  const file = tmpVersionFile("9.9.9\n");
  bumpMarketingVersion("major", file);
  assert.equal(readMarketingVersion(), before, "the real tracked file must be untouched by a test using its own tmp copy");
});

test("CLI: marketing-version prints the tracked version", () => {
  const out = execFileSync("node", [CLI, "marketing-version"], { encoding: "utf8" });
  assert.equal(out.trim(), readMarketingVersion());
});

test("CLI: build-number prints the integer for pinned --now/--run-of-day", () => {
  const out = execFileSync(
    "node",
    [CLI, "build-number", "--now", "2026-09-06T12:00:00Z", "--run-of-day", "3"],
    { encoding: "utf8" }
  );
  assert.equal(out.trim(), "2026090603");
});

test("CLI: pair prints MARKETING_VERSION/BUILD_NUMBER as KEY=VALUE lines", () => {
  const out = execFileSync(
    "node",
    [CLI, "pair", "--now", "2026-09-06T12:00:00Z", "--run-of-day", "1"],
    { encoding: "utf8" }
  );
  const lines = out.trim().split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^MARKETING_VERSION=\d+\.\d+\.\d+$/);
  assert.equal(lines[1], "BUILD_NUMBER=2026090601");
});

test("CLI: 'pair' called twice with identical pinned inputs is byte-identical — the acceptance criterion that both workflow shells must agree", () => {
  const args = [CLI, "pair", "--now", "2026-09-06T12:00:00Z", "--run-of-day", "7"];
  const first = execFileSync("node", args, { encoding: "utf8" });
  const second = execFileSync("node", args, { encoding: "utf8" });
  assert.equal(first, second, "two independent calls (standing in for the iOS and Android workflow shells) must print the identical pair");
});

test("CLI: no arguments prints usage and exits 2", () => {
  assert.throws(() => execFileSync("node", [CLI], { encoding: "utf8" }), (err) => err.status === 2);
});

test("CLI: bump writes back to the tracked file when no override is given", () => {
  // Run the CLI's bump against a throwaway copy of the repo file via cwd
  // trickery is unnecessary — bump's file default only matters via the
  // library API tested above; the CLI wraps bumpMarketingVersion() directly
  // with no override argument, exercised here only for exit-code shape.
  const before = readMarketingVersion();
  const out = execFileSync("node", [CLI, "bump", "patch"], { encoding: "utf8" });
  const after = readMarketingVersion();
  assert.equal(out.trim(), after);
  // Restore the tracked file so this test suite is idempotent / repeatable.
  fs.writeFileSync(VERSION_FILE, `${before}\n`, "utf8");
  assert.equal(readMarketingVersion(), before);
});
