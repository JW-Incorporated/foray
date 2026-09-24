#!/usr/bin/env node
/* Generate the Swift engine's constants and closed vocabularies FROM the JS
   reference (docs/native-engine-plan.md §6.7, card NE-04).

   USAGE
     node tools/parity/gen-constants.mjs --write   regenerate the three files below
     node tools/parity/gen-constants.mjs --check   exit 1 if any of them is stale

   WHAT IT WRITES
     foray-engine-core/Sources/ForayEngineCore/EngineConstants.swift
         Every exported constant of the SOURCES modules, as
         `EngineConstants.<Namespace>.<lowerCamelName>`.
     foray-engine-core/Sources/ForayEngineCore/Diag/Vocabulary.swift
         One String-backed enum per closed set in player/engine-vocabulary.js.
     player/parity/vocabulary.json
         The same sets as data, for the Swift parity runner and node tools.

   WHY GENERATED. A number like the 2.0 s seam beat is a RULE, and the failure
   this deck exists to prevent is the Swift engine quietly holding a different
   one (plan §8 R6). Retyping 60-odd numbers and strings into Swift is exactly
   how that happens, and a parity case only catches the ones some case happens
   to exercise. So Swift never types them: it reads this file, and
   gen-constants.test.mjs (in npm test) is red the moment a JS export changes
   without a regenerate.

   WHY NAMESPACED BY SOURCE MODULE. The JS modules reuse names for different
   rules: DRIFT_TOLERANCE_SEC is 30 in seek-policy.js (an ad-shifted episode's
   drift) and 1 in foray-progress.js (a clip's resume anchor); MIN_RESUME_SEC,
   NEAR_END_SEC and MAX_AGE_H are each exported twice with different values.
   A flat file would have to pick one, or rename one by hand, and either is a
   silent fork of the rule. Every namespace is one module, and a qualified name
   produced twice is a hard error (DuplicateConstantError).

   WHY INSIDE `enum EngineConstants` AND NOT TOP-LEVEL `enum SeekPolicy`. The
   policy PORTS are types with those names (NE-05's `SeamGap`, NE-09's
   `PlaybackRate`, NE-28s's `SeekPolicy`, ...). A generated top-level
   `enum SeamGap` would collide with the port the day both merge; nested, the
   two never meet, and the port reads `EngineConstants.SeamGap.seamGapSec`.

   WHY EVERY NUMBER IS A Double. JavaScript has one number type, IEEE 754
   double, and Double is its exact Swift equivalent. Choosing Int from the
   value would make `SEAM_GAP_SEC = 2.0` an Int (the JS source's `.0` is not in
   the value), and choosing it from the name is a heuristic that guesses wrong
   eventually. A port that needs an Int converts at its one use site, visibly.

   WHAT IS NOT A CONSTANT. Functions and classes are skipped: they are behaviour,
   ported by hand and pinned by fixtures. Anything else the generator cannot
   express (an object of functions, a Symbol, a Set, a mixed array, NaN) is an
   ERROR unless the source lists it under `omit` with its reason — a new export
   is never silently left out of the Swift side. */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stableJson } from "./record.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..");

const CORE = "mobile/plugins/foray-audio/foray-engine-core/Sources/ForayEngineCore";
export const CONSTANTS_FILE = `${CORE}/EngineConstants.swift`;
export const VOCABULARY_SWIFT_FILE = `${CORE}/Diag/Vocabulary.swift`;
export const VOCABULARY_JSON_FILE = "player/parity/vocabulary.json";
export const VOCABULARY_MODULE = "player/engine-vocabulary.js";

/** The modules whose exports the engine reimplements, and the namespace each
    one's constants live under. One namespace per module. A module joins this
    list when a Swift card first needs one of its numbers; adding it here and
    regenerating is the whole change. `omit` names an export that is not a
    constant the engine can use, with the reason, so the omission is reviewed
    rather than silent. */
