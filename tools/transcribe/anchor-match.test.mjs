/* Fuzzy anchor location over ASR cues (tools/transcribe/anchor-match.mjs,
   DAI-11). Run:
   node --test tools/transcribe/anchor-match.test.mjs

   Every test names the one-line mutation that turns it red; each was applied to
   anchor-match.mjs, confirmed changed on disk, and seen to fail this suite.
   The exact (publisher-transcript) matcher this module sits beside is covered
   by tools/segments/merge-segments.test.mjs; this suite covers only the fuzzy
   window scoring and the cue-time mapping. */

import test from "node:test";
import assert from "node:assert/strict";
import { MIN_MATCH_SCORE, anchorMatch, wordEditDistance } from "./anchor-match.mjs";

/** One cue per word: word k starts at `start + k * step` and ends 0.5 s later,
    so every token's start and end are distinct and an off-by-one shows. */
const wordCues = (text, start = 0, step = 1) =>
  text.split(" ").map((w, k) => ({ text: w, start_sec: start + k * step, end_sec: start + k * step + 0.5 }));

const ANCHOR10 = "we started measuring the river after the flood last spring";
const FILLER = "okay so here is a thing nobody tells you about";

test("an exact match scores 1 and returns its first and last token's cue times", () => {
  // MUTATION: `endTimes[best.i + best.len - 1]` -> `endTimes[best.i + best.len]` -> end_sec 20.5, not 19.5.
  const cues = wordCues(`${FILLER} ${ANCHOR10} ${FILLER}`);
  const r = anchorMatch(cues, ANCHOR10);
  assert.equal(r.hit, true);
  assert.equal(r.score, 1);
  assert.equal(r.index, 10);
  assert.equal(r.start_sec, 10);
  assert.equal(r.end_sec, 19.5);
  assert.deepEqual(r.words, ANCHOR10.split(" "));
});

test("one misheard word in a 10-word anchor scores 0.9 and hits at the default threshold", () => {
  // MUTATION: `MIN_MATCH_SCORE = 0.75` -> `0.95` -> hit false.
  const heard = ANCHOR10.replace("river", "liver");
  const r = anchorMatch(wordCues(`${FILLER} ${heard} ${FILLER}`), ANCHOR10);
  assert.equal(MIN_MATCH_SCORE, 0.75);
  assert.equal(r.score, 0.9);
  assert.equal(r.hit, true);
  assert.equal(r.start_sec, 10);
  assert.equal(r.end_sec, 19.5);
});

test("a dropped word hits through the L-1 window, scored against L", () => {
  // MUTATION: `[L, L - 1, L + 1]` -> `[L]` -> best is 0.6 (a stray filler word
  // joins the window), below 0.75: hit false.
  // A 5-word anchor, so one drop costs 0.2 in the L-1 window and 0.4 in any L window.
  const cues = wordCues(`${FILLER} alpha bravo delta echo ${FILLER}`);
  const r = anchorMatch(cues, "alpha bravo charlie delta echo");
  assert.equal(r.hit, true);
  assert.equal(r.score, 0.8);
  assert.equal(r.index, 10);
  assert.equal(r.start_sec, 10);
  assert.equal(r.end_sec, 13.5);
});

test("an anchor straddling two cues takes start from the first cue and end from the second", () => {
  // MUTATION: `start_sec: startTimes[best.i]` -> `startTimes[best.i + best.len - 1]` -> 14, not 10.
  const cues = [
    { text: "The quick, brown fox", start_sec: 10, end_sec: 14 },
    { text: "jumps over the lazy dog.", start_sec: 14, end_sec: 19 },
  ];
  const r = anchorMatch(cues, "brown fox jumps over");
  assert.equal(r.hit, true);
  assert.equal(r.score, 1);
  assert.equal(r.start_sec, 10);
  assert.equal(r.end_sec, 19);
});

test("two occurrences: the earliest wins the tie", () => {
  // MUTATION: `score > best.score` -> `score >= best.score` -> the later copy (index 30) wins.
  const cues = wordCues(`${FILLER} ${ANCHOR10} ${FILLER} ${ANCHOR10}`);
  const r = anchorMatch(cues, ANCHOR10);
  assert.equal(r.score, 1);
  assert.equal(r.index, 10);
  assert.equal(r.start_sec, 10);
});

