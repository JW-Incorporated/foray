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
  /* `session` and `lifecycle` were listed here for NE-14j, which drives them
     now (SESSION_EVENTS and LIFECYCLE_EVENTS below). `remote` was listed for
     NE-29j, which drives it now (REMOTE_ACTIONS below). Every schema verb has
     a JS driver; the mechanism stays for the next verb the schema gains. */
});

/** What a `remote` step can press (NE-29j): a lock-screen, car or headphone
    button, as the OS names it (media-session.js MEDIA_ACTIONS). A step is
    `{remote: "<action>", details?: {...}}` — `details` is what the OS hands
    the handler (`seekto` carries `{seekTime}`).

    THE PRESS GOES THROUGH THE REAL TABLE. The driver asks
    `mediaSessionActions(surface)` for the handler — the same function that
    installs the page's handlers and that NE-12s ports as MediaMapping — and
    calls it, so a remap (seekbackward's -15, seekto's refusal of a missing
    time) reaches the manager exactly as it reaches the page. The SURFACE is the
    one media-session.test.js's `realPlayer` builds over a real manager: play
    resumes, pause pauses, stop stops, next/previous skip, and both seeks are
    precise seeks on the loaded element's clock. On iOS the engine's remote
    handlers answer the same presses (plan §4.5); the op log is the claim.

    A press of an action the surface did not install is a HARNESS error: the OS
    never delivers a command nobody registered. */
export const REMOTE_ACTIONS = Object.freeze([
  "play", "pause", "stop", "previoustrack", "nexttrack", "seekbackward", "seekforward", "seekto",
]);

function remoteSurface(m, backend) {
  return {
    play: () => m.resume(),
    pause: () => m.pause(),
    stop: () => m.stop(),
    next: () => m.skipToNext(),
    previous: () => m.skipToPrevious(),
    seekBy: (offset) => m.seek(Math.max(0, backend.currentTime + offset), { precise: true }),
    seekTo: (position) => m.seek(position, { precise: true }),
  };
}

/** What a `session` step can say (NE-14j): the audio session's notifications,
    as the page hands them to the manager.

      interruptionBegan       the manager's own event (`interruptionBegan()`)
      interruptionReconciled  the iOS page's route for the same notification:
                              client.js's onNativeSession asks the element
                              rather than commanding it
                              (`reconcileWithBackend("session:interruptionBegan",
                              { interruption: true })`)
      interruptionEnded       with `shouldResume` (a boolean, required)
      routeLost               the old device went away (headphones out, the car
                              switched off); optional `routeName`, `isCarRoute`
      routeAvailable          a route appeared; `routeName`, `isCarRoute`

    The interruption `reason` vocabulary is SessionPolicy's (the `session`
    family), not the manager's, so a step carries none. */
export const SESSION_EVENTS = Object.freeze([
  "interruptionBegan", "interruptionReconciled", "interruptionEnded", "routeLost", "routeAvailable",
]);

/** What a `lifecycle` step can say (NE-14j).

      coldLaunch  the process starts with a stored queue and position:
                  `restoreColdLaunchState({ items, index, autoplay })`
      foreground  the page comes back and asks the element what happened
                  while it was away (`reconcileWithBackend("session:foreground")`)
      background  the app leaves the foreground (NE-14k): client.js's
                  `flushPositions`, which writes the playhead NOW, playing or
                  paused, through the manager's own refusals
                  (`manager._persistPosition()`, its one caller's call) */
export const LIFECYCLE_EVENTS = Object.freeze(["coldLaunch", "foreground", "background"]);

/** The manager methods a `call` step may invoke. A closed list: a scenario is
    a claim about the public surface, and `_private` methods are not one. */
export const MANAGER_CALLS = Object.freeze([
  "setQueueFromPick", "loadQueue", "setQueueFromForay", "playForay", "play", "resume", "pause",
  "skipToNext", "skipToPrevious", "stop", "seek", "setRate", "setVoice", "setInterludeEnabled",
  "interruptionBegan", "interruptionEnded", "routeChanged", "restoreColdLaunchState",
  "reconcileWithBackend",
]);

