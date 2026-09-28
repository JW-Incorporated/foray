/* The RENDERED fixture — `tools/foray/fixtures/rendered/` — held to what it
 * claims to be (Spark assessment Phase 1, 2026-09-28).
 *
 * WHY IT EXISTS. The founder ruled central narration rendering (D1-D11,
 * `docs/plans/spark-central-narration-assessment.md`): narration is rendered
 * once by Kokoro, served from the public `foray-narration` bucket at
 * audio.jwlabs.ai, and stamped into `data/forays.json` as `audio_url` +
 * `duration_sec` + `duration_source: "measured"` (+ `voices`, `render`). G-21c
 * (fixture before emit, F-89) says that shape reaches a committed fixture, and
 * every consumer in CI, BEFORE the first data PR stamps a live Foray (§3.4).
 *
 * WHAT IT IS. One real draft (`beyond-the-algorithm-…`) copied verbatim from
 * `data/` with exactly the pool rows, episodes and topics it needs, then
 * stamped by `tools/narration/stamp-narration.mjs` (PR #864) from the REAL
 * Phase 1 smoke render (render-narration run 36437228863: two lines, Heart and
 * Echo). Nothing in it is hand-written: the keys, durations and runtime are
 * what the render and the stamp tool produced.
 *
 * WHAT THIS FILE PINS:
 *   1. it passes the real checker (and the CLI) with zero errors;
 *   2. it is self-contained and minimal, like the frozen fixture;
 *   3. it carries rendered narration in both voices, on a DRAFT — the only
 *      status Phase 1 may stamp;
 *   4. the player reads it as the checker does: stamped lines are FILES (not
 *      spoken), timed by their measurement, and the player's total agrees with
 *      the restated `runtime_sec`;
 *   5. the checker's constants agree with the render profile, once that file
 *      is on main (`tools/narration/render-profile.json`, PR #864).
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  checkForays,
  loadFiles,
  NARRATION_PUBLIC_BASE,
  NARRATION_VOICES,
  DEFAULT_NARRATION_VOICE,
  RENDERED_DURATION_RATIO,
  RUNTIME_RESTATED_TOLERANCE_SEC,
  narrationAudioProblems,
} from "./check-forays.mjs";
import { buildForayQueue, NARRATION_CHARS_PER_SEC, DURATION_MEASURED } from "../../player/foray-queue.js";
import { resolveForay, indexSegments, indexSources } from "../../player/foray-resolve.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const RENDERED_ROOT = path.join(HERE, "fixtures", "rendered");
const rendered = loadFiles(RENDERED_ROOT);
const forays = rendered.forays.forays;
const stamped = (foray) => foray.items.filter((i) => i.type === "narration" && typeof i.audio_url === "string");

test("the rendered fixture passes the real checker with zero errors, and the CLI exits 0 on it", () => {
  /* MUTATION: add 1 s to one stamped line's duration_sec without restating
     runtime_sec -> both halves go red. */
  const { errors } = checkForays(rendered);
  assert.deepEqual(errors, [], errors.join("\n"));
  const out = execFileSync(process.execPath, [path.join(HERE, "check-forays.mjs"), "--root", RENDERED_ROOT], { encoding: "utf8" });
  assert.match(out, /forays ok/);
});

test("the rendered fixture is self-contained and minimal: exactly the rows and episodes its Foray plays", () => {
  const played = new Set(forays.flatMap((f) => f.items.filter((i) => i.type === "segment").map((i) => i.segment_id)));
  const pool = rendered.segments.segments.map((s) => s.id);
  assert.deepEqual(pool.filter((id) => !played.has(id)), [], "unplayed pool rows in the rendered fixture");
  assert.deepEqual([...played].filter((id) => !pool.includes(id)), [], "played segments missing from the rendered pool");
  const episodes = new Set(rendered.segments.segments.map((s) => s.item_id));
  const registered = rendered.sources.sources.map((s) => s.id);
  assert.deepEqual(registered.filter((id) => !episodes.has(id)), [], "episodes no rendered row cuts from");
  assert.deepEqual([...episodes].filter((id) => !registered.includes(id)), [], "rendered rows whose episode is not registered");
  const topics = new Set((rendered.taxonomy?.nodes || []).map((n) => n.id));
  for (const f of forays) assert.ok(topics.has(f.topic), `${f.id}'s topic ${f.topic} is not in the rendered taxonomy`);
});

