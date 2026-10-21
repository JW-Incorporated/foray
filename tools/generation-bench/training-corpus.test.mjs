/* Tests for the act-level training-example ledger and readiness count
 * (GV-114). Run:
 *   node --test tools/generation-bench/training-corpus.test.mjs
 *
 * WHAT IS AT RISK. The count is the number that says how far off fine-tuning
 * is (R2-17). A ledger that counted a superseded round, an unverified act, a
 * pairwise loser, a Claude-written reply or the same exchange twice would
 * report readiness that is not there; an export that let Claude-derived rows
 * through would break OQ-06's parking. Each test names the mutation that
 * breaks it; each was run against that mutation before this landed.
 *
 * EVERYTHING IS SYNTHETIC: short invented windows, invented verdict rows, an
 * invented swap evidence file and a fake unsealer, a fake prompt builder,
 * all in a throwaway temp directory. No model, no network, no tsx.
 */

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { EXCHANGE_SCHEMA } from "./exchanges.mjs";
import { VERDICT_SCHEMA } from "../generation/review-queue.mjs";
import { KEY_MISSING } from "../listening/unseal.mjs";
import {
  ALLOW_CLAUDE_FLAG,
  EXAMPLE_SCHEMA,
  READINESS_BEGIN,
  READINESS_END,
  appendReadiness,
  buildExamples,
  exampleIdOf,
  examplesJsonl,
  historicReferenceActs,
  main,
  pairwiseOutcomes,
  readiness,
  readinessLine,
  sftLines
} from "./training-corpus.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const QWEN = { impl: "local", model: "qwen-test", machine: "spark" };
const CLAUDE = { impl: "anthropic", model: "claude-test" };

const PASSED = { beats: [{ beatId: "b0", carried: true }], seams: [{ seamId: "s0", claimsSupported: true, restsOn: [], contestedHandled: true }] };
const FAILED = { beats: [{ beatId: "b0", carried: true }], seams: [{ seamId: "s0", claimsSupported: false, restsOn: [], contestedHandled: true }] };

function exchange(over = {}) {
  const script = over.script ?? "A line.";
  delete over.script;
  return {
    schema: EXCHANGE_SCHEMA,
    forayKey: "synth-key",
    attempt: 1,
    actIndex: 0,
    actTitle: "Act 1: Synthetic",
    round: 1,
    call: "writeAct",
    generator: QWEN,
    request: { actTitle: "Act 1: Synthetic", seams: [{ seamId: "s0", beats: [] }], clips: [], documents: [{ docId: "tape:x#1", kind: "tape", title: "Show - Ep", text: "a short synthetic window" }] },
    reply: { seams: [{ seamId: "s0", script, claims: [], usedClaims: [], pronunciationHints: [] }] },
    mechanical: [],
    verdict: PASSED,
    recordedAt: "2026-10-21T00:00:00.000Z",
    ...over
  };
}

const jsonl = (records) => records.map((r) => JSON.stringify(r)).join("\n") + "\n";
const sha = (text) => crypto.createHash("sha256").update(text).digest("hex");

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gv114-corpus-"));
}

