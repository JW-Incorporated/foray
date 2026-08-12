/* The FTS5 query builder: every case here is a real failure this replaced. */

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { buildFtsQuery } from "./ftsquery.mjs";

const m = (s, o) => buildFtsQuery(s, o).match;

/* --- the crashes. Each of these took down `corpus search` before. --------- */

test("a question mark does not reach FTS5 as syntax", () => {
  const q = m("what is DAI?");
  assert.equal(q, '"DAI"');
  assert.ok(!q.includes("?"));
});

test("plus signs are literal, not operators (C++ audio)", () => {
  const q = m("C++ audio");
  assert.equal(q, '"audio"');
  assert.ok(!q.includes("+"));
});

test("a colon does not become a column filter (diarization: who is speaking)", () => {
  // This crashed with `no such column: diarization`.
  const q = m("diarization: who is speaking when");
  assert.ok(!q.includes(":"));
  assert.ok(q.includes('"diarization"'));
});

test("a hyphen does not become a column filter (word-level)", () => {
  // This crashed with `no such column: level`.
  const q = m("aligning word-level timestamps");
  assert.ok(!/[^"]-/.test(q.replace(/"[^"]*"/g, "")));
  assert.ok(q.includes('"word"') && q.includes('"level"'));
});

test("an apostrophe is safe (someone's podcast)", () => {
  const q = m("can I republish someone's podcast audio");
  assert.ok(q.includes('"someone"'));
});

test("an unterminated quote degrades to words instead of throwing", () => {
  const q = m('AVFoundation "gapless');
  assert.ok(q.includes('"AVFoundation"'));
  assert.ok(q.includes('"gapless"'));
});

test("bare FTS5 operator words are neutralised into literals", () => {
  const q = m("timestamps NEAR chapters AND ads");
  assert.ok(!/\bNEAR\b(?![^"]*")/.test(q.replace(/"[^"]*"/g, "")));
  assert.ok(q.includes('"timestamps"'));
});

test("empty and stray quotes do not produce a broken expression", () => {
  // Every arm must still be a balanced quoted phrase, whatever the quoting.
  for (const s of ['a "" b "', '""', '" " "', 'x"y"z']) {
    const q = buildFtsQuery(s).match;
    if (q === null) continue;
    for (const arm of q.split(" OR ")) assert.match(arm, /^"[^"]*"$/, `${s} → bad arm ${arm}`);
  }
});

test("a quoted phrase suppresses the all-stopword fallback", () => {
  // '"dynamic ad insertion" what is it' must not re-inject "is"/"it" as arms:
  // they appear in nearly every chunk and bury the phrase hits.
  const { match } = buildFtsQuery('"dynamic ad insertion" what is it');
  assert.equal(match, '"dynamic ad insertion"');
});

test("repeated words are not weighted multiple times", () => {
  const arms = buildFtsQuery("test test test test").match.split(" OR ");
  assert.equal(arms.length, new Set(arms).size, "duplicate arms inflate bm25");
});

/* --- the silent zeroes. Implicit AND made real questions return nothing. -- */

test("terms are ORed, so a long question cannot AND itself to zero", () => {
  const q = m("what loudness target for stitched segments", { bigrams: false });
  assert.equal(q, '"loudness" OR "target" OR "stitched" OR "segments"');
});

test("stopwords are dropped", () => {
  const { terms, dropped } = buildFtsQuery("how does the server test cover images");
  assert.deepEqual(terms, ["server", "test", "cover", "images"]);
  assert.ok(dropped.includes("how") && dropped.includes("the"));
});

test("an all-stopword question keeps its words rather than matching nothing", () => {
  const { match, terms } = buildFtsQuery("how does it do that");
  assert.ok(match, "must not produce a null query");
  assert.ok(terms.length > 0);
});

/* --- structure ----------------------------------------------------------- */

test("bigrams add adjacent phrase arms and are OR'd, never required", () => {
  const q = m("reciprocal rank fusion");
  assert.ok(q.includes('"reciprocal rank"'));
  assert.ok(q.includes('"rank fusion"'));
  assert.ok(!q.includes(" AND "));
});

test("bigrams can be turned off for ablation", () => {
  assert.ok(!m("reciprocal rank fusion", { bigrams: false }).includes('"reciprocal rank"'));
});

test("explicit quoted phrases survive as phrases", () => {
  const { match, phrases } = buildFtsQuery('"dynamic ad insertion" timestamps');
  assert.deepEqual(phrases, ["dynamic ad insertion"]);
  assert.ok(match.startsWith('"dynamic ad insertion"'));
});

test("input with nothing indexable yields null, not an empty match", () => {
  // null must be distinguishable from "searched and found nothing".
  assert.equal(m("???"), null);
  assert.equal(m("   "), null);
  assert.equal(m(""), null);
});

test("single characters are dropped as noise", () => {
  assert.equal(m("a b DAI", { bigrams: false }), '"DAI"');
});

test("null and undefined input do not throw", () => {
  assert.doesNotThrow(() => buildFtsQuery(undefined));
  assert.doesNotThrow(() => buildFtsQuery(null));
});

test("every emitted arm is a quoted phrase", () => {
  const q = m("how does DAI break timestamps for stitched audio segments");
  for (const arm of q.split(" OR ")) {
    assert.match(arm, /^"[^"]*"$/, `arm not quoted: ${arm}`);
  }
});

/* --- the claim, executed. String assertions alone structurally cannot test
 * "this never reaches FTS5 as syntax" — only a real MATCH can. ------------- */

test("every hostile input executes against a real FTS5 index without throwing", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE VIRTUAL TABLE t USING fts5(text, tokenize='porter unicode61')`);
  db.exec(`INSERT INTO t(text) VALUES ('dynamic ad insertion breaks chapter timestamps')`);
  const hostile = [
    "what is DAI?", "C++ audio", "diarization: who is speaking when",
    "aligning word-level timestamps", "can I republish someone's podcast audio",
    'AVFoundation "gapless', "timestamps NEAR chapters AND ads", "a* OR b^",
    "^caret", "col:val", "(unbalanced", "NOT everything", '""', "-- dashes --",
    "emoji 🎧 query", "日本語のクエリ", "how does it do that", "   ", "",
    "x".repeat(5000), "a ".repeat(2000),
  ];
  for (const h of hostile) {
    const q = buildFtsQuery(h).match;
    if (q === null) continue;
    assert.doesNotThrow(
      () => db.prepare("SELECT rowid FROM t WHERE t MATCH ?").all(q),
      `FTS5 rejected the expression built from ${JSON.stringify(h)}: ${q}`
    );
  }
  db.close();
});
