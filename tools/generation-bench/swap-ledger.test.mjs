/* Tests for the model-swap rule and ledger (GV-35, W7-01).
 * Run: node --test tools/generation-bench/swap-ledger.test.mjs
 *
 * WHAT IS AT RISK
 * The rule turns the founder's blind cards and the scorecard into a verdict
 * that changes a production default. Every way it can go wrong is quiet: a
 * swap that lost reads as one that won, a metric arm B never measured counts
 * as passed, a regression hides inside a band nobody supplied, a correction
 * overwrites the row a PR cited. Each test below pins one of those. All
 * evidence is synthetic; nothing here reads a model, a network or a run.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AXES } from "../listening/card.mjs";
import { decideSwap, MIN_LISTENED, SLACK_MS } from "./swap-rule.mjs";
import {
  appendLedgerRow,
  DEFAULT_ADOPTED_STACK,
  DEFAULT_DOC,
  DEFAULT_LEDGER,
  main,
  parseLedger,
  readLedger,
  renderLedgerTable,
  spliceLedgerTable,
  SWAPS_BEGIN,
  SWAPS_END,
  validateAdoptedStack,
  validateLedgerRow
} from "./swap-ledger.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ */
/* Synthetic evidence                                                  */
/* ------------------------------------------------------------------ */

const card = (v) => Object.fromEntries(AXES.map((a) => [a, v]));
const cleanMq = () => ({ "MQ-01": 1, "MQ-02": 0.9, "MQ-04": 0, "MQ-05": 0.85, "MQ-21": true });

/** n listened prompts, all ties with equal cards and clean equal scorecards:
 * the evidence that should ADOPT when the corpus is frozen. `prefs` overrides
 * the preferences in order. */
function evidence({ prefs = [], n = 10, kind = "stage", ...rest } = {}) {
  const prompts = Array.from({ length: n }, (_, i) => ({
    promptId: `g-${String(i + 1).padStart(2, "0")}`,
    preference: i < prefs.length ? prefs[i] : "tie",
    scores: { A: card(4), B: card(4) },
    mq: { A: cleanMq(), B: cleanMq() }
  }));
  return {
    kind,
    stage: "deepen",
    corpusFingerprint: "corpus-abc123",
    prompts,
    timing: [
      { stage: "spine", A: 9000, B: 9000, resumed: true },
      { stage: "deepen", A: 20000, B: 21000 },
      { stage: "write", A: 30000, B: 30500 }
    ],
    ...rest
  };
}
const BANDS = { "MQ-02": 0.05, "MQ-05": 0.05 };
const result = (verdict, name) => verdict.checks.find((c) => c.name === name)?.result;

/* ------------------------------------------------------------------ */
/* decideSwap                                                          */
/* ------------------------------------------------------------------ */

test("a pairwise win with every check passing adopts, and the counts are B's", () => {
  const v = decideSwap(evidence({ prefs: ["B", "B", "B", "A"] }), { bands: BANDS });
  assert.equal(v.decision, "adopt");
  assert.deepEqual(v.pairwise, { wins: 3, ties: 6, losses: 1, pairs: 10 });
  assert.deepEqual(v.failing, []);
  assert.equal(result(v, "pairwise"), "pass");
});

test("an even result (all ties) adopts: wins(B) + ties >= wins(A)", () => {
  const v = decideSwap(evidence(), { bands: BANDS });
  assert.equal(v.decision, "adopt");
  assert.deepEqual(v.pairwise, { wins: 0, ties: 10, losses: 0, pairs: 10 });
});

test("a pairwise loss rejects: wins(A) > wins(B) + ties", () => {
  const prefs = ["A", "A", "A", "A", "A", "A", "B", "B", "tie", "tie"];
  const v = decideSwap(evidence({ prefs }), { bands: BANDS });
  assert.equal(v.decision, "reject");
  assert.deepEqual(v.pairwise, { wins: 2, ties: 2, losses: 6, pairs: 10 });
  assert.ok(v.failing.includes("pairwise"));
});

