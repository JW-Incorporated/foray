/* Conditional GET port for the S-10 watchlist poller (tools/poll/fetch-feed.mjs,
   PKG-10 core).
   Run:
   node --test tools/poll/fetch-feed.test.mjs

   Every test names the one-line mutation that turns it red; each was applied to
   fetch-feed.mjs and seen to fail this suite. The first test is a cross-file pin
   in politeness.test.mjs's pattern: it reads backend/src/feeds/conditionalGet.ts
   and backend/src/feeds/userAgent.ts as TEXT (this suite runs with no TS loader),
   so a constant changed on either side alone is a red suite. The rest talk to a
   node:http server on 127.0.0.1:0 -- loopback only, never a real publisher.
   The behavioural pin across the two runtimes (same loopback server, identical
   results, both cancel a non-2xx body, same default cap and timeout) is
   backend/test/fetchFeedParity.test.ts (CH2-28); this suite keeps the cheap
   text pin and the .mjs-only cases. */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { DEFAULT_FEED_USER_AGENT, DEFAULT_TIMEOUT_MS, MAX_FEED_BYTES, fetchFeedConditional } from "./fetch-feed.mjs";

const COND_TS = new URL("../../backend/src/feeds/conditionalGet.ts", import.meta.url);
const UA_TS = new URL("../../backend/src/feeds/userAgent.ts", import.meta.url);
const num = (s) => Number(s.replace(/_/g, ""));

/* One loopback server per test; `handler(req, res)` decides the response and
   every request's headers are recorded. Resolves { url, requests, close }. */
async function withServer(handler, fn) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ path: req.url, headers: req.headers });
    handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await fn({ base: `http://127.0.0.1:${port}`, requests });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("the port's constants equal backend/src/feeds/conditionalGet.ts and userAgent.ts", () => {
  // MUTATION: `MAX_FEED_BYTES = 20 * 1024 * 1024` -> `21 * 1024 * 1024` in tools/refresh/fetch-limits.mjs
  // (fetch-feed.mjs re-exports it since CH2-28) -> red.
  // MUTATION: `DEFAULT_TIMEOUT_MS = 15_000` -> `15_001` -> red.
  // MUTATION: drop "; contact wjduvall@gmail.com" from DEFAULT_FEED_USER_AGENT -> red.
  const cond = fs.readFileSync(COND_TS, "utf8");
  const max = cond.match(/export const MAX_FEED_BYTES\s*=\s*([\d_]+)\s*\*\s*([\d_]+)\s*\*\s*([\d_]+)\s*;/);
  assert.ok(max, "conditionalGet.ts no longer declares `export const MAX_FEED_BYTES = a * b * c;` -- escalate, do not loosen");
  const tsMax = num(max[1]) * num(max[2]) * num(max[3]);
  const timeout = cond.match(/const timeoutMs = opts\.timeoutMs \?\? ([\d_]+);/);
  assert.ok(timeout, "conditionalGet.ts no longer defaults `timeoutMs` with `opts.timeoutMs ?? <n>` -- escalate, do not loosen");
  const ua = fs.readFileSync(UA_TS, "utf8").match(/export const DEFAULT_FEED_USER_AGENT\s*=\s*"([^"]*)";/);
  assert.ok(ua, "userAgent.ts no longer declares DEFAULT_FEED_USER_AGENT as a string literal -- escalate, do not loosen");

  assert.deepEqual(
    { MAX_FEED_BYTES, DEFAULT_TIMEOUT_MS, DEFAULT_FEED_USER_AGENT },
    { MAX_FEED_BYTES: tsMax, DEFAULT_TIMEOUT_MS: num(timeout[1]), DEFAULT_FEED_USER_AGENT: ua[1] },
  );
  assert.equal(MAX_FEED_BYTES, 20 * 1024 * 1024);
  assert.equal(DEFAULT_TIMEOUT_MS, 15000);
});

test("a 200 returns the body and the response's validators; the prior validators go out as conditional headers", async () => {
  // MUTATION: drop `if (priorEtag) headers["If-None-Match"] = priorEtag;` -> red.
  // MUTATION: drop `if (priorLastModified) headers["If-Modified-Since"] = ...` -> red.
  await withServer(
    (req, res) => {
      res.writeHead(200, { ETag: '"v2"', "Last-Modified": "Tue, 06 Oct 2026 00:00:00 GMT", "Content-Type": "application/rss+xml" });
      res.end("<rss/>");
    },
    async ({ base, requests }) => {
      const r = await fetchFeedConditional(`${base}/feed`, { etag: '"v1"', lastModified: "Mon, 05 Oct 2026 00:00:00 GMT" });
      assert.deepEqual(r, {
        status: 200,
        notModified: false,
        body: "<rss/>",
        etag: '"v2"',
        lastModified: "Tue, 06 Oct 2026 00:00:00 GMT",
      });
      const h = requests[0].headers;
      assert.equal(h["if-none-match"], '"v1"');
      assert.equal(h["if-modified-since"], "Mon, 05 Oct 2026 00:00:00 GMT");
      assert.equal(h["user-agent"], DEFAULT_FEED_USER_AGENT);
      assert.equal(h.accept, "application/rss+xml, application/xml, text/xml, */*");
    },
  );
});

