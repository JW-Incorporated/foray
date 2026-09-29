// One endpoint, one shape (round-3 audit, arch-drift-13). The per-show list's
// DB branch (dormant: no DATABASE_URL in production) had drifted from the live
// branch: no pagination and no next_cursor (app.js reads a missing cursor as
// "this is the whole show"), no `degraded`, and connect() outside any try, so
// an unreachable database was a 500. Both branches now go through one shape
// assertion here.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as episodesModule from "../shows/[show_id]/episodes.ts";
import { sharedFeedReader } from "../_lib/feedCache.ts";

const handler = typeof episodesModule.default === "function" ? episodesModule.default : episodesModule.default.default;
const { LIST_RESPONSE_KEYS, _setDbSessionForTests } = episodesModule;
const SHOW = "lex-fridman-podcast";

const FEED = `<?xml version="1.0"?><rss version="2.0"><channel><title>Lex</title><description>About</description>
<item><title>One</title><guid>g1</guid><enclosure url="https://cdn.example.com/1.mp3" type="audio/mpeg" length="1"/><pubDate>Mon, 01 Jan 2026 00:00:00 GMT</pubDate></item>
</channel></rss>`;

function mockRes() {
  const state = { statusCode: null, body: undefined };
  return {
    headers: {},
    get statusCode() { return state.statusCode; },
    get body() { return state.body; },
    status(code) { state.statusCode = code; return this; },
    json(body) { state.body = body; },
    setHeader(name, value) { this.headers[name] = value; },
    end() {},
  };
}

function assertListShape(body, label) {
  assert.deepEqual(Object.keys(body).sort(), [...LIST_RESPONSE_KEYS].sort(), `${label}: keys`);
  assert.ok(Array.isArray(body.episodes), `${label}: episodes is an array`);
  assert.ok(body.next_cursor === null || typeof body.next_cursor === "string", `${label}: next_cursor`);
  assert.equal(typeof body.degraded, "boolean", `${label}: degraded`);
  assert.equal(typeof body.stale, "boolean", `${label}: stale`);
  for (const ep of body.episodes) assert.equal("description_html" in ep, false, `${label}: the list never ships description_html`);
}

function dbRows(n) {
  return Array.from({ length: n }, (_, i) => ({
    show_id: SHOW,
    guid: `db-${String(i).padStart(3, "0")}`,
    title: `Row ${i}`,
    description_html: "<p>html</p>",
    description_text: "text",
    published_at: new Date(Date.UTC(2026, 0, 1) - i * 86_400_000).toISOString(),
    duration_seconds: 60,
    audio_url: `https://cdn.example.com/${i}.mp3`,
    season_number: null,
    episode_number: null,
    chapters_url: null,
    chapters: null,
  }));
}

async function withEnv({ databaseUrl, session }, run) {
  const had = "DATABASE_URL" in process.env;
  const original = process.env.DATABASE_URL;
  if (databaseUrl) process.env.DATABASE_URL = databaseUrl;
  else delete process.env.DATABASE_URL;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(FEED, { status: 200 });
  sharedFeedReader.clear();
  _setDbSessionForTests(session);
  try {
    return await run();
  } finally {
    _setDbSessionForTests();
    globalThis.fetch = originalFetch;
    if (had) process.env.DATABASE_URL = original;
    else delete process.env.DATABASE_URL;
  }
}

test("the live branch and the DB branch answer in one shape", async () => {
  /* MUTATION: drop next_cursor/degraded/stale from the DB branch's body — the
     shared assertion goes red for "db". */
  let ended = 0;
  const session = async () => ({
    refresh: async () => ({ status: "fresh" }),
    episodes: async () => dbRows(3),
    end: async () => { ended += 1; },
  });
  await withEnv({ databaseUrl: null }, async () => {
    const res = mockRes();
    await handler({ method: "GET", query: { show_id: SHOW }, headers: {} }, res);
    assert.equal(res.body.source, "live");
    assertListShape(res.body, "live");
  });
  await withEnv({ databaseUrl: "postgres://fake", session }, async () => {
    const res = mockRes();
    await handler({ method: "GET", query: { show_id: SHOW }, headers: {} }, res);
    assert.equal(res.body.source, "db");
    assertListShape(res.body, "db");
  });
  assert.equal(ended, 1, "the DB session is always closed");
});

test("the DB branch paginates with the same cursor as the live one", async () => {
  /* MUTATION: return every row again (no paginate) — 150 rows, no cursor. */
  const session = async () => ({
    refresh: async () => ({ status: "fresh" }),
    episodes: async () => dbRows(150),
    end: async () => {},
  });
  await withEnv({ databaseUrl: "postgres://fake", session }, async () => {
    const first = mockRes();
    await handler({ method: "GET", query: { show_id: SHOW }, headers: {} }, first);
    assert.equal(first.body.episodes.length, 100);
    assert.equal(typeof first.body.next_cursor, "string");
    const second = mockRes();
    await handler({ method: "GET", query: { show_id: SHOW, cursor: first.body.next_cursor }, headers: {} }, second);
    assert.equal(second.body.episodes.length, 50);
    assert.equal(second.body.next_cursor, null);
    const ids = new Set([...first.body.episodes, ...second.body.episodes].map((e) => e.guid));
    assert.equal(ids.size, 150, "no row repeated or lost across the pages");
  });
});

test("a database it cannot reach degrades to the live branch, never a 500", async () => {
  /* MUTATION: move openDbSession back outside the try — the handler rejects. */
  const session = async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:5432"); };
  await withEnv({ databaseUrl: "postgres://unreachable", session }, async () => {
    const res = mockRes();
    await handler({ method: "GET", query: { show_id: SHOW }, headers: {} }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.source, "live");
    assertListShape(res.body, "db-down");
    assert.equal(res.body.episodes.length, 1);
  });
});
