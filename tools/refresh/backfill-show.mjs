/* One-shot show backfill — get a NEWLY CURATED show's chosen episodes into the
   pipeline. Not part of the nightly; run by hand, re-runnable, idempotent
   (dedup happens downstream in resolve.mjs and merge.mjs, which are unchanged).

   WHY THIS EXISTS. `scan.mjs` is a nightly: it reads the newest **10** items of
   each feed and keeps those published inside a 48-hour window. Both are correct
   for a catalogue that already holds the show. Neither can reach a show added
   to `data/catalog.json` today, whose entire back catalogue is older than the
   window and deeper than the slice — so before this script the only way to
   curate a show's episodes was to hand-write `fresh-pending.json`, which is
   exactly the un-versioned per-night code the `tools/refresh/` consolidation
   deleted (see README: machinery is code, content is data).

   It emits the same `fresh-pending.json` shape `scan.mjs` emits, so the rest of
   the pipeline is reused verbatim:

     backfill-show.mjs --show <id> ──▶ backfill-pending.json
       ──▶ PENDING_PATH=... resolve.mjs ──▶ resolved.json
       ──▶ agent authors edits.json ──▶ merge.mjs ──▶ data/discover.json

   TWO THINGS IT DELIBERATELY DOES NOT DO.

   1. **It never writes `data-local/refresh-state.json`.** `scan.mjs` records a
      seen-guid list per show, and a backfill that stamped those guids would
      teach the nightly that episodes it has never merged are already handled.
      This script reads no state and writes none.
   2. **It defaults to a DIFFERENT output file** (`backfill-pending.json`), so a
      backfill run cannot clobber a nightly scan that is mid-flight. Point
      `resolve.mjs` at it with `PENDING_PATH`.

      **The word doing the work there is DEFAULT.** `PENDING_PATH` is the same env
      var `scan.mjs` writes and `resolve.mjs` reads, and the hand-off recipe in the
      README has you exporting it — so a backfill and a nightly scan sharing one
      shell DO write the same file, and this script cannot tell. Use `--out`, which
      wins over the env var, if the two could overlap. Named rather than fixed
      because the env var is how the rest of `tools/refresh/` is wired and a
      script that ignored it would be the more surprising object.

   `--newest` DEFAULTS TO 25 AND THAT NUMBER IS NOT ARBITRARY. `resolve.mjs`
   looks episodes up at `limit=25`, which is roughly a year on a weekly show
   (measured 2026-08-19: Cider Chat at limit=25 reaches back to 2026-01-21, at
   limit=200 to 2022-03-23). Anything this script emits from deeper than the
   iTunes window resolves to no trackId and `resolve.mjs` drops it — correctly,
   since the trackId is the only trustworthy duplicate guard. So the default
   matches the window rather than the feed, and asking for more is allowed but
   will report drops.

   Usage:
     node tools/refresh/backfill-show.mjs --show cider-chat
     node tools/refresh/backfill-show.mjs --show cider-chat --show whiskycast
     node tools/refresh/backfill-show.mjs --show cider-chat --match "how cider is made" --match 489
     node tools/refresh/backfill-show.mjs --show cider-chat --newest 60 --dry-run

   Env overrides (mirrors the rest of tools/refresh/):
     PENDING_PATH   output (default data-local/backfill-pending.json)          */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve as resolvePath } from "node:path";
import { createRequire } from "node:module";
import { audioFieldsFrom } from "./enclosure.mjs";
import { UA } from "../segments/politeness.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/* Re-exported, not re-declared: this module's public surface has carried `UA`
   since before `politeness.mjs` owned the string. */
export { UA };
const THROTTLE_MS = 1500;
export const DEFAULT_NEWEST = 25;

const text = (v) => (v == null ? null : typeof v === "object" ? (v["#text"] ?? null) : String(v));

/** itunes:duration -> whole minutes. Same three shapes scan.mjs accepts. */
export function normDuration(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (/^\d+$/.test(s)) return Math.round(Number(s) / 60);
  const parts = s.split(":").map(Number);
  if (parts.some(isNaN)) return null;
  if (parts.length === 3) return Math.round(parts[0] * 60 + parts[1] + parts[2] / 60);
  if (parts.length === 2) return Math.round(parts[0] + parts[1] / 60);
  return null;
}

export class BackfillError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Case-insensitive substring, on the raw title. Deliberately NOT the search
    engine's matcher: this is an operator naming episodes they have already
    chosen, not a query, and the word-boundary rules that make `gin` safe in a
    search would stop `489` matching `489: Natural Cider Production Seminar`. */
export function titleMatches(title, needles) {
  if (!needles || needles.length === 0) return true;
  const t = String(title || "").toLowerCase();
  return needles.some((n) => t.includes(String(n).toLowerCase()));
}

/** The channel's `<item>`s as an array. fast-xml-parser collapses a single-item
    feed to one object, and a document that is not RSS at all (an HTML error page
    served with a 200, which is what a dead feed usually looks like) yields
    nothing — both have to be told apart from a real feed, and neither may be
    reported as a successful run of zero episodes. */
