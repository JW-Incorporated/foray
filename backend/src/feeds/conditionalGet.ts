import { env } from "../config/env";

export interface ConditionalGetState {
  etag: string | null;
  lastModified: string | null;
}

export interface FeedFetchResult {
  status: number;
  notModified: boolean;
  body: string | null;
  etag: string | null;
  lastModified: string | null;
  error?: string;
}

/**
 * Byte ceilings for a single feed fetch (M1, full-repo review 2026-08-31).
 *
 * A publisher can serve an extremely large or endless response fast enough
 * to dodge the elapsed-time timeout, exhausting memory before the abort
 * fires. Two independent guards: reject an implausible `Content-Length`
 * before we download anything, and cap the actual number of bytes read off
 * the stream (works even when `Content-Length` is absent, wrong, or the
 * body is compressed) so a slow-but-endless response is bounded too.
 *
 * 20 MB is generous for an RSS/Atom feed (even a huge show-notes-heavy feed
 * with hundreds of items is low single-digit MB) while leaving headroom
 * over anything legitimate.
 */
export const MAX_FEED_BYTES = 20 * 1024 * 1024; // 20 MB

/**
 * Reads a Response body up to `maxBytes`, aborting (via the passed
 * AbortController) the moment the ceiling is crossed rather than buffering
 * an unbounded amount first. Falls back to `res.text()` when the runtime
 * doesn't expose a streaming body (e.g. some test doubles) — callers that
 * care about the streaming guarantee should supply a real fetch Response.
 */
async function readBodyCapped(
  res: Response,
  maxBytes: number,
  controller: AbortController
): Promise<string> {
  const body = res.body as ReadableStream<Uint8Array> | null | undefined;
  if (!body || typeof body.getReader !== "function") {
    // No streaming body available (e.g. a mocked Response in tests) — the
    // whole thing is already in memory by the time we can see it, so at
    // least cap it after the fact rather than returning unbounded text.
    const text = await res.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new Error(`response exceeded ${maxBytes} bytes (post-hoc check, no stream available)`);
    }
    return text;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        controller.abort();
        try {
          await reader.cancel();
        } catch {
          // best-effort; the abort above is what actually stops the network
        }
        throw new Error(`response exceeded ${maxBytes} bytes (aborted mid-stream)`);
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // reader may already be released via cancel() above
    }
  }

  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

/**
 * Fetches a feed URL using conditional GET (ETag / If-Modified-Since) so
 * repeat polls cost the publisher (and us) as little as possible — the core
 * mechanic behind the polling-cadence ADR (0001). A 304 short-circuits with
 * `notModified: true` and no body.
 */
export async function fetchFeedConditional(
  url: string,
  prior: ConditionalGetState,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number; maxBytes?: number } = {}
): Promise<FeedFetchResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const maxBytes = opts.maxBytes ?? MAX_FEED_BYTES;

  const headers: Record<string, string> = {
    "User-Agent": env.userAgent,
    Accept: "application/rss+xml, application/xml, text/xml, */*"
  };
  if (prior.etag) headers["If-None-Match"] = prior.etag;
  if (prior.lastModified) headers["If-Modified-Since"] = prior.lastModified;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(url, { method: "GET", headers, signal: controller.signal });

    if (res.status === 304) {
      return { status: 304, notModified: true, body: null, etag: prior.etag, lastModified: prior.lastModified };
    }

    const etag = res.headers.get("etag");
    const lastModified = res.headers.get("last-modified");

    if (!res.ok) {
      return {
        status: res.status,
        notModified: false,
        body: null,
        etag,
        lastModified,
        error: `HTTP ${res.status}`
      };
    }

    // Guard 1: reject an implausible declared size before downloading
    // anything. A publisher lying about Content-Length can't be trusted,
    // but a HONEST oversized declaration is exactly the case we want to
    // short-circuit fastest. Abort the connection rather than just walking
    // away from it — otherwise the socket/stream stays open on the far end
    // for the timeout duration, which a scan running against hundreds of
    // feeds cannot afford to leak on every rejection.
    const declaredLength = res.headers.get("content-length");
    if (declaredLength !== null) {
      const declared = Number(declaredLength);
      if (Number.isFinite(declared) && declared > maxBytes) {
        controller.abort();
        try {
          await res.body?.cancel?.();
        } catch {
          // best-effort; the abort above is what actually stops the network
        }
        return {
          status: res.status,
          notModified: false,
          body: null,
          etag,
          lastModified,
          error: `declared Content-Length ${declared} exceeds ${maxBytes} byte limit`
        };
      }
    }

    // Guard 2: stream with an explicit decompressed byte ceiling, aborting
    // the request the moment it's crossed — covers missing/lying
    // Content-Length and slow-but-endless responses that dodge the
    // elapsed-time timeout.
    const body = await readBodyCapped(res, maxBytes, controller);
    return { status: res.status, notModified: false, body, etag, lastModified };
  } catch (err) {
    return {
      status: 0,
      notModified: false,
      body: null,
      etag: prior.etag,
      lastModified: prior.lastModified,
      error: `fetch error: ${(err as Error).message}`
    };
  } finally {
    clearTimeout(timer);
  }
}
