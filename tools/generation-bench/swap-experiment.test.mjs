/* Tests for the stage-swap experiment runner (GV-75, W7-04 + W2-16).
 * Run: node --test tools/generation-bench/swap-experiment.test.mjs
 *
 * WHAT IS AT RISK
 * The runner turns two arms of golden prompts into a ledger row that can
 * change a production default. Every way it can go wrong is quiet: an arm
 * that falls back to Claude, an arm B that silently ran arm A's stack, a
 * seeded stage compared as if it had run, a card from another experiment
 * counted, a blind label mapped to the wrong arm. Each test pins one of
 * those. Everything is offline: reports are copies of fixtures/out-9 edited
 * into A/B pairs, the pack builder and the spawn are fakes, the cards are
 * synthetic, and every file is written under a temp directory.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AXES } from "../listening/card.mjs";
import { readLedger } from "./swap-ledger.mjs";
import {
  ALLOW_LEGACY_ENV,
  BASELINE_LABEL,
  EVIDENCE_SCHEMA,
  EXPERIMENTS_DIR,
  FLOOR_SPEC_ID,
  MODE_ENV,
  REFERENCE_LABEL,
  assertArmEnv,
  collectExperiment,
  decideExperiment,
  driverEntry,
  lineDiff,
  loadBackendContract,
  main,
  parseConstList,
  parseConstMap,
  planExperiment,
  readSpec,
  runExperiment,
  stageEnvVar,
  timingDeltas,
  validateSpec
} from "./swap-experiment.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const CONTRACT = loadBackendContract();
const COMMITTED = ["E0-floor", "E1-deepen-p40", "E2-continuity-p40", "E6-verifier-jev-vs-qwen"];
const FLOOR = readSpec(path.join(EXPERIMENTS_DIR, `${FLOOR_SPEC_ID}.json`));
const EMPTY_STACK = { schema: "adopted-stack/1", note: "", stages: {}, levers: {}, ledgerRow: null };
const OUT9 = path.join(HERE, "fixtures", "out-9");
const OUT9_ENTRY = JSON.parse(fs.readFileSync(path.join(OUT9, "report.json"), "utf8")).entries[0];
const OUT9_CANDIDATE = fs.readFileSync(path.join(OUT9, "what-engineers-actually-do-all-day-how-e-4e64fd43.json"), "utf8");
const quiet = () => {};

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "swap-exp-"));
const floorEnv = () => ({ ...FLOOR.armB.env });

/* ------------------------------------------------------------------ */
/* Synthetic roots                                                     */
/* ------------------------------------------------------------------ */

/** A golden manifest of n bench prompts p01..pNN; the first `listened` are
 * listened, and listened ones may carry a reference. */
function goldenOf(n, listened, reference = null) {
  return Array.from({ length: n }, (_, i) => {
    const id = `p${String(i + 1).padStart(2, "0")}`;
    return {
      id,
      prompt: `synthetic prompt ${id}`,
      duration: "short",
      stratum: "multi-show",
      listened: i < listened,
      nodes: ["x"],
      ...(reference && i < listened ? { reference: reference(id) } : {}),
      bench: true
    };
  });
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** A stage-kind spec over the floor, deepen moved to the second box. */
function deepenSpec(extra = {}) {
  return {
    id: "T1-deepen",
    kind: "stage",
    stage: "deepen",
    armA: { env: floorEnv() },
    armB: { env: { FORAY_STAGE_DEEPEN: "local:second" } },
    rerunFrom: "deepen",
    golden: "golden.json",
    expect: { stageAssignments: { deepen: { impl: "local", machine: "second" } } },
    ...extra
  };
}

/** stageAssignments as the backend records them for an arm's planned routes. */
function assignmentsFor(expected) {
  return Object.fromEntries(Object.entries(expected).map(([s, a]) => [s, { impl: a.impl, model: a.machine ? `qwen-${a.machine}` : a.impl, ...(a.machine ? { machine: a.machine } : {}) }]));
}

/**
 * Write arm reports (copies of the out-9 entry) and their candidates for a
 * plan. `edit(entry, arm, promptId)` adjusts each row.
 */
function writeArms(root, plan, golden, { edit = () => {}, corpus = { A: "fp-1", B: "fp-1" }, arms = ["A", "B"] } = {}) {
  for (const arm of arms) {
    const dir = path.join(root, plan.arms[arm].outDir);
    const entries = golden.map((g) => {
      const entry = JSON.parse(JSON.stringify(OUT9_ENTRY));
      entry.promptId = g.id;
      entry.prompt = g.prompt;
      entry.file = `C:/elsewhere/cand-${g.id}-${arm.toLowerCase()}.json`;
      entry.stageAssignments = assignmentsFor(plan.arms[arm].expected);
      entry.anthropicCalls = 0;
      if (arm === "B" && plan.rerunFrom) entry.seededFrom = { dir: plan.arms.A.outDir, rerunFrom: plan.rerunFrom, stagesKept: ["understand", "spine"] };
      edit(entry, arm, g.id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `cand-${g.id}-${arm.toLowerCase()}.json`), OUT9_CANDIDATE);
      return entry;
    });
    writeJson(path.join(dir, "report.json"), {
      generated_at: "2026-10-20T00:00:00.000Z",
      ...(corpus[arm] ? { corpus: { fingerprint: { sha256: corpus[arm] } } } : {}),
      prompts: { file: "golden.json", sha256: "prompts-sha", count: golden.length },
      entries
    });
  }
}

/**
 * A fake blind-pack builder: writes a listen-key/1 key like pack.mjs would,
 * swapping the labels on every other prompt, and remembers which label each
 * arm got so a test can write cards. Never prints the mapping.
 */
