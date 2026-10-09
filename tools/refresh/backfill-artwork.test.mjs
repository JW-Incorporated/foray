/* tools/refresh/backfill-artwork.mjs looks its ids up through harvest-merge's
 * politeFetchJson, the ONE retry policy for Apple's iTunes endpoints (CH2-32,
 * docs/roadmap/code-health-2.md T1-19). The policy itself is pinned with a fake
 * fetch in tools/harvest-merge.test.mjs; this suite proves the backfill obeys
 * it, and pins the harvest mapping it fills `artwork_url` from.
 *
 * Every test names the mutation that kills it.
 */

import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { artworkFromLookup, lookup } from "./backfill-artwork.mjs";
import { politeFetchJson } from "../harvest-merge.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* Replays `statuses` against globalThis.fetch for the length of `fn`. */
async function withFakeFetch(statuses, fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    const status = statuses[Math.min(calls.length - 1, statuses.length - 1)];
    return {
      status, ok: status >= 200 && status < 300,
      json: async () => ({ results: [{ kind: "podcast", collectionId: 7, artworkUrl600: "https://a/7.jpg" }] }),
    };
  };
  try { return await fn(calls); } finally { globalThis.fetch = real; }
}

const quiet = () => politeFetchJson({ sleep: async () => {} });

test("a 5xx from Apple is retried, not fatal to the whole backfill", async () => {
  /* RED before CH2-32: the private lookup() never retried, so one 503 threw
     out of main() and the run fixed nothing.
     MUTATION: fetch directly in lookup() again -> calls = 1 and it throws. */
  await withFakeFetch([503, 200], async (calls) => {
    const results = await lookup([7, 8], quiet());
    assert.strictEqual(calls.length, 2);
    assert.match(calls[0], /lookup\?id=7,8&entity=podcast$/);
    assert.deepStrictEqual(results.map(artworkFromLookup), ["https://a/7.jpg"]);
  });
});

test("a 404 fails on the first request", async () => {
  /* MUTATION: retry any !res.ok -> calls = 4. */
  await withFakeFetch([404, 200], async (calls) => {
    await assert.rejects(lookup([7], quiet()), /HTTP 404/);
    assert.strictEqual(calls.length, 1);
  });
});

test("artworkFromLookup is the harvest mapping: a podcast's https artworkUrl600, else null", () => {
  /* MUTATION: drop the https check -> an http:// URL is spliced into data/catalog.json. */
  assert.strictEqual(artworkFromLookup({ kind: "podcast", collectionId: 1, artworkUrl600: "https://x/a.jpg" }), "https://x/a.jpg");
  assert.strictEqual(artworkFromLookup({ kind: "podcast", collectionId: 1, artworkUrl600: "http://x/a.jpg" }), null);
  assert.strictEqual(artworkFromLookup({ kind: "podcast", collectionId: 1 }), null);
  assert.strictEqual(artworkFromLookup({ kind: "podcast-episode", collectionId: 1, artworkUrl600: "https://x/a.jpg" }), null);
  assert.strictEqual(artworkFromLookup(null), null);
});

test("the backfill keeps no fetcher of its own", () => {
  /* The card's acceptance grep. MUTATION: a private fetch/retry loop back in
     backfill-artwork.mjs -> `attempt` or `fetch(` reappears. */
  const src = fs.readFileSync(path.join(HERE, "backfill-artwork.mjs"), "utf8");
  assert.match(src, /import \{[^}]*\bpoliteFetchJson\b[^}]*\} from "\.\.\/harvest-merge\.mjs"/,
    "tools/refresh/backfill-artwork.mjs must import politeFetchJson from ../harvest-merge.mjs");
  assert.doesNotMatch(src, /attempt/, "a private retry loop is back in tools/refresh/backfill-artwork.mjs");
  assert.doesNotMatch(src, /\bfetch\(/, "every request goes through politeFetchJson");
});
