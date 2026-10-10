#!/usr/bin/env node
/* What kind of MP3 is a Foray clip's source, and what will AVFoundation have to
 * do to start it mid-episode?
 *
 * WHY THIS EXISTS (M2 drive, 2026-10-01). The iOS native engine loads a Foray
 * clip with `AVURLAssetPreferPreciseDurationAndTimingKey = true` (plan P-7) and a
 * zero-tolerance seek. On cellular, Practical AI clips took 7.8 s, 11.2 s and
 * then 20+ s to become ready; one 21 s attempt pulled 43.9 MB (the whole file)
 * and was still not ready. Whether precise timing is worth that depends on what
 * the file IS: a CBR file seeks exactly by arithmetic, a VBR file with a Xing TOC
 * lands within the TOC's 1% granularity, and a VBR file with no TOC can land far
 * off. This tool answers that per source from the first bytes of the file.
 *
 * MANUAL, NEVER CI, and it never keeps audio (product principle #3). The header
 * probe is one ranged GET of the first 64 KB per file (plus a few 16 KB ranged
 * GETs inside the file to see whether the bitrate holds). `--scan` streams one
 * whole file through memory to build the exact time->byte index, prints numbers,
 * and keeps nothing.
 *
 *   node tools/audio/mp3-probe.mjs --foray beyond-the-algorithm-engineering-production-ai-s-e6533b
 *   node tools/audio/mp3-probe.mjs --url https://example.com/ep.mp3
 *   node tools/audio/mp3-probe.mjs --scan --at 1427.695 --url https://example.com/ep.mp3
 *   node tools/audio/mp3-probe.mjs --sources --write   # (re)classify data/segment-sources.json
 *
 * Every request goes through tools/segments/politeness.mjs (UA, per-host gate).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isEntryScript } from "../ci/entry.mjs";
import { AUDIO_PROBE_HEADERS, awaitHostSlot, discardBody } from "../segments/politeness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/* ---------- pure parsing (tested in mp3-probe.test.mjs) ---------- */

const KBPS = {
  "1-3": [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0],
  "1-2": [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 0],
  "2-3": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
};
const RATES = { 1: [44100, 48000, 32000, 0], 2: [22050, 24000, 16000, 0], 2.5: [11025, 12000, 8000, 0] };

/** Bytes an ID3v2 tag occupies at `off` (header + body + optional footer), or 0. */
export function id3v2Size(buf, off = 0) {
  if (buf.length < off + 10 || buf.toString("latin1", off, off + 3) !== "ID3") return 0;
  const s = buf.subarray(off + 6, off + 10);
  if ((s[0] | s[1] | s[2] | s[3]) & 0x80) return 0;
  const body = (s[0] << 21) | (s[1] << 14) | (s[2] << 7) | s[3];
  const footer = buf[off + 5] & 0x10 ? 10 : 0;
  return 10 + body + footer;
}

/** An MPEG audio Layer II/III frame header at `off`, or null. */
export function frameHeader(buf, off) {
  if (off + 4 > buf.length || buf[off] !== 0xff || (buf[off + 1] & 0xe0) !== 0xe0) return null;
  const vBits = (buf[off + 1] >> 3) & 3;
  const lBits = (buf[off + 1] >> 1) & 3;
  if (vBits === 1 || lBits === 0 || lBits === 3) return null; // reserved version; reserved layer; Layer I unsupported
  const version = vBits === 3 ? 1 : vBits === 2 ? 2 : 2.5;
  const layer = lBits === 1 ? 3 : 2;
  const brIdx = buf[off + 2] >> 4;
  const srIdx = (buf[off + 2] >> 2) & 3;
  const table = version === 1 ? KBPS[`1-${layer}`] : KBPS["2-3"];
  const kbps = table[brIdx];
  const sampleRate = RATES[version][srIdx];
  if (!kbps || !sampleRate) return null; // free-format or bad index
  const padding = (buf[off + 2] >> 1) & 1;
  const mono = buf[off + 3] >> 6 === 3;
  const samples = layer === 3 && version !== 1 ? 576 : 1152;
  const size = Math.floor((samples / 8) * kbps * 1000 / sampleRate) + padding;
  const sideInfo = layer !== 3 ? 0 : version === 1 ? (mono ? 17 : 32) : (mono ? 9 : 17);
  return { version, layer, kbps, sampleRate, padding, mono, samples, size, sideInfo };
}

