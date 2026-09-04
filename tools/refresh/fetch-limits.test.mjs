/* Tests for fetch-limits.mjs (M1, full-repo review 2026-08-31).
   Run: node --test tools/refresh/ */

import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_FEED_BYTES,
  checkDeclaredLength,
  readBodyCapped,
  fetchFeedCapped,
  capItems,
} from "./fetch-limits.mjs";

function headerResponse(headers) {
  const map = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { headers: { get: (k) => map.get(k.toLowerCase()) ?? null } };
}

/* ---------- checkDeclaredLength ---------- */

test("checkDeclaredLength allows a plausible size", async () => {
  const controller = new AbortController();
  assert.equal(await checkDeclaredLength(headerResponse({ "content-length": "1000" }), controller, 5000), null);
  assert.equal(controller.signal.aborted, false);
});

test("checkDeclaredLength rejects an implausible size before download, and aborts the connection", async () => {
  const controller = new AbortController();
  const res = headerResponse({ "content-length": "99999999" });
  const err = await checkDeclaredLength(res, controller, 5000);
  assert.match(err, /exceeds 5000 byte limit/);
  assert.equal(controller.signal.aborted, true, "must abort rather than leave the connection open");
});

test("checkDeclaredLength cancels the response body when rejecting, if one is present", async () => {
  const controller = new AbortController();
  let cancelled = false;
  const res = headerResponse({ "content-length": "99999999" });
  res.body = { cancel: async () => { cancelled = true; } };
  await checkDeclaredLength(res, controller, 5000);
  assert.equal(cancelled, true);
});

test("checkDeclaredLength allows a missing Content-Length (unknown, not rejected up front)", async () => {
  const controller = new AbortController();
  assert.equal(await checkDeclaredLength(headerResponse({}), controller, 5000), null);
  assert.equal(controller.signal.aborted, false);
});

/* ---------- readBodyCapped: streamed ceiling ---------- */

function streamResponse(chunks) {
  let i = 0;
  const reader = {
    read: async () => {
      if (i >= chunks.length) return { done: true, value: undefined };
      const value = chunks[i++];
      return { done: false, value };
    },
    cancel: async () => {},
    releaseLock: () => {},
  };
  return { body: { getReader: () => reader } };
}

test("readBodyCapped returns the body when under the ceiling", async () => {
  const chunks = [Buffer.from("<rss>"), Buffer.from("hi</rss>")];
  const res = streamResponse(chunks);
  const controller = new AbortController();
  const body = await readBodyCapped(res, controller, 1000);
  assert.equal(body, "<rss>hi</rss>");
  assert.equal(controller.signal.aborted, false);
});

test("readBodyCapped aborts a response that exceeds the byte ceiling mid-stream", async () => {
  // Simulates an endless/oversized chunked response: each chunk is under the
  // ceiling alone, but the stream never signals `done` before crossing it.
  const bigChunk = Buffer.alloc(100, "x");
  const chunks = Array.from({ length: 50 }, () => bigChunk); // 5000 bytes total
  const res = streamResponse(chunks);
  const controller = new AbortController();

  await assert.rejects(
    () => readBodyCapped(res, controller, 1000),
    /exceeded 1000 bytes/
  );
  assert.equal(controller.signal.aborted, true);
});

test("readBodyCapped caps a non-streaming body post-hoc when no reader is available", async () => {
  const res = { body: null, text: async () => "x".repeat(2000) };
  const controller = new AbortController();
  await assert.rejects(() => readBodyCapped(res, controller, 1000), /exceeded 1000 bytes/);
});

/* ---------- fetchFeedCapped: end-to-end guard wiring ---------- */

test("fetchFeedCapped rejects an oversized declared Content-Length before reading the stream", async () => {
  let streamRead = false;
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    headers: headerResponse({ "content-length": String(MAX_FEED_BYTES + 1) }).headers,
    body: {
      getReader: () => {
        streamRead = true;
        return { read: async () => ({ done: true, value: undefined }), releaseLock: () => {} };
      },
    },
  });

  await assert.rejects(() => fetchFeedCapped("https://example.com/feed.xml", { fetchImpl }), /exceeds/);
  assert.equal(streamRead, false, "must not start reading the stream once Content-Length is implausible");
});

test("fetchFeedCapped aborts a chunked response with no Content-Length that never ends", async () => {
  const bigChunk = Buffer.alloc(1024, "y");
  const res = {
    ok: true,
    status: 200,
    headers: headerResponse({}).headers, // no Content-Length — the "endless response" case
    body: streamResponse(Array.from({ length: 1000 }, () => bigChunk)).body,
  };
  const fetchImpl = async () => res;

  await assert.rejects(
    () => fetchFeedCapped("https://example.com/feed.xml", { fetchImpl, maxBytes: 10_000 }),
    /exceeded 10000 bytes/
  );
});

test("fetchFeedCapped returns the body for a normal, small feed", async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    headers: headerResponse({ "content-length": "20" }).headers,
    body: streamResponse([Buffer.from("<rss></rss>")]).body,
  });
  const body = await fetchFeedCapped("https://example.com/feed.xml", { fetchImpl });
  assert.equal(body, "<rss></rss>");
});

test("fetchFeedCapped surfaces a non-2xx status as an error", async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, headers: headerResponse({}).headers });
  await assert.rejects(() => fetchFeedCapped("https://example.com/feed.xml", { fetchImpl }), /HTTP 500/);
});

/* ---------- capItems: defense in depth after parsing ---------- */

test("capItems truncates an implausibly large item list", () => {
  const items = Array.from({ length: 5000 }, (_, i) => ({ id: i }));
  const capped = capItems(items, 2000);
  assert.equal(capped.length, 2000);
  assert.equal(capped[0].id, 0);
});

test("capItems passes a normal-sized list through unchanged", () => {
  const items = [{ id: 1 }, { id: 2 }];
  assert.deepStrictEqual(capItems(items, 2000), items);
});

test("capItems is a no-op for non-array input", () => {
  assert.equal(capItems(null, 2000), null);
});
