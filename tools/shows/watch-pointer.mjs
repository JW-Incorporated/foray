#!/usr/bin/env node
/* The shows-index pointer watchdog. Watches for an ABSENCE.
 *
 * WHY THIS EXISTS
 * `data/shows-index-pointer.json` is rewritten once a week by
 * `.github/workflows/shows-import.yml` (Sun 06:07 UTC) and reaches `main` as a
 * PR. `tools/refresh/candidates.mjs`'s loadChangeIndex() refuses a pointer
 * older than its `maxAgeHours` ceiling (24 * 9 = 216 h) and the nightly scan
 * falls back to a full scan. That fallback is correct and quiet, and quiet is
 * the problem: the scheduled imports of 2026-09-06, 09-13, 09-20, 09-27 and
 * 10-04 all failed and nobody noticed, because nothing watched the POINTER.
 *
 * A failed import RUN already shows red in the workflow list. What nothing
 * covered is a pointer that never reaches `main` for any OTHER reason: a
 * stranded pointer PR, red CI on that PR, an approval step nobody clicks
 * (#1038), a schedule that does not fire, or an idempotent skip. Every one of
 * those leaves every run green while the pointer quietly ages out.
 *
 * WHAT IT CHECKS
 * One thing: the age of the pointer's `published_at`. Older than
 * THRESHOLD_HOURS (192 h, 8 days) is red. A pointer that cannot be read, or
 * has no parseable `published_at`, is red too, because that is a pointer
 * loadChangeIndex() already refuses.
 *
 * WHY 192 h
 * It is loadChangeIndex()'s 216 h ceiling minus one day.
 * `.github/workflows/shows-pointer-watch.yml` runs it once a day, so a 24 h margin is the smallest one that guarantees at
 * least one red run BEFORE the ceiling is crossed. A healthy week does not get
 * near it: a weekly import publishing on time leaves a pointer about 7 days
 * old the evening before the next one lands. The ceiling itself is
 * candidates.mjs's number and is not changed here; the suite pins it by text so
 * that raising or lowering it there is a visible decision here too.
 *
 * WHAT THIS DOES NOT DO
 * No network, nothing written, node: builtins only. It reports; it does not
 * re-run the import or touch the pointer. A watchdog that can change the thing
 * it watches is not a watchdog.
 *
 * USAGE
 *   node tools/shows/watch-pointer.mjs [--pointer <path>] [--now <ISO>]
 * Exit 0 with a one-line "ok" on a fresh pointer; exit 1 with a one-line
 * reason otherwise.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CEILING_HOURS = 24 * 9; // loadChangeIndex's default maxAgeHours; pinned by the suite
export const THRESHOLD_HOURS = 24 * 8;

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_POINTER = path.resolve(HERE, "..", "..", "data", "shows-index-pointer.json");

/* Pure verdict. `pointerText` is the raw file contents (or null when the file
 * could not be read, with `readError` saying why). Returns { ok, line }. */
export function pointerVerdict({ pointerText, readError = null, now, thresholdHours = THRESHOLD_HOURS, pointerPath = "pointer" }) {
  if (pointerText == null) {
    return { ok: false, line: `RED: pointer unreadable (${pointerPath}): ${readError || "no content"}` };
  }
  let pointer;
  try {
    pointer = JSON.parse(pointerText);
  } catch (err) {
    return { ok: false, line: `RED: pointer is not JSON (${pointerPath}): ${err.message}` };
  }
  const raw = pointer && typeof pointer === "object" ? pointer.published_at : undefined;
  const publishedAt = typeof raw === "string" ? Date.parse(raw) : NaN;
  if (Number.isNaN(publishedAt)) {
    return { ok: false, line: `RED: pointer has no parseable published_at (${JSON.stringify(raw ?? null)}); loadChangeIndex already refuses it` };
  }
  const ageHours = (now - publishedAt) / 3_600_000;
  const staleAt = new Date(publishedAt + CEILING_HOURS * 3_600_000).toISOString();
  if (ageHours > thresholdHours) {
    return {
      ok: false,
      line: `RED: shows-index pointer published_at ${raw} is ${ageHours.toFixed(1)}h old (alarm ${thresholdHours}h, loadChangeIndex ceiling ${CEILING_HOURS}h, stale at ${staleAt}); the weekly shows-import has not landed a new pointer on main`,
    };
  }
  return { ok: true, line: `ok: shows-index pointer published_at ${raw} is ${ageHours.toFixed(1)}h old (alarm ${thresholdHours}h, stale at ${staleAt})` };
}

function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function run(argv) {
  const pointerPath = argValue(argv, "--pointer") || DEFAULT_POINTER;
  const nowArg = argValue(argv, "--now");
  const now = nowArg === undefined ? Date.now() : Date.parse(nowArg);
  if (Number.isNaN(now)) {
    return { code: 1, line: `RED: --now is not a parseable date: ${JSON.stringify(nowArg ?? null)}` };
  }
  let pointerText = null;
  let readError = null;
  try {
    pointerText = fs.readFileSync(pointerPath, "utf8");
  } catch (err) {
    readError = err.message;
  }
  const verdict = pointerVerdict({ pointerText, readError, now, pointerPath });
  return { code: verdict.ok ? 0 : 1, line: verdict.line };
}

const invokedDirectly =
  process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("tools/shows/watch-pointer.mjs");
if (invokedDirectly) {
  const { code, line } = run(process.argv.slice(2));
  (code === 0 ? process.stdout : process.stderr).write(line.replace(/\s+/g, " ") + "\n");
  process.exit(code);
}
