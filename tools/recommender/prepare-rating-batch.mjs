/* RV-08 (docs/roadmap/recommender-v1.md, D1, D7, D9; issue #1380): the
   deterministic half of the persona-rating loop.

   Picks the next N shows of the gold set that still need rating at a pass,
   builds their evidence packs (tools/recommender/evidence.mjs, the only place
   show text is assembled, D10), writes ONE batch file a Claude Code agent rates
   from, and reserves the shows in data/recommender/rating-progress.json through
   tools/recommender/progress.mjs (the only writer of that file, D10). Nothing
   here calls a model, Anthropic or the network: the agent reads the batch file
   and writes a results file (RV-10), and merge-rating-results.mjs (RV-09)
   validates it, the tools/classify/ pattern (D1).

     node tools/recommender/prepare-rating-batch.mjs --role pilot|gold
       [--set data/recommender/gold-set.json] [--pass 1|2|3]
       [--mode joint | isolated:<persona_id>] [--batch-size 20]
       [--shard i/n] [--only retest|isolated|holdout] [--dry-run]
       [--progress PATH] [--profiles PATH] [--batches-dir DIR]

   SELECTION. A show is eligible when its `roles` (RV-07's gold-set.json rows:
   `{ show_key, title, strata, roles }`) hold `--role`, it is not yet rated at
   this pass (`progress.rated[key].passes`), and it is not in flight
   (`reclaimStale` runs first, so a batch abandoned 12 h ago gives its shows
   back). Pass 2 and 3 take only `retest` shows, and only once the previous
   pass is recorded (a retest re-rates a show it already rated, D13). An
   `isolated:<id>` batch takes only `isolated` shows. `--only` narrows to one
   more role. `--shard i/n` keeps the shows with `fnv1a32(show_key) % n === i`
   (`shardOf` from tools/classify/labels.mjs), so n shard runs partition the
   set. Shows are taken in gold-set order (RV-07 already shuffled it); a show
   whose evidence tier is `none` is never rated (D3) and is skipped, unreserved.

   ISOLATED PROGRESS KEYS. Isolated batches rate shows a joint pass already
   rated, once per persona, so they cannot share the joint key: their
   reservations and pass records live under `<show_key>@isolated:<persona_id>`
   (`progressKey`). Thirteen personas' isolated batches over the same 40 shows
   can then run side by side, and none of them blocks or satisfies a joint pass.

   THE BATCH FILE (data-local/recommender/batches/rating-batch-<batch_id>.json,
   never committed):
     { batch_id, rubric_version, rubric_path, profiles_path, profiles_sha256,
       mode, pass, persona_order: { <show_key>: [persona ids] }, shows: [packs] }
   `batch_id` is `<role>-<pass>-<mode>-<YYYYMMDD>-<hash8>`; the colon of an
   isolated mode is written as a dash so the id is a legal Windows file name.
   The rubric and the persona profiles are referenced by repo path and the
   profiles by sha256, not copied: the agent reads the committed files, and
   copies `profiles_sha256` into its results so the merge can refuse a results
   file rated against other profiles. Every pack is `raterPack(buildEvidence())`
   (the audit-only `stripped` list removed, D7). Packs are position-shuffled
   and each show's persona list is shuffled, both seeded by the batch id (D7:
   no position bias the same way twice), so a batch rebuilt from the same
   inputs is byte-identical. An `isolated:<id>` batch lists only that persona.

   Prints the batch path and a token estimate (serialised chars / 4, D9).
   `--dry-run` reports the same and writes and reserves nothing.

   The progress file's load -> reclaim -> reserve -> save runs under
   progress.mjs's withProgressLock, so a prepare can overlap merges without
   overwriting their pass records (RV-13). */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isEntryScript } from "../ci/entry.mjs";
import { parseShard, shardOf } from "../classify/labels.mjs";
import { rng } from "../segments/rank-breadth.mjs";
import { buildEvidence, loadSources, raterPack } from "./evidence.mjs";
import { LOCK_WAIT_MS, loadProgress, reclaimStale, reserve, saveProgress, withProgressLock } from "./progress.mjs";
import { RUBRIC_VERSION, MAX_PASS } from "./schema.mjs";

