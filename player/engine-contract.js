/* The web <-> native engine contract, protocol v1 (docs/native-engine-plan.md
   §4.4, §4.6, §5; cards NE-10j, NE-11j).

   WHAT THIS MODULE IS. Everything the page and the Swift engine must agree on
   to talk at all, as data and pure functions:

     names       PROTOCOL, the three bridge methods, the commands, events,
                 refusal reasons, read kinds, modes, capabilities
     schema      one JSON Schema for every payload that crosses the bridge
                 (contractSchemaDocument), and the validator that reads it
     page rules  decideMode (does this page talk to a native engine?) and
                 extrapolate (where is the playhead now, between snapshots?)
     engine rules, as JS REFERENCE TABLES the Swift port is held to:
                 sessionTransition (§4.4's SessionPolicy), audibleStartViolations
                 (the audible-start invariant), decideEngineMode and
                 engineModeTrace (§4.6's EngineMode.decideOnce and its strikes)

   WHY THE ENGINE'S RULES HAVE A JS REFERENCE AT ALL. The deck's rule is that
   JS is the reference and fixtures are the contract (plan §6): a Swift rule is
   written to pass cases recorded from JS, never the other way round. The
   session policy and the mode decision have no JS ancestor to extract — the
   page never owned an AVAudioSession — so they are written here as small pure
   tables, recorded into the session, session-invariant and engine-mode parity
   families, and NE-11s ports them to `SessionPolicy.swift` and
   `EngineMode.swift` case for case. A rule change is still JS first, then a
   re-record, then Swift.

   WHY ONE SCHEMA, AND WHY IT LIVES HERE. `player/parity/schema/
   engine-contract.schema.json` is the document both sides point at (§5.1), but
   the page cannot read a JSON file synchronously at boot, and a validator
   hand-written beside a hand-written schema is two copies of one rule that
   drift. So the schema is built here, validateContract interprets it (the
   small JSON Schema subset it uses — no dependency), and
   `tools/parity/contract-schema.mjs --write` renders the .json file from it;
   engine-contract.test.js is red while the file is stale. Its valid and
   invalid examples ARE the contract and snapshot parity families, one case
   each, so Swift's Codable decoding (NE-11s, NE-20) is held to the same
   accept/reject answers the page gives.

   UNKNOWN KEYS ARE ALLOWED EVERYWHERE, on purpose. Swift's Codable ignores
   them, an older page must survive a newer engine adding a field within v1,
   and a change that is NOT additive bumps PROTOCOL, which decideMode turns
   into "run the JS player". A closed set of VALUES (a cmd, a reason, a mode)
   is closed; a closed set of KEYS is not.

   Pure: no DOM, no storage, no clock. The only import is the vocabulary, which
   is pure data too. */

import {
  SESSION_ERRORS, INTERRUPTION_REASONS, SOURCES, MODE_REASONS,
} from "./engine-vocabulary.js";

/* ====================================================================== */
/* names                                                                  */
/* ====================================================================== */

/** The contract's version (§5). Sent in engineHello both ways; a page and an
    engine that disagree run the JS player (decideMode), because neither can
    know what the other's payloads mean. Bumped only for a change an older
    reader would misread — an added field is not one (see the header). */
export const PROTOCOL = 1;

/**
 * The shared storage rows the native engine owns on iOS (plan §4.6; NE-10j).
 *
 *   `cp_pos:`         one row per episode, `position-store.js` (positionKey)
 *   `cp_foray:`       one row per Foray, `foray-progress.js` (KEY_PREFIX)
 *   `cp_last_episode` the single pointer row, `episode-progress.js` (KEY)
 *
 * They are PREFIXES, matched with startsWith, and the trailing colons are
 * load-bearing: `cp_foray` without one would also claim `cp_foray_feedback`,
 * the thumbs store, which the engine never writes — a deferred key nobody
 * writes is a vote that silently stops saving. `cp_last_episode` is one whole
 * key, and needs no colon because nothing else starts with it
 * (engine-contract.test.js checks every `cp_` key the app spells). NE-23 makes
 * DurableStore treat these keys as DEFERRED on the iOS shell from the moment it
 * is constructed; the Swift EngineStore writes exactly these rows.
 */
export const OWNED_PREFIXES = Object.freeze(["cp_pos:", "cp_foray:", "cp_last_episode"]);

/** The three plugin methods (§5.1), iOS only. New commands never need a new
    CAPPluginMethod: they are `cmd` values inside engineSend. NE-20's
    shell-invariants pin checks the Swift registration against this list. */
export const BRIDGE_METHODS = Object.freeze(["engineHello", "engineSend", "engineRead"]);

/** Every engineSend `cmd` (§5.2). A cmd outside this list is refused with
    `unknown-cmd`, never guessed at. */
export const COMMANDS = Object.freeze([
  "playEpisode", "playForay", "setContinuation",
  "play", "pause", "toggle", "next", "previous",
  "seekBy", "seekTo", "jump",
  "stop",
  "setRate", "setVoice", "setInterludeEnabled",
  "setPageVisible",
  "ackAdvances", "ackEvents", "restoreBar", "purge",
  "relinquish", "audition", "setModeOverride", "setHoldPolicy", "probeSession",
  "simulateTermination",
]);

/** The `type` of every "engine" event (§5.4). Delivery is best effort: a page
    that misses one reads the snapshot on visible, pageshow and resume. */
export const EVENTS = Object.freeze(["snapshot", "advanced", "skipped", "error", "voiceFallback", "diag", "modeChanged"]);

/** Why an engineSend was refused: the `reason` of `{ok: false}` (§5.2). A
    closed set, fully expanded — `session-failed:<token>` is written out for
    each SESSION_ERRORS token rather than left as a pattern, so a reason on the
    wire is always one exact string both sides can switch on. */
export const REFUSALS = Object.freeze([
  "not-loaded", "no-next", "no-previous", "ended", "refused-structure", "capability-off",
  ...SESSION_ERRORS.map((t) => `session-failed:${t}`),
  "engine-busy", "relinquished", "unknown-cmd",
]);

/** engineRead's `what` (§5.1). */
export const READ_KINDS = Object.freeze(["snapshot", "rows", "diagnostics"]);

/** The engine's answer to "who plays?" (engineHello's `mode`, §4.6). `legacy`
    is the lane iOS plays through today — the JS player PLUS this plugin's Now
    Playing half — which is why it is not spelled `js` (NE-01's stub answers
    it). */
export const ENGINE_MODES = Object.freeze(["native", "legacy"]);

/** The page's own answer (decideMode): drive the native engine, or run the JS
    player. `engineMode` in client.js holds one of these (NE-22). */
export const PAGE_MODES = Object.freeze(["native", "js"]);

/** What a native engine can play (§6.6). Each is advertised only when its
    parity families owe nothing (coverage.test.js, the capability gate). */
export const CAPABILITIES = Object.freeze(["episode", "continuation", "restore", "foray"]);

/** relinquish's `cap`: the capability the page needed and the engine lacks
    (M1: a Foray tap sends `foray`), or `all` when the handshake itself failed. */
