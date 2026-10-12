#!/usr/bin/env node
/* Legacy whisper JSONs at the R2 bucket root (GV-23 / W3-02,
   docs/roadmap/generation-v2.md; covers R2-16, GP-22).

   Before the transcript farm existed, an earlier ASR lane uploaded 7,531
   faster-whisper outputs straight into the bucket root of
   `foray-transcriptions`. sync-r2.mjs counts them `ignored` (they are not
   bodies in foray layout). This module makes them readable without a mirror,
   so the stream indexer (GV-60 / W3-06) and the legacy resolver (GV-53 /
   W3-03) can convert each object in memory.

   The rules are ported from foray-db's verified mapper,
   src/forays_corpus/acquisition/legacy_asr_mapper.py (evidence 2026-09-24,
   read with gh):
   - The key is `<show-slug>/<title-slug>-<sha1(guid)[:10]>.json`. The title
     part is optional in foray-db's `_KEY_RE`, and the transcripts/,
     transcript-originals/ and `_` (probe) prefixes are never legacy keys.
   - The body is raw faster-whisper output: `meta` (engine, model,
     detected_language, ...) plus `segments[{start, end, text, words[]}]`. It
     carries no show_id, guid or enclosure, and the object has no sha256
     metadata, so integrity rests on JSON validity and the etag.
   - The 10-hex suffix is sha1(guid)[:10], hashed over the raw guid and over
     the trimmed guid (a feed's surrounding whitespace is not identity).
   - The show slug is the show title slugified ([^a-z0-9]+ -> -).

   Exports:
   - parseLegacyKey(key) -> {key, showSlug, titleSlug, guidSha1_10} | null.
     inventory.mjs (GV-06) inlined the same regex as LEGACY_KEY_RE before this
     card merged; legacy-whisper.test.mjs pins that the two agree on every
     key in its table.
   - guidHashes(guid) -> the distinct 10-hex sha1 prefixes of the raw and the
     trimmed guid.
   - resolveLegacyEpisode(legacyKey, candidates[{guid, title}]) ->
     {status: matched|unmatched|ambiguous, guid, reason, hits}. Only the hash
     decides. A hash hit on two distinct episodes (distinct trimmed guids) is
     ambiguous and nothing is picked. The title slug never matches anything:
     each hit only REPORTS whether its title slugifies to the key's title slug
     (`titleSlugMatch`), as a tie-break hint for a human.
   - convertWhisperDoc(doc, {keepWords = false}) ->
     {cues[{start_sec, end_sec, text, words?}], asr{engine, model,
     detected_language}, stats}. LegacyShapeError not_a_whisper_doc when the
     doc, its meta or its segments are missing or mis-typed. A segment that
     is not an object, or whose start/end is not a finite number, is dropped
     and counted in `stats`. With keepWords every cue carries `words`
     [{text, start, end}] (bodyShapeError ignores extra fields, so this is
     backward compatible); without it no cue has a `words` key.
   - toNormalizedBody(converted, {show_id, guid}) -> {show_id, guid,
     transcript_source: "asr-local", asr, cues}. It NEVER sets source_url:
     FileTranscriptCueProvider.transcriptSource infers "publisher" from a
     source_url, which would mislabel ASR as a publisher transcript.
   - sampleLegacy({client, bucket, n, out, ...}) and the CLI
     `node tools/foraycorpus-export/legacy-whisper.mjs sample [--n <k>]
     [--out <dir>] [--prefix <p>]`: lists the bucket (or --prefix), keeps the
     keys parseLegacyKey accepts, picks k of them round-robin across show
     slugs (sorted, so the pick is deterministic), GETs exactly those k into
     data-local/legacy-sample/ (gitignored) and prints a shape report
     (segments, words present, last end, language). It writes nothing else.

   Nothing in the pipeline calls this module yet; GV-53 and GV-60 do. */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath, sep } from "node:path";

import { isEntryScript } from "../ci/entry.mjs";
import { ROOT } from "./config.mjs";
import { createR2Client, getObject, listPrefix, loadR2Credentials } from "./r2-client.mjs";

