#!/usr/bin/env node
import { GenerationRequestSchema } from "../types/generation";
import { createPromptUnderstander } from "../generation/createPromptUnderstander";
import { understandPrompt } from "../generation/understandPrompt";

/**
 * `npm run generate-foray` — §4.0-4.1's capture surface
 * (docs/curation/generation-architecture.md).
 *
 * WHY A CLI, NOT A WEB FORM. §4.0 asks for "a freeform text field plus a
 * duration selector. Nothing else." and explicitly leaves the surface
 * choice open for phase 1 ("check whether this belongs in the existing
 * drawer/admin surface or needs a new one; your call, justify it").
 *
 * This repo's frontend (app.js) is a static site with zero server calls
 * into `backend/` today — every existing backend/src/cli/*.ts entry point
 * (buildSession, buildLadder, ingestFixtures, learnInterests) is run by a
 * founder from a terminal, not reached from the drawer. Phase 1 generation
 * is founder-only (§1.3: "Wyatt and Joey" prompt, reviewed before it hits
 * the catalogue), so there is no listener-facing surface this stage needs
 * to serve yet, and inventing a drawer entry + an HTTP API to reach this
 * backend would be scope well past "prompt capture + safety/clarify/
 * intent" — the next real UI work is §4.9's publish review, which already
 * has a path (a PR a founder reviews). A CLI is the minimal, honest surface
 * for a founder-only tool with no existing web-to-backend bridge, and it
 * matches every other founder-run pipeline stage already in this directory.
 * When phase 2 opens this to any user (§1.3), THAT is the point to build a
 * real web capture surface — this file's `understandPrompt()` call is the
 * exact same one an HTTP handler would make.
 *
 * Usage:
 *   npm run generate-foray -- --prompt "the history of grilling" --duration medium
 *   npm run generate-foray -- --prompt "Mercury" --duration short
 *     (author_id defaults to "founder"; phase 1's only real author — see
 *     types/generation.ts's GenerationRequestSchema for why the field is
 *     real rather than hardcoded away)
 *
 * WHAT THIS PRINTS AND WHAT IT DOES NOT DO: this stage ends at §4.1's
 * structured understanding. It has no downstream stage to hand off to yet
 * (§4.2 research is the next kanban card), so it prints the result and
 * exits — there is no `data/forays.json` write, no draft record, nothing
 * persisted. The raw prompt is never written to disk by this command or
 * anything it calls (§9.4's ruling; see backend/test/promptNoPersistence.test.ts).
 */

interface CliArgs {
  prompt: string | null;
  duration: "short" | "medium" | "long" | null;
  authorId: string;
}

function parseArgs(argv: string[]): CliArgs {
  const get = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag);
    return idx >= 0 ? argv[idx + 1] : undefined;
  };
  const duration = get("--duration");
  return {
    prompt: get("--prompt") ?? null,
    duration: duration === "short" || duration === "medium" || duration === "long" ? duration : null,
    authorId: get("--author-id") ?? "founder"
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.prompt || !args.duration) {
    console.error('Usage: npm run generate-foray -- --prompt "<text>" --duration short|medium|long [--author-id <id>]');
    process.exitCode = 1;
    return;
  }

  const request = GenerationRequestSchema.safeParse({
    prompt: args.prompt,
    duration: args.duration,
    author_id: args.authorId,
    visibility: "catalogue"
  });
  if (!request.success) {
    console.error("Invalid generation request:", request.error.issues.map((i) => i.message).join("; "));
    process.exitCode = 1;
    return;
  }

  const understander = createPromptUnderstander();
  const result = await understandPrompt(request.data.prompt, understander, { userId: request.data.author_id });

  switch (result.outcome) {
    case "rejected":
      console.log(`REJECTED (${result.rejection.category}): ${result.rejection.explanation}`);
      process.exitCode = 1;
      return;
    case "needs_clarification":
      console.log(result.clarification.question);
      for (const reading of result.clarification.readings) console.log(`  - ${reading}`);
      console.log("  - or something else?");
      process.exitCode = 2; // distinct from a hard failure — the caller should re-prompt, not retry
      return;
    case "understood":
      console.log("Understood:");
      console.log(`  subject:        ${result.intent.subject}`);
      console.log(`  angle:          ${result.intent.angle}`);
      console.log(`  prior knowledge: ${result.intent.priorKnowledge}`);
      console.log(`  disappointment: ${result.intent.disappointment}`);
      console.log(`  duration:       ${request.data.duration}`);
      console.log(`  author_id:      ${request.data.author_id}`);
      return;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
