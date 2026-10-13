import { NARRATOR_STRUCTURE_RULE } from "../../copy/narratorStructure";
import type { IntentUnderstanding } from "../../types/generation";
import type { ResearchShape } from "../../types/research";
import { DURATION_SHAPE_BUDGETS, SPINE_MIN_SEEDED_BEATS_PER_ACT, type DurationTier, type Spine } from "../../types/spine";
import { joinParts, type PromptParts } from "../promptLayout";
import type { SpineBuildContext } from "../SpineBuilder";
import { SPINE_COPY_FIELDS } from "../replySchemas";
import { SPINE_SEED_REPEAT_MIN, SPINE_SEED_THIRD_MIN } from "../spineSeeding";

/**
 * §4.3's spine prompt and its re-ask turns, moved here from
 * AnthropicSpineBuilder.ts by GV-32 (decision 8: prompt text moves once, into
 * prompts/*.ts; the Anthropic and Chat builders both import it).
 *
 * Layout (promptLayout.ts; W4-04 item 1 with W2-13's part names):
 *   stable  the act/slot/beat contract, the slot-title rule, beat-as-claim,
 *           the exploration floor, the voice and overview rules,
 *           NARRATOR_STRUCTURE_RULE and the reply shape. No subject, no tier
 *           numbers, no episode ids.
 *   foray   the subject line, angle, prior knowledge and disappointment, the
 *           research map with its quoted windows, the seeding rules (they
 *           exist only when windows were quoted, and they point at "the
 *           quoted windows above"), and the tier line with its length targets.
 *   call    empty: the spine is one call per Foray, and a re-ask appends
 *           turns (spineRevisionTurns), so the opening is kept.
 * The words are the pre-GV-32 words, reordered so the rules come first.
 */

/** One turn of the spine conversation, provider-neutral. */
export interface SpineTurn {
  role: "user" | "assistant";
  content: string;
}

/**
 * F-86 / F-98: the spine call's conversation. A first call is the prompt
 * alone; a re-ask (`revision` present) is [prompt, the refused reply as the
 * assistant's own turn, one user turn naming what to fix], the fix turn being
 * the seed-floor instruction for a `seed-floor` re-ask and the structural one
 * otherwise. Shared by the Anthropic builder and its Chat twin (GV-25), so the
 * two cannot ask a re-ask differently: the Anthropic builder opens with the
 * joined prompt as one user turn (this function), the Chat builder with
 * toChatMessages(parts) (GV-32), and both append spineRevisionTurns. A fresh
 * array on every call.
 */
export function spineConversation(promptText: string, revision: SpineBuildContext["revision"], folded: boolean = false): SpineTurn[] {
  return [{ role: "user", content: promptText }, ...spineRevisionTurns(revision, folded)];
}

/**
 * The turns a re-ask appends after the opening prompt: none on a first call,
 * otherwise [the refused reply as the assistant's turn, the fix turn]. The
 * opening is never rebuilt, so a re-ask keeps the first call's prefix (GV-32).
 */
export function spineRevisionTurns(revision: SpineBuildContext["revision"], folded: boolean = false): SpineTurn[] {
  if (!revision) return [];
  return [
    { role: "assistant", content: spineReplyText(revision.previous, folded) },
    {
      role: "user",
      content: revision.kind === "seed-floor" ? buildSeedFloorInstruction(revision.violations) : buildSpineFixInstruction(revision.violations)
    }
  ];
}

/**
 * F-86: the reply the gate refused, in the exact shape the prompt asked for —
 * `{voice, acts}` and nothing else — so the assistant turn in a re-ask is
 * what the model would have said, not a wrapper around it. Exported for the
 * test that pins the re-ask conversation.
 */
export function spineReplyText(previous: Spine, folded: boolean = false): string {
  if (!folded) return JSON.stringify({ overview: previous.overview, voice: previous.voice, acts: previous.acts });
  /* GV-67: a folded reply led with the copy fields, so its re-ask turn does
     too, in the order the prompt asked for them. A field the reply left out
     or blank stays out: the turn is what the model wrote, and nothing the
     pipeline would otherwise have filled in (spineFromReply leaves a missing
     subject or angle blank, never the keyword intent's). */
  const copy: Record<string, string> = {};
  for (const field of SPINE_COPY_FIELDS) {
    const value = previous[field];
    if (value !== undefined && value.trim() !== "") copy[field] = value;
  }
  return JSON.stringify({ ...copy, overview: previous.overview, voice: previous.voice, acts: previous.acts });
}

