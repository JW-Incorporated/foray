/* Tests for tools/classify/root-dumping-report.mjs.
 *
 * This report is the acceptance number for any re-classification pass, so the
 * counting rules are the thing under test — a metric that can be flattered by
 * adding tags is not a metric. Two rules carry that weight: a branch with no
 * children is excluded (nowhere more specific to go), and a pair only counts
 * as fixed when the item names an actual child of that same branch. */

import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { branchesWithChildren, measure, buildReport, formatMarkdown, parseArgs } from "./root-dumping-report.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "root-dumping-report.mjs");

const TAXONOMY = {
  nodes: [
    { id: "food", parent: null },
    { id: "food/baking", parent: "food" },
    { id: "history", parent: null },
    { id: "history/archaeology", parent: "history" },
    { id: "linguistics", parent: null }, // childless on purpose
  ],
};
const WITH_CHILDREN = branchesWithChildren(TAXONOMY);

const branch = (r, name) => r.branches.find((b) => b.branch === name);

test("branchesWithChildren finds exactly the branches that have children", () => {
  assert.deepEqual([...WITH_CHILDREN].sort(), ["food", "history"]);
});

test("a bare root with no child is a root-only pair", () => {
  const r = measure([["food"]], WITH_CHILDREN);
  assert.equal(branch(r, "food").root_only, 1);
  assert.equal(branch(r, "food").with_child, 0);
});

test("root plus child in the same branch is not root-only", () => {
  const r = measure([["food", "food/baking"]], WITH_CHILDREN);
  assert.equal(branch(r, "food").root_only, 0);
  assert.equal(branch(r, "food").with_child, 1);
});

test("a child on its own is not root-only either", () => {
  const r = measure([["food/baking"]], WITH_CHILDREN);
  assert.equal(branch(r, "food").with_child, 1);
  assert.equal(r.root_only, 0);
});

test("a child of a DIFFERENT branch does not rescue a bare root", () => {
  const r = measure([["food", "history/archaeology"]], WITH_CHILDREN);
  assert.equal(branch(r, "food").root_only, 1, "food is still bare");
  assert.equal(branch(r, "history").with_child, 1);
});

test("a childless branch is excluded from the counts entirely", () => {
  const r = measure([["linguistics"]], WITH_CHILDREN);
  assert.equal(r.pairs, 0, "an item with nowhere more specific to go is not a failure");
  assert.equal(r.branches.length, 0);
});

test("one item spanning two branches produces two pairs", () => {
  const r = measure([["food", "history"]], WITH_CHILDREN);
  assert.equal(r.pairs, 2);
  assert.equal(r.root_only, 2);
});

test("a repeated topic in one item is counted once", () => {
  const r = measure([["food", "food"]], WITH_CHILDREN);
  assert.equal(branch(r, "food").pairs, 1);
});

test("fully_root_only counts items carrying no child node anywhere", () => {
  const r = measure([["food"], ["food", "food/baking"], ["history"]], WITH_CHILDREN);
  assert.equal(r.fully_root_only, 2);
  assert.equal(r.items, 3);
});

test("an item with an empty topic list is reported, not silently dropped", () => {
  const r = measure([[], ["food"]], WITH_CHILDREN);
  assert.equal(r.items_with_no_topics, 1);
  assert.equal(r.items, 2);
  assert.equal(r.fully_root_only, 1, "only the one that has topics and no child");
});

test("pct_root_only is the share of pairs, not of items", () => {
  const r = measure([["food", "history/archaeology"], ["food", "food/baking"]], WITH_CHILDREN);
  assert.equal(r.pairs, 3);
  assert.equal(r.root_only, 1);
  assert.equal(r.pct_root_only, 33.3);
});

test("pct_root_only is 0 rather than NaN when there is nothing to measure", () => {
  assert.equal(measure([], WITH_CHILDREN).pct_root_only, 0);
});

test("branches are ordered worst-first", () => {
  const r = measure([["history"], ["history"], ["food"]], WITH_CHILDREN);
  assert.equal(r.branches[0].branch, "history");
});

test("buildReport measures breadth and discover separately", () => {
  const rep = buildReport({
    taxonomy: TAXONOMY,
    breadth: { entries: { 1: { topics: ["food"] }, 2: { topics: ["food/baking"] } } },
    discover: { items: [{ topics: ["history"] }] },
  });
  assert.equal(rep.sources.breadth.root_only, 1);
  assert.equal(rep.sources.discover.root_only, 1);
  assert.equal(rep.sources.breadth.items, 2);
});

test("buildReport names the childless branches it excluded", () => {
  const rep = buildReport({ taxonomy: TAXONOMY, discover: { items: [] } });
  assert.deepEqual(rep.childless_branches, ["linguistics"]);
});

test("buildReport omits a source that was not supplied", () => {
  const rep = buildReport({ taxonomy: TAXONOMY, discover: { items: [] } });
  assert.equal(rep.sources.breadth, undefined);
});

test("formatMarkdown renders a plain table with no baseline", () => {
  const rep = buildReport({ taxonomy: TAXONOMY, discover: { items: [{ topics: ["food"] }] } });
  const md = formatMarkdown(rep, null);
  assert.match(md, /\| branch \| pairs \| root-only \| % \|/);
  assert.match(md, /\| food \| 1 \| 1 \| 100\.0% \|/);
});

