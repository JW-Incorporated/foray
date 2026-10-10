#!/usr/bin/env node
/* The parity recorder (NE-03, plan §6.3). JS is the reference; this writes down
   what the reference says, and refuses to write down anything else.

   USAGE
     node tools/parity/record.mjs [--family F] [--jvm-card A-xx]
         Run every case against the real JS module and write each non-authored
         `expect`. Every case that is NEW, or whose expect CHANGED, is reported
         as Swift work THIS change carries. Until NE-39s (M3) such a case went
         into swift-pending.json tagged with a --port-card, and a later Swift PR
         burned it down; NE-39s burned the list to nothing and deleted it (and
         unported.json with it), so nothing can be owed any more: the Swift
         runner (engine-parity) is red on the case until its port lands in the
         same change. --port-card is refused.
         The JVM keeps its own books, jvm-pending.json (A-22; player/parity/
         jvm-pending.js). A family the JVM does not run yet is owed there WHOLE,
         so a case new or changed in it owes the JVM nothing more. A case new or
         changed in a family the JVM DOES run, or a brand-new family, is handed
         to the Android card named by --jvm-card (docs/plans/android-assessment.md
         §5.4-5.5 name the card that ports each family), for the same reason.
         A `jsOnly` fixture family (schema; plan §5.5 C-2, the continuation
         hops the page computes and the engine only walks; NE-39s's
         manager-await) is recorded the same way and is Swift's to run never.
         A `nativeOnly` family (schema; code-health-3 CH3-20's native-episode,
         the episode path at the wheel) is the mirror image: JS has no
         reference for it, so it is never evaluated here, never recorded and
         never owed; every case is authored from the Swift core, engine-parity
         holds it, and the JVM runs it ("runs" in jvm-pending.json). --check
         still holds its files to the schema and the manifest.
         Refuses (writes nothing, exits 1) when:
           - JS disagrees with an `authored: true` case (a spec value, not ours
             to overwrite — change the spec on purpose, by hand, or fix the JS);
           - a case cannot run (harness error);
           - a --port-card is given (retired with swift-pending.json, NE-39s);
           - the JVM would be owed something new and no --jvm-card was given;
           - a family's case count would fall below its floor (--lower-floors).
     node tools/parity/record.mjs --check [--family F] [--json]
         Re-run and compare; change nothing. Red on any recorded or authored
         expect that differs, any unrecorded case, a manifest that no longer
         matches the bytes on disk, or a retired burn-down list
         (swift-pending.json, unported.json) back on disk.
         checkAll() below is what npm test runs (record.test.mjs).
     node tools/parity/record.mjs --mutate [rule ...]
         For each named rule in mutations.json (default: all), flip it in a
         child process's loader and require that BOTH its original JS test and
         its fixture family fail. Exit 1 if any mutant survives.
     node tools/parity/record.mjs --classify
         RETIRED by NE-39s: it parked unaccounted covered-suite tests in
         unported.json, which no longer exists. It now refuses and exits 1; a
         new covered test is fixtured, mapped to an XCTest, or excluded with a
         reason, in the change that adds it.
     node tools/parity/record.mjs --counts
         Print per-suite and per-family counts (the numbers no card types). */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isEntryScript } from "../ci/entry.mjs";
import {
  REPO_ROOT, PARITY_DIR, loadFixtures, validateFixtures, runCase, isNativeOnly,
} from "../../player/parity/runner.js";
import { compare, formatDiffs } from "../../player/parity/compare.js";
import {
  computeManifest, loadParityData, classify, counts, suiteFile, retiredBooksOnDisk,
} from "../../player/parity/coverage.js";
import {
  JVM_CARD_RE, JVM_PENDING_FILE, loadJvmPending, unportedFamilies, checkJvmPending, jvmOwedBy, nextJvmPending,
} from "../../player/parity/jvm-pending.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Stable JSON: two-space indent, LF, trailing newline, and any array or object
    whose one-line form fits in INLINE_MAX characters kept on one line — so a
    case reads as `"args": [{ "from": { "$seg": ["a"] } }]` rather than twenty
    lines of brackets. Every file this writes goes through here, so a re-record
    of an unchanged tree is byte-identical. A pure function of the value: the
    Swift side never writes fixtures, so there is no second formatter to match. */
