/* Tests for unsealing listening cards (GV-08, R2-01 / R2-21 / MQ-20).
 * Run: node --test tools/listening/unseal.test.mjs
 *
 * WHAT IS AT RISK
 * unseal is where a blind label becomes a candidate, a provider and a stage
 * swap. Its quiet failures: a label mapped to the wrong arm (a swap that lost
 * reads as a swap that won), a pack unsealed without its key (a guess), a tie
 * counted as a win (R2-21's go/no-go inflated), a re-listen counted as a
 * second pairwise result. Every key and card here is synthetic and written to
 * a temp directory; nothing reads data-local/ on this machine. Each test names
 * the mutation it kills; every one was run.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CARD_SCHEMA } from "./card.mjs";
import {
  KEY_MISSING,
  KEY_SCHEMA,
  aggregate,
  keyPathFor,
  listenByCandidate,
  loadKeys,
  main,
  unseal,
  validateKey
} from "./unseal.mjs";

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), "gv08-unseal-"));

const arm = (candidateId, stageSwap, provider = "local:spark") => ({ candidateId, provider, stageSwap });

function pairKey(packId, A, B, extra = {}) {
  return { schema: KEY_SCHEMA, packId, promptId: `prompt-${packId}`, act: 1, A, B, ...extra };
}

function soloKey(packId, solo) {
  return { schema: KEY_SCHEMA, packId, promptId: `prompt-${packId}`, act: 1, solo };
}

function card(packId, label, over = {}) {
  return {
    schema: CARD_SCHEMA,
    cardId: `${packId}-${label}-${over.n ?? 1}`,
    packId,
    label,
    act: 1,
    listener: "founder",
    listenedAt: "2026-10-11T19:00:00Z",
    scores: { onSubject: 3, flowsAtSeams: 3, oneNarrator: 3, nothingFalseOrOdd: 3 },
    overall: 3,
    q06: { oneVoice: true, everyClipIntroduced: true, anyClipCutShort: false },
    winces: [],
    ...(label === "solo" ? {} : { preference: "A" }),
    ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== "n"))
  };
}

function writeKeys(dir, keys) {
  for (const key of keys) fs.writeFileSync(path.join(dir, `${key.packId}.key.json`), JSON.stringify(key));
  return dir;
}

test("with the key present, each label unseals to its own arm", () => {
  /* MUTATION: swap `A: armView(key.A)` and `B: armView(key.B)` in unseal().
     Ran it: red. A label mapped to the wrong arm turns a swap that lost into
     a swap that won. (armFor()'s own label lookup is pinned by the
     listenByCandidate test below.) */
  const dir = writeKeys(tmpdir(), [pairKey("p1", arm("cand-base", "baseline"), arm("cand-swap", "spine:local:second", "local:second"))]);
  const cards = [card("p1", "A", { overall: 4, preference: "B" }), card("p1", "B", { overall: 5, preference: "B" })];
  const [r] = unseal(cards, { keyDir: dir });
  assert.equal(r.packId, "p1");
  assert.equal(r.promptId, "prompt-p1");
  assert.equal(r.mode, "pair");
  assert.deepEqual(r.A, { candidateId: "cand-base", provider: "local:spark", stageSwap: "baseline" });
  assert.deepEqual(r.B, { candidateId: "cand-swap", provider: "local:second", stageSwap: "spine:local:second" });
  assert.equal(r.preferred, "B");
  assert.equal(r.preferredCandidateId, "cand-swap");
  assert.deepEqual(r.overall, { A: 4, B: 5 });
  assert.equal(r.solo, null);
});

