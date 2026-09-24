/* The rows and number-format families (NE-10j): what makes them a recording of
   the real JS writers rather than a hand-kept copy of them.

   run.test.js already runs every case against the reference. What it cannot
   say is WHERE the reference came from: a rows case whose `expect` was typed by
   hand and happened to match would pass there, and so would an adapter in
   rows.js that built its own row. These tests close that gap from both ends —
   the recorded bytes are what the builders produce, and the page's own writers
   (with no injected clock) produce the same bytes. */

import test from "node:test";
import assert from "node:assert/strict";
import { REPO_ROOT, loadFixtures } from "./runner.js";
import { decodeSpecial } from "./codec.js";
import { makeLastEpisode, KEY as LAST_EPISODE_KEY } from "../episode-progress.js";
import { PositionStore, makePositionRecord } from "../position-store.js";
import { makeProgress, progressKey } from "../foray-progress.js";

const casesOf = (family) => loadFixtures(REPO_ROOT, { family }).flatMap((fx) => fx.doc.cases);

class MapStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}

test("rows and number-format are recorded, never authored, and every case has its expect", () => {
  // The card's acceptance: recorded from the builders, not hand-written. An
  // authored case is one record.mjs will never overwrite — the wrong status
  // for a row whose bytes must follow the JS builder wherever it goes.
  // MUTATION: add "authored": true to any rows case -> red.
  const rows = casesOf("rows");
  const nums = casesOf("number-format");
  assert.ok(rows.length >= 40 && nums.length >= 20, `rows ${rows.length}, number-format ${nums.length}: a family was gutted`);
  for (const c of [...rows, ...nums]) {
    assert.notEqual(c.authored, true, `${c.id} is authored; these families are recordings`);
    assert.ok("expect" in c, `${c.id} was never recorded`);
  }
});

test("every recorded cp_last_episode row is makeLastEpisode's output, byte for byte", () => {
  // Rebuilt here from the case's own inputs with the real builder, so a
  // hand-edited expect, or an adapter that built the row itself, is caught.
  // MUTATION: swap "show" and "title" in episode-progress.js SNAPSHOT_FIELDS
  // -> red here (and in run.test.js / record.mjs --check).
  const cases = casesOf("rows").filter((c) => c.call === "cpLastEpisodeRow");
  assert.ok(cases.length >= 5, "the cp_last_episode cases are gone");
  let written = 0;
  for (const c of cases) {
    const [item, nowMs] = decodeSpecial(c.args);
    const record = makeLastEpisode(item, { now: nowMs });
    const want = record ? [{ key: LAST_EPISODE_KEY, value: JSON.stringify(record) }] : [];
    assert.deepStrictEqual(c.expect.return, want, c.id);
    written += want.length;
  }
  assert.ok(written >= 5, "no cp_last_episode case writes a row");
});

test("every recorded cp_foray row is makeProgress's output, byte for byte", () => {
  // MUTATION: move `index` above `total_sec` in foray-progress.js makeProgress -> red.
  const cases = casesOf("rows").filter((c) => c.call === "cpForayRow");
  assert.ok(cases.length >= 10, "the cp_foray cases are gone");
  for (const c of cases) {
    if (!c.expect.return.length) continue; // a refusal: the store's rule, pinned by the case itself
    const [p, nowMs] = decodeSpecial(c.args);
    const want = [{ key: progressKey(p.forayId), value: JSON.stringify(makeProgress({ ...p, now: new Date(nowMs) })) }];
    assert.deepStrictEqual(c.expect.return, want, c.id);
  }
});

test("the page's PositionStore, on the wall clock, writes exactly makePositionRecord's bytes", () => {
  // NE-10j extracted the row builder out of save() and made the clock
  // injectable, so the recorder can fix `updated_at`. This is the shipping
  // configuration — client.js injects no clock — and it must still stamp the
  // wall clock and still write the recorded shape.
  // MUTATION: default the constructor's `now` to () => new Date(0) -> red;
  // build save()'s record inline again with `source` first -> red.
  const storage = new MapStorage();
  const before = Date.now();
  new PositionStore({ storage }).save("ep-1", 1234.5, { duration: 3600 });
  const after = Date.now();
  const raw = storage.getItem("cp_pos:ep-1");
  assert.ok(raw, "save() wrote nothing");
  const stamped = Date.parse(JSON.parse(raw).updated_at);
  assert.ok(stamped >= before && stamped <= after, `updated_at ${JSON.parse(raw).updated_at} is not the wall clock`);
  assert.equal(raw, JSON.stringify(makePositionRecord(1234.5, { duration: 3600, now: new Date(stamped) })));
  // And the recorded typical case is the same four fields in the same order.
  const typical = casesOf("rows").find((c) => c.id === "rows/cp-pos-typical");
  assert.deepStrictEqual(Object.keys(JSON.parse(typical.expect.return[0].value)), Object.keys(JSON.parse(raw)));
});