/**
 * F-86: the one user turn a structural re-ask adds. Short by design — the
 * whole prompt is still in the conversation, so this names ONLY what the gate
 * refused and says to keep the rest. Each violation is the gate's own message
 * (act, slot, the first 120 characters of the claim), which is what makes the
 * fix findable in a 30-beat reply. Exported for tests.
 */
export function buildSpineFixInstruction(violations: string[]): string {
  return [
    "Your previous spine failed the structural check before deepening. FIX ONLY THE FOLLOWING and keep",
    "everything else — every act, slot, beat, seed and the voice — exactly as it was:",
    ...violations.map((v) => `- ${v}`),
    "",
    "Every beat claim is ONE sentence (one full stop, at most 60 words); no claim appears twice; every act",
    "has a startState and an endState. Respond with ONLY the complete corrected JSON object, the same shape",
    "as before, no markdown fences, no other text."
  ].join("\n");
}

/**
 * F-98: the one user turn a SEED-FLOOR re-ask adds — same idiom as F-86's above
 * (the whole prompt is still in the conversation, the model's own reply is the
 * assistant turn, this names only what to change) and a deliberately different
 * ask.
 *
 * The structural re-ask says "these beats are malformed; fix them and touch
 * nothing else". This one says something the model can legitimately refuse for
 * some of the beats named: the windows above may genuinely not say what a
 * particular beat claims, and F-63's rule — never seed a claim its window does
 * not say — is stronger than any yield target. So the instruction asks for the
 * claim to be REWRITTEN from the window where the window has something to say,
 * and for the beat to be left exactly as it is where it does not. A re-ask that
 * demanded a seed per beat would buy seeds that `sourceBeats.ts` refuses one
 * stage later and narrate the beat anyway, with the claim damaged on the way
 * past. Exported for the test that pins the conversation.
 */
export function buildSeedFloorInstruction(violations: string[]): string {
  return [
    "Your previous spine is structurally fine, but too few of its beats are written from the quoted transcript",
    "windows above — and those windows are where this Foray's tape comes from: a beat with no seed is narrated,",
    "never played. The following beats carry no seed, each with the window that came closest to it:",
    ...violations.map((v) => `- ${v}`),
    "",
    "For each one where the named window (or any other window quoted above) ACTUALLY SAYS something the beat is",
    "about, rewrite that beat's claim in the window's own words and add its \"seed\": {\"episodeId\", \"startSec\",",
    "\"endSec\"}. Where no quoted window says it, LEAVE THE BEAT EXACTLY AS IT IS — never seed a claim its window",
    "does not carry, and never invent a window. Change nothing else: every other act, slot, beat, seed and the",
    "voice stay as they were, every claim is still ONE sentence, and the exploration marks are unchanged.",
    "",
    "Respond with ONLY the complete JSON object, the same shape as before, no markdown fences, no other text."
  ].join("\n");
}


/**
 * WHAT THE TAPE SAYS, UNDER THE SUBTOPIC IT SAYS IT ABOUT (WS-L; finding F-63).
 *
 * This is the change F-63 asks for, in the one place it can be made: run 2's
 * spine prompt said "Ai (semantic-concept, tape: strong, 761 items)" and not one
 * word of what those 761 items contain, so Opus wrote 35 beats from its own
 * knowledge of production machine learning and the archive was asked, four
 * stages later, to illustrate claims about ImageNet and feature stores that
 * nobody in it has ever uttered. The windows below are the archive's own
 * sentences, with the episode and the seconds they were spoken at.
 */
function tapeWindowLines(researchShape: ResearchShape): string[] {
  const lines: string[] = [];
  for (const subtopic of researchShape.subtopics) {
    if (subtopic.tapeWindows.length === 0) continue;
    lines.push(`  ${subtopic.label} — what the tape says:`);
    for (const w of subtopic.tapeWindows) {
      lines.push(`    [${w.episodeId} ${Math.round(w.startSec)}-${Math.round(w.endSec)}s] ${w.showTitle} — ${w.episodeTitle}`);
      lines.push(`      "${w.text}"`);
    }
  }
  return lines;
}

