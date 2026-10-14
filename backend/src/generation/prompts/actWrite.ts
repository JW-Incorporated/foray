import { NARRATOR_STRUCTURE_RULE } from "../../copy/narratorStructure";
import { MIN_QUOTE_WORDS } from "../../types/narration";
import type { ActFrame, ActWriteRequest, ClipBrief, SeamBrief, SeamEditRequest, SeamNeighbour } from "../NarrationWriterBuilder";
import { joinParts, type PromptParts } from "../promptLayout";
import { WRITTEN_SEAM_JSON_SCHEMA } from "../seamStream";

/**
 * §4.7's per-act writer prompt (Q-02/Q-03), moved here from
 * AnthropicNarrationWriterBuilder.ts by GV-50 (docs/roadmap/generation-v2.md,
 * #1286; from W4-11 + W2-14, covers R2-08, GP-05, R1-10). Decision 8: prompt
 * text moves once, into prompts/*.ts; the Anthropic writer and its Chat twin
 * both import it.
 *
 * Layout (promptLayout.ts, the GV-32 [stable][foray][call] parts; W4-11's
 * prefix / foray / act):
 *   stable  the role line (no act title), HOW TO WRITE, CLAIMS AND QUOTES
 *           (the copy rules close HOW TO WRITE), the pronunciation line and
 *           the output contract ('json' or 'jsonl'), then the VOICE SLOT.
 *           The same bytes for every act, round and Foray, so the 9-11k-token
 *           writer prompt is a prefix-cache hit after its first read.
 *   foray   the voice line, decided once for the whole Foray.
 *   call    the act's title, the ACT FRAME (GV-38), the layout in play order,
 *           the DOCUMENTS and, on a retry, the REJECTIONS section. A retry
 *           round differs from round 1 only here.
 *
 * The one rewrite (every other line is the pre-GV-50 line, reordered): the
 * role line named the act ("one act ("<title>") of ..."), which put per-act
 * text in the first bytes; it now says "one act of ...", and the title is on
 * the THE ACT YOU ARE WRITING line that opens the call part.
 *
 * Not in `foray`: the Foray overview (W4-11 listed it there). The request
 * carries it only inside act 0's frame, as what the listener has just heard,
 * and printing it on every act would add text the writer does not get today;
 * this card is a reorder.
 *
 * THE VOICE SLOT (decision 17). Empty by default: no voice card or exemplar
 * ships unconditionally. GV-99 renders the founder-selected
 * tools/generation/exemplars/narration-exemplars.json (GV-42) into one fixed
 * block and passes it as `voiceBlock` only when FORAY_WRITER_EXEMPLARS=on; it
 * lands at the end of `stable`, after a blank line, so it is cached with the
 * rules. An empty or absent block leaves `stable` byte-identical.
 */

/** Which reply the prompt asks for: one JSON object for the act (today's
 * writer, both providers), or JSONL, one seam per line, which only the
 * streamed Chat writer (GV-84) asks for. */
export type ActWriteOutput = "json" | "jsonl";

export interface ActWritePromptOptions {
  /** Default 'json'. */
  output?: ActWriteOutput;
  /** The voice slot's contents (GV-99). Absent or "" leaves the slot empty. */
  voiceBlock?: string;
}

const JSON_ONLY = "Respond with ONLY a single JSON object, no markdown fences, no other text, matching exactly:";
const CLAIM_SHAPE = '{"claimText": string, "quote": string, "docId": string, "contested": boolean}';
/** One seam as the writer returns it, inside the 'json' reply's `seams` array
 * and as each line of a 'jsonl' reply. */
const SEAM_SHAPE = `{"seamId": string, "script": string, "claims": [${CLAIM_SHAPE}], "usedClaims": [number], "pronunciationHints": [{"word": string, "hint": string}]}`;

