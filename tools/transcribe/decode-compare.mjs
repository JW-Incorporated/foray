#!/usr/bin/env node
/* ADR-0008's instrument of last resort: download ONE episode, decode it, and
   compare its true duration against the transcript's last cue.
   ============================================================================

   WHY THIS EXISTS. `ad-inflation.mjs` asks a host for two bytes and reads the
   total out of `Content-Range`. That is the right screen and it is blind in
   three places this repo has now hit for real, each one worth thousands of
   transcripts:

     - NO DENOMINATOR. All seven `atelier.flightcast.com` shows -- 5,461 timed
       transcripts, 47% of the anchorable corpus -- publish `<enclosure>` with
       no `length` attribute, so `delivered / declared` has nothing to divide
       by. #321 fell back to repeating the request N times and comparing the
       totals against each other, which CONDEMNS on variance but cannot ACQUIT
       on stability: a stitcher that did not vary inside a cache window looks
       exactly like a static file. It filed the shows `unresolved` and said so.

     - A CONSTANT OFFSET IS AMBIGUOUS BY CONSTRUCTION. The Art Bell Archive
       delivers the same ~99KB more than it declares on every episode, over a
       4.6MB spread of episode sizes. ADR-0008 lists pre-roll-only as producing
       exactly a constant offset, and a fixed ID3v2 artwork block produces one
       too. The ratio cannot tell them apart. Nothing can, from outside the
       file.

     - A DECLARED LENGTH CAN SIMPLY BE WRONG. Around the House delivers a
       median 0.758 of its declaration -- a quarter FEWER bytes -- which
       `AD_FREE_FLOOR` correctly refuses to call clean and equally correctly
       refuses to call ads. #319 found an Enormocast episode declaring exactly
       5 MiB (`5242880`, a placeholder) while delivering 81MB, so "the feed's
       number is junk" is a live hypothesis in this corpus, not an excuse.

   In all three the missing piece is the same: a length nobody has to take on
   trust. Decoding produces one.

   THE COMPARISON IS AGAINST THE TRANSCRIPT, NOT AGAINST THE FEED, and that is
   the entire method rather than a detail. ADR-0008 records Radiolab decoding
   at 1989.4s against a declared 1745s -- 244s of pure metadata error on a file
   with no injection at all -- and warns to "cross-check against the publisher
   transcript's last cue before treating any single-source delta as ad load".
   Two of the three questions above are questions about whether the feed's own
   numbers are trustworthy, so answering them with the feed's own numbers would
   be circular. The transcript is the independent witness: it is the timeline a
   segment would actually be authored against, so "does the delivered audio
   match the transcript" IS the anchoring question, stated directly.

   WHAT THIS TOOL DOES NOT DO, and must never learn to. It does not detect,
   locate, classify or remove an advertisement (R11, product principle 3). It
   counts seconds of audio and compares them to seconds of transcript. When it
   reports `excess-audio` it is saying "this file contains more audio than the
   transcript describes" -- which could be ads, a longer outro, a bonus
   segment, or a different cut -- and the verdict vocabulary below is worded to
   keep that distinction visible. Whatever the extra seconds are, they are
   seconds our authored timestamps do not account for, and that is what makes a
   segment land in the wrong place.

   COST DISCIPLINE. Every other measurement in this repo is kilobytes. This one
   is a whole episode per answer, which is why it is a manual tool with no cron
   entry, why `--episode` takes exactly one episode, and why the downloads land
   in gitignored `data-local/` and are deleted by `--cleanup`. Do not point it
   at a back catalogue. If you find yourself wanting a sample of ten, the
   question you are asking is a screen question and `ad-inflation.mjs` is the
   tool for it.

   USAGE
     node tools/transcribe/decode-compare.mjs --list
     node tools/transcribe/decode-compare.mjs --episode flightcast-doac --python PATH
     node tools/transcribe/decode-compare.mjs --episode art-bell --keep
     node tools/transcribe/decode-compare.mjs --probe-grid --episode flightcast-doac
     node tools/transcribe/decode-compare.mjs --recompare
     node tools/transcribe/decode-compare.mjs --cleanup

   `--python` points at an interpreter with `av==18.0.0` installed (pinned in
   requirements.txt; `PYTHON` in the environment works too). The decode itself
   lives in `decode-duration.py` beside this file -- see its header for why
   three durations are read and why demux beats decode.                       */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, openSync, readSync, closeSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/* IMPORTED, NEVER RESTATED -- the eighth duplicated implementation is always
   one convenience away. `fetchEpisode` is the repo's enclosure downloader with
   its disk guard, resident-byte ledger, resume plan and per-host gate;
   `fetchBody` is the transcript fetcher, including `assertTranscriptTarget`,
   which refuses to let a transcript path fetch audio. `normalize` is the cue
   parser. `CONSTANT_OFFSET_TOLERANCE_BYTES` is the "same size on every
   episode" band `measure-suspects.mjs` already derives and tests, and it is
   the right band for asking whether a tag accounts for a byte gap -- a second
   copy of that number would be the fourth threshold in this repo to drift. */
import { fetchEpisode, cleanup, ROOT } from "./fetch-audio.mjs";
import { UA, AUDIO_UA, ACCEPT_LANGUAGE, awaitHostSlot } from "../segments/politeness.mjs";
import { fetchBody, assertTranscriptTarget, spanImplausible } from "../segments/fetch-transcripts.mjs";
import { normalize } from "../segments/transcript-normalize.mjs";
import { CONSTANT_OFFSET_TOLERANCE_BYTES } from "../segments/measure-suspects.mjs";
import { parseContentRangeTotal } from "./ad-inflation.mjs";
import { writeJsonAtomic } from "../segments/sweep-transcripts.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Downloads land here and are deleted again. `data-local/` is gitignored and
    already holds 7.7GB of corpus working files, so a forgotten episode is
    merely untidy rather than a commit. Kept OUT of `audio-cache/` on purpose:
    that directory belongs to the transcription pipeline's checkpoint ledger,
    and a decode probe resuming somebody else's half-downloaded episode -- or
    being cleaned up by their run -- is a confusing failure to debug. */
export const AUDIO_DIR = join(ROOT, "data-local", "decode-audio");

/** Where the decode ledger is committed. Small by construction: a handful of
    rows, no episode text, no bytes. */
export const REPORT_PATH = join(ROOT, "data", "decode-and-compare.json");

export const DECODER = join(HERE, "decode-duration.py");

/* ------------------------------------------------------------ ID3v2 parsing */

/** ID3v2's syncsafe integer: four bytes, seven bits each, high bit always
    clear so a tag length can never contain a byte sequence a decoder would
    mistake for an MPEG frame sync.

    Returns null when any high bit IS set, which is not pedantry: that is
    precisely the signal that these four bytes are not a syncsafe size, so
    treating them as one would produce a confident, wrong tag length. Null
    means "this is not a tag header", and the caller reports zero rather than
    a guess. */
export function syncsafeSize(b0, b1, b2, b3) {
  for (const b of [b0, b1, b2, b3]) {
    if (!Number.isInteger(b) || b < 0 || b > 0xff) return null;
    if (b & 0x80) return null;
  }
  return (b0 << 21) | (b1 << 14) | (b2 << 7) | b3;
}

