/* The lock screen, the car head unit, and the headphone pinch (issue #27).
 *
 * WHAT THIS SUITE IS FOR
 * `player/media-session.js` decides four things a listener meets without ever
 * looking at our page: what the display says, what previous/next do, which
 * clock the progress bar is on, and what the 2.0 s seam beat reports. Those are
 * product decisions living in code, so each one is PINNED here rather than
 * merely exercised — a future edit that flips the seam beat to "paused" or
 * moves the publisher out of `artist` has to delete an assertion that says why.
 *
 * FIVE PARTS, and the middle one is the point:
 *   1. the artwork URL gate — allow or replace, never sanitise
 *   2. the mapping, exhaustively, including against the REAL committed Forays
 *   3. position + playback state, including the seam-gap decision
 *   4. the actions, routed into a REAL PlayerQueueManager over a fake backend,
 *      so "the lock screen calls the same thing the button calls" is a fact
 *      about behaviour and not about a comment
 *   5. graceful absence — no `navigator.mediaSession`, no `setPositionState`,
 *      an engine that throws on an action it does not implement. None of it may
 *      throw, because a nicer notification is not worth losing audio for.
 *
 * Plus a short sixth part that reads `player/client.js` and `app.js` as text.
 * That is not decoration: everything above tests the module, and the module is
 * worthless if the client quietly grows a second, parallel MediaSession
 * implementation beside it. Those assertions are the only thing standing
 * between "tested" and "tested and actually wired".
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  artworkUrl, mediaArtwork, mediaArtworkList, mediaMetadata,
  mediaPositionState, mediaPlaybackState, mediaSessionView,
  mediaSessionActions, createMediaSession,
  MEDIA_ACTIONS, APP_ARTWORK_URL, SEEK_BACKWARD_SEC, SEEK_FORWARD_SEC,
  NONE, PAUSED, PLAYING,
} from "./media-session.js";
import { PlayerQueueManager, __resetInstanceForTests } from "./queue-manager.js";
import { resolveForay, indexSegments, indexSources, findForay } from "./foray-resolve.js";
import { artworkUrlsByShow } from "./foray-sources.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));
const readText = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

const APPLE = "https://is1-ssl.mzstatic.com/image/thumb/Podcasts126/v4/ab/mza_124.jpg/600x600bb.jpg";

/* ---------- 1. the artwork URL gate ---------- */

test("artworkUrl passes https through unchanged", () => {
  assert.equal(artworkUrl(APPLE), APPLE);
  assert.equal(artworkUrl("https://example.com/a.png?x=1#y"), "https://example.com/a.png?x=1#y");
});

test("artworkUrl passes a data:image URI", () => {
  const uri = "data:image/png;base64,iVBORw0KGgo=";
  assert.equal(artworkUrl(uri), uri);
});

test("artworkUrl refuses every scheme that can execute or that the CSP blocks", () => {
  for (const bad of [
    "javascript:alert(1)", "JavaScript:alert(1)", "vbscript:msgbox", "data:text/html,<b>",
    "blob:https://x/y", "file:///etc/passwd", "about:blank", "http://example.com/a.png",
  ]) {
    assert.equal(artworkUrl(bad), null, `${bad} must be refused`);
  }
});

test("artworkUrl refuses http even though it is not executable — the CSP is img-src https: data:", () => {
  // Handing the OS a URL our own policy blocks buys a console error, not a picture.
  assert.equal(artworkUrl("http://example.com/a.png"), null);
});

test("artworkUrl refuses a protocol-relative URL", () => {
  // `//evil/x.png` is a third-party fetch wearing a relative path's clothes.
  assert.equal(artworkUrl("//evil.example/x.png"), null);
});

test("artworkUrl refuses a URL carrying a control character", () => {
  // A control byte is how a blocked scheme gets past a naive check.
  assert.equal(artworkUrl("java\nscript:alert(1)"), null);
  assert.equal(artworkUrl("java\u0000script:alert(1)"), null);
  assert.equal(artworkUrl("https://example.com/a\u0007.png"), null);
  assert.equal(artworkUrl("java script:alert(1)"), null);
});

test("artworkUrl allows a relative path, which is how our own icon reaches the OS", () => {
  assert.equal(artworkUrl("icon-512.png"), "icon-512.png");
  assert.equal(artworkUrl("/foray/icon-512.png"), "/foray/icon-512.png");
});

test("artworkUrl refuses empty, blank and non-string input rather than passing it on", () => {
  for (const bad of ["", "   ", null, undefined, 7, {}, []]) assert.equal(artworkUrl(bad), null);
});

test("mediaArtwork reads the size off the URL Apple already encodes it in", () => {
  assert.deepEqual(mediaArtwork(APPLE), { src: APPLE, sizes: "600x600", type: "image/jpeg" });
});

test("mediaArtwork infers the MIME type from the extension, and omits it when unknown", () => {
  assert.equal(mediaArtwork("https://x/y.png").type, "image/png");
  assert.equal(mediaArtwork("https://x/y.webp").type, "image/webp");
  assert.equal(mediaArtwork("https://x/y").type, undefined);
  assert.equal(mediaArtwork("https://x/y").sizes, undefined);
});

test("mediaArtwork lets the caller override size and type", () => {
  assert.deepEqual(
    mediaArtwork("icon-512.png", { sizes: "512x512", type: "image/png" }),
    { src: "icon-512.png", sizes: "512x512", type: "image/png" }
  );
});

test("mediaArtwork returns null for a refused URL rather than an entry with no src", () => {
  assert.equal(mediaArtwork("javascript:alert(1)"), null);
  assert.equal(mediaArtwork(null), null);
});

test("mediaArtworkList prefers the publisher's square when we have one", () => {
  const list = mediaArtworkList({ showArtworkUrl: APPLE });
  assert.equal(list.length, 1);
  assert.equal(list[0].src, APPLE);
});

test("mediaArtworkList falls back to the app icon, so the lock screen is never blank", () => {
  const list = mediaArtworkList({ showArtworkUrl: null });
  assert.equal(list.length, 1);
  assert.equal(list[0].src, APP_ARTWORK_URL);
});

test("mediaArtworkList never offers both — the OS picks by size, not by preference", () => {
  // Two entries would make it a coin flip over whose mark the car shows.
  assert.equal(mediaArtworkList({ showArtworkUrl: APPLE }).length, 1);
  assert.equal(mediaArtworkList({}).length, 1);
});

test("mediaArtworkList is empty when neither the show's square nor the app icon is usable", () => {
  assert.deepEqual(mediaArtworkList({ showArtworkUrl: "javascript:x", appArtworkUrl: "http://x/y.png" }), []);
});

test("a refused show artwork URL degrades to the app icon rather than to nothing", () => {
  const list = mediaArtworkList({ showArtworkUrl: "javascript:alert(1)" });
  assert.equal(list[0].src, APP_ARTWORK_URL);
});

/* ---------- 2. the mapping ---------- */

const SEG = { kind: "episode", title: "Episode 09: Did Cooking Make Us Human?", show: "Origin Stories", start_sec: 10, end_sec: 120 };

test("a segment puts the episode in title and the SHOW in artist", () => {
  const m = mediaMetadata({ item: SEG, forayTitle: "The history of grilling", index: 0, total: 32 });
  assert.equal(m.title, "Episode 09: Did Cooking Make Us Human?");
  assert.equal(m.artist, "Origin Stories");
});

test("the Foray's title lives in album, with the part counter", () => {
  const m = mediaMetadata({ item: SEG, forayTitle: "The history of grilling", index: 11, total: 32 });
  assert.equal(m.album, "The history of grilling · part 12 of 32");
});

