/* player/foray-sources.js — the publisher credit block.

   Two of these tests run against the REAL committed documents rather than a
   fixture, for the same reason player/foray-playback.test.js does: the question
   worth answering is "does Foray #1 credit the nine episodes it actually plays",
   and a fixture cannot be wrong about that in a way that matters. */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveForay, indexSegments, indexSources, findForay } from "./foray-resolve.js";
import {
  forayCredits, showLink, collectionIdsByShow, creditsSummary,
  APPLE_SHOW, APPLE_SEARCH,
} from "./foray-sources.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));

const FORAY_ID = "grilling-history-1";

function realResolve() {
  const foray = findForay(readJson("data/forays.json"), FORAY_ID, { unlocked: [FORAY_ID] });
  assert.ok(foray, `${FORAY_ID} must exist in data/forays.json`);
  return resolveForay(foray, {
    segments: indexSegments(readJson("data/segments.json")),
    sources: indexSources(readJson("data/segment-sources.json")),
  });
}

/** A tiny stand-in for a resolved Foray: `forayCredits` only reads `entries`. */
function fake(entries) {
  return { entries: entries.map((e, i) => ({ playable: true, duration_sec: 60, position: i, ...e })) };
}

/* ---------- the link ---------- */

test("a known Apple collection id links to that show's own page", () => {
  const link = showLink("The BBQ Central Show", 1412947410);
  assert.equal(link.url, "https://podcasts.apple.com/us/podcast/id1412947410");
  assert.equal(link.kind, APPLE_SHOW);
});

test("an unknown show links to an Apple search for its name, never to an invented id", () => {
  const link = showLink("BBQ Radio Network", null);
  assert.equal(link.url, "https://podcasts.apple.com/us/search?term=BBQ%20Radio%20Network");
  assert.equal(link.kind, APPLE_SEARCH);
});