/** foray-db `_KEY_RE`, with its named groups. */
export const LEGACY_KEY_PATTERN = /^(?<show>[a-z0-9][a-z0-9-]*)\/(?:(?<title>.*)-)?(?<hash>[0-9a-f]{10})\.json$/;
/** Prefixes foray-db's parse_legacy_key refuses before the regex. */
export const LEGACY_EXCLUDED_PREFIXES = Object.freeze(["transcripts/", "transcript-originals/", "_"]);
export const TRANSCRIPT_SOURCE = "asr-local";
export const SAMPLE_OUT_DIR = join(ROOT, "data-local", "legacy-sample");
export const SAMPLE_REPORT_NAME = "legacy-sample-report.json";
export const DEFAULT_SAMPLE_N = 20;
export const MAX_SAMPLE_N = 200;
export const USAGE = "usage: node tools/foraycorpus-export/legacy-whisper.mjs sample [--n <1..200>] [--out <dir>] [--prefix <p>]";

export class LegacyShapeError extends Error {
  constructor(code, message = code) {
    super(message === code ? code : `${code}: ${message}`);
    this.name = "LegacyShapeError";
    this.code = code;
  }
}

/** A legacy key's parts, or null for anything else (farm keys, probes). */
export function parseLegacyKey(key) {
  if (typeof key !== "string") return null;
  if (LEGACY_EXCLUDED_PREFIXES.some((p) => key.startsWith(p))) return null;
  const m = LEGACY_KEY_PATTERN.exec(key);
  if (!m) return null;
  return { key, showSlug: m.groups.show, titleSlug: m.groups.title ?? "", guidSha1_10: m.groups.hash };
}

const sha1_10 = (s) => createHash("sha1").update(s, "utf8").digest("hex").slice(0, 10);

/** The distinct sha1(guid)[:10] of the raw and the trimmed guid. */
export function guidHashes(guid) {
  if (typeof guid !== "string") return [];
  return [...new Set([guid, guid.trim()].map(sha1_10))];
}

