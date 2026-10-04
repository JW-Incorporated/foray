/* tools/audio/mp3-probe.mjs, offline. The parser is checked against the NE-25a
 * click tracks, whose nature (CBR, VBR + Xing TOC, VBR with no TOC) is already
 * pinned byte for byte by click-tracks.test.mjs, and against synthetic headers
 * for the cases those files do not carry (ID3, Info, VBRI, a stitch). No
 * network: the CLI half of the tool is manual and never runs in CI. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { estimateByte, findFrame, frameHeader, id3v2Size, infoTag, scanFrames, timeAtByte } from "./mp3-probe.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIR = path.join(ROOT, "mobile", "plugins", "foray-audio", "ios", "Tests", "ForayAudioPluginTests", "Fixtures", "ClickTracks");
const read = (f) => fs.readFileSync(path.join(DIR, f));

function open(buf) {
  const id3 = id3v2Size(buf);
  const f = findFrame(buf, id3);
  const tag = infoTag(buf, f.offset, f.header);
  const audioStart = f.offset + (tag ? f.header.size : 0);
  const index = scanFrames(buf, audioStart);
  return { id3, f, tag, audioStart, index };
}

test("the CBR click track reads as one bitrate, no header frame, 90 s of frames", () => {
  const { f, tag, index } = open(read("click-cbr.mp3"));
  assert.equal(f.offset, 0);
  assert.deepEqual({ v: f.header.version, l: f.header.layer, kbps: f.header.kbps, sr: f.header.sampleRate, mono: f.header.mono },
    { v: 2, l: 3, kbps: 16, sr: 16000, mono: true });
  assert.equal(tag, null);
  assert.deepEqual([...index.kbps.keys()], [16]);
  assert.equal(index.resyncs, 0);
  assert.ok(index.duration >= 90 && index.duration < 90.2, `${index.duration}`);
});

test("the Xing click track: tag, frame count, byte count and a 100-entry TOC; the no-TOC twin has none", () => {
  const xing = open(read("click-vbr-xing.mp3"));
  assert.equal(xing.tag.kind, "Xing");
  assert.equal(xing.tag.flags & 7, 7);
  assert.equal(xing.tag.frames, xing.index.offsets.length, "the header frame is not an audio frame");
  assert.equal(xing.tag.bytes, read("click-vbr-xing.mp3").length);
  assert.equal(xing.tag.toc.length, 100);
  assert.ok(xing.index.kbps.size >= 3, "VBR");
  const notoc = open(read("click-vbr-notoc.mp3"));
  assert.equal(notoc.tag, null);
  assert.equal(notoc.index.offsets.length, xing.index.offsets.length);
});

test("on CBR, the byte arithmetic an approximate seek uses lands within one frame of the target", () => {
  /* The claim the precise-timing recommendation rests on: for CBR, approximate
     IS exact to the frame. MUTATION: use a bitrate other than the file's. */
  const { f, tag, audioStart, index } = open(read("click-cbr.mp3"));
  const frameSec = f.header.samples / f.header.sampleRate;
  for (const t of [9.65, 19.65, 49.65, 79.65]) {
    const b = estimateByte({ audioStart, firstKbps: f.header.kbps, tag, durationEst: index.duration, streamBytes: index.end - audioStart }, t);
    const err = timeAtByte(index, b) - t;
    assert.ok(err <= 0 && err > -frameSec - 1e-9, `${t}: ${err}`);
  }
});