test("the boundary wins(A) == wins(B) + ties is not a reject", () => {
  const prefs = ["A", "A", "A", "A", "A", "B", "B", "B", "tie", "tie"];
  const v = decideSwap(evidence({ prefs }), { bands: BANDS });
  assert.notEqual(v.decision, "reject");
  assert.equal(v.decision, "adopt");
});

test("an axis mean dropping more than 0.5 holds and names the axis; exactly 0.5 passes", () => {
  const ev = evidence();
  ev.prompts.forEach((p, i) => (p.scores.B.oneNarrator = i < 6 ? 3 : 4)); // mean 3.4 vs 4 -> drop 0.6
  const v = decideSwap(ev, { bands: BANDS });
  assert.equal(v.decision, "hold");
  assert.deepEqual(v.failing, ["axis:oneNarrator"]);
  assert.equal(v.axisMeans.A.oneNarrator, 4);
  assert.ok(Math.abs(v.axisMeans.B.oneNarrator - 3.4) < 1e-9);

  const edge = evidence();
  edge.prompts.forEach((p, i) => (p.scores.B.onSubject = i < 5 ? 3 : 4)); // drop exactly 0.5
  assert.equal(result(decideSwap(edge, { bands: BANDS }), "axis:onSubject"), "pass");
});

test("an MQ-04 regression (an unverified page on one more prompt for B) holds", () => {
  const ev = evidence();
  ev.prompts[3].mq.B["MQ-04"] = 1;
  const v = decideSwap(ev, { bands: BANDS });
  assert.equal(v.decision, "hold");
  assert.deepEqual(v.failing, ["MQ-01+MQ-04"]);
  /* and MQ-01 below 1 on its own counts the same way */
  const g = evidence();
  g.prompts[0].mq.B["MQ-01"] = 0.9;
  assert.equal(result(decideSwap(g, { bands: BANDS }), "MQ-01+MQ-04"), "fail");
});

test("MQ-21: B may lose one run success per 10 prompts, not two", () => {
  const one = evidence();
  one.prompts[0].mq.B["MQ-21"] = false;
  assert.equal(result(decideSwap(one, { bands: BANDS }), "MQ-21"), "pass");
  const two = evidence();
  two.prompts[0].mq.B["MQ-21"] = false;
  two.prompts[1].mq.B["MQ-21"] = null; // a failed run has no report: not a success
  const v = decideSwap(two, { bands: BANDS });
  assert.equal(result(v, "MQ-21"), "fail");
  assert.equal(v.decision, "hold");
});

test("MQ-02/MQ-05 with no band supplied are 'unmeasured', never 'pass', and do not block", () => {
  const v = decideSwap(evidence());
  assert.equal(result(v, "MQ-02"), "unmeasured");
  assert.equal(result(v, "MQ-05"), "unmeasured");
  assert.ok(v.unmeasured.includes("MQ-02") && v.unmeasured.includes("MQ-05"));
  assert.equal(v.decision, "adopt");
});

test("MQ-05 below A by more than the band fails; a gain beyond the band passes", () => {
  const worse = evidence();
  worse.prompts.forEach((p) => (p.mq.B["MQ-05"] = 0.75));
  const v = decideSwap(worse, { bands: BANDS });
  assert.equal(result(v, "MQ-05"), "fail");
  assert.ok(Math.abs(v.scorecardDelta["MQ-05"].delta + 0.1) < 1e-9);
  const better = evidence();
  better.prompts.forEach((p) => (p.mq.B["MQ-02"] = 0.99));
  assert.equal(result(decideSwap(better, { bands: BANDS }), "MQ-02"), "pass");
});