/** How many macrotask turns a scenario waits, at its end, for what it floated
    to settle (NE-30j; see runScenario). */
const FLOAT_SETTLE_TURNS = 50;

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

/** NE-30j. What a Foray scenario may ADD to its checkpoints, by naming it in
    `setup.view`. Opt-in, so no earlier family's checkpoints change shape.

      outPoint            the boundary the deck holds armed now (null: none)
      seamGapRemainingMs  what is left of the seam beat, in wall-clock ms
      timersLive          how many timers are alive on the manual clock (0:
                          nothing left to fire, so no beat can start audio
                          after a pause, a stop or a skip)
      positionSec         the deck's playhead */
export const VIEW_KEYS = Object.freeze(["outPoint", "seamGapRemainingMs", "timersLive", "positionSec"]);

function extraView(keys, { m, backend, scheduler }) {
  const out = {};
  for (const k of keys) {
    if (k === "outPoint") out.outPoint = backend.outPoint ?? null;
    else if (k === "seamGapRemainingMs") out.seamGapRemainingMs = m.seamGapRemainingMs;
    else if (k === "timersLive") {
      if (typeof scheduler.live !== "number") throw new HarnessError("E_BAD_CASE", `view "timersLive" needs setup.scheduler = "manual"`);
      out.timersLive = scheduler.live;
    } else if (k === "positionSec") out.positionSec = backend.currentTime;
    else throw new HarnessError("E_BAD_CASE", `unknown view key ${JSON.stringify(k)} (one of ${VIEW_KEYS.join(", ")})`);
  }
  return out;
}

/** NE-30j. What a `call` step's `returns` may record into the next checkpoint's
    `returned` list. A closed projection, never the raw value: playForay's
    report carries whole queue items and English reasons, and a reason is text
    (a text-pin), not a rule.

      forayReport  {items: [queue ids], skipped: [{index, id, item_id}], warnings: n} */
export const RETURN_PROJECTIONS = Object.freeze(["forayReport"]);

function project(kind, value) {
  if (kind === "forayReport") {
    return {
      items: (value?.items ?? []).map((i) => i.id),
      skipped: (value?.skipped ?? []).map((s) => ({ index: s.index, id: s.id ?? null, item_id: s.item_id ?? null })),
      warnings: (value?.warnings ?? []).length,
    };
  }
  throw new HarnessError("E_BAD_CASE", `unknown returns projection ${JSON.stringify(kind)} (one of ${RETURN_PROJECTIONS.join(", ")})`);
}

/** NE-30j. `setup.forayBuild`: a REAL curated Foray, built the way the page
    builds it (foray-resolve.js `resolveForay` over the documents), so a
    scenario can play the frozen fixture's Forays end to end as
    foray-playback.test.js does. `{id, data: "frozen" | "committed",
    dropSources?: [source item ids], segments?: false}`. The build's hydrated
    document is what a `playForay` / `setQueueFromForay` call with no
    arguments is handed, and its source index is the resolver.

    WHAT THE SWIFT RUNNER NEEDS (NE-30s): the same build as input, not a Swift
    resolver — the engine never builds a Foray (plan §3 A-1). The same harness
    choice NE-29s makes for `$foray` (forays.js). */
async function forayBuildFor(spec, ctx) {
  const { resolveForay, indexSegments, indexSources, findForay } = await importModule(ctx.root, "player/foray-resolve.js");
  const dir = spec?.data === "frozen" ? "tools/foray/fixtures/frozen/data" : spec?.data === "committed" ? "data" : null;
  if (!dir || typeof spec.id !== "string") throw new HarnessError("E_BAD_CASE", `forayBuild needs {id, data: "frozen" | "committed"}`);
  const rd = (f) => JSON.parse(fs.readFileSync(path.join(ctx.root, dir, f), "utf8"));
  const foray = findForay(rd("forays.json"), spec.id, { unlocked: [spec.id] });
  if (!foray) throw new HarnessError("E_BAD_CASE", `forayBuild: ${spec.id} is not in ${dir}/forays.json`);
  const sources = indexSources(rd("segment-sources.json"));
  for (const id of spec.dropSources ?? []) sources.delete(id);
  const segments = indexSegments(spec.segments === false ? null : rd("segments.json"));
  return resolveForay(foray, { segments, sources });
}

