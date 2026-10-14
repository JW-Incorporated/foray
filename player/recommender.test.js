/* player/recommender.js — the recommender prior's pure runtime model
   (docs/roadmap/recommender-v1.md RV-16; D2, D5, D11, D12; #1380).

   What is pinned here: the persona mix from an interest map (uniform when
   empty, on the simplex, cosine rather than raw dot product, the history
   persona first for a history-heavy listener on the real RV-01 profiles), the
   show prior with unrated slots at the row mean, per-show shrinkage, the
   soft-count mix update (toward the personas that liked a completed show, away
   on a bounce, a smaller step the more evidence the mix holds), the blend's
   DAI penalty sign, the client-row decoder against RV-02's shape and its tier
   codes, the in-list reorder that never changes membership, and that the
   module touches no storage, network, page or event log.

   Every test names the one-line mutation that turns it red; each was run. */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  personaMixFromInterests,
  updateMix,
  showPrior,
  shrink,
  blend,
  decodeClientRow,
  rankWithPrior,
  MIX_N0,
  ITEM_N0,
  MIX_OUTCOMES,
  CLIENT_TIER_NAMES,
} from "./recommender.js";
import { CLIENT_TIER_CODES } from "../tools/recommender/schema.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROFILES = JSON.parse(fs.readFileSync(path.join(ROOT, "data/recommender/persona-profiles.json"), "utf8"));

const sum = (o) => Object.values(o).reduce((s, v) => s + v, 0);
const argmax = (o) => Object.entries(o).sort((a, b) => b[1] - a[1])[0][0];

/* Unequal affinity lengths: the short persona points straight at history; the
   long one has more total mass (so a raw dot product prefers it) but points
   mostly elsewhere. */
const FIXTURE = {
  personas: [
    { id: "history-deep-diver", taxonomy_affinity: [{ node_id: "history", weight: 1 }] },
    {
      id: "sharp-comedy",
      taxonomy_affinity: [
        { node_id: "history", weight: 0.8 },
        { node_id: "comedy", weight: 1 },
        { node_id: "culture", weight: 1 },
        { node_id: "tv-film", weight: 1 },
      ],
    },
    { id: "news-current", taxonomy_affinity: [{ node_id: "news", weight: 1 }] },
  ],
};
const HISTORY_HEAVY = { history: 1, comedy: 0.3, culture: 0.3, "tv-film": 0.3 };

// Mutation: delete the `if (nodes.length === 0 || iNorm === 0) return uniform(ids);`
// line — the cosine divides 0 by 0 and every weight is NaN.
test("empty interests give a uniform mix", () => {
  for (const interests of [{}, null, { history: 0, comedy: 0 }]) {
    const mix = personaMixFromInterests(interests, PROFILES);
    const ids = PROFILES.personas.map((p) => p.id);
    assert.deepEqual(Object.keys(mix).sort(), [...ids].sort());
    for (const id of ids) assert.ok(Math.abs(mix[id] - 1 / ids.length) < 1e-12, `${id}: ${mix[id]}`);
  }
});

// Mutation: `out[id] = exps[i] / sum` -> `out[id] = exps[i]` (skip normalisation).
test("the mix sums to 1", () => {
  for (const interests of [HISTORY_HEAVY, { comedy: 1 }, { "kids-family": 0.9, science: 0.4, news: 0.1 }]) {
    const mix = personaMixFromInterests(interests, PROFILES);
    assert.ok(Math.abs(sum(mix) - 1) < 1e-9, `sum ${sum(mix)}`);
    for (const w of Object.values(mix)) assert.ok(w > 0 && w < 1);
  }
});

// Mutation: `const cos = aSq === 0 ? 0 : dot / (iNorm * Math.sqrt(aSq))` ->
// `const cos = dot` (dot product without normalisation): the long persona's
// extra mass outranks the short one's direction.
test("a history-heavy profile ranks the history persona first", () => {
  const mix = personaMixFromInterests(HISTORY_HEAVY, FIXTURE);
  assert.equal(argmax(mix), "history-deep-diver");
  assert.ok(mix["history-deep-diver"] > mix["sharp-comedy"]);
  assert.ok(mix["sharp-comedy"] > mix["news-current"], "a persona with no shared node sits at cosine 0");
});

// Mutation: `const aSq = Object.values(aff).reduce(...)` -> the sum of squares
// over the interest map's nodes only (the projected norm): commute-explainer's
// lone 0.3 on history then reads as a perfect history match and wins.
test("on the real RV-01 profiles, history interests weight history-deep-diver above sharp-comedy and comedy the reverse", () => {
  const history = personaMixFromInterests({ history: 1, espionage: 0.6, comedy: 0.1, news: 0.2 }, PROFILES);
  assert.equal(argmax(history), "history-deep-diver");
  assert.ok(history["history-deep-diver"] > history["sharp-comedy"]);
  const comedy = personaMixFromInterests({ comedy: 1, "tv-film": 0.6, history: 0.1 }, PROFILES);
  assert.ok(comedy["sharp-comedy"] > comedy["history-deep-diver"]);
});