export const RELINQUISH_CAPS = Object.freeze([...CAPABILITIES, "all"]);

/** The Developer engine setting, 'Playback engine: Automatic / Native / Web'
    (NE-17), as setModeOverride's `mode` and the stored override. */
export const MODE_OVERRIDES = Object.freeze(["auto", "native", "web"]);

/** Snapshot `mode` (§5.3): what is loaded. */
export const SNAPSHOT_MODES = Object.freeze(["none", "episode", "foray"]);

/** Snapshot `state`: the six reducer states of queue-state.js (`S`), spelled
    as their `type`. */
export const PLAYER_STATES = Object.freeze(["idle", "loadingItem", "playing", "transitioning", "interrupted", "ended"]);

/** The session's phase (§4.2's composite state, §4.4). `relinquished` is
    terminal: after it the engine answers every input with nothing (§4.6). */
export const SESSION_PHASES = Object.freeze(["inactive", "active", "lostToInterruption", "relinquished"]);

/** pauseHoldPolicy's shapes (§4.4): hold the session through any pause
    (`forever`, the default, S-4 as written), release it at a pause (`none`, the
    H-1b arm), or release it after `until:<minutes>` of pause. As one string, so
    it round-trips through UserDefaults and a Copy header unchanged. */
export const HOLD_POLICY_KINDS = Object.freeze(["forever", "none", "until"]);
export const DEFAULT_HOLD_POLICY = "forever";

/** A strike is a launch whose previous native boot never reached a healthy
    marker, or a page that never said hello (§4.6). At this many the process
    runs legacy, sticky until CFBundleVersion changes. */
export const STRIKE_LIMIT = 3;

/* ====================================================================== */
/* small helpers                                                          */
/* ====================================================================== */

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isFiniteNum = (v) => typeof v === "number" && Number.isFinite(v);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** The refusal for a failed activation: `session-failed:<token>`, with a token
    outside SESSION_ERRORS admitted as `other` — the wire never carries an
    unknown token (engine-vocabulary.js, "WHY CLOSED"). */
export function sessionFailedReason(token) {
  return `session-failed:${SESSION_ERRORS.includes(token) ? token : "other"}`;
}

/** A hold policy string, parsed: `{kind, minutes}` or null when malformed.
    `until:<m>` takes a positive whole number of minutes and nothing else. */
export function parseHoldPolicy(policy) {
  if (policy === "forever" || policy === "none") return { kind: policy, minutes: null };
  const m = typeof policy === "string" ? /^until:([1-9][0-9]{0,5})$/.exec(policy) : null;
  return m ? { kind: "until", minutes: Number(m[1]) } : null;
}

/* ====================================================================== */
/* the schema                                                             */
/* ====================================================================== */

const HOLD_POLICY_PATTERN = "^(forever|none|until:[1-9][0-9]{0,5})$";

/** The public kinds a payload can be validated as, in the order the schema
    file lists them. */
export const CONTRACT_KINDS = Object.freeze([
  "helloRequest", "helloResponse", "sendRequest", "sendResponse",
  "readRequest", "rowsResponse", "diagnosticsResponse", "snapshot", "event",
]);

const str = { type: "string" };
const bool = { type: "boolean" };
const nonNeg = { type: "number", minimum: 0 };
const nonNegInt = { type: "integer", minimum: 0 };
const nullable = (s) => ({ ...s, type: [s.type, "null"] });
const argsOf = (required, properties) => ({ type: "object", required, properties });

/** Per-command args (§5.2). Where the plan names no argument (seekBy, seekTo,
    jump, setRate, setVoice, setInterludeEnabled), the name here is NE-11j's
    choice, the plainest one in the page's own vocabulary; NE-20 and NE-21
    read it from this table, so there is one spelling. A command absent from
    the table takes no args. */
const COMMAND_ARGS = {
  playEpisode: argsOf(["item", "lastEpisodeRow"], {
    item: { $ref: "#/$defs/item" },
    startSec: nonNeg,
    moved: bool,
    lastEpisodeRow: { type: "object", required: ["id"], properties: { id: { type: "string", minLength: 1 } } },
  }),
  playForay: argsOf(["forayId", "title", "items", "buildReport", "isLocalFile", "allowAdPad", "voiceId"], {
    forayId: { type: "string", minLength: 1 },
    title: str,
    items: { type: "array", minItems: 1, items: { $ref: "#/$defs/item" } },
    buildReport: { type: "object" },
    startElapsedSec: nonNeg,
    isLocalFile: bool,
    allowAdPad: bool,
    voiceId: nullable(str),
  }),
  setContinuation: argsOf(["planSeq", "autoAdvance", "chain"], {
    planSeq: nonNegInt,
    autoAdvance: bool,
    chain: { type: "array", items: { $ref: "#/$defs/hop" } },
    previous: { anyOf: [{ $ref: "#/$defs/hop" }, { type: "null" }] },
  }),
  seekBy: argsOf(["deltaSec"], { deltaSec: { type: "number" } }),
  seekTo: argsOf(["sec"], { sec: nonNeg }),
  jump: argsOf(["index"], { index: nonNegInt }),
  stop: argsOf(["persist"], { persist: bool }),
  setRate: argsOf(["rate"], { rate: { type: "number", exclusiveMinimum: 0 } }),
  setVoice: argsOf(["voiceId"], { voiceId: nullable(str) }),
  setInterludeEnabled: argsOf(["enabled"], { enabled: bool }),
  setPageVisible: argsOf(["visible"], { visible: bool }),
  ackAdvances: argsOf(["upToSeq"], { upToSeq: nonNegInt }),
  ackEvents: argsOf(["upToSeq"], { upToSeq: nonNegInt }),
  relinquish: argsOf(["cap"], { cap: { enum: [...RELINQUISH_CAPS] } }),
  audition: argsOf(["text", "voiceId"], { text: { type: "string", minLength: 1 }, voiceId: nullable(str) }),
  setModeOverride: argsOf(["mode"], { mode: { enum: [...MODE_OVERRIDES] } }),
  setHoldPolicy: argsOf(["policy"], { policy: { type: "string", pattern: HOLD_POLICY_PATTERN } }),
};

/* ---------- examples: the contract and snapshot parity families ---------- */

const NOW_PLAYING = { title: "The Long Drive", artist: "A Show", album: "Foray" };

/** A whole, valid snapshot: an episode playing at 1.5x, session held. */
const SNAPSHOT_PLAYING = {
  v: 1, seq: 42, capturedAtWallMs: 1790000000000, capturedAtMonotonicMs: 523000,
  mode: "episode", index: 0, itemId: "ep-1", itemKind: "episode",
  state: "playing", running: true, inSeamGap: false, inInterlude: false, buffering: false, ended: false,
  positionSec: 120.5, durationSec: 3600, sourceTimeSec: 120.5, playheadItemId: "ep-1", isNarrationPlayhead: false,
  rate: 1.5, effectiveRate: 1.5, canNext: true, canPrevious: true, autoAdvance: true,
  skippedSegments: 0, pendingAdvances: 0, pendingEvents: 0,
  session: "active", holdPolicy: "forever",
  nowPlaying: NOW_PLAYING,
};

