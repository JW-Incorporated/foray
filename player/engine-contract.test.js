/* player/engine-contract.js — the web <-> native contract (docs/native-engine-plan.md
   §4.4, §4.6, §5). The first three tests are NE-10j's: OWNED_PREFIXES, the
   shared rows the native engine owns on iOS (§4.6).

   What goes wrong if this list is wrong is quiet on both sides. A prefix that
   misses a row the engine writes lets a stale page push its old copy over the
   engine's (the clobber NE-23's deferral exists to stop). A prefix that catches
   a row the engine does NOT write defers it on the iOS shell with nobody left
   writing it: the listener's thumbs, queue or history silently stop saving.
   So both directions are pinned against real code, not against a retyped list.

   The rest are NE-11j's: the names, the one schema and its examples, the
   page's decideMode and extrapolate, and the three engine rules held as JS
   reference tables (SessionPolicy, the audible-start invariant, EngineMode).
   The parity families recorded from those rules are checked case by case by
   `record.mjs --check` (tools/parity/record.test.mjs, in npm test); what this
   suite adds is the RULES, stated across every case at once, so a change that
   re-records cleanly but breaks one of them is still red. */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OWNED_PREFIXES, PROTOCOL, COMMANDS, EVENTS, REFUSALS, BRIDGE_METHODS, CONTRACT_KINDS,
  SESSION_PHASES, SESSION_INPUTS, AUDIBLE_COMMANDS, STRIKE_LIMIT,
  contractSchemaDocument, validateContract, contractAccepts, decideMode, extrapolate,
  sessionTransition, audibleStartViolations, decideEngineMode, engineModeTrace,
} from "./engine-contract.js";
import { SESSION_ERRORS } from "./engine-vocabulary.js";
import { isStale, SCHEMA_FILE } from "../tools/parity/contract-schema.mjs";
import { positionKey } from "./position-store.js";
import { KEY_PREFIX as FORAY_PREFIX, progressKey } from "./foray-progress.js";
import { KEY as LAST_EPISODE_KEY } from "./episode-progress.js";
import { loadFixtures } from "./parity/runner.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const owned = (key) => OWNED_PREFIXES.some((p) => key.startsWith(p));

test("OWNED_PREFIXES is the three shared rows' namespaces, frozen", () => {
  // MUTATION: drop the colon from "cp_foray:" -> the scan below goes red;
  // push a fourth prefix at runtime -> this throws instead of deferring it.
  assert.ok(Object.isFrozen(OWNED_PREFIXES), "a caller must not be able to widen what the engine owns");
  assert.equal(OWNED_PREFIXES.length, 3);
  // Each prefix is the namespace a real writer uses, read from that writer.
  assert.ok(positionKey("ep-1").startsWith(OWNED_PREFIXES[0]), "cp_pos:<id> (position-store.js)");
  assert.equal(OWNED_PREFIXES[0], positionKey(""));
  assert.equal(OWNED_PREFIXES[1], FORAY_PREFIX, "cp_foray:<id> (foray-progress.js)");
  assert.ok(progressKey("f-1").startsWith(OWNED_PREFIXES[1]));
  assert.equal(OWNED_PREFIXES[2], LAST_EPISODE_KEY, "cp_last_episode (episode-progress.js)");
});

test("every row the rows family records is owned, and every owned prefix has a recorded row", () => {
  // The rows family is what the Swift EngineStore must write byte for byte
  // (NE-10s, NE-19). A recorded row outside OWNED_PREFIXES would be a row the
  // engine writes while the page still pushes its own copy; a prefix with no
  // recorded row would be deferred on the strength of nothing.
  // MUTATION: change OWNED_PREFIXES[0] to "cp_position:" -> red (cp_pos:ep-1 unowned).
  const keys = new Set();
  for (const fx of loadFixtures(ROOT, { family: "rows" })) {
    for (const c of fx.doc.cases) {
      for (const w of Array.isArray(c.expect?.return) ? c.expect.return : []) keys.add(w.key);
    }
  }
  assert.ok(keys.size >= 3, `the rows family records ${keys.size} distinct keys; expected all three rows`);
  for (const k of keys) assert.ok(owned(k), `${k} is recorded as a shared row but OWNED_PREFIXES does not own it`);
  for (const p of OWNED_PREFIXES) {
    assert.ok([...keys].some((k) => k.startsWith(p)), `${p} is owned but no rows case writes under it`);
  }
});

