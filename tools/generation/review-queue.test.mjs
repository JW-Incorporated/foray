/* Tests for the review queue (GV-41: W6-16, R2-19).
 * Run: node --test tools/generation/review-queue.test.mjs
 *
 * WHAT IS AT RISK
 * The queue decides what the founder reviews first and turns his per-act
 * verdict into the labelled rows GV-81 (promotion), GV-94 and GV-103
 * (calibration) read. Its quiet failures: a candidate with unverified pages
 * sorting below a clean one; a later risk rule overriding an earlier one; a
 * card that drops or reorders a script or a clip; a verdict row whose scores
 * card.mjs would refuse, or whose sha is not the candidate's; a second axis
 * list drifting from card.mjs; and the report's prompt leaking into any output.
 *
 * Ranking uses the committed out-9 bench report (tools/generation-bench/
 * fixtures/out-9) plus the synthetic tools/generation/fixtures/review report;
 * cards and verdicts use the synthetic candidate (short made-up scripts, no
 * transcript text) because the committed out-9 candidate is trimmed and has
 * no scripts. Verdicts are written to a temp directory, never data-local/.
 *
 * MUTATIONS (each applied to review-queue.mjs, each turned this suite red):
 *   M1  rule 1 (unverifiedPages > 0) deleted from compareRisk
 *   M2  rule 2 flags groundedQuoteRate <= 1 instead of < 1
 *   M3  rule 2 treats a null groundedQuoteRate as < 1
 *   M4  purposeFidelity sorted descending (nulls still worst)
 *   M5  null purposeFidelity sorted best (last) instead of worst
 *   M6  tapeRelevance read before clipOnSubjectRate
 *   M7  retryRounds sorted ascending
 *   M8  spineReasks sorted ascending
 *   M9  the forayId tiebreak deleted
 *   M10 committed pool read before the candidate's own segmentSources
 *   M11 the act-count check in buildVerdict deleted
 *   M12 axisErrors returns [] (card.mjs's validation bypassed)
 *   M13 candidateSha256 hashed from the re-serialised JSON, not the bytes
 *   M14 loadDir copies entry.prompt onto the row
 *   M15 clips dropped from the card's play order
 *   M16 appendVerdict writes the file instead of appending to it
 *   M17 parseWince keeps the surrounding quotes
 */

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AXES, CARD_SCHEMA, Q06_KEYS, validateCard } from "../listening/card.mjs";
import {
  VERDICT_SCHEMA,
  actTitle,
  appendVerdict,
  axisErrors,
  buildActCard,
  buildVerdict,
  compareRisk,
  describeClip,
  findRow,
  formatActCard,
  loadDir,
  main,
  parseScores,
  parseWince,
  rankRows,
  readVerdicts,
  validateVerdict
} from "./review-queue.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const OUT9 = path.join(ROOT, "tools", "generation-bench", "fixtures", "out-9");
const REVIEW = path.join(HERE, "fixtures", "review");
const CANDIDATE_A = path.join(REVIEW, "candidate-a.json");
const A_ID = "synthetic-review-a-5c1e0d";
const OUT9_ID = "what-engineers-actually-do-all-day-731735";
const SENTINEL = "PROMPT-SENTINEL-7f3a";
const OUT9_PROMPT = JSON.parse(fs.readFileSync(path.join(OUT9, "report.json"), "utf8")).entries[0].prompt;
const EMPTY_POOLS = { segments: new Map(), sources: new Map() };
const GOOD_SCORES = "onSubject=4,flowsAtSeams=3,oneNarrator=5,nothingFalseOrOdd=4";
const AT = "2026-10-12T09:30:00Z";

function capture(argv) {
  const lines = [];
  const result = main(argv, (l) => lines.push(String(l)));
  return { result, text: lines.join("\n") };
}

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "review-queue-"));
  return path.join(dir, "review", "verdicts.jsonl");
}

const row = (forayId, veracity, spineReasks = 0) => ({ forayId, veracity, spineReasks });
/* A row that is best on every rule. */
const CLEAN = { unverifiedPages: 0, groundedQuoteRate: 1, purposeFidelity: 1, tapeRelevance: 1, retryRounds: 0 };

/* ------------------------------------------------------------------ */
/* Ranking                                                             */
/* ------------------------------------------------------------------ */