/** The voice line: decided once for the whole Foray, so it is the `foray` part. */
export function voiceLine(request: { voice: ActWriteRequest["voice"] }): string {
  const voice = request.voice;
  return (
    `Voice (decided once for the whole Foray — do not vary it): style: ${voice.style}; register: ${voice.register}; ` +
    `sentence rhythm: ${voice.sentenceRhythm}; narrator presence: ${voice.narratorPresence}`
  );
}

/** The shared claim rules, restated for an act: the documents are the
 * act's, a statement about a clip cites the clip's window, and the
 * purpose lines are now the beats' claims. F-97: the act's claims are ONE
 * source set — a seam may rest on what another seam selected or on a
 * clip's window without selecting anything of its own. */
export const ACT_CLAIM_RULES: readonly string[] = [
  `A quote must be copied character for character out of the document you name, and must be at least ${MIN_QUOTE_WORDS} words or one whole sentence.`,
  "Never quote a beat's claim, a clip's opening as printed in the layout, or this prompt: they are direction, not documents.",
  "A statement about a CLIP — what it is about, who is speaking, what was said in it — rests on that clip's transcript window (its docId is on the CLIP line).",
  "Select it as a claim with that docId and either a short phrase of the clip's own words as the quote or an empty quote (\"\"); the whole window is that source, so the word minimum does not apply to it.",
  "Never back a statement about a clip with an outside publication.",
  "A statement about the world beyond the clips rests on a print document, or on a VERIFIED PAGE of this Foray when one is listed: select the claim and copy the span. If no document supports a claim worth making, do not make it.",
  "THE ACT'S SOURCES ARE ONE SET. Every claim any seam selects, every clip's window and every verified page listed can support a statement in ANY seam: a bridge that restates what the clip before it established, or sets up the clip after it, rests on those windows and need not select a claim of its own. Select each claim ONCE, on the seam that first makes it; the verifier reads the whole act's sources.",
  "If the documents contradict or complicate a beat, write the tension: that carries the beat.",
  '"contested" means reputable sources actively disagree about the fact itself — not that you are unsure.',
  "Every quote is checked by machine against the document you name after you answer; a quote that is not found there is discarded together with the seam's script."
];

export const ACT_PROSE_RULES: readonly string[] = [
  "One voice, one story. The beats are the checklist the prose must carry, not its template: make each beat's point where it belongs, in your own words, joined to what comes before and after it. A beat may be carried in any seam, and by what a clip itself says.",
  "Never announce a beat, never list the beats, never say what the next clip is going to say.",
  /* Q-08, one definition for every prompt that writes spoken narration
     (`copy/narratorStructure.js`). This prompt says "act", "beat" and "seam"
     throughout because they are how the WORK is described to the model; the
     rule is what keeps them out of what the listener hears. */
  NARRATOR_STRUCTURE_RULE,
  "A seam that follows a clip may restate what that clip said once, in the act's own words — then move on.",
  "Introductions, by the weight given on the SEAM line:",
  "  full  — one or two sentences: who is speaking (name and role, as the tape or the episode title gives them) and on which show, and what to listen for. Write it from the clip's OPENING as printed on its CLIP line — what the listener is about to hear — never from the point the clip goes on to make. Do not repeat the clip's first sentences.",
  "The FIRST clip from a show says the show's name (Q-09) — its CLIP line says when that is: \"first clip from this show\". Say it however the sentence wants it; there is no formula, and the same sentence twice in one Foray is worse than not saying it at all. When the line says the show has already been introduced, do NOT name it again: refer back lightly (\"back with the same guest\", \"the engineer from earlier\") or say nothing about the show at all.",
  "  light — the same guest and show as the clip before: one clause at most, or nothing.",
  "  none  — the host introduces the guest in the clip itself: add nothing about who is speaking.",
  "A seam with no beats and a light or none introduction may return an empty script: the clips then run together.",
  "A beat marked SEED LOST was written from a stretch of tape this Foray does NOT play and no document was found for: carry it only as far as the act's sources go. Never attribute a specific incident, number or quotation to anyone that beat's claim names — say what the sources DO say, or turn the beat into a question and hand off.",
  "One CLIP can carry more than one beat: when its line says it carries several, the tape makes those points itself — introduce it once and do not narrate what it is about to say.",
  "Each seam's script MUST land inside the character band on its SEAM line. Longer is not better: narration is at most a quarter of the listening.",
  "List, per seam, the indices of the claims its script asserts (usedClaims).",
  "NEVER assert what the record does or does not contain — no \"nobody wrote it down\", \"there is no record of\", \"the file doesn't say\", \"we still don't know\" — unless a quote you selected says exactly that. Say what a source DOES say instead: not \"the plan nobody wrote down\" but \"the plan that lived in people's heads, as he tells it\"; not \"the report never explains why\" but \"the report names the drawing, and stops there\" (only if it does), or leave the point out.",
  "",
  "Copy rules, unchanged and non-negotiable:",
  "- Never say: fascinating, deep dive, delve, explores.",
  "- No vulgar or gratuitously edgy content; register is a well-read friend, not a shock jock.",
  "- Never speak a URL, a citation, or a number a listener cannot hold in their head while driving.",
  "- If a claim is marked contested, the script must say the point is disputed."
];

