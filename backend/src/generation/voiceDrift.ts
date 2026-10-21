import { findBudgetError } from "../cost/budgetGuard";
import { findUnitBudgetError } from "../cost/unitBudget";
import { readEnumFlag, type FlagSource } from "./generationFlags";
import type { JevClient, JevErrorCategory, JevScoreQuestion, JudgeId } from "./jevTypes";
import type { LoadedVoiceExemplars, VoiceExemplarsFile } from "./voiceExemplars";
import { pageOfWrittenBeat, type WrittenAct } from "./writeNarration";

/**
 * GV-116 (docs/roadmap/generation-v2.md, #1286; from W4-12, covers R2-08 and
 * GP-24): THE VOICE DRIFT ALARM. One Jev Score per act on "is this narration
 * written by the same narrator as the reference passage?", where the
 * reference is the founder-selected exemplar seams (GV-99's
 * narration-exemplars.json, read through `loadVoiceExemplars`, so the alarm
 * and the writer's voice prefix share one voice reference).
 *
 * REPORT ONLY. The scores land in `meta.veracity.voice.drift` and nothing
 * reads them to gate, re-ask or drop: no threshold is set until the
 * founder's R2-01 listening cards say which acts sounded like a different
 * narrator. A judge failure never fails a run: an act whose ask comes back
 * `{ok:false}`, or throws anything but a budget stop, is recorded as
 * unmeasured and the rest are still asked. A budget stop (dollar or unit
 * cap) is rethrown, the way bestOfSpine and selfCritique do it, and the
 * acts not yet asked are not asked.
 *
 * DARK: FORAY_VOICE_DRIFT=off|on, default off. Off, runPipeline builds no
 * judge, asks nothing and adds no field, so the default output is
 * byte-identical. On, it still runs only with a judge that can answer (not
 * NullJevClient) and a usable exemplar file holding at least one selected
 * exemplar seam; otherwise `voice.drift` is ABSENT, never zero. It rides on
 * the voice scorecard, so FORAY_VOICE_GATE=off (no `voice` block) leaves it
 * out too.
 *
 * WHERE IT RUNS. runPipeline's `finishRun`, after the ordered stitch loop
 * (first audio has long been served), over the written acts the run holds,
 * which on a resume are the banked `narrate:<i>` stages. It is computed at
 * finalize from banked narration and banks nothing itself, so it changes no
 * stage's contents and needs no part in the checkpoint variant: a resumed
 * run re-asks the judge (a few cents) rather than reading a stored score.
 *
 * NO ANTHROPIC CALL. The judge is the JevClient the judge route resolves
 * (Jev, or OQ-05's Qwen-judge fallback); this module imports no provider.
 */

/** The flag, read at call time through generationFlags. */
export const VOICE_DRIFT_ENV = "FORAY_VOICE_DRIFT";
export const VOICE_DRIFT_MODES = ["off", "on"] as const;
export type VoiceDriftMode = (typeof VOICE_DRIFT_MODES)[number];

/** FORAY_VOICE_DRIFT: `off` (default) or `on`; any other value throws naming
 * only the variable (generationFlags.readEnumFlag). */
export function voiceDriftMode(source: FlagSource = process.env): VoiceDriftMode {
  return readEnumFlag(VOICE_DRIFT_ENV, VOICE_DRIFT_MODES, "off", source);
}

/** The purpose every drift ask is metered and logged under (never sent to Jev). */
export const VOICE_DRIFT_PURPOSE = "voice-drift";

/** The stage the run times the alarm under (a timed, unbanked stage). */
export const VOICE_DRIFT_STAGE = "voice-drift";

/** The state's budget (W4-12 item 3: capped at 4k tokens), at chars/4. */
export const VOICE_DRIFT_STATE_BUDGET_TOKENS = 4000;
export const VOICE_DRIFT_STATE_BUDGET_CHARS = VOICE_DRIFT_STATE_BUDGET_TOKENS * 4;

/** The reference passage takes at most this share of the budget, so an act's
 * narration always has room. */
export const VOICE_DRIFT_REFERENCE_SHARE = 0.5;

/** Acts asked at once. */
export const VOICE_DRIFT_CONCURRENCY = 4;

/** The report's scale: Jev's level 0..4 read as 1..5. */
export const VOICE_DRIFT_SCALE: [number, number] = [1, 5];

