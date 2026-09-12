import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";
import { resolve as resolvePath } from "path";
import { pathToFileURL } from "url";
import { D5_TOLERANCE, d5PairIsUniform, d5Pairs, placementEscapesD5Pair } from "../src/generation/d5Pair";
import { D5_TOLERANCE as D5_TOLERANCE_VIA_SOURCE_BEATS } from "../src/generation/sourceBeats";

/**
 * D5's pair clause, shared between sourcing and the checker (Q-04; F-80 for
 * the triple clause it replaced).
 *
 * WHAT THIS FILE PINS. `check-forays.mjs` is the authority on the rule and
 * `d5Pair.ts` is sourcing's copy of its arithmetic — copied, not imported,
 * because Vitest cannot load `tools/foray/*.mjs` on a checkout whose path has
 * a space in it (this one: "Vibe Coding"), and a static import would take the
 * whole sourcing suite down with it. The agreement case below therefore runs
 * the checker's own `d5UniformPairs` in a plain Node subprocess — the pattern
 * `measureCadence.test.ts` and `writeNarration.test.ts` already use — and
 * compares row by row. If either side changes and the other does not, this is
 * the test that goes red.
 */

/** The run-8 candidate's adjacent pairs, verbatim, plus the sequences the
 * rule's edges live on. */
const FIXTURES: Record<string, number[]> = {
  /* What-engineers-actually-do-all-day (run 8, 2026-09-12), the sixteen
     committed durations: three adjacent pairs inside the band — 69.7 / 65.6,
     116.7 / 113.8 and 176.7 / 158.3 — and no uniform TRIPLE anywhere, which is
     the difference between the two clauses in one running order. */
  run8: [167.3, 69.7, 65.6, 116.7, 113.8, 174.2, 98.3, 152.1, 90.7, 176.7, 158.3, 31.9, 170.5, 130.9, 162.8, 78.0],
  /* Run 5's refusal under the triple clause: both of its pairs are uniform too. */
  run5: [152.0, 142.2, 169.4],
  /* Exactly on the boundary: 120 / 100 is 1.2, and 1.2 is NOT greater than
     1 + 0.2, so this pair is uniform on both sides of the mirror. */
  boundary: [100, 120],
  /* Just over it. */
  justOver: [100, 120.01],
  /* Alternating by a quarter: no pair inside the band. */
  alternating: [100, 125, 100, 125, 100],
  /* One duration: nothing to report. */
  single: [100],
  /* Zero durations: 0 / 0 is NaN and clears no `>` test, so the checker
     reports a pair of zeros as uniform; the mirror must too. */
  zeros: [0, 0],
  /* A long realistic running order with several hits scattered through it. */
  long: [95, 210, 128, 133, 141, 61, 240, 180, 175, 190, 45, 110, 105, 100, 220, 705, 640]
};

interface CheckerHit {
  index: number;
  durations: number[];
  ratio: number;
}

/** `check-forays.mjs`'s `d5UniformPairs(durations)`, run where Node can load
 * the file. */
function checkerPairs(durations: number[]): CheckerHit[] {
  const moduleUrl = pathToFileURL(resolvePath(__dirname, "../../tools/foray/check-forays.mjs")).href;
  const script =
    `import(${JSON.stringify(moduleUrl)}).then((mod) => {` +
    `process.stdout.write(JSON.stringify({ tolerance: mod.D5_TOLERANCE, hits: mod.d5UniformPairs(${JSON.stringify(durations)}) }));` +
    `});`;
  const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
  const parsed = JSON.parse(stdout) as { tolerance: number; hits: CheckerHit[] };
  expect(parsed.tolerance).toBe(D5_TOLERANCE);
  return parsed.hits;
}

