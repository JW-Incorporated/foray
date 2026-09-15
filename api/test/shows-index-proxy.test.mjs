// api/shows/index/[...path].ts — S-05's shard-index proxy (kanban
// t_546eac9f). See that file's header for the Fable ruling this implements.
import { test } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as zlib from "node:zlib";
import * as indexModule from "../shows/index/[...path].ts";

const handler = typeof indexModule.default === "function" ? indexModule.default : indexModule.default.default;
const { resolveUpstreamAsset, isGzippedAsset, IndexPathError, _setPointerPathForTests } = indexModule;

function mockRes() {
  const headers = {};
  const state = { statusCode: null, body: undefined };
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
    end() {}
  };
}

function withMockedFetch(impl, run) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return Promise.resolve(run()).finally(() => {
    globalThis.fetch = original;
  });
}

function withPointerFile(pointer, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "s05-pointer-"));
  const file = path.join(dir, "shows-index-pointer.json");
  if (pointer !== null) fs.writeFileSync(file, JSON.stringify(pointer));
  _setPointerPathForTests(pointer === null ? path.join(dir, "does-not-exist.json") : file);
  return Promise.resolve(run()).finally(() => {
    _setPointerPathForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

/* ==================================================================== */
/* resolveUpstreamAsset / isGzippedAsset — pure allowlist logic          */
/* ==================================================================== */

test("the four top-level artifacts resolve to themselves, uncompressed", () => {
  for (const f of ["manifest.json", "top.json", "id-map.json", "changed.json"]) {
    assert.strictEqual(resolveUpstreamAsset(f), f);
    assert.strictEqual(isGzippedAsset(f), false);
  }
});

test("a two-char shard prefix resolves to its .json.gz upstream BASENAME (release assets are flat)", () => {
  /* MUTATION: return `shards/${...}.json.gz` (a "shards/" prefixed upstream
     name) — that shape never exists on the real release: `gh release
     create` names every asset by local basename, discarding the directory
     (see this file's own header and api/shows/index/[...path].ts's). */
  assert.strictEqual(resolveUpstreamAsset("shards/fr.json"), "fr.json.gz");
  assert.strictEqual(isGzippedAsset("shards/fr.json"), true);
});

test("a single-char-plus-underscore and the __ catch-all prefix both resolve to flat basenames", () => {
  assert.strictEqual(resolveUpstreamAsset("shards/a_.json"), "a_.json.gz");
  assert.strictEqual(resolveUpstreamAsset("shards/__.json"), "__.json.gz");
});

test("a path-traversal attempt is rejected, not silently forwarded", () => {
  /* MUTATION: drop the anchored `^...$` from SHARD_FILE_RE. This assertion
     fails because `shards/../../etc/passwd` would then match the loose
     `shards/` prefix. */
  assert.throws(() => resolveUpstreamAsset("shards/../../etc/passwd.json"), IndexPathError);
  assert.throws(() => resolveUpstreamAsset("../manifest.json"), IndexPathError);
});

test("an uppercase or 3-char prefix is rejected — the builder never emits one", () => {
  assert.throws(() => resolveUpstreamAsset("shards/FR.json"), IndexPathError);
  assert.throws(() => resolveUpstreamAsset("shards/abc.json"), IndexPathError);
});

test("an arbitrary unlisted file name is rejected", () => {
  assert.throws(() => resolveUpstreamAsset("secrets.json"), IndexPathError);
  assert.throws(() => resolveUpstreamAsset(""), IndexPathError);
});

/* ==================================================================== */
/* handler — end to end against a mocked pointer + mocked fetch          */
/* ==================================================================== */

test("no pointer on disk: 404 with available:false, never a 500, never cached", async () => {
  await withPointerFile(null, async () => {
    const req = { method: "GET", query: { path: ["manifest.json"] }, headers: {} };
    const res = mockRes();
    await handler(req, res);
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(res.body.available, false);
    assert.strictEqual(res.headers["Cache-Control"], "no-store");
  });
});

test("a recognised top-level file is fetched from asset_base_url and returned as JSON", async () => {
  const manifest = { export_version: "local:abc123", row_count: 42 };
  await withPointerFile({ asset_base_url: "https://github.com/JW-Incorporated/foray/releases/download/shows-index-x" }, () =>
    withMockedFetch(
      async (url) => {
        assert.strictEqual(url, "https://github.com/JW-Incorporated/foray/releases/download/shows-index-x/manifest.json");
        return new Response(JSON.stringify(manifest), { status: 200 });
      },
      async () => {
        const req = { method: "GET", query: { path: ["manifest.json"] }, headers: {} };
        const res = mockRes();
        await handler(req, res);
        assert.strictEqual(res.statusCode, 200);
        assert.deepStrictEqual(res.body, manifest);
        assert.strictEqual(res.headers["Cache-Control"], "public, max-age=3600, immutable");
      }
    )
  );
});

test("a shard request fetches the .gz asset and gunzips it before responding", async () => {
  const shardRows = [{ id: 1, t: "Lex Fridman Podcast", a: null, i: null, u: null, img: null, n: null, c: true }];
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(shardRows)));
  await withPointerFile({ asset_base_url: "https://example.test/rel" }, () =>
    withMockedFetch(
      async (url) => {
        assert.strictEqual(url, "https://example.test/rel/fr.json.gz");
        return new Response(gz, { status: 200 });
      },
      async () => {
        const req = { method: "GET", query: { path: ["shards", "fr.json"] }, headers: {} };
        const res = mockRes();
        await handler(req, res);
        assert.strictEqual(res.statusCode, 200);
        assert.deepStrictEqual(res.body, shardRows);
      }
    )
  );
});

