/* swap-experiment.mjs — the stage-swap experiment runner: plan, run, collect,
 * decide (GV-75, from W7-04 with W2-16's run step; covers R2-21 and GP-27).
 *
 * WHAT IT IS FOR (docs/roadmap/generation-v2.md, card GV-75; #1286)
 * A stage swap (deepen on the second box instead of the Spark) or a lever
 * trial is decided from two arms of the same golden prompts (decision 19):
 * arm A, the adopted all-local stack, and arm B, the same stack with ONE
 * stage's lane, model or lever changed. This tool makes each experiment a
 * reproducible command set that ends in a ledger row:
 *
 *   plan <spec>                prints both arms' environment and driver command
 *   run <spec> [--dry-run]     executes the planned arms through an injected
 *                              spawn (the driver named by backend/package.json)
 *   collect <spec>             reads both arms' report.json, refuses arms that
 *                              did not run what the spec says, builds the
 *                              scorecard and timing deltas and the sealed blind
 *                              pairs, and writes data-local/swaps/<id>/evidence.json
 *   decide <spec> --cards <jsonl>
 *                              unseals the founder's cards, applies decideSwap
 *                              (swap-rule.mjs), appends the ledger row, re-renders
 *                              docs/curation/model-swaps.md and, on adopt, prints
 *                              the adopted-stack.json diff (a person commits it)
 *
 * THE TOOL NEVER CALLS A MODEL. `run` starts the generation driver, which is
 * what talks to the lanes; the tool itself reads files, writes files under
 * data-local/ and the ledger, and spawns only through the function it is
 * handed. A structural test greps this file for any network use.
 *
 * ZERO ANTHROPIC (GV-68, the founder's rule; docs/roadmap/generation-v2.md
 * "Constraints"). Every arm sets FORAY_GENERATION_MODE=local and EVERY stage
 * of the backend's GENERATION_STAGES list as an explicit FORAY_STAGE_*, so no
 * stage can fall back to a default the backend picks. FORAY_ALLOW_ANTHROPIC_LEGACY
 * is never set and is stripped (with ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL)
 * from the environment `run` inherits. A spec whose arms name 'anthropic' or
 * 'claude' is refused at plan time, and `run` re-checks each arm's final
 * environment before anything is spawned. The backend's own double opt-in
 * (stageRouting.ts) is the second wall; this tool does not re-implement its
 * id parsing, it only splits `impl[:lane]` to know what to expect back.
 *
 * THE STAGE LIST IS THE BACKEND'S. GENERATION_STAGES (config/stageRouting.ts),
 * LANE_IDS (config/machineProfiles.ts), CHECKPOINT_STAGE_ORDER and
 * ROUTED_STAGE_FIRST_CHECKPOINT (generation/checkpoint.ts) are read from the
 * TypeScript sources at run time, never counted by hand: a plain `node` tool
 * cannot import those modules (they import extensionless siblings), so the
 * exported literals are parsed, and the parse refuses anything but a list of
 * string literals. A stage added to the backend is a stage every arm must set.
 *
 * AN EXPERIMENT SPEC (tools/generation-bench/swaps/experiments/<id>.json)
 *   { id, kind: "stage" | "lever" | "measure", stage?, lever?,
 *     armA: "adopted" | "reference" | { env },
 *     armB: { env },                     // overrides on arm A's environment
 *     rerunFrom: <checkpoint stage> | null,
 *     golden: "<repo-relative manifest>",
 *     expect?: { stageAssignments?: { <stage>: { impl, machine?, model? } }, levers? },
 *     notes? }
 * - "adopted" is the E0 floor stack (E0-floor.json's arm B: every stage on
 *   Qwen on the Spark, research 'none', every lever off) overlaid with
 *   swaps/adopted-stack.json. The adopted stack starts empty (nothing has been
 *   measured), so until a stage is adopted arm A IS the floor; each later
 *   experiment starts from whatever the earlier ones adopted (model-swaps.md).
 * - "reference" is E0 only (kind 'measure'): arm A is not generated, it is the
 *   committed Claude-written Foray each listened golden prompt names
 *   (reference.kind "forays-json", read from data/forays.json, read only).
 * - Env keys are FORAY_* only. The tool owns FORAY_GENERATION_MODE and never
 *   sets FORAY_ALLOW_ANTHROPIC_LEGACY; endpoint and key variables (FORAY_LLM_*,
 *   anything named KEY, TOKEN, SECRET or PASSWORD) come from the operator's
 *   shell and are refused in a spec. A `local` route must name its lane.
 * - kind 'stage': arm B differs from arm A in exactly the spec's stage. kind
 *   'lever': the stages are identical and some non-stage FORAY_* differs.
 * - rerunFrom: arm B is seeded from arm A's kept checkpoints (GV-62) and
 *   rebuilds from this checkpoint stage. It may not be later than the first
 *   banked stage the changed route feeds (ROUTED_STAGE_FIRST_CHECKPOINT), or
 *   arm B would resume work arm A's route built.
 *
 * COLLECT REFUSES RATHER THAN GUESSES
 * - Every row of both reports must carry the stageAssignments the plan
 *   implies (impl and machine per stage, plus spec.expect for arm B) and,
 *   when spec.expect.levers is set, matching `levers`: arm B the spec's
 *   values (an object value names the fields the row's record must carry,
 *   so GV-99's { mode: "on" } matches { mode, exemplarIds, fileSha }; any
 *   other value must equal the record), arm A each named lever on or off as
 *   planned (absent = off). An
 *   unimplemented flag, or a lever flag leaking into arm A, could otherwise
 *   make arm B silently equal arm A. `run` drops every inherited lever flag an
 *   arm leaves unset, and the printed commands unset it (env -u).
 * - A row that sent an Anthropic request (anthropicCalls > 0) refuses the
 *   collection. Two arms run on different prompt sets or different corpus
 *   fingerprints are not a pair and are refused.
 * - A pair whose arm B is unseeded (seededFrom null) while rerunFrom is set
 *   is dropped and listed, never compared.
 * - Timing deltas cover the changed stage's banked stage and every later one,
 *   from veracity.stageTimings; a stage that was resumed in either arm is
 *   marked resumed and compared in neither.
 * - With no corpus fingerprint in both reports the evidence is 'unfrozen', so
 *   decideSwap can only hold, reject or measure (swap-rule.mjs).
 *
 * THE SEAL. collect calls the blind-pack builder (tools/listening/pack.mjs,
 * GV-36) for every listened prompt: act 1 of arm A and arm B, labelled by a
 * random seed, the key written to data-local/listening/keys and never
 * printed. Arm A's key entry carries stageSwap "baseline" (or "reference" for
 * E0) and arm B's carries the experiment id; decide maps labels back through
 * those and refuses a card whose pack is not this experiment's or a key whose
 * prompt, act, arms or candidates do not match the evidence.
 *
 * LIVE STEP (not run by any test or agent; decision 31 forbids batch local
 * generation until the unit caps GV-90 and the lane scheduler GV-93 land):
 * on a machine with the LiteLLM and Jev keys and data-local transcripts, run
 * the printed arm commands, let the founder listen to the sealed pairs, then
 * `decide`. E0 first: it answers GP-27 with a number.
 */

import crypto from "node:crypto";
import { spawn as spawnChild } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isEntryScript } from "../ci/entry.mjs";
import { parseCards } from "../listening/card.mjs";
import { buildPack, loadPools, writePack } from "../listening/pack.mjs";
import { DEFAULT_KEY_DIR, loadKeys, unseal } from "../listening/unseal.mjs";
import {
  GOLDEN_BANDS,
  candidatePathFor,
  compareGolden,
  goldenSummaries,
  loadGoldenManifest,
  percentile,
  rowFor,
  scorecardFor,
  spanMsOf
} from "./run.mjs";
import { referenceRow } from "./score.mjs";
import { DEFAULT_ADOPTED_STACK, DEFAULT_DOC, DEFAULT_LEDGER, LEVER_KEYS, appendLedgerRow, readLedger, spliceLedgerTable, validateAdoptedStack } from "./swap-ledger.mjs";
import { KINDS, SCORECARD_METRICS, decideSwap } from "./swap-rule.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..");
export const BACKEND_DIR = path.join(REPO_ROOT, "backend");
export const EXPERIMENTS_DIR = path.join(HERE, "swaps", "experiments");
/** Where arm outputs and evidence live, relative to the root: gitignored. */
export const SWAPS_OUT = "data-local/swaps";
/** The spec whose arm B is the floor stack every 'adopted' arm starts from. */
export const FLOOR_SPEC_ID = "E0-floor";

