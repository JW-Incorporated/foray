/* One-shot backfill — add audio provenance to catalogue items that predate
   issue #21. Not part of the nightly; run by hand, re-runnable, idempotent.

   Usage:
     node tools/refresh/backfill-audio.mjs --dry-run    # report, write nothing
     node tools/refresh/backfill-audio.mjs              # write data files
     node tools/refresh/backfill-audio.mjs --force      # re-resolve everything
     node tools/refresh/backfill-audio.mjs --limit 10   # first N shows only

   STRATEGY — RSS primary, iTunes fallback. This is the inverse of what the
   issue originally proposed, and the reason is measured (see the review on
   #20): the iTunes lookup API returns only recent episodes. At limit=25 (what
   resolve.mjs uses) it reached back just ~12 months on a weekly show; even at
   limit=200 it stops around 3 years. But 162 of the 993 discover items and 14
   of the 27 session episodes predate 2026 — the hand-curated flagship session
   is majority back-catalogue, so an iTunes-first strategy fails precisely on
   the content that matters most.

   The RSS feed carries the full back catalogue (Lex: 499 items in one 2 MB
   fetch) with enclosure url, length, type and itunes:duration all present.
   Corner case #1 also wants the publisher's own declared URL so their download
   counts stay honest, which RSS is and iTunes is not — the two genuinely
   differ (content.blubrry vs ins.blubrry for the same episode).

   One fetch per SHOW, not per episode. Corner case #7 warns about multi-MB
   feeds; corner case #8 wants per-host politeness, hence the throttle.        */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { audioFieldsFrom, hostOf } from "./enclosure.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const backendRequire = createRequire(join(ROOT, "backend", "package.json"));
const { XMLParser } = backendRequire("fast-xml-parser");

const UA = "Foray/0.1 (personal podcast client; contact wjduvall@gmail.com)";
const THROTTLE_MS = 1500;

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const FORCE = args.includes("--force");
const LIMIT = args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : Infinity;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (v) => (v == null ? null : typeof v === "object" ? (v["#text"] ?? null) : String(v));
const norm = (s) => (s || "").toLowerCase().replace(/&amp;/g, "&").replace(/[^a-z0-9]+/g, " ").trim();

/* ---------- matching (corner case #3: composite identity) ----------
   GUIDs are unstable across republishes and we don't have them for existing
   catalogue items anyway, so match on normalised title, then confirm with the
   publish date. Titles drift slightly (a "#497 – " prefix added later, an
   em-dash swapped); dates are the tiebreak when several candidates fit. */

function candidateScore(itemTitle, feedTitle) {
  const a = norm(itemTitle), b = norm(feedTitle);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.9;
  const aw = new Set(a.split(" ").filter((w) => w.length > 3));
  const bw = new Set(b.split(" ").filter((w) => w.length > 3));
  if (!aw.size) return 0;
  let overlap = 0;
  for (const w of aw) if (bw.has(w)) overlap++;
  return overlap / aw.size;
}

function dayDiff(a, b) {
  if (!a || !b) return null;
  const d = Math.abs(new Date(a) - new Date(b));
  return Number.isNaN(d) ? null : d / 86_400_000;
}

/** Best feed entry for a catalogue item, or null. Title similarity dominates;
    a close publish date rescues a weak title match and breaks ties. */
function bestMatch(item, entries) {
  let best = null, bestScore = 0;
  for (const e of entries) {
    let score = candidateScore(item.title, e.title);
    if (score < 0.5) continue;
    const dd = dayDiff(item.release_date, e.date);
    if (dd != null) {
      if (dd <= 2) score += 0.25;        // same episode, near-certain
      else if (dd > 400) score -= 0.35;  // a rebroadcast or a title collision
    }
    if (score > bestScore) { bestScore = score; best = e; }
  }
  return bestScore >= 0.75 ? best : null;
}

/* ---------- iTunes fallback ---------- */

