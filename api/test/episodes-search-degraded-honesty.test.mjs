// Degraded-response honesty for GET /api/episodes/search's show-scoped mode
// (issue #560 item 1's second half).
//
// WHY THIS EXISTS
// `searchWithinShow()` resolves a show_id to a feed URL via `loadShowMeta()`,
// which reads `data/catalog.json` + `data/catalog-breadth.json` off disk —
// the same two files `api/test/vercel-bundle.test.mjs` guards the Vercel
// bundling of. Before this test, `loadShowMeta()` treated "both catalog
// files failed to read" (a bundling/deploy gap) identically to "the files
// read fine, this show_id just isn't in them" (a normal bad-input case): both
// silently produced `null`, and the handler reported the SAME
// `unknown show_id: <id>` message either way. That conflation is exactly the
// shape of bug #560 flags for the sibling (unscoped) search path: a real
// infrastructure failure disguises itself as an ordinary, unremarkable
// result instead of surfacing as the operational problem it actually is.
//
// `loadShowMeta()` now throws `ShowMetaFilesUnavailableError` when NEITHER
// required file could be read, and `searchWithinShow()` reports that
// distinctly (see api/episodes/search.ts). This suite drives that path
// end-to-end through the real handler, using `_setShowMetaRootForTests()` to
// point the lookup at a directory with no `data/` at all — never touching
// the real `data/` directory.
//
// MUTATION NOTE: this suite goes red if `loadShowMeta()` goes back to
// swallowing a fully-missing catalog pair into a plain `null` (the handler
// would then report the misleading `unknown show_id: ...` message instead of
// an honest one), or if the handler stops surfacing `ShowMetaFilesUnavailableError`
// as `degraded: true` + a non-empty `error` string, or degrades the response
// shape (extra/missing keys) between the healthy and unavailable cases.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as searchModule from "../episodes/search.ts";
import { _setShowMetaRootForTests } from "../episodes/search.ts";
import { _resetShowIdMapCacheForTests } from "../episodes/showIdMap.ts";

const handler = typeof searchModule.default === "function" ? searchModule.default : searchModule.default.default;

function mockRes() {
  const headers = {};
  const state = { statusCode: null, body: undefined, ended: false };
  return {
    headers,
    get statusCode() { return state.statusCode; },
    get body() { return state.body; },
    status(code) { state.statusCode = code; return this; },
    json(body) { state.body = body; },
    setHeader(name, value) { headers[name] = value; },
    end() { state.ended = true; },
  };
}

const RESPONSE_KEYS = ["query", "show", "episodes", "source", "degraded", "error"].sort();

test("show-scoped search: both catalog files unreadable reports an honest degraded failure, never a false-empty success", async (t) => {
  _resetShowIdMapCacheForTests();
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "foray-showmeta-missing-"));
  t.after(() => {
    _setShowMetaRootForTests(); // restore the real repo root for any test that runs after this one
    fs.rmSync(emptyRoot, { recursive: true, force: true });
  });
  _setShowMetaRootForTests(emptyRoot);

  const req = { method: "GET", query: { q: "alpha", show: "lex-fridman-podcast" }, headers: {} };
  const res = mockRes();
  await handler(req, res);

  assert.strictEqual(res.statusCode, 200, "an unavailable catalog degrades honestly — never a 500");
  assert.deepStrictEqual(res.body.episodes, [], "no episodes can be resolved without the catalog files");
  assert.strictEqual(res.body.degraded, true, "MUTATION: this is the exact bug #560 flags — a bundling/deploy gap must not look like a healthy empty result");
  assert.ok(
    typeof res.body.error === "string" && res.body.error.length > 0,
    "error must be a real, non-empty string, not null"
  );
  assert.notStrictEqual(
    res.body.error,
    "unknown show_id: lex-fridman-podcast",
    "must not be conflated with a genuinely-unknown show_id — the catalog files are the problem, not the id"
  );
  assert.deepStrictEqual(
    Object.keys(res.body).sort(),
    RESPONSE_KEYS,
    "the response shape (its keys) must stay the same as the healthy-path response"
  );
});

test("show-scoped search: a genuinely unknown show_id (catalog files ARE readable) keeps its original, distinct message", async (t) => {
  _resetShowIdMapCacheForTests();
  t.after(() => _setShowMetaRootForTests());
  _setShowMetaRootForTests(); // explicit: use the real repo root, catalog files present

  const req = { method: "GET", query: { q: "alpha", show: "definitely-not-a-real-show-xyz-560" }, headers: {} };
  const res = mockRes();
  await handler(req, res);

  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body.episodes, []);
  assert.strictEqual(res.body.degraded, true);
  assert.strictEqual(
    res.body.error,
    "unknown show_id: definitely-not-a-real-show-xyz-560",
    "a normal bad show_id keeps its original, more specific message once the catalog files ARE readable"
  );
  assert.deepStrictEqual(Object.keys(res.body).sort(), RESPONSE_KEYS);
});