const REPO_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "../..");

export const ROLES = Object.freeze(["pilot", "gold"]);
export const ONLY_ROLES = Object.freeze(["retest", "isolated", "holdout"]);
export const DEFAULT_BATCH_SIZE = 20;
export const DEFAULTS = Object.freeze({
  set: "data/recommender/gold-set.json",
  progress: "data/recommender/rating-progress.json",
  profiles: "data/recommender/persona-profiles.json",
  rubric: "docs/curation/rating-rubric-v1.md",
  batchesDir: "data-local/recommender/batches",
});

const USAGE =
  "usage: node tools/recommender/prepare-rating-batch.mjs --role pilot|gold [--set PATH] [--pass 1|2|3] " +
  "[--mode joint|isolated:<persona_id>] [--batch-size 20] [--shard i/n] [--only retest|isolated|holdout] [--dry-run] " +
  "[--progress PATH] [--profiles PATH] [--batches-dir DIR]";

export class UsageError extends Error {}

/* ---------------------------------------------------------------- args */

export function parseArgs(argv) {
  const args = { set: null, role: null, pass: 1, mode: "joint", batchSize: DEFAULT_BATCH_SIZE, shard: null, only: null, dryRun: false, progress: null, profiles: null, batchesDir: null };
  const value = (i, flag) => {
    if (i >= argv.length || String(argv[i]).startsWith("--")) throw new UsageError(`${flag} needs a value; ${USAGE}`);
    return argv[i];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--set") args.set = value(++i, a);
    else if (a === "--role") args.role = value(++i, a);
    else if (a === "--pass") args.pass = Number(value(++i, a));
    else if (a === "--mode") args.mode = value(++i, a);
    else if (a === "--batch-size") args.batchSize = Number(value(++i, a));
    else if (a === "--shard") {
      try {
        args.shard = parseShard(value(++i, a));
      } catch (e) {
        throw new UsageError(e.message);
      }
    } else if (a === "--only") args.only = value(++i, a);
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--progress") args.progress = value(++i, a);
    else if (a === "--profiles") args.profiles = value(++i, a);
    else if (a === "--batches-dir") args.batchesDir = value(++i, a);
    else throw new UsageError(`unknown argument ${a}; ${USAGE}`);
  }
  if (!ROLES.includes(args.role)) throw new UsageError(`--role must be one of ${ROLES.join("|")}; ${USAGE}`);
  if (!Number.isInteger(args.pass) || args.pass < 1 || args.pass > MAX_PASS) throw new UsageError(`--pass must be 1-${MAX_PASS}; ${USAGE}`);
  if (!(args.mode === "joint" || /^isolated:[a-z0-9]+(?:-[a-z0-9]+)*$/.test(args.mode))) throw new UsageError(`--mode must be joint or isolated:<persona_id>; ${USAGE}`);
  if (!Number.isInteger(args.batchSize) || args.batchSize < 1) throw new UsageError(`--batch-size must be a positive integer; ${USAGE}`);
  if (args.only !== null && !ONLY_ROLES.includes(args.only)) throw new UsageError(`--only must be one of ${ONLY_ROLES.join("|")}; ${USAGE}`);
  return args;
}

/* ------------------------------------------------------------ helpers */

/** The isolated persona of a mode, or null for joint. */
export function isolatedPersona(mode) {
  return typeof mode === "string" && mode.startsWith("isolated:") ? mode.slice("isolated:".length) : null;
}

/** The progress-file key a show is reserved and recorded under for `mode`:
    the show key for joint batches, `<show_key>@isolated:<persona_id>` for
    isolated ones (see the header). */
export function progressKey(showKey, mode = "joint") {
  const pid = isolatedPersona(mode);
  return pid ? `${showKey}@isolated:${pid}` : String(showKey);
}

