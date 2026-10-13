import * as crypto from "crypto";
import { z } from "zod";
import type { RoutingTable, StageId } from "../config/stageRouting";
import { checkpointVariant, type PipelineFlags } from "./pipelineFlags";

/**
 * Per-stage resume for ONE Foray (generation run 2026-09-09, findings F-17 and
 * F-18).
 *
 * THE PROBLEM, IN THE RUN'S OWN NUMBERS. Attempt 4 ran 2 h 35 m, made 103
 * model calls, finished 22 of 31 beats — and then beat 23's narration page was
 * rejected a third time, §4.7 threw, and the
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

/**
 * Bumped when a stage's SHAPE or MEANING changes enough that an older file
 * would be half-understood rather than simply out of date. A file whose
 * `version` is not this one is discarded whole (`resumeAll` below,
 * `FileCheckpointStore.save`), which is the honest outcome: a resume is
 * worth having only when what comes back means what this code thinks it
 * means.
 *
 * 1 → 2 (F-100, 2026-09-12). Version 1 stood through F-51, F-66, F-80,
 * F-96, F-98, F-99, Q-01, Q-03 and Q-04, each of which changed a stage and
 * each of which paid for that with a back-compat shim in `runPipeline.ts`:
 * two legacy spellings of the D5 gate in the sourcing trace, a whole-Foray
 * `stitch` key nothing had written since F-66, and the per-slot
 * `narrate:<i>:<slot>` keys nothing had written since Q-03. Those shims are
 * deleted with this bump. They were reading files that, in practice, do not
 * exist: a checkpoint is fingerprinted to ONE prompt and ONE output
 * directory and is deleted the moment that candidate is written
 * (`checkpointStore.ts`'s `discard`), so the only file a shim could ever
 * have helped is a failed run of a pre-Q-03 build of the pipeline, in a
 * directory nobody has cleaned, resumed against a prompt that has not
 * changed. Rejecting such a file costs one re-run; half-understanding it
 * costs a Foray that silently mixes two builds' output.
 *
 * VERSION 3 (Q-07, 2026-09-13): the spine now carries an `overview` — the
 * prelude's second half, the few sentences the listener hears before
 * anything else. `SpineSchema` is `.strict()` and the field is REQUIRED, so
 * a version-2 spine banked by an earlier build cannot parse. No shim, per
 * the deck's §5: a resumed run under the old file would build a Foray whose
 * first item is half missing, and re-running the spine stage costs one call.
 */
export const CHECKPOINT_VERSION = 3;

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
  /** gen-12: forgets banked stages, so the next run redoes them. Optional: a
   * store without it simply keeps the file (the in-process fence in
   * CheckpointSession still stops this run from re-banking them). */
  drop?(key: string, stages: CheckpointStageKey[]): Promise<void> | void;
}

/**
 * A stable identifier for the request a checkpoint belongs to.
 *
 * Everything that changes what a stage would produce goes in: the prompt, the
 * duration tier, and a pinned topic. The author id deliberately does NOT — two
 * founders generating the same prompt at the same duration are doing the same
 * work, and a run resumed under a different author still produces the same
 * Foray.
 *
 * GV-15 (decision 20): `variant` is `checkpointRunVariant(flags, routing)`
 * below (GV-55: `checkpointVariant(flags)` from `pipelineFlags.ts`, the
 * narration order and the local routing) — set only when a flag that changes
 * what a stage banks is on, or the run is routed off today's stages — so
 * banked runs never resume across modes. Without one (undefined
 * or empty) the hashed string is byte-identical to before, so a classic
 * run keeps its hash and CHECKPOINT_VERSION does not move. Both call sites
 * (the driver's FileCheckpointStore and the pipeline's session) must pass
 * the same variant, computed from the same merged flags.
 */
export function checkpointFingerprint(input: { prompt: string; duration: string; topic?: string | null; variant?: string }): string {
  /* `crypto` only — the other four stub builders in this directory import it
     the same way. Note what is NOT imported here: nothing that can write. The
     §9.4 no-persistence scan over this directory (`promptNoPersistence.test.ts`)
     is why the file half of this module lives in `src/cli/`. */
  const base = `${input.prompt}\n${input.duration}\n${input.topic ?? ""}`;
  return crypto
    .createHash("sha1")
    .update(input.variant ? `${base}\nvariant:${input.variant}` : base)
    .digest("hex")
    .slice(0, 12);
}

