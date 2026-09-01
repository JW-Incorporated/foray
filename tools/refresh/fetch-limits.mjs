/* Shared byte/size guards for feed fetches (M1, full-repo review 2026-08-31).

   Fetch paths in this repo bound elapsed time (the sleep/throttle loop) but
   not response bytes. A publisher can serve an extremely large or endless
   response fast enough to dodge that, exhausting memory before anything
   notices. Used by both tools/refresh/scan.mjs and tools/refresh-feeds.mjs
   (duplicated fetch path — see the M6 finding for de-duplicating the two
   scripts themselves; this file is the interim shared piece so the fix
   isn't written twice). */

export const MAX_FEED_BYTES = 20 * 1024 * 1024; // 20 MB — generous for RSS/Atom.
export const MAX_ITEMS_PER_FEED = 2000; // defense in depth, after parsing.

/** Guard 1: reject an implausible declared Content-Length before downloading
    anything. Returns an error string, or null when fine to proceed. */
export function checkDeclaredLength(res, maxBytes = MAX_FEED_BYTES) {
  const declared = res.headers.get("content-length");
  if (declared == null) return null;
  const n = Number(declared);
  if (Number.isFinite(n) && n > maxBytes) {
    return `declared Content-Length ${n} exceeds ${maxBytes} byte limit`;
  }
  return null;
}

/** Guard 2: read a fetch Response body as text, aborting the underlying
    request the moment the byte ceiling is crossed. Covers missing/lying
    Content-Length and slow-but-endless (chunked) responses, since it counts
    actual bytes read rather than trusting anything declared up front. */
export async function readBodyCapped(res, controller, maxBytes = MAX_FEED_BYTES) {
  const body = res.body;
  if (!body || typeof body.getReader !== "function") {
    // No streaming body available — cap after the fact rather than
    // returning something unbounded.
    const text = await res.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new Error(`response exceeded ${maxBytes} bytes (post-hoc check, no stream available)`);
    }
    return text;
  }

  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        controller.abort();
        try { await reader.cancel(); } catch (_) { /* best-effort */ }
        throw new Error(`response exceeded ${maxBytes} bytes (aborted mid-stream)`);
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch (_) { /* may already be released */ }
  }

  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

/** Fetch a feed URL with both guards applied. Mirrors the shape scan.mjs and
    refresh-feeds.mjs already used (`fetch(url, {headers, redirect})`) but
    routes it through an AbortController so guard 2 can actually cut the
    connection, and adds a `timeoutMs` elapsed-time bound alongside the byte
    ceiling (defense in depth: either one alone leaves a gap). */
export async function fetchFeedCapped(url, opts = {}) {
  const {
    fetchImpl = fetch,
    headers = {},
    maxBytes = MAX_FEED_BYTES,
    timeoutMs = 20_000,
  } = opts;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers, redirect: "follow", signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const lengthError = checkDeclaredLength(res, maxBytes);
    if (lengthError) throw new Error(lengthError);

    return await readBodyCapped(res, controller, maxBytes);
  } finally {
    clearTimeout(timer);
  }
}

/** Guard 3: cap item/field counts after parsing, as defense in depth against
    a feed within the byte ceiling but with an absurd number of items (e.g.
    a decompression-bomb-shaped small payload, or just a malicious feed
    dumping thousands of near-empty <item> tags to burn CPU downstream). */
export function capItems(items, maxItems = MAX_ITEMS_PER_FEED) {
  return Array.isArray(items) ? items.slice(0, maxItems) : items;
}