test("every generated link is https, which is what safeUrl and the CSP require", () => {
  for (const [show, id] of [["A Show", 123], ["Another", null], ["Ampersand & Co", null]]) {
    assert.match(showLink(show, id).url, /^https:\/\/podcasts\.apple\.com\//);
  }
});

test("a show name with URL metacharacters is encoded, not concatenated", () => {
  const link = showLink("Q&A / Live?", null);
  assert.ok(!link.url.includes("&A"), link.url);
  assert.ok(!link.url.includes(" "), link.url);
  assert.equal(link.kind, APPLE_SEARCH);
});

test("a collection id that is not a positive integer falls back to search", () => {
  for (const bad of [0, -5, 1.5, "abc", "", null, undefined, {}, NaN]) {
    assert.equal(showLink("Some Show", bad).kind, APPLE_SEARCH, `${JSON.stringify(bad)} must not become an id`);
  }
});

test("a numeric string id is accepted — JSON is not always typed the way we hope", () => {
  assert.equal(showLink("Some Show", " 1412947410 ").url, "https://podcasts.apple.com/us/podcast/id1412947410");
});

test("a show with no name has no link at all", () => {
  assert.equal(showLink("", 1), null);
  assert.equal(showLink(null), null);
});

/* ---------- harvesting ids from the discover pool ---------- */

test("collectionIdsByShow indexes the pool by show name", () => {
  const map = collectionIdsByShow({
    items: [
      { id: "a", show: "The BBQ Central Show", apple_collection_id: 1412947410 },
      { id: "b", show: "Other Show", apple_collection_id: 42 },
    ],
  });
  assert.equal(map.get("The BBQ Central Show"), 1412947410);
  assert.equal(map.get("Other Show"), 42);
});

test("the first id for a show wins, and later items do not overwrite it", () => {
  const map = collectionIdsByShow({
    items: [
      { id: "a", show: "S", apple_collection_id: 1 },
      { id: "b", show: "S", apple_collection_id: 2 },
    ],
  });
  assert.equal(map.get("S"), 1);
});

test("items with no show or no usable id are skipped rather than mapped to junk", () => {
  const map = collectionIdsByShow({
    items: [{ show: "", apple_collection_id: 5 }, { show: "S" }, { show: "T", apple_collection_id: null }, null],
  });
  assert.equal(map.size, 0);
});

test("a missing or malformed discover document yields an empty index, not a throw", () => {
  assert.equal(collectionIdsByShow(null).size, 0);
  assert.equal(collectionIdsByShow({}).size, 0);
  assert.equal(collectionIdsByShow({ items: "nope" }).size, 0);
});

/* ---------- grouping ---------- */

test("segments are grouped by show, then by episode", () => {
  const credits = forayCredits(fake([
    { show: "A", item_id: "a1", episode_title: "A one" },
    { show: "A", item_id: "a1", episode_title: "A one" },
    { show: "A", item_id: "a2", episode_title: "A two" },
    { show: "B", item_id: "b1", episode_title: "B one" },
  ]));
  assert.equal(credits.length, 2);
  assert.equal(credits[0].show, "A");
  assert.equal(credits[0].clips, 3);
  assert.deepEqual(credits[0].episodes.map((e) => e.title), ["A one", "A two"]);
  assert.deepEqual(credits[0].episodes.map((e) => e.clips), [2, 1]);
  assert.equal(credits[1].clips, 1);
});

test("shows come out in the order the listener first meets them", () => {
  const credits = forayCredits(fake([
    { show: "Third", item_id: "c" }, { show: "First", item_id: "a" },
    { show: "Third", item_id: "c" }, { show: "Second", item_id: "b" },
  ]));
  assert.deepEqual(credits.map((c) => c.show), ["Third", "First", "Second"]);
});

test("runtime is summed per show and per episode", () => {
  const credits = forayCredits(fake([
    { show: "A", item_id: "a1", duration_sec: 90 },
    { show: "A", item_id: "a1", duration_sec: 30 },
    { show: "A", item_id: "a2", duration_sec: 120 },
  ]));
  assert.equal(credits[0].seconds, 240);
  assert.deepEqual(credits[0].episodes.map((e) => e.seconds), [120, 120]);
});

test("an unplayable segment is not credited — it sends the publisher no traffic", () => {
  const credits = forayCredits({
    entries: [
      { show: "A", item_id: "a1", duration_sec: 60, playable: true },
      { show: "A", item_id: "a1", duration_sec: 60, playable: false },
      { show: "B", item_id: "b1", duration_sec: 60, playable: false },
    ],
  });
  assert.equal(credits.length, 1, "a show with nothing playable left must drop out");
  assert.equal(credits[0].clips, 1);
});

test("an entry with no show name is skipped rather than credited to an empty publisher", () => {
  const credits = forayCredits(fake([{ show: "", item_id: "x" }, { show: "A", item_id: "a" }]));
  assert.deepEqual(credits.map((c) => c.show), ["A"]);
});

test("episodes with no id are kept separate instead of merged into one bucket", () => {
  const credits = forayCredits(fake([
    { show: "A", item_id: null, episode_title: "One" },
    { show: "A", item_id: null, episode_title: "Two" },
  ]));
  assert.equal(credits[0].episodes.length, 2);
  assert.deepEqual(credits[0].episodes.map((e) => e.id), [null, null]);
});

test("a resolved Foray with no entries credits nobody", () => {
  assert.deepEqual(forayCredits({ entries: [] }), []);
  assert.deepEqual(forayCredits(null), []);
});

test("the internal episode index does not leak into the returned rows", () => {
  const credits = forayCredits(fake([{ show: "A", item_id: "a1" }]));
  assert.deepEqual(Object.keys(credits[0]).sort(), ["clips", "episodes", "link", "linkKind", "seconds", "show"]);
});

test("collection ids reach the rows, by Map or by plain object", () => {
  const entries = fake([{ show: "A", item_id: "a1" }, { show: "B", item_id: "b1" }]);
  const fromMap = forayCredits(entries, { collectionIds: new Map([["A", 77]]) });
  assert.equal(fromMap[0].linkKind, APPLE_SHOW);
  assert.equal(fromMap[1].linkKind, APPLE_SEARCH);
  const fromObj = forayCredits(entries, { collectionIds: { A: 77 } });
  assert.equal(fromObj[0].link, "https://podcasts.apple.com/us/podcast/id77");
});

/* ---------- the summary line ---------- */

test("creditsSummary counts episodes and shows, and gets the singulars right", () => {
  assert.equal(creditsSummary([{ episodes: [1, 2] }, { episodes: [3] }]), "3 episodes from 2 shows");
  assert.equal(creditsSummary([{ episodes: [1] }]), "1 episode from 1 show");
  assert.equal(creditsSummary([]), "");
  assert.equal(creditsSummary(null), "");
});

/* ---------- against the real Foray ---------- */

test("Foray #1 credits five shows and nine episodes", () => {
  const credits = forayCredits(realResolve());
  assert.equal(credits.length, 5, credits.map((c) => c.show).join(", "));
  assert.equal(creditsSummary(credits), "9 episodes from 5 shows");
  assert.ok(credits.every((c) => c.show && c.clips > 0 && c.seconds > 0));
  assert.ok(credits.every((c) => c.episodes.every((e) => e.title)), "a credit with no episode title credits nothing");
});

test("the credited clips add up to the whole running order, and the credited time to its runtime", () => {
  const r = realResolve();
  const credits = forayCredits(r);
  assert.equal(credits.reduce((n, c) => n + c.clips, 0), r.playable.length);
  /* Against `tapeSec`, NOT `totalSec`. Attribution is owed for somebody else's
     audio, and a narration bridge has no publisher to credit — so on a narrated
     Foray these credits sum to the tape and `totalSec` is larger by all the
     narration. The two numbers are equal on today's data, which is exactly why
     asserting the wrong one would look right until the first bridge shipped. */
  assert.ok(Math.abs(credits.reduce((t, c) => t + c.seconds, 0) - r.tapeSec) < 1);
});

test("every credit links somewhere real, and the one show in the pool gets its own page", () => {
  const credits = forayCredits(realResolve(), {
    collectionIds: collectionIdsByShow(readJson("data/discover.json")),
  });
  assert.ok(credits.every((c) => /^https:\/\//.test(c.link)), "every publisher needs a destination");
  const central = credits.find((c) => c.show === "The BBQ Central Show");
  assert.ok(central, "the running order no longer includes The BBQ Central Show");
  assert.equal(central.linkKind, APPLE_SHOW, "this show IS in data/discover.json — it should not need a search");
});