const INLINE_MAX = 88;
export function stableJson(value) {
  return format(value, "") + "\n";
}
function inline(v) {
  if (Array.isArray(v)) return `[${v.map(inline).join(", ")}]`;
  if (v !== null && typeof v === "object") {
    const parts = Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${inline(x)}`);
    return parts.length ? `{ ${parts.join(", ")} }` : "{}";
  }
  return JSON.stringify(v);
}
function format(v, indent) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  const one = inline(v);
  if (one.length + indent.length <= INLINE_MAX) return one;
  const next = indent + "  ";
  if (Array.isArray(v)) return `[\n${v.map((x) => next + format(x, next)).join(",\n")}\n${indent}]`;
  const body = Object.entries(v).map(([k, x]) => `${next}${JSON.stringify(k)}: ${format(x, next)}`);
  return `{\n${body.join(",\n")}\n${indent}}`;
}

const sortKeys = (obj) => Object.fromEntries(Object.entries(obj).sort(([a], [b]) => {
  // "//" commentary keys stay on top.
  if (a.startsWith("//") !== b.startsWith("//")) return a.startsWith("//") ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}));

/** Canonical key order for a case, so a hand-written case and a recorded one
    look the same on disk. */
const CASE_ORDER = ["id", "covers", "authored", "note", "read", "call", "args", "setup", "steps", "tolerance", "expect"];
function canonicalCase(c) {
  const out = {};
  for (const k of CASE_ORDER) if (k in c) out[k] = c[k];
  for (const k of Object.keys(c)) if (!(k in out)) out[k] = c[k];
  return out;
}

function writeParity(root, file, value) {
  fs.writeFileSync(path.join(root, PARITY_DIR, file), stableJson(value));
}

/** Run every case of the given fixtures. A nativeOnly family (CH3-20) has no
    JS reference to run: validateFixtures holds it to the schema (authored,
    with its expect) and computeManifest to its bytes, and the native runners
    hold it to its expects. */
async function evaluate(root, fixtures) {
  const out = [];
  for (const fx of fixtures) {
    if (isNativeOnly(fx)) continue;
    for (const c of fx.doc.cases) {
      try {
        out.push({ fx, c, actual: await runCase(c, fx, { root }) });
      } catch (err) {
        out.push({ fx, c, error: err });
      }
    }
  }
  return out;
}

/* ---------- --check ---------- */

/**
 * Everything --check checks. Returns `{problems, cases, failed}`; problems is
 * empty when the tree is consistent. `manifest: false` skips the whole-tree
 * manifest and pending checks (the mutation child only wants the cases).
 */
export async function checkAll({ root = REPO_ROOT, family = null, manifest = true } = {}) {
  const all = loadFixtures(root);
  const problems = validateFixtures(all).map((p) => `schema: ${p}`);
  const fixtures = family ? all.filter((f) => f.family === family) : all;
  let failed = 0;
  let cases = 0;
  for (const r of await evaluate(root, fixtures)) {
    cases++;
    if (r.error) { failed++; problems.push(`${r.c.id}: cannot run — ${r.error.message}`); continue; }
    if (!("expect" in r.c)) { failed++; problems.push(`${r.c.id}: unrecorded (run record.mjs)`); continue; }
    const diffs = compare(r.c.expect, r.actual, { family: r.fx.family, tolerance: r.c.tolerance });
    if (diffs.length) {
      failed++;
      problems.push(`${r.c.id}${r.c.authored ? " (AUTHORED)" : ""}: JS no longer matches the fixture\n${formatDiffs(diffs)}`);
    }
  }
  if (manifest) {
    const data = loadParityData(root);
    const want = computeManifest(root, all);
    const have = data.manifest;
    const famNames = new Set([...Object.keys(want.families), ...Object.keys(have.families ?? {})]);
    for (const f of famNames) {
      const w = want.families[f];
      const h = have.families?.[f];
      if (!w) { problems.push(`manifest: family ${f} is listed but has no fixtures on disk`); continue; }
      if (!h) { problems.push(`manifest: family ${f} is on disk but not in manifest.json (record it)`); continue; }
      for (const file of new Set([...Object.keys(w.files), ...Object.keys(h.files ?? {})])) {
        if (w.files[file] !== h.files?.[file]) problems.push(`manifest: ${file} does not match its recorded hash (hand-edited, or not re-recorded)`);
      }
      if (JSON.stringify(w.ids) !== JSON.stringify(h.ids)) problems.push(`manifest: family ${f}'s case ids differ from the fixtures on disk`);
    }
    // NE-39s: the Swift books are retired. A list that comes back would owe
    // again, and nothing reads it: the Swift loader refuses to run on it.
    for (const f of retiredBooksOnDisk(root)) {
      problems.push(`${f} is back on disk: NE-39s retired it (nothing may be owed; a JS rule change carries its Swift port). Delete it`);
    }
    // The JVM's books (A-22): every entry names a recorded case or family, none
    // is jsOnly, and every tag is an A- card.
    let jvm = null;
    try { jvm = loadJvmPending(root); } catch (e) { problems.push(`jvm-pending: cannot read ${JVM_PENDING_FILE}: ${e.message}`); }
    if (jvm) {
      const familyOf = new Map();
      for (const [f, entry] of Object.entries(want.families)) for (const id of entry.ids) familyOf.set(id, f);
      const byFam = {};
      for (const fx of all) (byFam[fx.family] ??= []).push(fx.doc.jsOnly === true);
      const jsOnlyFamilies = new Set(Object.entries(byFam).filter(([, v]) => v.every(Boolean)).map(([f]) => f));
      problems.push(...checkJvmPending(jvm, {
        familyOf, families: new Set(Object.keys(want.families)), jsOnlyFamilies, unported: unportedFamilies(data.unported),
      }));
    }
  }
  return { problems, cases, failed };
}