export const SOURCES = Object.freeze([
  { module: "player/default-voice.js", namespace: "DefaultVoice" },
  { module: "player/engine-contract.js", namespace: "EngineContract" },
  { module: "player/episode-progress.js", namespace: "EpisodeProgress" },
  { module: "player/foray-progress.js", namespace: "ForayProgress" },
  { module: "player/foray-queue.js", namespace: "ForayQueue" },
  { module: "player/html-audio-backend.js", namespace: "HtmlAudioBackend" },
  { module: "player/interlude.js", namespace: "Interlude" },
  { module: "player/media-session.js", namespace: "MediaSession" },
  { module: "player/playback-rate.js", namespace: "PlaybackRate" },
  { module: "player/position-store.js", namespace: "PositionStore" },
  { module: "player/queue-manager.js", namespace: "QueueManager" },
  {
    module: "player/queue-state.js",
    namespace: "QueueState",
    omit: {
      S: "the reducer's state constructors (functions), ported as PlayerQueueState.swift and pinned by the queue-state family",
      E: "the reducer's event constructors (functions), ported as PlayerEvent and pinned by the queue-state family",
      F: "the reducer's effect constructors (functions), ported as PlayerEffect and pinned by the queue-state family",
    },
  },
  { module: "player/seam-gap.js", namespace: "SeamGap" },
  { module: "player/seek-policy.js", namespace: "SeekPolicy" },
  // The card's own spelling (plan §14 NE-04): `Transport.restartWindowSec`.
  // Not `TransportPolicy`, which is NE-09's port type of the same module.
  { module: "player/transport-policy.js", namespace: "Transport" },
]);

export class DuplicateConstantError extends Error {
  constructor(message) { super(message); this.name = "DuplicateConstantError"; }
}
export class UnsupportedConstantError extends Error {
  constructor(message) { super(message); this.name = "UnsupportedConstantError"; }
}

/* ---------- names ---------- */

/** Swift's reserved words that a generated identifier could land on. A member
    or case spelled as one is emitted in backticks (`default`). */
const SWIFT_KEYWORDS = new Set([
  "associatedtype", "class", "deinit", "enum", "extension", "fileprivate", "func", "import", "init",
  "inout", "internal", "let", "open", "operator", "private", "precedencegroup", "protocol", "public",
  "rethrows", "static", "struct", "subscript", "typealias", "var", "break", "case", "catch",
  "continue", "default", "defer", "do", "else", "fallthrough", "for", "guard", "if", "in", "repeat",
  "return", "throw", "switch", "where", "while", "as", "Any", "false", "is", "nil", "super", "throws",
  "true", "try", "await", "async",
  // Contextual keywords. Most parse as identifiers in most positions, but
  // "most" is a compiler this machine cannot run; a backtick is always legal,
  // so any of these is escaped rather than trusted (a token like `override`
  // is a real mode reason).
  "any", "some", "override", "mutating", "nonmutating", "optional", "required", "convenience",
  "dynamic", "final", "lazy", "weak", "unowned", "indirect", "prefix", "postfix", "infix",
  "get", "set", "willSet", "didSet", "actor", "isolated", "nonisolated", "consume", "borrowing",
  "consuming", "package",
]);
/** Words that stay illegal as identifiers even in backticks. */
const SWIFT_UNESCAPABLE = new Set(["self", "Self", "Type", "Protocol", "_"]);

const escapeIdentifier = (id) => {
  if (SWIFT_UNESCAPABLE.has(id)) throw new UnsupportedConstantError(`"${id}" cannot be a Swift identifier`);
  return SWIFT_KEYWORDS.has(id) ? `\`${id}\`` : id;
};

/** SCREAMING_SNAKE -> lowerCamel: SEAM_GAP_SEC -> seamGapSec. */
export function memberName(jsName) {
  if (!/^[A-Z][A-Z0-9_]*$/.test(jsName)) {
    throw new UnsupportedConstantError(`export ${jsName} is not SCREAMING_SNAKE_CASE; the generator only names constants spelled that way`);
  }
  const words = jsName.toLowerCase().split("_").filter(Boolean);
  return words[0] + words.slice(1).map((w) => w[0].toUpperCase() + w.slice(1)).join("");
}