/** Total bytes of a leading ID3v2 tag, or 0 when the file does not start with
    one.

    THIS IS THE ART BELL DISCRIMINATOR and it is exact, not a threshold. The
    question there is whether ~99,345 constant bytes are a metadata block or a
    house pre-roll, and the two live on opposite sides of the first audio
    frame: a tag is counted here and is not audio; a pre-roll is audio and is
    not counted here. `decode-duration.py` reports the same boundary
    independently as `first_packet_pos`, and the two are compared rather than
    either being trusted -- one reads the tag's own declaration, the other
    reads where the demuxer actually found frames, and a disagreement means
    something is prepending bytes that are neither.

    The 10-byte footer flag (0x10) is included because ID3v2.4 permits a footer
    and its bytes sit between the tag and the audio like the rest of it. */
export function id3v2TagBytes(head) {
  if (!head || head.length < 10) return 0;
  const at = (i) => (typeof head[i] === "number" ? head[i] : null);
  if (at(0) !== 0x49 || at(1) !== 0x44 || at(2) !== 0x33) return 0;   // "ID3"
  const major = at(3);
  /* ID3v2.2, .3 and .4 are the versions that exist. The spec only forbids 0xFF
     in the two version bytes, and an earlier draft checked no more than that --
     so a stray 0x63 would have parsed as a tag and had its "length" subtracted
     from the file size. Accepting only what exists is the cheaper failure. */
  if (major === null || major < 2 || major > 4 || at(4) === 0xff) return 0;
  const flags = at(5);
  const size = syncsafeSize(at(6), at(7), at(8), at(9));
  if (size === null || flags === null) return 0;
  const footer = flags & 0x10 ? 10 : 0;
  return 10 + size + footer;
}

/** Do the two independent readings of "where does the audio start" agree?

    THEY DO NOT AGREE EXACTLY, AND THE REASON IS NOT AN ERROR. Measured on a
    synthetic 96kbps MP3 built for this check: `id3v2TagBytes` read 45 and
    PyAV's `first_packet_pos` read 358. The 313-byte difference is exactly one
    MPEG frame at that bitrate (96000 / 8 x 1152 / 44100 = 313.4), and it is
    the Xing/LAME header frame — a real, well-formed MPEG frame carrying a
    duration table instead of audio, which FFmpeg's demuxer consumes as a
    header and never emits as a packet. So the honest statement is that the two
    readings agree to within one frame, and pretending they agree to the byte
    would make this check fail on every file an ordinary encoder produced.

    THE BAND IS `CONSTANT_OFFSET_TOLERANCE_BYTES` (1024), IMPORTED, and it
    comfortably covers one frame at every bitrate in this corpus: 313 bytes at
    96kbps, 418 at 128, 626 at 192. It is also nowhere near the quantity being
    tested — the Art Bell gap is 99,345 bytes, ~97x the band — so this check
    separates "the lead-in is a metadata tag" from "the lead-in is 16 seconds
    of audio" with two orders of magnitude to spare. `lead_in_unaccounted_bytes`
    is published beside it so the frame is visible rather than absorbed. */
export function tagBoundaryAgrees(firstPacketPos, tagBytes) {
  if (!Number.isFinite(firstPacketPos) || !Number.isFinite(tagBytes) || tagBytes <= 0) return null;
  return Math.abs(firstPacketPos - tagBytes) <= CONSTANT_OFFSET_TOLERANCE_BYTES;
}

/** The first 10 bytes of a file, for the parser above. Read rather than
    slurped: these files are 20-95MB and only the header is wanted. */
