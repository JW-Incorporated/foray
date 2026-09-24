/* The coverage guard's logic (NE-03, plan §6.5-6.6). coverage.test.js asserts
   on what this returns; `tools/parity/record.mjs` uses it to print counts and
   to classify.

   THE RULE. Every top-level test() in the fifteen covered suites is accounted
   for in exactly one of four ways:

     - a fixture case lists it in `covers[]`, or xctest.json maps it to a named
       XCTest method (the two may combine: a rule can have a fixture AND a
       Simulator test) — it is PORTED;
     - exclusions.json names it with a closed reason — it has no Swift meaning;
     - unported.json names it with the card that will port it — it is owed.

   A test in none of them is a rule the Swift engine could silently drop, which
   is the whole failure this deck exists to prevent (plan §8 R6). A test in two
   incompatible places (owed AND ported, excluded AND ported) is a stale list,
   and a stale burn-down list is how a count lies.

   The fifteen suites are the ones holding rules AVDeck, DeckPair,
   SpeechNarrator and the facades reimplement (plan §6.5). Three do not exist
   yet; each is named with the card that creates it, and the guard goes red if
   one appears on disk while its entry still says "awaiting" — a new suite is
   never silently outside the guard, and never silently inside it either.

   Suites are named by STEM throughout (`seam-gap`, not the file path), because
   the stem is what `covers[]` entries carry. */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { loadFixtures, readJson, PARITY_DIR } from "./runner.js";

/** The covered suites: stem -> the card that ports its not-yet-fixtured tests
    (the default tag `record.mjs --classify` gives a new test) and the family
    those tests are provisionally charged to. The family is CONSERVATIVE on
    purpose: every queue-manager test counts against `manager-episode` until
    NE-14j moves the Foray ones to `manager-foray`, so the episode capability
    cannot ship while any manager rule is unclassified. */
export const COVERED_SUITES = Object.freeze({
  "queue-state": { card: "NE-07j", family: "queue-state" },
  "seam-gap": { card: "NE-28j", family: "seam-gap" },
  "interlude": { card: "NE-28j", family: "interlude" },
  "seek-policy": { card: "NE-28j", family: "seek-policy" },
  "playback-rate": { card: "NE-07j", family: "rate" },
  "foray-progress": { card: "NE-29j", family: "foray-progress" },
  "media-session": { card: "NE-12j", family: "media-episode" },
  /* Written by NE-08, fixture-first: every test reads its cases, so nothing is
     unported today. A test added later without a case is owed to the Swift
     port that burns these families down. */
  "transport-policy": { card: "NE-09", family: "transport" },
  "position-store": { card: "NE-09", family: "resume-rules" },
  "continuation": { card: "NE-13", family: "continuation", awaiting: "NE-13" },
  "queue-manager": { card: "NE-14j", family: "manager-episode" },
  "html-audio-backend": { card: "NE-14j", family: "deck-episode" },
  "tts-bridge": { card: "NE-31j", family: "speech-rate" },
  "foray-playback": { card: "NE-30j", family: "manager-foray" },
  "transport-reconcile": { card: "NE-21", family: "manager-episode" },
});

/** The closed exclusion reasons (plan §6.1). */
export const EXCLUSION_REASONS = Object.freeze(["webview-only", "dom-only", "text-pin", "js-module-shape"]);

/** A card id as the deck spells them: NE-03, NE-07j, NE-14s, NE-16g, NE-26r. */
export const CARD_RE = /^NE-\d{2}[a-z]?$/;

export const suiteFile = (stem) => `player/${stem}.test.js`;

/* ---------- reading test names ---------- */

/** Decode one JS string literal starting at `src[i]` (a quote). Returns
    `{value, end}` or null. Template literals with `${` are refused: a test
    whose name is computed has no stable name to map. */
