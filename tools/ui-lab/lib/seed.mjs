/* Deterministic localStorage profiles for the app target. Everything is derived
 * from the committed data files (discover.json, catalog-client.json), picked by
 * a fixed rule (first N items with distinct shows that carry audio + artwork),
 * so two runs on the same checkout seed identical profiles. Keys are the app's
 * own `cp_` keys; values are written exactly the way app.js's lsSet writes them
 * (JSON.stringify), through the init script in walk.mjs.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

/** The frozen "now" every run starts from (2026-10-05 12:00 UTC). */
export const FIXED_NOW_ISO = "2026-10-05T12:00:00.000Z";
const FIXED_NOW = Date.parse(FIXED_NOW_ISO);
const daysAgo = (n) => new Date(FIXED_NOW - n * 86400000).toISOString();

const readJson = (root, rel) => JSON.parse(readFileSync(path.join(root, rel), "utf8"));

/** First `n` items with audio + artwork, one per show, in file order. */
function pickItems(discover, n) {
  const seen = new Set();
  const out = [];
  for (const it of discover.items) {
    if (!it.audio_url || !it.artwork_url || !it.title || !it.show) continue;
    if (seen.has(it.show)) continue;
    seen.add(it.show);
    out.push(it);
    if (out.length >= n) break;
  }
  return out;
}

const LONG_TITLE =
  "The extraordinarily long and winding story of how a small group of researchers across three continents " +
  "spent eleven years arguing about whether the thing they measured was real";
const LONG_SHOW = "The Institute for the Long-Term Study of Remarkably Verbose Podcast Names Volume Two";
const LONG_TOKEN = "Supercalifragilisticexpialidocious-Electroencephalographically-Counterrevolutionaries-Unconstitutionally";

const trimSnap = (it, extra = {}) => ({ ...it, ...extra });
const partOf = (it) => {
  const p = { id: it.id, title: it.title, show: it.show };
  for (const f of ["duration_min", "topics", "release_date", "apple_collection_id", "apple_track_id"]) if (it[f] != null) p[f] = it[f];
  return p;
};

/** Everything a profile may need: picked items, shows, and the raw data. */
export function loadFixtures(repoRoot) {
  const discover = readJson(repoRoot, "data/discover.json");
  const catalog = readJson(repoRoot, "data/catalog-client.json");
  const taxonomy = readJson(repoRoot, "data/taxonomy.json");
  const forays = readJson(repoRoot, "data/forays.json");
  const items = pickItems(discover, 16);
  const shows = catalog.shows.filter((s) => s.title && s.artwork_url).slice(0, 8);
  const tagged = catalog.shows.find((s) => Array.isArray(s.taxonomy_node_ids) && s.taxonomy_node_ids.length);
  const category = tagged ? tagged.taxonomy_node_ids[0] : "engineering";
  return { items, shows, taxonomy, category, forays: forays.forays || [], episodeIds: items.map((i) => i.id) };
}

function playlistsOf(items, titles) {
  return titles.map((title, i) => {
    const slice = items.slice(i * 3, i * 3 + 4);
    return {
      id: "p" + (i + 1),
      title,
      items: slice.map(partOf),
      item_ids: slice.map((s) => s.id),
      created: daysAgo(9 - i * 3),
      last_played_at: i === 2 ? null : daysAgo(1 + i),
      sparse: false,
    };
  });
}

/**
 * @param {string} kind  empty | dismissed | returning | stress
 * @returns {Record<string, unknown>}  localStorage key -> JSON-serialisable value
 */
export function buildSeed(kind, fx) {
  if (kind === "empty") return {};
  const base = { cp_intro_dismissed: true };
  if (kind === "dismissed") return base;

  const items = fx.items.map((it) => ({ ...it }));
  if (kind === "stress") {
    items[0] = { ...items[0], id: "uilab-stress-1", title: LONG_TITLE, show: LONG_SHOW, hook: LONG_TITLE + ". " + LONG_TITLE };
    items[1] = { ...items[1], id: "uilab-stress-2", title: LONG_TOKEN + " " + LONG_TOKEN, show: LONG_TOKEN };
  }

  const saved = {};
  items.slice(0, kind === "stress" ? 6 : 9).forEach((it, i) => { saved[it.id] = trimSnap(it, { saved_at: daysAgo(i + 1) }); });
  const snaps = {};
  items.forEach((it) => { snaps[it.id] = trimSnap(it); });

  const starred = {};
  fx.shows.slice(0, kind === "stress" ? 3 : 6).forEach((s, i) => {
    starred[s.show_id] = { show_id: s.show_id, title: i === 0 && kind === "stress" ? LONG_SHOW : s.title, artwork_url: s.artwork_url || null, starred_at: daysAgo(i + 2) };
  });

  const playlistTitles = kind === "stress"
    ? [LONG_TITLE, "Short one", LONG_TOKEN]
    : ["The fusion reactor tour", "Short histories for a long drive", "How things get built"];

  return {
    ...base,
    cp_saved: saved,
    cp_episode_snaps: snaps,
    cp_queue: items.slice(0, kind === "stress" ? 4 : 5).map((i) => i.id),
    cp_history: items.slice(5, 11).map((i) => i.id),
    cp_playlists: playlistsOf(items, playlistTitles),
    cp_starred_shows: starred,
  };
}

export { LONG_TITLE, LONG_SHOW, LONG_TOKEN };