export function feedItems(doc, showId = "?") {
  /* `||`, NOT `??`, and the difference is a real defect this file already shipped
     once: fast-xml-parser renders `<item></item>` and `<item/>` as the empty STRING,
     which `??` passes through to a one-element array. The run then emits zero records
     and exits 0 saying BACKFILL_COMPLETE — the exact silent success this script exists
     to make impossible. `""` is falsy, so `||` sends it to the guard below. */
  let items = doc?.rss?.channel?.item || [];
  if (!Array.isArray(items)) items = [items];
  if (items.length === 0) {
    throw new BackfillError("EMPTY_FEED", `${showId}: feed has zero <item> entries (or is not RSS)`);
  }
  return items;
}

/** Picks the episodes to emit, newest-first as the feed declares them.
    `--newest` is applied to the FEED, then `--match` filters inside it, in that
    order — the reverse would let a `--match` reach past the iTunes window and
    produce rows resolve.mjs can only drop.

    ZERO MATCHES IS AN ERROR AND THAT IS THE POINT OF THE FUNCTION. A typo'd
    `--match` and a feed with nothing to backfill must never look the same to the
    operator, because the second is a fine outcome and the first is a silently
    wasted run. This guard used to live in `main()`, which no test can reach —
    it was moved here so it could be pinned. */
export function selectEpisodes(items, { newest = DEFAULT_NEWEST, match = [], showId = "?" } = {}) {
  if (!Number.isInteger(newest) || newest < 1) {
    throw new BackfillError("BAD_NEWEST", `--newest must be a positive integer, got ${newest}`);
  }
  const window = items.slice(0, newest);
  const chosen = window.filter((it) => titleMatches(text(it.title), match));
  if (chosen.length === 0) {
    throw new BackfillError(
      "NO_MATCH",
      `${showId}: 0 of the newest ${newest} feed items matched ${JSON.stringify(match)}. ` +
        `An empty backfill and a satisfied one must never look the same, so this is an error.`
    );
  }
  return chosen;
}

/** The pending file's envelope. `episodes` IS THE KEY resolve.mjs reads; naming it
    anything else produces a file that parses, validates as JSON, and resolves zero
    episodes. Built here rather than inline in main() so a test can read it. */
export function buildPayload({ shows, match, newest, episodes, now = new Date() }) {
  return {
    generated_at: now.toISOString(),
    source: "backfill-show",
    shows: shows.map((s) => s.show_id),
    match,
    newest,
    episodes,
  };
}

/** Where the pending file goes, in precedence order: `--out`, then `PENDING_PATH`,
    then the default.

    THE DEFAULT IS NOT `fresh-pending.json` AND `PENDING_PATH` IS A KNOWN HOLE.
    Invariant #2 in this file's header — "a backfill run cannot clobber a nightly
    scan that is mid-flight" — holds for the DEFAULT and not for the env var, because
    `scan.mjs` and `resolve.mjs` read the same `PENDING_PATH`. The README's own
    hand-off flow has you exporting it in the shell, so a backfill and a nightly in
    one shell will write the same file. Use `--out` to be sure; the flag wins over
    the env var precisely so there is a way to be sure. */
export function resolveOutPath({ out = null, env = {}, root = ROOT, cwd = process.cwd() } = {}) {
  if (out) return resolvePath(cwd, out);
  if (env.PENDING_PATH) return resolvePath(cwd, env.PENDING_PATH);
  return join(root, "data-local", "backfill-pending.json");
}

/** One RSS <item> -> one fresh-pending.json record. Field-for-field the shape
    scan.mjs pushes, because resolve.mjs reads that shape and nothing here is
    allowed to teach it a second one. `topics` comes from the SHOW's
    taxonomy_node_ids, which is how a curated show labels its episodes. */
export function pendingRecord(show, it) {
  /* `text()` already unwraps the `{ "#text": … }` form fast-xml-parser produces for
     `<guid isPermaLink="false">`, so there is no ternary here. scan.mjs writes one
     and it is dead code there too; a mutation test on the copied ternary came back
     green, which is what found it. */
  const guid = text(it.guid) || text(it.enclosure?.["@_url"]);
  const title = text(it.title);
  let pub = null;
  try { const d = new Date(it.pubDate); pub = isNaN(d) ? null : d; } catch (_) { /* unparseable */ }
  if (!guid || !title || !pub) {
    return { record: null, reason: !guid ? "no guid" : !title ? "no title" : "unparseable pubDate" };
  }
  const desc = String(text(it.description) || text(it["itunes:summary"]) || "")
    .replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);
  const audio = audioFieldsFrom(it);
  return {
    record: {
      show: show.title,
      show_id: show.show_id || null,
      apple_collection_id: show.apple_collection_id,
      artwork_url: show.artwork_url || null,
      topics: show.taxonomy_node_ids || [],
      guid, title,
      release_date: pub.toISOString().slice(0, 10),
      duration_min: normDuration(it["itunes:duration"]),
      duration_sec: audio.duration_sec,
      audio_url: audio.audio_url,
      audio_type: audio.audio_type,
      audio_bytes: audio.audio_bytes,
      description: desc,
      explicit_hint: /yes|true|explicit/i.test(String(text(it["itunes:explicit"]) || "")),
    },
    reason: audio.reason,
  };
}

