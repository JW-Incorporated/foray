/* Tests for DAI host classification (issue #22). Run: node --test tools/refresh/

   The host list is the ONLY signal — the duration-variance probe was measured
   and dropped (see the header of dai.mjs for the numbers). So the matcher's
   correctness is the whole of this feature's correctness. */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isDaiHost, DAI_HOSTS } from "./dai.mjs";

test("matches known DAI platforms", () => {
  for (const h of ["megaphone.fm", "rss.art19.com", "sphinx.acast.com", "omny.fm", "cdn.simplecast.com"]) {
    assert.equal(isDaiHost(h), true, h);
  }
});

test("matches subdomains, because prefix trackers land on them", () => {
  // Measured in this catalogue: pdst.fm -> dcs-cached.megaphone.fm. Matching
  // only the bare domain would misclassify 108 items as static.
  for (const h of [
    "dcs-cached.megaphone.fm",
    "dcs-spotify.megaphone.fm",
    "stitcher.simplecastaudio.com",
    "stitcher2.acast.com",
    "content.production.cdn.art19.com",
    "6b8m1.omnycontent.com",
    "dovetail-cdn.prxu.org",
  ]) assert.equal(isDaiHost(h), true, h);
});

test("does NOT match lookalike domains", () => {
  // Suffix matching must be anchored on a dot boundary, or an attacker-ish or
  // merely unlucky domain gets the wrong verdict.
  for (const h of ["notmegaphone.fm", "megaphone.fm.example.com", "fakeacast.com", "art19.com.evil.net"]) {
    assert.equal(isDaiHost(h), false, h);
  }
});

test("does not match hosts that serve a static file", () => {
  for (const h of [
    "content.libsyn.com",
    "traffic.libsyn.com",
    "media.blubrry.com",
    "content.blubrry.com",
    "feeds.soundcloud.com",
    "cf-media.sndcdn.com",
    "substackcdn.com",
  ]) assert.equal(isDaiHost(h), false, h);
});

test("tolerates junk input rather than throwing", () => {
  for (const h of [null, undefined, "", "   "]) assert.equal(isDaiHost(h), false);
});

test("is case-insensitive", () => {
  assert.equal(isDaiHost("DCS-Cached.MEGAPHONE.FM"), true);
});

test("the committed host list is well formed", () => {
  const raw = JSON.parse(readFileSync(new URL("./dai-hosts.json", import.meta.url), "utf8"));
  assert.ok(Array.isArray(raw.hosts) && raw.hosts.length > 0);
  for (const h of raw.hosts) {
    assert.match(h.host, /^[a-z0-9.-]+\.[a-z]{2,}$/, `bad host entry: ${h.host}`);
    // Every entry must justify itself. This list gates seek precision for real
    // users; an unexplained entry is one nobody can safely remove later.
    assert.ok(h.why && h.why.length > 20, `host ${h.host} needs a real "why"`);
    assert.ok(!h.host.startsWith("."), `host ${h.host} must not start with a dot`);
  }
  assert.equal(new Set(DAI_HOSTS).size, DAI_HOSTS.length, "duplicate host entries");
});

test("prefix trackers are never listed as origins", () => {
  // They are measurement redirectors: podtrac fronts both DAI and static
  // origins, so classifying the prefix itself would be wrong in both
  // directions. dai.mjs resolves through them instead.
  for (const p of ["podtrac.com", "dts.podtrac.com", "pdst.fm", "pdrl.fm", "pscrb.fm", "mgln.ai", "chartable.com"]) {
    assert.equal(isDaiHost(p), false, `${p} is a prefix, not an origin`);
  }
});