/* ---------- the `deck` target: the native out-point (NE-28j) ----------

   The `outpoint` family drives deck-policy.js `outPointStep`, the native deck's
   three-layer out-point as a pure reducer, over a DRIVEN CLOCK: this driver owns
   the wall clock and the playhead, moves the playhead by `elapsed x rate` while
   the deck plays (and is not stalled), and delivers the watchdog's one timer at
   the moment it comes due, with the playhead where it really is by then. The
   op log is the reducer's ops, in order; nothing else writes to it.

   `deck` steps:
     load      {id?, outPointSec, sec}  a new item at in-point `sec` (a new token)
     play | pause
     seek      {sec}
     rate      {rate}
     stall | unstall                    the playhead freezes / moves again while
                                        playing (buffering): time passes, content
                                        does not
     endTime | boundary  {token?, sec?} layer 1 / layer 2 reports now, for the
                                        current token or an older one; `sec` is
                                        the playhead the report read (an
                                        observer's own latency or jitter), which
                                        is where the playhead then is
     ended     {sec?}                   NE-30j: the FILE ran out (an authored
                                        end past the real audio) — the item's
                                        one, natural, end
   `clock: ms` advances the wall clock. */

export const DECK_EVENTS = Object.freeze([
  "load", "play", "pause", "seek", "rate", "stall", "unstall", "endTime", "boundary", "ended",
]);

/** Milliseconds of content, kept whole so a long driven clock accumulates no
    floating-point error. */
const toMs = (sec) => Math.round(sec * 1000);

async function runDeckScenario(c, setup, ctx) {
  const policy = await importModule(ctx.root, "player/deck-policy.js");
  const log = new OpLog();
  let state = policy.initialOutPointWatch();
  let nowMs = 0;
  let atMs = 0;
  let stalled = false;
  let loads = 0;
  const atSec = () => atMs / 1000;
  const dispatch = (event) => {
    const r = policy.outPointStep(state, { atSec: atSec(), nowMs, ...event });
    state = r.state;
    for (const op of r.ops) log.push(op);
  };
  if (setup.rate !== undefined) dispatch({ type: "rate", rate: setup.rate });

  const { verbs } = closedSets();
  const checkpoints = [];
  let mark = 0;
  const checkpoint = (name) => {
    checkpoints.push({
      name, ops: log.since(mark),
      nowMs, atSec: atSec(), armed: state.armed, fired: state.fired, playing: state.playing, rate: state.rate,
    });
    mark = log.length;
  };

  for (const [i, step] of c.steps.entries()) {
    const verb = Object.keys(step).find((k) => verbs.includes(k));
    if (!verb) throw new HarnessError("E_UNKNOWN_VERB", `step ${i} of ${c.id} has no known verb`);
    switch (verb) {
      case "deck":
        switch (step.deck) {
          case "load":
            loads += 1;
            atMs = toMs(step.sec ?? 0);
            dispatch({ type: "load", token: loads, outPointSec: step.outPointSec ?? null });
            break;
          case "play":
          case "pause":
            dispatch({ type: step.deck });
            break;
          case "seek":
            if (typeof step.sec !== "number") throw new HarnessError("E_BAD_CASE", `deck seek needs a numeric sec`);
            atMs = toMs(step.sec);
            dispatch({ type: "seek" });
            break;
          case "rate":
            dispatch({ type: "rate", rate: step.rate });
            break;
          case "stall":
          case "unstall":
            stalled = step.deck === "stall";
            break;
          case "ended":
            if (!loads) throw new HarnessError("E_BAD_CASE", `an end with nothing loaded`);
            if (step.sec !== undefined) atMs = toMs(step.sec);
            dispatch({ type: "ended" });
            break;
          case "endTime":
          case "boundary":
            if (!loads) throw new HarnessError("E_BAD_CASE", `a ${step.deck} report with nothing loaded`);
            if (step.sec !== undefined) atMs = toMs(step.sec);
            dispatch({ type: "layer", layer: step.deck, token: step.token ?? loads });
            break;
          default:
            throw new HarnessError("E_BAD_CASE", `unknown deck event "${step.deck}" (one of ${DECK_EVENTS.join(", ")})`);
        }
        break;
      case "clock": {
        if (!(Number.isInteger(step.clock) && step.clock >= 0)) throw new HarnessError("E_BAD_CASE", `clock takes whole milliseconds`);
        const until = nowMs + step.clock;
        for (;;) {
          const due = state.timerDueMs;
          const to = due !== null && due <= until ? due : until;
          if (state.playing && !stalled) atMs += Math.round((to - nowMs) * state.rate);
          nowMs = to;
          if (due !== null && due <= until) dispatch({ type: "timer" });
          else break;
        }
        break;
      }
      case "checkpoint":
        checkpoint(step.checkpoint);
        break;
      default:
        throw new HarnessError("E_BAD_CASE", `the deck target takes deck, clock and checkpoint steps, not "${verb}"`);
    }
  }
  checkpoint("end");
  return encode({ checkpoints, ops: [...log.ops] });
}