/* ---------- record ---------- */

/**
 * Record. Returns `{ok, refusals, written, swiftAffected}`; writes only when
 * ok. `swiftAffected`: the ids new or changed in families Swift runs, which
 * the engine-parity job now holds this change to (NE-39s: nothing is owed).
 */
export async function record({ root = REPO_ROOT, family = null, portCard = null, jvmCard = null, lowerFloors = false, log = console.log } = {}) {
  const all = loadFixtures(root);
  const refusals = validateFixtures(all).map((p) => `schema: ${p}`);
  const fixtures = family ? all.filter((f) => f.family === family) : all;
  if (family && !fixtures.length) refusals.push(`no fixtures for family "${family}"`);
  if (portCard != null) {
    refusals.push(`--port-card ${JSON.stringify(portCard)} was retired with swift-pending.json by NE-39s (M3): nothing may be owed, so the Swift port lands in this change and engine-parity checks it`);
  }
  if (jvmCard != null && !JVM_CARD_RE.test(jvmCard)) refusals.push(`--jvm-card ${JSON.stringify(jvmCard)} is not an Android card id (A-23, A-40, ...)`);

  const data = loadParityData(root);
  const knownIds = new Set(Object.values(data.manifest.families ?? {}).flatMap((f) => f.ids ?? []));
  const affected = [];
  const affectedFamily = new Map();
  const jsOnlyAffected = [];
  const dirty = new Set();

  if (!refusals.length) {
    for (const r of await evaluate(root, fixtures)) {
      if (r.error) { refusals.push(`${r.c.id}: cannot run — ${r.error.message}`); continue; }
      if (r.c.authored) {
        const diffs = compare(r.c.expect, r.actual, { family: r.fx.family, tolerance: r.c.tolerance });
        if (diffs.length) {
          refusals.push(
            `${r.c.id} is AUTHORED and the JS now disagrees with it. record.mjs never overwrites an authored case: ` +
            `either the JS change is wrong, or the spec changed and a person edits the case on purpose.\n${formatDiffs(diffs)}`
          );
        }
        if (!knownIds.has(r.c.id)) (r.fx.doc.jsOnly ? jsOnlyAffected : affected).push(r.c.id);
        affectedFamily.set(r.c.id, r.fx.family);
        continue;
      }
      const had = "expect" in r.c;
      const same = had && !compare(r.c.expect, r.actual, { family: r.fx.family, tolerance: r.c.tolerance }).length;
      if (same && knownIds.has(r.c.id)) continue;
      if (!same) { r.c.expect = r.actual; dirty.add(r.fx); }
      /* A JS-only family (schema `jsOnly`, plan §5.5 C-2) has no Swift card to
         hand its ids to: they are recorded, and owed to nobody. */
      (r.fx.doc.jsOnly ? jsOnlyAffected : affected).push(r.c.id);
      affectedFamily.set(r.c.id, r.fx.family);
    }
  }
  const evaluationRefused = refusals.length > 0;

  /* The JVM's books (A-22). A family the JVM does not run is owed there whole, so
     only a case new or changed in a family it DOES run, or a new family, needs a
     card; any other record run passes no --jvm-card and changes nothing there. */
  let jvm = null;
  let jvmOwed = { families: [], cases: [] };
  try { jvm = loadJvmPending(root); } catch (e) { refusals.push(`cannot read ${JVM_PENDING_FILE}: ${e.message}`); }
  if (jvm) {
    refusals.push(...jvm.problems);
    jvmOwed = jvmOwedBy(jvm, affected.map((id) => ({ id, family: affectedFamily.get(id) })));
    const n = jvmOwed.families.length + jvmOwed.cases.length;
    if (n && !jvmCard && !evaluationRefused) {
      refusals.push(
        `the JVM runner (A-22) would be owed ${n} new thing(s) and must be handed to an Android card: pass --jvm-card <A-xx> ` +
        `(docs/plans/android-assessment.md §5.4-5.5 name the card that ports each family).\n  ` +
        [...jvmOwed.families.map((f) => `family ${f} (new)`), ...jvmOwed.cases].slice(0, 10).join("\n  ")
      );
    }
  }

  // Floors: raise-only unless --lower-floors says, in the command, that a
  // family really lost cases.
  const byFamily = {};
  for (const fx of all) byFamily[fx.family] = (byFamily[fx.family] ?? 0) + fx.doc.cases.length;
  const floors = structuredClone(data.floors);
  floors.families ??= {};
  for (const [fam, n] of Object.entries(byFamily)) {
    const old = floors.families[fam] ?? 0;
    if (n < old && !lowerFloors) refusals.push(`family ${fam} has ${n} cases, below its floor of ${old} (pass --lower-floors and say why in the PR)`);
    floors.families[fam] = lowerFloors ? n : Math.max(old, n);
  }

  if (refusals.length) return { ok: false, refusals, written: [], swiftAffected: [] };

  const written = [];
  for (const fx of dirty) {
    const doc = { ...fx.doc, cases: fx.doc.cases.map(canonicalCase) };
    fs.writeFileSync(path.join(root, fx.file), stableJson(doc));
    written.push(fx.file);
  }

  const manifest = computeManifest(root);
  // A --family run records ONE family, so it may only vouch for that one. The
  // manifest is what the next run reads as "already recorded" (knownIds above),
  // and an authored case is only reported (to the Swift side, and to the JVM's
  // books) the first time it is NOT known — so writing another family's
  // unrecorded ids in here made them look recorded, and that family's own run
  // then left its authored cases out (found by NE-07j: recording queue-state
  // first dropped the four authored rate cases). Every other family keeps the
  // entry it had, or stays absent, and --check keeps saying "record it" until
  // someone does.
  if (family) {
    for (const f of Object.keys(manifest.families)) {
      if (f === family) continue;
      if (data.manifest.families?.[f]) manifest.families[f] = data.manifest.families[f];
      else delete manifest.families[f];
    }
  }
  const liveIds = new Set(Object.values(manifest.families).flatMap((f) => f.ids));
  writeParity(root, "manifest.json", manifest);
  const jvmNext = nextJvmPending(jvm, {
    owed: jvmOwed, card: jvmCard, liveIds, liveFamilies: new Set(Object.keys(manifest.families)),
    unported: unportedFamilies(data.unported),
  });
  for (const d of jvmNext.dropped) log(`jvm-pending: dropping ${d} — it no longer exists`);
  writeParity(root, JVM_PENDING_FILE, jvmNext.doc);

  const { status } = classify(root);
  const c = counts(status, loadFixtures(root));
  floors.suites ??= {};
  for (const [stem, s] of Object.entries(c.suites)) {
    if (!s.tests) continue;
    floors.suites[stem] = lowerFloors ? s.tests : Math.max(floors.suites[stem] ?? 0, s.tests);
  }
  floors.families = sortKeys(floors.families);
  floors.suites = sortKeys(floors.suites);
  writeParity(root, "floors.json", floors);

  log(formatCounts(c));
  if (affected.length) {
    log(`\nswift: ${affected.length} id(s) new or changed; engine-parity holds this change to them (nothing is owed since NE-39s)`);
  }
  if (jvmOwed.families.length + jvmOwed.cases.length) {
    log(`jvm-pending: ${jvmOwed.families.length} family(ies) and ${jvmOwed.cases.length} id(s) tagged ${jvmCard}`);
  }
  if (jsOnlyAffected.length) log(`js-only: ${jsOnlyAffected.length} id(s) recorded, owed to no Swift card`);
  return { ok: true, refusals: [], written, swiftAffected: affected, jsOnlyRecorded: jsOnlyAffected, jvmOwed };
}

