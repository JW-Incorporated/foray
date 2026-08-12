/* Tests for the transcript normaliser (issue #105).
   Run: node --test "tools/segments/*.test.mjs"

   The whole point of this module is that segment extraction never has to know
   which of four formats a publisher shipped. So the tests are mostly
   round-trips: read a fixture in each real-world grammar, assert the SAME
   shape comes out. The rest defend the two promises that are easy to break
   later — it never throws, and it never silently discards a cue. */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalize, parseTimestamp, sniffFormat, detectFormat } from "./transcript-normalize.mjs";

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

/** Every cue, in every format, must satisfy this. */
function assertShape(result) {
  assert.ok(Array.isArray(result.cues), "cues must be an array");
  assert.ok(Array.isArray(result.warnings), "warnings must be an array");
  for (const c of result.cues) {
    assert.equal(typeof c.start_sec, "number", "start_sec is a number");
    assert.equal(typeof c.end_sec, "number", "end_sec is a number");
    assert.ok(Number.isFinite(c.start_sec) && c.start_sec >= 0, `bad start_sec: ${c.start_sec}`);
    assert.ok(c.end_sec >= c.start_sec, `end before start: ${c.start_sec} -> ${c.end_sec}`);
    assert.equal(typeof c.text, "string");
    assert.ok(c.text.length > 0, "no empty cue text may survive");
    assert.ok(c.speaker === null || typeof c.speaker === "string");
  }
  for (const w of result.warnings) assert.equal(typeof w, "string");
}

/* ------------------------------------------------------------------ WebVTT */

test("WebVTT round-trips: header, NOTE blocks, cue ids, cue settings, MM:SS", () => {
  const r = normalize(fixture("webvtt-basic.vtt"), "text/vtt");
  assertShape(r);
  assert.deepEqual(r.warnings, [], "a clean file must produce no warnings");
  assert.equal(r.cues.length, 4);

  assert.deepEqual(
    r.cues.map((c) => [c.start_sec, c.end_sec]),
    [[2, 6.48], [6.48, 11.12], [11.5, 15.9], [15.9, 21.3]],
  );
  // Third cue is written `00:11.500` — VTT drops the hour for sub-hour cues.
  assert.equal(r.cues[2].start_sec, 11.5);
  // Cue settings after the end timestamp are presentation, not text.
  assert.ok(!r.cues[0].text.includes("align"));
  // Multi-line payloads collapse to one line of prose.
  assert.equal(r.cues[0].text, "Welcome to the show. Today we are talking about how concrete actually sets.");
  // <v Name> voice spans become the speaker field, not text.
  assert.equal(r.cues[0].speaker, "Josh");
  assert.equal(r.cues[1].speaker, "Chuck");
  // Entities are decoded.
  assert.ok(r.cues[1].text.includes("wrong & keeps"));
  // NOTE blocks, including the mid-file one, never surface.
  assert.ok(!r.cues.some((c) => /must be skipped|caption pipeline/.test(c.text)));
  // No VTT markup survives into the text of a cue.
  assert.ok(!r.cues.some((c) => /[<>]/.test(c.text)));
});

test("WebVTT parses with no declared MIME type at all", () => {
  const body = fixture("webvtt-basic.vtt");
  assert.deepEqual(normalize(body, undefined).cues, normalize(body, "text/vtt").cues);
});

/* --------------------------------------------------------------- SRT / x-subrip */

test("SRT round-trips: numeric index lines and comma decimals", () => {
  const r = normalize(fixture("srt-basic.srt"), "application/srt");
  assertShape(r);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.cues.length, 4);
  assert.deepEqual(
    r.cues.map((c) => [c.start_sec, c.end_sec]),
    [[0, 4.25], [4.25, 9], [9, 14.6], [14.6, 19.12]],
  );
  // The index line is structure, not speech.
  assert.ok(!r.cues.some((c) => /^\d+$/.test(c.text)));
  // <i> styling is stripped; entities decoded.
  assert.equal(r.cues[1].text, "And what that says about the next two years.");
  assert.ok(r.cues[2].text.includes("rates, not about ships & ports"));
  // SRT cannot express a speaker, so the field is present and null everywhere.
  assert.ok(r.cues.every((c) => c.speaker === null));
});

test("application/x-subrip is the same parser as application/srt", () => {
  const body = fixture("srt-basic.srt");
  assert.deepEqual(normalize(body, "application/x-subrip"), normalize(body, "application/srt"));
});