test("the part counter is 1-based, and worded exactly as the mini bar words it", () => {
  assert.match(mediaMetadata({ item: SEG, forayTitle: "F", index: 0, total: 9 }).album, /part 1 of 9$/);
  assert.match(mediaMetadata({ item: SEG, forayTitle: "F", index: 8, total: 9 }).album, /part 9 of 9$/);
});

test("an index past the end is clamped rather than reported as part 40 of 32", () => {
  assert.match(mediaMetadata({ item: SEG, forayTitle: "F", index: 99, total: 32 }).album, /part 32 of 32$/);
});

test("a zero total suppresses the counter — single-episode playback has no parts", () => {
  assert.equal(mediaMetadata({ item: SEG, forayTitle: "", index: 0, total: 0 }).album, "");
  assert.equal(mediaMetadata({ item: SEG, forayTitle: "A Foray", index: 0, total: 0 }).album, "A Foray");
});

test("a counter with no Foray title still reads as a sentence", () => {
  assert.equal(mediaMetadata({ item: SEG, forayTitle: "", index: 2, total: 9 }).album, "Part 3 of 9");
});

test("a missing show yields an EMPTY artist — a credit is never invented", () => {
  // Guessing here would attach one publisher's name to another's audio, which is
  // the single error this surface must not make.
  const m = mediaMetadata({ item: { kind: "episode", title: "T", show: "" }, forayTitle: "F", index: 0, total: 2 });
  assert.equal(m.artist, "");
  assert.notEqual(m.artist, "F");
  assert.notEqual(m.artist, "Foray");
});

test("a missing episode title falls back to the Foray, never to an empty display", () => {
  const m = mediaMetadata({ item: { kind: "episode", show: "S" }, forayTitle: "The history of grilling" });
  assert.equal(m.title, "The history of grilling");
});

test("with nothing at all the display still says something true", () => {
  const m = mediaMetadata();
  assert.equal(m.title, "Foray");
  assert.equal(m.artist, "");
  assert.equal(m.album, "");
});

test("whitespace-only strings count as missing, not as content", () => {
  const m = mediaMetadata({ item: { kind: "episode", title: "   ", show: "\t" }, forayTitle: "  F  ", index: 0, total: 3 });
  assert.equal(m.title, "F");
  assert.equal(m.artist, "");
  assert.equal(m.album, "F · part 1 of 3");
});

test("every field is a string and artwork is an array, for every input shape", () => {
  for (const view of [undefined, {}, { item: null }, { item: {} }, { item: { kind: "tts" } }]) {
    const m = mediaMetadata(view);
    assert.equal(typeof m.title, "string");
    assert.equal(typeof m.artist, "string");
    assert.equal(typeof m.album, "string");
    assert.ok(Array.isArray(m.artwork));
  }
});

test("a narration item takes the spec's title: \"Up next: <episode>\"", () => {
  // 04_VOICE_AUDIO_SPEC.md line 11, verbatim.
  const m = mediaMetadata({
    item: { kind: "tts", title: "bridge-3" },
    nextItem: { kind: "episode", title: "Fire and the human gut", show: "Origin Stories" },
    forayTitle: "The history of grilling", index: 3, total: 32,
  });
  assert.equal(m.title, "Up next: Fire and the human gut");
});

test("a narration item with nothing after it shows the FORAY, never its own slug", () => {
  /* An authored narration id is a slug — the fixtures in this repo look like
     `bridge-3` — and a slug on a car display is worse than the Foray's name,
     which is always a sentence. The first draft preferred the item's own title
     and a flattering fixture ("Closing line") hid it. */
  assert.equal(mediaMetadata({ item: { kind: "tts", title: "bridge-3" }, forayTitle: "The history of grilling" }).title,
    "The history of grilling");
  assert.equal(mediaMetadata({ item: { kind: "tts", title: "bridge-3" } }).title, "Foray");
});

test("a narration item is credited to Foray, never to a publisher", () => {
  const m = mediaMetadata({
    item: { kind: "tts", title: "b", show: "Origin Stories" },
    nextItem: { kind: "episode", title: "T", show: "Origin Stories" },
    forayTitle: "F", index: 1, total: 4,
  });
  assert.equal(m.artist, "Foray");
});

test("a narration item never carries a publisher's artwork", () => {
  const m = mediaMetadata({ item: { kind: "tts", title: "b" }, showArtworkUrl: APPLE });
  assert.equal(m.artwork[0].src, APP_ARTWORK_URL);
});

test("a segment carries the publisher's artwork when the show has one", () => {
  const m = mediaMetadata({ item: SEG, showArtworkUrl: APPLE });
  assert.equal(m.artwork[0].src, APPLE);
});

/* ---------- 2b. against the REAL committed Forays ---------- */

const FORAYS = readJson("data/forays.json");
const SEGMENTS = readJson("data/segments.json");
const SOURCES = readJson("data/segment-sources.json");
const DISCOVER = readJson("data/discover.json");

function realResolved(id) {
  const foray = findForay(FORAYS, id, { unlocked: [id] });
  assert.ok(foray, `${id} must exist in data/forays.json`);
  return resolveForay(foray, { segments: indexSegments(SEGMENTS), sources: indexSources(SOURCES) });
}

/** Every Foray in the shipped document, so a third one is covered on the day it
    lands rather than the day someone remembers this file. */
const REAL_IDS = FORAYS.forays.map((f) => f.id);

test("data/forays.json still has Forays to check this against", () => {
  assert.ok(REAL_IDS.length >= 2, `expected at least two Forays, found ${REAL_IDS.length}`);
});

test("every segment of every shipped Foray maps to a non-empty title and artist", () => {
  for (const id of REAL_IDS) {
    const r = realResolved(id);
    assert.ok(r.playable.length > 0, `${id} has nothing playable`);
    r.playable.forEach((item, i) => {
      const m = mediaMetadata({ item, forayTitle: r.title, index: i, total: r.playable.length });
      assert.ok(m.title.length > 0, `${id}#${i} has no lock-screen title`);
      assert.ok(m.artist.length > 0, `${id}#${i} has no publisher credit`);
      assert.ok(m.album.includes(r.title), `${id}#${i} does not name its Foray`);
    });
  }
});

test("the display CHANGES at a seam where the source changes — a frozen car display is the failure", () => {
  const r = realResolved(REAL_IDS[0]);
  const key = (i) => {
    const m = mediaMetadata({ item: r.playable[i], forayTitle: r.title, index: i, total: r.playable.length });
    return `${m.title}|${m.artist}|${m.album}`;
  };
  let changes = 0;
  for (let i = 1; i < r.playable.length; i++) if (key(i) !== key(i - 1)) changes += 1;
  // The counter alone guarantees this, which is part of why it is in there.
  assert.equal(changes, r.playable.length - 1);
});

test("the shipped shows really do come out as the publishers' names", () => {
  const r = realResolved(REAL_IDS[0]);
  const artists = new Set(r.playable.map((item, i) =>
    mediaMetadata({ item, forayTitle: r.title, index: i, total: r.playable.length }).artist));
  const shows = new Set(r.playable.map((i) => i.show));
  assert.deepEqual([...artists].sort(), [...shows].sort());
});

test("artworkUrlsByShow harvests the discover pool by exact show name", () => {
  const map = artworkUrlsByShow(DISCOVER);
  assert.ok(map.size > 0, "the discover pool carries artwork for at least one show");
  for (const [show, url] of map) {
    assert.ok(show.length > 0);
    assert.equal(artworkUrl(url), url, `${show}'s artwork must survive the URL gate`);
  }
});