/**
 * GV-55 (decision 20): the routing part of the checkpoint variant, or
 * `undefined` when the run is on today's routing. A run is on today's routing
 * when its generation mode is `stub` or `anthropic-legacy` and no
 * FORAY_STAGE_* variable (or `--stage-provider`) overrode a stage; that keeps
 * every stub and legacy fingerprint byte-identical, so banked runs survive.
 *
 * In local mode, or with any stage overridden, it names every routed stage's
 * implementation, lane and model (in GENERATION_STAGES order, the table's own
 * key order), so a local run never resumes a Claude-built or differently
 * routed stage. Never a URL or a key: the table's routes carry neither.
 */
export function routingVariant(routing: RoutingTable | undefined): string | undefined {
  if (routing === undefined) return undefined;
  if (routing.mode !== "local" && routing.overridden.length === 0) return undefined;
  const stages = Object.entries(routing.routes).map(([stage, route]) => routeDescriptor(stage, route));
  return `routing=${routing.mode}:${stages.join(",")}`;
}

/** One routed stage as `routingVariant` spells it (`stage=provider@lane/model`,
 * with any fallback); the bare stage name when it has no route. */
function routeDescriptor(stage: string, route: RoutingTable["routes"][StageId]): string {
  if (route === undefined) return stage;
  const at = route.lane ? `@${route.lane}` : "";
  const fallback = route.fallback ? `>${route.fallback.provider}@${route.fallback.lane}/${route.fallback.model}` : "";
  return `${stage}=${route.provider}${at}/${route.model}${fallback}`;
}

/**
 * GV-55 (decision 20): THE checkpoint variant both call sites hash (the
 * driver's FileCheckpointStore and the pipeline's CheckpointSession), from the
 * same merged flags and the same routing table:
 *
 *     [checkpointVariant(flags), narration order, routingVariant(routing)]
 *       .filter(Boolean).join("|")
 *
 * The narration order joins it only when it is `sequential` (orchestrator's
 * follow-up to the wave 5/6 reviews): a resumed run can then never mix acts
 * narrated in order with acts narrated all at once, and today's `parallel`
 * adds nothing, so the classic fingerprint is unchanged. The part is the
 * value, not "differs from the default", so flipping the default later does
 * not move any banked file's fingerprint. Undefined when every part is.
 */
export function checkpointRunVariant(
  flags: Pick<PipelineFlags, "foldSpineCopy" | "foldDeepen" | "perActPipeline" | "narrationOrder">,
  routing?: RoutingTable
): string | undefined {
  const parts = [
    checkpointVariant(flags),
    flags.narrationOrder === "sequential" ? "narration=sequential" : undefined,
    routingVariant(routing)
  ].filter((p): p is string => Boolean(p));
  return parts.length ? parts.join("|") : undefined;
}

/* ---------------------------------------------------------------------------
 * GV-62 (W7-03): keep and fork checkpoints, so a stage-swap arm B reuses arm
 * A's banked upstream stages byte-for-byte and regenerates only from the
 * changed stage on. The pure half: the stage order, the cut, and the rule
 * that says whether a seed may be forked. The driver
 * (`src/cli/generateForays.ts`) reads and copies the files; nothing here
 * touches one (§9.4, see the header of this module).
 * ------------------------------------------------------------------------- */

/**
 * The stages `runForayPipeline` banks, in the order a run produces them.
 * `deepen`, `narrate` and `stitch` are banked per act (`deepen:0`,
 * `narrate:2`, ...) and match by the part before the first colon.
 *
 * `identity` sits AFTER `spine`: the post-spine topic fallback (F-91) can
 * take its topic from the spine, so a rerun from the spine must drop the
 * identity too. `test/checkpointFork.test.ts` scans `runPipeline.ts` and
 * fails when it banks a key whose stage is not listed here.
 */
export const CHECKPOINT_STAGE_ORDER = ["understand", "topic", "research-shape", "spine", "identity", "deepen", "source", "narrate", "stitch"] as const;
export type CheckpointStage = (typeof CHECKPOINT_STAGE_ORDER)[number];

export function isCheckpointStage(value: string): value is CheckpointStage {
  return (CHECKPOINT_STAGE_ORDER as readonly string[]).includes(value);
}