/** SCREAMING_SNAKE -> UpperCamel, for a nested enum: REMOTE_STOP -> RemoteStop. */
export function typeName(jsName) {
  const m = memberName(jsName);
  return m[0].toUpperCase() + m.slice(1);
}

/** A closed-vocabulary token: lower-case dashed (`grace-expired`), or one
    lowerCamel word as Apple spells an enum case (`appWasSuspended`). */
export const TOKEN_RE = /^[a-z][a-zA-Z0-9]*(-[a-z0-9]+)*$/;

/** Token -> Swift case name: grace-expired -> graceExpired. */
export function caseName(token) {
  if (typeof token !== "string" || !TOKEN_RE.test(token)) {
    throw new UnsupportedConstantError(`vocabulary token ${JSON.stringify(token)} is not a lower-case dashed token or an Apple lowerCamel case name`);
  }
  return token.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
}

/* ---------- values ---------- */

/** A JS string as a Swift string literal. Not JSON.stringify: JSON's \b, \f
    and \uXXXX are not Swift escapes (Swift has \0 \\ \t \n \r \" \' \u{n}). */
export function swiftString(s) {
  let out = '"';
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (cp < 0x20 || cp === 0x7f) out += `\\u{${cp.toString(16).toUpperCase()}}`;
    else out += ch;
  }
  return out + '"';
}

/** A JS number as a Swift Double literal: the shortest string that round-trips
    (JS's own String(n)), which Swift parses to the same double. */
export function swiftNumber(n, where) {
  if (!Number.isFinite(n)) throw new UnsupportedConstantError(`${where} is ${n}; Swift has no literal for a non-finite constant`);
  if (Object.is(n, -0)) return "-0.0";
  return String(n).replace("e+", "e");
}

/**
 * Classify one exported value.
 * @returns {null | {kind: "scalar", type, literal} | {kind: "enum", members: [{js, name, type, literal}]}}
 *   null for a function (behaviour, not a constant).
 */
export function describeValue(value, where) {
  if (typeof value === "function") return null;
  if (typeof value === "number") return { kind: "scalar", type: "Double", literal: swiftNumber(value, where) };
  if (typeof value === "string") return { kind: "scalar", type: "String", literal: swiftString(value) };
  if (typeof value === "boolean") return { kind: "scalar", type: "Bool", literal: String(value) };
  if (Array.isArray(value)) {
    if (!value.length) throw new UnsupportedConstantError(`${where} is an empty array; its element type is unknowable`);
    if (value.every((v) => typeof v === "number")) {
      return { kind: "scalar", type: "[Double]", literal: `[${value.map((v, i) => swiftNumber(v, `${where}[${i}]`)).join(", ")}]` };
    }
    if (value.every((v) => typeof v === "string")) {
      return { kind: "scalar", type: "[String]", literal: `[${value.map(swiftString).join(", ")}]` };
    }
    throw new UnsupportedConstantError(`${where} is an array that is neither all numbers nor all strings`);
  }
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = Object.entries(value);
    if (!entries.length) throw new UnsupportedConstantError(`${where} is an empty object`);
    const seen = new Map();
    const members = entries.map(([k, v]) => {
      if (typeof v !== "string" && typeof v !== "number") {
        throw new UnsupportedConstantError(`${where}.${k} is a ${typeof v}; an object export must map names to strings or numbers`);
      }
      const d = describeValue(v, `${where}.${k}`);
      const name = memberName(k);
      if (seen.has(name)) throw new DuplicateConstantError(`duplicate export name: ${where}.${seen.get(name)} and .${k} would both be ${name}`);
      seen.set(name, k);
      return { js: k, name, type: d.type, literal: d.literal };
    });
    return { kind: "enum", members };
  }
  const what = value === null ? "null" : value instanceof Set ? "a Set" : typeof value === "symbol" ? "a Symbol" : value instanceof RegExp ? "a RegExp" : typeof value;
  throw new UnsupportedConstantError(`${where} is ${what}, which the generator cannot express`);
}

