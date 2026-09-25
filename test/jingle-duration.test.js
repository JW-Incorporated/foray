/* Audit round 3, arch-drift-4: ONE jingle length, everywhere it is counted.
 *
 * The jingle item plays the interlude WAV (3.0 s, measured from its header by
 * player/interlude.test.js). The player said 1.5 s and so did the generator's
 * own copy in backend/src/generation/runPipeline.ts, which adds it to every
 * generated Foray's `runtime_sec`. The player's copy is now the file's length;
 * this pins the backend's literal to it, because the backend is TypeScript in a
 * separate package and cannot import the player module.
 *
 * MUTATION: put `export const JINGLE_DURATION_SEC = 1.5;` back in runPipeline.ts
 * and this goes red.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

test("the generator's jingle length is the player's, which is the interlude file's", async () => {
  const { JINGLE_DURATION_SEC } = await import("../player/foray-queue.js");
  const { INTERLUDE_DURATION_SEC } = await import("../player/interlude.js");
  const src = fs.readFileSync(path.join(ROOT, "backend/src/generation/runPipeline.ts"), "utf8");
  const m = /export const JINGLE_DURATION_SEC = ([0-9.]+);/.exec(src);
  assert.ok(m, "runPipeline.ts still declares JINGLE_DURATION_SEC as a literal");
  assert.equal(Number(m[1]), JINGLE_DURATION_SEC, "backend and player agree");
  assert.equal(JINGLE_DURATION_SEC, INTERLUDE_DURATION_SEC, "and both are the file's length");
});
