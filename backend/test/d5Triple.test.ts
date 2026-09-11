import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";
import { resolve as resolvePath } from "path";
import { pathToFileURL } from "url";
import { D5_TOLERANCE, d5DistanceFromPrevious, d5TripleIsUniform, d5Triples, placementEscapesD5Triple } from "../src/generation/d5Triple";
import { D_TARGET_LADDER_SEC, D5_TOLERANCE as D5_TOLERANCE_VIA_SOURCE_BEATS } from "../src/generation/sourceBeats";

/**
 * D5's triple clause, shared between sourcing and the checker (F-80).
 *
 * WHAT THIS FILE PINS. `check-forays.mjs` is the authority on the rule and
 * `d5Triple.ts` is sourcing's copy of its arithmetic — copied, not imported,
 * because Vitest cannot load `tools/foray/*.mjs` on a checkout whose path has
 * a space in it (this one: "Vibe Coding"), and a static import would take the
 * whole sourcing suite down with it. The agreement case below therefore runs
 * the checker's own `d5Triples` in a plain Node subprocess — the pattern
 * `measureCadence.test.ts` and `writeNarration.test.ts` already use — and
 * compares row by row. If either side changes and the other does not, this is
 * the test that goes red.
 */

/** The run-5 refusal, verbatim, plus the sequences the rule's edges live on. */
const FIXTURES: Record<string, number[]> = {
  /* "practical-ai--tiny-recursive-networks#603 / …#2297 / …#1650 are 152.0 /
     142.2 / 169.4 s — three consecutive durations within +/-20 % of each other
     (max/min 1.191)" — 2026-09-11, run 5, the finalize refusal F-80 is about. */
  run5: [152.0, 142.2, 169.4],
  /* The ladder itself: no two adjacent rungs inside the band, so a run of
     placements that reach every rung makes no triple. */
  ladder: [...D_TARGET_LADDER_SEC],
  /* Exactly on the boundary: 120 / 100 is 1.2, and 1.2 is NOT greater than
     1 + 0.2, so this triple is uniform on both sides of the mirror. */
  boundary: [100, 120, 100],
  /* Just over it. */
  justOver: [100, 120.01, 100],
  /* Two overlapping hits in one run. */
  overlapping: [100, 110, 105, 100, 200, 100],
  /* Fewer than three: nothing to report. */
  pair: [100, 100],
  /* Zero durations: 0 / 0 is NaN and clears no `>` test, so the checker
     reports a triple of zeros as uniform; the mirror must too. */
  zeros: [0, 0, 0],
  /* A long realistic running order with several hits scattered through it. */
  long: [95, 210, 128, 133, 141, 61, 240, 180, 175, 190, 45, 110, 105, 100, 220]
};

interface CheckerHit {
  index: number;
  durations: number[];
  worst: number;
}

/** `check-forays.mjs`'s `d5Triples(durations, { reading: "pairwise" })`, run
 * where Node can load the file. */
function checkerTriples(durations: number[]): CheckerHit[] {
  const moduleUrl = pathToFileURL(resolvePath(__dirname, "../../tools/foray/check-forays.mjs")).href;
  const script =
    `import(${JSON.stringify(moduleUrl)}).then((mod) => {` +
    `process.stdout.write(JSON.stringify({ tolerance: mod.D5_TOLERANCE, hits: mod.d5Triples(${JSON.stringify(durations)}, { reading: "pairwise" }) }));` +
    `});`;
  const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
  const parsed = JSON.parse(stdout) as { tolerance: number; hits: CheckerHit[] };
  expect(parsed.tolerance).toBe(D5_TOLERANCE);
  return parsed.hits;
}

describe("d5Triple — the checker's arithmetic, mirrored (F-80)", () => {
  it("agrees with check-forays.mjs's d5Triples on every fixture, row by row", () => {
    /* MUTATION THAT KILLS THIS: change `!(ratio > 1 + D5_TOLERANCE)` in
       `d5TripleIsUniform` to `ratio < 1 + D5_TOLERANCE` — the `boundary`
       fixture (max/min exactly 1.2) is a hit for the checker and not for the
       mirror. Or `min > 0 &&` back in front of it, as #571's copy had — the
       `zeros` fixture disagrees. Ran both — red. */
    for (const [name, durations] of Object.entries(FIXTURES)) {
      const expected = checkerTriples(durations);
      const actual = d5Triples(durations);
      expect(actual.map((h) => h.index), name).toEqual(expected.map((h) => h.index));
      expect(actual.map((h) => h.durations), name).toEqual(expected.map((h) => h.durations));
      /* `worst` is the ratio the checker prints; a NaN (the zeros fixture)
         JSON-encodes as null on the way back, so compare finite values only. */
      for (let i = 0; i < actual.length; i++) {
        const theirs = expected[i]!.worst;
        if (theirs === null || !Number.isFinite(theirs)) continue;
        expect(actual[i]!.worst, `${name}[${i}]`).toBeCloseTo(theirs, 12);
      }
    }
  });

  it("names run 5's refusal as one uniform triple and the ladder as none", () => {
    expect(d5Triples(FIXTURES.run5!)).toEqual([{ index: 0, durations: [152.0, 142.2, 169.4], worst: 169.4 / 142.2 }]);
    expect(d5Triples(FIXTURES.ladder!)).toEqual([]);
    expect(d5TripleIsUniform(152.0, 142.2, 169.4)).toBe(true);
    expect(d5TripleIsUniform(105, 165, 135)).toBe(false);
  });

  it("asks a placement about the last two placed durations only, and lets the first two through", () => {
    expect(placementEscapesD5Triple([], 100)).toBe(true);
    expect(placementEscapesD5Triple([100], 100)).toBe(true);
    /* The run-5 placement: 169.4 after 152.0 / 142.2 is inside the band. */
    expect(placementEscapesD5Triple([152.0, 142.2], 169.4)).toBe(false);
    /* The cut F-80 places instead. */
    expect(placementEscapesD5Triple([152.0, 142.2], 210)).toBe(true);
    /* Earlier durations do not matter: only the last two form the triple.
       MUTATION THAT KILLS THIS: read `placed[0]`/`placed[1]` instead of the last
       two — the earlier 400 s here would wrongly let 169.4 through. */
    expect(placementEscapesD5Triple([400, 152.0, 142.2], 169.4)).toBe(false);
  });

  it("measures distance from the NEARER of the two previous durations, on the ratio scale", () => {
    /* 210 after 152 / 142.2: nearer is 152, ln(210 / 152). */
    expect(d5DistanceFromPrevious([152.0, 142.2], 210)).toBeCloseTo(Math.log(210 / 152), 12);
    /* 120 after 152 / 142.2: nearer is 142.2, ln(142.2 / 120). */
    expect(d5DistanceFromPrevious([152.0, 142.2], 120)).toBeCloseTo(Math.log(142.2 / 120), 12);
    /* Farther is larger, so the chooser's sort puts 210 before 120 here. */
    expect(d5DistanceFromPrevious([152.0, 142.2], 210)).toBeGreaterThan(d5DistanceFromPrevious([152.0, 142.2], 120));
    /* Nothing placed, or nothing positive, is no distance at all. */
    expect(d5DistanceFromPrevious([], 120)).toBe(0);
    expect(d5DistanceFromPrevious([0, 0], 120)).toBe(0);
  });

  it("is the one D5_TOLERANCE sourceBeats re-exports, so the constants cannot drift", () => {
    expect(D5_TOLERANCE_VIA_SOURCE_BEATS).toBe(D5_TOLERANCE);
    expect(D5_TOLERANCE).toBe(0.2);
  });
});
