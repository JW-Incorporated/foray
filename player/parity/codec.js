/* The parity codec: how a fixture says what JSON cannot (NE-03, plan §6.2).

   A fixture is read by two runtimes — this JS harness and the Swift
   `ForayEngineParity` library — so it has to be plain JSON. Plain JSON cannot
   say NaN, Infinity, -0 or undefined, and the rules the fixtures pin are full of
   them: seam-gap's "a nonsense length collapses to no beat" is a test ABOUT NaN
   and Infinity. So those values travel as tagged objects, and the tags are a
   closed set the schema names (`schema/fixture.schema.json`, `$defs.special`).

   The macros exist for the same two readers. `{"$seg": ["a", 100, 210]}` is
   the queue item every player suite spells `seg("a")`; writing the expansion
   out in every case would make a 300-case family unreadable and would let one
   case's item quietly drift from its neighbours'. The expansions are defined
   HERE and nowhere else on the JS side; the Swift decoder must expand them to
   the same objects, and the `codec` cases in run.test.js pin each one.

   Encoding is only ever applied to what the JS reference RETURNED (an `expect`),
   and decoding only to what a case SUPPLIES (`args`, `setup`, step payloads).
   Macros are therefore legal in inputs only: an `expect` that contained `$seg`
   would be asserting on the macro, not on the rule. */

import fs from "node:fs";
import path from "node:path";

/** The tagged encodings of values JSON cannot carry. Closed. */
export const SPECIAL_NUMBERS = Object.freeze(["NaN", "Infinity", "-Infinity", "-0"]);

/** The input macros. Closed; the schema's `$defs.macro` names the same four. */
export const MACROS = Object.freeze(["$seg", "$ep", "$tts", "$foray"]);

/** A harness error: the CASE is malformed, as opposed to the rule under test
    throwing. The codes are the schema's `$defs.harnessError` enum, so a Swift
    runner reports the same code for the same broken fixture. */
export class HarnessError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "HarnessError";
    this.code = code;
  }
}

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Turn a JS value the reference produced into fixture JSON.
 * Throws E_UNENCODABLE for anything a Swift reader could not rebuild — a
 * function, a symbol, a bigint, a class instance with behaviour — rather than
 * letting JSON.stringify drop it and record a fixture that asserts on nothing.
 */
export function encode(value, at = "$") {
  if (value === undefined) return { $undefined: true };
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (Number.isNaN(value)) return { $num: "NaN" };
    if (value === Infinity) return { $num: "Infinity" };
    if (value === -Infinity) return { $num: "-Infinity" };
    if (Object.is(value, -0)) return { $num: "-0" };
    return value;
  }
  if (Array.isArray(value)) return value.map((v, i) => encode(v, `${at}[${i}]`));
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new HarnessError("E_UNENCODABLE", `${at} is a ${value.constructor?.name ?? "non-plain object"}; a fixture can only hold plain data`);
    }
    const out = {};
    // Sorted, so a fixture's bytes do not depend on the order a module happened
    // to build its object in — the manifest hashes those bytes.
    for (const k of Object.keys(value).sort()) {
      // An own property holding undefined is dropped, like JSON.stringify does:
      // Swift's decoder cannot tell "absent" from "undefined", so neither may we.
      if (value[k] === undefined) continue;
      out[k] = encode(value[k], `${at}.${k}`);
    }
    return out;
  }
  throw new HarnessError("E_UNENCODABLE", `${at} is a ${typeof value}`);
}

/** The inverse of `encode` for the special tags only. Used on expects before a
    JS-side assertion that wants real values, and on inputs via `expandInputs`. */
export function decodeSpecial(value) {
  if (Array.isArray(value)) return value.map(decodeSpecial);
  if (!isPlainObject(value)) return value;
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === "$num") {
    const tag = value.$num;
    if (!SPECIAL_NUMBERS.includes(tag)) throw new HarnessError("E_BAD_SPECIAL", `unknown $num tag ${JSON.stringify(tag)}`);
    return { NaN: NaN, Infinity: Infinity, "-Infinity": -Infinity, "-0": -0 }[tag];
  }
  if (keys.length === 1 && keys[0] === "$undefined") return undefined;
  const out = {};
  for (const k of keys) out[k] = decodeSpecial(value[k]);
  return out;
}

