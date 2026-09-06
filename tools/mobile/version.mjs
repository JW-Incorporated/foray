#!/usr/bin/env node
/* One version number for both platforms — R-02 (docs/release-lockstep-plan.md).
 *
 * WHY THIS FILE EXISTS
 * Before this, the marketing version was hardcoded (`MARKETING_VERSION 1.0` in
 * the iOS build) and the build number was computed two different, unrelated
 * ways per platform: iOS used `run_number.run_attempt`, Android took a
 * `versionCode` typed by a human into a workflow_dispatch box every single
 * upload (`android-release.yml`'s `version_code` input — see its own comment
 * on why a bare `.toInteger()` on a mistyped `1.0.0` blows up twenty-five
 * minutes into a build with no useful message). Two workflows computing two
 * different numbers for what is supposed to be one release is exactly the
 * kind of "green, plausible, and silently not doing the job" this repo keeps
 * getting burned by (see `mobile/gradle/foray-signing.gradle`'s own header).
 *
 * So there is now exactly one source for each half, both PURE and both
 * callable identically from the macOS shell (`ios-build.yml`) and the Ubuntu
 * shell (`android-release.yml`):
 *
 *   readMarketingVersion()          -> the dotted string from `mobile/VERSION`
 *   buildNumber({ now, runOfDay })  -> an integer YYYYMMDDnn
 *
 * WHY `mobile/VERSION` AND NOT A JSON FILE OR `mobile/package.json`
 * `mobile/package.json`'s own `version` field is Capacitor/npm's concern (it
 * feeds nothing store-facing) and mixing the two would make an `npm install`
 * bump look like a release bump. A single bare line is the smallest tracked
 * surface a human can read, diff and edit without tooling, and it is under
 * `mobile/` so a version bump gets the same human-review gate as
 * `foray-signing.gradle` (`docs/... "A NOTE ON THE TWO WORDS"` — `mobile/` is
 * never auto-merged).
 *
 * WHY THE BUILD NUMBER IS `YYYYMMDDnn` AND NOT A RUN COUNTER
 * `ios-build.yml`'s own history is why: it used to derive `CFBundleVersion`
 * from `run_number.run_attempt`, and a RE-RUN of a run that already uploaded
 * kept the same `run_number` and reproduced the exact "duplicate build
 * number" rejection from App Store Connect (`ERROR -19232`, documented at
 * length in that workflow). A date-keyed number does not have that failure
 * mode: every calendar day starts a fresh, independent counter, so a stale
 * `run_number` from a re-run has no way to collide with anything from a
 * later day, and a human reading `2026090601` can tell what day it shipped
 * without cross-referencing a run log.
 *
 * THE FORMAT HAS EXACTLY TWO DIGITS OF HEADROOM FOR "WHICH RUN TODAY"
 * (`nn`, 01-99). That is enough: this repo does not (and per the cost
 * comments in `ios-build.yml` / `android-release.yml`, should not) upload
 * more than a handful of builds in one calendar day, macOS runners bill at
 * 10x. `buildNumber` refuses a `runOfDay` outside 1-99 rather than silently
 * truncating it, because a silently truncated run counter is a second copy
 * of the exact "looks fine, uploads a duplicate" failure this file exists to
 * retire. WHO computes `runOfDay` is deliberately NOT this file's problem —
 * that is a release-workflow concern (a counter file, `run_attempt`, or a
 * store API query), decided in R-03 (t_c4feac52) — `buildNumber` only turns a
 * `{ now, runOfDay }` pair into the one correct integer, the same way from
 * both shells.
 *
 * WHY int32 IS FINE FOR PLAY WITHOUT A RUNTIME CHECK ON EVERY CALL
 * Play's `versionCode` is a positive 32-bit integer, ceiling 2,147,483,647.
 * The worst case this format can ever produce is 31 Dec 2099, run 99:
 * `2099123199` — still under the ceiling by nearly 50 million. That is
 * asserted once, in the test file, as a comment-and-code pair rather than a
 * live bounds check here, because the check would never be able to fail
 * before this century ends and a runtime branch that can never execute is
 * dead code wearing a safety costume.
 *
 * CLI — THE THING BOTH WORKFLOW SHELLS ACTUALLY CALL
 *   node tools/mobile/version.mjs marketing-version
 *   node tools/mobile/version.mjs build-number [--run-of-day N] [--now ISO]
 *   node tools/mobile/version.mjs pair          [--run-of-day N] [--now ISO]
 *   node tools/mobile/version.mjs bump <major|minor|patch>
 *
 * `pair` is the one both workflows are expected to call (wiring is R-03's
 * job, not this card's): it prints `KEY=VALUE` lines that are byte-identical
 * given byte-identical `--now`/`--run-of-day`, on macOS bash or Ubuntu bash,
 * because the underlying functions are pure and the CLI does nothing but
 * format their output — which is also exactly what the test file asserts by
 * spawning the CLI twice and diffing stdout.
 *
 * `--now`/`--run-of-day` exist so a workflow (or a test) can PIN the inputs
 * instead of depending on wall-clock — the same reason `foray-signing.gradle`
 * reads its inputs once at configuration time rather than re-deriving them.
 * With no `--now`, `new Date()` is used, which is the only place non-determinism
 * enters this file, and it never enters `buildNumber`/`readMarketingVersion`
 * themselves — both of those are pure and unit-tested with no clock at all.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..");

/** The tracked source of truth for the marketing (user-visible) version. */
export const VERSION_FILE = path.join(REPO_ROOT, "mobile", "VERSION");

