/* Writes the two click-track fixtures AVDeck's Simulator XCTests play
 * (card NE-15, docs/native-engine-plan.md §14):
 *
 *   click-cbr-64k.mp3  22,050 Hz mono, CBR 64 kbit/s, no Xing/LAME tag
 *   click-11k.wav      11,025 Hz mono, 16-bit PCM
 *
 * Both are 20 s long: a 1 ms full-scale click at every whole second, and a
 * second click 50 ms later at every tenth second (0, 10), so a landing error
 * can later be read off the audio itself (NE-25a's MTAudioProcessingTap) as
 * well as off `currentTime` (what NE-15 measures). Together they stay under
 * the card's 1 MB budget, which `shell-invariants.test.mjs` pins.
 *
 * WHY THE FILES ARE COMMITTED AND THIS SCRIPT IS NOT RUN BY ANYTHING. No MP3
 * encoder exists on the machines this repo is written on or in its lockfiles,
 * and an XCTest cannot encode MP3 (AVFoundation on iOS has no MP3 encoder).
 * So the bytes are generated once and committed; this file is the recipe, so
 * a later card that needs a different length or rate regenerates rather than
 * hand-edits. Run it with lamejs@1.2.0 installed somewhere OUTSIDE the repo
 * (never add it to a package.json here; the root stays dependency-free):
 *
 *   npm install --prefix <scratch> lamejs@1.2.0   (1.2.1's CommonJS entry throws "MPEGMode is not defined")
 *   NODE_PATH=<scratch>/node_modules node tools/mobile/click-tracks/make-click-tracks.mjs <outDir>
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const outDir = process.argv[2];
if (!outDir) {
  console.error("usage: make-click-tracks.mjs <outDir>");
  process.exit(2);
}

const SECONDS = 20;
const CLICK_MS = 1;
const DOUBLE_GAP_MS = 50;

/** 16-bit mono samples: silence with a click each second (double on the tens). */
function clickTrack(sampleRate) {
  const samples = new Int16Array(SECONDS * sampleRate);
  const clickLen = Math.max(1, Math.round((CLICK_MS / 1000) * sampleRate));
  const put = (atSec) => {
    const start = Math.round(atSec * sampleRate);
    for (let i = 0; i < clickLen && start + i < samples.length; i++) samples[start + i] = 32767;
  };
  for (let s = 0; s < SECONDS; s++) {
    put(s);
    if (s % 10 === 0) put(s + DOUBLE_GAP_MS / 1000);
  }
  return samples;
}

function wav(samples, sampleRate) {
  const data = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function mp3(samples, sampleRate, kbps) {
  const lamejs = require("lamejs");
  const encoder = new lamejs.Mp3Encoder(1, sampleRate, kbps);
  const chunks = [];
  const block = 1152;
  for (let i = 0; i < samples.length; i += block) {
    const out = encoder.encodeBuffer(samples.subarray(i, i + block));
    if (out.length) chunks.push(Buffer.from(out));
  }
  const tail = encoder.flush();
  if (tail.length) chunks.push(Buffer.from(tail));
  return Buffer.concat(chunks);
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "click-cbr-64k.mp3"), mp3(clickTrack(22050), 22050, 64));
fs.writeFileSync(path.join(outDir, "click-11k.wav"), wav(clickTrack(11025), 11025));
for (const name of ["click-cbr-64k.mp3", "click-11k.wav"]) {
  console.log(name, fs.statSync(path.join(outDir, name)).size, "bytes");
}
