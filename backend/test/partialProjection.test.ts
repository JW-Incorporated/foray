import { describe, it, expect } from "vitest";
import { buildPartialCandidate, type PartialActInfo, type PartialCandidateMeta } from "../src/generation/partialCandidate";
import {
  buildProjectedItems,
  projectedRuleOf,
  projectedNarrationSec,
  PROJECTED_RULES,
  PARTIAL_RULES,
  type PartialProjectionPlan
} from "../src/generation/partialProjection";
import type { FinalizeForayInput, FinalizeForayResult, ForaySlot } from "../src/generation/finalizeForay";
import type { ForayItem } from "../src/generation/forayItems";
import type { SourcedAct, SourcedBeat } from "../src/types/tapeSourcing";
import { MODE_CHAR_BANDS } from "../src/types/narration";

/**
 * F-79 — a partial candidate is judged on the PROJECTED whole for the rules
 * that are shares of the whole (M4, D2-end, D4-share; Q-04 retired D3 and
 * D5's IQR clause, and F-101 took them out of the table) and on
 * itself for every monotone rule. The real `check-forays.mjs` cannot be
 * loaded under Vitest on this checkout (a path with a space — see
 * `RunPipelineDeps.finalize`), so the checker is stood in for by a fake
 * `finalize` that computes M4 EXACTLY as `check-forays.mjs` does (count share
 * and tape-runtime share per episode, 25 % cap, the checker's own message
 * text) from the items it is handed, plus whatever monotone lines a test
 * tells it to emit. The merge logic under test never reads the fake's
 * arithmetic — only its message lines — which is the same contract it has
 * with the real checker.
 */

/* ---- the tape --------------------------------------------------------- */

/** Run 5's shape, in miniature: act 1 carries 6 segments, one of them (the
 * Comma AI episode, `ep-a`) long enough to be 26.7 % of the act's tape while
 * being 1 of 6 (16.7 %) of its segments — the M4 runtime clause fires on the
 * slice and would not on the whole. */
const SEG: Record<string, { itemId: string; sec: number }> = {
  "ep-a#1": { itemId: "ep-a", sec: 200 },
  "ep-b#1": { itemId: "ep-b", sec: 110 },
  "ep-c#1": { itemId: "ep-c", sec: 110 },
  "ep-d#1": { itemId: "ep-d", sec: 110 },
  "ep-e#1": { itemId: "ep-e", sec: 110 },
  "ep-f#1": { itemId: "ep-f", sec: 110 }
};
/* 19 later segments, 120 s each, one per episode — the whole is 25 segments. */
for (let i = 1; i <= 19; i++) SEG[`ep-${i}#1`] = { itemId: `ep-${i}`, sec: 120 };
/* Eight more from `ep-a`, for the over-the-cap plan. */
for (let i = 2; i <= 9; i++) SEG[`ep-a#${i}`] = { itemId: "ep-a", sec: 120 };

const disclosure: ForayItem = {
  type: "narration",
  id: "disclosure",
  script: "This Foray was assembled by a machine from tape the machine chose. The narration is written by a language model.",
  mode: "marker",
  slot: "opening"
};

const partialItems: ForayItem[] = [
  disclosure,
  { type: "narration", id: "act-1-introduction", script: "A written introduction, long enough to clear the Hinge floor.", mode: "frame", slot: "opening" },
  ...Object.keys(SEG)
    .slice(0, 6)
    .map((segment_id): ForayItem => ({ type: "segment", segment_id, slot: "opening" }))
];
const partialTapeSec = 200 + 5 * 110; // 750

function tapeBeat(segmentId: string): SourcedBeat {
  const { itemId, sec } = SEG[segmentId]!;
  return {
    sourcing: "tape",
    claim: `claim for ${segmentId}`,
    exploration: false,
    tape: { segmentId, itemId, startSec: 100, endSec: 100 + sec, startAnchor: "start words", endAnchor: "end words", tier: 2, confidence: "medium" }
  };
}
function narrationBeat(mode: "Patch" | "Carry"): SourcedBeat {
  return { sourcing: "narration", claim: `a ${mode} beat`, exploration: false, narration: { mode, reason: "fixture" } };
}