test("artworkUrlsByShow survives a missing, malformed or empty document", () => {
  for (const doc of [null, undefined, {}, { items: null }, { items: [null, 3, {}, { show: "" }] }]) {
    assert.equal(artworkUrlsByShow(doc).size, 0);
  }
});

test("artwork coverage over the shipped Forays is THIN, and the fallback carries the rest", () => {
  /* The artwork verdict, pinned as a number rather than as a claim: our own data
     has no artwork field on a source at all, so the discover pool is the only
     join available and it covers a minority of the shows. This test does not
     demand coverage — it demands that a miss is a fallback, never a blank. */
  const map = artworkUrlsByShow(DISCOVER);
  const shows = new Set();
  for (const id of REAL_IDS) for (const i of realResolved(id).playable) if (i.show) shows.add(i.show);
  const hits = [...shows].filter((s) => map.has(s));
  assert.ok(hits.length < shows.size, "if every show now has artwork, say so and update the PR's verdict");
  for (const show of shows) {
    const list = mediaArtworkList({ showArtworkUrl: map.get(show) ?? null });
    assert.equal(list.length, 1, `${show} must end up with exactly one artwork entry`);
  }
});

/* ---------- 3. position and playback state ---------- */

test("mediaPositionState reports what it is given, validated", () => {
  assert.deepEqual(mediaPositionState({ durationSec: 3082, positionSec: 1200, playbackRate: 1.5 }),
    { duration: 3082, position: 1200, playbackRate: 1.5 });
});

test("a position past the duration is clamped, because the spec throws on it", () => {
  assert.equal(mediaPositionState({ durationSec: 100, positionSec: 140 }).position, 100);
});

test("a negative position is clamped to zero", () => {
  assert.equal(mediaPositionState({ durationSec: 100, positionSec: -5 }).position, 0);
  assert.equal(mediaPositionState({ durationSec: 100, positionSec: NaN }).position, 0);
});

test("no duration means no report — never a report of zero", () => {
  for (const d of [null, undefined, 0, -1, NaN, Infinity, "60"]) {
    assert.equal(mediaPositionState({ durationSec: d, positionSec: 5 }), null, `duration ${d}`);
  }
});

test("a zero playback rate becomes 1, because zero is a TypeError in the spec", () => {
  // This is the reason the seam beat cannot simply report "not moving".
  assert.equal(mediaPositionState({ durationSec: 10, playbackRate: 0 }).playbackRate, 1);
});

test("a negative or nonsense playback rate becomes 1 — we never play backwards", () => {
  for (const r of [-1, NaN, Infinity, null, "1.5", undefined]) {
    assert.equal(mediaPositionState({ durationSec: 10, playbackRate: r }).playbackRate, 1, `rate ${r}`);
  }
});

test("a real playback rate is passed through, so the OS extrapolates at the right speed", () => {
  assert.equal(mediaPositionState({ durationSec: 10, playbackRate: 1.75 }).playbackRate, 1.75);
});

test("nothing loaded reports no transport state at all", () => {
  assert.equal(mediaPlaybackState({ hasItem: false, playing: true }), NONE);
  assert.equal(mediaPlaybackState(), NONE);
});

test("playing reports playing, and paused reports paused", () => {
  assert.equal(mediaPlaybackState({ hasItem: true, playing: true }), PLAYING);
  assert.equal(mediaPlaybackState({ hasItem: true, playing: false }), PAUSED);
});

test("THE SEAM BEAT REPORTS PLAYING — 2.0 s of authored silence is not a pause", () => {
  /* player/media-session.js §4. The element really is paused for the beat, so
     "paused" is the literal answer and the wrong one: the listener did not
     pause, the Foray is advancing on its own, and a car display that blinks
     paused 31 times an hour reads as broken. If you are changing this, you are
     changing a product decision — say so in the PR. */
  assert.equal(mediaPlaybackState({ hasItem: true, playing: false, inSeamGap: true }), PLAYING);
});

test("the seam-gap widening is exactly the one `isRunning()` applies in the page", () => {
  // Same widening, one definition. A beat is the only state where "not playing"
  // and "running" disagree.
  assert.equal(mediaPlaybackState({ hasItem: true, playing: true, inSeamGap: true }), PLAYING);
  assert.equal(mediaPlaybackState({ hasItem: true, playing: false, inSeamGap: false }), PAUSED);
});

test("a beat with nothing loaded is still nothing loaded", () => {
  assert.equal(mediaPlaybackState({ hasItem: false, inSeamGap: true }), NONE);
});

test("a FINISHED Foray reports none, not paused — a dead play button is worse than no button", () => {
  assert.equal(mediaPlaybackState({ hasItem: true, playing: true, ended: true }), NONE);
  assert.equal(mediaPlaybackState({ hasItem: true, inSeamGap: true, ended: true }), NONE);
});

test("mediaSessionView reports the FORAY's clock, not the segment's", () => {
  /* The decision in §3, pinned against real data: a segment is ~110 s and the
     Foray is ~51 min, so this assertion fails loudly if anyone swaps in the
     element's own currentTime. */
  const r = realResolved(REAL_IDS[0]);
  const item = r.playable[19];
  const view = mediaSessionView({
    item, forayTitle: r.title, index: 19, total: r.playable.length,
    durationSec: r.totalSec, positionSec: 1800, playing: true,
  });
  assert.equal(view.positionState.duration, r.totalSec);
  assert.ok(view.positionState.duration > 600, "a Foray is tens of minutes long");
  const segmentLength = item.end_sec - item.start_sec;
  assert.notEqual(view.positionState.duration, segmentLength);
  assert.equal(view.positionState.position, 1800);
});

test("mediaSessionView carries the seam-gap flag THROUGH — not just mediaPlaybackState", () => {
  /* The reviewer's finding: every seam-gap assertion above called
     `mediaPlaybackState` directly, so hardcoding `inSeamGap: false` inside
     `mediaSessionView` reversed the decision with the whole suite green. The beat
     has to survive the trip the real caller actually takes. */
  assert.equal(mediaSessionView({ item: SEG, playing: false, inSeamGap: true }).playbackState, PLAYING);
  assert.equal(mediaSessionView({ item: SEG, playing: false, inSeamGap: false }).playbackState, PAUSED);
});

test("mediaSessionView carries the ended flag through, so a finished Foray still clears the slot", () => {
  assert.equal(mediaSessionView({ item: SEG, playing: true, ended: true }).playbackState, NONE);
  assert.equal(mediaSessionView({ item: SEG, playing: true, ended: false }).playbackState, PLAYING);
});

test("mediaSessionView carries the item through to both the metadata and hasItem", () => {
  const view = mediaSessionView({ item: SEG, forayTitle: "F", index: 0, total: 2, playing: true });
  assert.equal(view.metadata.artist, "Origin Stories");
  assert.equal(view.playbackState, PLAYING);
  assert.equal(mediaSessionView({ item: null, playing: true }).playbackState, NONE);
});

test("mediaSessionView hands back all three pieces, and none of them throws on an empty view", () => {
  const view = mediaSessionView();
  assert.equal(typeof view.metadata, "object");
  assert.equal(view.positionState, null);
  assert.equal(view.playbackState, NONE);
});

/* ---------- 4. the actions ---------- */

function recordingSurface(extra = {}) {
  const calls = [];
  const base = {
    calls,
    play: () => calls.push("play"),
    pause: () => calls.push("pause"),
    stop: () => calls.push("stop"),
    next: () => calls.push("next"),
    previous: () => calls.push("previous"),
    seekBy: (o) => calls.push(`seekBy:${o}`),
    seekTo: (...args) => calls.push(`seekTo:${args.join(",")}`),
  };
  return Object.assign(base, extra);
}

