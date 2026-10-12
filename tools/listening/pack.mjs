/* GV-36 (W1-17: R2-01, QK-30, GP-20, MQ-20) — the blind listening pack: act N
 * of one candidate ("solo") or of two candidates as "A" and "B", as a folder
 * the founder opens in a browser. Nothing is published to data/forays.json and
 * nothing touches app.js, styles.css or index.html: the pack is its own page.
 *
 * WHAT IS BUILT
 *   <out>/pack.json      labels and items only: what to play, in order. No
 *                        candidate id, provider, model, title, slot, segment id
 *                        or file name — anything that could unblind the pack.
 *                        It records which narration voice the page will use.
 *   <out>/listen.html    self-contained (inline CSS and JS, no external script,
 *                        style or font). One <audio> plays the clips (seek to
 *                        startSec, pause at endSec) and rendered narration;
 *                        narration with no rendered audio is spoken with
 *                        window.speechSynthesis, the device's own voice (OQ-03:
 *                        the phone voice). One listen-card/1 form per version
 *                        (tools/listening/card.mjs), a wince button that stamps
 *                        the elapsed listening time, 'Copy card JSON' and
 *                        'Download'. A clip from an episode suspected of
 *                        dynamic ad insertion carries a 'times may drift' badge.
 *   <key-dir>/<packId>.key.json
 *                        listen-key/1 (tools/listening/unseal.mjs): which
 *                        candidate, provider and stage swap each label was. It
 *                        is written to --key-dir and NEVER to --out; a key dir
 *                        inside the out dir is refused.
 *
 * WHICH ITEMS ARE "THE ACT"
 * The act's introduction (`act-N-introduction`) up to, not including, the next
 * act's introduction, so the act's exit seam is heard. Act 1 also opens with
 * everything before its introduction — the disclosure — because that is what a
 * listener hears first.
 *
 * HOW A CLIP RESOLVES
 * A segment item resolves to { enclosureUrl, startSec, endSec, daiVariable }:
 * the segment row from the candidate's own minted `segments` first, then the
 * committed pool (--segments, default data/segments.json); the episode's audio
 * row from the candidate's `segmentSources` first, then the committed sources
 * (--sources, default data/segment-sources.json). A clip that resolves nowhere
 * stays in the pack as `unresolved` (the page says so and moves on) rather than
 * failing the whole pack: the founder can still hear the narration around it,
 * and the CLI prints how many clips did not resolve.
 *
 * THE SEAL
 * With --b, which candidate is "A" comes from a seeded RNG (mulberry32 on
 * --seed; a random seed when none is given). The packId is a hash of the
 * pack's content and the seed, so the same inputs and seed give a
 * byte-identical pack.json, listen.html and key. The CLI never prints which
 * candidate got which label.
 *
 * USAGE
 *   node tools/listening/pack.mjs --a <candidate.json> [--b <candidate.json>]
 *     --act 1 --out <dir> [--seed n] [--segments data/segments.json]
 *     [--sources data/segment-sources.json] [--key-dir data-local/listening/keys]
 *     [--prompt-id <id>] [--provider-a <p>] [--provider-b <p>]
 *     [--swap-a <label>] [--swap-b <label>]
 *   Keep --out under data-local/ (gitignored): a pack holds narration scripts
 *   and is never committed.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isEntryScript } from "../ci/entry.mjs";
import { AXES, CARD_SCHEMA, MAX_NOTE_CHARS, Q06_KEYS, REPO_ROOT } from "./card.mjs";
import { DEFAULT_KEY_DIR, KEY_SCHEMA, validateKey } from "./unseal.mjs";

export const PACK_SCHEMA = "listen-pack/1";
export const DEFAULT_SEGMENTS = path.join(REPO_ROOT, "data", "segments.json");
export const DEFAULT_SOURCES = path.join(REPO_ROOT, "data", "segment-sources.json");

/** What the page shows for a narration item whose candidate carries no script
 * (a redacted fixture such as the out-9 bench candidate). */
export const NO_SCRIPT = "script not in fixture";

/** The voice line pack.json records for narration the page will speak. */
export const SYNTH_VOICE = "speechSynthesis: the device's default voice";
export const RENDERED_VOICE = "rendered narration audio";
export const NO_VOICE = "none: no narration script or rendered audio in this act";

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/* ------------------------------------------------------------------ */
/* The act                                                             */
/* ------------------------------------------------------------------ */

/** The items of act `act` (1-based): see the header. Throws when the
 * candidate has no `act-N-introduction`. */
export function extractAct(items, act) {
  if (!Array.isArray(items)) throw new Error("candidate has no items list");
  if (!Number.isInteger(act) || act < 1) throw new Error(`--act must be an integer >= 1, got ${act}`);
  const introAt = (n) => items.findIndex((i) => isPlainObject(i) && i.id === `act-${n}-introduction`);
  const start = introAt(act);
  if (start < 0) throw new Error(`candidate has no act-${act}-introduction item`);
  const next = introAt(act + 1);
  const end = next > start ? next : items.length;
  return items.slice(act === 1 ? 0 : start, end);
}