test("without the key, unseal refuses with a message naming the missing key", () => {
  /* MUTATION: `if (!fs.existsSync(file)) continue;` without pushing to
     `missing` in loadKeys() (unseal then proceeds keyless). Ran it: red.
     Unsealing without the key is a guess; the bench reads the refusal's code
     to leave its columns absent. */
  const dir = writeKeys(tmpdir(), [soloKey("p-have", arm("c1", "baseline"))]);
  const cards = [card("p-have", "solo"), card("p-gone", "A"), card("p-also-gone", "B")];
  let caught = null;
  try {
    unseal(cards, { keyDir: dir });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, "unseal must refuse");
  assert.equal(caught.code, KEY_MISSING);
  assert.match(caught.message, /cannot unseal: missing key /);
  assert.equal(caught.message.includes(path.join(dir, "p-gone.key.json")), true, caught.message);
  assert.equal(caught.message.includes(path.join(dir, "p-also-gone.key.json")), true, "every missing key is named");
  assert.equal(caught.message.includes("p-have"), false);
  assert.throws(() => listenByCandidate(cards, { keyDir: dir }), (err) => err.code === KEY_MISSING);
  assert.throws(() => unseal(cards, { keyDir: path.join(dir, "no-such-dir") }), /missing key/);
});

test("aggregate on 10 synthetic pairs returns the preference rate per stage swap", () => {
  /* MUTATION: `else if (r.preferred === "A") row.wins += 1` in aggregate()
     (the label's own position ignored, so every A-preference counts as a win
     for whichever arm is being tallied). Ran it: red. The swap arm sits in A
     on some packs and in B on others, as a seeded shuffle puts it. */
  const keys = [];
  const cards = [];
  /* 10 packs. The swap arm wins 7, the baseline wins 2, one tie. The swap is
     A on even packs and B on odd ones. */
  const outcomes = ["swap", "swap", "swap", "base", "swap", "swap", "tie", "swap", "base", "swap"];
  outcomes.forEach((outcome, i) => {
    const packId = `pk${i}`;
    const swapIsA = i % 2 === 0;
    const swapArm = arm(`swap-${i}`, "spine:local:second");
    const baseArm = arm(`base-${i}`, "baseline");
    keys.push(pairKey(packId, swapIsA ? swapArm : baseArm, swapIsA ? baseArm : swapArm));
    const pref = outcome === "tie" ? "tie" : outcome === "swap" ? (swapIsA ? "A" : "B") : swapIsA ? "B" : "A";
    cards.push(card(packId, "A", { preference: pref }), card(packId, "B", { preference: pref }));
  });
  assert.equal(cards.length, 20);
  const dir = writeKeys(tmpdir(), keys);
  const agg = aggregate(unseal(cards, { keyDir: dir }));
  assert.deepEqual(Object.keys(agg), ["baseline", "spine:local:second"]);
  assert.deepEqual(agg["spine:local:second"], { pairs: 10, wins: 7, ties: 1, losses: 2, rate: 0.7 });
  assert.deepEqual(agg.baseline, { pairs: 10, wins: 2, ties: 1, losses: 7, rate: 0.2 });
});

test("a tie is never a win, and a pair whose arms share a stage swap compares nothing", () => {
  /* MUTATION: `if (r.preferred === "tie") row.wins += 1`. Ran it: red.
     SECOND MUTATION: drop the `r.A.stageSwap === r.B.stageSwap` skip. Ran it:
     red (a same-label pair counts one win AND one loss for that label). */
  const dir = writeKeys(tmpdir(), [
    pairKey("t1", arm("a", "baseline"), arm("b", "deepen:local:spark")),
    pairKey("t2", arm("c", "baseline"), arm("d", "baseline"))
  ]);
  const cards = [card("t1", "A", { preference: "tie" }), card("t2", "A", { preference: "A" })];
  const agg = aggregate(unseal(cards, { keyDir: dir }));
  assert.deepEqual(agg, {
    baseline: { pairs: 1, wins: 0, ties: 1, losses: 0, rate: 0 },
    "deepen:local:spark": { pairs: 1, wins: 0, ties: 1, losses: 0, rate: 0 }
  });
});

