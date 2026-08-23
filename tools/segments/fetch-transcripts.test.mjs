/* Tests for the free-transcript fetcher (epic #102, ADR-0004 step 1).
   Run: node --test tools/segments/

   Nothing here touches the network: `fetchBody` takes a `fetchImpl`, so the
   suite drives real code paths against a fake transport and stays deterministic.

   Two of these tests guard boundaries rather than behaviour. The audio
   interlock exists because #108 is a `[gate]` — a transcript tool that grew an
   audio path would bypass a founder decision silently — and the path-escape
   test exists because feed guids are third-party strings that get turned into
   filesystem paths.

   Each test names the one-line mutation that makes it fail, and each was run
   against that mutation before being committed (CLAUDE.md § "A green test is
   not evidence until you have broken it"). */

import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join, sep } from "node:path";
import {
  AD_FREE_SHOWS,
  FetchError,
  MAX_BODY_BYTES,
  assertNotAudio,
  numericArg,
  MAX_SPAN_RATIO,
  spanImplausible,
  assertTranscriptTarget,
  digestOf,
  fetchBody,
  isAnchorableShow,
  safeKey,
  selectTargets,
  transcriptPath,
} from "./fetch-transcripts.mjs";

const show = (over) => ({
  show_id: "s",
  title: "A Show",
  dai_suspected: false,
  episodes_with_timed_transcript: 2,
  episodes: [
    { guid: "g1", title: "One", transcript_url: "https://t/1.vtt", transcript_type: "text/vtt", has_timestamps: true, enclosure_url: "https://cdn/1.mp3", duration_sec: 100 },
    { guid: "g2", title: "Two", transcript_url: "https://t/2.txt", transcript_type: "text/plain", has_timestamps: false, enclosure_url: "https://cdn/2.mp3", duration_sec: 200 },
  ],
  ...over,
});

const res = (over) => ({
  ok: true,
  status: 200,
  statusText: "OK",
  headers: new Map([["content-type", "text/vtt"]]),
  text: async () => "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nhello\n",
  ...over,
});
// node:test has no Headers shim concern here; Map.get matches the .get() use.

/* MUTATION: in `assertTranscriptTarget`, delete the `target.transcript_url ===
   target.enclosure_url` branch. The tool becomes willing to request an audio
   enclosure, which is the gate at #108 being opened by a tool that has no
   authority to open it. Verified failing. */
test("the fetcher refuses to request an episode's audio", () => {
  assert.throws(
    () => assertTranscriptTarget({ guid: "g", transcript_url: "https://cdn/1.mp3", enclosure_url: "https://cdn/1.mp3" }),
    (e) => e instanceof FetchError && e.code === "AUDIO_TARGET",
  );
  assert.equal(
    assertTranscriptTarget({ guid: "g", transcript_url: "https://t/1.vtt", enclosure_url: "https://cdn/1.mp3" }),
    "https://t/1.vtt",
  );
});

/* MUTATION: in `safeKey`, widen the character class to `/[^a-z0-9./]+/g` so
   dots and slashes survive slugging. `../../../etc/passwd` then stays intact,
   the resolved path leaves the base directory, and a publisher's feed gets to
   choose where this repo writes files. Verified failing.

   Note which defence this pins. `safeKey` is the one that fires: it slugs
   traversal away before a path is ever built, so `transcriptPath`'s escape
   check is belt-and-braces that cannot currently be reached through the
   public signature — mutating THAT check away leaves this suite green, which
   is how the first version of this test came to prove nothing. The check
   stays because it costs nothing and would catch a future caller that builds
   a path from something safeKey never touched; the test targets the guard
   that is actually load-bearing. */
test("a hostile guid is sanitised before it can become a path", () => {
  assert.ok(!safeKey("../../../etc/passwd").includes("."), "traversal must not survive slugging");
  assert.ok(!safeKey("a/b/c").includes("/"), "separators must not survive slugging");
  const base = mkdtempSync(join(tmpdir(), "fx-"));
  const p = transcriptPath(base, "raw", "s", "../../../etc/passwd", "vtt");
  assert.ok(p.startsWith(base + sep), `${p} escaped ${base}`);
  assert.ok(!p.includes(".."));
  // Distinct guids never collide onto one file, even after slug truncation.
  const a = transcriptPath(base, "raw", "s", "x".repeat(200) + "A", "vtt");
  const b = transcriptPath(base, "raw", "s", "x".repeat(200) + "B", "vtt");
  assert.notEqual(a, b);
});

