import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PAUSE_MAX_SHIFT_SEC, PAUSE_MIN_GAP_SEC, pausesNear, snapEdge } from "../src/generation/pauseSnap";
import {
  CUE_CACHE_MAX_ENTRIES,
  CUE_CACHE_WORDS_MAX_ENTRIES,
  FileTranscriptCueProvider,
  cueWordsOf,
  cuesFromBodyJson,
  cutWindowToSegment,
  type TapeWindow,
  type TranscriptCue,
  type TranscriptDigestEntry,
  type TranscriptWord
} from "../src/generation/transcriptArchiveLookup";
import { canonicalizeForAnchorMatch, phraseIsInWindow } from "../src/types/anchorText";

/**
 * GV-111 (docs/roadmap/generation-v2.md, from W5-14b; R2-05, MQ-06): clip
 * edges snapped to real pauses read from word timestamps, with the anchors
 * re-minted from the words — FORAY_PAUSE_SNAP=on, default off. Synthetic
 * cues and words only; nothing here reads a body from data-local.
 */

/** Words for `phrase`, spread evenly over [start, end] with 0.05 s between
 * them (never a pause). */
function spread(phrase: string, start: number, end: number): TranscriptWord[] {
  const parts = phrase.split(/\s+/).filter(Boolean);
  const step = (end - start) / parts.length;
  return parts.map((text, i) => ({ text, start: round(start + i * step), end: round(start + (i + 1) * step - 0.05) }));
}
const round = (n: number): number => Math.round(n * 1000) / 1000;

/** A cue whose words are the given phrases, each spread over its own span. */
function wordedCue(start: number, end: number, phrases: Array<[string, number, number]>, speaker?: string): TranscriptCue {
  const words = phrases.flatMap(([p, s, e]) => spread(p, s, e));
  return { text: phrases.map(([p]) => p).join(" "), start_sec: start, end_sec: end, ...(speaker ? { speaker } : {}), words };
}

