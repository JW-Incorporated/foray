/* Tests for the audio-provenance helpers. Run: node --test tools/refresh/

   These parse third-party RSS, which corner case #5 warns is "invalid XML that
   browsers tolerate, CDATA soup, wrong itunes:duration formats". Every case
   below is a shape real feeds actually emit. */

import test from "node:test";
import assert from "node:assert/strict";
import {
  pickEnclosure, durationSeconds, isPlayableType, looksTokened, audioFieldsFrom, hostOf, normalizeAudioUrl,
} from "./enclosure.mjs";

const enc = (url, type, length) => ({
  enclosure: { "@_url": url, ...(type ? { "@_type": type } : {}), ...(length != null ? { "@_length": String(length) } : {}) },
});

/* ---------- pickEnclosure ---------- */

test("pickEnclosure reads url, type and length", () => {
  const r = pickEnclosure(enc("https://cdn.example/ep.mp3", "audio/mpeg", 139400352));
  assert.deepStrictEqual(r, { url: "https://cdn.example/ep.mp3", type: "audio/mpeg", bytes: 139400352 });
});

test("pickEnclosure treats length=0 as unknown, not zero bytes", () => {
  // Extremely common in the wild; 0 would break download progress and LRU
  // accounting in #29 if taken literally.
  assert.equal(pickEnclosure(enc("https://cdn.example/ep.mp3", "audio/mpeg", 0)).bytes, null);
});

test("pickEnclosure ignores a non-numeric length", () => {
  assert.equal(pickEnclosure(enc("https://cdn.example/ep.mp3", "audio/mpeg", "unknown")).bytes, null);
});

test("pickEnclosure prefers the audio entry when a feed repeats the tag", () => {
  // Malformed feeds emit multiple <enclosure> elements; fast-xml-parser hands
  // back an array. Take the audio one, not merely the first.
  const item = { enclosure: [
    { "@_url": "https://cdn.example/ep.mp4", "@_type": "video/mp4" },
    { "@_url": "https://cdn.example/ep.mp3", "@_type": "audio/mpeg" },
  ] };
  assert.equal(pickEnclosure(item).url, "https://cdn.example/ep.mp3");
});

test("pickEnclosure falls back to the first entry when none are audio", () => {
  const item = { enclosure: [{ "@_url": "https://cdn.example/a.bin" }, { "@_url": "https://cdn.example/b.bin" }] };
  assert.equal(pickEnclosure(item).url, "https://cdn.example/a.bin");
});

test("pickEnclosure survives a missing enclosure", () => {
  assert.deepStrictEqual(pickEnclosure({}), { url: null, type: null, bytes: null });
  assert.deepStrictEqual(pickEnclosure(undefined), { url: null, type: null, bytes: null });
});

/* ---------- durationSeconds (corner case #5) ---------- */

test("durationSeconds handles all four formats real feeds use", () => {
  assert.equal(durationSeconds("3:13:37"), 11617);  // HH:MM:SS — measured on Lex
  assert.equal(durationSeconds("37:24"), 2244);     // MM:SS
  assert.equal(durationSeconds("2244"), 2244);      // bare seconds
  assert.equal(durationSeconds("  1:00:00  "), 3600); // padded
});

