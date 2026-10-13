import { createDirectJevClient, HttpJevClient } from "../generation/jevClient";
import type { JevQuestion, JevResult, JevState } from "../generation/jevTypes";

/**
 * GV-20 live step ONLY (docs/roadmap/generation-v2.md): asks Jev one noul,
 * one choice and one score question on a neutral synthetic state, `--runs`
 * times each (default 5), and prints per question type the median and p95
 * latency, the answering model, usage and the last request id, plus one
 * sanitized success per type for a recorded fixture
 * (backend/test/fixtures/jev/). Nothing in the pipeline or the tests runs it.
 *
 *   npx tsx backend/src/cli/jevSmoke.ts [--runs 5]
 *
 * Needs JEV_API_KEY or JEV_KEY_FILE; without one it exits 1 and sends
 * nothing. It asks Jev directly whatever the judge route
 * (FORAY_STAGE_JUDGE, FORAY_GENERATION_MODE, FORAY_LLM_BASE_URL) says. The state is synthetic: no prompt, transcript or listener text
 * leaves the machine. The key is never printed.
 */

const STATE: JevState = {
  sentence: "The lighthouse on the point was automated in 1990.",
  sources: {
    o1: "Keepers lived at the lighthouse with their families for most of the century.",
    o2: "In 1990 the light was automated and the last keeper left the point."
  }
};

const QUESTIONS: Record<"noul" | "choice" | "score", JevQuestion> = {
  noul: {
    id: "supported",
    type: "noul",
    instructions: "Do the sources state what the sentence claims?",
    criteria: { true: "A source states the sentence's claim.", false: "No source states the sentence's claim." }
  },
  choice: {
    id: "best_source",
    type: "choice",
    instructions: "Which source makes the sentence's claim?",
    criteria: { o1: { what: "source o1" }, o2: { what: "source o2" }, none: { what: "no source makes this claim" } }
  },
  score: {
    id: "clarity",
    type: "score",
    instructions: "How clearly does the sentence read aloud?",
    criteria: ["unreadable", "hard to follow", "acceptable", "clear", "very clear"]
  }
};

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[rank]!;
}

function parseRuns(argv: string[]): number {
  const at = argv.findIndex((a) => a === "--runs" || a.startsWith("--runs="));
  if (at < 0) return 5;
  const raw = argv[at]!.includes("=") ? argv[at]!.split("=")[1] : argv[at + 1];
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 100) throw new Error("--runs must be an integer from 1 to 100");
  return n;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const runs = parseRuns(argv);
  /* Jev itself, not the routed judge (GV-47): in local mode the routed judge is
     FallbackJudgeClient or the Qwen judge, and the routing table can throw. */
  const client = createDirectJevClient();
  if (!(client instanceof HttpJevClient)) {
    console.error("jevSmoke: no Jev key. Set JEV_API_KEY or JEV_KEY_FILE; nothing was sent.");
    return 1;
  }
  console.log(`jevSmoke: ${client.url} model ${client.model}, budget ${client.budgetMs} ms, ${runs} run(s) per question type`);
  let failures = 0;
  const fixtures: Record<string, unknown> = {};
  for (const [kind, question] of Object.entries(QUESTIONS)) {
    const latencies: number[] = [];
    let last: JevResult | undefined;
    for (let i = 0; i < runs; i += 1) {
      last = await client.ask(STATE, [question], { purpose: `jev-smoke-${kind}` });
      latencies.push(last.latencyMs);
      if (!last.ok) {
        failures += 1;
        console.log(`  ${kind} run ${i + 1}: ${last.error.category} (${last.error.reason})`);
      } else if (fixtures[kind] === undefined) {
        fixtures[kind] = { question, answers: last.answers, model: last.model, usage: last.usage, requestId: last.requestId };
      }
    }
    latencies.sort((a, b) => a - b);
    const summary = last?.ok
      ? `model ${last.model}${last.modelMismatch ? " (MISMATCH)" : ""}, usage in ${last.usage.inputTokens} / out ${last.usage.outputTokens}, request ${last.requestId}`
      : "last run failed";
    console.log(`  ${kind}: median ${percentile(latencies, 0.5)} ms, p95 ${percentile(latencies, 0.95)} ms; ${summary}`);
  }
  console.log("Sanitized successes (synthetic state; copy into backend/test/fixtures/jev/ if recording):");
  console.log(JSON.stringify({ state: STATE, results: fixtures }, null, 2));
  return failures === 0 ? 0 : 1;
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(2);
    }
  );
}
