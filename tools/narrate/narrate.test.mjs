/* Tests for the dry-run narration pipeline (#247).
 *
 * EVERY test here names the ONE-LINE MUTATION THAT KILLS IT. That is a house
 * rule with a specific history: a test in this repo once passed with the entire
 * mechanism it covered deleted, because the fake answered the way the real
 * thing could not. So the fakes below are built to be able to disagree with the
 * code — most importantly `capturingTransport`, which records the request the
 * adapter actually hands it, so the dry run's character count is checked
 * against a real payload rather than against another estimate.
 *
 * Nothing here reaches the network. There is no API key anywhere in this file
 * and `createAdapter` is never given one except to prove that `synthesize`
 * refuses without one.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { execFileSync } from "node:child_process";

import {
  billableText, countChars, nonAsciiChars, estimateDurationSec,
  charsForDurationSec, mp3Bytes, CHARS_PER_MIN_MEASURED,
} from "./billable.mjs";
import { cacheKey, assertKeyInputsComplete, NarrationCache, KEY_INPUTS } from "./cache.mjs";
import {
  createAdapter, buildRequest, costOf, byteCountOf, pricingBucketFor, MODEL_PRICING_BUCKET,
  FLASH_TURBO, MULTILINGUAL, DEFAULT_MODEL_ID, DEFAULT_OUTPUT_FORMAT, DEFAULT_PAD_SEC_PER_ITEM,
} from "./adapter.mjs";
import { projectForay, tierFor, SPINE } from "./projection.mjs";
import { reportScripts, reportProjection, PRICING } from "./narrate.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The CLI, driven as a real subprocess so the actual argv path runs. */
const CLI = path.join(HERE, "narrate.mjs");
/** Scratch dir for CLI fixtures. Outside the repo: a test must never write into a
    tree the repo serves, and #247's tools are dependency-free so there is no
    tmp-dir helper to reach for. */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "foray-narrate-"));

/** A transport that records exactly what it was asked to send and returns fake
    bytes. It cannot invent a payload — it only ever reports the real one.

    It AFFIRMS success (`ok: true` and a 2xx `status`) because a real wrapper must:
    `synthesize` treats a result that affirms nothing as a failure, since `fetch`
    resolves on 429/500. The first draft returned bare `{bytes}`, which made this
    fake more permissive than the contract it stands in for — the precise shape of
    "the fake answered the way the real thing could not" that this repo has been
    burned by before. Failure shapes are supplied per-test, not from here. */
function capturingTransport() {
  const sent = [];
  const fn = async (request) => {
    sent.push(request);
    return { ok: true, status: 200, bytes: 1234, asset: "fake.mp3" };
  };
  fn.sent = sent;
  return fn;
}

const spec = (text, over = {}) => ({
  text, voiceId: "v1", modelId: "m1", outputFormat: "mp3_44100_64", padSecPerItem: 1.0, ...over,
});

/* ---------- billable text: the payload definition ---------- */

test("CRLF is normalised away, so a Windows save is not a re-bill", () => {
  /* The money case. `.gitattributes` records a real CRLF incident in this repo,
     and a `\r` per line is billable and inaudible.
     MUTATION THAT KILLS THIS: delete the `.replace(/\r\n?/g, "\n")` line in
     billableText(). Then the CRLF form counts 2 more characters than the LF one
     and the two hash differently. */
  const lf = "one\ntwo\nthree";
  const crlf = "one\r\ntwo\r\nthree";
  assert.equal(billableText(crlf), lf);
  assert.equal(countChars(crlf), countChars(lf));
  assert.equal(cacheKey(spec(crlf)), cacheKey(spec(lf)), "a line-ending change must be a cache HIT");
});

test("trailing whitespace is stripped but internal pause structure is not touched", () => {
  /* Two halves, deliberately in one test because they are the same decision:
     strip what is inaudible, keep what a TTS engine reads as timing.
     MUTATION THAT KILLS THIS: add `.replace(/\n{2,}/g, "\n")` to billableText()
     (kills the second assertion), or delete the `/[ \t]+$/gm` replace (kills
     the first). */
  assert.equal(billableText("a   \nb\t\t\nc"), "a\nb\nc");
  assert.equal(billableText("para one.\n\npara two."), "para one.\n\npara two.",
    "a blank line between paragraphs is pause structure and must survive");
});

test("countChars counts spaces and punctuation, because the provider bills them", () => {
  /* pricing.json records billing as per-character including spaces. A count
     that measured words, or that trimmed internal spaces, would understate.
     MUTATION THAT KILLS THIS: make countChars return
     billableText(raw).split(/\s+/).length, or strip punctuation first. */
  assert.equal(countChars("Hi there, friend."), 17);
  assert.equal(countChars(""), 0);
  assert.equal(countChars(null), 0);
});

test("non-ascii characters are surfaced rather than silently counted", () => {
  /* The English-only ruling plus the UTF-16-vs-code-point caveat. Curly quotes
     and em-dashes land here legitimately; the point is visibility.
     MUTATION THAT KILLS THIS: make nonAsciiChars return {count: 0, samples: []}. */
  const r = nonAsciiChars("a fire — an ember");
  assert.equal(r.count, 1);
  assert.deepEqual(r.samples, ["—"]);
  assert.equal(nonAsciiChars("plain ascii").count, 0);
});

test("duration and character budgets are exact inverses of each other", () => {
  /* Script authoring needs the chars-for-duration direction and the cost model
     needs the duration-for-chars direction; if they disagree, a writer hits a
     budget the estimator then prices differently.
     MUTATION THAT KILLS THIS: change the 60 to 100 in either
     estimateDurationSec or charsForDurationSec (not both). */
  const chars = charsForDurationSec(45, 880);
  assert.equal(chars, 660);
  assert.equal(Math.round(estimateDurationSec(chars, 880)), 45);
});

test("mp3 bytes track bitrate linearly and a minute at 64 kbps is ~480 kB", () => {
  /* The hosting arithmetic depends on this being right; docs/narrator-pipeline.md
     quotes it.
     MUTATION THAT KILLS THIS: change the `/ 8` to `/ 1` in mp3Bytes (bits vs
     bytes), or drop the `* 1000`. */
  assert.equal(mp3Bytes(60, 64), 480000);
  assert.equal(mp3Bytes(60, 128), 960000);
  assert.equal(mp3Bytes(60, 128), mp3Bytes(60, 64) * 2);
  assert.equal(mp3Bytes(0, 64), 0);
});

/* ---------- the cache: the idempotence rule ---------- */

test("the cache key changes for each of the five inputs and for nothing else", () => {
  /* This IS the invalidation rule, asserted rather than described. A key that
     missed one of these would serve the OLD narrator (or stale padding) from
     cache forever — the failure that costs nothing and ships the wrong product.
     MUTATION THAT KILLS THIS: delete any one field from the loop in cacheKey()
     (e.g. drop "voiceId" or "padSecPerItem"), and its assertion below fails. */
  const base = spec("the same words");
  const key = cacheKey(base);
  assert.notEqual(key, cacheKey({ ...base, text: "the same words." }), "a script edit must invalidate");
  assert.notEqual(key, cacheKey({ ...base, voiceId: "v2" }), "a voice change must invalidate");
  assert.notEqual(key, cacheKey({ ...base, modelId: "m2" }), "a model change must invalidate");
  assert.notEqual(key, cacheKey({ ...base, outputFormat: "mp3_44100_128" }), "a format change must invalidate");
  assert.notEqual(key, cacheKey({ ...base, padSecPerItem: 0.5 }), "a padding change must invalidate");
  // And stable across calls, or nothing is ever a hit.
  assert.equal(key, cacheKey({ ...base }));
});

