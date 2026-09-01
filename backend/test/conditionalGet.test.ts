import { describe, it, expect, vi } from "vitest";
import { fetchFeedConditional } from "../src/feeds/conditionalGet";

function mockResponse(status: number, body: string | null, headers: Record<string, string> = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    text: async () => body ?? ""
  } as unknown as Response;
}

describe("fetchFeedConditional", () => {
  it("sends If-None-Match / If-Modified-Since when prior state exists", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(mockResponse(200, "<rss></rss>", { etag: '"abc"' }));

    await fetchFeedConditional(
      "https://example.com/feed.xml",
      { etag: '"old-etag"', lastModified: "Mon, 01 Jan 2024 00:00:00 GMT" },
      { fetchImpl }
    );

    const headersSent = fetchImpl.mock.calls[0]![1].headers;
    expect(headersSent["If-None-Match"]).toBe('"old-etag"');
    expect(headersSent["If-Modified-Since"]).toBe("Mon, 01 Jan 2024 00:00:00 GMT");
    expect(headersSent["User-Agent"]).toContain("Foray");
  });

  it("omits conditional headers on first fetch (no prior state)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(mockResponse(200, "<rss></rss>"));

    await fetchFeedConditional("https://example.com/feed.xml", { etag: null, lastModified: null }, { fetchImpl });

    const headersSent = fetchImpl.mock.calls[0]![1].headers;
    expect(headersSent["If-None-Match"]).toBeUndefined();
    expect(headersSent["If-Modified-Since"]).toBeUndefined();
  });

  it("returns notModified on 304 with no body fetched", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(mockResponse(304, null));

    const result = await fetchFeedConditional(
      "https://example.com/feed.xml",
      { etag: '"same"', lastModified: null },
      { fetchImpl }
    );

    expect(result.notModified).toBe(true);
    expect(result.body).toBeNull();
    expect(result.etag).toBe('"same"');
  });

  it("returns the body and new etag/last-modified on 200", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(mockResponse(200, "<rss>fresh</rss>", { etag: '"new-etag"', "last-modified": "Tue, 02 Jan 2024 00:00:00 GMT" }));

    const result = await fetchFeedConditional("https://example.com/feed.xml", { etag: null, lastModified: null }, { fetchImpl });

    expect(result.notModified).toBe(false);
    expect(result.body).toBe("<rss>fresh</rss>");
    expect(result.etag).toBe('"new-etag"');
    expect(result.lastModified).toBe("Tue, 02 Jan 2024 00:00:00 GMT");
  });

  it("reports an error for non-2xx/304 statuses without throwing", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(mockResponse(500, null));

    const result = await fetchFeedConditional("https://example.com/feed.xml", { etag: null, lastModified: null }, { fetchImpl });

    expect(result.notModified).toBe(false);
    expect(result.body).toBeNull();
    expect(result.error).toMatch(/500/);
  });

  it("surfaces network errors without throwing", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("timeout"));

    const result = await fetchFeedConditional("https://example.com/feed.xml", { etag: null, lastModified: null }, { fetchImpl });

    expect(result.error).toMatch(/timeout/);
    expect(result.body).toBeNull();
  });

  it("rejects a response whose declared Content-Length exceeds the byte ceiling, without reading the body", async () => {
    let bodyRead = false;
    const res = {
      status: 200,
      ok: true,
      headers: { get: (k: string) => (k.toLowerCase() === "content-length" ? "999999" : null) },
      text: async () => {
        bodyRead = true;
        return "<rss></rss>";
      }
    } as unknown as Response;
    const fetchImpl = vi.fn().mockResolvedValue(res);

    const result = await fetchFeedConditional(
      "https://example.com/feed.xml",
      { etag: null, lastModified: null },
      { fetchImpl, maxBytes: 1000 }
    );

    expect(result.body).toBeNull();
    expect(result.error).toMatch(/Content-Length/);
    expect(result.error).toMatch(/exceeds/);
    expect(bodyRead).toBe(false);
  });

  it("aborts a chunked/endless response once it crosses the byte ceiling, even with no Content-Length", async () => {
    // Simulates a publisher streaming forever fast enough to dodge the
    // elapsed-time timeout: no Content-Length, and the stream never signals
    // `done` before the ceiling is crossed.
    const bigChunk = new TextEncoder().encode("x".repeat(200));
    let reads = 0;
    const reader = {
      read: async () => {
        reads++;
        return { done: false, value: bigChunk }; // "never ending"
      },
      cancel: async () => {},
      releaseLock: () => {}
    };
    const res = {
      status: 200,
      ok: true,
      headers: { get: () => null }, // no Content-Length declared
      body: { getReader: () => reader },
      text: async () => "x".repeat(1_000_000)
    } as unknown as Response;
    const fetchImpl = vi.fn().mockResolvedValue(res);

    const result = await fetchFeedConditional(
      "https://example.com/feed.xml",
      { etag: null, lastModified: null },
      { fetchImpl, maxBytes: 1000 }
    );

    expect(result.body).toBeNull();
    expect(result.error).toMatch(/exceeded 1000 bytes/);
    // Bounded: must have stopped reading shortly after crossing the ceiling,
    // not consumed the "endless" stream.
    expect(reads).toBeLessThan(20);
  });

  it("accepts a normal small body under the byte ceiling", async () => {
    const chunk = new TextEncoder().encode("<rss>ok</rss>");
    let done = false;
    const reader = {
      read: async () => {
        if (done) return { done: true, value: undefined };
        done = true;
        return { done: false, value: chunk };
      },
      cancel: async () => {},
      releaseLock: () => {}
    };
    const res = {
      status: 200,
      ok: true,
      headers: { get: (k: string) => (k.toLowerCase() === "content-length" ? "13" : null) },
      body: { getReader: () => reader },
      text: async () => "<rss>ok</rss>"
    } as unknown as Response;
    const fetchImpl = vi.fn().mockResolvedValue(res);

    const result = await fetchFeedConditional(
      "https://example.com/feed.xml",
      { etag: null, lastModified: null },
      { fetchImpl, maxBytes: 1000 }
    );

    expect(result.body).toBe("<rss>ok</rss>");
    expect(result.error).toBeUndefined();
  });
});
