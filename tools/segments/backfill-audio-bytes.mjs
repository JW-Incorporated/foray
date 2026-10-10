/* Backfill `audio_bytes` on the DAI source rows of data/segment-sources.json
   from the show's own RSS enclosure `length` (DAI-04a, docs/roadmap/dai.md §3).

   WHY. ADR-0008's pad is sized from a same-episode ranged-GET probe:
   delivered bytes / feed-declared bytes. `audio_bytes` IS the feed-declared
   denominator (`tools/transcribe/ad-inflation.mjs` `selectTargets` reads
   `it.audio_bytes` = the enclosure `length`). On main, zero rows were both
   `dai_suspected` and carried `audio_bytes`, so a probe collector keyed on it
   (DAI-04 / DAI-08) had nothing to probe. data/discover.json joins only 6 of
   the 33 DAI rows by `audio_url`, so the feed is the source and discover is a
   read-only cross-check.

   WHAT IT DOES, per invocation (one show):
   1. ONE request: the feed, through politeness.mjs's host gate, under the
      ForayBot User-Agent (AUDIO_UA). No retry ladder — a non-200 exits 2 and
      the operator decides whether to run again (the card stops after two).
   2. Rows in scope: `dai_suspected === true` and `id` starting with --show.
   3. Join each row to a feed item by EXACT `audio_url` == enclosure url,
      falling back to `episode_guid` == item guid.
   4. Write `audio_bytes = Number(length)` only when length > 0
      (`enclosureLengthBytes`: length="0" / absent / junk means unknown).
   5. Cross-check: a discover.json item with the same `audio_url` must carry
      the same `audio_bytes`; a mismatch is reported and the feed wins.

   WHAT IT NEVER DOES: rewrite `audio_url` (a guid match whose enclosure URL
   differs is REPORTED as URL drift, audio_url kept), touch a field other than
   `audio_bytes`, touch a row out of scope, or write discover.json.
   Serialised as JSON.stringify(doc, null, 2) + "\n", LF — the file's existing
   form, so the diff is exactly the added lines.

   A throwaway, reproducible run script — not a suite, no floor.

     node tools/segments/backfill-audio-bytes.mjs \
       --feed https://feeds.transistor.fm/practical-ai-machine-learning-data-science-llm \
       --show practical-ai--
     node tools/segments/backfill-audio-bytes.mjs \
       --feed https://rss.buzzsprout.com/995575.rss --show being-an-engineer--

   Flags: --dry-run (print the table, write nothing); --save-feed <path> (keep
   the fetched body); --feed-file <path> (replay a saved body, no network);
   --sources / --discover override the data paths. */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { isEntryScript } from "../ci/entry.mjs";
import { AUDIO_UA, ACCEPT_LANGUAGE, awaitHostSlot } from "./politeness.mjs";
import { parseFeed } from "./sweep-transcripts.mjs";
import { enclosureLengthBytes } from "../refresh/enclosure.mjs";
import { readResponseCapped } from "../refresh/fetch-limits.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const FEED_TIMEOUT_MS = 30_000;

export function parseArgs(argv) {
  const out = { feed: null, show: null, dryRun: false, saveFeed: null, feedFile: null,
    sources: join(ROOT, "data", "segment-sources.json"), discover: join(ROOT, "data", "discover.json") };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v == null || v.startsWith("--")) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--feed") out.feed = val();
    else if (a === "--show") out.show = val();
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--save-feed") out.saveFeed = resolvePath(val());
    else if (a === "--feed-file") out.feedFile = resolvePath(val());
    else if (a === "--sources") out.sources = resolvePath(val());
    else if (a === "--discover") out.discover = resolvePath(val());
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!out.feed) throw new Error("--feed <url> is required");
  if (!out.show) throw new Error("--show <id prefix> is required");
  return out;
}

/** The feed body, one request. Throws on anything but a 200. */
export async function fetchFeedOnce(url, { fetchImpl = fetch, timeoutMs = FEED_TIMEOUT_MS } = {}) {
  await awaitHostSlot(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      headers: { "user-agent": AUDIO_UA, "accept-language": ACCEPT_LANGUAGE },
      redirect: "follow",
      signal: controller.signal,
    });
    if (res.status !== 200) {
      try { await res.body?.cancel?.(); } catch (_) { /* best-effort */ }
      throw new Error(`feed answered HTTP ${res.status}: ${url}`);
    }
    return await readResponseCapped(res, controller);
  } finally {
    clearTimeout(timer);
  }
}

function hostOfUrl(u) {
  try { return new URL(u).host; } catch { return "?"; }
}

/** Returns a copy of `row` with `audio_bytes` set, placed after `audio_type`
    (the position the 19 rows that already carry it use). */
export function withAudioBytes(row, bytes) {
  const out = {};
  let placed = false;
  for (const [k, v] of Object.entries(row)) {
    if (k === "audio_bytes") continue;
    out[k] = v;
    if (k === "audio_type") { out.audio_bytes = bytes; placed = true; }
  }
  if (!placed) {
    // No audio_type: rebuild with audio_bytes right after audio_url.
    const again = {};
    for (const [k, v] of Object.entries(out)) {
      again[k] = v;
      if (k === "audio_url") { again.audio_bytes = bytes; placed = true; }
    }
    if (!placed) again.audio_bytes = bytes;
    return again;
  }
  return out;
}