// Mutation: `const ratedFit = (v) => (isNum(v) && v >= 1 && v <= 5 ? v : null)` ->
// `v >= 0` (an unrated 0 is read as a fit of 0 and drags the prior down).
test("showPrior with an unrated slot uses the row mean", () => {
  const mix = { a: 1 / 3, b: 1 / 3, c: 1 / 3 };
  // Uniform mix over a fully rated row: the row mean.
  assert.ok(Math.abs(showPrior(mix, { fit: { a: 5, b: 3, c: 1 } }) - 3) < 1e-12);
  // c unrated (0 from the client digit, or null after decoding): it takes the
  // mean of a and b, 4, so the uniform prior is 4.
  assert.ok(Math.abs(showPrior(mix, { a: 5, b: 3, c: 0 }) - 4) < 1e-12);
  assert.ok(Math.abs(showPrior(mix, { fit: { a: 5, b: 3, c: null } }) - 4) < 1e-12);
  // All of the weight on the unrated persona: still the row mean.
  assert.ok(Math.abs(showPrior({ a: 0, b: 0, c: 1 }, { a: 5, b: 3, c: 0 }) - 4) < 1e-12);
  // Nothing rated: 3.
  assert.equal(showPrior(mix, { a: 0, b: 0, c: 0 }), 3);
});

// Mutation: `(n0 * prior + n * obs) / (n0 + n)` -> `(n * prior + n0 * obs) / (n0 + n)`
// (n0 and n swapped).
test("shrink: n=0 returns the prior; n=1000 is within 0.01 of obs", () => {
  assert.equal(ITEM_N0, 15);
  assert.equal(shrink(2, 5, 0), 2);
  // The distance left is n0 * |obs - prior| / (n0 + n): 15 * 0.5 / 1015 < 0.01.
  assert.ok(Math.abs(shrink(3, 3.5, 1000) - 3.5) < 0.01);
  assert.ok(Math.abs(shrink(2, 5, 1000) - 5) < 0.05);
  // With n = n0 it is the midpoint; a few listens move it only part way.
  assert.ok(Math.abs(shrink(2, 5, ITEM_N0) - 3.5) < 1e-12);
  assert.ok(shrink(2, 5, 3) > 2 && shrink(2, 5, 3) < 3);
});

// Mutation: `total * m[id] + value * (fits[id] / fitSum)` -> `m[id] + value * (fits[id] / fitSum)`
// (no pseudo-count: every listen moves the mix as far as the first).
test("updateMix moves toward the liking personas and the step shrinks with count", () => {
  assert.equal(MIX_N0, 8);
  const mix = { a: 1 / 3, b: 1 / 3, c: 1 / 3 };
  const row = { fit: { a: 5, b: 3, c: 1 } };
  const fresh = updateMix(mix, row, "complete");
  assert.ok(Math.abs(sum(fresh) - 1) < 1e-12);
  assert.ok(fresh.a > mix.a && fresh.c < mix.c, JSON.stringify(fresh));
  const seasoned = updateMix(mix, row, "complete", { n: 40 });
  assert.ok(seasoned.a > mix.a);
  assert.ok(seasoned.a - mix.a < fresh.a - mix.a, `step ${seasoned.a - mix.a} vs ${fresh.a - mix.a}`);
  // A complete listen moves further than a sample of the same show.
  const sampled = updateMix(mix, row, "sampled");
  assert.ok(sampled.a - mix.a < fresh.a - mix.a);
  assert.deepEqual(MIX_OUTCOMES, { complete: 1, engaged: 0.6, sampled: 0.2, bounce: -0.5 });
});

// Mutation: `const value = isNum(outcome) ? outcome : MIX_OUTCOMES[outcome]` ->
// `... : Math.abs(MIX_OUTCOMES[outcome])` (a bounce counts as a like).
test("updateMix on a bounce moves away from the liking personas and never drops a persona", () => {
  const mix = { a: 1 / 3, b: 1 / 3, c: 1 / 3 };
  const row = { fit: { a: 5, b: 3, c: 1 } };
  const bounced = updateMix(mix, row, "bounce");
  assert.ok(bounced.a < mix.a && bounced.c > mix.c, JSON.stringify(bounced));
  // A bounce larger than a persona's whole count clamps at zero instead of
  // going negative (which would drop the persona from the mix).
  const harsh = updateMix({ a: 0.01, b: 0.49, c: 0.5 }, row, -5, { n0: 1 });
  assert.deepEqual(Object.keys(harsh).sort(), ["a", "b", "c"]);
  for (const w of Object.values(harsh)) assert.ok(w >= 0);
  assert.ok(Math.abs(sum(harsh) - 1) < 1e-9);
  // An unknown outcome changes nothing.
  assert.deepEqual(updateMix(mix, row, "nonsense"), mix);
});

