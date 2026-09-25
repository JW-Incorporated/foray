/* Nightly resolve — STATIC machinery (committed). Reads fresh-pending.json,
   resolves apple_track_id for each episode via the iTunes lookup API, dedups
   against discover.json + session.json, drops unresolvable/duplicate/invalid-
   topic episodes, and writes resolved.json — the credential-free digest the
   merge step (and, in the cloud, the Claude Cloud agent) consumes.

   Keyless: iTunes lookup only. No secrets. Safe to run in GitHub Actions.

   Inputs (override paths via env):
     PENDING_PATH   scan output          (default data-local/fresh-pending.json)
     RESOLVED_PATH  digest to write      (default data-local/resolved.json)
     STATE_PATH     scan state to carry retries in (default: the `state_path`
                    scan.mjs recorded in the pending file; none -> no carry)

   Each resolved item carries `_description` (the episode's real blurb) so the
   agent can author a grounded hook; everything else is final.

   MATCHING (audit round 3, data-tools-2). An episode is matched to an iTunes
   track by something that cannot collide, in this order:
     1. the RSS guid against iTunes `episodeGuid`;
     2. the enclosure URL against iTunes `episodeUrl` (scheme, query and
        fragment ignored);
     3. the exact normalised title.
   The substring and word-overlap fallbacks survive only with a release date
   within one day of the episode's. Without that guard "How to Build a
   Startup, Part 3" matched Part 2 (every long word overlaps) and "Episode 12"
   matched "Episode 120" (substring), so a new episode was dropped as a
   `dup trackId`, or published with another episode's Apple id and audio.
   docs/adr/0002-episode-identity-and-dedup.md already says Part 1 and Part 2
   must never collide.

   CARRY FORWARD, NEVER LOSE. scan.mjs marks every guid it emits as seen, so a
   drop here used to be permanent. Two drops are not final:
     - the lookup FAILED (three non-OK answers or errors): reported per show in
       `lookup_failures`, never treated as "no match";
     - the lookup worked but the episode is not in it yet (iTunes indexes new
       episodes hours after the feed has them).
   Both go on a retry list, written to the digest (`retry`) and to the scan
   state (`state.retry`), which scan.mjs re-emits the next night. After
   MAX_RETRY_NIGHTS the episode is dropped for good, with a reason that says
   so. */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hostOf, normalizeAudioUrl } from "./enclosure.mjs";
import { NIGHTLY_UA } from "../segments/politeness.mjs";

/** Nights an unresolved episode is retried before it is dropped for good. */
export const MAX_RETRY_NIGHTS = 3;

/** How far apart an episode's RSS date and an iTunes release date may be for
    a fuzzy title match to count. */
export const FUZZY_DATE_WINDOW_DAYS = 1;

/** The slug normaliser for ids. ASCII on purpose: it builds the committed
    `<show>--<slug>` ids, and changing it would change ids. Matching uses
    `matchKey` below instead. */
const norm = (s) =>
  (s || "").toLowerCase().replace(/&amp;/g, "&").replace(/[^a-z0-9]+/g, " ").trim();
export const slugify = (s) => norm(s).split(" ").filter(Boolean).slice(0, 6).join("-");

/** The title key for MATCHING: Unicode letters and digits, accents folded,
    so a title in any script can match itself and an empty key matches
    nothing. */
export function matchKey(s) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** An audio URL reduced to what identifies the file: host (lowercased) and
    path. Scheme, query (tracking tokens) and fragment are ignored. */
export function urlKey(u) {
  if (!u) return null;
  try {
    const x = new URL(String(u).trim());
    return `${x.host.toLowerCase()}${x.pathname}`;
  } catch (_) {
    return null;
  }
}

function daysApart(isoA, isoB) {
  const a = Date.parse(String(isoA || "").slice(0, 10));
  const b = Date.parse(String(isoB || "").slice(0, 10));
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Infinity;
  return Math.abs(a - b) / 86_400_000;
}

/** Picks the iTunes track for one pending episode, or null. Returns
    `{ track, by }` so the digest can say how each match was made. */
