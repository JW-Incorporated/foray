import { demotedNames, houseStyleTitle, titleStyleProblems } from "../../copy/rules";
import { joinParts, type PromptParts } from "../promptLayout";
import { TitleRecaseSchema } from "../replySchemas";

/**
 * §4.1's clarity and intent prompts and the title re-case turn, moved here
 * from AnthropicPromptUnderstander.ts by GV-32 (decision 8: prompt text moves
 * once, into prompts/*.ts; the Anthropic and Chat builders both import it).
 *
 * Layout (promptLayout.ts): the rules and the JSON shape are `stable`; the
 * listener's prompt is `call`; there is no `foray` part, because no Foray
 * exists yet when the prompt is understood. The words are the pre-GV-32
 * words, reordered so the rules come first.
 */

/** The opening of a clarity or intent prompt: the listener's own words. */
function listenerPromptLines(intro: string, prompt: string): string {
  return [intro, "", `"${prompt}"`].join("\n");
}

export function buildClarityPromptParts(prompt: string): PromptParts {
  return {
    stable: [
      "Decide if this prompt is GENUINELY ambiguous — meaning it names something with two or",
      "more substantially different plausible subjects (e.g. \"Mercury\" could mean the planet,",
      "the element, or the Roman god). Do NOT flag a prompt as ambiguous just because it is broad",
      "or could be narrowed — \"Roman siege weapons\" is NOT ambiguous even though it covers many",
      "devices, because there is one clear subject. The bar is high: only flag it when a wrong",
      "guess would produce a genuinely different Foray.",
      "",
      "If ambiguous, give exactly 2-3 concrete readings (do not include an \"or something else\"",
      "option in `readings` — that is appended separately) and a single one-sentence question",
      "offering those readings.",
      "",
      "Respond with ONLY a single JSON object, no markdown fences, no other text, matching exactly:",
      '{"ambiguous": boolean, "readings": string[], "question": string|null}'
    ].join("\n"),
    foray: "",
    call: listenerPromptLines("A user has asked for an AI-generated audio documentary (a \"Foray\") on this prompt:", prompt)
  };
}

/** The legacy single-string clarity prompt (the Anthropic builder sends it). */
export function buildClarityPrompt(prompt: string): string {
  return joinParts(buildClarityPromptParts(prompt));
}

export function buildIntentPromptParts(prompt: string): PromptParts {
  return {
    stable: [
      "Produce a structured understanding of the request with exactly these six fields:",
      "- subject: the concrete subject of the Foray, as a short noun phrase of at most 8 words —",
      "  NOT a restatement of the prompt",
      "- angle: the specific angle or thesis worth taking, not just the topic",
      "- priorKnowledge: what the listener probably already knows about this",
      "- disappointment: what would make this Foray a disappointment to the listener — this is",
      "  the most important field; be concrete, not generic",
      "- title: the Foray's public title, at most 10 words, in SENTENCE CASE: capitalise the first word, proper",
      "  nouns and acronyms, and nothing else (\"How AI actually gets built\", \"How Earth got plate tectonics and",
      "  Venus never did\" — not \"How AI Actually Gets Built\"). No closing period; a closing ? or ! is fine.",
      "- summary: one plain sentence of at most 16 words that a listener sees under the title —",
      "  what they will come away knowing, not a list of subtopics",
      "  Neither the title nor the summary may count or number the Foray's parts (\"eight beats\", \"22 segments\",",
      "  \"three acts\", \"Act one\", \"this act\", \"the running order\"): those are our production words, not a",
      "  listener's. A machine checks that after you answer.",
      "",
      "Respond with ONLY a single JSON object, no markdown fences, no other text, matching exactly:",
      '{"subject": string, "angle": string, "priorKnowledge": string, "disappointment": string, ' +
        '"title": string, "summary": string}'
    ].join("\n"),
    foray: "",
    call: listenerPromptLines("A user asked for an AI-generated audio documentary (a \"Foray\") on this prompt:", prompt)
  };
}