/** Writes <dir>/<key>.exchanges.jsonl and, when given, the candidate beside it. */
function writeRun(dir, key, records, candidate) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${key}.exchanges.jsonl`), jsonl(records));
  if (!candidate) return null;
  const bytes = JSON.stringify(candidate);
  fs.writeFileSync(path.join(dir, `${key}.json`), bytes);
  return sha(bytes);
}

function verdictRow(forayId, act, candidateSha256, verdict, at = "2026-10-21T10:00:00.000Z") {
  return { schema: VERDICT_SCHEMA, forayId, act, candidateSha256, lane: "catalogue", verdict, scores: {}, winces: [], reviewer: "founder", at };
}

/** A usable row; `over` breaks one condition. */
function row(over = {}) {
  return { schema: EXAMPLE_SCHEMA, exampleId: "e1", forayKey: "k", attempt: 1, actIndex: 0, round: 1, call: "writeAct", exchangeRef: { file: "f", line: 1 }, label: "keep", labelSource: "pairwise-win", generator: { impl: "local", model: "q" }, claudeDerived: false, finalRound: true, verified: true, ...over };
}

/* MUTATION: hash only the request in exampleIdOf (drop the reply) -> the
   different-reply assertion fails. MUTATION: hash JSON.stringify instead of
   canonicalJson -> the key-order assertion fails. */
test("exampleId is stable for an identical request and reply, whatever the key order", () => {
  const a = exchange();
  const b = exchange();
  assert.equal(exampleIdOf(a.request, a.reply), exampleIdOf(b.request, b.reply));
  const reordered = { documents: a.request.documents, clips: a.request.clips, seams: a.request.seams, actTitle: a.request.actTitle };
  assert.equal(exampleIdOf(reordered, a.reply), exampleIdOf(a.request, a.reply));
  const other = exchange({ script: "Another line." });
  assert.notEqual(exampleIdOf(other.request, other.reply), exampleIdOf(a.request, a.reply));
  assert.match(exampleIdOf(a.request, a.reply), /^[0-9a-f]{64}$/);
});

/* MUTATION: drop `&& latestAttempt.get(actKey(r)) === r.attempt` from
   finalRound -> attempt 1's last round is labelled too and the label count
   is 2. MUTATION: label every round (drop `if (finalRound)`) -> round 1 gets
   the verdict. */
test("build labels only the final round of the latest attempt, from the founder's verdict on the candidate beside it", () => {
  const root = tmpRoot();
  const dir = path.join(root, "data-local", "swaps", "E1", "B");
  const candidateSha = writeRun(
    dir,
    "synth-key",
    [
      exchange({ round: 1, mechanical: ["seam s0: names neither the show"], verdict: undefined }),
      exchange({ round: 2, call: "editSeams", script: "Edited." }),
      exchange({ attempt: 2, round: 1, script: "Rewritten on resume." }),
      exchange({ actIndex: 1, actTitle: "Act 2: Synthetic", script: "Act two." })
    ],
    { id: "cand-1", items: [] }
  );
  const verdicts = [verdictRow("cand-1", 1, candidateSha, "pass"), verdictRow("cand-1", 2, candidateSha, "fix")];
  const rows = buildExamples({ exchangeDirs: [path.join(root, "data-local", "swaps")], verdicts, root });
  assert.equal(rows.length, 4);
  assert.deepEqual(
    rows.map((r) => [r.attempt, r.actIndex, r.round, r.finalRound, r.label, r.labelSource]),
    [
      [1, 0, 1, false, null, null],
      [1, 0, 2, false, null, null],
      [2, 0, 1, true, "keep", "founder-verdict"],
      [1, 1, 1, true, "edited", "founder-verdict"]
    ]
  );
  assert.equal(rows[0].verified, false, "a round with mechanical issues is not verified");
  assert.deepEqual(rows[2].exchangeRef, { file: "data-local/swaps/E1/B/synth-key.exchanges.jsonl", line: 3 });
  assert.deepEqual(rows[2].generator, { impl: "local", model: "qwen-test" });
  assert.equal(rows[2].schema, EXAMPLE_SCHEMA);
});

/* MUTATION: drop the candidateSha256 part of the verdict key -> the verdict
   on the regenerated candidate labels the act. MUTATION: use r.actIndex
   instead of r.actIndex + 1 -> act 1's verdict misses. */
test("a verdict on another candidate's bytes, or on another act, labels nothing", () => {
  const root = tmpRoot();
  const dir = path.join(root, "runs");
  const candidateSha = writeRun(dir, "synth-key", [exchange()], { id: "cand-1", items: [] });
  const stale = buildExamples({ exchangeDirs: [dir], verdicts: [verdictRow("cand-1", 1, "0".repeat(64), "pass")], root });
  assert.equal(stale[0].label, null);
  const otherAct = buildExamples({ exchangeDirs: [dir], verdicts: [verdictRow("cand-1", 2, candidateSha, "pass")], root });
  assert.equal(otherAct[0].label, null);
  const hit = buildExamples({ exchangeDirs: [dir], verdicts: [verdictRow("cand-1", 1, candidateSha, "fail")], root });
  assert.deepEqual([hit[0].label, hit[0].labelSource], ["reject", "founder-verdict"]);
  const latest = buildExamples({ exchangeDirs: [dir], verdicts: [verdictRow("cand-1", 1, candidateSha, "fail", "2026-10-21T10:00:00Z"), verdictRow("cand-1", 1, candidateSha, "pass", "2026-10-22T10:00:00Z")], root });
  assert.equal(latest[0].label, "keep", "the founder's latest verdict on the act wins");
});

/* MUTATION: key the pairwise lookup by forayKey only (drop the dir) -> arm
   A's same-stem candidate is labelled a win too. MUTATION: swap the
   founder-verdict and pairwise branches -> the verdict no longer wins. */
test("pairwise outcomes label the arm's act 1 by run dir and stem; a founder verdict beats them", () => {
  const root = tmpRoot();
  const dirA = path.join(root, "data-local", "swaps", "E1", "A");
  const dirB = path.join(root, "data-local", "swaps", "E1", "B");
  writeRun(dirA, "same-stem", [exchange({ forayKey: "same-stem", script: "Arm A." }), exchange({ forayKey: "same-stem", actIndex: 1, script: "Arm A act 2." })]);
  const shaB = writeRun(dirB, "same-stem", [exchange({ forayKey: "same-stem", script: "Arm B." })], { id: "cand-b", items: [] });
  const outcomes = [
    { experiment: "E1", promptId: "p1", actIndex: 0, dir: dirA, forayKey: "same-stem", outcome: "loss" },
    { experiment: "E1", promptId: "p1", actIndex: 0, dir: dirB, forayKey: "same-stem", outcome: "win" }
  ];
  const rows = buildExamples({ exchangeDirs: [path.join(root, "data-local", "swaps")], outcomes, root });
  assert.deepEqual(
    rows.map((r) => [path.basename(path.dirname(r.exchangeRef.file)), r.actIndex, r.label, r.labelSource]),
    [
      ["A", 0, "reject", "pairwise-loss"],
      ["A", 1, null, null],
      ["B", 0, "keep", "pairwise-win"]
    ]
  );
  const overruled = buildExamples({ exchangeDirs: [dirB], outcomes, verdicts: [verdictRow("cand-b", 1, shaB, "fail")], root });
  assert.deepEqual([overruled[0].label, overruled[0].labelSource], ["reject", "founder-verdict"]);
});

/* MUTATION: in pairwiseOutcomes, label both arms "win" (drop the
   `arm === preference` test) -> the loss assertion fails. MUTATION: rethrow
   KEY_MISSING -> the skipped experiment aborts the build. */
test("pairwiseOutcomes maps an unsealed preference to arm outcomes; ties, E0's reference arm and missing keys yield none", () => {
  const root = tmpRoot();
  const swaps = path.join(root, "data-local", "swaps");
  const evidence = (id, runDirs, prompts) => {
    fs.mkdirSync(path.join(swaps, id), { recursive: true });
    fs.writeFileSync(path.join(swaps, id, "evidence.json"), JSON.stringify({ experiment: id, runDirs, prompts }));
  };
  evidence("E1", { A: "data-local/swaps/E1/A", B: "data-local/swaps/E1/B" }, [
    { promptId: "p1", packId: "pk1", candidates: { A: "k1", B: "k1" } },
    { promptId: "p2", packId: "pk2", candidates: { A: "k2", B: "k2" } }
  ]);
  evidence("E0", { A: "data/forays.json", B: "data-local/swaps/E0/B" }, [{ promptId: "p3", packId: "pk3", candidates: { A: "ref-foray", B: "k3" } }]);
  evidence("E2", { A: "data-local/swaps/E2/A", B: "data-local/swaps/E2/B" }, [{ promptId: "p4", packId: "pk4", candidates: { A: "k4", B: "k4" } }]);
  const cards = ["pk1", "pk2", "pk3", "pk4"].map((packId) => ({ packId }));
  const prefs = { E1: { p1: "B", p2: "tie" }, E0: { p3: "A" } };
  const unsealer = (ev, mine) => {
    if (ev.experiment === "E2") {
      const err = new Error("missing key");
      err.code = KEY_MISSING;
      throw err;
    }
    assert.ok(mine.every((c) => ev.prompts.some((p) => p.packId === c.packId)), "only the experiment's own cards are passed");
    return new Map(Object.entries(prefs[ev.experiment]).map(([promptId, preference]) => [promptId, { preference }]));
  };
  const { outcomes, skipped } = pairwiseOutcomes({ swapsDir: swaps, cards, root, unsealer });
  assert.deepEqual(
    outcomes.map((o) => [o.experiment, o.promptId, toRel(root, o.dir), o.forayKey, o.actIndex, o.outcome]),
    [
      ["E0", "p3", "data-local/swaps/E0/B", "k3", 0, "loss"],
      ["E1", "p1", "data-local/swaps/E1/A", "k1", 0, "loss"],
      ["E1", "p1", "data-local/swaps/E1/B", "k1", 0, "win"]
    ]
  );
  assert.deepEqual(skipped, ["E2: pack keys not on this machine"]);
});

function toRel(root, abs) {
  return path.relative(root, abs).split(path.sep).join("/");
}

/* MUTATION: drop `generator.impl.toLowerCase() === "anthropic"` from
   isClaudeDerived -> the anthropic row is not claude-derived. MUTATION: drop
   the model test -> the claude-model row is not. */
test("an Anthropic or Claude generator marks the row claudeDerived; a missing generator is null, not Qwen", () => {
  const root = tmpRoot();
  const dir = path.join(root, "runs");
  writeRun(dir, "k", [
    exchange({ forayKey: "k", generator: { impl: "anthropic", model: "opaque-model" } }),
    exchange({ forayKey: "k", actIndex: 1, generator: { impl: "local", model: "Claude-distilled" } }),
    exchange({ forayKey: "k", actIndex: 2, generator: null }),
    exchange({ forayKey: "k", actIndex: 3 })
  ]);
  const rows = buildExamples({ exchangeDirs: [dir], root });
  assert.deepEqual(
    rows.map((r) => [r.claudeDerived, r.generator]),
    [
      [true, { impl: "anthropic", model: "opaque-model" }],
      [true, { impl: "local", model: "Claude-distilled" }],
      [false, null],
      [false, { impl: "local", model: "qwen-test" }]
    ]
  );
});

/* MUTATION: drop any one clause of usableExample (finalRound, verified,
   label keep, claudeDerived false) -> its row counts and usable is 2.
   MUTATION: count rows instead of distinct exampleIds -> the duplicate
   counts and usable is 2. */
test("only final-round, verified, keep-labelled, non-claude exchanges count toward 500, once per example", () => {
  const rows = [
    row(),
    row({ exchangeRef: { file: "g", line: 1 } }),
    row({ exampleId: "e2", finalRound: false }),
    row({ exampleId: "e3", verified: false }),
    row({ exampleId: "e4", label: "edited", labelSource: "founder-verdict" }),
    row({ exampleId: "e5", label: "reject", labelSource: "pairwise-loss" }),
    row({ exampleId: "e6", label: null, labelSource: null }),
    row({ exampleId: "e7", claudeDerived: true, generator: { impl: "anthropic", model: "c" } }),
    row({ exampleId: "e8", generator: null })
  ];
  const r = readiness(rows, 16);
  assert.deepEqual(r, { usable: 1, target: 500, held: 1, unknownProvenance: 1, historic: 16 });
  assert.equal(
    readinessLine(r),
    "usable act-level examples: 1 of 500 (non-claude, labelled keep); claude-derived held: 1; historic reference acts without inputs: 16; no recorded generator: 1"
  );
});

/* MUTATION: isVerifiedRound returns true once mechanical is clean (replace
   its last line, or the `seams.length === 0` and isPlainObject(verdict)
   guards, with `return true`) -> a clean, final, keep-labelled, non-claude
   round whose verifier rejected a seam or a beat, judged no seam, or never
   ran is verified and counts, and usable is 1, not 0. MUTATION: drop the
   `beats.every(... carried === true)` clause -> the dropped-beat act is
   verified. */
test("a clean, final, keep-labelled round the verifier rejected, judged empty or never ran is not verified and does not count", () => {
  const root = tmpRoot();
  const dir = path.join(root, "runs");
  const BEAT_DROPPED = { beats: [{ beatId: "b0", carried: false }], seams: PASSED.seams };
  const NO_SEAMS = { beats: [{ beatId: "b0", carried: true }], seams: [] };
  const candidateSha = writeRun(
    dir,
    "k",
    [
      exchange({ forayKey: "k", actIndex: 0, verdict: FAILED, script: "Seam rejected." }),
      exchange({ forayKey: "k", actIndex: 1, verdict: BEAT_DROPPED, script: "Beat dropped." }),
      exchange({ forayKey: "k", actIndex: 2, verdict: NO_SEAMS, script: "No seams judged." }),
      exchange({ forayKey: "k", actIndex: 3, verdict: undefined, script: "No verifier call." }),
      exchange({ forayKey: "k", actIndex: 4, verdict: PASSED, script: "Passed." })
    ],
    { id: "cand-v", items: [] }
  );
  const raw = fs.readFileSync(path.join(dir, "k.exchanges.jsonl"), "utf8").split("\n");
  assert.equal("verdict" in JSON.parse(raw[3]), false, "act 4's exchange carries no verdict field");
  const verdicts = [verdictRow("cand-v", 1, candidateSha, "pass"), verdictRow("cand-v", 5, candidateSha, "pass")];
  const outcomes = [1, 2, 3].map((actIndex) => ({ experiment: "E1", promptId: "p1", actIndex, dir, forayKey: "k", outcome: "win" }));
  const rows = buildExamples({ exchangeDirs: [dir], verdicts, outcomes, root });
  assert.deepEqual(
    rows.map((r) => [r.actIndex, r.finalRound, r.label, r.labelSource, r.claudeDerived, r.verified]),
    [
      [0, true, "keep", "founder-verdict", false, false],
      [1, true, "keep", "pairwise-win", false, false],
      [2, true, "keep", "pairwise-win", false, false],
      [3, true, "keep", "pairwise-win", false, false],
      [4, true, "keep", "founder-verdict", false, true]
    ]
  );
  assert.equal(readiness(rows.slice(0, 4), 0).usable, 0, "no rejected, empty or missing verdict counts");
  assert.equal(readiness(rows, 0).usable, 1, "the PASSED round alone counts");
});

/* MUTATION: count every item of a Foray as an act (items.length) instead of
   actCount -> the synthetic count is 9, not 4. */
test("count over the Forays alone reports 0 usable and their acts as historic reference", async () => {
  const synthetic = {
    forays: [
      { id: "generated", items: [{ id: "act-1-introduction" }, { id: "x" }, { id: "act-2-introduction" }, { id: "act-3-introduction" }, { id: "act-4-introduction" }] },
      { id: "hand-built", items: [{ id: "intro" }, { id: "y" }, { id: "z" }, { id: "w" }] }
    ]
  };
  assert.equal(historicReferenceActs(synthetic), 4);
  assert.equal(readinessLine(readiness([], historicReferenceActs(synthetic))), "usable act-level examples: 0 of 500 (non-claude, labelled keep); claude-derived held: 0; historic reference acts without inputs: 4");

  /* The committed file, read only: 16 acts on 2026-10-21 (4 generated
     Forays of 4 acts); a later publish can only add acts. */
  const lines = [];
  const code = await main(["count", "--no-append", "--forays", path.join(REPO, "data", "forays.json"), "--ledger", path.join(tmpRoot(), "absent.jsonl")], (l) => lines.push(l), { root: REPO });
  assert.equal(code, 0);
  const m = /^usable act-level examples: 0 of 500 \(non-claude, labelled keep\); claude-derived held: 0; historic reference acts without inputs: (\d+)$/.exec(lines[0]);
  assert.ok(m, lines[0]);
  assert.ok(Number(m[1]) >= 16, `historic acts ${m[1]}`);
});

/* MUTATION: drop the identical-last-entry check -> a second run on the same
   day doubles the line. MUTATION: append after READINESS_END instead of
   before it -> the line lands outside the section. */
test("count appends one dated line inside the readiness markers, keeps CRLF, and refuses a doc without them", async () => {
  const doc = `# Doc\r\n\r\n${READINESS_BEGIN}\r\n${READINESS_END}\r\n`;
  const once = appendReadiness(doc, "2026-10-21", "usable act-level examples: 0 of 500");
  assert.equal(once, `# Doc\r\n\r\n${READINESS_BEGIN}\r\n- 2026-10-21: usable act-level examples: 0 of 500\r\n${READINESS_END}\r\n`);
  assert.equal(appendReadiness(once, "2026-10-21", "usable act-level examples: 0 of 500"), once);
  const twice = appendReadiness(once, "2026-10-22", "usable act-level examples: 1 of 500");
  assert.ok(twice.includes(`- 2026-10-21: usable act-level examples: 0 of 500\r\n- 2026-10-22: usable act-level examples: 1 of 500\r\n${READINESS_END}`));
  assert.throws(() => appendReadiness("# no markers\n", "2026-10-21", "x"), /markers/);

  const root = tmpRoot();
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", "forays.json"), JSON.stringify({ forays: [] }));
  fs.writeFileSync(path.join(root, "doc.md"), `# Doc\n\n${READINESS_BEGIN}\n${READINESS_END}\n`);
  const out = [];
  assert.equal(await main(["count", "--doc", "doc.md", "--date", "2026-10-21"], (l) => out.push(l), { root }), 0);
  assert.equal(
    fs.readFileSync(path.join(root, "doc.md"), "utf8"),
    `# Doc\n\n${READINESS_BEGIN}\n- 2026-10-21: usable act-level examples: 0 of 500 (non-claude, labelled keep); claude-derived held: 0; historic reference acts without inputs: 0\n${READINESS_END}\n`
  );
});