/* ---------- collecting ---------- */

let importGeneration = 0;
/** Import a module fresh. The query defeats the ESM cache, so a --check after
    an edit in the same process (the tests do this) sees the edited file. */
async function importFresh(root, rel) {
  const url = pathToFileURL(path.join(root, rel)).href;
  return import(`${url}?gen-constants=${++importGeneration}`);
}

/** Import every source module. @returns [{module, namespace, omit, exports}] */
export async function loadSources(root = REPO_ROOT, sources = SOURCES) {
  const out = [];
  for (const s of sources) {
    const mod = await importFresh(root, s.module);
    out.push({ ...s, omit: s.omit ?? {}, exports: { ...mod } });
  }
  return out;
}

/**
 * Turn loaded sources into namespaces. Throws DuplicateConstantError on a
 * namespace used twice or a qualified name produced twice, and
 * UnsupportedConstantError on a value it cannot express or a stale `omit`.
 * @returns [{namespace, module, members: [{js, name, kind, type, literal, members?}]}]
 */
export function collect(loaded) {
  const byNamespace = new Map();
  for (const src of loaded) {
    if (!/^[A-Z][A-Za-z0-9]*$/.test(src.namespace)) {
      throw new UnsupportedConstantError(`namespace "${src.namespace}" (${src.module}) is not an UpperCamel Swift type name`);
    }
    for (const name of Object.keys(src.omit)) {
      if (!(name in src.exports)) throw new UnsupportedConstantError(`${src.module} omits ${name}, which it no longer exports (drop it from omit)`);
    }
    if (!byNamespace.has(src.namespace)) {
      byNamespace.set(src.namespace, { namespace: src.namespace, modules: [], members: [], seen: new Map() });
    }
    const ns = byNamespace.get(src.namespace);
    ns.modules.push(src.module);
    for (const js of Object.keys(src.exports).sort()) {
      if (js === "default") throw new UnsupportedConstantError(`${src.module} has a default export; constants must be named`);
      if (js in src.omit) continue;
      const d = describeValue(src.exports[js], `${src.module}#${js}`);
      if (!d) continue;
      const name = d.kind === "enum" ? typeName(js) : memberName(js);
      // The collision a flat constants file would have had. Checked across
      // every module in the namespace (so two modules mapped to one namespace
      // by mistake are reported by the export they clash on), and within one
      // module (FOO_BAR and FOO__BAR are both fooBar).
      const prior = ns.seen.get(name);
      if (prior) {
        throw new DuplicateConstantError(
          `duplicate export name: ${prior.module}#${prior.js} and ${src.module}#${js} would both be ` +
          `EngineConstants.${src.namespace}.${name}`
        );
      }
      ns.seen.set(name, { module: src.module, js });
      ns.members.push({ js, name, ...d });
    }
  }
  for (const ns of byNamespace.values()) {
    if (ns.modules.length > 1) {
      throw new DuplicateConstantError(
        `namespace ${ns.namespace} is claimed by ${ns.modules.join(" and ")}; constants are namespaced by source ` +
        `module, one namespace each, so a later export cannot collide with one it has never seen`
      );
    }
  }
  return [...byNamespace.values()]
    .map(({ namespace, modules, members }) => ({ namespace, module: modules[0], members }))
    .sort((a, b) => (a.namespace < b.namespace ? -1 : 1));
}

/** Export names that more than one source module uses — the reason for the
    namespaces, listed in the generated header so a reader sees them. */
