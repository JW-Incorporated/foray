/* The JS parity runner (NE-03, plan §6.2-6.3): load fixtures, validate them
   against the schema, and run one case against the JS reference.

   JS IS THE REFERENCE. This file never decides what a rule should return; it
   asks the real module and writes down the answer (`record.mjs`), or asks again
   and compares (`run.test.js`, `record.mjs --check`). The Swift
   `ForayEngineParity` library reads the same fixture files in place and runs
   its port of each rule against the same `expect`.

   THREE CASE SHAPES, and a case is exactly one of them:

     read      {id, covers, read: "SEAM_GAP_SEC", expect: {value}}
               an exported constant. The rule "the beat is 2.0 s" is a value,
               and a Swift port that hard-codes 2.5 must fail a case, not only
               the generated-constants check.
     call      {id, covers, call: "seamGapSec", args: [...], expect: {return} | {throws}}
               a pure function of its arguments.
     scenario  {id, covers, setup, steps: [...], expect: {checkpoints, ops}}
               a stateful object driven by verbs, asserted on its op log.

   The module a read or call targets is the fixture FILE's `module`, so a
   family's cases cannot quietly split across two implementations.

   Everything a case produces goes through `codec.encode`, so what is compared
   is exactly what is written to disk. */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { encode, expandInputs, containsMacro, HarnessError } from "./codec.js";
import {
  OpLog, FakeBackend, MemoryStore, fakeTts, fakeInterlude, instantScheduler, manualScheduler, tick,
} from "./fakes.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Repo root, from this file's own location (player/parity/). */
export const REPO_ROOT = path.resolve(HERE, "..", "..");

/** Where the harness's data lives, relative to a root. */
export const PARITY_DIR = "player/parity";
export const FIXTURES_DIR = `${PARITY_DIR}/fixtures`;

export function readJson(root, rel) {
  return JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
}

let schemaCache = null;
/** The schema, read from disk: its enums are the closed sets this file checks. */
export function loadSchema() {
  if (!schemaCache) schemaCache = readJson(REPO_ROOT, `${PARITY_DIR}/schema/fixture.schema.json`);
  return schemaCache;
}

/** The closed sets, from the schema — never restated here. */
export function closedSets(schema = loadSchema()) {
  const d = schema.$defs;
  return {
    verbs: d.verb.enum,
    harnessErrors: d.harnessError.enum,
    thrownNames: d.thrown.properties.name.enum,
    targets: d.setup.properties.target.enum,
    idPattern: new RegExp(d.caseId.pattern),
    familyPattern: new RegExp(d.family.pattern),
  };
}

/* ---------- loading ---------- */

/**
 * Every fixture file under `player/parity/fixtures/<family>/*.json`.
 * @returns {{family: string, file: string, doc: object}[]}  `file` is repo-relative POSIX
 */
export function loadFixtures(root = REPO_ROOT, { family = null } = {}) {
  const base = path.join(root, FIXTURES_DIR);
  if (!fs.existsSync(base)) return [];
  const out = [];
  const families = fs.readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory()).map((d) => d.name).sort();
  for (const fam of families) {
    if (family && fam !== family) continue;
    const files = fs.readdirSync(path.join(base, fam)).filter((f) => f.endsWith(".json")).sort();
    for (const f of files) {
      const file = `${FIXTURES_DIR}/${fam}/${f}`;
      out.push({ family: fam, file, doc: readJson(root, file) });
    }
  }
  return out;
}

/** The kind of a case, by which discriminating key it carries. */
export function caseKind(c) {
  const kinds = ["read", "call", "steps"].filter((k) => k in c);
  if (kinds.length !== 1) return null;
  return { read: "read", call: "call", steps: "scenario" }[kinds[0]];
}

/**
 * Validate every loaded fixture. Returns problems as strings; empty = valid.
 * The checks are the schema's, applied by hand (the harness takes no
 * dependencies), plus the ones a per-file schema cannot express: ids unique
 * across the whole tree, and a file's `family` equal to its directory.
 */