/**
 * THE HALF OF THE SIGNAL THAT SAYS WHETHER THE TAPE FITS (#703).
 *
 * The line this replaces read "tape: strong, 304 items", and a reader — human
 * or Opus — takes that as a statement about this Foray. It is not. Both numbers
 * come from `queryTapeAvailability`, which counts items in
 * `data/discover.json` carrying the concept; neither has looked at a
 * transcript. On 2026-09-14 "Medicine — tape: strong, 304 items" sat above five
 * clips about Lyme disease, injection moulding and toothpaste packaging, and
 * the number of episodes in the searchable corpus that actually said anything
 * about germ theory was zero. A confidence figure that cannot tell "lots of
 * relevant tape" from "lots of tape, none relevant" is worse than no figure.
 *
 * So the prompt now says both, and says which is which: `catalogue` is breadth
 * (how much of this KIND of thing exists at all) and `tape found` is fit (how
 * many episodes on this machine say this subtopic's own words, and how many of
 * them are quoted below). `tape found: none` under `catalogue: strong` is the
 * exact sentence the germ-theory map should have printed.
 */
function tapeFitPhrase(subtopic: ResearchShape["subtopics"][number]): string {
  if (subtopic.tapeEpisodesMatched === undefined) return "tape found: not measured";
  if (subtopic.tapeEpisodesMatched === 0) return "tape found: none";
  return `tape found: ${subtopic.tapeEpisodesMatched} episode(s), ${subtopic.tapeWindows.length} quoted below`;
}

/**
 * The spine prompt as [stable][foray] (GV-32; the module comment says what
 * goes where). `stable` is byte-identical for every intent, research map and
 * tier. Exported for tests and for measuring the prompt's size against a real
 * research map (G-25 records it): the words that reach the model are the
 * whole of WS-L and G-25, so they are asserted on directly.
 */