const actionMap = (surface, opts) => new Map(mediaSessionActions(surface, opts));

test("a complete surface installs every action this module knows about", () => {
  assert.deepEqual([...actionMap(recordingSurface()).keys()], [...MEDIA_ACTIONS]);
});

test("MEDIA_ACTIONS is the full set and is frozen, so the list cannot drift from the map", () => {
  assert.ok(Object.isFrozen(MEDIA_ACTIONS));
  assert.deepEqual([...MEDIA_ACTIONS], [
    "play", "pause", "stop", "previoustrack", "nexttrack",
    "seekbackward", "seekforward", "seekto",
  ]);
});

test("an absent surface method installs no handler — the OS greys the button out", () => {
  const s = recordingSurface();
  delete s.next;
  delete s.previous;
  const map = actionMap(s);
  assert.equal(map.has("nexttrack"), false);
  assert.equal(map.has("previoustrack"), false);
  assert.equal(map.has("play"), true);
});

test("single-episode playback offers no next: the queue is one item by design", () => {
  // SINGLE_ITEM, product principle 1 — no autoplay chains. A next button that
  // does nothing is worse than a dim one.
  const map = actionMap({ play() {}, pause() {}, stop() {}, seekBy() {}, seekTo() {} });
  assert.deepEqual([...map.keys()], ["play", "pause", "stop", "seekbackward", "seekforward", "seekto"]);
});

test("an empty surface installs nothing rather than throwing", () => {
  assert.deepEqual(mediaSessionActions({}), []);
  assert.deepEqual(mediaSessionActions(), []);
  assert.deepEqual(mediaSessionActions(null), []);
});

test("play means play and pause means pause — never a toggle", () => {
  /* MediaSession delivers them as two actions. A toggle would pause on a `play`
     that arrived while already playing, which is what a car sends when the
     engine starts. */
  const s = recordingSurface();
  const map = actionMap(s);
  map.get("play")();
  map.get("play")();
  map.get("pause")();
  assert.deepEqual(s.calls, ["play", "play", "pause"]);
});

test("previoustrack and nexttrack take no arguments — the surface owns the meaning", () => {
  const seen = [];
  const map = actionMap({ next: (...a) => seen.push(["next", a.length]), previous: (...a) => seen.push(["prev", a.length]) });
  map.get("nexttrack")({ action: "nexttrack" });
  map.get("previoustrack")({ action: "previoustrack" });
  assert.deepEqual(seen, [["next", 0], ["prev", 0]]);
});

test("seekbackward asks for a NEGATIVE 15 seconds by default", () => {
  const s = recordingSurface();
  actionMap(s).get("seekbackward")();
  assert.deepEqual(s.calls, [`seekBy:-${SEEK_BACKWARD_SEC}`]);
  assert.equal(SEEK_BACKWARD_SEC, 15);
});

test("seekforward asks for a positive 30 seconds by default", () => {
  const s = recordingSurface();
  actionMap(s).get("seekforward")();
  assert.deepEqual(s.calls, [`seekBy:${SEEK_FORWARD_SEC}`]);
  assert.equal(SEEK_FORWARD_SEC, 30);
});

test("the platform's own seekOffset wins when it sends one", () => {
  const s = recordingSurface();
  const map = actionMap(s);
  map.get("seekforward")({ seekOffset: 10 });
  map.get("seekbackward")({ seekOffset: 10 });
  assert.deepEqual(s.calls, ["seekBy:10", "seekBy:-10"]);
});

test("a nonsense seekOffset falls back to our default rather than seeking by zero", () => {
  const s = recordingSurface();
  const map = actionMap(s);
  for (const bad of [0, -5, NaN, null, "10", undefined]) map.get("seekforward")({ seekOffset: bad });
  assert.deepEqual(s.calls, new Array(6).fill(`seekBy:${SEEK_FORWARD_SEC}`));
});

test("the ±15/30 defaults are overridable in one place, and default to the spec's numbers", () => {
  const s = recordingSurface();
  const map = actionMap(s, { seekBackwardSec: 5, seekForwardSec: 7 });
  map.get("seekbackward")();
  map.get("seekforward")();
  assert.deepEqual(s.calls, ["seekBy:-5", "seekBy:7"]);
});

test("seekto forwards the head unit's own seekTime", () => {
  const s = recordingSurface();
  actionMap(s).get("seekto")({ seekTime: 1800 });
  assert.deepEqual(s.calls, ["seekTo:1800"]);
});

test("seekto passes ONLY the time — fastSeek is our seek policy's call, not the car's", () => {
  // seek-policy.js (ADR-0007/0008) decides whether a landing may be approximate.
  // On a DAI source an approximate landing is a wrong one.
  const s = recordingSurface();
  actionMap(s).get("seekto")({ seekTime: 12, fastSeek: true });
  assert.deepEqual(s.calls, ["seekTo:12"]);
});

test("seekto with no usable time does nothing — it is not a seek to zero", () => {
  const s = recordingSurface();
  const map = actionMap(s);
  for (const bad of [undefined, null, NaN, -1, "30", {}]) map.get("seekto")({ seekTime: bad });
  map.get("seekto")();
  assert.deepEqual(s.calls, []);
});

test("seekto zero is a real destination and is honoured", () => {
  const s = recordingSurface();
  actionMap(s).get("seekto")({ seekTime: 0 });
  assert.deepEqual(s.calls, ["seekTo:0"]);
});

test("handlers keep their surface as `this`, so a method form works too", () => {
  const calls = [];
  const surface = { n: 0, next() { this.n += 1; calls.push(this.n); } };
  const map = actionMap(surface);
  map.get("nexttrack")();
  map.get("nexttrack")();
  assert.deepEqual(calls, [1, 2]);
});

/* ---------- 4b. routed into a REAL PlayerQueueManager ---------- */

/** The fake from queue-manager.test.js, reduced to what a Foray needs. Records
    every call so the assertions are about SEQUENCE. */
class FakeBackend {
  constructor() {
    this.calls = [];
    this.currentTime = 0;
    this.duration = 3600;
    this.outPoint = null;
    this.onItemEnded = null;
    this.onError = null;
  }
  async load(item, { startOffset = 0 } = {}) {
    this.outPoint = null;
    this.currentTime = startOffset;
    this.calls.push(`load:${item.id}@${Math.round(startOffset)}`);
  }
  play() { this.calls.push("play"); }
  pause() { this.calls.push("pause"); }
  seek(s) { this.currentTime = s; this.calls.push(`seek:${Math.round(s)}`); }
  setOutPoint(s) { this.outPoint = s; this.calls.push(`outPoint:${Math.round(s)}`); }
  setRate(r) { this.calls.push(`rate:${r}`); }
  release() { this.calls.push("release"); }
}

/** A real manager on the real Foray, plus the surface `client.js` builds — same
    shape, delegating to the same manager methods. Nothing here is a stand-in for
    the transport; the transport is the transport. */
async function realPlayer() {
  __resetInstanceForTests();
  const r = realResolved(REAL_IDS[0]);
  const backend = new FakeBackend();
  const manager = new PlayerQueueManager({ backend, seamGapSec: 0, allowMultiple: true });
  manager.setQueueFromForay(r.hydrated, { resolveItem: (id) => r.sources.get(id) ?? null });
  await manager.play(0);
  const surface = {
    play: () => manager.resume(),
    pause: () => manager.pause(),
    stop: () => manager.stop(),
    next: () => manager.skipToNext(),
    previous: () => manager.skipToPrevious(),
    seekBy: (o) => manager.seek(Math.max(0, backend.currentTime + o), { precise: true }),
    seekTo: (p) => manager.seek(p, { precise: true }),
  };
  return { r, backend, manager, map: actionMap(surface) };
}