export function sharedNames(loaded) {
  const where = new Map();
  for (const src of loaded) {
    for (const [js, v] of Object.entries(src.exports)) {
      if (typeof v === "function" || js in src.omit) continue;
      (where.get(js) ?? where.set(js, []).get(js)).push(src.namespace);
    }
  }
  return [...where].filter(([, ns]) => ns.length > 1).sort(([a], [b]) => (a < b ? -1 : 1));
}

/* ---------- rendering ---------- */

const REGENERATE = "node tools/parity/gen-constants.mjs --write";

function header(title, lines) {
  return [
    "// GENERATED FILE - DO NOT EDIT.",
    `// ${title}`,
    `// Regenerate with \`${REGENERATE}\`; tools/parity/gen-constants.test.mjs`,
    "// (in npm test) is red while this file disagrees with the JS it comes from.",
    ...lines.map((l) => (l ? `// ${l}` : "//")),
    "",
  ];
}

export function renderConstants(namespaces, shared = []) {
  const out = header("The engine's constants, from the JS reference (docs/native-engine-plan.md §6.7, NE-04).", [
    "",
    "Namespaced by source module, as EngineConstants.<Module>.<name>, because the",
    "JS modules reuse names for different rules. Exported by more than one module:",
    ...(shared.length ? shared.map(([js, ns]) => `  ${js}: ${ns.map((n) => `${n}`).join(", ")}`) : ["  (none)"]),
    "",
    "Every JS number is a Double (JavaScript has no other number type). Policy",
    "ports are separate types (SeamGap, PlaybackRate, ...) that READ these; they",
    "never redeclare a value here.",
  ]);
  out.push("import Foundation", "", "public enum EngineConstants {");
  namespaces.forEach((ns, i) => {
    if (i) out.push("");
    out.push(`    /// \`${ns.module}\``);
    out.push(`    public enum ${ns.namespace} {`);
    for (const m of ns.members) {
      if (m.kind === "enum") {
        out.push(`        /// \`${m.js}\``);
        out.push(`        public enum ${m.name} {`);
        for (const e of m.members) {
          out.push(`            /// \`${m.js}.${e.js}\``);
          out.push(`            public static let ${escapeIdentifier(e.name)}: ${e.type} = ${e.literal}`);
        }
        out.push("        }");
      } else {
        out.push(`        /// \`${m.js}\``);
        out.push(`        public static let ${escapeIdentifier(m.name)}: ${m.type} = ${m.literal}`);
      }
    }
    out.push("    }");
  });
  out.push("}", "");
  return out.join("\n");
}

/** Validate the vocabulary module's sets and shape them for rendering.
    @returns [{set, type, tokens: [{token, name}]}] */
export function collectVocabulary(mod, where = VOCABULARY_MODULE) {
  const vocab = mod.VOCABULARY;
  if (!vocab || typeof vocab !== "object") throw new UnsupportedConstantError(`${where} exports no VOCABULARY object`);
  const out = [];
  for (const [set, tokens] of Object.entries(vocab)) {
    if (!/^[a-z][a-zA-Z0-9]*$/.test(set)) throw new UnsupportedConstantError(`${where}: set name "${set}" is not lowerCamel`);
    if (!Array.isArray(tokens) || !tokens.length) throw new UnsupportedConstantError(`${where}: set ${set} is not a non-empty array of tokens`);
    const seen = new Map();
    const rows = tokens.map((token) => {
      const name = caseName(token);
      if (seen.has(name)) {
        throw new DuplicateConstantError(`${where}: set ${set} holds ${JSON.stringify(seen.get(name))} and ${JSON.stringify(token)}, which are one Swift case (${name})`);
      }
      seen.set(name, token);
      return { token, name };
    });
    out.push({ set, type: set[0].toUpperCase() + set.slice(1), tokens: rows });
  }
  return out;
}