test("on VBR with no TOC, the first frame's bitrate is no estimate at all (seconds off), and a TOC brings it under a second", () => {
  /* What Media3 measured on these files (docs/android-emulator-measurements.md
     §8: 20 s early at 49.65 s with no table, 0.2-0.6 s with Xing), reproduced
     from the bytes. MUTATION: make estimateByte ignore the TOC. */
  const n = open(read("click-vbr-notoc.mp3"));
  const nb = estimateByte({ audioStart: n.audioStart, firstKbps: n.f.header.kbps, tag: null, durationEst: 0, streamBytes: 0 }, 49.65);
  assert.ok(timeAtByte(n.index, nb) - 49.65 < -10);
  const x = open(read("click-vbr-xing.mp3"));
  const dur = (x.tag.frames * x.f.header.samples) / x.f.header.sampleRate;
  for (const t of [19.65, 49.65, 79.65]) {
    const xb = estimateByte({ audioStart: x.audioStart, firstKbps: x.f.header.kbps, tag: x.tag, durationEst: dur, streamBytes: x.tag.bytes }, t);
    assert.ok(Math.abs(timeAtByte(x.index, xb) - t) < 1, `${t}`);
  }
});

function frame(kbps = 128, { tag = null } = {}) {
  // MPEG-1 Layer III, 44.1 kHz, stereo, no padding: 417 bytes.
  const idx = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320].indexOf(kbps);
  const size = Math.floor((144 * kbps * 1000) / 44100);
  const b = Buffer.alloc(size);
  b[0] = 0xff; b[1] = 0xfb; b[2] = (idx << 4) | (0 << 2); b[3] = 0x00;
  if (tag) tag.copy(b, 4 + 32);
  return b;
}

test("an ID3v2 tag is skipped by its syncsafe size, footer included", () => {
  const id3 = Buffer.alloc(10 + 300);
  id3.write("ID3", 0, "latin1"); id3[3] = 4; id3[5] = 0x10;
  id3[8] = 2; id3[9] = 300 - 256 - 10; // syncsafe 2*128 + 34 = 290 body bytes; +10 header +10 footer = 310
  assert.equal(id3v2Size(id3), 310);
  const buf = Buffer.concat([id3, frame(), frame(), frame()]);
  assert.equal(findFrame(buf, id3v2Size(buf)).offset, 310);
  assert.equal(id3v2Size(Buffer.from("not a tag at all")), 0);
});

test("an Info frame (CBR) and a VBRI frame are recognised; a lone 0xFFE is not a frame", () => {
  const info = Buffer.alloc(120);
  info.write("Info", 0, "latin1"); info.writeUInt32BE(3, 4); info.writeUInt32BE(1000, 8); info.writeUInt32BE(417000, 12);
  const f = frame(128, { tag: info });
  const t = infoTag(f, 0, frameHeader(f, 0));
  assert.deepEqual({ kind: t.kind, frames: t.frames, bytes: t.bytes, toc: t.toc }, { kind: "Info", frames: 1000, bytes: 417000, toc: null });

  const vbri = Buffer.alloc(32);
  vbri.write("VBRI", 0, "latin1"); vbri.writeUInt32BE(5000, 10); vbri.writeUInt32BE(77, 14); vbri.writeUInt16BE(10, 18);
  const g = frame(128, { tag: vbri });
  const v = infoTag(g, 0, frameHeader(g, 0));
  assert.deepEqual({ kind: v.kind, bytes: v.bytes, frames: v.frames, entries: v.tocEntries }, { kind: "VBRI", bytes: 5000, frames: 77, entries: 10 });

  const junk = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00, 1, 2, 3]), Buffer.alloc(600)]);
  assert.equal(findFrame(junk, 0), null);
});

test("a stitch (a different bitrate spliced in) shows up in the histogram, and timeAtByte reads the real timeline", () => {
  const buf = Buffer.concat([frame(128), frame(128), frame(64), frame(64), frame(128)]);
  const index = scanFrames(buf, 0);
  assert.deepEqual(Object.fromEntries(index.kbps), { 128: 3, 64: 2 });
  const fs = 1152 / 44100;
  assert.equal(index.offsets.length, 5);
  assert.ok(Math.abs(timeAtByte(index, index.offsets[3] + 5) - 3 * fs) < 1e-9);
  assert.equal(timeAtByte(index, 0), 0);
});
