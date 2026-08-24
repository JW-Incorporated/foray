/* Tests for DAI host classification (issue #22). Run: node --test tools/refresh/

   The host list is the ONLY signal — the duration-variance probe was measured
   and dropped (see the header of dai.mjs for the numbers). So the matcher's
   correctness is the whole of this feature's correctness. */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  isDaiHost,
  DAI_HOSTS,
  mergeShowEntry,
  classifyShow,
  resolveChain,
  daiHostIn,
  daiReason,
  MAX_REDIRECT_HOPS,
} from "./dai.mjs";

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


/* MUTATION: restore the original assignment in classify-dai.mjs --
   `cache.shows[cid] = { show, ...verdict }` -- or make mergeShowEntry drop the
   spread of `existing`.

   That is what --recheck did until 2026-08-23, and it is destructive in a way
   nothing reports: a re-resolve rewrites the four fields this module owns and
   deletes `ad_inflation`, the measured ad-load verdict plus the per-episode
   byte samples behind it. The resolve costs one request; the measurement it
   would have deleted cost 112, and the file would still look healthy. */
test("a recheck updates the host verdict without deleting the measurement", () => {
  const existing = {
    show: "Tuned In",
    dai: false,
    reason: "unknown",
    resolved_host: "old.example.com",
    checked_at: "2026-01-01T00:00:00.000Z",
    ad_inflation: { verdict: "ad-free", median_ratio: 1, episodes_probed: 5 },
  };
  const verdict = {
    dai: true,
    reason: "host:audio.buzzsprout.com",
    resolved_host: "audio.buzzsprout.com",
    checked_at: "2026-08-23T00:00:00.000Z",
  };
  const merged = mergeShowEntry(existing, "Tuned In", verdict);

  // The host verdict still wins for its own fields -- a recheck that could not
  // overwrite a stale flag would have no reason to exist.
  assert.equal(merged.dai, true);
  assert.equal(merged.resolved_host, "audio.buzzsprout.com");
  assert.equal(merged.checked_at, "2026-08-23T00:00:00.000Z");
  // ...and it does not get to speak for fields it knows nothing about.
  assert.deepEqual(merged.ad_inflation, existing.ad_inflation);
});

test("mergeShowEntry handles a show seen for the first time", () => {
  const merged = mergeShowEntry(undefined, "New Show", { dai: false, reason: "unknown" });
  assert.deepEqual(merged, { show: "New Show", dai: false, reason: "unknown" });
});

/* ------------------------------------------------- the redirect CHAIN (#319)

   The bug these cover: `resolveHost` follows redirects with Node doing the
   walking, so only the last hop survives. `dts.podtrac.com -> api.spreaker.com
   -> d1bxy2pveef3fq.cloudfront.net` therefore classified as "unknown" — a
   positive identification discarded by the very step that exists to find one.
   Five breadth shows, 2,470 timed transcripts.

   These inject `fetchImpl` and `gate`, so nothing here makes a request or
   waits for one. */

const stubRes = (status, location) => ({
  status,
  headers: { get: (k) => (String(k).toLowerCase() === "location" && location ? location : null) },
});

/** A fetch stub that replays a scripted chain and records what it was asked. */
function chainFetch(script) {
  const asked = [];
  const impl = async (url) => {
    asked.push(url);
    const next = script[url];
    if (next instanceof Error) throw next;
    return next ? stubRes(302, next) : stubRes(206, null);
  };
  return { impl, asked };
}

const noGate = async () => 0;

/* MUTATION: in `resolveChain`, report only the landing host (drop the
   accumulation into `chain`), or make `daiHostIn` test only the last element.
   Either restores the pre-fix behaviour and this fails — `api.spreaker.com` is
   the MIDDLE hop, and neither end of this chain is on the host list. */