test("timing over slack holds; resumed and upstream stages are not compared", () => {
  const ev = evidence();
  ev.timing[1].B = 24000; // deepen +4000 ms > 15% of 20000 (3000)
  ev.timing[0].B = 99999; // spine is upstream AND resumed: never compared
  const v = decideSwap(ev, { bands: BANDS });
  assert.equal(v.decision, "hold");
  assert.deepEqual(v.failing, ["timing:deepen"]);
  assert.deepEqual(v.timingDelta.map((t) => t.stage), ["deepen", "write"]);
  assert.equal(v.timingDelta[0].slackMs, 3000);
  /* an upstream stage that was NOT resumed is still not compared (it is not
     the change), and a later stage marked resumed is skipped */
  const split = evidence({
    timing: [
      { stage: "understand", A: 1000, B: 9000 },
      { stage: "deepen", A: 20000, B: 20000 },
      { stage: "continuity", A: 5000, B: 50000, resumed: true },
      { stage: "write", A: 30000, B: 30000 }
    ]
  });
  const s = decideSwap(split, { bands: BANDS });
  assert.deepEqual(s.timingDelta.map((t) => t.stage), ["deepen", "write"]);
  assert.equal(s.decision, "adopt");
  /* the spine best-of-2 lever gets its fixed 3,000 ms slack */
  const lever = evidence({
    kind: "lever",
    lever: "spineBestOf",
    stage: "spine",
    timing: [{ stage: "spine", A: 8000, B: 10900 }, { stage: "deepen", A: 20000, B: 20000 }]
  });
  const lv = decideSwap(lever, { bands: BANDS });
  assert.equal(SLACK_MS.spineBestOf, 3000);
  assert.equal(result(lv, "timing:spine"), "pass");
  lever.timing[0].B = 11100;
  assert.equal(result(decideSwap(lever, { bands: BANDS }), "timing:spine"), "fail");
});

test("a metric absent in one arm fails; absent in both arms is unmeasured and does not block", () => {
  const oneArm = evidence();
  oneArm.prompts.forEach((p) => {
    delete p.mq.B["MQ-01"];
    delete p.mq.B["MQ-04"];
  });
  oneArm.timing[2].B = null;
  const v = decideSwap(oneArm, { bands: BANDS });
  assert.equal(result(v, "MQ-01+MQ-04"), "fail");
  assert.equal(result(v, "timing:write"), "fail");
  assert.equal(v.decision, "hold");

  const both = evidence({ timing: [] });
  both.prompts.forEach((p) => {
    for (const arm of ["A", "B"]) for (const k of ["MQ-01", "MQ-04", "MQ-21"]) delete p.mq[arm][k];
  });
  const w = decideSwap(both, { bands: BANDS });
  for (const name of ["MQ-01+MQ-04", "MQ-21", "timing"]) assert.equal(result(w, name), "unmeasured", name);
  assert.equal(w.decision, "adopt");

  /* present in B only: nothing to compare against, unmeasured, never pass */
  const bOnly = evidence();
  bOnly.prompts.forEach((p) => delete p.mq.A["MQ-02"]);
  assert.equal(result(decideSwap(bOnly, { bands: BANDS }), "MQ-02"), "unmeasured");
});

test("fewer than the 10 listened prompts holds, and the 40 scored-only prompts count only on the scorecard", () => {
  const ev = evidence({ n: 12 });
  ev.prompts.slice(MIN_LISTENED - 1).forEach((p) => {
    p.preference = null; // scored, not listened
    p.scores = null;
  });
  const v = decideSwap(ev, { bands: BANDS });
  assert.equal(v.pairwise.pairs, MIN_LISTENED - 1);
  assert.deepEqual(v.failing, ["listened"]);
  assert.equal(v.decision, "hold");
});

test("unfrozen evidence cannot adopt: corpus-frozen fails and the verdict holds", () => {
  const v = decideSwap(evidence({ corpusFingerprint: "unfrozen" }), { bands: BANDS });
  assert.equal(v.decision, "hold");
  assert.deepEqual(v.failing, ["corpus-frozen"]);
});

test("the measure kind (E0) is 'measured' whatever the checks say", () => {
  const prefs = Array(10).fill("A");
  const v = decideSwap(evidence({ kind: "measure", prefs, corpusFingerprint: "unfrozen" }), { bands: BANDS });
  assert.equal(v.decision, "measured");
  assert.ok(v.failing.includes("pairwise") && v.failing.includes("corpus-frozen"));
});

test("malformed evidence throws rather than reading as nothing measured", () => {
  assert.throws(() => decideSwap({ kind: "swap", prompts: [] }), /kind/);
  assert.throws(() => decideSwap({ kind: "stage" }), /prompts/);
  assert.throws(() => decideSwap(evidence({ prefs: ["a"] })), /preference/);
});