export function matchTrack(eps, ep) {
  const guid = String(ep.guid || "").trim();
  if (guid) {
    const hit = eps.find((e) => e.episodeGuid && String(e.episodeGuid).trim() === guid);
    if (hit) return { track: hit, by: "guid" };
  }
  const uk = urlKey(ep.audio_url);
  if (uk) {
    const hit = eps.find((e) => urlKey(e.episodeUrl) === uk);
    if (hit) return { track: hit, by: "url" };
  }
  const nt = matchKey(ep.title);
  if (!nt) return null;
  const exact = eps.find((e) => matchKey(e.trackName) === nt);
  if (exact) return { track: exact, by: "title" };

  // Fuzzy only on the same release date (±1 day): a sequel with the same
  // long words is published on a different day.
  const dated = eps.filter((e) => daysApart(e.releaseDate, ep.release_date) <= FUZZY_DATE_WINDOW_DAYS);
  const sub = dated.find((e) => {
    const ne = matchKey(e.trackName);
    return ne && (ne.includes(nt) || nt.includes(ne));
  });
  if (sub) return { track: sub, by: "title-substring+date" };
  const tt = new Set(nt.split(" ").filter((w) => w.length > 3));
  let best = null, bestScore = 0;
  for (const e of dated) {
    const ew = new Set(matchKey(e.trackName).split(" ").filter((w) => w.length > 3));
    let overlap = 0;
    for (const w of tt) if (ew.has(w)) overlap++;
    const score = tt.size ? overlap / tt.size : 0;
    if (score > bestScore) { bestScore = score; best = e; }
  }
  return bestScore >= 0.6 ? { track: best, by: "title-overlap+date" } : null;
}

/** One show's recent episodes from the iTunes lookup. A lookup that never
    got a usable answer is `{ ok:false, error }`, NOT an empty list: an outage
    is not evidence that the episode does not exist. */
export async function lookupEpisodes(collectionId, { fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), attempts = 3 } = {}) {
  const url = `https://itunes.apple.com/lookup?id=${collectionId}&entity=podcastEpisode&limit=25`;
  let error = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await fetchImpl(url, { headers: { "User-Agent": NIGHTLY_UA } });
      if (res.ok) {
        const data = await res.json();
        const eps = (data?.results || []).filter((r) => r.wrapperType === "podcastEpisode");
        return { ok: true, eps };
      }
      error = `HTTP ${res.status}`;
    } catch (e) {
      error = e?.message || String(e);
    }
    if (attempt < attempts - 1) await sleep(800);
  }
  return { ok: false, error: error || "no answer" };
}

/** The pure resolve pass. `lookup(collectionId)` returns what lookupEpisodes
    returns. Returns the digest's arrays plus the retry list. */
