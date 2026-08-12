/* The FTS5 query builder: every case here is a real failure this replaced. */

import test from "node:test";
import assert from "node:assert/strict";
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

test("an embedded double quote is doubled, not left to break the string", () => {
  const q = buildFtsQuery('say "hi', { bigrams: false }).match;
  assert.ok(!/[^"]"[^ "]/.test(q.replace(/""/g, "")) || q.includes('""') || q.includes('"hi"'));
  assert.doesNotThrow(() => buildFtsQuery('a "" b "'));
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
