#!/usr/bin/env node
/* Build the podcast RSS feed from the two committed manifests.
 *
 *   node tools/podcast/build-feed.mjs --base-url https://podcast.example.org
 *        [--out data-local/podcast/feed] [--include-drafts]
 *   node tools/podcast/build-feed.mjs --check [--base-url https://...]
 *
 * Inputs:  data/podcast/channel.json, data/podcast/episodes.json
 * Outputs: <out>/feed.xml and <out>/chapters/<guid>.json (Podcasting 2.0 JSON
 *          Chapters). <out> defaults to data-local/podcast/feed, never committed.
 *
 * No network, no keys, no dependencies: the XML is written by hand. Going live
 * is: upload audio + feed, point Apple/Spotify at the feed URL
 * (docs/podcast/hosting.md). An upload command is deliberately NOT here yet.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CHANNEL_PATH = "data/podcast/channel.json";
const EPISODES_PATH = "data/podcast/episodes.json";
export const DEFAULT_OUT = path.join("data-local", "podcast", "feed");

/* ------------------------------------------------------------- primitives */

/* XML text/attribute escaping. Also drops characters XML 1.0 forbids. */
export function esc(s) {
  return String(s)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/* CDATA that survives "]]>" in the content by splitting the section. */
export function cdata(s) {
  return "<![CDATA[" + String(s).replace(/]]>/g, "]]]]><![CDATA[>") + "]]>";
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function rfc2822(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`bad date: ${iso}`);
  const p = (n) => String(n).padStart(2, "0");
  return `${DAYS[d.getUTCDay()]}, ${p(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
}

export function hms(sec) {
  const t = Math.round(sec);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(Math.floor(t / 3600))}:${p(Math.floor((t % 3600) / 60))}:${p(t % 60)}`;
}

