import { describe, it, expect } from "vitest";
import {
  extendToThought,
  relevanceScorer,
  thoughtTerms,
  PARAGRAPH_CUE_SEC,
  QUESTION_TURN_MAX_SEC,
  RELEVANCE_FLOOR,
  RELEVANCE_WINDOW_SEC,
  THOUGHT_PAUSE_SEC
} from "../src/generation/tapeExtent";
import {
  ABSOLUTE_MIN_TAPE_SEGMENT_SEC,
  canonicalizeForAnchorMatch,
  cutWindowToSegment,
  indexCues,
  MAX_TAPE_SEGMENT_SEC,
  MIN_TAPE_SEGMENT_SEC,
  TAPE_CLAIM_SEARCH_MAX_SEC,
  TAPE_CLAIM_SEARCH_MIN_SEC,
  TAPE_CUE_GAP_MAX_SEC,
  TAPE_WINDOW_MAX_SEC,
  TAPE_WINDOW_MIN_SEC,
  type TapeWindow,
  type TranscriptCue
} from "../src/generation/transcriptArchiveLookup";

/**
 * Q-01: a clip starts and ends at thought boundaries and runs while the
 * content stays relevant (`tapeExtent.ts`). Every case names the mutation
 * that kills it. The fixtures are cue lists in the shape the archive's
 * normalized bodies have — `{ text, start_sec, end_sec, speaker? }` — with the
 * timings chosen so the sixty-second relevance grid and the boundaries fall
 * where the case needs them; the numbers are stated beside each.
 */

const claim = "Gearboxes fail because bearings take torque reversals.";
const thesis = "Why turbines break early.";

const cue = (start: number, end: number, text: string, speaker?: string): TranscriptCue => ({
  text,
  start_sec: start,
  end_sec: end,
  ...(speaker ? { speaker } : {})
});

/** A claim window over cues `first..last`, as `selectTapeWindow` would hand it
 * over — the extension reads only the four position fields. */
function windowAt(cues: TranscriptCue[], first: number, last: number): TapeWindow {
  return {
    firstCue: first,
    lastCue: last,
    startSec: cues[first]!.start_sec,
    endSec: cues[last]!.end_sec,
    matchedTerms: [],
    distinctiveTerms: [],
    claimTermCount: 0,
    share: 0,
    weightedShare: 0,
    score: 0
  };
}

const terms = () => ({ claimTerms: thoughtTerms(claim), thesisTerms: thoughtTerms(thesis) });

/* -------------------------------------------------------------- fixtures */

/** A host intro, a pause, the host's question, the guest's four-cue answer,
 * then the host moving on. The claim window is the MIDDLE of the answer
 * (cues 5-6, 95-135 s): opening mid-answer and closing mid-answer, exactly the
 * cut the founder complained about. Turns are carried by `speaker`; the only
 * pause is the 1 s before the question (cue 2 ends at 59, cue 3 starts at 60),
 * so without turns the sentence rule finds precisely one boundary. */
const qa: TranscriptCue[] = [
  cue(0, 20, "Welcome back to the show, this week we are in Denver.", "Host"),
  cue(20, 40, "The coffee here is excellent and the hotels are cheap.", "Host"),
  cue(40, 59, "Earlier we were arguing about which coffee machine to buy.", "Host"),
  cue(60, 75, "So tell me, why do gearboxes fail early on these turbines?", "Host"),
  cue(75, 95, "Well, the gearboxes fail because the bearings take torque reversals.", "Guest"),
  cue(95, 115, "Every rotation the torque comes back the other way and the bearings crack.", "Guest"),
  cue(115, 135, "So the bearings crack under torque that keeps switching direction.", "Guest"),
  cue(135, 155, "That is why the gearboxes fail well before the design life says.", "Guest"),
  cue(155, 170, "Fascinating. Let us talk about the conference next month.", "Host"),
  cue(170, 230, "The conference is in Denver and the keynote is about coffee machines and hotels.", "Host"),
  cue(230, 290, "I love Denver, the coffee there is excellent and the hotels are cheap.", "Guest")
];

