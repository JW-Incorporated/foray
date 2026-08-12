/* Transcript normaliser — every timestamped format publishers ship, one shape
   (issue #105, epic #102 track A).

   WHY THIS EXISTS — segment extraction is the whole of Forays, and it needs a
   timeline it can index. What publishers actually ship, measured across the 208
   live feeds in this catalogue (<podcast:transcript> tags, by declared type):

     text/vtt                 7063
     application/srt          6848
     application/json          787
     application/x-subrip      621

   Four formats, three genuinely different grammars, and no publisher owes us
   consistency. Every downstream consumer — segment scoring, anchor resolution,
   narration copy — would otherwise carry its own half-correct parser. This file
   is that parser, once. It is the only place in the codebase allowed to know
   that SRT writes `00:00:01,500` with a comma and WebVTT writes `.500`.

   NEVER THROWS. Same posture as backend/src/feeds/parser.ts: a transcript is
   third-party input fetched over the network from an operation that has no
   reason to care about us, and an exception here would take down a nightly run
   over one publisher's truncated file. Worst case is `{cues: [], warnings: [
   ...why]}`. Callers check `cues.length`, never a try/catch.

   DECLARED TYPE IS A HINT, NOT A FACT. Mislabelling is routine — SRT served as
   `text/vtt`, VTT served as `text/plain`, JSON served as `application/srt`. We
   sniff the body and let the content win, recording a warning when the two
   disagree so the mismatch is visible without being fatal.

   THREE THINGS WE DO NOT DO SILENTLY:

   1. Out-of-order / overlapping cues. We sort (a caller indexing a timeline
      needs monotonic starts) but we do NOT merge overlaps. An overlap is
      usually rolling captions, occasionally two speakers talking over each
      other, and rarely a genuinely broken file — merging would destroy the
      evidence needed to tell those apart. We sort, we count, we report.

   2. Rolling-caption repetition. Live-styled VTT repeats the tail of each cue
      as the head of the next ("hello there / how are you" then "how are you /
      I am fine"). Concatenated naively, every sentence appears twice and any
      word-count-based scoring is wrong by 2x. We strip the repeated run — but
      only when the overlap is word-aligned AND either three-plus words long or
      the entire previous cue, because "you know" ending one cue and starting
      the next is speech, not repetition.

   3. Missing end times. Podcasting 2.0 JSON often ships `startTime` only. We
      close each cue at the next cue's start rather than dropping it, and say so.

   Pure, dependency-free, no network, no filesystem — like the rest of tools/.
   Fixtures for the formats live in ./fixtures, tests in
   ./transcript-normalize.test.mjs.                                            */

/* ------------------------------------------------------------------ format */

/** Declared MIME type -> format. Parameters (`; charset=utf-8`) are stripped
    before lookup. `text/plain` is deliberately absent: it is the type feeds use
    when they have no idea, so it must fall through to sniffing. */
const MIME_FORMATS = new Map([
  ["text/vtt", "vtt"],
  ["text/webvtt", "vtt"],
  ["application/x-subtitle-vtt", "vtt"],
  ["application/srt", "srt"],
  ["text/srt", "srt"],
  ["application/x-subrip", "srt"],
  ["application/x-subtitle", "srt"],
  ["application/json", "json"],
  ["text/json", "json"],
  ["application/x-json", "json"],
]);

/** What the bytes look like, ignoring what anyone claimed. Returns null when
    nothing recognisable is present — the caller turns that into a warning. */
export function sniffFormat(body) {
  const s = String(body || "").replace(/^﻿/, "").trimStart();
  if (!s) return null;
  if (/^WEBVTT\b/i.test(s)) return "vtt";
  if (s[0] === "{" || s[0] === "[") return "json";
  // The comma decimal separator is the one unambiguous SRT/VTT discriminator.
  if (/\d{1,2}:\d{2}(?::\d{2})?,\d{1,3}\s*-->/.test(s)) return "srt";
  if (s.includes("-->")) return "vtt";
  return null;
}