test("fields cannot collide by swapping values between them", () => {
  /* A naive key that concatenated values would make voice "a"/model "b"
     identical to voice "ab"/model "". The field names are in the hash to stop it.
     MUTATION THAT KILLS THIS: in cacheKey(), change
     h.update(`${field}\n${...}\n`) to h.update(String(spec[field] ?? "")). */
  assert.notEqual(
    cacheKey(spec("t", { voiceId: "a", modelId: "b" })),
    cacheKey(spec("t", { voiceId: "ab", modelId: "" })),
  );
});

test("an unknown generation parameter is a loud error, not a silently dropped key input", () => {
  /* The expensive direction: an unhashed parameter that changes the audio means
     a changed request serves a stale hit.
     MUTATION THAT KILLS THIS: make assertKeyInputsComplete a no-op (`return;`). */
  assert.throws(() => assertKeyInputsComplete({ text: "t", stability: 0.5 }), /stability/);
  assert.throws(() => cacheKey(spec("t", { speakerBoost: true })), /speakerBoost/);
  assert.doesNotThrow(() => assertKeyInputsComplete(spec("t")));
  assert.deepEqual(KEY_INPUTS, ["text", "voiceId", "modelId", "outputFormat", "padSecPerItem"]);
});

test("a re-run of an unchanged script bills zero characters", () => {
  /* #247 item 12, the whole requirement, end to end.
     MUTATION THAT KILLS THIS: in NarrationCache.plan(), return
     `billedChars: chars` unconditionally instead of `cached ? 0 : chars`. */
  const cache = new NarrationCache();
  const s = spec("a line of narration");
  const first = cache.plan(s);
  assert.equal(first.cached, false);
  assert.equal(first.billedChars, 19);

  cache.record(first.key, { chars: first.chars });

  const second = cache.plan(s);
  assert.equal(second.cached, true);
  assert.equal(second.billable, false);
  assert.equal(second.billedChars, 0, "an unchanged script must never re-bill");
  assert.equal(second.chars, 19, "but its character count is still reported");
});

test("an edited script re-bills, and only the edited one", () => {
  /* The other half: caching must not make an edit free, or a corrected script
     never gets re-voiced.
     MUTATION THAT KILLS THIS: hash a constant in cacheKey() (e.g.
     h.update("text\n") without the text) — then the edited script is a HIT. */
  const cache = new NarrationCache();
  const a = cache.plan(spec("beat one"));
  const b = cache.plan(spec("beat two"));
  cache.record(a.key, { chars: a.chars });
  cache.record(b.key, { chars: b.chars });

  assert.equal(cache.plan(spec("beat one")).billedChars, 0);
  assert.equal(cache.plan(spec("beat one, revised")).billedChars, 17, "the edit must re-bill");
  assert.equal(cache.plan(spec("beat two")).billedChars, 0, "its neighbour must not");
});

test("the dumped index round-trips and is key-sorted for a stable diff", () => {
  /* The index is meant to be committed; an unstable key order would churn the
     diff on every run and make review useless.
     MUTATION THAT KILLS THIS: drop the `.sort()` in dump().

     The keys here are deliberately PLAIN STRINGS in a known-unsorted insertion
     order, not real hashes. The first draft of this test recorded three real
     scripts and compared `Object.keys(dump())` against its own `.sort()` — which
     is tautological when dump() sorts, and happened to pass when it did NOT,
     because the sha256 hashes of those three particular scripts came out in
     ascending insertion order. Mutation testing caught it surviving. A cache key
     is opaque to dump(), so the contract can be tested with strings that make
     the ordering visible. */
  const unsorted = new NarrationCache({ entries: { ccc: { chars: 3 }, aaa: { chars: 1 }, bbb: { chars: 2 } } });
  assert.deepEqual(Object.keys(unsorted.dump().entries), ["aaa", "bbb", "ccc"]);

  // And a real entry survives a dump/restore as a cache hit.
  const cache = new NarrationCache();
  const p = cache.plan(spec("a line of narration"));
  cache.record(p.key, { chars: p.chars });
  const restored = new NarrationCache(cache.dump());
  assert.equal(restored.plan(spec("a line of narration")).billedChars, 0, "a restored index must still be a hit");
  assert.equal(restored.plan(spec("a different line")).billable, true);
});

/* ---------- the adapter: dry by construction ---------- */

test("the dry run counts the characters of the REAL request body", () => {
  /* THE ANTI-VACUITY TEST. The dry run is worthless unless it measures the
     string that would actually be submitted, so this checks the reported count
     against a payload captured from a transport rather than against a second
     estimate. The transport is only reachable with a key, so this is the one
     test that supplies a fake one — and it never leaves the process.
     MUTATION THAT KILLS THIS: in adapter.plan(), replace
     `const chars = request.body.text.length` with `countChars(beat.text) - 1`,
     or make buildRequest() send `raw` instead of `billableText(text)`. */
  const transport = capturingTransport();
  const adapter = createAdapter({ apiKey: "fake-key-never-leaves-this-process", transport, voiceId: "v1" });

  const script = "Two rooms, two microphones.\r\nOne story.   \n";
  const planned = adapter.plan({ id: "b1", text: script });

  return adapter.synthesize({ id: "b1", text: script }).then(() => {
    assert.equal(transport.sent.length, 1, "exactly one request");
    const sentText = transport.sent[0].body.text;
    assert.equal(
      sentText.length, planned.chars,
      "the dry run's character count must equal the real payload's length"
    );
    assert.equal(sentText, "Two rooms, two microphones.\nOne story.",
      "and the payload must be the canonical form, not the raw script");
  });
});

test("synthesize refuses without a key, and plan still works fully", async () => {
  /* #247's hard constraint made mechanical: no key, no spend.
     MUTATION THAT KILLS THIS: delete the `if (dryRun) throw` block in
     synthesize(). */
  const transport = capturingTransport();
  const adapter = createAdapter({ transport, voiceId: "v1" });
  assert.equal(adapter.dryRun, true);
  /* AWAITED. Unawaited, this assertion passed the test green and only surfaced
     the mutation as a file-level "asynchronous activity after the test ended" --
     and suite-integrity.test.js names this test as one of the only things
     standing between the repo and a paid API call, so it must fail as an
     assertion rather than lean on the runner's unhandled-rejection detection. */
  await assert.rejects(() => adapter.synthesize({ text: "hello" }), /no apiKey/);
  const planned = adapter.plan({ id: "b", text: "hello" });
  assert.equal(planned.chars, 5, "planning must be fully functional with no key");
  assert.equal(transport.sent.length, 0, "and nothing may be sent");
});

test("the request carries the key only when there is one, and is otherwise identical", () => {
  /* "Adding a key is the only change needed" — asserted by diffing the two
     requests. If anything else differed, the dry run would be measuring a
     different call than the real one makes.
     MUTATION THAT KILLS THIS: in buildRequest(), change the body or the url
     depending on apiKey — e.g. `text: apiKey ? billableText(text) : text`. */
  const args = { text: "a  \r\nb", voiceId: "v1", modelId: "m1", outputFormat: "f1" };
  const dry = buildRequest(args);
  const real = buildRequest({ ...args, apiKey: "k" });
  assert.equal(dry.headers["xi-api-key"], undefined);
  assert.equal(real.headers["xi-api-key"], "k");
  assert.deepEqual(dry.body, real.body, "the billable payload must not depend on having a key");
  assert.equal(dry.url, real.url);
  assert.equal(dry.body.text, "a\nb");
});