export const PLAN_SCHEMA = "swap-plan/1";
export const EVIDENCE_SCHEMA = "swap-evidence/1";

/** The stageSwap label each arm's pack key carries. */
export const BASELINE_LABEL = "baseline";
export const REFERENCE_LABEL = "reference";

/** The act a pair is heard on (R2-21: act 1 of both arms). */
export const LISTEN_ACT = 1;

/** Lever -> the backend flag that switches it and that flag's on and off
 * values. Only levers whose flag exists are mapped (decision 17 names
 * FORAY_WRITER_EXEMPLARS; GV-99 defines it as off|on, read through
 * generationFlags.readEnumFlag, which throws on any other value such as "1").
 * An adopted stack that turns on an unmapped lever is refused until its card
 * adds the mapping.
 *
 * GV-124 (#1413 item 5): spineBestOf is FORAY_SPINE_BEST_OF (1|2, GV-91's
 * pipelineFlags.ts). Under 2 the backend also requires FORAY_SPINE_JUDGE and
 * reads FORAY_SPINE_BEST_OF_GRACE_MS, so its adopted value is the lever as the
 * report records it ({ mode: "best-of-2", judge, graceMs }): `companions`
 * maps that record's fields to their variables, and `requires` names the
 * fields an adopted stack must give. */
export const LEVER_ENV = Object.freeze({
  exemplars: Object.freeze({ name: "FORAY_WRITER_EXEMPLARS", on: "on", off: "off" }),
  spineBestOf: Object.freeze({
    name: "FORAY_SPINE_BEST_OF",
    on: "2",
    off: "1",
    companions: Object.freeze({ judge: "FORAY_SPINE_JUDGE", graceMs: "FORAY_SPINE_BEST_OF_GRACE_MS" }),
    requires: Object.freeze(["judge"])
  })
});

export const MODE_ENV = "FORAY_GENERATION_MODE";
export const ALLOW_LEGACY_ENV = "FORAY_ALLOW_ANTHROPIC_LEGACY";
/** Stripped from the environment `run` inherits, never set. */
export const STRIPPED_ENV = Object.freeze([ALLOW_LEGACY_ENV, "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"]);

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const ENV_KEY_RE = /^FORAY_[A-Z0-9_]+$/;
const SECRET_KEY_RE = /KEY|TOKEN|SECRET|PASSWORD/;
const FORBIDDEN_RE = /anthropic|claude/i;
const SPEC_KEYS = Object.freeze(["id", "kind", "stage", "lever", "armA", "armB", "rerunFrom", "golden", "expect", "notes"]);

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isText = (v) => typeof v === "string" && v.trim() !== "";
const toPosix = (p) => p.split(path.sep).join("/");

/* ------------------------------------------------------------------ */
/* The backend's lists, read from its sources                          */
/* ------------------------------------------------------------------ */

/** The string items of `export const <name>[: type] = [ ... ]` in `source`.
 * Throws when the export is missing or its list holds anything but string
 * literals (a spread or an identifier would be silently dropped otherwise). */
export function parseConstList(source, name) {
  const m = source.match(new RegExp(`export const ${name}(?:\\s*:[^=]+)?\\s*=\\s*\\[([^\\]]*)\\]`));
  if (!m) throw new Error(`cannot find "export const ${name} = [...]"`);
  if (m[1].replace(/"[^"\n]*"/g, "").replace(/[\s,]/g, "") !== "") throw new Error(`${name} is not a plain list of string literals`);
  const items = [...m[1].matchAll(/"([^"\n]*)"/g)].map((x) => x[1]);
  if (items.length === 0) throw new Error(`${name} is empty`);
  return items;
}

/** The `"key": "value"` entries of `export const <name>[: type] = { ... }`. */
export function parseConstMap(source, name) {
  const m = source.match(new RegExp(`export const ${name}(?:\\s*:[^=]+)?\\s*=\\s*\\{([^}]*)\\}`));
  if (!m) throw new Error(`cannot find "export const ${name} = {...}"`);
  const out = {};
  const rest = m[1].replace(/(?:"([^"\n]+)"|([A-Za-z_][\w]*))\s*:\s*"([^"\n]+)"/g, (_, quoted, bare, value) => {
    out[quoted ?? bare] = value;
    return "";
  });
  if (rest.replace(/[\s,]/g, "") !== "") throw new Error(`${name} is not a plain map of string literals`);
  return out;
}

export const CONTRACT_FILES = Object.freeze({
  routing: "backend/src/config/stageRouting.ts",
  lanes: "backend/src/config/machineProfiles.ts",
  checkpoint: "backend/src/generation/checkpoint.ts"
});

/** { stages, lanes, checkpointOrder, firstCheckpoint } from the backend sources
 * under `repoRoot`. */
export function loadBackendContract(repoRoot = REPO_ROOT) {
  const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), "utf8");
  const routing = read(CONTRACT_FILES.routing);
  const checkpoint = read(CONTRACT_FILES.checkpoint);
  const contract = {
    stages: parseConstList(routing, "GENERATION_STAGES"),
    lanes: parseConstList(read(CONTRACT_FILES.lanes), "LANE_IDS"),
    checkpointOrder: parseConstList(checkpoint, "CHECKPOINT_STAGE_ORDER"),
    firstCheckpoint: parseConstMap(checkpoint, "ROUTED_STAGE_FIRST_CHECKPOINT")
  };
  for (const stage of contract.stages) {
    if (!contract.checkpointOrder.includes(contract.firstCheckpoint[stage])) {
      throw new Error(`ROUTED_STAGE_FIRST_CHECKPOINT has no checkpoint stage for "${stage}"`);
    }
  }
  return contract;
}

/** FORAY_STAGE_<STAGE>, spelled as stageRouting.ts stageEnvVar spells it
 * (dots and dashes become underscores). */
export function stageEnvVar(stage) {
  return `FORAY_STAGE_${stage.toUpperCase().replace(/[.-]/g, "_")}`;
}

/** `impl[:lane]` -> { impl, machine? }. Only the split: what the ids mean is
 * the backend's business, and it refuses an unknown one at run start. */
export function splitRoute(value) {
  const [impl, lane] = String(value).split(":");
  return lane === undefined ? { impl } : { impl, machine: lane };
}

/* ------------------------------------------------------------------ */
/* Specs                                                               */
/* ------------------------------------------------------------------ */

/** A spec path, or an id resolved in the experiments directory. */
export function specPathFor(target, experimentsDir = EXPERIMENTS_DIR) {
  if (/\.json$/i.test(target) || target.includes("/") || target.includes("\\")) return path.resolve(target);
  return path.join(experimentsDir, `${target}.json`);
}

export function readSpec(file) {
  let spec;
  try {
    spec = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`cannot read spec ${file}: ${err.message}`);
  }
  if (isPlainObject(spec) && spec.id !== path.basename(file, ".json")) {
    throw new Error(`spec ${file}: id "${spec.id}" must equal the file name`);
  }
  return spec;
}

function envErrors(env, where, contract) {
  const errors = [];
  if (!isPlainObject(env)) return [`${where} must be { env: { FORAY_*: value } }`];
  const stageVars = new Set(contract.stages.map(stageEnvVar));
  for (const [key, value] of Object.entries(env)) {
    if (FORBIDDEN_RE.test(key) || FORBIDDEN_RE.test(String(value))) {
      errors.push(`${where}.${key} names an Anthropic model or route; every arm is all-local (the generation pipeline makes zero Anthropic calls)`);
      continue;
    }
    if (!ENV_KEY_RE.test(key)) errors.push(`${where}.${key} is not a FORAY_* variable`);
    else if (key === MODE_ENV) errors.push(`${where}.${key} is set by the tool (always local), not by a spec`);
    else if (key.startsWith("FORAY_LLM_") || SECRET_KEY_RE.test(key)) errors.push(`${where}.${key} comes from the operator's shell, never from a spec`);
    else if (key.startsWith("FORAY_STAGE_") && !stageVars.has(key)) errors.push(`${where}.${key} is not a stage the backend routes`);
    if (typeof value !== "string" || value === "") errors.push(`${where}.${key} must be a non-empty string`);
    else if (key.startsWith("FORAY_STAGE_")) {
      const { impl, machine } = splitRoute(value);
      if (impl === "local" && machine === undefined) errors.push(`${where}.${key} routes to local without a lane; name it (local:<lane>)`);
      if (machine !== undefined && !contract.lanes.includes(machine)) errors.push(`${where}.${key} names lane "${machine}"; the lanes are ${contract.lanes.join(", ")}`);
    }
  }
  return errors;
}