export function readHead(path, bytes = 10) {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

/* ------------------------------------------------------- choosing a duration */

/** How far the two FRAME-DERIVED durations may disagree before the
    measurement is refused rather than reported.

    ONE SECOND, and it is tight because these two are counted over the same
    demux pass by different arithmetic -- summed packet durations against
    frame count x frame geometry -- so on any file whose frames all share one
    geometry they agree to the millisecond. Measured: 5740.3820408163265 from
    both routes on the DOAC episode, 2509.3224489795916 from both on The Secret
    To Success. They come apart when the frames DO NOT share one geometry,
    which is a concatenation of differently-encoded parts, and that is a reason
    to stop rather than to average. */
export const DURATION_AGREEMENT_SEC = 1.0;

/** The duration to trust, and the two readings it is chosen between.

    THE CONTAINER'S OWN DURATION IS NOT ONE OF THEM, and an earlier version of
    this function treated it as a third vote. That was wrong twice over, and
    the measurements that showed it are worth keeping:

      1. IT IS A CLAIM, NOT A COUNT. For an MP3 it comes from the Xing/LAME
         header -- a number the encoder (or whatever last rewrote the file)
         asserts. This entire tool exists because declared numbers in this
         corpus are unreliable, so seating one on the jury was incoherent.
         Measured: flightcast's Xing headers over-declare on BOTH a clean file
         and an inserting one -- +3.76s on The Secret To Success, whose frames
         match its feed duration to 0.32s, and +8.41s on the DOAC episode. A
         1-second agreement band therefore refused to answer for a file that
         was in perfect order, which is a false `undecidable` on the exact
         question the download was bought to settle.

      2. WHERE THERE IS NO XING HEADER IT IS CIRCULAR. FFmpeg then derives the
         duration from (file size - tags) x 8 / bitrate, i.e. it restates the
         byte count. Three of this tool's four questions are "do the delivered
         bytes carry more audio than the transcript describes", and a duration
         computed out of the delivered bytes cannot answer that -- it would
         report "consistent" for a file with an hour of ads in it.

    So the header is REPORTED beside the measurement as `header_claimed_sec`
    and never gates anything. Its delta against the frames is published too:
    on a stitched file it is one of the few visible traces that the artifact
    was assembled after its header was written. */
export function chooseDuration(decode) {
  const candidates = [
    ["packet_duration_sec", decode?.packet_duration_sec],
    ["frame_geometry_sec", decode?.frame_geometry_sec],
  ].filter(([, v]) => Number.isFinite(v) && v > 0);

  const claimed = Number.isFinite(decode?.container_duration_sec) ? decode.container_duration_sec : null;

  if (!candidates.length) {
    return { sec: null, source: null, spread_sec: null, agrees: false, header_claimed_sec: claimed, header_delta_sec: null };
  }

  const values = candidates.map(([, v]) => v);
  const spread = Math.max(...values) - Math.min(...values);
  const [source, sec] = candidates[0];
  return {
    sec,
    source,
    spread_sec: candidates.length >= 2 ? Number(spread.toFixed(3)) : null,
    /* TWO READINGS OR NONE. With a single finite candidate the spread is
       trivially zero, and an earlier version reported that as agreement -- so a
       full verdict could be issued from one unverified number, against this
       tool's own doctrine that "two numbers that agree are a measurement while
       one number is a hope". It is reachable rather than theoretical:
       `frame_geometry_sec` is null whenever the codec context never populates
       `frame_size`, which is ordinary for AAC/M4A enclosures. */
    agrees: candidates.length >= 2 && spread <= DURATION_AGREEMENT_SEC,
    header_claimed_sec: claimed,
    header_delta_sec: claimed === null ? null : Number((claimed - sec).toFixed(3)),
  };
}

/* ---------------------------------------------------------- the comparison */

/** Audio beyond the transcript's last cue that an ordinary outro explains, so
    that this tool does not report a theme tune as unexplained audio.

    THIRTY SECONDS, TAKEN FROM THIS REPO'S OWN MEASUREMENTS RATHER THAN
    INVENTED. It is the smallest ad slot anybody here has actually observed:
    `measure-suspects.mjs` records all five Spreaker shows inserting in
    "discrete ~30 s slots", with Sasquatch Experience's creatives measured at
    420,937 and 422,034 bytes at 112kbps -- 30 s either way -- and The WWE
    Podcast's at 481,071 bytes. `AD_FREE_THRESHOLD`'s own docstring reasons in
    the same unit ("not even a 30-second pre-roll"). So below this figure no
    pod that this corpus has ever produced would fit, and above it at least one
    would.

    IT IS A RESOLUTION LIMIT, NOT A CLEAN BILL, and the report says so in the
    row rather than leaving it to be inferred: `beyond_transcript_sec` is
    always published, so a reader can see 4s and 29s are not the same answer
    even though both pass. Do not raise it to make a show pass. It is NOT
    `ANCHOR_TIME_TOLERANCE_SEC` (120s, the pad ceiling) and must not drift into
    it -- that constant bounds how far a segment may be displaced and still be
    worth playing, which is a different question with a different answer. */
export const TRAILING_ALLOWANCE_SEC = 30;

/** The four things a decode can find. Deliberately NOT two.

    `matches-transcript`  the delivered audio is the audio the transcript
                          describes, within the allowance above. This is the
                          only verdict that admits a show.
    `excess-audio`        the file carries materially more audio than the
                          transcript accounts for. Not a claim about ads -- see
                          this file's header -- but the timestamps are wrong by
                          that much either way.
    `short-of-transcript` the file is materially SHORTER than the transcript's
                          span, i.e. we are receiving a copy the publisher's
                          timeline does not describe. `AD_FREE_FLOOR` already
                          treats the byte version of this as disqualifying "for
                          exactly the reason injection does".
    `undecidable`         an input was missing, or the frame-derived durations
                          disagreed, or there was only one of them. Says
                          nothing, and must never be read as either of the first
                          two. */
export const VERDICTS = Object.freeze([
  "matches-transcript",
  "excess-audio",
  "short-of-transcript",
  "undecidable",
]);

/** The whole comparison, pure, so the arithmetic is testable without a network
    or a Python interpreter. Every field it returns is published in the report:
    a verdict whose numbers are not visible is a verdict nobody can check. */
export function compareDecode({
  decoded_sec = null,
  duration_agrees = true,
  last_cue_sec = null,
  feed_duration_sec = null,
  declared_bytes = null,
  delivered_bytes = null,
  tag_bytes = 0,
  allowance_sec = TRAILING_ALLOWANCE_SEC,
} = {}) {
  const num = (v) => (Number.isFinite(v) ? v : null);
  const round = (v) => (Number.isFinite(v) ? Number(v.toFixed(2)) : null);

  const decoded = num(decoded_sec);
  const lastCue = num(last_cue_sec);
  const feedDur = num(feed_duration_sec);
  const declared = num(declared_bytes);
  const delivered = num(delivered_bytes);
  const tag = Number.isFinite(tag_bytes) && tag_bytes > 0 ? tag_bytes : 0;

  const audioBytes = delivered === null ? null : delivered - tag;
  const bitrate =
    audioBytes !== null && decoded !== null && decoded > 0
      ? Math.round((audioBytes * 8) / decoded)
      : null;

  const gapBytes = declared !== null && delivered !== null ? delivered - declared : null;
  /* Does the non-audio tag account for the whole declared/delivered gap? When
     it does, the gap is metadata and the delta in SECONDS is zero -- which is
     the Art Bell question answered exactly, with no threshold in seconds
     anywhere near it. Uses the same band `measure-suspects.mjs` uses to call
     an offset constant across episodes. */
  const gapExplainedByTag =
    gapBytes === null || gapBytes === 0 || tag === 0
      ? null
      : Math.abs(gapBytes - tag) <= CONSTANT_OFFSET_TOLERANCE_BYTES;

  const beyondTranscript = decoded !== null && lastCue !== null ? decoded - lastCue : null;
  const beyondFeed = decoded !== null && feedDur !== null ? decoded - feedDur : null;

  let verdict = "undecidable";
  let reason = null;

  if (decoded === null) {
    reason = "the file produced no usable duration";
  } else if (!duration_agrees) {
    reason =
      "the frame-derived duration readings did not agree within " +
      `${DURATION_AGREEMENT_SEC}s, or only one of them existed — so none of them is being trusted`;
  } else if (lastCue === null) {
    reason = "no transcript cue to compare against, which is the only comparison this tool makes";
  } else if (beyondTranscript < -allowance_sec) {
    verdict = "short-of-transcript";
    reason =
      `decoded ${round(decoded)}s is ${round(-beyondTranscript)}s SHORTER than the transcript's ` +
      `last cue at ${round(lastCue)}s — the publisher's timeline describes a copy we are not receiving`;
  } else if (beyondTranscript > allowance_sec) {
    verdict = "excess-audio";
    reason =
      `decoded ${round(decoded)}s runs ${round(beyondTranscript)}s past the transcript's last cue ` +
      `at ${round(lastCue)}s, which is more than the ${allowance_sec}s an outro explains`;
  } else {
    verdict = "matches-transcript";
    reason =
      `decoded ${round(decoded)}s against a last cue at ${round(lastCue)}s — ` +
      `${round(beyondTranscript)}s of trailing audio, inside the ${allowance_sec}s allowance`;
  }

  return {
    verdict,
    reason,
    decoded_sec: round(decoded),
    last_cue_sec: round(lastCue),
    feed_duration_sec: feedDur,
    beyond_transcript_sec: round(beyondTranscript),
    beyond_feed_sec: round(beyondFeed),
    declared_bytes: declared,
    delivered_bytes: delivered,
    tag_bytes: tag,
    audio_bytes: audioBytes,
    gap_bytes: gapBytes,
    gap_explained_by_tag: gapExplainedByTag,
    implied_bitrate_bps: bitrate,
    allowance_sec,
  };
}

/* THE SCREEN THAT WAS PLANNED HERE, AND WHY IT IS NOT.

   The original design carried a `bitrateResidualSec` helper: once one episode
   is decoded and the encode is known to be constant-bitrate, `bytes x 8 /
   bitrate` turns every ALREADY-MEASURED delivered byte count into a duration,
   which against `itunes:duration` is the denominator the flightcast feeds never
   published. It would have let one download speak, as a screen, about
   thirty-four episodes nobody downloaded. It was written and unit-tested.

   THE FIRST DOWNLOAD FALSIFIED IT, so it has been deleted rather than shipped
   dark. The screen consumes the byte counts `ad-inflation.mjs` collected, and
   on `atelier.flightcast.com` those are the master's length rather than the
   delivery -- so it read a residual of -0.4s to +3.3s across all 35 flightcast
   samples, including the five belonging to the episode measured carrying
   114.4s of undeclared audio. An instrument that returns "clean" for the one
   case we can independently prove dirty is not a screen; it is a way of
   restating the lie in seconds. Keeping it exported and unused would have been
   worse than either shipping or deleting it: a future reader would have wired
   it up on the strength of its tests.

   What replaced it is nothing. Five of the seven flightcast shows are
   `unresolved` and the only instrument that can settle them is another
   download -- see HUMAN-ACTIONS.md item 24, which is a founder's call about
   bandwidth and not a gap to be filled with arithmetic. */

/* ------------------------------------------------------------------- the io */

/** Four cheap requests that ask an origin how big one file is, four ways.

    WHY THIS IS A COMMITTED MODE AND NOT AN AD-HOC SCRIPT. The most consequential
    claim this tool makes -- that a 2-byte ranged GET reports a length the origin
    does not deliver -- was first established by hand, and a reviewer correctly
    refused it: an assertion whose evidence exists in no artifact is exactly what
    ADR-0008's workflow note forbids, and it is the same objection that had
    already been raised against the Gastropod numbers living in a PR comment.
    Four requests, ~4 bytes of body, and the answer is committed.

    THE FOUR CELLS, and the grid is the point rather than any one number. The two
    axes are the ones that can change what a CDN assembles: whether the request
    carries a `Range`, and which identity it announces. This repo has already
    MEASURED the second axis mattering -- `politeness.mjs` records a Buzzsprout
    edge answering 403 to one product token and 206 to another, reproducible both
    ways -- so a length difference observed under only one identity proves much
    less than it appears to.

    NOTHING HERE READS A BODY. The unranged calls are aborted the moment their
    headers arrive, so this mode costs the four range bytes and no audio. */
export async function probeGrid(target, { fetchImpl = fetch, sleep = null } = {}) {
  const url = target.audio_url;
  const cells = [];
  for (const [identity, ua] of [["probe", AUDIO_UA], ["client", UA]]) {
    for (const ranged of [true, false]) {
      if (sleep) await sleep(url);
      else await awaitHostSlot(url);
      const headers = { "user-agent": ua, "accept-language": ACCEPT_LANGUAGE, ...(ranged ? { range: "bytes=0-1" } : {}) };
      const res = await fetchImpl(url, { headers, redirect: "follow" });
      /* `Number(null)` IS 0, AND 0 IS FINITE. Read the header first and check
         it exists, because the unranged arm is the one that produces this
         mode's headline: an origin that sends no `Content-Length` at all
         (chunked, or plenty of HTTP/2 origins) would otherwise record `total:
         0`, land in `distinct_totals`, and manufacture "two different lengths
         for one URL" out of a missing header. The ranged arm was already safe
         -- `parseContentRangeTotal` returns null on anything it cannot parse. */
      const rawLength = res.headers.get("content-length");
      const total = ranged
        ? parseContentRangeTotal(res.headers.get("content-range"))
        : rawLength === null || rawLength === "" || !Number.isFinite(Number(rawLength))
          ? null
          : Number(rawLength);
      cells.push({
        identity,
        ranged,
        status: res.status,
        total: Number.isFinite(total) ? total : null,
        content_encoding: res.headers.get("content-encoding"),
        transfer_encoding: res.headers.get("transfer-encoding"),
        resolved_host: (() => { try { return new URL(res.url).host; } catch { return null; } })(),
      });
      if (ranged) await res.arrayBuffer().catch(() => {});
      else res.body?.cancel?.().catch?.(() => {});
    }
  }
  const totals = [...new Set(cells.map((c) => c.total).filter((n) => Number.isFinite(n)))];
  return {
    url,
    checked_at: new Date().toISOString(),
    cells,
    distinct_totals: totals.sort((a, b) => a - b),
    /* THE HEADLINE. Two different lengths for one URL, differing only in how it
       was asked, is the same evidence `varyingSamples` treats as PROOF rather
       than as a threshold: two totals mean two resources, and a file assembled
       per request is what dynamic insertion IS. Reported, never gated on --
       what acts on it is `decodeUnderreports`, from the delivered bytes. */
    varies_by_request: totals.length > 1,
    compressed: cells.some((c) => c.content_encoding),
  };
}

/** Cues from a transcript URL, using the repo's transcript fetcher and the
    repo's normaliser. `assertTranscriptTarget` is called first and on purpose:
    it is the guard that stops a transcript path being pointed at an enclosure,
    and this file is the one place in the repo that legitimately holds both
    kinds of URL at once, which is exactly where that mistake would happen. */
export async function transcriptCues(target, { fetchImpl = fetch } = {}) {
  /* `enclosure_url` IS SUPPLIED DELIBERATELY, and the line is load-bearing.
     `assertTranscriptTarget` is an EQUALITY interlock: it throws when
     `transcript_url === enclosure_url`, i.e. when a transcript fetch is about
     to request the audio. A caller that hands it an object with no
     `enclosure_url` gets a guard that cannot fire — it returns the URL and
     looks like it checked. The target rows in this file carry the enclosure
     under `audio_url`, so without this mapping the one interlock that matters
     in the one file holding both kinds of URL would have been silently inert.
     It is renamed here rather than in TARGETS because `audio_url` is the name
     `fetchEpisode` reads, and having the enclosure under two names on one
     object is how the two would drift apart. */
  const checked = {
    guid: target.guid,
    transcript_url: target.transcript_url,
    enclosure_url: target.enclosure_url ?? target.audio_url ?? null,
    duration_sec: target.duration_sec,
  };
  assertTranscriptTarget(checked);
  const { text, content_type } = await fetchBody(checked.transcript_url, { fetchImpl });
  const { cues, warnings } = normalize(text, content_type || target.transcript_type);
  const last = cues.length ? cues[cues.length - 1].end_sec : null;
  return {
    cues: cues.length,
    first_cue_sec: cues.length ? cues[0].start_sec : null,
    last_cue_sec: last,
    span_implausible: spanImplausible(last, target.duration_sec),
    bytes: Buffer.byteLength(String(text || ""), "utf8"),
    warnings,
  };
}

/** Run the PyAV probe on a file already on disk. */
export function decodeFile(path, { python = process.env.PYTHON || "python", run = execFileSync } = {}) {
  /* THE DECODER EXITS NON-ZERO WHENEVER ITS REPORT CARRIES AN `error` KEY, so
     `execFileSync` throws before anything here can read the message -- which
     made `runTarget`'s "decode failed for X: <reason>" branch unreachable and
     handed the operator a generic child-process failure instead of "no audio
     stream". The JSON is on stdout either way, so read it off the thrown
     error and re-raise with the reason the decoder actually gave. */
  try {
    return JSON.parse(run(python, [DECODER, path], { encoding: "utf8", maxBuffer: 1 << 22 }));
  } catch (e) {
    const out = typeof e?.stdout === "string" ? e.stdout : null;
    if (out) {
      try {
        const parsed = JSON.parse(out);
        if (parsed && parsed.error) return parsed;
      } catch {
        /* not JSON — fall through to the original failure, which is the honest
           one: the interpreter itself did not run. */
      }
    }
    throw e;
  }
}

/* --------------------------------------------------------------- the targets

   ONE ROW PER QUESTION, and the list is the cost control. ADR-0008's method is
   affordable exactly because it is aimed: each entry below names the single
   episode whose decode settles one open question, with the reason it and not
   another episode of the same show. Adding a row costs a full download, so
   adding one should feel like a decision.                                    */

export const TARGETS = Object.freeze([
  {
    id: "flightcast-doac",
    question: "flightcast: is the byte-stable, length-less enclosure a static file or an unvaried stitch?",
    show_id: "1291423644",
    show: "The Diary Of A CEO with Steven Bartlett",
    guid: "flightcast:01M011YXPMA7EXR82JB7CMWHJN",
    episode: "Financial Crash Expert: He Predicted The 2008 Crash, Now He Says Capitalism Failed, It's Too Late!",
    audio_url:
      "https://pdst.fm/e/pscrb.fm/rss/p/mgln.ai/e/1390/claritaspod.com/measure/p.podderapp.com/2544644999/mgln.ai/e/1651/episode.flightcast.com/01M011YXPMDDJ8TWA1RB7X36R7.mp3?fcv=zvf5r7i63yvx7ohhgxyiv4jz",
    transcript_url: "https://rss.flightcast.com/transcripts/01M011YXPMDDJ8TWA1RB7X36R7.vtt",
    transcript_type: "text/vtt",
    duration_sec: 5626,
    declared_bytes: null,
    delivered_bytes: 67510022,
    /* TRUE, WHICH ARMS SOMETHING. `fetchEpisode` passes this to
       `verifyResumeResponse`, whose DAI branch refuses to append to a partial
       file when the identity may have changed -- i.e. the anti-splice guard
       that stops a resumed download stitching two different assemblies
       together. Left null it is not armed, which is exactly backwards for the
       one host in this list measured assembling per request. */
    dai_suspected: true,
    /* WHY THIS EPISODE AND NOT ONE OF THE OTHER 34 PROBED.

       WHY THIS SHOW. The seven flightcast shows share one origin, and six of
       them reach it through one or two hops. This one reaches it through SIX
       ad-tech hosts -- pdst.fm, pscrb.fm, mgln.ai (twice), claritaspod.com,
       p.podderapp.com -- which is the longest monetisation chain in the pool
       and, in a corpus where chart rank predicts injection (ADR-0008 §5.2,
       p<0.01), by a distance the most commercially exploited show in it. It is
       therefore the flightcast show most likely to be carrying an insert, and
       a clean result on the hardest case is worth more than a clean result on
       an easy one. It also spreads the test across two mechanisms rather than
       one: a clean decode here rules out both a flightcast-origin stitch and a
       prefix-host stitch, and only this row's chain can test the second.

       NOT chosen for transcript count, which would have picked Success Story
       (1,264 against this show's 141). That would optimise the wrong thing: a
       single decode licenses one show either way, so the tie-break is which
       show's answer is worth the most, and a NEGATIVE result on the likeliest
       suspect is worth more than a negative on an unlikely one.

       AN EARLIER VERSION OF THIS COMMENT JUSTIFIED IT DIFFERENTLY AND WAS
       WRONG, which is worth leaving in: it argued that what reaches the other
       six shows is a bitrate screen this decode would CALIBRATE. That screen
       was written, and the decode falsified it before it shipped -- see the
       block above `transcriptCues`. Nothing reaches the other six. They need
       their own downloads.

       WHY THIS EPISODE. A full-length interview (93.8 min) rather than one of
       the show's short "Most Replayed Moment" cuts: mid-rolls need an episode
       long enough to hold them, and a 26-minute clip failing to contain a pod
       proves much less. It is the leanest of the show's three full episodes at
       67.5MB against 94.5 and 94.9, which is 27MB of politeness for nothing
       given up. */
    why: "longest ad-tech redirect chain in the flightcast pool (6 hops); leanest full-length episode of that show",
  },
  {
    id: "flightcast-doac-origin",
    question:
      "flightcast: the SAME DOAC episode fetched from the bare origin — do the extra 1,374,876 bytes " +
      "come from the flightcast origin or from the six ad-tech hops in front of it?",
    show_id: "1291423644",
    show: "The Diary Of A CEO with Steven Bartlett",
    guid: "flightcast:01M011YXPMA7EXR82JB7CMWHJN",
    episode: "Financial Crash Expert: He Predicted The 2008 Crash, Now He Says Capitalism Failed, It's Too Late!",
    /* THE ONLY ROW HERE THAT IS NOT THE PUBLISHER'S DECLARED ENCLOSURE URL, and
       the deviation is the measurement. Corner case #1 says we always fetch the
       declared URL and never substitute a resolved one — `flightcast-doac`
       above obeys that and is what a listener receives. This row deliberately
       breaks it in a controlled way, because the ONLY way to ask "which hop
       adds the bytes" is to remove the hops and re-ask. It is a diagnostic, not
       a fetch path, and nothing downstream may use this URL for anything. */
    audio_url: "https://episode.flightcast.com/01M011YXPMDDJ8TWA1RB7X36R7.mp3",
    /* AND THIS FLAG IS WHAT ENFORCES THE SENTENCE ABOVE. `decodeIndex` keys on
       `show_id`, so without it this row -- fetched from a URL the publisher
       never declared -- sits in the same bucket as the real one and is eligible
       to CONDEMN or ACQUIT the show. Both DOAC rows happen to agree today, so
       there is no live harm; had the bare-origin fetch come back clean it could
       have acquitted a show whose DECLARED url delivers 114s of undeclared
       audio. A comment saying "nothing downstream may use this" is not a
       mechanism, and a reviewer was right to say so. */
    diagnostic: true,
    transcript_url: "https://rss.flightcast.com/transcripts/01M011YXPMDDJ8TWA1RB7X36R7.vtt",
    transcript_type: "text/vtt",
    duration_sec: 5626,
    declared_bytes: null,
    delivered_bytes: 67510022,
    /* TRUE, WHICH ARMS SOMETHING. `fetchEpisode` passes this to
       `verifyResumeResponse`, whose DAI branch refuses to append to a partial
       file when the identity may have changed -- i.e. the anti-splice guard
       that stops a resumed download stitching two different assemblies
       together. Left null it is not armed, which is exactly backwards for the
       one host in this list measured assembling per request. */
    dai_suspected: true,
    /* WHY IT IS WORTH A FIFTH DOWNLOAD. `flightcast-bare` already showed a
       flightcast show with no ad-tech prefix delivering exactly what it
       declares — but it is a DIFFERENT SHOW, so the A/B carries a confound:
       the honest reading of those two rows alone is "one show is clean and
       another is not", which is where `_adswizz_note` says to stop. Fetching
       THIS episode — same guid, same origin object, same transcript — with the
       prefixes stripped removes the confound entirely. Whatever differs
       between this row and `flightcast-doac` is the chain and nothing else.

       What it decides is the size of the finding: an origin that
       under-declares puts all seven flightcast shows and 5,461 transcripts
       behind the same blind instrument, while a prefix that inserts is a fact
       about one show's monetisation and leaves the other six untouched. That
       is the difference between 141 transcripts and 5,461, which is worth 67MB
       of somebody's bandwidth exactly once. */
    why: "the flightcast-doac episode with its six ad-tech hops removed — isolates chain from origin with the show held constant",
  },
  {
    id: "flightcast-bare",
    question:
      "flightcast: does the origin under-declare its own length for a show with NO ad-tech prefix, " +
      "or was that a property of the six-hop chain?",
    show_id: "844102142",
    show: "The Secret To Success with CJ, Karl, Jemal & Eric Thomas",
    guid: "flightcast:01KY03B0FNC3GJZAA2AE4GNMVY",
    episode: "Prayed About It But Still Stuck? Here's Why | S2S 551",
    audio_url: "https://episode.flightcast.com/01KY03B0FNFNM0K1G6HHVM1QZT.mp3",
    transcript_url: "https://rss.flightcast.com/transcripts/01KY03B0FNFNM0K1G6HHVM1QZT.vtt",
    transcript_type: "text/vtt",
    duration_sec: 2509,
    declared_bytes: null,
    delivered_bytes: 30112183,
    dai_suspected: true,   // same origin as the row above; see its note
    /* THIS ROW WAS NOT PLANNED. It was added after the `flightcast-doac`
       download came back 1,374,876 bytes LARGER than the length the origin
       declares -- reproducibly, on two clean unranged GETs, against a
       `Content-Range` total that eight repeat probes agreed was 67,510,022.
       That is the "HEAD requests lie" failure ADR-0008 documents, reappearing
       on the RANGED GET this repo adopted specifically because HEAD lied, and
       it is worth a fourth download because of what it leaves open rather than
       what it settles.

       WHAT IT SEPARATES, and it is the difference between 141 transcripts and
       5,461. The DOAC enclosure reaches flightcast through SIX ad-tech hosts,
       any of which could be the thing rewriting a length. This show reaches
       the same origin through `episode.flightcast.com` -> `atelier.flightcast.com`
       and NOTHING ELSE -- no tracker, no prefix, no measurement host. If a
       bare chain under-declares too, the behaviour belongs to the flightcast
       origin and the instrument is blind on all seven shows. If it does not,
       the finding is about one chain and the other six shows are untouched by
       it.

       A REVIEWER POINTED OUT THIS WAS PARTLY ANSWERABLE FOR FREE, and they were
       right: `flightcast-doac`'s own row records `resolved_host:
       "atelier.flightcast.com"`, so the body already came from the origin and
       the six prefixes were pure redirectors. What that field cannot rule out
       is a prefix altering the REQUEST -- a header, a query parameter -- in a
       way the origin then keys on, which is exactly the mechanism
       `probeGrid` went on to find (the origin serves a longer file to an
       unranged request from a client identity). So the row is still worth its
       bytes, and it is worth less than the comment originally claimed.

       Deliberately the cheapest full-length episode that can answer it: 30MB,
       42 minutes -- long enough to hold mid-rolls, which the show's shorter
       cuts are not. */
    why: "same flightcast origin reached through a chain with NO ad-tech prefix — separates an origin-level under-declaration from a prefix-level one",
  },
  {
    id: "art-bell",
    question:
      "Art Bell: is the constant ~99KB gap an ID3 artwork block or a fixed house pre-roll? " +
      "(UNANSWERABLE as of 2026-08-23 — that copy is no longer served; see the note below for what this row does settle)",
    show_id: "1737303645",
    show: "The Art Bell Archive",
    guid: "https://artbellarchive.org/episode/october-16-2015-open-lines-super-power-line",
    episode: "October 16, 2015: Open Lines - Super Power Line",
    audio_url: "https://audio.artbell.am/episodes/2015/1365-october-16-2015-open-lines-super-power-line.mp3",
    transcript_url:
      "https://artbellarchive.org/transcript/1365_2015-10-16_OpenLinesSuperPowerLine-MidnightInTheDesert.srt",
    transcript_type: "text/vtt",
    duration_sec: 8625,
    declared_bytes: 51890380,
    /* TODAY'S PROBE FIGURE, and the change is the finding. The 2026-08-23 scan
       recorded 51,989,683 here -- 99,303 bytes more than the declaration, on
       all five episodes, which is why this row exists at all. A re-probe
       through `measure-suspects.mjs --reprobe` on 2026-08-23 returned the
       declared length EXACTLY on all five (committed in
       `data/breadth-anchorable-inflation.json`, `source.passes`), and the
       enclosure now 307-redirects to an archive.org master that the earlier
       run's `resolved_chain` shows it was not reaching. The superseded figure
       is kept in this comment rather than in the field because the field's job
       is to say what the cheap instrument reports NOW, so that
       `probeCorroborated` compares two readings of the same object. */
    delivered_bytes: 51890380,
    dai_suspected: false,
    /* WHY THIS EPISODE. The gap is the SAME on all five probed episodes
       (+99,324 / +99,387 / +99,331 / +99,303 / +99,319 over a 4.6MB spread of
       episode sizes), so no episode is more informative than another about it
       -- which makes the cheapest one the right one, and this is the smallest
       file of the five at 51.99MB. Deliberately not dressed up as a deeper
       reason than that: when the candidates are interchangeable, spend less.

       THE QUESTION IN THE `question` FIELD IS NO LONGER ANSWERABLE, AND THE ROW
       SAYS SO RATHER THAN PRETENDING OTHERWISE. The plan was to decide artwork
       vs pre-roll on the tag boundary, read twice and independently --
       `id3v2TagBytes` off the file header and `first_packet_pos` out of the
       demuxer -- because metadata and a pre-roll sit on opposite sides of the
       first audio frame. That test ran and came back `id3v2_tag_bytes: 2048`:
       a 2KB tag, which does NOT account for 99,345 bytes and is evidence
       against the artwork hypothesis rather than for it.

       The reason it cannot decide is that the artifact is gone. The enclosure
       now 307-redirects to an archive.org master that delivers its declared
       length exactly, and a re-probe of all five episodes through
       `measure-suspects.mjs --reprobe` returns +0 bytes on every one. The copy
       carrying the ~99KB was being served by `audio.artbell.am` itself: the
       row as committed at parent `cc9f11a` records `resolved_chain:
       ["audio.artbell.am"]`, with no archive.org hop, where the re-probed row
       in this change records
       `["audio.artbell.am","archive.org","dn601202.us.archive.org"]`. That
       evidence now lives ONLY in the parent commit, because the re-probe
       overwrote the row -- so the claim is cited to `cc9f11a` rather than to
       the file beside it. Nobody can decode a file that is no longer served.

       SO WHAT THIS ROW ACTUALLY ESTABLISHES is the narrower and more useful
       thing: the file a listener receives TODAY carries no audio its transcript
       does not describe (0.09s past a last cue that spans the full declared
       duration), and both instruments now agree about its size. That is what
       anchoring needs. It is not an answer to "what were those bytes"; that
       answer is unrecoverable and the row must not be read as supplying one. */
    why: "smallest of the five episodes that carried the identical constant gap; establishes that the copy served today matches its transcript, not what the withdrawn copy contained",
  },
  {
    id: "around-the-house",
    question: "Around the House: is a 0.758 delivered/declared ratio a truncated file or a junk declaration?",
    show_id: "around-the-house-eric-g",
    show: "Around the House with Eric G",
    guid: "b9167a1a-77a9-41e1-9cfc-804f0571f6b8",
    episode: "From Drips to Disasters: Stop Water Damage Before It Starts!",
    audio_url: "https://episodes.captivate.fm/episode/b9167a1a-77a9-41e1-9cfc-804f0571f6b8.mp3",
    transcript_url: "https://transcripts.captivate.fm/transcript/494313ce-0f33-405f-8de8-6f5b1c15f138/transcript.srt",
    transcript_type: "application/srt",
    duration_sec: 2280,
    declared_bytes: 54729590,
    delivered_bytes: 41493310,
    dai_suspected: true,
    /* WHY THIS EPISODE. It is the median: 0.758 is the show's median ratio and
       this is the episode that produced it, so a verdict here is a verdict
       about the number the ticket is actually asking about.

       AND ITS ARITHMETIC IS THE CLEANEST OF THE FIVE, which matters more than
       it sounds. Four of the five declared lengths correspond to EXACTLY
       192.03 kbps against the feed's own `itunes:duration` -- 192.03, 192.03,
       192.05, 192.06 -- while the delivered bytes imply a scattered 143-155
       kbps. A declaration that is duration x a round 192,000 on every episode
       is a COMPUTED number, not a measured file size, which is the #319
       Enormocast 5-MiB-placeholder shape in a less obvious costume. This
       episode sits exactly on that 192.03 line; the fifth (0.759) implies
       203.83 kbps, i.e. its `itunes:duration` is off as well, and stacking two
       suspect numbers in one test is how a measurement produces a story
       instead of an answer.

       Not the cheapest -- the 0.759 episode is 20.5MB against this one's
       41.5MB -- and that 21MB is bought deliberately, for the clean
       denominator. */
    why: "the episode that produced the show's median 0.758, and the one whose declared length lands exactly on the 192kbps line",
  },
]);

/* --------------------------------------------------------------------- main */

function arg(argv, name, fallback = null) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
}