test("the request body carries exactly the fields the cache key covers", () => {
  /* THE HOLE THIS CLOSES. `assertKeyInputsComplete` guards the cache SPEC, but
     nothing stopped someone adding a field to buildRequest()'s BODY — say
     `voice_settings` or `seed` — which changes the returned audio while leaving
     the key untouched and the guard silent. Then every existing entry becomes a
     stale hit serving audio generated under different settings.

     So the body's shape is pinned. Adding a field here fails this test, which
     forces the author to decide whether it belongs in KEY_INPUTS.
     MUTATION THAT KILLS THIS: add `seed: 42` to the body in buildRequest(). */
  const body = buildRequest(spec("t")).body;
  assert.deepEqual(Object.keys(body).sort(), ["model_id", "text"]);
  /* And each of those maps to a hashed input: `text` -> "text", `model_id` ->
     "modelId". The other two hashed inputs travel in the URL, not the body.
     A distinctive voice id on purpose: the default fixture's "v1" is
     indistinguishable from the API's own `/v1` path segment, which made the
     first draft of this assertion read as if it were matching the API version. */
  const url = buildRequest(spec("t", { voiceId: "NARRATOR_X", outputFormat: "mp3_44100_64" })).url;
  assert.match(url, /\/v1\/text-to-speech\/NARRATOR_X\?/, "voiceId is in the path");
  assert.match(url, /output_format=mp3_44100_64/, "outputFormat is in the query");
});

test("a plan never carries the api key, because a plan is a reportable object", () => {
  /* The CLI prints plans and a caller may log or serialise one. A secret must
     not ride inside it. The billable unit is the BODY and the key only ever
     reaches a HEADER, so omitting it costs nothing.
     MUTATION THAT KILLS THIS: in adapter.plan(), restore
     `buildRequest({ ...specFor(text), apiKey })`. */
  const adapter = createAdapter({ apiKey: "sk-secret-value", transport: capturingTransport(), voiceId: "v1" });
  const p = adapter.plan({ id: "b", text: "some narration" });
  assert.equal(p.request.headers["xi-api-key"], undefined);
  assert.ok(!JSON.stringify(p).includes("sk-secret-value"), "no serialisation of a plan may leak the key");
});

test("a dry run never writes cache entries", () => {
  /* The most damaging bug this pipeline could have: a dry run that recorded
     entries would make the next run believe the audio exists and skip it, so
     the Foray would ship with no narration and no error.
     MUTATION THAT KILLS THIS: add `cache.record(p.key, {})` to plan(). */
  const cache = new NarrationCache();
  const adapter = createAdapter({ cache, voiceId: "v1" });
  adapter.planForay([{ id: "a", text: "one" }, { id: "b", text: "two" }]);
  assert.equal(Object.keys(cache.dump().entries).length, 0);
  assert.equal(cache.plan(spec("one", { voiceId: "v1", modelId: DEFAULT_MODEL_ID, outputFormat: DEFAULT_OUTPUT_FORMAT })).billable, true);
});

test("synthesize skips a cached script and an empty one without calling the transport", () => {
  /* Two ways to spend nothing, both worth pinning: an unchanged script and a
     beat whose script has not been written.
     MUTATION THAT KILLS THIS: delete the `if (!p.billable) return` line, or the
     `if (p.empty) return` line, in synthesize(). */
  const transport = capturingTransport();
  const cache = new NarrationCache();
  const adapter = createAdapter({ apiKey: "fake", transport, cache, voiceId: "v1" });
  return adapter.synthesize({ id: "a", text: "real script" })
    .then(() => adapter.synthesize({ id: "a", text: "real script" }))
    .then((second) => {
      assert.equal(second.skipped, "cached");
      assert.equal(transport.sent.length, 1, "the second call must not reach the transport");
      return adapter.synthesize({ id: "b", text: "" });
    })
    .then((empty) => {
      assert.equal(empty.skipped, "empty");
      assert.equal(transport.sent.length, 1, "an empty script must not reach the transport either");
    });
});

test("a Foray's totals separate what it costs from what a re-run costs", () => {
  /* The two numbers a founder needs side by side.
     MUTATION THAT KILLS THIS: in planForay(), compute billedChars as
     `planned.reduce((n, b) => n + b.chars, 0)`. */
  const cache = new NarrationCache();
  const adapter = createAdapter({ cache, voiceId: "v1" });
  const beats = [{ id: "a", text: "aaaa" }, { id: "b", text: "bbbbbb" }];
  const first = adapter.planForay(beats);
  assert.equal(first.totals.chars, 10);
  assert.equal(first.totals.billedChars, 10);

  // Pretend the first beat got voiced.
  const key = cacheKey(spec("aaaa", { voiceId: "v1", modelId: DEFAULT_MODEL_ID, outputFormat: DEFAULT_OUTPUT_FORMAT }));
  cache.record(key, { chars: 4 });

  const second = adapter.planForay(beats);
  assert.equal(second.totals.chars, 10, "the Foray still contains 10 characters of narration");
  assert.equal(second.totals.billedChars, 6, "but only the unvoiced beat is billable");
  assert.equal(second.totals.cachedBeats, 1);
});

/* ---------- cost and pricing ---------- */

test("cost is a band, because the per-character credit rate is only bounded", () => {
  /* pricing.json records that the discounted API rate is officially only
     "between 0.5 and 1 credit per character". A single number here would be a
     guess wearing a decimal point.
     MUTATION THAT KILLS THIS: make costOf return creditsLow === creditsHigh. */
  const c = costOf(1000, PRICING);
  assert.equal(c.creditsHigh, 1000, "the ceiling is 1 credit per character");
  assert.equal(c.creditsLow, 500, "the floor is the strongly-implied Flash discount");
  assert.ok(c.creditsLow < c.creditsHigh);
  assert.equal(Number(c.usd.toFixed(2)), 0.05, "$0.05 per 1K characters on Flash");
  assert.equal(c.bucket, FLASH_TURBO, "and it says which bucket it priced");
});

test("UI generations get no discount, unlike API ones", () => {
  /* The trap in pricing.json: "For UI generations, 1 character costs 1 credit"
     for EVERY model including Flash. A cost model that assumes Flash halves the
     burn in the web app is wrong.
     MUTATION THAT KILLS THIS: drop the `api &&` from the `discounted`
     expression in costOf(). */
  const ui = costOf(1000, PRICING, { api: false });
  assert.equal(ui.creditsLow, 1000);
  assert.equal(ui.creditsHigh, 1000);
});

test("the pricing snapshot records Creator at $22, not the $11 first-month promotion", () => {
  /* The scraped page in data-local reads as $11/month and the #247 sketch
     inherited that. It is a promotion. This test is the correction, pinned.
     MUTATION THAT KILLS THIS: edit pricing.json's creator price to 11. */
  const creator = PRICING.tiers.find((t) => t.id === "creator");
  assert.equal(creator.price_usd_month, 22);
  assert.match(creator.price_trap, /first-month promotion, not a standing price/);
  // And the $6-11 band the sketch aimed at contains exactly one standing tier.
  const inBand = PRICING.tiers.filter((t) => t.price_usd_month >= 5 && t.price_usd_month <= 11);
  assert.deepEqual(inBand.map((t) => t.id), ["starter"]);
});

test("the free tier is excluded from tier selection because it has no commercial licence", () => {
  /* Verified verbatim: "The free plan does not include a commercial license and
     cannot be used for any commercial purpose." So the obvious "pilot it for
     nothing" option does not exist, and tierFor must never return it.
     MUTATION THAT KILLS THIS: drop the `.filter((t) => t.commercial_license)`
     in tierFor(). Then 5,000 credits resolves to free. */
  assert.equal(PRICING.tiers.find((t) => t.id === "free").commercial_license, false);
  assert.equal(tierFor(5000, PRICING).id, "starter", "even a tiny burn must start at a paid tier");
  assert.equal(tierFor(30000, PRICING).id, "starter");
  assert.equal(tierFor(30001, PRICING).id, "creator");
  assert.equal(tierFor(99e6, PRICING), null, "and an unservable burn is null, not the biggest tier");
});