const isHttps = (u) => typeof u === "string" && /^https:\/\/[^\s/]+/.test(u);
const join = (base, key) => base.replace(/\/+$/, "") + "/" + key.replace(/^\/+/, "");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const plain = (html) => String(html).replace(/<[^>]*>/g, " ").replace(/&[a-z#0-9]+;/gi, " ");

/* ------------------------------------------------------------- validation */

/* Returns a list of problems (strings).
   opts.baseUrl            the https base URL, when one was given
   opts.prior              episodes from git HEAD, or null
   opts.priorChannelGuid   podcast_guid from git HEAD, or null
   opts.publishReady       also demand what only a live feed needs (default true) */
export function validate(channel, episodes, opts = {}) {
  const out = [];
  const bad = (m) => out.push(m);
  const publishReady = opts.publishReady !== false;
  const published = episodes.filter((e) => e.status === "published");

  if (opts.baseUrl !== undefined && !isHttps(opts.baseUrl)) bad(`base URL must be https:// (got ${JSON.stringify(opts.baseUrl)})`);
  for (const k of ["title", "author", "description", "language"]) if (!channel[k]) bad(`channel.${k} is required`);
  if (!UUID.test(channel.podcast_guid || "")) bad("channel.podcast_guid must be a lowercase UUID");
  if (!Array.isArray(channel.categories) || !channel.categories.length) bad("channel.categories is required");
  if (typeof channel.explicit !== "boolean") bad("channel.explicit must be true or false");

  if (publishReady || published.length) {
    if (!channel.owner || !channel.owner.email) bad("channel.owner.email is required before publish (null today)");
    if (!channel.artwork) bad("channel.artwork is required before publish (square 1400-3000 px JPEG/PNG; null today)");
    if (!isHttps(channel.link)) bad("channel.link must be an https URL before publish");
  }

  const guids = new Map();
  const forayIds = new Set();
  for (const e of episodes) {
    const id = e.foray_id || e.guid || "?";
    if (!UUID.test(e.guid || "")) bad(`episode ${id}: guid must be a lowercase UUID`);
    if (guids.has(e.guid)) bad(`duplicate guid ${e.guid} (${guids.get(e.guid)} and ${id})`);
    guids.set(e.guid, id);
    if (forayIds.has(e.foray_id)) bad(`duplicate foray_id ${e.foray_id}`);
    forayIds.add(e.foray_id);
    if (!["draft", "published"].includes(e.status)) bad(`episode ${id}: status must be draft or published`);
    for (const k of ["title", "summary", "description", "foray_id"]) if (!e[k]) bad(`episode ${id}: ${k} is required`);
    if (!(e.duration_sec > 0)) bad(`episode ${id}: duration_sec must be positive`);
  }

  for (const e of published) {
    const id = e.foray_id;
    if (!e.pub_date || Number.isNaN(Date.parse(e.pub_date))) bad(`episode ${id}: published episodes need a valid pub_date`);
    if (!Array.isArray(e.audio) || !e.audio.length) bad(`episode ${id}: no audio entries`);
    for (const a of e.audio || []) {
      if (!(a.bytes > 0)) bad(`episode ${id}: ${a.format} audio needs bytes`);
      if (!/^[0-9a-f]{64}$/.test(a.sha256 || "")) bad(`episode ${id}: ${a.format} audio needs a sha256`);
      else if (a.key !== `episodes/${e.guid}/${a.sha256.slice(0, 12)}.${a.format}`) bad(`episode ${id}: ${a.format} key is not content-addressed (episodes/<guid>/<sha256-12>.${a.format})`);
    }
    if (!(e.audio || []).some((a) => a.format === "mp3")) bad(`episode ${id}: an mp3 is required for the feed enclosure`);
    const text = plain(e.description);
    if (!(e.sources || []).length) bad(`episode ${id}: no sources (attribution is mandatory)`);
    for (const s of e.sources || []) if (!text.includes(s.show)) bad(`episode ${id}: description does not name source show "${s.show}"`);
  }

  /* A guid never changes for an existing foray_id, and none vanishes. */
  if (opts.prior) {
    for (const p of opts.prior) {
      const now = episodes.find((e) => e.foray_id === p.foray_id);
      if (!now) bad(`episode ${p.foray_id} was removed; a guid already in the repo must not vanish`);
      else if (now.guid !== p.guid) bad(`guid for ${p.foray_id} changed (${p.guid} -> ${now.guid}); guids are permanent`);
    }
  }
  if (opts.priorChannelGuid && channel.podcast_guid !== opts.priorChannelGuid) bad(`channel.podcast_guid changed (${opts.priorChannelGuid} -> ${channel.podcast_guid}); it is permanent`);
  return out;
}

/* ---------------------------------------------------------------- builders */

export function chaptersJson(ep) {
  return { version: "1.2.0", chapters: ep.chapters.map((c) => ({ startTime: c.start_sec, title: c.title })) };
}

function personTags(people, indent) {
  return (people || []).map((p) => `${indent}<podcast:person role="${esc(p.role || "guest")}"${p.href ? ` href="${esc(p.href)}"` : ""}>${esc(p.name)}</podcast:person>\n`).join("");
}

export function buildFeed(channel, episodes, { baseUrl, includeDrafts = false }) {
  const list = episodes.filter((e) => e.status === "published" || includeDrafts);
  const title = channel.title + (includeDrafts ? " (preview)" : "");
  const feedUrl = join(baseUrl, "feed.xml");
  const hasEmail = channel.owner && channel.owner.email;
  let x = `<?xml version="1.0" encoding="UTF-8"?>\n`;
  x += `<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:podcast="https://podcastindex.org/namespace/1.0">\n<channel>\n`;
  x += `  <title>${esc(title)}</title>\n`;
  if (channel.link) x += `  <link>${esc(channel.link)}</link>\n`;
  x += `  <atom:link href="${esc(feedUrl)}" rel="self" type="application/rss+xml"/>\n`;
  x += `  <description>${esc(channel.description)}</description>\n`;
  x += `  <language>${esc(channel.language)}</language>\n`;
  x += `  <itunes:author>${esc(channel.author)}</itunes:author>\n`;
  x += `  <itunes:type>${esc(channel.type || "episodic")}</itunes:type>\n`;
  x += `  <itunes:explicit>${channel.explicit ? "true" : "false"}</itunes:explicit>\n`;
  if (channel.artwork) x += `  <itunes:image href="${esc(join(baseUrl, channel.artwork.key))}"/>\n`;
  for (const c of channel.categories) {
    x += c.sub
      ? `  <itunes:category text="${esc(c.name)}"><itunes:category text="${esc(c.sub)}"/></itunes:category>\n`
      : `  <itunes:category text="${esc(c.name)}"/>\n`;
  }
  if (channel.owner && (channel.owner.name || hasEmail)) {
    x += `  <itunes:owner>\n`;
    if (channel.owner.name) x += `    <itunes:name>${esc(channel.owner.name)}</itunes:name>\n`;
    if (hasEmail) x += `    <itunes:email>${esc(channel.owner.email)}</itunes:email>\n`;
    x += `  </itunes:owner>\n`;
  }
  x += `  <podcast:guid>${esc(channel.podcast_guid)}</podcast:guid>\n`;
  x += `  <podcast:locked${hasEmail ? ` owner="${esc(channel.owner.email)}"` : ""}>${channel.locked ? "yes" : "no"}</podcast:locked>\n`;
  if (channel.funding && channel.funding.url) x += `  <podcast:funding url="${esc(channel.funding.url)}">${esc(channel.funding.text || "Support the show")}</podcast:funding>\n`;
  x += personTags(channel.people, "  ");

  for (const e of list) {
    const mp3 = e.audio.find((a) => a.format === "mp3") || e.audio[0];
    x += `  <item>\n`;
    x += `    <title>${esc(e.title)}</title>\n`;
    x += `    <description>${esc(e.summary)}</description>\n`;
    x += `    <content:encoded>${cdata(e.description)}</content:encoded>\n`;
    x += `    <guid isPermaLink="false">${esc(e.guid)}</guid>\n`;
    if (e.pub_date) x += `    <pubDate>${rfc2822(e.pub_date)}</pubDate>\n`;
    x += `    <enclosure url="${esc(join(baseUrl, mp3.key))}" length="${mp3.bytes}" type="${esc(mp3.type)}"/>\n`;
    x += `    <itunes:title>${esc(e.title)}</itunes:title>\n`;
    if (e.subtitle) x += `    <itunes:subtitle>${esc(e.subtitle)}</itunes:subtitle>\n`;
    x += `    <itunes:summary>${esc(e.summary)}</itunes:summary>\n`;
    x += `    <itunes:duration>${hms(e.duration_sec)}</itunes:duration>\n`;
    x += `    <itunes:explicit>${e.explicit ? "true" : "false"}</itunes:explicit>\n`;
    x += `    <itunes:episodeType>${esc(e.episode_type || "full")}</itunes:episodeType>\n`;
    if (e.season) x += `    <itunes:season>${e.season}</itunes:season>\n`;
    if (e.episode) x += `    <itunes:episode>${e.episode}</itunes:episode>\n`;
    if (e.chapters && e.chapters.length) x += `    <podcast:chapters url="${esc(join(baseUrl, `chapters/${e.guid}.json`))}" type="application/json+chapters"/>\n`;
    x += personTags(e.people, "    ");
    x += `  </item>\n`;
  }
  x += `</channel>\n</rss>\n`;
  return x;
}

/* --------------------------------------------------------------------- CLI */

function gitHead(root) {
  const show = (p) => JSON.parse(execFileSync("git", ["show", `HEAD:${p}`], { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString());
  try {
    const episodes = show(EPISODES_PATH).episodes;
    let channelGuid = null;
    try { channelGuid = show(CHANNEL_PATH).podcast_guid; } catch { /* channel not in HEAD yet */ }
    return { episodes, channelGuid };
  } catch {
    return null; /* no git, or the manifest is new in this commit */
  }
}

export function parseArgs(argv) {
  const a = { baseUrl: undefined, out: DEFAULT_OUT, includeDrafts: false, check: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--base-url") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) a.baseUrl = ""; /* missing value: invalid, reported by validate */
      else { a.baseUrl = next; i++; }
    } else if (v.startsWith("--base-url=")) a.baseUrl = v.slice(11);
    else if (v === "--out") a.out = argv[++i];
    else if (v === "--include-drafts") a.includeDrafts = true;
    else if (v === "--check") a.check = true;
    else if (v === "--help" || v === "-h") a.help = true;
    else throw new Error(`unknown argument ${v}`);
  }
  return a;
}

export function main(argv = process.argv.slice(2), root = ROOT) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log("usage: build-feed.mjs --base-url https://host [--out dir] [--include-drafts] | --check [--base-url https://host]");
    return 0;
  }
  const channel = JSON.parse(fs.readFileSync(path.join(root, CHANNEL_PATH), "utf8"));
  const episodes = JSON.parse(fs.readFileSync(path.join(root, EPISODES_PATH), "utf8")).episodes;
  const head = gitHead(root);
  const problems = validate(channel, episodes, {
    baseUrl: args.baseUrl,
    prior: head && head.episodes,
    priorChannelGuid: head && head.channelGuid,
    publishReady: args.check,
  });
  if (!args.check && args.baseUrl === undefined) problems.unshift("--base-url https://... is required");
  if (problems.length) {
    for (const p of problems) console.error("podcast: " + p);
    return 1;
  }
  const published = episodes.filter((e) => e.status === "published").length;
  if (args.check) {
    console.log(`podcast: ok (${episodes.length} episodes, ${published} published)`);
    return 0;
  }
  const out = path.resolve(root, args.out);
  const list = episodes.filter((e) => e.status === "published" || args.includeDrafts);
  fs.mkdirSync(path.join(out, "chapters"), { recursive: true });
  fs.writeFileSync(path.join(out, "feed.xml"), buildFeed(channel, episodes, args));
  for (const e of list) {
    if (e.chapters && e.chapters.length) fs.writeFileSync(path.join(out, "chapters", `${e.guid}.json`), JSON.stringify(chaptersJson(e), null, 2) + "\n");
  }
  console.log(`podcast: wrote ${path.join(out, "feed.xml")} (${list.length} episodes)`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());