/** The legacy single-string intent prompt (the Anthropic builder sends it). */
export function buildIntentPrompt(prompt: string): string {
  return joinParts(buildIntentPromptParts(prompt));
}

/** One turn of the title re-ask conversation, provider-neutral. */
export interface TitleTurn {
  role: "user" | "assistant";
  content: string;
}

/**
 * What a title re-ask hands its `ask`: the 3-turn conversation (the intent
 * prompt, the parsed intent as the assistant's own turn, the corrective line)
 * and the corrective line alone (for metering). `ask` meters, sends and
 * returns the reply's text; it may throw.
 */
export interface TitleRecaseAsk {
  messages: TitleTurn[];
  line: string;
}

/**
 * The title house-style re-ask (see AnthropicPromptUnderstander's
 * sentenceCaseTitle), extracted by GV-25 so the Anthropic builder and its
 * Chat twin share one implementation and differ only in how they ask:
 * - no title, or a title that already keeps the style after the code fixes,
 *   asks nothing;
 * - otherwise ONE ask, with the checker's own words for what is wrong;
 * - any failure of the ask (budget refusal, 429/529, network, a refused
 *   reply) keeps the original title, as does a reply that does not parse,
 *   rewords the title, still breaks the style, or demotes a name.
 * `who` prefixes the warnings (the builder's class name). Moved here from
 * AnthropicPromptUnderstander.ts by GV-32 (decision 8), unchanged.
 */
export async function recaseIntentTitle<T extends { title?: string }>(
  intent: T,
  promptText: string,
  listenerPrompt: string,
  who: string,
  ask: (request: TitleRecaseAsk) => Promise<string>
): Promise<T> {
  const title = intent.title?.trim();
  if (!title) return intent;
  const problems = titleStyleProblems(houseStyleTitle(title));
  if (problems.length === 0) return intent;
  const line =
    `The title "${title}" ${problems.join("; ")}. Reply with ONLY a JSON object {"title": string}: the same title in sentence case — ` +
    "the first word, proper nouns and acronyms capitalised, every other word lower case, no closing period.";
  /* A style-only call must never cost the run: the intent is already
     parsed and usable, so a budget refusal, a 429/529 or a network error
     here keeps the original title, exactly as a second miss does (review of
     PR #785). */
  let text: string;
  try {
    text = await ask({
      messages: [
        { role: "user", content: promptText },
        { role: "assistant", content: JSON.stringify(intent) },
        { role: "user", content: line }
      ],
      line
    });
  } catch (error) {
    console.warn(`${who}: the title re-ask for "${title}" failed (${error instanceof Error ? error.message : String(error)}); keeping it`);
    return intent;
  }
  let restyled: string | undefined;
  try {
    const parsed = TitleRecaseSchema.safeParse(JSON.parse(text.replace(/^[^{]*/, "").replace(/[^}]*$/, "")));
    restyled = parsed.success ? parsed.data.title.trim() : undefined;
  } catch {
    restyled = undefined;
  }
  /* Only the CASE may change: a reply that rewords the title is not the
     title the rest of the intent was written around. */
  const letters = (t: string): string => houseStyleTitle(t).toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!restyled || letters(restyled) !== letters(title) || titleStyleProblems(houseStyleTitle(restyled)).length > 0) {
    console.warn(`${who}: the title "${title}" is still not sentence case after one re-ask; keeping it`);
    return intent;
  }
  /* ...and the case change may not demote a name to get past the checker
     ("Why Doctor who still works" keeps the letters and passes it). */
  const demoted = demotedNames(title, restyled, listenerPrompt);
  if (demoted.length > 0) {
    console.warn(`${who}: the re-ask lower-cased what may be a name (${demoted.join(", ")}) in "${restyled}"; keeping "${title}"`);
    return intent;
  }
  return { ...intent, title: restyled };
}
