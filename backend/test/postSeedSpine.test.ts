import { describe, expect, it } from "vitest";
import {
  ASSIGNED_SEED_MIN_SHARE,
  DEFAULT_SEED_FLOOR_REASKS,
  offeredWindowIdf,
  offeredWindows,
  postSeedSpine,
  postSeedWithFloor,
  scoreWindowForClaim,
  seedFloorViolations,
  summarizeSeedFloor,
  SPINE_SEED_FLOOR
} from "../src/generation/postSeedSpine";
import { buildSeedFloorInstruction } from "../src/generation/AnthropicSpineBuilder";
import { TIER2_WINDOW_MIN_SHARE } from "../src/generation/transcriptArchiveLookup";
import { validateSpine, type Beat, type Spine } from "../src/types/spine";
import type { ResearchShape, ResearchTapeWindow } from "../src/types/research";
import type { SpineBuildContext, SpineBuilder } from "../src/generation/SpineBuilder";
import type { IntentUnderstanding } from "../src/types/generation";

/**
 * F-98 (A): DETERMINISTIC POST-SEEDING WITH A SEED FLOOR.
 *
 * Run 8 and run 9 sent the spine model byte-similar prompts offering the same
 * eleven tape windows. Run 8 seeded 26 of 32 beats, run 9 nine of 31 — and
 * seeded beats are where the tape comes from, so a Foray's tape share was a
 * sample from one model's variance. These cases pin the two things that stop
 * that: every unseeded non-argument beat is scored against the windows the
 * prompt already offered and the best one is attached when it clears the same
 * share floor the window search will apply downstream; and when the seeded
 * share is still below `SPINE_SEED_FLOOR` the spine is re-asked ONCE, in F-86's
 * idiom, with the unseeded beats and their closest windows named.
 *
 * MUTATIONS, each named in the test that kills it.
 */

const WINDOWS: ResearchTapeWindow[] = [
  {
    episodeId: "being-an-engineer--ep-1",
    showTitle: "Being an Engineer",
    episodeTitle: "Mopping floors to mechanical design",
    startSec: 600,
    endSec: 720,
    text: "i started at eighteen mopping floors in the machine shop and nobody there had a degree, and that apprenticeship taught me more about tolerances than any classroom",
    score: 9
  },
  {
    episodeId: "being-an-engineer--ep-2",
    showTitle: "Being an Engineer",
    episodeTitle: "The first promotion nobody wants",
    startSec: 1200,
    endSec: 1330,
    text: "the promotion into management arrived the week my mentor quit, and i spent a year discovering that reviewing other engineers drawings is a completely different craft",
    score: 8
  },
  {
    episodeId: "being-an-engineer--ep-3",
    showTitle: "Being an Engineer",
    episodeTitle: "A recall you never forget",
    startSec: 200,
    endSec: 340,
    text: "the recall cost us four million dollars because a bracket failed fatigue testing after shipping, and i signed the drawing that released it",
    score: 7
  },
  {
    episodeId: "being-an-engineer--ep-4",
    showTitle: "Being an Engineer",
    episodeTitle: "Interviews are not the job",
    startSec: 90,
    endSec: 240,
    text: "we stopped asking whiteboard puzzles in interviews and started handing candidates a failed part to diagnose, and the hiring signal improved immediately",
    score: 6
  },
  {
    episodeId: "being-an-engineer--ep-5",
    showTitle: "Being an Engineer",
    episodeTitle: "The night shift teardown",
    startSec: 400,
    endSec: 530,
    text: "we tore down the gearbox on the night shift and found the keyway sheared, and the maintenance log had said nothing about vibration for six months",
    score: 5
  },
  {
    episodeId: "being-an-engineer--ep-6",
    showTitle: "Being an Engineer",
    episodeTitle: "Estimating badly, in public",
    startSec: 800,
    endSec: 950,
    text: "my estimate for the tooling was off by a factor of three and i had to say so in front of the customer, which is the day i learned what an estimate is for",
    score: 4
  }
];