export function validateFixtures(fixtures, schema = loadSchema()) {
  const sets = closedSets(schema);
  const problems = [];
  const seen = new Map();
  const jsOnlyOf = new Map();
  for (const { family, file, doc } of fixtures) {
    /* A family is ported or it is not; half a family marked JS-only would hide
       its ported half from swift-pending (plan §5.5 C-2). */
    const jsOnly = doc.jsOnly === true;
    if ("jsOnly" in doc && typeof doc.jsOnly !== "boolean") problems.push(`${file}: jsOnly must be a boolean`);
    if (jsOnlyOf.has(family) && jsOnlyOf.get(family) !== jsOnly) problems.push(`${file}: jsOnly disagrees with another file of family "${family}"`);
    jsOnlyOf.set(family, jsOnly);
    const where = (m) => problems.push(`${file}: ${m}`);
    if (doc.family !== family) where(`family "${doc.family}" does not match its directory "${family}"`);
    if (!sets.familyPattern.test(family)) where(`family "${family}" is not a valid family name`);
    if (!Array.isArray(doc.cases) || !doc.cases.length) { where("has no cases"); continue; }
    const needsModule = doc.cases.some((c) => "read" in c || "call" in c);
    if (needsModule && typeof doc.module !== "string") where("has read/call cases but no `module`");
    const allowed = new Set(Object.keys(schema.properties));
    for (const k of Object.keys(doc)) if (!allowed.has(k)) where(`unknown top-level key "${k}"`);
    doc.cases.forEach((c, i) => {
      const at = (m) => where(`case ${c?.id ?? `#${i}`}: ${m}`);
      if (typeof c.id !== "string" || !sets.idPattern.test(c.id)) return at("id must match " + sets.idPattern);
      if (!c.id.startsWith(`${family}/`)) at(`id must start with "${family}/"`);
      if (seen.has(c.id)) at(`duplicate id (also in ${seen.get(c.id)})`);
      seen.set(c.id, file);
      if (!Array.isArray(c.covers)) at("covers must be an array (it may be empty)");
      else for (const cv of c.covers) if (typeof cv !== "string" || !cv.includes("::")) at(`covers entry ${JSON.stringify(cv)} is not "<suite>::<test name>"`);
      const kind = caseKind(c);
      if (!kind) return at("must have exactly one of read / call / steps");
      const caseKeys = new Set(Object.keys(schema.$defs.case.properties));
      for (const k of Object.keys(c)) if (!caseKeys.has(k)) at(`unknown key "${k}"`);
      if (c.authored === true && !("expect" in c)) at("an authored case must carry its expect");
      if ("expect" in c) {
        if (containsMacro(c.expect)) at("expect may not use a macro — macros are inputs only");
        const e = c.expect ?? {};
        if (kind === "read" && !("value" in e)) at("a read case's expect is {value}");
        if (kind === "call" && ("return" in e) === ("throws" in e)) at("a call case's expect is exactly one of {return} / {throws}");
        if (kind === "call" && "throws" in e && !sets.thrownNames.includes(e.throws?.name)) {
          at(`throws.name must be one of ${sets.thrownNames.join(", ")}`);
        }
        if (kind === "scenario" && !Array.isArray(e.checkpoints)) at("a scenario's expect is {checkpoints, ops}");
      }
      if (kind === "call" && "args" in c && !Array.isArray(c.args)) at("args must be an array");
      if (kind === "scenario") {
        if (!c.setup || !sets.targets.includes(c.setup.target)) at(`setup.target must be one of ${sets.targets.join(", ")}`);
        c.steps.forEach((s, j) => {
          const verbs = Object.keys(s).filter((k) => sets.verbs.includes(k));
          if (verbs.length !== 1) at(`step ${j} must carry exactly one verb (${sets.verbs.join(", ")})`);
        });
      }
      if ("tolerance" in c && !(typeof c.tolerance === "number" && c.tolerance >= 0)) at("tolerance must be a non-negative number");
    });
  }
  return problems;
}

/* ---------- running ---------- */

const moduleCache = new Map();
async function importModule(root, rel) {
  const url = pathToFileURL(path.join(root, rel)).href;
  if (!moduleCache.has(url)) moduleCache.set(url, await import(url));
  return moduleCache.get(url);
}

/** Map a thrown value to the schema's closed `thrown.name` set. */
function thrownName(err) {
  const name = err?.name;
  return ["TypeError", "RangeError"].includes(name) ? name : "Error";
}

/**
 * Run one case against the JS reference.
 * @param {object} c        the case
 * @param {object} fixture  `{family, doc}` it came from
 * @param {object} [opts]   `{root}`
 * @returns {Promise<object>} the encoded actual, same shape as an `expect`
 */
export async function runCase(c, fixture, { root = REPO_ROOT } = {}) {
  const kind = caseKind(c);
  const ctx = { root };
  if (kind === "read" || kind === "call") {
    const mod = await importModule(root, fixture.doc.module);
    const name = kind === "read" ? c.read : c.call;
    if (!(name in mod)) throw new HarnessError("E_UNKNOWN_EXPORT", `${fixture.doc.module} has no export "${name}"`);
    if (kind === "read") return { value: encode(mod[name]) };
    if (typeof mod[name] !== "function") throw new HarnessError("E_NOT_A_FUNCTION", `${fixture.doc.module}#${name} is not a function`);
    const args = expandInputs(c.args ?? [], ctx);
    try {
      return { return: encode(await mod[name](...args)) };
    } catch (err) {
      if (err instanceof HarnessError) throw err;
      return { throws: { name: thrownName(err) } };
    }
  }
  if (kind === "scenario") return runScenario(c, ctx);
  throw new HarnessError("E_BAD_CASE", `case ${c.id} has no runnable shape`);
}

/* ---------- scenarios ---------- */

/** Verbs whose JS driver does not exist yet, and the card that adds it. They
    are legal in the schema — the Swift runner needs the vocabulary now — but a
    JS case using one fails loudly rather than being silently skipped. */
export const PENDING_DRIVERS = Object.freeze({
  session: "NE-11j",
  lifecycle: "NE-14j",
  /* NE-12j recorded media-session's episode subset without it: the remote-press
     table is a pure function of a surface and the presses, asked through
     player/parity/media-actions.js, so no press needed a manager behind it. The
     media-session tests that DO press a lock-screen button into a live manager
     are the Foray ones (a real Foray's nexttrack, previoustrack, pause, seekto),
     and NE-12j left them in unported.json for NE-29j — so NE-29j is the first
     card that needs this driver. */
  remote: "NE-29j",
});

/** The manager methods a `call` step may invoke. A closed list: a scenario is
    a claim about the public surface, and `_private` methods are not one. */
export const MANAGER_CALLS = Object.freeze([
  "setQueueFromPick", "loadQueue", "setQueueFromForay", "playForay", "play", "resume", "pause",
  "skipToNext", "skipToPrevious", "stop", "seek", "setRate", "setVoice", "setInterludeEnabled",
  "interruptionBegan", "interruptionEnded", "routeChanged", "restoreColdLaunchState",
  "reconcileWithBackend",
]);

/** What a checkpoint records about the manager. Plain data only. */
function managerView(m) {
  return {
    index: m.currentIndex,
    inInterlude: m.inInterlude,
    inSeamGap: m.inSeamGap,
    playhead: m.playheadItemId ?? null,
    rate: m.rate,
    state: m.state?.type ?? null,
  };
}

async function runScenario(c, ctx) {
  const setup = expandInputs(c.setup ?? {}, ctx);
  if (setup.target !== "manager") throw new HarnessError("E_SCENARIO_TARGET", `no JS driver for target "${setup.target}"`);
  const { PlayerQueueManager, __resetInstanceForTests } = await importModule(ctx.root, "player/queue-manager.js");

  const log = new OpLog();
  const backend = new FakeBackend({ log, ...(setup.backend ?? {}) });
  const store = new MemoryStore({ log });
  for (const [id, seconds] of Object.entries(setup.positions ?? {})) store.positions.set(id, { seconds });
  const scheduler = setup.scheduler === "manual" ? manualScheduler() : instantScheduler();
  const tts = setup.tts ? fakeTts({ log, ...(typeof setup.tts === "object" ? setup.tts : {}) }) : null;
  const interlude = setup.interlude ? fakeInterlude({ log, ...(typeof setup.interlude === "object" ? setup.interlude : {}) }) : null;
  const catalogue = setup.catalogue ?? {};

  __resetInstanceForTests();
  const m = new PlayerQueueManager({
    backend, positionStore: store, scheduler, tts, interlude,
    ...(setup.rate !== undefined ? { rate: setup.rate } : {}),
    ...(setup.seamGapSec !== undefined ? { seamGapSec: setup.seamGapSec } : {}),
    ...(setup.interludeEnabled !== undefined ? { interludeEnabled: setup.interludeEnabled } : {}),
  });

  const { verbs } = closedSets();
  const checkpoints = [];
  let mark = 0;
  const checkpoint = (name) => {
    checkpoints.push({ name, ops: log.since(mark), ...managerView(m) });
    mark = log.length;
  };
  const floating = [];
  let ops = [];

  try {
    for (const [i, step] of c.steps.entries()) {
      const verb = Object.keys(step).find((k) => verbs.includes(k));
      if (!verb) throw new HarnessError("E_UNKNOWN_VERB", `step ${i} of ${c.id} has no known verb`);
      if (verb in PENDING_DRIVERS) {
        throw new HarnessError("E_NO_JS_DRIVER", `the "${verb}" verb has no JS driver yet (${PENDING_DRIVERS[verb]} adds it)`);
      }
      switch (verb) {
        case "call": {
          if (!MANAGER_CALLS.includes(step.call)) throw new HarnessError("E_UNKNOWN_EXPORT", `"${step.call}" is not a manager call a scenario may make`);
          let args = expandInputs(step.args ?? [], ctx);
          // A Foray needs a resolver, and a function cannot live in JSON: the
          // scenario's `catalogue` is that resolver's table.
          if (step.call === "playForay" || step.call === "setQueueFromForay") {
            args = [args[0], { ...(args[1] ?? {}), resolveItem: (id) => catalogue[id] ?? null }];
          }
          const p = Promise.resolve(m[step.call](...args));
          if (step.await === false) floating.push(p.catch(() => {}));
          else await p;
          break;
        }
        case "settle":
          for (let n = 0; n < (Number.isInteger(step.settle) && step.settle > 0 ? step.settle : 1); n++) await tick();
          break;
        case "clock":
          if (!scheduler.advance) throw new HarnessError("E_BAD_CASE", `"clock" needs setup.scheduler = "manual"`);
          await scheduler.advance(step.clock);
          break;
        case "deck":
          if (step.deck === "ended") floating.push(Promise.resolve(backend.onItemEnded?.(step.reason ?? "natural")).catch(() => {}));
          else if (step.deck === "error") floating.push(Promise.resolve(backend.onError?.(step.message ?? "error")).catch(() => {}));
          else if (step.deck === "time") backend.currentTime = step.sec;
          else if (step.deck === "duration") backend.duration = step.sec;
          else if (step.deck === "audible") backend.paused = step.audible === false;
          else throw new HarnessError("E_BAD_CASE", `unknown deck event "${step.deck}"`);
          await tick();
          break;
        case "tts":
          if (!tts) throw new HarnessError("E_BAD_CASE", `"tts" needs setup.tts`);
          if (step.tts !== "finish") throw new HarnessError("E_BAD_CASE", `unknown tts event "${step.tts}"`);
          tts.finish();
          await tick();
          break;
        case "interlude":
          if (!interlude) throw new HarnessError("E_BAD_CASE", `"interlude" needs setup.interlude`);
          if (step.interlude !== "end") throw new HarnessError("E_BAD_CASE", `unknown interlude event "${step.interlude}"`);
          interlude.finish(step.reason ?? "ended");
          await tick();
          break;
        case "checkpoint":
          checkpoint(step.checkpoint);
          break;
      }
    }
    await Promise.all(floating);
    await tick();
    checkpoint("end");
  } finally {
    // Teardown is the harness's, not the scenario's: the ops are copied BEFORE
    // dispose() releases the backend, so no case ever asserts on `release`
    // it did not ask for.
    ops = [...log.ops];
    m.dispose();
    __resetInstanceForTests();
  }
  return encode({ checkpoints, ops });
}
