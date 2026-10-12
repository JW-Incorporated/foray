import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  BUDGET_STAGES,
  BUDGET_TIERS,
  BUILDER_MAX_TOKENS,
  LABEL_BUDGET_STAGES,
  OUTPUT_TOKEN_BUDGETS,
  R1_17_SUM,
  budgetStageOf,
  enforcedMaxTokens,
  outputBudgetFor,
  outputBudgetMode,
  stampOutputBudget,
  truncationDecision,
  writerActBudget
} from "../src/config/outputBudgets";
import { FlagValueError } from "../src/generation/generationFlags";
import { seamBand, type SeamPlan } from "../src/generation/actSeams";

/**
 * GV-14 (docs/roadmap/generation-v2.md, from W1-07): R1-17's output-token
 * budgets in one table, the builders' caps beside it, and the pure
 * truncation decision the provider layer will act on. Each test names the
 * mutation that turns it red; every one was run.
 */

const GENERATION_DIR = path.join(__dirname, "..", "src", "generation");
const read = (file: string) => fs.readFileSync(path.join(GENERATION_DIR, file), "utf8");

const ENV_KEY = "FORAY_OUTPUT_BUDGETS";
const savedFlag = process.env[ENV_KEY];
afterEach(() => {
  if (savedFlag === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedFlag;
});

/* A fixture act: a seam carrying Patch + Carry into a clip (its ceiling
   765 + 1870 + 260 = 2895, capped at SEAM_MAX_CHARS 150 x 17 = 2550), a
   lone Hinge (135), and an intro-only seam (the Intro band, 260). */
const beat = (mode: string) => ({ mode }) as unknown as SeamPlan["beats"][number];
const FIXTURE_SEAMS = [
  { seamId: "s0", beats: [beat("Patch"), beat("Carry")], introduces: {} as SeamPlan["introduces"] },
  { seamId: "s1", beats: [beat("Hinge")] },
  { seamId: "s2", beats: [] }
] as SeamPlan[];

describe("outputBudgets: the table", () => {
  it("has a value for short, medium and long on every BudgetStage, and no stage it does not declare", () => {
    /* MUTATION THAT KILLS THIS: spine short 450 -> 451, or delete the
       continuity row. Ran both — red. */
    expect(Object.keys(OUTPUT_TOKEN_BUDGETS).sort()).toEqual([...BUDGET_STAGES].sort());
    for (const stage of BUDGET_STAGES) {
      for (const tier of BUDGET_TIERS) {
        const cell = OUTPUT_TOKEN_BUDGETS[stage][tier];
        expect(cell === "per-seam" || (Number.isInteger(cell) && cell >= 0), `${stage}/${tier}`).toBe(true);
      }
    }
    expect(OUTPUT_TOKEN_BUDGETS.spine).toEqual({ short: 450, medium: 1200, long: 2400 });
  });

  it("sums R1-17's per-Foray stages to 1,650 on short, and needs the seam plan on medium", () => {
    /* MUTATION THAT KILLS THIS: spine short 450 -> 451, or add
       understand.intent to R1_17_STAGES. Ran both — red. */
    expect(R1_17_SUM("short")).toBe(1650);
    expect(R1_17_SUM("medium")).toBeNull();
    const seamBands = FIXTURE_SEAMS.map(seamBand);
    expect(R1_17_SUM("medium", { seamBands })).toBe(1200 + 981);
  });

  it("sizes the medium/long writer budget from the seam bands: ceil(sum max x 0.25 x 1.25) + 20 per seam", () => {
    /* MUTATION THAT KILLS THIS: drop the `+ 20 per seam` term, or sum the
       band floors instead of the ceilings. Ran both — red. */
    const seamBands = FIXTURE_SEAMS.map(seamBand);
    expect(seamBands.map(([, max]) => max)).toEqual([2550, 135, 260]);
    /* Hand-computed: 2550 + 135 + 260 = 2945; x 0.3125 = 920.3125 -> 921; + 3 x 20 = 981. */
    expect(writerActBudget(seamBands)).toBe(981);
    expect(outputBudgetFor("narrate.act", "medium", { seamBands })).toBe(981);
    expect(outputBudgetFor("narrate.act", "long")).toBeNull();
    expect(outputBudgetFor("narrate.act", "short", { seamBands })).toBe(1200);
  });
});

/** Every createMessage / createWebSearchTurn* call in one builder, and the
 * label it passes: the argument after the params object, a string literal or
 * a parameter whose type is a union of string literals. */
function builderLabels(source: string): { sites: number; labels: string[] } {
  const callRe = /\b(createMessage|createWebSearchTurn|createWebSearchTurnKeepingTruncation)\s*\(/g;
  const labels: string[] = [];
  let sites = 0;
  for (let m = callRe.exec(source); m; m = callRe.exec(source)) {
    if (/function\s+$/.test(source.slice(Math.max(0, m.index - 20), m.index))) continue;
    sites += 1;
    let i = source.indexOf("{", m.index);
    let depth = 0;
    for (; i < source.length; i += 1) {
      if (source[i] === "{") depth += 1;
      else if (source[i] === "}" && --depth === 0) break;
    }
    const arg = /^\s*,\s*(?:"([^"]+)"|([A-Za-z_$][\w$]*))/.exec(source.slice(i + 1));
    if (!arg) continue;
    if (arg[1]) {
      labels.push(arg[1]);
      continue;
    }
    const typeName = new RegExp(`\\b${arg[2]}\\s*:\\s*([A-Za-z_]\\w*)`).exec(source)?.[1];
    const union = typeName ? new RegExp(`type\\s+${typeName}\\s*=\\s*([^;]+);`).exec(source)?.[1] : undefined;
    for (const lit of union?.matchAll(/"([^"]+)"/g) ?? []) if (lit[1]) labels.push(lit[1]);
  }
  return { sites, labels };
}

describe("outputBudgets: which budget a call is held to", () => {
  it("maps every label the seven Anthropic builders pass to createMessage (source grep)", () => {
    /* MUTATION THAT KILLS THIS: delete the `deepen-act` entry from
       LABEL_BUDGET_STAGES. Ran it — red. */
    const builders = fs.readdirSync(GENERATION_DIR).filter((f) => /^Anthropic\w+\.ts$/.test(f));
    expect(builders).toHaveLength(7);
    const all = new Set<string>();
    for (const file of builders) {
      const { sites, labels } = builderLabels(read(file));
      expect(sites, file).toBeGreaterThan(0);
      expect(labels.length, `${file}: a call site whose label the grep could not resolve`).toBeGreaterThanOrEqual(sites);
      for (const label of labels) {
        all.add(label);
        expect(budgetStageOf({ label }), `${file}: ${label}`).not.toBeNull();
      }
    }
    expect([...all].sort()).toEqual(Object.keys(LABEL_BUDGET_STAGES).sort());
  });

  it("tells the understander's three calls apart, then falls back to role and to the pipeline stage", () => {
    /* MUTATION THAT KILLS THIS: return "understand.intent" for every
       prompt-understand call, or drop the judge rule (a Jev verify in
       narrate:2 then reads narrate.act). Ran both — red. */
    expect(budgetStageOf({ label: "prompt-understand", maxTokens: 400 })).toBe("understand.clarity");
    expect(budgetStageOf({ label: "prompt-understand", maxTokens: 600 })).toBe("understand.intent");
    expect(budgetStageOf({ label: "prompt-understand", maxTokens: 120 })).toBe("understand.title");
    expect(budgetStageOf({ label: "prompt-understand", role: "title", maxTokens: 999 })).toBe("understand.title");
    expect(budgetStageOf({ label: "chat-x", role: "verifier", stage: "narrate:1" })).toBe("narrate.verify");
    expect(budgetStageOf({ label: "chat-x", stage: "narrate:1" })).toBe("narrate.act");
    expect(budgetStageOf({ label: "jev", role: "judge", stage: "narrate:2" })).toBe("narrate.verify");
    expect(budgetStageOf({ label: "jev", role: "judge", stage: "understand" })).toBe("understand.clarity");
    expect(budgetStageOf({ label: "jev", role: "judge", stage: "spine" })).toBeNull();
    expect(budgetStageOf({ label: "x", stage: "stitch:0" })).toBe("continuity");
    expect(budgetStageOf({ label: "x", stage: "finalize" })).toBeNull();
    expect(budgetStageOf({ label: "x" })).toBeNull();
  });

  it("stamps a spine call on short with 900 output tokens as budget 450, over; unknowns stay null", () => {
    /* MUTATION THAT KILLS THIS: `>` -> `>=` in the overBudget comparison, or
       read 0 for an unreported output count. Ran both — red. */
    expect(stampOutputBudget({ label: "spine", outputTokens: 900 }, "short")).toEqual({ outputBudget: 450, overBudget: true });
    expect(stampOutputBudget({ label: "spine", outputTokens: 450 }, "short")).toEqual({ outputBudget: 450, overBudget: false });
    expect(stampOutputBudget({ label: "spine", outputTokens: null }, "short")).toEqual({ outputBudget: 450, overBudget: null });
    expect(stampOutputBudget({ label: "spine", outputTokens: 900 }, undefined)).toEqual({ outputBudget: null, overBudget: null });
    expect(stampOutputBudget({ label: "spine", outputTokens: 900 }, "epic")).toEqual({ outputBudget: null, overBudget: null });
    expect(stampOutputBudget({ label: "narration_write_act", outputTokens: 900 }, "medium")).toEqual({ outputBudget: null, overBudget: null });
  });
});

describe("outputBudgets: truncation policy", () => {
  it("keeps finished seams for the writer, re-asks the spine once then refuses, and accepts a complete reply", () => {
    /* MUTATION THAT KILLS THIS: return the policy without the attempt check
       (spine attempt 2 then re-asks forever), or drop "length" from
       TRUNCATION_STOP_REASONS. Ran both — red. */
    expect(truncationDecision("narrate.act", { stopReason: "max_tokens", attempt: 1 })).toBe("keep-finished-seams");
    expect(truncationDecision("spine", { stopReason: "max_tokens", attempt: 1 })).toBe("reask-once-naming-overrun");
    expect(truncationDecision("spine", { stopReason: "max_tokens", attempt: 2 })).toBe("refuse");
    expect(truncationDecision("spine", { stopReason: "length", attempt: 2 })).toBe("refuse");
    expect(truncationDecision("narrate.verify", { stopReason: "length", attempt: 1 })).toBe("refuse");
    expect(truncationDecision("spine", { stopReason: "end_turn", attempt: 2 })).toBe("accept");
    expect(truncationDecision("spine", { stopReason: null, attempt: 1 })).toBe("accept");
    expect(() => truncationDecision("spine", { stopReason: "max_tokens", attempt: 0 })).toThrow(RangeError);
  });

  it("enforces min(cap, budget) only in enforce mode and only for a positive budget", () => {
    /* MUTATION THAT KILLS THIS: drop the `mode !== "enforce"` guard (report
       mode would then cut every spine call to 450), or allow a 0 budget
       through. Ran both — red. */
    expect(enforcedMaxTokens(8000, 450, "report")).toBe(8000);
    expect(enforcedMaxTokens(8000, 450, "off")).toBe(8000);
    expect(enforcedMaxTokens(8000, 450, "enforce")).toBe(450);
    expect(enforcedMaxTokens(300, 450, "enforce")).toBe(300);
    expect(enforcedMaxTokens(4000, 0, "enforce")).toBe(4000);
    expect(enforcedMaxTokens(4000, null, "enforce")).toBe(4000);
  });
});

describe("outputBudgets: the FORAY_OUTPUT_BUDGETS flag", () => {
  it("is read at call time: report when unset, off/enforce when set, and an unknown value throws naming only the variable", () => {
    /* MUTATION THAT KILLS THIS: read the flag once at import into a const
       (the later settings are ignored), or append the raw value to the
       FlagValueError message in generationFlags.readFlag. Ran both — red. */
    delete process.env[ENV_KEY];
    expect(outputBudgetMode()).toBe("report");
    process.env[ENV_KEY] = "enforce";
    expect(outputBudgetMode()).toBe("enforce");
    process.env[ENV_KEY] = "off";
    expect(outputBudgetMode()).toBe("off");
    process.env[ENV_KEY] = "loud-secret-ish";
    let caught: unknown;
    try {
      outputBudgetMode();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FlagValueError);
    expect((caught as Error).message).toContain(ENV_KEY);
    expect((caught as Error).message).not.toContain("loud-secret-ish");
  });
});

describe("outputBudgets: BUILDER_MAX_TOKENS parity", () => {
  it("holds exactly the max_tokens each Anthropic builder sends today", () => {
    /* MUTATION THAT KILLS THIS: BUILDER_MAX_TOKENS.continuity 500 -> 600.
       Ran it — red. */
    const constantOf = (file: string, name: string): number => {
      const source = read(file);
      const value = new RegExp(`const ${name} = (\\d+);`).exec(source)?.[1];
      expect(value, `${file}: ${name}`).toBeDefined();
      /* Every max_tokens in that builder sends the constant. */
      const sites = [...source.matchAll(/max_tokens:\s*([\w.]+)/g)].map((m) => m[1]);
      expect(sites.length, file).toBeGreaterThan(0);
      for (const site of sites) expect([name, "maxOutputTokens"], `${file}: max_tokens ${site}`).toContain(site);
      return Number(value);
    };
    const understander = read("AnthropicPromptUnderstander.ts");
    const slice = (from: string, to?: string) => understander.slice(understander.indexOf(from), to ? understander.indexOf(to) : undefined);
    const literalCap = (body: string): number => {
      const caps = [...new Set([...body.matchAll(/max_tokens:\s*(\d+)/g)].map((m) => Number(m[1])))];
      expect(caps).toHaveLength(1);
      return caps[0] ?? Number.NaN;
    };
    expect({
      clarity: literalCap(slice("async assessClarity", "async extractIntent")),
      intent: literalCap(slice("async extractIntent", "private async sentenceCaseTitle")),
      title: literalCap(slice("private async sentenceCaseTitle")),
      spine: constantOf("AnthropicSpineBuilder.ts", "MAX_OUTPUT_TOKENS"),
      deepen: constantOf("AnthropicDeepenActBuilder.ts", "MAX_OUTPUT_TOKENS"),
      continuity: constantOf("AnthropicContinuityBuilder.ts", "MAX_OUTPUT_TOKENS"),
      verifier: constantOf("AnthropicNarrationVerifierBuilder.ts", "MAX_ACT_VERIFY_OUTPUT_TOKENS")
    }).toEqual(BUILDER_MAX_TOKENS);
  });
});
