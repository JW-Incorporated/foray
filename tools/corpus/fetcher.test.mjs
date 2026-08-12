/* Fetcher policy tests — fixture-only, zero network, zero real waiting.
 * fetchImpl/sleep/now are injected; virtual time advances through the fake
 * sleep so spacing assertions are exact, not flaky.
 */

import { test } from "node:test";
import assert from "node:assert";
import { createFetcher, USER_AGENT, AGENT_TOKEN } from "./fetcher.mjs";
import { parseRobots } from "./robots.mjs";

/* ------------------------------------------------------------ test rig */

function makeRes(status, body = "", headers = {}, contentType = "text/html") {
  const h = new Map(Object.entries({ "content-type": contentType, ...headers }));
  return {
    status,
    headers: { get: (k) => h.get(k.toLowerCase()) ?? null },
    text: async () => body,
    // TextEncoder gives an exact-size buffer; Buffer.from(str).buffer would
    // hand back Node's shared 8KB pool slab and corrupt the assertion.
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  };
}

/* Virtual clock: sleep() advances time instantly. */
function makeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms) => { t += ms; },
    advance: (ms) => { t += ms; },
  };
}

/* Scripted fetch: routes[urlPrefix] = array of responses (or fns). */
function makeFetch(routes, log = []) {
  return async (url, opts) => {
    log.push({ url, at: undefined, opts });
    for (const [prefix, queue] of Object.entries(routes)) {
      if (url.startsWith(prefix)) {
        const next = queue.length > 1 ? queue.shift() : queue[0];
        if (next instanceof Error) throw next;
        return typeof next === "function" ? next(url, opts) : next;
      }
    }
    return makeRes(404);
  };
}

const NO_ROBOTS = { "https://example.com/robots.txt": [makeRes(404)] };

/* -------------------------------------------------------------- robots */

test("robots: disallow blocks matching path", () => {
  const r = parseRobots("User-agent: *\nDisallow: /private/", AGENT_TOKEN);
  assert.equal(r.isAllowed("/private/x"), false);
  assert.equal(r.isAllowed("/public"), true);
});

test("robots: longest match wins, allow beats disallow on tie", () => {
  const r = parseRobots(
    "User-agent: *\nDisallow: /docs/\nAllow: /docs/api/",
    AGENT_TOKEN
  );
  assert.equal(r.isAllowed("/docs/secret"), false);
  assert.equal(r.isAllowed("/docs/api/spec"), true);
});

test("robots: wildcard and end-anchor patterns", () => {
  const r = parseRobots("User-agent: *\nDisallow: /*.pdf$", AGENT_TOKEN);
  assert.equal(r.isAllowed("/paper.pdf"), false);
  assert.equal(r.isAllowed("/paper.pdf.html"), true);
});

test("robots: specific agent group beats star group", () => {
  const r = parseRobots(
    "User-agent: *\nDisallow: /\n\nUser-agent: foraycorpusbot\nDisallow:",
    AGENT_TOKEN
  );
  assert.equal(r.isAllowed("/anything"), true);
});

test("robots: crawl-delay parsed from selected group", () => {
  const r = parseRobots("User-agent: *\nCrawl-delay: 7\nDisallow: /x", AGENT_TOKEN);
  assert.equal(r.crawlDelay, 7);
});

test("robots: empty disallow means allow-all", () => {
  const r = parseRobots("User-agent: *\nDisallow:", AGENT_TOKEN);
  assert.equal(r.isAllowed("/"), true);
});

test("robots: no groups at all allows everything", () => {
  const r = parseRobots("", AGENT_TOKEN);
  assert.equal(r.isAllowed("/whatever"), true);
  assert.equal(r.crawlDelay, null);
});

/* ------------------------------------------------------------- fetching */