/** Wrap every scorecard value the way score.mjs emits it: { value, source, note }. */
const asCells = (ev) => {
  for (const p of ev.prompts) {
    for (const arm of ["A", "B"]) {
      p.mq[arm] = Object.fromEntries(Object.entries(p.mq[arm]).map(([k, v]) => [k, { value: v, source: "report", note: null }]));
    }
  }
  return ev;
};

test("score.mjs cells are unwrapped: a B regressed on MQ-01, MQ-04 and MQ-21 holds", () => {
  const ev = evidence();
  ev.prompts[0].mq.B["MQ-01"] = 0.2;
  ev.prompts[1].mq.B["MQ-04"] = 5;
  ev.prompts[2].mq.B["MQ-21"] = false;
  ev.prompts[3].mq.B["MQ-21"] = false;
  const v = decideSwap(asCells(ev), { bands: BANDS });
  assert.equal(v.decision, "hold");
  assert.equal(result(v, "MQ-01+MQ-04"), "fail");
  assert.equal(result(v, "MQ-21"), "fail");
  assert.deepEqual(v.failing, ["MQ-01+MQ-04", "MQ-21"]);
  /* the banded rates are read through the cell too, not dropped to unmeasured */
  assert.equal(result(v, "MQ-02"), "pass");
  assert.equal(result(v, "MQ-05"), "pass");
  assert.equal(v.scorecardDelta["MQ-04"].B, 0.5);
  /* a cell whose value is null is absent, exactly like a bare null */
  const gone = asCells(evidence());
  for (const p of gone.prompts) p.mq.B["MQ-02"] = { value: null, source: "judged", note: "no judged file" };
  assert.equal(result(decideSwap(gone, { bands: BANDS }), "MQ-02"), "fail");
});

test("a scorecard value that is not a number, a boolean, null or a cell carrying one throws", () => {
  const stray = evidence();
  stray.prompts[4].mq.B["MQ-04"] = "0";
  assert.throws(() => decideSwap(stray, { bands: BANDS }), /g-05: arm B MQ-04/);
  const obj = evidence();
  obj.prompts[0].mq.A["MQ-21"] = { ok: true };
  assert.throws(() => decideSwap(obj, { bands: BANDS }), /g-01: arm A MQ-21/);
  const inCell = asCells(evidence());
  inCell.prompts[0].mq.B["MQ-01"].value = { rate: 1 };
  assert.throws(() => decideSwap(inCell, { bands: BANDS }), /g-01: arm B MQ-01/);
  const nan = evidence();
  nan.prompts[0].mq.B["MQ-02"] = Number.NaN;
  assert.throws(() => decideSwap(nan, { bands: BANDS }), /MQ-02/);
});

/* ------------------------------------------------------------------ */
/* The ledger                                                          */
/* ------------------------------------------------------------------ */

function rowFrom(verdict, over = {}) {
  return {
    id: "E1-deepen-p40-1",
    experiment: "E1",
    kind: "stage",
    stage: "deepen",
    armA: { stack: { deepen: "local:spark" }, levers: {} },
    armB: { stack: { deepen: "local:second" }, levers: {} },
    commit: "c7cd8925",
    goldenSetId: "golden-v1",
    corpusFingerprint: "corpus-abc123",
    runDirs: { A: "data-local/swaps/E1/A", B: "data-local/swaps/E1/B" },
    pairwise: {
      wins: verdict.pairwise.wins,
      ties: verdict.pairwise.ties,
      losses: verdict.pairwise.losses,
      listener: "founder",
      listenedOn: "2026-10-20",
      packId: "pk-e1"
    },
    axisMeans: verdict.axisMeans,
    scorecardDelta: verdict.scorecardDelta,
    timingDelta: verdict.timingDelta,
    checks: verdict.checks,
    decision: verdict.decision,
    notes: "",
    ...over
  };
}
const adoptRow = (over) => rowFrom(decideSwap(evidence(), { bands: BANDS }), over);
const errorsOf = (row, existing) => validateLedgerRow(row, existing).errors.join("\n");