/** The committed shape of one decode: every number the Python probe produced,
    plus the two derived readings the verdict rests on. Separated from
    `runTarget` so `recompare` can rebuild a verdict from a row that is already
    on disk, without the download that produced it. */
export function decodeBlock(decode, tagBytes) {
  const chosen = chooseDuration(decode);
  return {
    container_duration_sec: decode?.container_duration_sec ?? null,
    packet_duration_sec: decode?.packet_duration_sec ?? null,
    frame_geometry_sec: decode?.frame_geometry_sec ?? null,
    frames: decode?.frames ?? null,
    packets: decode?.packets ?? null,
    first_packet_pos: decode?.first_packet_pos ?? null,
    codec: decode?.codec ?? null,
    sample_rate: decode?.sample_rate ?? null,
    channels: decode?.channels ?? null,
    container_format: decode?.container_format ?? null,
    metadata_keys: decode?.metadata_keys ?? [],
    duration_source: chosen.source,
    duration_spread_sec: chosen.spread_sec,
    duration_agrees: chosen.agrees,
    /* The header's CLAIM, reported and never gated on — see `chooseDuration`.
       On a stitched file this is one of the few visible traces that the
       artifact was assembled after its header was written. */
    header_claimed_sec: chosen.header_claimed_sec,
    header_delta_sec: chosen.header_delta_sec,
    id3v2_tag_bytes: tagBytes,
    tag_boundary_agrees: tagBoundaryAgrees(decode?.first_packet_pos, tagBytes),
    lead_in_unaccounted_bytes:
      Number.isFinite(decode?.first_packet_pos) && tagBytes > 0 ? decode.first_packet_pos - tagBytes : null,
  };
}

