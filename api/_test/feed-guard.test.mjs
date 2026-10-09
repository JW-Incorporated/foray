// SEC-01 (security review 2026-10): a feed fetch reaches only public
// addresses, on the first request and on every redirect. The feed url of a
// `pi:` show is a PodcastIndex row (third-party input), so before this a
// submitted feed naming 127.0.0.1, 169.254.169.254 or a private name - or
// redirecting to one - had the function make that request. Every test names
// the mutation it kills; each was run against the source and turned this
// suite red.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as zlib from "node:zlib";
import { createFeedReader } from "../_lib/feedCache.ts";
import { assertPublicFeedUrl, guardFeedFetch, isBlockedAddress, FeedAddressError, MAX_FEED_REDIRECTS } from "../_lib/feedGuard.ts";
import * as episodesModule from "../shows/[show_id]/episodes.ts";
import { sharedFeedReader } from "../_lib/feedCache.ts";
import { _setPointerPathForTests } from "../_lib/showsIndexRelease.ts";

const handler = typeof episodesModule.default === "function" ? episodesModule.default : episodesModule.default.default;
const { _resetPiShowCacheForTests } = episodesModule;

const FEED = `<?xml version="1.0"?><rss version="2.0"><channel><title>Lex</title>
<item><title>Alpha</title><guid>a</guid><enclosure url="https://cdn.example.com/a.mp3" type="audio/mpeg" length="1"/></item>
</channel></rss>`;

/** A resolver that answers from a table and never touches the network. */
const table = (map) => async (host) => {
  if (!(host in map)) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
  return map[host].map((address) => ({ address }));
};

/** Records every request; `routes` maps a url to a Response factory, anything
    else answers the feed. */
function recorder(routes = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), redirect: init?.redirect });
    const r = routes[String(url)];
    return r ? r() : new Response(FEED, { status: 200 });
  };
  return { impl, calls };
}

const redirectTo = (location, status = 302) => () => new Response(null, { status, headers: { location } });

test("non-public addresses are blocked, public ones are not (IPv4, IPv6, mapped and NAT64 forms)", () => {
  /* MUTATION: drop the 169.254/16 line from blockedIpv4 -> the metadata
     address passes; red. MUTATION 2: drop the IPv4-mapped branch from
     blockedIpv6 -> ::ffff:127.0.0.1 passes; red. */
  for (const ip of [
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254",
    "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1",
    "::1", "::", "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::a9fe:a9fe", "fd00::1", "fe80::1", "ff02::1",
  ]) assert.equal(isBlockedAddress(ip), true, ip);
  for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
    assert.equal(isBlockedAddress(ip), false, ip);
  }
});

test("a feed url naming a loopback, link-local or private literal, or localhost, is refused without a request", async () => {
  /* MUTATION: make feedUrlProblem return null for IP literals -> 127.0.0.1 is
     fetched; red. MUTATION 2: remove the localhost line -> localhost is
     fetched; red. */
  const lookup = table({});
  for (const url of [
    "http://127.0.0.1:9001/2018-06-01/runtime/invocation/next",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/feed.xml",
    "http://[::ffff:10.0.0.1]/feed.xml",
    "http://localhost:3000/feed.xml",
    "http://api.localhost/feed.xml",
    "http://metadata/computeMetadata/v1/",
    "ftp://feeds.example.com/x.xml",
  ]) {
    const r = recorder();
    await assert.rejects(guardFeedFetch(r.impl, { lookup })(url), FeedAddressError, url);
    assert.deepEqual(r.calls, [], `${url} must never be requested`);
  }
});

test("a host whose name resolves to a private address is refused; a public one is fetched", async () => {
  /* MUTATION: skip the lookup in assertPublicFeedUrl -> the private name is
     fetched; red. */
  const lookup = table({ "evil.example.net": ["93.184.216.34", "10.0.0.5"], "feeds.example.org": ["93.184.216.34"] });
  const r = recorder();
  await assert.rejects(guardFeedFetch(r.impl, { lookup })("https://evil.example.net/feed.xml"), /non-public/);
  assert.deepEqual(r.calls, []);
  const ok = await guardFeedFetch(r.impl, { lookup })("https://feeds.example.org/feed.xml");
  assert.equal(ok.status, 200);
  assert.deepEqual(r.calls, [{ url: "https://feeds.example.org/feed.xml", redirect: "manual" }]);
});

test("a redirect to a non-public address is not followed", async () => {
  /* MUTATION: pass `init` through without `redirect: "manual"` and return the
     first response -> fetch would follow the redirect itself, unchecked: the
     recorder sees redirect !== "manual"; red. MUTATION 2: skip the check on
     hops after the first (check only when hop === 0) -> the metadata address
     is requested; red. */
  const lookup = table({ "feeds.example.org": ["93.184.216.34"] });
  const r = recorder({ "https://feeds.example.org/feed.xml": redirectTo("http://169.254.169.254/latest/meta-data/") });
  await assert.rejects(guardFeedFetch(r.impl, { lookup })("https://feeds.example.org/feed.xml"), FeedAddressError);
  assert.deepEqual(r.calls, [{ url: "https://feeds.example.org/feed.xml", redirect: "manual" }]);
});