/** First offset >= `from` holding a frame header whose successor is also a frame
    header with the same version/layer/rate (one stray 0xFFE is not a frame). */
export function findFrame(buf, from = 0, limit = buf.length) {
  for (let i = from; i + 4 <= Math.min(limit, buf.length); i++) {
    const h = frameHeader(buf, i);
    if (!h) continue;
    const n = frameHeader(buf, i + h.size);
    if (i + h.size + 4 > buf.length) return { offset: i, header: h, confirmed: false };
    if (n && n.version === h.version && n.layer === h.layer && n.sampleRate === h.sampleRate) {
      return { offset: i, header: h, confirmed: true };
    }
  }
  return null;
}

/** The Xing/Info or VBRI tag in the frame at `off`, or null. */
export function infoTag(buf, off, h) {
  const at = (o, s) => buf.toString("latin1", o, o + s.length) === s;
  const x = off + 4 + h.sideInfo;
  if (at(x, "Xing") || at(x, "Info")) {
    const kind = buf.toString("latin1", x, x + 4);
    const flags = buf.readUInt32BE(x + 4);
    let p = x + 8;
    const tag = { kind, flags, frames: null, bytes: null, toc: null, quality: null, encoder: null, delay: null, padding: null };
    if (flags & 1) { tag.frames = buf.readUInt32BE(p); p += 4; }
    if (flags & 2) { tag.bytes = buf.readUInt32BE(p); p += 4; }
    if (flags & 4) { tag.toc = [...buf.subarray(p, p + 100)]; p += 100; }
    if (flags & 8) { tag.quality = buf.readUInt32BE(p); p += 4; }
    const enc = buf.toString("latin1", p, p + 9).replace(/[^\x20-\x7e]/g, "");
    if (/^(LAME|Lavc|Lavf|L3.99|GOGO)/.test(enc)) {
      tag.encoder = enc.trim();
      if (enc.startsWith("LAME") || enc.startsWith("Lavc")) {
        const d = p + 21;
        tag.delay = (buf[d] << 4) | (buf[d + 1] >> 4);
        tag.padding = ((buf[d + 1] & 0x0f) << 8) | buf[d + 2];
      }
    }
    return tag;
  }
  const v = off + 4 + 32;
  if (at(v, "VBRI")) {
    const entries = buf.readUInt16BE(v + 18);
    return {
      kind: "VBRI", bytes: buf.readUInt32BE(v + 10), frames: buf.readUInt32BE(v + 14),
      tocEntries: entries, tocScale: buf.readUInt16BE(v + 20), tocEntrySize: buf.readUInt16BE(v + 22),
      framesPerEntry: buf.readUInt16BE(v + 24), toc: entries > 0 ? [] : null,
    };
  }
  return null;
}

/** Walk every frame from `start`. Returns the exact index (frame start bytes and
    start times), the bitrate histogram, and how many times sync was lost and
    re-found (ID3 tags or a stitch mid-stream). */
export function scanFrames(buf, start) {
  const offsets = [];
  const times = [];
  const kbps = new Map();
  let t = 0;
  let i = start;
  let resyncs = 0;
  let sampleRate = null;
  while (i + 4 <= buf.length) {
    const h = frameHeader(buf, i);
    if (!h || (sampleRate && h.sampleRate !== sampleRate)) {
      const inner = id3v2Size(buf, i);
      const next = findFrame(buf, inner ? i + inner : i + 1);
      if (!next) break;
      resyncs++;
      i = next.offset;
      continue;
    }
    sampleRate ??= h.sampleRate;
    offsets.push(i);
    times.push(t);
    kbps.set(h.kbps, (kbps.get(h.kbps) || 0) + 1);
    t += h.samples / h.sampleRate;
    i += h.size;
  }
  return { offsets, times, duration: t, kbps, resyncs, end: i };
}