/** foray-db `_slug`: lowercase, [^a-z0-9]+ -> -, trim dashes. */
export function slugifyTitle(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** foray-db `_title_slugs`: the plain slug and the accent-folded one. */
export function titleSlugs(title) {
  const folded = String(title ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "");
  return new Set([slugifyTitle(title), slugifyTitle(folded)].filter((s) => s !== ""));
}

/**
 * Decides which candidate episode a legacy key is, by the guid hash alone.
 * @param {string | {key: string, showSlug: string, titleSlug: string, guidSha1_10: string}} legacyKey
 * @param {Array<{guid: string, title?: string}>} candidates the show's episodes (e.g. from its RSS feed)
 */
export function resolveLegacyEpisode(legacyKey, candidates) {
  const parsed = typeof legacyKey === "string" ? parseLegacyKey(legacyKey) : legacyKey;
  if (!parsed || typeof parsed.guidSha1_10 !== "string") {
    return { status: "unmatched", guid: null, reason: "not_a_legacy_key", hits: [] };
  }
  const list = Array.isArray(candidates) ? candidates.filter((c) => c && typeof c.guid === "string") : [];
  if (list.length === 0) return { status: "unmatched", guid: null, reason: "no_candidates", hits: [] };

  // Distinct episodes by trimmed guid; the first raw spelling is kept.
  const byEpisode = new Map();
  for (const c of list) {
    if (!guidHashes(c.guid).includes(parsed.guidSha1_10)) continue;
    const id = c.guid.trim();
    if (!byEpisode.has(id)) byEpisode.set(id, c);
  }
  const hits = [...byEpisode.values()].map((c) => ({
    guid: c.guid,
    titleSlugMatch: parsed.titleSlug === "" ? null : titleSlugs(c.title).has(parsed.titleSlug),
  }));
  if (hits.length === 0) return { status: "unmatched", guid: null, reason: "no_episode_for_guid_hash", hits };
  if (hits.length > 1) return { status: "ambiguous", guid: null, reason: "guid_hash_multi_episode", hits };
  return { status: "matched", guid: hits[0].guid, reason: null, hits };
}

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isFiniteNumber = (v) => typeof v === "number" && Number.isFinite(v);

/** Raw whisper output -> the normalized body's cues and asr block. */
export function convertWhisperDoc(doc, { keepWords = false } = {}) {
  if (!isPlainObject(doc) || !isPlainObject(doc.meta) || !Array.isArray(doc.segments)) {
    throw new LegacyShapeError("not_a_whisper_doc");
  }
  const { meta, segments } = doc;
  const stats = { segments: segments.length, cues: 0, dropped_not_object: 0, dropped_non_finite_time: 0, dropped_words: 0 };
  const cues = [];
  for (const s of segments) {
    if (!isPlainObject(s)) {
      stats.dropped_not_object += 1;
      continue;
    }
    if (!isFiniteNumber(s.start) || !isFiniteNumber(s.end)) {
      stats.dropped_non_finite_time += 1;
      continue;
    }
    const cue = { start_sec: s.start, end_sec: s.end, text: String(s.text ?? "").trim() };
    if (keepWords) {
      cue.words = [];
      for (const w of Array.isArray(s.words) ? s.words : []) {
        if (!isPlainObject(w) || !isFiniteNumber(w.start) || !isFiniteNumber(w.end)) {
          stats.dropped_words += 1;
          continue;
        }
        cue.words.push({ text: String(w.word ?? w.text ?? "").trim(), start: w.start, end: w.end });
      }
    }
    cues.push(cue);
  }
  stats.cues = cues.length;
  const engine = meta.engine || (meta.faster_whisper ? "faster-whisper" : "whisper");
  return {
    cues,
    asr: { engine, model: meta.model ?? null, detected_language: meta.detected_language ?? null },
    stats,
  };
}

/** A converted doc as a body in foray's normalized layout. Never a source_url. */
export function toNormalizedBody(converted, { show_id, guid } = {}) {
  if (typeof show_id !== "string" || show_id.trim() === "") throw new LegacyShapeError("bad_identity", "show_id must be a non-empty string");
  if (typeof guid !== "string" || guid === "") throw new LegacyShapeError("bad_identity", "guid must be a non-empty string");
  if (!isPlainObject(converted) || !Array.isArray(converted.cues)) throw new LegacyShapeError("not_converted", "pass convertWhisperDoc's result");
  return {
    show_id,
    guid,
    transcript_source: TRANSCRIPT_SOURCE,
    asr: { ...(converted.asr ?? {}) },
    cues: converted.cues.map((c) => (c.words ? { ...c, words: c.words.map((w) => ({ ...w })) } : { ...c })),
  };
}

/** Parses `sample [--n <k>] [--out <dir>] [--prefix <p>]`. */
export function parseSampleArgs(argv) {
  const [command, ...rest] = argv;
  if (command !== "sample") throw new LegacyShapeError("USAGE", USAGE);
  const args = { n: DEFAULT_SAMPLE_N, out: SAMPLE_OUT_DIR, prefix: "" };
  const seen = new Set();
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    const name = { "--n": "n", "--out": "out", "--prefix": "prefix" }[flag];
    if (!name) throw new LegacyShapeError("USAGE", `unknown flag ${flag}; ${USAGE}`);
    if (seen.has(name)) throw new LegacyShapeError("USAGE", `${flag} given twice`);
    seen.add(name);
    const value = rest[i + 1];
    if (value === undefined || value.startsWith("--")) throw new LegacyShapeError("USAGE", `${flag} needs a value`);
    i += 1;
    if (name === "n") {
      if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > MAX_SAMPLE_N) {
        throw new LegacyShapeError("USAGE", `--n must be an integer 1..${MAX_SAMPLE_N}, got ${value}`);
      }
      args.n = Number(value);
    } else {
      args[name] = value;
    }
  }
  return args;
}

/** k keys, round-robin across show slugs in sorted order (deterministic). */
export function pickSample(parsedKeys, n) {
  const byShow = new Map();
  for (const p of [...parsedKeys].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))) {
    if (!byShow.has(p.showSlug)) byShow.set(p.showSlug, []);
    byShow.get(p.showSlug).push(p);
  }
  const queues = [...byShow.keys()].sort().map((s) => byShow.get(s));
  const picked = [];
  for (let round = 0; picked.length < n; round += 1) {
    let any = false;
    for (const q of queues) {
      if (round < q.length && picked.length < n) {
        picked.push(q[round]);
        any = true;
      }
    }
    if (!any) break;
  }
  return picked;
}