/** Nothing loaded: what a fresh engine answers. */
const SNAPSHOT_IDLE = {
  v: 1, seq: 0, capturedAtWallMs: 1790000000000, capturedAtMonotonicMs: 0,
  mode: "none", state: "idle", running: false, inSeamGap: false, inInterlude: false, buffering: false, ended: false,
  positionSec: 0, durationSec: null, sourceTimeSec: null, playheadItemId: null, isNarrationPlayhead: false,
  rate: 1, effectiveRate: 0, canNext: false, canPrevious: false, autoAdvance: true,
  skippedSegments: 0, pendingAdvances: 0, pendingEvents: 0,
  session: "inactive", holdPolicy: "forever",
  nowPlaying: { title: "", artist: "", album: "" },
};

const without = (o, k) => { const c = { ...o }; delete c[k]; return c; };

/** `{valid: {slug: payload}, invalid: {slug: payload}}` per public kind. Each
    one is a case in the contract family (the snapshot's in the snapshot
    family), recorded as `contractAccepts(kind, payload)`; engine-contract.test.js
    keeps the two one-to-one and requires every valid example accepted and
    every invalid one refused. An invalid example is a mistake a real sender
    could make, one per example, so a validator that stops checking that one
    thing turns exactly one case red. */
const EXAMPLES = {
  helloRequest: {
    valid: { "page-v1": { pageBuild: "2026.09.24-1", protocol: 1 } },
    invalid: {
      "missing-protocol": { pageBuild: "2026.09.24-1" },
      "protocol-string": { pageBuild: "2026.09.24-1", protocol: "1" },
    },
  },
  helloResponse: {
    valid: {
      "not-built-stub": { mode: "legacy", reason: "not-built" },
      "native": {
        mode: "native", reason: "build-default", engineVersion: "1.0.0", protocol: 1,
        capabilities: ["episode", "restore"], ownedKeyPrefixes: [...OWNED_PREFIXES], snapshot: SNAPSHOT_IDLE,
        pendingAdvances: [{ planSeq: 3, hopSeq: 1, nextId: "ep-2", at: 1790000000000 }],
        pendingEvents: [{ seq: 7, kind: "position", episode_id: "ep-1", seconds: 60, duration: 3600, at: 1790000000000 }],
      },
      "crash-loop-legacy": { mode: "legacy", reason: "crash-loop", protocol: 1 },
    },
    invalid: {
      "mode-js": { mode: "js", reason: "build-default" },
      "reason-free-text": { mode: "legacy", reason: "the engine felt unwell" },
      "native-without-snapshot": {
        mode: "native", reason: "override", engineVersion: "1.0.0", protocol: 1,
        capabilities: ["episode"], ownedKeyPrefixes: [...OWNED_PREFIXES],
      },
      "unknown-capability": {
        mode: "native", reason: "override", engineVersion: "1.0.0", protocol: 1,
        capabilities: ["carplay"], ownedKeyPrefixes: [...OWNED_PREFIXES], snapshot: SNAPSHOT_IDLE,
      },
    },
  },
  sendRequest: {
    valid: {
      "play-tap": { v: 1, cmdSeq: 5, cmd: "play", source: "tap", issuedAtWallMs: 1790000000000 },
      "play-episode": {
        v: 1, cmdSeq: 6, cmd: "playEpisode", source: "tap",
        args: { item: { id: "ep-1", kind: "episode", audio_url: "https://example.com/a.mp3" }, startSec: 30, lastEpisodeRow: { id: "ep-1", title: "An Episode" } },
      },
      "relinquish-foray": { v: 1, cmdSeq: 7, cmd: "relinquish", source: "tap", args: { cap: "foray" } },
      "set-hold-until": { v: 1, cmdSeq: 8, cmd: "setHoldPolicy", source: "tap", args: { policy: "until:60" } },
      "set-continuation": {
        v: 1, cmdSeq: 9, cmd: "setContinuation", source: "restore",
        args: { planSeq: 3, autoAdvance: false, chain: [{ planSeq: 3, hopSeq: 1, nextId: "ep-2" }] },
      },
      "stop-data-deletion": { v: 1, cmdSeq: 10, cmd: "stop", source: "tap", args: { persist: false } },
    },
    invalid: {
      "unknown-cmd": { v: 1, cmdSeq: 5, cmd: "fastForward", source: "tap" },
      "wrong-version": { v: 2, cmdSeq: 5, cmd: "play", source: "tap" },
      "unknown-source": { v: 1, cmdSeq: 5, cmd: "play", source: "siri" },
      "relinquish-without-cap": { v: 1, cmdSeq: 5, cmd: "relinquish", source: "tap", args: {} },
      "relinquish-unknown-cap": { v: 1, cmdSeq: 5, cmd: "relinquish", source: "tap", args: { cap: "everything" } },
      "hold-until-zero": { v: 1, cmdSeq: 5, cmd: "setHoldPolicy", source: "tap", args: { policy: "until:0" } },
      "play-episode-without-row": { v: 1, cmdSeq: 5, cmd: "playEpisode", source: "tap", args: { item: { id: "ep-1" } } },
      "negative-seq": { v: 1, cmdSeq: -1, cmd: "play", source: "tap" },
      "override-unknown-mode": { v: 1, cmdSeq: 5, cmd: "setModeOverride", source: "tap", args: { mode: "legacy" } },
    },
  },
  sendResponse: {
    valid: {
      "ok": { ok: true, snapshot: SNAPSHOT_PLAYING },
      "refused-no-next": { ok: false, reason: "no-next", snapshot: SNAPSHOT_PLAYING },
      "session-failed": { ok: false, reason: "session-failed:cannot-interrupt-others", snapshot: SNAPSHOT_IDLE },
    },
    invalid: {
      "refused-without-reason": { ok: false, snapshot: SNAPSHOT_IDLE },
      "session-failed-unknown-token": { ok: false, reason: "session-failed:busy", snapshot: SNAPSHOT_IDLE },
      "without-snapshot": { ok: true },
    },
  },
  readRequest: {
    valid: {
      "snapshot": { what: "snapshot" },
      "rows-owned": { what: "rows", prefixes: [...OWNED_PREFIXES] },
      "diagnostics": { what: "diagnostics" },
    },
    invalid: {
      "rows-unowned-prefix": { what: "rows", prefixes: ["cp_queue"] },
      "unknown-what": { what: "everything" },
    },
  },
  rowsResponse: {
    valid: { "one-row": { rows: { "cp_pos:ep-1": "{\"seconds\":60,\"updated_at\":\"2026-09-24T00:00:00.000Z\"}" } } },
    invalid: { "row-not-a-string": { rows: { "cp_pos:ep-1": { seconds: 60 } } } },
  },
  diagnosticsResponse: {
    valid: { "one-row": { rows: [{ seq: 1, at: 1790000000000, kind: "mode", reason: "build-default" }] } },
    invalid: { "rows-not-an-array": { rows: { seq: 1 } } },
  },
  snapshot: {
    valid: {
      "playing": SNAPSHOT_PLAYING,
      "idle": SNAPSHOT_IDLE,
      "foray-narration": {
        ...SNAPSHOT_PLAYING, mode: "foray", forayId: "foray-1", index: 3, itemId: "n-3", itemKind: "tts",
        playheadItemId: "n-3", isNarrationPlayhead: true, narrationElapsedSec: 4.2, holdPolicy: "until:60",
      },
      "interrupted": { ...SNAPSHOT_PLAYING, state: "interrupted", wasPlaying: true, running: false, effectiveRate: 0, session: "lostToInterruption" },
    },
    invalid: {
      "missing-session": without(SNAPSHOT_PLAYING, "session"),
      "unknown-state": { ...SNAPSHOT_PLAYING, state: "paused" },
      "negative-position": { ...SNAPSHOT_PLAYING, positionSec: -1 },
      "zero-rate": { ...SNAPSHOT_PLAYING, rate: 0 },
      "bad-hold-policy": { ...SNAPSHOT_PLAYING, holdPolicy: "until:forever" },
      "wrong-version": { ...SNAPSHOT_PLAYING, v: 2 },
      "now-playing-missing-album": { ...SNAPSHOT_PLAYING, nowPlaying: { title: "t", artist: "a" } },
    },
  },
  event: {
    valid: {
      "snapshot": { type: "snapshot", snapshot: SNAPSHOT_PLAYING },
      "error-chain-start": { type: "error", code: "chain-start" },
      "mode-changed": { type: "modeChanged", mode: "legacy", reason: "downgrade" },
    },
    invalid: {
      "unknown-type": { type: "tick" },
      "snapshot-without-snapshot": { type: "snapshot" },
      "error-without-code": { type: "error" },
    },
  },
};