/** The fields every JSONL line must carry, read from the line schema
 * (seamStream.ts, GV-43) so the contract cannot fall behind it. */
const JSONL_LINE_FIELDS = (WRITTEN_SEAM_JSON_SCHEMA.required ?? []).join(", ");

/** The output contract, the last rules of `stable`. */
function outputContract(output: ActWriteOutput): string[] {
  if (output === "jsonl") {
    return [
      "Respond in JSONL: one seam object per line, in listening order, s0 first, nothing else on the line. No markdown fences, no array around the lines, no other text.",
      `Every line carries every one of these fields: ${JSONL_LINE_FIELDS} (an empty array when a seam has no claims, used claims or hints). Each line matches exactly:`,
      SEAM_SHAPE
    ];
  }
  return [JSON_ONLY, `{"seams": [${SEAM_SHAPE}]}`];
}

/** `stable` without the voice slot: one string per output contract, built once. */
const WRITE_STABLE: Record<ActWriteOutput, string> = {
  json: writeStable("json"),
  jsonl: writeStable("jsonl")
};

function writeStable(output: ActWriteOutput): string {
  return [
    `You are writing the narration of one act of an audio documentary ("Foray") — the whole act at once, as one voice telling one story.`,
    "",
    "HOW TO WRITE",
    ...ACT_PROSE_RULES,
    "",
    "CLAIMS AND QUOTES",
    ...ACT_CLAIM_RULES,
    "",
    "Also list any hard-to-pronounce or foreign words with a plain-English pronunciation hint.",
    "",
    ...outputContract(output)
  ].join("\n");
}

/**
 * Q-03: the act in one prompt — its seams and clips laid out in play
 * order, the beats under the seam that positions them, every document the
 * act may quote, and on a retry the previous scripts with the verifier's
 * notes — as [stable][foray][call] (see the module comment).
 */
export function actWritePromptParts(request: ActWriteRequest, options: ActWritePromptOptions = {}): PromptParts {
  const clips = new Map(request.clips.map((c) => [c.clipId, c]));
  return {
    stable: stableFor(options),
    foray: voiceLine(request),
    call: [
      `THE ACT YOU ARE WRITING: "${request.actTitle}"`,
      "",
      "THE ACT, IN PLAY ORDER. Narration and clips alternate. You write the narration; the clips are real tape and play as they are.",
      "A SEAM is one stretch of narration: it carries the beats listed under it, bridges from the clip before to the clip after, and — when it introduces a clip — opens the listener's ear to it.",
      "",
      /* GV-38: only when the driver sent a frame. */
      ...(request.frame ? actFrameBlock(request.frame) : []),
      actLayout(request.seams, clips),
      "",
      "DOCUMENTS — the only things you may quote:",
      documentsBlock(request.documents),
      ...(request.retryNote
        ? [
            "",
            `REJECTIONS SO FAR: ${request.retryNote}`,
            "Seams marked FROZEN are verified: return each one's script VERBATIM and select no claims for it. Seams marked EDIT carry their previous script and a `fix` line:",
            "EDIT only those, to answer their notes — add a missed beat where it belongs, drop or re-source an unsupported sentence, replace an assertion about the record with what a source says — and keep every sentence that was not objected to."
          ]
        : [])
    ].join("\n")
  };
}