/* -------------------------------------------------------------------- JSON */

test("Podcasting 2.0 JSON round-trips, speaker included", () => {
  const r = normalize(fixture("podcasting20-basic.json"), "application/json");
  assertShape(r);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.cues.length, 4);
  assert.deepEqual(
    r.cues.map((c) => [c.start_sec, c.end_sec]),
    [[0, 3.75], [3.75, 9.2], [9.2, 12.5], [12.5, 18.04]],
  );
  assert.deepEqual(r.cues.map((c) => c.speaker), ["Host", "Guest", "Host", "Guest"]);
  assert.ok(r.cues[0].text.startsWith("My guest today studies"));
});

test("JSON key variants and a nested segment array are accepted", () => {
  // The Podcasting 2.0 JSON shape is loosely specified; leniency here is the
  // difference between 787 usable transcripts and some smaller number.
  const r = normalize(fixture("podcasting20-variants.json"), "application/json");
  assertShape(r);
  assert.equal(r.cues.length, 3);
  assert.deepEqual(r.cues.map((c) => c.start_sec), [1, 4, 8.5]);
  // A segment with a start but no end is closed at the next cue's start.
  assert.equal(r.cues[1].end_sec, 8.5);
  assert.ok(r.warnings.some((w) => /no end time/.test(w)));
  // A segment we cannot read is reported, not thrown over and not invented.
  assert.ok(r.warnings.some((w) => /no readable start time/.test(w)));
  assert.ok(r.warnings.some((w) => /no text/.test(w)));
});

test("JSON text is left alone by the markup stripper", () => {
  // VTT/SRT need <tag> removal; JSON has no tag convention, so prose with an
  // inequality in it must survive intact.
  const body = JSON.stringify({ segments: [{ startTime: 0, endTime: 1, body: "when x < 3 and y > 4 you get uplift" }] });
  const r = normalize(body, "application/json");
  assert.equal(r.cues.length, 1);
  assert.equal(r.cues[0].text, "when x < 3 and y > 4 you get uplift");
});

test("unreadable JSON shapes warn instead of throwing", () => {
  for (const [body, why] of [
    ['{"foo":1}', "no segment array"],
    ["[]", "empty array"],
    ['{"segments":[]}', "empty segments"],
    ['{"segments":"nope"}', "segments is not an array"],
    ['{"segments":[1,2,3]}', "segments are not objects"],
  ]) {
    const r = normalize(body, "application/json");
    assert.deepEqual(r.cues, [], why);
    assert.ok(r.warnings.length > 0, `${why} must warn`);
  }
});

/* ----------------------------------------------------- ordering & overlap */

test("out-of-order cues are sorted and reported, never silently merged", () => {
  const r = normalize(fixture("srt-out-of-order.srt"), "application/x-subrip");
  assertShape(r);
  assert.equal(r.cues.length, 3, "sorting must not lose or merge a cue");
  assert.deepEqual(r.cues.map((c) => c.start_sec), [4, 8, 12]);
  assert.ok(r.warnings.some((w) => /out of chronological order/.test(w)));
  // Cue 2 starts at 8 while cue 1 runs to 9.5. Reported, left alone.
  assert.ok(r.warnings.some((w) => /overlap/.test(w)));
  assert.equal(r.cues[0].end_sec, 9.5, "the overlapping cue's own end must be untouched");
});

/* --------------------------------------------------------- rolling captions */