/** Pure. Plans (and applies to a copy of) the backfill for one show.
    `episodes` is parseFeed(...).episodes; it carries the RAW enclosure length
    as `enclosure_bytes` already filtered through enclosureLengthBytes.
    Returns { doc, report, k } — `k` = rows in scope that now carry a feed
    denominator. */
export function planBackfill(doc, episodes, { show, feed, discoverItems = [] }) {
  const byUrl = new Map();
  const byGuid = new Map();
  for (const ep of episodes) {
    if (ep.enclosure_url && !byUrl.has(ep.enclosure_url)) byUrl.set(ep.enclosure_url, ep);
    if (ep.guid && !byGuid.has(ep.guid)) byGuid.set(ep.guid, ep);
  }
  const discoverByUrl = new Map();
  for (const it of discoverItems) if (it?.audio_url && !discoverByUrl.has(it.audio_url)) discoverByUrl.set(it.audio_url, it);

  const report = [];
  let k = 0;
  const sources = doc.sources.map((row) => {
    if (row?.dai_suspected !== true || typeof row.id !== "string" || !row.id.startsWith(show)) return row;
    const disc = discoverByUrl.get(row.audio_url);
    const discoverBytes = disc && Number.isFinite(disc.audio_bytes) && disc.audio_bytes > 0 ? disc.audio_bytes : null;
    const line = { id: row.id, host: hostOfUrl(row.audio_url), feed_bytes: null, discover_bytes: discoverBytes, status: "" };
    report.push(line);

    if (feed && row.feed_url && row.feed_url !== feed) {
      line.status = `skipped: row feed_url is ${row.feed_url}`;
      return row;
    }

    let ep = byUrl.get(row.audio_url);
    let via = "audio_url";
    if (!ep && row.episode_guid) { ep = byGuid.get(row.episode_guid); via = "guid"; }
    if (!ep) { line.status = "no enclosure match"; return row; }

    const bytes = enclosureLengthBytes(ep.enclosure_bytes);
    line.feed_bytes = bytes;
    const notes = [];
    if (via === "guid") notes.push(`matched by guid; URL drift (feed enclosure ${ep.enclosure_url}) — audio_url kept`);
    if (bytes == null) {
      line.status = ["un-probeable (decode only): enclosure length 0/absent", ...notes].join("; ");
      return row;
    }
    if (discoverBytes != null && discoverBytes !== bytes) notes.push(`discover mismatch (${discoverBytes}); feed wins`);
    if (row.audio_bytes === bytes) notes.unshift("unchanged (already carried)");
    else if (row.audio_bytes != null) notes.unshift(`replaced ${row.audio_bytes}`);
    else notes.unshift(`backfilled (by ${via})`);
    if (discoverBytes != null && discoverBytes === bytes) notes.push("discover agrees");
    line.status = notes.join("; ");
    k++;
    return row.audio_bytes === bytes ? row : withAudioBytes(row, bytes);
  });
  return { doc: { ...doc, sources }, report, k };
}

export function serialise(doc) {
  return JSON.stringify(doc, null, 2) + "\n";
}

export function formatTable(report) {
  const lines = ["| id | host | feed length | discover length | status |", "|---|---|---|---|---|"];
  for (const r of report) {
    lines.push(`| ${r.id} | ${r.host} | ${r.feed_bytes ?? "—"} | ${r.discover_bytes ?? "—"} | ${r.status} |`);
  }
  return lines.join("\n");
}

export async function main(argv = process.argv.slice(2), { log = console.log } = {}) {
  const args = parseArgs(argv);
  const xml = args.feedFile ? readFileSync(args.feedFile, "utf8") : await fetchFeedOnce(args.feed);
  if (args.saveFeed && !args.feedFile) writeFileSync(args.saveFeed, xml);
  const { episodes } = parseFeed(xml);

  const raw = readFileSync(args.sources, "utf8");
  const doc = JSON.parse(raw);
  let discoverItems = [];
  try { discoverItems = JSON.parse(readFileSync(args.discover, "utf8")).items || []; } catch (_) { /* cross-check only */ }

  const { doc: next, report, k } = planBackfill(doc, episodes, { show: args.show, feed: args.feed, discoverItems });
  log(`${args.show}: ${episodes.length} feed items; ${report.length} DAI rows in scope; K=${k} carry a feed denominator`);
  log(formatTable(report));

  const out = serialise(next);
  if (args.dryRun) { log("(dry run: nothing written)"); return { k, report, changed: out !== raw }; }
  if (out !== raw) { writeFileSync(args.sources, out); log(`wrote ${args.sources}`); }
  else log("no change");
  return { k, report, changed: out !== raw };
}

if (isEntryScript(import.meta.url)) {
  main().catch((err) => {
    console.error(`backfill-audio-bytes: ${err.message}`);
    process.exit(2);
  });
}
