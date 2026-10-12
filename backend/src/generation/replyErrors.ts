/**
 * Errors a structured reply can end in, shared by every provider path
 * (GV-19, docs/roadmap/generation-v2.md, from W2-04).
 *
 * TruncatedReplyError lived in anthropicCall.ts; it moved here so the
 * provider-neutral chat path (chat/askStructured.ts) throws the SAME class
 * as the Anthropic path, and a caller's `instanceof TruncatedReplyError`
 * (researchShape.ts's fan-out) matches a refusal from either. anthropicCall.ts
 * re-exports it, so its existing importers are unchanged.
 */

/**
 * A reply that stopped because it hit its output-token ceiling (Anthropic
 * `stop_reason: "max_tokens"`, OpenAI-compatible `finish_reason: "length"`).
 * It is refused before any parse: `parseOrRepairJson` closes open strings and
 * brackets, so a cut-off reply would otherwise parse as a SHORTER valid answer.
 */
export class TruncatedReplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TruncatedReplyError";
  }
}