test("a 304 keeps the prior validators; a 5xx carries the response's and an HTTP error", async () => {
  // MUTATION: in the 304 branch `etag: priorEtag` -> `etag: null` -> red.
  // MUTATION: `if (!res.ok)` -> `if (false)` -> red (the 500 body would be returned).
  await withServer(
    (req, res) => {
      if (req.url === "/same") {
        res.writeHead(304, { ETag: '"ignored"' });
        res.end();
      } else {
        res.writeHead(500);
        res.end("boom");
      }
    },
    async ({ base }) => {
      const prior = { etag: '"v1"', lastModified: "Mon, 05 Oct 2026 00:00:00 GMT" };
      assert.deepEqual(await fetchFeedConditional(`${base}/same`, prior), {
        status: 304,
        notModified: true,
        body: null,
        etag: '"v1"',
        lastModified: "Mon, 05 Oct 2026 00:00:00 GMT",
      });
      assert.deepEqual(await fetchFeedConditional(`${base}/err`, prior), {
        status: 500,
        notModified: false,
        body: null,
        etag: null,
        lastModified: null,
        error: "HTTP 500",
      });
    },
  );
});

test("a declared Content-Length above the cap is rejected before the body is read", async () => {
  // MUTATION: `declared > maxBytes` -> `declared > maxBytes * 4` -> red (the stream
  // guard then catches it instead: status 0 and a mid-stream error).
  await withServer(
    (req, res) => {
      res.writeHead(200, { "Content-Length": "2048", ETag: '"big"' });
      res.end("x".repeat(2048));
    },
    async ({ base }) => {
      const r = await fetchFeedConditional(`${base}/big`, {}, { maxBytes: 1024 });
      assert.equal(r.status, 200);
      assert.equal(r.body, null);
      assert.equal(r.etag, '"big"');
      assert.equal(r.error, "declared Content-Length 2048 exceeds 1024 byte limit");
    },
  );
});

test("a body with no Content-Length is aborted mid-stream past maxBytes", async () => {
  // MUTATION: `if (total > maxBytes)` -> `if (false)` in fetch-limits.mjs's readBodyCapped (the reader
  // fetch-feed.mjs imports since CH2-28) -> red (body returned, status 200).
  let written = 0;
  await withServer(
    (req, res) => {
      res.writeHead(200, { "Content-Type": "application/rss+xml" }); // chunked, no length
      const chunk = "y".repeat(512);
      const pump = () => {
        if (res.destroyed || written >= 64 * 1024) return res.end();
        written += chunk.length;
        res.write(chunk, () => setImmediate(pump));
      };
      pump();
    },
    async ({ base }) => {
      const r = await fetchFeedConditional(`${base}/endless`, { etag: '"keep"', lastModified: null }, { maxBytes: 1024 });
      assert.equal(r.status, 0);
      assert.equal(r.body, null);
      assert.equal(r.etag, '"keep"', "a thrown read keeps the prior validators");
      assert.match(r.error, /^fetch error: response exceeded 1024 bytes \(aborted mid-stream\)$/);
    },
  );
});

test("a thrown fetch gives status 0 and keeps the prior validators; the timeout aborts a stalled request", { timeout: 10_000 }, async () => {
  // MUTATION: in the catch `etag: priorEtag` -> `etag: null` -> red.
  // MUTATION: `setTimeout(() => controller.abort(), timeoutMs)` -> `() => {}` -> red (the stall never ends; test times out).
  const prior = { etag: '"v1"', lastModified: "Mon, 05 Oct 2026 00:00:00 GMT" };
  const thrown = await fetchFeedConditional("http://127.0.0.1:9/feed", prior, {
    fetchImpl: async () => {
      throw new Error("connect ECONNREFUSED");
    },
  });
  assert.deepEqual(thrown, {
    status: 0,
    notModified: false,
    body: null,
    etag: '"v1"',
    lastModified: "Mon, 05 Oct 2026 00:00:00 GMT",
    error: "fetch error: connect ECONNREFUSED",
  });

  await withServer(
    () => {}, // never answers
    async ({ base }) => {
      const r = await fetchFeedConditional(`${base}/stall`, prior, { timeoutMs: 50 });
      assert.equal(r.status, 0);
      assert.equal(r.etag, '"v1"');
      assert.match(r.error, /^fetch error: /);
    },
  );
});