/** True media time of the frame containing byte `b` (binary search over the index). */
export function timeAtByte(index, b) {
  const { offsets, times } = index;
  let lo = 0, hi = offsets.length - 1;
  if (b <= offsets[0]) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= b) lo = mid; else hi = mid - 1;
  }
  return times[lo];
}

/** Byte AVFoundation-style approximate seeking would aim at for `sec`:
    the Xing TOC when there is one (percent of duration -> 1/256ths of the stream),
    otherwise straight-line bytes at the first frame's bitrate. */
export function estimateByte({ audioStart, firstKbps, tag, durationEst, streamBytes }, sec) {
  if (tag && tag.toc && tag.kind === "Xing" && durationEst > 0) {
    const pct = Math.min(99.999, Math.max(0, (sec / durationEst) * 100));
    const i = Math.floor(pct);
    const a = tag.toc[i];
    const b = i < 99 ? tag.toc[i + 1] : 256;
    const frac = (a + (b - a) * (pct - i)) / 256;
    return audioStart + Math.round(frac * (tag.bytes || streamBytes));
  }
  return audioStart + Math.round((sec * firstKbps * 1000) / 8);
}

/** What an approximate (non-precise) seek into this file can rely on, from a
    probe: "cbr" when the first frame and every sampled window inside the file
    share one bitrate (byte arithmetic is then exact to a frame, so precise
    timing buys nothing); "vbr-toc" for VBR behind a Xing TOC or VBRI table
    (lands within ~duration/256, measured 3-8 s early on a 35-min file);
    "vbr-notoc" for VBR with neither. Null when the probe could not tell (no
    frame, too few windows read): the engine then keeps precise timing. */
export function classifySeekMap(r) {
  if (!r?.firstFrame || !Array.isArray(r.kbpsSamples) || r.kbpsSamples.length < 3) return null;
  if (r.kbpsSamples.some((s) => !s.kbps.length)) return null;
  const seen = new Set([r.firstFrame.kbps, ...r.kbpsSamples.flatMap((s) => s.kbps)]);
  if (seen.size === 1 && r.tag?.kind !== "Xing" && r.tag?.kind !== "VBRI") return "cbr";
  if ((r.tag?.kind === "Xing" && r.tag.toc) || r.tag?.kind === "VBRI") return "vbr-toc";
  return "vbr-notoc";
}

/* ---------- network ---------- */

async function get(url, range, { full = false } = {}) {
  await awaitHostSlot(url);
  const headers = { ...AUDIO_PROBE_HEADERS };
  if (range) headers.range = range; else delete headers.range;
  const t0 = performance.now();
  const res = await fetch(url, { headers, redirect: "follow" });
  const ttfb = performance.now() - t0;
  if (!full && res.status !== 206) {
    const d = await discardBody(res);
    return { res, buf: null, ttfb, ms: performance.now() - t0, note: `status ${res.status} (${d})` };
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return { res, buf, ttfb, ms: performance.now() - t0 };
}

/** One redirect chain, hop by hop, so its cellular cost is visible. */
async function hops(url) {
  const out = [];
  let u = url;
  for (let n = 0; n < 8; n++) {
    await awaitHostSlot(u);
    const t0 = performance.now();
    const res = await fetch(u, { headers: AUDIO_PROBE_HEADERS, redirect: "manual" });
    const ms = Math.round(performance.now() - t0);
    out.push({ host: new URL(u).host, status: res.status, ms });
    await discardBody(res);
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) { u = new URL(loc, u).toString(); continue; }
    break;
  }
  return out;
}

const totalOf = (res) => {
  const m = /\/(\d+)\s*$/.exec(res.headers.get("content-range") || "");
  return m ? Number(m[1]) : null;
};

