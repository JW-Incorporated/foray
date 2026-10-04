/* The locate step's arithmetic (player/locate-window.js, docs/roadmap/dai.md
   DAI-10). Every test names the mutation that kills it. */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LOCATED_SPAN_TOLERANCE_SEC, locateWindow, windowBytes, locatedBounds } from "./locate-window.js";

// The dai-playback-brief's SYSK row (§3 table: worst implied delta 534 s) on a
// two-minute segment authored at 600-720, with an 80 s observed spread.
const SYSK = { start_sec: 600, end_sec: 720, delta_max_sec: 534, spread_sec: 80 };
const authored = { start_sec: 600, end_sec: 720 };
const window = locateWindow(SYSK);

test("the brief's SYSK example: fetch_end 1334, span 734", () => {
  // Mutation: forget the margin (fetch_end = end + delta_max) -> 1254 / 654, red.
  assert.equal(LOCATED_SPAN_TOLERANCE_SEC, 2);
  assert.deepEqual(window, {
    fetch_start_sec: 600,
    fetch_end_sec: 1334,
    span_sec: 734,
    search_start: { from_sec: 600, to_sec: 1214 },
    search_end: { from_sec: 720, to_sec: 1334 },
  });
});

test("the margin defaults to the spread, and a wider margin widens both search ranges", () => {
  // Mutation: the search ranges add delta_max alone -> red.
  const w = locateWindow({ ...SYSK, margin_sec: 100 });
  assert.equal(w.fetch_end_sec, 1354);
  assert.equal(w.search_start.to_sec, 1234);
  assert.equal(w.search_end.to_sec, 1354);
});

test("the margin may not be below the spread", () => {
  // Mutation: drop the margin check -> no throw, red.
  assert.throws(() => locateWindow({ ...SYSK, margin_sec: 79.9 }), {
    name: "RangeError",
    message: "margin below the observed spread (ADR-0008 decision 3)",
  });
  assert.equal(locateWindow({ ...SYSK, margin_sec: 80 }).fetch_end_sec, 1334);
});

test("lead never goes negative", () => {
  // Mutation: fetch_start = start - lead without the Math.max -> -100, red.
  const early = locateWindow({ ...SYSK, start_sec: 20, lead_sec: 120 });
  assert.equal(early.fetch_start_sec, 0);
  assert.equal(early.span_sec, early.fetch_end_sec);
  const led = locateWindow({ ...SYSK, lead_sec: 30 });
  assert.equal(led.fetch_start_sec, 570);
  assert.equal(led.span_sec, 764);
  // The lead widens the fetch, never the search: content only moves later.
  assert.deepEqual(led.search_start, window.search_start);
});

test("windowBytes at 96 kbps for 734 s is 8,808,000", () => {
  // Mutation: drop the `/ 8` -> 70,464,000, red.
  assert.equal(windowBytes(734, 96000), 8808000);
  assert.equal(windowBytes(window.span_sec, 96000), 8808000);
  // Rounded up, never down: a short fetch misses the tail of the window.
  // Mutation: Math.floor -> 1, red.
  assert.equal(windowBytes(1, 9), 2);
});

test("a hit outside the search range is refused", () => {
  // Mutation: drop either range check -> a bounds object, red.
  assert.deepEqual(locatedBounds({ start_hit_sec: 599, end_hit_sec: 760, authored, window }), {
    refused: "start hit outside its search range",
  });
  assert.deepEqual(locatedBounds({ start_hit_sec: 1215, end_hit_sec: 1300, authored, window }), {
    refused: "start hit outside its search range",
  });
  assert.deepEqual(locatedBounds({ start_hit_sec: 650, end_hit_sec: 719, authored, window }), {
    refused: "end hit outside its search range",
  });
  assert.deepEqual(locatedBounds({ start_hit_sec: 650, end_hit_sec: 1335, authored, window }), {
    refused: "end hit outside its search range",
  });
  // The edges are inside (inclusive ranges). Mutation: strict comparisons -> red.
  assert.equal(locatedBounds({ start_hit_sec: 600, end_hit_sec: 720, authored, window }).start_sec, 600);
  assert.equal(locatedBounds({ start_hit_sec: 1214, end_hit_sec: 1334, authored, window }).end_sec, 1334);
});

test("a located end before the located start is refused", () => {
  // Mutation: drop the order check -> the span check answers instead, red.
  assert.deepEqual(locatedBounds({ start_hit_sec: 900, end_hit_sec: 800, authored, window }), {
    refused: "end before start",
  });
  assert.deepEqual(locatedBounds({ start_hit_sec: 900, end_hit_sec: 900, authored, window }), {
    refused: "end before start",
  });
});

