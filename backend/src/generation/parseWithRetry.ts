import type { z } from "zod";

/**
 * Shared parser used by every real Anthropic* provider class
 * (AnthropicEnricher, AnthropicPromptUnderstander, AnthropicSpineBuilder,
 * AnthropicDeepenActBuilder, AnthropicExternalResearcher). Previously
 * copy-pasted privately into all five files (identical bodies except the
 * error message prefix) — extracted here so it is tested once instead of
 * five times, and so the five copies can no longer silently drift from
 * each other (see AnthropicEnricher.ts:50's stale "response.usage" comment
 * for an example of exactly that kind of drift already happening).
 *
 * Despite the name, there is NO retry in this build (see the thrown
 * error's own message) — models occasionally wrap JSON in ```json fences
 * despite prompt instructions, so this strips those defensively before
 * parsing, then wraps any parse/validation failure in a single `Error`
 * with `cause` set to the original error for the caller's dead-letter
 * handling (corner case 32: "schema-validated JSON, retry once on
 * failure, then throw").
 */
export function parseWithRetry<T>(schema: z.ZodType<T>, raw: string, errorPrefix = "LLM output"): T {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  try {
    return schema.parse(JSON.parse(cleaned));
  } catch (err) {
    throw new Error(`${errorPrefix} failed schema validation (no retry available in this build): ${(err as Error).message}`, {
      cause: err
    });
  }
}

/**
 * Variant for AnthropicExternalResearcher, whose model may wrap the final
 * JSON answer in prose around its web-search tool calls — take the last
 * fenced or bare JSON object in the text before handing off to
 * `parseWithRetry`'s parse/validate/wrap logic.
 */
export function parseLastJsonBlock<T>(schema: z.ZodType<T>, raw: string, errorPrefix = "LLM output"): T {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/g);
  const candidate =
    fenced && fenced.length > 0
      ? fenced[fenced.length - 1]!.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "")
      : raw;
  return parseWithRetry(schema, candidate.trim(), errorPrefix);
}
