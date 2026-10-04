/* The pad ledger's collector (tools/segments/probe-ad-pad.mjs, DAI-04). Run:
   node --test tools/segments/probe-ad-pad.test.mjs

   No network and no spawn: every probe is an injected fake. Every test names
   the one-line mutation that turns it red. */

import test from "node:test";
import assert from "node:assert/strict";
import { selectRows, probeRow, appendProbes, run } from "./probe-ad-pad.mjs";

const sourcesDoc = {
  version: 1,
  sources: [
    { id: "dai-ok", audio_url: "https://pscrb.fm/rss/p/a.mp3", audio_bytes: 35_549_607, dai_suspected: true },
    { id: "dai-no-bytes", audio_url: "https://www.buzzsprout.com/1/2.mp3", dai_suspected: true },
    { id: "dai-no-url", audio_bytes: 30_000_000, dai_suspected: true },
    { id: "clean", audio_url: "https://media.transistor.fm/c.mp3", audio_bytes: 20_000_000, dai_suspected: false },
  ],
};

const delivered = (overrides = {}) => async (url, declared) => ({
  ratio: 44_961_612 / declared,
  declared_bytes: declared,
  delivered_bytes: 44_961_612,
  status: 206,
  attempts: 1,
  error: null,
  ...overrides,
});
const at = (iso) => () => new Date(iso);
const emptyLedger = () => ({ version: 1, notes: "n", probes: [] });
const quiet = () => {};

test("selectRows takes DAI rows with a denominator and names the rest", () => {
  // MUTATION: drop the `audio_bytes > 0` check -> dai-no-bytes lands in rows.
  const { rows, skipped } = selectRows(sourcesDoc);
  assert.deepEqual(rows.map((r) => r.id), ["dai-ok"]);
  assert.deepEqual(skipped, [
    { id: "dai-no-bytes", reason: "no audio_bytes" },
    { id: "dai-no-url", reason: "no audio_url" },
  ]);
});

test("selectRows by id ignores the DAI flag, and --all takes every row", () => {
  // MUTATION: ignore `ids` (always filter on dai_suspected) -> "clean" is not selected.
  assert.deepEqual(selectRows(sourcesDoc, { ids: ["clean"] }).rows.map((r) => r.id), ["clean"]);
  // MUTATION: ignore `all` -> "clean" is missing.
  assert.deepEqual(selectRows(sourcesDoc, { all: true }).rows.map((r) => r.id), ["dai-ok", "clean"]);
});

test("probeRow records the evidence, not a verdict", async () => {
  // MUTATION: add `ratio: p.ratio` to the returned row -> `"ratio" in row` is true.
  const row = await probeRow(sourcesDoc.sources[0], { probe: delivered(), now: at("2026-10-04T12:00:00.000Z") });
  assert.deepEqual(row, {
    item_id: "dai-ok",
    probed_at: "2026-10-04T12:00:00.000Z",
    method: "ranged-get",
    host: "pscrb.fm",
    status: 206,
    attempts: 1,
    declared_bytes: 35_549_607,
    delivered_bytes: 44_961_612,
  });
  assert.equal("ratio" in row, false);
});

test("a probe with no delivered length is not appended", async () => {
  // MUTATION: drop the `delivered_bytes == null` guard in probeRow -> a row with
  // delivered_bytes null is appended and `failed` is empty.
  const probe = delivered({ delivered_bytes: null, ratio: null, status: 403, error: "HTTP 403" });
  assert.equal(await probeRow(sourcesDoc.sources[0], { probe }), null);
  const ledger = emptyLedger();
  const r = await run({ sourcesDoc, ledger, probe, now: at("2026-10-04T12:00:00Z"), log: quiet });
  assert.equal(r.ledger.probes.length, 0);
  assert.deepEqual(r.failed, [{ item_id: "dai-ok", error: "HTTP 403" }]);
});

test("a second probe inside the gap is refused, one outside it is appended", () => {
  // MUTATION: default minGapHours 24 -> 0 -> the 23 h probe is appended.
  const first = { item_id: "dai-ok", probed_at: "2026-10-04T00:00:00.000Z", method: "ranged-get" };
  const ledger = { ...emptyLedger(), probes: [first] };
  const in23 = { ...first, probed_at: "2026-10-04T23:00:00.000Z" };
  const in25 = { ...first, probed_at: "2026-10-05T01:00:00.000Z" };
  const soon = appendProbes(ledger, [in23]);
  assert.deepEqual(soon.tooSoon, [{ item_id: "dai-ok", last: "2026-10-04T00:00:00.000Z" }]);
  assert.deepEqual(soon.appended, []);
  const later = appendProbes(ledger, [in25]);
  assert.deepEqual(later.appended, [in25]);
  assert.deepEqual(later.ledger.probes, [first, in25]);
  // Exactly 24 h is outside the gap ("strictly less than").
  // MUTATION: `<` -> `<=` in probeInsideGap -> the 24 h probe is refused.
  const in24 = { ...first, probed_at: "2026-10-05T00:00:00.000Z" };
  assert.deepEqual(appendProbes(ledger, [in24]).appended, [in24]);
});

test("appendProbes returns a new ledger and never mutates its input", () => {
  // MUTATION: `const out = ledger` (push into the input) -> ledger.probes grows.
  const ledger = emptyLedger();
  const p = { item_id: "dai-ok", probed_at: "2026-10-04T00:00:00.000Z", method: "ranged-get" };
  const r = appendProbes(ledger, [p]);
  assert.notEqual(r.ledger, ledger);
  assert.equal(ledger.probes.length, 0);
  assert.equal(r.ledger.probes.length, 1);
  assert.equal(r.ledger.notes, "n");
});

test("run with dryRun returns the input ledger object untouched", async () => {
  // MUTATION: return `merged.ledger` regardless of dryRun -> result.ledger !== ledger.
  const ledger = emptyLedger();
  const dry = await run({ sourcesDoc, ledger, dryRun: true, probe: delivered(), now: at("2026-10-04T12:00:00Z"), log: quiet });
  assert.equal(dry.ledger, ledger);
  assert.equal(ledger.probes.length, 0);
  const wet = await run({ sourcesDoc, ledger, probe: delivered(), now: at("2026-10-04T12:00:00Z"), log: quiet });
  assert.notEqual(wet.ledger, ledger);
  assert.equal(wet.ledger.probes.length, 1);
  assert.equal(wet.appended[0].item_id, "dai-ok");
  assert.deepEqual(wet.skipped.map((s) => s.id), ["dai-no-bytes", "dai-no-url"]);
});

test("run spends no request on a row already probed inside the gap", async () => {
  // MUTATION: delete the pre-probe `probeInsideGap` check in run -> the fake is
  // called once (appendProbes still refuses the row, but the host was asked).
  let calls = 0;
  const probe = async (...a) => { calls++; return delivered()(...a); };
  const ledger = { ...emptyLedger(), probes: [{ item_id: "dai-ok", probed_at: "2026-10-04T00:00:00.000Z", method: "ranged-get" }] };
  const r = await run({ sourcesDoc, ledger, probe, now: at("2026-10-04T10:00:00Z"), log: quiet });
  assert.equal(calls, 0);
  assert.deepEqual(r.tooSoon, [{ item_id: "dai-ok", last: "2026-10-04T00:00:00.000Z" }]);
  assert.equal(r.ledger.probes.length, 1);
});