export async function resolveEpisodes({ pending, discover, session, taxonomy, lookup }) {
  const nodeIds = new Set(taxonomy.nodes.map((n) => n.id));
  const existingIds = new Set(discover.items.map((i) => i.id));
  Object.keys(session.episodes).forEach((id) => existingIds.add(id));
  const existingTrackIds = new Set();
  discover.items.forEach((i) => i.apple_track_id && existingTrackIds.add(i.apple_track_id));
  Object.values(session.episodes).forEach((e) => e.apple_track_id && existingTrackIds.add(e.apple_track_id));

  // id-style helper: match the show's existing slug prefix in discover.json
  const showPrefix = new Map();
  for (const i of discover.items) {
    const pre = i.id.split("--")[0];
    if (!showPrefix.has(i.show)) showPrefix.set(i.show, pre);
  }

  const cache = new Map();
  const lookupOnce = async (cid) => {
    if (!cache.has(cid)) cache.set(cid, await lookup(cid));
    return cache.get(cid);
  };

  const resolved = [];
  const dropped = [];
  const retry = [];
  const lookupFailures = [];
  const failedShows = new Set();
  const seenTrackThisRun = new Set();
  const matchedBy = {};
  // Audio provenance (issue #21). RSS is authoritative — corner case #1 wants
  // the publisher's own declared URL so their download counts stay honest.
  // iTunes `episodeUrl` is a fallback for feeds that omitted the enclosure.
  // The two genuinely differ (measured: content.blubrry vs ins.blubrry for the
  // same episode), so the disagreement rate is logged, not treated as an error.
  const audio = { fromRss: 0, fromItunes: 0, missing: 0, hostDisagreements: 0 };

  const carry = (ep, reason) => {
    if (!ep.guid) { dropped.push({ show: ep.show, title: ep.title, reason: `${reason}; no guid to carry it by` }); return; }
    const attempts = (Number(ep._retry_attempts) || 0) + 1;
    if (attempts >= MAX_RETRY_NIGHTS) {
      dropped.push({ show: ep.show, title: ep.title, reason: `${reason}; gave up after ${attempts} night(s)` });
      return;
    }
    // Not dropped: carried. It is in `retry`, not `dropped`, until it resolves
    // or runs out of nights.
    const { _retry_attempts, ...item } = ep;
    retry.push({ guid: ep.guid, attempts, reason, item });
  };

  for (const ep of pending.episodes) {
    const look = await lookupOnce(ep.apple_collection_id);
    if (!look.ok) {
      if (!failedShows.has(ep.apple_collection_id)) {
        failedShows.add(ep.apple_collection_id);
        lookupFailures.push({ show: ep.show, apple_collection_id: ep.apple_collection_id, error: look.error });
      }
      carry(ep, `iTunes lookup failed (${look.error})`);
      continue;
    }
    const m = matchTrack(look.eps, ep);
    if (!m || !m.track.trackId) {
      carry(ep, "no trackId match");
      continue;
    }
    const track = m.track;
    const trackId = track.trackId;
    if (existingTrackIds.has(trackId) || seenTrackThisRun.has(trackId)) {
      dropped.push({ show: ep.show, title: ep.title, reason: `dup trackId ${trackId}` });
      continue;
    }
    const validTopics = (ep.topics || []).filter((t) => nodeIds.has(t));
    if (validTopics.length === 0) {
      dropped.push({ show: ep.show, title: ep.title, reason: `no valid topic (${(ep.topics || []).join(",")})` });
      continue;
    }
    const pre = showPrefix.get(ep.show) || ep.show_id;
    const id = `${pre}--${slugify(ep.title)}`;
    // Ids are deduped against existingIds alone, which gains every id this
    // run publishes on the next line. (A second clause that looked the id up in
    // seenTrackThisRun asked a set of numeric trackIds about a string slug: always
    // false, and deleted -- audit round 3, data-tools-15.)
    if (existingIds.has(id)) {
      dropped.push({ show: ep.show, title: ep.title, reason: `dup id ${id}` });
      continue;
    }
    existingIds.add(id);
    seenTrackThisRun.add(trackId);
    matchedBy[m.by] = (matchedBy[m.by] || 0) + 1;

    let audioUrl = ep.audio_url || null;
    let audioType = ep.audio_type || null;
    if (audioUrl) {
      audio.fromRss++;
      const itunesUrl = track.episodeUrl || null;
      if (itunesUrl && hostOf(itunesUrl) !== hostOf(audioUrl)) audio.hostDisagreements++;
    } else {
      // Same gate as the RSS path — http upgraded, tokens withheld. iTunes
      // `episodeUrl` is frequently cleartext, so this is not a rare branch.
      const { url: fallback } = normalizeAudioUrl(track.episodeUrl);
      if (fallback) {
        audioUrl = fallback;
        audioType = track.episodeFileExtension ? `audio/${track.episodeFileExtension}` : null;
        audio.fromItunes++;
      } else {
        audio.missing++;
      }
    }

    resolved.push({
      id,
      show: ep.show,
      title: ep.title,
      apple_collection_id: ep.apple_collection_id,
      apple_track_id: trackId,
      apple_episode_url: track.trackViewUrl || null,
      release_date: ep.release_date,
      duration_min: ep.duration_min,
      duration_sec: ep.duration_sec ?? null,
      audio_url: audioUrl,
      audio_type: audioType,
      audio_bytes: ep.audio_bytes ?? null,
      artwork_url: ep.artwork_url || track.artworkUrl600 || null,
      topics: validTopics,
      explicit: (track.contentAdvisoryRating || "").toLowerCase() === "explicit",
      _description: ep.description,
    });
  }

  return { resolved, dropped, retry, lookupFailures, matchedBy, audio };
}

/** The retry list scan.mjs re-emits: last night's unresolved episodes, each
    tagged with how many nights it has been tried. One that has since reached
    the pool (same show and title) is not re-emitted. */