export function formatCounts(c) {
  const lines = ["suite                 tests  fixtured  xctest  facade  excluded  unported"];
  for (const [stem, s] of Object.entries(c.suites)) {
    lines.push(`${stem.padEnd(20)} ${String(s.tests).padStart(6)} ${String(s.fixtured).padStart(9)} ${String(s.xctest).padStart(7)} ${String(s.facade ?? 0).padStart(7)} ${String(s.excluded).padStart(9)} ${String(s.unported).padStart(9)}`);
  }
  lines.push("", "family                cases");
  for (const [f, n] of Object.entries(c.families)) lines.push(`${f.padEnd(20)} ${String(n).padStart(6)}`);
  return lines.join("\n");
}

/* ---------- --classify (retired) ---------- */

/** NE-39s retired unported.json, the list --classify wrote into. The option
    stays only to say so: a covered test that is accounted for nowhere is
    fixtured, mapped to an XCTest or excluded, in the change that adds it. */
export const CLASSIFY_RETIRED =
  "--classify is retired: NE-39s deleted unported.json, so nothing can be owed. Fixture the test (a case's covers[]), " +
  "map it to an XCTest (xctest.json) or exclude it with a reason (exclusions.json) in this change";

/* ---------- --mutate ---------- */

export function loadMutations() {
  return JSON.parse(fs.readFileSync(path.join(HERE, "mutations.json"), "utf8")).rules;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function tapCount(out, key) {
  const m = out.match(new RegExp(`^# ${key} (\\d+)$`, "m"));
  return m ? Number(m[1]) : null;
}

/**
 * Run one mutation. Children run ONE AT A TIME (spawnSync), never in parallel.
 * @returns {{rule, js: string, fixture: string, killed: boolean, detail: string[]}}
 *   js/fixture are "killed" | "survived" | "pending" | "error"
 */
export function runMutation(name, rule, { root = REPO_ROOT } = {}) {
  const detail = [];
  const target = path.join(root, rule.patch.file);
  const src = fs.readFileSync(target, "utf8");
  const hits = src.split(rule.patch.find).length - 1;
  if (hits !== 1) {
    return { rule: name, js: "error", fixture: "error", killed: false, detail: [`anchor occurs ${hits} times in ${rule.patch.file}; it must occur exactly once`] };
  }
  const env = {
    ...process.env,
    PARITY_MUTATION: JSON.stringify({ url: pathToFileURL(target).href, find: rule.patch.find, replace: rule.patch.replace }),
  };
  // Under `node --test` (npm test runs record.test.mjs), the runner marks its
  // children with NODE_TEST_CONTEXT, and a child carrying it reports to that
  // parent's protocol instead of printing TAP — so the counts below would read
  // as "the test never ran". The mutant child is its own run, not a subtest.
  delete env.NODE_TEST_CONTEXT;
  const register = pathToFileURL(path.join(HERE, "mutate-register.mjs")).href;

  // 1. The original JS test, alone, under the mutant.
  let js;
  const jsRun = spawnSync(process.execPath, [
    "--import", register,
    "--test-reporter=tap",
    `--test-name-pattern=^${escapeRe(rule.jsTest.name)}$`,
    suiteFile(rule.jsTest.suite),
  ], { cwd: root, env, encoding: "utf8", timeout: 120000 });
  const tests = tapCount(jsRun.stdout ?? "", "tests");
  const fail = tapCount(jsRun.stdout ?? "", "fail");
  if (tests === null || tests < 1) {
    js = "error";
    detail.push(`JS: the named test did not run (${suiteFile(rule.jsTest.suite)} :: ${rule.jsTest.name})\n${(jsRun.stderr ?? "").slice(0, 800)}`);
  } else if (fail > 0) js = "killed";
  else { js = "survived"; detail.push(`JS: ${suiteFile(rule.jsTest.suite)} :: ${rule.jsTest.name} still passes under the mutant`); }

  // 2. The fixture family, under the same mutant.
  let fixture;
  const hasFamily = loadFixtures(root, { family: rule.family }).length > 0;
  if (!hasFamily) {
    fixture = "pending";
    detail.push(`fixture: family ${rule.family} is not recorded yet (${rule.recordedBy} records it); enforced from then on`);
  } else {
    const fxRun = spawnSync(process.execPath, [
      "--import", register, path.join(HERE, "record.mjs"), "--check", "--family", rule.family, "--json", "--cases-only",
    ], { cwd: root, env, encoding: "utf8", timeout: 120000 });
    let parsed = null;
    try { parsed = JSON.parse(fxRun.stdout); } catch { /* reported below */ }
    if (!parsed || !(parsed.cases > 0)) {
      fixture = "error";
      detail.push(`fixture: the family check did not report\n${(fxRun.stderr ?? "").slice(0, 800)}`);
    } else if (parsed.failed > 0) fixture = "killed";
    else { fixture = "survived"; detail.push(`fixture: all ${parsed.cases} ${rule.family} cases still pass under the mutant`); }
  }
  const killed = js === "killed" && (fixture === "killed" || fixture === "pending");
  return { rule: name, js, fixture, killed, detail };
}

/* ---------- CLI ---------- */

function parseArgs(argv) {
  const opts = { mode: "record", family: null, portCard: null, jvmCard: null, json: false, casesOnly: false, lowerFloors: false, rules: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") opts.mode = "check";
    else if (a === "--mutate") opts.mode = "mutate";
    else if (a === "--classify") opts.mode = "classify";
    else if (a === "--counts") opts.mode = "counts";
    else if (a === "--family") opts.family = argv[++i];
    else if (a === "--port-card") opts.portCard = argv[++i];
    else if (a === "--jvm-card") opts.jvmCard = argv[++i];
    else if (a === "--json") opts.json = true;
    else if (a === "--cases-only") opts.casesOnly = true;
    else if (a === "--lower-floors") opts.lowerFloors = true;
    else if (opts.mode === "mutate" && !a.startsWith("--")) opts.rules.push(a);
    else throw new Error(`unknown option ${a}`);
  }
  return opts;
}

export async function main(argv, { root = REPO_ROOT, log = console.log, err = console.error } = {}) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) { err(e.message); return 2; }

  if (opts.mode === "check") {
    const r = await checkAll({ root, family: opts.family, manifest: !opts.casesOnly });
    if (opts.json) log(JSON.stringify({ cases: r.cases, failed: r.failed, problems: r.problems }));
    else if (r.problems.length) err(`parity --check: ${r.problems.length} problem(s)\n` + r.problems.join("\n"));
    else log(`parity --check: ${r.cases} case(s), all match`);
    return r.problems.length ? 1 : 0;
  }
  if (opts.mode === "counts") {
    const { status } = classify(root);
    log(formatCounts(counts(status, loadFixtures(root))));
    return 0;
  }
  if (opts.mode === "classify") {
    err(CLASSIFY_RETIRED);
    return 1;
  }
  if (opts.mode === "mutate") {
    const rules = loadMutations();
    const names = opts.rules.length ? opts.rules : Object.keys(rules);
    let bad = 0;
    for (const n of names) {
      if (!rules[n]) { err(`--mutate: no rule named ${n} (have: ${Object.keys(rules).join(", ")})`); bad++; continue; }
      const r = runMutation(n, rules[n], { root });
      log(`${r.killed ? "KILLED  " : "SURVIVED"} ${n}: js=${r.js} fixture=${r.fixture}${r.detail.length ? "\n  " + r.detail.join("\n  ") : ""}`);
      if (!r.killed) bad++;
    }
    return bad ? 1 : 0;
  }
  const r = await record({ root, family: opts.family, portCard: opts.portCard, jvmCard: opts.jvmCard, lowerFloors: opts.lowerFloors, log });
  if (!r.ok) { err(`record refused:\n${r.refusals.join("\n")}`); return 1; }
  log(`recorded: ${r.written.length} file(s) rewritten, ${r.swiftAffected.length} id(s) new or changed for Swift`);
  return 0;
}

if (isEntryScript(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