const itunesCache = new Map();
async function itunesEpisodes(collectionId) {
  if (itunesCache.has(collectionId)) return itunesCache.get(collectionId);
  const url = `https://itunes.apple.com/lookup?id=${collectionId}&entity=podcastEpisode&limit=200`;
  let eps = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "foray-nightly/1.0" } });
      if (res.ok) {
        const data = await res.json();
        eps = (data.results || []).filter((r) => r.wrapperType === "podcastEpisode");
        break;
      }
    } catch (_) { /* retry */ }
    await sleep(800);
  }
  itunesCache.set(collectionId, eps);
  return eps;
}

/* ---------- main ---------- */

const catalog = JSON.parse(readFileSync(join(ROOT, "data", "catalog.json"), "utf8"));
const discover = JSON.parse(readFileSync(join(ROOT, "data", "discover.json"), "utf8"));
const session = JSON.parse(readFileSync(join(ROOT, "data", "session.json"), "utf8"));

const feedByCollection = new Map(
  (catalog.shows || []).filter((s) => s.feed_url).map((s) => [s.apple_collection_id, s])
);

// Every target in one list so discover items and session episodes take the
// identical code path — a divergence here is exactly how the flagship session
// ends up unplayable while the counters look fine.
const targets = [
  ...discover.items.map((i) => ({ ref: i, where: "discover" })),
  ...Object.entries(session.episodes).map(([id, e]) => ({ ref: { id, ...e }, node: e, where: "session" })),
];

const needsWork = targets.filter((t) => FORCE || !t.ref.audio_url);
const byShow = new Map();
for (const t of needsWork) {
  const cid = t.ref.apple_collection_id;
  if (!cid) continue;
  if (!byShow.has(cid)) byShow.set(cid, []);
  byShow.get(cid).push(t);
}

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", trimValues: true });
const stats = { rss: 0, itunes: 0, unmatched: 0, withheld: 0, feedFail: 0, noFeed: 0, disagree: 0 };
const unresolved = [];

const shows = [...byShow.entries()].slice(0, LIMIT);
console.log(`${needsWork.length} item(s) need audio across ${byShow.size} show(s); processing ${shows.length}\n`);

