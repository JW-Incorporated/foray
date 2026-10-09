/* One-shot backfill — add audio provenance to catalogue items that predate
   issue #21. Not part of the nightly; run by hand, re-runnable, idempotent.

   Usage:
     node tools/refresh/backfill-audio.mjs --dry-run    # report, write nothing
     node tools/refresh/backfill-audio.mjs              # write data files
     node tools/refresh/backfill-audio.mjs --force      # re-resolve discover items
     node tools/refresh/backfill-audio.mjs --limit 10   # first N shows only

   --force re-resolves DISCOVER items only. session.json is text-patched, and
   the patch fills a block only when its audio fields are empty (see
   session-patch.mjs; a block that already carries audio_url is left alone and
   the verify step then refuses the run, deliberately). So a session episode
   that already has audio is never a target, with or without --force: forcing
   it used to abort the whole run, discover refresh included, on the first
   session URL that had moved (code-health-2 T1-02, CH2-36).

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
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { audioFieldsFrom, hostOf, normalizeAudioUrl } from "./enclosure.mjs";
import { UA } from "../segments/politeness.mjs";
import { minutesFromSeconds } from "../check-durations.mjs";
import { prepareSessionPatch } from "./session-patch.mjs";
import { fetchFeedCapped } from "./fetch-limits.mjs";
import { text, feedParser } from "./feed-xml.mjs";
import { lookupEpisodes, norm } from "./resolve.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const THROTTLE_MS = 1500;

/** How far back the iTunes fallback reaches: resolve.mjs's lookup at 200
    (it uses 25), because this script exists for the back catalogue. */
const ITUNES_LIMIT = 200;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/* ---------- targets ---------- */

/** The items this run resolves. Every target sits in one list so discover
    items and session episodes take the identical code path (a divergence
    there is how the flagship session ends up unplayable while the counters
    look fine). Without --force: whatever lacks audio_url. With --force: every
    discover item, and still only the session episodes that lack audio_url --
    the session patch never overwrites a filled block (see the header). */
export function workTargets(discover, session, { force = false } = {}) {
  const targets = [
    ...discover.items.map((i) => ({ ref: i, where: "discover" })),
    ...Object.entries(session.episodes).map(([id, e]) => ({ ref: { id, ...e }, node: e, where: "session" })),
  ];
  return targets.filter((t) => (force && t.where === "discover") || !t.ref.audio_url);
}

/** One show's feed as match entries: title, ISO date and audio fields. */
async function feedEntries(feedUrl, parser) {
  // Capped and timed (code-health-2 T1-05): one hung or endless publisher
  // must not hang or OOM a 220-feed run that holds every resolution in memory.
  const doc = parser.parse(await fetchFeedCapped(feedUrl, { headers: { "User-Agent": UA } }));
  let raw = doc?.rss?.channel?.item || [];
  if (!Array.isArray(raw)) raw = [raw];
  return raw.map((it) => {
    const a = audioFieldsFrom(it);
    let date = null;
    try { const d = new Date(it.pubDate); date = Number.isNaN(+d) ? null : d.toISOString().slice(0, 10); } catch (_) {}
    return { title: text(it.title) || "", date, ...a };
  });
}

/* ---------- resolve ---------- */

/** Resolves `needsWork` show by show: RSS first, iTunes for the leftovers.
    Mutates each resolved target in place (see `apply`) and returns the
    counters and the UNRESOLVED list. The network sits behind `entriesFor`
    (show -> feed entries) and `lookup` (collection id -> resolve.mjs's
    `lookupEpisodes` answer), so a test drives it offline. */