function readStringLiteral(src, i) {
  const q = src[i];
  if (q !== '"' && q !== "'" && q !== "`") return null;
  let out = "";
  for (let j = i + 1; j < src.length; j++) {
    const ch = src[j];
    if (ch === q) return { value: out, end: j + 1 };
    if (q === "`" && ch === "$" && src[j + 1] === "{") return null;
    if (ch === "\n" && q !== "`") return null;
    if (ch !== "\\") { out += ch; continue; }
    const nx = src[++j];
    const simple = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", 0: "\0" };
    if (nx in simple) out += simple[nx];
    else if (nx === "u" && src[j + 1] === "{") {
      const close = src.indexOf("}", j);
      out += String.fromCodePoint(parseInt(src.slice(j + 2, close), 16));
      j = close;
    } else if (nx === "u") { out += String.fromCharCode(parseInt(src.slice(j + 1, j + 5), 16)); j += 4; }
    else if (nx === "x") { out += String.fromCharCode(parseInt(src.slice(j + 1, j + 3), 16)); j += 2; }
    else if (nx === "\n") { /* line continuation */ }
    else out += nx;
  }
  return null;
}

/**
 * The top-level test() names of a suite's source, in order. "Top level" is a
 * `test(` at column 0 — the shape every covered suite uses (verified: all 12
 * existing suites, 0 indented). An unnamed or computed-name test is returned
 * in `problems`, because the guard cannot map what it cannot name.
 */
export function topLevelTests(src) {
  const names = [];
  const problems = [];
  const re = /^test\(\s*/gm;
  let m;
  while ((m = re.exec(src))) {
    const line = src.slice(0, m.index).split("\n").length;
    const lit = readStringLiteral(src, m.index + m[0].length);
    if (!lit) problems.push(`line ${line}: test() without a literal name`);
    else names.push(lit.value);
  }
  const dup = names.filter((n, i) => names.indexOf(n) !== i);
  for (const d of new Set(dup)) problems.push(`duplicate test name ${JSON.stringify(d)}`);
  return { names, problems };
}

/** { stem: {exists, names[], problems[]} } for every covered suite. */
export function readCoveredSuites(root, suites = COVERED_SUITES) {
  const out = {};
  for (const stem of Object.keys(suites)) {
    const file = path.join(root, suiteFile(stem));
    if (!fs.existsSync(file)) { out[stem] = { exists: false, names: [], problems: [] }; continue; }
    const { names, problems } = topLevelTests(fs.readFileSync(file, "utf8"));
    out[stem] = { exists: true, names, problems };
  }
  return out;
}

/* ---------- the Swift side of an xctest: mapping ---------- */

/** Every `*.swift` under a `Tests` directory in mobile/plugins — the shipping
    plugins and foray-engine-core. ios/ is the frozen scaffold (NE-02) and is
    deliberately not a place a mapping may point. */
export function swiftTestFiles(root) {
  const base = path.join(root, "mobile", "plugins");
  const out = [];
  const walk = (dir, inTests) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, inTests || e.name === "Tests");
      else if (inTests && e.name.endsWith(".swift")) out.push(p);
    }
  };
  walk(base, false);
  return out.sort();
}

/** Set of "Class/method" for every `func test…()` declared in an XCTestCase
    subclass (or an extension of one) in the given sources. */
