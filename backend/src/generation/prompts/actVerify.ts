import type { ActSourceBrief, ActVerifyRequest, VerifyClipBrief } from "../NarrationVerifierBuilder";
import { joinParts, type PromptParts } from "../promptLayout";

/**
 * §4.7's per-act verification prompt (Q-03), moved here from
 * AnthropicNarrationVerifierBuilder.ts by GV-50 (docs/roadmap/generation-v2.md,
 * #1286; W2-14's split, covers R1-10, GP-05). Decision 8: prompt text moves
 * once, into prompts/*.ts; the Anthropic verifier and its Chat twin both
 * import it.
 *
 * Layout (promptLayout.ts, the GV-32 [stable][foray][call] parts):
 *   stable  the role line (no act title), the two sets of questions, the
 *           "do not check whether a quote exists" line and the reply shape.
 *           The same bytes for every act, round and Foray.
 *   foray   empty: nothing in the verifier's prompt is per-Foray.
 *   call    the act's title, the checklist, the act's sources, the act in
 *           play order with every clip's whole transcript window (R2-12's
 *           evidence lives here), which seams to judge, and the documents.
 *
 * The rewrites (every other line is the pre-GV-50 line, reordered so the
 * questions come first):
 *   - the role line named the act; it now says "one act of ...", and the
 *     title is on the THE ACT YOU ARE VERIFYING line that opens the call part;
 *   - question 2 listed the seam ids to judge inside the rules; it now points
 *     at the SEAMS TO JUDGE line, which carries them in the call part;
 *   - question 2 said "SOME act source above"; the sources now follow the
 *     questions, so it says "below".
 */

const VERIFY_STABLE = [
  `You are the FACT-VERIFICATION pass for the narration of one act of an audio documentary ("Foray"). You did NOT write it.`,
  "",
  "Answer two sets of questions.",
  "1. For each BEAT on the checklist: carried — does the act's narration (any seam, frozen ones included, not only the one the beat was positioned in)",
  "   or one of its clips make the beat's point, resting on an act source (a selected claim, a clip's window, a verified page)? A beat is carried when",
  "   a listener would hear its point made, in whatever words. It is NOT carried when no seam or clip makes the point, or a seam makes it and nothing",
  "   in the act's sources supports it. When carried, say by which seam or clip (carriedBy: \"s1\" or \"c0\") and on which sources it rests (restsOn).",
  "   When not carried, say in notes which seam it belongs in and what is missing, in one sentence a writer can act on.",
  "2. For each SEAM to judge (named on the SEAMS TO JUDGE line below; the FROZEN seams are confirmed already — do not answer for them):",
  "   claimsSupported — does every statement the script makes about the world follow from SOME act source below — this seam's selected claims,",
  "   another seam's, any clip's transcript window, any verified page? A bridge that restates what the clip before it established, or sets up",
  "   the clip after it, is supported by those windows. Judge a statement about a clip against that clip's window as printed on its CLIP line.",
  "   Then list in restsOn the ids of the sources the seam's statements actually rest on — required whenever claimsSupported is true and the",
  "   script states anything; a seam that only asks a question or hands off to the listener rests on nothing and lists none.",
  "   When a statement is NOT supported, QUOTE the sentence in notes, and say what no source covers.",
  "   EXEMPT from this question: the sentences that introduce a clip — who is speaking, the show, the episode — which are checked by",
  "   structure against the segment's source row before you are called. Do not fail a seam for them.",
  "   contestedHandled — read the sources: if reputable sources actively disagree about something the script asserts, the script must",
  "   say the point is disputed, in any natural wording. If nothing is genuinely contested, this is true.",
  "",
  "Do NOT check whether a quote exists in its source — that was already proven mechanically before you were called.",
  "",
  "Respond with ONLY a single JSON object, no markdown fences, no other text, matching exactly:",
  '{"beats": [{"beatId": string, "carried": boolean, "carriedBy": string (the seam or clip id, when carried), "restsOn": string[] (source ids, when carried), "notes": string (required and specific whenever carried is false)}], ' +
    '"seams": [{"seamId": string, "claimsSupported": boolean, "restsOn": string[], "contestedHandled": boolean, "notes": string (required whenever an answer is false; quote the unsupported sentence)}]}'
].join("\n");

/**
 * Q-03: the per-act verification prompt. The beats are the CHECKLIST;
 * the act's seams and clips are laid out in play order with every clip's
 * transcript window; the answer is one verdict per beat (carried, by
 * which seam or clip, resting on which act sources, or a note naming what
 * is missing and where it belongs) and one per seam (the two page
 * questions that survive — support and contested; purpose is now the
 * per-beat question — plus what the seam rests on).
 *
 * F-97: SUPPORT IS ACT-SCOPED. The act's sources are printed ONCE, as one
 * numbered set — every claim any seam selected, every clip's window, every
 * verified page of an earlier act — and a seam's statements may rest on
 * any of them. The verifier is told so in as many words, because run 9's
 * prompt said "the source attached to it" and refused every bridge.
 * Seams marked frozen were confirmed in an earlier round: context only.
 * Introductions are exempt from the support question: who is speaking,
 * the show and the episode are checked structurally against the segment
 * source row before this is called (Q-02).
 */