export async function resolveAudio(needsWork, {
  feedByCollection,
  limit = Infinity,
  entriesFor,
  lookup = (cid) => lookupEpisodes(cid, { limit: ITUNES_LIMIT }),
  pause = sleep,
  log = console.log,
} = {}) {
  if (!entriesFor) {
    const parser = feedParser();
    entriesFor = (show) => feedEntries(show.feed_url, parser);
  }
  const byShow = new Map();
  for (const t of needsWork) {
    const cid = t.ref.apple_collection_id;
    if (!cid) continue;
    if (!byShow.has(cid)) byShow.set(cid, []);
    byShow.get(cid).push(t);
  }

  const stats = { rss: 0, itunes: 0, unmatched: 0, withheld: 0, feedFail: 0, lookupFail: 0, noFeed: 0, disagree: 0 };
  const unresolved = [];

  const shows = [...byShow.entries()].slice(0, limit);
  log(`${needsWork.length} item(s) need audio across ${byShow.size} show(s); processing ${shows.length}\n`);

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

    await pause(THROTTLE_MS);
    let entries = [];
    let feedError = null;
    try {
      entries = await entriesFor(show);
    } catch (e) {
      // Do NOT give up on the show — fall through with no entries so every item
      // still gets the iTunes fallback below. `omega tau` fails chronically and
      // its episodes are recent enough that iTunes can often rescue them.
      feedError = e.message;
      log(`[${n}/${shows.length}] ${label}: FEED ERROR ${e.message} — falling back to iTunes`);
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

    // Only the leftovers pay for an iTunes call. A lookup that never got an
    // answer is reported as the failure it is (resolve.mjs's semantics), not
    // as "no match": an outage is not evidence the episode is missing
    // (code-health-2 T1-11).
    if (missItems.length) {
      const look = await lookup(cid);
      const feedPart = feedError ? `feed error (${feedError}) + ` : "";
      for (const t of missItems) {
        if (!look.ok) {
          stats.lookupFail++;
          unresolved.push({ id: t.ref.id, show: label, reason: `${feedPart}iTunes lookup failed (${look.error})` });
          continue;
        }
        const ep = look.eps.find((e) => e.trackId === t.ref.apple_track_id);
        const itunesUrl = ep ? normalizeAudioUrl(ep.episodeUrl).url : null;
        if (itunesUrl) {
          apply(t, {
            audio_url: itunesUrl,
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

    if (!feedError) log(`[${n}/${shows.length}] ${label}: ${hit}/${items.length} resolved (${entries.length} feed items)`);
    else log(`    ${label}: ${hit}/${items.length} rescued via iTunes`);
  }

  return { stats, unresolved };
}

function apply(t, fields) {
  // session episodes are nested under session.episodes[id]; discover items are
  // the array element itself. `t.node` points at the real object for session.
  const target = t.where === "session" ? t.node : t.ref;
  target.audio_url = fields.audio_url;
  target.audio_type = fields.audio_type;
  target.audio_bytes = fields.audio_bytes;
  if (fields.duration_sec != null) {
    target.duration_sec = fields.duration_sec;
    /* One length per episode (audit round 2, honesty-1): the minute count
       follows the measurement, or tools/check-durations.mjs fails the pool. */
    const min = minutesFromSeconds(fields.duration_sec);
    if (min !== null && t.where !== "session") target.duration_min = min;
  }
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

/* ---------- main ---------- */

async function main() {
  const args = process.argv.slice(2);
  const DRY = args.includes("--dry-run");
  const FORCE = args.includes("--force");
  const LIMIT = args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : Infinity;

  const catalog = JSON.parse(readFileSync(join(ROOT, "data", "catalog.json"), "utf8"));
  const discover = JSON.parse(readFileSync(join(ROOT, "data", "discover.json"), "utf8"));
  const session = JSON.parse(readFileSync(join(ROOT, "data", "session.json"), "utf8"));

  const feedByCollection = new Map(
    (catalog.shows || []).filter((s) => s.feed_url).map((s) => [s.apple_collection_id, s])
  );

  const needsWork = workTargets(discover, session, { force: FORCE });
  const { stats, unresolved } = await resolveAudio(needsWork, { feedByCollection, limit: LIMIT });

  console.log(`\n${"=".repeat(60)}`);
  console.log(`resolved: ${stats.rss} from RSS, ${stats.itunes} from iTunes fallback`);
  console.log(`failed  : ${stats.unmatched} unmatched, ${stats.withheld} withheld, ${stats.feedFail} feed errors, ${stats.lookupFail} iTunes lookup failures, ${stats.noFeed} no feed_url`);

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

  /* ---------- writing ----------

     discover.json is machine-owned: merge.mjs already rewrites it wholesale with
     the same 2-space stringify, so a full re-serialise is consistent with how the
     nightly maintains it.

     session.json is NOT. It is hand-authored ("builder": "hand-architect-v1"),
     every episode block is deliberately kept on one line, and the founders read
     it. A blind JSON.stringify reformats all 27 blocks and turns 27 real edits
     into a ~670-line diff — unreviewable, and it destroys formatting somebody
     chose on purpose. So we patch its TEXT in place instead, inserting the four
     fields after `"duration_min": N` and leaving every other byte alone.        */

  /* The patch itself lives in ./session-patch.mjs, shared with classify-dai. */

  if (DRY) {
    console.log("\n--dry-run: no files written.");
  } else {
    // Never write a session.json we cannot prove is both valid and correct: it
    // is the document the whole client boots from. And prove it BEFORE writing
    // discover.json (audit round 3, data-tools-11): a verification that threw
    // after discover.json was rewritten left the two documents disagreeing.
    const sessionPath = join(ROOT, "data", "session.json");
    const original = readFileSync(sessionPath, "utf8");
    const { txt, missed } = prepareSessionPatch(original, session.episodes, { kind: "audio" });

    discover.built_at = new Date().toISOString();
    writeFileSync(join(ROOT, "data", "discover.json"), JSON.stringify(discover, null, 2) + "\n");
    if (missed.length) console.log(`WARN could not patch ${missed.length} session episode(s): ${missed.join(", ")}`);
    writeFileSync(sessionPath, txt);

    console.log("\nwrote data/discover.json (re-serialised) + data/session.json (text-patched, formatting preserved)");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
}