/* MUTATION: drop the `!allowClaudeDerived` refusal in sftLines -> the claude
   row is exported without the override. MUTATION: emit the reply object
   instead of JSON text as the assistant content -> the content type check
   fails. */
test("export-sft refuses claude-derived rows without the override and otherwise writes valid chat JSONL", async () => {
  const root = tmpRoot();
  const dir = path.join(root, "data-local", "swaps", "E1", "B");
  const records = [exchange({ forayKey: "k" }), exchange({ forayKey: "k", actIndex: 1, generator: CLAUDE, script: "Claude line." }), exchange({ forayKey: "k", actIndex: 2, script: "Unlabelled." })];
  writeRun(dir, "k", records);
  const outcomes = [0, 1, 2].map((actIndex) => ({ experiment: "E1", promptId: "p", actIndex, dir, forayKey: "k", outcome: "win" }));
  const rows = buildExamples({ exchangeDirs: [dir], outcomes: outcomes.slice(0, 2), root });
  fs.mkdirSync(path.join(root, "data-local", "training"), { recursive: true });
  fs.writeFileSync(path.join(root, "data-local", "training", "act-examples.jsonl"), examplesJsonl(rows));

  const builder = (request, record) => `PROMPT[${record.call}] ${request.actTitle}`;
  const refused = sftLines(rows, { promptBuilder: builder, root });
  assert.equal(refused.lines.length, 1);
  assert.equal(refused.refused, 1);
  const line = JSON.parse(refused.lines[0]);
  assert.deepEqual(line.messages.map((m) => m.role), ["user", "assistant"]);
  assert.equal(line.messages[0].content, "PROMPT[writeAct] Act 1: Synthetic");
  assert.equal(typeof line.messages[1].content, "string");
  assert.deepEqual(JSON.parse(line.messages[1].content), { seams: records[0].reply.seams });

  const allowed = sftLines(rows, { promptBuilder: builder, allowClaudeDerived: true, root });
  assert.equal(allowed.lines.length, 2);
  assert.equal(allowed.refused, 0);

  const out = [];
  assert.equal(await main(["export-sft", "--out", "data-local/training/sft.jsonl"], (l) => out.push(l), { root, promptBuilder: builder }), 0);
  const written = fs.readFileSync(path.join(root, "data-local", "training", "sft.jsonl"), "utf8").trim().split("\n");
  assert.equal(written.length, 1);
  for (const l of written) assert.ok(Array.isArray(JSON.parse(l).messages));
  assert.ok(out.some((l) => l.includes(`refused 1 claude-derived`) && l.includes(ALLOW_CLAUDE_FLAG)), out.join("\n"));
  assert.equal(await main(["export-sft", "--out", "data-local/training/sft-all.jsonl", ALLOW_CLAUDE_FLAG], () => {}, { root, promptBuilder: builder }), 0);
  assert.equal(fs.readFileSync(path.join(root, "data-local", "training", "sft-all.jsonl"), "utf8").trim().split("\n").length, 2);
});

