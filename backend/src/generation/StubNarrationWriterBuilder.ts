import * as crypto from "crypto";
import { defaultBudgetGuard, type BudgetGuard } from "../cost/budgetGuard";
import { MIN_QUOTE_WORDS, quoteEchoesPurpose } from "../types/narration";
import type { EvidenceDoc } from "./gatherEvidence";
import type {
  ActWriteRequest,
  ActWriteResult,
  ClipBrief,
  NarrationBuildContext,
  NarrationWriterBuilder,
  SeamBrief,
  SelectedClaim,
  WrittenSeam
} from "./NarrationWriterBuilder";

/**
 * Deterministic fake narration writer, used whenever ANTHROPIC_API_KEY is
 * absent (env.anthropicDryRun) — same role as StubSpineBuilder /
 * StubDeepenActBuilder: zero API keys, zero network calls, reproducible
 * fixtures that land INSIDE the requested mode's character band (§0).
 *
 * IT QUOTES OUT OF THE EVIDENCE PACK, and that is the whole point of the
 * WS-A version of this class. A stub that made its quotes up would leave
 * `--dry-run` exercising a strictly easier path than production: every
 * mechanical rule in `writeNarration.ts` (the quote is a span of a held
 * document; the publication is that document's title; the span is long
 * enough; it is not the beat purpose read back) would be dead code until
 * a key was configured. Here the span is COPIED out of the document the
 * gatherer supplied — in a dry-run that is `StubExternalResearcher`'s
 * fixture passage — so the substring check runs for real and a
 * dry-run candidate is structurally identical to a live one.
 *
 * A fixture generator, not a content-quality stand-in — the real
 * provider (AnthropicNarrationWriterBuilder) does the actual prose
 * judgement §4.7 asks for.
 *
 * ONE METHOD SINCE F-100. This class used to fake the three per-page
 * calls as well (`selectClaims`, `writePages`, `selectAndWrite`), which is
 * what made `--dry-run` exercise the per-page path. Q-03 moved production
 * and `--dry-run` alike onto `writeAct`, so those three fixtures only ever
 * ran for a test that asked for them; they are deleted with the path.
 */
export class StubNarrationWriterBuilder implements NarrationWriterBuilder {
  readonly providerName = "stub";

  constructor(private readonly budgetGuard: BudgetGuard = defaultBudgetGuard) {}

  /**
   * Q-03: the per-act contract, so `--dry-run` writes per act exactly as
   * production does. One script per seam: an introduction to the clip it
   * leads into, weighted as the orchestrator decided (Q-02 — a question
   * and a listener imperative naming the show, so it asserts nothing and
   * cites nothing, and a same-episode follow-on is one clause), then one
   * sentence per beat the seam carries, each backed by a span COPIED out
   * of a held document, padded to the seam's band. A seam with no beats
   * and no introduction to make returns an empty script — no page there.
   */
  async writeAct(request: ActWriteRequest, ctx: NarrationBuildContext): Promise<ActWriteResult> {
    await this.budgetGuard.checkAndRecord({
      userId: ctx.userId,
      operation: "narration_write_act",
      provider: this.providerName,
      estimatedUsd: 0,
      dryRun: true,
      sessionId: ctx.sessionId
    });
    const clips = new Map(request.clips.map((c) => [c.clipId, c]));
    return { seams: request.seams.map((seam) => stubSeam(seam, clips, request.documents, request.voice.register)) };
  }
}

/** Exported for the act tests: the deterministic seam the stub writes,
 * so a test can mutate one sentence of it (drop a beat, repeat the clip's
 * opening) and watch the gate or the verifier go red. */
export function stubSeam(seam: SeamBrief, clips: Map<string, ClipBrief>, documents: EvidenceDoc[], register: string): WrittenSeam {
  /* F-97: a frozen seam comes back verbatim, as the real writer is told
     to return it — the orchestrator keeps the confirmed text either way. */
  if (seam.frozen && seam.previousScript !== undefined) {
    return { seamId: seam.seamId, script: seam.previousScript, claims: [], usedClaims: [], pronunciationHints: [] };
  }
  const clip = seam.introduces ? clips.get(seam.introduces) : undefined;
  const [min, max] = seam.band;
  const sentences: string[] = [];
  const claims: SelectedClaim[] = [];
  if (clip && clip.intro === "full") {
    /* F-81's shape, on the act path: the introduction cites the clip's
       own window (a tape source, no quote) when the pipeline holds it;
       with no window held it asserts nothing — a question and a listener
       imperative that still name the show and episode. */
    if (clip.docId) {
      claims.push({ claimText: `the clip that follows is from ${clip.show || "the show"}: "${clip.title}"`, quote: "", docId: clip.docId, contested: false });
      sentences.push(`Next, from ${clip.show || "the show"}, "${clip.title}". Listen for who is doing the talking.`);
    } else {
      sentences.push(`Who speaks next, and where? Listen for ${clip.show || "the show"}, and for "${clip.title}".`);
    }
  } else if (clip && clip.intro === "light") {
    sentences.push(`Stay with ${clip.show || "the same voice"}.`);
  }
  const purposeText = seam.beats.map((b) => b.claim).join(" ");
  for (const beat of seam.beats) {
    /* Print first, quoted (a span copied out of the document, F-14/F-27);
       failing that, the first transcript window the act holds, cited as a
       whole with no echoed quote — F-81/F-82's shape for a beat whose
       claim is what the tape beside it says, which is what the run-6
       claims were (the window's every span echoes the purpose, so no
       quote of it is legal, and none is needed). */
    const print = documents.filter((doc) => doc.kind !== "tape").map((doc) => ({ doc, quote: firstLegalSpan(doc.text, purposeText) })).find((x) => x.quote !== null);
    const window = documents.find((doc) => doc.kind === "tape");
    if (print) claims.push({ claimText: beat.claim, quote: print.quote!, docId: print.doc.docId, contested: false });
    else if (window) claims.push({ claimText: beat.claim, quote: "", docId: window.docId, contested: false });
    else continue;
    sentences.push(`In the voice of a ${register.toLowerCase()}, this stretch carries the idea that ${lowerFirst(beat.claim)}.`);
  }
  if (sentences.length === 0) return { seamId: seam.seamId, script: "", claims: [], usedClaims: [], pronunciationHints: [] };
  const seed = sentences.join(" ");
  const script = padToBand(seed, min, max, Math.min(max, Math.max(min, seed.length)), seam.beats.length === 0 ? "Intro" : "seam", claims.length === 0 ? CLAIM_FREE_FILLERS : FILLERS);
  return {
    seamId: seam.seamId,
    script,
    claims,
    usedClaims: claims.map((_, i) => i),
    pronunciationHints: seam.beats.flatMap((b) => hardWordsIn(b.claim).map((word) => ({ word, hint: `Say "${word}" as spelled — no override configured (stub fixture).` })))
  };
}