/** `deepen:3` -> `deepen`; a whole-stage key is its own stage. */
export function checkpointStageOf(key: CheckpointStageKey): string {
  const colon = key.indexOf(":");
  return colon < 0 ? key : key.slice(0, colon);
}

function stageIndexOrThrow(rerunFrom: string): number {
  const from = CHECKPOINT_STAGE_ORDER.indexOf(rerunFrom as CheckpointStage);
  if (from < 0) throw new Error(`unknown checkpoint stage "${rerunFrom}"; expected one of ${CHECKPOINT_STAGE_ORDER.join(", ")}`);
  return from;
}

/**
 * The keys of `keys` whose stage is `rerunFrom` or later, in their given
 * order: what a fork drops so the run redoes them. A key whose stage is not
 * in CHECKPOINT_STAGE_ORDER (a shape no current build banks) is dropped too:
 * redoing work costs time, while resuming something this code cannot place
 * in the order could hand a stage an output built on the wrong upstream.
 * Throws on an unknown `rerunFrom`.
 */
export function stagesAtOrAfter(keys: readonly CheckpointStageKey[], rerunFrom: string): CheckpointStageKey[] {
  const from = stageIndexOrThrow(rerunFrom);
  return keys.filter((key) => {
    const at = CHECKPOINT_STAGE_ORDER.indexOf(checkpointStageOf(key) as CheckpointStage);
    return at < 0 || at >= from;
  });
}

/**
 * The FIRST banked stage each routed stage (stageRouting.ts) can change. A
 * fork may change a stage's route only when the banked stage it feeds is at
 * or after `--rerun-from`, so everything that route built is rebuilt. Where
 * a route could reach more than one banked stage the earliest is named, so
 * the rule errs towards refusing a seed: the title is written by the
 * understander (`understand.title` names `understand`), and `judge` names
 * `source`, the earliest stage a support judge could serve.
 */
export const ROUTED_STAGE_FIRST_CHECKPOINT: Readonly<Record<StageId, CheckpointStage>> = {
  "understand.clarity": "understand",
  "understand.intent": "understand",
  "understand.title": "understand",
  research: "research-shape",
  spine: "spine",
  "spine-alt": "spine",
  deepen: "deepen",
  writer: "narrate",
  verifier: "narrate",
  continuity: "stitch",
  judge: "source"
};

/**
 * What a kept bench checkpoint records about the run that built it, so a
 * later arm can tell whether its banked stages may be forked. Needed because
 * GV-55 put the routing in the fingerprint: an arm that routes one stage
 * differently has a different fingerprint, and an exact match alone would
 * refuse every lane or model swap. Never the prompt (only its hash) and
 * never a URL or a key (routes carry neither).
 */
export const CheckpointForkStampSchema = z.object({
  /** checkpointFingerprint with no variant: the prompt, duration and topic. */
  request: z.string(),
  /** checkpointRunVariant without the routing: the semantics-changing flags
   * and the narration order (null when none is on). */
  flags: z.string().nullable(),
  /** Per routed stage, its route as `routingVariant` spells it. */
  routes: z.record(z.string())
});
export type CheckpointForkStamp = z.infer<typeof CheckpointForkStampSchema>;

export function checkpointForkStamp(input: {
  prompt: string;
  duration: string;
  topic?: string | null;
  flags: Pick<PipelineFlags, "foldSpineCopy" | "foldDeepen" | "perActPipeline" | "narrationOrder">;
  routing: RoutingTable;
}): CheckpointForkStamp {
  const routes: Record<string, string> = {};
  for (const [stage, route] of Object.entries(input.routing.routes)) routes[stage] = routeDescriptor(stage, route);
  return {
    request: checkpointFingerprint({ prompt: input.prompt, duration: input.duration, topic: input.topic }),
    flags: checkpointRunVariant(input.flags) ?? null,
    routes
  };
}

/**
 * Why a seed checkpoint may NOT be forked into this run, or null when it may.
 *
 *   - its `version` is not CHECKPOINT_VERSION: refused (half-understood);
 *   - its fingerprint is this run's: accepted (same request, flags and
 *     routing);
 *   - otherwise it must carry a fork stamp (`--keep-checkpoints` writes one)
 *     for the same request and the same flags, and every routed stage whose
 *     route differs must feed a banked stage at or after `rerunFrom`, so no
 *     kept stage was built by a route this run would not use.
 *
 * Throws on an unknown `rerunFrom`.
 */