test("the rendered fixture carries rendered narration in both voices, on a draft", () => {
  /* The shapes fixture-coverage.test.mjs counts it as the carrier of
     (`narration.voice = audio_url`, `narration.duration_source = measured`),
     plus the `voices`/`render` fields the stamp tool writes beside them.
     Phase 1 stamps drafts only (§5), so a published carrier would itself be
     an error. */
  assert.equal(forays.length, 1);
  const [foray] = forays;
  assert.equal(foray.status, "draft");
  assert.equal(foray.generated, true);
  const lines = stamped(foray);
  assert.ok(lines.length >= 2, "at least two stamped lines");
  for (const line of lines) {
    assert.deepEqual(narrationAudioProblems(line.audio_url, { voice: DEFAULT_NARRATION_VOICE }), [], line.id);
    assert.equal(line.duration_source, DURATION_MEASURED, line.id);
    for (const voice of NARRATION_VOICES.filter((v) => v !== DEFAULT_NARRATION_VOICE)) {
      assert.deepEqual(narrationAudioProblems(line.voices?.[voice]?.audio_url, { voice }), [], `${line.id} ${voice}`);
      assert.ok(line.voices[voice].duration_sec > 0, `${line.id} ${voice}`);
    }
    assert.equal(typeof line.render?.profile, "string", `${line.id}: render.profile`);
    assert.match(line.render?.script_sha ?? "", /^[0-9a-f]{64}$/, `${line.id}: render.script_sha`);
  }
  // The rest of the Foray is still script-only, spoken on the device until it is rendered.
  assert.ok(foray.items.some((i) => i.type === "narration" && !i.audio_url && typeof i.script === "string"));
});

test("the player reads the rendered lines as FILES timed by their measurement, and agrees with runtime_sec", () => {
  /* The consumer half of G-21c: the queue a phone builds from this Foray.
     `PlayerQueueManager._isSynthNarration` speaks a tts item only when it has
     no `audio_url`, so a stamped line must reach the queue WITH one; its clock
     entry must be the measured length, not the 17 chars/s estimate; and the
     player's total must be the restated runtime.
     MUTATION: drop `audio_url` from the queue item in buildForayQueue -> the
     first assertion goes red. */
  const [foray] = forays;
  const { items } = buildForayQueue(foray);
  const byId = new Map(items.map((i) => [i.id, i]));
  for (const line of stamped(foray)) {
    const q = byId.get(line.id);
    assert.ok(q, `${line.id} is in the queue`);
    assert.equal(q.audio_url, line.audio_url, `${line.id} plays its file, not a synthesized voice`);
    assert.equal(q.duration_sec, line.duration_sec);
    assert.equal(q.duration_source, DURATION_MEASURED);
    assert.notEqual(q.duration_sec, +(line.script.trim().length / NARRATION_CHARS_PER_SEC).toFixed(3));
  }
  const r = resolveForay(foray, { segments: indexSegments(rendered.segments), sources: indexSources(rendered.sources) });
  assert.ok(
    Math.abs(r.totalSec - foray.runtime_sec) <= RUNTIME_RESTATED_TOLERANCE_SEC,
    `player total ${r.totalSec} vs runtime_sec ${foray.runtime_sec}`
  );
});

const PROFILE = path.join(REPO_ROOT, "tools", "narration", "render-profile.json");
test(
  "the checker's narration constants agree with the render profile",
  { skip: fs.existsSync(PROFILE) ? false : "tools/narration/render-profile.json is not on this branch yet (PR #864)" },
  () => {
    /* Two files state the same facts: the render/stamp tools read the
       profile, and CI reads check-forays.mjs. Pinned together so one cannot
       move without the other. */
    const profile = JSON.parse(fs.readFileSync(PROFILE, "utf8"));
    assert.equal(profile.public_base.replace(/\/+$/, ""), NARRATION_PUBLIC_BASE);
    assert.deepEqual(profile.voices, [...NARRATION_VOICES]);
    assert.equal(profile.default_voice, DEFAULT_NARRATION_VOICE);
    assert.deepEqual(profile.reject.length_ratio, [...RENDERED_DURATION_RATIO]);
    assert.equal(profile.reject.estimate_chars_per_sec, NARRATION_CHARS_PER_SEC);
    assert.equal(profile.key_prefix, "n");
    assert.equal(profile.render.encode.container, "m4a");
    assert.equal(profile.bucket, "foray-narration");
  }
);