let n = 0;
for (const [cid, items] of shows) {
  n++;
  const show = feedByCollection.get(cid);
  const label = show?.title || `collection ${cid}`;
  if (!show) {
    stats.noFeed += items.length;
    items.forEach((t) => unresolved.push({ id: t.ref.id, show: label, reason: "no feed_url in catalog" }));
    continue;
  }

  await sleep(THROTTLE_MS);
  let entries = [];
  let feedError = null;
  try {
    const res = await fetch(show.feed_url, { headers: { "User-Agent": UA }, redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const doc = parser.parse(await res.text());
    let raw = doc?.rss?.channel?.item || [];
    if (!Array.isArray(raw)) raw = [raw];
    entries = raw.map((it) => {
      const a = audioFieldsFrom(it);
      let date = null;
      try { const d = new Date(it.pubDate); date = Number.isNaN(+d) ? null : d.toISOString().slice(0, 10); } catch (_) {}
      return { title: text(it.title) || "", date, ...a };
    });
  } catch (e) {
    // Do NOT give up on the show — fall through with no entries so every item
    // still gets the iTunes fallback below. `omega tau` fails chronically and
    // its episodes are recent enough that iTunes can often rescue them.
    feedError = e.message;
    console.log(`[${n}/${shows.length}] ${label}: FEED ERROR ${e.message} — falling back to iTunes`);
  }

  let hit = 0, missItems = [];
  for (const t of items) {
    const m = bestMatch(t.ref, entries);
    if (m && m.audio_url) {
      apply(t, { audio_url: m.audio_url, audio_type: m.audio_type, audio_bytes: m.audio_bytes, duration_sec: m.duration_sec });
      stats.rss++; hit++;
    } else if (m && m.reason) {
      stats.withheld++;
      unresolved.push({ id: t.ref.id, show: label, reason: m.reason });
    } else {
      missItems.push(t);
    }
  }

  // Only the leftovers pay for an iTunes call.
  if (missItems.length) {
    const eps = await itunesEpisodes(cid);
    for (const t of missItems) {
      const ep = eps.find((e) => e.trackId === t.ref.apple_track_id);
      if (ep?.episodeUrl && /^https?:\/\//i.test(ep.episodeUrl)) {
        apply(t, {
          audio_url: ep.episodeUrl,
          audio_type: ep.episodeFileExtension ? `audio/${ep.episodeFileExtension}` : null,
          audio_bytes: null,
          duration_sec: ep.trackTimeMillis ? Math.round(ep.trackTimeMillis / 1000) : null,
        });
        stats.itunes++; hit++;
      } else {
        if (feedError) stats.feedFail++; else stats.unmatched++;
        unresolved.push({
          id: t.ref.id, show: label,
          reason: feedError ? `feed error (${feedError}) + no iTunes match` : "no RSS or iTunes match",
        });
      }
    }
  }

  if (!feedError) console.log(`[${n}/${shows.length}] ${label}: ${hit}/${items.length} resolved (${entries.length} feed items)`);
  else console.log(`    ${label}: ${hit}/${items.length} rescued via iTunes`);
}

function apply(t, fields) {
  // session episodes are nested under session.episodes[id]; discover items are
  // the array element itself. `t.node` points at the real object for session.
  const target = t.where === "session" ? t.node : t.ref;
  target.audio_url = fields.audio_url;
  target.audio_type = fields.audio_type;
  target.audio_bytes = fields.audio_bytes;
  if (fields.duration_sec != null) target.duration_sec = fields.duration_sec;
}

/* ---------- report ---------- */

const isRecent = (d) => String(d || "").slice(0, 4) >= "2026";
function coverage(list, label) {
  const recent = list.filter((x) => isRecent(x.release_date));
  const older = list.filter((x) => !isRecent(x.release_date));
  const pct = (a, b) => (b ? ((a / b) * 100).toFixed(1) : "n/a");
  const ok = (arr) => arr.filter((x) => x.audio_url).length;
  console.log(`\n${label}`);
  console.log(`  2026+     : ${ok(recent)}/${recent.length} (${pct(ok(recent), recent.length)}%)`);
  console.log(`  pre-2026  : ${ok(older)}/${older.length} (${pct(ok(older), older.length)}%)`);
  console.log(`  overall   : ${ok(list)}/${list.length} (${pct(ok(list), list.length)}%)`);
  return { recent: { ok: ok(recent), n: recent.length }, older: { ok: ok(older), n: older.length } };
}

console.log(`\n${"=".repeat(60)}`);
console.log(`resolved: ${stats.rss} from RSS, ${stats.itunes} from iTunes fallback`);
console.log(`failed  : ${stats.unmatched} unmatched, ${stats.withheld} withheld, ${stats.feedFail} feed errors, ${stats.noFeed} no feed_url`);

// Coverage is reported SEPARATELY for recent vs back catalogue. A single
// blended number is what hid this problem in the first place: 83% of the
// catalogue is 2026 content, so an iTunes-only run scores ~83% while leaving
// every older item — including most of the flagship session — unplayable.
coverage(discover.items, "discover.json");
const sessionEps = Object.values(session.episodes);
coverage(sessionEps, "session.json");

const sessionOk = sessionEps.filter((e) => e.audio_url).length;
if (sessionOk < sessionEps.length) {
  console.log(`\n!! session.json is ${sessionOk}/${sessionEps.length} — the acceptance bar for #21 is 100%.`);
}

if (unresolved.length) {
  console.log(`\nUNRESOLVED (${unresolved.length}):`);
  for (const u of unresolved.slice(0, 40)) console.log(`  ${u.show} :: ${u.id} :: ${u.reason}`);
  if (unresolved.length > 40) console.log(`  … and ${unresolved.length - 40} more`);
}

if (DRY) {
  console.log("\n--dry-run: no files written.");
} else {
  discover.built_at = new Date().toISOString();
  writeFileSync(join(ROOT, "data", "discover.json"), JSON.stringify(discover, null, 2) + "\n");
  writeFileSync(join(ROOT, "data", "session.json"), JSON.stringify(session, null, 2) + "\n");
  console.log("\nwrote data/discover.json + data/session.json");
}