/** Fisher-Yates over a copy of `list`, seeded (rng from rank-breadth.mjs). */
export function seededShuffle(list, seed) {
  const next = rng(seed);
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** The persona list one show's rater sees: shuffled per show, seeded by the
    batch id and the show key, so it differs between shows and is stable for
    a batch id. */
export function personaOrder(personaIds, batchId, showKey) {
  return seededShuffle(personaIds, `${batchId}|${showKey}`);
}

const yyyymmdd = (now) => new Date(now instanceof Date ? now.getTime() : Number(now)).toISOString().slice(0, 10).replace(/-/g, "");

/** `<role>-<pass>-<mode>-<YYYYMMDD>-<hash8>`; the hash covers the chosen keys
    and the shard, so a rebuild of the same selection gets the same id. */
export function batchIdOf({ role, pass, mode, now, keys, shard = null }) {
  const hash = createHash("sha256")
    .update(JSON.stringify({ role, pass, mode, keys: [...keys].sort(), shard: shard ? `${shard.index}/${shard.count}` : null }))
    .digest("hex")
    .slice(0, 8);
  return `${role}-${pass}-${String(mode).replace(/:/g, "-")}-${yyyymmdd(now)}-${hash}`;
}

/** Candidate show keys, in set order, that this pass may rate (before the
    evidence-tier check). Pure. */
export function eligibleShows(set, progress, { role, pass = 1, mode = "joint", only = null, shard = null }) {
  const pid = isolatedPersona(mode);
  const out = [];
  const seen = new Set();
  for (const row of set?.shows ?? []) {
    const key = row && row.show_key != null ? String(row.show_key) : null;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const roles = Array.isArray(row.roles) ? row.roles : [];
    if (!roles.includes(role)) continue;
    if (pass > 1 && !roles.includes("retest")) continue;
    if (pid && !roles.includes("isolated")) continue;
    if (only && !roles.includes(only)) continue;
    if (shard && shardOf(key, shard.count) !== shard.index) continue;
    const pk = progressKey(key, mode);
    if (Object.prototype.hasOwnProperty.call(progress.in_flight, pk)) continue;
    const passes = Array.isArray(progress.rated[pk]?.passes) ? progress.rated[pk].passes : [];
    if (passes.includes(pass)) continue;
    if (pass > 1 && !passes.includes(pass - 1)) continue;
    out.push(key);
  }
  return out;
}

/** sha256 of the profiles file's bytes, lowercase hex. */
export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const repoPath = (root, p) => {
  const rel = relative(root, p);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel.split(sep).join("/") : p;
};

/**
 * Builds one batch in memory and reserves its keys on `progress` (mutated).
 * Returns `{ batch, batchId, keys, skippedNone, reclaimed }`, or `batch: null`
 * when nothing is eligible. Throws when the isolated persona is unknown.
 */
export function prepareBatch({ set, progress, profilesDoc, profilesSha256, profilesPath, rubricPath, sources, role, pass = 1, mode = "joint", only = null, shard = null, batchSize = DEFAULT_BATCH_SIZE, now }) {
  const personaIds = (profilesDoc?.personas ?? []).map((p) => p.id);
  if (!personaIds.length) throw new Error("the persona profiles list no personas");
  const pid = isolatedPersona(mode);
  if (pid && !personaIds.includes(pid)) throw new Error(`--mode isolates "${pid}", which is not a persona in ${profilesPath}`);

  const reclaimed = reclaimStale(progress, now);
  const candidates = eligibleShows(set, progress, { role, pass, mode, only, shard });

  const packs = [];
  const skippedNone = [];
  for (const key of candidates) {
    if (packs.length >= batchSize) break;
    const pack = buildEvidence(key, sources);
    if (pack.tier === "none") {
      skippedNone.push(key);
      continue;
    }
    packs.push(raterPack(pack));
  }
  if (!packs.length) return { batch: null, batchId: null, keys: [], skippedNone, reclaimed };

  const keys = packs.map((p) => p.show_key);
  const batchId = batchIdOf({ role, pass, mode, now, keys, shard });
  const listed = pid ? [pid] : personaIds;
  const persona_order = {};
  for (const key of [...keys].sort()) persona_order[key] = personaOrder(listed, batchId, key);

  const batch = {
    batch_id: batchId,
    rubric_version: RUBRIC_VERSION,
    rubric_path: rubricPath,
    profiles_path: profilesPath,
    profiles_sha256: profilesSha256,
    mode,
    pass,
    persona_order,
    shows: seededShuffle(packs, batchId),
  };
  reserve(progress, keys.map((k) => progressKey(k, mode)), batchId, now);
  return { batch, batchId, keys, skippedNone, reclaimed };
}

/** Chars / 4 of the serialised batch (D9's estimate unit). */
export function tokenEstimate(serialised) {
  return Math.ceil(serialised.length / 4);
}

function writeAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

/* --------------------------------------------------------------------- CLI */

export function main(argv = process.argv.slice(2), { root = REPO_ROOT, env = process.env, now = Date.now(), log = console.log, error = console.error, lockWaitMs = LOCK_WAIT_MS } = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      error(e.message);
      return 2;
    }
    throw e;
  }
  const at = (flag, def) => (flag ? resolvePath(process.cwd(), flag) : resolvePath(root, def));
  const setPath = at(args.set, DEFAULTS.set);
  const progressPath = at(args.progress, DEFAULTS.progress);
  const profilesPath = at(args.profiles, DEFAULTS.profiles);
  const batchesDir = at(args.batchesDir, DEFAULTS.batchesDir);
  if (!existsSync(setPath)) {
    error(`no gold set at ${setPath}; run tools/recommender/sample.mjs first (RV-07)`);
    return 1;
  }

  const set = JSON.parse(readFileSync(setPath, "utf8"));
  const profilesDoc = JSON.parse(readFileSync(profilesPath, "utf8"));
  /* The catalogue loads before the lock (it is the slow part); the whole
     load -> reserve -> save of the progress file runs under the lock, so a
     merge that rewrote the file in between is never overwritten (RV-13). */
  let sources;
  try {
    sources = loadSources({ root, env });
  } catch (e) {
    error(e.message);
    return 1;
  }
  const prepareLocked = () => {
    const progress = loadProgress(progressPath);
    let out;
    try {
      out = prepareBatch({
        set,
        progress,
        profilesDoc,
        profilesSha256: sha256File(profilesPath),
        profilesPath: repoPath(root, profilesPath),
        rubricPath: DEFAULTS.rubric,
        sources,
        role: args.role,
        pass: args.pass,
        mode: args.mode,
        only: args.only,
        shard: args.shard,
        batchSize: args.batchSize,
        now,
      });
    } catch (e) {
      error(e.message);
      return 1;
    }

    for (const k of out.skippedNone) log(`skipped ${k}: evidence tier none (never rated, D3)`);
    if (!out.batch) {
      log(`nothing to rate: no ${args.role} show is unrated at pass ${args.pass} (${args.mode}${args.only ? `, --only ${args.only}` : ""}${args.shard ? `, shard ${args.shard.index}/${args.shard.count}` : ""}) and not in flight`);
      if (!args.dryRun && out.reclaimed.length) saveProgress(progressPath, progress);
      return 0;
    }
    const text = `${JSON.stringify(out.batch, null, 2)}\n`;
    const batchPath = join(batchesDir, `rating-batch-${out.batchId}.json`);
    const summary = `${out.keys.length} shows, ~${tokenEstimate(text)} tokens (chars / 4)`;
    if (args.dryRun) {
      log(`dry run: would write ${batchPath} (${summary}) and reserve: ${out.keys.join(", ")}`);
      return 0;
    }
    writeAtomic(batchPath, text);
    saveProgress(progressPath, progress);
    log(`${batchPath} (${summary})`);
    return 0;
  };
  try {
    return withProgressLock(progressPath, prepareLocked, { waitMs: lockWaitMs });
  } catch (e) {
    if (e.code !== "progress_locked") throw e;
    error(e.message);
    return 1;
  }
}

if (isEntryScript(import.meta.url)) process.exitCode = main();