/* ------------------------------------------------------------------ */
/* Pools                                                               */
/* ------------------------------------------------------------------ */

function readJson(file, what) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`cannot read ${what} ${file}: ${err.message}`);
  }
}

/** The committed segment pool and source registry as id -> row maps. Accepts
 * the committed wrappers ({ segments: [...] }, { sources: [...] }) or a bare
 * array. */
export function loadPools({ segmentsFile = DEFAULT_SEGMENTS, sourcesFile = DEFAULT_SOURCES } = {}) {
  const seg = readJson(segmentsFile, "segments");
  const src = readJson(sourcesFile, "segment sources");
  const segRows = Array.isArray(seg) ? seg : seg.segments;
  const srcRows = Array.isArray(src) ? src : src.sources;
  if (!Array.isArray(segRows)) throw new Error(`${segmentsFile} has no segments list`);
  if (!Array.isArray(srcRows)) throw new Error(`${sourcesFile} has no sources list`);
  return {
    segments: new Map(segRows.filter((r) => isPlainObject(r) && typeof r.id === "string").map((r) => [r.id, r])),
    sources: new Map(srcRows.filter((r) => isPlainObject(r) && typeof r.id === "string").map((r) => [r.id, r]))
  };
}

/** One segment row in one shape, from a minted candidate row (camelCase) or a
 * committed pool row (snake_case). */
function segmentView(row) {
  if (!isPlainObject(row)) return null;
  const itemId = row.itemId ?? row.item_id;
  const startSec = row.startSec ?? row.start_sec;
  const endSec = row.endSec ?? row.end_sec;
  if (typeof itemId !== "string" || !isNum(startSec) || !isNum(endSec) || endSec <= startSec) return null;
  return { itemId, startSec, endSec, daiSuspected: row.dai_suspected === true };
}

/** A segment item -> { kind: "clip", enclosureUrl, startSec, endSec,
 * daiVariable } or { kind: "clip", unresolved }. The candidate's own rows win
 * over the committed ones (see the header). */
export function resolveClip(segmentId, candidate, pools) {
  const minted = (candidate.segments || []).find((r) => isPlainObject(r) && r.id === segmentId);
  const seg = segmentView(minted) || segmentView(pools.segments.get(segmentId));
  if (!seg) return { kind: "clip", unresolved: "segment not found" };
  const source = (candidate.segmentSources || []).find((r) => isPlainObject(r) && r.id === seg.itemId) || pools.sources.get(seg.itemId);
  if (!isPlainObject(source) || typeof source.audio_url !== "string" || !/^https?:\/\//.test(source.audio_url)) {
    return { kind: "clip", unresolved: "no audio source" };
  }
  return {
    kind: "clip",
    enclosureUrl: source.audio_url,
    startSec: seg.startSec,
    endSec: seg.endSec,
    daiVariable: source.dai_suspected === true || seg.daiSuspected
  };
}

/** One candidate item -> one pack item, with nothing that names the
 * candidate: no item id, slot, segment id, mode or cites. */
export function packItem(item, candidate, pools) {
  if (item.type === "segment") return resolveClip(item.segment_id, candidate, pools);
  if (item.type === "narration") {
    const script = typeof item.script === "string" && item.script.trim() !== "" ? item.script : null;
    const audioUrl = typeof item.audio_url === "string" && /^https?:\/\//.test(item.audio_url) ? item.audio_url : null;
    return { kind: "narration", script, audioUrl };
  }
  return { kind: "jingle" };
}

/** The act of one candidate as pack items, plus counts for the CLI. */
export function buildVersion(candidate, act, pools) {
  if (!isPlainObject(candidate)) throw new Error("a candidate is a JSON object");
  const items = extractAct(candidate.items, act).map((i) => packItem(i, candidate, pools));
  const count = (pred) => items.filter(pred).length;
  return {
    items,
    stats: {
      clips: count((i) => i.kind === "clip"),
      unresolvedClips: count((i) => i.kind === "clip" && i.unresolved),
      narration: count((i) => i.kind === "narration"),
      rendered: count((i) => i.kind === "narration" && i.audioUrl),
      noScript: count((i) => i.kind === "narration" && !i.audioUrl && !i.script)
    }
  };
}

/* ------------------------------------------------------------------ */
/* The seal                                                            */
/* ------------------------------------------------------------------ */

