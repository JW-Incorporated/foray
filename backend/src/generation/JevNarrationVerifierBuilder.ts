import { splitSpokenSentences } from "../copy/spokenLine";
import { defaultBudgetGuard, type BudgetGuard } from "../cost/budgetGuard";
import { containsContestedLanguage, isStatementSentence } from "../types/narration";
import { introNamesSource } from "./actSeams";
import { readGateConfig, judgeThreshold, type GateConfig } from "./gateConfig";
import { DEFAULT_JEV_POOL_SIZE, createJevPool, meteredJevClient } from "./jevClient";
import type { JevChoiceQuestion, JevClient, JevResult, JudgeId } from "./jevTypes";
import type {
  ActSourceBrief,
  ActVerifyRequest,
  ActVerifyResult,
  BeatVerdict,
  NarrationBuildContext,
  NarrationVerifierBuilder,
  SeamVerdict,
  SentenceVerdict,
  VerifySeamBrief
} from "./NarrationVerifierBuilder";
import {
  JevSentenceSupportJudge,
  candidateSourcesFor,
  isSupportUnavailable,
  passageAround,
  type SentenceSupportItem,
  type SentenceSupportJudge,
  type SentenceSupportVerdict,
  type SupportSource
} from "./sentenceSupport";
import { unsupportedSpecifics } from "./specifics";

/**
 * GV-51 (docs/roadmap/generation-v2.md, from W5-09; covers R1-07, R2-09,
 * MQ-02, MQ-11, GP-26): the act verifier as parallel Jev questions instead of
 * one whole-act model call (TM-03/TM-04: about 14 s of decode a round, up to
 * three rounds). Selected with FORAY_STAGE_VERIFIER=jev (or jev:<lane>, Jev
 * with the Qwen judge on <lane> as its fallback) through the routing table;
 * the default route is unchanged, so no run reaches this class unless that
 * variable says so.
 *
 * verifyAct asks two kinds of question AT ONCE (one Promise.all over one
 * pool of at most 8 asks in flight):
 *
 *   (a) PER OPEN BEAT, ONE CHOICE. The options are every statement sentence
 *       of every scripted seam ('s1.0': seam s1, sentence 0), every clip
 *       whose window is held ('c0', the passage of its window around the
 *       claim, at most 4,000 characters) and 'none'. Options over 40,000
 *       characters (or 254 options) are split into several asks; the best
 *       non-'none' top option across them is kept. The beat is carried when
 *       that option's probability reaches the answering judge's
 *       supportMinP threshold (gateConfig.ts, per judge since GV-47).
 *   (b) PER SENTENCE OF EACH NON-FROZEN SEAM (splitSpokenSentences). A
 *       question, a listener imperative and an Intro sentence (one that
 *       names the clip the seam introduces: introNamesSource, the code check
 *       W5-15 also makes) are 'exempt'. Each statement goes to GV-27's
 *       support judge against its own candidate sources (candidateSourcesFor
 *       over the act's sources resolved to text, the seam's selected claims
 *       always included), and GV-34's unsupportedSpecifics runs on the same
 *       texts: a number, year or name no candidate carries makes the
 *       sentence 'unsupported' whatever the judge said. A judge that could
 *       not answer makes it 'unknown'.
 *
 * The seam's verdict follows from its sentences: claimsSupported when no
 * statement is unsupported or unknown; restsOn the union of the sources the
 * judge chose; notes QUOTE each failing sentence (the shape writeAct's
 * roundNotes already forwards to the writer).
 *
 * CONTESTED HANDLING IS DECIDED IN CODE, NOT ASKED (a change from the
 * model verifiers, recorded here as the card asks): contestedHandled is
 * the stub's rule (StubNarrationVerifierBuilder actVerdictFor): true when
 * none of the sources the seam rests on is marked contested, or the script
 * uses contested language (narration.ts containsContestedLanguage). The
 * F-41-era question "is a genuinely contested point handled" is no longer
 * put to a model on this route.
 *
 * Metering is meteredJevClient's (GV-20): every ask is charged to the
 * BudgetGuard before it is sent, under the run's user and session. The
 * threshold comes from the gate config the factory hands in; this class
 * never reads process.env.
 */

