/* CH2-30 (docs/roadmap/code-health-2.md, T1-20): the corpus export's shared
   row helpers (rows.mjs). Each was a private copy in two or three modules
   (rowsOf/showsOf in catalogue, catalog-adapter, show-map, wave-candidates;
   idKey in overlap and wave-candidates; three sync JSONL readers in overlap
   and export); these pins are the contract every caller now shares. Tmp
   files only; no data/ file, no network. The floor for this suite lives in
   test/suite-integrity.test.js. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OverlapError, readShowsJsonl } from "./overlap.mjs";
import { idKey, JsonlError, readJsonl, rowsOf } from "./rows.mjs";

/* Mutation that turns this red: make rowsOf return `doc?.shows ?? []`
   (an array document, or a non-array `shows`, comes back wrong). */
test("rowsOf: an array, a {shows} document, anything else []", () => {
  const rows = [{ a: 1 }];
  assert.equal(rowsOf(rows), rows);
  assert.equal(rowsOf({ shows: rows }), rows);
  assert.deepEqual(rowsOf({ shows: "x" }), []);
  assert.deepEqual(rowsOf(null), []);
  assert.deepEqual(rowsOf(undefined), []);
  assert.deepEqual(rowsOf({}), []);
});

/* Mutation that turns this red: drop the `.trim()` (" 42 " stops matching
   42) or the blank check ("" becomes a key that matches every blank id). */
test("idKey: numbers and strings compare as trimmed strings; absent and blank are null", () => {
  assert.equal(idKey(42), "42");
  assert.equal(idKey(" 42 "), "42");
  assert.equal(idKey("abc"), "abc");
  assert.equal(idKey(""), null);
  assert.equal(idKey("   "), null);
  assert.equal(idKey(null), null);
  assert.equal(idKey(undefined), null);
});

/* Mutation that turns this red: drop the blank-line skip (JSON.parse("")
   throws on the CRLF file's trailing line) or report `i` instead of `i + 1`
   (the line number reads 2). */
test("readJsonl: CRLF and blank lines skipped; a malformed line names path:line (OverlapError via readShowsJsonl)", () => {
  const dir = mkdtempSync(join(tmpdir(), "corpus-rows-"));
  try {
    const good = join(dir, "good.jsonl");
    writeFileSync(good, '{"a":1}\r\n\r\n{"a":2}\r\n');
    assert.deepEqual(readJsonl(good), [{ a: 1 }, { a: 2 }]);
    assert.deepEqual(readShowsJsonl(good), [{ a: 1 }, { a: 2 }]);

    const bad = join(dir, "bad.jsonl");
    writeFileSync(bad, '{"a":1}\n\n{nope\n');
    assert.throws(() => readJsonl(bad), (e) => e instanceof JsonlError && e.code === "MALFORMED_ROW" && e.detail === `${bad}:3`);
    assert.throws(() => readShowsJsonl(bad), (e) => e instanceof OverlapError && e.code === "MALFORMED_ROW" && e.detail === `${bad}:3`);
    assert.throws(() => readJsonl(join(dir, "absent.jsonl")), (e) => e.code === "ENOENT");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