test("a row built from decideSwap's output validates", () => {
  assert.deepEqual(validateLedgerRow(adoptRow()), { ok: true, errors: [] });
});

test("validateLedgerRow refuses a row missing its commit or its pairwise counts", () => {
  const noCommit = adoptRow();
  delete noCommit.commit;
  assert.match(errorsOf(noCommit), /commit/);
  const noCounts = adoptRow();
  delete noCounts.pairwise.ties;
  assert.match(errorsOf(noCounts), /pairwise\.ties/);
  const noPairwise = adoptRow({ pairwise: undefined });
  delete noPairwise.pairwise;
  assert.match(errorsOf(noPairwise), /pairwise must be/);
});

test("an 'adopt' row on an unfrozen corpus is refused; a 'hold' row on one is fine", () => {
  assert.match(errorsOf(adoptRow({ corpusFingerprint: "unfrozen" })), /unfrozen/);
  const held = rowFrom(decideSwap(evidence({ corpusFingerprint: "unfrozen" }), { bands: BANDS }), { corpusFingerprint: "unfrozen" });
  assert.equal(held.decision, "hold");
  assert.deepEqual(validateLedgerRow(held).errors, []);
});

test("an 'adopt' row with a failing check, or a non-measure row decided 'measured', is refused", () => {
  const row = adoptRow();
  row.checks = [...row.checks, { name: "MQ-21", result: "fail" }];
  assert.match(errorsOf(row), /failing check/);
  assert.match(errorsOf(adoptRow({ decision: "measured" })), /measure/);
  assert.match(errorsOf(adoptRow({ extra: 1 })), /unknown field "extra"/);
});