export function retryItems(state, knownTitles = new Set()) {
  const out = [];
  for (const [guid, entry] of Object.entries(state?.retry || {})) {
    const item = entry?.item;
    if (!item || !guid) continue;
    if (knownTitles.has(item.show + "::" + item.title)) continue;
    out.push({ ...item, guid, _retry_attempts: Number(entry.attempts) || 0 });
  }
  return out;
}

/** Writes the retry list into the scan state, replacing the previous one:
    this run's pending already included last night's retries, so what is
    still unresolved is exactly `retry`. */
export function writeRetryState(statePath, retry) {
  let state = { seen: {} };
  try { state = JSON.parse(readFileSync(statePath, "utf8")); } catch (_) { /* fresh state */ }
  state.retry = Object.fromEntries(retry.map((r) => [r.guid, { attempts: r.attempts, reason: r.reason, item: r.item }]));
  writeFileSync(statePath, JSON.stringify(state));
  return state;
}

async function main() {
  const root = new URL("../../", import.meta.url);
  const p = (rel) => fileURLToPath(new URL(rel, root));
  // If the env override is set, resolve it as a filesystem path relative to cwd
  // (works on Windows + POSIX). Otherwise fall back to the repo-relative default.
  const envPath = (name, def) => (process.env[name] ? resolvePath(process.cwd(), process.env[name]) : def && p(def));

  const PENDING_PATH = envPath("PENDING_PATH", "data-local/fresh-pending.json");
  const RESOLVED_PATH = envPath("RESOLVED_PATH", "data-local/resolved.json");

  const pending = JSON.parse(readFileSync(PENDING_PATH, "utf8"));
  const discover = JSON.parse(readFileSync(p("data/discover.json"), "utf8"));
  const session = JSON.parse(readFileSync(p("data/session.json"), "utf8"));
  const taxonomy = JSON.parse(readFileSync(p("data/taxonomy.json"), "utf8"));

  // Retries are carried only in the state of the scan that produced this
  // pending file (or an explicit STATE_PATH). A backfill-show pending file
  // names no state, so its unresolved rows never enter the nightly's.
  const STATE_PATH = envPath("STATE_PATH", null) || pending.state_path || null;

  const out = await resolveEpisodes({ pending, discover, session, taxonomy, lookup: (cid) => lookupEpisodes(cid) });

  writeFileSync(RESOLVED_PATH, JSON.stringify({
    generated_at: new Date().toISOString(),
    resolved: out.resolved,
    dropped: out.dropped,
    // Carried to the next night's scan (see the header); here so the digest
    // shows what is still pending rather than only what was dropped.
    retry: out.retry.map((r) => ({ show: r.item.show, title: r.item.title, attempts: r.attempts, reason: r.reason })),
    lookup_failures: out.lookupFailures,
    // S-11: passed through verbatim from fresh-pending.json (scan.mjs
    // --source index) so the digest carries the curation-candidates section
    // all the way to the agent that authors edits.json — changed.json ∩
    // top.json's NOT-curated shows, i.e. fresh activity nobody has curated
    // in. Absent/full-scan nights simply carry an empty array; nothing here
    // treats that as an error.
    candidates: pending.candidates || [],
  }, null, 2));
  if (STATE_PATH && existsSync(STATE_PATH)) {
    writeRetryState(STATE_PATH, out.retry);
    console.log(`retry: ${out.retry.length} episode(s) carried to the next scan via ${STATE_PATH}`);
  } else if (out.retry.length) {
    console.log(`retry: ${out.retry.length} episode(s) unresolved; no scan state to carry them in (backfill or manual run)`);
  }

  const { audio } = out;
  console.log(`RESOLVED ${out.resolved.length} / DROPPED ${out.dropped.length} -> ${RESOLVED_PATH}`);
  console.log(`matched by: ${JSON.stringify(out.matchedBy)}`);
  console.log(`audio: ${audio.fromRss} from RSS, ${audio.fromItunes} from iTunes fallback, ${audio.missing} unresolved` +
    (audio.hostDisagreements ? ` (${audio.hostDisagreements} RSS/iTunes host disagreement(s) — RSS wins)` : ""));
  for (const f of out.lookupFailures) console.log(`  LOOKUP FAILED: ${f.show} (${f.apple_collection_id}): ${f.error}`);
  for (const d of out.dropped) console.log(`  drop: ${d.show} :: ${d.title} :: ${d.reason}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
}
