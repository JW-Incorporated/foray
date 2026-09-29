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
const {
  resolveUpstreamAsset, isGzippedAsset, IndexPathError, _setPointerPathForTests,
  shardKeyFromRequestPath, resolveShardRelease,
} = indexModule;

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
        /* search-api-css-7: the URL does not carry the release tag, so it is
           never immutable. MUTATION: put `immutable` back. */
        assert.strictEqual(res.headers["Cache-Control"], "public, max-age=300");
        assert.doesNotMatch(res.headers["Cache-Control"], /immutable/);
      }
    )
  );
});

test("a shard request fetches the .gz asset and gunzips it before responding", async () => {
  const shardRows = [{ id: 1, t: "Lex Fridman Podcast", a: null, i: null, u: null, img: null, n: null, c: true }];
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(shardRows)));
  const pointer = {
    asset_base_url: "https://example.test/rel",
    shard_releases: [{ tag: "t-shards-1", asset_base_url: "https://example.test/rel", first_key: "aa", last_key: "zz", count: 1 }],
  };
  await withPointerFile(pointer, () =>
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
  const pointer = {
    asset_base_url: "https://example.test/rel",
    shard_releases: [{ tag: "t-shards-1", asset_base_url: "https://example.test/rel", first_key: "aa", last_key: "zz", count: 1 }],
  };
  await withPointerFile(pointer, () =>
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

/* ==================================================================== */
/* S-04c: shard batch release resolution                                 */
/* ==================================================================== */

test("shardKeyFromRequestPath: extracts the key from a shard request, null for a top-level file", () => {
  assert.strictEqual(shardKeyFromRequestPath("shards/fr.json"), "fr");
  assert.strictEqual(shardKeyFromRequestPath("shards/a_.json"), "a_");
  assert.strictEqual(shardKeyFromRequestPath("shards/__.json"), "__");
  assert.strictEqual(shardKeyFromRequestPath("manifest.json"), null);
});

test("resolveShardRelease: finds the batch whose first_key/last_key range covers the key", () => {
  const releases = [
    { tag: "t-shards-1", asset_base_url: "https://x/t-shards-1", first_key: "aa", last_key: "mm", count: 500 },
    { tag: "t-shards-2", asset_base_url: "https://x/t-shards-2", first_key: "mn", last_key: "zz", count: 500 },
  ];
  assert.strictEqual(resolveShardRelease(releases, "fr").tag, "t-shards-1");
  assert.strictEqual(resolveShardRelease(releases, "mm").tag, "t-shards-1");
  assert.strictEqual(resolveShardRelease(releases, "mn").tag, "t-shards-2");
  assert.strictEqual(resolveShardRelease(releases, "zz").tag, "t-shards-2");
});

test("resolveShardRelease: returns null when no batch covers the key or the list is empty/undefined", () => {
  assert.strictEqual(resolveShardRelease([], "fr"), null);
  assert.strictEqual(resolveShardRelease(undefined, "fr"), null);
  const releases = [{ tag: "t-shards-1", asset_base_url: "https://x", first_key: "aa", last_key: "mm", count: 1 }];
  assert.strictEqual(resolveShardRelease(releases, "zz"), null);
});

test("a shard request fetches from the SHARD RELEASE's asset_base_url, not the top-level one", async () => {
  const shardRows = [{ id: 1, t: "Lex Fridman Podcast", a: null, i: null, u: null, img: null, n: null, c: true }];
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(shardRows)));
  const pointer = {
    asset_base_url: "https://example.test/top",
    release_tag: "shows-index-v1",
    shard_releases: [
      { tag: "shows-index-v1-shards-1", asset_base_url: "https://example.test/shard-batch-1", first_key: "aa", last_key: "zz", count: 1298 },
    ],
    shards_published: true,
  };
  await withPointerFile(pointer, () =>
    withMockedFetch(
      async (url) => {
        assert.strictEqual(url, "https://example.test/shard-batch-1/fr.json.gz",
          "a shard request must resolve against shard_releases, never the top-level asset_base_url");
        return new Response(gz, { status: 200 });
      },
      async () => {
        const req = { method: "GET", query: { path: ["shards", "fr.json"] }, headers: {} };
        const res = mockRes();
        await handler(req, res);
        assert.strictEqual(res.statusCode, 200);
        assert.deepStrictEqual(res.body, shardRows);
        assert.strictEqual(res.headers["X-Shows-Index-Version"], "shows-index-v1");
      }
    )
  );
});

test("a shard request for a key with no covering shard_releases batch is a 404, not a 502", async () => {
  const pointer = {
    asset_base_url: "https://example.test/top",
    release_tag: "shows-index-v1",
    shard_releases: [], // shards not published yet for this pointer
    shards_published: false,
  };
  await withPointerFile(pointer, () =>
    withMockedFetch(
      async () => { assert.fail("fetch must not be called when no shard release covers the key"); },
      async () => {
        const req = { method: "GET", query: { path: ["shards", "fr.json"] }, headers: {} };
        const res = mockRes();
        await handler(req, res);
        assert.strictEqual(res.statusCode, 404);
        assert.strictEqual(res.body.available, false);
        assert.strictEqual(res.headers["Cache-Control"], "no-store");
      }
    )
  );
});