export function swiftTestMethods(files) {
  const found = new Set();
  for (const f of files) {
    let current = null;
    for (const line of fs.readFileSync(f, "utf8").split("\n")) {
      const cls = line.match(/^\s*(?:(?:final|public|open|internal|private|fileprivate|@MainActor)\s+)*(?:class|extension)\s+([A-Za-z_][A-Za-z0-9_]*)/);
      if (cls) current = cls[1];
      const fn = line.match(/^\s*(?:(?:@MainActor|override|public|internal|private|fileprivate|final)\s+)*func\s+(test[A-Za-z0-9_]*)\s*\(/);
      if (fn && current) found.add(`${current}/${fn[1]}`);
    }
  }
  return found;
}

/** Every xctest.json mapping whose `Class/method` is not declared in the Swift
    test sources. A mapping is a promise that a named XCTest carries a rule;
    renaming or deleting that XCTest must break the promise loudly. */
export function xctestProblems(root, xctest, methods = swiftTestMethods(swiftTestFiles(root))) {
  const problems = [];
  for (const [stem, names] of Object.entries(xctest)) {
    if (stem.startsWith("//")) continue;
    for (const [name, v] of Object.entries(names)) {
      const target = typeof v === "string" ? v.replace(/^xctest:/, "") : "";
      if (!methods.has(target)) {
        problems.push(`xctest.json ${stem}::${JSON.stringify(name)} maps to ${JSON.stringify(v)}, which no Swift test source under mobile/plugins declares`);
      }
    }
  }
  return problems;
}

/* ---------- the parity data files ---------- */

export function loadParityData(root) {
  const rd = (f) => readJson(root, `${PARITY_DIR}/${f}`);
  return {
    manifest: rd("manifest.json"),
    exclusions: rd("exclusions.json"),
    unported: rd("unported.json"),
    pending: rd("swift-pending.json"),
    capabilities: rd("capabilities.json"),
    floors: rd("floors.json"),
    xctest: rd("xctest.json"),
  };
}

export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** The manifest the tree on disk implies: per family, each file's sha256 and
    the ordered case ids. `record.mjs` writes this; coverage.test.js compares. */
export function computeManifest(root, fixtures = loadFixtures(root)) {
  const families = {};
  for (const { family, file, doc } of fixtures) {
    const f = (families[family] ??= { files: {}, ids: [] });
    f.files[file] = sha256(fs.readFileSync(path.join(root, file)));
    for (const c of doc.cases) f.ids.push(c.id);
  }
  return { version: 1, families };
}

/* ---------- classification ---------- */

/**
 * Classify every top-level test of every covered suite.
 * @returns {{status: object, problems: string[]}}
 *   status[stem][name] = {covered: [caseIds], xctest?, excluded?, unported?}
 */
export function classify(root, data = loadParityData(root), fixtures = loadFixtures(root), suites = readCoveredSuites(root)) {
  const problems = [];
  const status = {};
  const known = (stem, name) => suites[stem]?.exists && suites[stem].names.includes(name);

  for (const [stem, s] of Object.entries(suites)) {
    status[stem] = {};
    const cfg = COVERED_SUITES[stem];
    if (!s.exists) {
      if (!cfg?.awaiting) problems.push(`${suiteFile(stem)} is a covered suite and is missing`);
      continue;
    }
    if (cfg?.awaiting) {
      problems.push(`${suiteFile(stem)} now exists but COVERED_SUITES still marks it awaiting ${cfg.awaiting}; drop "awaiting" so the guard reads it`);
    }
    for (const p of s.problems) problems.push(`${suiteFile(stem)}: ${p}`);
    for (const n of s.names) status[stem][n] = { covered: [] };
  }

  const place = (where, key, fn) => {
    const [stem, ...rest] = key.split("::");
    const name = rest.join("::");
    if (!(stem in COVERED_SUITES)) return problems.push(`${where}: "${stem}" is not a covered suite`);
    if (!known(stem, name)) return problems.push(`${where}: ${stem} has no top-level test named ${JSON.stringify(name)}`);
    fn(status[stem][name]);
  };

  for (const { doc } of fixtures) {
    for (const c of doc.cases) for (const cv of c.covers ?? []) place(`case ${c.id} covers`, cv, (st) => st.covered.push(c.id));
  }
  const nested = (obj, label, fn) => {
    for (const [stem, names] of Object.entries(obj)) {
      if (stem.startsWith("//")) continue;
      for (const [name, v] of Object.entries(names)) place(`${label} ${stem}`, `${stem}::${name}`, (st) => fn(st, v, stem, name));
    }
  };
  nested(data.xctest, "xctest.json", (st, v, stem, name) => {
    if (typeof v !== "string" || !/^xctest:[A-Za-z_]\w*\/test\w*$/.test(v)) problems.push(`xctest.json ${stem}::${name}: ${JSON.stringify(v)} is not "xctest:<Class>/<testMethod>"`);
    st.xctest = v;
  });
  nested(data.exclusions, "exclusions.json", (st, v, stem, name) => {
    if (!EXCLUSION_REASONS.includes(v?.reason)) problems.push(`exclusions.json ${stem}::${name}: reason ${JSON.stringify(v?.reason)} is not one of ${EXCLUSION_REASONS.join(", ")}`);
    if (typeof v?.why !== "string" || v.why.length < 10) problems.push(`exclusions.json ${stem}::${name}: an exclusion says why, in words`);
    st.excluded = v;
  });
  nested(data.unported, "unported.json", (st, v, stem, name) => {
    if (!CARD_RE.test(v?.card ?? "")) problems.push(`unported.json ${stem}::${name}: card ${JSON.stringify(v?.card)} is not a card id`);
    if (typeof v?.family !== "string") problems.push(`unported.json ${stem}::${name}: needs the family it will be recorded into`);
    st.unported = v;
  });

  for (const [stem, names] of Object.entries(status)) {
    for (const [name, st] of Object.entries(names)) {
      const ported = st.covered.length > 0 || Boolean(st.xctest);
      const ways = [ported, Boolean(st.excluded), Boolean(st.unported)].filter(Boolean).length;
      const label = `${suiteFile(stem)} :: ${JSON.stringify(name)}`;
      if (ways === 0) problems.push(`${label} is in no case's covers[], no xctest mapping, exclusions.json or unported.json`);
      else if (ways > 1) {
        const where = [ported && "ported", st.excluded && "excluded", st.unported && "unported"].filter(Boolean).join(" + ");
        problems.push(`${label} is ${where}; a test is accounted for exactly one way (burn down the stale entry)`);
      }
    }
  }
  return { status, problems };
}

/** Every family named anywhere must be charged to some capability, or it
    could hold pending cases no gate ever reads. */
export function capabilityFamilies(capabilities) {
  const all = new Set();
  for (const [cap, fams] of Object.entries(capabilities)) {
    if (cap.startsWith("//")) continue;
    for (const f of fams) all.add(f);
  }
  return all;
}

/* ---------- the capability gate ---------- */

/** Capabilities advertised by the shipping configuration: `mobile/ENGINE_DEFAULT.json`
    (absent until NE-27 creates it = none) and the Swift source's
    `advertisedCapabilities` array literal (absent until NE-20 = none). */
export function advertisedCapabilities(root) {
  const out = new Map();
  const def = path.join(root, "mobile", "ENGINE_DEFAULT.json");
  if (fs.existsSync(def)) {
    const doc = JSON.parse(fs.readFileSync(def, "utf8"));
    for (const c of doc.capabilities ?? []) out.set(c, "mobile/ENGINE_DEFAULT.json");
  }
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".") || e.name === "Tests") continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".swift")) {
        const src = fs.readFileSync(p, "utf8");
        const m = src.match(/advertisedCapabilities\s*(?::\s*\[String\])?\s*=\s*\[([^\]]*)\]/);
        if (m) for (const s of m[1].matchAll(/"([^"]+)"/g)) out.set(s[1], path.relative(root, p).split(path.sep).join("/"));
      }
    }
  };
  walk(path.join(root, "mobile", "plugins"));
  return out;
}

