import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PROJECTED_RULE_PATTERNS, projectedRuleOf, PROJECTED_RULES } from "../src/generation/partialProjection";

/**
 * F-101 — THE GENERALISING GUARD. `partialProjection.ts` decides, by matching
 * `check-forays.mjs`'s MESSAGE TEXT with a regex, which rules a partial
 * candidate is judged on the projection for and which on itself — and that
 * decision governs whether G-30 aborts a run mid-flight. Nothing verified the
 * regexes against the checker, so when Q-04 retired D3 and restated D5's
 * interquartile clause out of existence, two of the five patterns went on
 * matching nothing for two cards and every test stayed green: the tests pinned
 * the table against strings somebody had typed, which is the same mistake in a
 * second place.
 *
 * WHAT THIS FILE DOES INSTEAD. It drives the REAL `tools/foray/check-forays.mjs`
 * over the committed boundary fixture, mutated four ways so the checker emits
 * real lines for every projected clause, and asserts that EVERY pattern in
 * `PROJECTED_RULE_PATTERNS` matches at least one line the checker actually
 * emitted. A rule that is renamed, reworded or retired therefore turns this red
 * the day it moves, instead of silently reclassifying a share-of-whole rule as
 * monotone. The converse direction is pinned too: the lines the checker emits
 * for the monotone clauses that share a rule prefix (D2's run clause, D4's
 * adjacency clause, D5's pair clause) must classify as `null`.
 *
 * WHY A CHILD PROCESS. Vitest cannot `import()` the `.mjs` checkers on this
 * checkout — the repo path contains a space (see `RunPipelineDeps.finalize` and
 * `partialProjection.test.ts`'s header). `node` itself has no such trouble, so
 * the checker is run in a child and its errors come back as JSON. That is also
 * why this file is separate from `partialProjection.test.ts`: that one is pure
 * and fast, this one spends a process.
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const CHECKER = path.join(REPO_ROOT, "tools", "foray", "check-forays.mjs");
const FIXTURE_ROOT = path.join(REPO_ROOT, "tools", "foray", "fixtures", "boundary");

/**
 * The mutations, in the child's own words. Each is the smallest change to the
 * committed boundary fixture that makes the checker emit one clause's line;
 * incidental errors (a runtime_sec disagreement, an L2 floor) are expected and
 * ignored — this file asserts what the checker CAN say, not that the fixture is
 * otherwise clean.
 */
const DRIVER = `
const { checkForays, loadFiles } = await import(process.env.CHECKER_URL);
const base = loadFiles(process.env.FIXTURE_ROOT);
const clone = () => structuredClone(base);
const foray = (f) => f.forays.forays[0];
const segOf = (f, id) => f.segments.segments.find((s) => s.id === id);
const played = (f) => foray(f).items.filter((i) => i.type === "segment");
const out = {};

/* M4 — both share clauses: two episodes' pooled rows handed to a third, so it
   owns 15 of 30 segments and 41.9 % of the tape beyond its longest clip. */
{
  const f = clone();
  for (const s of f.segments.segments) if (s.item_id === "boundary-ep-b" || s.item_id === "boundary-ep-c") s.item_id = "boundary-ep-a";
  out.m4 = checkForays(f).errors;
}
/* D2's END clause (projected) — the last two played segments under 60 s, with
   no following segment to supply the 150 s recovery. */
{
  const f = clone();
  for (const i of played(f).slice(-2)) { const s = segOf(f, i.segment_id); s.end_sec = s.start_sec + 40; }
  out.d2end = checkForays(f).errors;
}
/* D2's RUN clause (monotone) — three consecutive segments under 60 s inside the
   Foray, which no later act can un-make. */
{
  const f = clone();
  for (const i of played(f).slice(2, 5)) { const s = segOf(f, i.segment_id); s.end_sec = s.start_sec + 40; }
  out.d2run = checkForays(f).errors;
}
/* D4 — the share clause (projected) and the adjacency clause (monotone) from
   the same mutation: ten consecutive \`quote\` roles. */
{
  const f = clone();
  played(f).slice(0, 10).forEach((i) => { i.role = "quote"; });
  out.d4 = checkForays(f).errors;
}
/* D5's pair clause (monotone, Q-04) — a WARNING since F-102, never an error,
   so the line comes from the warnings list; the Q-01 stamp is kept only to
   prove it no longer changes which list the line lands in. */
{
  const f = clone();
  foray(f).generated = true;
  const items = played(f);
  segOf(f, items[0].segment_id).boundary = "sentence";
  const a = segOf(f, items[0].segment_id);
  const b = segOf(f, items[1].segment_id);
  a.end_sec = a.start_sec + 100;
  b.end_sec = b.start_sec + 105;
  const run = checkForays(f);
  out.d5pair = run.errors;
  out.d5pairWarnings = run.warnings;
}
process.stdout.write(JSON.stringify(out));
`;

/** One child process for the file — the checker is deterministic on a fixture
 * it is handed, so three tests share one run. */
let cached: Record<string, string[]> | null = null;
function checkerErrors(): Record<string, string[]> {
  if (cached) return cached;
  const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", DRIVER], {
    encoding: "utf8",
    env: { ...process.env, CHECKER_URL: pathToFileURL(CHECKER).href, FIXTURE_ROOT },
    maxBuffer: 32 * 1024 * 1024
  });
  cached = JSON.parse(stdout) as Record<string, string[]>;
  return cached;
}