/**
 * Check a spec's shape against the backend contract. Never throws; returns
 * every problem. Arm completeness and the one-change rule are checked when
 * the arms are built (planExperiment), because 'adopted' needs the stack.
 */
export function validateSpec(spec, contract) {
  const errors = [];
  if (!isPlainObject(spec)) return { ok: false, errors: ["a spec is a JSON object"] };
  for (const key of Object.keys(spec)) if (!SPEC_KEYS.includes(key)) errors.push(`unknown field "${key}"`);
  if (typeof spec.id !== "string" || !ID_RE.test(spec.id)) errors.push("id must be a short id (letters, digits, . _ -)");
  if (!KINDS.includes(spec.kind)) errors.push(`kind must be one of ${KINDS.join(", ")}`);
  if (spec.kind === "stage" && !contract.stages.includes(spec.stage)) errors.push(`a stage experiment names one of ${contract.stages.join(", ")}`);
  if (spec.kind === "lever" && !LEVER_KEYS.includes(spec.lever)) errors.push(`a lever experiment names one of ${LEVER_KEYS.join(", ")}`);
  if (spec.stage !== undefined && !contract.stages.includes(spec.stage)) errors.push(`stage "${spec.stage}" is not a stage the backend routes`);
  if (spec.kind === "measure" && spec.lever !== undefined) errors.push("a measure experiment changes no lever");

  if (spec.armA === "reference") {
    if (spec.kind !== "measure") errors.push("armA 'reference' (the committed Forays) is for a 'measure' experiment only");
  } else if (spec.armA !== "adopted") {
    errors.push(...envErrors(spec.armA?.env, "armA.env", contract));
    if (isPlainObject(spec.armA)) for (const k of Object.keys(spec.armA)) if (k !== "env") errors.push(`armA.${k} is not an arm field`);
  }
  errors.push(...envErrors(spec.armB?.env, "armB.env", contract));
  if (isPlainObject(spec.armB)) for (const k of Object.keys(spec.armB)) if (k !== "env") errors.push(`armB.${k} is not an arm field`);

  if (spec.rerunFrom !== null && spec.rerunFrom !== undefined) {
    if (!contract.checkpointOrder.includes(spec.rerunFrom)) {
      errors.push(`rerunFrom must be null or one of ${contract.checkpointOrder.join(", ")}`);
    } else if (spec.kind === "measure") {
      errors.push("a measure experiment has no arm A run to seed from; rerunFrom must be null");
    } else if (spec.kind === "stage" && contract.stages.includes(spec.stage)) {
      const feeds = contract.firstCheckpoint[spec.stage];
      if (contract.checkpointOrder.indexOf(spec.rerunFrom) > contract.checkpointOrder.indexOf(feeds)) {
        errors.push(`rerunFrom "${spec.rerunFrom}" is after "${feeds}", the first banked stage ${spec.stage} feeds; arm B would resume work arm A's route built`);
      }
    }
  } else if (spec.rerunFrom === undefined) {
    errors.push("rerunFrom must be stated (a checkpoint stage, or null for a full rerun)");
  }

  if (!isText(spec.golden) || path.isAbsolute(spec.golden) || spec.golden.includes("..")) errors.push("golden must be a repo-relative manifest path");

  if (spec.expect !== undefined) {
    if (!isPlainObject(spec.expect)) errors.push("expect must be { stageAssignments?, levers? }");
    else {
      for (const k of Object.keys(spec.expect)) if (k !== "stageAssignments" && k !== "levers") errors.push(`expect.${k} is not an expectation`);
      const sa = spec.expect.stageAssignments;
      if (sa !== undefined) {
        if (!isPlainObject(sa)) errors.push("expect.stageAssignments must map stages to { impl, machine?, model? }");
        else
          for (const [stage, a] of Object.entries(sa)) {
            if (!contract.stages.includes(stage)) errors.push(`expect.stageAssignments.${stage} is not a stage`);
            if (!isPlainObject(a) || !isText(a.impl)) errors.push(`expect.stageAssignments.${stage} must be { impl, machine?, model? }`);
            else if (FORBIDDEN_RE.test(JSON.stringify(a))) errors.push(`expect.stageAssignments.${stage} names an Anthropic model; every arm is all-local`);
          }
      }
      if (spec.expect.levers !== undefined && !isPlainObject(spec.expect.levers)) errors.push("expect.levers must be an object");
    }
  }
  if (spec.notes !== undefined && typeof spec.notes !== "string") errors.push("notes must be text");
  return { ok: errors.length === 0, errors };
}

/* ------------------------------------------------------------------ */
/* Arms                                                                */
/* ------------------------------------------------------------------ */

/** An adopted-stack stage entry { impl, model, machine } as a route value. */
export function routeOfStackEntry(entry, lanes) {
  return (entry.impl === "local" || entry.impl === "jev") && lanes.includes(entry.machine) ? `${entry.impl}:${entry.machine}` : entry.impl;
}

function stageEnvOf(env, contract) {
  return Object.fromEntries(contract.stages.map((s) => [stageEnvVar(s), env[stageEnvVar(s)]]).filter(([, v]) => v !== undefined));
}

/** The arm's environment in a stable order: the mode, every stage in the
 * backend's order, then any lever variable sorted. */
function orderedEnv(env, contract) {
  const out = { [MODE_ENV]: "local" };
  for (const stage of contract.stages) if (env[stageEnvVar(stage)] !== undefined) out[stageEnvVar(stage)] = env[stageEnvVar(stage)];
  for (const key of Object.keys(env).sort()) if (!(key in out)) out[key] = env[key];
  return out;
}

/** The 'adopted' arm's environment: the floor stack, then adopted-stack.json. */
export function adoptedEnv({ floorSpec, stack, contract, ledgerRows = [] }) {
  const checked = validateAdoptedStack(stack, ledgerRows);
  if (!checked.ok) throw new Error(`adopted-stack.json: ${checked.errors.join("; ")}`);
  if (!isPlainObject(floorSpec?.armB?.env)) throw new Error(`${FLOOR_SPEC_ID}.json has no arm B environment to start the adopted arm from`);
  const env = { ...floorSpec.armB.env };
  for (const [stage, entry] of Object.entries(stack.stages)) {
    if (!contract.stages.includes(stage)) throw new Error(`adopted-stack.json names stage "${stage}", which the backend does not route`);
    env[stageEnvVar(stage)] = routeOfStackEntry(entry, contract.lanes);
  }
  for (const [lever, value] of Object.entries(stack.levers)) {
    if (value === false || value === null || value === undefined) continue;
    const flag = LEVER_ENV[lever];
    if (!flag) throw new Error(`adopted-stack.json turns on lever "${lever}", which has no backend flag mapped yet (LEVER_ENV)`);
    if (isPlainObject(value)) {
      /* A recorded lever ({ mode, ... }): on unless its mode is off; its
         other fields set the flag's companion variables. */
      if (!leverIsOn(value)) continue;
      env[flag.name] = flag.on;
      for (const [field, name] of Object.entries(flag.companions ?? {})) if (value[field] !== undefined) env[name] = String(value[field]);
    } else {
      env[flag.name] = value === true ? flag.on : String(value);
    }
    for (const field of flag.requires ?? []) {
      const name = flag.companions[field];
      if (env[name] === undefined) throw new Error(`adopted-stack.json turns on lever "${lever}" without its ${field} (${name}); give the lever as recorded, e.g. { "mode": ..., "${field}": ... }`);
    }
  }
  return env;
}

/** The levers an arm's environment sets, by lever name: the flag's on value
 * is true, its off value false. */
