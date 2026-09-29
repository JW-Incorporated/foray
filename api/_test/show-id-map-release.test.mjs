// The release id-map fetch is bounded and retried (round-3 audit,
// search-api-css-8). It had no timeout, and it runs inside the first general
// episode search of a cold instance after a bucket slot was spent; and one
// failure cached the catalogue fallback for the instance's whole life, so a
// warm instance never tried the release again after GitHub recovered.
// (Latent today: the committed pointer has no id_map_url.)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadShowIdMap, _resetShowIdMapCacheForTests, _setShowIdMapPointerPathForTests,
  RELEASE_ID_MAP_TIMEOUT_MS, RELEASE_RETRY_MS,
} from "../_lib/showIdMap.ts";

function withPointer(pointer, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "id-map-pointer-"));
  const file = path.join(dir, "shows-index-pointer.json");
  fs.writeFileSync(file, JSON.stringify(pointer));
  _setShowIdMapPointerPathForTests(file);
  _resetShowIdMapCacheForTests();
  return Promise.resolve(run()).finally(() => {
    _setShowIdMapPointerPathForTests();
    _resetShowIdMapCacheForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

const POINTER = { id_map_url: "https://example.test/rel/id-map.json" };

test("the release fetch carries a deadline of its own", async () => {
  /* MUTATION: call fetchImpl without the signal — `init` is undefined here. */
  await withPointer(POINTER, async () => {
    let seen;
    await loadShowIdMap({ fetchImpl: async (url, init) => { seen = init; throw new Error("down"); } });
    assert.ok(seen?.signal instanceof AbortSignal, "the id-map fetch must be abortable");
    assert.ok(RELEASE_ID_MAP_TIMEOUT_MS <= 2_000);
  });
});

test("a hung release fetch is abandoned and the catalogue fallback answers", async () => {
  await withPointer(POINTER, async () => {
    /* A generous guard, not a stopwatch: a loaded CI box is slow, but an
       unbounded fetch never settles at all. */
    let guard;
    const hung = new Promise((_, reject) => {
      guard = setTimeout(() => reject(new Error("the id-map load is still waiting on a hung release")), RELEASE_ID_MAP_TIMEOUT_MS + 10_000);
    });
    try {
      const map = await Promise.race([
        loadShowIdMap({
          fetchImpl: (url, init) => new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
        }),
        hung,
      ]);
      assert.equal(map.source, "catalog-fallback");
    } finally {
      clearTimeout(guard);
    }
  });
});

test("a failed release is retried after the retry window, not pinned for the instance's life", async () => {
  /* MUTATION: drop the retryDue check in loadShowIdMap — the recovered release
     is never fetched again and the source stays catalog-fallback. */
  await withPointer(POINTER, async () => {
    let t = 1_000_000;
    const now = () => t;
    let calls = 0;
    let healthy = false;
    const fetchImpl = async () => {
      calls += 1;
      if (!healthy) throw new Error("github down");
      return new Response(JSON.stringify({ "123": "some-show" }), { status: 200 });
    };
    assert.equal((await loadShowIdMap({ fetchImpl, now })).source, "catalog-fallback");
    healthy = true;
    t += RELEASE_RETRY_MS - 1;
    assert.equal((await loadShowIdMap({ fetchImpl, now })).source, "catalog-fallback", "inside the window: no retry");
    assert.equal(calls, 1);
    t += 2;
    const after = await loadShowIdMap({ fetchImpl, now });
    assert.equal(after.source, "release");
    assert.equal(after.byCollectionId.get(123), "some-show");
    assert.equal(calls, 2);
  });
});

test("no id_map_url means no fetch and nothing to retry", async () => {
  await withPointer({ version: "x" }, async () => {
    let calls = 0;
    const fetchImpl = async () => { calls += 1; throw new Error("never"); };
    let t = 0;
    await loadShowIdMap({ fetchImpl, now: () => t });
    t += RELEASE_RETRY_MS * 3;
    await loadShowIdMap({ fetchImpl, now: () => t });
    assert.equal(calls, 0);
  });
});