/* ---------- the `engine` target: the prepare family (NE-30j) ----------

   The `prepare` family asserts seams at the AUDIBLE level: "item N+1 starts
   at wall time T, at offset O" (plan §6), with the native-only `n.prepare:` /
   `n.handover:` tokens ASSERTED rather than stripped (compare.js keeps `n.*`
   in this family only). The JS warm handover is parked on the web, so the only
   JS path that prepares is reference-engine.js — protocol v1 over the REAL
   manager, with a WarmingBackend — and this target drives it.

   `call` steps are engine COMMANDS (`{call: "<cmd>", args?, source?}`, sent
   as engineSend payloads with a running cmdSeq; a refused reply is a harness
   error unless the step says `refused: "<reason>"`). `deck` steps are the
   engine's deck events (`ended` with `reason`, `error`, `time`/`duration`
   with `sec`, `window`, `stall`, `flowing`). `clock` moves the manual
   clock. A checkpoint records the manager view plus `nowMs` — T. */

export const ENGINE_DECK_EVENTS = Object.freeze(["ended", "error", "time", "duration", "window", "stall", "flowing"]);

async function runEngineScenario(c, setup, ctx) {
  const { ReferenceEngine } = await importModule(ctx.root, "player/parity/reference-engine.js");
  const log = new OpLog();
  const scheduler = manualScheduler();
  const eng = new ReferenceEngine({
    scheduler, now: () => 0, log,
    capabilities: setup.capabilities ?? ["episode", "continuation", "restore", "foray"],
    catalogue: setup.catalogue ?? {}, backend: setup.backend ?? {},
    ...(setup.seamGapSec !== undefined ? { seamGapSec: setup.seamGapSec } : {}),
  });
  const { verbs } = closedSets();
  const checkpoints = [];
  let mark = 0;
  let cmdSeq = 0;
  const checkpoint = (name) => {
    checkpoints.push({ name, ops: log.since(mark), nowMs: scheduler.nowMs(), ...managerView(eng.manager) });
    mark = log.length;
  };
  let ops = [];
  try {
    for (const [i, step] of c.steps.entries()) {
      const verb = Object.keys(step).find((k) => verbs.includes(k));
      if (!verb) throw new HarnessError("E_UNKNOWN_VERB", `step ${i} of ${c.id} has no known verb`);
      switch (verb) {
        case "call": {
          const payload = {
            v: 1, cmdSeq: ++cmdSeq, cmd: step.call, source: step.source ?? "tap",
            ...(step.args !== undefined ? { args: expandInputs(step.args, ctx) } : {}),
          };
          const reply = await eng.engineSend(payload);
          const want = step.refused ?? null;
          if ((reply.ok ? null : reply.reason) !== want) {
            throw new HarnessError("E_BAD_CASE", `engine ${step.call} answered ${JSON.stringify(reply.ok ? "ok" : reply.reason)}, the step expects ${JSON.stringify(want ?? "ok")}`);
          }
          break;
        }
        case "deck": {
          if (!ENGINE_DECK_EVENTS.includes(step.deck)) {
            throw new HarnessError("E_BAD_CASE", `unknown engine deck event ${JSON.stringify(step.deck)} (one of ${ENGINE_DECK_EVENTS.join(", ")})`);
          }
          const arg = step.deck === "ended" ? (step.reason ?? "natural")
            : step.deck === "error" ? (step.message ?? "error")
              : step.sec;
          await eng.deck(step.deck, arg);
          break;
        }
        case "clock":
          if (!(Number.isInteger(step.clock) && step.clock >= 0)) throw new HarnessError("E_BAD_CASE", "clock takes whole milliseconds");
          await scheduler.advance(step.clock);
          await tick();
          break;
        case "settle":
          for (let n = 0; n < (Number.isInteger(step.settle) && step.settle > 0 ? step.settle : 1); n++) await tick();
          break;
        case "checkpoint":
          checkpoint(step.checkpoint);
          break;
        default:
          throw new HarnessError("E_BAD_CASE", `the engine target takes call, deck, clock, settle and checkpoint steps, not "${verb}"`);
      }
    }
    await tick();
    checkpoint("end");
  } finally {
    ops = [...log.ops];
    eng.dispose();
  }
  return encode({ checkpoints, ops });
}