/** Play's ceiling for `versionCode`, a positive 32-bit signed integer. */
export const PLAY_VERSION_CODE_CEILING = 2147483647;

export class VersionError extends Error {}

/** `X.Y.Z`, three non-negative integers, no leading `v`, no pre-release tag —
 *  the one shape both `MARKETING_VERSION` (iOS) and `FORAY_VERSION_NAME`
 *  (Android) are handed as-is. */
const MARKETING_VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;

/** Read the tracked marketing version.
 *
 *  Throws rather than returning something malformed: a version string with
 *  trailing whitespace or a stray `v` prefix reaching `xcodebuild` or Gradle
 *  fails many steps downstream with a message that does not point back here.
 */
export function readMarketingVersion(file = VERSION_FILE) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    throw new VersionError(`could not read ${file}: ${err.message}`);
  }
  const trimmed = text.trim();
  if (!MARKETING_VERSION_RE.test(trimmed)) {
    throw new VersionError(
      `${file} contains '${trimmed}', which is not a plain X.Y.Z version (no 'v' prefix, no pre-release tag)`
    );
  }
  return trimmed;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

/** An integer `YYYYMMDDnn`, computed the same way regardless of the caller's
 *  timezone (UTC fields only) or platform.
 *
 *  @param {{now?: Date, runOfDay?: number}} opts
 *    `now` defaults to `new Date()`; pin it for a reproducible call.
 *    `runOfDay` defaults to 1; must be an integer in [1, 99].
 */
export function buildNumber({ now = new Date(), runOfDay = 1 } = {}) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new VersionError(`buildNumber: 'now' is not a valid Date (${now})`);
  }
  if (!Number.isInteger(runOfDay) || runOfDay < 1 || runOfDay > 99) {
    throw new VersionError(
      `buildNumber: runOfDay must be an integer 1-99 (got ${runOfDay}) — the YYYYMMDDnn format only has two digits for it`
    );
  }
  const year = now.getUTCFullYear();
  if (year < 1000 || year > 9999) {
    // Four YYYY digits are assumed everywhere below; this repo will not be
    // shipping releases in year 10000, but a wrong Date should fail loudly
    // rather than emit a number with the wrong digit count.
    throw new VersionError(`buildNumber: year ${year} does not fit the YYYY slot of YYYYMMDDnn`);
  }
  const month = pad2(now.getUTCMonth() + 1);
  const day = pad2(now.getUTCDate());
  const run = pad2(runOfDay);
  return Number(`${year}${month}${day}${run}`);
}

/** Bump the tracked marketing version and write it back.
 *
 *  Ordinary semver reset rule: bumping `major` zeroes minor+patch, bumping
 *  `minor` zeroes patch, bumping `patch` touches nothing else.
 *
 *  @param {"major"|"minor"|"patch"} part
 *  @param {string} file  override for tests; defaults to the tracked file
 *  @returns {string} the new version, already written to `file`
 */
export function bumpMarketingVersion(part, file = VERSION_FILE) {
  if (!["major", "minor", "patch"].includes(part)) {
    throw new VersionError(`bumpMarketingVersion: part must be 'major', 'minor' or 'patch' (got '${part}')`);
  }
  const current = readMarketingVersion(file);
  const match = MARKETING_VERSION_RE.exec(current);
  let [major, minor, patch] = [match[1], match[2], match[3]].map(Number);
  if (part === "major") {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (part === "minor") {
    minor += 1;
    patch = 0;
  } else {
    patch += 1;
  }
  const next = `${major}.${minor}.${patch}`;
  fs.writeFileSync(file, `${next}\n`, "utf8");
  return next;
}

/* ─────────────────────────────── CLI ─────────────────────────────────────── */

function parseCliOpts(args) {
  const opts = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--run-of-day") {
      opts.runOfDay = Number(args[++i]);
    } else if (args[i] === "--now") {
      opts.now = args[++i];
    }
  }
  return opts;
}

function resolveNowRunOfDay(opts) {
  const now = opts.now !== undefined ? new Date(opts.now) : new Date();
  const runOfDay = opts.runOfDay !== undefined ? opts.runOfDay : 1;
  return { now, runOfDay };
}

function main(argv) {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case "marketing-version": {
        console.log(readMarketingVersion());
        return 0;
      }
      case "build-number": {
        const { now, runOfDay } = resolveNowRunOfDay(parseCliOpts(rest));
        console.log(String(buildNumber({ now, runOfDay })));
        return 0;
      }
      case "pair": {
        const { now, runOfDay } = resolveNowRunOfDay(parseCliOpts(rest));
        console.log(`MARKETING_VERSION=${readMarketingVersion()}`);
        console.log(`BUILD_NUMBER=${buildNumber({ now, runOfDay })}`);
        return 0;
      }
      case "bump": {
        const part = rest[0];
        console.log(bumpMarketingVersion(part));
        return 0;
      }
      default: {
        console.error(
          "usage: node tools/mobile/version.mjs <marketing-version|build-number|pair|bump> [--run-of-day N] [--now ISO] [part]"
        );
        return 2;
      }
    }
  } catch (err) {
    console.error(err instanceof VersionError ? err.message : err);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