// Mutation: `- delta * z(daiPenalty)` -> `+ delta * z(daiPenalty)`.
test("blend applies the DAI penalty with a minus sign", () => {
  assert.equal(blend({ prior: 4 }), 4);
  assert.equal(blend({ prior: 4, daiPenalty: 1 }), 3.5);
  assert.equal(blend({ prior: 4, daiPenalty: 1 }, { delta: 2 }), 2);
  assert.equal(blend({ prior: 3, embeddingSim: 1, resid: 0.5, daiPenalty: 1 }), 3 + 0.5 + 0.5 - 0.5);
  assert.ok(blend({ prior: 4, daiPenalty: 1 }) < blend({ prior: 4, daiPenalty: 0 }));
});

// Mutation: append `.filter((e) => (priorOf(e.item) ?? 3) >= 3)` before the
// final `.map` (low priors filtered out).
test("rankWithPrior changes order only, never membership", () => {
  const items = [
    { id: "a", score: 1, prior: 1 },
    { id: "b", score: 1, prior: 5 },
    { id: "c", score: 0.9, prior: 5 },
    { id: "d", score: 2, prior: 1 },
    { id: "e", score: 0.5 },
  ];
  const ranked = rankWithPrior(items, { scoreOf: (i) => i.score, priorOf: (i) => i.prior });
  assert.equal(ranked.length, items.length);
  assert.deepEqual(new Set(ranked), new Set(items));
  assert.deepEqual(ranked.map((i) => i.id), ["d", "b", "c", "a", "e"]);
  assert.notEqual(ranked, items, "a new array; the caller's list is not sorted in place");
  assert.deepEqual(items.map((i) => i.id), ["a", "b", "c", "d", "e"]);
});

// Mutation: `b.key - a.key || a.index - b.index` -> `b.key - a.key || b.index - a.index`
// (ties reversed, so a neutral prior reorders the caller's list).
test("rankWithPrior with a neutral or missing prior keeps the caller's order", () => {
  const items = ["x", "y", "z", "w"];
  assert.deepEqual(rankWithPrior(items, { scoreOf: () => 1, priorOf: () => 3 }), items);
  assert.deepEqual(rankWithPrior(items, { scoreOf: () => 1, priorOf: () => null }), items);
  assert.deepEqual(rankWithPrior(items, { scoreOf: () => 1 }), items);
  // A prior of 5 is worth exactly `weight` of score: it beats a 0.3 lead, not a 0.4 one.
  const lead = (gap) => rankWithPrior(["lead", "lifted"], {
    scoreOf: (i) => (i === "lead" ? 1 + gap : 1),
    priorOf: (i) => (i === "lifted" ? 5 : 3),
  })[0];
  assert.equal(lead(0.3), "lifted");
  assert.equal(lead(0.4), "lead");
});

// Mutation: `fit[id] = d >= 1 && d <= 5 ? d : null` -> `fit[id] = d >= 0 && d <= 5 ? d : null`
// (0 decodes to a fit of 0).
test("decodeClientRow maps digits to 1-5 and 0 to null", () => {
  const personas = ["a", "b", "c", "d"];
  assert.deepEqual(decodeClientRow({ f: "5103", x: 1, t: "t" }, personas), {
    fit: { a: 5, b: 1, c: null, d: 3 },
    explicit: true,
    tier: "transcript",
  });
  assert.deepEqual(decodeClientRow({ f: "40", x: 0, t: "s" }, personas), {
    fit: { a: 4, b: null, c: null, d: null },
    explicit: false,
    tier: "show-metadata",
  });
  assert.equal(decodeClientRow(null, personas), null);
  assert.equal(decodeClientRow({ f: 12, x: 0, t: "e" }, personas), null);
  // A decoded row feeds showPrior directly: the unrated slots take the row mean.
  assert.equal(showPrior({ a: 0.25, b: 0.25, c: 0.25, d: 0.25 }, decodeClientRow({ f: "5103", x: 0, t: "e" }, personas)), 3);
});

// Mutation: `e: "episode-metadata"` -> `e: "episode"` in CLIENT_TIER_NAMES.
test("the client tier codes are RV-02's CLIENT_TIER_CODES, inverted", () => {
  const inverted = Object.fromEntries(Object.entries(CLIENT_TIER_CODES).map(([name, code]) => [code, name]));
  assert.deepEqual({ ...CLIENT_TIER_NAMES }, inverted);
  assert.equal(decodeClientRow({ f: "1", x: 0, t: "e" }, ["a"]).tier, "episode-metadata");
  assert.equal(decodeClientRow({ f: "1", x: 0, t: "q" }, ["a"]).tier, null);
});

// Mutation: add `const saved = globalThis.localStorage?.getItem("x");` inside
// personaMixFromInterests.
test("the module source has no fetch, storage, page, window, event log or storage key", () => {
  const src = fs.readFileSync(path.join(ROOT, "player/recommender.js"), "utf8");
  for (const re of [/\bfetch\s*\(/, /localStorage/, /sessionStorage/, /indexedDB/, /\bdocument\b/, /\bwindow\b/, /logEvent/, /["'`]cp_/, /\bimport\b/]) {
    assert.doesNotMatch(src, re);
  }
});