export async function probe(url) {
  const r = { url, finalHost: null, ranged: null, total: null, id3: null, firstFrame: null, tag: null, kbpsSamples: [], verdict: null, hops: null };
  r.hops = await hops(url);
  const head = await get(url, "bytes=0-65535");
  r.finalHost = new URL(head.res.url).host;
  r.ranged = head.res.status === 206;
  if (!head.buf) { r.verdict = head.note; return r; }
  r.total = totalOf(head.res);
  let buf = head.buf;
  r.id3 = id3v2Size(buf);
  let base = 0;
  if (r.id3 + 4096 > buf.length) {
    const more = await get(url, `bytes=${r.id3}-${r.id3 + 65535}`);
    buf = more.buf; base = r.id3;
  }
  const f = findFrame(buf, r.id3 - base);
  if (!f) { r.verdict = "no MPEG frame found"; return r; }
  r.firstFrame = { offset: base + f.offset, ...f.header };
  r.tag = infoTag(buf, f.offset, f.header);
  // Does the bitrate hold inside the file? Four 16 KB windows.
  if (r.total) {
    for (const frac of [0.2, 0.4, 0.6, 0.8]) {
      const at = Math.floor(r.total * frac);
      const w = await get(url, `bytes=${at}-${at + 16383}`);
      if (!w.buf) continue;
      const kb = [];
      let g = findFrame(w.buf, 0);
      while (g && kb.length < 40) {
        kb.push(g.header.kbps);
        const nh = frameHeader(w.buf, g.offset + g.header.size);
        g = nh ? { offset: g.offset + g.header.size, header: nh } : null;
      }
      r.kbpsSamples.push({ frac, kbps: [...new Set(kb)] });
    }
  }
  r.seekMap = classifySeekMap(r);
  const seen = new Set([f.header.kbps, ...r.kbpsSamples.flatMap((s) => s.kbps)]);
  const kind = r.tag?.kind;
  r.verdict = seen.size === 1
    ? `CBR ${f.header.kbps} kbps${kind ? ` (${kind} frame)` : ", no header frame"}`
    : `VBR (${[...seen].sort((a, b) => a - b).join("/")} kbps)${kind === "Xing" && r.tag.toc ? " WITH Xing TOC" : kind ? ` with ${kind}${r.tag.toc ? "" : " (no TOC)"}` : " NO TOC"}`;
  return r;
}

/** Stream one file through memory, build the exact index, and say where
    approximate seeking would land for `targets`. Nothing is written to disk. */
export async function scan(url, targets) {
  const t0 = performance.now();
  const { buf, res } = await get(url, null, { full: true });
  const secs = (performance.now() - t0) / 1000;
  const id3 = id3v2Size(buf);
  const f = findFrame(buf, id3);
  const tag = infoTag(buf, f.offset, f.header);
  const audioStart = f.offset + (tag ? f.header.size : 0);
  const index = scanFrames(buf, audioStart);
  const streamBytes = index.end - audioStart;
  const xingDur = tag?.frames ? (tag.frames * f.header.samples) / f.header.sampleRate : null;
  const cbrDur = (buf.length - audioStart) * 8 / (f.header.kbps * 1000);
  const durationEst = xingDur ?? cbrDur;
  const out = {
    bytes: buf.length, status: res.status, downloadSec: +secs.toFixed(1), id3, firstKbps: f.header.kbps,
    tag: tag ? { kind: tag.kind, frames: tag.frames, bytes: tag.bytes, hasToc: !!tag.toc, encoder: tag.encoder } : null,
    trueDuration: +index.duration.toFixed(3), xingDuration: xingDur && +xingDur.toFixed(3), cbrDuration: +cbrDur.toFixed(3),
    kbpsHistogram: Object.fromEntries([...index.kbps].sort((a, b) => a[0] - b[0])), resyncs: index.resyncs, landings: [],
  };
  for (const t of targets) {
    const viaToc = estimateByte({ audioStart, firstKbps: f.header.kbps, tag, durationEst, streamBytes }, t);
    const linear = estimateByte({ audioStart, firstKbps: f.header.kbps, tag: null, durationEst, streamBytes }, t);
    const prop = audioStart + Math.round((t / durationEst) * streamBytes);
    const exact = index.offsets[index.times.findIndex((x) => x >= t)] ?? index.end;
    out.landings.push({
      target: t, exactByte: exact,
      toc: tag?.toc ? +(timeAtByte(index, viaToc) - t).toFixed(3) : null,
      linearFirstBitrate: +(timeAtByte(index, linear) - t).toFixed(3),
      proportional: +(timeAtByte(index, prop) - t).toFixed(3),
      bytesToTargetPct: +((exact / buf.length) * 100).toFixed(1),
    });
  }
  return out;
}