test("no other cp_ key the app spells falls under an owned prefix", () => {
  // Every `cp_` key literal in the shipping page (app.js, sw.js, the player
  // modules). The trailing colons are what keep `cp_foray_feedback` (the
  // thumbs) out of `cp_foray:`; this is the check that says so.
  // MUTATION: "cp_foray:" -> "cp_foray" in engine-contract.js -> red, naming
  // cp_foray_feedback.
  const files = ["app.js", "sw.js", "search-engine.js"].map((f) => path.join(ROOT, f));
  const playerDir = path.join(ROOT, "player");
  for (const f of fs.readdirSync(playerDir)) {
    if (f.endsWith(".js") && !f.endsWith(".test.js")) files.push(path.join(playerDir, f));
  }
  const spelled = new Set();
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    for (const m of fs.readFileSync(f, "utf8").matchAll(/\bcp_[A-Za-z0-9_]*:?/g)) spelled.add(m[0]);
  }
  assert.ok(spelled.size > 20, `found only ${spelled.size} cp_ keys; the scan is not reading the app`);
  for (const p of OWNED_PREFIXES) assert.ok(spelled.has(p), `${p} is not spelled anywhere in the shipping page`);
  const wrongly = [...spelled].filter((k) => owned(k) && !OWNED_PREFIXES.includes(k)).sort();
  assert.deepStrictEqual(wrongly, [], "keys the engine would defer but never writes");
});

/* ====================================================================== */
/* NE-11j                                                                 */
/* ====================================================================== */

const NE11J_FAMILIES = ["session", "session-invariant", "engine-mode", "handshake", "snapshot", "contract"];
const readParity = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, "player/parity", f), "utf8"));
const kebab = (s) => s.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());

test("the names: protocol 1, the plan's commands and events, and every refusal spelled out", () => {
  // MUTATION: drop "probeSession" from COMMANDS -> red; write REFUSALS with a
  // bare "session-failed" instead of one entry per token -> red.
  assert.equal(PROTOCOL, 1);
  assert.deepStrictEqual([...BRIDGE_METHODS], ["engineHello", "engineSend", "engineRead"]);
  for (const cmd of ["playEpisode", "setContinuation", "relinquish", "setModeOverride", "setHoldPolicy", "ackEvents", "ackAdvances", "probeSession", "simulateTermination", "audition"]) {
    assert.ok(COMMANDS.includes(cmd), `§5.2 names ${cmd}`);
  }
  assert.equal(new Set(COMMANDS).size, COMMANDS.length, "no command twice");
  assert.ok(EVENTS.includes("modeChanged") && EVENTS.includes("snapshot"));
  for (const t of SESSION_ERRORS) assert.ok(REFUSALS.includes(`session-failed:${t}`), `session-failed:${t}`);
  assert.ok(!REFUSALS.includes("session-failed"), "a refusal on the wire is one exact string, never a prefix");
  for (const list of [COMMANDS, EVENTS, REFUSALS, BRIDGE_METHODS, CONTRACT_KINDS]) assert.ok(Object.isFrozen(list));
});

test("the schema file on disk is exactly what engine-contract.js renders", () => {
  // MUTATION: add a command to COMMANDS without --write -> red; hand-edit the
  // .json -> red.
  assert.equal(isStale(ROOT), false, `${SCHEMA_FILE} is stale: run node tools/parity/contract-schema.mjs --write`);
  const onDisk = JSON.parse(fs.readFileSync(path.join(ROOT, SCHEMA_FILE), "utf8"));
  assert.deepStrictEqual(onDisk["x-kinds"], [...CONTRACT_KINDS]);
  const send = onDisk.$defs.sendRequest;
  assert.deepStrictEqual(send.properties.cmd.enum, [...COMMANDS]);
  for (const branch of send.allOf) assert.ok(COMMANDS.includes(branch.if.properties.cmd.const), "args are only declared for real commands");
});

