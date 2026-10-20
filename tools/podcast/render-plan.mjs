#!/usr/bin/env node
/* Foray id -> plan.json, the input to tools/podcast/render-episode.py.
 *
 *   node tools/podcast/render-plan.mjs <foray-id> [--out plan.json] [--channels stereo|mono]
 *
 * Ported from the flagship builder's make-plan.mjs (#1457, part of #1425). It
 * reads only committed data: data/forays.json (item order, narration scripts,
 * segment ids), data/segments.json (the cut points: start_sec / end_sec),
 * data/segment-sources.json (enclosure URL and feed duration) and
 * data/podcast/episodes.json (title, shows, and the episode's `render` block).
 *
 * Chapter titles are NOT derivable from the other data (the flagship's were
 * written by hand), so they live in the episode entry's `render.chapter_titles`
 * ({narration id: title}). A narration without one falls back to its slot
 * title and the plan carries a warning. One chapter per narration item.
 *
 * Seam types (the gap itself is chosen by render-episode.py, #1452):
 *   tape-narr, narr-tape, narr-narr, tape-tape.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isEntryScript } from "../ci/entry.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const PLAN_VERSION = 1;
export const ALBUM = "4a Forays";

export function seamType(prevType, type) {
  return `${prevType === "narr" ? "narr" : "tape"}-${type === "narr" ? "narr" : "tape"}`;
}

/* "Jan Smit on Resolving ..." -> "Jan Smit"; null when the title has no " on ". */
export function speakerFromTitle(title) {
  const m = / on /.exec(title || "");
  return m ? title.slice(0, m.index) : null;
}

export function buildPlan({ foray, segments, sources, episode, channels = "stereo" }) {
  if (!foray) throw new Error("foray not found");
  if (!["stereo", "mono"].includes(channels)) throw new Error(`channels must be stereo or mono (got ${channels})`);
  const segById = new Map(segments.map((s) => [s.id, s]));
  const srcById = new Map(sources.map((s) => [s.id, s]));
  const slotTitle = new Map((foray.slots || []).map((s) => [s.id, s.title]));
  const titles = (episode && episode.render && episode.render.chapter_titles) || {};
  const items = [];
  const warnings = [];
  let prev = null;
  for (const it of foray.items) {
    let item;
    if (it.type === "narration") {
      if (!it.script) throw new Error(`narration ${it.id}: no script`);
      let chapter = titles[it.id];
      if (!chapter) {
        chapter = slotTitle.get(it.slot) || it.id;
        warnings.push(`narration ${it.id}: no render.chapter_titles entry, chapter falls back to "${chapter}"`);
      }
      item = { type: "narr", id: it.id, text: it.script, chapter };
    } else if (it.type === "segment") {
      const seg = segById.get(it.segment_id);
      if (!seg) throw new Error(`${it.label}: segment ${it.segment_id} is not in data/segments.json`);
      const src = srcById.get(seg.item_id);
      if (!src) throw new Error(`${it.label}: source ${seg.item_id} is not in data/segment-sources.json`);
      if (!src.audio_url) throw new Error(`${it.label}: source ${src.id} has no audio_url`);
      if (!(seg.end_sec > seg.start_sec)) throw new Error(`${it.label}: segment ${seg.id} has end <= start`);
      item = {
        type: "clip", label: it.label, segment_id: it.segment_id, source_id: src.id, show: src.show,
        speaker: speakerFromTitle(src.title) || it.label.split("-")[0], title: src.title,
        url: src.audio_url, feed_duration_sec: src.duration_sec, in: seg.start_sec, out: seg.end_sec,
      };
    } else throw new Error(`item type ${it.type} is not renderable`);
    item.i = items.length;
    item.seam_before = prev ? seamType(prev, item.type) : null;
    prev = item.type;
    items.push(item);
  }
  const shows = [...new Set(items.filter((x) => x.type === "clip").map((x) => x.show))];
  const r = (episode && episode.render) || {};
  const title = (episode && episode.title) || foray.title;
  return {
    version: PLAN_VERSION, foray_id: foray.id, channels,
    title,
    artist: r.artist || `4a Foray (clips: ${shows.join(", ")})`,
    album: r.album || ALBUM,
    comment: r.comment || `Clips from ${shows.join(" and ")}. Narration written with AI, synthetic voice.`,
    basename: r.basename || title.split(/[,:]/)[0].toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
    items,
    chapters: items.filter((x) => x.type === "narr").map((x) => ({ item: x.i, title: x.chapter })),
    seams: items.filter((x) => x.seam_before).map((x) => ({ before_item: x.i, type: x.seam_before })),
    warnings,
  };
}

export function loadPlan(forayId, { root = ROOT, channels } = {}) {
  const j = (p) => JSON.parse(fs.readFileSync(path.join(root, p), "utf8"));
  const foray = j("data/forays.json").forays.find((f) => f.id === forayId);
  if (!foray) throw new Error(`no Foray ${forayId} in data/forays.json`);
  const episode = j("data/podcast/episodes.json").episodes.find((e) => e.foray_id === forayId);
  return buildPlan({ foray, segments: j("data/segments.json").segments, sources: j("data/segment-sources.json").sources, episode, channels });
}

export function parseArgs(argv) {
  const a = { id: null, out: null, channels: "stereo", help: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--out") a.out = argv[++i];
    else if (v === "--channels") a.channels = argv[++i];
    else if (v === "--help" || v === "-h") a.help = true;
    else if (v.startsWith("--")) throw new Error(`unknown argument ${v}`);
    else if (a.id) throw new Error(`unexpected argument ${v}`);
    else a.id = v;
  }
  return a;
}

export function main(argv = process.argv.slice(2), root = ROOT) {
  let args;
  try { args = parseArgs(argv); } catch (e) { console.error("render-plan: " + e.message); return 2; }
  if (args.help || !args.id) {
    console.log("usage: render-plan.mjs <foray-id> [--out plan.json] [--channels stereo|mono]");
    return args.help ? 0 : 2;
  }
  let plan;
  try { plan = loadPlan(args.id, { root, channels: args.channels }); } catch (e) { console.error("render-plan: " + e.message); return 1; }
  const text = JSON.stringify(plan, null, 1) + "\n";
  if (args.out) fs.writeFileSync(args.out, text); else process.stdout.write(text);
  for (const w of plan.warnings) console.error("render-plan: warning: " + w);
  console.error(`render-plan: ${plan.items.length} items (${plan.items.filter((x) => x.type === "clip").length} clips), ${plan.chapters.length} chapters`);
  return 0;
}

if (isEntryScript(import.meta.url)) process.exitCode = main();
