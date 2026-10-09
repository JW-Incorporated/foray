// api/_lib/appleClient.ts — the one Apple search client (code-health-2 CH2-39,
// A1-07 and B1-12). Episode search and the show directory each hand-rolled
// this call with the same URL, headers and error strings and two timeouts
// whose comments contradicted each other; the callers' own pins live in
// episodes-search.test.mjs and shows-search-apple.test.mjs. This suite pins
// the client itself, and the source shape that keeps it the only one: one
// Apple search URL under api/, no User-Agent alias, no User-Agent option.
//
// Every test names the mutation that kills it.
import { test, mock } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appleSearch, APPLE_SEARCH_URL } from "../_lib/appleClient.ts";
import { DEFAULT_FEED_USER_AGENT } from "../../backend/src/feeds/userAgent.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const API = path.join(here, "..");
const REPO = path.join(API, "..");

function sourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "_test") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(?:ts|mjs|js)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function recording(response) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return typeof response === "function" ? response() : response;
  };
  return { calls, fetchImpl };
}

test("the URL names the entity, the limit and the encoded term, in that order", async () => {
  /* MUTATION: drop `encodeURIComponent` from the term — the `&` in the term
     splits the query string and this goes red. */
  const { calls, fetchImpl } = recording(new Response(JSON.stringify({ results: [] }), { status: 200 }));
  await appleSearch("podcastEpisode", "rock & roll", 50, { fetchImpl, timeoutMs: 1_000 });
  await appleSearch("podcast", "lex", 25, { fetchImpl, timeoutMs: 1_000 });
  assert.equal(APPLE_SEARCH_URL, "https://itunes.apple.com/search");
  assert.deepEqual(calls.map((c) => c.url), [
    "https://itunes.apple.com/search?entity=podcastEpisode&limit=50&term=rock%20%26%20roll",
    "https://itunes.apple.com/search?entity=podcast&limit=25&term=lex",
  ]);
});

test("the headers are the product's one User-Agent and Accept: application/json, with a signal", async () => {
  /* MUTATION: restate the User-Agent literal, or send a wildcard Accept — red. */
  const { calls, fetchImpl } = recording(new Response(JSON.stringify({ results: [] }), { status: 200 }));
  await appleSearch("podcast", "x", 1, { fetchImpl, timeoutMs: 1_000 });
  assert.deepEqual(calls[0].init.headers, { "User-Agent": DEFAULT_FEED_USER_AGENT, Accept: "application/json" });
  assert.ok(calls[0].init.signal instanceof AbortSignal, "the call is abortable");
});

test("a 2xx answer hands back Apple's results as sent; an absent `results` is an empty answer", async () => {
  /* MUTATION: return `error: "..."` for an absent `results` — the second
     assertion goes red (and the show directory would stop caching a real
     "Apple has never heard of it"). */
  const rows = [{ collectionId: 1, trackName: "a" }, { collectionId: 2 }];
  const full = await appleSearch("podcastEpisode", "x", 50, {
    fetchImpl: recording(new Response(JSON.stringify({ results: rows }), { status: 200 })).fetchImpl,
    timeoutMs: 1_000,
  });
  assert.deepEqual(full, { results: rows, error: null });
  const none = await appleSearch("podcast", "x", 50, {
    fetchImpl: recording(new Response(JSON.stringify({ resultCount: 0 }), { status: 200 })).fetchImpl,
    timeoutMs: 1_000,
  });
  assert.deepEqual(none, { results: [], error: null });
});

test("the two error strings: `Apple search HTTP <status>` and `Apple search fetch error: <message>`", async () => {
  /* MUTATION: reword either string — red (both callers surface it verbatim). */
  const http = await appleSearch("podcast", "x", 1, {
    fetchImpl: recording(new Response("nope", { status: 429 })).fetchImpl,
    timeoutMs: 1_000,
  });
  assert.deepEqual(http, { results: [], error: "Apple search HTTP 429" });
  const transport = await appleSearch("podcast", "x", 1, {
    fetchImpl: async () => { throw new Error("ECONNRESET"); },
    timeoutMs: 1_000,
  });
  assert.deepEqual(transport, { results: [], error: "Apple search fetch error: ECONNRESET" });
});

