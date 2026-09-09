import * as crypto from "crypto";
import { z } from "zod";

/**
 * Per-stage resume for ONE Foray (generation run 2026-09-09, findings F-17 and
 * F-18).
 *
 * THE PROBLEM, IN THE RUN'S OWN NUMBERS. Attempt 4 ran 2 h 35 m, made 103
 * model calls, finished 22 of 31 beats — and then beat 23's narration page was
 * rejected a third time, `NarrationWriteError` propagated out of §4.7, and the
 * batch driver recorded the Foray as `error`. Every finished beat was
 * discarded: the spine, three deepened acts, the whole sourcing pass, 18 kept
 * pages. Three earlier attempts died the same way at beats 1, 1 and 5. The
 * driver's own resume key is the CANDIDATE FILE, which a failed run never
 * writes (F-18), so the re-run started again at the clarity check — and the
 * orchestrator's answer, four times, was to hand the pipeline the previous
 * attempt's answers by hand and log it as an intervention (I-11, I-14).
 *
 * WHAT THIS FIXES. A stage's output is written to disk the moment it exists.
 * On a re-run with the same prompt, a stage whose output is already on disk is
 * not called again. A narration failure on one beat therefore costs one beat's
 * worth of retries, not the Foray — and the third failure that ends the run
 * still leaves the other 22 beats banked for the next attempt.
 *
 * WHAT IT IS NOT. Not a cache: the key is scoped to one prompt and one output
 * directory, and the file records the request it was built for
 * (`fingerprint`). Change the prompt, the duration or the requested topic and
 * the fingerprint changes, the old stages are discarded, and the run starts
 * clean. That matters because the alternative — silently resuming a spine
 * built for a different duration tier — is a wrong Foray rather than a slow
 * one, and this whole module exists to make failures cheap, not to make them
 * quiet.
 *
 * WHY THE STORE IS AN INTERFACE, AND WHY NOTHING HERE TOUCHES A FILE. Two
 * reasons, and the second is a rule rather than a preference:
 *
 *   - `runForayPipeline` takes the store as an optional dependency alongside
 *     its seven builders, for the same reason those are injectable: the tests
 *     drive the real resume logic with an in-memory store at zero cost, and
 *     the batch driver passes `src/cli/checkpointStore.ts`'s
 *     `FileCheckpointStore`. One code path, not two.
 *   - §9.4 is a founder ruling — "Each prompt is discarded" — and
 *     `test/promptNoPersistence.test.ts` enforces it by scanning every file in
 *     this directory for a persistence primitive. The §4 stages must not be
 *     able to write anything; the DRIVER writes, and always did. So this
 *     module holds the interface, the session and the fingerprint, and the
 *     only code that opens a file lives in `src/cli/`.
 *
 * A pipeline given no store behaves exactly as it did before this module
 * existed — every `save` is a no-op that never happens, and no stage is ever
 * skipped.
 */

/** The stage keys the driver persists under. `deepen:0` / `narrate:2` carry an
 * act index: F-17 is specifically about a failure in act 3 not costing acts 1
 * and 2, which a single `deepen` key could not express. */
export type CheckpointStageKey = string;

export const CHECKPOINT_VERSION = 1;

export const CheckpointFileSchema = z
  .object({
    version: z.number(),
    /** The candidate basename this file belongs to — carried so a file that
     * has been moved or copied between output directories is recognisably not
     * the one being resumed. */
    key: z.string(),
    /** Identifies the REQUEST, not the content. A mismatch discards the file
     * rather than resuming a spine built for a different duration tier. */
    fingerprint: z.string(),
    updatedAt: z.string(),
    stages: z.record(z.unknown())
  })
  .passthrough();
export type CheckpointFile = z.infer<typeof CheckpointFileSchema>;

export interface CheckpointStore {
  /** Returns the stored stages for `key`, or null when there is nothing to
   * resume. Never throws on a missing, unreadable or malformed file — a
   * corrupt checkpoint must cost a re-run, never the run. */
  load(key: string): Promise<CheckpointFile | null> | CheckpointFile | null;
  /** Persists one stage's output. Called after the stage returns, so a file on
   * disk only ever describes work that actually completed. */
  save(key: string, stage: CheckpointStageKey, data: unknown): Promise<void> | void;
}

/**
 * A stable identifier for the request a checkpoint belongs to.
 *
 * Everything that changes what a stage would produce goes in: the prompt, the
 * duration tier, and a pinned topic. The author id deliberately does NOT — two
 * founders generating the same prompt at the same duration are doing the same
 * work, and a run resumed under a different author still produces the same
 * Foray.
 */