/** Resolves `--show` names against the curated catalogue. Throws rather than
    warning: a typo'd show_id that silently produced zero episodes would look
    identical to a feed that has nothing to backfill, and the operator would
    believe the second. */
export function resolveShows(catalog, names) {
  if (!names || names.length === 0) {
    throw new BackfillError("NO_SHOW", "--show is required (a show_id from data/catalog.json)");
  }
  const byId = new Map(catalog.shows.map((s) => [s.show_id, s]));
  const shows = [];
  for (const n of names) {
    const s = byId.get(n);
    if (!s) throw new BackfillError("NO_SUCH_SHOW", `no show_id ${JSON.stringify(n)} in data/catalog.json`);
    if (!s.feed_url) throw new BackfillError("NO_FEED", `${n} has no feed_url`);
    shows.push(s);
  }
  return shows;
}

// -------------------------------------------------------------------- main --

export const VALUE_FLAGS = ["--show", "--match", "--newest", "--out"];
export const BARE_FLAGS = ["--dry-run"];

/** REFUSES WHAT IT DOES NOT UNDERSTAND, rather than ignoring it. A silently
    dropped flag is the worst outcome this script has: `--newst 60` used to mean
    "--newest 25 and say nothing", and `--show --dry-run` used to mean "look up a
    show called `--dry-run`". Both report a successful run against the wrong
    input, which is the same failure `NO_MATCH` exists to prevent, one layer up. */
export function parseArgs(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    if (BARE_FLAGS.includes(a)) continue;
    if (!VALUE_FLAGS.includes(a)) {
      throw new BackfillError("BAD_FLAG", `unknown flag ${JSON.stringify(a)}. Known: ${[...VALUE_FLAGS, ...BARE_FLAGS].join(" ")}`);
    }
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) {
      throw new BackfillError("MISSING_VALUE", `${a} needs a value, got ${v === undefined ? "end of arguments" : JSON.stringify(v)}`);
    }
    i++; // consume the value, so it is never itself read as a flag
  }
  const many = (flag) => argv.reduce((acc, a, i) => (a === flag && argv[i + 1] !== undefined ? [...acc, argv[i + 1]] : acc), []);
  const one = (flag, fallback) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
  };
  return {
    shows: many("--show").flatMap((v) => v.split(",").map((s) => s.trim()).filter(Boolean)),
    match: many("--match"),
    newest: Number(one("--newest", String(DEFAULT_NEWEST))),
    dryRun: argv.includes("--dry-run"),
    out: one("--out", null),
  };
}

async function fetchFeed(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow" });
  if (!res.ok) throw new BackfillError(`HTTP_${res.status}`, `${url}: HTTP ${res.status}`);
  return res.text();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const catalog = JSON.parse(readFileSync(join(ROOT, "data", "catalog.json"), "utf8"));
  const shows = resolveShows(catalog, args.shows);

  const backendRequire = createRequire(join(ROOT, "backend", "package.json"));
  const { XMLParser } = backendRequire("fast-xml-parser");
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", trimValues: true });

  const episodes = [];
  const withheld = [];
  const skipped = [];
  for (const show of shows) {
    await new Promise((r) => setTimeout(r, THROTTLE_MS));
    const doc = parser.parse(await fetchFeed(show.feed_url));
    const items = feedItems(doc, show.show_id);
    const chosen = selectEpisodes(items, {
      newest: args.newest, match: args.match, showId: show.show_id,
    });
    for (const it of chosen) {
      const { record, reason } = pendingRecord(show, it);
      if (!record) { skipped.push(`${show.show_id} :: ${text(it.title)} :: ${reason}`); continue; }
      if (reason) withheld.push(`${show.title} :: ${record.title} :: ${reason}`);
      episodes.push(record);
    }
    console.log(`  ${show.show_id}: ${chosen.length} of ${items.length} feed items selected`);
  }

  const payload = buildPayload({ shows, match: args.match, newest: args.newest, episodes });
  const outPath = resolveOutPath({ out: args.out, env: process.env });

  if (args.dryRun) {
    console.log(`--dry-run: ${episodes.length} episode(s) would go to ${outPath}`);
  } else {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(payload, null, 2));
    console.log(`${episodes.length} episode(s) -> ${outPath}`);
  }
  const withAudio = episodes.filter((e) => e.audio_url).length;
  console.log(`audio urls: ${withAudio}/${episodes.length}`);
  for (const w of withheld) console.warn(`  withheld: ${w}`);
  for (const s of skipped) console.warn(`  skipped: ${s}`);
  console.log("BACKFILL_COMPLETE");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`${e.code ? e.code + ": " : ""}${e.message}`);
    process.exit(1);
  });
}