test("a located span shorter than authored by more than 2 s is refused, longer by a mid-roll is accepted", () => {
  // Mutation: symmetric tolerance (|located - authored| > 2) -> the mid-roll is refused, red.
  assert.deepEqual(locatedBounds({ start_hit_sec: 605, end_hit_sec: 722, authored, window }), {
    refused: "located span shorter than authored",
  });
  assert.equal(locatedBounds({ start_hit_sec: 605, end_hit_sec: 723, authored, window }).end_sec, 723);
  const midRoll = locatedBounds({ start_hit_sec: 640, end_hit_sec: 850, authored, window });
  assert.deepEqual(midRoll, { start_sec: 640, end_sec: 850, shift_start_sec: 40, shift_end_sec: 130 });
});

test("a located span longer than the search range allows is refused", () => {
  // Hits inside ranges built from these authored times cannot exceed it; a
  // window built for different times (here, opened 100 s early) can.
  // Mutation: drop the upper span check -> a bounds object, red.
  const skewed = {
    search_start: { from_sec: 400, to_sec: 1014 },
    search_end: { from_sec: 720, to_sec: 1334 },
  };
  assert.deepEqual(locatedBounds({ start_hit_sec: 500, end_hit_sec: 1334, authored, window: skewed }), {
    refused: "located span longer than the window allows",
  });
  assert.equal(locatedBounds({ start_hit_sec: 600, end_hit_sec: 1334, authored, window: skewed }).start_sec, 600);
});

test("shifts are reported per end", () => {
  // Mutation: one shared shift (both ends report the start's) -> red.
  assert.deepEqual(locatedBounds({ start_hit_sec: 655, end_hit_sec: 1000, authored, window }), {
    start_sec: 655,
    end_sec: 1000,
    shift_start_sec: 55,
    shift_end_sec: 280,
  });
});

test("junk input refuses or throws, never NaN", () => {
  // Mutation: drop any field check -> NaN in a window, red.
  for (const [field, bad] of [
    ["start_sec", NaN],
    ["start_sec", -1],
    ["start_sec", "600"],
    ["end_sec", Infinity],
    ["end_sec", 600],
    ["delta_max_sec", -1],
    ["delta_max_sec", undefined],
    ["spread_sec", -0.1],
    ["lead_sec", -5],
    ["lead_sec", NaN],
  ]) {
    assert.throws(
      () => locateWindow({ ...SYSK, [field]: bad }),
      (err) => err instanceof RangeError && err.message.startsWith(field),
      `${field}=${String(bad)}`,
    );
  }
  assert.throws(() => locateWindow({ ...SYSK, margin_sec: NaN }), /margin_sec/);
  assert.throws(() => locateWindow(), RangeError);
  assert.throws(() => locateWindow(null), RangeError);

  // Mutation: drop the guard -> NaN or a negative byte count, red.
  for (const [span, rate] of [[NaN, 96000], [734, Infinity], [0, 96000], [734, 0], [-1, 96000], ["734", 96000]]) {
    assert.equal(windowBytes(span, rate), null, `${span}/${rate}`);
  }

  // Mutation: drop the finiteness check -> NaN shifts, red.
  for (const [s, e] of [[NaN, 800], [650, undefined], [650, Infinity], ["650", 800]]) {
    assert.deepEqual(locatedBounds({ start_hit_sec: s, end_hit_sec: e, authored, window }), {
      refused: "hit not a number",
    });
  }
  assert.throws(() => locatedBounds({ start_hit_sec: 650, end_hit_sec: 800, authored: { start_sec: 600 }, window }), RangeError);
  assert.throws(() => locatedBounds({ start_hit_sec: 650, end_hit_sec: 800, authored }), RangeError);
  assert.throws(() => locatedBounds({ start_hit_sec: 650, end_hit_sec: 800, authored, window: { search_start: {} } }), RangeError);
  assert.throws(() => locatedBounds(), RangeError);
});

test("the module is dependency-free and wired into nothing yet", () => {
  // Shipped as-is by the manifest's player/*.js glob, so it imports nothing.
  // Mutation: add an import -> red.
  const src = readFileSync(new URL("./locate-window.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /^\s*import\b/m);
  assert.doesNotMatch(src, /\bimport\s*\(/);
  // locateStep stays unimplemented (DAI-10 does not touch seek-policy.js).
  const policy = readFileSync(new URL("./seek-policy.js", import.meta.url), "utf8");
  assert.match(policy, /implemented: false/);
  assert.doesNotMatch(policy, /locate-window/);
});
