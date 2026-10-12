/* Tests for the listening card (GV-08, R2-01). Run: node --test tools/listening/card.test.mjs
 *
 * WHAT IS AT RISK
 * The card is the founder's verdict as data, and the store it goes into is
 * committed under docs/ (auto-merge territory). Every failure mode is a QUIET
 * one: a score of 0 or 6 averaged into MQ-20, a pair card with no preference
 * counted as half a pairwise result, a pasted transcript riding along in an
 * extra field, a malformed line skipped so a listen vanishes. Each test names
 * the one-line mutation that makes it pass falsely; every one was run.
 *
 * All cards here are synthetic. No transcript text, no real candidate.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  AXES,
  CARD_SCHEMA,
  DEFAULT_STORE,
  MAX_NOTE_CHARS,
  Q06_KEYS,
  appendCard,
  main,
  parseCards,
  readCards,
  validateCard
} from "./card.mjs";

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), "gv08-card-"));

/** A valid card; `over` replaces fields (undefined deletes one). */
function card(over = {}) {
  const base = {
    schema: CARD_SCHEMA,
    cardId: "pack-1-A",
    packId: "pack-1",
    label: "A",
    act: 1,
    listener: "founder",
    listenedAt: "2026-10-11T19:04:00Z",
    scores: { onSubject: 4, flowsAtSeams: 3, oneNarrator: 5, nothingFalseOrOdd: 4 },
    overall: 4,
    q06: { oneVoice: true, everyClipIntroduced: true, anyClipCutShort: false },
    winces: [{ atSec: 212.5, note: "intro repeats the clip's first line" }],
    preference: "A"
  };
  const out = { ...base, ...over };
  for (const [k, v] of Object.entries(over)) if (v === undefined) delete out[k];
  return out;
}

const errorsOf = (c) => validateCard(c).errors.join("\n");

test("a well-formed pair card and a well-formed solo card both validate", () => {
  /* MUTATION: `return { ok: false, errors }` at the end of validateCard()
     (or any rule below made unconditional). Ran it: red. Without this the
     rejection tests could pass on a validator that rejects everything. */
  assert.deepEqual(validateCard(card()), { ok: true, errors: [] });
  assert.deepEqual(validateCard(card({ cardId: "pack-2-solo", packId: "pack-2", label: "solo", preference: undefined, winces: [] })), { ok: true, errors: [] });
  assert.deepEqual(validateCard(card({ label: "B", preference: "tie" })).ok, true);
});

test("an out-of-range or fractional axis score is refused", () => {
  /* MUTATION: `const isScore = (v) => typeof v === "number"` (drop the 1-5
     integer check). Ran it: red. A 0 or a 6 averaged into MQ-20 is a
     fabricated listen; a 3.5 is a scale the form never offered. */
  for (const bad of [0, 6, 3.5, -1, "4", null]) {
    const c = card({ scores: { ...card().scores, flowsAtSeams: bad } });
    assert.equal(validateCard(c).ok, false, `flowsAtSeams=${JSON.stringify(bad)}`);
    assert.match(errorsOf(c), /scores\.flowsAtSeams must be an integer 1-5/);
  }
  for (const ok of [1, 5]) assert.equal(validateCard(card({ scores: { ...card().scores, onSubject: ok } })).ok, true);
});

test("an out-of-range overall is refused", () => {
  /* MUTATION: drop the `if (!isScore(card.overall))` line. Ran it: red.
     `overall` is MQ-20's headline number in the bench. */
  assert.match(errorsOf(card({ overall: 0 })), /overall must be an integer 1-5/);
  assert.match(errorsOf(card({ overall: 6 })), /overall must be an integer 1-5/);
  assert.match(errorsOf(card({ overall: undefined })), /overall/);
});

test("a missing axis is refused by name, and so is an axis the card does not define", () => {
  /* MUTATION: replace the `for (const axis of AXES)` loop in validateCard()
     with nothing. Ran it: red. A card missing `oneNarrator` would read as an
     act with no voice problem. SECOND MUTATION: drop the reverse loop
     (`if (!AXES.includes(key))`): a misspelt axis then rides along beside the
     real one. Ran it: red. */
  assert.equal(AXES.length, 4);
  const { oneNarrator, ...three } = card().scores;
  assert.equal(oneNarrator, 5);
  assert.match(errorsOf(card({ scores: three })), /scores\.oneNarrator is missing/);
  assert.match(errorsOf(card({ scores: { ...card().scores, oneNarator: 3 } })), /scores\.oneNarator is not an axis/);
  assert.match(errorsOf(card({ scores: undefined })), /scores must be an object/);
});

test("a pair card without a preference is refused, and a solo card with one is refused", () => {
  /* MUTATION: delete the `if (card.label === "A" || card.label === "B")`
     branch in validateCard(). Ran it: red. A pair card with no preference is
     half a pairwise result: aggregate() would count the pack as unheard. */
  for (const label of ["A", "B"]) {
    assert.match(errorsOf(card({ label, preference: undefined })), /a pair card \(label [AB]\) needs preference A \| B \| tie/);
    assert.match(errorsOf(card({ label, preference: "even" })), /needs preference/);
  }
  assert.match(errorsOf(card({ label: "solo", preference: "A" })), /a solo card has no preference/);
});