function fakePacks(keyDir) {
  const calls = [];
  const labels = new Map();
  const builder = (args) => {
    calls.push(args);
    const swap = calls.length % 2 === 0;
    const packId = `pk-${args.experiment.toLowerCase()}-${args.promptId}`;
    const armKey = (a) => ({ candidateId: a.candidateId, provider: a.provider, stageSwap: a.stageSwap });
    const key = { schema: "listen-key/1", packId, promptId: args.promptId, act: args.act, seed: 0, A: armKey(swap ? args.b : args.a), B: armKey(swap ? args.a : args.b) };
    writeJson(path.join(keyDir, `${packId}.key.json`), key);
    labels.set(args.promptId, swap ? { A: "B", B: "A" } : { A: "A", B: "B" });
    return { packId };
  };
  return { builder, calls, labels };
}

/** listen-card/1 cards for one pack: both labels, the preference given by
 * ARM ("A", "B" or "tie"), each arm's axis score. */
function cardsFor(packId, armToLabel, preferArm, scoreA = 4, scoreB = 4, when = "2026-10-21T10:00:00Z") {
  const pref = preferArm === "tie" ? "tie" : armToLabel[preferArm];
  const scoreOfLabel = (label) => (armToLabel.A === label ? scoreA : scoreB);
  return ["A", "B"].map((label) => ({
    schema: "listen-card/1",
    cardId: `${packId}-${label}`,
    packId,
    label,
    act: 1,
    listener: "founder",
    listenedAt: when,
    scores: Object.fromEntries(AXES.map((a) => [a, scoreOfLabel(label)])),
    overall: scoreOfLabel(label),
    q06: { oneVoice: true, everyClipIntroduced: true, anyClipCutShort: false },
    winces: [],
    preference: pref
  }));
}

/** A collected stage experiment over n listened prompts, ready to decide. */
function collected({ n = 10, corpus, spec = deepenSpec(), edit } = {}) {
  const root = tmp();
  const golden = goldenOf(n, n);
  writeJson(path.join(root, "golden.json"), golden);
  const plan = planExperiment(spec, { root, contract: CONTRACT });
  writeArms(root, plan, golden, { ...(corpus ? { corpus } : {}), ...(edit ? { edit } : {}) });
  const keyDir = path.join(root, "keys");
  const packs = fakePacks(keyDir);
  const evidence = collectExperiment(plan, { root, contract: CONTRACT, packBuilder: packs.builder, keyDir, out: quiet });
  const ledger = path.join(root, "ledger.jsonl");
  const doc = path.join(root, "model-swaps.md");
  fs.copyFileSync(path.join(REPO, "docs", "curation", "model-swaps.md"), doc);
  const stackFile = path.join(root, "adopted-stack.json");
  writeJson(stackFile, EMPTY_STACK);
  return { root, plan, evidence, keyDir, packs, ledger, doc, stackFile };
}

/* ------------------------------------------------------------------ */
/* The backend contract                                                */
/* ------------------------------------------------------------------ */

test("the stage list, lanes and checkpoint order are read from the backend sources, not counted by hand", () => {
  const routing = fs.readFileSync(path.join(REPO, "backend/src/config/stageRouting.ts"), "utf8");
  const listed = routing.match(/export const GENERATION_STAGES = \[([^\]]*)\]/)[1].match(/"[^"]+"/g).length;
  assert.equal(CONTRACT.stages.length, listed);
  assert.ok(CONTRACT.stages.includes("deepen") && CONTRACT.stages.includes("spine-alt") && CONTRACT.stages.includes("judge"));
  assert.deepEqual(CONTRACT.lanes, ["spark", "second"]);
  assert.equal(CONTRACT.checkpointOrder[0], "understand");
  assert.equal(CONTRACT.firstCheckpoint.continuity, "stitch");
  for (const stage of CONTRACT.stages) assert.ok(CONTRACT.checkpointOrder.includes(CONTRACT.firstCheckpoint[stage]), stage);
  /* stageEnvVar spells the variable exactly as the backend does. */
  assert.match(routing, /return `FORAY_STAGE_\$\{stage\.toUpperCase\(\)\.replace\(\/\[\.-\]\/g, "_"\)\}`;/);
  assert.equal(stageEnvVar("understand.clarity"), "FORAY_STAGE_UNDERSTAND_CLARITY");
  assert.equal(stageEnvVar("spine-alt"), "FORAY_STAGE_SPINE_ALT");
});

test("the source parse refuses a list or map that is not plain string literals", () => {
  assert.deepEqual(parseConstList('export const X: readonly T[] = ["a", "b"] as const;', "X"), ["a", "b"]);
  assert.throws(() => parseConstList('export const X = ["a", ...MORE] as const;', "X"), /not a plain list/);
  assert.throws(() => parseConstList("const Y = 1;", "X"), /cannot find/);
  assert.deepEqual(parseConstMap('export const M: Readonly<Record<A, B>> = { "a.b": "x", c: "y" };', "M"), { "a.b": "x", c: "y" });
  assert.throws(() => parseConstMap("export const M = { a: OTHER };", "M"), /not a plain map/);
});

test("a stage the backend adds is a stage every arm must set", () => {
  const root = tmp();
  writeJson(path.join(root, "golden.json"), goldenOf(2, 1));
  const contract = { ...CONTRACT, stages: [...CONTRACT.stages, "newstage"], firstCheckpoint: { ...CONTRACT.firstCheckpoint, newstage: "narrate" } };
  assert.throws(() => planExperiment(deepenSpec(), { root, contract }), /arm A leaves stage\(s\) unassigned: newstage/);
});

/* ------------------------------------------------------------------ */
/* plan                                                                */
/* ------------------------------------------------------------------ */