test("append, then supersede: a reused id is refused, a correction is a new row carrying supersedes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swap-ledger-"));
  const file = path.join(dir, "ledger.jsonl");
  try {
    fs.writeFileSync(file, "");
    assert.equal(appendLedgerRow(file, adoptRow()), 1);
    const before = fs.readFileSync(file, "utf8");

    assert.throws(() => appendLedgerRow(file, adoptRow({ notes: "rescored" })), /already in the ledger.*supersedes/);
    assert.throws(() => appendLedgerRow(file, adoptRow({ id: "E1-x", supersedes: "nope" })), /supersedes must name/);
    assert.equal(fs.readFileSync(file, "utf8"), before, "a refused row leaves the file untouched");

    assert.equal(appendLedgerRow(file, adoptRow({ id: "E1-deepen-p40-2", supersedes: "E1-deepen-p40-1", notes: "card re-entered" })), 2);
    const after = fs.readFileSync(file, "utf8");
    assert.ok(after.startsWith(before), "append never rewrites an existing line");
    assert.throws(() => appendLedgerRow(file, adoptRow({ id: "E1-fork", supersedes: "E1-deepen-p40-1" })), /already superseded/);

    const rows = readLedger(file);
    assert.deepEqual(rows.map((r) => r.id), ["E1-deepen-p40-1", "E1-deepen-p40-2"]);
    assert.match(renderLedgerTable(rows), /\| E1-deepen-p40-1 \|.*\| superseded by E1-deepen-p40-2 \|/);
    assert.throws(() => parseLedger(`${after}${JSON.stringify(adoptRow())}\n`, "x.jsonl"), /x\.jsonl:3: .*already in the ledger/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* The table, the committed files                                      */
/* ------------------------------------------------------------------ */

test("renderLedgerTable is byte-stable and splices only between the markers", () => {
  const held = rowFrom(decideSwap(evidence({ corpusFingerprint: "unfrozen" }), { bands: BANDS }), {
    id: "E1-a",
    experiment: "E1 | retry",
    corpusFingerprint: "unfrozen",
    notes: "never rendered"
  });
  const rows = [held, adoptRow({ id: "E4-b", kind: "lever", lever: "spineBestOf", stage: undefined })];
  delete rows[1].stage;
  const once = renderLedgerTable(rows);
  assert.equal(renderLedgerTable(JSON.parse(JSON.stringify(rows))), once);
  assert.equal(
    once.split("\n")[2],
    "| E1-a | E1 \\| retry | stage | stage deepen | 0 / 10 / 0 | hold | corpus-frozen | unfrozen | c7cd892 | current |"
  );
  assert.match(once.split("\n")[3], /^\| E4-b \| E1 \| lever \| lever spineBestOf \| .* \| adopt \| none \|/);

  const doc = `intro\n${SWAPS_BEGIN}\nstale\n${SWAPS_END}\noutro\n`;
  const spliced = spliceLedgerTable(doc, rows);
  assert.equal(spliceLedgerTable(spliced, rows), spliced, "re-rendering is a no-op");
  assert.ok(spliced.startsWith(`intro\n${SWAPS_BEGIN}\n| id |`) && spliced.endsWith(`${SWAPS_END}\noutro\n`));
  assert.throws(() => spliceLedgerTable("no markers", rows), /no .*block/);
});

test("the committed ledger parses, the adopted stack starts empty, and the doc's table is in sync", () => {
  const rows = readLedger(DEFAULT_LEDGER);
  const stack = JSON.parse(fs.readFileSync(DEFAULT_ADOPTED_STACK, "utf8"));
  assert.deepEqual(validateAdoptedStack(stack, rows), { ok: true, errors: [] });
  assert.deepEqual(stack.stages, {});
  assert.match(stack.note, /No non-Anthropic stack has been measured/);
  const doc = fs.readFileSync(DEFAULT_DOC, "utf8");
  assert.equal(spliceLedgerTable(doc, rows), doc, "model-swaps.md is stale: run swap-ledger.mjs render --write");
  const lines = [];
  assert.equal(main(["check"], (l) => lines.push(l)), rows.length);
  assert.match(lines[0], /table in sync/);
});

test("the adopted stack cites a current 'adopt' row and never names an Anthropic model", () => {
  const rows = [adoptRow({ id: "E1-a" })];
  const stack = (over) => ({ schema: "adopted-stack/1", note: "", stages: { deepen: { impl: "chat", model: "qwen3.6-35b-a3b", machine: "second" } }, levers: {}, ledgerRow: "E1-a", ...over });
  assert.deepEqual(validateAdoptedStack(stack(), rows).errors, []);
  assert.match(validateAdoptedStack(stack({ ledgerRow: null }), rows).errors.join(), /cites the ledger row/);
  const heldRows = [rowFrom(decideSwap(evidence({ corpusFingerprint: "unfrozen" })), { id: "E1-a", corpusFingerprint: "unfrozen" })];
  assert.match(validateAdoptedStack(stack(), heldRows).errors.join(), /'hold' row, not 'adopt'/);
  const superseded = [...rows, adoptRow({ id: "E1-b", supersedes: "E1-a" })];
  assert.match(validateAdoptedStack(stack(), superseded).errors.join(), /superseded/);
  const claude = stack({ stages: { spine: { impl: "anthropic", model: "claude-sonnet", machine: "relay" } } });
  assert.match(validateAdoptedStack(claude, rows).errors.join(), /Anthropic/);
  assert.match(validateAdoptedStack(stack({ levers: { bestOf3: true } }), rows).errors.join(), /not a lever/);
});

test("model-swaps.md states the rule, the E0-E7 order, why the reviewers' order is replaced, and who decides", () => {
  const doc = fs.readFileSync(DEFAULT_DOC, "utf8");
  for (const e of ["E0", "E1", "E2", "E3", "E4", "E5", "E6", "E7"]) assert.match(doc, new RegExp(`\\| ${e} \\|`), e);
  assert.match(doc, /## The decision rule/);
  assert.match(doc, /no Claude arm may be generated/);
  assert.match(doc, /## Who decides/);
  assert.match(doc, /cites the ledger row id/);
});

test("neither module reaches the network or a model", () => {
  for (const f of ["swap-rule.mjs", "swap-ledger.mjs"]) {
    const src = fs.readFileSync(path.join(HERE, f), "utf8");
    assert.doesNotMatch(src, /\bfetch\(|node:https?|from "https?"|anthropicCall|child_process/, f);
  }
});