describe("pauseSnap — where an edge can sit on a real pause", () => {
  /* "hello world." then a 0.42 s gap; every other gap is 0.1 s. */
  const hello: TranscriptCue[] = [
    {
      text: "hello world. this is it",
      start_sec: 0,
      end_sec: 3,
      words: [
        { text: "hello", start: 0, end: 0.4 },
        { text: "world.", start: 0.5, end: 1.0 },
        { text: "this", start: 1.42, end: 1.7 },
        { text: "is", start: 1.8, end: 1.9 },
        { text: "it", start: 2.0, end: 2.5 }
      ]
    }
  ];

  it("snaps to the 0.42 s gap after 'world.' and not to a 0.1 s gap, on either side", () => {
    /* MUTATION THAT KILLS THIS: compare the gap against 0.05 instead of
       PAUSE_MIN_GAP_SEC — the 0.1 s gaps become pauses and the nearer one
       wins the end edge. Ran it: red. */
    expect(PAUSE_MIN_GAP_SEC).toBe(0.3);
    expect(pausesNear(hello, 0, "start").map((p) => [p.sec, p.wordIndex])).toEqual([[1.42, 2]]);
    expect(snapEdge(hello, 0, "start")).toMatchObject({ sec: 1.42, cueIndex: 0, wordIndex: 2, kind: "sentence" });
    expect(snapEdge(hello, 0, "end")).toMatchObject({ sec: 1.0, cueIndex: 0, wordIndex: 1, kind: "sentence" });
  });

  it("respects maxShiftSec, and leaves an edge whose cue has no words unchanged", () => {
    /* MUTATION THAT KILLS THIS: drop the shift bound — the 1.42 s snap is
       taken under a 1 s bound. Ran it: red. */
    expect(PAUSE_MAX_SHIFT_SEC).toBe(4);
    expect(snapEdge(hello, 0, "start", { maxShiftSec: 1 })).toBeNull();
    expect(snapEdge(hello, 0, "end", { maxShiftSec: 1.9 })).toBeNull();
    expect(snapEdge(hello, 0, "end", { maxShiftSec: 2 })).toMatchObject({ sec: 1.0 });
    /* "this" now starts 5.42 s after the cue edge: past the default 4 s. */
    const far: TranscriptCue[] = [
      {
        ...hello[0]!,
        end_sec: 7,
        words: [
          { text: "hello", start: 0, end: 0.4 },
          { text: "world.", start: 0.5, end: 1.0 },
          { text: "this", start: 5.42, end: 5.7 },
          { text: "is", start: 5.8, end: 5.9 },
          { text: "it", start: 6.0, end: 6.5 }
        ]
      }
    ];
    expect(snapEdge(far, 0, "start")).toBeNull();
    const bare: TranscriptCue[] = [{ text: hello[0]!.text, start_sec: 0, end_sec: 3 }];
    expect(pausesNear(bare, 0, "start")).toEqual([]);
    expect(snapEdge(bare, 0, "end")).toBeNull();
  });

  it("prefers a pause after terminal punctuation over a nearer plain pause; requireSentence takes nothing else", () => {
    /* MUTATION THAT KILLS THIS: pick `pauses[0]` before the sentence pause —
       the nearer plain pause at 0.9 s wins. Ran it: red. */
    const cue: TranscriptCue[] = [
      {
        text: "so then we. went",
        start_sec: 0,
        end_sec: 3,
        words: [
          { text: "so", start: 0, end: 0.5 },
          { text: "then", start: 0.9, end: 1.2 },
          { text: "we.", start: 1.3, end: 1.6 },
          { text: "went", start: 2.0, end: 2.3 }
        ]
      }
    ];
    expect(pausesNear(cue, 0, "start").map((p) => p.sec)).toEqual([0.9, 2.0]);
    expect(snapEdge(cue, 0, "start")).toMatchObject({ sec: 2.0, kind: "sentence" });
    expect(snapEdge(cue, 0, "start", { requireSentence: true })).toMatchObject({ sec: 2.0 });
    const plain: TranscriptCue[] = [{ ...cue[0]!, text: "so then we went", words: cue[0]!.words!.map((w) => ({ ...w, text: w.text.replace(".", "") })) }];
    expect(snapEdge(plain, 0, "start")).toMatchObject({ sec: 0.9, kind: "pause" });
    expect(snapEdge(plain, 0, "start", { requireSentence: true })).toBeNull();
  });

  it("moves an edge back into the outward neighbour's words, but never into another speaker's", () => {
    /* The cue break falls after "And": the sentence ended at 8.0 s, inside
       the previous cue. MUTATION THAT KILLS THIS: drop the `sameSpeaker`
       check — the start pulls in the host's "And". Ran it: red. */
    const tape: TranscriptCue[] = [
      wordedCue(6, 10, [
        ["the job is done.", 6, 8.05],
        ["And", 8.6, 10.05]
      ]),
      wordedCue(10, 14, [["so we moved on", 10, 11.55]])
    ];
    expect(snapEdge(tape, 1, "start")).toMatchObject({ sec: 8.6, cueIndex: 0, wordIndex: 4, kind: "sentence" });
    expect(snapEdge(tape, 1, "start", { outward: false })).toBeNull();
    const twoVoices: TranscriptCue[] = [{ ...tape[0]!, speaker: "Host" }, { ...tape[1]!, speaker: "Guest" }];
    expect(snapEdge(twoVoices, 1, "start")).toBeNull();
  });
});