test("a DAI platform in the MIDDLE of the chain is still a DAI platform", async () => {
  const start = "https://dts.podtrac.com/redirect.mp3/api.spreaker.com/download/episode/1/x.mp3";
  const { impl, asked } = chainFetch({
    [start]: "https://api.spreaker.com/download/episode/1/x.mp3",
    "https://api.spreaker.com/download/episode/1/x.mp3": "https://d1bxy2pveef3fq.cloudfront.net/1/x.mp3",
  });
  const v = await classifyShow(start, { fetchImpl: impl, gate: noGate });

  assert.equal(v.dai, true);
  assert.equal(
    v.reason,
    "host:api.spreaker.com (in redirect chain; landed on d1bxy2pveef3fq.cloudfront.net)",
  );
  /* `resolved_host` keeps meaning what it always meant — where the chain
     LANDED. Everything already reading data/dai-classification.json depends on
     that, which is why the chain is a new field rather than a redefinition. */
  assert.equal(v.resolved_host, "d1bxy2pveef3fq.cloudfront.net");
  assert.deepEqual(v.resolved_chain, [
    "dts.podtrac.com",
    "api.spreaker.com",
    "d1bxy2pveef3fq.cloudfront.net",
  ]);
  assert.equal(asked.length, 3);
});

/* MUTATION: drop `resolved_chain` from what `classifyShow` returns, or rename
   any of the other four keys. `mergeShowEntry` spreads this object over the
   cached entry, so a renamed key does not replace the old one — it lands
   BESIDE it and the stale value keeps being read. */
test("the record shape is ADDED to, never replaced", async () => {
  const { impl } = chainFetch({ "https://static.example.org/a.mp3": null });
  const v = await classifyShow("https://static.example.org/a.mp3", { fetchImpl: impl, gate: noGate });
  assert.deepEqual(Object.keys(v).sort(), ["checked_at", "dai", "reason", "resolved_chain", "resolved_host"]);
  assert.equal(v.dai, false);
  assert.equal(v.reason, "unknown");
  assert.equal(v.resolved_host, "static.example.org");
});

/* MUTATION: in `resolveChain`'s `catch`, return `{ chain: [] }` instead of
   `{ chain }` — i.e. throw away the hosts already reached when a hop fails.
   Verified failing on both assertions below.

   A chain that dies part-way still knows the hosts it already reached, and one
   of them may be the whole answer: a feed declaring a megaphone.fm enclosure is
   DAI whether or not megaphone answers this second. Losing that turns a
   known-DAI show into `unknown` on a transient blip — in the permissive
   direction, which is the one that costs something.

   NAMED CAREFULLY, because the first version of this comment named a mutation
   that did NOT fire. It pointed at a `chain.length ? chain : [declared]`
   fallback in `classifyShow`, and deleting that fallback changed nothing:
   `resolveChain` appends each host BEFORE fetching from it, so the fallback
   could never run. The code was unreachable and the guard was decoration. It
   is deleted; this is the mutation that actually exercises the behaviour. */
test("a chain that fails mid-walk keeps the evidence it already had", async () => {
  const { impl } = chainFetch({
    "https://pdst.fm/e/x.mp3": "https://dcs-cached.megaphone.fm/x.mp3",
    "https://dcs-cached.megaphone.fm/x.mp3": new Error("socket hang up"),
  });
  const v = await classifyShow("https://pdst.fm/e/x.mp3", { fetchImpl: impl, gate: noGate });
  assert.equal(v.dai, true);
  assert.deepEqual(v.resolved_chain, ["pdst.fm", "dcs-cached.megaphone.fm"]);
  assert.equal(
    v.reason,
    "host:dcs-cached.megaphone.fm (chain incomplete at dcs-cached.megaphone.fm: socket hang up)",
  );
  /* `resolved_host` falls back to the DECLARED host, not to the hop that died.
     `classify-dai.mjs` prints a "resolved origins" histogram from this field,
     and a host that never answered is not an origin. */
  assert.equal(v.resolved_host, "pdst.fm");

  const dead = await classifyShow("https://megaphone.fm/x.mp3", {
    fetchImpl: async () => { throw new Error("ENOTFOUND"); },
    gate: noGate,
  });
  assert.equal(dead.dai, true, "the declared host on its own is still evidence");
  assert.deepEqual(dead.resolved_chain, ["megaphone.fm"]);
});

/* MUTATION: in `resolveChain`, drop the `status >= 400` branch so a refusal
   returns `error: null` like a clean landing. Verified failing.

   A 403 and a 404 carry no `Location`, so the obvious "no Location means we
   have arrived" reads a refusal as a successful resolution — and the record
   then says `dai: false, reason: "unknown"`, which is indistinguishable from a
   chain that really landed somewhere static and makes the show ANCHORABLE.
   This is the exact shape of #316's most expensive bug: a blocked User-Agent
   drew 403s that `ad-inflation.mjs` reported as "could not tell" for 423
   transcripts. A refusal has to be greppable. */