test("every schema example is one contract or snapshot case and back, valid ones accepted, invalid ones refused", () => {
  // MUTATION: drop the if/then that requires `reason` on {ok: false} -> the
  // sendResponse example "refused-without-reason" is accepted -> red. Delete a
  // contract case, or add an example with no case -> red.
  const doc = contractSchemaDocument();
  const expected = new Map();
  for (const kind of CONTRACT_KINDS) {
    const fam = kind === "snapshot" ? "snapshot" : "contract";
    for (const verdict of ["valid", "invalid"]) {
      const examples = doc.$defs[kind]["x-examples"][verdict];
      assert.ok(Object.keys(examples).length > 0, `${kind} has ${verdict} examples`);
      for (const [slug, payload] of Object.entries(examples)) {
        const r = validateContract(kind, payload);
        assert.equal(r.ok, verdict === "valid", `${kind} ${verdict} example "${slug}": ${r.errors.join("; ")}`);
        // Sharp examples: an invalid one breaks ONE rule, so a validator that
        // forgets exactly that rule turns exactly one case red.
        if (verdict === "invalid") assert.equal(r.errors.length, 1, `${kind} invalid "${slug}" breaks ${r.errors.length} rules: ${r.errors.join("; ")}`);
        expected.set(`${fam}/${kebab(kind)}-${verdict}-${slug}`, [kind, payload]);
      }
    }
  }
  const cases = new Map();
  for (const fx of loadFixtures(ROOT).filter((f) => f.family === "contract" || f.family === "snapshot")) {
    for (const c of fx.doc.cases) {
      if (c.call === "contractAccepts" && CONTRACT_KINDS.includes(c.args?.[0])) cases.set(c.id, c);
    }
  }
  for (const [id, [kind, payload]] of expected) {
    const c = cases.get(id);
    assert.ok(c, `schema example ${id} has no parity case`);
    assert.deepStrictEqual(c.args, [kind, payload], `${id} does not carry its example`);
  }
  for (const id of cases.keys()) assert.ok(expected.has(id), `${id} is a contract case with no schema example behind it`);
});

test("the validator refuses what JSON cannot carry and a kind that does not exist, and allows an additive field", () => {
  // MUTATION: type "number" as typeof === "number" -> NaN accepted -> red.
  const snap = contractSchemaDocument().$defs.snapshot["x-examples"].valid.playing;
  assert.equal(contractAccepts("snapshot", { ...snap, positionSec: NaN }), false);
  assert.equal(contractAccepts("snapshot", { ...snap, positionSec: Infinity }), false);
  assert.equal(contractAccepts("snapshot", { ...snap, futureField: "an additive field" }), true, "an additive field is not a protocol change");
  assert.throws(() => validateContract("handshake", {}), RangeError);
});

test("decideMode: native only on iOS with the method, a well-formed native hello and protocol 1", () => {
  // MUTATION: read protocol before mode -> the NE-01 stub (no protocol) reads
  // as a mismatch and asks for a relinquish nobody needs -> red.
  const native = contractSchemaDocument().$defs.helloResponse["x-examples"].valid.native;
  const ios = (hello) => decideMode({ platform: "ios", methodPresent: true, hello });
  assert.deepStrictEqual(ios(native), { mode: "native", reason: "native", relinquish: false });
  assert.deepStrictEqual(ios({ mode: "legacy", reason: "not-built" }), { mode: "js", reason: "engine-legacy", relinquish: false });
  // Every way the page ends up on JS while an engine MIGHT be running asks it
  // to let go first (A-2: never two producers).
  assert.equal(ios(null).relinquish, true);
  assert.equal(ios({ ...native, protocol: 2 }).relinquish, true);
  assert.equal(ios({ mode: "native" }).relinquish, true);
  assert.equal(decideMode({ platform: "android", methodPresent: true, hello: native }).mode, "js");
  assert.equal(decideMode({ platform: "ios", methodPresent: false, hello: native }).mode, "js");
});