/** The checker prefixes every Foray-scoped line with `foray "<id>": `, which
 * `projectedRuleOf` strips before matching. Strip it here too so the patterns
 * are asserted against exactly what they are asked to match.
 *
 * ERRORS ONLY. Since F-102 one driver case also collects `warnings` (D5's pair
 * clause is reported rather than gated), and a pattern in
 * `PROJECTED_RULE_PATTERNS` must be proven against a line the checker put in
 * the list the projection actually reads — `errors`. A pattern that matched
 * only a warning would pass the guard below while classifying nothing real. */
const bodies = (emitted: Record<string, string[]>): string[] =>
  Object.entries(emitted)
    .filter(([key]) => !key.endsWith("Warnings"))
    .flatMap(([, lines]) => lines)
    .map((e) => e.replace(/^foray "[^"]*": /, ""));

describe("F-101 — the projected-rule table matches what check-forays.mjs actually emits", () => {
  it("every pattern in PROJECTED_RULE_PATTERNS matches at least one line the real checker emitted", () => {
    /* MUTATION THAT KILLS THIS: put back either rule Q-04 retired — add
       `["D3", /^D3 FAIL:/]` or `["D5-IQR", /^D5 FAIL: interquartile range/]`
       to PROJECTED_RULE_PATTERNS. The checker emits neither string any more
       (`grep -c 'D3 FAIL'` is 0; "interquartile" survives only in comments),
       so the pattern matches nothing here and the rule's name is red. Ran it —
       red on both, naming the rule. This is the test that would have caught
       the two dead entries the day Q-04 landed; without it, a pattern that
       matches nothing is indistinguishable from a rule that never fires. */
    const emitted = checkerErrors();
    const lines = bodies(emitted);
    expect(lines.length).toBeGreaterThan(10);

    const unmatched = PROJECTED_RULE_PATTERNS.filter(([, rx]) => !lines.some((line) => rx.test(line))).map(([rule]) => rule);
    expect(unmatched).toEqual([]);

    /* And every named rule has a pattern — the two lists cannot drift apart. */
    expect(PROJECTED_RULE_PATTERNS.map(([rule]) => rule).sort()).toEqual([...PROJECTED_RULES].sort());
  });

  it("classifies the real lines: M4, D2's end clause and D4's share clause are projected; D2's run, D4's adjacency and D5's pair are monotone", () => {
    /* MUTATION THAT KILLS THIS: widen D4's pattern to `/^D4 FAIL:/` or D2's to
       `/^D2 FAIL:/`. Both rules emit a monotone clause under the same prefix —
       D4's adjacency run and D2's three-in-a-row — and a partial that already
       contains the offending run would have its verdict read off an estimate
       of acts not yet written. Ran it — red on the `null` expectations. */
    const emitted = checkerErrors();
    const classify = (line: string) => projectedRuleOf(line);
    const find = (key: string, needle: RegExp): string => {
      const hit = emitted[key]?.find((e) => needle.test(e));
      expect(hit, `the checker emitted no ${needle} line for the ${key} fixture — the mutation no longer trips the rule`).toBeDefined();
      return hit!;
    };

    expect(classify(find("m4", /M4 FAIL: .* % of segments/))).toBe("M4");
    expect(classify(find("m4", /M4 FAIL: .* beyond its longest clip/))).toBe("M4");
    expect(classify(find("d2end", /D2 FAIL: the Foray ends on/))).toBe("D2-end");
    expect(classify(find("d4", /D4 FAIL: \d+\/\d+ segments are/))).toBe("D4-share");

    expect(classify(find("d2run", /D2 FAIL: \d+ consecutive segments/))).toBeNull();
    expect(classify(find("d4", /D4 FAIL: \d+ adjacent/))).toBeNull();
    /* The one the audit found riding on luck: D5's message names the two clips,
       matches no pattern, and falls through to monotone. Correct for a pair
       rule — the offending pair is already in the prefix — and asserted against
       the checker's own text rather than assumed.

       F-102 MOVED IT OUT OF `errors` ENTIRELY. The pair clause is reported and
       gates nothing, so its line is a WARNING now and the projection never sees
       it at all; the classification below is asserted on the real warning text
       so the table stays honest if the clause is ever gated again. And the
       checker emitting NO D5 error is pinned here, next to the reason: a
       partial refused for a uniform pair is a run aborted so a Foray can play
       less tape. */
    expect(classify(find("d5pairWarnings", /D5 \(reported, not gated/))).toBeNull();
    expect(emitted["d5pair"]?.some((e) => /^foray "[^"]*": D5/.test(e))).toBe(false);
  });

  it("no line the checker emits for a retired rule is classified at all", () => {
    /* MUTATION THAT KILLS THIS: none can, directly — this is the negative half
       of the first test and exists to state the invariant in the report. If
       `check-forays.mjs` ever emits `D3 FAIL` or an interquartile line again,
       the first test still passes (patterns are gone) and this one records
       that the checker is not emitting them, so the pair of tests brackets the
       question from both sides. */
    const lines = bodies(checkerErrors());
    expect(lines.some((l) => /^D3 FAIL:/.test(l))).toBe(false);
    expect(lines.some((l) => /interquartile/.test(l))).toBe(false);
  });
});