describe("d5Pair — the checker's arithmetic, mirrored (Q-04)", () => {
  it("agrees with check-forays.mjs's d5UniformPairs on every fixture, row by row", () => {
    /* MUTATION THAT KILLS THIS: change `!(ratio > 1 + D5_TOLERANCE)` in
       `d5PairIsUniform` to `ratio < 1 + D5_TOLERANCE` — the `boundary` fixture
       (max/min exactly 1.2) is a hit for the checker and not for the mirror. Or
       put `min > 0 &&` in front of it — the `zeros` fixture disagrees. Ran
       both — red. */
    for (const [name, durations] of Object.entries(FIXTURES)) {
      const expected = checkerPairs(durations);
      const actual = d5Pairs(durations);
      expect(actual.map((h) => h.index), name).toEqual(expected.map((h) => h.index));
      expect(actual.map((h) => h.durations), name).toEqual(expected.map((h) => h.durations));
      /* `ratio` is the number the checker prints; a NaN (the zeros fixture)
         JSON-encodes as null on the way back, so compare finite values only. */
      for (let i = 0; i < actual.length; i++) {
        const theirs = expected[i]!.ratio;
        if (theirs === null || !Number.isFinite(theirs)) continue;
        expect(actual[i]!.ratio, `${name}[${i}]`).toBeCloseTo(theirs, 12);
      }
    }
  });

  it("names run 8's three adjacent pairs and finds none in an alternating order", () => {
    expect(d5Pairs(FIXTURES.run8!).map((h) => h.index)).toEqual([1, 3, 9]);
    expect(d5Pairs(FIXTURES.alternating!)).toEqual([]);
    expect(d5PairIsUniform(69.7, 65.6)).toBe(true);
    expect(d5PairIsUniform(100, 125)).toBe(false);
    /* The pair clause is STRICTER than the triple it replaced: run 8 has three
       uniform pairs and not one uniform triple — which is why the checker gates
       it only on tape cut under Q-01 and reports it on everything older. */
    const triples = (d: number[]) => d.filter((_v, i) => i + 2 < d.length && Math.max(d[i]!, d[i + 1]!, d[i + 2]!) / Math.min(d[i]!, d[i + 1]!, d[i + 2]!) <= 1 + D5_TOLERANCE);
    expect(triples(FIXTURES.run8!)).toEqual([]);
  });

  it("asks a placement about the last placed duration only, and lets the first through", () => {
    expect(placementEscapesD5Pair([], 100)).toBe(true);
    /* 65.6 after 69.7 — run 8's second and third clips — is inside the band. */
    expect(placementEscapesD5Pair([69.7], 65.6)).toBe(false);
    expect(placementEscapesD5Pair([69.7], 90)).toBe(true);
    /* Earlier durations do not matter: only the last one forms the pair.
       MUTATION THAT KILLS THIS: read `placed[0]` instead of the last — the
       earlier 400 s here would wrongly let 65.6 through. */
    expect(placementEscapesD5Pair([400, 69.7], 65.6)).toBe(false);
  });

  it("F-102: exports nothing that can shorten a clip — the module answers, it does not prescribe", async () => {
    /* THE DEFECT THIS PINS. Until F-102 this module exported `d5EscapeBelow`,
       whose entire job was to tell `sourceBeats.ts` how far to CUT a clip back
       so an adjacent pair would escape the band — `previous / 1.2`, a hair
       under. It was the mechanism by which a listening-variety rule made the
       Foray play less tape than its relevance supports, which is what the
       founder's Q-01 instruction forbids, and it is deleted.

       MUTATION THAT KILLS THIS: export any function from `d5Pair.ts` that
       returns a LENGTH — restore `d5EscapeBelow`, or add a `d5EscapeAbove` —
       and this goes red naming it. What the module may export is predicates
       and counts: a question a caller asks about lengths it already has, never
       a length a caller should cut to. (`D5_TOLERANCE` is a ratio, not a
       length, and is listed by name rather than by type.) */
    const mod = (await import("../src/generation/d5Pair")) as Record<string, unknown>;
    expect(Object.keys(mod).sort()).toEqual(["D5_TOLERANCE", "d5PairIsUniform", "d5Pairs", "placementEscapesD5Pair"]);
    const prescribesALength = Object.entries(mod)
      .filter(([name]) => name !== "D5_TOLERANCE")
      .filter(([, value]) => typeof value === "function")
      .filter(([, fn]) => {
        const out = (fn as (...args: unknown[]) => unknown)([120], 120);
        return typeof out === "number";
      })
      .map(([name]) => name);
    expect(prescribesALength).toEqual([]);

    /* And the one predicate that survives still answers the question — it is
       the MARK sourcing writes on the row, so it must keep working. */
    expect(placementEscapesD5Pair([120], 100)).toBe(false);
    expect(placementEscapesD5Pair([120], 99.9)).toBe(true);
  });

  it("is the one D5_TOLERANCE sourceBeats re-exports, so the constants cannot drift", () => {
    expect(D5_TOLERANCE_VIA_SOURCE_BEATS).toBe(D5_TOLERANCE);
    expect(D5_TOLERANCE).toBe(0.2);
  });
});