function researchShape(windows: ResearchTapeWindow[] = WINDOWS): ResearchShape {
  return {
    subject: "The real arc of an engineering career",
    angle: "identity shifts, not a technical ladder",
    generatedAt: "2026-09-12T00:00:00.000Z",
    subtopics: [
      {
        label: "Engineering careers",
        source: "semantic-concept",
        tape: { signal: "strong", itemCount: 334 },
        controversies: [],
        externalNotes: null,
        externallyResearched: false,
        tapeWindows: windows,
        windowsUnavailable: null
      }
    ],
    nonObviousAngle: null,
    externallyResearchedSubtopics: []
  } as unknown as ResearchShape;
}

/* A `short`-tier spine: one act, two slots, nine beats — the smallest shape
   `validateSpine` accepts, so these cases are about seeding and not about
   building a 31-beat fixture by hand. Two beats carry the spine's own seeds,
   which is `SPINE_MIN_SEEDED_BEATS_PER_ACT`. */
const SEEDED_CLAIM_A = "Joe started at eighteen mopping floors in a machine shop where nobody had a degree.";
const SEEDED_CLAIM_B = "The promotion into management arrived the same week his mentor quit the company.";
const MATCHABLE_RECALL = "A recall cost four million dollars after a bracket failed fatigue testing post shipping.";
const MATCHABLE_INTERVIEW = "Handing candidates a failed part to diagnose improved the hiring signal over whiteboard puzzles.";
const UNMATCHABLE_1 = "Roman aqueduct builders relied on gravity gradients measured with water levels.";
const UNMATCHABLE_2 = "Antarctic ice cores preserve volcanic ash layers useful for dating glacial retreat.";
const UNMATCHABLE_3 = "Medieval cathedral masons passed geometry rules down as guarded workshop secrets.";
const UNMATCHABLE_4 = "Deep sea cable repair ships carry spare fibre spliced by hand at anchor.";
const UNMATCHABLE_5 = "Sourdough starters cultivated in bakeries inherit the flour mill local yeast strains.";
const ARGUMENT_CLAIM = "Careers should be judged by the identities people shed rather than the titles they collect.";

function beat(claim: string, extra: Partial<Beat> = {}): Beat {
  return { claim, exploration: false, kind: "account", ...extra };
}

function spineOf(beats: Beat[]): Spine {
  const half = Math.ceil(beats.length / 2);
  return {
    subject: "The real arc of an engineering career",
    angle: "identity shifts, not a technical ladder",
    duration: "short",
    generatedAt: "2026-09-12T00:00:00.000Z",
    voice: { style: "warm", register: "plain", sentenceRhythm: "varied", narratorPresence: "light" },
    acts: [
      {
        title: "Act one",
        thesis: "An engineering career is a sequence of identity shifts.",
        startState: "The listener thinks of engineering as a technical ladder.",
        endState: "The listener sees the ladder as a sequence of identity shifts.",
        slots: [
          { title: "Starting out", beats: beats.slice(0, half) },
          { title: "Turning", beats: beats.slice(half) }
        ]
      }
    ]
  };
}

/** The run-9 shape: nine beats, two of them seeded by the spine itself. */
function baseBeats(): Beat[] {
  return [
    beat(SEEDED_CLAIM_A, { seed: { episodeId: "being-an-engineer--ep-1", startSec: 600, endSec: 720 } }),
    beat(SEEDED_CLAIM_B, { seed: { episodeId: "being-an-engineer--ep-2", startSec: 1200, endSec: 1330 } }),
    beat(MATCHABLE_RECALL),
    beat(MATCHABLE_INTERVIEW),
    beat(UNMATCHABLE_1, { exploration: true }),
    beat(UNMATCHABLE_2, { exploration: true }),
    beat(UNMATCHABLE_3, { exploration: true }),
    beat(UNMATCHABLE_4),
    beat(UNMATCHABLE_5, { exploration: true }),
    beat(ARGUMENT_CLAIM, { kind: "argument" })
  ];
}