test("rollover raises capacity to 3x quota, which changes the tier answer", () => {
  /* Narration is bursty — a Foray is authored then voiced in one go — so the
     3x rollover ceiling is load-bearing for a one-time corpus build.
     MUTATION THAT KILLS THIS: make tierFor ignore opts.useRollover (always
     mult = 1). Then the two assertions below return the same tier. */
  assert.equal(tierFor(90000, PRICING).id, "creator");
  assert.equal(tierFor(90000, PRICING, { useRollover: true }).id, "starter",
    "30k x 3 covers 90k");
  assert.equal(tierFor(90000, PRICING, { useRollover: true }).capacity, 90000);
});

/* ---------- the projection ---------- */

test("the projection counts cross-episode bridges, which the #247 sketch omitted", () => {
  /* Rule X1 ("cross-episode seam always carries narration", gate yes) is a
     whole category of narration the sketch did not count.
     MUTATION THAT KILLS THIS: in projectForay(), set bridgeItems = 0 (or drop
     the `+ bridgeSec` from speechSec). Then the two projections below are equal. */
  const withBridges = projectForay({ bridgeAbsorption: 0 }, PRICING);
  const without = projectForay({ bridgeAbsorption: 1 }, PRICING);
  assert.equal(withBridges.items.bridgeItems, SPINE.crossEpisodeSeams);
  assert.equal(without.items.bridgeItems, 0);
  assert.ok(withBridges.chars > without.chars, "bridges must cost characters");
  assert.equal(withBridges.seconds.bridgeSec, SPINE.crossEpisodeSeams * 8);
});

test("regeneration multiplies characters but NOT stored bytes", () => {
  /* Only the final take is kept, so a 3x regeneration factor triples the spend
     and leaves the hosting figure alone. Conflating them would treble the
     hosting estimate and push the recommendation the wrong way.
     MUTATION THAT KILLS THIS: in projectForay(), change `bytes` to
     `mp3Bytes(audioSec, kbps) * regen`. */
  const one = projectForay({ regenFactor: 1 }, PRICING);
  const three = projectForay({ regenFactor: 3 }, PRICING);
  assert.equal(three.charsWithRegen, one.chars * 3);
  assert.equal(three.bytes, one.bytes, "storage is of the final take only");
});

test("a higher chars-per-minute rate costs MORE, not less", () => {
  /* The direction of the error in the sketch's 840. Characters are billed and
     the budget is a DURATION, so a slow rate understates the character count.
     Getting this backwards would make the sketch look conservative when it is
     optimistic.
     MUTATION THAT KILLS THIS: invert the ratio in estimateDurationSec, or in
     projectForay compute chars as `(speechSec / 60) / charsPerMin`. */
  const slow = projectForay({ charsPerMin: 840 }, PRICING);
  const fast = projectForay({ charsPerMin: 1000 }, PRICING);
  assert.ok(fast.chars > slow.chars, "the provider's own 1000 chars/min is the more expensive reading");
  assert.equal(fast.chars, Math.round(slow.chars * (1000 / 840)));
});

test("the projection carries its caveats rather than presenting itself as measured", () => {
  /* House rule: report unknowns as unknowns. The M6 undercount and the
     absorption guess must travel with the number.
     MUTATION THAT KILLS THIS: return `caveats: []` from projectForay(). */
  const p = projectForay({}, PRICING);
  assert.ok(p.caveats.length >= 3);
  assert.ok(p.caveats.some((c) => /M6/.test(c)), "the known undercount must be stated");
  assert.ok(p.caveats.some((c) => /guess/.test(c)));
  const noUndercount = projectForay({ elisionBridges: 4 }, PRICING);
  assert.ok(!noUndercount.caveats.some((c) => /M6/.test(c)), "and must drop once it is supplied");
});

test("ten fully narrated Forays at 3x regeneration cost under $50", () => {
  /* The headline finding, pinned so a later edit cannot quietly turn a rounding
     error into a real expense without a test going red. If this fails, the
     recommendation in docs/narrator-pipeline.md needs rewriting rather than
     the assertion needs relaxing.
     MUTATION THAT KILLS THIS: change BUDGETS.emptyBeatSec from 45 to 450, or
     api_dollar_per_1k_chars.flash_turbo from 0.05 to 0.5. */
  const one = projectForay({ regenFactor: 3 }, PRICING);
  const ten = costOf(one.charsWithRegen * 10, PRICING);
  assert.ok(ten.usd < 50, `ten Forays at 3x came to $${ten.usd.toFixed(2)}`);
  assert.ok(ten.usd > 5, "and it is not zero either — sanity check on the arithmetic");
});

/* ---------- the CLI's report ---------- */

test("the script report shows per-beat and per-Foray counts and flags empty scripts", () => {
  /* #247 item 11 asks for exact counts "per beat and per Foray".
     MUTATION THAT KILLS THIS: drop the per-beat loop in reportScripts(), or the
     `[EMPTY SCRIPT]` marker. */
  const r = reportScripts({
    id: "grilling-history-2",
    beats: [{ id: "beat-7", text: "Fire came first." }, { id: "beat-8", text: "" }],
  }, { voiceId: "v1", modelId: DEFAULT_MODEL_ID, outputFormat: "f1" });
  assert.match(r.text, /beat-7/);
  assert.match(r.text, /beat-8/);
  assert.match(r.text, /\[EMPTY SCRIPT\]/);
  assert.match(r.text, /DRY RUN, nothing called/);
  assert.equal(r.totals.chars, 16);
  assert.equal(r.totals.emptyBeats, 1);
});