export function forkSeedRefusal(
  seed: { version: number; fingerprint: string; fork?: unknown },
  run: { fingerprint: string; stamp: CheckpointForkStamp },
  rerunFrom: string
): string | null {
  const from = stageIndexOrThrow(rerunFrom);
  if (seed.version !== CHECKPOINT_VERSION) return `checkpoint version ${seed.version}, this build reads ${CHECKPOINT_VERSION}`;
  if (seed.fingerprint === run.fingerprint) return null;
  const parsed = CheckpointForkStampSchema.safeParse(seed.fork);
  if (!parsed.success) return "its fingerprint differs and it carries no fork stamp";
  const stamp = parsed.data;
  if (stamp.request !== run.stamp.request) return "built for a different prompt, duration or topic";
  if (stamp.flags !== run.stamp.flags) return `built under other pipeline flags (${stamp.flags ?? "none"}; this run ${run.stamp.flags ?? "none"})`;
  const stages = [...new Set([...Object.keys(stamp.routes), ...Object.keys(run.stamp.routes)])];
  for (const stage of stages) {
    const seedRoute = stamp.routes[stage];
    const runRoute = run.stamp.routes[stage];
    if (seedRoute === runRoute) continue;
    /* A routed stage this build does not know feeds, for all this code can
       tell, the very first banked stage. */
    const feeds: CheckpointStage = Object.prototype.hasOwnProperty.call(ROUTED_STAGE_FIRST_CHECKPOINT, stage)
      ? ROUTED_STAGE_FIRST_CHECKPOINT[stage as StageId]
      : CHECKPOINT_STAGE_ORDER[0];
    if (CHECKPOINT_STAGE_ORDER.indexOf(feeds) < from) {
      return `stage ${stage} is routed differently (${seedRoute ?? "unrouted"}; this run ${runRoute ?? "unrouted"}) and feeds ${feeds}, before --rerun-from ${rerunFrom}`;
    }
  }
  return null;
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
  /** gen-12: keys dropped this run; a later save of a matching key (an act
   * still narrating when the drop happened) is not banked either. */
  private fence: ((name: CheckpointStageKey) => boolean) | null = null;

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

  /**
   * Whether a key is banked at all, WITHOUT resuming it — no parse, and the
   * stage is not marked resumed. For a caller that only wants to know
   * whether work downstream will be needed (G-35's evidence prefetch skips
   * the slots a resumed run will never narrate again); the resume itself,
   * with its re-validation, still goes through `stage`/`resumeSync`.
   */
  has(name: CheckpointStageKey): boolean {
    return Object.prototype.hasOwnProperty.call(this.stages, name);
  }

  /** Persists one unit of work under its own key. Pairs with `resumeSync`. */
  async save(name: CheckpointStageKey, value: unknown): Promise<void> {
    await this.record(name, value);
  }

  /** Whether this run resumed `name` from disk rather than producing it. */
  wasResumed(name: CheckpointStageKey): boolean {
    return this.resumedStages.has(name);
  }

  /**
   * gen-12 (round-3 audit): forget every banked stage `match` selects, in
   * memory and in the store, and refuse to bank a matching stage for the rest
   * of this run. Used when a resumed stage turns out to be stale against the
   * world (a resumed `source` whose minted rows now collide with the pool):
   * without it every later resume replays the same banked sourcing and fails
   * the same way until someone runs with --no-resume.
   */
  async drop(match: (name: CheckpointStageKey) => boolean): Promise<CheckpointStageKey[]> {
    const previous = this.fence;
    this.fence = previous ? (name) => previous(name) || match(name) : match;
    const dropped = Object.keys(this.stages).filter(match);
    for (const name of dropped) {
      delete this.stages[name];
      this.resumedStages.delete(name);
    }
    if (this.store?.drop && dropped.length > 0) {
      try {
        await this.store.drop(this.key, dropped);
      } catch {
        /* Same rule as record(): checkpoint I/O never fails the run. */
      }
    }
    return dropped;
  }

  private async record(name: CheckpointStageKey, value: unknown): Promise<void> {
    if (this.fence?.(name)) return;
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
