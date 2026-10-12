import { describe, it, expect } from "vitest";
import { z } from "zod";
import { parseWithRetry, parseLastJsonBlock } from "../src/generation/parseWithRetry";
import fs from "node:fs";
import path from "node:path";
import { AnthropicSpineBuilder } from "../src/generation/AnthropicSpineBuilder";
import { RunLog, currentCallContext, runWithRunLog, withCallContext, type CallContext } from "../src/generation/runLog";
import { BudgetGuard } from "../src/cost/budgetGuard";
import { InMemoryCostEventSink } from "../src/cost/costEvents";
import { makeFakeAnthropicClient, textBlock } from "./helpers/fakeAnthropicClient";
import type { IntentUnderstanding } from "../src/types/generation";
import type { ResearchShape } from "../src/types/research";

/**
 * Direct unit coverage for the shared parseWithRetry/parseLastJsonBlock
 * helper extracted from the five private per-file copies (see this file's
 * own doc comment and t_550d289f). Testing this once here is the whole
 * point of the extraction — previously each of the five private copies was
 * untested and free to drift independently.
 */
describe("parseWithRetry", () => {
  const schema = z.object({ a: z.string() });

  it("parses plain JSON", async () => {
    expect(await parseWithRetry(schema, JSON.stringify({ a: "x" }))).toEqual({ a: "x" });
  });

  it("strips ```json fences before parsing", async () => {
    expect(await parseWithRetry(schema, "```json\n" + JSON.stringify({ a: "x" }) + "\n```")).toEqual({ a: "x" });
  });

  it("strips bare ``` fences (no json language tag)", async () => {
    expect(await parseWithRetry(schema, "```\n" + JSON.stringify({ a: "x" }) + "\n```")).toEqual({ a: "x" });
  });

  it("throws a wrapped error with cause on invalid JSON, with no reask given", async () => {
    await expect(parseWithRetry(schema, "not json")).rejects.toThrow(/failed schema validation/);
    try {
      await parseWithRetry(schema, "not json");
      throw new Error("expected parseWithRetry to throw");
    } catch (err) {
      expect((err as Error).cause).toBeDefined();
    }
  });

  it("throws on schema-valid JSON with the wrong shape", async () => {
    await expect(parseWithRetry(schema, JSON.stringify({ a: 123 }))).rejects.toThrow();
  });

  it("uses the custom errorPrefix in the thrown message", async () => {
    await expect(parseWithRetry(schema, "bad", "Custom prefix")).rejects.toThrow(/^Custom prefix failed schema validation/);
  });
});

describe("parseWithRetry — reask (F-39/WS-E item 5): a single re-ask on parse failure", () => {
  const schema = z.object({ a: z.string() });

  it("never calls reask when the first parse succeeds", async () => {
    let reaskCalls = 0;
    const reask = async () => {
      reaskCalls += 1;
      return JSON.stringify({ a: "should not be used" });
    };
    const result = await parseWithRetry(schema, JSON.stringify({ a: "x" }), "LLM output", reask);
    expect(result).toEqual({ a: "x" });
    expect(reaskCalls).toBe(0);
  });

  it("calls reask once on a first parse failure and returns its result if valid", async () => {
    let reaskCalls = 0;
    const reask = async () => {
      reaskCalls += 1;
      return JSON.stringify({ a: "repaired" });
    };
    const result = await parseWithRetry(schema, "not json at all", "LLM output", reask);
    expect(result).toEqual({ a: "repaired" });
    expect(reaskCalls).toBe(1);
  });

  it("tries reask only ONCE — a still-invalid reask reply fails the call rather than looping", async () => {
    let reaskCalls = 0;
    const reask = async () => {
      reaskCalls += 1;
      return "still not json";
    };
    await expect(parseWithRetry(schema, "not json at all", "LLM output", reask)).rejects.toThrow(/failed schema validation after one re-ask/);
    expect(reaskCalls).toBe(1);
  });

  it("reports the ORIGINAL parse failure, not a reask transport failure, if reask() itself throws", async () => {
    const reask = async (): Promise<string> => {
      throw new Error("network down");
    };
    await expect(parseWithRetry(schema, "not json at all", "LLM output", reask)).rejects.toThrow(/re-ask attempt itself failed: network down/);
  });
});

describe("parseLastJsonBlock", () => {
  const schema = z.object({ notes: z.string() });

  it("takes the LAST fenced block when multiple are present", async () => {
    const raw = [
      "```json",
      JSON.stringify({ notes: "first" }),
      "```",
      "some prose in between",
      "```json",
      JSON.stringify({ notes: "second" }),
      "```"
    ].join("\n");
    expect(await parseLastJsonBlock(schema, raw)).toEqual({ notes: "second" });
  });

  it("falls back to the bare text when no fenced block exists", async () => {
    expect(await parseLastJsonBlock(schema, JSON.stringify({ notes: "bare" }))).toEqual({ notes: "bare" });
  });

  it("throws when the last fenced block is invalid JSON", async () => {
    await expect(parseLastJsonBlock(schema, "```json\nnot json\n```")).rejects.toThrow();
  });
});