/** The one question, a five-level Score (level 0 first). */
export const VOICE_DRIFT_QUESTION: JevScoreQuestion = {
  id: "same-narrator",
  type: "score",
  instructions:
    "Is this narration written by the same narrator as the reference passage? Judge only the voice: word choice, sentence rhythm, register and how the narrator addresses the listener. Ignore the subject and the facts.",
  criteria: [
    "A different narrator: the word choice, rhythm and register do not match the reference passage.",
    "Mostly a different narrator, sharing only a few habits with the reference passage.",
    "Unclear: some of the narration sounds like the reference narrator and some does not.",
    "Probably the same narrator, with small differences in rhythm or register.",
    "The same narrator: the word choice, rhythm and register match the reference passage."
  ]
};

/** Why an act carries no score. `no-narration`: the act has no page with a
 * script, so nothing was asked. `aborted`: the run failed (or a budget stop
 * ended the alarm) before this act was asked. `error`: the ask threw
 * something other than a budget stop. The rest are the judge's own failure
 * categories (`JevErrorCategory`) or `malformed` for an answer that is not a
 * score for the question. */
export type VoiceDriftUnmeasured = "no-narration" | "aborted" | "error" | JevErrorCategory;

export interface VoiceDriftAct {
  /** The act's index in the Foray. */
  act: number;
  /** 1..5 (Jev's level + 1; may be fractional). null when unmeasured. */
  score: number | null;
  /** Seam scripts in the state (the last one may be cut to the budget). */
  seams: number;
  /** Present exactly when `score` is null. */
  unmeasured?: VoiceDriftUnmeasured;
  /** Which judge answered (GV-47), when one did. */
  judge?: JudgeId;
}

/** `meta.veracity.voice.drift`. Report only. */
export interface VoiceDrift {
  question: string;
  scale: [number, number];
  /** The exemplars the reference was built from (`<forayId>:<first itemId>`,
   * GV-99's ids) and the file's hash, so a reading names its reference. */
  exemplarIds: string[];
  fileSha: string;
  acts: VoiceDriftAct[];
  measured: number;
  unmeasured: number;
  /** The lowest act score, the alarm's reading. null when none was measured. */
  min: number | null;
  /** The act with the lowest score (the first on a tie). */
  minAct: number | null;
  mean: number | null;
}

/** The reference passage: the selected exemplar seams' texts, in file order,
 * one blank line apart. null when the file holds no exemplar seam (a voice
 * card alone is a description, not a passage to compare a narrator with). */
export function voiceDriftReference(file: VoiceExemplarsFile): string | null {
  const texts = file.exemplars.map((e) => e.text.trim()).filter((t) => t.length > 0);
  return texts.length ? texts.join("\n\n") : null;
}

/** Every page script of `act`, in slot and beat order (a beat carried by
 * another beat's page has none). Blank scripts are skipped. */
export function actSeamScripts(act: WrittenAct): string[] {
  const scripts: string[] = [];
  for (const slot of act.slots) {
    for (const beat of slot.beats) {
      const script = pageOfWrittenBeat(beat)?.script?.trim();
      if (script) scripts.push(script);
    }
  }
  return scripts;
}

export interface VoiceDriftState {
  state: { reference: string; narration: string };
  seams: number;
}

/**
 * The state one act's ask carries: the reference (cut to
 * VOICE_DRIFT_REFERENCE_SHARE of the budget) and the act's seam scripts in
 * order, one blank line apart, until the budget is spent (the seam that does
 * not fit is cut, the rest dropped). Nothing else: no ids, titles, prompt or
 * sources leave the machine (LM-25).
 */
export function voiceDriftState(reference: string, seamScripts: readonly string[], budgetChars: number = VOICE_DRIFT_STATE_BUDGET_CHARS): VoiceDriftState {
  const ref = reference.slice(0, Math.floor(budgetChars * VOICE_DRIFT_REFERENCE_SHARE));
  let room = budgetChars - ref.length;
  const parts: string[] = [];
  for (const script of seamScripts) {
    const sep = parts.length ? 2 : 0;
    if (room - sep <= 0) break;
    parts.push(script.slice(0, room - sep));
    room -= sep + Math.min(script.length, room - sep);
  }
  return { state: { reference: ref, narration: parts.join("\n\n") }, seams: parts.length };
}

const isBudgetStop = (err: unknown): boolean => findBudgetError(err) !== null || findUnitBudgetError(err) !== null;

