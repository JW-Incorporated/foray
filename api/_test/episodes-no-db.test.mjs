// api/shows/[show_id]/episodes.ts end-to-end tests (S-02, kanban t_4bd3c0a3):
// no-DB (live) mode, bogus id 404, CORS wiring, and the failure-path
// Cache-Control fix from Fable's ruling on this design (no-store on a
// live-fetch failure, never the cacheable s-maxage header).
//
// DATABASE_URL is asserted absent/deleted around every test so these run
// the no-DB branch regardless of what's in the environment — this suite
// only covers no-DB mode; DB mode is untouched Stage 3b behavior with its
// own existing coverage (backend/test/ingestShowFeed.test.ts,
// backend/test/showEpisodesStore.test.ts).
import { test } from "node:test";
import assert from "node:assert";
import * as episodesModule from "../shows/[show_id]/episodes.ts";

// tsx's ESM/CJS interop for a `export default` TS file can present the
// default export nested (`{ default: handler }`) depending on the loader
// path taken — unwrap defensively so this suite isn't coupled to that detail.
const handler = typeof episodesModule.default === "function" ? episodesModule.default : episodesModule.default.default;

const REAL_SHOW_ID = "lex-fridman-podcast"; // first entry in data/catalog.json, verified present in the repo

const FEED_TWO_EPS = `<?xml version="1.0"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
<channel>
  <title>Lex Fridman Podcast</title>
  <description>Conversations about science, tech, philosophy.</description>
  <item>
    <title>Episode One</title>
    <guid>ep-1</guid>
    <description>First episode</description>
    <enclosure url="https://cdn.example.com/ep1.mp3" type="audio/mpeg" length="1000"/>
    <pubDate>Mon, 01 Jan 2026 00:00:00 GMT</pubDate>
  </item>
  <item>
    <title>Episode Two</title>
    <guid>ep-2</guid>
    <description>Second episode</description>
    <enclosure url="https://cdn.example.com/ep2.mp3" type="audio/mpeg" length="1000"/>
    <pubDate>Tue, 02 Jan 2026 00:00:00 GMT</pubDate>
  </item>
</channel>
</rss>`;

function mockRes() {
  const headers = {};
  const state = { statusCode: null, body: undefined, ended: false };
  return {
    headers,
    get statusCode() {
      return state.statusCode;
    },
    get body() {
      return state.body;
    },
    status(code) {
      state.statusCode = code;
      return this;
    },
    json(body) {
      state.body = body;
    },
    setHeader(name, value) {
      headers[name] = value;
    },
    end() {
      state.ended = true;
    }
  };
}

function withMockedFetch(impl, run) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return Promise.resolve(run()).finally(() => {
    globalThis.fetch = original;
  });
}

function withoutDatabaseUrl(run) {
  const had = "DATABASE_URL" in process.env;
  const original = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  return Promise.resolve(run()).finally(() => {
    if (had) process.env.DATABASE_URL = original;
  });
}

test("no-DB mode: a real show returns 200, source live, episodes, and the show header from the feed", async () => {
  await withoutDatabaseUrl(() =>
    withMockedFetch(
      async () =>
        new Response(FEED_TWO_EPS, { status: 200, headers: { "content-type": "application/rss+xml" } }),
      async () => {
        const req = { method: "GET", query: { show_id: REAL_SHOW_ID }, headers: {} };
        const res = mockRes();
        await handler(req, res);

        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.body.source, "live");
        assert.strictEqual(res.body.degraded, false);
        assert.strictEqual(res.body.episodes.length, 2);
        assert.strictEqual(res.body.show.description, "Conversations about science, tech, philosophy.");
        assert.strictEqual(res.headers["Cache-Control"], "s-maxage=3600, stale-while-revalidate=86400");
      }
    )
  );
});

test("bogus show_id 404s before any feed fetch runs", async () => {
  await withoutDatabaseUrl(() =>
    withMockedFetch(
      async () => {
        assert.fail("fetch must not be called for an unknown show_id");
      },
      async () => {
        const req = { method: "GET", query: { show_id: "definitely-not-a-real-show-id" }, headers: {} };
        const res = mockRes();
        await handler(req, res);
        assert.strictEqual(res.statusCode, 404);
      }
    )
  );
});

test("a live-fetch failure degrades to 200 + empty episodes + no-store (never s-maxage, never a 500)", async () => {
  await withoutDatabaseUrl(() =>
    withMockedFetch(
      async () => new Response("", { status: 503 }),
      async () => {
        const req = { method: "GET", query: { show_id: REAL_SHOW_ID }, headers: {} };
        const res = mockRes();
        await handler(req, res);

        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.body.episodes.length, 0);
        assert.strictEqual(res.body.degraded, true);
        assert.ok(res.body.error);
        // The binding Fable amendment: failure path must never carry the
        // hour-long edge-cacheable header, or a transient hiccup gets
        // pinned at the CDN for every visitor to that show for an hour.
        assert.strictEqual(res.headers["Cache-Control"], "no-store");
      }
    )
  );
});

test("CORS is applied: an allowed origin gets ACAO, and OPTIONS never reaches the feed fetch", async () => {
  await withoutDatabaseUrl(() =>
    withMockedFetch(
      async () => {
        assert.fail("fetch must not be called on an OPTIONS preflight");
      },
      async () => {
        const req = { method: "OPTIONS", query: { show_id: REAL_SHOW_ID }, headers: { origin: "https://jwlabs.ai" } };
        const res = mockRes();
        await handler(req, res);
        assert.strictEqual(res.statusCode, 204);
        assert.strictEqual(res.headers["Access-Control-Allow-Origin"], "https://jwlabs.ai");
      }
    )
  );
});

test("method other than GET/OPTIONS is 405", async () => {
  await withoutDatabaseUrl(async () => {
    const req = { method: "POST", query: { show_id: REAL_SHOW_ID }, headers: {} };
    const res = mockRes();
    await handler(req, res);
    assert.strictEqual(res.statusCode, 405);
  });
});

test("missing show_id is 400", async () => {
  await withoutDatabaseUrl(async () => {
    const req = { method: "GET", query: {}, headers: {} };
    const res = mockRes();
    await handler(req, res);
    assert.strictEqual(res.statusCode, 400);
  });
});