test("extrapolate is frozen while inSeamGap, buffering or not running, and runs on the page's own clock otherwise", () => {
  // MUTATION: drop any one freeze condition -> red; clamp nothing -> red.
  const snap = { ...contractSchemaDocument().$defs.snapshot["x-examples"].valid.playing, positionSec: 100, effectiveRate: 2, durationSec: 3600 };
  assert.equal(extrapolate(snap, 10_000, 13_000), 106);
  for (const frozen of [{ inSeamGap: true }, { buffering: true }, { running: false }]) {
    assert.equal(extrapolate({ ...snap, ...frozen }, 10_000, 13_000), 100, JSON.stringify(frozen));
  }
  assert.equal(extrapolate({ ...snap, positionSec: 3599 }, 0, 60_000), 3600, "never past the end");
  assert.equal(extrapolate(snap, 13_000, 10_000), 100, "a clock that went backwards is no time");
});

/** Every (phase, input) edge the session family records, run live. */
function sessionEdges() {
  const out = [];
  for (const fx of loadFixtures(ROOT, { family: "session" })) {
    for (const c of fx.doc.cases) {
      if (c.call !== "sessionTransition" || !("return" in (c.expect ?? {}))) continue;
      out.push({ id: c.id, phase: c.args[0], input: c.args[1], policy: c.args[2], r: sessionTransition(...c.args) });
    }
  }
  return out;
}

test("SessionPolicy: the session family is the full table, every phase crossed with every input", () => {
  // MUTATION: delete the relinquished rows from the fixture -> red.
  const seen = new Set(sessionEdges().map((e) => `${e.phase}|${e.input.kind}`));
  for (const p of SESSION_PHASES) for (const k of SESSION_INPUTS) assert.ok(seen.has(`${p}|${k}`), `no session case for ${k} in ${p}`);
});

test("SessionPolicy: deactivate+notify only on close, finalEnd and dataDeletion; relinquish carries nothing; relinquished is terminal", () => {
  // MUTATION: add "deactivate" to the relinquish edge, or "deactivate" to a
  // pause under .forever -> red (NE-11s's two named mutations, stated for JS).
  const nothing = (phase) => ({ phase, actions: [], row: null, reason: null });
  for (const e of sessionEdges()) {
    if (e.r.actions.includes("deactivate-notify")) {
      assert.ok(["close", "finalEnd", "dataDeletion"].includes(e.input.kind), `${e.id} notifies others`);
      assert.equal(e.phase, "active", `${e.id}: only an active session has anything to hand back`);
    }
    if (e.input.kind === "relinquish" || e.phase === "relinquished") assert.deepStrictEqual(e.r, nothing("relinquished"), e.id);
    if (["beat", "narration", "background"].includes(e.input.kind)) assert.deepStrictEqual(e.r.actions, [], `${e.id}: S-4`);
    if (e.input.kind === "pause" && (e.policy ?? "forever") !== "none") assert.deepStrictEqual(e.r.actions, [], `${e.id}: S-4 under ${e.policy ?? "forever"}`);
  }
});

test("SessionPolicy: only a successful sessionResult makes a session active", () => {
  // MUTATION: let userPlay move inactive straight to active -> red. Activation
  // is a request and a response (§4.2); nothing may claim `active` on the
  // strength of an activation that has not happened.
  for (const e of sessionEdges()) {
    if (e.phase !== "active" && e.r.phase === "active") {
      assert.deepStrictEqual(e.input, { kind: "sessionResult", ok: true }, `${e.id} activates without a successful result`);
    }
    if (e.r.actions.includes("activate")) assert.equal(e.r.phase, e.phase, `${e.id}: the request leaves the phase alone`);
  }
});

test("the audible-start invariant holds for every activation the session policy asks for", () => {
  // Compose the two tables the way the core will (§4.2): an edge that asks to
  // activate gets its answer in the same turn, and the core may play only if
  // that answer made the session active. MUTATION: let audibleStartViolations
  // count a failed result as an activation -> red.
  let checked = 0;
  for (const e of sessionEdges()) {
    if (!e.r.actions.includes("activate")) continue;
    for (const ok of [true, false]) {
      const result = ok ? { kind: "sessionResult", ok: true } : { kind: "sessionResult", ok: false, token: "other" };
      const after = sessionTransition(e.r.phase, result, e.policy);
      const violations = audibleStartViolations(e.phase, ["sessionActivate", ok ? "sessionResult:ok" : "sessionResult:failed", "deckPlay"]);
      assert.equal(after.phase === "active", ok, `${e.id}: result ok=${ok}`);
      assert.equal(violations.length === 0, ok, `${e.id}: a deckPlay after ok=${ok} ${ok ? "must" : "must not"} be allowed`);
      checked++;
    }
  }
  assert.ok(checked >= 8, `only ${checked} activation edges checked`);
  // The plan's named mutation: a deckPlay in lostToInterruption, unasked.
  assert.deepStrictEqual(audibleStartViolations("lostToInterruption", ["deckPlay"]), [{ at: 0, cmd: "deckPlay" }]);
  for (const cmd of AUDIBLE_COMMANDS) assert.equal(audibleStartViolations("inactive", [cmd]).length, 1, cmd);
});

