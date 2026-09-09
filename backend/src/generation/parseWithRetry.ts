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
    return schema.parse(JSON.parse(parseOrRepairJson(cleaned)));
  } catch (err) {
    throw new Error(`${errorPrefix} failed schema validation (no retry available in this build): ${(err as Error).message}`, {
      cause: err
    });
  }
}

/**
 * Returns `text` if it parses, else the cheapest repair that does: closing
 * brackets the model forgot at the very end. Generation run 1 (2026-09-09,
 * call #34): a verifier reply arrived complete except for its final `}` and
 * the parse failure was charged to the narration page as a rejected attempt
 * — the writer was then told its page "failed schema validation". A truncated
 * tail is the one malformation that is both common and unambiguous to mend;
 * anything else still fails as before.
 */
export function parseOrRepairJson(text: string): string {
  try {
    JSON.parse(text);
    return text;
  } catch {
    /* fall through to repair */
  }
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") stack.pop();
  }
  let repaired = text.trimEnd();
  if (inString) repaired += '"';
  repaired = repaired.replace(/,\s*$/, "");
  while (stack.length > 0) repaired += stack.pop();
  try {
    JSON.parse(repaired);
    return repaired;
  } catch {
    return text; // let the caller report the original failure
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