describe("cueWordsOf / cuesFromBodyJson — a body's word timings are kept only when they can be trusted", () => {
  const cue = { text: "Hello, world. It's fine", start_sec: 10, end_sec: 13 };
  const good = [
    { text: "Hello,", start: 10, end: 10.4 },
    { text: "world.", start: 10.5, end: 11 },
    { text: "It's", start: 11.5, end: 11.8 },
    { text: "fine", start: 11.9, end: 12.6 }
  ];

  it("keeps monotonic words inside the span (±0.5 s) that spell the cue's text, whisper's `word` key included", () => {
    expect(cueWordsOf(good, cue)).toEqual(good);
    expect(cueWordsOf(good.map(({ text, ...rest }) => ({ word: ` ${text}`, ...rest })), cue)).toEqual(good);
    expect(cueWordsOf([{ ...good[0]!, start: 9.6 }, ...good.slice(1)], cue)).toBeDefined();
  });

  it("drops a non-monotonic array, a word outside the span, and words that do not spell the cue", () => {
    /* MUTATIONS THAT KILL THIS: drop the monotonic check, the span check or
       the canonical-join check — the bad array is kept. Ran each: red. */
    expect(cueWordsOf([good[1], good[0], ...good.slice(2)], cue)).toBeUndefined();
    /* In the cue's order, spelling it, inside the span, but timed backwards. */
    expect(cueWordsOf([good[0], good[1], { text: "It's", start: 10.2, end: 10.3 }, good[3]], cue)).toBeUndefined();
    expect(cueWordsOf([{ ...good[0]!, start: 9.4 }, ...good.slice(1)], cue)).toBeUndefined();
    expect(cueWordsOf([...good.slice(0, 3), { text: "fine", start: 11.9, end: 13.6 }], cue)).toBeUndefined();
    expect(cueWordsOf([...good.slice(0, 3), { text: "good", start: 11.9, end: 12.6 }], cue)).toBeUndefined();
    expect(cueWordsOf(good.slice(0, 3), cue)).toBeUndefined();
    expect(cueWordsOf([{ ...good[0]!, end: Number.NaN }, ...good.slice(1)], cue)).toBeUndefined();
    expect(cueWordsOf([], cue)).toBeUndefined();
    expect(cueWordsOf("nope", cue)).toBeUndefined();
  });

  it("the reader carries `words` only when kept, and the cue's text never changes", () => {
    /* MUTATION THAT KILLS THIS: push `words` unconditionally — the cue whose
       words are bad carries `words: undefined` and stops deep-equalling the
       body read before GV-111. Ran it: red. */
    const cues = cuesFromBodyJson({ cues: [{ ...cue, words: good }, { text: "plain cue", start_sec: 14, end_sec: 16, words: [{ text: "other", start: 14, end: 15 }] }] })!;
    expect(cues[0]).toEqual({ ...cue, speaker: null, words: good });
    expect(cues[1]).toEqual({ text: "plain cue", start_sec: 14, end_sec: 16, speaker: null });
    expect("words" in cues[1]!).toBe(false);
  });
});

