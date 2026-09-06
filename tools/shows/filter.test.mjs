/* D1 filter unit tests — no dump, no network, plain row objects. */
import test from "node:test";
import assert from "node:assert/strict";
import { applyD1Filter, evaluateD1 } from "./filter.mjs";

const NOW = Date.parse("2026-09-05T00:00:00Z");
const monthsAgo = (n) => NOW - n * (365.25 / 12) * 24 * 60 * 60 * 1000;

const baseRow = (over = {}) => ({
  id: 1, dead: 0, episodeCount: 10, newestItemPubdate: Math.floor(monthsAgo(1) / 1000),
  ...over,
});

test("evaluateD1: a healthy row passes with no reasons", () => {
  const { pass, reasons } = evaluateD1(baseRow(), { now: NOW });
  assert.equal(pass, true);
  assert.deepEqual(reasons, []);
});

test("evaluateD1: dead=1 fails with reason 'dead'", () => {
  const { pass, reasons } = evaluateD1(baseRow({ dead: 1 }), { now: NOW });
  assert.equal(pass, false);
  assert.ok(reasons.includes("dead"));
});

test("evaluateD1: episodeCount below minimum fails 'too_few_episodes'", () => {
  const { pass, reasons } = evaluateD1(baseRow({ episodeCount: 2 }), { now: NOW });
  assert.equal(pass, false);
  assert.ok(reasons.includes("too_few_episodes"));
});

test("evaluateD1: episodeCount exactly at minimum passes", () => {
  const { pass } = evaluateD1(baseRow({ episodeCount: 3 }), { now: NOW });
  assert.equal(pass, true);
});

test("evaluateD1: stale (>24 months) fails 'stale'", () => {
  const row = baseRow({ newestItemPubdate: Math.floor(monthsAgo(25) / 1000) });
  const { pass, reasons } = evaluateD1(row, { now: NOW });
  assert.equal(pass, false);
  assert.ok(reasons.includes("stale"));
});

test("evaluateD1: exactly at the 24-month boundary passes (not stale)", () => {
  const row = baseRow({ newestItemPubdate: Math.floor(monthsAgo(23.9) / 1000) });
  const { pass } = evaluateD1(row, { now: NOW });
  assert.equal(pass, true);
});

test("evaluateD1: missing newestItemPubdate fails 'no_newest_item_pubdate'", () => {
  const { pass, reasons } = evaluateD1(baseRow({ newestItemPubdate: null }), { now: NOW });
  assert.equal(pass, false);
  assert.ok(reasons.includes("no_newest_item_pubdate"));
});

test("evaluateD1: a row can fail multiple conditions at once, all reported", () => {
  const row = baseRow({ dead: 1, episodeCount: 0, newestItemPubdate: null });
  const { pass, reasons } = evaluateD1(row, { now: NOW });
  assert.equal(pass, false);
  assert.deepEqual(new Set(reasons), new Set(["dead", "too_few_episodes", "no_newest_item_pubdate"]));
});

test("evaluateD1: no language filter — a non-English row with everything else healthy passes", () => {
  const row = baseRow({ language: "ja" });
  const { pass } = evaluateD1(row, { now: NOW });
  assert.equal(pass, true);
});

test("applyD1Filter: per-filter counts are the real overlap, not first-match-only", () => {
  const rows = [
    baseRow({ id: 1 }),                                    // passes
    baseRow({ id: 2, dead: 1 }),                            // dead only
    baseRow({ id: 3, dead: 1, episodeCount: 0 }),            // dead + too_few
    baseRow({ id: 4, episodeCount: 1 }),                     // too_few only
    baseRow({ id: 5, newestItemPubdate: Math.floor(monthsAgo(30) / 1000) }), // stale only
  ];
  const { kept, counts } = applyD1Filter(rows, { now: NOW });
  assert.equal(kept.length, 1);
  assert.equal(counts.read, 5);
  assert.equal(counts.kept, 1);
  assert.equal(counts.dead, 2);
  assert.equal(counts.too_few_episodes, 2);
  assert.equal(counts.stale, 1);
});

test("applyD1Filter: works over a generator, never buffering the input array", () => {
  function* gen() {
    yield baseRow({ id: 1 });
    yield baseRow({ id: 2, dead: 1 });
  }
  const { kept, counts } = applyD1Filter(gen(), { now: NOW });
  assert.equal(kept.length, 1);
  assert.equal(counts.read, 2);
});