/**
 * Problems with advertising `advertised` (Map name -> where): an unknown
 * capability, or one whose families still have pending or unported entries.
 */
export function capabilityGate(advertised, data) {
  const problems = [];
  const famOfPending = (id) => id.split("/")[0];
  for (const [cap, where] of advertised) {
    const fams = data.capabilities[cap];
    if (!Array.isArray(fams)) { problems.push(`${where} advertises "${cap}", which capabilities.json does not define`); continue; }
    const pending = Object.keys(data.pending).filter((id) => !id.startsWith("//") && fams.includes(famOfPending(id)));
    const unported = [];
    for (const [stem, names] of Object.entries(data.unported)) {
      if (stem.startsWith("//")) continue;
      for (const [name, v] of Object.entries(names)) if (fams.includes(v?.family)) unported.push(`${stem}::${name}`);
    }
    if (pending.length) problems.push(`${where} advertises "${cap}" with ${pending.length} swift-pending case(s) in its families, e.g. ${pending.slice(0, 3).join(", ")}`);
    if (unported.length) problems.push(`${where} advertises "${cap}" with ${unported.length} unported test(s) in its families, e.g. ${unported.slice(0, 2).join(" | ")}`);
  }
  return problems;
}

/** Per-suite and per-family counts, for the recorder's report and floors.json. */
export function counts(status, fixtures) {
  const suites = {};
  for (const [stem, names] of Object.entries(status)) {
    const c = { tests: 0, fixtured: 0, xctest: 0, excluded: 0, unported: 0 };
    for (const st of Object.values(names)) {
      c.tests++;
      if (st.covered.length) c.fixtured++;
      if (st.xctest) c.xctest++;
      if (st.excluded) c.excluded++;
      if (st.unported) c.unported++;
    }
    suites[stem] = c;
  }
  const families = {};
  for (const { family, doc } of fixtures) families[family] = (families[family] ?? 0) + doc.cases.length;
  return { suites, families };
}
