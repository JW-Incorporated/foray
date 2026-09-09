import type { z } from "zod";

/**
 * Shared parser used by every real Anthropic* provider class
 * (AnthropicEnricher, AnthropicPromptUnderstander, AnthropicSpineBuilder,
 * AnthropicDeepenActBuilder, AnthropicExternalResearcher, and the §4.7/4.8
 * narration/continuity builders). Previously copy-pasted privately into
 * several files (identical bodies except the error message prefix) —
 * extracted here so it is tested once instead of many times, and so those
 * copies can no longer silently drift from each other (see
 * AnthropicEnricher.ts:50's stale "response.usage" comment for an example
 * of exactly that kind of drift already happening). `test/parseWithRetry.test.ts`
 * has a regression test that fails if a private `function parseWithRetry`
 * reappears anywhere under `backend/src/generation` other than this file.
 *
 * F-39 (generation run 1, 2026-09-09, verifier call #34): a reply arrived
 * complete except its final `}`, and — despite this function's name —
 * there was NO repair and no retry, so the parse failure was charged to
 * the page as a rejected attempt. `parseOrRepairJson` (below) fixes the
 * "truncated tail" case mechanically. This function now ALSO accepts an
 * optional `reask` callback: a real API call can still return prose that
 * is not JSON at all (not merely truncated), and for that case the cheap
 * fix is asking the model again, once, with the same messages plus one
 * extra user turn saying the previous reply was not valid JSON. Every
 * real Anthropic* builder passes a `reask` closure that re-sends its own
 * messages this way; a stub builder passes none because it never talks to
 * a model in the first place. Omitting `reask` preserves the original
 * "fail on the first bad parse" behavior exactly.
 */
export async function parseWithRetry<T>(
  schema: z.ZodType<T>,
  raw: string,
  errorPrefix = "LLM output",
  reask?: () => Promise<string>
): Promise<T> {
  try {
    return attemptParse(schema, raw);
  } catch (firstErr) {
    if (!reask) {
      throw new Error(`${errorPrefix} failed schema validation: ${(firstErr as Error).message}`, { cause: firstErr });
    }
    let retryRaw: string;
    try {
      retryRaw = await reask();
    } catch (reaskErr) {
      // The re-ask call itself failed (network/API) — report the ORIGINAL
      // parse failure; a transport error while re-asking should not be
      // reported to the caller as a JSON-shape problem.
      throw new Error(
        `${errorPrefix} failed schema validation (re-ask attempt itself failed: ${(reaskErr as Error).message}): ${(firstErr as Error).message}`,
        { cause: firstErr }
      );
    }
    try {
      return attemptParse(schema, retryRaw);
    } catch (secondErr) {
      throw new Error(`${errorPrefix} failed schema validation after one re-ask: ${(secondErr as Error).message}`, {
        cause: secondErr
      });
    }
  }
}

/** Strips a wrapping ```/```json fence (models occasionally add one despite
 * prompt instructions), repairs a truncated tail (see `parseOrRepairJson`),
 * then parses and schema-validates. Throws the RAW parse/validation error —
 * callers wrap it with their own prefix/attempt-count context. */
function attemptParse<T>(schema: z.ZodType<T>, raw: string): T {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "");
  return schema.parse(JSON.parse(parseOrRepairJson(cleaned)));
}

/**
 * Returns `text` if it parses, else the cheapest repair that does: closing
 * brackets the model forgot at the very end. Generation run 1 (2026-09-09,
 * call #34): a verifier reply arrived complete except for its final `}` and
 * the parse failure was charged to the narration page as a rejected attempt
 * — the writer was then told its page "failed schema validation". A truncated
 * tail is the one malformation that is both common and unambiguous to mend;
 * anything else still fails as before (and now gets the one-shot `reask`
 * above rather than an outright failure).
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
 * `parseWithRetry`'s parse/validate/wrap/reask logic.
 */
export async function parseLastJsonBlock<T>(
  schema: z.ZodType<T>,
  raw: string,
  errorPrefix = "LLM output",
  reask?: () => Promise<string>
): Promise<T> {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/g);
  const candidate =
    fenced && fenced.length > 0
      ? fenced[fenced.length - 1]!.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "")
      : raw;
  return parseWithRetry(schema, candidate.trim(), errorPrefix, reask);
}