test("out-9 plus a synthetic report: the candidate with unverified pages ranks first, whichever dir is named first", () => {
  for (const dirs of [
    [OUT9, REVIEW],
    [REVIEW, OUT9]
  ]) {
    const { result, text } = capture(["list", ...dirs.flatMap((d) => ["--dir", d])]);
    assert.deepEqual(
      result.map((r) => r.forayId),
      [OUT9_ID, A_ID]
    );
    assert.equal(result[0].veracity.unverifiedPages, 8);
    assert.match(text.split("\n")[1], new RegExp(`^1  ${OUT9_ID}  4  8  `));
    assert.match(text, /1 report entry has no candidate file and is not reviewable/);
  }
});

test("rule 1: unverified pages outrank every later rule", () => {
  const risky = row("z-risky", { ...CLEAN, unverifiedPages: 1 });
  const worstElsewhere = row("a-other", { unverifiedPages: 0, groundedQuoteRate: 0.1, purposeFidelity: null, tapeRelevance: null, retryRounds: 9 }, 9);
  assert.deepEqual(
    rankRows([worstElsewhere, risky]).map((r) => r.forayId),
    ["z-risky", "a-other"]
  );
});

test("rule 2: groundedQuoteRate below 1 outranks rules 3-6; exactly 1 and null are not flagged", () => {
  const ungrounded = row("z-ungrounded", { ...CLEAN, groundedQuoteRate: 0.9 });
  const other = row("a-other", { ...CLEAN, purposeFidelity: null, tapeRelevance: null, retryRounds: 9 }, 9);
  assert.deepEqual(
    rankRows([other, ungrounded]).map((r) => r.forayId),
    ["z-ungrounded", "a-other"]
  );
  /* 1 and null tie on rule 2, so rule 3 decides (the null-grounded row has the worse purpose). */
  const one = row("a-one", { ...CLEAN, purposeFidelity: 0.2 });
  const none = row("z-none", { ...CLEAN, groundedQuoteRate: null, purposeFidelity: 0.5 });
  assert.deepEqual(
    rankRows([none, one]).map((r) => r.forayId),
    ["a-one", "z-none"]
  );
});

test("rule 3: purposeFidelity ascending, null worst, and it outranks rules 4-6", () => {
  const rows = [row("a-high", { ...CLEAN, purposeFidelity: 0.9, tapeRelevance: 0, retryRounds: 9 }, 9), row("b-low", { ...CLEAN, purposeFidelity: 0.2 }), row("c-null", { ...CLEAN, purposeFidelity: null })];
  assert.deepEqual(
    rankRows(rows).map((r) => r.forayId),
    ["c-null", "b-low", "a-high"]
  );
});

test("rule 4: clipOnSubjectRate when present, otherwise tapeRelevance, ascending with null worst", () => {
  /* a's tapeRelevance is the lowest, but its clipOnSubjectRate is present and high. */
  const a = row("a-clip-high", { ...CLEAN, tapeRelevance: 0, clipOnSubjectRate: 0.95 });
  const b = row("b-clip-low", { ...CLEAN, tapeRelevance: 1, clipOnSubjectRate: 0.4 });
  const c = row("c-tape-mid", { ...CLEAN, tapeRelevance: 0.6 });
  const d = row("d-none", { ...CLEAN, tapeRelevance: null }, 0);
  const e = row("e-retries", { ...CLEAN, tapeRelevance: 1, clipOnSubjectRate: 0.99, retryRounds: 9 }, 9);
  assert.deepEqual(
    rankRows([a, b, c, d, e]).map((r) => r.forayId),
    ["d-none", "b-clip-low", "c-tape-mid", "a-clip-high", "e-retries"]
  );
});

test("rules 5 and 6: retryRounds then spineReasks descending, then forayId", () => {
  const rows = [row("a-quiet", { ...CLEAN }), row("b-reasked", { ...CLEAN }, 2), row("c-retried", { ...CLEAN, retryRounds: 3 }, 0), row("d-retried-less", { ...CLEAN, retryRounds: 1 }, 5)];
  assert.deepEqual(
    rankRows(rows).map((r) => r.forayId),
    ["c-retried", "d-retried-less", "b-reasked", "a-quiet"]
  );
  /* A full tie is ordered by forayId, so the queue is the same on every machine. */
  assert.ok(compareRisk(row("a", CLEAN), row("b", CLEAN)) < 0);
  assert.ok(compareRisk(row("b", CLEAN), row("a", CLEAN)) > 0);
});

test("loadDir reads the risk inputs and never the prompt; list output carries no prompt", () => {
  const { rows, skipped } = loadDir(REVIEW);
  assert.equal(skipped, 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].forayId, A_ID);
  assert.equal(rows[0].spineReasks, 1);
  assert.equal(rows[0].acts, 2);
  assert.ok(!("prompt" in rows[0]));
  for (const argv of [
    ["list", "--dir", OUT9, "--dir", REVIEW],
    ["list", "--dir", OUT9, "--dir", REVIEW, "--json"]
  ]) {
    const { text } = capture(argv);
    assert.ok(!text.includes(SENTINEL), "the synthetic prompt leaked");
    assert.ok(!text.includes(OUT9_PROMPT.slice(0, 40)), "the out-9 prompt leaked");
  }
});