/**
 * Copies a span out of a document. Legal means: at least
 * `MIN_QUOTE_WORDS` words long, and sharing no run with the beats'
 * claims — a stub that quoted the purpose back would reproduce F-46 in the
 * dry-run path and be rejected by the same rule the live writer is.
 * Deterministic: always the first legal window, never a sampled one.
 *
 * The first window of `MIN_QUOTE_WORDS` words that is not an echo of the
 * purpose, or `null` when the document has none. */
export function firstLegalSpan(text: string, purposeText: string): string | null {
  const words = String(text ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length < MIN_QUOTE_WORDS) return null;
  for (let i = 0; i + MIN_QUOTE_WORDS <= words.length; i++) {
    const span = words.slice(i, i + MIN_QUOTE_WORDS).join(" ");
    if (!quoteEchoesPurpose(span, purposeText)) return span;
  }
  return null;
}

function lowerFirst(s: string): string {
  return s.length === 0 ? s : s[0]!.toLowerCase() + s.slice(1);
}

/* Ordinary padding: declarative, but never a banned word, never a
   digit, never a URL/citation token, and never a claim about what the
   record does or does not contain (F-45). */
const FILLERS = [
  "That thread runs further than most listeners expect.",
  "It is worth sitting with before moving on.",
  "The popular version of this is tidier than what happened.",
  "Nothing about that was inevitable at the time.",
  "The people closest to it saw it differently.",
  "That detail is easy to miss and easy to underrate."
];

/* Padding for the zero-source page, and the reason this list exists at
   all: a page with no sources may contain no declarative sentence
   (F-36/F-37/F-44, enforced by `hasDeclarativeSentence`), so padding it
   with the ordinary fillers above would make the stub fail its own
   validator. Questions and listener-directed imperatives only. */
const CLAIM_FREE_FILLERS = [
  "Listen for who is doing the talking.",
  "Notice what is being taken for granted.",
  "Keep that question open a little longer.",
  "What would count as an answer here?",
  "Consider what the next few minutes have to establish.",
  "Watch for the moment the story turns."
];

/** Repeats a deterministic filler clause (never a banned word, never a
 * digit, never a URL/citation token, and never a claim about what the
 * record does or does not contain — F-45) until the script sits inside
 * [min, max] characters, then trims to `target` if it overshot on the
 * final repeat. Reproducible per-request via a seeded PRNG-free hash of
 * the claim text, not randomness — a stub must be reproducible across
 * runs (`AnthropicNarrationWriterBuilder`'s doc comment on this same
 * discipline). */
function padToBand(seed: string, min: number, max: number, target: number, mode: string, fillers: string[]): string {
  let out = seed.trim();
  if (!out.endsWith(".")) out += ".";
  let i = hashToInt(`${seed}::${mode}`) % fillers.length;
  while (out.length < min) {
    out += ` ${fillers[i % fillers.length]}`;
    i += 1;
  }
  if (out.length > max) {
    // Trim on a sentence boundary at or before `target`/`max`, never
    // mid-word — a script a listener will hear must end on a real
    // sentence, not a truncated clause.
    const cutoff = Math.min(max, Math.max(target, min));
    const truncated = out.slice(0, cutoff);
    const lastPeriod = truncated.lastIndexOf(".");
    out = lastPeriod > min ? truncated.slice(0, lastPeriod + 1) : truncated;
  }
  return out;
}

function hashToInt(input: string): number {
  const digest = crypto.createHash("sha1").update(input).digest();
  return digest.readUInt32BE(0);
}

/** Very small heuristic for "words worth a pronunciation hint": long,
 * capitalized (proper-noun-shaped) tokens, since the stub has no real
 * hard/foreign-word detector — the real provider is expected to use
 * editorial judgement here, not a heuristic. Kept intentionally simple:
 * this stage only needs the FIELD to exist (§4.7's "carry the hint field
 * in the data shape... even though nothing consumes it yet"), not a
 * correct pronunciation system. */
function hardWordsIn(claim: string): string[] {
  const words = claim.match(/[A-Za-z][A-Za-z'-]{6,}/g) ?? [];
  const capitalized = words.filter((w) => /^[A-Z]/.test(w) && w.toLowerCase() !== w);
  return [...new Set(capitalized)].slice(0, 2);
}