export function buildSpinePromptParts(
  intent: IntentUnderstanding,
  researchShape: ResearchShape,
  duration: DurationTier,
  listenerPrompt?: string
): PromptParts {
  const budget = DURATION_SHAPE_BUDGETS[duration];
  const subtopicLines = researchShape.subtopics
    .map(
      (s) =>
        `- ${s.label} (${s.source}, catalogue: ${s.tape.signal}, ${s.tape.itemCount} items; ${tapeFitPhrase(s)}${
          s.controversies.length > 0 ? `; controversies: ${s.controversies.join("; ")}` : ""
        }${
          // §4.2's external research is only invoked for a genuine catalogue
          // gap and is the most expensive collaborator in that stage — its
          // findings must actually reach this prompt, or the paid call has
          // no effect on the Foray's shape and the gap subtopic gets
          // invented from its bare label alone.
          s.externallyResearched && s.externalNotes ? `; external research: ${s.externalNotes}` : ""
        })`
    )
    .join("\n");

  const windowLines = tapeWindowLines(researchShape);
  /* ONE RULE, ADDED ONLY WHEN THERE IS TAPE TO OBEY IT WITH. A subject the
     archive is silent on keeps exactly today's prompt — §4.2's guardrail again:
     tape is a signal, never a filter. */
  /* AND WHICH EPISODES THE SEEDS IN ONE SLOT MAY COME FROM (F-70). A Foray may
     not draw more than a quarter of its segments from one episode (M4) and may
     not play one episode's tape backwards (M3), and run 2 attempt 4b broke both
     at once: two seeded beats in one slot named the SAME *Practical AI*
     episode, the later beat quoting the earlier stretch of it. The mechanical
     guarantee is `sourceBeats.ts`'s ledger, which now refuses the second window
     in either case — this paragraph exists so the spine stops asking for tape
     that will be refused, and spreads its seeds instead. Guidance, not a gate:
     a subject whose tape lives in one episode still gets a spine. */
  /* AND THE FLOOR IS A FLOOR, NOT THE ASK (G-25; tape-yield brief §5 R4). On
     the run-2 checkpoint the unseeded search admitted 0 of 14 beats at every
     floor value and the seeded path admitted 10 of 14: the seed is the only
     path that yields, so a Foray's tape count is bounded by how many beats the
     spine chose to seed. WS-L asked for two per act and the spine wrote
     fourteen seeds for thirty-two beats. It is now asked to seed every ACCOUNT
     beat a quoted window can carry, and told what an account beat is in the
     same words `types/spine.ts`'s `BeatKind` uses, so that the beats it leaves
     unseeded are the ones no recording could carry — arguments, which
     narration is for — and not simply the ones past the floor.
     AND THE M4 CAP IS STATED IN NUMBERS (R3; `spineSeeding.ts`). "A quarter"
     was already here; what it means at seeding time — one seed per episode
     until the spine carries eight — was not, and the run-2 spine seeded two
     episodes twice with fourteen seeds and lost an on-claim window to it. */
  const seedRule =
    windowLines.length === 0
      ? []
      : [
          "",
          `Every act must carry at least ${SPINE_MIN_SEEDED_BEATS_PER_ACT} beats whose claim states something one of the quoted`,
          "windows above actually says. Each of those beats carries \"seed\": {\"episodeId\": ..., \"startSec\": ...,",
          "\"endSec\": ...} copied from the bracketed window it was written from. Beats written from anything else",
          "omit \"seed\".",
          "",
          "That floor is a minimum, not a target: SEED EVERY ACCOUNT BEAT A WINDOW CAN CARRY. An account beat",
          "states an event, a practice, a measurement or a mechanism a person could be heard describing —",
          "whenever one of the quoted windows says it, write the claim from that window's own words and seed",
          "it. Only an argument beat — a claim about what something MEANS or what someone SHOULD do, which no",
          "recording of an event carries — stays unseeded and is narrated; so does a beat no quoted window",
          "actually says. Never seed a claim its window does not say: every seed is checked against the tape's",
          "own words downstream, and a claim the window does not carry is narrated anyway, with the seed wasted.",
          "",
          "Spread the seeds across EPISODES: across the WHOLE spine, seeded beats must name DIFFERENT episodeIds",
          "wherever the windows above allow it — no episode can supply more than a quarter of the finished",
          `Foray's tape. Concretely: seed each episodeId ONCE until the whole spine carries at least ${SPINE_SEED_REPEAT_MIN}`,
          "seeded beats; a second seed from an episode already seeded is admitted only after that, and a third",
          `only once the spine carries ${SPINE_SEED_THIRD_MIN}. A repeat seeded before then is refused downstream and its beat`,
          "narrated — take another episode's window instead. Each window above is listed once (no episode is quoted",
          "under two subtopics), so a repeat seed names the SAME window again with a sentence of it not yet",
          "used. If the spine really must seed two beats from the SAME",
          "episode, put them in the order the tape says them: the beat seeded from the earlier startSec comes first."
        ];

  /* GV-67: on the folded path (`listenerPrompt` set) the intent is only a
     keyword list with sentinel fields (preSpineIntent.ts), so the spine is
     given the listener's own words instead and writes the subject, angle and
     copy itself (SPINE_STABLE_FOLDED). The rest of the foray part is the same. */
  const opening =
    listenerPrompt !== undefined
      ? ['Build the SPINE for an audio documentary ("Foray") a listener asked for in these words:', `"${listenerPrompt}"`]
      : [
          `Build the SPINE for an audio documentary ("Foray") on: "${intent.subject}".`,
          `Angle: ${intent.angle}`,
          `What the listener probably already knows: ${intent.priorKnowledge}`,
          `This Foray disappoints if: ${intent.disappointment}`
        ];
  return {
    stable: listenerPrompt !== undefined ? SPINE_STABLE_FOLDED : SPINE_STABLE,
    foray: [
      ...opening,
      "",
      "Research map (candidate subtopics found so far):",
      subtopicLines,
      ...windowLines,
      ...seedRule,
      "",
      `Duration tier: ${duration}. Target exactly, within a small tolerance: ${budget.acts[0]}-${budget.acts[1]} acts, ` +
        `${budget.slots[0]}-${budget.slots[1]} slots total, ${budget.items[0]}-${budget.items[1]} beats total.`
    ].join("\n"),
    call: ""
  };
}

/** The legacy single-string spine prompt: stable, a blank line, foray. The
 * Anthropic builder sends it as one user turn. */
export function buildSpinePrompt(intent: IntentUnderstanding, researchShape: ResearchShape, duration: DurationTier, listenerPrompt?: string): string {
  return joinParts(buildSpinePromptParts(intent, researchShape, duration, listenerPrompt));
}