/**
 * The contract as a JSON Schema document (draft 2020-12, the subset
 * validateContract interprets). A function, not an exported object, so
 * tools/parity/gen-constants.mjs skips it (behaviour, not a constant) and every
 * call hands out a fresh copy no caller can mutate for the next.
 */
export function contractSchemaDocument() {
  const withExamples = (kind, schema) => ({ ...schema, "x-examples": EXAMPLES[kind] });
  const sendArgs = Object.entries(COMMAND_ARGS).map(([cmd, args]) => ({
    if: { properties: { cmd: { const: cmd } }, required: ["cmd"] },
    then: { required: ["args"], properties: { args } },
  }));
  const doc = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://jw-incorporated.github.io/foray/player/parity/schema/engine-contract.schema.json",
    title: `Foray web <-> native engine contract, protocol v${PROTOCOL} (docs/native-engine-plan.md §5)`,
    description:
      "GENERATED from player/engine-contract.js by `node tools/parity/contract-schema.mjs --write` - do not edit. " +
      "Every payload that crosses the engineHello / engineSend / engineRead bridge and the 'engine' event. " +
      "Each public $def carries x-examples {valid, invalid}; each example is one case of the contract (or snapshot) " +
      "parity family, so the page's validator and Swift's decoding give the same accept/reject answers. " +
      "Unknown keys are allowed everywhere: an additive field is not a protocol change.",
    "x-kinds": [...CONTRACT_KINDS],
    $defs: {
      helloRequest: withExamples("helloRequest", {
        type: "object",
        required: ["pageBuild", "protocol"],
        properties: { pageBuild: str, protocol: { type: "integer", minimum: 1 } },
      }),
      helloResponse: withExamples("helloResponse", {
        type: "object",
        required: ["mode", "reason"],
        properties: {
          mode: { enum: [...ENGINE_MODES] },
          reason: { enum: [...MODE_REASONS] },
          engineVersion: str,
          protocol: { type: "integer", minimum: 1 },
          capabilities: { type: "array", items: { enum: [...CAPABILITIES] } },
          ownedKeyPrefixes: { type: "array", items: str },
          snapshot: { $ref: "#/$defs/snapshot" },
          pendingAdvances: { type: "array", items: { $ref: "#/$defs/hop" } },
          pendingEvents: { type: "array", items: { $ref: "#/$defs/pendingEvent" } },
        },
        // A native engine must say everything the page needs to attach; the
        // NE-01 stub's {mode: "legacy", reason} says only "not me".
        if: { properties: { mode: { const: "native" } }, required: ["mode"] },
        then: { required: ["engineVersion", "protocol", "capabilities", "ownedKeyPrefixes", "snapshot"] },
      }),
      sendRequest: withExamples("sendRequest", {
        type: "object",
        required: ["v", "cmdSeq", "cmd", "source"],
        properties: {
          v: { const: PROTOCOL },
          cmdSeq: nonNegInt,
          cmd: { enum: [...COMMANDS] },
          args: { type: "object" },
          source: { enum: [...SOURCES] },
          issuedAtWallMs: nonNeg,
        },
        allOf: sendArgs,
      }),
      sendResponse: withExamples("sendResponse", {
        type: "object",
        required: ["ok", "snapshot"],
        properties: {
          ok: bool,
          reason: { enum: [...REFUSALS] },
          snapshot: { $ref: "#/$defs/snapshot" },
        },
        if: { properties: { ok: { const: false } }, required: ["ok"] },
        then: { required: ["reason"] },
      }),
      readRequest: withExamples("readRequest", {
        type: "object",
        required: ["what"],
        properties: {
          what: { enum: [...READ_KINDS] },
          // Shared rows only (NE-20): the engine's private keys are never read
          // through here, and neither is any row it does not own.
          prefixes: { type: "array", items: { enum: [...OWNED_PREFIXES] } },
        },
      }),
      rowsResponse: withExamples("rowsResponse", {
        type: "object",
        required: ["rows"],
        // key -> the exact string the engine stored (NE-10s's JSWriter bytes),
        // so the page adopts a row without re-serialising it.
        properties: { rows: { type: "object", additionalProperties: str } },
      }),
      diagnosticsResponse: withExamples("diagnosticsResponse", {
        type: "object",
        required: ["rows"],
        properties: { rows: { type: "array", items: { type: "object" } } },
      }),
      snapshot: withExamples("snapshot", {
        type: "object",
        required: [
          "v", "seq", "capturedAtWallMs", "capturedAtMonotonicMs", "mode", "state",
          "running", "inSeamGap", "inInterlude", "buffering", "ended",
          "positionSec", "durationSec", "sourceTimeSec", "playheadItemId", "isNarrationPlayhead",
          "rate", "effectiveRate", "canNext", "canPrevious", "autoAdvance",
          "skippedSegments", "pendingAdvances", "pendingEvents", "session", "holdPolicy", "nowPlaying",
        ],
        properties: {
          v: { const: PROTOCOL },
          seq: nonNegInt,
          capturedAtWallMs: nonNeg,
          capturedAtMonotonicMs: nonNeg,
          mode: { enum: [...SNAPSHOT_MODES] },
          forayId: nullable(str),
          index: nullable(nonNegInt),
          itemId: nullable(str),
          itemKind: nullable(str),
          state: { enum: [...PLAYER_STATES] },
          wasPlaying: bool,
          running: bool,
          inSeamGap: bool,
          inInterlude: bool,
          buffering: bool,
          ended: bool,
          positionSec: nonNeg,
          // null while the duration is unknown (JSON carries no Infinity).
          durationSec: nullable(nonNeg),
          sourceTimeSec: nullable(nonNeg),
          playheadItemId: nullable(str),
          isNarrationPlayhead: bool,
          narrationElapsedSec: nonNeg,
          rate: { type: "number", exclusiveMinimum: 0 },
          effectiveRate: nonNeg,
          canNext: bool,
          canPrevious: bool,
          autoAdvance: bool,
          lastError: nullable(str),
          voiceFallback: nullable(str),
          // Counts here; the logs themselves travel in engineHello.
          skippedSegments: nonNegInt,
          pendingAdvances: nonNegInt,
          pendingEvents: nonNegInt,
          session: { enum: [...SESSION_PHASES] },
          holdPolicy: { type: "string", pattern: HOLD_POLICY_PATTERN },
          nowPlaying: { $ref: "#/$defs/nowPlaying" },
        },
      }),
      event: withExamples("event", {
        type: "object",
        required: ["type"],
        properties: { type: { enum: [...EVENTS] } },
        allOf: [
          { if: { properties: { type: { const: "snapshot" } }, required: ["type"] }, then: { required: ["snapshot"], properties: { snapshot: { $ref: "#/$defs/snapshot" } } } },
          { if: { properties: { type: { const: "error" } }, required: ["type"] }, then: { required: ["code"], properties: { code: { type: "string", minLength: 1 } } } },
          {
            if: { properties: { type: { const: "modeChanged" } }, required: ["type"] },
            then: { required: ["mode", "reason"], properties: { mode: { enum: [...ENGINE_MODES] }, reason: { enum: [...MODE_REASONS] } } },
          },
        ],
      }),
      // Helpers, not payloads of their own.
      nowPlaying: {
        type: "object",
        required: ["title", "artist", "album"],
        properties: { title: str, artist: str, album: str },
      },
      item: { type: "object", required: ["id"], properties: { id: { type: "string", minLength: 1 } } },
      hop: {
        // continuation.js's hop: planSeq/hopSeq order it, nextId names what it plays.
        type: "object",
        required: ["planSeq", "hopSeq", "nextId"],
        properties: { planSeq: nonNegInt, hopSeq: nonNegInt, nextId: { type: "string", minLength: 1 } },
      },
      pendingEvent: {
        // continuation.js planEventDrain's input: {seq, kind: "position", episode_id, seconds, duration, at}.
        type: "object",
        required: ["seq", "kind"],
        properties: { seq: nonNegInt, kind: str },
      },
    },
  };
  return JSON.parse(JSON.stringify(doc));
}

