/* tools/shows/search-shows.test.mjs — pure query-builder tests (no DB).
   The golden-query ranking set against a real Postgres lives in
   shows-postgres-integration.test.mjs (CI `db` job only). */
import test from "node:test";
import assert from "node:assert/strict";
import { buildFtsQuery, buildTrgmQuery, searchShows } from "./search-shows.mjs";

test("buildFtsQuery: parameterises query and limit, excludes dead by default", () => {
  const q = buildFtsQuery({ query: "lex fridman", limit: 5 });
  assert.match(q.text, /websearch_to_tsquery\('english', \$1\)/);
  assert.match(q.text, /dead = false/);
  assert.deepEqual(q.values, ["lex fridman", 5]);
});

test("buildFtsQuery: includeDead drops the dead=false clause", () => {
  const q = buildFtsQuery({ query: "x", limit: 5, includeDead: true });
  assert.doesNotMatch(q.text, /dead = false/);
});

test("buildFtsQuery: curated boost is additive in the rank expression", () => {
  const q = buildFtsQuery({ query: "x", limit: 5 });
  assert.match(q.text, /case when curated then [\d.]+ else 0 end/);
});

test("buildTrgmQuery: parameterises query, limit, and min similarity", () => {
  const q = buildTrgmQuery({ query: "joe rogen", limit: 10 });
  assert.match(q.text, /similarity\(title, \$1\) > \$3/);
  assert.equal(q.values[0], "joe rogen");
  assert.equal(q.values[1], 10);
  assert.equal(typeof q.values[2], "number");
});

test("searchShows: empty/whitespace query short-circuits without hitting the client", async () => {
  let called = false;
  const fakeClient = { query: async () => { called = true; return { rows: [] }; } };
  const result = await searchShows(fakeClient, { query: "   " });
  assert.deepEqual(result, { rows: [], strategy: "empty_query" });
  assert.equal(called, false);
});

test("searchShows: returns fts strategy when the FTS pass finds rows", async () => {
  const fakeClient = {
    query: async (q) => {
      assert.match(q.text, /websearch_to_tsquery/);
      return { rows: [{ pi_id: 1, title: "Lex Fridman Podcast" }] };
    },
  };
  const result = await searchShows(fakeClient, { query: "lex fridman" });
  assert.equal(result.strategy, "fts");
  assert.equal(result.rows.length, 1);
});

test("searchShows: falls back to trgm when FTS finds nothing", async () => {
  let calls = 0;
  const fakeClient = {
    query: async (q) => {
      calls++;
      if (calls === 1) {
        assert.match(q.text, /websearch_to_tsquery/);
        return { rows: [] };
      }
      assert.match(q.text, /similarity\(title/);
      return { rows: [{ pi_id: 2, title: "Joe Rogan Experience" }] };
    },
  };
  const result = await searchShows(fakeClient, { query: "joe rogen" });
  assert.equal(calls, 2);
  assert.equal(result.strategy, "trgm_fallback");
  assert.equal(result.rows[0].pi_id, 2);
});