test("nexttrack from a lock screen really advances the real manager to the next segment", async () => {
  const { r, backend, manager, map } = await realPlayer();
  backend.calls.length = 0;
  await map.get("nexttrack")();
  assert.equal(manager.currentIndex, 1);
  const second = r.playable[1];
  assert.ok(
    backend.calls.includes(`load:${second.id}@${Math.round(second.start_sec)}`),
    `expected the next segment loaded at its in-point; got ${backend.calls.join(" ")}`
  );
});

test("nexttrack lands at the segment's in-point, not at 0:00 of somebody's episode", async () => {
  const { r, backend, map } = await realPlayer();
  backend.calls.length = 0;
  await map.get("nexttrack")();
  assert.ok(r.playable[1].start_sec > 0, "the fixture segment must start inside its episode");
  assert.ok(!backend.calls.includes(`load:${r.playable[1].id}@0`));
});

test("two lock-screen nexttracks advance two segments", async () => {
  const { manager, map } = await realPlayer();
  await map.get("nexttrack")();
  await map.get("nexttrack")();
  assert.equal(manager.currentIndex, 2);
});

test("previoustrack from a lock screen restarts the segment at its in-point", async () => {
  const { r, backend, map } = await realPlayer();
  const first = r.playable[0];
  backend.currentTime = first.start_sec + 40;
  backend.calls.length = 0;
  await map.get("previoustrack")();
  assert.ok(
    backend.calls.includes(`load:${first.id}@${Math.round(first.start_sec)}`),
    `expected a restart at the in-point; got ${backend.calls.join(" ")}`
  );
});

test("the hardware pause button really pauses the real backend", async () => {
  const { backend, manager, map } = await realPlayer();
  backend.calls.length = 0;
  await map.get("pause")();
  assert.deepEqual(backend.calls, ["pause"]);
  assert.equal(manager.state.type, "interrupted");
});

test("play after pause resumes through the real manager", async () => {
  const { backend, manager, map } = await realPlayer();
  await map.get("pause")();
  backend.calls.length = 0;
  await map.get("play")();
  assert.equal(manager.state.type, "playing");
  assert.ok(backend.calls.includes("play"), backend.calls.join(" "));
});

test("a car scrub reaches the real backend as a precise seek", async () => {
  const { r, backend, map } = await realPlayer();
  const first = r.playable[0];
  backend.calls.length = 0;
  await map.get("seekto")({ seekTime: first.start_sec + 20 });
  assert.ok(backend.calls.some((c) => c.startsWith("seek:")), backend.calls.join(" "));
});

test("an out-point still arms after a lock-screen skip — the Foray cannot run into the next hour", async () => {
  const { r, backend, map } = await realPlayer();
  backend.calls.length = 0;
  await map.get("nexttrack")();
  assert.equal(backend.outPoint, r.playable[1].end_sec);
});

/* ---------- 5. the bridge, and graceful absence ---------- */

/** A minimally believable `navigator.mediaSession`.
 *
 *  The metadata log records EVERY field, not just the title. The first draft
 *  logged `v.title` alone, and the reviewer's pass proved what that costs: the
 *  bridge could have overwritten `artist` with our own name — nine publishers'
 *  work credited to us for an hour — with all 116 tests green, because nothing
 *  outside the pure mapper ever looked at the artist that actually reached the
 *  platform. A fake that observes less than the code writes is not a fake, it is
 *  a blindfold. */
function fakeNav({ withPositionState = true, withPlaybackState = true, throwOn = [] } = {}) {
  const log = [];
  const ms = {
    metadata: undefined,
    handlers: new Map(),
    log,
    setActionHandler(action, handler) {
      if (throwOn.includes(action)) throw new Error(`Unsupported action: ${action}`);
      log.push(`handler:${action}:${handler ? "set" : "null"}`);
      if (handler) ms.handlers.set(action, handler);
      else ms.handlers.delete(action);
    },
  };
  if (withPositionState) ms.setPositionState = (state) => log.push(`position:${state ? Math.round(state.position) : "clear"}`);
  if (withPlaybackState) {
    let state;
    Object.defineProperty(ms, "playbackState", {
      get: () => state,
      set: (v) => { state = v; log.push(`state:${v}`); },
      configurable: true,
    });
  }
  Object.defineProperty(ms, "metadata", {
    set: (v) => {
      log.push(v
        ? `metadata:${v.title}|${v.artist}|${v.album}|${(v.artwork ?? []).map((a) => a.src).join("+")}`
        : "metadata:null");
      ms._metadata = v;
    },
    get: () => ms._metadata,
    configurable: true,
  });
  return { mediaSession: ms, _ms: ms, _log: log };
}

/** What the platform was actually told, parsed back out of the log. */
function metadataWrites(nav) {
  return nav._log.filter((l) => l.startsWith("metadata:")).map((l) => {
    const [, rest] = /^metadata:(.*)$/s.exec(l);
    if (rest === "null") return null;
    const [title, artist, album, artwork] = rest.split("|");
    return { title, artist, album, artwork };
  });
}

test("no navigator at all yields an inert bridge that answers every call", () => {
  const bridge = createMediaSession({ nav: null });
  assert.equal(bridge.supported, false);
  assert.deepEqual(bridge.setActions(recordingSurface()), []);
  bridge.update(mediaSessionView({ item: SEG, durationSec: 10, positionSec: 1, playing: true }));
  bridge.clear();
  bridge.release();
});

test("a navigator with no mediaSession — desktop Safari, older browsers — never throws", () => {
  for (const nav of [{}, { mediaSession: null }, { mediaSession: undefined }, { mediaSession: "yes" }, "navigator", 7]) {
    const bridge = createMediaSession({ nav });
    assert.equal(bridge.supported, false, JSON.stringify(nav));
    bridge.update({ metadata: { title: "x" }, playbackState: PLAYING });
    bridge.release();
  }
});

test("createMediaSession with no arguments at all is inert, not an exception", () => {
  const bridge = createMediaSession();
  assert.equal(bridge.supported, false);
  bridge.update();
});

test("a real mediaSession is detected and reports itself supported", () => {
  assert.equal(createMediaSession({ nav: fakeNav() }).supported, true);
});

test("the bridge installs handlers and reports which ones landed", () => {
  const nav = fakeNav();
  const installed = createMediaSession({ nav }).setActions(recordingSurface());
  assert.deepEqual(installed, [...MEDIA_ACTIONS]);
  assert.deepEqual([...nav._ms.handlers.keys()], [...MEDIA_ACTIONS]);
});

test("an engine that throws on one unsupported action still gets the other seven", () => {
  // Chromium throws rather than no-ops for an action it does not implement.
  const nav = fakeNav({ throwOn: ["seekto"] });
  const installed = createMediaSession({ nav }).setActions(recordingSurface());
  assert.equal(installed.includes("seekto"), false);
  assert.equal(installed.length, MEDIA_ACTIONS.length - 1);
});

test("switching from a Foray to one episode REMOVES nexttrack instead of leaving it stale", () => {
  /* The bug this guards: a `nexttrack` handler still bound to a Foray nobody is
     on. It is invisible on screen and only shows up as a car button doing
     something surprising. */
  const nav = fakeNav();
  const bridge = createMediaSession({ nav });
  bridge.setActions(recordingSurface());
  assert.ok(nav._ms.handlers.has("nexttrack"));
  bridge.setActions({ play() {}, pause() {}, stop() {}, seekBy() {}, seekTo() {} });
  assert.equal(nav._ms.handlers.has("nexttrack"), false);
  assert.equal(nav._ms.handlers.has("previoustrack"), false);
  assert.ok(nav._ms.handlers.has("play"));
});

