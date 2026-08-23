/* Suite for `decode-compare.mjs` — ADR-0008's decode-and-compare instrument.
 *
 * WHAT IS WORTH TESTING HERE, given that the expensive half of this tool is a
 * network download and a Python subprocess and neither belongs in CI. The
 * answer is: everything that turns bytes into a VERDICT. A decode that is
 * measured correctly and then compared wrongly is worse than no decode at all,
 * because it arrives wearing the authority of a full download — this is the
 * instrument the cheap ones defer to, so an arithmetic bug here has nothing
 * above it to catch it.
 *
 * So the seams are drawn to leave the arithmetic pure: `compareDecode`,
 * `chooseDuration`, `id3v2TagBytes`, `syncsafeSize` and `bitrateResidualSec`
 * take numbers and return numbers, and the two impure functions take injectable
 * `fetchImpl` / `run` so they can be exercised without touching either.
 *
 * MUTATION-TESTED. Every block below records the mutation run against it and
 * the failure it produced. Mutations were applied with `python -c` byte
 * rewrites and each was confirmed to have CHANGED THE FILE ON DISK before its
 * result was believed — #319 found four "passing" mutants that were no-ops
 * because a newline pattern did not match a CRLF working tree, and a mutant
 * that did not apply proves nothing except that the harness lied. */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";

import {
  AUDIO_DIR,
  DECODER,
  DURATION_AGREEMENT_SEC,
  REPORT_PATH,
  TARGETS,
  TRAILING_ALLOWANCE_SEC,
  VERDICTS,
  chooseDuration,
  compareDecode,
  decodeFile,
  id3v2TagBytes,
  probeGrid,
  readHead,
  recompare,
  syncsafeSize,
  tagBoundaryAgrees,
  transcriptCues,
} from "./decode-compare.mjs";
import { CONSTANT_OFFSET_TOLERANCE_BYTES } from "../segments/measure-suspects.mjs";
import { ACCEPT_LANGUAGE, AUDIO_UA, UA } from "../segments/politeness.mjs";

/* ------------------------------------------------------------ ID3v2 parsing */

/** An ID3v2 header with `size` in the four syncsafe bytes. */
function id3Header(size, { major = 3, flags = 0 } = {}) {
  return Buffer.from([
    0x49, 0x44, 0x33, major, 0x00, flags,
    (size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f,
  ]);
}

/* MUTATION: `if (b & 0x80) return null;` -> `if (false) return null;`.
   Verified failing (byte diff confirmed):
     syncsafeSize accepts a byte with the high bit set
   Reverted. */
test("syncsafeSize refuses four bytes that are not syncsafe", () => {
  assert.equal(syncsafeSize(0, 0, 0, 0), 0);
  assert.equal(syncsafeSize(0, 0, 0, 0x7f), 127);
  assert.equal(syncsafeSize(0, 0, 1, 0), 128);
  assert.equal(syncsafeSize(0x7f, 0x7f, 0x7f, 0x7f), 268435455, "the largest legal tag size");

  // The high bit is the whole point of the encoding. A byte carrying it is a
  // byte that is not part of a syncsafe integer, and reading one anyway is how
  // a confident, wrong tag length gets produced.
  assert.equal(syncsafeSize(0x80, 0, 0, 0), null);
  assert.equal(syncsafeSize(0, 0, 0, 0xff), null);
  assert.equal(syncsafeSize(0, 0, 0, undefined), null);
  assert.equal(syncsafeSize(0, 0, 0, -1), null);
  assert.equal(syncsafeSize(0, 0, 0, 1.5), null);
});

/* MUTATION: drop the `+ footer` term from the return. Verified failing:
     a tag declaring a footer is 10 bytes larger than one that does not
   MUTATION: `at(0) !== 0x49` -> `at(0) !== 0x00`. Verified failing:
     a file with no tag reports 0
   Both reverted. */
test("id3v2TagBytes measures the leading tag, and reports 0 when there is not one", () => {
  assert.equal(id3v2TagBytes(id3Header(0)), 10, "a header with an empty tag body is still 10 bytes");
  assert.equal(id3v2TagBytes(id3Header(99_335)), 99_345, "the Art Bell gap, if it is a tag");
  assert.equal(id3v2TagBytes(id3Header(99_335, { flags: 0x10 })), 99_355, "ID3v2.4 footer counts too");

  // Not a tag: no magic, an invalid version byte, a non-syncsafe size, or a
  // buffer too short to decide. Every one of these must report 0 rather than a
  // number, because the caller subtracts this from the file size.
  assert.equal(id3v2TagBytes(Buffer.from("RIFFxxxxWAVE")), 0);
  assert.equal(id3v2TagBytes(Buffer.from([0xff, 0xfb, 0x90, 0x00, 0, 0, 0, 0, 0, 0])), 0, "a bare MPEG frame sync");
  assert.equal(id3v2TagBytes(id3Header(1, { major: 0xff })), 0, "0xFF is explicitly invalid as a version");
  /* ID3v2.2/.3/.4 are the versions that exist. The spec forbids only 0xFF, and
     checking no more than that let a stray 0x63 parse as a tag and have its
     "length" subtracted from the file size. */
  for (const major of [2, 3, 4]) assert.ok(id3v2TagBytes(id3Header(64, { major })) > 0, `v2.${major} is a real version`);
  for (const major of [0, 1, 5, 0x63]) assert.equal(id3v2TagBytes(id3Header(64, { major })), 0, `v2.${major} is not`);
  assert.equal(id3v2TagBytes(Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0x80, 0])), 0, "size bytes not syncsafe");
  assert.equal(id3v2TagBytes(Buffer.from([0x49, 0x44, 0x33])), 0, "too short to decide");
  assert.equal(id3v2TagBytes(null), 0);
  assert.equal(id3v2TagBytes([]), 0);
});