function leversOf(env) {
  const out = {};
  for (const [lever, flag] of Object.entries(LEVER_ENV)) {
    const v = env[flag.name];
    if (v !== undefined) out[lever] = v === flag.on ? true : v === flag.off ? false : v;
  }
  return out;
}

/** Whether a lever value, planned or recorded, means the lever ran: absent,
 * null, false and the flag's off value are off; a record such as GV-99's
 * {mode, exemplarIds, fileSha} is read by its mode; anything else recorded is
 * on. */
export function leverIsOn(value) {
  if (value === undefined || value === null || value === false || value === "off") return false;
  if (isPlainObject(value) && "mode" in value) return leverIsOn(value.mode);
  return true;
}

/** The lever flags the arm leaves unset: inherited copies are dropped and
 * unset in the printed commands, so the operator's shell cannot turn one on. */
function unsetLeverVars(armEnv) {
  return Object.values(LEVER_ENV)
    .map((flag) => flag.name)
    .filter((name) => armEnv?.[name] === undefined);
}

function reportDir(id, arm) {
  return toPosix(path.join(SWAPS_OUT, id, arm));
}

/**
 * Plan an experiment. Pure apart from reading the golden manifest, the
 * adopted stack, the floor spec and the backend sources. Throws, naming every
 * problem, on a spec the arms cannot be built from.
 *
 * @param {object} spec
 * @param {object} [options]  { root, contract, stack, floorSpec, ledgerRows, experimentsDir }
 */
export function planExperiment(spec, options = {}) {
  const root = options.root || REPO_ROOT;
  const contract = options.contract || loadBackendContract();
  const checked = validateSpec(spec, contract);
  if (!checked.ok) throw new Error(`spec ${spec?.id ?? "?"} refused: ${checked.errors.join("; ")}`);

  /* The golden prompts: every entry must be a bench prompt (GV-62's fork is
     refused otherwise, and a listener's prompt must never be kept). */
  const goldenFile = path.join(root, spec.golden);
  let golden;
  try {
    golden = JSON.parse(fs.readFileSync(goldenFile, "utf8"));
  } catch (err) {
    throw new Error(`spec ${spec.id} refused: cannot read golden manifest ${spec.golden}: ${err.message}`);
  }
  if (!Array.isArray(golden) || golden.length === 0) throw new Error(`spec ${spec.id} refused: ${spec.golden} is not a list of prompts`);
  const notBench = golden.filter((g) => !isPlainObject(g) || g.bench !== true).map((g, i) => (isPlainObject(g) && g.id) || `#${i + 1}`);
  if (notBench.length) throw new Error(`spec ${spec.id} refused: golden prompt(s) without bench: true: ${notBench.join(", ")}`);

  let envA = null;
  if (spec.armA === "adopted") {
    const experimentsDir = options.experimentsDir || EXPERIMENTS_DIR;
    const floorSpec = options.floorSpec || readSpec(path.join(experimentsDir, `${FLOOR_SPEC_ID}.json`));
    const stack = options.stack || JSON.parse(fs.readFileSync(DEFAULT_ADOPTED_STACK, "utf8"));
    const ledgerRows = options.ledgerRows || readLedger(DEFAULT_LEDGER);
    const floorChecked = validateSpec(floorSpec, contract);
    if (!floorChecked.ok) throw new Error(`${FLOOR_SPEC_ID}.json refused: ${floorChecked.errors.join("; ")}`);
    envA = adoptedEnv({ floorSpec, stack, contract, ledgerRows });
  } else if (spec.armA !== "reference") {
    envA = { ...spec.armA.env };
  }
  const envB = { ...(envA || {}), ...spec.armB.env };

  const problems = [];
  for (const [arm, env] of [["A", envA], ["B", envB]]) {
    if (env === null) continue;
    const missing = contract.stages.filter((s) => env[stageEnvVar(s)] === undefined);
    if (missing.length) problems.push(`arm ${arm} leaves stage(s) unassigned: ${missing.join(", ")}`);
    for (const [k, v] of Object.entries(env)) if (FORBIDDEN_RE.test(`${k}=${v}`)) problems.push(`arm ${arm} ${k} names Anthropic`);
    for (const flag of Object.values(LEVER_ENV)) {
      const v = env[flag.name];
      if (v !== undefined && v !== flag.on && v !== flag.off) problems.push(`arm ${arm} ${flag.name}=${v} is not ${flag.off}|${flag.on}`);
    }
  }
  if (envA !== null) {
    const stageA = stageEnvOf(envA, contract);
    const stageB = stageEnvOf(envB, contract);
    const changedStages = contract.stages.filter((s) => stageA[stageEnvVar(s)] !== stageB[stageEnvVar(s)]);
    const others = new Set([...Object.keys(envA), ...Object.keys(envB)].filter((k) => !k.startsWith("FORAY_STAGE_")));
    const changedOthers = [...others].filter((k) => envA[k] !== envB[k]);
    if (spec.kind === "stage") {
      if (changedStages.length !== 1 || changedStages[0] !== spec.stage) {
        problems.push(`a stage experiment changes exactly its stage (${spec.stage}); arm B changes ${changedStages.length ? changedStages.join(", ") : "no stage"}`);
      }
      if (changedOthers.length) problems.push(`a stage experiment changes no lever; arm B also changes ${changedOthers.join(", ")}`);
    }
    if (spec.kind === "lever") {
      if (changedStages.length) problems.push(`a lever experiment changes no stage; arm B changes ${changedStages.join(", ")}`);
      if (changedOthers.length === 0) problems.push("a lever experiment changes a lever flag; arm B changes nothing");
    }
  }
  if (problems.length) throw new Error(`spec ${spec.id} refused: ${problems.join("; ")}`);

  const expected = (env) => Object.fromEntries(contract.stages.map((s) => [s, splitRoute(env[stageEnvVar(s)])]));
  const arm = (name, env, args) => ({ source: name === "A" ? (typeof spec.armA === "string" ? spec.armA : "env") : "env", env: orderedEnv(env, contract), levers: leversOf(env), expected: expected(env), outDir: reportDir(spec.id, name), args });
  const outA = reportDir(spec.id, "A");
  const outB = reportDir(spec.id, "B");
  const arms = {
    A:
      envA === null
        ? { source: "reference", env: null, levers: {}, expected: null, outDir: null, args: null, reference: "data/forays.json" }
        : arm("A", envA, ["--prompts", toPosix(spec.golden), "--out", outA, "--keep-checkpoints"]),
    B: arm("B", envB, ["--prompts", toPosix(spec.golden), "--out", outB, ...(spec.rerunFrom ? ["--seed-checkpoints", outA, "--rerun-from", spec.rerunFrom] : [])])
  };
  const plan = {
    schema: PLAN_SCHEMA,
    id: spec.id,
    kind: spec.kind,
    ...(spec.stage !== undefined ? { stage: spec.stage } : {}),
    ...(spec.lever !== undefined ? { lever: spec.lever } : {}),
    golden: toPosix(spec.golden),
    rerunFrom: spec.rerunFrom ?? null,
    expect: spec.expect ?? null,
    arms
  };
  plan.commands = commandsFor(plan);
  return plan;
}

/** The arms as shell lines, run from the repo root. Paths are repo-relative;
 * the driver runs in backend/, so they gain a "../". Endpoint and key
 * variables are the operator's (FORAY_LLM_BASE_URL, FORAY_LLM_API_KEY or
 * FORAY_LLM_API_KEY_FILE, JEV_API_KEY), never printed. */
export function commandsFor(plan) {
  const lines = [];
  for (const name of ["A", "B"]) {
    const arm = plan.arms[name];
    if (!arm.args) {
      lines.push(`# arm A: the committed reference Forays (${arm.reference}); nothing is generated`);
      continue;
    }
    const env = Object.entries(arm.env).map(([k, v]) => `${k}=${v}`).join(" ");
    const args = arm.args.map((a, i) => (i > 0 && ["--prompts", "--out", "--seed-checkpoints"].includes(arm.args[i - 1]) ? `../${a}` : a)).join(" ");
    lines.push(`# arm ${name}`);
    const unset = [ALLOW_LEGACY_ENV, ...unsetLeverVars(arm.env)].map((k) => `-u ${k}`).join(" ");
    lines.push(`(cd backend && env ${unset} ${env} npm run generate-forays -- ${args})`);
  }
  return lines;
}

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

