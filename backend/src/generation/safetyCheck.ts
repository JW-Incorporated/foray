import type { SafetyVerdict } from "../types/generation";

/**
 * §4.1's safety check — the FIRST thing that happens to a prompt, before any
 * spend on understanding it. The doc is explicit this belongs in "a
 * committed, unit-tested module, not in a system prompt where it cannot be
 * reviewed or unit-tested" — so this is a pure, synchronous, dependency-free
 * function: no LLM call, no network, no retry surface. A rejection is final;
 * there is nothing here that loops.
 *
 * THREE FORBIDDEN CATEGORIES (verbatim from generation-architecture.md §4.1):
 *   - sexual content involving minors
 *   - instructions for mass-casualty weapons
 *   - targeted harassment of a named private individual
 *
 * DESIGN: each rule requires two signals to co-occur (a subject-matter term
 * AND an intent/action term), not a single keyword. A bare keyword match
 * would misfire on ordinary historical/educational prompts the pipeline must
 * allow — "Roman siege weapons" and "the history of the Manhattan Project"
 * are both legitimate Forays and must never trip this gate. Requiring
 * co-occurrence is deliberately conservative in the other direction too:
 * this is a phase-1, founder-only tool (§1.3), so a false negative here is
 * caught by the founder reviewing the Foray before publish (§4.9), while a
 * false positive costs a confusing rejection with no recourse. Strengthening
 * this list (more terms, better recall) is expected to be an ongoing task —
 * it is a committed module precisely so that work can happen here, in code
 * review, rather than by editing a prompt no one can diff.
 */

interface Rule {
  category: SafetyVerdict["category"];
  /** Both patterns must match somewhere in the prompt (order-independent). */
  subject: RegExp;
  intent: RegExp;
  explanation: string;
}

const RULES: Rule[] = [
  {
    category: "sexual-content-minors",
    subject: /\b(child|children|kid|kids|minor|minors|toddler|toddlers|underage|preteen|pre-teen)\b/i,
    intent: /\b(sex|sexual|sexualiz\w*|nude|naked|porn\w*|erotic|explicit)\b/i,
    explanation:
      "This prompt combines sexual content with a minor. 4a will not generate that, and there's no rephrasing that changes the answer — try a different topic."
  },
  {
    category: "mass-casualty-weapons",
    subject: /\b(bomb|explosive device|nerve agent|bioweapon|biological weapon|chemical weapon|nuclear device|dirty bomb|sarin|vx gas|anthrax|improvised explosive)\b/i,
    intent: /\b(how (?:to|do i|can i|would i)|instructions? for|recipe for|steps? to|synthesi[sz]e|build a|make a|construct a|assemble a)\b/i,
    explanation:
      "This prompt asks for build/how-to instructions for a mass-casualty weapon. 4a won't generate that. A Foray about the history, policy, or science of the topic is a different request — ask for that instead."
  },
  {
    category: "targeted-harassment",
    subject: /\bmy (ex|neighbor|neighbour|coworker|co-worker|boss|classmate|roommate|room-mate|landlord|manager|teacher|professor)\b/i,
    intent: /\b(dox|doxx|expose|humiliate|harass|stalk|ruin|blackmail|out them|get back at)\b/i,
    explanation:
      "This prompt targets a named private individual for harassment. 4a won't generate that."
  }
];

/**
 * Checks a raw prompt against the forbidden-topics list. Pure and
 * synchronous — the same input always produces the same verdict, and
 * nothing here writes to any store (see `understandPrompt.ts` for the
 * no-persistence guarantee at the pipeline level).
 */
export function checkSafety(prompt: string): SafetyVerdict {
  for (const rule of RULES) {
    if (rule.subject.test(prompt) && rule.intent.test(prompt)) {
      return { allowed: false, category: rule.category, explanation: rule.explanation };
    }
  }
  return { allowed: true, category: null, explanation: null };
}