export function renderVocabularySwift(sets) {
  const out = header("The engine's closed vocabularies, from player/engine-vocabulary.js (NE-04).", [
    "",
    "A diagnostics row admits a token only through these sets; the reasons for",
    "each set, and for keeping them closed, are in the JS module. The data only:",
    "admission itself is ported by hand and pinned by the diag-tokens family.",
  ]);
  out.push("import Foundation", "", "public enum Vocabulary {");
  for (const s of sets) {
    out.push(`    /// \`${s.set}\``);
    out.push(`    public enum ${s.type}: String, CaseIterable, Sendable {`);
    for (const t of s.tokens) out.push(`        case ${escapeIdentifier(t.name)} = ${swiftString(t.token)}`);
    out.push("    }", "");
  }
  out.push("    /// Every set's name, in the JS declaration order.");
  out.push(`    public static let setNames: [String] = [${sets.map((s) => swiftString(s.set)).join(", ")}]`, "");
  out.push("    /// Every set's tokens, by set name, in the JS declaration order.");
  out.push("    public static let sets: [String: [String]] = [");
  for (const s of sets) out.push(`        ${swiftString(s.set)}: ${s.type}.allCases.map(\\.rawValue),`);
  out.push("    ]", "}", "");
  return out.join("\n");
}

export function renderVocabularyJson(sets) {
  return stableJson({
    "//": `GENERATED by tools/parity/gen-constants.mjs from ${VOCABULARY_MODULE} - do not edit; add a token there and run \`${REGENERATE}\`. The closed token sets of the native engine's diagnostics rows (NE-04); the reasons for each set are in the JS module.`,
    sets: Object.fromEntries(sets.map((s) => [s.set, s.tokens.map((t) => t.token)])),
  });
}

/* ---------- the three files ---------- */

/**
 * Render every generated file from the tree at `root`.
 * @returns {Promise<Record<string, string>>}  repo-relative path -> content
 */
export async function generate({ root = REPO_ROOT, sources = SOURCES, vocabularyModule = VOCABULARY_MODULE, transform = null } = {}) {
  let loaded = await loadSources(root, sources);
  // A test hook: rewrite the loaded exports before rendering, to show that a
  // JS change the committed file does not reflect is caught.
  if (transform) loaded = transform(loaded);
  const files = { [CONSTANTS_FILE]: renderConstants(collect(loaded), sharedNames(loaded)) };
  if (vocabularyModule) {
    const sets = collectVocabulary(await importFresh(root, vocabularyModule), vocabularyModule);
    files[VOCABULARY_SWIFT_FILE] = renderVocabularySwift(sets);
    files[VOCABULARY_JSON_FILE] = renderVocabularyJson(sets);
  }
  return files;
}

/** The generated files whose bytes on disk differ from `files`. */
export function staleFiles(root, files) {
  return Object.entries(files)
    .filter(([rel, content]) => {
      const full = path.join(root, rel);
      return !fs.existsSync(full) || fs.readFileSync(full, "utf8") !== content;
    })
    .map(([rel]) => rel);
}

export async function main(argv, { root = REPO_ROOT, log = console.log, err = console.error, ...opts } = {}) {
  const mode = argv[0];
  if (argv.length !== 1 || (mode !== "--write" && mode !== "--check")) {
    err("usage: node tools/parity/gen-constants.mjs --write | --check");
    return 2;
  }
  let files;
  try {
    files = await generate({ root, ...opts });
  } catch (e) {
    err(`gen-constants: ${e.message}`);
    return 1;
  }
  const stale = staleFiles(root, files);
  if (mode === "--check") {
    if (stale.length) {
      err(`gen-constants --check: stale, regenerate with \`${REGENERATE}\`:\n  ${stale.join("\n  ")}`);
      return 1;
    }
    log(`gen-constants --check: ${Object.keys(files).length} file(s) up to date`);
    return 0;
  }
  for (const rel of stale) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), files[rel]);
  }
  log(`gen-constants --write: ${stale.length} file(s) rewritten, ${Object.keys(files).length - stale.length} unchanged`);
  return 0;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = await main(process.argv.slice(2));
}