test("fetch: happy path returns body and sends honest UA", async () => {
  const log = [];
  const f = createFetcher({
    fetchImpl: makeFetch({ ...NO_ROBOTS, "https://example.com/page": [makeRes(200, "hello")] }, log),
    ...makeClock(),
  });
  const r = await f.fetchUrl("https://example.com/page");
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.equal(r.body.toString(), "hello");
  const pageReq = log.find((l) => l.url.includes("/page"));
  assert.equal(pageReq.opts.headers["user-agent"], USER_AGENT);
  assert.match(USER_AGENT, /contact:/);
});

test("fetch: http URLs are upgraded to https", async () => {
  const f = createFetcher({
    fetchImpl: makeFetch({ ...NO_ROBOTS, "https://example.com/x": [makeRes(200, "ok")] }),
    ...makeClock(),
  });
  const r = await f.fetchUrl("http://example.com/x");
  assert.equal(r.ok, true);
  assert.equal(r.finalUrl, "https://example.com/x");
  assert.ok(r.notes.includes("upgraded http→https"));
});

test("fetch: robots disallow short-circuits with status -1", async () => {
  const f = createFetcher({
    fetchImpl: makeFetch({
      "https://example.com/robots.txt": [makeRes(200, "User-agent: *\nDisallow: /blocked")],
      "https://example.com/blocked": [makeRes(200, "should never be fetched")],
    }),
    ...makeClock(),
  });
  const r = await f.fetchUrl("https://example.com/blocked/page");
  assert.equal(r.ok, false);
  assert.equal(r.status, -1);
  assert.ok(r.notes.some((n) => n.includes("robots")));
});

test("fetch: same-host requests are spaced >= 2s", async () => {
  const clock = makeClock();
  const times = [];
  const fetchImpl = async (url) => {
    times.push({ url, at: clock.now() });
    return url.endsWith("robots.txt") ? makeRes(404) : makeRes(200, "ok");
  };
  const f = createFetcher({ fetchImpl, sleep: clock.sleep, now: clock.now });
  await f.fetchUrl("https://example.com/a");
  await f.fetchUrl("https://example.com/b");
  const hits = times.filter((t) => !t.url.endsWith("robots.txt"));
  assert.equal(hits.length, 2);
  assert.ok(hits[1].at - hits[0].at >= 2000, `spacing was ${hits[1].at - hits[0].at}ms`);
});

test("fetch: robots crawl-delay larger than default is honored", async () => {
  const clock = makeClock();
  const times = [];
  const fetchImpl = async (url) => {
    times.push({ url, at: clock.now() });
    return url.endsWith("robots.txt")
      ? makeRes(200, "User-agent: *\nCrawl-delay: 10\nDisallow: /nope")
      : makeRes(200, "ok");
  };
  const f = createFetcher({ fetchImpl, sleep: clock.sleep, now: clock.now });
  await f.fetchUrl("https://example.com/a");
  await f.fetchUrl("https://example.com/b");
  const hits = times.filter((t) => !t.url.endsWith("robots.txt"));
  assert.ok(hits[1].at - hits[0].at >= 10_000, `spacing was ${hits[1].at - hits[0].at}ms`);
});

test("fetch: retries on 500 then succeeds", async () => {
  const f = createFetcher({
    fetchImpl: makeFetch({
      ...NO_ROBOTS,
      "https://example.com/flaky": [makeRes(500), makeRes(200, "recovered")],
    }),
    ...makeClock(),
  });
  const r = await f.fetchUrl("https://example.com/flaky");
  assert.equal(r.ok, true);
  assert.equal(r.body.toString(), "recovered");
  assert.ok(r.notes.some((n) => n.includes("status 500")));
});

test("fetch: retries on network error then succeeds", async () => {
  const f = createFetcher({
    fetchImpl: makeFetch({
      ...NO_ROBOTS,
      "https://example.com/net": [new TypeError("fetch failed"), makeRes(200, "up")],
    }),
    ...makeClock(),
  });
  const r = await f.fetchUrl("https://example.com/net");
  assert.equal(r.ok, true);
});

test("fetch: gives up after 3 attempts on persistent 503", async () => {
  let attempts = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith("robots.txt")) return makeRes(404);
    attempts++;
    return makeRes(503);
  };
  const f = createFetcher({ fetchImpl, ...makeClock() });
  const r = await f.fetchUrl("https://example.com/down");
  assert.equal(r.ok, false);
  assert.equal(r.status, 503);
  assert.equal(attempts, 3);
});

