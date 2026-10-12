import type { ChatMessage } from "./chat/ChatProvider";

/**
 * GV-32 (docs/roadmap/generation-v2.md, #1286; from W2-13 and the prompt-split
 * half of W4-04; covers R1-10, GP-05): every planning prompt as three parts in
 * a fixed order, so the bytes that open it are the same on every call.
 *
 *   stable  text that never changes: the rules, the field glossary, the reply
 *           shape. No subject, no tier numbers, no ids, no timestamps.
 *   foray   text that is the same for every call of ONE Foray: the intent,
 *           the research map, the tier line, a spine summary that renders
 *           every act alike.
 *   call    text that belongs to this call alone: the listener's prompt, the
 *           act being deepened, the seam being smoothed.
 *
 * Why: SGLang's radix cache reuses a prefix only when it is byte-identical
 * (HW-04: a 24k-token prefix drops from 14 s to 0.24 s). Before this module
 * every planning prompt OPENED with per-run text (the spine's subject, the
 * deepen act marker, the listener prompt), so no call after the first could
 * reuse anything. With [stable][foray][call], deepen calls 2..n and every
 * re-ask (re-asks append turns, so the prefix is kept) share stable+foray.
 *
 * A content-preserving reorder: the same instruction lines, in a new order
 * (the deepen act marker is the one rewrite, prompts/deepen.ts). The legacy
 * Anthropic path keeps sending ONE user string, joinParts(parts); the Chat
 * builders send toChatMessages(parts), [system: stable, user: foray + call].
 */
export interface PromptParts {
  /** Identical for every Foray and every call of the stage. */
  stable: string;
  /** Identical for every call of the stage within one Foray; "" when none. */
  foray: string;
  /** This call only; "" when none. */
  call: string;
}

/** Blank line between parts, the way the prompts already separated paragraphs. */
const PART_SEPARATOR = "\n\n";

/** The string the legacy (single user turn) path sends: the non-empty parts,
 * in order, a blank line between them. */
export function joinParts(parts: PromptParts): string {
  return [parts.stable, parts.foray, parts.call].filter((p) => p.length > 0).join(PART_SEPARATOR);
}

/**
 * The chat path's opening turns: the stable part as the system message and
 * the rest as the first user message, so the system message alone is the
 * cacheable prefix every Foray shares and system + the foray part is the one
 * every call of a Foray shares. Always two messages, a fresh array each call.
 */
export function toChatMessages(parts: PromptParts): ChatMessage[] {
  return [
    { role: "system", content: parts.stable },
    { role: "user", content: [parts.foray, parts.call].filter((p) => p.length > 0).join(PART_SEPARATOR) }
  ];
}

/** The start of an ISO-8601 date-time (`new Date().toISOString()` writes
 * `2026-10-12T08:00:00.000Z`); a date and an hour:minute are enough to tell
 * one apart from prose. */
export const ISO_TIMESTAMP_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function stripAndSort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripAndSort);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const v = (value as Record<string, unknown>)[key];
    if (v === undefined) continue;
    if (typeof v === "string" && ISO_TIMESTAMP_RE.test(v)) continue;
    out[key] = stripAndSort(v);
  }
  return out;
}

/**
 * JSON for a prompt's stable or foray part: keys sorted at every depth, and
 * every property whose value is a string carrying an ISO timestamp dropped
 * (a `generatedAt` would otherwise make two renders of the same object differ
 * by the clock). Array order is kept: it is content.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(stripAndSort(value)) ?? "";
}