/* ---------- the validator: the JSON Schema subset the document uses ---------- */

let schemaCache = null;
const schema = () => (schemaCache ??= contractSchemaDocument());

function typeOk(t, v) {
  switch (t) {
    case "object": return isObj(v);
    case "array": return Array.isArray(v);
    case "string": return typeof v === "string";
    // JSON has no NaN or Infinity, and a value that cannot be written to the
    // wire cannot have come from it.
    case "number": return isFiniteNum(v);
    case "integer": return Number.isInteger(v);
    case "boolean": return typeof v === "boolean";
    case "null": return v === null;
    default: throw new RangeError(`the contract schema uses a type this validator does not know: ${t}`);
  }
}

const SUPPORTED = new Set([
  "$ref", "type", "enum", "const", "required", "properties", "additionalProperties", "items",
  "minimum", "exclusiveMinimum", "minLength", "pattern", "minItems", "allOf", "anyOf", "if", "then",
  "x-examples",
]);

function check(s, v, at, errors) {
  for (const k of Object.keys(s)) {
    // A keyword this interpreter ignores would be a rule the page silently
    // skips while the .json file claims it; refuse the schema instead.
    if (!SUPPORTED.has(k)) throw new RangeError(`the contract schema uses an unsupported keyword: ${k}`);
  }
  if (s.$ref) {
    const name = /^#\/\$defs\/([A-Za-z]+)$/.exec(s.$ref)?.[1];
    if (!name || !schema().$defs[name]) throw new RangeError(`unresolvable $ref ${s.$ref}`);
    check(schema().$defs[name], v, at, errors);
  }
  if ("const" in s && v !== s.const) errors.push(`${at}: must be ${JSON.stringify(s.const)}`);
  if (s.enum && !s.enum.includes(v)) errors.push(`${at}: ${JSON.stringify(v)} is not one of the closed set`);
  if (s.type) {
    const types = [].concat(s.type);
    if (!types.some((t) => typeOk(t, v))) {
      errors.push(`${at}: must be ${types.join(" or ")}`);
      return;
    }
  }
  if (isFiniteNum(v)) {
    if ("minimum" in s && v < s.minimum) errors.push(`${at}: must be >= ${s.minimum}`);
    if ("exclusiveMinimum" in s && v <= s.exclusiveMinimum) errors.push(`${at}: must be > ${s.exclusiveMinimum}`);
  }
  if (typeof v === "string") {
    if ("minLength" in s && v.length < s.minLength) errors.push(`${at}: must not be empty`);
    if (s.pattern && !new RegExp(s.pattern, "u").test(v)) errors.push(`${at}: does not match ${s.pattern}`);
  }
  if (Array.isArray(v)) {
    if ("minItems" in s && v.length < s.minItems) errors.push(`${at}: needs at least ${s.minItems} item(s)`);
    if (s.items) v.forEach((x, i) => check(s.items, x, `${at}/${i}`, errors));
  }
  if (isObj(v)) {
    for (const k of s.required ?? []) if (!own(v, k)) errors.push(`${at}: missing ${k}`);
    for (const [k, sub] of Object.entries(s.properties ?? {})) if (own(v, k)) check(sub, v[k], `${at}/${k}`, errors);
    if (isObj(s.additionalProperties)) {
      for (const k of Object.keys(v)) if (!own(s.properties ?? {}, k)) check(s.additionalProperties, v[k], `${at}/${k}`, errors);
    }
  }
  for (const sub of s.allOf ?? []) check(sub, v, at, errors);
  if (s.anyOf && !s.anyOf.some((sub) => validAgainst(sub, v))) errors.push(`${at}: matches none of the allowed shapes`);
  if (s.if && validAgainst(s.if, v) && s.then) check(s.then, v, at, errors);
}

function validAgainst(s, v) {
  const errors = [];
  check(s, v, "", errors);
  return errors.length === 0;
}

