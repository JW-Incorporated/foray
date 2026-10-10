import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchFeedConditional, MAX_FEED_BYTES, type FeedFetchResult } from "../src/feeds/conditionalGet";

/* CH2-28 (code-health-2 B1-04, T1-10). `tools/poll/fetch-feed.mjs` is a plain-ESM
   copy of this backend's `fetchFeedConditional` (the episode-poll runner has no
   TypeScript loader, and this CommonJS backend cannot `require` the .mjs), so
   the two cannot share code. Before this suite the only thing holding them
   together was fetch-feed.test.mjs's text scrape of three constants, and the
   non-2xx body cancel had already drifted (the .mjs freed the socket, the TS
   left it to GC). vitest CAN `import()` the .mjs (precedent:
   anchorTextParity.test.ts), so here both run against the same loopback
   server and must return the same result, request the same headers and free
   the same sockets. Loopback only (127.0.0.1:0), never a real publisher. */

type Prior = { etag: string | null; lastModified: string | null };
type FetchFn = (url: string, prior: Prior, opts?: Record<string, unknown>) => Promise<FeedFetchResult>;
type Runtime = { name: "ts" | "mjs"; fetch: FetchFn };

const ts: Runtime = { name: "ts", fetch: fetchFeedConditional as FetchFn };

async function runtimes(): Promise<Runtime[]> {
  const mjs = (await import("../../tools/poll/fetch-feed.mjs")) as unknown as { fetchFeedConditional: FetchFn };
  return [ts, { name: "mjs", fetch: mjs.fetchFeedConditional }];
}

type Seen = { path: string; headers: http.IncomingHttpHeaders; closedEarly: boolean };

/* One loopback server per test. Every request is recorded with its headers and
   whether the CLIENT dropped the connection before the handler finished
   (`res` "close" without "finish") -- the wire-level sign that the body
   stream was cancelled rather than left for GC. */
async function withServer<T>(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  fn: (ctx: { base: string; seen: Seen[] }) => Promise<T>
): Promise<T> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const entry: Seen = { path: req.url ?? "", headers: req.headers, closedEarly: false };
    seen.push(entry);
    res.on("close", () => {
      if (!res.writableFinished) entry.closedEarly = true;
    });
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await fn({ base: `http://127.0.0.1:${port}`, seen });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/* A body that never ends: 512-byte chunks until the client goes away. */
function pumpForever(res: http.ServerResponse): void {
  const chunk = "e".repeat(512);
  const pump = (): void => {
    if (res.destroyed) return;
    res.write(chunk, () => setTimeout(pump, 5));
  };
  pump();
}

async function waitFor(check: () => boolean, ms = 2000): Promise<boolean> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
}

const PRIOR: Prior = { etag: '"v1"', lastModified: "Mon, 05 Oct 2026 00:00:00 GMT" };

afterEach(() => {
  vi.useRealTimers();
});