/** The generation driver's .ts entry, read from backend/package.json's
 * "generate-forays" script (the rule tools/generation/start-run's
 * driverEntryFromPackage applies; restated here because that module is the
 * legacy relay launcher, and no new path may depend on the relay). */
export function driverEntry(pkg) {
  const script = pkg?.scripts?.["generate-forays"];
  const m = typeof script === "string" ? script.match(/(\S+\.ts)\s*$/) : null;
  if (!m) throw new Error(`backend/package.json's "generate-forays" script does not end in a .ts entry (found ${JSON.stringify(script)})`);
  return m[1];
}

/** Throws unless `env` is an all-local arm: mode local, the legacy opt-in
 * absent, every stage set, nothing naming Anthropic. Checked right before a
 * spawn, after the inherited environment is merged. */
export function assertArmEnv(env, contract) {
  const problems = [];
  if (env[MODE_ENV] !== "local") problems.push(`${MODE_ENV} must be local`);
  for (const name of STRIPPED_ENV) if (env[name] !== undefined) problems.push(`${name} must not be set`);
  for (const stage of contract.stages) {
    const v = env[stageEnvVar(stage)];
    if (v === undefined) problems.push(`${stageEnvVar(stage)} is not set`);
    else if (FORBIDDEN_RE.test(v)) problems.push(`${stageEnvVar(stage)} names Anthropic`);
  }
  for (const [k, v] of Object.entries(env)) if (k.startsWith("FORAY_") && FORBIDDEN_RE.test(String(v))) problems.push(`${k} names Anthropic`);
  if (problems.length) throw new Error(`refusing to spawn: ${problems.join("; ")}`);
}

/** The environment an arm is spawned with: the inherited one, minus every
 * FORAY_STAGE_* it carried, every lever flag the arm leaves unset and the
 * stripped variables, plus the arm's. */
export function spawnEnv(inherited, armEnv) {
  const env = {};
  const unsetLevers = unsetLeverVars(armEnv);
  for (const [k, v] of Object.entries(inherited)) {
    if (STRIPPED_ENV.includes(k) || k.startsWith("FORAY_STAGE_") || k === MODE_ENV || unsetLevers.includes(k)) continue;
    env[k] = v;
  }
  return { ...env, ...armEnv };
}

/** The default spawner: node + tsx's CLI on the driver entry, in backend/,
 * output inherited. Resolves to the exit code (128 + n for a signal). */
export function defaultSpawn({ args, cwd, env }) {
  const tsx = createRequire(path.join(cwd, "package.json")).resolve("tsx/cli");
  return new Promise((resolve, reject) => {
    const child = spawnChild(process.execPath, [tsx, ...args], { cwd, env, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve(code ?? 128 + (os.constants.signals[signal] ?? 0)));
  });
}

/**
 * Execute the planned arms, A then B (B seeds from A, so a failed A stops
 * B). `spawn({ arm, args, cwd, env })` is injected; under `dryRun` nothing is
 * spawned and the calls are only described. Every arm's final environment is
 * checked by assertArmEnv before ANY spawn, so a refusal leaves nothing
 * running. Returns [{ arm, args, code | null }].
 */
export async function runExperiment(plan, options = {}) {
  const { spawn = defaultSpawn, dryRun = false, only = null, inherited = process.env, root = REPO_ROOT, backendDir = BACKEND_DIR, out = console.log } = options;
  const contract = options.contract || loadBackendContract();
  const entry = driverEntry(JSON.parse(fs.readFileSync(path.join(backendDir, "package.json"), "utf8")));
  const absolute = (args) => args.map((a, i) => (i > 0 && ["--prompts", "--out", "--seed-checkpoints"].includes(args[i - 1]) ? path.join(root, a) : a));
  const calls = [];
  for (const name of ["A", "B"]) {
    if (only && only !== name) continue;
    const arm = plan.arms[name];
    if (!arm.args) continue;
    const env = spawnEnv(inherited, arm.env);
    assertArmEnv(env, contract);
    calls.push({ arm: name, args: [entry, ...absolute(arm.args)], cwd: backendDir, env });
  }
  const results = [];
  for (const call of calls) {
    if (dryRun) {
      out(`[dry-run] arm ${call.arm}: would run ${call.args.join(" ")} in ${call.cwd}`);
      results.push({ arm: call.arm, args: call.args, code: null });
      continue;
    }
    out(`arm ${call.arm}: ${call.args.join(" ")}`);
    const code = await spawn(call);
    results.push({ arm: call.arm, args: call.args, code });
    if (code !== 0) {
      out(`arm ${call.arm} exited ${code}; later arms not run`);
      break;
    }
  }
  return results;
}

/* ------------------------------------------------------------------ */
/* collect                                                             */
/* ------------------------------------------------------------------ */

function readReport(file) {
  if (!fs.existsSync(file)) throw new Error(`no report at ${file}; run the arm first`);
  const report = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(report.entries)) throw new Error(`${file} has no entries`);
  return report;
}

/** Whether a row's recorded lever meets the spec's expectation: an object
 * expectation names the fields the record must carry with those values (the
 * record may carry more, e.g. GV-99's exemplarIds and fileSha, which the spec
 * cannot know before the founder's selection); any other expectation must
 * equal the record. */
export function leverMatches(got, want) {
  if (isPlainObject(want)) return isPlainObject(got) && Object.entries(want).every(([field, value]) => JSON.stringify(got[field]) === JSON.stringify(value));
  return JSON.stringify(got) === JSON.stringify(want);
}

/** Every way the rows of one arm disagree with what the plan routed. */
export function assignmentMismatches(entries, expected, extra = {}, expectLevers = undefined, armName = "?") {
  const problems = [];
  entries.forEach((entry, i) => {
    const at = `arm ${armName} row ${entry.promptId ?? i + 1}`;
    const sa = entry.stageAssignments;
    if (!isPlainObject(sa)) {
      problems.push(`${at} records no stageAssignments`);
      return;
    }
    for (const [stage, want] of Object.entries(expected)) {
      const got = sa[stage];
      if (!isPlainObject(got) || got.impl !== want.impl || (got.machine ?? null) !== (want.machine ?? null)) {
        problems.push(`${at} ${stage}: ran ${got ? `${got.impl}${got.machine ? `@${got.machine}` : ""}` : "nothing"}, planned ${want.impl}${want.machine ? `@${want.machine}` : ""}`);
      }
    }
    for (const [stage, want] of Object.entries(extra)) {
      const got = sa[stage];
      for (const field of ["impl", "machine", "model"]) {
        if (want[field] !== undefined && (!isPlainObject(got) || got[field] !== want[field])) {
          problems.push(`${at} ${stage}.${field}: ${got ? JSON.stringify(got[field]) : "absent"}, expected ${JSON.stringify(want[field])}`);
        }
      }
    }
    if (expectLevers !== undefined) {
      if (!isPlainObject(entry.levers)) problems.push(`${at} records no levers`);
      else
        for (const [lever, want] of Object.entries(expectLevers)) {
          if (!leverMatches(entry.levers[lever], want)) problems.push(`${at} lever ${lever}: ${JSON.stringify(entry.levers[lever])}, expected ${JSON.stringify(want)}`);
        }
    }
    if (typeof entry.anthropicCalls === "number" && entry.anthropicCalls > 0) problems.push(`${at} sent ${entry.anthropicCalls} Anthropic request(s)`);
  });
  return problems;
}

/** Arm A against every lever spec.expect names, on or off as planned (a lever
 * arm A does not set is planned off). Arm A's planned value, not the spec's,
 * is the expectation: a lever flag leaking into arm A would otherwise make it
 * equal arm B and still pass. */
export function armALeverMismatches(entries, expectLevers, plannedLevers = {}) {
  if (expectLevers === undefined) return [];
  const problems = [];
  entries.forEach((entry, i) => {
    const at = `arm A row ${entry.promptId ?? i + 1}`;
    if (!isPlainObject(entry.levers)) {
      problems.push(`${at} records no levers`);
      return;
    }
    for (const lever of Object.keys(expectLevers)) {
      const want = leverIsOn(plannedLevers[lever]);
      if (leverIsOn(entry.levers[lever]) !== want) problems.push(`${at} lever ${lever}: ${JSON.stringify(entry.levers[lever])}, planned ${want ? "on" : "off"}`);
    }
  });
  return problems;
}