test("durationSeconds returns null on garbage rather than NaN", () => {
  // NaN would propagate into the scrubber range and render an unusable UI.
  for (const bad of ["", "  ", "unknown", "1:2:3:4", null, undefined, "abc:def"]) {
    assert.equal(durationSeconds(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

/* ---------- type policy (corner case #6) ---------- */

test("isPlayableType accepts audio and a missing type, rejects video", () => {
  assert.equal(isPlayableType("audio/mpeg"), true);
  assert.equal(isPlayableType("audio/x-m4a"), true);
  assert.equal(isPlayableType(null), true, "plenty of feeds omit type; let the player degrade instead");
  assert.equal(isPlayableType("video/mp4"), false);
});

/* ---------- token guard (corner case #9) ---------- */

test("looksTokened flags credential-bearing URLs", () => {
  for (const u of [
    "https://cdn.example/ep.mp3?token=abc123",
    "https://cdn.example/ep.mp3?foo=1&auth=xyz",
    "https://cdn.example/ep.mp3?api_key=k",
    "https://cdn.example/ep.mp3?apikey=k",
    "https://cdn.example/ep.mp3?session=s",
  ]) assert.equal(looksTokened(u), true, u);
});

test("looksTokened does not flag ordinary tracking params", () => {
  // A false positive silently makes an episode unplayable, so this guard is
  // deliberately narrow. These are all shapes real public feeds use.
  for (const u of [
    "https://cdn.example/ep.mp3",
    "https://cdn.example/ep.mp3?source=rss",
    "https://cdn.example/ep.mp3?utm_medium=podcast&utm_source=feed",
    "https://cdn.example/ep.mp3?ptm_source=rss&aid=12",
  ]) assert.equal(looksTokened(u), false, u);
});

/* ---------- audioFieldsFrom ---------- */

test("audioFieldsFrom returns a clean record for a normal item", () => {
  const r = audioFieldsFrom({ ...enc("https://cdn.example/ep.mp3", "audio/mpeg", 100), "itunes:duration": "45:00" });
  assert.equal(r.audio_url, "https://cdn.example/ep.mp3");
  assert.equal(r.audio_type, "audio/mpeg");
  assert.equal(r.audio_bytes, 100);
  assert.equal(r.duration_sec, 2700);
  assert.equal(r.reason, null);
});

test("audioFieldsFrom withholds a tokened URL and says why", () => {
  const r = audioFieldsFrom(enc("https://cdn.example/ep.mp3?token=secret", "audio/mpeg"));
  assert.equal(r.audio_url, null, "a tokened URL must never reach a public data file");
  assert.match(r.reason, /tokened/);
});

test("audioFieldsFrom withholds video-only and non-https enclosures", () => {
  assert.equal(audioFieldsFrom(enc("https://cdn.example/ep.mp4", "video/mp4")).audio_url, null);
  assert.equal(audioFieldsFrom(enc("ftp://cdn.example/ep.mp3", "audio/mpeg")).audio_url, null);
});

test("audioFieldsFrom UPGRADES cleartext http rather than dropping the item", () => {
  // Real feeds in this catalogue publish http enclosures (Hardcore History,
  // Lingthusiasm, Designer Notes, Music History Monday...). Cleartext is
  // unplayable in the shipped app, but dropping would cost real shows —
  // and all four affected hosts serve the identical path over https
  // (verified: 206 + audio/mpeg). Only the transport changes, so corner
  // case #1's download-attribution still holds.
  const r = audioFieldsFrom(enc("http://dts.podtrac.com/redirect.mp3/x/ep.mp3", "audio/mpeg"));
  assert.equal(r.audio_url, "https://dts.podtrac.com/redirect.mp3/x/ep.mp3");
  assert.equal(r.reason, null);
});

test("normalizeAudioUrl is the single gate for both RSS and iTunes URLs", () => {
  assert.equal(normalizeAudioUrl("http://a.example/e.mp3").url, "https://a.example/e.mp3");
  assert.equal(normalizeAudioUrl("https://a.example/e.mp3").url, "https://a.example/e.mp3");
  assert.equal(normalizeAudioUrl("HTTP://A.example/E.mp3").url, "https://A.example/E.mp3");
  // Host and path must survive the upgrade untouched — publishers count
  // downloads at exactly this URL.
  assert.equal(normalizeAudioUrl("http://x.example/a/b?c=1#f").url, "https://x.example/a/b?c=1#f");
  assert.equal(normalizeAudioUrl("ftp://a.example/e.mp3").url, null);
  assert.equal(normalizeAudioUrl("https://a.example/e.mp3?token=s").url, null);
  assert.equal(normalizeAudioUrl(null).url, null);
  assert.equal(normalizeAudioUrl("").url, null);
});

test("audioFieldsFrom keeps duration even when the URL is withheld", () => {
  // The episode still shows a runtime in discovery; it just links out.
  const r = audioFieldsFrom({ ...enc("https://cdn.example/ep.mp4", "video/mp4"), "itunes:duration": "10:00" });
  assert.equal(r.audio_url, null);
  assert.equal(r.duration_sec, 600);
});

/* ---------- hostOf ---------- */

test("hostOf extracts a comparable host and tolerates junk", () => {
  assert.equal(hostOf("https://Media.BLUBRRY.com/x/y.mp3"), "media.blubrry.com");
  assert.equal(hostOf("not a url"), null);
  assert.equal(hostOf(null), null);
});