test("plan: every committed spec sets FORAY_GENERATION_MODE=local and every stage explicitly, never the legacy opt-in", () => {
  for (const id of COMMITTED) {
    const spec = readSpec(path.join(EXPERIMENTS_DIR, `${id}.json`));
    const plan = planExperiment(spec, { contract: CONTRACT, stack: EMPTY_STACK, ledgerRows: [] });
    for (const arm of ["A", "B"]) {
      const env = plan.arms[arm].env;
      if (env === null) {
        assert.equal(id, "E0-floor");
        continue;
      }
      assert.equal(env[MODE_ENV], "local", `${id} ${arm}`);
      assert.equal(env[ALLOW_LEGACY_ENV], undefined, `${id} ${arm}`);
      for (const stage of CONTRACT.stages) assert.ok(env[stageEnvVar(stage)], `${id} ${arm} ${stage}`);
      assert.doesNotMatch(JSON.stringify(env), /anthropic|claude/i);
    }
    for (const line of plan.commands) assert.doesNotMatch(line, /anthropic-legacy|ALLOW_ANTHROPIC_LEGACY=/);
  }
});

test("plan output snapshot for each committed spec", () => {
  const floorStages = {
    "understand.clarity": "local:spark",
    "understand.intent": "local:spark",
    "understand.title": "local:spark",
    research: "none",
    spine: "local:spark",
    "spine-alt": "local:spark",
    deepen: "local:spark",
    writer: "local:spark",
    verifier: "local:spark",
    continuity: "local:spark",
    judge: "local:spark"
  };
  const envOf = (stages) => ({ [MODE_ENV]: "local", ...Object.fromEntries(Object.entries(stages).map(([s, v]) => [stageEnvVar(s), v])) });
  const G = "tools/generation-bench/golden/golden-v1.json";
  const snapshot = {
    "E0-floor": {
      A: { source: "reference", env: null, args: null },
      B: { source: "env", env: envOf(floorStages), args: ["--prompts", G, "--out", "data-local/swaps/E0-floor/B"] }
    },
    "E1-deepen-p40": {
      A: { source: "adopted", env: envOf(floorStages), args: ["--prompts", G, "--out", "data-local/swaps/E1-deepen-p40/A", "--keep-checkpoints"] },
      B: {
        source: "env",
        env: envOf({ ...floorStages, deepen: "local:second" }),
        args: ["--prompts", G, "--out", "data-local/swaps/E1-deepen-p40/B", "--seed-checkpoints", "data-local/swaps/E1-deepen-p40/A", "--rerun-from", "deepen"]
      }
    },
    "E2-continuity-p40": {
      A: { source: "adopted", env: envOf(floorStages), args: ["--prompts", G, "--out", "data-local/swaps/E2-continuity-p40/A", "--keep-checkpoints"] },
      B: {
        source: "env",
        env: envOf({ ...floorStages, continuity: "local:second" }),
        args: ["--prompts", G, "--out", "data-local/swaps/E2-continuity-p40/B", "--seed-checkpoints", "data-local/swaps/E2-continuity-p40/A", "--rerun-from", "stitch"]
      }
    },
    "E6-verifier-jev-vs-qwen": {
      A: { source: "adopted", env: envOf(floorStages), args: ["--prompts", G, "--out", "data-local/swaps/E6-verifier-jev-vs-qwen/A", "--keep-checkpoints"] },
      B: {
        source: "env",
        env: envOf({ ...floorStages, verifier: "jev" }),
        args: ["--prompts", G, "--out", "data-local/swaps/E6-verifier-jev-vs-qwen/B", "--seed-checkpoints", "data-local/swaps/E6-verifier-jev-vs-qwen/A", "--rerun-from", "narrate"]
      }
    }
  };
  for (const id of COMMITTED) {
    const plan = planExperiment(readSpec(path.join(EXPERIMENTS_DIR, `${id}.json`)), { contract: CONTRACT, stack: EMPTY_STACK, ledgerRows: [] });
    for (const arm of ["A", "B"]) {
      const got = plan.arms[arm];
      assert.deepEqual({ source: got.source, env: got.env, args: got.args }, snapshot[id][arm], `${id} arm ${arm}`);
    }
    assert.equal(plan.commands.filter((l) => l.startsWith("(cd backend && env -u FORAY_ALLOW_ANTHROPIC_LEGACY FORAY_GENERATION_MODE=local ")).length, id === "E0-floor" ? 1 : 2);
  }
});