test("rolling-caption repetition is de-duplicated", () => {
  const r = normalize(fixture("webvtt-rolling.vtt"), "text/vtt");
  assertShape(r);
  assert.deepEqual(r.cues.map((c) => c.text), [
    "the thing about a caldera is that",
    "it is not a crater",
    "at all it is a collapse",
    "and the collapse is the whole story",
  ]);
  // The verbatim repeat is merged into the cue it repeats, which keeps the
  // timeline continuous rather than leaving a hole.
  assert.equal(r.cues[2].end_sec, 13);
  assert.ok(r.warnings.some((w) => /repeated the previous cue verbatim/.test(w)));
  assert.ok(r.warnings.some((w) => /repeating the previous cue's tail/.test(w)));

  // Read back as one string, no clause appears twice.
  const joined = r.cues.map((c) => c.text).join(" ");
  assert.equal(joined.match(/it is not a crater/g).length, 1);
  assert.equal(joined.match(/it is a collapse/g).length, 1);
});

test("de-duplication can be turned off", () => {
  const r = normalize(fixture("webvtt-rolling.vtt"), "text/vtt", { dedupe: false });
  assert.equal(r.cues.length, 5);
  assert.ok(!r.warnings.some((w) => /rolling captions/.test(w)));
});

test("de-duplication tolerates punctuation and case changes in the repeat", () => {
  const body = [
    "WEBVTT",
    "",
    "00:00:00.000 --> 00:00:02.000",
    "we went down to the harbour",
    "",
    "00:00:02.000 --> 00:00:04.000",
    "We went down to the harbour, and it was empty.",
  ].join("\n");
  const r = normalize(body, "text/vtt");
  assert.deepEqual(r.cues.map((c) => c.text), ["we went down to the harbour", "and it was empty."]);
});

test("de-duplication does NOT eat ordinary repeated speech", () => {
  // "you know" at a cue boundary is conversation, not a caption artefact.
  // A normaliser that quietly deletes words is worse than one that leaves a
  // duplicate in, so short overlaps must be left alone.
  const body = [
    "WEBVTT",
    "",
    "00:00:00.000 --> 00:00:02.000",
    "and it just kept going, you know",
    "",
    "00:00:02.000 --> 00:00:04.000",
    "you know, that was the whole afternoon",
    "",
    "00:00:04.000 --> 00:00:06.000",
    "Right.",
    "",
    "00:00:06.000 --> 00:00:08.000",
    "Right, so we left.",
  ].join("\n");
  const r = normalize(body, "text/vtt");
  assert.equal(r.cues.length, 4);
  assert.equal(r.cues[1].text, "you know, that was the whole afternoon");
  assert.equal(r.cues[3].text, "Right, so we left.");
});

/* ------------------------------------------------------ mislabelled input */

test("the body wins when the declared MIME type disagrees", () => {
  // Mislabelling is routine in the wild: SRT served as text/vtt, VTT served as
  // application/srt, JSON served as anything at all.
  const srtAsVtt = normalize(fixture("srt-basic.srt"), "text/vtt");
  assert.equal(srtAsVtt.cues.length, 4);
  assert.ok(srtAsVtt.warnings.some((w) => /looks like srt/.test(w)));

  const jsonAsSrt = normalize(fixture("podcasting20-basic.json"), "application/srt");
  assert.equal(jsonAsSrt.cues.length, 4);
  assert.ok(jsonAsSrt.warnings.some((w) => /looks like json/.test(w)));

  const vttAsPlain = normalize(fixture("webvtt-basic.vtt"), "text/plain");
  assert.equal(vttAsPlain.cues.length, 4);
  assert.deepEqual(vttAsPlain.warnings, [], "text/plain is a shrug, not a claim to contradict");
});

test("a VTT missing its WEBVTT header still parses, with a warning", () => {
  const r = normalize("00:00:01.000 --> 00:00:02.000\nHello.\n", "text/vtt");
  assert.equal(r.cues.length, 1);
  assert.ok(r.warnings.some((w) => /missing WEBVTT header/.test(w)));
});

test("CRLF line endings and a UTF-8 BOM parse identically to plain LF", () => {
  /* Normalise to LF FIRST rather than trusting the bytes on disk. This repo is
     developed on Windows, where git's autocrlf rewrites the fixture at checkout
     time — so a naive `.replace(/\n/g, "\r\n")` on an already-CRLF file yields
     "\r\r\n" and the parser correctly finds nothing. That failure is a property
     of the developer's checkout, not of the code under test, and it is
     invisible on the Linux CI runner. `.gitattributes` now pins the fixtures,
     but constructing both variants explicitly here means the test states what
     it actually means regardless of how the file arrived. */
  const lf = fixture("webvtt-basic.vtt").replace(/\r\n/g, "\n");
  const crlf = "﻿" + lf.replace(/\n/g, "\r\n");
  assert.deepEqual(normalize(crlf, "text/vtt").cues, normalize(lf, "text/vtt").cues);
});

/* -------------------------------------------------------- never throws */

test("empty and garbage input returns no cues plus a warning, never an exception", () => {
  const inputs = [
    "", "   ", "\n\n\n", "﻿",
    "not a transcript, just a sentence",
    "<html><body>404 Not Found</body></html>",
    " ",
    "-->",
    "WEBVTT",
    "{",
    "{]",
    "0123456789".repeat(500),
  ];
  for (const body of inputs) {
    for (const mime of [undefined, "text/vtt", "application/srt", "application/json", "application/x-subrip", "nonsense/type"]) {
      const r = normalize(body, mime);
      assertShape(r);
      assert.deepEqual(r.cues, [], `expected no cues for ${JSON.stringify(body.slice(0, 20))} as ${mime}`);
      assert.ok(r.warnings.length > 0, `expected a warning for ${JSON.stringify(body.slice(0, 20))} as ${mime}`);
    }
  }
});

test("non-string bodies are reported, not thrown over", () => {
  for (const body of [null, undefined, 0, {}, [], NaN, true, () => {}, Symbol("x")]) {
    let r;
    assert.doesNotThrow(() => { r = normalize(body, "text/vtt"); }, `threw on ${String(body)}`);
    assertShape(r);
    assert.deepEqual(r.cues, []);
    assert.ok(r.warnings.length > 0);
  }
});

test("a partly-damaged file yields what parsed, plus warnings explaining the rest", () => {
  const r = normalize(fixture("malformed.vtt"), "text/vtt");
  assertShape(r);
  assert.equal(r.cues.length, 2, "the two recoverable cues survive");
  assert.equal(r.cues[0].text, "This cue is fine.");
  assert.ok(r.warnings.some((w) => /unreadable start timestamp/.test(w)));
  assert.ok(r.warnings.some((w) => /no timestamp line/.test(w)));
  assert.ok(r.warnings.some((w) => /no text/.test(w)));
  // 00:00:08 --> 00:00:06 is nonsense; clamped, reported, never negative.
  assert.ok(r.warnings.some((w) => /ended before they started/.test(w)));
  assert.equal(r.cues[1].end_sec, 8);
});

/* ------------------------------------------------------------- primitives */

test("parseTimestamp handles every separator and both hour conventions", () => {
  assert.equal(parseTimestamp("00:00:01.500"), 1.5);
  assert.equal(parseTimestamp("00:00:01,500"), 1.5);
  assert.equal(parseTimestamp("01:02:03.004"), 3723.004);
  assert.equal(parseTimestamp("02:03.456"), 123.456);   // VTT omits the hour
  assert.equal(parseTimestamp("00:00:07"), 7);          // no fractional part
  assert.equal(parseTimestamp("1:02:03,4"), 3723.4);    // one-digit hour, tenths
  assert.equal(parseTimestamp("100:00:00.000"), 360000); // >99h is legal
  assert.equal(parseTimestamp(12.25), 12.25);           // JSON ships numbers
  assert.equal(parseTimestamp("12.25"), 12.25);
  assert.equal(parseTimestamp(0), 0);
});

test("parseTimestamp returns null rather than NaN or an exception", () => {
  for (const bad of [null, undefined, "", "   ", "abc", "--:--:--", "1:2:3:4", -1, NaN, Infinity, {}, []]) {
    assert.equal(parseTimestamp(bad), null, `expected null for ${String(bad)}`);
  }
});

test("timestamp arithmetic does not accumulate float noise", () => {
  // 0.1 + 0.2 problems in a timeline become off-by-a-frame seek bugs.
  assert.equal(parseTimestamp("00:00:00.100") + parseTimestamp("00:00:00.200"), 0.30000000000000004);
  assert.equal(parseTimestamp("00:02:00.300"), 120.3);
  assert.equal(String(parseTimestamp("00:33:20.100")), "2000.1");
});

test("sniffFormat identifies each format from the bytes alone", () => {
  assert.equal(sniffFormat(fixture("webvtt-basic.vtt")), "vtt");
  assert.equal(sniffFormat(fixture("srt-basic.srt")), "srt");
  assert.equal(sniffFormat(fixture("podcasting20-basic.json")), "json");
  assert.equal(sniffFormat("[{\"start\":0}]"), "json");
  assert.equal(sniffFormat(""), null);
  assert.equal(sniffFormat(null), null);
  assert.equal(sniffFormat("just some prose"), null);
});

test("detectFormat falls back to the declared type when the body is unrecognisable", () => {
  const { format, warnings } = detectFormat("nothing recognisable here", "text/vtt");
  assert.equal(format, "vtt");
  assert.deepEqual(warnings, []);
  assert.equal(detectFormat("x", "TEXT/VTT; charset=utf-8").format, "vtt", "type params and case must not matter");
  assert.equal(detectFormat("x", "application/pdf").format, null);
});