export function actVerifyPromptParts(request: ActVerifyRequest): PromptParts {
  const clips = new Map(request.clips.map((c) => [c.clipId, c]));
  const judged = request.seams.filter((s) => !s.frozen).map((s) => s.seamId);
  return {
    stable: VERIFY_STABLE,
    foray: "",
    call: [
      `THE ACT YOU ARE VERIFYING: "${request.actTitle}"`,
      "",
      "THE CHECKLIST — the beats to judge this round (each must be carried somewhere in the act):",
      ...(request.beats.length > 0
        ? request.beats.flatMap((b) =>
            /* F-99: a beat whose seed tape is not in this Foray. Judged on
               what the act's sources CAN carry: demanding the seed's
               specifics is demanding something no seam could ever have
               written, which is how six of run 9's eight unverified pages
               came to be. */
            b.seedLost
              ? [
                  `  ${b.beatId}: ${b.claim}`,
                  `    SEED LOST — the tape this claim was written from is NOT in this act and nothing was retrieved for it. Judge it carried when the prose makes as much of its point as the act's sources support; do NOT demand the names, numbers or incidents that only the missing tape could supply. If the act's sources do not reach the point at all, say exactly that in notes.`
                ]
              : [`  ${b.beatId}: ${b.claim}`]
          )
        : ["  (none — every beat is already confirmed)"]),
      "",
      "THE ACT'S SOURCES — one set for the whole act. Any statement in any seam may rest on any of these, not only the ones the seam selected:",
      ...request.sources.map(actSourceEntry),
      "",
      "THE ACT, IN PLAY ORDER — narration seams and the clips of real tape between them:",
      actVerifyLayout(request, clips),
      "",
      `SEAMS TO JUDGE: ${judged.join(", ") || "none"}`,
      "",
      "DOCUMENTS the claims quote:",
      request.documents.filter((d) => d.kind !== "tape").map((d) => `  --- ${d.title}${d.url ? ` | ${d.url}` : ""}\n${d.text}`).join("\n") || "  (none — every source is a clip's window)"
    ].join("\n")
  };
}

/** The legacy single-string verification prompt (the Anthropic verifier sends it). */
export function buildActVerifyPrompt(request: ActVerifyRequest): string {
  return joinParts(actVerifyPromptParts(request));
}

function actSourceEntry(s: ActSourceBrief): string {
  const contested = s.contested ? " [marked contested]" : "";
  if (s.kind === "clip") return `  ${s.id}: the transcript window of CLIP ${s.docId === s.id ? s.id : s.id} — ${s.claimText} (printed under the clip below)`;
  if (s.kind === "page") return `  ${s.id}: a VERIFIED PAGE of this Foray from an earlier act — "${s.claimText}" (${s.publication})`;
  const from = s.selectedBy ? ` (selected by seam ${s.selectedBy})` : "";
  if (s.publication.startsWith("This Foray, page")) return `  ${s.id}${from}: claim="${s.claimText}" quote="${s.quote ?? ""}" from a verified page — ${s.publication}${contested}`;
  if (s.docId.startsWith("tape:")) return `  ${s.id}${from} [TAPE]: claim="${s.claimText}"${s.quote ? ` echoes="${s.quote}"` : ""} — judge against the window of the clip it names (${s.publication})${contested}`;
  return `  ${s.id}${from}: claim="${s.claimText}" quote="${s.quote ?? ""}" publication="${s.publication}"${contested}`;
}

function actVerifyLayout(request: ActVerifyRequest, clips: Map<string, VerifyClipBrief>): string {
  const lines: string[] = [];
  for (const seam of request.seams) {
    const edges: string[] = [];
    if (seam.follows) edges.push(`follows CLIP ${seam.follows}`);
    if (seam.introduces) edges.push(`introduces CLIP ${seam.introduces} (introduction: ${seam.intro ?? "full"})`);
    lines.push(
      `SEAM ${seam.seamId}${seam.frozen ? " — FROZEN (confirmed in an earlier round; context only)" : ""}${seam.carries.length > 0 ? ` — positioned beats ${seam.carries.join(", ")}` : " — no beat positioned here"}${edges.length > 0 ? ` — ${edges.join(", ")}` : ""}`
    );
    lines.push(`  Script:\n${seam.script}`);
    lines.push(`  Selected sources: ${seam.selected.length > 0 ? seam.selected.join(", ") : "(none — it may rest on the act's other sources)"}`);
    if (seam.introduces) {
      const clip = clips.get(seam.introduces);
      if (clip) {
        /* F-99: one clip may carry two beats (§4.5 merged the second
           beat's window into it). It plays once and there is one window:
           judge both beats against it. */
        const carried = clip.carries ?? [];
        lines.push(
          `CLIP ${clip.clipId} — "${clip.title}" on ${clip.show || "an unnamed show"}, ${Math.round(clip.durationSec)} s of tape${clip.docId ? ` (${clip.docId})` : ""}` +
            (carried.length > 1 ? ` — carries beats ${carried.map((b) => b.beatId).join(", ")}, judged against this one window` : "")
        );
        if (carried.length > 1) for (const beat of carried) lines.push(`  it carries beat ${beat.beatId}: ${beat.claim}`);
        lines.push(`  Transcript window:\n${clip.windowText || "    (the window is not held — treat any statement about this clip as unsupported)"}`);
      }
    }
  }
  return lines.join("\n");
}