test("formatMarkdown renders before/after columns against a baseline", () => {
  const before = buildReport({ taxonomy: TAXONOMY, discover: { items: [{ topics: ["food"] }] } });
  const after = buildReport({ taxonomy: TAXONOMY, discover: { items: [{ topics: ["food", "food/baking"] }] } });
  const md = formatMarkdown(after, before);
  assert.match(md, /root-only before \| root-only after \| change/);
  assert.match(md, /\| food \| 1 \| 1 \| 0 \| -1 \|/);
  assert.match(md, /was 1 \(100%\)/, "the baseline share is rendered from pct_root_only verbatim");
});

test("formatMarkdown reports a source that has vanished since the baseline", () => {
  const before = buildReport({ taxonomy: TAXONOMY, breadth: { entries: { 1: { topics: ["food"] } } }, discover: { items: [] } });
  const after = buildReport({ taxonomy: TAXONOMY, discover: { items: [] } });
  const md = formatMarkdown(after, before);
  assert.match(md, /### breadth/);
  assert.match(md, /MISSING from this run/, "a disappeared source must not silently drop out of the diff");
});

/* --- the metric must not be gameable ------------------------------------- */

test("a topic that is not a taxonomy node is reported, never counted as a child", () => {
  const known = new Set(TAXONOMY.nodes.map((n) => n.id));
  const r = measure([["food", "food/bakin"]], WITH_CHILDREN, known);
  assert.deepEqual(r.unknown_topics, ["food/bakin"]);
  assert.equal(r.root_only, 1, "a misspelled child must not erase a root-only pair");
});

test("an item whose every topic is unknown counts as having no topics", () => {
  const known = new Set(TAXONOMY.nodes.map((n) => n.id));
  const r = measure([["not/real"]], WITH_CHILDREN, known);
  assert.equal(r.items_with_no_topics, 1);
  assert.equal(r.pairs, 0);
});

test("buildReport passes the taxonomy through, so unknown ids surface per source", () => {
  const rep = buildReport({ taxonomy: TAXONOMY, discover: { items: [{ topics: ["food", "invented/node"] }] } });
  assert.deepEqual(rep.sources.discover.unknown_topics, ["invented/node"]);
});

test("measure without a node set still works (ids are then trusted)", () => {
  const r = measure([["food", "food/anything"]], WITH_CHILDREN);
  assert.deepEqual(r.unknown_topics, []);
  assert.equal(r.root_only, 0);
});

/* --- argument handling: refuse rather than guess -------------------------- */

test("parseArgs accepts the documented flags", () => {
  assert.deepEqual(parseArgs([]), { json: false, baseline: null });
  assert.deepEqual(parseArgs(["--json"]), { json: true, baseline: null });
  assert.deepEqual(parseArgs(["--baseline", "b.json"]), { json: false, baseline: "b.json" });
});

test("parseArgs refuses an unknown flag instead of ignoring it", () => {
  assert.match(parseArgs(["--jsn"]).error, /unknown argument/);
});

test("parseArgs refuses --baseline with no value", () => {
  assert.match(parseArgs(["--baseline"]).error, /needs a snapshot path/);
  assert.match(parseArgs(["--baseline", "--json"]).error, /needs a snapshot path/);
});

test("parseArgs refuses --json together with --baseline", () => {
  assert.match(parseArgs(["--json", "--baseline", "b.json"]).error, /mutually exclusive/);
});

test("a bad flag exits non-zero rather than printing a table nobody asked for", () => {
  const res = spawnSync(process.execPath, [SCRIPT, "--jsn"], { encoding: "utf8" });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /unknown argument/);
  assert.equal(res.stdout.trim(), "", "no table on the happy-path stream");
});

test("a missing baseline file says so instead of throwing a stack trace", () => {
  const res = spawnSync(process.execPath, [SCRIPT, "--baseline", "definitely-not-here.json"], { encoding: "utf8" });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /baseline snapshot not found/);
  assert.doesNotMatch(res.stderr, /at Object|at Module/, "not a raw stack");
});

test("a baseline snapshot with a BOM still parses", () => {
  const dir = mkdtempSync(join(tmpdir(), "root-dumping-bom-"));
  const snap = join(dir, "before.json");
  const report = buildReport({ taxonomy: TAXONOMY, discover: { items: [{ topics: ["food"] }] } });
  writeFileSync(snap, "﻿" + JSON.stringify(report));
  const tax = join(dir, "taxonomy.json");
  const disc = join(dir, "discover.json");
  writeFileSync(tax, JSON.stringify(TAXONOMY));
  writeFileSync(disc, JSON.stringify({ items: [{ topics: ["food", "food/baking"] }] }));
  const res = spawnSync(process.execPath, [SCRIPT, "--baseline", snap], {
    encoding: "utf8",
    env: { ...process.env, TAXONOMY_PATH: tax, DISCOVER_PATH: disc, BREADTH_CLASSIFICATION_PATH: join(dir, "none.json") },
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /root-only before/);
});

test("formatMarkdown shows a branch that only exists in the baseline", () => {
  const before = buildReport({ taxonomy: TAXONOMY, discover: { items: [{ topics: ["history"] }] } });
  const after = buildReport({ taxonomy: TAXONOMY, discover: { items: [{ topics: ["food"] }] } });
  const md = formatMarkdown(after, before);
  assert.match(md, /\| history \| 0 \| 1 \| 0 \| -1 \|/);
});