async function runScenario(c, ctx) {
  const setup = expandInputs(c.setup ?? {}, ctx);
  if (setup.target === "deck") return runDeckScenario(c, setup, ctx);
  if (setup.target === "engine") return runEngineScenario(c, setup, ctx);
  if (setup.target !== "manager") throw new HarnessError("E_SCENARIO_TARGET", `no JS driver for target "${setup.target}"`);
  const { PlayerQueueManager, __resetInstanceForTests } = await importModule(ctx.root, "player/queue-manager.js");
  const { mediaSessionActions } = await importModule(ctx.root, "player/media-session.js");

  const log = new OpLog();
  const backend = new FakeBackend({ log, ...(setup.backend ?? {}) });
  const store = await positionStoreFor(setup, log, ctx);
  const scheduler = setup.scheduler === "manual" ? manualScheduler() : instantScheduler();
  const tts = setup.tts ? fakeTts({ log, ...(typeof setup.tts === "object" ? setup.tts : {}) }) : null;
  const interlude = setup.interlude ? fakeInterlude({ log, ...(typeof setup.interlude === "object" ? setup.interlude : {}) }) : null;
  const built = setup.forayBuild ? await forayBuildFor(setup.forayBuild, ctx) : null;
  const catalogue = built ? Object.fromEntries(built.sources) : (setup.catalogue ?? {});
  const view = setup.view ?? [];
  if (!Array.isArray(view)) throw new HarnessError("E_BAD_CASE", "setup.view is a list of view keys");

  __resetInstanceForTests();
  const m = new PlayerQueueManager({
    backend, positionStore: store, scheduler, tts, interlude,
    /* NE-30j. The surface's beat callback, as an op: the page repaints on it,
       and the native engine reports the same transition. */
    ...(setup.seamGapEvents === true ? { onSeamGapChange: (inGap) => log.push(`event.seamGap:${inGap === true}`) } : {}),
    ...(setup.rate !== undefined ? { rate: setup.rate } : {}),
    ...(setup.seamGapSec !== undefined ? { seamGapSec: setup.seamGapSec } : {}),
    ...(setup.interludeEnabled !== undefined ? { interludeEnabled: setup.interludeEnabled } : {}),
  });

  const { verbs } = closedSets();
  const checkpoints = [];
  let mark = 0;
  let returned = [];
  const checkpoint = (name) => {
    checkpoints.push({
      name, ops: log.since(mark), ...managerView(m), ...extraView(view, { m, backend, scheduler }),
      ...(returned.length ? { returned } : {}),
    });
    mark = log.length;
    returned = [];
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
            const doc = args.length === 0 && built ? built.hydrated : args[0];
            args = [doc, { ...(args[1] ?? {}), resolveItem: (id) => catalogue[id] ?? null }];
          }
          /* NE-14k. `stop` is the ENGINE's stop command (the Swift driver
             sends `.stop(persist: true)`), which is the page's close:
             client.js `stopAndClose` flushes the playhead, then stops (audit
             round 2, player-3: a scrub made while paused is written by nothing
             else). So the flush the page makes goes first, through the
             manager's own refusals (`_persistPosition`, its one caller's call). */
          if (step.call === "stop") m._persistPosition();
          const p = Promise.resolve(m[step.call](...args));
          if (step.returns !== undefined) {
            if (step.await === false) throw new HarnessError("E_BAD_CASE", "a call that records what it returns must be awaited");
            returned.push(project(step.returns, await p));
          } else if (step.await === false) floating.push(p.catch(() => {}));
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
          /* The file ran out: the element is paused and `ended` (NE-14k: the
             flag is now modelled, so what the manager reads off the element
             after an end is what an <audio> element says), then says so. */
          if (step.deck === "ended") {
            backend.paused = true;
            backend.ended = true;
            floating.push(Promise.resolve(backend.onItemEnded?.(step.reason ?? "natural")).catch(() => {}));
          }
          /* NE-14k. The element reached its end and the `ended` event has not
             been delivered yet — the window a reconcile can land in, which
             `pause` firing BEFORE `ended` makes an ordinary one. */
          else if (step.deck === "ranOut") {
            backend.paused = true;
            backend.ended = true;
          }
          else if (step.deck === "error") floating.push(Promise.resolve(backend.onError?.(step.message ?? "error")).catch(() => {}));
          else if (step.deck === "time") backend.currentTime = step.sec;
          else if (step.deck === "duration") backend.duration = step.sec;
          else if (step.deck === "audible") backend.paused = step.audible === false;
          /* NE-14j. A pause nobody commanded (a call on an awake page, a route
             the OS took): the element stops, then says so — the backend's
             `onUnexplainedPause`, which the manager reconciles. */
          else if (step.deck === "observedPause") {
            backend.paused = true;
            floating.push(Promise.resolve(backend.onUnexplainedPause?.()).catch(() => {}));
          }
          /* NE-14j. A held load (setup.backend.holdLoads) lands, or fails: the
             oldest one held for `id`, or the oldest of all. */
          else if (step.deck === "loaded" || step.deck === "loadFailed") {
            if (!backend.settleLoad(step.id ?? null, { fail: step.deck === "loadFailed" })) {
              throw new HarnessError("E_BAD_CASE", `no held load${step.id ? ` for "${step.id}"` : ""} to settle`);
            }
          }
          else throw new HarnessError("E_BAD_CASE", `unknown deck event "${step.deck}"`);
          await tick();
          break;
        case "session": {
          const run = sessionStep(m, step);
          if (step.await === false) floating.push(run.catch(() => {}));
          else await run;
          await tick();
          break;
        }
        case "lifecycle": {
          const run = lifecycleStep(m, step, ctx);
          if (step.await === false) floating.push(run.catch(() => {}));
          else await run;
          await tick();
          break;
        }
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
        case "remote": {
          if (!REMOTE_ACTIONS.includes(step.remote)) {
            throw new HarnessError("E_BAD_CASE", `unknown remote action ${JSON.stringify(step.remote)} (have ${REMOTE_ACTIONS.join(", ")})`);
          }
          const handler = new Map(mediaSessionActions(remoteSurface(m, backend))).get(step.remote);
          if (!handler) throw new HarnessError("E_BAD_CASE", `the surface installs no "${step.remote}" handler, so the OS could never deliver this press`);
          const run = Promise.resolve("details" in step ? handler(expandInputs(step.details, ctx)) : handler());
          if (step.await === false) floating.push(run.catch(() => {}));
          else await run;
          await tick();
          break;
        }
        case "checkpoint":
          checkpoint(step.checkpoint);
          break;
      }
    }
    /* NE-30j. Wait for what the scenario floated (an end at a seam, a held
       load) — but never forever. A scenario that ENDS inside a seam beat on
       the manual clock leaves the end's handler waiting on a timer only a
       `clock` step could fire; so does any case under a mutant that lengthens
       the beat (record.test.mjs records the whole tree with SEAM_GAP_SEC
       changed). Awaited outright, that is a promise the event loop can never
       settle, and node cancels the whole run instead of failing one case.
       Bounded, the case records the state it really ended in, which --check
       then reports as a difference. Every recorded case settles long before
       the bound. */
    {
      let settled = false;
      Promise.all(floating).then(() => { settled = true; }, () => { settled = true; });
      for (let n = 0; n < FLOAT_SETTLE_TURNS && !settled; n++) await tick();
    }
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