/** mulberry32: a small seeded RNG, so the same --seed gives the same A/B. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Which narration voice the page will use, recorded in pack.json. */
function voiceOf(versions) {
  const narration = versions.flatMap((v) => v.items.filter((i) => i.kind === "narration" && (i.audioUrl || i.script)));
  const rendered = narration.filter((i) => i.audioUrl).length;
  const spoken = narration.length - rendered;
  const primary =
    narration.length === 0
      ? NO_VOICE
      : spoken === 0
        ? RENDERED_VOICE
        : rendered === 0
          ? SYNTH_VOICE
          : `${RENDERED_VOICE} where rendered, else ${SYNTH_VOICE}`;
  return { narration: primary, renderedItems: rendered, synthesizedItems: spoken };
}

/** A candidate's prompt id for the key: --prompt-id, else its Foray id with
 * the run's hash suffix cut off, so two candidates of one prompt agree. */
export function promptIdOf(candidate) {
  const id = typeof candidate.id === "string" && candidate.id ? candidate.id : "unknown-prompt";
  return id.replace(/-[0-9a-f]{6}$/i, "");
}

/**
 * Build a pack in memory. Writes nothing.
 *
 * @param {object} args
 * @param {{ candidate, candidateId, provider?, stageSwap? }} args.a
 * @param {{ candidate, candidateId, provider?, stageSwap? }} [args.b]
 * @param {number} args.act
 * @param {number} args.seed   unsigned 32-bit integer
 * @param {{ segments: Map, sources: Map }} args.pools
 * @param {string} [args.promptId]
 * @returns {{ packId, pack, html, key, stats }}
 */
export function buildPack({ a, b, act, seed, pools, promptId }) {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error(`--seed must be an integer 0..4294967295, got ${seed}`);
  const arms = b ? [a, b] : [a];
  for (const arm of arms) {
    if (typeof arm.candidateId !== "string" || arm.candidateId === "") throw new Error("each candidate needs a candidateId (its file name without .json)");
  }
  let labelled;
  if (b) {
    const swap = mulberry32(seed)() >= 0.5;
    labelled = swap ? [["A", b], ["B", a]] : [["A", a], ["B", b]];
  } else {
    labelled = [["solo", a]];
  }
  const built = labelled.map(([label, arm]) => ({ label, ...buildVersion(arm.candidate, act, pools) }));
  const versions = built.map(({ label, items }) => ({ label, items }));
  const mode = b ? "pair" : "solo";

  const body = { act, mode, voice: voiceOf(versions), versions };
  const packId = `pk-${crypto.createHash("sha256").update(JSON.stringify({ seed, body })).digest("hex").slice(0, 12)}`;
  const pack = { schema: PACK_SCHEMA, packId, ...body };

  let pid = promptId;
  if (!pid) {
    const ids = [...new Set(arms.map((arm) => promptIdOf(arm.candidate)))];
    if (ids.length > 1) throw new Error("the two candidates look like different prompts; pass --prompt-id to pair them anyway");
    pid = ids[0];
  }
  const armKey = (arm) => ({
    candidateId: arm.candidateId,
    provider: arm.provider || (typeof arm.candidate.meta?.provider === "string" && arm.candidate.meta.provider) || "unrecorded",
    stageSwap: arm.stageSwap || "baseline"
  });
  const key = { schema: KEY_SCHEMA, packId, promptId: pid, act, seed };
  for (const [label, arm] of labelled) key[label] = armKey(arm);
  const { ok, errors } = validateKey(key);
  if (!ok) throw new Error(`internal: built an invalid key: ${errors.join("; ")}`);

  return {
    packId,
    pack,
    html: renderHtml(pack),
    key,
    stats: Object.fromEntries(built.map(({ label, stats }) => [label, stats]))
  };
}

/* ------------------------------------------------------------------ */
/* Writing                                                             */
/* ------------------------------------------------------------------ */

function inside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Write pack.json and listen.html to outDir and the key to keyDir. Refuses a
 * key dir inside the out dir (the key would travel with the pack), and an
 * existing key for the same packId that says something else. */
export function writePack(built, { outDir, keyDir = DEFAULT_KEY_DIR }) {
  if (!outDir) throw new Error("--out is required");
  if (inside(outDir, keyDir)) throw new Error(`--key-dir ${keyDir} is inside --out ${outDir}: the key must never travel with the pack`);
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(keyDir, { recursive: true });
  const packFile = path.join(outDir, "pack.json");
  const htmlFile = path.join(outDir, "listen.html");
  const keyFile = path.join(keyDir, `${built.packId}.key.json`);
  const keyText = `${JSON.stringify(built.key, null, 2)}\n`;
  if (fs.existsSync(keyFile) && fs.readFileSync(keyFile, "utf8") !== keyText) {
    throw new Error(`a different key for ${built.packId} already exists at ${keyFile}; refusing to overwrite it`);
  }
  fs.writeFileSync(packFile, `${JSON.stringify(built.pack, null, 2)}\n`);
  fs.writeFileSync(htmlFile, built.html);
  fs.writeFileSync(keyFile, keyText);
  return { packFile, htmlFile, keyFile };
}

