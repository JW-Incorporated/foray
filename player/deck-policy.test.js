/* deck-policy.js unit tests (NE-45j).

   Most of deck-policy.js is pinned by parity fixtures (deck-episode, deck), so
   the Swift DeckPolicy is checked against the same rows. This suite holds the
   rules NE-45j added, stated directly so the JS reference reads as a spec:
   what is prepared across a seam (`warmsAcross`), and where the prefetch window
   of an item with no out-point is (`prefetchWindowOpens` with `durationSec`).
   The same rules are recorded for the Swift and JVM ports in
   player/parity/fixtures/prepare-narration/. */

import test from "node:test";
import assert from "node:assert/strict";
import { warmsAcross, prefetchWindowOpens } from "./deck-policy.js";
import { PREFETCH_LEAD_SEC } from "./html-audio-backend.js";

const clip = (id, url = "https://cdn.test/a.mp3") => ({ id, kind: "episode", audio_url: url, start_sec: 100, end_sec: 200 });
const rendered = (id = "n1") => ({ id, kind: "tts", audio_url: "https://cdn.test/n1.m4a", script: "A line." });
const spoken = (id = "n1") => ({ id, kind: "tts", audio_url: null, script: "A line." });
const episode = (id = "e1") => ({ id, kind: "episode", audio_url: "https://cdn.test/e.mp3" });

/* ---------- warmsAcross: the file, not the beat ---------- */

test("warmsAcross: a clip after a clip is prepared", () => {
  assert.equal(warmsAcross({ from: clip("s0"), to: clip("s1", "https://cdn.test/b.mp3") }), true);
});

test("warmsAcross: a rendered line after a clip is prepared, though the seam gets no beat", () => {
  assert.equal(warmsAcross({ from: clip("s0"), to: rendered() }), true);
});

test("warmsAcross: the clip after a rendered or a spoken line is prepared", () => {
  assert.equal(warmsAcross({ from: rendered(), to: clip("s1") }), true);
  assert.equal(warmsAcross({ from: spoken(), to: clip("s1") }), true, "WHEN is the manager's (at the line's start); WHETHER is the file");
});

test("warmsAcross: a spoken line has no file, so nothing is prepared for it", () => {
  assert.equal(warmsAcross({ from: clip("s0"), to: spoken() }), false);
  assert.equal(warmsAcross({ from: clip("s0"), to: { ...rendered(), audio_url: "" } }), false, "an empty url is no file");
});

test("warmsAcross: the item after an episode's natural end is prepared", () => {
  assert.equal(warmsAcross({ from: episode(), to: clip("s1") }), true);
});

test("warmsAcross: the Foray's last item prepares nothing — a Foray does not chain", () => {
  assert.equal(warmsAcross({ from: clip("s0"), to: null }), false);
  assert.equal(warmsAcross({ from: null, to: clip("s1") }), false, "nothing playing, no seam");
  assert.equal(warmsAcross(), false);
});

/* ---------- prefetchWindowOpens: an item with no out-point ---------- */

const base = { available: true, outPointSec: null, armed: false, paused: false, rate: 1, leadSec: PREFETCH_LEAD_SEC };

test("window: with no out-point the boundary is the duration, and the window opens the lead before it", () => {
  assert.equal(prefetchWindowOpens({ ...base, durationSec: 30, atSec: 30 - PREFETCH_LEAD_SEC - 1 }), false, "outside the lead");
  assert.equal(prefetchWindowOpens({ ...base, durationSec: 30, atSec: 30 - PREFETCH_LEAD_SEC }), true, "at the lead");
  assert.equal(prefetchWindowOpens({ ...base, durationSec: 3600, atSec: 3590 }), true, "an episode's natural end");
});

test("window: an item shorter than the lead is inside its window from its first tick", () => {
  assert.equal(prefetchWindowOpens({ ...base, durationSec: PREFETCH_LEAD_SEC - 4, atSec: 0 }), true);
});

test("window: the duration's lead is wall clock too, so 2x opens it earlier", () => {
  // 20 s of file at 2x is 10 s of wall clock: inside a 12 s lead.
  assert.equal(prefetchWindowOpens({ ...base, durationSec: 3600, atSec: 3580, rate: 2 }), true);
  assert.equal(prefetchWindowOpens({ ...base, durationSec: 3600, atSec: 3580, rate: 1 }), false);
});

test("window: no out-point and no usable duration is no boundary", () => {
  for (const durationSec of [null, undefined, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(prefetchWindowOpens({ ...base, durationSec, atSec: 0 }), false, String(durationSec));
  }
});

test("window: the duration never stands in for a slice's own out-point", () => {
  // An out-point that exists but is not armed is no boundary, whatever the duration says.
  assert.equal(prefetchWindowOpens({ ...base, outPointSec: 200, armed: false, durationSec: 5, atSec: 0 }), false);
  // And an armed out-point wins over the duration.
  assert.equal(prefetchWindowOpens({ ...base, outPointSec: 200, armed: true, durationSec: 3600, atSec: 190 }), true);
  assert.equal(prefetchWindowOpens({ ...base, outPointSec: 200, armed: true, durationSec: 5, atSec: 100 }), false);
});

test("window: paused, unavailable or already opened stays shut with a duration too", () => {
  const open = { ...base, durationSec: 8, atSec: 0 };
  assert.equal(prefetchWindowOpens(open), true, "precondition");
  assert.equal(prefetchWindowOpens({ ...open, paused: true }), false);
  assert.equal(prefetchWindowOpens({ ...open, available: false }), false);
  assert.equal(prefetchWindowOpens({ ...open, alreadyOpened: true }), false);
});

test("window: a caller that passes no duration gets the out-point-only answer (the web lane is unchanged)", () => {
  assert.equal(prefetchWindowOpens({ available: true, outPointSec: null, armed: true, paused: false, atSec: 999, rate: 1, leadSec: 12 }), false);
});