/** Timing groups in pipeline order: the checkpoint stages, the evidence wave
 * after sourcing, finalize last; anything else after them as first seen. */
function timingOrder(contract) {
  const order = [...contract.checkpointOrder];
  const at = order.indexOf("source");
  order.splice(at < 0 ? order.length : at + 1, 0, "evidence");
  order.push("finalize");
  return order;
}

/** One prompt's per-group timings: name before the first colon; sub-spans
 * (names with a dot, e.g. finalize.build-record) are inside their parent. */
function timingGroups(entry) {
  const groups = new Map();
  const timings = entry?.veracity?.stageTimings;
  if (!Array.isArray(timings)) return groups;
  for (const t of timings) {
    if (!t || typeof t.name !== "string" || t.name.includes(".")) continue;
    const g = t.name.split(":")[0];
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(t);
  }
  return groups;
}

/**
 * Timing rows [{ stage, A, B, resumed? }] (p50 ms over the kept pairs) for the
 * group `from` and every later group. A group that was resumed in either arm,
 * on any pair, is marked resumed and carries no numbers: a resumed stage did
 * no work in that run, so it is never compared.
 */
export function timingDeltas(pairs, from, contract) {
  const order = timingOrder(contract);
  const seen = [];
  for (const p of pairs) for (const side of [p.A, p.B]) for (const g of timingGroups(side).keys()) if (!seen.includes(g)) seen.push(g);
  const groups = [...order.filter((g) => seen.includes(g)), ...seen.filter((g) => !order.includes(g))];
  const start = from ? groups.indexOf(from) : 0;
  if (start < 0) return [];
  return groups.slice(start).map((g) => {
    let resumed = false;
    const samples = { A: [], B: [] };
    for (const p of pairs) {
      for (const arm of ["A", "B"]) {
        const ts = timingGroups(p[arm]).get(g);
        if (!ts) continue;
        if (ts.some((t) => t.resumed === true)) resumed = true;
        const ms = spanMsOf(ts);
        if (ms !== null) samples[arm].push(ms);
      }
    }
    if (resumed) return { stage: g, A: null, B: null, resumed: true };
    return { stage: g, A: percentile(samples.A, 0.5), B: percentile(samples.B, 0.5) };
  });
}

function mqOf(scorecard) {
  if (!isPlainObject(scorecard)) return null;
  return Object.fromEntries(SCORECARD_METRICS.map((id) => [id, scorecard[id] ?? null]));
}

function corpusOf(report) {
  const fp = report?.corpus?.fingerprint?.sha256;
  return isText(fp) ? fp : null;
}

/** The default blind-pack builder: tools/listening/pack.mjs, a random seal. */
export function defaultPackBuilder() {
  let pools = null;
  return ({ promptId, act, a, b, outDir, keyDir }) => {
    pools ||= loadPools();
    const built = buildPack({ a, b, act, seed: crypto.randomInt(0, 0xffffffff), pools, promptId });
    writePack(built, { outDir, keyDir });
    return { packId: built.packId };
  };
}

function readForays(file) {
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  const list = Array.isArray(doc) ? doc : doc.forays;
  if (!Array.isArray(list)) throw new Error(`${file} has no Forays list`);
  return new Map(list.map((f) => [f.id, f]));
}

/**
 * Collect an experiment: read the arms, refuse a mismatched run, pair the
 * golden prompts, compute the scorecard and timing evidence, build the sealed
 * pairs and write evidence.json. Returns the evidence.
 *
 * @param {object} plan  planExperiment's result
 * @param {object} options { root, contract, packBuilder, keyDir, foraysFile, commit, out }
 */
export function collectExperiment(plan, options = {}) {
  const { root = REPO_ROOT, keyDir = DEFAULT_KEY_DIR, out = console.log } = options;
  const expect = plan.expect || {};
  const contract = options.contract || loadBackendContract();
  const packBuilder = options.packBuilder || defaultPackBuilder();
  const base = path.join(root, SWAPS_OUT, plan.id);
  const measure = plan.arms.A.source === "reference";

  const manifest = loadGoldenManifest(path.join(root, plan.golden));
  const golden = JSON.parse(fs.readFileSync(path.join(root, plan.golden), "utf8"));
  const goldenById = new Map(golden.map((g) => [g.id, g]));

  const reportPathB = path.join(root, plan.arms.B.outDir, "report.json");
  const reportB = readReport(reportPathB);
  const reportPathA = measure ? null : path.join(root, plan.arms.A.outDir, "report.json");
  const reportA = measure ? null : readReport(reportPathA);

  /* Refuse the whole collection when either arm did not run what was planned. */
  const problems = [
    ...(measure ? [] : armALeverMismatches(reportA.entries, expect.levers, plan.arms.A.levers)),
    ...(measure ? [] : assignmentMismatches(reportA.entries, plan.arms.A.expected, {}, undefined, "A")),
    ...assignmentMismatches(reportB.entries, plan.arms.B.expected, expect.stageAssignments || {}, expect.levers, "B")
  ];
  if (!measure && reportA.prompts?.sha256 && reportB.prompts?.sha256 && reportA.prompts.sha256 !== reportB.prompts.sha256) {
    problems.push("the two arms ran different prompt files (report.prompts.sha256 differs)");
  }
  const fpA = measure ? null : corpusOf(reportA);
  const fpB = corpusOf(reportB);
  if (fpA && fpB && fpA !== fpB) problems.push("the two arms ran on different corpora (report.corpus.fingerprint differs)");
  if (problems.length) throw new Error(`collect refused for ${plan.id}:\n  ${problems.join("\n  ")}`);
  const corpusFingerprint = measure ? fpB || "unfrozen" : fpA && fpB ? fpA : "unfrozen";

  const byPrompt = (report) => {
    const m = new Map();
    for (const e of report.entries) if (typeof e.promptId === "string" && goldenById.has(e.promptId)) m.set(e.promptId, e);
    return m;
  };
  const rowsB = byPrompt(reportB);
  const rowsA = measure ? null : byPrompt(reportA);
  const forays = measure ? readForays(options.foraysFile || path.join(root, "data", "forays.json")) : null;

  const dropped = [];
  const kept = [];
  for (const g of golden) {
    const b = rowsB.get(g.id);
    if (!b) {
      dropped.push({ promptId: g.id, reason: "no arm B row" });
      continue;
    }
    if (measure) {
      const ref = g.reference;
      if (!isPlainObject(ref) || ref.kind !== "forays-json" || !forays.has(ref.forayId)) {
        dropped.push({ promptId: g.id, reason: isPlainObject(ref) ? `reference ${ref.kind} not readable here` : "no committed reference" });
        continue;
      }
      kept.push({ promptId: g.id, A: null, B: b, reference: forays.get(ref.forayId) });
      continue;
    }
    const a = rowsA.get(g.id);
    if (!a) {
      dropped.push({ promptId: g.id, reason: "no arm A row" });
      continue;
    }
    if (plan.rerunFrom && (b.seededFrom === null || b.seededFrom === undefined)) {
      dropped.push({ promptId: g.id, reason: `arm B unseeded while rerunFrom is ${plan.rerunFrom}` });
      continue;
    }
    kept.push({ promptId: g.id, A: a, B: b });
  }

  const scored = (entry, reportPath, report, arm) => {
    const candidateFile = candidatePathFor(entry, reportPath);
    const candidate = candidateFile ? JSON.parse(fs.readFileSync(candidateFile, "utf8")) : null;
    const scorecard = scorecardFor(entry, candidate, candidateFile, {});
    const run = `${plan.id}/${arm}`;
    return { candidate, candidateId: candidateFile ? path.basename(candidateFile, ".json") : null, row: rowFor(entry, { report, runId: run, reportRun: run, scorecard }) };
  };

  const prompts = [];
  const benchRows = { A: [], B: [] };
  for (const pair of kept) {
    const b = scored(pair.B, reportPathB, reportB, "B");
    benchRows.B.push(b.row);
    let a;
    if (measure) {
      const ref = referenceRow(pair.reference);
      a = { candidate: pair.reference, candidateId: pair.reference.id, row: { scorecard: ref.scorecard } };
    } else {
      a = scored(pair.A, reportPathA, reportA, "A");
      benchRows.A.push(a.row);
    }
    const listened = goldenById.get(pair.promptId).listened === true;
    let packId = null;
    let packNote;
    if (listened) {
      if (!a.candidate || !b.candidate) packNote = `no candidate file for arm ${!a.candidate ? "A" : "B"}`;
      else {
        try {
          packId = packBuilder({
            experiment: plan.id,
            promptId: pair.promptId,
            act: LISTEN_ACT,
            a: { candidate: a.candidate, candidateId: a.candidateId, provider: measure ? REFERENCE_LABEL : "local", stageSwap: measure ? REFERENCE_LABEL : BASELINE_LABEL },
            b: { candidate: b.candidate, candidateId: b.candidateId, provider: "local", stageSwap: plan.id },
            outDir: path.join(base, "packs", pair.promptId),
            keyDir
          }).packId;
        } catch (err) {
          packNote = `pack not built: ${err.message}`;
        }
      }
    }
    prompts.push({
      promptId: pair.promptId,
      listened,
      candidates: { A: a.candidateId, B: b.candidateId },
      packId,
      ...(packNote ? { packNote } : {}),
      preference: null,
      scores: null,
      mq: { A: mqOf(a.row.scorecard), B: mqOf(b.row.scorecard) }
    });
  }

  const timingFrom = plan.stage ? contract.firstCheckpoint[plan.stage] : null;
  const timing = measure ? [] : timingDeltas(kept, timingFrom, contract);

  let goldenCompare = null;
  if (!measure && benchRows.A.length && benchRows.B.length) {
    const [sumA] = goldenSummaries(benchRows.A, manifest);
    const [sumB] = goldenSummaries(benchRows.B, manifest);
    goldenCompare = compareGolden(sumB, sumA);
  }

  const assignmentsB = reportB.entries.find((e) => isPlainObject(e.stageAssignments))?.stageAssignments ?? null;
  const evidence = {
    schema: EVIDENCE_SCHEMA,
    experiment: plan.id,
    kind: plan.kind,
    ...(plan.stage !== undefined ? { stage: plan.stage } : {}),
    ...(plan.lever !== undefined ? { lever: plan.lever } : {}),
    timingFrom,
    goldenSetId: path.basename(plan.golden, ".json"),
    corpusFingerprint,
    commit: isText(options.commit) ? options.commit : null,
    runDirs: { A: measure ? plan.arms.A.reference : plan.arms.A.outDir, B: plan.arms.B.outDir },
    arms: {
      A: { stack: measure ? {} : stackOfEnv(plan.arms.A.env, contract), levers: plan.arms.A.levers },
      B: { stack: stackOfEnv(plan.arms.B.env, contract), levers: plan.arms.B.levers, assignments: assignmentsB }
    },
    prompts,
    dropped,
    timing,
    goldenCompare
  };
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  const packs = prompts.filter((p) => p.packId).length;
  out(`${plan.id}: ${prompts.length} pair(s), ${dropped.length} dropped, ${packs} sealed pack(s), corpus ${corpusFingerprint}`);
  out(`  evidence: ${toPosix(path.relative(root, path.join(base, "evidence.json")))} (the pack keys are local; nothing here says which label is which arm)`);
  return evidence;
}