test("public redirects are followed (relative Location included), and a chain longer than the cap is refused", async () => {
  /* MUTATION: drop the hop cap -> the chain runs until the stub gives up
     ("runaway", not the refusal) and the count is wrong; red. */
  const lookup = table({ "a.example.org": ["93.184.216.34"], "b.example.org": ["93.184.216.35"] });
  const r = recorder({
    "https://a.example.org/feed": redirectTo("https://b.example.org/moved", 301),
    "https://b.example.org/moved": redirectTo("/final.xml", 308),
  });
  const res = await guardFeedFetch(r.impl, { lookup })("https://a.example.org/feed");
  assert.equal(res.status, 200);
  assert.deepEqual(r.calls.map((c) => c.url), ["https://a.example.org/feed", "https://b.example.org/moved", "https://b.example.org/final.xml"]);

  let n = 0;
  const loop = async () => { if (++n > 20) throw new Error("runaway"); return new Response(null, { status: 302, headers: { location: `/hop${n}` } }); };
  await assert.rejects(guardFeedFetch(loop, { lookup })("https://a.example.org/start"), /redirects/);
  assert.equal(n, MAX_FEED_REDIRECTS + 1);
});

test("a lookup that fails is left to fetch to report, not refused here", async () => {
  /* MUTATION: turn a failed lookup into a refusal -> the request is never
     made; red. (The fetch resolves the same name the same way.) */
  const r = recorder();
  const res = await guardFeedFetch(r.impl, { lookup: table({}) })("https://feeds.example.test/x.xml");
  assert.equal(res.status, 200);
  assert.equal(r.calls.length, 1);
  await assertPublicFeedUrl("https://feeds.example.test/x.xml", table({}));
});

test("the feed reader routes every fetch through the guard", async () => {
  /* MUTATION: pass `opts.fetchImpl` to fetchFeedConditional unguarded (the
     pre-SEC-01 line) -> the loopback url is fetched; red. */
  const reader = createFeedReader({ lookup: table({}) });
  const r = recorder();
  const got = await reader.read("s", "http://127.0.0.1:8080/feed.xml", { fetchImpl: r.impl });
  assert.equal(got.parsed, null);
  assert.equal(got.feedFailed, true);
  assert.match(got.error, /refused/);
  assert.deepEqual(r.calls, []);
});

test("end to end: a pi: show whose PodcastIndex row names a loopback feed is degraded and the address is never requested", async () => {
  /* MUTATION: as above, at the endpoint the attacker actually reaches
     (GET /api/shows/pi:<n>/episodes?k=<key>) -> the runtime-API url appears
     in the request log; red. */
  const shards = "https://github.com/JW-Incorporated/foray/releases/download/shows-index-x-shards-1";
  const pointer = {
    asset_base_url: "https://github.com/JW-Incorporated/foray/releases/download/shows-index-x",
    release_tag: "shows-index-x",
    shards_published: true,
    shard_releases: [{ tag: "shows-index-x-shards-1", asset_base_url: shards, first_key: "00", last_key: "zz", count: 1 }],
  };
  const evil = "http://127.0.0.1:9001/2018-06-01/runtime/invocation/next";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feed-guard-"));
  const file = path.join(dir, "pointer.json");
  fs.writeFileSync(file, JSON.stringify(pointer));
  _setPointerPathForTests(file);
  _resetPiShowCacheForTests();
  sharedFeedReader.clear();
  const original = globalThis.fetch;
  const hadDb = "DATABASE_URL" in process.env;
  const db = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith(".json.gz")) {
      return new Response(zlib.gzipSync(JSON.stringify([{ id: 9, t: "Evil", a: "x", i: null, u: evil, img: null, n: 1, c: false }])), { status: 200 });
    }
    return new Response(FEED, { status: 200 });
  };
  try {
    const res = { headers: {}, code: null, body: null };
    await handler({ method: "GET", query: { show_id: "pi:9", k: "ev" }, headers: {} }, {
      status(c) { res.code = c; return this; }, json(b) { res.body = b; }, setHeader(n, v) { res.headers[n] = v; }, end() {},
    });
    assert.equal(res.code, 200);
    assert.equal(res.body.degraded, true);
    assert.deepEqual(res.body.episodes, []);
    assert.equal(res.headers["Cache-Control"], "no-store");
    assert.deepEqual(calls, [`${shards}/ev.json.gz`], "only the shard is requested, never the row's loopback feed");
  } finally {
    globalThis.fetch = original;
    if (hadDb) process.env.DATABASE_URL = db;
    _setPointerPathForTests();
    _resetPiShowCacheForTests();
    sharedFeedReader.clear();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