export interface VoiceDriftOptions {
  /** The run's abort: once it fires, no act still waiting is asked, and the
   * asks in flight carry it to the judge. */
  signal?: AbortSignal;
  concurrency?: number;
  budgetChars?: number;
}

/**
 * One Score per written act against the exemplar reference (see the module
 * comment). Never throws on a judge failure; rethrows a budget stop.
 * `exemplars` must hold an exemplar seam (`voiceDriftReference`), else this
 * throws: a caller with none must not call it, so the field stays absent.
 */
export async function voiceDriftScores(
  writtenActs: readonly WrittenAct[],
  exemplars: LoadedVoiceExemplars,
  jev: JevClient,
  opts: VoiceDriftOptions = {}
): Promise<VoiceDrift> {
  const reference = voiceDriftReference(exemplars.file);
  if (reference === null) throw new Error("voiceDriftScores: the exemplar file holds no exemplar seam");
  const inner = new AbortController();
  const onOuter = (): void => inner.abort();
  if (opts.signal?.aborted) inner.abort();
  else opts.signal?.addEventListener("abort", onOuter, { once: true });

  const scoreAct = async (act: number): Promise<VoiceDriftAct> => {
    const { state, seams } = voiceDriftState(reference, actSeamScripts(writtenActs[act]!), opts.budgetChars);
    if (seams === 0) return { act, score: null, seams, unmeasured: "no-narration" };
    if (inner.signal.aborted) return { act, score: null, seams, unmeasured: "aborted" };
    try {
      const result = await jev.ask(state, [VOICE_DRIFT_QUESTION], { purpose: VOICE_DRIFT_PURPOSE, signal: inner.signal });
      const judge = { judge: result.judge ?? ("jev" as const) };
      if (!result.ok) return { act, score: null, seams, unmeasured: result.error.category, ...judge };
      const answer = result.answers.find((a) => a.id === VOICE_DRIFT_QUESTION.id);
      if (!answer || answer.type !== "score" || !Number.isFinite(answer.score)) return { act, score: null, seams, unmeasured: "malformed", ...judge };
      return { act, score: answer.score + VOICE_DRIFT_SCALE[0], seams, ...judge };
    } catch (err) {
      if (isBudgetStop(err)) {
        inner.abort();
        throw err;
      }
      return { act, score: null, seams, unmeasured: "error" };
    }
  };

  const rows: VoiceDriftAct[] = new Array(writtenActs.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < writtenActs.length) {
      const act = next++;
      rows[act] = await scoreAct(act);
    }
  };
  const width = Math.max(1, Math.min(opts.concurrency ?? VOICE_DRIFT_CONCURRENCY, writtenActs.length));
  try {
    await Promise.all(Array.from({ length: width }, worker));
  } finally {
    opts.signal?.removeEventListener("abort", onOuter);
  }
  return summarizeVoiceDrift(rows, exemplars);
}

/** The report block over the per-act rows. */
export function summarizeVoiceDrift(acts: VoiceDriftAct[], exemplars: LoadedVoiceExemplars): VoiceDrift {
  const scored = acts.filter((a): a is VoiceDriftAct & { score: number } => a.score !== null);
  let low: (VoiceDriftAct & { score: number }) | null = null;
  for (const a of scored) if (low === null || a.score < low.score) low = a;
  return {
    question: VOICE_DRIFT_QUESTION.id,
    scale: [...VOICE_DRIFT_SCALE],
    exemplarIds: exemplars.file.exemplars.map((e) => `${e.forayId}:${e.itemIds[0]}`),
    fileSha: exemplars.fileSha,
    acts,
    measured: scored.length,
    unmeasured: acts.length - scored.length,
    min: low ? low.score : null,
    minAct: low ? low.act : null,
    mean: scored.length ? scored.reduce((sum, a) => sum + a.score, 0) / scored.length : null
  };
}

/** The run's one drift line, e.g. `voice drift (report only): act 1 4.0, act 2 2.5 (min 2.5 at act 2)`. */
export function voiceDriftLine(drift: VoiceDrift): string {
  const cells = drift.acts.map((a) => `act ${a.act + 1} ${a.score === null ? `unmeasured (${a.unmeasured})` : a.score.toFixed(1)}`);
  const tail = drift.min === null ? "nothing measured" : `min ${drift.min.toFixed(1)} at act ${drift.minAct! + 1}`;
  return `voice drift (report only): ${cells.join(", ")} (${tail})`;
}