/** `stable` for these options: the output contract's rules, then the voice
 * slot after a blank line when it is filled. Shared by the act prompt and
 * the seam-edit prompt, so both send the same first bytes. */
function stableFor(options: ActWritePromptOptions): string {
  const base = WRITE_STABLE[options.output ?? "json"];
  const voiceBlock = options.voiceBlock ?? "";
  return voiceBlock.length > 0 ? `${base}\n\n${voiceBlock}` : base;
}

/** The DOCUMENTS section's body: one block per document, in the order given. */
function documentsBlock(documents: ActWriteRequest["documents"]): string {
  return documents
    .map(
      (doc) =>
        `--- docId: ${doc.docId} | ${doc.title}${doc.url ? ` | ${doc.url}` : ""}${doc.kind === "tape" ? " | TRANSCRIPT WINDOW of a clip (cite it for statements about that clip)" : doc.kind === "page" ? " | a VERIFIED PAGE of this same Foray, from an earlier act — quote one of its whole sentences" : ""}\n${doc.text}`
    )
    .join("\n\n");
}

/**
 * GV-84 (docs/roadmap/generation-v2.md, W4-19; covers R2-08, GP-05, GP-02):
 * THE SEAM EDIT of the timed round policy (GV-80's `editSeams`), as
 * [stable][foray][call].
 *
 *   stable  BYTE-IDENTICAL to `actWritePromptParts`'s for the same options
 *           (`stableFor`), so an edit round reads the 9-11k-token writer
 *           rules from the prefix cache the act's first call filled. The
 *           streamed Chat writer sends the 'jsonl' contract, so its edit
 *           reply is JSONL too: one line per edited seam.
 *   foray   the voice line, as on every act call.
 *   call    a short act part: the act's title, the frame (when the driver
 *           sent one), ONLY the seams being edited (each with its band, its
 *           beats, its previous script and its `fix` line) in play order
 *           between the read-only seams beside them, the clips they follow
 *           or introduce, the documents they cite, the act's rejections, and
 *           which seams to return. A frozen seam is never in the request
 *           (GV-80), so no FROZEN line is printed.
 *
 * Nothing on the default path calls it: only ChatNarrationWriterBuilder's
 * editSeams does, and writeAct.ts asks for an edit only on the timed round
 * policy (FORAY_ROUND_POLICY=timed or the fast-path umbrella).
 */
export function seamEditPromptParts(request: SeamEditRequest, options: ActWritePromptOptions = {}): PromptParts {
  const ids = request.seams.map((s) => s.seamId);
  return {
    stable: stableFor(options),
    foray: voiceLine(request),
    call: [
      `THE ACT YOU ARE EDITING: "${request.actTitle}"`,
      "",
      "A SEAM EDIT. The act is already written. Only the seams marked EDIT below need work; each is shown in play order with the seam on either side of it as the listener hears it (READ-ONLY: context, so an edited seam still joins its neighbours) and the clips it touches.",
      "A SEAM is one stretch of narration: it carries the beats listed under it, bridges from the clip before to the clip after, and — when it introduces a clip — opens the listener's ear to it.",
      "",
      /* GV-38: only when the driver sent a frame. */
      ...(request.frame ? actFrameBlock(request.frame) : []),
      editLayout(request),
      "",
      "DOCUMENTS — the only things you may quote:",
      documentsBlock(request.documents),
      "",
      `REJECTIONS SO FAR: ${request.retryNote}`,
      "Seams marked EDIT carry their previous script and a `fix` line: edit each one to answer its notes — add a missed beat where it belongs, drop or re-source an unsupported sentence, replace an assertion about the record with what a source says — and keep every sentence that was not objected to.",
      `Return a seam for each seam marked EDIT (${ids.join(", ")}) and for no other: a READ-ONLY seam is not yours to return.`
    ].join("\n")
  };
}