/* ---------- CLI ---------- */

function forayUrls(id) {
  const read = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, "data", f), "utf8"));
  const foray = read("forays.json").forays.find((x) => x.id === id);
  if (!foray) throw new Error(`no Foray ${id}`);
  const segs = Object.fromEntries(read("segments.json").segments.map((s) => [s.id, s]));
  const srcs = Object.fromEntries(read("segment-sources.json").sources.map((s) => [s.id, s]));
  return foray.items.filter((i) => i.type === "segment").map((i) => {
    const s = segs[i.segment_id];
    return { id: s.id, startSec: s.start_sec, url: srcs[s.item_id]?.audio_url };
  }).filter((x) => x.url);
}

/** `--sources [--write]`: probe every source in data/segment-sources.json and
    (with --write) record each one's `seek_map`, which the native engine reads
    to skip precise timing where it buys nothing. A source the probe cannot
    classify keeps no field (and so keeps precise timing). */
async function sources(write) {
  const file = path.join(ROOT, "data", "segment-sources.json");
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const s of doc.sources) {
    let r = null;
    try { r = await probe(s.audio_url); } catch (e) { r = { verdict: String(e), seekMap: null }; }
    console.log(JSON.stringify({ id: s.id, seek_map: r.seekMap ?? null, verdict: r.verdict, finalHost: r.finalHost, ranged: r.ranged }));
    if (r.seekMap) s.seek_map = r.seekMap; else delete s.seek_map;
  }
  if (write) fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}
`);
}

async function main(argv) {
  const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  if (argv.includes("--sources")) return sources(argv.includes("--write"));
  const targets = argv.flatMap((a, i) => (argv[i - 1] === "--at" ? [Number(a)] : []));
  const list = arg("--foray") ? forayUrls(arg("--foray")) : argv.flatMap((a, i) => (argv[i - 1] === "--url" ? [{ id: a, url: a, startSec: targets[0] }] : []));
  for (const item of list) {
    if (argv.includes("--scan")) {
      const at = targets.length ? targets : [item.startSec].filter(Number.isFinite);
      console.log(JSON.stringify({ id: item.id, ...(await scan(item.url, at)) }));
    } else {
      const r = await probe(item.url);
      const tag = r.tag ? { kind: r.tag.kind, frames: r.tag.frames, bytes: r.tag.bytes, toc: !!r.tag.toc, encoder: r.tag.encoder } : null;
      console.log(JSON.stringify({ id: item.id, startSec: item.startSec, verdict: r.verdict, finalHost: r.finalHost, ranged: r.ranged, total: r.total, id3: r.id3, firstFrame: r.firstFrame && `${r.firstFrame.kbps}k ${r.firstFrame.sampleRate}Hz ${r.firstFrame.mono ? "mono" : "stereo"} @${r.firstFrame.offset}`, tag, inside: r.kbpsSamples.map((s) => s.kbps.join("/")).join(" "), hops: r.hops.map((h) => `${h.host}:${h.status}:${h.ms}ms`).join(" > ") }));
    }
  }
}

if (isEntryScript(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => { console.error(e); process.exit(1); });
}