/* ---------- the macros ---------- */

/** Committed Forays, read once per root. `$foray: "<id>"` is how NE-29j runs
    a rule over every Foray that actually ships, not over a hand-made one. */
const forayCache = new Map();
function committedForay(root, id) {
  if (!forayCache.has(root)) {
    const file = path.join(root, "data", "forays.json");
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    forayCache.set(root, new Map((doc.forays ?? []).map((f) => [f.id, f])));
  }
  const foray = forayCache.get(root).get(id);
  if (!foray) throw new HarnessError("E_BAD_MACRO", `$foray names ${JSON.stringify(id)}, which is not in data/forays.json`);
  // A structured clone, so one case mutating its Foray cannot leak into the next.
  return structuredClone(foray);
}

function expandMacro(name, arg, ctx) {
  const tuple = (min, max) => {
    if (!Array.isArray(arg) || arg.length < min || arg.length > max) {
      throw new HarnessError("E_BAD_MACRO", `${name} takes an array of ${min}-${max} elements, got ${JSON.stringify(arg)}`);
    }
    return arg;
  };
  const extra = (v) => {
    if (v === undefined) return {};
    if (!isPlainObject(v)) throw new HarnessError("E_BAD_MACRO", `${name}'s last element must be an object of extra fields`);
    return expandInputs(v, ctx);
  };
  switch (name) {
    // The shape every player suite calls seg(): a real forward slice of a source.
    // Defaults match seam-gap.test.js's `seg(id, 100, 210)`.
    case "$seg": {
      const [id, start = 100, end = 210, more] = tuple(1, 4);
      return { id, kind: "episode", start_sec: decodeSpecial(start), end_sec: decodeSpecial(end), ...extra(more) };
    }
    // An ordinary, unbounded episode.
    case "$ep": {
      const [id, more] = tuple(1, 2);
      return { id, kind: "episode", ...extra(more) };
    }
    // A narration item.
    case "$tts": {
      const [id, more] = tuple(1, 2);
      return { id, kind: "tts", ...extra(more) };
    }
    // A committed Foray by id, or a literal one `{id, title, items}`.
    case "$foray": {
      if (typeof arg === "string") return committedForay(ctx.root, arg);
      if (isPlainObject(arg) && typeof arg.id === "string" && Array.isArray(arg.items)) {
        return { title: "", ...expandInputs(arg, ctx) };
      }
      throw new HarnessError("E_BAD_MACRO", `$foray takes a committed Foray id or {id, title?, items[]}`);
    }
    default:
      throw new HarnessError("E_BAD_MACRO", `unknown macro ${name}`);
  }
}

/**
 * Expand macros and special tags in a case's inputs, producing live JS values.
 * @param {*} value  fixture JSON
 * @param {object} ctx  `{ root }` — the repo root, for `$foray` lookups
 */
export function expandInputs(value, ctx = {}) {
  if (Array.isArray(value)) return value.map((v) => expandInputs(v, ctx));
  if (!isPlainObject(value)) return value;
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0].startsWith("$")) {
    const k = keys[0];
    if (k === "$num" || k === "$undefined") return decodeSpecial(value);
    if (MACROS.includes(k)) return expandMacro(k, value[k], ctx);
    throw new HarnessError("E_BAD_MACRO", `unknown tag ${k}`);
  }
  const out = {};
  for (const k of keys) {
    if (k.startsWith("$")) throw new HarnessError("E_BAD_MACRO", `a tag (${k}) must be the only key of its object`);
    out[k] = expandInputs(value[k], ctx);
  }
  return out;
}

/** True when `value` (fixture JSON) uses a macro anywhere. Expects may not. */
export function containsMacro(value) {
  if (Array.isArray(value)) return value.some(containsMacro);
  if (!isPlainObject(value)) return false;
  for (const k of Object.keys(value)) {
    if (MACROS.includes(k)) return true;
    if (containsMacro(value[k])) return true;
  }
  return false;
}
