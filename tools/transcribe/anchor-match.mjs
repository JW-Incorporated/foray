/* Fuzzy anchor location over ASR cues — the pure half of the G-41 locate step
   (DAI-11, docs/roadmap/dai.md).

   WHAT THIS IS FOR. On a show that inserts ads dynamically, the delivered file
   is not the one the transcript was timed against, so an authored boundary
   lands somewhere inside a search window (player/locate-window.js, DAI-10)
   rather than at its authored second. The locate step transcribes that window
   on the device and looks for the segment's ADR-0007 anchor (8-12 verbatim
   words) in what the recogniser heard. merge-segments.mjs's
   findAnchorOccurrences is the exact, whole-word matcher for PUBLISHER
   transcripts; it is the wrong tool here, because ASR drops, inserts and
   mishears words, and an exact matcher misses on the first slip. This module
   scores every nearby token window by word-level edit distance instead.

   THE RULE, so the native port can reproduce it bit for bit:
   - words = canonical(anchorText) split on spaces (merge-segments.mjs's
     canonical form, imported, never reimplemented — the two matchers must
     agree on what a word is);
   - fewer than MIN_ANCHOR_WORDS words is refused ("anchor too short");
   - every token window of length L-1, L and L+1 (L = words.length; a length
     below 1 is skipped) whose FIRST token's start time lies in
     [from_sec, to_sec] is scored as 1 - wordEditDistance(window, words) / L,
     floored at 0 — the divisor is always L, so a window one word short that
     is otherwise exact scores 1 - 1/L, never 1;
   - the best window is the highest score; a tie goes to the earliest start
     token, and within one start token to the length tried first (L, then L-1,
     then L+1);
   - hit = score >= minScore (MIN_MATCH_SCORE = 0.75 by default);
   - start_sec is the first token's cue start, end_sec the last token's cue
     end. A token inherits its cue's times (buildTranscriptIndex), so the
     resolution is the cue's, exactly as for publisher transcripts.

   WHAT IT DOES NOT DO. It never reads an ASR format: whisper-cli JSON,
   SFSpeechRecognizer segments and the rest are normalised to
   `{ text, start_sec, end_sec }` cues by the caller (the shape
   decode-compare.mjs's transcriptCues returns). It never decides whether a
   located boundary is plausible — that is locatedBounds in
   player/locate-window.js. Pure: no network, no file access. */

import { MIN_ANCHOR_WORDS, buildTranscriptIndex, canonical } from "../segments/merge-segments.mjs";

/** Below this a window is not the anchor. 0.75 tolerates a quarter of the
    words misheard, dropped or inserted — on a 10-word anchor, two slips. */
export const MIN_MATCH_SCORE = 0.75;

/**
 * Levenshtein distance over two arrays of words: the fewest single-word
 * insertions, deletions and substitutions that turn `a` into `b`.
 */
export function wordEditDistance(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) throw new TypeError("wordEditDistance takes two arrays of words");
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const sub = prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      const del = prev[j] + 1;
      const ins = row[j - 1] + 1;
      row.push(Math.min(sub, del, ins));
    }
    prev = row;
  }
  return prev[b.length];
}

/**
 * Locate one anchor in a cue list by fuzzy whole-word match.
 *
 * @param {Array<{text: string, start_sec: number, end_sec: number}>} cues
 * @param {string} anchorText
 * @param {{minScore?: number, from_sec?: number, to_sec?: number}} [opts]
 * @returns {{hit: boolean, score?: number, start_sec?: number, end_sec?: number,
 *            index?: number, words?: string[], candidates?: number, reason?: string}}
 */
export function anchorMatch(cues, anchorText, { minScore = MIN_MATCH_SCORE, from_sec = -Infinity, to_sec = Infinity } = {}) {
  const words = canonical(anchorText).split(" ").filter(Boolean);
  if (words.length < MIN_ANCHOR_WORDS) return { hit: false, reason: "anchor too short", words };
  if (!Array.isArray(cues) || cues.length === 0) return { hit: false, reason: "no cues" };

  const { tokens, startTimes, endTimes } = buildTranscriptIndex(cues);
  const L = words.length;
  const lengths = [L, L - 1, L + 1].filter((len) => len >= 1);

  let best = null;
  let candidates = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    if (!(startTimes[i] >= from_sec && startTimes[i] <= to_sec)) continue;
    for (const len of lengths) {
      if (i + len > tokens.length) continue;
      candidates += 1;
      const score = Math.max(0, 1 - wordEditDistance(tokens.slice(i, i + len), words) / L);
      if (best === null || score > best.score) best = { score, i, len };
    }
  }
  if (best === null) return { hit: false, reason: "no window in range", candidates: 0 };

  return {
    hit: best.score >= minScore,
    score: best.score,
    start_sec: startTimes[best.i],
    end_sec: endTimes[best.i + best.len - 1],
    index: best.i,
    words,
    candidates,
  };
}