describe("CH2-28 -- backend fetchFeedConditional and tools/poll/fetch-feed.mjs behave as one", () => {
  it("a 200 returns the same result and both send the same request headers", async () => {
    /* MUTATION THAT KILLS THIS: change the Accept string, the User-Agent
       default or drop either conditional header in ONE runtime -> the header
       rows differ. */
    await withServer(
      (_req, res) => {
        res.writeHead(200, { ETag: '"v2"', "Last-Modified": "Tue, 06 Oct 2026 00:00:00 GMT" });
        res.end("<rss/>");
      },
      async ({ base, seen }) => {
        const results: Record<string, FeedFetchResult> = {};
        for (const rt of await runtimes()) results[rt.name] = await rt.fetch(`${base}/${rt.name}`, PRIOR);
        expect(results.ts).toEqual({
          status: 200,
          notModified: false,
          body: "<rss/>",
          etag: '"v2"',
          lastModified: "Tue, 06 Oct 2026 00:00:00 GMT"
        });
        expect(results.mjs).toEqual(results.ts);

        const pick = (h: http.IncomingHttpHeaders) => ({
          ua: h["user-agent"],
          accept: h.accept,
          inm: h["if-none-match"],
          ims: h["if-modified-since"]
        });
        expect(seen.map((s) => s.path)).toEqual(["/ts", "/mjs"]);
        expect(pick(seen[1]!.headers)).toEqual(pick(seen[0]!.headers));
        expect(pick(seen[0]!.headers).inm).toBe('"v1"');
      }
    );
  });

  it("a 304 returns the same result, keeping the prior validators", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(304, { ETag: '"ignored"' });
        res.end();
      },
      async ({ base }) => {
        const [a, b] = await runtimes();
        const ra = await a!.fetch(`${base}/feed`, PRIOR);
        const rb = await b!.fetch(`${base}/feed`, PRIOR);
        expect(ra).toEqual({ status: 304, notModified: true, body: null, ...PRIOR });
        expect(rb).toEqual(ra);
      }
    );
  });

  it("a 500 with an endless error body returns the same result and BOTH cancel the body stream", async () => {
    /* B1-04. MUTATION THAT KILLS THIS: delete `await res.body?.cancel?.()`
       from the `!res.ok` branch of EITHER conditionalGet.ts or
       fetch-feed.mjs -> that runtime's connection stays open (the error
       body is left for GC) and its `closedEarly` row is false. */
    await withServer(
      (_req, res) => {
        res.writeHead(500, { ETag: '"err"', "Content-Type": "text/plain" });
        pumpForever(res);
      },
      async ({ base, seen }) => {
        const results: Record<string, FeedFetchResult> = {};
        const freed: Record<string, boolean> = {};
        for (const rt of await runtimes()) {
          results[rt.name] = await rt.fetch(`${base}/${rt.name}`, PRIOR);
          const entry = seen.find((s) => s.path === `/${rt.name}`)!;
          freed[rt.name] = await waitFor(() => entry.closedEarly);
        }
        expect(results.ts).toEqual({
          status: 500,
          notModified: false,
          body: null,
          etag: '"err"',
          lastModified: null,
          error: "HTTP 500"
        });
        expect(results.mjs).toEqual(results.ts);
        expect(freed).toEqual({ ts: true, mjs: true });
      }
    );
  });

  it("a declared Content-Length one byte over the DEFAULT cap is rejected identically", async () => {
    /* MUTATION THAT KILLS THIS: change MAX_FEED_BYTES in ONE runtime
       (conditionalGet.ts, or tools/refresh/fetch-limits.mjs which
       fetch-feed.mjs now imports it from) -> the error strings name
       different limits, or one runtime starts reading the body. */
    await withServer(
      (_req, res) => {
        res.writeHead(200, { "Content-Length": String(MAX_FEED_BYTES + 1), ETag: '"big"' });
        res.write("x".repeat(64));
      },
      async ({ base }) => {
        const [a, b] = await runtimes();
        const ra = await a!.fetch(`${base}/big`, PRIOR);
        const rb = await b!.fetch(`${base}/big`, PRIOR);
        expect(ra).toEqual({
          status: 200,
          notModified: false,
          body: null,
          etag: '"big"',
          lastModified: null,
          error: `declared Content-Length ${MAX_FEED_BYTES + 1} exceeds ${MAX_FEED_BYTES} byte limit`
        });
        expect(rb).toEqual(ra);
      }
    );
  });

  it("an endless 200 with no Content-Length is aborted mid-stream identically", async () => {
    /* MUTATION THAT KILLS THIS: change the mid-stream error text or the
       `total > maxBytes` test in ONE reader (conditionalGet.ts's
       readBodyCapped, or fetch-limits.mjs's, which fetch-feed.mjs uses). */
    await withServer(
      (_req, res) => {
        res.writeHead(200, { ETag: '"chunked"' });
        pumpForever(res);
      },
      async ({ base }) => {
        const [a, b] = await runtimes();
        const ra = await a!.fetch(`${base}/endless`, PRIOR, { maxBytes: 1024 });
        const rb = await b!.fetch(`${base}/endless`, PRIOR, { maxBytes: 1024 });
        expect(ra).toEqual({
          status: 0,
          notModified: false,
          body: null,
          ...PRIOR,
          error: "fetch error: response exceeded 1024 bytes (aborted mid-stream)"
        });
        expect(rb).toEqual(ra);
      }
    );
  });

  it("both abort a stalled request at the same DEFAULT timeout (15 s)", async () => {
    /* MUTATION THAT KILLS THIS: change the default timeout in ONE runtime
       (`opts.timeoutMs ?? 15_000` in conditionalGet.ts, DEFAULT_TIMEOUT_MS in
       fetch-feed.mjs) -> that runtime is still pending at 15 000 ms, or
       already settled at 14 999 ms. Fake timers: no real wait. */
    vi.useFakeTimers();
    const stalled = ((_url: string, init: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted by timeout")));
      })) as unknown as typeof fetch;

    const settled: Record<string, FeedFetchResult | undefined> = {};
    for (const rt of await runtimes()) {
      void rt.fetch("http://127.0.0.1:9/stall", PRIOR, { fetchImpl: stalled }).then((r) => {
        settled[rt.name] = r;
      });
    }
    await vi.advanceTimersByTimeAsync(14_999);
    expect(settled).toEqual({});
    await vi.advanceTimersByTimeAsync(1);
    const expected = { status: 0, notModified: false, body: null, ...PRIOR, error: "fetch error: aborted by timeout" };
    expect(settled).toEqual({ ts: expected, mjs: expected });
  });

  it("a UTF-8 BOM is stripped by fetch-feed.mjs exactly as fetch-limits.readBodyCapped strips it", async () => {
    /* T1-10. fetch-feed.mjs used to carry its own copy of readBodyCapped
       ending in `Buffer#toString("utf8")`, which keeps a leading U+FEFF; the
       fetch-limits reader decodes with TextDecoder, which drops it (round-3
       L8). MUTATION THAT KILLS THIS: fetch-feed.mjs decoding with its own
       `Buffer.concat(...).toString("utf8")` again -> its body starts with
       U+FEFF and differs from fetch-limits'. */
    const limits = (await import("../../tools/refresh/fetch-limits.mjs")) as unknown as {
      readBodyCapped: (res: Response, controller: AbortController, maxBytes?: number) => Promise<string>;
    };
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("<rss/>")]);
    await withServer(
      (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/rss+xml" });
        res.end(bom);
      },
      async ({ base }) => {
        const [tsRt, mjsRt] = await runtimes();
        const viaLimits = await limits.readBodyCapped(await fetch(`${base}/limits`), new AbortController());
        const viaPoller = (await mjsRt!.fetch(`${base}/poller`, PRIOR)).body;
        expect(viaLimits).toBe("<rss/>");
        expect(viaPoller).toBe(viaLimits);

        /* KNOWN DIVERGENCE, pinned so it is a decision and not an accident:
           the backend reader (conditionalGet.ts, used by api/) still decodes
           with Buffer#toString and keeps the BOM. CH2-28's exact change does
           not touch the TS decode; routing it through TextDecoder flips this
           row to "<rss/>" and the parity is then total. */
        expect((await tsRt!.fetch(`${base}/backend`, PRIOR)).body).toBe("\uFEFF<rss/>");
      }
    );
  });
});