/* MEASURED, NOT ASSUMED. The numbers below come from decoding a synthetic
   96kbps MP3 written for this check: `id3v2TagBytes` read 45 and PyAV's
   `first_packet_pos` read 358, and the 313-byte difference is exactly one MPEG
   frame at that bitrate — the Xing/LAME header, which the demuxer consumes and
   never emits. A byte-equality check here would fail on every file an ordinary
   encoder produced.

   MUTATION: `<= CONSTANT_OFFSET_TOLERANCE_BYTES` -> `=== 0`. Verified failing:
     the two readings of where audio starts agree to within one frame
   Reverted. */
test("the two readings of where audio starts agree to within one frame", () => {
  assert.equal(tagBoundaryAgrees(358, 45), true, "one 96kbps Xing frame apart — measured");
  assert.equal(tagBoundaryAgrees(45, 45), true);
  assert.equal(tagBoundaryAgrees(45 + 626, 45), true, "one 192kbps frame is still inside the band");

  // The quantity actually being separated is ~97x the band, so this check has
  // two orders of magnitude of headroom over the question it answers.
  assert.equal(tagBoundaryAgrees(99_345, 45), false, "16 seconds of audio is not a header frame");
  assert.equal(tagBoundaryAgrees(45, 99_345), false);

  assert.equal(tagBoundaryAgrees(null, 45), null, "unknown is not agreement");
  assert.equal(tagBoundaryAgrees(358, 0), null, "no tag means nothing to agree with");
  assert.equal(tagBoundaryAgrees(358, null), null);
});