test("a top-level file request still uses asset_base_url and carries the version header", async () => {
  const manifest = { export_version: "local:abc123", row_count: 42 };
  const pointer = {
    asset_base_url: "https://example.test/top",
    release_tag: "shows-index-v1",
    shard_releases: [{ tag: "shows-index-v1-shards-1", asset_base_url: "https://example.test/shard-batch-1", first_key: "aa", last_key: "zz", count: 1 }],
    shards_published: true,
  };
  await withPointerFile(pointer, () =>
    withMockedFetch(
      async (url) => {
        assert.strictEqual(url, "https://example.test/top/manifest.json");
        return new Response(JSON.stringify(manifest), { status: 200 });
      },
      async () => {
        const req = { method: "GET", query: { path: ["manifest.json"] }, headers: {} };
        const res = mockRes();
        await handler(req, res);
        assert.strictEqual(res.statusCode, 200);
        assert.deepStrictEqual(res.body, manifest);
        assert.strictEqual(res.headers["X-Shows-Index-Version"], "shows-index-v1");
      }
    )
  );
});

test("X-Shows-Index-Version is exposed via Access-Control-Expose-Headers — otherwise a cross-origin caller's JS can never read it (review finding)", async () => {
  // Every real caller of this endpoint is cross-origin (app.js's API_ORIGIN
  // is a different origin than the page) — per the Fetch spec a custom
  // response header is invisible to cross-origin JS unless explicitly
  // exposed. Asserted on both the success path and the 404 "not published
  // yet" path, since the header is set unconditionally before the method
  // check.
  const pointer = { asset_base_url: "https://example.test/rel" };
  await withPointerFile(pointer, () =>
    withMockedFetch(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      async () => {
        const req = { method: "GET", query: { path: ["manifest.json"] }, headers: {} };
        const res = mockRes();
        await handler(req, res);
        assert.strictEqual(res.headers["Access-Control-Expose-Headers"], "X-Shows-Index-Version");
      }
    )
  );
  await withPointerFile(null, async () => {
    const req = { method: "GET", query: { path: ["manifest.json"] }, headers: {} };
    const res = mockRes();
    await handler(req, res);
    assert.strictEqual(res.headers["Access-Control-Expose-Headers"], "X-Shows-Index-Version");
  });
});

/* ==================================================================== */
/* search-api-css-7: the upstream fetch is bounded                       */
/* ==================================================================== */

const TOP = { asset_base_url: "https://example.test/rel" };
const manifestReq = () => ({ method: "GET", query: { path: ["manifest.json"] }, headers: {} });

test("a hung upstream is abandoned at the deadline as a 502, never held until the platform kills it", async () => {
  /* MUTATION: drop the AbortController signal from the upstream fetch — the
     request never settles and this test times out. */
  indexModule._setUpstreamTimeoutMsForTests(30);
  try {
    await withPointerFile(TOP, () =>
      withMockedFetch(
        (url, init) => new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
        async () => {
          const res = mockRes();
          let guard;
          const hung = new Promise((_, reject) => { guard = setTimeout(() => reject(new Error("the handler is still waiting on a hung upstream")), 2_000); });
          try {
            await Promise.race([handler(manifestReq(), res), hung]);
          } finally {
            clearTimeout(guard);
          }
          assert.strictEqual(res.statusCode, 502);
          assert.strictEqual(res.headers["Cache-Control"], "no-store");
        }
      )
    );
  } finally {
    indexModule._setUpstreamTimeoutMsForTests();
  }
});

test("a body that fails mid-read is the endpoint's 502, not an unhandled 500", async () => {
  /* MUTATION: move the body read back outside the try — the handler throws. */
  await withPointerFile(TOP, () =>
    withMockedFetch(
      async () => {
        const body = new ReadableStream({
          pull(controller) { controller.error(new Error("connection reset mid-body")); },
        });
        return new Response(body, { status: 200 });
      },
      async () => {
        const res = mockRes();
        await handler(manifestReq(), res);
        assert.strictEqual(res.statusCode, 502);
        assert.match(res.body.error, /connection reset mid-body/);
      }
    )
  );
});

test("an upstream body over the byte cap, or one that declares it, is refused as a 502", async () => {
  await withPointerFile(TOP, () =>
    withMockedFetch(
      async () => new Response("{}", { status: 200, headers: { "content-length": String(indexModule.MAX_UPSTREAM_BYTES + 1) } }),
      async () => {
        const res = mockRes();
        await handler(manifestReq(), res);
        assert.strictEqual(res.statusCode, 502);
        assert.match(res.body.error, /cap/);
      }
    )
  );
});

test("a shard that inflates past the decompression cap is refused as a 502", async () => {
  /* MUTATION: drop maxOutputLength from gunzipSync — the bomb inflates. */
  const bomb = zlib.gzipSync(Buffer.alloc(indexModule.MAX_DECOMPRESSED_BYTES + 1024, 0x20));
  const pointer = {
    asset_base_url: "https://example.test/rel",
    shard_releases: [{ tag: "t", asset_base_url: "https://example.test/rel", first_key: "aa", last_key: "zz", count: 1 }],
  };
  await withPointerFile(pointer, () =>
    withMockedFetch(
      async () => new Response(bomb, { status: 200 }),
      async () => {
        const res = mockRes();
        await handler({ method: "GET", query: { path: ["shards", "fr.json"] }, headers: {} }, res);
        assert.strictEqual(res.statusCode, 502);
        assert.match(res.body.error, /decompress/);
      }
    )
  );
});