/**
 * Validate a payload as one of CONTRACT_KINDS against the schema.
 * @returns {{ok: boolean, errors: string[]}} errors are JSON-pointer-ish paths
 *   with a short reason, for a diagnostics row — never compared by parity
 *   (Swift's decoder words its errors its own way); contractAccepts is.
 * @throws {RangeError} for a kind that is not a contract kind (a bug in the
 *   caller, not a bad payload)
 */
export function validateContract(kind, value) {
  if (!CONTRACT_KINDS.includes(kind)) throw new RangeError(`no contract kind named ${JSON.stringify(kind)}`);
  const errors = [];
  check(schema().$defs[kind], value, "", errors);
  return { ok: errors.length === 0, errors };
}

/** Accept or refuse, and nothing else: what the contract and snapshot parity
    families record, and what the Swift side's decoding must answer too. */
export function contractAccepts(kind, value) {
  return validateContract(kind, value).ok;
}

/** validateContract("snapshot", s): a snapshot from engineSend, engineRead or
    an event is checked before the page believes a word of it (NE-21). */
export function validateSnapshot(snapshot) {
  return validateContract("snapshot", snapshot);
}

/* ====================================================================== */
/* the page's rules                                                       */
/* ====================================================================== */

/** engineHello's request: the page's build stamp and the protocol it speaks. */
export function helloRequest(pageBuild) {
  return { pageBuild: typeof pageBuild === "string" ? pageBuild : "", protocol: PROTOCOL };
}

/** Why decideMode answered what it did, one token per outcome. */
export const HANDSHAKE_REASONS = Object.freeze([
  "native", "not-ios", "no-method", "no-hello", "bad-hello", "engine-legacy", "protocol-mismatch",
]);

/**
 * Does this page drive a native engine? (§4.6's page boot order; NE-21, NE-22.)
 *
 *   {platform, methodPresent, hello}
 *     platform       Capacitor.getPlatform(): only "ios" has an engine
 *     methodPresent  whether the plugin answers engineHello at all (an older
 *                    binary does not)
 *     hello          engineHello's answer, or null for a timeout (5 s) or a
 *                    rejection
 *
 * @returns {{mode: "native"|"js", reason: string, relinquish: boolean}}
 *   `relinquish` is true when an engine MIGHT be running natively and the page
 *   is about to run the JS player anyway — no answer, an unreadable answer, or
 *   a protocol it does not speak. The page then sends relinquish{cap: "all"}
 *   before building a single audible thing, so there are never two producers
 *   (A-2). A clear `legacy` answer needs none: nothing native is playing.
 *
 * `mode` is checked BEFORE `protocol` because the NE-01 stub answers
 * {mode: "legacy", reason: "not-built"} with no protocol at all, and that is
 * the ordinary case for every build before the engine ships, not a mismatch.
 */
export function decideMode(input) {
  const out = (mode, reason, relinquish) => ({ mode, reason, relinquish });
  if (input?.platform !== "ios") return out("js", "not-ios", false);
  if (input.methodPresent !== true) return out("js", "no-method", false);
  const hello = input.hello;
  if (hello === null || hello === undefined) return out("js", "no-hello", true);
  if (!contractAccepts("helloResponse", hello)) return out("js", "bad-hello", true);
  if (hello.mode !== "native") return out("js", "engine-legacy", false);
  if (hello.protocol !== PROTOCOL) return out("js", "protocol-mismatch", true);
  return out("native", "native", false);
}

/**
 * Where the playhead is `nowMs` after a snapshot arrived at `receivedAtMs`
 * (§5.4), for the scrubber between the engine's ≤ 1 Hz snapshots.
 *
 * The page's OWN receipt time, not the snapshot's capture time: the two clocks
 * are different processes' (and the page may have been suspended between
 * them), so only the page's clock can be subtracted from the page's clock.
 *
 * FROZEN — the position is returned as sent — while `inSeamGap` (the beat is
 * silence, the source is not moving), `buffering` (a stall), or `!running`
 * (paused, interrupted, ended, idle). Extrapolating any of those is a
 * scrubber that runs ahead of audio that is not playing.
 *
 * Clamped to [0, durationSec] when the duration is known, and a clock that
 * went backwards counts as no time at all.
 * @returns {number} seconds
 */
export function extrapolate(snapshot, receivedAtMs, nowMs) {
  const pos = isFiniteNum(snapshot?.positionSec) ? snapshot.positionSec : 0;
  const dur = isFiniteNum(snapshot?.durationSec) && snapshot.durationSec > 0 ? snapshot.durationSec : null;
  const clamp = (x) => Math.max(0, dur === null ? x : Math.min(dur, x));
  const frozen = snapshot?.inSeamGap === true || snapshot?.buffering === true || snapshot?.running !== true;
  if (frozen) return clamp(pos);
  const rate = isFiniteNum(snapshot.effectiveRate) && snapshot.effectiveRate > 0 ? snapshot.effectiveRate : 0;
  const elapsedMs = isFiniteNum(receivedAtMs) && isFiniteNum(nowMs) ? Math.max(0, nowMs - receivedAtMs) : 0;
  return clamp(pos + (rate * elapsedMs) / 1000);
}

/* ====================================================================== */
/* SessionPolicy: the JS reference table (§4.4)                           */
/* ====================================================================== */

/** The inputs SessionPolicy reads. */
export const SESSION_INPUTS = Object.freeze([
  "userPlay", "sessionResult",
  "pause", "beat", "narration", "background", "holdExpired",
  "interruptionBegan", "interruptionEnded", "mediaServicesReset",
  "relinquish", "close", "finalEnd", "dataDeletion",
]);

/** What caused a play the session may activate for (§4.4, S-1: activation
    only on a user-caused play). An audition tap counts: a tap is user-caused
    (OQ-5). */
export const PLAY_VIAS = Object.freeze(["tap", "remote", "autoresume", "auditionTap"]);

/** What the interpreter does to AVAudioSession for an edge. `deactivate` is
    setActive(false) with NO .notifyOthersOnDeactivation; `deactivate-notify`
    carries it, and is reserved for the three endings that mean "4a is done"
    (close, final end, data deletion) — notifying at a pause would invite the
    app 4a interrupted to take the car back mid-episode. `command-failed` is
    `.commandFailed` to the remote and `{ok: false, reason}` to the page. */
export const SESSION_ACTIONS = Object.freeze([
  "activate", "deactivate", "deactivate-notify", "reapply-category", "rebuild", "command-failed",
]);

/** The session row an edge writes beyond the ordinary transition row, when it
    is an input the policy deliberately IGNORED: the record has to show it
    arrived, or a drive's paste cannot tell "ignored" from "never delivered". */
export const SESSION_ROWS = Object.freeze(["stale-suspension", "mic-muted", "stale-hold", "media-services-reset"]);

const QUIET = ["pause", "beat", "narration", "background"];
const ENDINGS = ["close", "finalEnd", "dataDeletion"];