test("a refusal is an error, not a destination", async () => {
  for (const status of [403, 404, 500]) {
    const v = await classifyShow("https://static.example.org/a.mp3", {
      gate: noGate,
      fetchImpl: async () => stubRes(status, null),
    });
    assert.equal(v.reason, `unknown (resolve failed: HTTP ${status})`, `status ${status}`);
    assert.equal(v.dai, false);
  }
  // ...and a real landing still reports no error at all.
  const ok = await classifyShow("https://static.example.org/a.mp3", {
    gate: noGate,
    fetchImpl: async () => stubRes(206, null),
  });
  assert.equal(ok.reason, "unknown");
});

/* MUTATION: delete the `next.protocol` check in `resolveChain`. Verified
   failing.

   `new URL("mailto:x@y", base)` parses, and its `.host` is the empty string, so
   without the check the loop pushes `""` into the chain and spends a real
   request trying to range-GET a mailto: URL. Nothing misclassifies — `""` is
   not a DAI host — but the chain we file as evidence acquires a member that is
   not a host, and we made a pointless request to learn it. */
test("a redirect to something that is not http stops the walk", async () => {
  const { chain, error } = await resolveChain("https://a.example.org/x.mp3", {
    gate: noGate,
    fetchImpl: async () => stubRes(302, "mailto:someone@example.org"),
  });
  assert.equal(error, "unfollowable scheme: mailto:");
  assert.deepEqual(chain, ["a.example.org"], "no empty-string host in the evidence");
});

/* MUTATION: remove the `hop === maxHops` guard, or set MAX_REDIRECT_HOPS to
   Infinity. A redirect loop then spins forever against a live host, which is
   the one way a classification bug becomes an abuse complaint. */
test("a redirect loop stops at the hop cap instead of spinning", async () => {
  let calls = 0;
  const impl = async () => { calls++; return stubRes(302, "https://loop.example.org/next"); };
  const { chain, error } = await resolveChain("https://loop.example.org/a", { fetchImpl: impl, gate: noGate });

  assert.equal(error, "too many redirects");
  assert.equal(calls, MAX_REDIRECT_HOPS);
  /* Same host every hop, recorded once: the chain is hosts-in-order, not a hop
     log, so a loop cannot inflate it into a wall of duplicates. */
  assert.deepEqual(chain, ["loop.example.org"]);
});

/* MUTATION: delete the `await gate(current)` line in `resolveChain`.

   `redirect: "follow"` got Node's chain-walk for free AND unthrottled. Walking
   it by hand means throttling it by hand, or one classification becomes an
   un-gated burst across up to MAX_REDIRECT_HOPS hosts and a 500-feed sweep is
   500 of those. Asserts on the CALL rather than on elapsed time, so it is
   instant and cannot flake. */
test("every hop passes through the shared host gate", async () => {
  const gated = [];
  const { impl } = chainFetch({
    "https://a.example.org/x.mp3": "https://b.example.org/x.mp3",
    "https://b.example.org/x.mp3": "https://c.example.org/x.mp3",
  });
  await resolveChain("https://a.example.org/x.mp3", {
    fetchImpl: impl,
    gate: async (u) => { gated.push(u); return 0; },
  });
  assert.deepEqual(gated, [
    "https://a.example.org/x.mp3",
    "https://b.example.org/x.mp3",
    "https://c.example.org/x.mp3",
  ]);
});

/* MUTATION: make `daiHostIn` return the LAST match rather than the first. The
   chain runs prefix -> platform -> CDN, so the first match is the most specific
   name available and the one a human can verify by hand. */
test("daiHostIn names the earliest platform in the chain", () => {
  assert.equal(daiHostIn(["dts.podtrac.com", "api.spreaker.com", "cdn.simplecast.com"]), "api.spreaker.com");
  assert.equal(daiHostIn(["dts.podtrac.com", "content.libsyn.com"]), null);
  assert.equal(daiHostIn([]), null);
  assert.equal(daiHostIn(undefined), null);
});