test("fetch: 404 is terminal, not retried", async () => {
  let attempts = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith("robots.txt")) return makeRes(404);
    attempts++;
    return makeRes(404);
  };
  const f = createFetcher({ fetchImpl, ...makeClock() });
  const r = await f.fetchUrl("https://example.com/gone");
  assert.equal(r.ok, false);
  assert.equal(r.status, 404);
  assert.equal(attempts, 1);
});

test("fetch: follows redirects and records hops", async () => {
  const f = createFetcher({
    fetchImpl: makeFetch({
      "https://example.com/robots.txt": [makeRes(404)],
      "https://example.com/old": [makeRes(301, "", { location: "https://example.com/new" })],
      "https://example.com/new": [makeRes(200, "moved")],
    }),
    ...makeClock(),
  });
  const r = await f.fetchUrl("https://example.com/old");
  assert.equal(r.ok, true);
  assert.equal(r.finalUrl, "https://example.com/new");
  assert.ok(r.notes.some((n) => n.startsWith("redirect 301")));
});

test("fetch: redirect loop terminates with failure", async () => {
  const f = createFetcher({
    fetchImpl: makeFetch({
      "https://example.com/robots.txt": [makeRes(404)],
      "https://example.com/loop": [makeRes(302, "", { location: "https://example.com/loop" })],
    }),
    ...makeClock(),
  });
  const r = await f.fetchUrl("https://example.com/loop");
  assert.equal(r.ok, false);
  assert.ok(r.notes.some((n) => n.includes("redirects")));
});

test("fetch: cross-host redirect applies target host robots", async () => {
  const f = createFetcher({
    fetchImpl: makeFetch({
      "https://a.com/robots.txt": [makeRes(404)],
      "https://a.com/go": [makeRes(302, "", { location: "https://b.com/landing" })],
      "https://b.com/robots.txt": [makeRes(200, "User-agent: *\nDisallow: /landing")],
      "https://b.com/landing": [makeRes(200, "secret")],
    }),
    ...makeClock(),
  });
  const r = await f.fetchUrl("https://a.com/go");
  assert.equal(r.ok, false);
  assert.equal(r.status, -1);
});

test("fetch: oversized content-length is rejected", async () => {
  const f = createFetcher({
    fetchImpl: makeFetch({
      ...NO_ROBOTS,
      "https://example.com/huge": [makeRes(200, "x", { "content-length": String(51 * 1024 * 1024) })],
    }),
    ...makeClock(),
  });
  const r = await f.fetchUrl("https://example.com/huge");
  assert.equal(r.ok, false);
  assert.ok(r.notes.some((n) => n.includes("cap")));
});

test("fetch: robots.txt fetched once per host, then cached", async () => {
  let robotsHits = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith("robots.txt")) { robotsHits++; return makeRes(404); }
    return makeRes(200, "ok");
  };
  const f = createFetcher({ fetchImpl, ...makeClock() });
  await f.fetchUrl("https://example.com/1");
  await f.fetchUrl("https://example.com/2");
  await f.fetchUrl("https://example.com/3");
  assert.equal(robotsHits, 1);
});

test("fetch: honors Retry-After seconds on 429", async () => {
  const clock = makeClock();
  const times = [];
  let served = false;
  const fetchImpl = async (url) => {
    if (url.endsWith("robots.txt")) return makeRes(404);
    times.push(clock.now());
    if (!served) { served = true; return makeRes(429, "", { "retry-after": "30" }); }
    return makeRes(200, "ok");
  };
  const f = createFetcher({ fetchImpl, sleep: clock.sleep, now: clock.now });
  const r = await f.fetchUrl("https://example.com/limited");
  assert.equal(r.ok, true);
  assert.ok(times[1] - times[0] >= 30_000, `waited ${times[1] - times[0]}ms`);
});