/* ------------------------------------------------------------------ */
/* Cards                                                               */
/* ------------------------------------------------------------------ */

test("the card lists every narration script and every clip of the act in play order", () => {
  const candidate = JSON.parse(fs.readFileSync(CANDIDATE_A, "utf8"));
  const card = buildActCard(candidate, 1, { pools: EMPTY_POOLS });
  /* Act 1 is everything before act-2-introduction (the disclosure included). */
  const expected = candidate.items.slice(0, candidate.items.findIndex((i) => i.id === "act-2-introduction"));
  assert.deepEqual(
    card.play.map((p) => p.kind),
    expected.map((i) => (i.type === "segment" ? "clip" : i.type))
  );
  const text = formatActCard(card);
  let at = -1;
  for (const item of expected) {
    const needle = item.type === "narration" ? item.script : item.type === "segment" ? item.segment_id : "Jingle";
    const next = text.indexOf(needle, at + 1);
    assert.ok(next > at, `${needle} is missing or out of order`);
    at = next;
  }
  assert.match(text, /Clip: Synthetic Show A · "Episode 12: The load test" · 0:40\.5-2:32\.3 \(111\.8 s\) · boundary turn/);
  assert.match(text, /Clip: Synthetic Show B · "Episode 3: Wind" · 5:10\.0-6:35\.5 \(85\.5 s\) · boundary sentence/);
  assert.equal(card.title, "The first load / What the wind taught");
  assert.deepEqual(card.metrics, { items: 8, narrationItems: 5, narrationWords: 46, scriptsMissing: 0, clips: 2, unresolvedClips: 0, clipSec: 197.3 });
  /* Act 2 starts at its own introduction and holds its one clip. */
  const two = buildActCard(candidate, 2, { pools: EMPTY_POOLS });
  assert.deepEqual(
    two.play.map((p) => p.id ?? p.segmentId),
    ["act-2-introduction", "synthetic-show-a--ep-14#1200", "narration-act-2-1-beat", "act-2-exit"]
  );
});

test("a clip's show and episode come from the candidate's segmentSources before the committed pool", () => {
  const candidate = JSON.parse(fs.readFileSync(CANDIDATE_A, "utf8"));
  const pools = {
    segments: new Map([["pool-only#5", { id: "pool-only#5", item_id: "pool-ep", start_sec: 5, end_sec: 65 }]]),
    sources: new Map([
      ["synthetic-show-a--ep-12", { id: "synthetic-show-a--ep-12", show: "WRONG SHOW", title: "WRONG EPISODE" }],
      ["pool-ep", { id: "pool-ep", show: "Pool Show", title: "Pool Episode" }]
    ])
  };
  const own = describeClip("synthetic-show-a--ep-12#40", candidate, pools);
  assert.equal(own.show, "Synthetic Show A");
  assert.equal(own.episode, "Episode 12: The load test");
  const fromPool = describeClip("pool-only#5", candidate, pools);
  assert.deepEqual(fromPool, { segmentId: "pool-only#5", show: "Pool Show", episode: "Pool Episode", startSec: 5, endSec: 65, boundary: null });
  assert.equal(describeClip("nowhere#1", candidate, pools).unresolved, "segment not found");
});

test("the act title: a partial candidate's acts[].title, else the act's slot titles", () => {
  const candidate = JSON.parse(fs.readFileSync(CANDIDATE_A, "utf8"));
  const items = [{ type: "narration", id: "x", slot: "fixing-it-in-the-field" }];
  assert.equal(actTitle(candidate, 2, items), "Fixing it in the field");
  assert.equal(actTitle({ ...candidate, acts: [{ index: 1, title: "Repair", status: "ready" }] }, 2, items), "Repair");
  assert.equal(actTitle({ id: "x" }, 3, []), "Act 3");
});