export function checkpointFingerprint(input: { prompt: string; duration: string; topic?: string | null }): string {
  /* `crypto` only — the other four stub builders in this directory import it
     the same way. Note what is NOT imported here: nothing that can write. The
     §9.4 no-persistence scan over this directory (`promptNoPersistence.test.ts`)
     is why the file half of this module lives in `src/cli/`. */
  return crypto
    .createHash("sha1")
    .update(`${input.prompt}\n${input.duration}\n${input.topic ?? ""}`)
    .digest("hex")
    .slice(0, 12);
}

/**
 * The in-process half of a resume: holds one Foray's already-completed stages
 * and hands each one back to the pipeline, parsed and re-validated.
 *
 * RE-VALIDATION IS THE POINT, not ceremony. A checkpoint file is JSON on disk
 * that a person can edit, a half-finished write can truncate, and a code
 * change can outdate. Handing an unparsed blob back into §4.4 would turn a
 * corrupt file into a failure four stages later with no trace of where it came
 * from. Every read goes through the SAME schema the stage's own output is
 * checked against; anything that fails is dropped, the stage runs for real,
 * and the fresh output overwrites it.
 */
export class CheckpointSession {
  private readonly stages: Record<string, unknown>;
  private readonly resumedStages = new Set<string>();

  private constructor(
    private readonly store: CheckpointStore | undefined,
    private readonly key: string,
    private readonly fingerprint: string,
    stages: Record<string, unknown>
  ) {
    this.stages = stages;
  }

  /** No store, or nothing on disk, or a file for a different request — all
   * three produce a session that resumes nothing and saves nothing extra. */
  static async open(
    store: CheckpointStore | undefined,
    key: string | undefined,
    fingerprint: string
  ): Promise<CheckpointSession> {
    if (!store || !key) return new CheckpointSession(undefined, key ?? "", fingerprint, {});
    let file: CheckpointFile | null;
    try {
      file = await store.load(key);
    } catch {
      /* A store that cannot read is a store that has nothing to resume. The
         run continues from stage one, which is exactly the behaviour before
         checkpoints existed. */
      file = null;
    }
    const usable = file && file.version === CHECKPOINT_VERSION && file.fingerprint === fingerprint ? file.stages : {};
    return new CheckpointSession(store, key, fingerprint, { ...usable });
  }

  /** Which stages this run skipped — surfaced so a report can say "resumed"
   * rather than reporting a 2 ms spine as if it had been built. */
  resumed(): string[] {
    return [...this.resumedStages];
  }

  /**
   * The one seam every stage goes through: return the stored output if there
   * is a valid one, otherwise run the stage and store what it produced.
   *
   * `parse` is the stage's own schema. It is required rather than optional
   * because an unvalidated resume is the failure mode described on this
   * class — making it a parameter with no default means a new stage cannot be
   * added to the checkpoint without someone deciding how its output is
   * checked.
   */
  async stage<T>(name: CheckpointStageKey, parse: (raw: unknown) => T, run: () => Promise<T>): Promise<{ value: T; resumed: boolean }> {
    if (Object.prototype.hasOwnProperty.call(this.stages, name)) {
      try {
        const value = parse(this.stages[name]);
        this.resumedStages.add(name);
        return { value, resumed: true };
      } catch {
        /* Stale or corrupt. Drop it and pay for the stage — a wrong resume is
           more expensive than a repeated one. */
        delete this.stages[name];
      }
    }
    const value = await run();
    await this.record(name, value);
    return { value, resumed: false };
  }

  /**
   * The `stage` seam split in two, for a stage whose unit of work is not the
   * stage — §4.4 deepens every act in parallel inside one `Promise.all`, so it
   * needs "have you got act 3?" answered SYNCHRONOUSLY inside the map, and
   * "here is act 3" called the moment that act lands rather than when the
   * stage returns.
   *
   * Same re-validation rule as `stage`: a stored value that no longer parses
   * is dropped and the work is redone.
   */
  resumeSync<T>(name: CheckpointStageKey, parse: (raw: unknown) => T): T | undefined {
    if (!Object.prototype.hasOwnProperty.call(this.stages, name)) return undefined;
    try {
      const value = parse(this.stages[name]);
      this.resumedStages.add(name);
      return value;
    } catch {
      delete this.stages[name];
      return undefined;
    }
  }

  /** Persists one unit of work under its own key. Pairs with `resumeSync`. */
  async save(name: CheckpointStageKey, value: unknown): Promise<void> {
    await this.record(name, value);
  }

  private async record(name: CheckpointStageKey, value: unknown): Promise<void> {
    this.stages[name] = value;
    if (!this.store) return;
    try {
      await this.store.save(this.key, name, value);
    } catch {
      /* A checkpoint that cannot be written must never fail a stage that
         succeeded. The cost of the loss is one repeated stage on the next
         run; the cost of throwing here is the whole Foray, which is the bug
         F-17 is about. */
    }
  }
}