/** Three acts. Act 1 is the written one (its beats are never projected);
 * acts 2 and 3 carry `laterSegmentIds` between them plus two narration beats.
 * The second act reuses act 1's slot TITLE ("Opening") so the de-duplicated
 * id (`opening-2`) is what a projected item must carry. */
function plan(laterSegmentIds: string[]): PartialProjectionPlan {
  const half = Math.ceil(laterSegmentIds.length / 2);
  const sourcedActs: SourcedAct[] = [
    { title: "Act 1", slots: [{ title: "Opening", beats: Object.keys(SEG).slice(0, 6).map(tapeBeat) }] },
    {
      title: "Act 2",
      slots: [
        { title: "Opening", beats: [narrationBeat("Patch"), ...laterSegmentIds.slice(0, half).map(tapeBeat)] },
        { title: "Middle", beats: [narrationBeat("Carry")] }
      ]
    },
    { title: "Act 3", slots: [{ title: "Closing", beats: laterSegmentIds.slice(half).map(tapeBeat) }] }
  ];
  const slots: ForaySlot[] = [
    { id: "opening", title: "Opening" },
    { id: "opening-2", title: "Opening" },
    { id: "middle", title: "Middle" },
    { id: "closing", title: "Closing" }
  ];
  return { sourcedActs, slots };
}

const laterDistinct = Array.from({ length: 19 }, (_, i) => `ep-${i + 1}#1`);
const laterEpAHeavy = [...Array.from({ length: 8 }, (_, i) => `ep-a#${i + 2}`), ...laterDistinct.slice(0, 11)];

/* ---- the stand-in checker ---------------------------------------------- */

const M4_SHARE_MAX = 0.25;

/** M4 as `check-forays.mjs` computes it: per-episode share of segments and of
 * TAPE runtime, both capped at 25 %, in the checker's own words. */
function m4Lines(input: FinalizeForayInput): string[] {
  const played = input.items.filter((i): i is Extract<ForayItem, { type: "segment" }> => i.type === "segment").map((i) => SEG[i.segment_id]!);
  const tape = played.reduce((a, p) => a + p.sec, 0);
  const byEpisode = new Map<string, { n: number; sec: number }>();
  for (const p of played) {
    const e = byEpisode.get(p.itemId) ?? { n: 0, sec: 0 };
    e.n++;
    e.sec += p.sec;
    byEpisode.set(p.itemId, e);
  }
  const out: string[] = [];
  for (const [itemId, e] of byEpisode) {
    const nShare = e.n / played.length;
    const secShare = e.sec / tape;
    if (nShare > M4_SHARE_MAX || secShare > M4_SHARE_MAX) {
      out.push(`foray "${input.id}": M4 FAIL: "${itemId}" is ${(nShare * 100).toFixed(1)} % of segments and ${(secShare * 100).toFixed(1)} % of runtime, over the 25 % cap`);
    }
  }
  return out;
}

function fakeChecker(extra: (input: FinalizeForayInput) => string[] = () => []) {
  const seen: FinalizeForayInput[] = [];
  const fn = async (input: FinalizeForayInput): Promise<FinalizeForayResult> => {
    seen.push(input);
    const checkForaysErrors = [...m4Lines(input), ...extra(input)];
    return {
      validation: { ok: checkForaysErrors.length === 0, checkForaysErrors, checkForaysWarnings: ["fixture warning"], checkNarrationErrors: [], checkNarrationWarnings: [] },
      forayRecord: checkForaysErrors.length === 0 ? { id: input.id, generated: true } : undefined,
      timings: []
    };
  };
  return { fn, seen };
}

const isPartialCall = (input: FinalizeForayInput): boolean => input.items.length === partialItems.length;