/** Resolve declared type against sniffed content. Content wins; disagreement is
    reported, not fatal. */
export function detectFormat(body, mimeType) {
  const warnings = [];
  const declared = MIME_FORMATS.get(String(mimeType || "").split(";")[0].trim().toLowerCase()) || null;
  const sniffed = sniffFormat(body);

  if (sniffed && declared && sniffed !== declared) {
    warnings.push(`declared type "${mimeType}" (${declared}) but the body looks like ${sniffed}; parsed as ${sniffed}`);
  }
  const format = sniffed || declared;
  if (!format) warnings.push(`unrecognised transcript format (declared type: ${mimeType || "none"})`);
  return { format, warnings };
}

/* --------------------------------------------------------------- timestamps */

const TIME_RE = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/;

/** `HH:MM:SS.mmm`, `MM:SS.mmm` (VTT legally omits the hour for sub-hour cues),
    either decimal separator, and a bare seconds number (JSON transcripts use
    those). Returns seconds as a number, or null when unreadable — null is a
    parse failure the caller reports, never an exception. */
export function parseTimestamp(raw) {
  if (typeof raw === "number") return Number.isFinite(raw) && raw >= 0 ? round3(raw) : null;
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (/^\d+(?:\.\d+)?$/.test(s)) return round3(Number(s));

  const m = TIME_RE.exec(s);
  if (!m) return null;
  const [, hh, mm, ss, frac] = m;
  const seconds = Number(hh || 0) * 3600 + Number(mm) * 60 + Number(ss) + (frac ? Number(`0.${frac}`) : 0);
  return Number.isFinite(seconds) ? round3(seconds) : null;
}

/** Float seconds accumulate noise (0.1 + 0.2). Milliseconds are the finest
    resolution any of these formats can express, so three places is lossless. */
function round3(n) {
  return Math.round(n * 1000) / 1000;
}

/* --------------------------------------------------------------------- text */

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
    const key = name.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(ENTITIES, key)) return ENTITIES[key];
    if (key.startsWith("#x")) {
      const cp = parseInt(key.slice(2), 16);
      return Number.isFinite(cp) ? safeFromCodePoint(cp, whole) : whole;
    }
    if (key.startsWith("#")) {
      const cp = parseInt(key.slice(1), 10);
      return Number.isFinite(cp) ? safeFromCodePoint(cp, whole) : whole;
    }
    return whole;
  });
}

function safeFromCodePoint(cp, fallback) {
  try {
    return String.fromCodePoint(cp);
  } catch {
    return fallback;
  }
}

/** Cue payload -> plain text plus whatever speaker the markup named.

    VTT carries speakers as `<v Josh>…</v>` voice spans; SRT carries styling
    markup (`<i>`, `<font color=…>`) that means nothing to us. Inline
    `<00:00:12.500>` karaoke timings are stripped along with everything else —
    the cue's own start/end are the timeline we index on.

    `markup: false` for JSON, which has no tag convention at all: there, a body
    containing `if x < 3 and y > 4` is prose, and tag-stripping would eat it. */
function cleanText(lines, { markup = true } = {}) {
  const raw = lines.join("\n");
  const voice = markup ? /<v(?:\.[^\s>]+)*\s+([^>]+?)\/?>/i.exec(raw) : null;
  const speaker = voice ? decodeEntities(voice[1]).trim() || null : null;
  const text = decodeEntities(markup ? raw.replace(/<\/?[^<>]*>/g, "") : raw)
    .replace(/\s+/g, " ")
    .trim();
  return { text, speaker };
}

/* ------------------------------------------------------- VTT / SRT (blocks) */

/** VTT and SRT are the same grammar with three differences: the WEBVTT header,
    SRT's leading numeric index, and the decimal separator. Two parsers would
    be two places to fix the next quirk, so this handles both and varies only
    the warnings it emits. */
const CUE_LINE_RE = /^(.+?)\s*-->\s*([^\s]+)(?:\s+(.*))?$/;