const intent: IntentUnderstanding = {
  subject: "The real arc of an engineering career",
  angle: "identity shifts, not a technical ladder",
  priorKnowledge: "Engineers write code and there is an IC-versus-management track.",
  disappointment: "It repeats the ladder story."
} as unknown as IntentUnderstanding;

const ctx: SpineBuildContext = { userId: "founder-1" };

/** A builder that records what it was asked and replies with a fixed spine. */
function replyingBuilder(reply: Spine | ((ctx: SpineBuildContext) => Spine)) {
  const calls: SpineBuildContext[] = [];
  const builder: SpineBuilder = {
    providerName: "stub",
    async buildSpine(_i, _r, _d, c) {
      calls.push(c);
      return typeof reply === "function" ? reply(c) : reply;
    }
  };
  return { builder, calls };
}

describe("F-98 — the floors, named and derived", () => {
  it("the assigned-seed floor IS the window search's own share floor, and the spine floor sits between run 8 and run 9", () => {
    /* MUTATION THAT KILLS THIS: write 0.35 into `postSeedSpine.ts` instead of
       importing it, then move `TIER2_WINDOW_MIN_SHARE` — the two floors drift
       apart silently, because a seed below the search's floor is still
       reported as a seed and then narrated. Ran it with the share at 0.5 — red. */
    expect(ASSIGNED_SEED_MIN_SHARE).toBe(TIER2_WINDOW_MIN_SHARE);
    expect(SPINE_SEED_FLOOR).toBe(0.5);
    /* Run 8: 26 of 32 seeded (0.81) — accepted. Run 9: 9 of 31 (0.29) — refused. */
    expect(26 / 32).toBeGreaterThan(SPINE_SEED_FLOOR);
    expect(9 / 31).toBeLessThan(SPINE_SEED_FLOOR);
    expect(DEFAULT_SEED_FLOOR_REASKS).toBe(1);
  });

  it("the offered windows are the map's own, deduplicated, and the idf is computed over exactly those", () => {
    /* MUTATION THAT KILLS THIS: keep the duplicate — the repeated window's
       words then look twice as common as they are and the claim written from
       it scores lower than one written from a window listed once. */
    const shape = researchShape([...WINDOWS, WINDOWS[0]!]);
    expect(offeredWindows(shape)).toHaveLength(WINDOWS.length);
    const idf = offeredWindowIdf(offeredWindows(shape));
    // "engineer"-adjacent words shared by several windows weigh less than a word
    // only one window says.
    expect(idf.get("mopping")!).toBeGreaterThan(idf.get("i")! ?? 0);
    expect(offeredWindowIdf([]).size).toBe(0);
  });

  it("scores a claim against a window as the share of its distinctiveness the window speaks", () => {
    /* MUTATION THAT KILLS THIS: count matched terms instead of weighing them —
       a claim that shares only the trade's everyday words then clears the
       floor, which is the false positive F-61's weighted share exists to stop. */
    const idf = offeredWindowIdf(WINDOWS);
    const onClaim = scoreWindowForClaim(MATCHABLE_RECALL, WINDOWS[2]!, idf);
    expect(onClaim.weightedShare).toBeGreaterThanOrEqual(ASSIGNED_SEED_MIN_SHARE);
    expect(onClaim.matchedTerms).toContain("recall");
    const offClaim = scoreWindowForClaim(UNMATCHABLE_1, WINDOWS[2]!, idf);
    expect(offClaim.weightedShare).toBeLessThan(ASSIGNED_SEED_MIN_SHARE);
    expect(scoreWindowForClaim("", WINDOWS[0]!, idf).weightedShare).toBe(0);
  });
});