const info: PartialActInfo = {
  actIndex: 0,
  totalActs: 3,
  allActTitles: ["Act 1", "Act 2", "Act 3"],
  items: partialItems,
  slots: [{ id: "opening", title: "Opening" }],
  runtimeSec: partialTapeSec + 12.5,
  ttlA1Ms: 1000
};
const meta: PartialCandidateMeta = { id: "f-79", title: "T", topic: "technology/ai", summary: "s", authorId: "founder-1", builtAt: "2026-09-11T00:00:00.000Z" };

/* ---- tests ------------------------------------------------------------- */

describe("projectedRuleOf — which check-forays lines are shares of the whole", () => {
  it("names M4, D2's end-of-Foray clause and D4's share clause, and nothing monotone — and no longer names Q-04's retired D3 or D5-IQR", () => {
    /* MUTATION THAT KILLS THIS: match D5 or D2 on the rule prefix alone
       (`/^D5 FAIL/`). D5's consecutive-pair clause and D2's run clause —
       both local, both monotone — would then be read from the projection and
       a partial with two near-identical segments in a row would pass on
       an estimate. Ran it — red on the two `null` lines below.
       SECOND MUTATION (F-101): put `["D3", /^D3 FAIL:/]` back in
       `PROJECTED_RULE_PATTERNS`. Q-04 retired D3 and restated D5's IQR
       clause out of existence, and for two cards this table still listed
       both — red on the two `toBeNull()` lines added below, and red in
       `partialProjectionRules.test.ts`, which asks the real checker. */
    const id = 'foray "x": ';
    expect(projectedRuleOf(`${id}M4 FAIL: "ep" is 16.7 % of segments, over the 25 % cap`)).toBe("M4");
    expect(projectedRuleOf(`${id}D2 FAIL: the Foray ends on two consecutive segments under 60 s (x onward); the rule requires a following segment of at least 150 s, and there is none`)).toBe("D2-end");
    expect(projectedRuleOf(`${id}D4 FAIL: 3/10 segments are \`quote\`, over the 20 % cap`)).toBe("D4-share");

    /* Retired by Q-04. Were the checker ever to emit them again they would be
       monotone-by-default, which is the safe direction: judged on the partial. */
    expect(projectedRuleOf(`${id}D3 FAIL: mean segment duration 76.1 s is under the 90 s floor`)).toBeNull();
    expect(projectedRuleOf(`${id}D5 FAIL: interquartile range 15.6 s is under the 45 s floor (R-7)`)).toBeNull();

    /* D5's pair message. F-102 made it a WARNING — the checker emits no
       `D5 FAIL` string at all any more, which `partialProjectionRules.test.ts`
       asserts live — so this line is now hypothetical, and kept because the
       answer must stay `null` if the clause is ever gated again: the offending
       pair is already in the partial's own prefix, so it is monotone. */
    expect(projectedRuleOf(`${id}D5 FAIL: a / b are 100.0 / 105.0 s — two consecutive clips within +/-20 % of the same length (max/min 1.050)`)).toBeNull();
    expect(projectedRuleOf(`${id}D2 FAIL: 3 consecutive segments under 60 s starting at x`)).toBeNull();
    expect(projectedRuleOf(`${id}D2 FAIL: two consecutive segments under 60 s at x are followed by 90.0 s, under the 150 s recovery floor`)).toBeNull();
    expect(projectedRuleOf(`${id}D4 FAIL: 3 adjacent \`quote\` segments ending at x`)).toBeNull();
    expect(projectedRuleOf(`${id}M3 FAIL: x plays at 1019 s of "ep" after a later segment from the same episode`)).toBeNull();
    expect(projectedRuleOf(`${id}D1 FAIL: 9 segment starts inside a 600 s window (budget 8 for a 30.0-minute Foray)`)).toBeNull();
    expect(projectedRuleOf(`${id}items[3]: unknown segment_id "ep#1" — not in data/segments.json`)).toBeNull();
    expect(projectedRuleOf("data/forays.json: version must be 1")).toBeNull();
  });
});