test("an unknown field is refused, so the committed store cannot carry a transcript", () => {
  /* MUTATION: delete the unknown-key loop at the top of validateCard(). Ran
     it: red. The store auto-merges under docs/; a `transcript` or a
     `candidateId` field would either commit clip text or unblind the pack. */
  assert.match(errorsOf(card({ transcript: "so anyway the engineer said" })), /unknown field "transcript"/);
  assert.match(errorsOf(card({ candidateId: "x-4e64fd43" })), /unknown field "candidateId"/);
});

test("a wince note is a note, not a transcript; a wince time is seconds >= 0", () => {
  /* MUTATION: drop the `w.note.length > MAX_NOTE_CHARS` branch. Ran it: red.
     SECOND MUTATION: `w.atSec < 0` -> `w.atSec < -1e9`. Ran it: red. */
  assert.equal(validateCard(card({ winces: [{ atSec: 0, note: "x".repeat(MAX_NOTE_CHARS) }] })).ok, true);
  assert.match(errorsOf(card({ winces: [{ atSec: 1, note: "x".repeat(MAX_NOTE_CHARS + 1) }] })), /over 280 characters/);
  assert.match(errorsOf(card({ winces: [{ atSec: -2, note: "" }] })), /winces\[0\]\.atSec must be seconds >= 0/);
  assert.match(errorsOf(card({ winces: [{ atSec: 3, note: "ok", speaker: "x" }] })), /winces\[0\]\.speaker is not a wince field/);
  assert.match(errorsOf(card({ winces: undefined })), /winces must be a list/);
});

test("the q06 answers are kept as three booleans, so MQ-20 stays continuous with Q-06", () => {
  /* MUTATION: `if (card.q06[key] === undefined)` instead of the boolean check.
     Ran it: red. "yes" is not an answer the baseline definition could have
     produced. */
  assert.deepEqual([...Q06_KEYS], ["oneVoice", "everyClipIntroduced", "anyClipCutShort"]);
  assert.match(errorsOf(card({ q06: { oneVoice: "yes", everyClipIntroduced: true, anyClipCutShort: false } })), /q06\.oneVoice must be true or false/);
  assert.match(errorsOf(card({ q06: { oneVoice: true, everyClipIntroduced: true } })), /q06\.anyClipCutShort must be true or false/);
  assert.match(errorsOf(card({ q06: undefined })), /q06 must be an object/);
});

test("ids must be safe file names, listenedAt must carry a zone, and the card must name its listener", () => {
  /* MUTATION: `ID_RE = /.+/`. Ran it: red. A packId names the key FILE that
     unseal reads, so `../x` would point the reader outside the key directory.
     SECOND MUTATION: make the zone optional in LISTENED_AT_RE
     (`(Z|[+-]\d{2}:\d{2})?$`). Ran it: red. A zoneless time dates the same card differently on two machines. */
  assert.match(errorsOf(card({ packId: "../keys/x" })), /packId must be a short id/);
  assert.match(errorsOf(card({ cardId: "a/b" })), /cardId must be a short id/);
  assert.match(errorsOf(card({ listenedAt: "2026-10-11T19:04:00" })), /listenedAt/);
  assert.match(errorsOf(card({ listenedAt: "2026-13-45T99:99:00Z" })), /listenedAt/);
  assert.match(errorsOf(card({ listener: "  " })), /listener must name who listened/);
  assert.match(errorsOf(card({ act: 0 })), /act must be an integer >= 1/);
  assert.match(errorsOf(card({ schema: "listen-card/0" })), /schema must be "listen-card\/1"/);
  assert.match(errorsOf(card({ label: "C" })), /label must be one of A, B, solo/);
  assert.deepEqual(validateCard(null), { ok: false, errors: ["a card is a JSON object"] });
});

test("a store line that is not a valid card throws, naming the line; a duplicate cardId throws", () => {
  /* MUTATION: `if (!ok) return;` (skip the bad line) in parseCards(). Ran it:
     red. A reader that skipped a bad line would hide a listen that happened.
     SECOND MUTATION: drop the `seen.has(card.cardId)` check. Ran it: red. */
  const good = JSON.stringify(card());
  assert.throws(() => parseCards(`${good}\n{"schema":"listen-card/1"}\n`, "s.jsonl"), /^Error: s\.jsonl:2: /);
  assert.throws(() => parseCards(`${good}\nnot json\n`, "s.jsonl"), /s\.jsonl:2: not JSON/);
  assert.throws(() => parseCards(`${good}\n\n${good}\n`, "s.jsonl"), /s\.jsonl:3: duplicate cardId "pack-1-A" \(first on line 1\)/);
});

