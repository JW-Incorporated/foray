import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { MODEL_IDS, MODEL_COSTS, modelFor, costFor, resolveModelId, resolveModelCost, MODEL_TIERS } from "../src/config/models";

/**
 * F-03: "Model ids are last-generation: `claude-opus-4-1`, `claude-sonnet-4-5`,
 * `claude-haiku-4-5`. The Claude 5 family is current. Production would be
 * calling superseded models. Recommend pinning current ids in one config."
 *
 * The drift was possible because the id was written down seven times. The
 * grep test below is the part that keeps it closed: pinning the ids in one
 * file fixes today's drift, and only a test that fails when a NEW literal
 * appears stops tomorrow's.
 */

const SRC = path.resolve(__dirname, "..", "src");

/**
 * Any `claude-` literal, not just the three families in use today.
 *
 * Deliberately NOT an alternation of known family names. The whole failure
 * F-03 describes is a NEXT generation arriving and the repo still naming the
 * previous one, so a rule that only recognises the names already written down
 * would go quiet on exactly the id it exists to catch. `src/` contains no
 * `claude-` string outside `config/models.ts`, so the broad form has nothing
 * legitimate to trip over.
 */
const CLAUDE_ID_RE = /claude-[a-z0-9]/;

function readSource(rel: string): string {
  return fs.readFileSync(path.join(SRC, rel), "utf8");
}

/** Every class in the repo that sends a `model:` to the Anthropic API. */
const BUILDER_FILES = [
  "generation/AnthropicSpineBuilder.ts",
  "generation/AnthropicDeepenActBuilder.ts",
  "generation/AnthropicNarrationWriterBuilder.ts",
  "generation/AnthropicNarrationVerifierBuilder.ts",
  "generation/AnthropicContinuityBuilder.ts",
  "generation/AnthropicPromptUnderstander.ts",
  "generation/AnthropicExternalResearcher.ts",
  "enrich/AnthropicEnricher.ts"
];

describe("config/models — the one place a model id is written down (F-03)", () => {
  it("defaults every tier to the current Claude family", () => {
    expect(MODEL_IDS.opus).toBe("claude-opus-5");
    expect(MODEL_IDS.sonnet).toBe("claude-sonnet-5");
    /* Pinned to the dated snapshot on purpose: haiku is the one tier whose
       current model is still 4.x, and pinning makes "deliberately last
       generation" reviewable instead of looking like the drift F-03 found. */
    expect(MODEL_IDS.haiku).toBe("claude-haiku-4-5-20251001");
  });

  it("carries a per-call cost for every tier, ordered opus > sonnet > haiku", () => {
    for (const tier of MODEL_TIERS) {
      expect(MODEL_COSTS[tier].usdPerInputToken).toBeGreaterThan(0);
      expect(MODEL_COSTS[tier].usdPerOutputToken).toBeGreaterThan(MODEL_COSTS[tier].usdPerInputToken);
    }
    expect(costFor("opus").usdPerInputToken).toBeGreaterThan(costFor("sonnet").usdPerInputToken);
    expect(costFor("sonnet").usdPerInputToken).toBeGreaterThan(costFor("haiku").usdPerInputToken);
  });

  it("prices the published rates: opus $5/$25, sonnet $2/$10, haiku $1/$5 per MTok", () => {
    expect(costFor("opus").usdPerInputToken * 1_000_000).toBeCloseTo(5.0, 6);
    expect(costFor("opus").usdPerOutputToken * 1_000_000).toBeCloseTo(25.0, 6);
    expect(costFor("sonnet").usdPerInputToken * 1_000_000).toBeCloseTo(2.0, 6);
    expect(costFor("sonnet").usdPerOutputToken * 1_000_000).toBeCloseTo(10.0, 6);
    expect(costFor("haiku").usdPerInputToken * 1_000_000).toBeCloseTo(1.0, 6);
    expect(costFor("haiku").usdPerOutputToken * 1_000_000).toBeCloseTo(5.0, 6);
  });

  it("lets an env var override an id without touching code", () => {
    expect(resolveModelId("opus", { FORAY_MODEL_OPUS: "claude-opus-4-8" })).toBe("claude-opus-4-8");
    expect(resolveModelId("sonnet", { FORAY_MODEL_SONNET: "  " })).toBe("claude-sonnet-5");
    expect(resolveModelId("haiku", {})).toBe("claude-haiku-4-5-20251001");
  });

  it("lets an env var override a price, and ignores a malformed one", () => {
    const overridden = resolveModelCost("sonnet", { FORAY_MODEL_SONNET_USD_PER_MTOK_IN: "4" });
    expect(overridden.usdPerInputToken * 1_000_000).toBeCloseTo(4.0, 6);
    /* A bad rate must fall back to the published one, never to zero: a zero
       rate silently disables the budget guard, which is the failure mode
       F-04 is about. */
    const malformed = resolveModelCost("opus", { FORAY_MODEL_OPUS_USD_PER_MTOK_OUT: "not-a-number" });
    expect(malformed.usdPerOutputToken * 1_000_000).toBeCloseTo(25.0, 6);
    const negative = resolveModelCost("opus", { FORAY_MODEL_OPUS_USD_PER_MTOK_IN: "-3" });
    expect(negative.usdPerInputToken * 1_000_000).toBeCloseTo(5.0, 6);
  });

  it("modelFor and costFor read the same frozen map", () => {
    for (const tier of MODEL_TIERS) {
      expect(modelFor(tier)).toBe(MODEL_IDS[tier]);
      expect(costFor(tier)).toEqual(MODEL_COSTS[tier]);
    }
  });
});

describe("no builder writes a model id down for itself (F-03, grep)", () => {
  it.each(BUILDER_FILES)("%s reads its model from config/models", (rel) => {
    const src = readSource(rel);
    expect(src).toMatch(/from "\.\.\/config\/models"/);
    expect(src).toMatch(/const MODEL = modelFor\("(opus|sonnet|haiku)"\)/);
  });

  it.each(BUILDER_FILES)("%s contains no literal claude-* model id", (rel) => {
    const src = readSource(rel);
    /* Doc comments are code too: run 1's builders documented the id they were
       calling as prose, and that prose was equally stale. The rule is that a
       model id string appears in exactly one file. */
    expect(src).not.toMatch(CLAUDE_ID_RE);
  });

  it("finds no literal model id anywhere in src/ except config/models.ts", () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith(".ts")) continue;
        const rel = path.relative(SRC, full).split(path.sep).join("/");
        if (rel === "config/models.ts") continue;
        if (CLAUDE_ID_RE.test(fs.readFileSync(full, "utf8"))) offenders.push(rel);
      }
    };
    walk(SRC);
    expect(offenders).toEqual([]);
  });
});