/* ------------------------------------------------------------------ */
/* The page's card builder                                             */
/* ------------------------------------------------------------------ */

/** The listen-card/1 shape the page fills, taken from card.mjs so the page
 * and the validator cannot drift. Embedded in listen.html as CARD_SHAPE. */
export const CARD_SHAPE = Object.freeze({ schema: CARD_SCHEMA, axes: [...AXES], q06: [...Q06_KEYS], maxNote: MAX_NOTE_CHARS });

/**
 * The page's card builder. Its source is embedded verbatim in listen.html (in
 * <script id="card-builder">), so it must stay self-contained: no imports, no
 * closures over module scope, ES5-ish syntax every phone browser runs.
 *
 * input: { packId, label, act, listener, listenedAt, scores: {axis: 1-5},
 *          overall, q06: {key: true|false}, winces: [{atSec, note}],
 *          preference }   (form values; numbers may arrive as strings)
 * returns { card, missing }: `missing` lists what the listener has not
 * answered yet; the page copies nothing until it is empty.
 */
export function buildCard(input, shape) {
  var missing = [];
  var score = function (v) {
    var n = Number(v);
    return v !== "" && v !== null && v !== undefined && Math.floor(n) === n && n >= 1 && n <= 5 ? n : null;
  };
  var scores = {};
  for (var i = 0; i < shape.axes.length; i++) {
    var axis = shape.axes[i];
    var s = score(input.scores ? input.scores[axis] : null);
    if (s === null) missing.push(axis);
    scores[axis] = s;
  }
  var overall = score(input.overall);
  if (overall === null) missing.push("overall");
  var q06 = {};
  for (var j = 0; j < shape.q06.length; j++) {
    var q = shape.q06[j];
    var raw = input.q06 ? input.q06[q] : null;
    var b = raw === true || raw === "true" || raw === "yes" ? true : raw === false || raw === "false" || raw === "no" ? false : null;
    if (b === null) missing.push(q);
    q06[q] = b;
  }
  var listener = String(input.listener || "").trim().slice(0, 64);
  if (!listener) missing.push("listener");
  var winces = [];
  var list = input.winces || [];
  for (var k = 0; k < list.length; k++) {
    var at = Number(list[k].atSec);
    winces.push({
      atSec: isFinite(at) && at > 0 ? Math.round(at * 10) / 10 : 0,
      note: String(list[k].note || "").slice(0, shape.maxNote)
    });
  }
  var stamp = String(input.listenedAt || "").replace(/[^0-9]/g, "").slice(0, 14);
  var card = {
    schema: shape.schema,
    cardId: input.packId + "-" + input.label + "-" + stamp,
    packId: input.packId,
    label: input.label,
    act: Number(input.act),
    listener: listener,
    listenedAt: input.listenedAt,
    scores: scores,
    overall: overall,
    q06: q06,
    winces: winces
  };
  if (input.label !== "solo") {
    if (input.preference === "A" || input.preference === "B" || input.preference === "tie") card.preference = input.preference;
    else missing.push("preference");
  }
  return { card: card, missing: missing };
}

/**
 * What the page shows for one item of a version. Like buildCard, its source is
 * embedded verbatim in listen.html (in <script id="item-describer">), so it
 * stays self-contained; the test runs that embedded copy.
 */
export function describeItem(item, noScript) {
  var fmt = function (sec) {
    sec = Math.max(0, Math.floor(sec));
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + ":" + (s < 10 ? "0" : "") + s;
  };
  if (item.kind === "clip") {
    if (item.unresolved) return "Clip: cannot be played (" + item.unresolved + ")";
    return "Clip, " + fmt(item.endSec - item.startSec);
  }
  if (item.kind === "narration") return item.audioUrl ? "Narration (rendered)" : item.script ? "Narration (spoken by this device)" : "Narration: " + noScript;
  return "Jingle (not played here)";
}

/* ------------------------------------------------------------------ */
/* The page                                                            */
/* ------------------------------------------------------------------ */