test("blank lines and CRLF endings are tolerated; an empty store holds no cards", () => {
  /* MUTATION: drop `.replace(/\r$/, "")` in parseCards() — JSON.parse accepts
     a trailing \r, so this one is pinned by the blank-line half: drop the
     `line.trim() === ""` skip. Ran it: red (JSON.parse of ""). */
  const two = [card(), card({ cardId: "pack-1-B", label: "B" })].map((c) => JSON.stringify(c)).join("\r\n");
  assert.equal(parseCards(`\r\n${two}\r\n\r\n`).length, 2);
  assert.deepEqual(parseCards(""), []);
});

test("readCards of a store that does not exist is empty; of one that exists, validated", () => {
  /* MUTATION: `return []` unconditionally in readCards(). Ran it: red. */
  const dir = tmpdir();
  assert.deepEqual(readCards(path.join(dir, "nope.jsonl")), []);
  const file = path.join(dir, "cards.jsonl");
  fs.writeFileSync(file, `${JSON.stringify(card())}\n`);
  assert.equal(readCards(file)[0].cardId, "pack-1-A");
});

test("appendCard adds exactly one line and never rewrites what is there", () => {
  /* MUTATION: `fs.writeFileSync(file, JSON.stringify(card) + "\n")` in
     appendCard() (overwrite instead of append). Ran it: red. The store is
     append-only: the founder's earlier verdicts are the trend. */
  const dir = tmpdir();
  const file = path.join(dir, "cards.jsonl");
  const first = `${JSON.stringify(card())}`; // no trailing newline on purpose
  fs.writeFileSync(file, first);
  assert.equal(appendCard(file, card({ cardId: "pack-1-B", label: "B" })), 2);
  const text = fs.readFileSync(file, "utf8");
  assert.equal(text.startsWith(`${first}\n`), true, "the existing line is kept byte for byte");
  assert.equal(text.endsWith("\n"), true);
  assert.deepEqual(readCards(file).map((c) => c.cardId), ["pack-1-A", "pack-1-B"]);
});

test("appendCard refuses an invalid card, a duplicate cardId, and a store that is already broken", () => {
  /* MUTATION: drop the `cards.some((c) => c.cardId === card.cardId)` refusal.
     Ran it: red (then the store itself is unreadable, which is worse). */
  const dir = tmpdir();
  const file = path.join(dir, "cards.jsonl");
  appendCard(file, card());
  const before = fs.readFileSync(file, "utf8");
  assert.throws(() => appendCard(file, card()), /cardId "pack-1-A" is already in/);
  assert.throws(() => appendCard(file, card({ cardId: "x", overall: 9 })), /card refused: overall must be an integer 1-5/);
  assert.equal(fs.readFileSync(file, "utf8"), before, "a refused card leaves the store untouched");
  fs.writeFileSync(file, "garbage\n");
  assert.throws(() => appendCard(file, card({ cardId: "y" })), /not JSON/);
});

test("the committed store is valid, and every line in it is a card", () => {
  /* MUTATION: append a line with an unknown field (or a score of 7) to
     docs/curation/listening/cards.jsonl. Ran it: red. This is the store's own
     gate: it auto-merges, so a malformed or padded card must fail CI. It
     cannot fail on today's (empty) store; it is here for the first card. */
  assert.equal(fs.existsSync(DEFAULT_STORE), true, "docs/curation/listening/cards.jsonl is committed");
  const cards = readCards(DEFAULT_STORE);
  for (const c of cards) assert.equal(validateCard(c).ok, true);
});

test("Q-06 in the listening-quality plan says the card supersedes it, and the store's README says who may append", () => {
  /* MUTATION: delete the "Status (2026-10-11)" line under Q-06 in
     docs/curation/listening-quality-plan.md, or the founder-only rule from the
     README. Ran both: red. A reader of Q-06 must not grade a run on three
     yes/no answers the card has replaced; a bot reading the README must not
     append a card the founder did not paste. */
  const plan = fs.readFileSync(path.join(path.dirname(DEFAULT_STORE), "..", "listening-quality-plan.md"), "utf8");
  const q06 = plan.slice(plan.indexOf("### Q-06"), plan.indexOf("**Ask.**", plan.indexOf("### Q-06")));
  assert.match(q06, /\*\*Status \(2026-10-11\)\.\*\* Superseded by the listening card \(R2-01/);
  const readme = fs.readFileSync(path.join(path.dirname(DEFAULT_STORE), "README.md"), "utf8");
  assert.match(readme, /Only the founder's own card JSON is appended/);
});

test("the CLI checks a store and appends a card file to it", () => {
  /* MUTATION: `if (command === "check") return 0;` in main(). Ran it: red. */
  const dir = tmpdir();
  const store = path.join(dir, "cards.jsonl");
  const cardFile = path.join(dir, "card.json");
  fs.writeFileSync(cardFile, JSON.stringify(card()));
  const out = [];
  assert.equal(main(["append", cardFile, "--store", store], (s) => out.push(s)), 1);
  assert.equal(main(["check", store], (s) => out.push(s)), 1);
  assert.match(out.join("\n"), /appended pack-1-A; 1 card\(s\)/);
  assert.match(out.join("\n"), /1 valid card\(s\)/);
  assert.throws(() => main(["append"]), /usage:/);
  assert.throws(() => main(["frobnicate"]), /usage:/);
});