test("an unlisted path is 400 and fetch is never called", async () => {
  await withPointerFile({ asset_base_url: "https://example.test/rel" }, () =>
    withMockedFetch(
      async () => {
        assert.fail("fetch must not be called for a rejected path");
      },
      async () => {
        const req = { method: "GET", query: { path: ["secrets.json"] }, headers: {} };
        const res = mockRes();
        await handler(req, res);
        assert.strictEqual(res.statusCode, 400);
      }
    )
  );
});

test("an upstream non-200 is a 502, not forwarded verbatim, and never cached", async () => {
  await withPointerFile({ asset_base_url: "https://example.test/rel" }, () =>
    withMockedFetch(
      async () => new Response("", { status: 404 }),
      async () => {
        const req = { method: "GET", query: { path: ["manifest.json"] }, headers: {} };
        const res = mockRes();
        await handler(req, res);
        assert.strictEqual(res.statusCode, 502);
        assert.strictEqual(res.body.available, false);
        assert.strictEqual(res.headers["Cache-Control"], "no-store");
      }
    )
  );
});

test("a corrupt (non-gzip) shard asset is a 502, never a crash", async () => {
  await withPointerFile({ asset_base_url: "https://example.test/rel" }, () =>
    withMockedFetch(
      async () => new Response("not actually gzip", { status: 200 }),
      async () => {
        const req = { method: "GET", query: { path: ["shards", "fr.json"] }, headers: {} };
        const res = mockRes();
        await handler(req, res);
        assert.strictEqual(res.statusCode, 502);
        assert.strictEqual(res.body.available, false);
      }
    )
  );
});

test("CORS is applied: an allowed origin gets ACAO, and OPTIONS never reaches fetch", async () => {
  await withPointerFile({ asset_base_url: "https://example.test/rel" }, () =>
    withMockedFetch(
      async () => {
        assert.fail("fetch must not be called on an OPTIONS preflight");
      },
      async () => {
        const req = { method: "OPTIONS", query: { path: ["manifest.json"] }, headers: { origin: "capacitor://localhost" } };
        const res = mockRes();
        await handler(req, res);
        assert.strictEqual(res.statusCode, 204);
        assert.strictEqual(res.headers["Access-Control-Allow-Origin"], "capacitor://localhost");
      }
    )
  );
});

test("method other than GET/OPTIONS is 405", async () => {
  const req = { method: "POST", query: { path: ["manifest.json"] }, headers: {} };
  const res = mockRes();
  await handler(req, res);
  assert.strictEqual(res.statusCode, 405);
});