test("readHead reads only the header, not the file", () => {
  const dir = mkdtempSync(join(tmpdir(), "decode-head-"));
  try {
    const p = join(dir, "a.mp3");
    writeFileSync(p, Buffer.concat([id3Header(64), Buffer.alloc(4096, 0x41)]));
    const head = readHead(p);
    assert.equal(head.length, 10);
    assert.equal(id3v2TagBytes(head), 74);

    // A file shorter than the requested head must come back short, not padded:
    // ten zero bytes would parse as "no tag" either way, but a short read that
    // silently returns zeroes hides a truncated file.
    const tiny = join(dir, "tiny.mp3");
    writeFileSync(tiny, Buffer.from([0x49, 0x44]));
    assert.equal(readHead(tiny).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* --------------------------------------------------------- duration choice */

/* TWO REGRESSIONS LIVE IN THIS BLOCK, and both would produce a wrong verdict
   rather than a crash.

   ONE: the container's own duration must never be a candidate. For an MP3 it
   is the Xing/LAME header's CLAIM, and where there is no such header FFmpeg
   derives it from (file size - tags) x 8 / bitrate — a restatement of the byte
   count. Three of this tool's four questions are "do the delivered bytes carry
   more audio than the transcript describes", so a duration computed out of the
   delivered bytes would report "consistent" for a file with an hour of ads in
   it.

   TWO: it must not be a VOTE either, which is the subtler version and the one
   that actually shipped. An earlier draft averaged it into a three-way
   agreement band, and flightcast's Xing headers over-declare on clean and
   inserting files alike — +3.76s on The Secret To Success, whose frames match
   its feed duration to 0.32s, and +8.41s on the DOAC episode. The band refused
   to answer for a file that was in perfect order, i.e. a false `undecidable` on
   the exact question a 30MB download had just been spent to settle.

   MUTATION: add `["container_duration_sec", decode?.container_duration_sec]`
   back to `candidates`. Verified failing (byte diff confirmed):
     the container's own duration is reported as a claim, never counted as a reading
   Reverted. */
test("the packet sum is preferred over the container's own claim", () => {
  const d = chooseDuration({
    container_duration_sec: 3600.5,
    packet_duration_sec: 3600.1,
    frame_geometry_sec: 3600.2,
  });
  assert.equal(d.source, "packet_duration_sec");
  assert.equal(d.sec, 3600.1);
  assert.equal(d.agrees, true);
  assert.equal(d.spread_sec, 0.1, "the spread is between the two FRAME-derived readings only");
});

test("the container's own duration is reported as a claim, never counted as a reading", () => {
  // The measured flightcast numbers. Both files are in order by every
  // frame-derived measure; both have headers that over-declare.
  const clean = chooseDuration({ container_duration_sec: 2513.084082, packet_duration_sec: 2509.3224489795916, frame_geometry_sec: 2509.3224489795916 });
  assert.equal(clean.agrees, true, "a lying header must not veto a file whose frames agree exactly");
  assert.equal(clean.spread_sec, 0);
  assert.equal(clean.header_claimed_sec, 2513.084082);
  assert.equal(clean.header_delta_sec, 3.762, "the header's overclaim is published rather than absorbed");

  const stitched = chooseDuration({ container_duration_sec: 5748.793469, packet_duration_sec: 5740.3820408163265, frame_geometry_sec: 5740.3820408163265 });
  assert.equal(stitched.agrees, true);
  assert.equal(stitched.header_delta_sec, 8.411);

  // No header at all is not a disagreement.
  const bare = chooseDuration({ packet_duration_sec: 100, frame_geometry_sec: 100 });
  assert.equal(bare.header_claimed_sec, null);
  assert.equal(bare.header_delta_sec, null);
  assert.equal(bare.agrees, true);
});

/* MUTATION: `agrees: candidates.length >= 2 && spread <= ...` -> drop the
   length clause. Verified failing:
     one reading is never agreement, however small its spread
   Reverted. A single finite candidate has a trivially zero spread, and an
   earlier version reported that as agreement — so `compareDecode` could issue a
   full verdict from one unverified number. Reachable rather than theoretical:
   `frame_geometry_sec` is null whenever the codec context never populates
   `frame_size`, which is ordinary for AAC/M4A. */
test("one reading is never agreement, however small its spread", () => {
  const one = chooseDuration({ packet_duration_sec: 3000, frame_geometry_sec: null });
  assert.equal(one.sec, 3000, "the reading is still returned");
  assert.equal(one.agrees, false);
  assert.equal(one.spread_sec, null, "there is no spread between one number and nothing");

  // And it must reach the verdict, not just the struct.
  assert.equal(
    compareDecode({ ...clean, decoded_sec: one.sec, duration_agrees: one.agrees }).verdict,
    "undecidable",
  );
});

test("a disagreement between the frame-derived readings is reported, not averaged", () => {
  const d = chooseDuration({ container_duration_sec: 3600, packet_duration_sec: 3000, frame_geometry_sec: 3600 });
  assert.equal(d.agrees, false, "600s apart means the frames do not share one geometry");
  assert.equal(d.spread_sec, 600);
  assert.equal(d.sec, 3000, "the reading is still returned so the operator can see it");

  // Exactly at the bound is agreement; a hair past it is not.
  assert.equal(chooseDuration({ packet_duration_sec: 100, frame_geometry_sec: 100 + DURATION_AGREEMENT_SEC }).agrees, true);
  assert.equal(chooseDuration({ packet_duration_sec: 100, frame_geometry_sec: 100 + DURATION_AGREEMENT_SEC + 0.01 }).agrees, false);
});

test("chooseDuration falls back rather than inventing, and says when it has nothing", () => {
  assert.equal(chooseDuration({ frame_geometry_sec: 42, packet_duration_sec: null }).source, "frame_geometry_sec");
  // A container duration ALONE is not a measurement — it is the one reading
  // this function refuses to stand on, so a file offering only that is
  // undecidable rather than 42 seconds long.
  const claimOnly = chooseDuration({ container_duration_sec: 42 });
  assert.equal(claimOnly.source, null);
  assert.equal(claimOnly.sec, null);
  assert.equal(claimOnly.header_claimed_sec, 42, "still reported, just not counted");

  const none = chooseDuration({ packet_duration_sec: 0, container_duration_sec: null, frame_geometry_sec: NaN });
  assert.equal(none.sec, null);
  assert.equal(none.agrees, false, "nothing to agree about is not agreement");
  assert.equal(chooseDuration(null).sec, null);
});

/* ------------------------------------------------------------- the verdict */

const clean = {
  decoded_sec: 5600,
  last_cue_sec: 5590,
  feed_duration_sec: 5626,
  delivered_bytes: 67_200_000,
  declared_bytes: null,
  tag_bytes: 0,
};

/* MUTATION: `beyondTranscript > allowance_sec` -> `beyondTranscript > allowance_sec * 10`.
   Verified failing:
     audio past the transcript beyond the allowance is excess-audio
   MUTATION: `beyondTranscript < -allowance_sec` -> `beyondTranscript < allowance_sec`.
   Verified failing:
     a file shorter than its transcript is never called a match
   Both reverted. */
test("a file whose audio ends where its transcript does matches it", () => {
  const r = compareDecode(clean);
  assert.equal(r.verdict, "matches-transcript");
  assert.equal(r.beyond_transcript_sec, 10);
  assert.match(r.reason, /inside the 30s allowance/);
});

test("audio past the transcript beyond the allowance is excess-audio", () => {
  const r = compareDecode({ ...clean, decoded_sec: 5590 + TRAILING_ALLOWANCE_SEC + 1 });
  assert.equal(r.verdict, "excess-audio");
  assert.equal(r.beyond_transcript_sec, 31);
  assert.match(r.reason, /past the transcript's last cue/);

  // Exactly at the allowance still matches. The constant is a resolution
  // limit, and a boundary that moves under `>=` vs `>` is a constant nobody
  // can reason about.
  assert.equal(compareDecode({ ...clean, decoded_sec: 5590 + TRAILING_ALLOWANCE_SEC }).verdict, "matches-transcript");
});

test("a file shorter than its transcript is never called a match", () => {
  const r = compareDecode({ ...clean, decoded_sec: 5590 - TRAILING_ALLOWANCE_SEC - 1 });
  assert.equal(r.verdict, "short-of-transcript");
  assert.equal(r.beyond_transcript_sec, -31);
  assert.match(r.reason, /a copy we are not receiving/);
});

/* The three ways this refuses to answer. Every one of them used to be a
   plausible place for a wrong `matches-transcript` to fall out of an `else`. */
test("a missing input or a disagreeing decode is undecidable, never a pass", () => {
  assert.equal(compareDecode({ ...clean, decoded_sec: null }).verdict, "undecidable");
  assert.equal(compareDecode({ ...clean, last_cue_sec: null }).verdict, "undecidable");
  assert.equal(compareDecode({ ...clean, duration_agrees: false }).verdict, "undecidable");
  assert.equal(compareDecode().verdict, "undecidable");
  assert.match(compareDecode({ ...clean, duration_agrees: false }).reason, /none of them is being trusted/);
  for (const r of [compareDecode({ ...clean, decoded_sec: null }), compareDecode()]) {
    assert.ok(VERDICTS.includes(r.verdict));
  }
});

/* THE ART BELL QUESTION, in arithmetic. A constant byte gap that a leading
   non-audio tag exactly accounts for is metadata; the delta in seconds is
   zero, and no threshold in seconds is consulted to say so.

   MUTATION: `Math.abs(gapBytes - tag) <= CONSTANT_OFFSET_TOLERANCE_BYTES`
   -> `... >= ...`. Verified failing:
     a byte gap the leading tag accounts for is metadata, not audio
   Reverted. */
test("a byte gap the leading tag accounts for is metadata, not audio", () => {
  const artBell = {
    decoded_sec: 8560,
    last_cue_sec: 8550,
    feed_duration_sec: 8625,
    declared_bytes: 51_890_380,
    delivered_bytes: 51_989_683,
    tag_bytes: 99_303,
  };
  const r = compareDecode(artBell);
  assert.equal(r.gap_bytes, 99_303);
  assert.equal(r.gap_explained_by_tag, true);
  assert.equal(r.audio_bytes, 51_890_380, "the audio is exactly what the feed declared");
  assert.equal(r.verdict, "matches-transcript");

  // A pre-roll is the same gap on the other side of the first frame: no tag,
  // so nothing explains it and the bytes are audio.
  const preroll = compareDecode({ ...artBell, tag_bytes: 0 });
  assert.equal(preroll.gap_explained_by_tag, null, "no tag means the question was not answered, not answered no");
  assert.equal(preroll.audio_bytes, 51_989_683);

  // A gap of ZERO has nothing to explain, and `false` there reads as "the tag
  // does not account for the gap" — which is a finding, about a gap that does
  // not exist. Live on the art-bell row, which now delivers exactly what it
  // declares.
  assert.equal(compareDecode({ ...artBell, delivered_bytes: 51_890_380 }).gap_bytes, 0);
  assert.equal(compareDecode({ ...artBell, delivered_bytes: 51_890_380 }).gap_explained_by_tag, null);

  // A tag that is present but the wrong size explains nothing.
  assert.equal(
    compareDecode({ ...artBell, tag_bytes: 99_303 + CONSTANT_OFFSET_TOLERANCE_BYTES + 1 }).gap_explained_by_tag,
    false,
  );
  assert.equal(compareDecode({ ...artBell, tag_bytes: 99_303 + CONSTANT_OFFSET_TOLERANCE_BYTES }).gap_explained_by_tag, true);
});

test("the bitrate is computed from AUDIO bytes, never from the tag", () => {
  const r = compareDecode({ ...clean, decoded_sec: 1000, delivered_bytes: 12_100_000, tag_bytes: 100_000 });
  assert.equal(r.audio_bytes, 12_000_000);
  assert.equal(r.implied_bitrate_bps, 96_000, "12,000,000 bytes over 1000s is 96 kbps — the tag is not audio");
  assert.equal(compareDecode({ ...clean, decoded_sec: 0 }).implied_bitrate_bps, null, "never divide by zero");
});

test("a gap cannot be computed against a feed that declared no length", () => {
  const r = compareDecode({ ...clean, declared_bytes: null });
  assert.equal(r.gap_bytes, null, "this is the flightcast case — no denominator at all");
  assert.equal(r.gap_explained_by_tag, null);
  assert.equal(r.verdict, "matches-transcript", "the transcript comparison still works without one");
});

/* ------------------------------------------------------------- the probe grid

   THE CENTRAL CLAIM OF THIS WHOLE CHANGE lives or dies on `probeGrid`: that a
   2-byte ranged GET can report a length the origin does not deliver. It became
   a committed mode after a reviewer refused it as an ad-hoc observation, so the
   grid it produces is what a future reader will check the claim against — and
   these tests are what stop the grid from lying in the same way the instrument
   it audits does. */

/** A fetch stub that answers a length per (identity, ranged) cell. */
function gridFetch(answers, seen = []) {
  return async (url, init) => {
    const h = init.headers;
    const ranged = Boolean(h.range);
    const identity = h["user-agent"].startsWith("ForayBot") ? "probe" : "client";
    seen.push({ identity, ranged, ua: h["user-agent"], lang: h["accept-language"] });
    const total = answers[`${identity}:${ranged ? "ranged" : "unranged"}`];
    return new Response(ranged ? "xx" : "", {
      status: ranged ? 206 : 200,
      headers: ranged
        ? { "content-range": `bytes 0-1/${total}`, "content-length": "2" }
        : { "content-length": String(total) },
    });
  };
}

const gridTarget = { id: "t", audio_url: "https://cdn.example.com/a.mp3" };
const noWait = async () => {};

/* MUTATION: `totals.length > 1` -> `totals.length > 2`. Verified failing:
     one URL answering with two different lengths is per-request assembly
   Reverted. */
test("one URL answering with two different lengths is per-request assembly", async () => {
  // The measured flightcast grid: three cells report the master's length and
  // only an unranged request from a CLIENT identity is served the assembled
  // file. This is why every ranged probe this repo has ever sent came back
  // byte-stable on that host — it was never being shown the other file.
  const seen = [];
  const g = await probeGrid(gridTarget, {
    fetchImpl: gridFetch({
      "probe:ranged": 67_510_022,
      "probe:unranged": 67_510_022,
      "client:ranged": 67_510_022,
      "client:unranged": 68_884_898,
    }, seen),
    sleep: noWait,
  });
  assert.equal(g.varies_by_request, true);
  assert.deepEqual(g.distinct_totals, [67_510_022, 68_884_898]);
  assert.equal(g.cells.length, 4, "both identities, ranged and not");
  assert.equal(g.compressed, false);

  // Four cells that agree is the honest negative, and three of this change's
  // four targets produce exactly that.
  const clean = await probeGrid(gridTarget, {
    fetchImpl: gridFetch({
      "probe:ranged": 30_112_183, "probe:unranged": 30_112_183,
      "client:ranged": 30_112_183, "client:unranged": 30_112_183,
    }),
    sleep: noWait,
  });
  assert.equal(clean.varies_by_request, false);
  assert.deepEqual(clean.distinct_totals, [30_112_183]);
});

/* THE GRID MUST VARY ONLY THE TWO THINGS IT CLAIMS TO VARY. If it also drifted
   the Accept-Language header, or sent a UA this repo does not own, a length
   difference would be evidence about something else entirely — and the whole
   finding is a difference between two cells.

   MUTATION: hardcode `"user-agent": "curl/8"` in one arm. Verified failing:
     the grid varies only the Range and the identity, both from politeness.mjs
   Reverted. */
test("the grid varies only the Range and the identity, both from politeness.mjs", async () => {
  const seen = [];
  await probeGrid(gridTarget, { fetchImpl: gridFetch({ "probe:ranged": 1, "probe:unranged": 1, "client:ranged": 1, "client:unranged": 1 }, seen), sleep: noWait });

  assert.deepEqual(seen.map((x) => `${x.identity}:${x.ranged}`), ["probe:true", "probe:false", "client:true", "client:false"]);
  assert.deepEqual([...new Set(seen.map((x) => x.lang))], [ACCEPT_LANGUAGE], "one Accept-Language across all four cells");
  const uas = [...new Set(seen.map((x) => x.ua))];
  assert.equal(uas.length, 2, "exactly two identities, and they are the repo's own");
  assert.ok(uas.includes(AUDIO_UA) && uas.includes(UA));
});

test("the grid reads no audio body", async () => {
  let bodyReads = 0;
  const fetchImpl = async (url, init) => {
    const ranged = Boolean(init.headers.range);
    const res = new Response(ranged ? "xx" : "A".repeat(4096), {
      status: ranged ? 206 : 200,
      headers: ranged ? { "content-range": "bytes 0-1/4096" } : { "content-length": "4096" },
    });
    if (!ranged) {
      // Fail loudly if the unranged arm ever consumes its body: this mode is
      // supposed to cost four range bytes, not four episodes.
      const original = res.body;
      Object.defineProperty(res, "body", { get: () => { bodyReads++; return original; } });
    }
    return res;
  };
  await probeGrid(gridTarget, { fetchImpl, sleep: noWait });
  assert.ok(bodyReads <= 2, "the unranged arms may cancel their body, never read it");
});

/* MUTATION: `rawLength === null || rawLength === "" || !Number.isFinite(...)`
   -> `false`. Verified failing (byte diff confirmed):
     a missing Content-Length is not a length of zero
   Reverted. */
test("a missing Content-Length is not a length of zero", async () => {
  // `Number(null)` is 0, and 0 is finite — so an origin that sends no
  // Content-Length at all (chunked, or plenty of HTTP/2 origins) would record
  // `total: 0`, enter `distinct_totals`, and MANUFACTURE this mode's headline
  // out of a missing header.
  const fetchImpl = async (url, init) => {
    const ranged = Boolean(init.headers.range);
    return new Response(ranged ? "xx" : "", {
      status: ranged ? 206 : 200,
      headers: ranged ? { "content-range": "bytes 0-1/4096" } : {},   // no content-length
    });
  };
  const g = await probeGrid(gridTarget, { fetchImpl, sleep: noWait });
  assert.deepEqual(g.distinct_totals, [4096], "only the two readings that exist");
  assert.equal(g.varies_by_request, false, "a header that is absent is not a second length");
  assert.deepEqual(g.cells.filter((c) => !c.ranged).map((c) => c.total), [null, null]);
});

/* --------------------------------------------------------------- the seams */

/* THE INTERLOCK HAS TO BE WIRED UP, NOT MERELY IMPORTED, and this test exists
   because the first version of `transcriptCues` imported it and was still
   inert. `assertTranscriptTarget` throws on `transcript_url === enclosure_url`,
   and the target rows here carry the enclosure as `audio_url` — so the guard
   was being handed an object with no `enclosure_url`, returning happily, and
   protecting nothing. The `fetchImpl` below throws if it is ever reached, so a
   regression fails as a wrong error rather than as a real request to a real
   host.

   MUTATION: drop `enclosure_url` from the `checked` object in
   `transcriptCues`. Verified failing (byte diff confirmed):
     transcriptCues refuses to point the transcript fetcher at an enclosure
   Reverted. */
test("transcriptCues refuses to point the transcript fetcher at an enclosure", async () => {
  const never = async () => assert.fail("a request was made after the interlock should have thrown");
  const url = "https://cdn.example.com/ep.mp3";
  await assert.rejects(
    () => transcriptCues({ guid: "g", transcript_url: url, audio_url: url }, { fetchImpl: never }),
    (e) => {
      assert.equal(e.code, "AUDIO_TARGET");
      assert.match(e.message, /never fetches audio/);
      return true;
    },
  );

  // The other half of the same guard: no transcript at all.
  await assert.rejects(
    () => transcriptCues({ guid: "g", transcript_url: null, audio_url: url }, { fetchImpl: never }),
    (e) => (assert.equal(e.code, "NO_TRANSCRIPT_URL"), true),
  );
});

test("transcriptCues reports the last cue, the count and an implausible span", async () => {
  const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nhello\n\n00:10:00.000 --> 00:10:09.500\ngoodbye\n";
  const fetchImpl = async () => new Response(vtt, { status: 200, headers: { "content-type": "text/vtt" } });
  const t = await transcriptCues(
    { transcript_url: "https://example.com/a.vtt", transcript_type: "text/vtt", duration_sec: 620 },
    { fetchImpl },
  );
  assert.equal(t.cues, 2);
  assert.equal(t.first_cue_sec, 1);
  assert.equal(t.last_cue_sec, 609.5);
  assert.equal(t.span_implausible, false);

  // The degenerate-transcript guard is the fetcher's, imported not re-derived:
  // a cue ending at 99:59:59.999 against a 620s episode is a writer's "no end
  // time", and summing it naively is what made a corpus total 24% wrong.
  const junk = "WEBVTT\n\n00:00:01.000 --> 99:59:59.999\nhello\n";
  const t2 = await transcriptCues(
    { transcript_url: "https://example.com/b.vtt", transcript_type: "text/vtt", duration_sec: 620 },
    { fetchImpl: async () => new Response(junk, { status: 200, headers: { "content-type": "text/vtt" } }) },
  );
  assert.equal(t2.span_implausible, true);
});

test("decodeFile parses the decoder's JSON and does not swallow its errors", () => {
  const run = (bin, args) => {
    assert.equal(args[0], DECODER, "the committed decoder, not something on PATH");
    assert.equal(args[1], "/tmp/x.mp3");
    return JSON.stringify({ packet_duration_sec: 12.5, frames: 3 });
  };
  assert.equal(decodeFile("/tmp/x.mp3", { python: "python3", run }).packet_duration_sec, 12.5);

  assert.throws(() => decodeFile("/tmp/x.mp3", { run: () => "not json" }));
  assert.throws(() => decodeFile("/tmp/x.mp3", { run: () => { throw new Error("No module named 'av'"); } }), /av/);
});

/* THE DRIFT THIS PREVENTS IS NOT HYPOTHETICAL: the committed Art Bell row went
   on asking "artwork or pre-roll?" for a full review cycle after TARGETS had
   been corrected to say the question is no longer answerable, because
   `recompare` spread `...row` and never refreshed it. The row a reader opens to
   check a claim is the one that must not be stale.

   MUTATION: delete the `question:` and `why_this_episode:` lines from
   `recompare`. Verified failing:
     recompare refreshes target-derived prose and never a measurement
   Reverted. */
test("recompare refreshes target-derived prose and never a measurement", () => {
  const target = {
    id: "x", question: "the CURRENT question", why: "the CURRENT reason",
    show: "Show", show_id: "S", episode: "Ep", duration_sec: 100, declared_bytes: null, delivered_bytes: 500,
  };
  const stored = {
    id: "x", question: "a STALE question", why_this_episode: "a STALE reason",
    show: "Old", show_id: "OLD", episode: "Old Ep",
    downloaded_bytes: 500,
    transcript: { last_cue_sec: 99 },
    decode: { packet_duration_sec: 100, frame_geometry_sec: 100, id3v2_tag_bytes: 0, frames: 42 },
  };
  const out = recompare(stored, target);
  assert.equal(out.question, "the CURRENT question");
  assert.equal(out.why_this_episode, "the CURRENT reason");
  assert.equal(out.show_id, "S");
  assert.equal(out.episode, "Ep");
  // Measurements are copied through untouched — an override may change the
  // judgement, never the evidence.
  assert.equal(out.decode.frames, 42);
  assert.equal(out.downloaded_bytes, 500);
  assert.equal(out.comparison.verdict, "matches-transcript");
});

test("recompare refuses a stored row whose target is gone", () => {
  // Silently nulling `declared_bytes` and `feed_duration_sec` would rewrite the
  // row to `undecidable` and commit it, making a lost input look like a
  // measurement.
  assert.throws(
    () => recompare({ id: "vanished", decode: {}, transcript: {}, downloaded_bytes: 1 }, undefined),
    /no target named "vanished"/,
  );
});

/* --------------------------------------------------------- the target list */

/* THE COST CONTROL IS THE LIST, so the list is what gets pinned. Each row is a
   full episode download; a fourth row that appears without a founder noticing
   is bandwidth spent on a question nobody asked. This does not forbid adding
   one — it forbids adding one silently. */
test("every target names one episode, one question, and why that episode", () => {
  /* FIVE, FOR THREE QUESTIONS, and the two extras were both bought by a result
     rather than planned — which is the shape this list is supposed to have.
     `flightcast-bare` and `flightcast-doac-origin` were added after the first
     flightcast download came back larger than the origin declares: the first
     asks whether a show with no ad-tech prefix behaves the same, the second
     re-asks with the SAME episode and the prefixes stripped. Each row's
     comment argues its own download. Raising this number should always feel
     like spending something, because it is. */
  assert.equal(TARGETS.length, 5, "one download per open question, plus two the results forced");
  assert.deepEqual(TARGETS.map((t) => t.id), [
    "flightcast-doac", "flightcast-doac-origin", "flightcast-bare", "art-bell", "around-the-house",
  ]);

  const seen = new Set();
  for (const t of TARGETS) {
    assert.ok(!seen.has(t.id), `duplicate target id ${t.id}`);
    seen.add(t.id);
    for (const field of ["question", "show", "show_id", "guid", "episode", "why", "audio_url", "transcript_url"]) {
      assert.ok(t[field], `${t.id} is missing ${field}`);
    }
    assert.match(t.audio_url, /^https:\/\//, `${t.id} fetches audio over plaintext`);
    assert.match(t.transcript_url, /^https:\/\//, `${t.id} fetches a transcript over plaintext`);
    assert.notEqual(t.audio_url, t.transcript_url);
    assert.ok(t.why.length > 20, `${t.id}'s reason for this episode is too thin to audit`);
    assert.ok(Number.isFinite(t.duration_sec) && t.duration_sec > 0, `${t.id} has no feed duration to compare against`);
  }
});

test("the targets cover the three open questions and name the shows they speak for", () => {
  /* A platform verdict is not a show verdict (`_adswizz_note` in
     dai-hosts.json), so every row names the show it is evidence about: FOUR
     distinct shows across five downloads, answering three questions. The count
     is deliberately not tidy — flightcast needed two shows precisely because
     one show could not answer a question about a platform. */
  assert.equal(new Set(TARGETS.map((t) => t.show_id)).size, 4);
  assert.equal(new Set(TARGETS.map((t) => t.question)).size, TARGETS.length,
    "each row states its own question — two rows sharing one would mean one of them was not worth its download");

  const fc = TARGETS.find((t) => t.id === "flightcast-doac");
  assert.match(fc.show, /Diary Of A CEO/);
  assert.equal(fc.declared_bytes, null, "the whole point of that row: this feed declares no length");

  /* THE A/B THAT SEPARATES ORIGIN FROM CHAIN. These two rows must stay the same
     episode of the same show and differ ONLY in the URL, or the comparison they
     exist to make is confounded and the conclusion drawn from it is wrong. */
  const origin = TARGETS.find((t) => t.id === "flightcast-doac-origin");
  assert.equal(origin.show_id, fc.show_id);
  assert.equal(origin.guid, fc.guid);
  assert.equal(origin.transcript_url, fc.transcript_url);
  assert.equal(origin.duration_sec, fc.duration_sec);
  assert.notEqual(origin.audio_url, fc.audio_url);
  assert.match(fc.audio_url, /pdst\.fm/, "the publisher's declared URL, with its ad-tech prefixes");
  assert.doesNotMatch(origin.audio_url, /pdst\.fm|pscrb\.fm|mgln\.ai|claritaspod|podderapp/,
    "the diagnostic row must have every prefix stripped or it measures nothing");

  // And the bare-chain control is a DIFFERENT show on the same origin.
  const bare = TARGETS.find((t) => t.id === "flightcast-bare");
  assert.notEqual(bare.show_id, fc.show_id);
  assert.match(bare.audio_url, /episode\.flightcast\.com/);

  /* THE DIAGNOSTIC FLAG IS A MECHANISM, NOT A COMMENT. `decodeIndex` keys on
     `show_id`, so the one row that deliberately fetches a URL the publisher
     never declared must be marked, or it is eligible to condemn or acquit the
     show on evidence about a URL no listener is ever served. Corner case #1
     otherwise has only prose defending it. */
  assert.equal(origin.diagnostic, true, "the non-declared-URL row must be flagged");
  for (const t of TARGETS.filter((x) => x.id !== "flightcast-doac-origin")) {
    assert.ok(!t.diagnostic, `${t.id} fetches the publisher's declared URL and must not be flagged diagnostic`);
  }
});

/* THE COST GATE. The file header promises `--episode` takes exactly one
   episode; the code used to download all five (261MB) on a bare invocation.
   Cost discipline that lives only in a comment is not cost discipline. */
test("a bare invocation refuses to download every target", () => {
  const src = readFileSync(new URL("./decode-compare.mjs", import.meta.url), "utf8");
  assert.match(src, /if \(!only && !argv\.includes\("--all"\)\)/, "the download path must require --episode or --all");
  assert.match(src, /refusing to download every target on a bare invocation/);
});

/* THE ARTIFACT-PRESERVATION RULE. `--probe-grid` writes the four-cell evidence
   for this change's headline finding, and the download path used to write a
   fresh object that silently deleted it. A mode that destroys another mode's
   artifact is the same failure as never committing it. */
test("every write path preserves what the others committed", () => {
  /* COMMENTS ARE STRIPPED FIRST, and that is not tidiness — it is the whole
     reason this assertion works. The first version scanned the raw source, and
     the comment ABOVE the spread explains `...prevFile` in backticks; deleting
     the actual spread left the comment matching, so the mutant survived. A
     guard that reads its own documentation as evidence of the thing documented
     is a guard that fails open. */
  const src = readFileSync(new URL("./decode-compare.mjs", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const writes = [...src.matchAll(/writeJsonAtomic\(REPORT_PATH, \{([\s\S]{0,60})/g)];
  assert.ok(writes.length >= 3, `expected the three write paths, found ${writes.length}`);
  for (const [, head] of writes) {
    assert.match(head, /\.\.\.prevFile/, `a write to the ledger drops what was already in it: ${head.trim().slice(0, 60)}`);
  }
});

/* ------------------------------------------------ never commit audio (hard) */

const ROOT = join(import.meta.dirname, "..", "..");
const git = (args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
const isRepo = (() => { try { git(["rev-parse", "--git-dir"]); return true; } catch { return false; } })();

test("the decode download dir is gitignored", { skip: !isRepo && "not a git checkout" }, () => {
  const probe = join(AUDIO_DIR, "probe.mp3");
  const out = git(["check-ignore", "-v", "--no-index", probe].map(String));
  assert.ok(out.length > 0, `${AUDIO_DIR} is not gitignored — a 95MB episode could be committed`);
  assert.ok(basename(AUDIO_DIR).length > 0);
});

test("the committed report carries no transcript text and no audio", { skip: !existsSync(REPORT_PATH) && "not measured yet" }, () => {
  const raw = readFileSync(REPORT_PATH, "utf8");
  const report = JSON.parse(raw);
  assert.ok(report.results.length > 0);
  for (const r of report.results) {
    // Cue COUNTS and boundary seconds, never cue text: the transcript is the
    // publisher's, it lives in gitignored data-local/, and only digests are
    // committed (#255). A verdict needs the numbers and nothing else.
    assert.equal(typeof r.transcript.cues, "number");
    assert.ok(!("text" in r.transcript), "cue text must never reach the committed report");
    assert.ok(VERDICTS.includes(r.comparison.verdict), `${r.id} carries an unknown verdict`);
    assert.ok(r.why_this_episode, `${r.id} does not say why this episode was the one downloaded`);

    /* AND IT MUST BE THE REASON THE SOURCE GIVES TODAY. A ledger whose prose
       has drifted from TARGETS is a ledger that answers a question the code no
       longer asks — which is exactly what happened to the Art Bell row. */
    const t = TARGETS.find((x) => x.id === r.id);
    assert.ok(t, `${r.id} is in the ledger but not in TARGETS`);
    assert.equal(r.question, t.question, `${r.id}: the ledger's question has drifted from its target`);
    assert.equal(r.why_this_episode, t.why, `${r.id}: the ledger's reason has drifted from its target`);
    assert.equal(r.diagnostic ?? false, t.diagnostic ?? false, `${r.id}: diagnostic flag drifted`);
  }
  assert.ok(raw.length < 200_000, "this ledger is a handful of rows; anything larger means episode data leaked in");
});
