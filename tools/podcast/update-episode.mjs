#!/usr/bin/env node
/* After `render-episode.py finish`: write the rendered audio's bytes, sha256,
 * content-addressed keys, duration and chapters into data/podcast/episodes.json,
 * in the fields and key scheme tools/podcast/build-feed.mjs validates.
 *
 *   node tools/podcast/update-episode.mjs <foray-id> --dir <render-out> [--manifest path] [--dry-run]
 *
 * <render-out> holds report.json plus the two encodes named in it. Nothing else
 * in the episode entry is touched (guid, status, pub_date, show notes, `render`).
 * Refuses a report whose true-peak check failed, an encode that is missing, and
 * a report without chapters.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { isEntryScript } from "../ci/entry.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const EPISODES_PATH = "data/podcast/episodes.json";
/* mp3 first: it is the feed enclosure (build-feed.mjs requires one). */
export const FORMATS = [
  { format: "mp3", type: "audio/mpeg" },
  { format: "m4a", type: "audio/mp4" },
];

export function audioKey(guid, sha256, format) {
  return `episodes/${guid}/${sha256.slice(0, 12)}.${format}`;
}

/* The manifest stores whole seconds (a chapter must not start after its audio does). */
export function chaptersFromReport(report) {
  if (!Array.isArray(report.chapters) || !report.chapters.length) throw new Error("report.json has no chapters");
  return report.chapters.map((c) => ({ start_sec: Math.floor(c.start), title: c.title }));
}

export function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/* files: {mp3: {bytes, sha256}, m4a: {...}}. Returns a new manifest; the input is not mutated. */
export function updateManifest(manifest, forayId, report, files) {
  const idx = manifest.episodes.findIndex((e) => e.foray_id === forayId);
  if (idx < 0) throw new Error(`no episode for Foray ${forayId} in ${EPISODES_PATH}`);
  if (report.true_peak_ok === false) throw new Error("report.json says the true-peak check failed; not recording this render");
  if (!(report.duration_sec > 0)) throw new Error("report.json has no duration_sec");
  const ep = manifest.episodes[idx];
  const audio = FORMATS.map(({ format, type }) => {
    const f = files[format];
    if (!f) throw new Error(`no ${format} file`);
    if (!(f.bytes > 0)) throw new Error(`${format} is empty`);
    return { format, type, bytes: f.bytes, sha256: f.sha256, key: audioKey(ep.guid, f.sha256, format) };
  });
  const next = { ...ep, duration_sec: report.duration_sec, audio, chapters: chaptersFromReport(report) };
  const episodes = manifest.episodes.slice();
  episodes[idx] = next;
  return { ...manifest, episodes };
}

export function parseArgs(argv) {
  const a = { id: null, dir: null, manifest: null, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--dir") a.dir = argv[++i];
    else if (v === "--manifest") a.manifest = argv[++i];
    else if (v === "--dry-run") a.dryRun = true;
    else if (v === "--help" || v === "-h") a.help = true;
    else if (v.startsWith("--")) throw new Error(`unknown argument ${v}`);
    else if (a.id) throw new Error(`unexpected argument ${v}`);
    else a.id = v;
  }
  return a;
}

export function main(argv = process.argv.slice(2), root = ROOT) {
  let a;
  try { a = parseArgs(argv); } catch (e) { console.error("update-episode: " + e.message); return 2; }
  if (a.help || !a.id || !a.dir) {
    console.log("usage: update-episode.mjs <foray-id> --dir <render-out> [--manifest path] [--dry-run]");
    return a.help ? 0 : 2;
  }
  try {
    const manifestPath = a.manifest || path.join(root, EPISODES_PATH);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const report = JSON.parse(fs.readFileSync(path.join(a.dir, "report.json"), "utf8"));
    const files = {};
    for (const { format } of FORMATS) {
      const name = Object.keys(report.final || {}).find((n) => n.endsWith("." + format));
      if (!name) throw new Error(`report.json has no ${format} entry under "final"`);
      const file = path.join(a.dir, name);
      if (!fs.existsSync(file)) throw new Error(`${file} is missing`);
      files[format] = { bytes: fs.statSync(file).size, sha256: sha256File(file) };
    }
    const next = updateManifest(manifest, a.id, report, files);
    const ep = next.episodes.find((e) => e.foray_id === a.id);
    if (a.dryRun) console.log(JSON.stringify({ duration_sec: ep.duration_sec, audio: ep.audio, chapters: ep.chapters.length }, null, 2));
    else fs.writeFileSync(manifestPath, JSON.stringify(next, null, 2) + "\n");
    console.log(`update-episode: ${a.id}: ${ep.audio.map((x) => `${x.format} ${x.bytes} B`).join(", ")}, ${ep.chapters.length} chapters, ${ep.duration_sec} s${a.dryRun ? " (dry run)" : ""}`);
    return 0;
  } catch (e) {
    console.error("update-episode: " + e.message);
    return 1;
  }
}

if (isEntryScript(import.meta.url)) process.exitCode = main();