test("from_sec/to_sec exclude a match whose first token starts outside the range", () => {
  // MUTATION: delete the `if (!(startTimes[i] >= from_sec && startTimes[i] <= to_sec)) continue;`
  // line -> from_sec 25 still returns the copy at 10.
  const cues = wordCues(`${FILLER} ${ANCHOR10} ${FILLER} ${ANCHOR10}`);
  const late = anchorMatch(cues, ANCHOR10, { from_sec: 25 });
  assert.equal(late.hit, true);
  assert.equal(late.start_sec, 30);
  const early = anchorMatch(cues, ANCHOR10, { to_sec: 25 });
  assert.equal(early.start_sec, 10);
  // A range that starts the anchor nowhere: the copy at 10 begins outside [13, 25],
  // and the best window left (seven anchor words plus two filler, from 13) scores 0.5.
  const inside = anchorMatch(cues, ANCHOR10, { from_sec: 13, to_sec: 25 });
  assert.equal(inside.hit, false);
  assert.equal(inside.score, 0.5);
  assert.deepEqual(anchorMatch(cues, ANCHOR10, { from_sec: 500 }), { hit: false, reason: "no window in range", candidates: 0 });
});

test("an anchor under MIN_ANCHOR_WORDS (4) is refused; punctuation is not a word", () => {
  // MUTATION: `words.length < MIN_ANCHOR_WORDS` -> `< MIN_ANCHOR_WORDS - 1` -> the 3-word anchor is matched.
  const cues = wordCues(`${FILLER} river after the flood`);
  assert.deepEqual(anchorMatch(cues, "after the flood"), { hit: false, reason: "anchor too short", words: ["after", "the", "flood"] });
  assert.deepEqual(anchorMatch(cues, "after -- the ... flood!"), { hit: false, reason: "anchor too short", words: ["after", "the", "flood"] });
  assert.equal(anchorMatch(cues, "river after the flood").hit, true);
});

test("wordEditDistance is Levenshtein over words", () => {
  // MUTATION: `const ins = row[j - 1] + 1` -> `+ 2` -> the one-insertion case reads 2.
  assert.equal(wordEditDistance(["a", "b"], ["a", "c", "b"]), 1);
  assert.equal(wordEditDistance(["a", "c", "b"], ["a", "b"]), 1);
  assert.equal(wordEditDistance([], ["x", "y"]), 2);
  assert.equal(wordEditDistance(["x", "y"], ["x", "y"]), 0);
  assert.equal(wordEditDistance(["kitten", "sat"], ["sitting", "sat", "down"]), 2);
  assert.throws(() => wordEditDistance("a b", ["a"]), TypeError);
});

test("a miss still reports its best score and times; no cues is its own refusal", () => {
  // MUTATION: `hit: best.score >= minScore` -> `hit: true` -> the unrelated transcript hits.
  const r = anchorMatch(wordCues(FILLER), ANCHOR10);
  assert.equal(r.hit, false);
  assert.ok(r.score < MIN_MATCH_SCORE);
  assert.equal(typeof r.start_sec, "number");
  assert.equal(typeof r.end_sec, "number");
  assert.deepEqual(anchorMatch([], ANCHOR10), { hit: false, reason: "no cues" });
  assert.deepEqual(anchorMatch(null, ANCHOR10), { hit: false, reason: "no cues" });
  // A caller-raised threshold turns the 0.9 near-miss into a miss.
  const heard = ANCHOR10.replace("river", "liver");
  assert.equal(anchorMatch(wordCues(heard), ANCHOR10, { minScore: 0.95 }).hit, false);
});

test("candidates counts every window scored, and no window runs past the last token", () => {
  // MUTATION: delete `if (i + len > tokens.length) continue;` -> truncated tail
  // windows are scored too: 18 candidates, not 9.
  // 6 tokens, L = 4: L-length windows 3, L-1 windows 4, L+1 windows 2.
  const r = anchorMatch(wordCues("one two three four five six"), "three four five six");
  assert.equal(r.candidates, 9);
  assert.equal(r.score, 1);
  assert.equal(r.end_sec, 5.5);
});