describe("cutWindowToSegment — snapToPauses moves the edges and re-mints the anchors from the words", () => {
  /* Cue 1 is the window. It opens on a lead-in ("Engineers explained
     honestly.") with a 0.45 s pause before "Turbine", and closes on
     "there." with a 0.45 s pause before a trailing remark. The cues
     either side carry no words and end on no full stop, so the pauses at the
     cue edges themselves are plain ones. */
  const lead = "Engineers explained honestly.";
  const body = "Turbine blades crack under thermal cycling stress every winter season because the alloy fatigues quickly and that is what we see all the time out there.";
  const tail = "Metallurgists recommend nickel cobalt chromium superalloys";
  const tape: TranscriptCue[] = [
    { text: "Welcome back everyone to another long episode of the program and", start_sec: 0, end_sec: 19 },
    wordedCue(20, 100, [
      [lead, 20, 21.55],
      [body, 22, 98.05],
      [tail, 98.5, 100.05]
    ]),
    { text: "next week we talk about something else entirely and", start_sec: 101, end_sec: 120 }
  ];
  const claim = "Turbine blades crack under thermal cycling stress.";
  const windowOf = (edges: Partial<TapeWindow> = {}): TapeWindow => ({
    firstCue: 1,
    lastCue: 1,
    startSec: 20,
    endSec: 100,
    matchedTerms: ["turbine", "blades"],
    distinctiveTerms: ["turbine", "blades"],
    claimTermCount: 6,
    share: 0.5,
    weightedShare: 0.5,
    score: 2,
    ...edges
  });
  const extended = (start: "turn" | "sentence" | "claim-only", end: "turn" | "sentence" | "claim-only") =>
    windowOf({ boundary: "claim-only", startBoundary: start, endBoundary: end, extendedBySec: 0, claimStartSec: 20, claimEndSec: 100 });

  it("with words and the option on: snapped times, anchors that are verbatim word runs starting (ending) at the snapped word, kinds upgraded", () => {
    /* MUTATIONS THAT KILL THIS: mint the snapped start anchor from the whole
       cue (`index.words[cue]`) — it opens on "engineers"; keep the cue edge
       times — 20/100; skip the kind upgrade — claim-only stays. Ran each: red. */
    const span = cutWindowToSegment(claim, tape, extended("claim-only", "claim-only"), { snapToPauses: true })!;
    expect(span.startSec).toBe(22);
    expect(span.endSec).toBe(98);
    const fromSnapped = canonicalizeForAnchorMatch(`${body}`);
    expect(canonicalizeForAnchorMatch(span.startAnchor)).toBe(fromSnapped.split(" ").slice(0, 8).join(" "));
    expect(span.startAnchor.startsWith("turbine blades")).toBe(true);
    /* The end anchor is a run of the words that END at "there." — never
       the trailing "Metallurgists recommend nickel superalloys" the cue goes
       on to, which the cue-edge anchor would quote. */
    expect(` ${canonicalizeForAnchorMatch(`${lead} ${body}`)} `).toContain(` ${canonicalizeForAnchorMatch(span.endAnchor)} `);
    expect(span.endAnchor).not.toMatch(/metallurgists|nickel|superalloys/);
    for (const anchor of [span.startAnchor, span.endAnchor]) {
      expect(phraseIsInWindow(anchor, tape[1]!.text)).toBe(true);
      expect(phraseIsInWindow(anchor, body)).toBe(true);
    }
    expect(span.startBoundary).toBe("sentence");
    expect(span.endBoundary).toBe("sentence");
    expect(span.boundary).toBe("sentence");
    expect(span.firstCue).toBe(1);
    expect(span.lastCue).toBe(1);
  });

  it("off, omitted, or on over cues without words: today's cut, byte for byte", () => {
    /* MUTATION THAT KILLS THIS: snap whenever words are present, ignoring
       the option — the off cut moves to 22 s. Ran it: red. */
    const today = cutWindowToSegment(claim, tape, extended("claim-only", "claim-only"))!;
    expect(today.startSec).toBe(20);
    expect(today.endSec).toBe(100);
    expect(today.startAnchor.startsWith("engineers explained honestly")).toBe(true);
    expect(today.endAnchor).toMatch(/superalloys$/);
    expect(cutWindowToSegment(claim, tape, extended("claim-only", "claim-only"), { snapToPauses: false })).toEqual(today);
    const bare: TranscriptCue[] = tape.map((cue) => ({ text: cue.text, start_sec: cue.start_sec, end_sec: cue.end_sec }));
    expect(cutWindowToSegment(claim, bare, extended("claim-only", "claim-only"), { snapToPauses: true })).toEqual(today);
    expect(cutWindowToSegment(claim, bare, windowOf(), { snapToPauses: true })).toEqual(cutWindowToSegment(claim, bare, windowOf()));
  });

  it("never moves a turn edge, and moves a sentence edge only to another sentence boundary", () => {
    /* MUTATION THAT KILLS THIS: drop the `startKind !== "turn"` guard — the
       turn start moves to 22 s. Ran it: red. */
    const turn = cutWindowToSegment(claim, tape, extended("turn", "claim-only"), { snapToPauses: true })!;
    expect(turn.startSec).toBe(20);
    expect(turn.startBoundary).toBe("turn");
    expect(turn.endSec).toBe(98);
    /* Strip the full stops: the pauses are now plain, so a sentence edge
       stays put, while a claim-only end takes the nearest plain pause (the
       one at its own cue edge, 1 s before the next cue) and stays
       claim-only. */
    const plainTape = tape.map((c) =>
      c.words ? { ...c, text: c.text.replace(/\./g, ""), words: c.words.map((w) => ({ ...w, text: w.text.replace(/\./g, "") })) } : c
    );
    const sentence = cutWindowToSegment(claim, plainTape, extended("sentence", "claim-only"), { snapToPauses: true })!;
    expect(sentence.startSec).toBe(20);
    expect(sentence.startBoundary).toBe("sentence");
    expect(sentence.endSec).toBe(100);
    expect(sentence.endBoundary).toBe("claim-only");
    expect(sentence.boundary).toBe("claim-only");
  });

  it("an unextended window snaps its times and anchors but gains no edge kinds", () => {
    const span = cutWindowToSegment(claim, tape, windowOf(), { snapToPauses: true })!;
    expect([span.startSec, span.endSec]).toEqual([22, 98]);
    expect(span.boundary).toBeUndefined();
    expect(span.startBoundary).toBeUndefined();
  });

  it("an outward snap may not push a capped cut past its ceiling", () => {
    /* The previous cue ends its sentence 1.4 s before the window's start; a
       ceiling of the whole-cue length leaves no room to reach back for it,
       so the capped cut takes the plain pause 1 s inside its own cue.
       MUTATION THAT KILLS THIS: drop `notBeforeSec` from the start snap —
       the sentence pause is picked, overruns the cap and is dropped whole,
       so the capped cut stays at 10 s. Ran it: red. */
    const twoCues: TranscriptCue[] = [
      wordedCue(6, 10, [
        ["the job is done.", 6, 8.05],
        ["Turbine", 8.6, 10.05]
      ]),
      wordedCue(10, 80, [
        ["blades", 10, 10.65],
        ["crack under thermal cycling stress every winter season because the alloy fatigues quickly", 11, 80.05]
      ])
    ];
    const window: TapeWindow = { ...windowOf(), firstCue: 1, lastCue: 1, startSec: 10, endSec: 80 };
    expect(cutWindowToSegment(claim, twoCues, window, { snapToPauses: true })!.startSec).toBe(8.6);
    expect(cutWindowToSegment(claim, twoCues, window, { snapToPauses: true, maxSec: 70 })!.startSec).toBe(11);
  });
});