test("axisDeltas are A's scores minus B's, per axis and overall, only when both were carded", () => {
  /* MUTATION: `latest.B.scores[axis] - latest.A.scores[axis]` in unseal().
     Ran it: red. The sign is the documented contract (A minus B). */
  const dir = writeKeys(tmpdir(), [pairKey("d1", arm("a", "x"), arm("b", "y")), pairKey("d2", arm("c", "x"), arm("e", "y"))]);
  const a = card("d1", "A", { scores: { onSubject: 5, flowsAtSeams: 2, oneNarrator: 4, nothingFalseOrOdd: 3 }, overall: 4 });
  const b = card("d1", "B", { scores: { onSubject: 3, flowsAtSeams: 4, oneNarrator: 4, nothingFalseOrOdd: 1 }, overall: 2 });
  const [d1, d2] = unseal([a, b, card("d2", "A")], { keyDir: dir });
  assert.deepEqual(d1.axisDeltas, { onSubject: 2, flowsAtSeams: -2, oneNarrator: 0, nothingFalseOrOdd: 2, overall: 2 });
  assert.equal(d2.axisDeltas, null, "one carded version has nothing to subtract");
  assert.equal(d2.preferred, "A", "the single pair card still carries the preference");
});

test("a re-listen supersedes the earlier verdict for the pairwise result, and a disagreement is flagged", () => {
  /* MUTATION: `if (!latest[card.label])` (first card wins) in unseal(). Ran
     it: red. A re-listen of the same pack is the listener changing their
     mind; counting the old verdict would make the pairwise result stale. */
  const dir = writeKeys(tmpdir(), [pairKey("r1", arm("a", "x"), arm("b", "y"))]);
  const cards = [
    card("r1", "A", { n: 1, preference: "A", overall: 2, listenedAt: "2026-10-11T10:00:00Z" }),
    card("r1", "A", { n: 2, preference: "B", overall: 4, listenedAt: "2026-10-12T10:00:00Z" }),
    card("r1", "B", { n: 1, preference: "A", listenedAt: "2026-10-11T10:05:00Z" })
  ];
  const [r] = unseal(cards, { keyDir: dir });
  assert.equal(r.preferred, "B", "the newest card's preference");
  assert.equal(r.overall.A, 4);
  assert.equal(r.preferenceConflict, true, "A's latest says B, B's latest says A");
  assert.equal(r.cards, 3);
  assert.equal(r.lastListenedAt, "2026-10-12T10:00:00Z");
});

test("listenByCandidate gives the mean overall and the latest listen per candidate", () => {
  /* MUTATION: `row.sum = card.overall` (last card only) in
     listenByCandidate(), or keep the EARLIEST listenedAt, or
     `key.A` for every non-solo label in armFor(). Ran all three: red.
     This is MQ-20 in the bench: mean overall, and the date that makes
     "nobody has listened since" visible. */
  const dir = writeKeys(tmpdir(), [
    soloKey("s1", arm("cand-14sep", "baseline")),
    soloKey("s2", arm("cand-14sep", "baseline")),
    pairKey("p1", arm("cand-14sep", "baseline"), arm("cand-other", "spine:local:second"))
  ]);
  const cards = [
    card("s1", "solo", { overall: 3, listenedAt: "2026-10-11T09:00:00Z" }),
    card("s2", "solo", { overall: 4, listenedAt: "2026-10-14T09:00:00Z" }),
    card("p1", "A", { overall: 5, listenedAt: "2026-10-12T09:00:00Z" }),
    card("p1", "B", { overall: 2, listenedAt: "2026-10-12T09:10:00Z" })
  ];
  const by = listenByCandidate(cards, { keyDir: dir });
  assert.deepEqual(by.get("cand-14sep"), { meanOverall: 4, lastListenedAt: "2026-10-14T09:00:00Z", cards: 3 });
  assert.deepEqual(by.get("cand-other"), { meanOverall: 2, lastListenedAt: "2026-10-12T09:10:00Z", cards: 1 });
  assert.equal(by.has("never-heard"), false);
  assert.equal(listenByCandidate([], { keyDir: path.join(dir, "absent") }).size, 0, "no cards, nothing to unseal");
});