/** The rules both static halves share: everything before the reply shape. */
const SPINE_RULE_LINES = [
  "For EACH act, give: title, thesis, startState (what the listener believes entering), endState",
  "(what they believe leaving), and slots (each with a title and an ordered list of beats).",
  "",
  "Every slot title is printed for the listener under the Foray. Write it as a heading in plain words, and",
  "never count or point at the Foray's structure in it: no \"this act\", \"the last act\", \"Act one\",",
  "\"three beats\", \"22 segments\" or \"running order\" — the listener cannot see a running order. A machine",
  "checks that after you answer.",
  "",
  "Every beat MUST be a CLAIM, not a topic. Example: \"Charcoal briquettes were a Ford Motor",
  "Company waste-disposal scheme\" is a beat; \"Briquettes\" is not.",
  "",
  "Mark at least 30% of ALL beats (across the whole spine) with exploration: true — beats that go",
  "somewhere the prompt didn't literally ask for but a curious listener would want. Do not just",
  "sprinkle a token few; hit the floor for real.",
  "",
  "Decide the VOICE once for the whole spine (style, register, sentenceRhythm, narratorPresence) —",
  "it applies to every act; do not vary it per act.",
  "",
  "Write the OVERVIEW: three or four sentences the listener hears before anything else, telling them",
  "what this Foray covers. It is spoken aloud, so write it to be heard — no list, no colon-and-bullets,",
  "no \"first we... then we...\". Say what the Foray is about and what makes it worth an hour, the way",
  "you would tell a friend before pressing play. NEVER say how many acts or parts there are, never say",
  "\"this Foray has\", and never mention acts, beats or segments at all: the listener cannot see a",
  "running order and does not need one. A machine checks that after you answer.",
  `The overview is SPOKEN. ${NARRATOR_STRUCTURE_RULE}`,
  "",
  "Respond with ONLY a single JSON object, no markdown fences, no other text, matching exactly:"
];

/** The reply shape from the overview on: overview, voice and the acts. */
const SPINE_PLAN_SHAPE =
  '"overview": string, "voice": {"style": string, "register": string, "sentenceRhythm": string, "narratorPresence": string}, ' +
  '"acts": [{"title": string, "thesis": string, "startState": string, "endState": string, ' +
  '"slots": [{"title": string, "beats": [{"claim": string, "exploration": boolean, ' +
  '"seed"?: {"episodeId": string, "startSec": number, "endSec": number}}]}]}]}';

/** The spine prompt's static half: built once, the same bytes for every Foray. */
const SPINE_STABLE = [...SPINE_RULE_LINES, `{${SPINE_PLAN_SHAPE}`].join("\n");

/**
 * GV-67 (W4-03): the folded path's static half. No extractIntent call ran, so
 * the spine writes the listener copy itself, FIRST, before the acts it will
 * shape. The field rules are the intent prompt's (prompts/understand.ts) plus
 * `answersDisappointment` (R2's guard: the plan says how it avoids the
 * disappointment it named, which MQ-10 measures); then the same rules as the
 * classic half and the same reply shape, the seven copy fields leading it.
 * The same bytes for every folded Foray.
 */
const SPINE_STABLE_FOLDED = [
  "A listener's own request is quoted below. Before the acts, decide what this Foray is, and write these",
  "seven fields FIRST in your reply:",
  "- subject: the concrete subject of the Foray, as a short noun phrase of at most 8 words —",
  "  NOT a restatement of the request",
  "- angle: the specific angle or thesis worth taking, not just the topic; the acts below take it",
  "- priorKnowledge: what the listener probably already knows about this",
  "- disappointment: what would make this Foray a disappointment to the listener — this is",
  "  the most important field; be concrete, not generic",
  "- answersDisappointment: ONE sentence on how the acts below avoid that disappointment",
  "- title: the Foray's public title, at most 10 words, in SENTENCE CASE: capitalise the first word, proper",
  "  nouns and acronyms, and nothing else (\"How AI actually gets built\", \"How Earth got plate tectonics and",
  "  Venus never did\" — not \"How AI Actually Gets Built\"). No closing period; a closing ? or ! is fine.",
  "- summary: one plain sentence of at most 16 words that a listener sees under the title —",
  "  what they will come away knowing, not a list of subtopics",
  "  Neither the title nor the summary may count or number the Foray's parts (\"eight beats\", \"22 segments\",",
  "  \"three acts\", \"Act one\", \"this act\", \"the running order\"): those are our production words, not a",
  "  listener's. A machine checks that after you answer.",
  "",
  "Then build the spine.",
  "",
  ...SPINE_RULE_LINES,
  '{"subject": string, "angle": string, "priorKnowledge": string, "disappointment": string, ' +
    '"answersDisappointment": string, "title": string, "summary": string, ' +
    SPINE_PLAN_SHAPE
].join("\n");