/* MUTATION: drop the exampleId re-derivation in sftLines -> the edited file
   is exported. MUTATION: drop dataLocalRefusal in export-sft -> a file is
   written outside data-local/. */
test("export-sft refuses an exchanges file edited after build, and any --out outside data-local/", async () => {
  const root = tmpRoot();
  const dir = path.join(root, "data-local", "runs");
  writeRun(dir, "k", [exchange({ forayKey: "k" })]);
  const rows = buildExamples({ exchangeDirs: [dir], outcomes: [{ experiment: "E1", promptId: "p", actIndex: 0, dir, forayKey: "k", outcome: "win" }], root });
  writeRun(dir, "k", [exchange({ forayKey: "k", script: "Changed after build." })]);
  assert.throws(() => sftLines(rows, { promptBuilder: () => "p", root }), /no longer holds example/);

  const out = [];
  assert.equal(await main(["export-sft", "--out", "sft.jsonl"], (l) => out.push(l), { root, promptBuilder: () => "p" }), 1);
  assert.ok(!fs.existsSync(path.join(root, "sft.jsonl")));
  assert.match(out[0], /not under data-local/);
  assert.equal(await main(["build", "--out", "act-examples.jsonl"], () => {}, { root }), 1);
});

/* MUTATION: in main build, ignore --verdicts (always the default path) -> the
   verdict is not read and the row is unlabelled. */