test("release() removes every handler it installed", () => {
  const nav = fakeNav();
  const bridge = createMediaSession({ nav });
  bridge.setActions(recordingSurface());
  bridge.release();
  assert.equal(nav._ms.handlers.size, 0);
});

test("a handler installed BY THE BRIDGE actually calls the surface — all eight of them", () => {
  /* The hole the reviewer's pass found and this closes. Every other test in this
     section asserts which handlers are REGISTERED, or that invoking one does not
     throw. Neither notices a bridge that installs eight handlers which do
     nothing — and a dead lock screen is invisible in a browser tab, so it would
     have shipped. Invoke through `nav.mediaSession.handlers`, the way the OS
     does, and assert the surface ran. */
  const nav = fakeNav();
  const s = recordingSurface();
  createMediaSession({ nav }).setActions(s);
  for (const action of MEDIA_ACTIONS) {
    const handler = nav._ms.handlers.get(action);
    assert.ok(handler, `${action} was never installed`);
    handler(action === "seekto" ? { seekTime: 1800 } : {});
  }
  assert.deepEqual(s.calls, [
    "play", "pause", "stop", "previous", "next",
    `seekBy:-${SEEK_BACKWARD_SEC}`, `seekBy:${SEEK_FORWARD_SEC}`, "seekTo:1800",
  ]);
});

test("the bridge forwards the platform's details, it does not swallow them", () => {
  // A bridge that called `handler()` with no arguments would pass every test
  // above and quietly ignore a head unit's own seek offset and scrub position.
  const nav = fakeNav();
  const s = recordingSurface();
  createMediaSession({ nav }).setActions(s);
  nav._ms.handlers.get("seekforward")({ seekOffset: 10 });
  nav._ms.handlers.get("seekto")({ seekTime: 42 });
  assert.deepEqual(s.calls, ["seekBy:10", "seekTo:42"]);
});

test("a handler installed by the bridge reaches a REAL manager", async () => {
  // End to end with no DOM: the OS's own entry point, through the bridge, into
  // the real PlayerQueueManager, out at the backend.
  const { r, backend, manager } = await realPlayer();
  const nav = fakeNav();
  createMediaSession({ nav }).setActions({
    play: () => manager.resume(),
    pause: () => manager.pause(),
    next: () => manager.skipToNext(),
  });
  backend.calls.length = 0;
  /* A MediaSession action handler's return value is ignored by the platform, so
     the bridge does not hand one back and there is nothing to await. Drain the
     microtask queue instead — the fake backend does no real I/O, so everything
     the manager does settles inside it. */
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  nav._ms.handlers.get("nexttrack")({});
  await settle();
  assert.equal(manager.currentIndex, 1);
  assert.ok(backend.calls.includes(`load:${r.playable[1].id}@${Math.round(r.playable[1].start_sec)}`),
    backend.calls.join(" "));
  nav._ms.handlers.get("pause")({});
  await settle();
  assert.equal(manager.state.type, "interrupted");
});

test("an action whose surface throws does not propagate into the platform", () => {
  const nav = fakeNav();
  const bridge = createMediaSession({ nav });
  bridge.setActions({ next: () => { throw new Error("boom"); } });
  assert.doesNotThrow(() => nav._ms.handlers.get("nexttrack")({}));
});

test("an action whose surface rejects does not become an unhandled rejection", () => {
  const nav = fakeNav();
  const bridge = createMediaSession({ nav });
  bridge.setActions({ next: () => Promise.reject(new Error("nope")) });
  assert.doesNotThrow(() => nav._ms.handlers.get("nexttrack")({}));
});

test("update writes metadata, playback state and position", () => {
  const nav = fakeNav();
  const bridge = createMediaSession({ nav });
  bridge.update(mediaSessionView({
    item: SEG, forayTitle: "F", index: 0, total: 3,
    durationSec: 600, positionSec: 12, playing: true, showArtworkUrl: APPLE,
  }));
  assert.deepEqual(nav._log.filter((l) => !l.startsWith("metadata:")), ["state:playing", "position:12"]);
});

/** The real `MediaMetadata`, near enough: it copies its init dictionary. */
class FakeMediaMetadata {
  constructor(init) { Object.assign(this, init); }
}

test("the PUBLISHER's name is what actually reaches the platform, not ours", () => {
  /* The reviewer's finding, made permanent: this is asserted on the object the
     bridge WROTE, not on the mapper's return value, because the two are only the
     same until somebody edits the bridge.
     BOTH BRANCHES, and that matters — the first version of this test ran only
     without a `MediaMetadata` constructor, so `new MediaMetadata({ ...metadata,
     artist: "Foray" })` still credited us for nine publishers' work with the
     whole suite green. Every engine that has a lock screen takes the other
     branch. */
  for (const MediaMetadata of [null, FakeMediaMetadata]) {
    const nav = fakeNav();
    createMediaSession({ nav, MediaMetadata }).update(mediaSessionView({
      item: SEG, forayTitle: "The history of grilling", index: 11, total: 32,
      durationSec: 600, positionSec: 12, playing: true, showArtworkUrl: APPLE,
    }));
    assert.deepEqual(metadataWrites(nav), [{
      title: "Episode 09: Did Cooking Make Us Human?",
      artist: "Origin Stories",
      album: "The history of grilling · part 12 of 32",
      artwork: APPLE,
    }], MediaMetadata ? "with a MediaMetadata constructor" : "without one");
  }
});

test("the artwork really reaches the platform, and falls back to ours when it must", () => {
  for (const MediaMetadata of [null, FakeMediaMetadata]) {
    const nav = fakeNav();
    createMediaSession({ nav, MediaMetadata })
      .update(mediaSessionView({ item: SEG, durationSec: 60, positionSec: 1, playing: true }));
    assert.equal(metadataWrites(nav)[0].artwork, APP_ARTWORK_URL);
  }
});

test("an unchanged view does NOT rewrite metadata — a 4 Hz redraw flickers the notification", () => {
  const nav = fakeNav();
  const bridge = createMediaSession({ nav });
  const view = mediaSessionView({ item: SEG, forayTitle: "F", index: 0, total: 3, durationSec: 600, positionSec: 12, playing: true });
  bridge.update(view);
  bridge.update(view);
  bridge.update(view);
  assert.equal(nav._log.filter((l) => l.startsWith("metadata:")).length, 1);
  assert.equal(nav._log.filter((l) => l.startsWith("state:")).length, 1);
});

test("a new segment DOES rewrite metadata", () => {
  const nav = fakeNav();
  const bridge = createMediaSession({ nav });
  bridge.update(mediaSessionView({ item: SEG, forayTitle: "F", index: 0, total: 3, durationSec: 600, positionSec: 1, playing: true }));
  bridge.update(mediaSessionView({
    item: { kind: "episode", title: "Smoke and time", show: "The BBQ Central Show" },
    forayTitle: "F", index: 1, total: 3, durationSec: 600, positionSec: 120, playing: true,
  }));
  assert.deepEqual(metadataWrites(nav).map((m) => `${m.title} / ${m.artist}`), [
    "Episode 09: Did Cooking Make Us Human? / Origin Stories",
    "Smoke and time / The BBQ Central Show",
  ]);
});

test("a moving playhead writes position, a still one stops writing", () => {
  const nav = fakeNav();
  const bridge = createMediaSession({ nav });
  const at = (positionSec) => mediaSessionView({ item: SEG, forayTitle: "F", index: 0, total: 3, durationSec: 600, positionSec, playing: true });
  bridge.update(at(10));
  bridge.update(at(10));
  bridge.update(at(11));
  assert.deepEqual(nav._log.filter((l) => l.startsWith("position:")), ["position:10", "position:11"]);
});