/** No speakers. Twenty-second cues one second apart (a pause after every
 * sentence), an off-topic lead-in, eight cues about the claim, then the host
 * moving on. Cues 8 and 9 end WITHOUT a full stop — their sentence finishes in
 * cue 10, which says nothing about the claim — so the sixty-second grid, which
 * runs out at 203 s, reaches into a sentence that no boundary closes. */
const monologue: TranscriptCue[] = [
  cue(0, 20, "Welcome back to the show, this week we are in Denver."),
  cue(21, 41, "The coffee here is excellent and the hotels are cheap."),
  cue(42, 62, "The gearboxes fail because the bearings take torque reversals."),
  cue(63, 83, "Every rotation the torque comes back and the bearings crack."),
  cue(84, 104, "So the bearings crack under torque that keeps switching direction."),
  cue(105, 125, "That is why the gearboxes fail well before the design life says."),
  cue(126, 146, "The torque reversals were never in the original load case at all."),
  cue(147, 167, "And the bearings that take them were never sized for reversals."),
  cue(168, 188, "So when the torque reverses the gearboxes"),
  cue(189, 209, "fail and the bearings crack, every time, and"),
  cue(210, 230, "that is the whole story, honestly."),
  cue(231, 251, "The conference is in Denver and the keynote is about coffee machines."),
  cue(252, 272, "I love Denver, the coffee there is excellent and the hotels are cheap.")
];

/* ------------------------------------------------------------------ cases */