test("a body that is not an answer is a failure, never an empty success", async () => {
  /* The show directory caches an empty success for an hour, so a malformed
     200 must come back with an error. MUTATION: `body?.results` (a `null`
     body becomes an empty success) or drop the Array.isArray check — red. */
  for (const text of ["<html>", "null", JSON.stringify({ results: "nope" })]) {
    const out = await appleSearch("podcast", "x", 1, {
      fetchImpl: recording(() => new Response(text, { status: 200 })).fetchImpl,
      timeoutMs: 1_000,
    });
    assert.deepEqual(out.results, [], text);
    assert.match(out.error ?? "", /^Apple search fetch error: /, text);
  }
});

test("the caller's timeoutMs is the abort, to the millisecond, and the timer is cleared on an answer", async () => {
  /* MUTATION: hard-code the abort at 8_000 (or 2_000) inside the client — the
     500 ms abort goes red. MUTATION: drop `clearTimeout` — the pending-timer
     assertion goes red. */
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let signal;
    const pending = appleSearch("podcastEpisode", "x", 1, {
      fetchImpl: (_url, init) => {
        signal = init.signal;
        return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
      },
      timeoutMs: 500,
    });
    mock.timers.tick(499);
    assert.equal(signal.aborted, false);
    mock.timers.tick(1);
    assert.equal(signal.aborted, true);
    assert.deepEqual(await pending, { results: [], error: "Apple search fetch error: This operation was aborted" });

    let answeredSignal;
    await appleSearch("podcast", "x", 1, {
      fetchImpl: async (_url, init) => {
        answeredSignal = init.signal;
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      },
      timeoutMs: 500,
    });
    mock.timers.tick(10_000);
    assert.equal(answeredSignal.aborted, false, "an answered call's timer was cleared, so it never fires");
  } finally {
    mock.timers.reset();
  }
});

/* ---------------------------------------------------------------------- */
/* The source shape that keeps this the only client                       */
/* ---------------------------------------------------------------------- */

test("api/ spells the Apple search URL exactly once, in appleClient.ts", () => {
  /* MUTATION: put `const APPLE_SEARCH_URL = "https://itunes.apple.com/search"`
     back in api/episodes/search.ts or api/_lib/appleShowSearch.ts — red. */
  const files = sourceFiles(API);
  assert.ok(files.length > 10, "the walk found a plausible api/ tree");
  const hits = files.filter((f) => /["'`]https:\/\/itunes\.apple\.com\/search/.test(fs.readFileSync(f, "utf8")));
  assert.deepEqual(hits.map((f) => path.relative(API, f).replace(/\\/g, "/")), ["_lib/appleClient.ts"]);
});

test("api/ declares no User-Agent alias (B1-12)", () => {
  /* The aliases (`EPISODE_USER_AGENT`, `SHOW_USER_AGENT`) were the shape that
     let api/ drift to its own literal once (arch-drift-14, #316).
     MUTATION: `const SHOW_USER_AGENT = DEFAULT_FEED_USER_AGENT;` back in
     appleShowSearch.ts — red. */
  const offenders = sourceFiles(API).filter((f) => /\b[A-Z0-9_]*_USER_AGENT\s*=/.test(fs.readFileSync(f, "utf8")));
  assert.deepEqual(offenders.map((f) => path.relative(API, f)), []);
});

test("no feed read or feed fetch takes a User-Agent option (B1-12)", () => {
  /* `fetchFeedConditional`'s `userAgent` only ever received the default it
     fell back to. MUTATION: put `userAgent: opts.userAgent` back in
     feedCache.ts's fetchFeedConditional call, or `userAgent?: string` back in
     conditionalGet.ts's options — red. */
  const files = [...sourceFiles(API), ...sourceFiles(path.join(REPO, "backend", "src", "feeds"))];
  const options = files.filter((f) => /\buserAgent:/.test(fs.readFileSync(f, "utf8")));
  assert.deepEqual(options.map((f) => path.relative(REPO, f)), []);
  const conditionalGet = fs.readFileSync(path.join(REPO, "backend", "src", "feeds", "conditionalGet.ts"), "utf8");
  assert.doesNotMatch(conditionalGet, /\buserAgent\?:|opts\.userAgent/, "fetchFeedConditional declares and reads no userAgent option");
});