describe("buildProjectedItems — the sourcing plan, after the partial's own items", () => {
  it("keeps the partial verbatim, then one item per planned beat of every LATER act, with the plan's de-duplicated slot ids and band-midpoint narration estimates", () => {
    /* MUTATION THAT KILLS THIS: project `a < actIndex` instead of
       `a <= actIndex` — act 1's six segments appear twice and every share
       halves. Or: resolve a projected item's slot by `slugifySlotTitle`
       alone — act 2's "Opening" collides with act 1's and the record's
       contiguity rule reads act 1's slot as interleaved. Ran both — red. */
    const built = buildProjectedItems(partialItems, 0, plan(laterDistinct));

    expect(built.items.slice(0, partialItems.length)).toEqual(partialItems);
    expect(built.projectedActs).toBe(2);
    expect(built.projectedTapeSegments).toBe(19);
    expect(built.projectedNarrationItems).toBe(2);
    expect(built.items).toHaveLength(partialItems.length + 21);

    const later = built.items.slice(partialItems.length);
    const segments = later.filter((i) => i.type === "segment");
    expect(segments.map((s) => (s as { segment_id: string }).segment_id)).toEqual(laterDistinct);
    /* Act 2's first slot shares act 1's title; its id is the plan's second
       "opening", not a re-slug of the title. */
    expect(new Set(segments.slice(0, 10).map((s) => s.slot))).toEqual(new Set(["opening-2"]));
    expect(new Set(segments.slice(10).map((s) => s.slot))).toEqual(new Set(["closing"]));

    const narrations = later.filter((i) => i.type === "narration") as Array<Record<string, unknown>>;
    expect(narrations.map((n) => n.mode)).toEqual(["patch", "carry"]);
    expect(narrations.map((n) => n.slot)).toEqual(["opening-2", "middle"]);
    const mid = (m: "Patch" | "Carry") => (MODE_CHAR_BANDS[m][0] + MODE_CHAR_BANDS[m][1]) / 2 / 17;
    expect(narrations[0]!.duration_sec).toBeCloseTo(mid("Patch"), 3);
    expect(narrations[1]!.duration_sec).toBeCloseTo(mid("Carry"), 3);
    expect(projectedNarrationSec("Patch")).toBeCloseTo(mid("Patch"), 3);
    for (const n of narrations) expect((n.script as string).length).toBeGreaterThanOrEqual(50);

    expect(built.addedRuntimeSec).toBeCloseTo(19 * 120 + projectedNarrationSec("Patch") + projectedNarrationSec("Carry"), 3);
  });
});

describe("buildProjectedItems — F-96: a merged beat's clip is projected once", () => {
  it("projects one segment item for two later beats that share a pointer, and counts its seconds once", () => {
    /* §4.5's merge gives the second beat the first beat's pointer; the stitch
       emits that clip once, so the projection must too, or the projected M4
       share would charge the episode twice for one clip. MUTATION THAT KILLS
       THIS: drop the `projectedSegments` set. */
    /* `plan` puts the first half of the ids in act 2 — the two copies land
       there together, the way a merge only ever joins beats of one act. */
    const twice = [laterDistinct[0]!, laterDistinct[0]!, laterDistinct[1]!];
    const built = buildProjectedItems(partialItems, 0, plan(twice));
    const later = built.items.slice(partialItems.length).filter((i) => i.type === "segment");
    expect(later.map((s) => (s as { segment_id: string }).segment_id)).toEqual(laterDistinct.slice(0, 2));
    expect(built.projectedTapeSegments).toBe(2);
    expect(built.addedRuntimeSec).toBeCloseTo(2 * 120 + projectedNarrationSec("Patch") + projectedNarrationSec("Carry"), 3);
  });
});