describe("extendToThought — Q-01: thought boundaries, relevance, the clamp", () => {
  it("with turns, opens at the host's question and closes at the end of the answer (boundary: turn)", () => {
    /* The claim window is cues 5-6 (95-135 s), mid-answer both ends. The
       nearest boundary before it is the guest's turn start (cue 4, 75 s); the
       turn before that ends in a fifteen-second question, so the clip opens on
       the question (60 s). After the window the answer runs to cue 7 and the
       host's turn begins at 155 s, which is the end. 95 s of tape for a 40 s
       claim window, both edges on turns.

       MUTATION THAT KILLS THIS: delete step 3 (`questionEndingAt`) — the clip
       opens at 75 s, on "Well, the gearboxes fail", and the listener never
       hears what was asked. Ran it — red on the start. */
    const extent = extendToThought(windowAt(qa, 5, 6), qa, terms());
    expect(extent.startSec).toBe(60);
    expect(extent.endSec).toBe(155);
    expect(extent.boundary).toBe("turn");
    expect(extent.extendedBySec).toBe(55);
    expect(extent.claimStartSec).toBe(95);
    expect(extent.claimEndSec).toBe(135);
  });

  it("a question longer than QUESTION_TURN_MAX_SEC is not the question, and relevance decides it", () => {
    /* The same tape with the host's whole intro run into one seventy-five
       second cue that ends in a question mark and says nothing about the claim:
       a monologue with a question on the end. Relevance refuses it (nothing in
       it is about gearboxes) and the question rule does not override that, so
       the clip opens at the guest's turn (75 s). MUTATION THAT KILLS THIS: drop
       the `QUESTION_TURN_MAX_SEC` check in `questionEndingAt` — the clip opens
       at 0 s on a minute of coffee talk. */
    const longQuestion: TranscriptCue[] = [
      cue(0, 75, "Welcome back to the show, this week we are in Denver, the coffee is excellent and the hotels are cheap, so what happened next?", "Host"),
      ...qa.slice(4)
    ];
    expect(75 - 0).toBeGreaterThan(QUESTION_TURN_MAX_SEC);
    const extent = extendToThought(windowAt(longQuestion, 2, 3), longQuestion, terms());
    expect(extent.startSec).toBe(75);
    expect(extent.boundary).toBe("turn");
  });

  it("with no turns, moves to sentence boundaries marked by a pause (boundary: sentence)", () => {
    /* The claim window is cues 2-3 (42-83 s). Every cue here ends a sentence
       and is followed by a one-second pause, so both edges snap to sentence
       boundaries; and with nothing off-topic said before cue 2, the start stays
       where it is.

       MUTATION THAT KILLS THIS: require `gap >= THOUGHT_PAUSE_SEC` to be
       `gap > 1` — no boundary is found anywhere and the extent is
       `claim-only` at 42-83 s. */
    const extent = extendToThought(windowAt(monologue, 2, 3), monologue, terms());
    expect(extent.boundary).toBe("sentence");
    expect(extent.startSec).toBe(42);
    expect(extent.endSec).toBeGreaterThan(83);
  });

  it("a sentence end without a pause is not a boundary — unless the cue is a paragraph (PARAGRAPH_CUE_SEC)", () => {
    /* Contiguous twenty-second cues (gap 0): a full stop alone moves nothing.
       Make the cue before the claim window forty seconds long and its full
       stop counts, because a cue that size is the transcriber's paragraph. */
    const tight: TranscriptCue[] = [
      cue(0, 20, "Welcome back to the show, this week we are in Denver."),
      cue(20, 40, "The coffee here is excellent and the hotels are cheap."),
      cue(40, 60, "The gearboxes fail because the bearings take torque reversals."),
      cue(60, 80, "Every rotation the torque comes back and the bearings crack."),
      cue(80, 100, "So the bearings crack under torque that keeps switching direction."),
      cue(100, 120, "Anyway, that is enough of that, let us talk about the conference."),
      cue(120, 140, "The conference is in Denver and the keynote is about coffee machines.")
    ];
    const none = extendToThought(windowAt(tight, 2, 4), tight, terms());
    expect(none.boundary).toBe("claim-only");
    expect(none.startSec).toBe(40);
    expect(none.endSec).toBe(100);

    const paragraph: TranscriptCue[] = [
      cue(0, 40, "Welcome back to the show, this week we are in Denver. The coffee here is excellent and the hotels are cheap."),
      ...tight.slice(2)
    ];
    expect(40).toBeGreaterThanOrEqual(PARAGRAPH_CUE_SEC);
    const found = extendToThought(windowAt(paragraph, 1, 3), paragraph, terms());
    expect(found.startSec).toBe(40);
    /* The start is a sentence boundary now; the end still is not. The weaker
       edge names the extent. */
    expect(found.boundary).toBe("claim-only");
  });

  it("keeps extending while sixty-second windows stay relevant, stops at the drift and backs up to the last boundary before it", () => {
    /* The claim window is cues 2-3 (42-83 s). The answer stays on the claim
       through cue 9 (209 s) and the tape drifts from 210 s. The grid from 83 s
       passes [83,143) and [143,203) and fails [203,263) — cue 9 straddles
       203 s by six seconds, under the overlap a cue needs to count toward a
       minute, and the minute holds nothing else about the claim — so the reach
       is cue 9, the last cue the passing minutes counted. Cues 8 and 9 end
       mid-sentence; the last BOUNDARY at or before the reach is the end of
       cue 7 (167 s), and that is the cut.

       MUTATION THAT KILLS THIS: in `extendToThought`'s end step 2, replace
       `lastEndBoundaryUpTo(shape, reachCue, last)` with `{ cue: reachCue,
       kind: "sentence" }` — the clip ends at 209 s, on "every time, and",
       with the sentence finishing in the next cue. Ran it — red. */
    const extent = extendToThought(windowAt(monologue, 2, 3), monologue, terms());
    expect(extent.endSec).toBe(167);
    expect(extent.boundary).toBe("sentence");
    expect(extent.extendedBySec).toBe(167 - 42 - (83 - 42));
    /* And the same window, with the subject change moved to right after the
       claim window, stops at the nearest boundary: the drift is measured, not
       assumed. */
    const shortAnswer: TranscriptCue[] = [...monologue.slice(0, 4), ...monologue.slice(10)];
    const stopped = extendToThought(windowAt(shortAnswer, 2, 3), shortAnswer, terms());
    expect(stopped.endSec).toBe(83);
  });

  it("scores relevance the way the search does: the corpus idf discounts the trade's everyday words", () => {
    /* Two minutes: one says a rare claim word, the other only a common one.
       With every word weighing one both minutes score; with the search's idf —
       `bearings` rare, `fail` everywhere — the common minute falls under the
       floor. MUTATION THAT KILLS THIS: score by plain term count. */
    const cues: TranscriptCue[] = [
      cue(0, 60, "The bearings were the part everybody had trouble with on those machines."),
      cue(60, 120, "Things fail, and when they fail you find out why they fail.")
    ];
    const index = indexCues(cues);
    const unweighted = relevanceScorer(index, { claimTerms: thoughtTerms(claim) });
    expect(unweighted(0, 60)).toBeGreaterThanOrEqual(RELEVANCE_FLOOR);
    expect(unweighted(60, 120)).toBeGreaterThanOrEqual(RELEVANCE_FLOOR);
    const idf = new Map<string, number>();
    for (const t of thoughtTerms(claim)) idf.set(t, t === "fail" ? 0.05 : 5);
    const weighted = relevanceScorer(index, { claimTerms: thoughtTerms(claim), idf });
    expect(weighted(0, 60)).toBeGreaterThanOrEqual(RELEVANCE_FLOOR);
    expect(weighted(60, 120)).toBeLessThan(RELEVANCE_FLOOR);
  });

  it("scores the claim and the thesis as two shares and takes the larger — a thesis the tape never says costs nothing (F-96)", () => {
    /* RUN 9'S LIVE TIMIDITY, PINNED. The idf the window search hands over
       holds the claim's terms only, so every thesis word weighed 1 — the
       claim's rarest word's weight — and a twenty-word thesis the guest never
       spoke diluted a claim-continuing minute below the floor. Two minutes:
       the first continues the CLAIM, the second turns to the THESIS's subject.
       Under the old union query, with the claim's idf and none for the
       thesis, the first minute scores 2 words of 5 + 20 = under 0.08 and the
       clip stops; scored as two shares, it is the claim's own 0.4 and the
       second minute is the thesis's. MUTATION THAT KILLS THIS: fold the two
       lists into one query and divide by the union's weight. */
    const cues: TranscriptCue[] = [
      cue(0, 60, "The bearings crack because the torque keeps switching direction on them."),
      cue(60, 120, "The turbines break early, years early, and the operators are the ones who pay.")
    ];
    const longThesis =
      "Why the turbines on these farms break early and what it costs the operators who bought them on a twenty year design life that nobody had tested.";
    const idf = new Map<string, number>();
    for (const t of thoughtTerms(claim)) idf.set(t, 5);
    const index = indexCues(cues);
    const scorer = relevanceScorer(index, { claimTerms: thoughtTerms(claim), thesisTerms: thoughtTerms(longThesis), idf });
    const claimOnly = relevanceScorer(index, { claimTerms: thoughtTerms(claim), idf });
    /* The claim minute scores exactly what it scores without the thesis. */
    expect(scorer(0, 60)).toBe(claimOnly(0, 60));
    expect(scorer(0, 60)).toBeGreaterThanOrEqual(RELEVANCE_FLOOR);
    /* And the thesis minute, which says none of the claim, still passes on
       the thesis's own share. */
    expect(claimOnly(60, 120)).toBe(0);
    expect(scorer(60, 120)).toBeGreaterThanOrEqual(RELEVANCE_FLOOR);
    /* What the union did: a share of the combined weight, the thesis at 1 a
       word — the claim minute's score cut to a fraction of itself by words
       the guest never said (under half here; live, under the floor). */
    const unionTerms = [...new Set([...thoughtTerms(claim), ...thoughtTerms(longThesis)])];
    const unionScorer = relevanceScorer(index, { claimTerms: unionTerms, idf });
    expect(unionScorer(0, 60)).toBeLessThan(claimOnly(0, 60) / 2);
  });

  it("cutWindowToSegment never shortens an extended window below the boundary the extension found", () => {
    /* The cut GROWS towards the floor and mints anchors; it has no step that
       moves an edge inwards. Stated over every extent the fixtures produce.
       MUTATION THAT KILLS THIS: in `cutWindowToSegment`, clamp `last` back to
       `window.lastCue - 1` when the span is over the search band. */
    for (const [cues, first, last] of [
      [qa, 5, 6],
      [qa, 4, 4],
      [monologue, 2, 3],
      [monologue, 6, 7]
    ] as Array<[TranscriptCue[], number, number]>) {
      const extent = extendToThought(windowAt(cues, first, last), cues, terms());
      const span = cutWindowToSegment(claim, cues, extent)!;
      expect(span.firstCue).toBeLessThanOrEqual(extent.firstCue);
      expect(span.lastCue).toBeGreaterThanOrEqual(extent.lastCue);
      expect(span.startSec).toBeLessThanOrEqual(extent.startSec);
      expect(span.endSec).toBeGreaterThanOrEqual(extent.endSec);
    }
  });

  it("caps at maxSec at a boundary, and leaves the floor to the cut's claim-overlap growth rather than padding (F-62)", () => {
    /* THE FLOOR IS A TARGET, NOT A PAD. One twenty-second claim cue between
       off-topic sentences comes out of the extension twenty seconds long —
       nothing around it is about the claim, so nothing is added — and
       `cutWindowToSegment` then grows it the way F-62 always has: through cues
       that share the claim (none here), else only up to the least playable
       length. A round minute of the host's coffee talk is exactly the cut F-62
       removed. MUTATION THAT KILLS THIS: pad the extent forward by whole cues
       to `minSec` — the extent comes back 42-104 s. */
    const shortTape: TranscriptCue[] = [
      ...monologue.slice(0, 3),
      cue(63, 83, "Anyway, that is enough of that, let us talk about the conference."),
      cue(84, 104, "The conference is in Denver and the keynote is about coffee machines."),
      cue(105, 125, "I love Denver, the coffee there is excellent and the hotels are cheap.")
    ];
    const short = extendToThought(windowAt(shortTape, 2, 2), shortTape, terms());
    expect(short.startSec).toBe(42);
    expect(short.endSec).toBe(62);
    const grown = cutWindowToSegment(claim, shortTape, short)!;
    expect(grown.endSec - grown.startSec).toBeGreaterThanOrEqual(ABSOLUTE_MIN_TAPE_SEGMENT_SEC);
    expect(grown.endSec - grown.startSec).toBeLessThan(TAPE_WINDOW_MIN_SEC);
    /* And a cut whose growth moved an edge off the extension's boundary says
       `claim-only` rather than claim a boundary it no longer sits on. */
    expect(grown.boundary).toBe("claim-only");

    /* The ceiling. Twenty relevant cues (420 s) and a 200 s ceiling: the grid
       stops where the next minute would pass the budget, and the end backs up
       to the boundary before it. Never a second over, never mid-sentence. */
    const long: TranscriptCue[] = [cue(0, 20, "Welcome back to the show, this week we are in Denver."), cue(21, 41, "The coffee here is excellent.")];
    for (let k = 2; k < 22; k++) long.push(cue(21 * k, 21 * k + 20, "The gearboxes fail because the bearings take torque reversals."));
    const capped = extendToThought(windowAt(long, 2, 3), long, { ...terms(), maxSec: 200 });
    expect(capped.endSec - capped.startSec).toBeLessThanOrEqual(200);
    expect(capped.endSec - capped.startSec).toBeGreaterThan(120);
    expect(long.some((c) => c.end_sec === capped.endSec)).toBe(true);
    expect(capped.boundary).toBe("sentence");
  });

  it("never crosses a hole in the tape (TAPE_CUE_GAP_MAX_SEC), however relevant the far side", () => {
    /* The monologue with a ten-second hole after cue 5 (125 s): the far side
       is about the claim, and the clip still ends at the hole. */
    const holed = monologue.map((c, k) => (k >= 6 ? cue(c.start_sec + 10, c.end_sec + 10, c.text) : c));
    expect(holed[6]!.start_sec - holed[5]!.end_sec).toBeGreaterThan(TAPE_CUE_GAP_MAX_SEC);
    const extent = extendToThought(windowAt(holed, 2, 3), holed, terms());
    expect(extent.endSec).toBe(125);
  });

  it("is claim-only when no boundary of any kind exists, and moves nothing", () => {
    /* No speakers, no punctuation, no pauses, the transcript's own edges a
       minute away on either side and off-topic. Nothing to snap to, so the
       window is returned as it was, and says so. */
    const flat: TranscriptCue[] = [
      cue(0, 20, "welcome back to the show this week we are in denver"),
      cue(20, 40, "the coffee here is excellent and the hotels are cheap"),
      cue(40, 60, "earlier we were arguing about which coffee machine to buy"),
      cue(60, 80, "the gearboxes fail because the bearings take torque reversals"),
      cue(80, 100, "every rotation the torque comes back and the bearings crack"),
      cue(100, 120, "so the bearings crack under torque that keeps switching direction"),
      cue(120, 140, "anyway that is enough of that let us talk about the conference"),
      cue(140, 160, "the conference is in denver and the keynote is about coffee machines"),
      cue(160, 180, "i love denver the coffee there is excellent and the hotels are cheap")
    ];
    const extent = extendToThought(windowAt(flat, 3, 5), flat, terms());
    expect(extent.boundary).toBe("claim-only");
    expect(extent.startSec).toBe(60);
    expect(extent.endSec).toBe(120);
    expect(extent.extendedBySec).toBe(0);
  });

  it("anchors still resolve: cutWindowToSegment mints the tape's own words at the extended edges and carries the two fields", () => {
    /* ADR-0007's constraint is untouched by the extension: the edges are cue
       boundaries, and the anchors are runs of the cues' own words at them —
       here the question's and the answer's last sentence's. */
    const extent = extendToThought(windowAt(qa, 5, 6), qa, terms());
    const span = cutWindowToSegment(claim, qa, extent)!;
    expect(span).not.toBeNull();
    expect(span.startSec).toBe(60);
    expect(span.endSec).toBe(155);
    expect(canonicalizeForAnchorMatch(qa[3]!.text)).toContain(span.startAnchor);
    expect(canonicalizeForAnchorMatch(qa[7]!.text)).toContain(span.endAnchor);
    expect(span.boundary).toBe("turn");
    expect(span.extendedBySec).toBe(55);
    /* And a bare window — never extended — cuts to a span that carries
       neither, so a row minted before Q-01 is byte-for-byte what it was. */
    const bare = cutWindowToSegment(claim, qa, windowAt(qa, 4, 7))!;
    expect(bare.boundary).toBeUndefined();
    expect(bare.extendedBySec).toBeUndefined();
  });

  it("pins the hand-set numbers and the bands the extension is clamped to", () => {
    /* The two bands are two different objects (Q-01): the claim SEARCH keeps
       its 30-180 s band, and the tape window a listener hears is 60-1800 s —
       the founder's "let it ride" ceiling. The segment's own floor and
       ceiling are the window's. MUTATION THAT KILLS THIS: put
       `TAPE_WINDOW_MAX_SEC` back to 180. */
    expect(TAPE_CLAIM_SEARCH_MIN_SEC).toBe(30);
    expect(TAPE_CLAIM_SEARCH_MAX_SEC).toBe(180);
    expect(TAPE_WINDOW_MIN_SEC).toBe(60);
    expect(TAPE_WINDOW_MAX_SEC).toBe(1800);
    expect(MIN_TAPE_SEGMENT_SEC).toBe(TAPE_WINDOW_MIN_SEC);
    expect(MAX_TAPE_SEGMENT_SEC).toBe(TAPE_WINDOW_MAX_SEC);
    /* And the measured ones — see each constant's note for the numbers. */
    expect(RELEVANCE_FLOOR).toBe(0.08);
    expect(RELEVANCE_WINDOW_SEC).toBe(60);
    expect(THOUGHT_PAUSE_SEC).toBe(0.7);
    expect(PARAGRAPH_CUE_SEC).toBe(30);
    expect(QUESTION_TURN_MAX_SEC).toBe(60);
  });
});