/** The CallRecord and cost-event labels of the two kinds of ask. */
export const VERIFY_BEAT_PURPOSE = "verify-beat";
export const VERIFY_SENTENCE_PURPOSE = "verify-sentence";
/** The beat choice's 'no option carries it' key. */
export const BEAT_NONE = "none";
/** Characters of a clip window offered as one beat option. */
export const BEAT_CLIP_PASSAGE_CHARS = 4000;
/** Characters of option text in one beat ask before it is split. */
export const BEAT_OPTIONS_MAX_CHARS = 40_000;
/** Options in one beat ask beside 'none' (Jev takes at most 255). */
export const BEAT_OPTIONS_MAX_COUNT = 254;

export const BEAT_CARRIED_INSTRUCTIONS =
  "Choose the one option in `options` that says what `claim` says: a sentence of the narration, or a passage of a clip. Read each option literally. Choose none when no option carries the claim.";

/* ------------------------------------------------------------------------ */
/* Sentences                                                                 */
/* ------------------------------------------------------------------------ */

/** One sentence of a seam as the verifier reads it. */
export interface SeamSentence {
  seamId: string;
  index: number;
  text: string;
  kind: SentenceVerdict["kind"];
}

/** The option id (and support item id) of a seam's sentence. */
export function sentenceId(seamId: string, index: number): string {
  return `${seamId}.${index}`;
}

/**
 * The seam's spoken sentences (splitSpokenSentences), each classified: a
 * question ('?'), an Intro sentence (introNamesSource holds for the clip the
 * seam introduces), a statement (isStatementSentence), else an imperative
 * (a listener imperative, or a fragment under three words: it asserts
 * nothing).
 */