/** One place that assembles `compareDecode`'s arguments, so the live path and
    the recompare path cannot drift into answering differently. */
export function comparisonFor(measured, transcript, target, deliveredBytes) {
  return compareDecode({
    decoded_sec: measured.duration_source ? measured[measured.duration_source] : null,
    duration_agrees: measured.duration_agrees,
    last_cue_sec: transcript?.last_cue_sec ?? null,
    feed_duration_sec: target?.duration_sec ?? null,
    declared_bytes: target?.declared_bytes ?? null,
    delivered_bytes: deliveredBytes,
    tag_bytes: measured.id3v2_tag_bytes,
  });
}

/** Rebuild a stored row's verdict from the numbers already in it.

    WHY THIS EXISTS, and it is a cost-discipline feature rather than a
    convenience. The decode is the expensive half and its OUTPUT is small: once
    a row carries the frame count, the durations and the tag length, every
    threshold in this file is a pure function of numbers already committed. The
    first version of this tool had no such path, and the first time a constant
    turned out to be wrong — `DURATION_AGREEMENT_SEC`, which refused to answer
    for a file that was in perfect order — the only way to re-run the verdict
    would have been to download 150MB again. Re-downloading to re-apply
    arithmetic is exactly the politeness this repo does not spend.

    It rebuilds `decode` too, not just `comparison`, so a change to what the
    decode block DERIVES (rather than what it measured) also lands. What it can
    never do is change a measurement: `container_duration_sec`, `frames` and
    the rest are copied through untouched. */
