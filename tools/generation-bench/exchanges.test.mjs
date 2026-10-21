/* Tests for the writer exchange reader (GV-110). Run:
 *   node --test tools/generation-bench/exchanges.test.mjs
 *
 * WHAT IS AT RISK. The ledger (GV-114) counts only final-round exchanges,
 * and a reader that read a corrupt or foreign line as "no exchange", that
 * marked every round final, or that keyed the final round across two acts or
 * two attempts would quietly miscount it. Each test names the mutation that
 * breaks it; each was run against that mutation before this landed.
 *
 * THE LINES ARE SYNTHETIC: short invented windows, no prompt or transcript
 * text, written to a throwaway temp directory.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { EXCHANGE_SCHEMA, listExchanges, parseExchanges, readExchange } from "./exchanges.mjs";

const GENERATOR = { impl: "local", model: "qwen-test", machine: "spark" };

function exchange(over = {}) {
  return {
    schema: EXCHANGE_SCHEMA,
    forayKey: "synth-key",
    attempt: 1,
    actIndex: 0,
    actTitle: "Act 1: Synthetic",
    round: 1,
    call: "writeAct",
    generator: GENERATOR,
    request: {
      actTitle: "Act 1: Synthetic",
      seams: [{ seamId: "s0", beats: [] }],
      clips: [],
      documents: [{ docId: "tape:x#1", kind: "tape", title: "Show - Ep", text: "a short synthetic window" }]
    },
    reply: { seams: [{ seamId: "s0", script: "A line.", claims: [], usedClaims: [], pronunciationHints: [] }] },
    mechanical: [],
    verdict: { beats: [{ beatId: "b0", carried: true }, { beatId: "b1", carried: false, notes: "n" }], seams: [{ seamId: "s0", claimsSupported: true, restsOn: [], contestedHandled: true }] },
    recordedAt: "2026-10-21T00:00:00.000Z",
    ...over
  };
}

const jsonl = (records) => records.map((r) => JSON.stringify(r)).join("\n") + "\n";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gv110-exchanges-"));
}

/* Act 0: rounds 1 and 2 (round 1 refused in code). Act 1: round 1 only.
   Attempt 2 of act 0: round 1 only (a resumed run's own rounds). */
const RECORDS = [
  exchange({ round: 1, mechanical: ["seam s0: names neither the show"] }),
  exchange({ actIndex: 1, actTitle: "Act 2: Synthetic" }),
  exchange({ round: 2, call: "editSeams", verdict: undefined }),
  exchange({ attempt: 2 })
];

test("listExchanges indexes every line in order, without request or reply text", () => {
  const dir = tmpDir();
  const file = path.join(dir, "synth-key.exchanges.jsonl");
  fs.writeFileSync(file, jsonl(RECORDS));
  const rows = listExchanges(file);
  assert.equal(rows.length, 4);
  assert.deepEqual(
    rows.map((r) => [r.line, r.actIndex, r.round, r.attempt, r.call]),
    [
      [1, 0, 1, 1, "writeAct"],
      [2, 1, 1, 1, "writeAct"],
      [3, 0, 2, 1, "editSeams"],
      [4, 0, 1, 2, "writeAct"]
    ]
  );
  assert.deepEqual(rows[0].generator, GENERATOR);
  assert.equal(rows[0].mechanical, 1);
  assert.equal(rows[0].clean, false);
  assert.equal(rows[1].clean, true);
  assert.deepEqual(rows[0].verdict, { beatsJudged: 2, beatsCarried: 1, seamsJudged: 1, seamsSupported: 1 });
  /* A round with no verifier call has no verdict, not a zero one. */
  assert.equal(rows[2].verdict, null);
  /* No row carries the request, the reply or the window text. */
  for (const r of rows) {
    assert.equal("request" in r, false);
    assert.equal("reply" in r, false);
    assert.equal(JSON.stringify(r).includes("synthetic window"), false);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

/* MUTATION: `finalRound: true` for every row -> red (row 1 is not final).
   MUTATION: key the last round by forayKey alone -> red (act 1's round 1 and
   attempt 2's round 1 read as not final). */
test("finalRound marks the last recorded round of each act of each attempt", () => {
  const dir = tmpDir();
  const file = path.join(dir, "synth-key.exchanges.jsonl");
  fs.writeFileSync(file, jsonl(RECORDS));
  assert.deepEqual(
    listExchanges(file).map((r) => r.finalRound),
    [false, true, true, true]
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

/* MUTATION: drop the recursive walk (read only the top directory) -> red. */
test("a directory is searched recursively for *.exchanges.jsonl files, and nothing else is read", () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, "arm-a"), { recursive: true });
  fs.mkdirSync(path.join(dir, "arm-b", "deep"), { recursive: true });
  fs.writeFileSync(path.join(dir, "arm-a", "k1.exchanges.jsonl"), jsonl([exchange({ forayKey: "k1" })]));
  fs.writeFileSync(path.join(dir, "arm-b", "deep", "k2.exchanges.jsonl"), jsonl([exchange({ forayKey: "k2" }), exchange({ forayKey: "k2", round: 2 })]));
  fs.writeFileSync(path.join(dir, "arm-b", "report.json"), "{not an exchange");
  const rows = listExchanges(dir);
  assert.deepEqual(
    rows.map((r) => [path.basename(r.file), r.forayKey, r.round]),
    [
      ["k1.exchanges.jsonl", "k1", 1],
      ["k2.exchanges.jsonl", "k2", 1],
      ["k2.exchanges.jsonl", "k2", 2]
    ]
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

/* MUTATION: `hit = parsed[line - 1]` (index, not file line) -> red (blank
   lines shift it). */
test("readExchange returns the whole record on its file line, blank lines counted", () => {
  const dir = tmpDir();
  const file = path.join(dir, "synth-key.exchanges.jsonl");
  fs.writeFileSync(file, `${JSON.stringify(RECORDS[0])}\n\n${JSON.stringify(RECORDS[1])}\n`);
  const rec = readExchange(file, 3);
  assert.equal(rec.actIndex, 1);
  assert.deepEqual(rec.request, RECORDS[1].request);
  assert.deepEqual(rec.reply, RECORDS[1].reply);
  assert.equal(listExchanges(file)[1].line, 3);
  assert.throws(() => readExchange(file, 2), /no exchange on line 2/);
  fs.rmSync(dir, { recursive: true, force: true });
});

/* MUTATION: skip a line whose schema differs (instead of throwing) -> red.
   MUTATION: drop the required-field check -> red. */
test("a corrupt, foreign or incomplete line is refused, naming its line", () => {
  assert.throws(() => parseExchanges(`${JSON.stringify(exchange())}\n{oops\n`, "f"), /f: line 2 is not JSON/);
  assert.throws(() => parseExchanges(JSON.stringify({ ...exchange(), schema: "runlog/1" }), "f"), /line 1 is not a writer-exchange\/1 line/);
  const { request: _r, ...noRequest } = exchange();
  assert.throws(() => parseExchanges(JSON.stringify(noRequest), "f"), /line 1 has no request/);
  assert.throws(() => parseExchanges(JSON.stringify(exchange({ call: "verifyAct" })), "f"), /unknown call/);
  assert.throws(() => parseExchanges(JSON.stringify(exchange({ actIndex: -1 })), "f"), /no act index/);
  assert.throws(() => parseExchanges(JSON.stringify(exchange({ round: 0 })), "f"), /no round/);
  assert.deepEqual(parseExchanges("\n\n"), []);
});