function parseBlocks(body, format, warnings) {
  const text = String(body).replace(/^﻿/, "").replace(/\r\n?/g, "\n");

  if (format === "vtt" && !/^\s*WEBVTT\b/i.test(text)) {
    warnings.push("missing WEBVTT header; parsed anyway");
  }

  const cues = [];
  let skipped = 0;
  let badTimes = 0;

  for (const block of text.split(/\n[ \t]*\n+/)) {
    const lines = block.split("\n").map((l) => l.replace(/\s+$/, "")).filter((l, i, a) => !(l === "" && (i === 0 || i === a.length - 1)));
    if (!lines.length || lines.every((l) => l.trim() === "")) continue;

    // Header and metadata blocks. NOTE/STYLE/REGION are legal VTT furniture,
    // not content, so they are skipped without complaint.
    if (/^(WEBVTT|NOTE|STYLE|REGION)\b/i.test(lines[0]) && !lines[0].includes("-->")) continue;

    const idx = lines.findIndex((l) => l.includes("-->"));
    if (idx === -1) {
      // A block with no timestamp is either a stray index line or damage.
      if (!/^\d+$/.test(lines[0].trim())) skipped += 1;
      continue;
    }

    const m = CUE_LINE_RE.exec(lines[idx].trim());
    const start = m ? parseTimestamp(m[1]) : null;
    const end = m ? parseTimestamp(m[2]) : null;
    if (start == null) {
      badTimes += 1;
      continue;
    }

    // Lines above the timestamp are the SRT index and/or the VTT cue
    // identifier; neither carries meaning we keep. Cue settings (m[3], e.g.
    // `align:start position:0%`) are presentation, discarded the same way.
    const { text: cueText, speaker } = cleanText(lines.slice(idx + 1));
    cues.push({ start_sec: start, end_sec: end, text: cueText, speaker });
  }

  if (skipped) warnings.push(`${skipped} block(s) had no timestamp line and were skipped`);
  if (badTimes) warnings.push(`${badTimes} cue(s) had an unreadable start timestamp and were dropped`);
  return cues;
}

/* --------------------------------------------------------------------- JSON */

/** Podcasting 2.0's transcript JSON is specified far more loosely than VTT or
    SRT, and the wild shows it: `segments` vs `results.segments`, `startTime` vs
    `start`, `body` vs `text`. Leniency here is cheaper than a warning nobody
    can act on, so we accept the variants we have seen and report — never
    throw — for a shape we cannot read at all. */
const SEGMENT_KEYS = ["segments", "Segments", "cues", "items", "results", "transcript", "transcripts"];
const START_KEYS = ["startTime", "start_time", "start", "start_sec", "startSec", "begin", "from", "startTimeSeconds"];
const END_KEYS = ["endTime", "end_time", "end", "end_sec", "endSec", "stop", "to", "endTimeSeconds"];
const TEXT_KEYS = ["body", "text", "content", "transcript", "utterance", "value", "caption"];
const SPEAKER_KEYS = ["speaker", "speakerName", "speaker_name", "speakerLabel", "speaker_label", "name", "who"];

function firstKey(obj, keys) {
  for (const k of keys) {
    if (obj != null && Object.prototype.hasOwnProperty.call(obj, k) && obj[k] != null && obj[k] !== "") return obj[k];
  }
  return undefined;
}

/** Walk the plausible containers for the segment array. Depth is capped at two
    because every real shape we have seen is either the root array, `segments`,
    or `results.segments` — an unbounded search would happily "find" an array of
    something else entirely. */
function findSegments(root) {
  if (Array.isArray(root)) return root;
  if (root == null || typeof root !== "object") return null;
  for (const k of SEGMENT_KEYS) {
    const v = root[k];
    if (Array.isArray(v)) return v;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const k2 of SEGMENT_KEYS) if (Array.isArray(v[k2])) return v[k2];
    }
  }
  return null;
}