test("plan refuses a spec that names anthropic or claude, sets the mode, or carries an endpoint or key", () => {
  const root = tmp();
  writeJson(path.join(root, "golden.json"), goldenOf(2, 1));
  const refused = (armB, re) => assert.throws(() => planExperiment(deepenSpec({ armB: { env: armB } }), { root, contract: CONTRACT }), re);
  refused({ FORAY_STAGE_DEEPEN: "anthropic" }, /names an Anthropic model or route/);
  refused({ FORAY_STAGE_DEEPEN: "local:second", [ALLOW_LEGACY_ENV]: "1" }, /names an Anthropic model or route/);
  refused({ FORAY_STAGE_DEEPEN: "local:second", FORAY_MODEL_SONNET: "claude-sonnet" }, /names an Anthropic model or route/);
  refused({ FORAY_STAGE_DEEPEN: "local:second", [MODE_ENV]: "local" }, /set by the tool/);
  refused({ FORAY_STAGE_DEEPEN: "local:second", FORAY_LLM_BASE_URL: "x" }, /operator's shell/);
  refused({ FORAY_STAGE_DEEPEN: "local:second", FORAY_JEV_API_KEY: "x" }, /operator's shell/);
  refused({ FORAY_STAGE_DEEPEN: "local" }, /without a lane/);
  refused({ FORAY_STAGE_DEEPEN: "local:third" }, /names lane "third"/);
  refused({ FORAY_STAGE_NOPE: "local:spark" }, /not a stage the backend routes/);
  assert.throws(
    () => planExperiment(deepenSpec({ expect: { stageAssignments: { deepen: { impl: "local", model: "claude-x" } } } }), { root, contract: CONTRACT }),
    /names an Anthropic model/
  );
});

test("plan refuses an arm that leaves a stage unassigned", () => {
  const root = tmp();
  writeJson(path.join(root, "golden.json"), goldenOf(2, 1));
  const env = floorEnv();
  delete env.FORAY_STAGE_JUDGE;
  delete env.FORAY_STAGE_SPINE_ALT;
  assert.throws(() => planExperiment(deepenSpec({ armA: { env } }), { root, contract: CONTRACT }), /arm A leaves stage\(s\) unassigned: spine-alt, judge/);
  const measure = { id: "T0", kind: "measure", armA: "reference", armB: { env: { FORAY_STAGE_SPINE: "local:spark" } }, rerunFrom: null, golden: "golden.json" };
  assert.throws(() => planExperiment(measure, { root, contract: CONTRACT }), /arm B leaves stage\(s\) unassigned/);
});

test("plan refuses golden prompts without bench: true", () => {
  const root = tmp();
  const golden = goldenOf(3, 1);
  delete golden[1].bench;
  writeJson(path.join(root, "golden.json"), golden);
  assert.throws(() => planExperiment(deepenSpec(), { root, contract: CONTRACT }), /without bench: true: p02/);
});

test("plan refuses an arm B that changes more or less than the spec's one stage, and a lever spec that changes a stage", () => {
  const root = tmp();
  writeJson(path.join(root, "golden.json"), goldenOf(2, 1));
  assert.throws(
    () => planExperiment(deepenSpec({ armB: { env: { FORAY_STAGE_DEEPEN: "local:second", FORAY_STAGE_SPINE: "local:second" } } }), { root, contract: CONTRACT }),
    /changes exactly its stage \(deepen\); arm B changes spine, deepen/
  );
  assert.throws(() => planExperiment(deepenSpec({ armB: { env: { FORAY_STAGE_DEEPEN: "local:spark" } } }), { root, contract: CONTRACT }), /arm B changes no stage/);
  assert.throws(
    () => planExperiment(deepenSpec({ armB: { env: { FORAY_STAGE_DEEPEN: "local:second", FORAY_WRITER_EXEMPLARS: "1" } } }), { root, contract: CONTRACT }),
    /changes no lever; arm B also changes FORAY_WRITER_EXEMPLARS/
  );
  const lever = { id: "T3", kind: "lever", lever: "exemplars", armA: { env: floorEnv() }, armB: { env: { FORAY_STAGE_DEEPEN: "local:second" } }, rerunFrom: null, golden: "golden.json" };
  assert.throws(() => planExperiment(lever, { root, contract: CONTRACT }), /lever experiment changes no stage/);
  const leverOk = { ...lever, armB: { env: { FORAY_WRITER_EXEMPLARS: "1" } } };
  assert.equal(planExperiment(leverOk, { root, contract: CONTRACT }).arms.B.levers.exemplars, true);
});

test("plan refuses a rerunFrom after the changed stage's first banked stage, a seeded measure, and a spec id that is not its file name", () => {
  const contract = CONTRACT;
  assert.match(validateSpec(deepenSpec({ rerunFrom: "narrate" }), contract).errors.join(), /after "deepen", the first banked stage deepen feeds/);
  assert.ok(validateSpec(deepenSpec({ rerunFrom: "spine" }), contract).ok);
  assert.match(validateSpec({ ...FLOOR, rerunFrom: "spine" }, contract).errors.join(), /no arm A run to seed from/);
  assert.match(validateSpec({ ...deepenSpec(), rerunFrom: undefined }, contract).errors.join(), /rerunFrom must be stated/);
  assert.match(validateSpec(deepenSpec({ armA: "reference" }), contract).errors.join(), /for a 'measure' experiment only/);
  assert.match(validateSpec(deepenSpec({ golden: "../outside.json" }), contract).errors.join(), /repo-relative/);
  const dir = tmp();
  writeJson(path.join(dir, "E9-x.json"), deepenSpec({ id: "E9-y" }));
  assert.throws(() => readSpec(path.join(dir, "E9-x.json")), /must equal the file name/);
});

test("the adopted arm is the floor overlaid with adopted-stack.json; an unmapped lever is refused", () => {
  const spec = readSpec(path.join(EXPERIMENTS_DIR, "E6-verifier-jev-vs-qwen.json"));
  const stack = { ...EMPTY_STACK, stages: { deepen: { impl: "local", model: "qwen3.6-35b-a3b", machine: "second" } }, ledgerRow: "E1-deepen-p40-1" };
  const rows = [{ id: "E1-deepen-p40-1", decision: "adopt" }];
  const plan = planExperiment(spec, { contract: CONTRACT, stack, ledgerRows: rows });
  assert.equal(plan.arms.A.env.FORAY_STAGE_DEEPEN, "local:second");
  assert.equal(plan.arms.B.env.FORAY_STAGE_DEEPEN, "local:second");
  assert.equal(plan.arms.B.env.FORAY_STAGE_VERIFIER, "jev");
  /* E1 against a stack that already adopted deepen-on-second changes nothing. */
  const e1 = readSpec(path.join(EXPERIMENTS_DIR, "E1-deepen-p40.json"));
  assert.throws(() => planExperiment(e1, { contract: CONTRACT, stack, ledgerRows: rows }), /arm B changes no stage/);
  /* A stack that does not cite a current adopt row is refused, as swap-ledger check refuses it. */
  assert.throws(() => planExperiment(spec, { contract: CONTRACT, stack, ledgerRows: [] }), /adopted-stack.json: ledgerRow/);
  assert.throws(
    () => planExperiment(spec, { contract: CONTRACT, stack: { ...EMPTY_STACK, levers: { selfCritique: true } }, ledgerRows: [] }),
    /lever "selfCritique", which has no backend flag mapped/
  );
  const withExemplars = planExperiment(spec, { contract: CONTRACT, stack: { ...EMPTY_STACK, levers: { exemplars: true } }, ledgerRows: [] });
  assert.equal(withExemplars.arms.A.env.FORAY_WRITER_EXEMPLARS, "1");
});

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

function runPlan() {
  const root = tmp();
  writeJson(path.join(root, "golden.json"), goldenOf(2, 1));
  return { root, plan: planExperiment(deepenSpec(), { root, contract: CONTRACT }) };
}

test("run executes each arm through the injected spawn with FORAY_GENERATION_MODE=local and the arm's FORAY_STAGE_* set", async () => {
  const { root, plan } = runPlan();
  const calls = [];
  const inherited = { PATH: "p", [ALLOW_LEGACY_ENV]: "1", ANTHROPIC_API_KEY: "sk-x", FORAY_STAGE_DEEPEN: "anthropic", FORAY_GENERATION_MODE: "anthropic-legacy", FORAY_LLM_BASE_URL: "lan" };
  const results = await runExperiment(plan, { root, contract: CONTRACT, inherited, out: quiet, spawn: async (call) => (calls.push(call), 0) });
  assert.deepEqual(results.map((r) => [r.arm, r.code]), [["A", 0], ["B", 0]]);
  const entry = driverEntry(JSON.parse(fs.readFileSync(path.join(REPO, "backend", "package.json"), "utf8")));
  assert.equal(entry, "src/cli/generateForays.ts");
  for (const call of calls) {
    assert.equal(call.cwd, path.join(REPO, "backend"));
    assert.equal(call.args[0], entry);
    assert.equal(call.env[MODE_ENV], "local");
    assert.equal(call.env[ALLOW_LEGACY_ENV], undefined);
    assert.equal(call.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(call.env.FORAY_LLM_BASE_URL, "lan", "the operator's endpoint is inherited");
    for (const stage of CONTRACT.stages) assert.equal(call.env[stageEnvVar(stage)], plan.arms[call.arm].env[stageEnvVar(stage)]);
  }
  assert.equal(calls[0].env.FORAY_STAGE_DEEPEN, "local:spark");
  assert.equal(calls[1].env.FORAY_STAGE_DEEPEN, "local:second");
  assert.deepEqual(calls[1].args.slice(-4), ["--seed-checkpoints", path.join(root, "data-local/swaps/T1-deepen/A"), "--rerun-from", "deepen"]);
});

test("--dry-run spawns nothing", async () => {
  const { root, plan } = runPlan();
  const lines = [];
  const results = await runExperiment(plan, {
    root,
    contract: CONTRACT,
    dryRun: true,
    out: (l) => lines.push(l),
    spawn: () => {
      throw new Error("spawned under --dry-run");
    }
  });
  assert.deepEqual(results.map((r) => r.code), [null, null]);
  assert.equal(lines.filter((l) => l.startsWith("[dry-run] arm ")).length, 2);
  assert.equal(fs.existsSync(path.join(root, "data-local")), false);
});

test("an anthropic override is refused before anything is spawned", async () => {
  const root = tmp();
  writeJson(path.join(root, "golden.json"), goldenOf(2, 1));
  const dir = path.join(root, "experiments");
  writeJson(path.join(dir, "T1-deepen.json"), deepenSpec({ armB: { env: { FORAY_STAGE_DEEPEN: "anthropic" } } }));
  let spawned = 0;
  await assert.rejects(
    main(["run", path.join(dir, "T1-deepen.json")], quiet, { root, contract: CONTRACT, spawn: async () => (spawned++, 0) }),
    /names an Anthropic model or route/
  );
  /* A plan edited after planning is still checked, for EVERY arm, before the first spawn. */
  const { plan } = runPlan();
  plan.arms.B.env = { ...plan.arms.B.env, FORAY_STAGE_WRITER: "anthropic" };
  await assert.rejects(runExperiment(plan, { root, contract: CONTRACT, out: quiet, spawn: async () => (spawned++, 0) }), /refusing to spawn: FORAY_STAGE_WRITER names Anthropic/);
  assert.equal(spawned, 0);
  assert.throws(() => assertArmEnv({ [MODE_ENV]: "local" }, CONTRACT), /FORAY_STAGE_UNDERSTAND_CLARITY is not set/);
});

test("a failed arm A stops arm B; a measure runs arm B only", async () => {
  const { root, plan } = runPlan();
  const arms = [];
  const results = await runExperiment(plan, { root, contract: CONTRACT, out: quiet, spawn: async (c) => (arms.push(c.arm), 3) });
  assert.deepEqual(arms, ["A"]);
  assert.deepEqual(results.map((r) => r.code), [3]);
  const e0 = planExperiment(FLOOR, { contract: CONTRACT });
  const e0arms = [];
  await runExperiment(e0, { contract: CONTRACT, out: quiet, spawn: async (c) => (e0arms.push(c.arm), 0) });
  assert.deepEqual(e0arms, ["B"]);
});

/* ------------------------------------------------------------------ */
/* collect                                                             */
/* ------------------------------------------------------------------ */

test("collect pairs rows by prompt and drops unseeded B rows when rerunFrom is set", () => {
  const { evidence } = collected({
    n: 4,
    edit: (e, arm, id) => {
      if (arm === "B" && id === "p02") e.seededFrom = null;
      if (arm === "B" && id === "p03") delete e.seededFrom;
    }
  });
  assert.equal(evidence.schema, EVIDENCE_SCHEMA);
  assert.deepEqual(evidence.prompts.map((p) => p.promptId), ["p01", "p04"]);
  assert.deepEqual(evidence.dropped, [
    { promptId: "p02", reason: "arm B unseeded while rerunFrom is deepen" },
    { promptId: "p03", reason: "arm B unseeded while rerunFrom is deepen" }
  ]);
  const p = evidence.prompts[0];
  assert.deepEqual(p.candidates, { A: "cand-p01-a", B: "cand-p01-b" });
  assert.equal(p.mq.A["MQ-01"].value, 1, "MQ cells come from the scorecard (run.mjs rowFor)");
  assert.equal(p.mq.B["MQ-04"].value, 8);
  assert.equal(p.preference, null);
  assert.deepEqual(evidence.arms.B.stack.deepen, "local:second");
  assert.equal(evidence.timingFrom, "deepen");
  assert.ok(evidence.goldenCompare.length > 0, "the GEN-05 compare runs when the manifest loads");
});

test("collect keeps unseeded B rows when no rerunFrom is set", () => {
  const { evidence } = collected({ n: 2, spec: deepenSpec({ rerunFrom: null }), edit: (e, arm) => arm === "B" && (e.seededFrom = null) });
  assert.equal(evidence.prompts.length, 2);
});

test("collect refuses when a report's stageAssignments or levers do not match the plan and spec.expect", () => {
  /* Arm B's deepen silently ran on the Spark: the flag did nothing. */
  assert.throws(
    () => collected({ n: 2, edit: (e, arm) => arm === "B" && (e.stageAssignments.deepen = { impl: "local", model: "q", machine: "spark" }) }),
    /arm B row p01 deepen: ran local@spark, planned local@second/
  );
  assert.throws(() => collected({ n: 2, edit: (e, arm, id) => arm === "A" && id === "p02" && delete e.stageAssignments }), /arm A row p02 records no stageAssignments/);
  assert.throws(
    () => collected({ n: 2, spec: deepenSpec({ expect: { stageAssignments: { deepen: { impl: "local", machine: "second", model: "qwen-p40" } } } }) }),
    /deepen.model: "qwen-second", expected "qwen-p40"/
  );
  assert.throws(() => collected({ n: 2, spec: deepenSpec({ expect: { levers: { exemplars: true } } }) }), /records no levers/);
  assert.throws(
    () => collected({ n: 2, spec: deepenSpec({ expect: { levers: { exemplars: true } } }), edit: (e, arm) => (e.levers = { exemplars: arm === "B" ? false : undefined }) }),
    /lever exemplars: false, expected true/
  );
  assert.throws(() => collected({ n: 2, edit: (e, arm) => arm === "B" && (e.anthropicCalls = 2) }), /sent 2 Anthropic request\(s\)/);
  assert.throws(() => collected({ n: 2, corpus: { A: "fp-1", B: "fp-2" } }), /different corpora/);
});

test("evidence is unfrozen unless both arms name the same corpus fingerprint", () => {
  assert.equal(collected({ n: 1 }).evidence.corpusFingerprint, "fp-1");
  assert.equal(collected({ n: 1, corpus: { A: "fp-1", B: null } }).evidence.corpusFingerprint, "unfrozen");
});

test("timing deltas cover the changed stage and later stages, and never a stage marked resumed", () => {
  const { evidence } = collected({
    n: 2,
    edit: (e, arm) => {
      if (arm !== "B") return;
      for (const t of e.veracity.stageTimings) if (["understand", "research-shape", "spine"].includes(t.name)) t.resumed = true;
      for (const t of e.veracity.stageTimings) if (t.name === "spine") t.ms = 1;
      for (const t of e.veracity.stageTimings) if (t.name.startsWith("narrate:")) t.ms *= 2;
    }
  });
  const stages = evidence.timing.map((r) => r.stage);
  assert.deepEqual(stages, ["deepen", "source", "evidence", "narrate", "stitch", "finalize"]);
  const narrate = evidence.timing.find((r) => r.stage === "narrate");
  assert.ok(narrate.B > narrate.A, "a real delta is carried");
  assert.equal(evidence.timing.find((r) => r.stage === "deepen").A, 247163);
  /* A resumed stage at or after the start is marked and carries no numbers. */
  const pair = (resumeB) => {
    const a = JSON.parse(JSON.stringify(OUT9_ENTRY));
    const b = JSON.parse(JSON.stringify(OUT9_ENTRY));
    for (const t of b.veracity.stageTimings) if (t.name.startsWith(resumeB)) t.resumed = true;
    return { A: a, B: b };
  };
  const rows = timingDeltas([pair("deepen")], "deepen", CONTRACT);
  assert.deepEqual(rows[0], { stage: "deepen", A: null, B: null, resumed: true });
  assert.ok(rows.slice(1).every((r) => !r.resumed && r.A !== null));
  assert.deepEqual(timingDeltas([pair("zzz")], "nowhere", CONTRACT), []);
});

test("collect seals a blind pair for every listened prompt only, and the evidence never says which label is which arm", () => {
  const root = tmp();
  const golden = goldenOf(3, 2);
  writeJson(path.join(root, "golden.json"), golden);
  const plan = planExperiment(deepenSpec(), { root, contract: CONTRACT });
  writeArms(root, plan, golden);
  const keyDir = path.join(root, "keys");
  const packs = fakePacks(keyDir);
  const lines = [];
  const evidence = collectExperiment(plan, { root, contract: CONTRACT, packBuilder: packs.builder, keyDir, out: (l) => lines.push(l) });
  assert.deepEqual(packs.calls.map((c) => c.promptId), ["p01", "p02"]);
  assert.equal(packs.calls[0].act, 1);
  assert.equal(packs.calls[0].a.stageSwap, BASELINE_LABEL);
  assert.equal(packs.calls[0].b.stageSwap, "T1-deepen");
  assert.equal(packs.calls[0].outDir, path.join(root, "data-local/swaps/T1-deepen/packs/p01"));
  assert.deepEqual(evidence.prompts.map((p) => p.packId), ["pk-t1-deepen-p01", "pk-t1-deepen-p02", null]);
  const written = fs.readFileSync(path.join(root, "data-local/swaps/T1-deepen/evidence.json"), "utf8");
  assert.doesNotMatch(written, /"label"|"seed"/);
  assert.doesNotMatch(lines.join("\n"), /label A is|label B is/);
});

/* ------------------------------------------------------------------ */
/* decide                                                              */
/* ------------------------------------------------------------------ */

function allCards(c, prefer, scores = () => [4, 4]) {
  return c.evidence.prompts.flatMap((p, i) => cardsFor(p.packId, c.packs.labels.get(p.promptId), prefer(i), ...scores(i)));
}

const decideWith = (c, cards, extra = {}) =>
  decideExperiment(c.evidence, cards, { contract: CONTRACT, ledger: c.ledger, doc: c.doc, stackFile: c.stackFile, keyDir: c.keyDir, commit: "abc1234", out: quiet, ...extra });

test("decide: adopt writes the row, re-renders the table and prints the adopted-stack diff", () => {
  const c = collected();
  const { row, verdict, stackDiff } = decideWith(c, allCards(c, (i) => (i % 3 === 0 ? "B" : "tie")));
  assert.equal(verdict.decision, "adopt", JSON.stringify(verdict.failing));
  assert.deepEqual(readLedger(c.ledger), [row]);
  assert.equal(row.id, "T1-deepen-1");
  assert.equal(row.stage, "deepen");
  assert.deepEqual(row.pairwise, { wins: 4, ties: 6, losses: 0, listener: "founder", listenedOn: "2026-10-21", packId: c.evidence.prompts.map((p) => p.packId).sort() });
  assert.equal(row.armA.stack.deepen, "local:spark");
  assert.equal(row.armB.stack.deepen, "local:second");
  assert.equal(row.corpusFingerprint, "fp-1");
  assert.match(fs.readFileSync(c.doc, "utf8"), /\| T1-deepen-1 \| T1-deepen \| stage \| stage deepen \| 4 \/ 6 \/ 0 \| adopt \|/);
  assert.match(stackDiff, /\+ {3}"ledgerRow": "T1-deepen-1"/);
  assert.match(stackDiff, /"impl": "local",\n\+ {7}"model": "qwen-second",\n\+ {7}"machine": "second"/);
  assert.equal(JSON.parse(fs.readFileSync(c.stackFile, "utf8")).ledgerRow, null, "the stack is never written by the tool");
});

test("decide maps blind labels back to arms: an A-preferred label that is arm B counts as a B win", () => {
  const c = collected({ n: 2 });
  /* Prompt p02's pack has the labels swapped; preferring arm B there means the card says "A". */
  assert.deepEqual(c.packs.labels.get("p02"), { A: "B", B: "A" });
  const cards = allCards(c, () => "B");
  assert.equal(cards.find((x) => x.packId.endsWith("p02")).preference, "A");
  const { verdict } = decideWith(c, cards);
  assert.deepEqual(verdict.pairwise, { wins: 2, ties: 0, losses: 0, pairs: 2 });
  /* Scores are mapped too: arm A scored 2 everywhere, arm B 4. */
  const c2 = collected({ n: 2 });
  const { verdict: v2 } = decideWith(c2, allCards(c2, () => "B", () => [2, 4]));
  assert.equal(v2.axisMeans.A.onSubject, 2);
  assert.equal(v2.axisMeans.B.onSubject, 4);
});

test("decide: hold on unfrozen evidence, reject when arm A wins", () => {
  const hold = collected({ corpus: { A: null, B: null } });
  const h = decideWith(hold, allCards(hold, () => "tie"));
  assert.equal(h.row.decision, "hold");
  assert.ok(h.verdict.failing.includes("corpus-frozen"));
  const reject = collected();
  const r = decideWith(reject, allCards(reject, (i) => (i < 6 ? "A" : "B")));
  assert.equal(r.row.decision, "reject");
  assert.equal(r.stackDiff, null);
  assert.deepEqual([r.row.pairwise.wins, r.row.pairwise.losses], [4, 6]);
});

test("decide: E0-style measure pairs arm B with the committed reference Foray and records 'measured'", () => {
  const root = tmp();
  const golden = goldenOf(2, 1, () => ({ kind: "forays-json", forayId: "ref-foray" }));
  writeJson(path.join(root, "golden.json"), golden);
  writeJson(path.join(root, "data", "forays.json"), { forays: [{ ...JSON.parse(OUT9_CANDIDATE), id: "ref-foray", runtime_sec: 900 }] });
  const spec = { ...FLOOR, id: "T0-floor", golden: "golden.json" };
  const plan = planExperiment(spec, { root, contract: CONTRACT });
  writeArms(root, plan, golden, { arms: ["B"] });
  const keyDir = path.join(root, "keys");
  const packs = fakePacks(keyDir);
  const evidence = collectExperiment(plan, { root, contract: CONTRACT, packBuilder: packs.builder, keyDir, out: quiet });
  assert.deepEqual(evidence.prompts.map((p) => p.promptId), ["p01"]);
  assert.deepEqual(evidence.dropped, [{ promptId: "p02", reason: "no committed reference" }]);
  assert.equal(packs.calls[0].a.stageSwap, REFERENCE_LABEL);
  assert.equal(packs.calls[0].a.candidateId, "ref-foray");
  assert.equal(evidence.prompts[0].mq.A["MQ-01"].value, null, "a published Foray carries no run report");
  assert.deepEqual(evidence.timing, []);
  const ledger = path.join(root, "ledger.jsonl");
  const cards = cardsFor("pk-t0-floor-p01", packs.labels.get("p01"), "A");
  const { row } = decideExperiment(evidence, cards, { contract: CONTRACT, ledger, doc: path.join(root, "absent.md"), keyDir, commit: "abc1234", out: quiet });
  assert.equal(row.decision, "measured");
  assert.equal(row.kind, "measure");
  assert.equal(row.stage, undefined);
  assert.equal(row.runDirs.A, "data/forays.json");
  assert.deepEqual([row.pairwise.wins, row.pairwise.losses], [0, 1]);
});

test("decide refuses cards whose pack id or key does not match the experiment", () => {
  const c = collected({ n: 2 });
  const good = allCards(c, () => "tie");
  const foreign = cardsFor("pk-other-experiment", { A: "A", B: "B" }, "tie");
  assert.throws(() => decideWith(c, [...good, ...foreign]), /not in experiment T1-deepen: pk-other-experiment-A -> pk-other-experiment/);
  const keyFile = path.join(c.keyDir, "pk-t1-deepen-p01.key.json");
  const key = JSON.parse(fs.readFileSync(keyFile, "utf8"));
  writeJson(keyFile, { ...key, promptId: "p09" });
  assert.throws(() => decideWith(c, good), /key for pack pk-t1-deepen-p01 does not match experiment T1-deepen: names prompt p09/);
  writeJson(keyFile, { ...key, B: { ...key.B, candidateId: "someone-else" } });
  assert.throws(() => decideWith(c, good), /label B is candidate someone-else/);
  writeJson(keyFile, { ...key, A: { ...key.A, stageSwap: "E9-other" } });
  assert.throws(() => decideWith(c, good), /stageSwap "E9-other"/);
  fs.rmSync(keyFile);
  assert.throws(() => decideWith(c, good), /cannot unseal: missing key/);
  assert.equal(readLedger(c.ledger).length, 0, "nothing is appended on a refusal");
});

test("decide refuses without a commit, and the CLI decides from evidence.json and a cards file", async () => {
  const c = collected({ n: 2 });
  const cards = allCards(c, () => "tie");
  assert.throws(() => decideWith(c, cards, { commit: undefined }), /needs the commit/);
  const dir = path.join(c.root, "experiments");
  writeJson(path.join(dir, "T1-deepen.json"), { ...deepenSpec() });
  const cardsFile = path.join(c.root, "cards.jsonl");
  fs.writeFileSync(cardsFile, cards.map((x) => JSON.stringify(x)).join("\n") + "\n");
  const lines = [];
  const result = await main(["decide", path.join(dir, "T1-deepen.json"), "--cards", cardsFile, "--commit", "abc1234", "--key-dir", c.keyDir], (l) => lines.push(l), {
    root: c.root,
    contract: CONTRACT,
    ledger: c.ledger,
    doc: c.doc,
    stackFile: c.stackFile
  });
  assert.equal(result.row.decision, "hold", "two listened prompts are fewer than the 10 the rule needs");
  assert.ok(result.verdict.failing.includes("listened"));
  assert.match(lines[0], /^T1-deepen: hold/);
});

/* ------------------------------------------------------------------ */
/* Structure and the committed specs                                   */
/* ------------------------------------------------------------------ */

test("structural: the runner has no network use, no Anthropic call path and no relay import", () => {
  const src = fs.readFileSync(path.join(HERE, "swap-experiment.mjs"), "utf8");
  assert.doesNotMatch(src, /fetch|https?\b|node:net|node:dgram/i);
  assert.doesNotMatch(src, /anthropicCall\b|@anthropic-ai|relay\.mjs|start-run\.mjs/);
  assert.match(src, /import \{ spawn as spawnChild \} from "node:child_process"/, "the only process start is the default spawner run injects");
});

test("the committed specs: valid, named after their files, E0 is the all-Spark floor, the rest change one FORAY_STAGE_* each", () => {
  const files = fs.readdirSync(EXPERIMENTS_DIR).filter((f) => f.endsWith(".json")).sort();
  assert.deepEqual(files, COMMITTED.map((id) => `${id}.json`));
  for (const id of COMMITTED) {
    const spec = readSpec(path.join(EXPERIMENTS_DIR, `${id}.json`));
    assert.ok(validateSpec(spec, CONTRACT).ok, `${id}: ${validateSpec(spec, CONTRACT).errors}`);
    assert.equal(spec.golden, "tools/generation-bench/golden/golden-v1.json");
    if (id === "E0-floor") {
      assert.equal(spec.kind, "measure");
      for (const stage of CONTRACT.stages) assert.equal(spec.armB.env[stageEnvVar(stage)], stage === "research" ? "none" : "local:spark", stage);
    } else {
      assert.equal(spec.kind, "stage");
      assert.equal(spec.armA, "adopted");
      assert.deepEqual(Object.keys(spec.armB.env), [stageEnvVar(spec.stage)]);
      assert.deepEqual(Object.keys(spec.expect.stageAssignments), [spec.stage]);
    }
  }
});

test("CLI: plan --json prints the plan; an unknown command or flag is refused", async () => {
  const lines = [];
  const plan = await main(["plan", "E2-continuity-p40", "--json"], (l) => lines.push(l), { contract: CONTRACT, stack: EMPTY_STACK, ledgerRows: [] });
  assert.deepEqual(JSON.parse(lines[0]), plan);
  await assert.rejects(main(["bogus", "E2-continuity-p40"], quiet, { contract: CONTRACT, stack: EMPTY_STACK, ledgerRows: [] }), /unknown command bogus/);
  await assert.rejects(main(["plan", "E2-continuity-p40", "--nope"], quiet, { contract: CONTRACT }), /unknown flag --nope/);
  await assert.rejects(main([], quiet), /usage:/);
  assert.match(lineDiff("a\nb", "a\nc"), /^ {2}a\n- b\n\+ c$/);
});