/**
 * One SessionPolicy edge: `(phase, input, holdPolicy) -> {phase, actions, row, reason}`.
 *
 * ACTIVATION IS A REQUEST AND A RESPONSE (§4.2). An edge that needs the session
 * active emits `activate` and LEAVES THE PHASE WHERE IT WAS; the interpreter
 * calls setActive(true) synchronously and feeds the outcome back as
 * `{kind: "sessionResult", ok, token}`, and only an ok result moves the phase
 * to `active`. So §4.4's `inactive --userPlay--> active [activate]` is two
 * edges here, and "fail: stay, token, .commandFailed" is the second one
 * failing. That split is what makes the audible-start invariant checkable: no
 * edge ever reports `active` on the strength of an activation that has not
 * happened (see audibleStartViolations).
 *
 * `relinquished` is terminal: every input returns it unchanged with nothing to
 * do — no deactivate and no notify on the way in, either (§4.6: an app 4a
 * interrupted must not be invited back by a lane switch).
 *
 * @param {string} phase       one of SESSION_PHASES
 * @param {object} input       {kind, ...}; kind one of SESSION_INPUTS
 *   userPlay            {via}                     one of PLAY_VIAS
 *   sessionResult       {ok, token?}              token one of SESSION_ERRORS
 *   interruptionBegan   {reason, running, activatedInProcess}
 *   interruptionEnded   {shouldResume, wasPlaying}
 *   holdExpired         {running}
 * @param {string} [holdPolicy] "forever" (default) | "none" | "until:<minutes>"
 * @returns {{phase: string, actions: string[], row: string|null, reason: string|null}}
 * @throws {RangeError} on an unknown phase, input kind, play via or hold policy
 */
export function sessionTransition(phase, input, holdPolicy = DEFAULT_HOLD_POLICY) {
  if (!SESSION_PHASES.includes(phase)) throw new RangeError(`unknown session phase ${JSON.stringify(phase)}`);
  const kind = input?.kind;
  if (!SESSION_INPUTS.includes(kind)) throw new RangeError(`unknown session input ${JSON.stringify(kind)}`);
  const hold = parseHoldPolicy(holdPolicy);
  if (!hold) throw new RangeError(`unknown hold policy ${JSON.stringify(holdPolicy)}`);
  const to = (next, actions = [], row = null, reason = null) => ({ phase: next, actions, row, reason });
  const stay = (actions, row, reason) => to(phase, actions, row, reason);

  if (phase === "relinquished") return stay();

  switch (kind) {
    case "userPlay":
      if (!PLAY_VIAS.includes(input.via)) throw new RangeError(`unknown play via ${JSON.stringify(input.via)}`);
      // S-5: activate once. An active session is not re-activated per press.
      return phase === "active" ? stay() : stay(["activate"]);

    case "sessionResult":
      if (input.ok === true) return to("active");
      return stay(["command-failed"], null, sessionFailedReason(input.token));

    case "pause": case "beat": case "narration": case "background":
      // S-4: a pause, a seam beat, a narration handover or going to the
      // background does not release the session. Only a PAUSE under the
      // `none` policy does (the H-1b arm), and never with notify.
      if (phase === "active" && kind === "pause" && hold.kind === "none") return to("inactive", ["deactivate"]);
      return stay();

    case "holdExpired":
      if (phase === "active" && hold.kind === "until" && input.running !== true) return to("inactive", ["deactivate"]);
      // A timer the engine failed to cancel (it is playing again, or the
      // policy changed) must not stop the audio; it is written down instead.
      return stay([], "stale-hold");

    case "interruptionBegan": {
      const reason = INTERRUPTION_REASONS.includes(input.reason) ? input.reason : "unknown";
      if (reason === "builtInMicMuted") return stay([], "mic-muted");
      // A late began(appWasSuspended) for a suspension that is already over:
      // the engine activated in this process and is audibly running, so the
      // notification describes the past (stale=y), not a stop.
      if (reason === "appWasSuspended" && input.running === true && input.activatedInProcess === true) {
        return stay([], "stale-suspension");
      }
      return phase === "active" ? to("lostToInterruption") : stay();
    }

    case "interruptionEnded":
      if (phase !== "lostToInterruption") return stay();
      // The system took the session; it comes back only by activating again,
      // and only for a listener who was actually listening.
      if (input.shouldResume === true && input.wasPlaying === true) return stay(["activate"]);
      // NP-9: Now Playing and the remote targets stay, so a later tap or car
      // button is a userPlay (S-5).
      return to("inactive");

    case "mediaServicesReset":
      return to("inactive", ["reapply-category", "rebuild"], "media-services-reset");

    case "relinquish":
      return to("relinquished");

    case "close": case "finalEnd": case "dataDeletion":
      return phase === "active" ? to("inactive", ["deactivate-notify"]) : to("inactive");
  }
  // Unreachable: SESSION_INPUTS was checked above and every kind has a case.
  throw new RangeError(`unhandled session input ${kind}`);
}

/* ====================================================================== */
/* the audible-start invariant (§4.4, the session-invariant family)       */
/* ====================================================================== */

/** The engine commands that make sound. Each must come after the session was
    active at the start of the turn, or after a SUCCESSFUL activation in the
    same turn — because AVPlayer.play(), a synthesizer and an audio engine all
    activate an inactive session IMPLICITLY (§4.3), which is exactly the
    second, unowned session start this deck exists to remove. */
export const AUDIBLE_COMMANDS = Object.freeze(["deckPlay", "speak", "interludeStart", "silenceStart"]);

/**
 * Check one `handle()` turn against the audible-start invariant.
 *
 * @param {string} sessionAtEntry  the session phase when the turn began
 * @param {string[]} turn          the turn in order: engine commands by name,
 *   plus the session traffic the interpreter interleaves —
 *     "sessionActivate"       the core's request (setActive(true))
 *     "sessionResult:ok"      the interpreter's answer, success
 *     "sessionResult:failed"  the interpreter's answer, failure
 *     "sessionDeactivate"     a deactivate in the same turn (hold policy none)
 *   Any other name is a command that makes no sound.
 * @returns {{at: number, cmd: string}[]} every audible command that had no
 *   active session behind it; empty = the turn keeps the invariant.
 *
 * A `sessionResult:ok` counts only as the answer to a `sessionActivate` asked
 * earlier in the same turn: a success nobody requested is not an activation
 * this engine owns.
 */
export function audibleStartViolations(sessionAtEntry, turn) {
  if (!SESSION_PHASES.includes(sessionAtEntry)) throw new RangeError(`unknown session phase ${JSON.stringify(sessionAtEntry)}`);
  if (!Array.isArray(turn)) throw new TypeError("a turn is an array of command names");
  let active = sessionAtEntry === "active";
  let asked = false;
  const violations = [];
  turn.forEach((cmd, at) => {
    if (typeof cmd !== "string") throw new TypeError(`turn[${at}] is not a command name`);
    if (cmd === "sessionActivate") asked = true;
    else if (cmd === "sessionResult:ok") { if (asked) active = true; asked = false; }
    else if (cmd === "sessionResult:failed") asked = false;
    else if (cmd === "sessionDeactivate") active = false;
    else if (AUDIBLE_COMMANDS.includes(cmd) && !active) violations.push({ at, cmd });
  });
  return violations;
}