function parseJson(body, warnings) {
  let data;
  try {
    data = JSON.parse(String(body));
  } catch (e) {
    warnings.push(`JSON did not parse: ${e.message}`);
    return [];
  }

  const segments = findSegments(data);
  if (!segments) {
    const keys = data && typeof data === "object" ? Object.keys(data).slice(0, 8).join(", ") : typeof data;
    warnings.push(`no recognisable segment array in JSON transcript (top-level keys: ${keys || "none"})`);
    return [];
  }

  const cues = [];
  let unreadable = 0;
  for (const seg of segments) {
    if (seg == null || typeof seg !== "object") {
      unreadable += 1;
      continue;
    }
    const start = parseTimestamp(firstKey(seg, START_KEYS));
    if (start == null) {
      unreadable += 1;
      continue;
    }
    const rawText = firstKey(seg, TEXT_KEYS);
    const { text } = cleanText([typeof rawText === "string" ? rawText : rawText == null ? "" : String(rawText)], { markup: false });
    const declaredSpeaker = firstKey(seg, SPEAKER_KEYS);
    cues.push({
      start_sec: start,
      end_sec: parseTimestamp(firstKey(seg, END_KEYS)),
      text,
      speaker: (typeof declaredSpeaker === "string" ? declaredSpeaker.trim() : "") || null,
    });
  }
  if (unreadable) warnings.push(`${unreadable} JSON segment(s) had no readable start time and were dropped`);
  return cues;
}

/* -------------------------------------------------------------- shared pass */

/** Close open cues, sort, and report. A cue with no end time is closed at the
    next cue's start — a zero-length cue would be invisible to any range query,
    and dropping it would lose the words. */
function closeAndSort(cues, warnings) {
  let outOfOrder = 0;
  for (let i = 1; i < cues.length; i += 1) {
    if (cues[i].start_sec < cues[i - 1].start_sec) outOfOrder += 1;
  }
  if (outOfOrder) warnings.push(`${outOfOrder} cue(s) were out of chronological order; sorted by start time`);
  cues.sort((a, b) => a.start_sec - b.start_sec || (a.end_sec ?? a.start_sec) - (b.end_sec ?? b.start_sec));

  let inferred = 0;
  let inverted = 0;
  for (let i = 0; i < cues.length; i += 1) {
    const c = cues[i];
    if (c.end_sec == null) {
      const next = cues[i + 1];
      c.end_sec = next ? Math.max(next.start_sec, c.start_sec) : c.start_sec;
      inferred += 1;
    } else if (c.end_sec < c.start_sec) {
      c.end_sec = c.start_sec;
      inverted += 1;
    }
  }
  if (inferred) warnings.push(`${inferred} cue(s) had no end time; closed at the following cue's start`);
  if (inverted) warnings.push(`${inverted} cue(s) ended before they started; end clamped to start`);
  return cues;
}

/** Rolling-caption de-duplication.

    Only consecutive cues, only word-aligned overlaps, and only when the repeat
    is either the whole previous cue or at least MIN_ROLL_WORDS long. Anything
    looser starts eating real speech: people repeat "I mean" and "you know"
    across a cue boundary constantly, and a normaliser that quietly deletes
    words is worse than one that leaves a duplicate in. */
const MIN_ROLL_WORDS = 3;