/** The local file for a sampled key: <out>/<showSlug>/<file>, refused outside <out>. */
export function samplePath(out, parsed) {
  const base = resolvePath(out);
  const file = parsed.key.slice(parsed.showSlug.length + 1).replace(/[^A-Za-z0-9._-]/g, "_");
  const full = resolvePath(base, parsed.showSlug, file);
  if (file === "." || file === ".." || !full.startsWith(base + sep)) {
    throw new LegacyShapeError("PATH_ESCAPE", `refusing to write outside ${base}: ${full}`);
  }
  return full;
}

/** One object's shape row for the report. */
export function shapeRow(parsed, bytes) {
  const row = { key: parsed.key, bytes: bytes.length, segments: null, cues: null, segments_with_words: null, last_end_sec: null, language: null, engine: null, model: null, error: null };
  let doc;
  try {
    doc = JSON.parse(bytes.toString("utf8"));
  } catch {
    row.error = "bad_json";
    return row;
  }
  let converted;
  try {
    converted = convertWhisperDoc(doc, { keepWords: true });
  } catch (e) {
    row.error = e?.code ?? "convert_failed";
    return row;
  }
  row.segments = converted.stats.segments;
  row.cues = converted.stats.cues;
  row.segments_with_words = converted.cues.filter((c) => c.words.length > 0).length;
  row.last_end_sec = converted.cues.reduce((m, c) => Math.max(m, c.end_sec), 0);
  row.language = converted.asr.detected_language;
  row.engine = converted.asr.engine;
  row.model = converted.asr.model;
  return row;
}

/** The report as a markdown table (for #1163). */
export function sampleMarkdown(report) {
  const lines = [
    `legacy whisper sample: listed=${report.listed} legacy_keys=${report.legacy_keys} sampled=${report.sampled} with_words=${report.with_words} errors=${report.errors}`,
    "",
    "| key | segments | words present | last end (s) | language | engine | model | error |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const r of report.rows) {
    const words = r.segments_with_words === null ? "" : `${r.segments_with_words}/${r.cues}`;
    lines.push(`| ${r.key} | ${r.segments ?? ""} | ${words} | ${r.last_end_sec ?? ""} | ${r.language ?? ""} | ${r.engine ?? ""} | ${r.model ?? ""} | ${r.error ?? ""} |`);
  }
  return lines.join("\n");
}

/**
 * Lists, picks n legacy keys and GETs exactly those n into `out`.
 * `commands` are the SDK command classes (tests inject fakes).
 */
export async function sampleLegacy({ client, bucket, n = DEFAULT_SAMPLE_N, out = SAMPLE_OUT_DIR, prefix = "", commands = {}, log = console.log } = {}) {
  let listed = 0;
  const legacy = [];
  for await (const o of listPrefix(client, bucket, prefix, commands)) {
    listed += 1;
    const parsed = parseLegacyKey(o.key);
    if (parsed) legacy.push(parsed);
  }
  const picked = pickSample(legacy, n);
  const rows = [];
  for (const parsed of picked) {
    const path = samplePath(out, parsed);
    const { body } = await getObject(client, bucket, parsed.key, commands);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, body);
    rows.push({ ...shapeRow(parsed, body), file: path });
  }
  const report = {
    listed,
    legacy_keys: legacy.length,
    sampled: rows.length,
    with_words: rows.filter((r) => (r.segments_with_words ?? 0) > 0).length,
    errors: rows.filter((r) => r.error !== null).length,
    rows,
  };
  mkdirSync(out, { recursive: true });
  const reportPath = join(out, SAMPLE_REPORT_NAME);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  log(sampleMarkdown(report));
  log(`report: ${reportPath}`);
  return { report, reportPath };
}

export async function runSampleCli(argv) {
  const args = parseSampleArgs(argv);
  const creds = await loadR2Credentials();
  const client = await createR2Client(creds);
  return sampleLegacy({ client, bucket: creds.bucket, n: args.n, out: args.out, prefix: args.prefix });
}

if (isEntryScript(import.meta.url)) {
  runSampleCli(process.argv.slice(2)).catch((e) => {
    console.error("FATAL:", e?.message ?? e);
    process.exit(1);
  });
}