/** { <stage>: "<impl[:lane]>" } from an arm's environment. */
function stackOfEnv(env, contract) {
  return Object.fromEntries(contract.stages.filter((s) => env?.[stageEnvVar(s)] !== undefined).map((s) => [s, env[stageEnvVar(s)]]));
}

/* ------------------------------------------------------------------ */
/* decide                                                              */
/* ------------------------------------------------------------------ */

const laterCard = (a, b) => Date.parse(b.listenedAt) >= Date.parse(a.listenedAt);

/**
 * The founder's cards unsealed against this experiment's evidence: per prompt
 * the preferred ARM (A, B, tie or null) and each arm's axis scores. Refuses a
 * card whose pack is not one of the evidence's packs, and a key whose prompt,
 * act, arm labels or candidates do not match what collect sealed.
 */
export function unsealForEvidence(evidence, cards, options = {}) {
  const byPack = new Map(evidence.prompts.filter((p) => p.packId).map((p) => [p.packId, p]));
  const foreign = cards.filter((c) => !byPack.has(c.packId));
  if (foreign.length) {
    throw new Error(`card(s) for pack(s) not in experiment ${evidence.experiment}: ${[...new Set(foreign.map((c) => `${c.cardId} -> ${c.packId}`))].join(", ")}; pass only this experiment's cards`);
  }
  const keys = options.keys || loadKeys(cards.map((c) => c.packId), options.keyDir || DEFAULT_KEY_DIR);
  const armALabel = evidence.kind === "measure" ? REFERENCE_LABEL : BASELINE_LABEL;
  const labelToArm = new Map();
  for (const [packId, prompt] of byPack) {
    const key = keys.get(packId);
    if (!key) continue;
    const problems = [];
    if (key.packId !== packId) problems.push(`is for pack ${key.packId}`);
    if (key.promptId !== prompt.promptId) problems.push(`names prompt ${key.promptId}, the evidence ${prompt.promptId}`);
    if (key.act !== LISTEN_ACT) problems.push(`is act ${key.act}, not ${LISTEN_ACT}`);
    if (!key.A || !key.B) problems.push("is not a pair key");
    else {
      const map = {};
      for (const label of ["A", "B"]) {
        const arm = key[label].stageSwap === evidence.experiment ? "B" : key[label].stageSwap === armALabel ? "A" : null;
        if (!arm) problems.push(`label ${label} carries stageSwap "${key[label].stageSwap}", neither "${armALabel}" nor "${evidence.experiment}"`);
        else if (key[label].candidateId !== prompt.candidates[arm]) problems.push(`label ${label} is candidate ${key[label].candidateId}, the evidence's arm ${arm} is ${prompt.candidates[arm]}`);
        map[label] = arm;
      }
      if (map.A && map.A === map.B) problems.push("both labels are the same arm");
      labelToArm.set(packId, map);
    }
    if (problems.length) throw new Error(`key for pack ${packId} does not match experiment ${evidence.experiment}: ${problems.join("; ")}`);
  }

  const results = new Map(unseal(cards, { keys }).map((r) => [r.packId, r]));
  const latest = new Map();
  for (const c of cards) {
    const k = `${c.packId}\u0000${c.label}`;
    if (!latest.has(k) || laterCard(latest.get(k), c)) latest.set(k, c);
  }
  const perPrompt = new Map();
  for (const [packId, prompt] of byPack) {
    const r = results.get(packId);
    if (!r) continue;
    const map = labelToArm.get(packId);
    const preference = r.preferred === "tie" ? "tie" : r.preferred === "A" || r.preferred === "B" ? map[r.preferred] : null;
    const scores = {};
    for (const label of ["A", "B"]) {
      const c = latest.get(`${packId}\u0000${label}`);
      if (c) scores[map[label]] = { ...c.scores };
    }
    perPrompt.set(prompt.promptId, { preference, scores: scores.A || scores.B ? scores : null });
  }
  return perPrompt;
}

/** A small line diff (longest common subsequence), "-" / "+" / " " prefixed. */
export function lineDiff(before, after) {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      out.push(`  ${a[i++]}`);
      j++;
    } else if (i < n && (j === m || lcs[i + 1][j] >= lcs[i][j + 1])) out.push(`- ${a[i++]}`);
    else out.push(`+ ${b[j++]}`);
  }
  return out.join("\n");
}

/** The adopted stack an 'adopt' row would produce: arm B's whole stack when
 * nothing is adopted yet (it replaces the floor), else the one changed stage
 * or lever. Never written: a person commits it in a PR citing the row. */
export function proposedStack(stack, evidence, rowId, lanes) {
  const toEntry = (stage, value) => {
    const { impl, machine } = splitRoute(value);
    const model = evidence.arms.B.assignments?.[stage]?.model;
    return { impl, model: isText(model) ? model : impl, machine: machine && lanes.includes(machine) ? machine : impl };
  };
  const next = { ...stack, stages: { ...stack.stages }, levers: { ...stack.levers }, ledgerRow: rowId };
  if (evidence.kind === "lever") next.levers[evidence.lever] = evidence.arms.B.levers[evidence.lever] ?? true;
  else if (Object.keys(stack.stages).length === 0) for (const [stage, value] of Object.entries(evidence.arms.B.stack)) next.stages[stage] = toEntry(stage, value);
  else next.stages[evidence.stage] = toEntry(evidence.stage, evidence.arms.B.stack[evidence.stage]);
  return next;
}

