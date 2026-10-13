import { houseStyleTitle } from "../copy/rules";
import type { IntentUnderstanding } from "../types/generation";
import { tokenizeForSourcing } from "./catalogueLookup";

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
 * NEVER THE PROMPT VERBATIM. What this returns is banked (the understand,
 * topic and research-shape checkpoints), so it holds a lower-cased,
 * stopword-stripped keyword list and never the prompt string itself — no
 * worse than today, where the model's restatement is banked. The verbatim
 * prompt rides only on the call stack (§4.1's "prompts are discarded").
 */

/** At most this many keywords make the pre-spine subject and angle. */
export const PRE_SPINE_MAX_KEYWORDS = 12;

/** At most this many keywords make the provisional title. */
export const PROVISIONAL_TITLE_KEYWORDS = 8;

/** What the pre-spine intent says for the fields only the spine can decide. */
export const PRE_SPINE_SENTINEL = "not yet known: decided by the spine";

/** The subject when the prompt carries no sourcing keyword at all (every word
 * a stopword or shorter than three letters). Never the prompt itself. */
export const PRE_SPINE_NO_KEYWORDS = "the listener's request";

/** The provisional title when the prompt carries no sourcing keyword. */
export const PROVISIONAL_TITLE_FALLBACK = "Untitled Foray";

/** The distinct sourcing keywords of `prompt`, in the order they first appear. */
export function preSpineKeywords(prompt: string, max: number = PRE_SPINE_MAX_KEYWORDS): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const word of tokenizeForSourcing(prompt)) {
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
 * summary: those come from the spine.
 */
export function preSpineIntent(prompt: string): IntentUnderstanding {
  const keywords = preSpineKeywords(prompt);
  const subject = keywords.length > 0 ? keywords.join(" ") : PRE_SPINE_NO_KEYWORDS;
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