/** The scenario's position store. By default the MemoryStore (`store.save:`
    tokens, `positions` seeded as `{seconds}` rows). With `setup.positionEvents`
    (NE-14j) it is the REAL PositionStore over a MemoryStore storage, with its
    `onSave` writing `event.position:<id>@<seconds>:<duration>` — the event the
    page logs and the native engine appends to `pendingEvents` (plan §5.5), under
    the once-a-minute rule the resume-rules family pins. `updated_at` is fixed at
    the epoch: the rows family owns the row's bytes, this owns WHEN it is written. */
async function positionStoreFor(setup, log, ctx) {
  if (setup.positionEvents !== true) {
    const store = new MemoryStore({ log });
    for (const [id, seconds] of Object.entries(setup.positions ?? {})) store.positions.set(id, { seconds });
    return store;
  }
  const { PositionStore, positionKey } = await importModule(ctx.root, "player/position-store.js");
  const initial = {};
  for (const [id, seconds] of Object.entries(setup.positions ?? {})) {
    initial[positionKey(id)] = JSON.stringify({ seconds, duration: null, updated_at: new Date(0).toISOString(), source: "local" });
  }
  const storage = new MemoryStore({ log, initial });
  return new PositionStore({
    storage,
    now: () => new Date(0),
    onSave: (id, seconds, meta) => log.push(`event.position:${id}@${seconds}:${meta?.duration ?? "null"}`),
  });
}