export function recompare(row, target) {
  /* REFUSES rather than nulls. A stored row whose id is no longer in TARGETS
     would otherwise be re-judged with `declared_bytes` and `feed_duration_sec`
     silently undefined -- i.e. rewritten to `undecidable` and committed, with
     the loss looking like a measurement. */
  if (!target) {
    throw new Error(
      `recompare: no target named "${row?.id}" — a stored row cannot be re-judged without the feed ` +
        `numbers it was measured against. Restore the TARGETS row or delete the stored one.`,
    );
  }
  const measured = decodeBlock(row.decode, row.decode?.id3v2_tag_bytes ?? 0);
  const probed = Number.isFinite(target?.delivered_bytes) ? target.delivered_bytes : row.probe_recorded_bytes ?? null;
  return {
    ...row,
    /* TARGET-DERIVED PROSE IS REFRESHED, NOT CARRIED. `question`, `why` and the
       episode's identity are not measurements -- they are what the TARGETS row
       says about why this download was bought -- so a stored row must restate
       them from the target rather than preserve whatever they said when it was
       downloaded. Without this the ledger drifts silently: the Art Bell row
       went on asking "artwork or pre-roll?" in the committed file for a full
       review cycle after the source had been corrected to say the question is
       no longer answerable, and the row a reader opens to check a claim is the
       one that must not be stale. Measurements below are never touched. */
    question: target.question,
    why_this_episode: target.why,
    show: target.show,
    show_id: target.show_id,
    episode: target.episode,
    ...(target.diagnostic ? { diagnostic: true } : {}),
    probe_recorded_bytes: probed,
    probe_delivered_delta_bytes:
      Number.isFinite(probed) && Number.isFinite(row.downloaded_bytes) ? row.downloaded_bytes - probed : null,
    decode: measured,
    comparison: comparisonFor(measured, row.transcript, target, row.downloaded_bytes),
  };
}