/** The `s<n>` position of a seam id, for play order; an id of any other
 * shape sorts after the rest, in the order it came. */
function seamOrdinal(seamId: string): number {
  const match = /^s(\d+)$/.exec(seamId);
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

/** The seam edit's layout: the edited seams and their read-only neighbours
 * in play order, each clip printed once, where it plays -- an introduced
 * clip after the seam that introduces it (as `actLayout` prints it), and a
 * followed clip that no edited seam introduces just before the seam that
 * follows it. */
function editLayout(request: SeamEditRequest): string {
  const clips = new Map(request.clips.map((c) => [c.clipId, c]));
  type Entry = { at: number; order: number; seam?: SeamBrief; neighbour?: SeamNeighbour };
  const entries: Entry[] = [
    ...request.seams.map((seam, i): Entry => ({ at: seamOrdinal(seam.seamId), order: i, seam })),
    ...request.neighbours.map((neighbour, i): Entry => ({ at: seamOrdinal(neighbour.seamId), order: request.seams.length + i, neighbour }))
  ].sort((a, b) => (a.at === b.at ? a.order - b.order : a.at < b.at ? -1 : 1));
  const introduced = new Set(request.seams.map((s) => s.introduces).filter((id): id is string => id !== undefined));
  const printed = new Set<string>();
  const lines: string[] = [];
  for (const entry of entries) {
    if (entry.neighbour) {
      const { seamId, script } = entry.neighbour;
      lines.push(
        script.length > 0
          ? `SEAM ${seamId} — READ-ONLY, as the listener hears it: ${JSON.stringify(script)}`
          : `SEAM ${seamId} — READ-ONLY, silent: the clips run together here`
      );
      continue;
    }
    const seam = entry.seam!;
    const follows = seam.follows ? clips.get(seam.follows) : undefined;
    if (follows && !introduced.has(follows.clipId) && !printed.has(follows.clipId)) {
      printed.add(follows.clipId);
      lines.push(...clipLines(follows));
    }
    lines.push(...seamLines(seam, clips));
  }
  return lines.join("\n");
}

/** The legacy single-string writer prompt (the Anthropic writer sends it):
 * the three parts joined, the 'json' contract, the voice slot empty. */
export function buildActWritePrompt(request: ActWriteRequest): string {
  return joinParts(actWritePromptParts(request));
}

/**
 * GV-38 (W4-08, QK-26): the ACT FRAME — what the listener has just heard
 * before the first seam, and where the act must leave them — so the writer
 * writes this act to follow the one before rather than in isolation. Every
 * quoted line is already written and plays as it is; the rules keep the
 * writer from repeating it (which also keeps its unverified claims, QK-24,
 * from spreading). Ends with a blank line, before the layout.
 */
export function actFrameBlock(frame: ActFrame): string[] {
  return [
    `ACT FRAME — this is act ${frame.actIndex + 1} of ${frame.totalActs}. The lines quoted here are already written and play around your seams as they are; they are not yours to write.`,
    "WHAT THE LISTENER HAS JUST HEARD, in order:",
    ...(frame.forayOverview !== undefined ? [`  the Foray's overview: ${JSON.stringify(frame.forayOverview)}`] : []),
    ...(frame.previousActExit !== undefined ? [`  the previous act's exit: ${JSON.stringify(frame.previousActExit)}`] : []),
    `  this act's introduction: ${JSON.stringify(frame.actIntroduction)}`,
    `  entering this act, the listener believes: ${frame.startState}`,
    "WHERE THE ACT MUST LEAVE THEM:",
    `  leaving this act, the listener should believe: ${frame.endState}`,
    `  the act's exit, which plays right after your last seam: ${JSON.stringify(frame.actExit)}`,
    "FRAME RULES:",
    "- Do not repeat the introduction or the exit, or restate what they say.",
    "- The first seam follows the introduction: pick up where it leaves off, without opening the act again.",
    "- The last seam hands into the exit: end where the exit can take over.",
    ...(frame.previousActExit !== undefined ? ["- Do not re-introduce what the previous act established; the listener has just heard it."] : []),
    ""
  ];
}

function actLayout(seams: SeamBrief[], clips: Map<string, ClipBrief>): string {
  return seams.flatMap((seam) => seamLines(seam, clips)).join("\n");
}

/** One seam's lines of the layout: its SEAM line, its beats, its previous
 * script, and the CLIP it introduces. */
function seamLines(seam: SeamBrief, clips: Map<string, ClipBrief>): string[] {
  const lines: string[] = [];
  const edges: string[] = [];
  if (seam.follows) edges.push(`follows CLIP ${seam.follows}`);
  if (seam.introduces) edges.push(`introduces CLIP ${seam.introduces} (introduction: ${seam.intro ?? "full"})`);
  lines.push(`SEAM ${seam.seamId} — ${seam.band[0]}-${seam.band[1]} characters${edges.length > 0 ? ` — ${edges.join(", ")}` : ""}${seam.frozen ? " — FROZEN" : seam.previousScript !== undefined ? " — EDIT" : ""}`);
  if (seam.beats.length === 0) lines.push("  carries no beat — the introduction only, or nothing");
  for (const beat of seam.beats) {
    lines.push(`  carries beat ${beat.beatId}${beat.kind === "argument" ? " (an argument — what it means)" : ""}: ${beat.claim}`);
    /* F-99: the seed behind this claim is not in the Foray. Said on the
       beat's own line, in the imperative, because the general rule above
       is not what a writer reads when it is looking at one claim. */
    if (beat.seedLost) {
      lines.push(
        `    SEED LOST — beat ${beat.beatId}'s tape was not available: do not attribute specifics to anyone this claim names; say only what the act's sources say, or hand off.`
      );
    }
  }
  if (seam.frozen && seam.previousScript !== undefined) {
    lines.push(`  FROZEN — verified; return this script verbatim, with no claims: ${JSON.stringify(seam.previousScript)}`);
  } else if (seam.previousScript !== undefined) {
    lines.push(`  previous script: ${JSON.stringify(seam.previousScript)}`);
    if (seam.notes) lines.push(`  fix: ${seam.notes}`);
  }
  if (seam.introduces) {
    const clip = clips.get(seam.introduces);
    if (clip) lines.push(...clipLines(clip));
  }
  return lines;
}

/** A clip's lines of the layout: its CLIP line, the beats it carries when
 * there are several, and its opening. */
function clipLines(clip: ClipBrief): string[] {
  const lines: string[] = [];
  /* F-99: a clip §4.5 merged two beats into is ONE clip carrying
     both — it plays once, so it is introduced once and the tape
     makes both points itself. Named on the line only when there is
     more than one: a clip carrying its own beat alone is the
     ordinary case and says nothing new. */
  const carried = clip.carries ?? [];
  lines.push(
    `CLIP ${clip.clipId} — "${clip.title}" on ${clip.show || "an unnamed show"}, ${Math.round(clip.durationSec)} s of tape` +
      (clip.docId ? ` (document ${clip.docId})` : " (no transcript window is held)") +
      (carried.length > 1 ? ` — carries beats ${carried.map((b) => b.beatId).join(", ")}` : "") +
      /* Q-09: said on the CLIP line, in the imperative, because the
         general rule above is not what a writer reads when it is
         looking at one clip. */
      (clip.show
        ? clip.showFirstHeard === false
          ? ` — ${clip.show} has already been introduced in this Foray: do not name it again`
          : " — FIRST CLIP FROM THIS SHOW: say its name"
        : "")
  );
  if (carried.length > 1) for (const beat of carried) lines.push(`  it carries beat ${beat.beatId}: ${beat.claim}`);
  lines.push(clip.opening ? `  it opens: ${JSON.stringify(clip.opening)}` : "  its opening is not held — introduce it from the show and episode only");
  return lines;
}