describe("F-98 — deterministic post-seeding", () => {
  it("attaches the best offered window to an unseeded beat, and says the seed was assigned rather than written", () => {
    /* MUTATION THAT KILLS THIS: stamp `seedSource: "spine"` on every seed — the
       run log then reports a rescue as the model's own yield, which is exactly
       the number this card exists to stop trusting. */
    const result = postSeedSpine(spineOf(baseBeats()), researchShape());
    const beats = result.spine.acts[0]!.slots.flatMap((s) => s.beats);
    const byClaim = new Map(beats.map((b) => [b.claim, b]));
    expect(byClaim.get(SEEDED_CLAIM_A)!.seedSource).toBe("spine");
    expect(byClaim.get(SEEDED_CLAIM_A)!.seed).toEqual({ episodeId: "being-an-engineer--ep-1", startSec: 600, endSec: 720 });
    expect(byClaim.get(MATCHABLE_RECALL)!.seedSource).toBe("assigned");
    expect(byClaim.get(MATCHABLE_RECALL)!.seed).toEqual({ episodeId: "being-an-engineer--ep-3", startSec: 200, endSec: 340 });
    expect(byClaim.get(MATCHABLE_INTERVIEW)!.seed?.episodeId).toBe("being-an-engineer--ep-4");
    expect(result.spineSeeded).toBe(2);
    expect(result.assigned).toBe(2);
  });

  it("leaves a beat no window speaks to unseeded, and names it with its closest window", () => {
    /* A seed the window does not carry is refused one stage later and the beat
       narrated anyway, with the claim damaged on the way past (F-63).
       MUTATION THAT KILLS THIS: attach the best window whatever it scored. */
    const result = postSeedSpine(spineOf(baseBeats()), researchShape());
    expect(result.unseeded.map((u) => u.claim).sort()).toEqual([UNMATCHABLE_1, UNMATCHABLE_2, UNMATCHABLE_3, UNMATCHABLE_4, UNMATCHABLE_5].sort());
    for (const row of result.unseeded) expect(row.best).not.toBeNull();
    const lines = seedFloorViolations(result);
    expect(lines).toHaveLength(5);
    expect(lines[0]).toMatch(/^act 1, slot \d+, beat \d+: "/);
    expect(lines[0]).toMatch(/carries no seed — closest window offered: \[being-an-engineer--ep-\d \d+-\d+s\]/);
  });

  it("an argument beat is never seeded and is not in the denominator — narration is what argument is for", () => {
    /* MUTATION THAT KILLS THIS: drop the `kind === "argument"` guard — the
       denominator grows by the beats no recording could carry, so the floor
       fires on spines that are not short of seeds at all (F-38). */
    const result = postSeedSpine(spineOf(baseBeats()), researchShape());
    const argument = result.spine.acts[0]!.slots.flatMap((s) => s.beats).find((b) => b.kind === "argument")!;
    expect(argument.seed).toBeUndefined();
    expect(argument.seedSource).toBeUndefined();
    expect(result.nonArgument).toBe(9);
    expect(result.seededShare).toBeCloseTo(4 / 9, 6);
  });

  it("the M4 ledger the spine's own seeds left behind is what an assigned seed faces", () => {
    /* Both matchable beats are pushed at the SAME episode by removing the other
       windows: the first is assigned, the second is refused by M4's share (one
       seed per episode until the spine carries eight) and no lesser window is
       substituted from that episode. MUTATION THAT KILLS THIS: use a fresh
       ledger, or skip it entirely — the spine then asks for tape §4.5 refuses,
       which is the run-2 bug G-25 measured. */
    const oneEpisode = researchShape([WINDOWS[2]!]);
    const result = postSeedSpine(spineOf([beat(MATCHABLE_RECALL), beat(MATCHABLE_RECALL.replace("A recall", "The recall"))]), oneEpisode);
    expect(result.assigned).toBe(1);
    expect(result.unseeded).toHaveLength(1);
  });

  it("is deterministic and idempotent: the same map and spine assign the same seeds, and a second pass adds none", () => {
    /* MUTATION THAT KILLS THIS: break the tie-break in `bestWindowFor` (drop
       the episodeId/startSec tail) — two windows at an identical score then
       swap with the input order and a replay stops reproducing the run. */
    const first = postSeedSpine(spineOf(baseBeats()), researchShape());
    const again = postSeedSpine(spineOf(baseBeats()), researchShape());
    expect(again.spine).toEqual(first.spine);
    const second = postSeedSpine(first.spine, researchShape());
    expect(second.assigned).toBe(0);
    expect(second.spineSeeded).toBe(4);
  });

  it("a map that quoted nothing changes nothing: every beat keeps what the spine gave it", () => {
    /* §4.2's guardrail, carried one stage forward: tape is a signal, never a
       filter. MUTATION THAT KILLS THIS: divide by the window count. */
    const result = postSeedSpine(spineOf(baseBeats()), researchShape([]));
    expect(result.assigned).toBe(0);
    expect(result.spineSeeded).toBe(2);
    expect(result.unseeded).toHaveLength(7);
    expect(result.unseeded[0]!.best).toBeNull();
    expect(seedFloorViolations(result)[0]).toMatch(/no window was offered for this subject/);
  });
});

describe("F-98 — the seed floor and its one re-ask", () => {
  it("says both numbers in one line, the spine's own yield and what post-seeding recovered", () => {
    /* The line run 9 could not print. MUTATION THAT KILLS THIS: report the
       total as the spine's — the line then cannot tell a good reply from a
       good rescue, which is the whole reason `seedSource` exists. */
    const beats: Beat[] = [];
    for (let i = 0; i < 31; i++) {
      const seeded = i < 9 ? "spine" : i < 24 ? "assigned" : undefined;
      beats.push(
        beat(`Claim number ${i} about an engineering career turning point.`, {
          ...(seeded ? { seed: { episodeId: `ep-${i}`, startSec: i, endSec: i + 10 }, seedSource: seeded } : {})
        })
      );
    }
    beats.push(beat(ARGUMENT_CLAIM, { kind: "argument" }));
    expect(summarizeSeedFloor(spineOf(beats), false)).toBe("seeds: spine 9/31 → assigned 24/31 (floor 0.5, re-asked: no)");
    expect(summarizeSeedFloor(spineOf(beats), true)).toMatch(/re-asked: yes\)$/);
  });

  it("does not re-ask when post-seeding cleared the floor, nor when the map offered no windows", async () => {
    /* A re-ask is a whole Opus call. MUTATION THAT KILLS THIS: re-ask whenever
       any beat is unseeded — every run then pays the call, including one whose
       subject the archive is silent on, where there is no window to name. */
    const cleared = replyingBuilder(spineOf(baseBeats()));
    const result = await postSeedWithFloor(spineOf(baseBeats().slice(0, 4)), intent, researchShape(), "short", cleared.builder, ctx);
    expect(result.reasked).toBe(false);
    expect(result.seededShare).toBeGreaterThanOrEqual(SPINE_SEED_FLOOR);
    expect(cleared.calls).toHaveLength(0);

    const noWindows = replyingBuilder(spineOf(baseBeats()));
    const out = await postSeedWithFloor(spineOf(baseBeats()), intent, researchShape([]), "short", noWindows.builder, ctx);
    expect(out.reasked).toBe(false);
    expect(noWindows.calls).toHaveLength(0);
  });

  it("re-asks ONCE, in F-86's idiom: the model's own reply back as the previous, the unseeded beats named, kind seed-floor", async () => {
    /* MUTATION THAT KILLS THIS: hand the POST-SEEDED spine back as `previous` —
       the model is then asked to keep as its own a judgement this stage made,
       and the re-ask's own seeds become indistinguishable from its first
       reply's. Or re-ask twice: the call count below pins one. */
    const better = spineOf([
      beat(SEEDED_CLAIM_A, { seed: { episodeId: "being-an-engineer--ep-1", startSec: 600, endSec: 720 } }),
      beat(SEEDED_CLAIM_B, { seed: { episodeId: "being-an-engineer--ep-2", startSec: 1200, endSec: 1330 } }),
      beat(MATCHABLE_RECALL, { seed: { episodeId: "being-an-engineer--ep-3", startSec: 200, endSec: 340 } }),
      beat(MATCHABLE_INTERVIEW, { seed: { episodeId: "being-an-engineer--ep-4", startSec: 90, endSec: 240 } }),
      beat("The gearbox teardown on the night shift found the keyway sheared with no vibration entry.", { exploration: true, seed: { episodeId: "being-an-engineer--ep-5", startSec: 400, endSec: 530 } }),
      beat("His tooling estimate was off by a factor of three and he said so in front of the customer.", { exploration: true, seed: { episodeId: "being-an-engineer--ep-6", startSec: 800, endSec: 950 } }),
      beat(UNMATCHABLE_3, { exploration: true }),
      beat(UNMATCHABLE_4),
      beat(UNMATCHABLE_5, { exploration: true }),
      beat(ARGUMENT_CLAIM, { kind: "argument" })
    ]);
    expect(validateSpine(better).valid).toBe(true);
    const original = spineOf(baseBeats());
    const { builder, calls } = replyingBuilder(better);
    const result = await postSeedWithFloor(original, intent, researchShape(), "short", builder, ctx);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.revision).toBeDefined();
    expect(calls[0]!.revision!.kind).toBe("seed-floor");
    expect(calls[0]!.revision!.attempt).toBe(1);
    expect(calls[0]!.revision!.previous).toBe(original);
    expect(calls[0]!.revision!.violations.some((v) => v.includes(UNMATCHABLE_1))).toBe(true);
    expect(result.reasked).toBe(true);
    expect(result.seededShare).toBeGreaterThan(4 / 9);
  });

  it("keeps the reply that already passed the gates when the re-asked one is worse or malformed", async () => {
    /* A re-ask is one more sample from the variance this card exists to stop
       depending on. MUTATION THAT KILLS THIS: return the re-asked spine
       unconditionally — a reply with fewer seeds, or a two-sentence claim the
       structural gate would refuse, then replaces one that cleared both. */
    const original = spineOf(baseBeats());
    const worse = spineOf(baseBeats().map((b) => ({ ...b, seed: undefined })));
    const worseOut = await postSeedWithFloor(original, intent, researchShape(), "short", replyingBuilder(worse).builder, ctx);
    expect(worseOut.reasked).toBe(true);
    expect(worseOut.spineSeeded).toBe(2);
    expect(worseOut.assigned).toBe(2);

    const malformed = spineOf(baseBeats().map((b, i) => (i === 4 ? { ...b, claim: "One sentence. And a second one." } : b)));
    const malformedOut = await postSeedWithFloor(original, intent, researchShape(), "short", replyingBuilder(malformed).builder, ctx);
    expect(malformedOut.reasked).toBe(true);
    expect(malformedOut.spine.acts[0]!.slots.flatMap((s) => s.beats).some((b) => b.claim.includes("And a second one"))).toBe(false);
  });

  it("`maxSeedFloorReasks: 0` spends no call — post-seeding still runs, because it calls nothing", async () => {
    /* The pre-F-98 pipeline's spine spend, restored exactly.
       MUTATION THAT KILLS THIS: ignore the option. */
    const { builder, calls } = replyingBuilder(spineOf(baseBeats()));
    const out = await postSeedWithFloor(spineOf(baseBeats()), intent, researchShape(), "short", builder, ctx, { maxSeedFloorReasks: 0 });
    expect(calls).toHaveLength(0);
    expect(out.reasked).toBe(false);
    expect(out.assigned).toBe(2);
  });

  it("the seed-floor instruction asks for a rewrite where a window says it and for the beat to be left alone where none does", () => {
    /* F-63's rule is stronger than any yield target: a seed the window does not
       carry is refused downstream and the beat narrated anyway, with the claim
       damaged. MUTATION THAT KILLS THIS: reuse `buildSpineFixInstruction` for
       this re-ask — it tells the model the beats VIOLATE something and to fix
       only them, which is not what a thin seed yield is. */
    const text = buildSeedFloorInstruction(["act 1, slot 1, beat 3: \"A claim\" carries no seed — closest window offered: [ep-3 200-340s] A recall"]);
    expect(text).toContain("too few of its beats are written from the quoted transcript");
    expect(text).toContain("LEAVE THE BEAT EXACTLY AS IT IS");
    expect(text).toContain("never seed a claim its window");
    expect(text).toContain("act 1, slot 1, beat 3");
    expect(text).not.toContain("failed the structural check");
  });
});

