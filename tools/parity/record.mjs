#!/usr/bin/env node
/* The parity recorder (NE-03, plan §6.3). JS is the reference; this writes down
   what the reference says, and refuses to write down anything else.

   USAGE
     node tools/parity/record.mjs [--family F] --port-card NE-xx
         Run every case against the real JS module and write each non-authored
         `expect`. Every case that is NEW, or whose expect CHANGED, is added to
         swift-pending.json tagged with --port-card — a JS rule change therefore
         never turns the Swift runner red; it hands the Swift card a list.
         Refuses (writes nothing, exits 1) when:
           - JS disagrees with an `authored: true` case (a spec value, not ours
             to overwrite — change the spec on purpose, by hand, or fix the JS);
           - a case cannot run (harness error);
           - ids would change and no --port-card was given;
           - a family's case count would fall below its floor (--lower-floors).
     node tools/parity/record.mjs --check [--family F] [--json]
         Re-run and compare; change nothing. Red on any recorded or authored
         expect that differs, any unrecorded case, a manifest that no longer
         matches the bytes on disk, or a pending id that names no case.
         checkAll() below is what npm test runs (record.test.mjs).
     node tools/parity/record.mjs --mutate [rule ...]
         For each named rule in mutations.json (default: all), flip it in a
         child process's loader and require that BOTH its original JS test and
         its fixture family fail. Exit 1 if any mutant survives.
     node tools/parity/record.mjs --classify
         Put every covered-suite test that is accounted for nowhere into
         unported.json with its suite's default card and family (coverage.js
         COVERED_SUITES). The guard stays red until a person does this, by
         design: classifying is a decision, even when the default is right.
     node tools/parity/record.mjs --counts
         Print per-suite and per-family counts (the numbers no card types). */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  REPO_ROOT, PARITY_DIR, loadFixtures, validateFixtures, runCase,
} from "../../player/parity/runner.js";
import { compare, formatDiffs } from "../../player/parity/compare.js";
import {
  computeManifest, loadParityData, classify, counts, COVERED_SUITES, CARD_RE, suiteFile,
} from "../../player/parity/coverage.js";

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

/** Run every case of the given fixtures. */
async function evaluate(root, fixtures) {
  const out = [];
  for (const fx of fixtures) {
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
    if (!("expect" in r.c)) { failed++; problems.push(`${r.c.id}: unrecorded (run record.mjs --port-card <card>)`); continue; }
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
    const ids = new Set(Object.values(want.families).flatMap((f) => f.ids));
    for (const [id, card] of Object.entries(data.pending)) {
      if (id.startsWith("//")) continue;
      if (!ids.has(id)) problems.push(`swift-pending: ${id} names no fixture case`);
      if (!CARD_RE.test(card)) problems.push(`swift-pending: ${id} is tagged ${JSON.stringify(card)}, not a card id`);
    }
  }
  return { problems, cases, failed };
}

/* ---------- record ---------- */

/**
 * Record. Returns `{ok, refusals, written, pendingAdded}`; writes only when ok.
 */