/**
 * Decide an experiment: unseal the cards, apply decideSwap, append the ledger
 * row and re-render the doc table. Returns { row, verdict, stackDiff }.
 *
 * @param {object} evidence  evidence.json as collect wrote it
 * @param {object[]} cards   parsed listen-card/1 cards
 * @param {object} options   { ledger, doc, stackFile, keyDir, keys, commit, rowId, contract, out }
 */
export function decideExperiment(evidence, cards, options = {}) {
  const { ledger = DEFAULT_LEDGER, doc = DEFAULT_DOC, stackFile = DEFAULT_ADOPTED_STACK, out = console.log } = options;
  const contract = options.contract || loadBackendContract();
  if (evidence?.schema !== EVIDENCE_SCHEMA) throw new Error(`not ${EVIDENCE_SCHEMA} evidence`);
  const commit = isText(options.commit) ? options.commit : evidence.commit;
  if (!isText(commit)) throw new Error("decide needs the commit both arms ran at (--commit <sha>)");

  const heard = unsealForEvidence(evidence, cards, options);
  const prompts = evidence.prompts.map((p) => ({ promptId: p.promptId, preference: heard.get(p.promptId)?.preference ?? null, scores: heard.get(p.promptId)?.scores ?? null, mq: p.mq }));
  const bands = { "MQ-02": GOLDEN_BANDS.rate.absolute, "MQ-05": GOLDEN_BANDS.rate.absolute };
  const verdict = decideSwap(
    {
      kind: evidence.kind,
      ...(evidence.timingFrom ? { stage: evidence.timingFrom } : {}),
      ...(evidence.lever ? { lever: evidence.lever } : {}),
      corpusFingerprint: evidence.corpusFingerprint,
      prompts,
      timing: evidence.timing
    },
    { bands }
  );

  const existing = readLedger(ledger);
  const rowId = options.rowId || `${evidence.experiment}-${existing.filter((r) => r.experiment === evidence.experiment).length + 1}`;
  const listeners = [...new Set(cards.map((c) => c.listener))].sort();
  const lastHeard = cards.reduce((m, c) => (m === null || Date.parse(c.listenedAt) > Date.parse(m) ? c.listenedAt : m), null);
  const packIds = [...new Set(cards.map((c) => c.packId))].sort();
  const notes = [
    evidence.dropped.length ? `dropped ${evidence.dropped.length} pair(s): ${evidence.dropped.map((d) => `${d.promptId} (${d.reason})`).join(", ")}` : "",
    evidence.timingFrom ? `timing from ${evidence.timingFrom}` : ""
  ]
    .filter(Boolean)
    .join("; ");
  const row = {
    id: rowId,
    experiment: evidence.experiment,
    kind: evidence.kind,
    ...(evidence.stage ? { stage: evidence.stage } : {}),
    ...(evidence.lever ? { lever: evidence.lever } : {}),
    armA: { stack: evidence.arms.A.stack, levers: evidence.arms.A.levers },
    armB: { stack: evidence.arms.B.stack, levers: evidence.arms.B.levers },
    commit,
    goldenSetId: evidence.goldenSetId,
    corpusFingerprint: evidence.corpusFingerprint,
    runDirs: evidence.runDirs,
    pairwise: {
      wins: verdict.pairwise.wins,
      ties: verdict.pairwise.ties,
      losses: verdict.pairwise.losses,
      listener: listeners.length ? listeners.join(", ") : null,
      listenedOn: lastHeard ? new Date(lastHeard).toISOString().slice(0, 10) : null,
      packId: packIds.length === 0 ? null : packIds.length === 1 ? packIds[0] : packIds
    },
    axisMeans: verdict.axisMeans,
    scorecardDelta: verdict.scorecardDelta,
    timingDelta: verdict.timingDelta,
    checks: verdict.checks,
    decision: verdict.decision,
    notes
  };
  appendLedgerRow(ledger, row);
  if (fs.existsSync(doc)) fs.writeFileSync(doc, spliceLedgerTable(fs.readFileSync(doc, "utf8"), readLedger(ledger)));
  out(`${evidence.experiment}: ${verdict.decision} (B ${verdict.pairwise.wins} / tie ${verdict.pairwise.ties} / A ${verdict.pairwise.losses}); ledger row ${rowId}`);
  if (verdict.failing.length) out(`  failing: ${verdict.failing.join(", ")}`);

  let stackDiff = null;
  if (verdict.decision === "adopt") {
    const stack = JSON.parse(fs.readFileSync(stackFile, "utf8"));
    const before = `${JSON.stringify(stack, null, 2)}\n`;
    const after = `${JSON.stringify(proposedStack(stack, evidence, rowId, contract.lanes), null, 2)}\n`;
    stackDiff = lineDiff(before, after);
    out(`  adopted-stack.json, to commit in a PR that cites ledger row ${rowId}:`);
    out(stackDiff);
  }
  return { row, verdict, stackDiff };
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

export const USAGE = [
  "usage: node tools/generation-bench/swap-experiment.mjs <command> <spec id | spec path> [flags]",
  "  plan <spec> [--json]",
  "  run <spec> [--dry-run] [--arm A|B]",
  "  collect <spec> [--commit <sha>] [--key-dir <dir>]",
  "  decide <spec> --cards <cards.jsonl> [--commit <sha>] [--row-id <id>] [--key-dir <dir>]"
].join("\n");

function flagsOf(argv) {
  const flags = { _: [] };
  const valued = new Set(["--arm", "--commit", "--key-dir", "--cards", "--row-id"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (valued.has(a)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value\n${USAGE}`);
      flags[a.slice(2)] = v;
    } else if (a === "--dry-run" || a === "--json") flags[a.slice(2)] = true;
    else if (a.startsWith("--")) throw new Error(`unknown flag ${a}\n${USAGE}`);
    else flags._.push(a);
  }
  return flags;
}

/** The CLI. Resolves to the command's result; throws on a refusal. */
export async function main(argv, out = console.log, deps = {}) {
  const [command, target, ...rest] = argv;
  if (!command || !target) throw new Error(USAGE);
  const flags = flagsOf(rest);
  const spec = readSpec(specPathFor(target, deps.experimentsDir));
  const plan = planExperiment(spec, deps);
  if (command === "plan") {
    if (flags.json) out(JSON.stringify(plan, null, 2));
    else for (const line of plan.commands) out(line);
    return plan;
  }
  if (command === "run") {
    if (flags.arm && flags.arm !== "A" && flags.arm !== "B") throw new Error("--arm must be A or B");
    return runExperiment(plan, { ...deps, dryRun: flags["dry-run"] === true, only: flags.arm || null, out });
  }
  if (command === "collect") {
    return collectExperiment(plan, { ...deps, commit: flags.commit, ...(flags["key-dir"] ? { keyDir: path.resolve(flags["key-dir"]) } : {}), out });
  }
  if (command === "decide") {
    if (!flags.cards) throw new Error(`decide needs --cards <cards.jsonl>\n${USAGE}`);
    const root = deps.root || REPO_ROOT;
    const evidenceFile = path.join(root, SWAPS_OUT, spec.id, "evidence.json");
    if (!fs.existsSync(evidenceFile)) throw new Error(`no evidence at ${evidenceFile}; run collect first`);
    const evidence = JSON.parse(fs.readFileSync(evidenceFile, "utf8"));
    if (evidence.experiment !== spec.id) throw new Error(`${evidenceFile} is evidence for ${evidence.experiment}, not ${spec.id}`);
    const cardsFile = path.resolve(flags.cards);
    const cards = parseCards(fs.readFileSync(cardsFile, "utf8"), cardsFile);
    return decideExperiment(evidence, cards, {
      ...deps,
      commit: flags.commit,
      rowId: flags["row-id"],
      ...(flags["key-dir"] ? { keyDir: path.resolve(flags["key-dir"]) } : {}),
      out
    });
  }
  throw new Error(`unknown command ${command}\n${USAGE}`);
}

if (isEntryScript(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