export async function runTarget(target, { python, keep = false, dir = AUDIO_DIR } = {}) {
  mkdirSync(dir, { recursive: true });

  const transcript = await transcriptCues(target);

  const got = await fetchEpisode(
    { id: target.id, audio_url: target.audio_url, audio_bytes: target.delivered_bytes, dai_suspected: target.dai_suspected },
    { dir, checkpointPath: join(dir, "checkpoint.json") },
  );

  const decode = decodeFile(got.path, { python });
  if (decode.error) throw new Error(`decode failed for ${target.id}: ${decode.error}`);

  const head = readHead(got.path);
  const tagBytes = id3v2TagBytes(head);
  const measured = decodeBlock(decode, tagBytes);
  const comparison = comparisonFor(measured, transcript, target, got.bytes);

  if (!keep) await cleanup(target.id, { dir, checkpointPath: join(dir, "checkpoint.json"), url: target.audio_url });

  return {
    id: target.id,
    question: target.question,
    show: target.show,
    show_id: target.show_id,
    guid: target.guid,
    episode: target.episode,
    why_this_episode: target.why,
    measured_at: new Date().toISOString(),
    downloaded_bytes: got.bytes,
    /* THE DOWNLOAD'S OWN PROVENANCE, on the row, because the byte count is the
       most consequential number this tool produces and "did this arrive in one
       clean stream" is the first question anybody will ask of it.

       IT IS CORROBORATION AND NOT THE ARGUMENT, and the distinction matters
       because rows measured before this field existed do not carry it. What
       actually excludes resume-and-append as the source of a delivery larger
       than the declaration is `probeGrid`: the two lengths differ in the
       `Content-Length` HEADER, in responses whose bodies are never read, so no
       download-side mechanism of any kind can be responsible. Any claim in the
       README or in HUMAN-ACTIONS must rest on the grid; this field only lets a
       reader confirm it twice. */
    download: { resumed: got.resumed ?? null, status: got.status ?? null },
    /* WHAT THE CHEAP INSTRUMENT SAID THE FILE WAS, carried onto the row so the
       two can be compared later without re-reading a second file. This is the
       field `decodeUnderreports` reads, and the comparison it enables --
       "the probe was told N, the wire delivered M" -- is the finding that
       demoted the ranged GET on `atelier.flightcast.com` from instrument to
       unreliable witness. Null where no probe figure was recorded. */
    ...(target.diagnostic ? { diagnostic: true } : {}),
    probe_recorded_bytes: Number.isFinite(target.delivered_bytes) ? target.delivered_bytes : null,
    probe_delivered_delta_bytes:
      Number.isFinite(target.delivered_bytes) && Number.isFinite(got.bytes) ? got.bytes - target.delivered_bytes : null,
    resolved_host: got.resolved_host,
    transcript,
    decode: measured,
    comparison,
  };
}

