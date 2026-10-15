/* Completion and follow payload builders (RV-28, #1380;
 * docs/roadmap/recommender-v1.md, decision D6).
 *
 * WHAT THIS SUITE GUARDS, beyond the arithmetic: that the payloads mirror the
 * dark RV-23 contract in backend/src/types/events.ts exactly. The contract is
 * read as TEXT (a key-set compare, as the card says; no zod, no backend
 * node_modules), so a field renamed on either side turns this suite red. And
 * that the module emits nothing: no logEvent, no storage, no network.
 *
 * Every test names the one-line mutation that turns it red (CLAUDE.md).
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  finishedPayload, followPayload, unfollowPayload, CENSOR_REASONS, COMPLETION_FIELDS, PERCENT_CAP,
} from "./feedback-events.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const MIN = 60;

/* The fields of one `export const <name> = <base>.extend({...})` or
   `z.object({...})` block of events.ts, comments stripped, each with whether
   it is `.optional()`. Top-level fields only: a nested z.object would need a
   real parser, and none of the three schemas read here has one. */
function contractFields(name) {
  const src = fs.readFileSync(path.join(ROOT, "backend/src/types/events.ts"), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  const start = src.indexOf(`export const ${name} =`) >= 0
    ? src.indexOf(`export const ${name} =`)
    : src.indexOf(`const ${name} =`);
  assert.ok(start >= 0, `events.ts declares ${name}`);
  const end = src.indexOf("});", start);
  assert.ok(end > start, `${name} block closes`);
  const body = src.slice(src.indexOf("({", start) + 2, end);
  const fields = new Map();
  for (const m of body.matchAll(/^\s*([a-z_]+)\s*:\s*(z\.[^\n]*|[A-Z]\w*Schema[^\n]*)$/gm)) {
    fields.set(m[1], /\.optional\(\)/.test(m[2]));
  }
  assert.ok(fields.size > 0, `${name} has fields`);
  return fields;
}

const base = { episode_slug: "hardcore-history/72", show: "Hardcore History", topics: ["history", "history/ancient"] };

test("percent is position over effective length, capped at 1.2", () => {
  /* MUTATION: `position_sec / eff` -> `position_sec / duration_sec` in
     finishedPayload — red: half of a 50-minute episode's 2,940 s effective
     length (1,470 s) reads 0.49 of the raw 3,000 s instead of 0.5. */
  const dur = 50 * MIN;
  const half = finishedPayload({ ...base, position_sec: 1470, duration_sec: dur });
  assert.equal(half.eff_len_sec, 2940);
  assert.equal(half.percent, 0.5);
  assert.equal(finishedPayload({ ...base, position_sec: 1000, duration_sec: dur }).percent, 0.34, "two decimals (0.3401...)");
  const replay = finishedPayload({ ...base, position_sec: 4000, duration_sec: dur });
  assert.equal(replay.percent, PERCENT_CAP, "a replay past the end is capped at 1.2 (the contract's max)");
  assert.equal(PERCENT_CAP, 1.2);
  assert.equal(finishedPayload({ ...base, position_sec: 3300, duration_sec: dur }).percent, 1.12, "under the cap a replay passes 1");
});

test("a stop in the outro margin is percent 1.0", () => {
  /* MUTATION: `effectiveLength(duration_sec)` ->
     `effectiveLength(duration_sec, { outroMarginSec: 0 })` in finishedPayload
     — red: 50 s before the end of a 50-minute episode reads 2950/3000 = 0.98,
     not a completed listen. */
  const dur = 50 * MIN;
  assert.equal(finishedPayload({ ...base, position_sec: dur - 50, duration_sec: dur }).percent, 1);
  assert.equal(finishedPayload({ ...base, position_sec: 2940, duration_sec: dur }).percent, 1, "the margin's start");
  const short = finishedPayload({ ...base, position_sec: 270, duration_sec: 5 * MIN });
  assert.equal(short.eff_len_sec, 270, "a 5-minute episode keeps 90% of its length");
  assert.equal(short.percent, 1);
});

test("censored is true for every CENSOR_REASON and false for null", () => {
  /* MUTATION: `payload.censored = censored` -> `payload.censored = true` in
     finishedPayload — red: a stop with no reason (and one with none given)
     reads censored. */
  assert.deepEqual([...CENSOR_REASONS], ["backgrounded", "route_lost", "foray_transition", "app_closed"]);
  for (const reason of CENSOR_REASONS) {
    assert.equal(finishedPayload({ ...base, position_sec: 600, duration_sec: 3000, censor_reason: reason }).censored, true, reason);
  }
  assert.equal(finishedPayload({ ...base, position_sec: 600, duration_sec: 3000, censor_reason: null }).censored, false);
  assert.equal(finishedPayload({ ...base, position_sec: 600, duration_sec: 3000 }).censored, false, "no reason given");
});

test("the finished payload's keys equal the contract's optional fields", () => {
  /* MUTATION: rename `payload.eff_len_sec` to `payload.eff_len` in
     finishedPayload — red: the builder's completion keys stop matching
     FinishedPayloadSchema's optional fields. The required percent_complete
     and source are RV-27's to merge in (module header), so they are excluded
     here, and the builder must never emit one of them. */
  const finished = contractFields("FinishedPayloadSchema");
  const optional = [...finished].filter(([, opt]) => opt).map(([k]) => k).sort();
  const required = [...finished].filter(([, opt]) => !opt).map(([k]) => k).sort();
  assert.deepEqual(required, ["percent_complete", "source"], "the contract's required finished fields, RV-27's to fill");
  assert.deepEqual([...COMPLETION_FIELDS].sort(), optional);

  const context = [...contractFields("EpisodeContextSchema").keys()].sort();
  const payload = finishedPayload({ ...base, position_sec: 600, duration_sec: 3000, resumed: true });
  assert.deepEqual(Object.keys(payload).sort(), [...context, ...optional].sort(),
    "the payload is the episode context plus the optional completion fields");
  for (const k of required) assert.ok(!(k in payload), `${k} is never built here`);
  assert.equal(payload.resumed, true);
  assert.equal(finishedPayload({ ...base, position_sec: 600, duration_sec: 3000 }).resumed, false);
  assert.deepEqual(payload.topics, base.topics);
});

test("unfollow carries episodes_played as an integer", () => {
  /* MUTATION: `Math.floor(episodes_played)` -> `String(episodes_played)` in
     showFollow — red: the contract's z.number().int() would reject "3". */
  const p = unfollowPayload({ show_id: "hardcore-history", episodes_played: 3, topics: ["history"] });
  assert.equal(p.episodes_played, 3);
  assert.ok(Number.isInteger(p.episodes_played));
  assert.equal(unfollowPayload({ show_id: "s", episodes_played: 2.7 }).episodes_played, 2, "a fraction floors");
  assert.equal(unfollowPayload({ show_id: "s", episodes_played: 0 }).episodes_played, 0, "zero is a count");
  for (const bad of [-1, Number.NaN, "3", null, undefined]) {
    assert.ok(!("episodes_played" in unfollowPayload({ show_id: "s", episodes_played: bad })), `${String(bad)} is omitted`);
  }
});

test("follow and unfollow keys equal ShowFollowPayloadSchema's, topics included", () => {
  /* MUTATION: delete `payload.topics = stringList(topics);` in showFollow —
     red: the payload loses the show's taxonomy nodes the contract carries
     (RV-23 as merged, #1408). */
  const contract = [...contractFields("ShowFollowPayloadSchema").keys()].sort();
  assert.deepEqual(contract, ["episodes_played", "show_id", "topics"]);
  const args = { show_id: "hardcore-history", episodes_played: 4, topics: ["history", 7, ""] };
  for (const build of [followPayload, unfollowPayload]) {
    const p = build(args);
    assert.deepEqual(Object.keys(p).sort(), contract);
    assert.deepEqual(p.topics, ["history"], "non-string and empty node ids are dropped");
    assert.deepEqual(build({ show_id: "s" }), { show_id: "s", topics: [] }, "topics default to [] as the contract's do");
    assert.equal(build({ episodes_played: 2 }), null, "no show id, no payload");
  }
});

test("unusable inputs build no payload and an unknown censor reason is refused", () => {
  /* MUTATION: delete `if (!eff || !finiteNonNegative(position_sec)) return null;`
     in finishedPayload — red: an unknown duration builds eff_len_sec 0,
     which the contract's positive() rejects. */
  for (const duration_sec of [0, -5, Number.NaN, Infinity, undefined, "3000"]) {
    assert.equal(finishedPayload({ ...base, position_sec: 10, duration_sec }), null, `duration ${String(duration_sec)}`);
  }
  for (const position_sec of [-1, Number.NaN, undefined]) {
    assert.equal(finishedPayload({ ...base, position_sec, duration_sec: 3000 }), null, `position ${String(position_sec)}`);
  }
  assert.equal(finishedPayload({ position_sec: 10, duration_sec: 3000 }), null, "no slug");
  const noShow = finishedPayload({ episode_slug: "e/1", position_sec: 0, duration_sec: 3000 });
  assert.deepEqual(noShow, { episode_slug: "e/1", topics: [], percent: 0, eff_len_sec: 2940, censored: false, resumed: false });
  assert.throws(() => finishedPayload({ ...base, position_sec: 10, duration_sec: 3000, censor_reason: "paused" }), RangeError);
});

test("the module source emits nothing: no logEvent, storage, network or page", () => {
  /* MUTATION: add `logEvent("finished", payload);` to finishedPayload — red.
     Also red for a quoted storage-key literal or an import other than
     ./recommender-feedback.js. */
  const src = fs.readFileSync(path.join(HERE, "feedback-events.js"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  for (const word of [/\blocalStorage\b/, /\bsessionStorage\b/, /\bindexedDB\b/, /\blogEvent\b/i,
    /\bfetch\s*\(/, /\bdocument\b/, /\bXMLHttpRequest\b/, /\bsendBeacon\b/, /\bwindow\./]) {
    assert.ok(!word.test(code), `feedback-events.js must not use ${word}`);
  }
  assert.ok(!/["'`]cp_/.test(code), "no storage-key literal in code");
  const imports = [...code.matchAll(/^\s*import\b[^;]*from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ["./recommender-feedback.js"]);
});
