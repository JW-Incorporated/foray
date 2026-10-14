import { houseStyleTitle } from "../copy/rules";
import type { IntentUnderstanding } from "../types/generation";
import { isSourcingStopword } from "./catalogueLookup";

/**
 * GV-67 (docs/roadmap/generation-v2.md, from W4-03): the intent the stages
 * BEFORE the spine run on when the spine writes the listener copy
 * (`flags.foldSpineCopy`, FORAY_SPINE_FOLD_COPY or the FORAY_FAST_PATH
 * umbrella).
 *
 * The topic decision and the research map need a subject before any spine
 * exists, and on the classic path that subject is a model's restatement of
 * the prompt (extractIntent, one call plus a possible title re-case). On the
 * folded path it is derived in code: the distinct sourcing keywords of the
 * prompt, in the prompt's order. The spine call then writes the real
 * subject, angle, prior knowledge, disappointment, title and summary from the
 * listener's own words (`SpineBuildContext.listenerPrompt`).
 *
 * NOT THE PROMPT AS WRITTEN. What this returns is banked (the understand,
 * topic and research-shape checkpoints), so it holds a lower-cased,
 * stopword-stripped, de-duplicated keyword list rather than the prompt
 * string — no worse than today, where the model's restatement is banked. A
 * prompt that is already a lower-case run of distinct keywords ("octopus
 * cognition") equals its own keyword list, and that is the one case the
 * banked value can match it. The prompt itself rides only on the call stack
 * (§4.1's "prompts are discarded").
 *
 * A PROMPT WITH NO KEYWORD (every word a stopword or too short, "is it
 * on?") has no pre-spine intent: `preSpineIntent` returns null and
 * `understandPromptFast` asks the understander for one, as the classic path
 * does, rather than send the topic decision and the research map off on a
 * placeholder subject.
 */

/** At most this many keywords make the pre-spine subject and angle. */
export const PRE_SPINE_MAX_KEYWORDS = 12;

/** At most this many keywords make the provisional title. */
export const PROVISIONAL_TITLE_KEYWORDS = 8;

/** What the pre-spine intent says for the fields only the spine can decide. */
export const PRE_SPINE_SENTINEL = "not yet known: decided by the spine";

/** The provisional title when the prompt carries no sourcing keyword. */
export const PROVISIONAL_TITLE_FALLBACK = "Untitled Foray";

/**
 * The prompt's words, Unicode-aware: split on anything that is not a letter or
 * a digit in any script (so "Björk" and "Gödel" stay whole, where the
 * catalogue's ASCII tokenizer cuts them in two), lower-cased, the sourcing
 * stopwords dropped (`isSourcingStopword`, the list `tokenizeForSourcing`
 * drops). A word is kept when it is longer than two characters, or when it
 * is a two-letter word written ALL-CAPS in the prompt ("AI", "EU", "UK"):
 * the acronym is often the whole subject. Local to this module on purpose:
 * the sourcing scorers' tokenizer is unchanged.
 */
function promptKeywordTokens(prompt: string): string[] {
  const out: string[] = [];
  for (const raw of prompt.normalize("NFC").split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length === 0) continue;
    const word = raw.toLowerCase();
    if (isSourcingStopword(word)) continue;
    const length = Array.from(word).length;
    if (length > 2 || (length === 2 && /^\p{Lu}{2}$/u.test(raw))) out.push(word);
  }
  return out;
}

/** The distinct sourcing keywords of `prompt`, in the order they first appear. */
export function preSpineKeywords(prompt: string, max: number = PRE_SPINE_MAX_KEYWORDS): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const word of promptKeywordTokens(prompt)) {
    if (seen.has(word)) continue;
    seen.add(word);
    out.push(word);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * The pre-spine intent: `subject` and `angle` are the keyword list joined by
 * spaces; `priorKnowledge` and `disappointment` are the sentinel. No title or
 * summary: those come from the spine. Null when the prompt carries no
 * keyword (see the module comment): the caller falls back to extractIntent.
 */
export function preSpineIntent(prompt: string): IntentUnderstanding | null {
  const keywords = preSpineKeywords(prompt);
  if (keywords.length === 0) return null;
  const subject = keywords.join(" ");
  return { subject, angle: subject, priorKnowledge: PRE_SPINE_SENTINEL, disappointment: PRE_SPINE_SENTINEL };
}

/**
 * The title a run that stops BEFORE the spine carries (the pre-spine
 * no-supply stop): the first keywords in the house style. Used nowhere else;
 * every post-spine outcome takes the spine's own title.
 */
export function provisionalTitle(prompt: string): string {
  const keywords = preSpineKeywords(prompt, PROVISIONAL_TITLE_KEYWORDS);
  return houseStyleTitle(keywords.length > 0 ? keywords.join(" ") : PROVISIONAL_TITLE_FALLBACK);
}