function dedupeRolling(cues, warnings) {
  const out = [];
  let stripped = 0;
  let dropped = 0;

  for (const cue of cues) {
    const prev = out[out.length - 1];
    if (!prev || !cue.text || !prev.text) {
      out.push(cue);
      continue;
    }

    const prevWords = prev.text.split(" ");
    const words = cue.text.split(" ");
    let overlap = 0;
    const max = Math.min(prevWords.length, words.length);
    for (let n = max; n > 0; n -= 1) {
      if (eqWords(prevWords.slice(prevWords.length - n), words.slice(0, n))) {
        overlap = n;
        break;
      }
    }

    // The whole of the previous cue repeated is unambiguous rolling caption
    // above one word; a partial tail has to clear the noise floor. One-word
    // repeats ("Right." / "Right, so…") are left alone in both cases — in
    // conversation that is two people, not a caption artefact.
    const wholePrev = overlap === prevWords.length && prevWords.length >= 2;
    if (!overlap || (!wholePrev && overlap < MIN_ROLL_WORDS)) {
      out.push(cue);
      continue;
    }

    const rest = words.slice(overlap).join(" ").trim();
    if (!rest) {
      // Pure repetition: keep one cue spanning both, so the timeline stays
      // continuous and the words are not counted twice.
      prev.end_sec = Math.max(prev.end_sec, cue.end_sec);
      if (!prev.speaker && cue.speaker) prev.speaker = cue.speaker;
      dropped += 1;
      continue;
    }
    cue.text = rest;
    stripped += 1;
    out.push(cue);
  }

  if (dropped) warnings.push(`${dropped} cue(s) repeated the previous cue verbatim (rolling captions); merged`);
  if (stripped) warnings.push(`${stripped} cue(s) began by repeating the previous cue's tail (rolling captions); trimmed`);
  return out;
}

function eqWords(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (norm(a[i]) !== norm(b[i])) return false;
  }
  return true;
}

/** Compare on letters and digits only: rolling captions routinely re-emit the
    repeated run with different punctuation or capitalisation once the sentence
    resolves ("we went" -> "We went,"). */
function norm(w) {
  return w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
}

/** Count overlaps for the record. Deliberately does not fix them — see the
    header. */
function reportOverlaps(cues, warnings) {
  let overlaps = 0;
  for (let i = 1; i < cues.length; i += 1) {
    if (cues[i].start_sec < cues[i - 1].end_sec) overlaps += 1;
  }
  if (overlaps) warnings.push(`${overlaps} cue(s) overlap the previous cue in time; left as-is (not merged)`);
}

/* ---------------------------------------------------------------- normalize */

/**
 * Normalise any supported transcript body into one cue list.
 *
 * @param {string} body      raw transcript text (or JSON text)
 * @param {string} [mimeType] the feed's declared `<podcast:transcript type=…>`;
 *                            a hint only, the body wins when they disagree
 * @param {{dedupe?: boolean}} [options] `dedupe: false` keeps rolling-caption
 *                            repetition, for callers that want the raw cues
 * @returns {{cues: Array<{start_sec: number, end_sec: number, text: string, speaker: string|null}>, warnings: string[]}}
 *
 * `speaker` is additive: null for the formats that cannot express it, so a
 * consumer that only reads start/end/text sees the same shape everywhere.
 *
 * Never throws.
 */
export function normalize(body, mimeType, options = {}) {
  const warnings = [];
  try {
    if (body == null || typeof body === "object") {
      warnings.push(`expected a transcript string, got ${body === null ? "null" : typeof body}`);
      return { cues: [], warnings };
    }
    const text = String(body);
    if (!text.trim()) {
      warnings.push("empty transcript body");
      return { cues: [], warnings };
    }

    const { format, warnings: formatWarnings } = detectFormat(text, mimeType);
    warnings.push(...formatWarnings);
    if (!format) return { cues: [], warnings };

    let cues = format === "json" ? parseJson(text, warnings) : parseBlocks(text, format, warnings);

    const empty = cues.filter((c) => !c.text).length;
    if (empty) warnings.push(`${empty} cue(s) had no text and were dropped`);
    cues = cues.filter((c) => c.text);

    if (!cues.length) {
      warnings.push(`no usable cues found in ${format} transcript`);
      return { cues: [], warnings };
    }

    closeAndSort(cues, warnings);
    if (options.dedupe !== false) cues = dedupeRolling(cues, warnings);
    reportOverlaps(cues, warnings);

    return { cues, warnings };
  } catch (e) {
    // Belt and braces. Nothing above is meant to throw; if something does, the
    // contract still holds and the nightly run survives to the next episode.
    warnings.push(`internal normaliser error (input ignored): ${e && e.message ? e.message : String(e)}`);
    return { cues: [], warnings };
  }
}

export default normalize;