test("EngineMode: no plist key is legacy/no-plist-key; strikes come only from a set sentinel; three strikes stick until the build changes", () => {
  // MUTATION: count a strike per launch instead of per set sentinel -> the
  // clean-launch trace reaches crash-loop -> red; keep the sticky pin across a
  // new CFBundleVersion -> red; count page-health from the current strikes ->
  // the broken page never reaches legacy -> red.
  const base = { override: "auto", sentinelWasSet: false, strikes: 0, stickyLegacyBuild: null, currentBuild: "b1", built: true };
  assert.deepStrictEqual(decideEngineMode(base), { mode: "legacy", reason: "no-plist-key", strikes: 0, stickyLegacyBuild: null, writeSentinel: false });
  assert.equal(decideEngineMode({ ...base, buildDefault: "native", sentinelWasSet: true, strikes: STRIKE_LIMIT - 1 }).reason, "crash-loop");
  const L = (b = "b1") => ({ kind: "launch", buildDefault: "native", currentBuild: b, built: true });
  const H = { kind: "healthy" };
  const PH = { kind: "page-health" };
  const fresh = { override: "auto", strikes: 0, sentinel: false, stickyLegacyBuild: null };
  const clean = engineModeTrace(fresh, [L(), H, L(), H, L(), H, L(), H]);
  assert.ok(clean.every((s) => s.strikes === 0 && s.mode === "native"), "clean background launches: strikes 0");
  const crashes = engineModeTrace(fresh, [L(), L(), L(), L(), L(), L("b2")]);
  assert.deepStrictEqual(crashes.map((s) => s.mode), ["native", "native", "native", "legacy", "legacy", "native"]);
  assert.equal(crashes[4].stickyLegacyBuild, "b1");
  assert.equal(crashes[5].strikes, 0);
  // A page that never says hello reaches legacy even though the 5 s healthy
  // marker fires first on every launch.
  const broken = engineModeTrace(fresh, [L(), H, PH, L(), H, PH, L(), H, PH, L()]);
  assert.equal(broken.at(-1).reason, "crash-loop");
});

test("the six NE-11j families are recorded, charged to the episode capability, and burned down by NE-11s", () => {
  // NE-11j recorded them owed to NE-11s; NE-11s ported SessionPolicy,
  // EngineMode and the contract's decoding and burned every id out of
  // swift-pending, so the Swift runners (registered and REQUIRED by both XCTest
  // wrappers, tools/mobile/shell-invariants.test.mjs) must now execute them.
  // The episode capability requires zero pending in these families, so an id
  // that drifted back to "owed" is a gate problem, not a bookkeeping one.
  // A later JS rule change re-adds its ids here through record.mjs
  // --port-card; this test then names the card that must burn them down.
  // MUTATION: re-add one of these ids to swift-pending.json -> red.
  const pending = readParity("swift-pending.json");
  const manifest = readParity("manifest.json");
  const episode = readParity("capabilities.json").episode;
  for (const fam of NE11J_FAMILIES) {
    assert.ok(episode.includes(fam), `${fam} is gated by the episode capability`);
    const ids = manifest.families[fam]?.ids ?? [];
    assert.ok(ids.length > 0, `${fam} is recorded`);
    for (const id of ids) assert.equal(pending[id], undefined, `${id} is owed to ${pending[id]}; NE-11s burned this family down, so the Swift port must pass it`);
  }
  const invariant = loadFixtures(ROOT, { family: "session-invariant" }).flatMap((f) => f.doc.cases);
  assert.ok(invariant.every((c) => c.authored === true), "session-invariant is authored end to end: the rule is the spec's, not the recorder's");
});
