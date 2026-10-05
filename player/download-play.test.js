/**
 * Playing a downloaded episode from its local file (PQ-19, #29;
 * docs/roadmap/player-features.md "### PQ-19 · Play from the local file").
 *
 * The rules themselves are pure and executed elsewhere: `playSource` /
 * `localPlayable` in download-store.test.js, and the native facade's pointer
 * row (the ORIGINAL item, not the local playable) in native-facades.test.js.
 * What this file pins is client.js's WIRING of them: that `play()` asks for
 * the source before the queue is set and hands the queue the playable; that
 * the bar, the sheet and the pointer row keep the original item; that the
 * seek note reads `isLocalFile` from the current item; and that a missing
 * file is marked and streamed once, never in a loop.
 *
 * WHY THIS IS A SOURCE-TEXT SUITE. `player/client.js` builds real DOM at
 * import and cannot be loaded under node — the reason now-playing-sheet.test.js
 * and episode-link.test.js read it as text — and this file reuses their
 * `codeOnly()` stripper verbatim so a scan for a code path cannot be satisfied
 * by a comment ABOUT that code path. It is a weaker instrument than executing
 * the module and it is named as one; what it catches is the wiring being
 * deleted, reordered or renamed.
 *
 * WHAT ONLY A DEVICE CAN CONFIRM, stated rather than faked: that AVPlayer on
 * iOS plays the percent-encoded `file://` URL from Application Support, that
 * the Android shell serves `webSrc`, and that airplane-mode playback works end
 * to end. All three wait on the plugins (PQ-20/21/22) on a real phone.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

/** Comments and string literals stripped. Ported verbatim from
    now-playing-sheet.test.js (itself from episode-link.test.js), which
    documents why the order matters and why a `//` must be preceded by
    start-of-line/whitespace/an opener. */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/`(?:\\[\s\S]|[^`\\])*`|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, '""')
    .replace(/(^|[\s(,;{}=])\/\/[^\n]*/gm, "$1");
}
const FLAT = codeOnly(read("player/client.js")).replace(/\s+/g, " ");

/** The body of the first block whose header matches `head`, braces balanced.
    Strings are already erased, so a brace inside one cannot unbalance it. */
function body(head) {
  const at = FLAT.indexOf(head);
  assert.ok(at >= 0, `client.js has ${JSON.stringify(head)}`);
  const open = FLAT.indexOf("{", at + head.length - 1);
  let depth = 0;
  for (let i = open; i < FLAT.length; i++) {
    if (FLAT[i] === "{") depth++;
    else if (FLAT[i] === "}" && --depth === 0) return FLAT.slice(open, i + 1);
  }
  throw new Error(`unbalanced block after ${head}`);
}

const PLAY = body("async play(item, opts) {");
const pos = (src, needle) => {
  const i = src.indexOf(needle);
  assert.ok(i >= 0, `expected ${JSON.stringify(needle)}`);
  return i;
};

test("play() asks playSource for the source BEFORE the queue is set, and the queue gets the playable", () => {
  // MUTATION: `manager.setQueueFromPick(item, { lastEpisodeItem: item })` in
  // play() -> the queue is handed the remote item and the download never plays.
  const pick = body("function localSourceFor(item, opts) {");
  assert.match(pick, /dl\.store\.playSource\(item, dl\.recordFor\(item\.id\), \{ platform \}\)/);
  assert.match(pick, /return dl\.store\.localPlayable\(item, src\) \|\| item;/);
  const chosen = pos(PLAY, "const playable = localSourceFor(item, opts);");
  const queued = pos(PLAY, "manager.setQueueFromPick(playable, { lastEpisodeItem: item });");
  assert.ok(chosen < queued, "the source is chosen before the queue is set");
  assert.ok(queued < pos(PLAY, "await manager.play(0,"), "and the queue is set before anything loads");
});

test("setNowPlaying, the pointer row and the native facade's row all keep the ORIGINAL item", () => {
  // MUTATION: `{ lastEpisodeItem: playable }` in play()'s setQueueFromPick ->
  // the native engine's pointer row names the local file (no test here sees
  // the JS lane's row change, which is why both are asserted).
  assert.ok(pos(PLAY, "setNowPlaying(item, why);") < pos(PLAY, "const playable ="),
    "the bar is painted from the original, before the source is known");
  assert.match(PLAY, /const lastRec = makeLastEpisode\(item\);/);
  assert.match(PLAY, /\{ lastEpisodeItem: item \}/);
  assert.doesNotMatch(PLAY, /setNowPlaying\(playable|makeLastEpisode\(playable|lastEpisodeItem: playable/);
});

test("the seek note reads isLocalFile from the current item, and play() marks current then repaints it", () => {
  // MUTATION: `isLocalFile: false` in paintSeekNote() -> a downloaded copy of
  // a stitched show is called approximate, though its timeline is frozen.
  const note = body("function paintSeekNote() {");
  assert.match(note, /seekPrecision\(current, \{ isLocalFile: Boolean\(current\?\.isLocalFile\), source: OWN \}\)/);
  /* setNowPlaying's own text, up to the next function — not `body()`: two
     apostrophes in its line comments read as a string to the verbatim
     stripper, which swallows one of its braces (a known blind spot of the
     ported stripper, the same on origin/main). The call sits after them. */
  const nowPlaying = FLAT.slice(pos(FLAT, "function setNowPlaying(item, why) {"), pos(FLAT, "function paintSeekNote() {"));
  assert.match(nowPlaying, /paintSeekNote\(\); buffering = false;/);
  const marked = pos(PLAY, "current = { ...item, isLocalFile: true };");
  assert.ok(marked < pos(PLAY, "paintSeekNote();"), "the note is repainted after the flag is set");
});

test("a missing local file calls onMissing and retries the original item ONCE with noLocal", () => {
  // MUTATION: drop `noLocal: true` from degradeLocalPlay's retry -> the retry
  // picks the same missing file again (the ticket stops the loop, but the
  // listener gets the error instead of the stream).
  const degrade = body("function degradeLocalPlay() {");
  assert.ok(pos(degrade, "localAttempt = null;") < pos(degrade, "onMissing"), "the ticket is spent before anything else");
  assert.match(degrade, /window\.forayDownloads\?\.onMissing\?\.\(attempt\.item\.id\)/);
  assert.match(degrade, /return ForayPlayer\.play\(attempt\.item, \{ \.\.\.opts, noLocal: true \}\);/);
  assert.match(body("function localSourceFor(item, opts) {"), /if \(opts\?\.noLocal \|\|/);
  // Both triggers: a local load that rejects or lands idle, and reportPlayFailure.
  assert.match(PLAY, /if \(current\?\.isLocalFile && current\.id === item\.id && \(loadError \|\| manager\.state\?\.type === ""\)\)/);
  assert.ok(pos(PLAY, "degradeLocalPlay()") < pos(PLAY, "throw loadError.err"), "a degrade answers before the error is rethrown");
  assert.match(body("reportPlayFailure(err) {"), /current\?\.isLocalFile \? degradeLocalPlay\(\) : null/);
});