describe("FileTranscriptCueProvider — bodies carrying words count four times in the cue cache", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gv111-"));
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, "normalized");
  const dir = path.join(root, "worded-show");
  fs.mkdirSync(dir, { recursive: true });
  const entries: TranscriptDigestEntry[] = [];
  const COUNT = CUE_CACHE_WORDS_MAX_ENTRIES + 10;
  for (let i = 0; i < COUNT; i++) {
    const guid = `ep${i}`;
    const words = [
      { text: "episode", start: 0, end: 1 },
      { text: String(i), start: 1.1, end: 2 }
    ];
    fs.writeFileSync(path.join(dir, `${guid}.json`), JSON.stringify({ guid, cues: [{ text: `episode ${i}`, start_sec: 0, end_sec: 2, words }] }));
    entries.push({ show_id: "worded-show", show_title: "Worded Show", guid, title: `Episode ${i}`, cues: 1 });
  }

  it("holds at most CUE_CACHE_WORDS_MAX_ENTRIES worded bodies, and forgetting a show frees their weight", () => {
    /* MUTATION THAT KILLS THIS: weigh every entry 1 — the cache holds all 74.
       And: skip the weight in `forgetShow`'s delete — after forgetting, a
       refill holds fewer than 64. Ran both: red. */
    const provider = new FileTranscriptCueProvider(root);
    for (const entry of entries) expect(provider.getCues(entry)?.[0]?.words).toHaveLength(2);
    expect(provider.cachedCueCount()).toBe(CUE_CACHE_WORDS_MAX_ENTRIES);
    expect(CUE_CACHE_MAX_ENTRIES / CUE_CACHE_WORDS_MAX_ENTRIES).toBe(4);
    provider.forgetShow("worded-show");
    expect(provider.cachedCueCount()).toBe(0);
    for (const entry of entries) provider.getCues(entry);
    expect(provider.cachedCueCount()).toBe(CUE_CACHE_WORDS_MAX_ENTRIES);
  });
});