test("card CLI: every act by default, one with --act, an act that does not exist refused, no prompt", () => {
  const all = capture(["card", A_ID, "--dir", REVIEW, "--segments", path.join(REVIEW, "none.json")]);
  assert.equal(all.result.length, 2);
  assert.match(all.text, /# synthetic-review-a-5c1e0d · act 1 of 2/);
  assert.match(all.text, /# synthetic-review-a-5c1e0d · act 2 of 2/);
  assert.match(all.text, /narrate time 41\.0 s/);
  assert.match(all.text, /- tapeRelevance 0\.80 · retryRounds 1 · spineReasks 1/);
  assert.ok(!all.text.includes(SENTINEL));
  const one = capture(["card", A_ID, "--dir", REVIEW, "--act", "2"]);
  assert.equal(one.result.length, 1);
  assert.ok(!one.text.includes("act 1 of 2"));
  assert.throws(() => capture(["card", A_ID, "--dir", REVIEW, "--act", "3"]), /has 2 act\(s\); there is no act 3/);
  assert.throws(() => capture(["card", "no-such-foray", "--dir", REVIEW]), /no candidate with id no-such-foray/);
  const out9 = capture(["card", OUT9_ID, "--dir", OUT9, "--act", "1"]);
  assert.ok(!out9.text.includes(OUT9_PROMPT.slice(0, 40)));
  assert.match(out9.text, /\(no script in this candidate\)/);
});

/* ------------------------------------------------------------------ */
/* Verdicts                                                            */
/* ------------------------------------------------------------------ */

test("verdict appends exactly one line whose scores pass card.mjs, with the candidate file's sha", () => {
  const store = tmpStore();
  const { result, text } = capture(["verdict", A_ID, "--dir", REVIEW, "--act", "2", "--verdict", "fix", "--scores", GOOD_SCORES, "--wince", "132:'the second clip starts mid-word'", "--out", store, "--at", AT]);
  assert.match(text, /appended a fix verdict for synthetic-review-a-5c1e0d act 2/);
  const lines = fs.readFileSync(store, "utf8").split("\n");
  assert.equal(lines.length, 2);
  assert.equal(lines[1], "");
  const written = JSON.parse(lines[0]);
  assert.deepEqual(written, result);
  const sha = crypto.createHash("sha256").update(fs.readFileSync(CANDIDATE_A)).digest("hex");
  assert.deepEqual(written, {
    schema: VERDICT_SCHEMA,
    forayId: A_ID,
    act: 2,
    candidateSha256: sha,
    lane: "catalogue",
    verdict: "fix",
    scores: { onSubject: 4, flowsAtSeams: 3, oneNarrator: 5, nothingFalseOrOdd: 4 },
    winces: [{ atSec: 132, note: "the second clip starts mid-word" }],
    reviewer: "founder",
    at: AT
  });
  /* The scores and winces are a valid listen-card/1 by card.mjs's own check. */
  const card = { schema: CARD_SCHEMA, cardId: "c1", packId: "p1", label: "solo", act: 2, listener: "founder", listenedAt: AT, scores: written.scores, overall: 3, q06: Object.fromEntries(Q06_KEYS.map((k) => [k, true])), winces: written.winces };
  assert.deepEqual(validateCard(card), { ok: true, errors: [] });
  assert.deepEqual(Object.keys(written.scores), [...AXES]);
  assert.ok(!lines[0].includes(SENTINEL));
  assert.ok(!("prompt" in written));
  assert.deepEqual(readVerdicts(store), [written]);
});

test("verdict refuses a score outside 1-5, an axis card.mjs does not define, a missing axis and an act that does not exist", () => {
  const store = tmpStore();
  const base = ["verdict", A_ID, "--dir", REVIEW, "--verdict", "pass", "--out", store, "--at", AT];
  const refusals = [
    [["--act", "1", "--scores", "onSubject=6,flowsAtSeams=3,oneNarrator=5,nothingFalseOrOdd=4"], /scores\.onSubject must be an integer 1-5/],
    [["--act", "1", "--scores", "onSubject=0,flowsAtSeams=3,oneNarrator=5,nothingFalseOrOdd=4"], /scores\.onSubject must be an integer 1-5/],
    [["--act", "1", "--scores", "onSubject=3.5,flowsAtSeams=3,oneNarrator=5,nothingFalseOrOdd=4"], /scores\.onSubject must be an integer 1-5/],
    [["--act", "1", "--scores", "onSubject=x,flowsAtSeams=3,oneNarrator=5,nothingFalseOrOdd=4"], /scores\.onSubject must be an integer 1-5/],
    [["--act", "1", "--scores", `${GOOD_SCORES},pacing=4`], /scores\.pacing is not an axis/],
    [["--act", "1", "--scores", "onSubject=4,flowsAtSeams=3,oneNarrator=5"], /scores\.nothingFalseOrOdd is missing/],
    [["--act", "1", "--scores", `${GOOD_SCORES},onSubject=2`], /onSubject is given twice/],
    [["--act", "3", "--scores", GOOD_SCORES], /has 2 act\(s\); there is no act 3/],
    [["--act", "0", "--scores", GOOD_SCORES], /--act must be an integer >= 1/],
    [["--scores", GOOD_SCORES], /verdict needs --act N/],
    [["--act", "1", "--scores", GOOD_SCORES, "--wince", `5:${"x".repeat(281)}`], /winces\[0\]\.note is over 280 characters/]
  ];
  for (const [extra, message] of refusals) assert.throws(() => capture([...base, ...extra]), message, extra.join(" "));
  assert.throws(() => capture(["verdict", A_ID, "--dir", REVIEW, "--act", "1", "--verdict", "maybe", "--scores", GOOD_SCORES, "--out", store]), /verdict must be one of pass, fail, fix/);
  assert.throws(() => capture([...base, "--act", "1", "--scores", GOOD_SCORES, "--lane", "express"]), /--lane must be one of catalogue, on-demand/);
  assert.equal(fs.existsSync(store), false, "a refused verdict wrote nothing");
});

test("appending keeps every earlier byte, and a store with a bad line is not appended to", () => {
  const store = tmpStore();
  capture(["verdict", A_ID, "--dir", REVIEW, "--act", "1", "--verdict", "pass", "--scores", GOOD_SCORES, "--out", store, "--at", AT]);
  const first = fs.readFileSync(store, "utf8");
  capture(["verdict", A_ID, "--dir", REVIEW, "--act", "2", "--verdict", "fail", "--scores", GOOD_SCORES, "--lane", "on-demand", "--out", store, "--at", AT]);
  const both = fs.readFileSync(store, "utf8");
  assert.ok(both.startsWith(first));
  assert.deepEqual(
    readVerdicts(store).map((r) => [r.act, r.verdict, r.lane]),
    [
      [1, "pass", "catalogue"],
      [2, "fail", "on-demand"]
    ]
  );
  fs.appendFileSync(store, '{"schema":"foray-review-verdict/1","prompt":"x"}\n');
  assert.throws(() => capture(["verdict", A_ID, "--dir", REVIEW, "--act", "1", "--verdict", "pass", "--scores", GOOD_SCORES, "--out", store, "--at", AT]), /verdicts\.jsonl:3: unknown field "prompt"/);
  assert.deepEqual(readVerdicts(tmpStore()), []);
});

test("validateVerdict: no prompt or other extra field, a sha-256, a zoned time, the founder as reviewer", () => {
  const good = buildVerdict({ row: findRow([REVIEW], A_ID), act: 1, verdict: "pass", scores: parseScores(GOOD_SCORES), at: AT });
  assert.deepEqual(validateVerdict(good), { ok: true, errors: [] });
  const bad = (patch) => validateVerdict({ ...good, ...patch }).errors.join("; ");
  assert.match(bad({ prompt: "x" }), /unknown field "prompt"/);
  assert.match(bad({ candidateSha256: "abc" }), /candidateSha256 must be a sha-256/);
  assert.match(bad({ at: "2026-10-12T09:30:00" }), /at must be an ISO 8601 date-time with a zone/);
  assert.match(bad({ reviewer: "agent" }), /reviewer must be "founder"/);
  assert.match(bad({ schema: "listen-card/1" }), /schema must be "foray-review-verdict\/1"/);
  assert.match(bad({ winces: [{ atSec: -1, note: "x" }] }), /winces\[0\]\.atSec must be seconds >= 0/);
  assert.equal(validateVerdict("x").ok, false);
});

test("scores and winces are validated by card.mjs, and this module defines no axis list of its own", () => {
  assert.deepEqual(axisErrors(Object.fromEntries(AXES.map((a) => [a, 3])), []), []);
  assert.match(axisErrors({ ...Object.fromEntries(AXES.map((a) => [a, 3])), extra: 3 }, []).join("; "), /scores\.extra is not an axis/);
  assert.deepEqual(parseWince("132:'too fast'"), { atSec: 132, note: "too fast" });
  assert.deepEqual(parseWince("7.5:a: colon inside"), { atSec: 7.5, note: "a: colon inside" });
  assert.throws(() => parseWince("no seconds"), /is not <seconds>:<note>/);
  const src = fs.readFileSync(path.join(HERE, "review-queue.mjs"), "utf8");
  for (const axis of AXES) assert.ok(!new RegExp(`["'\`]${axis}["'\`]`).test(src), `${axis} is spelled as a literal in review-queue.mjs`);
  assert.match(src, /import \{[^}]*\bAXES\b[^}]*\bvalidateCard\b[^}]*\} from "\.\.\/listening\/card\.mjs"/);
});