/* MUTATION: in `classify-dai.mjs`, put back the inline
   `entry.reason = dai ? "host:" + entry.resolved_host : "unknown"` in place of
   the `daiReason` call.

   That is a SECOND spelling of a sentence this module already writes, and
   `--reclassify` is the mode that overwrites the online one with it. The two
   happened to agree for as long as a verdict could only ever name the landing
   host; the moment it can name a middle hop they diverge, and the offline pass
   wins. Asserting they are one function is the only durable form of "they
   agree". */
test("the reason sentence has exactly one author", () => {
  assert.equal(
    daiReason("api.spreaker.com", "d1bxy2pveef3fq.cloudfront.net", null),
    "host:api.spreaker.com (in redirect chain; landed on d1bxy2pveef3fq.cloudfront.net)",
  );
  /* No detour clause when the platform IS the landing host. This is the exact
     string every pre-existing DAI entry in data/dai-classification.json
     carries, and a --reclassify pass must not churn 141 rows by rewording it. */
  assert.equal(daiReason("megaphone.fm", "megaphone.fm", null), "host:megaphone.fm");
  assert.equal(daiReason(null, "content.libsyn.com", null), "unknown");
  assert.equal(daiReason(null, "content.libsyn.com", "timeout"), "unknown (resolve failed: timeout)");
  /* The failure clause names where the walk STOPPED. It used to say "declared
     host used", which was true of `resolveHost` (it returned null on failure,
     so the declared host really was the fallback) and false the moment
     `resolveChain` started reporting the hop it died on. */
  assert.equal(
    daiReason("megaphone.fm", "dcs-cached.megaphone.fm", "timeout"),
    "host:megaphone.fm (in redirect chain; landed on dcs-cached.megaphone.fm) (chain incomplete at dcs-cached.megaphone.fm: timeout)",
  );
});

/* MUTATION: in `classify-dai.mjs`, replace the `daiReason(...)` call with any
   inline spelling — `"host:" + entry.resolved_host`, a template literal, or a
   copy of the function. Verified failing on the second assertion.

   The test above pins what `daiReason` RETURNS; it cannot see whether the one
   caller that could contradict it still calls it. `classify-dai.mjs` is a
   top-level script that reads three data files on import, so it cannot be
   imported into a test — a source scan is the only instrument available, and
   this repo already uses exactly that shape for the User-Agent guard in
   `politeness.test.mjs`.

   SCANNING FOR THE ABSENCE OF SOMETHING IS THE FAILURE-PRONE DIRECTION, which
   #318 learned the expensive way: its first guard failed OPEN because a regex
   literal containing an apostrophe blinded the scanner, and eleven files were
   already invisible to it. So this asserts a POSITIVE fact first — the import
   and the call are both present — and only then the negative one. A scanner
   that has stopped seeing the file fails the positive assertion loudly instead
   of passing the negative one quietly. */
test("--reclassify cannot grow a second spelling of the reason", () => {
  const src = readFileSync(new URL("./classify-dai.mjs", import.meta.url), "utf8");

  // Positive: the guard can still see the file it thinks it is reading.
  assert.match(src, /import \{[^}]*daiReason[^}]*\} from "\.\/dai\.mjs"/, "the scanner has lost sight of the import");
  assert.match(src, /entry\.reason = daiReason\(/, "the scanner has lost sight of the assignment");

  /* Negative: and there is no other author of that sentence in this file.

     WRITTEN AS "READ THE RIGHT-HAND SIDE", NOT AS A NEGATIVE LOOKAHEAD. The
     first version of this line was `/reason\s*=\s*(?!daiReason\()/` and it
     failed on the correct code: `\s*` backtracks to empty, which moves the
     lookahead one character left onto the space before `daiReason`, and the
     assertion fires on the one call it exists to bless. A guard that cannot
     tell right from wrong in the direction it is not testing is not a guard —
     so this captures each right-hand side and inspects it, which has no
     backtracking to get wrong. `(?!=)` keeps `===` out of the sample. */
  const rhs = [...src.matchAll(/\breason\s*=(?!=)\s*([^\s;]+)/g)].map((m) => m[1]);
  assert.ok(rhs.length > 0, "the scanner found no `reason =` at all — it has stopped seeing the file");
  assert.deepEqual(
    rhs.filter((r) => !r.startsWith("daiReason(")),
    [],
    "classify-dai.mjs writes a `reason` it did not get from daiReason()",
  );
});