async function main(argv) {
  if (argv.includes("--list")) {
    for (const t of TARGETS) console.log(`${t.id.padEnd(20)} ${t.show}\n${" ".repeat(20)} ${t.question}\n`);
    return 0;
  }
  if (argv.includes("--cleanup")) {
    rmSync(AUDIO_DIR, { recursive: true, force: true });
    console.log(`removed ${AUDIO_DIR}`);
    return 0;
  }

  const prevFile = existsSync(REPORT_PATH) ? JSON.parse(readFileSync(REPORT_PATH, "utf8")) : { results: [] };

  if (argv.includes("--recompare")) {
    const byTarget = new Map(TARGETS.map((t) => [t.id, t]));
    const rebuilt = (prevFile.results || []).map((r) => recompare(r, byTarget.get(r.id)));
    for (const r of rebuilt) console.log(`${r.id.padEnd(20)} ${r.comparison.verdict}: ${r.comparison.reason}`);
    writeJsonAtomic(REPORT_PATH, {
      ...prevFile,
      recompared_at: new Date().toISOString(),
      results: rebuilt,
    });
    console.log(`
rewrote ${REPORT_PATH} from stored measurements — no download`);
    return 0;
  }

  if (argv.includes("--probe-grid")) {
    const which = arg(argv, "--episode");
    const targets = which ? TARGETS.filter((t) => t.id === which) : TARGETS;
    const grids = {};
    for (const t of targets) {
      const g = await probeGrid(t);
      grids[t.id] = g;
      console.log(`\n=== ${t.id}`);
      for (const c of g.cells) {
        console.log(
          `    ${c.identity.padEnd(6)} ${(c.ranged ? "ranged" : "unranged").padEnd(9)} ` +
            `HTTP ${c.status}  total=${c.total}  enc=${c.content_encoding || "none"}`,
        );
      }
      console.log(`    distinct totals: ${g.distinct_totals.join(", ")}${g.varies_by_request ? "  <-- VARIES BY REQUEST" : ""}`);
    }
    /* THE GRID'S OWN RANGED READING IS STAMPED ONTO THE RESULT ROW, because
       `probe_recorded_bytes` is otherwise copied from a hand-maintained literal
       in TARGETS -- and the gate that guards every acquittal
       (`probeCorroborated`) should not be satisfiable by editing a constant.
       The ranged cell is the same request `ad-inflation.mjs` makes, measured
       rather than remembered, so where a grid exists it is the better witness
       and `probe_recorded_bytes` is refreshed from it. */
    const results = (prevFile.results || []).map((r) => {
      const g = grids[r.id];
      if (!g) return r;
      const cell = g.cells.find((c) => c.identity === "probe" && c.ranged && Number.isFinite(c.total));
      if (!cell) return r;
      return {
        ...r,
        probe_recorded_bytes: cell.total,
        probe_recorded_source: "probe-grid",
        probe_delivered_delta_bytes: Number.isFinite(r.downloaded_bytes) ? r.downloaded_bytes - cell.total : null,
      };
    });
    writeJsonAtomic(REPORT_PATH, {
      ...prevFile,
      probe_grid: { ...(prevFile.probe_grid || {}), ...grids },
      results,
    });
    console.log(`\nwrote the probe grid into ${REPORT_PATH}`);
    return 0;
  }

  const only = arg(argv, "--episode");
  const python = arg(argv, "--python", process.env.PYTHON || "python");
  const keep = argv.includes("--keep");
  if (!only && !argv.includes("--all")) {
    /* THE HEADER PROMISES `--episode` TAKES EXACTLY ONE EPISODE and the code
       used to download all five (261MB) on a bare invocation. Cost discipline
       that lives only in a comment is not cost discipline. */
    console.error(
      "refusing to download every target on a bare invocation — this costs 261MB.\n" +
        "Name one with --episode <id> (see --list), or pass --all if you really mean all of them.",
    );
    return 1;
  }
  const targets = only ? TARGETS.filter((t) => t.id === only) : TARGETS;
  if (!targets.length) {
    console.error(`no target with id "${only}" — try --list`);
    return 1;
  }

  const byId = new Map((prevFile.results || []).map((r) => [r.id, r]));

  for (const t of targets) {
    console.log(`\n=== ${t.id} — ${t.show}`);
    const row = await runTarget(t, { python, keep });
    byId.set(t.id, row);
    console.log(`    ${row.comparison.verdict}: ${row.comparison.reason}`);
  }

  const results = TARGETS.map((t) => byId.get(t.id)).filter(Boolean);
  const bytes = results.reduce((n, r) => n + (r.downloaded_bytes || 0), 0);
  writeJsonAtomic(REPORT_PATH, {
    /* `...prevFile` FIRST, and its absence was a real bug: this branch used to
       write a fresh object, so the next `--episode` run silently deleted
       `probe_grid` -- the four-cell evidence that exists only because a
       reviewer refused the headline finding as an ad-hoc observation. A mode
       that destroys another mode's artifact is the same failure as never
       committing it. `--probe-grid` and `--recompare` both already spread. */
    ...prevFile,
    version: 1,
    measured_at: new Date().toISOString(),
    method:
      "full enclosure download, PyAV demux (tools/transcribe/decode-duration.py), decoded duration " +
      "compared against the publisher transcript's last cue — ADR-0008 decode-and-compare",
    downloads: { files: results.length, bytes },
    results,
  });
  console.log(`\nwrote ${REPORT_PATH} — ${results.length} file(s), ${bytes} bytes downloaded`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err?.stack || String(err));
      process.exit(1);
    },
  );
}