export async function record({ root = REPO_ROOT, family = null, portCard = null, lowerFloors = false, log = console.log } = {}) {
  const all = loadFixtures(root);
  const refusals = validateFixtures(all).map((p) => `schema: ${p}`);
  const fixtures = family ? all.filter((f) => f.family === family) : all;
  if (family && !fixtures.length) refusals.push(`no fixtures for family "${family}"`);
  if (portCard != null && !CARD_RE.test(portCard)) refusals.push(`--port-card ${JSON.stringify(portCard)} is not a card id (NE-05, NE-14s, ...)`);

  const data = loadParityData(root);
  const knownIds = new Set(Object.values(data.manifest.families ?? {}).flatMap((f) => f.ids ?? []));
  const affected = [];
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
        if (!knownIds.has(r.c.id)) affected.push(r.c.id);
        continue;
      }
      const had = "expect" in r.c;
      const same = had && !compare(r.c.expect, r.actual, { family: r.fx.family, tolerance: r.c.tolerance }).length;
      if (same && knownIds.has(r.c.id)) continue;
      if (!same) { r.c.expect = r.actual; dirty.add(r.fx); }
      affected.push(r.c.id);
    }
  }
  if (affected.length && !portCard && !refusals.length) {
    refusals.push(
      `${affected.length} case(s) are new or changed and must be handed to a Swift card: pass --port-card <card>.\n  ` +
      affected.slice(0, 10).join("\n  ")
    );
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

  if (refusals.length) return { ok: false, refusals, written: [], pendingAdded: [] };

  const written = [];
  for (const fx of dirty) {
    const doc = { ...fx.doc, cases: fx.doc.cases.map(canonicalCase) };
    fs.writeFileSync(path.join(root, fx.file), stableJson(doc));
    written.push(fx.file);
  }

  const pending = { ...data.pending };
  for (const id of affected) pending[id] = portCard;
  const manifest = computeManifest(root);
  const liveIds = new Set(Object.values(manifest.families).flatMap((f) => f.ids));
  for (const id of Object.keys(pending)) {
    if (!id.startsWith("//") && !liveIds.has(id)) {
      log(`swift-pending: dropping ${id} — its case was deleted`);
      delete pending[id];
    }
  }
  writeParity(root, "swift-pending.json", sortKeys(pending));
  writeParity(root, "manifest.json", manifest);

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
  if (affected.length) log(`\nswift-pending: ${affected.length} id(s) tagged ${portCard}`);
  return { ok: true, refusals: [], written, pendingAdded: affected };
}

export function formatCounts(c) {
  const lines = ["suite                 tests  fixtured  xctest  excluded  unported"];
  for (const [stem, s] of Object.entries(c.suites)) {
    lines.push(`${stem.padEnd(20)} ${String(s.tests).padStart(6)} ${String(s.fixtured).padStart(9)} ${String(s.xctest).padStart(7)} ${String(s.excluded).padStart(9)} ${String(s.unported).padStart(9)}`);
  }
  lines.push("", "family                cases");
  for (const [f, n] of Object.entries(c.families)) lines.push(`${f.padEnd(20)} ${String(n).padStart(6)}`);
  return lines.join("\n");
}

/* ---------- --classify ---------- */

/** Add every unaccounted covered-suite test to unported.json with its suite's
    default card and family. Returns the entries added. */
export function classifyNew({ root = REPO_ROOT } = {}) {
  const data = loadParityData(root);
  const { status } = classify(root, data);
  const added = [];
  const unported = structuredClone(data.unported);
  for (const [stem, names] of Object.entries(status)) {
    for (const [name, st] of Object.entries(names)) {
      if (st.covered.length || st.xctest || st.excluded || st.unported) continue;
      const cfg = COVERED_SUITES[stem];
      (unported[stem] ??= {})[name] = { card: cfg.card, family: cfg.family };
      added.push(`${stem}::${name}`);
    }
  }
  for (const stem of Object.keys(unported)) if (!stem.startsWith("//")) unported[stem] = sortKeys(unported[stem]);
  writeParity(root, "unported.json", sortKeys(unported));
  return added;
}

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
  const opts = { mode: "record", family: null, portCard: null, json: false, casesOnly: false, lowerFloors: false, rules: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") opts.mode = "check";
    else if (a === "--mutate") opts.mode = "mutate";
    else if (a === "--classify") opts.mode = "classify";
    else if (a === "--counts") opts.mode = "counts";
    else if (a === "--family") opts.family = argv[++i];
    else if (a === "--port-card") opts.portCard = argv[++i];
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
    const added = classifyNew({ root });
    log(`--classify: ${added.length} test(s) added to unported.json`);
    return 0;
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
  const r = await record({ root, family: opts.family, portCard: opts.portCard, lowerFloors: opts.lowerFloors, log });
  if (!r.ok) { err(`record refused:\n${r.refusals.join("\n")}`); return 1; }
  log(`recorded: ${r.written.length} file(s) rewritten, ${r.pendingAdded.length} id(s) now swift-pending`);
  return 0;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = await main(process.argv.slice(2));
}
