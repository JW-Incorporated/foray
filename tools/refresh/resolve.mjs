/* Nightly resolve — STATIC machinery (committed). Reads fresh-pending.json,
   resolves apple_track_id for each episode via the iTunes lookup API, dedups
   against discover.json + session.json, drops unresolvable/duplicate/invalid-
   topic episodes, and writes resolved.json — the credential-free digest the
   merge step (and, in the cloud, the Claude Cloud agent) consumes.

   Keyless: iTunes lookup only. No secrets. Safe to run in GitHub Actions.

   Inputs (override paths via env):
     PENDING_PATH   scan output          (default data-local/fresh-pending.json)
     RESOLVED_PATH  digest to write      (default data-local/resolved.json)

   Each resolved item carries `_description` (the episode's real blurb) so the
   agent can author a grounded hook; everything else is final.               */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { hostOf } from "./enclosure.mjs";

const root = new URL("../../", import.meta.url);
const p = (rel) => new URL(rel, root);
// If the env override is set, resolve it as a filesystem path relative to cwd
// (works on Windows + POSIX). Otherwise fall back to the repo-relative default.
const envPath = (name, def) => (process.env[name] ? resolvePath(process.cwd(), process.env[name]) : p(def));

const PENDING_PATH = envPath("PENDING_PATH", "data-local/fresh-pending.json");
const RESOLVED_PATH = envPath("RESOLVED_PATH", "data-local/resolved.json");

const pending = JSON.parse(readFileSync(PENDING_PATH, "utf8"));
const discover = JSON.parse(readFileSync(p("data/discover.json"), "utf8"));
const session = JSON.parse(readFileSync(p("data/session.json"), "utf8"));
const taxonomy = JSON.parse(readFileSync(p("data/taxonomy.json"), "utf8"));

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

const norm = (s) =>
  (s || "").toLowerCase().replace(/&amp;/g, "&").replace(/[^a-z0-9]+/g, " ").trim();
const slugify = (s) => norm(s).split(" ").filter(Boolean).slice(0, 6).join("-");

const lookupCache = new Map();
async function lookup(collectionId) {
  if (lookupCache.has(collectionId)) return lookupCache.get(collectionId);
  const url = `https://itunes.apple.com/lookup?id=${collectionId}&entity=podcastEpisode&limit=25`;
  let data = { results: [] };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "foray-nightly/1.0" } });
      if (res.ok) { data = await res.json(); break; }
    } catch (e) { /* retry */ }
    await new Promise((r) => setTimeout(r, 800));
  }
  const eps = (data.results || []).filter((r) => r.wrapperType === "podcastEpisode");
  lookupCache.set(collectionId, eps);
  return eps;
}

function matchTrack(eps, title) {
  const nt = norm(title);
  let hit = eps.find((e) => norm(e.trackName) === nt);
  if (hit) return hit;
  hit = eps.find((e) => {
    const ne = norm(e.trackName);
    return ne && (ne.includes(nt) || nt.includes(ne));
  });
  if (hit) return hit;
  const tt = new Set(nt.split(" ").filter((w) => w.length > 3));
  let best = null, bestScore = 0;
  for (const e of eps) {
    const ew = new Set(norm(e.trackName).split(" ").filter((w) => w.length > 3));
    let overlap = 0;
    for (const w of tt) if (ew.has(w)) overlap++;
    const score = tt.size ? overlap / tt.size : 0;
    if (score > bestScore) { bestScore = score; best = e; }
  }
  return bestScore >= 0.6 ? best : null;
}

const resolved = [];
const dropped = [];
const seenTrackThisRun = new Set();
// Audio provenance (issue #21). RSS is authoritative — corner case #1 wants
// the publisher's own declared URL so their download counts stay honest.
// iTunes `episodeUrl` is a fallback for feeds that omitted the enclosure.
// The two genuinely differ (measured: content.blubrry vs ins.blubrry for the
// same episode), so the disagreement rate is logged, not treated as an error.
let audioFromRss = 0, audioFromItunes = 0, audioMissing = 0, hostDisagreements = 0;

for (const ep of pending.episodes) {
  const eps = await lookup(ep.apple_collection_id);
  const track = matchTrack(eps, ep.title);
  if (!track || !track.trackId) {
    dropped.push({ show: ep.show, title: ep.title, reason: "no trackId match" });
    continue;
  }
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
  let id = `${pre}--${slugify(ep.title)}`;
  if (existingIds.has(id) || seenTrackThisRun.has(id)) {
    dropped.push({ show: ep.show, title: ep.title, reason: `dup id ${id}` });
    continue;
  }
  existingIds.add(id);
  seenTrackThisRun.add(trackId);

  let audioUrl = ep.audio_url || null;
  let audioType = ep.audio_type || null;
  if (audioUrl) {
    audioFromRss++;
    const itunesUrl = track.episodeUrl || null;
    if (itunesUrl && hostOf(itunesUrl) !== hostOf(audioUrl)) hostDisagreements++;
  } else if (track.episodeUrl && /^https?:\/\//i.test(track.episodeUrl)) {
    audioUrl = track.episodeUrl;
    audioType = track.episodeFileExtension ? `audio/${track.episodeFileExtension}` : null;
    audioFromItunes++;
  } else {
    audioMissing++;
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

writeFileSync(RESOLVED_PATH, JSON.stringify({ generated_at: new Date().toISOString(), resolved, dropped }, null, 2));
console.log(`RESOLVED ${resolved.length} / DROPPED ${dropped.length} -> ${RESOLVED_PATH}`);
console.log(`audio: ${audioFromRss} from RSS, ${audioFromItunes} from iTunes fallback, ${audioMissing} unresolved` +
  (hostDisagreements ? ` (${hostDisagreements} RSS/iTunes host disagreement(s) — RSS wins)` : ""));
for (const d of dropped) console.log(`  drop: ${d.show} :: ${d.title} :: ${d.reason}`);