/** JSON safe inside a <script> element. */
function scriptJson(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

const AXIS_LABELS = {
  onSubject: "Stays on the subject",
  flowsAtSeams: "Flows at the seams (narration into clip and back)",
  oneNarrator: "Sounds like one narrator",
  nothingFalseOrOdd: "Nothing false or odd"
};
const Q06_LABELS = {
  oneVoice: "One voice throughout?",
  everyClipIntroduced: "Every clip introduced?",
  anyClipCutShort: "Any clip cut short?"
};

const PAGE_CSS = `
:root { --bg: #fbfaf7; --fg: #1d1c1a; --muted: #6b6760; --line: #dedad2; --card: #ffffff; --accent: #2f5d8a; --warn: #8a4b00; --warn-bg: #fff1dc; --now: #e8f0f8; }
@media (prefers-color-scheme: dark) { :root { --bg: #161615; --fg: #ecebe7; --muted: #a29e96; --line: #36342f; --card: #1f1f1d; --accent: #8db6e0; --warn: #ffc27a; --warn-bg: #3a2a14; --now: #22303d; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 760px; margin: 0 auto; padding: 16px; }
h1 { font-size: 1.4rem; margin: 0.2rem 0; }
h2 { font-size: 1.15rem; margin: 0 0 0.5rem; }
.muted { color: var(--muted); font-size: 0.9rem; }
.version { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 14px; margin: 16px 0; }
.controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 8px 0; }
button { font: inherit; padding: 8px 14px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg); color: var(--fg); cursor: pointer; }
button.primary { background: var(--accent); border-color: var(--accent); color: var(--bg); }
.clock { font-variant-numeric: tabular-nums; font-weight: 600; }
ol.items { padding-left: 1.6rem; margin: 8px 0; }
ol.items li { padding: 4px 6px; border-radius: 6px; cursor: pointer; }
ol.items li.now { background: var(--now); }
.badge { display: inline-block; font-size: 0.75rem; padding: 1px 6px; border-radius: 4px; background: var(--warn-bg); color: var(--warn); margin-left: 6px; }
details summary { color: var(--muted); }
fieldset { border: 1px solid var(--line); border-radius: 8px; margin: 10px 0; padding: 8px 10px; }
label { display: block; margin: 6px 0; }
select, input[type=text], textarea { font: inherit; color: var(--fg); background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 4px 6px; max-width: 100%; }
.wince { display: flex; gap: 6px; align-items: center; margin: 4px 0; flex-wrap: wrap; }
.wince input[type=text] { flex: 1 1 200px; }
textarea.out { width: 100%; min-height: 6rem; font-family: ui-monospace, Consolas, monospace; font-size: 0.8rem; }
.problems { color: var(--warn); }
`;

/* The page's player and form. Plain DOM, no framework; every callback checks
 * a play token so a pause or a skip cancels the item it interrupted. */
const PAGE_JS = `
(function () {
  var pack = JSON.parse(document.getElementById("pack-data").textContent);
  var audio = document.getElementById("player");
  var synth = window.speechSynthesis || null;
  var AXIS_LABELS = ${scriptJson(AXIS_LABELS)};
  var Q06_LABELS = ${scriptJson(Q06_LABELS)};
  var states = {};
  var current = null;
  var token = 0;

  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    for (var k in attrs || {}) e.setAttribute(k, attrs[k]);
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function now() { return performance.now() / 1000; }
  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec));
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + ":" + (s < 10 ? "0" : "") + s;
  }
  function elapsed(st) { return st.base + (st.playing ? now() - st.since : 0); }
  function describe(item) { return describeItem(item, NO_SCRIPT); }

  function stopAll() {
    token++;
    audio.pause();
    audio.onended = audio.ontimeupdate = audio.onerror = audio.onloadedmetadata = null;
    if (synth) synth.cancel();
  }
  function pause(st) {
    if (!st.playing) return;
    if (st.items[st.index] && st.items[st.index].kind === "clip" && !audio.paused) st.resumeAt = audio.currentTime;
    st.base = elapsed(st);
    st.playing = false;
    stopAll();
    render(st);
  }
  function play(st) {
    if (current && current !== st) pause(current);
    current = st;
    if (st.index >= st.items.length) st.index = 0;
    st.playing = true;
    st.since = now();
    playItem(st);
  }
  function advance(st, t) {
    if (t !== token) return;
    st.resumeAt = null;
    st.index++;
    if (st.index >= st.items.length) { pause(st); st.status.textContent = "End of the act. Fill in the card below."; return; }
    playItem(st);
  }
  function start(st) {
    var p = audio.play();
    if (p && p.catch) p.catch(function () { st.status.textContent = "The browser blocked playback; press Play again."; });
  }
  function later(st, t, ms) { setTimeout(function () { advance(st, t); }, ms); }
  function playItem(st) {
    stopAll();
    var t = token;
    var item = st.items[st.index];
    render(st);
    st.status.textContent = describe(item);
    if (item.kind === "clip" && !item.unresolved) {
      var from = st.resumeAt !== null && st.resumeAt >= item.startSec && st.resumeAt < item.endSec ? st.resumeAt : item.startSec;
      var go = function () {
        if (t !== token) return;
        audio.currentTime = from;
        start(st);
      };
      audio.ontimeupdate = function () { if (t === token && audio.currentTime >= item.endSec) { audio.pause(); advance(st, t); } };
      audio.onerror = function () { if (t === token) { st.status.textContent = "This clip could not be loaded; moving on."; later(st, t, 1500); } };
      if (audio.getAttribute("src") !== item.enclosureUrl) {
        audio.src = item.enclosureUrl;
        audio.onloadedmetadata = go;
        audio.load();
      } else go();
      return;
    }
    if (item.kind === "narration" && item.audioUrl) {
      audio.onended = function () { advance(st, t); };
      audio.onerror = function () { if (t === token) { st.status.textContent = "Rendered narration could not be loaded; moving on."; later(st, t, 1500); } };
      audio.src = item.audioUrl;
      start(st);
      return;
    }
    if (item.kind === "narration" && item.script && synth) {
      var u = new SpeechSynthesisUtterance(item.script);
      u.onend = function () { advance(st, t); };
      u.onerror = function () { advance(st, t); };
      synth.speak(u);
      return;
    }
    if (item.kind === "narration" && item.script) st.status.textContent = "This browser cannot speak narration; read it below.";
    later(st, t, 1200);
  }

  function render(st) {
    st.playBtn.textContent = st.playing ? "Pause" : "Play";
    for (var i = 0; i < st.rows.length; i++) st.rows[i].className = i === st.index ? "now" : "";
  }

  function scoreSelect(name) {
    var s = el("select", { name: name });
    s.appendChild(el("option", { value: "" }, "-"));
    for (var n = 1; n <= 5; n++) s.appendChild(el("option", { value: String(n) }, String(n)));
    return s;
  }
  function yesNo(name) {
    var s = el("select", { name: name });
    s.appendChild(el("option", { value: "" }, "-"));
    s.appendChild(el("option", { value: "yes" }, "yes"));
    s.appendChild(el("option", { value: "no" }, "no"));
    return s;
  }
  function addWince(st, atSec, note) {
    var row = el("div", { "class": "wince" });
    var at = el("input", { type: "number", step: "0.1", min: "0", value: String(atSec), "aria-label": "seconds into the act" });
    at.style.width = "6rem";
    var text = el("input", { type: "text", maxlength: String(CARD_SHAPE.maxNote), placeholder: "what jarred (a note, not a quote)", value: note || "" });
    var rm = el("button", { type: "button" }, "Remove");
    rm.onclick = function () { row.parentNode.removeChild(row); };
    row.appendChild(el("span", {}, "at")); row.appendChild(at); row.appendChild(el("span", {}, "s")); row.appendChild(text); row.appendChild(rm);
    st.wincesBox.appendChild(row);
    text.focus();
  }
  function formInput(st) {
    var f = st.form;
    var scores = {};
    for (var i = 0; i < CARD_SHAPE.axes.length; i++) scores[CARD_SHAPE.axes[i]] = f.elements["score-" + CARD_SHAPE.axes[i]].value;
    var q06 = {};
    for (var j = 0; j < CARD_SHAPE.q06.length; j++) q06[CARD_SHAPE.q06[j]] = f.elements["q06-" + CARD_SHAPE.q06[j]].value;
    var winces = [];
    var rows = st.wincesBox.querySelectorAll(".wince");
    for (var k = 0; k < rows.length; k++) {
      var ins = rows[k].querySelectorAll("input");
      winces.push({ atSec: ins[0].value, note: ins[1].value });
    }
    return {
      packId: pack.packId, label: st.label, act: pack.act,
      listener: f.elements.listener.value, listenedAt: new Date().toISOString(),
      scores: scores, overall: f.elements.overall.value, q06: q06, winces: winces,
      preference: f.elements.preference ? f.elements.preference.value : undefined
    };
  }
  function finish(st, then) {
    var built = buildCard(formInput(st), CARD_SHAPE);
    if (built.missing.length) { st.problems.textContent = "Not answered yet: " + built.missing.join(", "); return; }
    st.problems.textContent = "";
    var text = JSON.stringify(built.card);
    st.out.value = text;
    st.out.hidden = false;
    then(text, built.card);
  }
  function copy(st) {
    finish(st, function (text) {
      var done = function () { st.problems.textContent = "Copied. Paste it to Claude to append to cards.jsonl."; };
      var fallback = function () { st.out.focus(); st.out.select(); try { document.execCommand("copy"); done(); } catch (e) { st.problems.textContent = "Select the text below and copy it."; } };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback);
      else fallback();
    });
  }
  function download(st) {
    finish(st, function (text, card) {
      var a = el("a", { download: card.cardId + ".json" });
      a.href = URL.createObjectURL(new Blob([text + "\\n"], { type: "application/json" }));
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
    });
  }

  function version(v) {
    var st = { label: v.label, items: v.items, index: 0, playing: false, base: 0, since: 0, resumeAt: null, rows: [] };
    states[v.label] = st;
    var box = el("section", { "class": "version", id: "version-" + v.label });
    box.appendChild(el("h2", {}, v.label === "solo" ? "The act" : "Version " + v.label));
    var controls = el("div", { "class": "controls" });
    st.playBtn = el("button", { type: "button", "class": "primary" }, "Play");
    st.playBtn.onclick = function () { st.playing ? pause(st) : play(st); };
    var back = el("button", { type: "button" }, "Back");
    back.onclick = function () { var was = st.playing; pause(st); st.resumeAt = null; st.index = Math.max(0, st.index - 1); render(st); if (was) play(st); };
    var skip = el("button", { type: "button" }, "Skip");
    skip.onclick = function () { var was = st.playing; pause(st); st.resumeAt = null; st.index = Math.min(st.items.length - 1, st.index + 1); render(st); if (was) play(st); };
    var wince = el("button", { type: "button" }, "Wince");
    wince.title = "Stamp the elapsed listening time, then say what jarred";
    wince.onclick = function () { addWince(st, Math.round(elapsed(st) * 10) / 10, ""); };
    st.clock = el("span", { "class": "clock" }, "0:00");
    controls.appendChild(st.playBtn); controls.appendChild(back); controls.appendChild(skip); controls.appendChild(wince); controls.appendChild(st.clock);
    box.appendChild(controls);
    st.status = el("div", { "class": "muted" }, "Press Play. Listen first; the card is below.");
    box.appendChild(st.status);

    var list = el("ol", { "class": "items" });
    v.items.forEach(function (item, i) {
      var li = el("li", {}, describe(item));
      if (item.kind === "clip" && item.daiVariable) li.appendChild(el("span", { "class": "badge", title: "This episode may carry dynamically inserted ads, so the clip can land early or late." }, "times may drift"));
      if (item.kind === "narration" && item.script) {
        var d = el("details");
        d.appendChild(el("summary", {}, "script"));
        d.appendChild(el("div", {}, item.script));
        li.appendChild(d);
      }
      li.onclick = function (e) { if (e.target.tagName === "SUMMARY") return; var was = st.playing; pause(st); st.resumeAt = null; st.index = i; render(st); if (was) play(st); };
      st.rows.push(li);
      list.appendChild(li);
    });
    box.appendChild(list);

    var form = el("form");
    form.onsubmit = function (e) { e.preventDefault(); };
    st.form = form;
    var who = el("label", {}, "Listener ");
    who.appendChild(el("input", { type: "text", name: "listener", maxlength: "64", autocomplete: "name" }));
    form.appendChild(who);
    var axes = el("fieldset"); axes.appendChild(el("legend", {}, "Scores, 1 (bad) to 5 (great)"));
    CARD_SHAPE.axes.forEach(function (axis) { var l = el("label", {}, (AXIS_LABELS[axis] || axis) + " "); l.appendChild(scoreSelect("score-" + axis)); axes.appendChild(l); });
    var ov = el("label", {}, "Overall "); ov.appendChild(scoreSelect("overall")); axes.appendChild(ov);
    form.appendChild(axes);
    var q = el("fieldset"); q.appendChild(el("legend", {}, "Q-06"));
    CARD_SHAPE.q06.forEach(function (k) { var l = el("label", {}, (Q06_LABELS[k] || k) + " "); l.appendChild(yesNo("q06-" + k)); q.appendChild(l); });
    form.appendChild(q);
    if (v.label !== "solo") {
      var p = el("label", {}, "Which version would you rather hear again? ");
      var ps = el("select", { name: "preference" });
      [["", "-"], ["A", "A"], ["B", "B"], ["tie", "no preference (tie)"]].forEach(function (o) { ps.appendChild(el("option", { value: o[0] }, o[1])); });
      p.appendChild(ps);
      form.appendChild(p);
    }
    var w = el("fieldset"); w.appendChild(el("legend", {}, "Winces (Wince stamps the time)"));
    st.wincesBox = el("div"); w.appendChild(st.wincesBox);
    form.appendChild(w);
    var actions = el("div", { "class": "controls" });
    var c = el("button", { type: "button", "class": "primary" }, "Copy card JSON"); c.onclick = function () { copy(st); };
    var dl = el("button", { type: "button" }, "Download"); dl.onclick = function () { download(st); };
    actions.appendChild(c); actions.appendChild(dl);
    form.appendChild(actions);
    st.problems = el("div", { "class": "problems" });
    form.appendChild(st.problems);
    st.out = el("textarea", { "class": "out", readonly: "readonly" }); st.out.hidden = true;
    form.appendChild(st.out);
    box.appendChild(form);
    return box;
  }

  var root = document.getElementById("versions");
  pack.versions.forEach(function (v) { root.appendChild(version(v)); });
  var voice = document.getElementById("voice");
  voice.textContent = "Narration voice: " + pack.voice.narration + ".";
  if (synth && pack.voice.synthesizedItems > 0) {
    var name = function () { var vs = synth.getVoices(); for (var i = 0; i < vs.length; i++) if (vs[i]["default"]) return vs[i].name; return vs.length ? vs[0].name : null; };
    var show = function () { var n = name(); if (n) voice.textContent = "Narration voice: " + pack.voice.narration + " (here: " + n + ")."; };
    show();
    if ("onvoiceschanged" in synth) synth.onvoiceschanged = show;
  }
  setInterval(function () { for (var k in states) states[k].clock.textContent = fmt(elapsed(states[k])); }, 250);
})();
`;

/** listen.html for a pack: deterministic, self-contained. */
export function renderHtml(pack) {
  const title = pack.mode === "pair" ? "Blind pair listen" : "Solo listen";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${PAGE_CSS}</style>
</head>
<body>
<main>
<h1>${title}</h1>
<p class="muted">Act ${pack.act} · pack ${pack.packId}${pack.mode === "pair" ? " · two versions, A and B, in a random order" : ""}</p>
<p class="muted" id="voice"></p>
<p class="muted">Listen with the screen off if you like: the card is filled in afterwards. Wince stamps the time you have listened so far.</p>
<audio id="player" preload="none"></audio>
<div id="versions"></div>
</main>
<script type="application/json" id="pack-data">${scriptJson(pack)}</script>
<script id="card-builder">
var CARD_SHAPE = ${scriptJson(CARD_SHAPE)};
${buildCard.toString()}
</script>
<script id="item-describer">
var NO_SCRIPT = ${scriptJson(NO_SCRIPT)};
${describeItem.toString()}
</script>
<script>${PAGE_JS}</script>
</body>
</html>
`;
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

const USAGE =
  "usage: node tools/listening/pack.mjs --a <candidate.json> [--b <candidate.json>] --act 1 --out <dir> [--seed n] " +
  "[--segments data/segments.json] [--sources data/segment-sources.json] [--key-dir data-local/listening/keys] " +
  "[--prompt-id id] [--provider-a p] [--provider-b p] [--swap-a label] [--swap-b label]";

const FLAGS = {
  "--a": "a",
  "--b": "b",
  "--act": "act",
  "--out": "out",
  "--seed": "seed",
  "--segments": "segments",
  "--sources": "sources",
  "--key-dir": "keyDir",
  "--prompt-id": "promptId",
  "--provider-a": "providerA",
  "--provider-b": "providerB",
  "--swap-a": "swapA",
  "--swap-b": "swapB"
};

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const name = FLAGS[argv[i]];
    if (!name) throw new Error(`unknown argument ${argv[i]}; ${USAGE}`);
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) throw new Error(`${argv[i - 1]} needs a value; ${USAGE}`);
    args[name] = value;
  }
  if (!args.a || !args.out || args.act === undefined) throw new Error(USAGE);
  if (!/^\d+$/.test(args.act)) throw new Error(`--act must be an integer >= 1, got ${args.act}`);
  args.act = Number(args.act);
  if (args.seed !== undefined) {
    if (!/^\d+$/.test(args.seed)) throw new Error(`--seed must be a non-negative integer, got ${args.seed}`);
    args.seed = Number(args.seed);
  }
  if (!args.b && (args.providerB || args.swapB)) throw new Error("--provider-b and --swap-b need --b");
  return args;
}

function arm(file, provider, stageSwap) {
  return { candidate: readJson(file, "candidate"), candidateId: path.basename(file).replace(/\.json$/i, ""), provider, stageSwap };
}

export function main(argv, out = console.log) {
  const args = parseArgs(argv);
  const pools = loadPools({ segmentsFile: args.segments ? path.resolve(args.segments) : DEFAULT_SEGMENTS, sourcesFile: args.sources ? path.resolve(args.sources) : DEFAULT_SOURCES });
  const built = buildPack({
    a: arm(path.resolve(args.a), args.providerA, args.swapA),
    b: args.b ? arm(path.resolve(args.b), args.providerB, args.swapB) : undefined,
    act: args.act,
    seed: args.seed ?? crypto.randomInt(0, 0xffffffff),
    pools,
    promptId: args.promptId
  });
  const files = writePack(built, { outDir: path.resolve(args.out), keyDir: args.keyDir ? path.resolve(args.keyDir) : DEFAULT_KEY_DIR });
  out(`pack ${built.packId} (${built.pack.mode}, act ${built.pack.act})`);
  for (const [label, s] of Object.entries(built.stats)) {
    out(`  ${label}: ${s.clips} clip(s), ${s.unresolvedClips} unresolved; ${s.narration} narration, ${s.rendered} rendered, ${s.noScript} with no script`);
  }
  out(`  page: ${files.htmlFile}`);
  out(`  pack: ${files.packFile}`);
  out(`  key:  ${files.keyFile} (local only; never commit it)`);
  return { built, files };
}

if (isEntryScript(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(String(err.message || err));
    process.exit(2);
  }
}