test("an engine with no setPositionState is not a failure — older Safari", () => {
  const nav = fakeNav({ withPositionState: false });
  const bridge = createMediaSession({ nav });
  assert.doesNotThrow(() => bridge.update(mediaSessionView({ item: SEG, durationSec: 60, positionSec: 1, playing: true })));
  assert.deepEqual(nav._log.filter((l) => l.startsWith("position:")), []);
  assert.ok(nav._log.some((l) => l.startsWith("metadata:")), "metadata must still be written");
});

test("a setPositionState that throws is swallowed, and the render loop survives", () => {
  const nav = fakeNav();
  nav._ms.setPositionState = () => { throw new TypeError("bad state"); };
  const bridge = createMediaSession({ nav });
  assert.doesNotThrow(() => bridge.update(mediaSessionView({ item: SEG, durationSec: 60, positionSec: 1, playing: true })));
});

test("a playbackState setter that throws is swallowed", () => {
  const nav = fakeNav({ withPlaybackState: false });
  Object.defineProperty(nav._ms, "playbackState", { set: () => { throw new Error("nope"); }, configurable: true });
  const bridge = createMediaSession({ nav });
  assert.doesNotThrow(() => bridge.update({ playbackState: PLAYING }));
});

test("a metadata setter that throws is swallowed", () => {
  const nav = fakeNav();
  Object.defineProperty(nav._ms, "metadata", { set: () => { throw new Error("nope"); }, configurable: true });
  const bridge = createMediaSession({ nav });
  assert.doesNotThrow(() => bridge.update({ metadata: { title: "t", artist: "a", album: "b", artwork: [] } }));
});

test("MediaMetadata is used when the engine provides it", () => {
  const seen = [];
  class MM { constructor(init) { Object.assign(this, init); seen.push(init.title); } }
  const nav = fakeNav();
  createMediaSession({ nav, MediaMetadata: MM })
    .update({ metadata: { title: "t", artist: "a", album: "b", artwork: [] } });
  assert.deepEqual(seen, ["t"]);
  assert.ok(nav._ms.metadata instanceof MM);
});

test("a MediaMetadata constructor that throws does not take the page with it", () => {
  const nav = fakeNav();
  const MM = function () { throw new TypeError("bad artwork"); };
  const bridge = createMediaSession({ nav, MediaMetadata: MM });
  assert.doesNotThrow(() => bridge.update({ metadata: { title: "t", artist: "", album: "", artwork: [] } }));
});

test("clear() empties the OS slot and reports none", () => {
  const nav = fakeNav();
  const bridge = createMediaSession({ nav });
  bridge.update(mediaSessionView({ item: SEG, durationSec: 60, positionSec: 1, playing: true }));
  nav._log.length = 0;
  bridge.clear();
  assert.deepEqual(nav._log, ["metadata:null", "state:none", "position:clear"]);
});

test("after clear(), the next identical update writes again rather than being deduped away", () => {
  // Otherwise closing and reopening the same Foray leaves a blank lock screen.
  const nav = fakeNav();
  const bridge = createMediaSession({ nav });
  const view = mediaSessionView({ item: SEG, durationSec: 60, positionSec: 1, playing: true });
  bridge.update(view);
  bridge.clear();
  nav._log.length = 0;
  bridge.update(view);
  assert.ok(nav._log.some((l) => l.startsWith("metadata:")), nav._log.join(" "));
});

/* ---------- 6. the wiring is real, not just tested ---------- */

const CLIENT = readText("player/client.js");
const APP = readText("app.js");
/* EVERY assertion below runs against the COMMENTED-OUT-PROOF form. The reviewer
   defeated four of these by commenting out one line — `// media.setActions(
   forayMediaSurface);` left a Foray with no lock-screen controls at all and the
   whole suite green, because the regex matched the raw file text. A guard that a
   `//` disarms is not a guard. (`codeOnly` is hoisted; see its own note.) */
const CLIENT_CODE = codeOnly(CLIENT);
/* NOT app.js. `codeOnly` cannot survive 1,800 lines of template-literal HTML
   with nested quotes and regex literals — it mangles them, and a mangled scan is
   a scan that reads as coverage. app.js is checked line-wise instead, by
   `liveLines` below, which is narrower but honest. */

/** Lines containing `needle` that are NOT commented out. Deliberately dumb: one
    line, one call, and `//` anywhere before the needle disqualifies it. */
function liveLines(src, needle) {
  return src.split("\n").filter((line) => {
    const at = line.indexOf(needle);
    if (at < 0) return false;
    return !line.slice(0, at).includes("//");
  });
}

test("liveLines ignores a commented-out call, which is the whole reason it exists", () => {
  const src = ["  a.playForay(x);", "  // a.playForay(y);", "  /* a.playForay(z); */"].join("\n");
  assert.deepEqual(liveLines(src, "playForay("), ["  a.playForay(x);", "  /* a.playForay(z); */"]);
});

test("player/client.js drives the lock screen through this module and nothing else", () => {
  assert.match(CLIENT, /import\s*\{[^}]*createMediaSession[^}]*\}\s*from\s*"\.\/media-session\.js"/s);
  assert.match(CLIENT_CODE, /mediaSessionView/);
});

/** Comments and string literals stripped, so a scan for a code path is not
    fooled by prose about it — every file here discusses `navigator.mediaSession`
    at length. Same approach as `test/app-security.test.js`'s `codeOnly`.
 *
 *  ORDER AND THE `//` RULE BOTH MATTER. Strings go before line comments, or a
 *  `//` inside a string starts a comment. And a line comment must be PRECEDED by
 *  start-of-line, whitespace, or an opener — the first draft accepted any
 *  character but `:`, which meant the `\/` ending a regex literal such as
 *  `/^data:image\//i` began a "comment" that swallowed the rest of the line. The
 *  reviewer proved that made the module's whole `data:` branch invisible to the
 *  scans below, and that `navigator.mediaSession.metadata = null` hidden after
 *  such a regex passed them. A scanner with a blind spot reads as coverage. */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, '""')
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/(^|[\s(,;{}=])\/\/[^\n]*/gm, "$1");
}

test("codeOnly does not blind itself on a regex literal — it is the scanner's own guard", () => {
  const src = [
    'if (/^data:image\\//i.test(s)) return s;',
    'const u = "https://example.com/a.png";',
    "// a real comment mentioning navigator.mediaSession",
    "const ok = 1; // trailing comment",
  ].join("\n");
  const out = codeOnly(src);
  assert.match(out, /data:image/, "the data: branch must survive the strip");
  assert.match(out, /test\(s\)/);
  assert.doesNotMatch(out, /a real comment/);
  assert.doesNotMatch(out, /trailing comment/);
  assert.match(out, /const ok = 1;/);
});

test("no file under player/ touches navigator.mediaSession in code", () => {
  /* The whole value of a pure module is lost if a surface reaches around it.
     `media-session.js` receives a `nav` and never reads the global; `client.js`
     hands the global over at exactly one call site and does not dereference it.
     Anything else is a second implementation growing next to the first. */
  const dir = path.join(ROOT, "player");
  const offenders = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".js") || name.endsWith(".test.js")) continue;
    const src = codeOnly(fs.readFileSync(path.join(dir, name), "utf8"));
    if (/navigator\s*(\.|\[)\s*["']?mediaSession/.test(src)) offenders.push(name);
  }
  assert.deepEqual(offenders, [], "route it through createMediaSession({ nav }) instead");
});