describe("parseWithRetry — F-39: a reply truncated before its closing brackets is repaired, not failed", () => {
  it("closes a missing final brace (generation run 1, verifier call #34)", async () => {
    const { z } = await import("zod");
    const { parseWithRetry, parseOrRepairJson } = await import("../src/generation/parseWithRetry");
    const schema = z.object({ verified: z.boolean(), verifierNotes: z.string() });
    const truncated = '{"verified": false, "verifierNotes": "No sources are declared for this page (\'(none declared)\')."';
    expect(await parseWithRetry(schema, truncated)).toEqual({ verified: false, verifierNotes: "No sources are declared for this page ('(none declared)')." });
    expect(parseOrRepairJson('{"a": [1, 2')).toBe('{"a": [1, 2]}');
    expect(parseOrRepairJson('{"a": "unterminated')).toBe('{"a": "unterminated"}');
  });
  it("leaves genuinely broken JSON to fail with the original error", async () => {
    const { z } = await import("zod");
    const { parseWithRetry } = await import("../src/generation/parseWithRetry");
    await expect(parseWithRetry(z.object({ a: z.number() }), "not json at all")).rejects.toThrow(/failed schema validation/);
  });
});

describe("parseWithRetry — WS-E item 4: no private copy drifts back in", () => {
  it("no file under backend/src/generation other than parseWithRetry.ts defines its own `function parseWithRetry`", () => {
    const generationDir = path.resolve(__dirname, "../src/generation");
    const offenders: string[] = [];
    // A private redeclaration was previously copy-pasted into several
    // Anthropic* builders (see this file's own module doc comment and
    // F-40) — each one delegated to the shared implementation, so it
    // never drifted in BEHAVIOR, but the existence of the local
    // declaration is exactly the shape drift starts from. Match a
    // `function parseWithRetry` declaration specifically (not merely the
    // identifier, which every real caller legitimately imports and uses).
    const declarationRe = /\bfunction\s+parseWithRetry\s*[<(]/;
    for (const entry of fs.readdirSync(generationDir)) {
      if (!entry.endsWith(".ts") || entry === "parseWithRetry.ts") continue;
      const filePath = path.join(generationDir, entry);
      const content = fs.readFileSync(filePath, "utf8");
      if (declarationRe.test(content)) offenders.push(entry);
    }
    expect(offenders).toEqual([]);
  });
});

/** Recursively lists every `.ts` file under `dir` (backend/src, so no
 * node_modules to worry about excluding). */
function listTsFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFilesRecursive(full));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("parseWithRetry — every reask closure meters its own spend (coordinator follow-up on F-39/F-40)", () => {
  it("every `const reask = async ...` closure in backend/src calls budgetGuard.checkAndRecord before its own messages.create", () => {
    // A re-ask is its own real, metered API call (see parseWithRetry.ts's
    // BUDGET doc comment): it re-sends the whole original prompt PLUS the
    // model's bad reply, so its estimate is larger than the original call's.
    // Every real Anthropic* builder's `reask` closure must call
    // `this.budgetGuard.checkAndRecord(...)` itself before its own
    // `messages.create` — otherwise that second call is unmetered spend.
    // This scans every `.ts` file under backend/src (not just
    // backend/src/generation — AnthropicEnricher.ts lives under
    // backend/src/enrich) for each `reask` closure declaration and checks
    // that its own body, up to its closing `};`, contains
    // "checkAndRecord". A closure that DOES NOT talk to the model at all
    // (no real reask closures currently look like that, but the rule is
    // still "if you declare a reask closure, meter it") would still need
    // to satisfy this — the point is structural, not behavioral.
    const srcDir = path.resolve(__dirname, "../src");
    const declarationRe = /^\s*const reask\s*=\s*async\b/;
    const closureEndRe = /^\s*};\s*$/;
    const offenders: string[] = [];
    let reaskClosuresFound = 0;

    for (const filePath of listTsFilesRecursive(srcDir)) {
      const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (!declarationRe.test(lines[i]!)) continue;
        reaskClosuresFound++;
        const bodyLines: string[] = [];
        let j = i + 1;
        for (; j < lines.length; j++) {
          if (closureEndRe.test(lines[j]!)) break;
          bodyLines.push(lines[j]!);
        }
        const body = bodyLines.join("\n");
        if (!body.includes("checkAndRecord")) {
          offenders.push(`${path.relative(srcDir, filePath)}:${i + 1}`);
        }
      }
    }

    // Structural sanity: fail loudly if the scan itself found nothing,
    // rather than passing trivially because the regex stopped matching a
    // future rename of `reask` (e.g. to `reAsk` or `retryOnce`).
    // 9 since CH2-08 folded AnthropicEnricher's two re-ask closures into
    // its one askJson helper.
    expect(reaskClosuresFound).toBeGreaterThanOrEqual(9);
    expect(offenders).toEqual([]);
  });
});