export function seamSentences(seam: VerifySeamBrief, clips: ActVerifyRequest["clips"]): SeamSentence[] {
  const introduced = seam.introduces !== undefined ? clips.find((c) => c.clipId === seam.introduces) : undefined;
  return splitSpokenSentences(String(seam.script ?? "")).map((text, index) => {
    const trimmed = text.trim();
    let kind: SentenceVerdict["kind"];
    if (/\?["'”’)\]]*$/.test(trimmed)) kind = "question";
    else if (introduced !== undefined && introNamesSource(trimmed, introduced)) kind = "intro";
    else if (isStatementSentence(trimmed)) kind = "statement";
    else kind = "imperative";
    return { seamId: seam.seamId, index, text: trimmed, kind };
  });
}

/* ------------------------------------------------------------------------ */
/* The act's sources as text                                                 */
/* ------------------------------------------------------------------------ */

const DOC_PREFIX = "doc:";

/** The page document id writeAct gives a ground page (synthesisVerify.ts
 * pageDocIdFor), restated so this module does not import the stitcher. */
function pageDocId(pageId: string): string {
  return `page:${pageId}`;
}

/**
 * The act's sources resolved to the text a sentence is judged against:
 * a claim is its quote plus its claim text; a clip is its held window; a
 * page is its ground script. Each evidence document whose text no clip or
 * page already offers is a further source, `doc:<docId>`, which maps back
 * to an act claim quoting that document (`actIdFor`). Sources with no text
 * are left out: nothing can rest on them.
 */
export function supportSourcesFor(request: ActVerifyRequest): SupportSource[] {
  const out: SupportSource[] = [];
  const covered = new Set<string>();
  for (const s of request.sources) {
    let text: string;
    if (s.kind === "claim") text = [s.quote, s.claimText].filter((t): t is string => typeof t === "string" && t.trim().length > 0).join(" ");
    else if (s.kind === "clip") {
      text = request.clips.find((c) => c.clipId === s.id)?.windowText ?? "";
      covered.add(s.docId);
    } else {
      text = (request.ground ?? []).find((g) => pageDocId(g.pageId) === s.docId)?.script ?? "";
      covered.add(s.docId);
    }
    if (text.trim().length > 0) out.push({ id: s.id, kind: s.kind, text, publication: s.publication });
  }
  for (const d of request.documents) {
    if (covered.has(d.docId) || String(d.text ?? "").trim().length === 0) continue;
    covered.add(d.docId);
    out.push({ id: `${DOC_PREFIX}${d.docId}`, kind: "doc", text: d.text, publication: d.title });
  }
  return out;
}

/** An id the judge chose, as an act source id: act ids pass through; a
 * document maps to the first act claim quoting it (the seam's own first),
 * or to nothing when no act source rests in it. */
function actIdFor(id: string, seamId: string, sources: readonly ActSourceBrief[]): string | undefined {
  if (!id.startsWith(DOC_PREFIX)) return sources.some((s) => s.id === id) ? id : undefined;
  const docId = id.slice(DOC_PREFIX.length);
  const inDoc = sources.filter((s) => s.docId === docId);
  return (inDoc.find((s) => s.selectedBy === seamId) ?? inDoc[0])?.id;
}

/* ------------------------------------------------------------------------ */
/* Per-sentence support                                                      */
/* ------------------------------------------------------------------------ */

/**
 * Every sentence of every non-frozen seam with its verdict, keyed by seam
 * id. `judge` answers the statements (one batch); `minP(id)` is the support
 * threshold for the judge that answered statement `id`. Shared by the Jev
 * verifier and the stub's opt-in sentence mode (CodeOverlapSupportJudge).
 */
export async function sentenceVerdictsFor(
  request: ActVerifyRequest,
  judge: SentenceSupportJudge,
  minP: (id: string) => number
): Promise<Map<string, SentenceVerdict[]>> {
  const sources = supportSourcesFor(request);
  const seams = request.seams.filter((s) => !s.frozen);
  const items: SentenceSupportItem[] = [];
  const specificsOf = new Map<string, string[]>();
  const perSeam = seams.map((seam) => {
    const sentences = seamSentences(seam, request.clips);
    for (const s of sentences) {
      if (s.kind !== "statement") continue;
      const id = sentenceId(seam.seamId, s.index);
      const candidates = candidateSourcesFor(s.text, sources, { mustInclude: seam.selected });
      items.push({ id, sentence: s.text, sources: candidates });
      specificsOf.set(id, unsupportedSpecifics(s.text, candidates.map((c) => c.text)));
    }
    return { seam, sentences };
  });
  const verdicts = items.length > 0 ? await judge.judge(items) : new Map<string, SentenceSupportVerdict>();

  const out = new Map<string, SentenceVerdict[]>();
  for (const { seam, sentences } of perSeam) {
    out.set(
      seam.seamId,
      sentences.map((s): SentenceVerdict => {
        const base = { index: s.index, text: s.text, kind: s.kind };
        if (s.kind !== "statement") return { ...base, verdict: "exempt" };
        const id = sentenceId(seam.seamId, s.index);
        const specifics = specificsOf.get(id) ?? [];
        const v = verdicts.get(id);
        const judged: { p?: number; restsOn?: string[] } = {};
        if (v !== undefined && !isSupportUnavailable(v)) {
          judged.p = v.p;
          const rest = v.restsOn !== undefined ? actIdFor(v.restsOn, seam.seamId, request.sources) : undefined;
          if (rest !== undefined) judged.restsOn = [rest];
        }
        const withSpecifics = specifics.length > 0 ? { specifics } : {};
        if (specifics.length > 0) return { ...base, verdict: "unsupported", ...judged, ...withSpecifics };
        if (v === undefined || isSupportUnavailable(v)) return { ...base, verdict: "unknown" };
        return { ...base, verdict: v.p >= minP(id) ? "supported" : "unsupported", ...judged };
      })
    );
  }
  return out;
}

/** The seam's verdict from its sentences (see the module comment). */
export function seamVerdictFromSentences(seam: VerifySeamBrief, sentences: SentenceVerdict[], sources: readonly ActSourceBrief[]): SeamVerdict {
  const statements = sentences.filter((s) => s.kind === "statement");
  const claimsSupported = statements.every((s) => s.verdict === "supported");
  const restsOn: string[] = [];
  for (const s of statements) for (const id of s.restsOn ?? []) if (!restsOn.includes(id)) restsOn.push(id);
  const notes: string[] = [];
  for (const s of statements) {
    if (s.verdict === "unsupported") {
      const why = s.specifics && s.specifics.length > 0 ? ` It states ${s.specifics.join(", ")}, which no source in the act carries.` : "";
      notes.push(`Unsupported: "${s.text}" is not backed by any source in the act.${why}`);
    } else if (s.verdict === "unknown") {
      notes.push(`Unconfirmed: "${s.text}" could not be checked against the act's sources.`);
    }
  }
  /* The stub's code rule (StubNarrationVerifierBuilder actVerdictFor). */
  const rested = sources.filter((s) => restsOn.includes(s.id));
  const contestedHandled = !rested.some((s) => s.contested) || containsContestedLanguage(seam.script);
  if (!contestedHandled) notes.push("A source is marked contested but the script never says so explicitly.");
  return {
    seamId: seam.seamId,
    claimsSupported,
    restsOn,
    contestedHandled,
    ...(notes.length > 0 ? { notes: notes.join(" ") } : {}),
    sentences
  };
}

/* ------------------------------------------------------------------------ */
/* Per-beat choice                                                           */
/* ------------------------------------------------------------------------ */

interface BeatOption {
  id: string;
  text: string;
  seamId?: string;
  index?: number;
}

/** The beat's options: every statement sentence of every scripted seam,
 * then every clip whose window is held (the passage around the claim). */
export function beatOptionsFor(claim: string, request: ActVerifyRequest): BeatOption[] {
  const options: BeatOption[] = [];
  for (const seam of request.seams) {
    for (const s of seamSentences(seam, request.clips)) {
      if (s.kind === "statement") options.push({ id: sentenceId(seam.seamId, s.index), text: s.text, seamId: seam.seamId, index: s.index });
    }
  }
  for (const clip of request.clips) {
    if (String(clip.windowText ?? "").trim().length === 0) continue;
    options.push({ id: clip.clipId, text: passageAround(clip.windowText, claim, BEAT_CLIP_PASSAGE_CHARS) });
  }
  return options;
}

/** The options split into asks of at most BEAT_OPTIONS_MAX_CHARS characters
 * and BEAT_OPTIONS_MAX_COUNT options each, in order. */
export function chunkBeatOptions(options: readonly BeatOption[]): BeatOption[][] {
  const chunks: BeatOption[][] = [];
  let current: BeatOption[] = [];
  let chars = 0;
  for (const option of options) {
    if (current.length > 0 && (chars + option.text.length > BEAT_OPTIONS_MAX_CHARS || current.length >= BEAT_OPTIONS_MAX_COUNT)) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push(option);
    chars += option.text.length;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export function beatQuestion(options: readonly BeatOption[]): JevChoiceQuestion {
  const criteria: Record<string, { what: string }> = {};
  for (const o of options) criteria[o.id] = { what: `Option ${o.id} carries the claim.` };
  criteria[BEAT_NONE] = { what: "No option in `options` carries the claim." };
  return { id: "carriedBy", type: "choice", instructions: BEAT_CARRIED_INSTRUCTIONS, criteria };
}

/** One ask's best option: the chosen option and its probability, or the
 * reason the ask failed. */
type BeatAsk = { ok: true; choice: string; p: number; judge: JudgeId } | { ok: false; reason: string };

function readBeatAsk(result: JevResult, options: readonly BeatOption[]): BeatAsk {
  if (!result.ok) return { ok: false, reason: result.error.reason };
  const answer = result.answers.find((a) => a.id === "carriedBy");
  if (!answer || answer.type !== "choice") return { ok: false, reason: "malformed_answer" };
  if (answer.choice !== BEAT_NONE && !options.some((o) => o.id === answer.choice)) return { ok: false, reason: "malformed_answer" };
  const p = answer.probabilities[answer.choice];
  if (typeof p !== "number" || !Number.isFinite(p)) return { ok: false, reason: "malformed_answer" };
  return { ok: true, choice: answer.choice, p, judge: result.judge ?? "jev" };
}

/* ------------------------------------------------------------------------ */
/* The builder                                                               */
/* ------------------------------------------------------------------------ */

export interface JevNarrationVerifierOptions {
  /** The judge client (createJevClient for the verifier's route); it is
   * wrapped in meteredJevClient per call. */
  client: JevClient;
  /** The gate config the thresholds are read from (default: the table's
   * defaults, never process.env). */
  gates?: GateConfig;
  budgetGuard?: BudgetGuard;
  /** Asks in flight at once across the act (default 8, the Jev pool size). */
  maxInFlight?: number;
}

export class JevNarrationVerifierBuilder implements NarrationVerifierBuilder {
  readonly providerName = "jev";
  private readonly client: JevClient;
  private readonly gates: GateConfig;
  private readonly budgetGuard: BudgetGuard;
  private readonly maxInFlight: number;

  constructor(opts: JevNarrationVerifierOptions) {
    this.client = opts.client;
    this.gates = opts.gates ?? readGateConfig({});
    this.budgetGuard = opts.budgetGuard ?? defaultBudgetGuard;
    this.maxInFlight = opts.maxInFlight ?? DEFAULT_JEV_POOL_SIZE;
  }

  private minP(judge: JudgeId): number {
    return judgeThreshold(this.gates, "supportMinP", judge);
  }

  async verifyAct(request: ActVerifyRequest, ctx: NarrationBuildContext): Promise<ActVerifyResult> {
    const metered = meteredJevClient(this.client, {
      guard: this.budgetGuard,
      userId: ctx.userId,
      ...(ctx.sessionId !== undefined ? { sessionId: ctx.sessionId } : {})
    });
    const pool = createJevPool(metered, { maxInFlight: this.maxInFlight });
    const support = new JudgeTaggedSupport(pool);

    const [beatAsks, sentences] = await Promise.all([
      Promise.all(request.beats.map((beat) => this.askBeat(beat.claim, request, pool))),
      sentenceVerdictsFor(request, support, (id) => this.minP(support.answeredBy.get(id) ?? "jev"))
    ]);

    const seams: SeamVerdict[] = request.seams
      .filter((seam) => !seam.frozen)
      .map((seam) => seamVerdictFromSentences(seam, sentences.get(seam.seamId) ?? [], request.sources));

    /* A seed-lost beat the judge could not read is given NO verdict: writeAct
       closes a seed-lost beat on its first verdict (F-99), and an outage has
       not read it against the act. */
    const beats: BeatVerdict[] = request.beats.flatMap((beat, i) => {
      const asks = beatAsks[i]!;
      const verdict = this.beatVerdict(beat, asks, request, sentences);
      if (beat.seedLost === true && !verdict.carried && asks.asks.some((a) => !a.ok)) return [];
      return [verdict];
    });
    return { beats, seams };
  }

  /** Every ask for one beat (one per option chunk), in parallel. */
  private async askBeat(claim: string, request: ActVerifyRequest, pool: JevClient): Promise<{ options: BeatOption[]; asks: BeatAsk[] }> {
    const options = beatOptionsFor(claim, request);
    if (options.length === 0) return { options, asks: [] };
    const asks = await Promise.all(
      chunkBeatOptions(options).map(async (chunk) => {
        const state = { claim, options: Object.fromEntries(chunk.map((o) => [o.id, o.text])) };
        const result = await pool.ask(state, [beatQuestion(chunk)], { purpose: VERIFY_BEAT_PURPOSE });
        return readBeatAsk(result, chunk);
      })
    );
    return { options, asks };
  }

  private beatVerdict(
    beat: ActVerifyRequest["beats"][number],
    found: { options: BeatOption[]; asks: BeatAsk[] },
    request: ActVerifyRequest,
    sentences: Map<string, SentenceVerdict[]>
  ): BeatVerdict {
    const positioned = request.seams.find((seam) => seam.carries.includes(beat.beatId));
    const where = positioned ? ` — it was positioned in seam ${positioned.seamId}` : "";
    const claim = beat.claim.slice(0, 60);
    if (found.options.length === 0) {
      return { beatId: beat.beatId, carried: false, notes: `the act has no prose sentence or clip that could carry the claim "${claim}"${where}` };
    }
    /* The best non-'none' option across the asks. */
    let best: Extract<BeatAsk, { ok: true }> | undefined;
    for (const ask of found.asks) {
      if (ask.ok && ask.choice !== BEAT_NONE && (best === undefined || ask.p > best.p)) best = ask;
    }
    if (best !== undefined && best.p >= this.minP(best.judge)) {
      const option = found.options.find((o) => o.id === best!.choice)!;
      if (option.seamId !== undefined && option.index !== undefined) {
        const verdict = sentences.get(option.seamId)?.find((s) => s.index === option.index);
        return {
          beatId: beat.beatId,
          carried: true,
          carriedBy: option.seamId,
          carriedBySentence: { seamId: option.seamId, index: option.index },
          ...(verdict?.restsOn && verdict.restsOn.length > 0 ? { restsOn: [...verdict.restsOn] } : {})
        };
      }
      const clipSource = request.sources.some((s) => s.id === option.id);
      return { beatId: beat.beatId, carried: true, carriedBy: option.id, ...(clipSource ? { restsOn: [option.id] } : {}) };
    }
    /* Not carried. A failed ask is said so: the beat is unconfirmed, not
       refused, though writeAct treats both as open. */
    const failed = found.asks.find((a): a is Extract<BeatAsk, { ok: false }> => !a.ok);
    if (failed !== undefined) {
      return { beatId: beat.beatId, carried: false, notes: `the judge could not be asked whether the act carries the claim "${claim}" (${failed.reason})${where}` };
    }
    return { beatId: beat.beatId, carried: false, notes: `no sentence of the act's prose and no clip carries the claim "${claim}"${where}` };
  }
}

/**
 * GV-27's JevSentenceSupportJudge, one instance per sentence over the
 * shared pool, so the judge that answered each sentence (GV-47's tag: Jev,
 * or the Qwen fallback) is known and its own threshold applies.
 */
class JudgeTaggedSupport implements SentenceSupportJudge {
  readonly name = "jev";
  readonly answeredBy = new Map<string, JudgeId>();

  constructor(private readonly pool: JevClient) {}

  async judge(items: readonly SentenceSupportItem[]): Promise<Map<string, SentenceSupportVerdict>> {
    const out = new Map<string, SentenceSupportVerdict>();
    await Promise.all(
      items.map(async (item) => {
        const recorder: JevClient = {
          ask: async (state, questions, opts) => {
            const result = await this.pool.ask(state, questions, opts);
            this.answeredBy.set(item.id, result.judge ?? "jev");
            return result;
          }
        };
        const judged = await new JevSentenceSupportJudge(recorder, { maxInFlight: 1, purpose: VERIFY_SENTENCE_PURPOSE }).judge([item]);
        out.set(item.id, judged.get(item.id)!);
      })
    );
    return out;
  }
}