/* MUTATION: in `selectTargets`, drop the `|| !ep.has_timestamps` conjunct.
   Prose transcripts enter the queue, so the run spends publisher bandwidth on
   text that cannot anchor a boundary (ADR-0007) and the "587 anchorable"
   headline silently becomes a mixed number. Verified failing. */
test("only timed transcripts are queued", () => {
  const targets = selectTargets({ shows: [show()] });
  assert.deepEqual(targets.map((t) => t.guid), ["g1"]);
});

/* MUTATION: in `isAnchorableShow`, change `show.dai_suspected !== true` to
   `show.dai_suspected !== false`. The default selection inverts: the 4,411
   transcripts measured as ad-injected get fetched and the usable ones do not.
   Verified failing. */
test("DAI shows are excluded unless measured ad-free, and --all-timed overrides", () => {
  const dai = show({ title: "Injected Show", dai_suspected: true });
  const adFree = show({ title: AD_FREE_SHOWS[0], dai_suspected: true });

  assert.equal(isAnchorableShow(dai), false);
  assert.equal(isAnchorableShow(adFree), true, `${AD_FREE_SHOWS[0]} is measured ad-free`);
  assert.equal(isAnchorableShow(dai, { allTimed: true }), true);
  assert.equal(isAnchorableShow(show({ episodes_with_timed_transcript: 0 }), { allTimed: true }), false);
});

/* MUTATION: in `fetchBody`, change `if (res.status !== 429 && res.status < 500)
   throw err;` to `if (false) throw err;`. A permanent 404 is then retried three
   times with backoff against a publisher who already said no. Verified failing. */
test("a 404 fails immediately; a 500 is retried", async () => {
  let calls = 0;
  await assert.rejects(
    () => fetchBody("https://t/missing.vtt", { fetchImpl: async () => { calls++; return res({ ok: false, status: 404, statusText: "Not Found" }); } }),
    (e) => e instanceof FetchError && e.code === "HTTP_404",
  );
  assert.equal(calls, 1, "a 404 must not be retried");

  let serverCalls = 0;
  const body = await fetchBody("https://t/flaky.vtt", {
    attempts: 2,
    fetchImpl: async () => {
      serverCalls++;
      return serverCalls === 1 ? res({ ok: false, status: 503, statusText: "Busy", headers: new Map([["retry-after", "0"]]) }) : res();
    },
  });
  assert.equal(serverCalls, 2);
  assert.match(body.text, /WEBVTT/);
});

/* MUTATION: in `fetchBody`, change `text.length > MAX_BODY_BYTES` to
   `text.length > MAX_BODY_BYTES * 1e6`. A mislabelled URL handing back a video
   is written to disk as a "transcript". Verified failing. */
test("an implausibly large body is refused rather than stored", async () => {
  await assert.rejects(
    () => fetchBody("https://t/huge.vtt", { fetchImpl: async () => res({ text: async () => "x".repeat(MAX_BODY_BYTES + 1) }) }),
    (e) => e instanceof FetchError && e.code === "TOO_LARGE",
  );
});

/* MUTATION: in `digestOf`, replace the `sha256` value with the literal
   `"unknown"`. The committed digest stops being able to detect that a publisher
   rewrote a transcript segments were already cut from — the one thing keeping
   the text outside git costs us, and the only reason the digest exists.
   Verified failing. */
test("the digest identifies the exact bytes and the span they cover", () => {
  const body = "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nhello\n";
  const d = digestOf(
    { show_id: "s", show_title: "A Show", guid: "g1", title: "One", transcript_url: "https://t/1.vtt", transcript_type: "text/vtt", enclosure_url: "https://cdn/1.mp3", duration_sec: 100 },
    body,
    { cues: [{ start_sec: 1, end_sec: 3, text: "hello", speaker: null }], warnings: [] },
  );

  assert.match(d.sha256, /^[0-9a-f]{64}$/);
  assert.notEqual(digestOf({ guid: "g" }, body + " ", { cues: [], warnings: [] }).sha256, d.sha256);
  assert.equal(d.bytes, Buffer.byteLength(body, "utf8"));
  assert.equal(d.first_cue_sec, 1);
  assert.equal(d.last_cue_sec, 3);
  assert.equal(d.cues, 1);
});

/* MUTATION: in `spanImplausible`, replace the body with `return false;`.
   The 100-hour cue in Inside Winemaking 210 is then summed at
   face value and the corpus total reads 527 hours instead of 427 — a headline
   number 24% wrong because of one file. Verified failing.

   This is the one bug in this tool that no unit test would have found on its
   own: it took running the real 587 and noticing that two transcripts claimed
   101 hours between them. The fixture below is that episode's real numbers. */