describe("parseWithRetry — GV-07: the re-ask is recorded as one, and every parse outcome is a ParseEvent", () => {
  const schema = z.object({ a: z.string() });

  it("the reask closure runs under reask 'json', and the log gets ok:false then ok:true", async () => {
    /* MUTATION THAT KILLS THIS: call `reask()` bare (drop its
       withCallContext({reask:'json'})) — the closure sees no reask. Or drop
       the recordParse calls — the log has no parse events. Ran both — red. */
    const log = new RunLog();
    const seen: CallContext[] = [];
    const out = await runWithRunLog(log, () =>
      withCallContext({ stage: "spine" }, () =>
        parseWithRetry(schema, "not json", "x", async () => {
          seen.push(currentCallContext());
          return JSON.stringify({ a: "y" });
        })
      )
    );
    expect(out).toEqual({ a: "y" });
    expect(seen).toEqual([{ stage: "spine", reask: "json" }]);
    expect(log.events("parse")).toEqual([
      { kind: "parse", ok: false, reask: false },
      { kind: "parse", ok: true, reask: true }
    ]);
  });

  it("a first-time parse is one ok:true event; a failed re-ask is ok:false twice; no log, no events and no change", async () => {
    const log = new RunLog();
    await runWithRunLog(log, () => parseWithRetry(schema, JSON.stringify({ a: "x" })));
    await expect(runWithRunLog(log, () => parseWithRetry(schema, "nope", "x", async () => "still nope"))).rejects.toThrow(/after one re-ask/);
    expect(log.events("parse").map((e) => [e.ok, e.reask])).toEqual([
      [true, false],
      [false, false],
      [false, true]
    ]);
    await expect(parseWithRetry(schema, "nope", "x", async () => JSON.stringify({ a: "z" }))).resolves.toEqual({ a: "z" });
  });

  it("a forced JSON re-ask through AnthropicSpineBuilder makes a second CallRecord with reask 'json'", async () => {
    /* MUTATION THAT KILLS THIS: same as above — without the wrapper the
       re-ask's record reads reask null. Ran it — red. */
    const validRawSpine = {
      overview: "We look at what happens when the thing you built meets the world that has to run it, told by the people who were there.",
      voice: { style: "s", register: "r", sentenceRhythm: "sr", narratorPresence: "np" },
      acts: [
        {
          title: "Act 1",
          thesis: "thesis",
          startState: "start",
          endState: "end",
          slots: [{ title: "slot", beats: [{ claim: "A claim happened", exploration: false }] }]
        }
      ]
    };
    const intent: IntentUnderstanding = { subject: "Charcoal briquettes", angle: "an industrial scheme", priorKnowledge: "grilling", disappointment: "none" };
    const researchShape: ResearchShape = {
      subject: intent.subject,
      angle: intent.angle,
      generatedAt: new Date().toISOString(),
      subtopics: [],
      nonObviousAngle: null,
      externalGapsResearched: []
    };
    const usage = { input_tokens: 50, output_tokens: 5 };
    const { client, create } = makeFakeAnthropicClient([]);
    create
      .mockResolvedValueOnce({ content: [textBlock("not json at all")], stop_reason: "end_turn", usage })
      .mockResolvedValueOnce({ content: [textBlock(JSON.stringify(validRawSpine))], stop_reason: "end_turn", usage });
    const builder = new AnthropicSpineBuilder(new BudgetGuard(new InMemoryCostEventSink(), 100), client);
    const log = new RunLog();
    const spine = await runWithRunLog(log, () =>
      withCallContext({ stage: "spine" }, () => builder.buildSpine(intent, researchShape, "short", { userId: "u1", sessionId: "s1" }))
    );
    expect(spine.acts).toHaveLength(1);
    expect(create).toHaveBeenCalledTimes(2);
    expect(log.calls().map((c) => [c.seq, c.stage, c.label, c.reask])).toEqual([
      [0, "spine", "spine", null],
      [1, "spine", "spine", "json"]
    ]);
    expect(log.events("parse").map((e) => e.ok)).toEqual([false, true]);
  });
});