/** Drive one `session` step (SESSION_EVENTS). */
function sessionStep(m, step) {
  switch (step.session) {
    case "interruptionBegan":
      return m.interruptionBegan();
    case "interruptionReconciled":
      return m.reconcileWithBackend("session:interruptionBegan", { interruption: true });
    case "interruptionEnded":
      if (typeof step.shouldResume !== "boolean") {
        throw new HarnessError("E_BAD_CASE", `session interruptionEnded needs a boolean shouldResume`);
      }
      return m.interruptionEnded(step.shouldResume);
    case "routeLost":
    case "routeAvailable":
      return m.routeChanged({
        oldDeviceUnavailable: step.session === "routeLost",
        routeName: step.routeName ?? null,
        isCarRoute: step.isCarRoute === true,
      });
    default:
      throw new HarnessError("E_BAD_CASE", `unknown session event "${step.session}" (one of ${SESSION_EVENTS.join(", ")})`);
  }
}

/** Drive one `lifecycle` step (LIFECYCLE_EVENTS). */
function lifecycleStep(m, step, ctx) {
  switch (step.lifecycle) {
    case "coldLaunch":
      return m.restoreColdLaunchState({
        items: expandInputs(step.items ?? [], ctx),
        index: step.index ?? 0,
        autoplay: step.autoplay === true,
      });
    case "foreground":
      return m.reconcileWithBackend("session:foreground");
    case "background":
      return Promise.resolve(m._persistPosition());
    default:
      throw new HarnessError("E_BAD_CASE", `unknown lifecycle event "${step.lifecycle}" (one of ${LIFECYCLE_EVENTS.join(", ")})`);
  }
}