test("the module itself never reads a global — it is pure, and that is what makes it testable", () => {
  const src = codeOnly(readText("player/media-session.js"));
  for (const global of ["navigator", "window", "document", "localStorage", "setTimeout"]) {
    assert.doesNotMatch(src, new RegExp(`\\b${global}\\b`), `media-session.js must not reach for ${global}`);
  }
});

test("client.js hands the real navigator over at exactly one place", () => {
  const handovers = CLIENT_CODE.match(/createMediaSession\(/g) ?? [];
  assert.equal(handovers.length, 1, "one bridge, built once in ensureBooted()");
  assert.match(CLIENT_CODE, /nav: typeof navigator/);
  assert.match(CLIENT_CODE, /\? navigator : null/);
});

test("the lock screen's previous/next are the page's own segment controls", () => {
  // Not a parallel implementation: the same two functions the ‹‹ / ›› buttons
  // call, so `forayPrevious`'s restart-vs-previous window cannot diverge.
  const surface = /const forayMediaSurface = \{[\s\S]*?\n\};/.exec(CLIENT_CODE);
  assert.ok(surface, "player/client.js must define forayMediaSurface");
  assert.match(surface[0], /next:\s*\(\)\s*=>\s*ForayPlayer\.forayNext\(\)/);
  assert.match(surface[0], /previous:\s*\(\)\s*=>\s*ForayPlayer\.forayPrevious\(\)/);
  assert.match(surface[0], /seekTo:\s*\(position\)\s*=>\s*ForayPlayer\.foraySeek\(position\)/);
});

test("the lock screen's play/pause is the same call the in-page button makes", () => {
  const surface = /const forayMediaSurface = \{[\s\S]*?\n\};/.exec(CLIENT_CODE)[0];
  assert.match(surface, /play:\s*\(\)\s*=>\s*setRunning\(true\)/);
  assert.match(surface, /pause:\s*\(\)\s*=>\s*setRunning\(false\)/);
  // ...and the button really does go through the same function.
  assert.match(CLIENT_CODE, /const toggle = \(\) => setRunning\(!isRunning\(\)\)/);
});

test("single-episode playback installs a surface with no next or previous", () => {
  const surface = /const episodeMediaSurface = \{[\s\S]*?\n\};/.exec(CLIENT_CODE);
  assert.ok(surface, "player/client.js must define episodeMediaSurface");
  assert.doesNotMatch(surface[0], /\bnext:/);
  assert.doesNotMatch(surface[0], /\bprevious:/);
});

test("the Foray surface is installed INSIDE playForay, not merely defined somewhere", () => {
  /* The reviewer's cheapest defeat: comment out the one install line and a Foray
     gets no lock-screen controls at all — or worse, inherits a stale episode
     surface from earlier in the session. So the assertion is about WHERE it sits,
     against comment-stripped source. */
  const body = /async playForay\([\s\S]*?\n  \},/.exec(CLIENT_CODE);
  assert.ok(body, "player/client.js must define playForay");
  assert.match(body[0], /media\.setActions\(forayMediaSurface\)/);
});

test("the episode surface is installed INSIDE play(), for the same reason", () => {
  const body = /async play\(item[\s\S]*?\n  \},/.exec(CLIENT_CODE);
  assert.ok(body, "player/client.js must define play(item)");
  assert.match(body[0], /media\.setActions\(episodeMediaSurface\)/);
});

test("the FORAY's clock is what client.js reports — the whole thing, not the segment", () => {
  /* Decision (3), pinned where it can actually be broken. `mediaSessionView` is
     pure and will faithfully report whatever it is handed, so testing it proves
     pass-through and nothing more: swapping these two lines for
     `backend.duration` / `backend.currentTime` reverses the decision — a car then
     shows "31 minutes into somebody else's episode", and because `seekto` still
     routes to `foraySeek`, a head-unit scrub lands somewhere unrelated to where
     the listener dragged. */
  const block = /if \(foray\) \{[\s\S]*?media\.update\(mediaSessionView\(\{[\s\S]*?\}\)\);/.exec(CLIENT_CODE);
  assert.ok(block, "syncMediaSession must have a foray branch");
  assert.match(block[0], /durationSec: foray\.resolved\.totalSec/);
  assert.match(block[0], /positionSec: forayPosition\(\)/);
  assert.match(block[0], /item: items\[index\]/);
  assert.match(block[0], /total: items\.length/);
});

test("the seam-beat state reaches the bridge from the manager, not from a guess", () => {
  assert.match(CLIENT_CODE, /inSeamGap:\s*manager\?\.inSeamGap === true/);
});

test("the finished state reaches the bridge too, so a done Foray clears the slot", () => {
  // Scoped to syncMediaSession: `forayStateSnapshot` reads the same state for the
  // page, and counting the file over would pass on that one alone.
  const fn = /function syncMediaSession\(\)[\s\S]*?\n\}/.exec(CLIENT_CODE);
  assert.ok(fn, "player/client.js must define syncMediaSession");
  // `codeOnly` blanks string literals, so the state name reads as `""` here.
  const writes = fn[0].match(/ended: manager\?\.state\?\.type === ""/g) ?? [];
  assert.equal(writes.length, 2, "both the Foray branch and the single-episode branch report it");
  // ...and the state really is spelled "ended" in the source.
  assert.ok(liveLines(CLIENT, 'manager?.state?.type === "ended"').length >= 2);
});

test("the lock screen is repainted from the same render tick the page is", () => {
  assert.match(CLIENT_CODE, /\n  syncMediaSession\(\);/);
});

test("client.js declares no second copy of the ±15/30 numbers", () => {
  // They are imported from media-session.js so the page and the lock screen
  // cannot drift apart on what "back" means.
  assert.doesNotMatch(CLIENT_CODE, /const SEEK_BACK = \d/);
  assert.doesNotMatch(CLIENT_CODE, /const SEEK_FWD = \d/);
  assert.match(CLIENT_CODE, /const SEEK_BACK = SEEK_BACKWARD_SEC;/);
  assert.match(CLIENT_CODE, /const SEEK_FWD = SEEK_FORWARD_SEC;/);
});

test("EVERY playForay call site in app.js passes the artwork document", () => {
  /* Receiver-agnostic on purpose: the first draft matched `player.playForay(`,
     so a site written `window.ForayPlayer.playForay(...)` would have been
     invisible while the count still passed on the existing three. The exact count
     is deliberate too — `>= 3` lets a fourth, artwork-less call site merge. */
  const calls = liveLines(APP, "playForay(");
  assert.equal(calls.length, 3, `the known call sites are three; found ${calls.length} — check the new one`);
  const missing = calls.filter((c) => !/forayOpts|discoverDoc/.test(c));
  assert.deepEqual(missing, [], "a Foray started without discoverDoc loses the publisher's artwork");
});

test("app.js hands over the discover pool it already fetched, not a new request", () => {
  assert.deepEqual(
    liveLines(APP, "const forayOpts =").map((l) => l.trim()),
    ["const forayOpts = { onChange, discoverDoc: state.discover };"]
  );
});

test("index.html's CSP already permits https artwork, so nothing here widened it", () => {
  /* MediaSession artwork is fetched by the browser for the OS and is subject to
     img-src. If this assertion ever fails, the artwork in this module stopped
     being allowed — fix the module, do not widen the policy. */
  const html = readText("index.html");
  const csp = /content="([^"]*default-src[^"]*)"/.exec(html);
  assert.ok(csp, "index.html must carry a CSP");
  assert.match(csp[1], /img-src[^;]*https:/);
  assert.match(csp[1], /img-src[^;]*data:/);
});