test("the projection report names the sketch's rate and the provider's beside each other", () => {
  /* The sensitivity table is the deliverable that makes the spend decision
     informed, and it is only useful if the reader can see which row is the
     assumption under test.
     MUTATION THAT KILLS THIS: delete the `<- the #247 sketch` annotation, or
     drop 840 from the rates array in reportProjection(). */
  const r = reportProjection({ forays: 10, regenFactor: 3 });
  assert.match(r.text, /840.*<- the #247 sketch/);
  assert.match(r.text, /1000.*provider's own implied rate/);
  assert.match(r.text, /CAVEATS/);
  /* The rates must be listed in ascending order, or the table misleads. Scoped
     to the SENSITIVITY block: the BITRATE table below it also starts rows with a
     3-digit number, and matching both is how the first draft of this assertion
     failed on a correctly-sorted table. */
  const block = r.text.split("SENSITIVITY")[1].split("BITRATE")[0];
  const rows = [...block.matchAll(/^(\d{3,4}) +[\d,]+/gm)].map((m) => Number(m[1]));
  assert.deepEqual(rows, [760, 840, 880, 940, 1000], "sensitivity rows must ascend and cover the band");
});

test("pricing.json is internally consistent and dated", () => {
  /* It supersedes an undated scrape, so its own date and provenance are the
     thing that makes it trustworthy later.
     MUTATION THAT KILLS THIS: delete `verified_at` from pricing.json, or set a
     tier's credits_per_month to a string. */
  assert.match(PRICING.verified_at, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(PRICING.supersedes.why, /NO DATE/);
  for (const t of PRICING.tiers) {
    assert.equal(typeof t.price_usd_month, "number", `${t.id} price`);
    assert.equal(typeof t.credits_per_month, "number", `${t.id} credits`);
    assert.equal(typeof t.commercial_license, "boolean", `${t.id} licence`);
  }
  // Ascending price must mean ascending credits, or tierFor's first-match is wrong.
  const paid = PRICING.tiers.filter((t) => t.commercial_license).sort((a, b) => a.price_usd_month - b.price_usd_month);
  for (let i = 1; i < paid.length; i++) {
    assert.ok(paid[i].credits_per_month > paid[i - 1].credits_per_month,
      `${paid[i].id} must include more credits than ${paid[i - 1].id}`);
  }
});

test("no API key, endpoint call or network reach exists anywhere in tools/narrate", () => {
  /* #247's hard constraint, enforced against the source rather than trusted.
     The adapter must never default `transport` to a global fetch, because that
     turns a missing argument into a live paid call.
     MUTATION THAT KILLS THIS: add `transport = fetch` as the default in
     createAdapter(), or paste a real `sk_...` key into any file here. */
  for (const f of fs.readdirSync(HERE).filter((f) => /\.mjs$/.test(f))) {
    const src = fs.readFileSync(path.join(HERE, f), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.ok(!/\bfetch\s*\(/.test(code), `${f} must not call fetch`);
    assert.ok(!/transport\s*=\s*fetch/.test(code), `${f} must not default transport to fetch`);
    assert.ok(!/\bsk_[a-zA-Z0-9]{8}/.test(src), `${f} must not contain an API key`);
    /* ANY env read, not just an ELEVEN/XI_ prefix: the narrow regex would have
       missed `process.env.TTS_API_KEY`. Nothing here has a legitimate reason to
       consult the environment at all, so the whole surface is banned. */
    assert.ok(!/process\.env/.test(code), `${f} must not read anything from the environment`);
  }
});

/* ---------- the seven findings from the review of PR #253 ---------- */

test("a transport that reports HTTP failure records NOTHING, so a retry re-bills", async () => {
  /* THE WORST BUG THIS MODULE COULD HAVE, and it was live. `transport` is
     `fetch` in production and **fetch RESOLVES on 429 and 500** — it rejects only
     on a network-level failure. So `await transport(...)` followed by
     `cache.record(...)` wrote a cache entry for a generation that never happened,
     and every later run read it as "already voiced" and skipped the beat: a Foray
     shipping with a silent gap and no error anywhere.

     Paying twice is recoverable. A permanently skipped beat is not.
     MUTATION THAT KILLS THIS: in synthesize(), delete the whole
     `if (okContradicts || statusContradicts || ...)` early return. */
  for (const bad of [
    { ok: false, status: 429 },
    { ok: false, status: 500 },
    { ok: true, status: 503 },
    { ok: true, status: 200 },            // 2xx but no bytes: nothing was produced
    { ok: true, status: 200, bytes: 0 },
  ]) {
    const cache = new NarrationCache();
    const adapter = createAdapter({ apiKey: "fake", transport: async () => bad, cache, voiceId: "v1" });
    const r = await adapter.synthesize({ id: "b", text: "a line of narration" });
    assert.ok(r.failed, `${JSON.stringify(bad)} must report failure`);
    assert.equal(r.bytes, null);
    assert.equal(Object.keys(cache.dump().entries).length, 0,
      `${JSON.stringify(bad)} must not be cached`);
    // And the retry is still billable, which is the property that matters.
    assert.equal(adapter.plan({ id: "b", text: "a line of narration" }).billable, true);
  }
});

test("a transport that returns real bytes IS recorded", async () => {
  /* The other half — the failure guard must not reject success.
     MUTATION THAT KILLS THIS: make the guard `if (true) return {...}`, or require
     `result.ok === true` (the fixture below omits `ok` on purpose, since a
     transport reporting only a 2xx status is legitimate). */
  const cache = new NarrationCache();
  const adapter = createAdapter({
    apiKey: "fake", cache, voiceId: "v1",
    transport: async () => ({ status: 200, bytes: 4096, asset: "beat-7.mp3" }),
  });
  const r = await adapter.synthesize({ id: "b", text: "a line of narration" });
  assert.equal(r.failed, undefined);
  assert.equal(r.bytes, 4096);
  assert.equal(r.asset, "beat-7.mp3");
  assert.equal(Object.keys(cache.dump().entries).length, 1);
});

test("costOf refuses an unknown model instead of pricing it at zero", () => {
  /* Two namespaces meet in costOf: provider model ids (`eleven_flash_v2_5`) and
     pricing buckets (`flash_turbo`). pricing.json is keyed by the latter, so the
     natural call — costOf(chars, PRICING, { model: DEFAULT_MODEL_ID }) — found no
     rate and silently answered $0.00. A cost tool that says "free" when it does
     not recognise the model is worse than one that refuses.
     MUTATION THAT KILLS THIS: replace the `if (!bucket) throw` with
     `bucket = bucket ?? FLASH_TURBO`. */
  assert.throws(() => costOf(1000, PRICING, { model: "eleven_wrong_v9" }), /unknown model/);
  assert.throws(() => costOf(1000, PRICING, { model: "" }), /unknown model/);
  // A provider id and its bucket must price identically.
  assert.equal(costOf(1000, PRICING, { model: DEFAULT_MODEL_ID }).usd,
               costOf(1000, PRICING, { model: FLASH_TURBO }).usd);
  assert.ok(costOf(1000, PRICING, { model: DEFAULT_MODEL_ID }).usd > 0,
    "the default model must have a real price, not zero");
});

test("the multilingual bucket costs twice the flash bucket, and gets no credit discount", () => {
  /* pricing.json: $0.10/1K vs $0.05/1K, and the 0.5-credit floor is Flash-only.
     MUTATION THAT KILLS THIS: make `discounted` ignore the bucket
     (`const discounted = api;`). */
  const flash = costOf(100000, PRICING, { model: FLASH_TURBO });
  const multi = costOf(100000, PRICING, { model: MULTILINGUAL });
  assert.equal(multi.usd, flash.usd * 2);
  assert.equal(flash.creditsLow, 50000, "Flash gets the implied 0.5 floor");
  assert.equal(multi.creditsLow, 100000, "multilingual does not");
  assert.equal(multi.creditsHigh, 100000);
});

test("costOf reports no dollar figure for a UI generation, rather than the API one", () => {
  /* pricing.json records UI billing as a flat 1 credit/character and the
     per-1,000-credit dollar rate as NOT PUBLISHED, so there is no honest dollar
     number for api:false — and returning the API rate understated a UI
     generation on the discounted models by 2x.
     MUTATION THAT KILLS THIS: drop the `api &&` from the `usd` expression. */
  const ui = costOf(1000, PRICING, { api: false });
  assert.equal(ui.usd, null, "no published rate means no number");
  assert.equal(ui.creditsLow, 1000);
  assert.equal(ui.creditsHigh, 1000);
  assert.ok(typeof costOf(1000, PRICING, { api: true }).usd === "number");
});

test("every model id the adapter can send maps to a pricing bucket", () => {
  /* The seam between the two namespaces, closed in both directions: the adapter's
     own default must be priceable, and nothing in the map may point at a bucket
     pricing.json does not quote.
     MUTATION THAT KILLS THIS: change DEFAULT_MODEL_ID to a model absent from
     MODEL_PRICING_BUCKET, or add a bucket name pricing.json lacks. */
  assert.ok(pricingBucketFor(DEFAULT_MODEL_ID), "the default model must be priceable");
  for (const [id, bucket] of Object.entries(MODEL_PRICING_BUCKET)) {
    assert.ok([FLASH_TURBO, MULTILINGUAL].includes(bucket), `${id} -> unknown bucket ${bucket}`);
    assert.equal(typeof PRICING.api_dollar_per_1k_chars[bucket], "number",
      `pricing.json quotes no rate for ${bucket}`);
  }
});

test("the CLI prices the model it was actually given", () => {
  /* The tool's whole purpose is preventing a surprise bill, and it used to call
     costOf with no opts — so it printed `--model eleven_multilingual_v2` directly
     above a cost computed at half that model's real rate.
     MUTATION THAT KILLS THIS: in reportScripts(), drop the `{ model: modelId }`
     argument from the costOf call. */
  const beats = [{ id: "b1", text: "x".repeat(100000) }];
  const flash = reportScripts({ id: "f", beats }, { voiceId: "v1", modelId: "eleven_flash_v2_5", outputFormat: "f" });
  const multi = reportScripts({ id: "f", beats }, { voiceId: "v1", modelId: "eleven_multilingual_v2", outputFormat: "f" });
  assert.match(flash.text, /~\$5\.00/);
  assert.match(multi.text, /~\$10\.00/);
  assert.match(flash.text, /50,000-100,000 credits/);
  assert.match(multi.text, /100,000-100,000 credits/);
});

test("the rollover tier line appears when no single-month tier suffices", () => {
  /* That is exactly when rollover is the deciding factor, and the old guard
     (`tr && t && ...`) suppressed it there because `t` is null in that case.
     MUTATION THAT KILLS THIS: restore `if (tr && t && tr.id !== t.id)`. */
  const r = reportProjection({ forays: 120, regenFactor: 3 });
  assert.match(r.text, /cheapest sufficient tier in ONE month: none/);
  assert.match(r.text, /with rollover \(3x quota\): +business/);
});

test("the cache key cannot be forged by embedding a field name in the text", () => {
  /* The old encoding joined field names to values with newlines, so a value
     containing a newline could impersonate a field boundary — and script text is
     multi-line by nature. Length-prefixing makes the encoding injective.
     MUTATION THAT KILLS THIS: in cacheKey(), change the field() body back to
     joining name and value with newlines. */
  const a = cacheKey({ text: "foo\nvoiceId\nbar", voiceId: "V", modelId: "m", outputFormat: "f" });
  const b = cacheKey({ text: "foo", voiceId: "bar\nvoiceId\nV", modelId: "m", outputFormat: "f" });
  assert.notEqual(a, b);
  // The same trick across the other boundary.
  assert.notEqual(
    cacheKey({ text: "t", voiceId: "a\nmodelId\nb", modelId: "c", outputFormat: "f" }),
    cacheKey({ text: "t", voiceId: "a", modelId: "b\nmodelId\nc", outputFormat: "f" }),
  );
});

test("cache.plan is a pure query and keeps no hit counters", () => {
  /* It used to keep hits/misses, and they were wrong: synthesize() re-runs
     plan() internally, so one beat and one generation counted as two misses. A
     cache-effectiveness number that double-counts is worse than none, and
     planForay().totals.cachedBeats already reports it correctly.
     MUTATION THAT KILLS THIS: reintroduce `this.hits`/`this.misses` and a
     stats() method on NarrationCache. */
  const cache = new NarrationCache();
  assert.equal(typeof cache.stats, "undefined", "no misleading stats() surface");
  assert.equal(cache.hits, undefined);
  const s = { text: "one", voiceId: "v", modelId: "m", outputFormat: "f" };
  assert.deepEqual(cache.plan(s), cache.plan(s), "repeated planning must be identical");

  // The honest number, from a single pass.
  const adapter = createAdapter({ cache, voiceId: "v1" });
  const beats = [{ id: "a", text: "aaa" }, { id: "b", text: "bbb" }];
  const key = cacheKey({
    text: "aaa", voiceId: "v1", modelId: DEFAULT_MODEL_ID, outputFormat: DEFAULT_OUTPUT_FORMAT,
    padSecPerItem: DEFAULT_PAD_SEC_PER_ITEM,
  });
  cache.record(key, { chars: 3 });
  assert.equal(adapter.planForay(beats).totals.cachedBeats, 1);
  assert.equal(adapter.planForay(beats).totals.cachedBeats, 1, "and it must not drift on a second pass");
});

/* ---------- second review round: the guard that only looked positive ---------- */

test("a transport that affirms nothing is a failure, not a success", async () => {
  /* THE FIRST FIX WAS NOT ACTUALLY POSITIVE. It accepted any result whose `ok`
     was not literally `false` and whose `status` was absent or 2xx — so the most
     natural wrapper anyone would write,

         const r = await fetch(...); const b = await r.arrayBuffer();
         return { bytes: b.byteLength };

     which forgets to forward `ok`/`status`, sailed straight through and cached a
     429's JSON error body as voiced audio. The original HIGH bug, undiminished,
     behind a guard that read as though it closed it.
     MUTATION THAT KILLS THIS: drop the `!(okAffirms || statusAffirms)` term from
     the failure condition in synthesize(). */
  for (const affirmsNothing of [
    { bytes: 41234 },                       // the realistic forgetful wrapper
    { bytes: 41234, asset: "a.mp3" },
    { ok: 0, status: 200, bytes: 5 },       // falsy-but-not-false ok
    { ok: null, status: 200, bytes: 5 },
    { ok: "yes", status: 200, bytes: 5 },   // truthy but not `true`
  ]) {
    const cache = new NarrationCache();
    const adapter = createAdapter({ apiKey: "fake", transport: async () => affirmsNothing, cache, voiceId: "v1" });
    const r = await adapter.synthesize({ id: "b", text: "a line of narration" });
    assert.ok(r.failed, `${JSON.stringify(affirmsNothing)} must not count as success`);
    assert.equal(Object.keys(cache.dump().entries).length, 0,
      `${JSON.stringify(affirmsNothing)} must not be cached`);
  }
});

test("either affirmative signal alone is enough", async () => {
  /* The guard must not become so strict that it rejects real successes — that
     direction re-bills every run forever. `ok: true` OR a numeric 2xx suffices.
     MUTATION THAT KILLS THIS: require both (`okAffirms && statusAffirms`). */
  for (const good of [
    { ok: true, bytes: 2048 },
    { status: 200, bytes: 2048 },
    { status: 201, bytes: 2048 },
    { ok: true, status: 200, bytes: 2048 },
  ]) {
    const cache = new NarrationCache();
    const adapter = createAdapter({ apiKey: "fake", transport: async () => good, cache, voiceId: "v1" });
    const r = await adapter.synthesize({ id: "b", text: "a line of narration" });
    assert.equal(r.failed, undefined, `${JSON.stringify(good)} must count as success`);
    assert.equal(Object.keys(cache.dump().entries).length, 1);
  }
});

test("audio bytes are counted whatever container the transport used", () => {
  /* Requiring a `number` looked strict and was a correctness bug in the dangerous
     direction: a Buffer of real audio counted as "no bytes", so a genuine success
     was recorded as a failure and the beat RE-BILLED ON EVERY RUN, FOREVER.
     MUTATION THAT KILLS THIS: make byteCountOf return
     `typeof b === "number" && b > 0 ? b : null`. */
  assert.equal(byteCountOf(4096), 4096);
  assert.equal(byteCountOf(Buffer.from(new Uint8Array(999))), 999);
  assert.equal(byteCountOf(new Uint8Array(700)), 700);
  assert.equal(byteCountOf(new ArrayBuffer(512)), 512);
  // And the genuinely empty cases stay null, or a 204 would look like audio.
  for (const empty of [0, -1, null, undefined, NaN, new ArrayBuffer(0), Buffer.alloc(0), {}]) {
    assert.equal(byteCountOf(empty), null, `${String(empty)} is not audio`);
  }
});

test("a Buffer-carrying transport is recorded, end to end", async () => {
  /* The bug above, at the level it actually bit.
     MUTATION THAT KILLS THIS: same as byteCountOf above. */
  const cache = new NarrationCache();
  const adapter = createAdapter({
    apiKey: "fake", cache, voiceId: "v1",
    transport: async () => ({ ok: true, status: 200, bytes: Buffer.from(new Uint8Array(8192)) }),
  });
  const r = await adapter.synthesize({ id: "b", text: "a line of narration" });
  assert.equal(r.failed, undefined);
  assert.equal(r.bytes, 8192, "the byte count must be reported, not the container");
  assert.equal(Object.keys(cache.dump().entries).length, 1);
  // The retry is now free, which is the point of recording it at all.
  assert.equal(adapter.plan({ id: "b", text: "a line of narration" }).billable, false);
});

test("an unknown model costs the cost line, not the whole report", () => {
  /* costOf rightly refuses to price a model it does not recognise, but the
     per-beat character table is model-independent and is the tool's primary
     output. Throwing from the reporting path printed a stack trace and zero bytes
     of report for a typo in `--model` — and real provider ids absent from the map
     (`eleven_monolingual_v1`) hit it too.
     MUTATION THAT KILLS THIS: remove the try/catch in reportScripts() so costOf's
     throw propagates. */
  const r = reportScripts(
    { id: "f", beats: [{ id: "b1", text: "Fire came first." }] },
    { voiceId: "v1", modelId: "eleven_monolingual_v1", outputFormat: "f" },
  );
  assert.match(r.text, /b1/, "the per-beat table must survive");
  assert.match(r.text, /16 characters/, "and so must the counts");
  assert.match(r.text, /COST UNAVAILABLE: .*unknown model/);
  assert.equal(r.totals.chars, 16);
});

/* ---------- third review round: boundaries and duck-typing ---------- */

test("the 2xx window has both edges pinned, so a 3xx cannot be cached as success", async () => {
  /* THIS TEST EXISTS BECAUSE A MUTATION SURVIVED. Changing `status < 300` to
     `status < 400` passed the entire suite: the code was right and the assertion
     was missing, so a redirect — which carries no audio — could have become a
     cached "generation" with nothing to catch it.
     MUTATION THAT KILLS THIS: change `status < 300` to `status < 400`, or
     `status >= 200` to `status >= 100`, in synthesize(). */
  const probe = async (status) => {
    const cache = new NarrationCache();
    const adapter = createAdapter({
      apiKey: "fake", cache, voiceId: "v1",
      transport: async () => ({ status, bytes: 2048 }),
    });
    const r = await adapter.synthesize({ id: "b", text: "a line of narration" });
    return { ok: !r.failed, cached: Object.keys(cache.dump().entries).length };
  };
  for (const s of [200, 201, 299]) {
    assert.deepEqual(await probe(s), { ok: true, cached: 1 }, `${s} is a success`);
  }
  for (const s of [100, 199, 300, 301, 302, 400, 429, 500]) {
    assert.deepEqual(await probe(s), { ok: false, cached: 0 }, `${s} must NOT be cached`);
  }
});

test("a present but unreadable status contradicts rather than being ignored", async () => {
  /* Treating a non-numeric status as absent let `{ ok: true, status: "404" }`
     through as a success — a genuine failure cached, which is the HIGH class.
     MUTATION THAT KILLS THIS: drop `statusUnparseable` from the
     `statusContradicts` expression. */
  for (const status of ["404", "200", {}, [], true, NaN]) {
    const cache = new NarrationCache();
    const adapter = createAdapter({
      apiKey: "fake", cache, voiceId: "v1",
      transport: async () => ({ ok: true, status, bytes: 2048 }),
    });
    const r = await adapter.synthesize({ id: "b", text: "a line of narration" });
    assert.ok(r.failed, `status ${JSON.stringify(status)} is unreadable and must not pass`);
    assert.equal(Object.keys(cache.dump().entries).length, 0);
  }
});

test("byteCountOf reads byteLength and size, and refuses bare length", () => {
  /* `.length` duck-types far too widely for a module whose job is distrusting
     what a transport returns: it would answer 4 for the string "1234", the
     character count for a forwarded JSON error body, and 5 for the natural-looking
     `bytes: r.headers.get("content-length")`.
     MUTATION THAT KILLS THIS: restore `?? b?.length` in byteCountOf. */
  assert.equal(byteCountOf(new Blob(["abcdefghij"])), 10, "Blob carries size, not byteLength");
  assert.equal(byteCountOf(new DataView(new ArrayBuffer(64))), 64);
  assert.equal(byteCountOf(new Float32Array(8)), 32, "byteLength, not element count");
  // The duck-typing hazards, all refused.
  assert.equal(byteCountOf("1234"), null, "a string is not audio");
  assert.equal(byteCountOf('{"detail":"quota_exceeded"}'), null, "an error body is not audio");
  assert.equal(byteCountOf("41234"), null, "a content-length header value is not audio");
  assert.equal(byteCountOf([1, 2, 3]), null, "an array is not audio");
  assert.equal(byteCountOf({ length: 5 }), null, "a bare length is not audio");
});

test("a Blob-carrying transport is recorded, end to end", async () => {
  /* `await r.blob()` is one of the four natural ways to read a fetch body, and
     the previous draft rejected it — a genuine success recorded as a failure,
     re-billing every run forever.
     MUTATION THAT KILLS THIS: drop `?? b?.size` from byteCountOf. */
  const cache = new NarrationCache();
  const adapter = createAdapter({
    apiKey: "fake", cache, voiceId: "v1",
    transport: async () => ({ ok: true, status: 200, bytes: new Blob(["x".repeat(4096)]) }),
  });
  const r = await adapter.synthesize({ id: "b", text: "a line of narration" });
  assert.equal(r.failed, undefined);
  assert.equal(r.bytes, 4096);
  assert.equal(Object.keys(cache.dump().entries).length, 1);
});

test("a transport that throws records nothing and propagates", async () => {
  /* The network-level failure case, as opposed to the resolved-but-failed one.
     MUTATION THAT KILLS THIS: wrap the `await transport(keyed)` call in a
     try/catch that falls through to cache.record(). */
  const cache = new NarrationCache();
  const adapter = createAdapter({
    apiKey: "fake", cache, voiceId: "v1",
    transport: async () => { throw new Error("ECONNRESET"); },
  });
  await assert.rejects(() => adapter.synthesize({ id: "b", text: "a line" }), /ECONNRESET/);
  assert.equal(Object.keys(cache.dump().entries).length, 0);
});

test("the pipeline doc does not describe a transport contract the code rejects", () => {
  /* A doc-vs-code divergence here is expensive in a specific way: someone writes
     the transport from the doc, the adapter rejects every result, and the beat
     re-bills forever with no clue why. The doc described the REVERTED rule for one
     commit, so this pins the two claims that matter.
     MUTATION THAT KILLS THIS: reinstate "a non-false `ok`" in the doc, or drop the
     "wraps" so it reads "`transport` is `fetch` in production". */
  const doc = fs.readFileSync(path.join(HERE, "..", "..", "docs", "narrator-pipeline.md"), "utf8");
  /* Case-INSENSITIVE: the first draft of this assertion used /a non-false `ok`/
     and a mutation inserting "A non-false `ok` suffices." survived it. */
  assert.ok(!/non-false `ok`/i.test(doc),
    "the doc must not describe the reverted absence-of-denial rule");
  assert.ok(!/`transport` is `fetch` in production/i.test(doc),
    "the doc must not say transport IS fetch — a bare Response is rejected");
  assert.match(doc, /affirms?/i, "it must describe the positive rule");
});

/* ---------- fourth round: the test gaps mutation testing exposed ---------- */

test("the cache key resists a forged FIELD DELIMITER, not just a forged newline", () => {
  /* A REVIEWER'S MUTATION SURVIVED THE SUITE HERE. The shipped length prefix is
     correct, but the only forgery this suite tried was a newline one — which
     collides under NEITHER encoding, so the test was toothless about the very
     property it was named for. The real vector is the delimiter actually in use,
     a colon:

       text "A" + "voiceId:" + "B",  voice "C"
       text "A",                     voice "B" + "voiceId:" + "C"

     Those two share a digest under `${name}:${v}` and differ under
     `${name}:${byteLength}:${v}`.
     MUTATION THAT KILLS THIS: drop the length from the prefix in cacheKey(),
     leaving `h.update(`${name}:${v}`)`. */
  const a = cacheKey({ text: "AvoiceId:B", voiceId: "C", modelId: "m", outputFormat: "f" });
  const b = cacheKey({ text: "A", voiceId: "BvoiceId:C", modelId: "m", outputFormat: "f" });
  assert.notEqual(a, b, "a colon-delimited forgery must not collide");

  // And the same across the modelId boundary, with a numeric-looking prefix.
  assert.notEqual(
    cacheKey({ text: "x", voiceId: "1:modelId:2", modelId: "3", outputFormat: "f" }),
    cacheKey({ text: "x", voiceId: "1", modelId: "2:modelId:3", outputFormat: "f" }),
  );
});

test("byteCountOf reads size ONLY off a real Blob", () => {
  /* `.size` duck-types onto Set, Map and URLSearchParams — the same objection this
     function already makes to `.length`, and a reviewer's mutation exposed that the
     accept side was pinned while the reject side was not.
     MUTATION THAT KILLS THIS: replace the `b instanceof Blob` test with a bare
     `b?.size`. */
  assert.equal(byteCountOf(new Blob(["abcdefghij"])), 10, "a Blob still counts");
  assert.equal(byteCountOf(new Set([1, 2])), null, "a Set is not audio");
  assert.equal(byteCountOf(new Map([["a", 1]])), null, "a Map is not audio");
  assert.equal(byteCountOf(new URLSearchParams("a=1&b=2")), null, "a query string is not audio");
  assert.equal(byteCountOf({ size: 5 }), null, "a bare size is not audio");
});

test("byteCountOf rejects a non-finite count", () => {
  /* Another surviving mutation: only ±Infinity slipped through, but a byte count
     that is not a finite number is not a byte count.
     MUTATION THAT KILLS THIS: drop `Number.isFinite(b)` from the number branch of
     byteCountOf. */
  assert.equal(byteCountOf(Infinity), null);
  assert.equal(byteCountOf(-Infinity), null);
  assert.equal(byteCountOf({ byteLength: Infinity }), null);
});

test("a transport whose ok flip-flops between reads cannot be cached as a success", async () => {
  /* `result.ok` used to be read three times, so a non-idempotent getter returning
     true, false, true was recorded as a success — the severe direction. It is now
     read once, so a single authoritative value decides.
     MUTATION THAT KILLS THIS: in synthesize(), inline `result?.ok` into both
     okAffirms and okContradicts instead of reading rawOk once. */
  let reads = 0;
  const cache = new NarrationCache();
  const adapter = createAdapter({
    apiKey: "fake", cache, voiceId: "v1",
    // false on the first read, true afterwards: under repeated reads okContradicts
    // saw false-ish and okAffirms saw true, and the result was cached.
    transport: async () => ({ get ok() { reads++; return reads !== 1; }, status: 200, bytes: 1024 }),
  });
  const r = await adapter.synthesize({ id: "b", text: "a line of narration" });
  assert.equal(reads, 1, "`ok` must be consulted exactly once");
  assert.ok(r.failed, "the single authoritative read said false, so this is a failure");
  assert.equal(Object.keys(cache.dump().entries).length, 0);
});

test("the CLI's argument walk survives a flag value that repeats an earlier token", () => {
  /* `main()` was entirely untested, and commit 1 of this branch claimed to fix its
     argv walk without shipping a test — exactly the gap this repo's suite-integrity
     floor exists to prevent. Driven as a real subprocess so the actual argv path
     runs, not a re-implementation of it.
     MUTATION THAT KILLS THIS: in main(), find the scripts file with
     `args.find((a) => !a.startsWith("--"))` (then `--voice`'s VALUE can be taken
     as the file), or drop the `i++` that skips a flag's value. */
  const scripts = path.join(TMP, "argv-walk.json");
  fs.writeFileSync(scripts, JSON.stringify({
    id: "argv", beats: [{ id: "beat-1", text: "Fire came first." }],
  }));
  /* THE FILE COMES AFTER THE FLAGS, which is the whole point and which the first
     draft of this test got wrong: with the file FIRST, any implementation finds it
     and both argv mutations survived. A flag's VALUE precedes it here, so a walk
     that does not skip flag values picks up "narrator" as the filename. */
  const out = execFileSync(process.execPath, [
    CLI, "--voice", "narrator", "--format", "narrator", scripts,
  ], { encoding: "utf8" });
  assert.match(out, /beat-1/, "the scripts file must be found after the flags");
  assert.match(out, /16 characters/);
  assert.match(out, /Voice narrator/);

  // And the file-first ordering must keep working.
  const first = execFileSync(process.execPath, [CLI, scripts, "--voice", "narrator"], { encoding: "utf8" });
  assert.match(first, /beat-1/);
});

test("the CLI honours --cache, so a re-run of an unchanged script bills nothing", () => {
  /* The idempotence promise, end to end through the real CLI. A mutation making
     `flag()` ignore its argument left --cache silently unused and every re-run
     billing in full, with the report looking entirely normal.
     MUTATION THAT KILLS THIS: in main(), pass `cacheIndex: null` unconditionally,
     or make flag() return its default always. */
  const scripts = path.join(TMP, "cache-cli.json");
  const text = "Fire came first, and everything else followed it.";
  fs.writeFileSync(scripts, JSON.stringify({ id: "c", beats: [{ id: "b1", text }] }));

  const voice = "NARRATOR_X";
  const cold = execFileSync(process.execPath, [CLI, scripts, "--voice", voice], { encoding: "utf8" });
  assert.match(cold, /BILLABLE this run: 49 characters/);
  assert.match(cold, /miss/);

  // An index recording that exact generation.
  const cache = new NarrationCache();
  const key = cacheKey({
    text, voiceId: voice, modelId: DEFAULT_MODEL_ID, outputFormat: DEFAULT_OUTPUT_FORMAT,
    padSecPerItem: DEFAULT_PAD_SEC_PER_ITEM,
  });
  cache.record(key, { chars: 49 });
  const idx = path.join(TMP, "cache-cli-index.json");
  fs.writeFileSync(idx, JSON.stringify(cache.dump()));

  const warm = execFileSync(process.execPath, [CLI, scripts, "--voice", voice, "--cache", idx], { encoding: "utf8" });
  assert.match(warm, /BILLABLE this run: 0 characters/, "an unchanged script must re-bill nothing");
  assert.match(warm, /HIT/);
  // A different voice invalidates, so the same index must bill in full again.
  const other = execFileSync(process.execPath, [CLI, scripts, "--voice", "OTHER", "--cache", idx], { encoding: "utf8" });
  assert.match(other, /BILLABLE this run: 49 characters/, "a voice change must re-bill");
});