/* ====================================================================== */
/* EngineMode.decideOnce: the JS reference table (§4.6)                   */
/* ====================================================================== */

/**
 * Which lane this process runs: the pure decision EngineOwnership.decideOnce()
 * makes once per process (NE-17 wraps it in the lazy static and UserDefaults).
 *
 * @param {object} i
 *   buildDefault       Info.plist ForayEngineDefault: "native" | "js" | absent
 *   override           the Developer setting: "auto" | "native" | "web"
 *   sentinelWasSet     the PREVIOUS launch's sentinel is still set (its native
 *                      boot never reached a healthy marker)
 *   strikes            the stored strike count
 *   stickyLegacyBuild  the CFBundleVersion a crash loop pinned to legacy, or null
 *   currentBuild       this launch's CFBundleVersion
 *   built              whether this binary has an engine at all
 * @returns {{mode, reason, strikes, stickyLegacyBuild, writeSentinel}} the lane,
 *   its MODE_REASONS token, and what to store back. `writeSentinel` is true
 *   exactly when the engine boots natively: the sentinel guards a native boot.
 *
 * ORDER, and why:
 *   1. not built   -> legacy/not-built. Nothing else can matter.
 *   2. a strike is added ONLY IF the previous sentinel is still set (never per
 *      launch: a background launch that went healthy is not a crash, R18).
 *   3. a sticky legacy pin from ANOTHER build is dropped with its strikes: a new
 *      CFBundleVersion is the fix a crash loop was waiting for.
 *   4. sticky for THIS build, or strikes at STRIKE_LIMIT -> legacy/crash-loop,
 *      and the pin is (re)written. Safety beats every preference below it,
 *      including a Developer override of native.
 *   5. the override, then 6. the plist: absent or unreadable is legacy with
 *      reason no-plist-key — a build that forgot the key runs today's player.
 */
export function decideEngineMode(i) {
  const strikes0 = Number.isInteger(i?.strikes) && i.strikes > 0 ? i.strikes : 0;
  const sticky0 = typeof i?.stickyLegacyBuild === "string" && i.stickyLegacyBuild ? i.stickyLegacyBuild : null;
  const build = typeof i?.currentBuild === "string" ? i.currentBuild : "";
  const out = (mode, reason, strikes, sticky) =>
    ({ mode, reason, strikes, stickyLegacyBuild: sticky, writeSentinel: mode === "native" });

  if (i?.built !== true) return out("legacy", "not-built", strikes0, sticky0);

  let strikes = i.sentinelWasSet === true ? strikes0 + 1 : strikes0;
  let sticky = sticky0;
  if (sticky !== null && sticky !== build) { sticky = null; strikes = 0; }
  if (sticky === build || strikes >= STRIKE_LIMIT) return out("legacy", "crash-loop", strikes, build);

  if (i.override === "native") return out("native", "override", strikes, null);
  if (i.override === "web") return out("legacy", "override", strikes, null);
  if (i.buildDefault === "native") return out("native", "build-default", strikes, null);
  if (i.buildDefault === "js") return out("legacy", "build-default", strikes, null);
  return out("legacy", "no-plist-key", strikes, null);
}

/** The events that move the stored mode state between and within launches. */
export const ENGINE_MODE_EVENTS = Object.freeze(["launch", "healthy", "page-health", "set-override"]);

/**
 * Fold a sequence of launches and in-process events over the stored state —
 * the strike rules across time, which one decideEngineMode call cannot show.
 *
 * @param {object} stored  {override, strikes, sentinel, stickyLegacyBuild}
 *   (the engine-private UserDefaults keys, §4.6)
 * @param {object[]} events
 *   {kind: "launch", buildDefault, currentBuild, built}
 *       decideEngineMode over the stored state; the old sentinel is consumed
 *       and a new one written only for a native boot.
 *   {kind: "healthy"}
 *       a healthy marker (first handled input, 5 s of run loop, resign
 *       active / background, first .playing): the sentinel clears and strikes
 *       reset to 0. Native processes only — legacy wrote no sentinel.
 *   {kind: "page-health"}
 *       no engineHello within 10 s of a foreground page load: ONE strike per
 *       process, counted from the strikes this launch STARTED with. Not from
 *       the current count: the 5 s healthy marker has usually reset it to 0 by
 *       then, and a page that is broken on every launch would otherwise sit at
 *       1 strike forever and never reach legacy. After it, a later healthy
 *       marker still clears the sentinel but no longer resets the strikes.
 *   {kind: "set-override", mode}
 *       the Developer setting changed: stored override, strikes 0, sticky
 *       cleared. The running process keeps its lane ("applies after restart").
 * @returns {object[]} after each event: {kind, mode, reason, override, strikes,
 *   sentinel, stickyLegacyBuild}; mode/reason are the current process's, null
 *   before the first launch.
 */
export function engineModeTrace(stored, events) {
  if (!Array.isArray(events)) throw new TypeError("events is an array");
  let s = {
    override: MODE_OVERRIDES.includes(stored?.override) ? stored.override : "auto",
    strikes: Number.isInteger(stored?.strikes) && stored.strikes > 0 ? stored.strikes : 0,
    sentinel: stored?.sentinel === true,
    stickyLegacyBuild: typeof stored?.stickyLegacyBuild === "string" && stored.stickyLegacyBuild ? stored.stickyLegacyBuild : null,
  };
  let proc = null;
  const trace = [];
  for (const e of events) {
    if (!ENGINE_MODE_EVENTS.includes(e?.kind)) throw new RangeError(`unknown engine-mode event ${JSON.stringify(e?.kind)}`);
    if (e.kind === "launch") {
      const d = decideEngineMode({
        buildDefault: e.buildDefault, override: s.override, sentinelWasSet: s.sentinel, strikes: s.strikes,
        stickyLegacyBuild: s.stickyLegacyBuild, currentBuild: e.currentBuild, built: e.built,
      });
      s = { ...s, strikes: d.strikes, stickyLegacyBuild: d.stickyLegacyBuild, sentinel: d.writeSentinel };
      proc = { mode: d.mode, reason: d.reason, launchStrikes: d.strikes, pageHealthTaken: false };
    } else if (e.kind === "healthy") {
      if (proc?.mode === "native") s = { ...s, sentinel: false, strikes: proc.pageHealthTaken ? s.strikes : 0 };
    } else if (e.kind === "page-health") {
      if (proc?.mode === "native" && !proc.pageHealthTaken) {
        proc = { ...proc, pageHealthTaken: true };
        s = { ...s, strikes: proc.launchStrikes + 1 };
      }
    } else {
      if (!MODE_OVERRIDES.includes(e.mode)) throw new RangeError(`unknown mode override ${JSON.stringify(e.mode)}`);
      s = { ...s, override: e.mode, strikes: 0, stickyLegacyBuild: null };
    }
    trace.push({ kind: e.kind, mode: proc?.mode ?? null, reason: proc?.reason ?? null, ...s });
  }
  return trace;
}