test("a card whose label or act is not in its pack's key is refused, as is a key for another pack", () => {
  /* MUTATION: `if (!arm) return key.solo;` in armFor(). Ran it: red. A B card
     against a solo key means the card and the key came from different packs. */
  const dir = writeKeys(tmpdir(), [soloKey("s1", arm("c", "baseline"))]);
  assert.throws(() => unseal([card("s1", "B")], { keyDir: dir }), /label B is not in pack s1's key/);
  assert.throws(() => unseal([card("s1", "solo", { act: 2 })], { keyDir: dir }), /act 2 but pack s1 is act 1/);
  fs.writeFileSync(path.join(dir, "s9.key.json"), JSON.stringify(soloKey("s1", arm("c", "baseline"))));
  assert.throws(() => loadKeys(["s9"], dir), /is for pack "s1", not "s9"/);
  fs.writeFileSync(path.join(dir, "s8.key.json"), "{nope");
  assert.throws(() => loadKeys(["s8"], dir), /cannot read key/);
});

test("validateKey: a pair key has A and B, a solo key has only solo, and every arm is complete", () => {
  /* MUTATION: drop the `pair && key.solo !== undefined` check. Ran it: red. */
  assert.equal(validateKey(pairKey("k", arm("a", "x"), arm("b", "y"))).ok, true);
  assert.equal(validateKey(soloKey("k", arm("a", "x"))).ok, true);
  assert.match(validateKey(pairKey("k", arm("a", "x"), arm("b", "y"), { solo: arm("c", "z") })).errors.join(), /pair \(A, B\) or a solo, not both/);
  assert.match(validateKey(pairKey("k", arm("a", "x"), undefined)).errors.join(), /B must be/);
  assert.match(validateKey(soloKey("k", { candidateId: "a", provider: "", stageSwap: "x" })).errors.join(), /solo\.provider/);
  assert.match(validateKey({ ...soloKey("k", arm("a", "x")), schema: "listen-key/0" }).errors.join(), /schema/);
});

test("a pack id cannot point the key reader outside the key directory", () => {
  /* MUTATION: drop the ID_RE check in keyPathFor(). Ran it: red. Cards come
     from a committed, auto-merging store; their packId must not become a
     path. */
  assert.equal(keyPathFor("/keys", "pack-1"), path.join("/keys", "pack-1.key.json"));
  assert.throws(() => keyPathFor("/keys", "../../etc/x"), /not a pack id/);
  assert.throws(() => keyPathFor("/keys", "a\\b"), /not a pack id/);
});

test("the CLI prints one line per pack and the aggregate, and refuses without keys", () => {
  /* MUTATION: drop the `out(JSON.stringify({ aggregate: ... }))` line in
     main(). Ran it: red. */
  const dir = tmpdir();
  const keyDir = writeKeys(fs.mkdtempSync(path.join(dir, "k")), [pairKey("c1", arm("a", "baseline"), arm("b", "swap"))]);
  const store = path.join(dir, "cards.jsonl");
  fs.writeFileSync(store, [card("c1", "A", { preference: "B" }), card("c1", "B", { preference: "B" })].map((c) => JSON.stringify(c)).join("\n") + "\n");
  const out = [];
  main(["--cards", store, "--keys", keyDir], (s) => out.push(s));
  assert.equal(out.length, 2);
  assert.equal(JSON.parse(out[0]).preferredCandidateId, "b");
  assert.deepEqual(JSON.parse(out[1]).aggregate.swap, { pairs: 1, wins: 1, ties: 0, losses: 0, rate: 1 });
  assert.throws(() => main(["--cards", store, "--keys", path.join(dir, "none")], () => {}), /missing key/);
  assert.throws(() => main(["--bogus"]), /unknown argument --bogus/);
});