describe("buildPartialCandidate with a projection plan (F-79)", () => {
  it("run 5's shape: the partial's own M4 share is over the cap, the projected whole is under — the partial PASSES", async () => {
    /* THE FINDING. `ep-a` is 1 of 6 segments (16.7 %) and 200 of 750 tape
       seconds (26.7 %) on the act-1 slice — over M4's runtime clause — and
       1 of 25 / 200 of 3,030 s (6.6 %) on the whole the sourcing stage
       already planned. G-30 aborted run 5 on the first number.

       MUTATION THAT KILLS THIS: in `buildPartialCandidate`, skip the
       projection (pre-F-79 code) or, in `mergeProjectedVerdict`, keep the
       partial's share-rule lines instead of setting them aside. Either way
       `ok` is false and the M4 line is on the candidate. Ran both — red. */
    const checker = fakeChecker();
    const candidate = await buildPartialCandidate(info, { ...meta, projection: plan(laterDistinct) }, checker.fn);

    /* The stand-in agreed with run 5 on the slice… */
    expect(checker.seen).toHaveLength(2);
    expect(m4Lines(checker.seen[0]!)).toHaveLength(1);
    expect(m4Lines(checker.seen[0]!)[0]).toMatch(/"ep-a" is 16\.7 % of segments and 26\.7 % of runtime/);
    /* …and the second call was the projected whole, on the whole's slots. */
    expect(checker.seen[1]!.items).toHaveLength(partialItems.length + 21);
    expect(checker.seen[1]!.slots).toEqual(plan(laterDistinct).slots);
    expect(checker.seen[1]!.id).toBe(meta.id);
    expect(checker.seen[1]!.runtimeSec).toBeCloseTo(info.runtimeSec + 19 * 120 + projectedNarrationSec("Patch") + projectedNarrationSec("Carry"), 3);

    expect(candidate.validation.ok).toBe(true);
    expect(candidate.validation.checkForaysErrors).toEqual([]);
    expect(candidate.ruleScope.projection?.supersededOnPartial).toHaveLength(1);
    expect(candidate.ruleScope.projection?.supersededOnPartial[0]).toMatch(/^foray "f-79": M4 FAIL: "ep-a"/);
    expect(candidate.ruleScope.projection?.tapeSegments).toBe(25);
    expect(candidate.ruleScope.projection?.errors).toEqual([]);
  });

  it("a projection over the cap REFUSES the partial, on the projection's own line", async () => {
    /* MUTATION THAT KILLS THIS: read the projected rules from the partial
       after all (or from neither). Here the partial's slice is the same
       26.7 % as above, but the plan puts 9 of 25 segments on `ep-a` — a
       failure the finished Foray really would have, and the one G-30's
       abort should fire on. */
    const checker = fakeChecker();
    const candidate = await buildPartialCandidate(info, { ...meta, projection: plan(laterEpAHeavy) }, checker.fn);

    expect(candidate.validation.ok).toBe(false);
    expect(candidate.validation.checkForaysErrors).toHaveLength(1);
    expect(candidate.validation.checkForaysErrors[0]).toMatch(/M4 FAIL: "ep-a" is 36\.0 % of segments/);
    expect(candidate.ruleScope.projection?.errors).toEqual(candidate.validation.checkForaysErrors);
  });

  it("a monotone rule still refuses on the partial alone, and a monotone line that exists only in the projection is not charged", async () => {
    /* MUTATION THAT KILLS THIS: take EVERY line from the projection
       (`checkForaysErrors = projection.checkForaysErrors`). The partial's
       real D5 triple — three of act 1's own segments within 20 % of each
       other, which no later act can un-adjoin — would vanish, and the
       projection's M3 line, computed over ESTIMATED items, would refuse a
       partial for something no written page has done. Ran it — red on
       both halves. */
    const d5 = 'foray "f-79": D5 FAIL: ep-b#1 / ep-c#1 / ep-d#1 are 110.0 / 110.0 / 110.0 s — three consecutive durations within +/-20 % of each other (max/min 1.000)';
    const m3 = 'foray "f-79": M3 FAIL: ep-9#1 plays at 100 s of "ep-9" after a later segment from the same episode';
    const checker = fakeChecker((input) => (isPartialCall(input) ? [d5] : [m3]));
    const refused = await buildPartialCandidate(info, { ...meta, projection: plan(laterDistinct) }, checker.fn);

    expect(refused.validation.ok).toBe(false);
    expect(refused.validation.checkForaysErrors).toEqual([d5]);
    expect(refused.ruleScope.projection?.errors).toEqual([m3]);

    /* And with the partial clean of monotone lines, the projection's M3 alone
       leaves the partial passing. */
    const only = fakeChecker((input) => (isPartialCall(input) ? [] : [m3]));
    const passing = await buildPartialCandidate(info, { ...meta, projection: plan(laterDistinct) }, only.fn);
    expect(passing.validation.ok).toBe(true);
  });

  it("reports which rules were judged on the projection and which on the partial, in `ruleScope` and in a warning line", async () => {
    /* MUTATION THAT KILLS THIS: return `partialOnlyScope` from the projected
       branch, or drop the F-79 warning line. A reader of the partial file
       (or of a RefusedPartialError) could not tell a whole-Foray failure
       from a one-act artefact, which is the whole of what F-79 asks for. */
    const candidate = await buildPartialCandidate(info, { ...meta, projection: plan(laterDistinct) }, fakeChecker().fn);

    expect(candidate.ruleScope.basis).toBe("projected");
    expect(candidate.ruleScope.projected).toEqual([...PROJECTED_RULES]);
    expect(candidate.ruleScope.projected).toEqual(["M4", "D2-end", "D4-share"]);
    expect(candidate.ruleScope.partial).toEqual([...PARTIAL_RULES]);
    expect(candidate.ruleScope.partial).toContain("M3");
    expect(candidate.ruleScope.partial).toContain("D1");
    expect(candidate.ruleScope.partial).not.toContain("M4");
    expect(candidate.ruleScope.projection).toMatchObject({ acts: 2, tapeSegments: 25, narrationItems: 2, items: partialItems.length + 21 });

    const scopeLine = candidate.validation.checkForaysWarnings.find((w) => w.startsWith("F-79:"));
    expect(scopeLine).toBeDefined();
    expect(scopeLine).toMatch(/M4, D2-end, D4-share judged on the projected whole \(25 tape segments across 2 projected act\(s\)/);
    expect(scopeLine).toMatch(/every other rule judged on the partial \(6 tape segment\(s\)\)/);
    expect(scopeLine).toMatch(/1 share-rule line\(s\) on the partial set aside/);
    /* The partial's own warnings are kept, not replaced. */
    expect(candidate.validation.checkForaysWarnings[0]).toBe("fixture warning");
  });

  it("does not project on the last act (the partial is the whole) nor without a plan — one finalize call, every rule on the partial, and the report says so", async () => {
    /* MUTATION THAT KILLS THIS: drop the `status === "partial"` guard — the
       last act's candidate would be judged twice on identical items, and a
       run that predates the plan would throw on `meta.projection.slots`. */
    const last = fakeChecker();
    const whole = await buildPartialCandidate({ ...info, actIndex: 2 }, { ...meta, projection: plan(laterDistinct) }, last.fn);
    expect(last.seen).toHaveLength(1);
    expect(whole.status).toBe("complete");
    expect(whole.ruleScope).toEqual({ basis: "whole", projected: [], partial: [...PARTIAL_RULES, ...PROJECTED_RULES], projection: null });
    /* On the whole, the slice IS the Foray, so its M4 line stands. */
    expect(whole.validation.ok).toBe(false);
    expect(whole.validation.checkForaysErrors[0]).toMatch(/M4 FAIL/);

    const none = fakeChecker();
    const legacy = await buildPartialCandidate(info, meta, none.fn);
    expect(none.seen).toHaveLength(1);
    expect(legacy.ruleScope.basis).toBe("partial-only");
    expect(legacy.ruleScope.projected).toEqual([]);
    expect(legacy.validation.ok).toBe(false);
    expect(legacy.validation.checkForaysWarnings.some((w) => w.startsWith("F-79:"))).toBe(false);
  });
});