test("the build CLI writes the ledger under data-local/ from exchanges and verdicts", async () => {
  const root = tmpRoot();
  const dir = path.join(root, "data-local", "swaps", "E1", "B");
  const candidateSha = writeRun(dir, "k", [exchange({ forayKey: "k" })], { id: "cand-k", items: [] });
  fs.mkdirSync(path.join(root, "data-local", "review"), { recursive: true });
  fs.writeFileSync(path.join(root, "data-local", "review", "mine.jsonl"), JSON.stringify(verdictRow("cand-k", 1, candidateSha, "pass")) + "\n");
  const out = [];
  assert.equal(await main(["build", "--verdicts", "data-local/review/mine.jsonl", "--cards", "none.jsonl"], (l) => out.push(l), { root }), 0);
  const ledger = fs.readFileSync(path.join(root, "data-local", "training", "act-examples.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(ledger.length, 1);
  assert.deepEqual([ledger[0].label, ledger[0].labelSource, ledger[0].finalRound, ledger[0].verified, ledger[0].claudeDerived], ["keep", "founder-verdict", true, true, false]);
  assert.match(out[0], /1 exchange\(s\), 1 labelled/);

  const counted = [];
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", "forays.json"), JSON.stringify({ forays: [] }));
  assert.equal(await main(["count", "--no-append"], (l) => counted.push(l), { root }), 0);
  assert.match(counted[0], /^usable act-level examples: 1 of 500/);
});

/* MUTATION: revert model-swaps.md's runner row to "not built yet", or delete
   the readiness markers -> this fails. */
test("model-swaps.md names the built runner, the training corpus and its readiness section", () => {
  const doc = fs.readFileSync(path.join(REPO, "docs", "curation", "model-swaps.md"), "utf8");
  assert.doesNotMatch(doc, /swap-experiment\.mjs` \(GV-75, not built yet\)/);
  assert.match(doc, /`tools\/generation-bench\/training-corpus\.mjs` \(GV-114\)/);
  assert.match(doc, /--allow-claude-derived/);
  assert.match(doc, /OQ-06/);
  const begin = doc.indexOf(READINESS_BEGIN);
  const end = doc.indexOf(READINESS_END);
  assert.ok(begin >= 0 && end > begin, "the readiness markers are in order");
  for (const l of doc.slice(begin + READINESS_BEGIN.length, end).split(/\r?\n/).filter((x) => x.trim() !== "")) {
    assert.match(l, /^- \d{4}-\d{2}-\d{2}: usable act-level examples: \d+ of 500 /);
  }
});

/* MUTATION: add `await fetch(` (or import node:https / child_process /
   anthropicCall) to training-corpus.mjs -> this fails. */
test("the tool reaches no network, no model, no child process and never writes data/forays.json", () => {
  const src = fs.readFileSync(path.join(HERE, "training-corpus.mjs"), "utf8");
  assert.doesNotMatch(src, /\bfetch\(|node:https?|from "https?"|anthropicCall|child_process|@anthropic-ai/);
  assert.doesNotMatch(src, /writeFileSync\([^)]*forays/);
});