test("a transcript claiming more time than the episode holds is flagged, not summed", () => {
  assert.equal(spanImplausible(359999.999, 4231), true, "Inside Winemaking 210: 100h of cues on a 70min episode");
  assert.equal(spanImplausible(3233.379, 3247), false, "a transcript ending just shy of the feed duration is normal");
  assert.equal(spanImplausible(3300, 3247), false, "running slightly past a rounded itunes:duration is normal");
  assert.equal(spanImplausible(4900, 3247), true, `beyond ${MAX_SPAN_RATIO}x is not a timeline for this episode`);
  // Missing or zero duration means unknowable, never "implausible".
  assert.equal(spanImplausible(9999, null), false);
  assert.equal(spanImplausible(9999, 0), false);
  assert.equal(spanImplausible(null, 3247), false);

  const d = digestOf(
    { show_id: "s", guid: "g", transcript_url: "https://t/1.vtt", duration_sec: 4231 },
    "WEBVTT",
    { cues: [{ start_sec: 0, end_sec: 359999.999, text: "x", speaker: null }], warnings: [] },
  );
  assert.equal(d.span_implausible, true);
});

/* THE OTHER HALF OF THE AUDIO INTERLOCK.

   MUTATION: in `assertNotAudio`, replace the throw with `return base;`.
   Verified failing.

   `assertTranscriptTarget` can only compare the two URLs a feed declared, so a
   publisher putting `type="text/vtt"` on an `.mp3` defeats it — and with
   `redirect: "follow"` and a permissive `Accept`, anything under 20MB would be
   buffered and written to disk as a transcript. #108 is a gate; a feed being
   wrong is not this tool's authority to open it. The check runs BEFORE
   `res.text()`, so an audio response is abandoned rather than downloaded. */
test("an audio response is refused even when the feed declared it a transcript", async () => {
  assert.throws(
    () => assertNotAudio("https://cdn/x.mp3", "audio/mpeg"),
    (e) => e instanceof FetchError && e.code === "AUDIO_RESPONSE",
  );
  assert.throws(
    () => assertNotAudio("https://cdn/x.mp4", "video/mp4; codecs=avc1"),
    (e) => e instanceof FetchError && e.code === "AUDIO_RESPONSE",
  );
  assert.equal(assertNotAudio("https://t/x.vtt", "text/vtt; charset=utf-8"), "text/vtt");
  assert.equal(assertNotAudio("https://t/x.vtt", null), "", "a missing type is not proof of audio");

  // And the fetch path must consult it before buffering the body.
  let bodyRead = false;
  await assert.rejects(
    () =>
      fetchBody("https://cdn/lying-feed.mp3", {
        fetchImpl: async () =>
          res({
            headers: new Map([["content-type", "audio/mpeg"]]),
            text: async () => {
              bodyRead = true;
              return "x";
            },
          }),
      }),
    (e) => e instanceof FetchError && e.code === "AUDIO_RESPONSE",
  );
  assert.equal(bodyRead, false, "the body must never be read once the type says audio");
});

/* MUTATION: in `numericArg`, replace the `Number.isFinite` throw with `return
   n;`. `--concurrency abc` becomes NaN, `Array.from({length: NaN})` builds zero
   workers, and the run reports ALL_FAILED — naming the wrong cause for what is
   really a typo. Verified failing. */
test("a non-numeric flag is rejected by name rather than becoming NaN", () => {
  assert.throws(
    () => numericArg("--concurrency", "abc"),
    (e) => e instanceof FetchError && e.code === "BAD_ARG" && /--concurrency/.test(e.message),
  );
  assert.throws(
    () => numericArg("--concurrency", "0"),
    (e) => e instanceof FetchError && e.code === "BAD_ARG",
  );
  assert.equal(numericArg("--concurrency", "4"), 4);
  assert.equal(numericArg("--limit", "Infinity"), Infinity);
});

/* MUTATION: in `safeKey`, delete the `hash` suffix and return `slug`. Two
   episodes whose titles slug identically overwrite each other's transcript, and
   the digest records two rows for one file. Verified failing. */
test("distinct guids get distinct keys even when they slug the same", () => {
  assert.notEqual(safeKey("Episode: One!"), safeKey("Episode - One"));
  assert.equal(safeKey("g1"), safeKey("g1"));
  assert.match(safeKey("!!!"), /^[0-9a-f]{10}$/, "an unsluggable guid still yields a key");
});
