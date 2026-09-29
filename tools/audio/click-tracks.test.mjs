/* NE-25a's click tracks (docs/native-engine-plan.md, card NE-25a), read without
 * a decoder.
 *
 * The Simulator measurement (mobile/plugins/foray-audio/ios/Tests/
 * ForayAudioPluginTests/ClickTrack/) reports where AVFoundation lands an
 * in-point by reading the click track's content. Every number it publishes is
 * only as good as the claim that the files are what the descriptor says: a WAV
 * whose clicks are not on the whole seconds, a "CBR" file with one odd frame, a
 * "no TOC" file that quietly carries an Info frame, or a Xing TOC that points at
 * the wrong bytes would each produce a precise-looking, wrong table. None of
 * that needs Swift to check, so it is checked here, on every machine.
 *
 * The generator is tools/audio/make-click-tracks.py (it needs `lameenc`, so CI
 * does not run it; `--check` there proves the bytes are reproducible, this
 * proves they are right).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PLUGIN_DIR = path.join(ROOT, "mobile", "plugins", "foray-audio");
const TESTS_DIR = path.join(PLUGIN_DIR, "ios", "Tests", "ForayAudioPluginTests");
const DIR = path.join(TESTS_DIR, "Fixtures", "ClickTracks");
const descriptor = JSON.parse(fs.readFileSync(path.join(DIR, "click-tracks.json"), "utf8"));
const read = (file) => fs.readFileSync(path.join(DIR, file));
const fixture = (kind) => descriptor.fixtures.find((f) => f.kind === kind);

/** The authored onsets, in seconds: 1..duration-1 plus each double's second click. */
function onsets(durationSec) {
  const out = [];
  for (let s = descriptor.firstClickSec; s < durationSec; s++) {
    out.push(s);
    if (s % descriptor.doubleEverySec === 0) out.push(s + descriptor.doubleGapSec);
  }
  return out;
}

const MPEG2_L3_KBPS = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const MPEG2_RATES = [22050, 24000, 16000, 0];

/** Every frame of an MPEG-2 Layer III stream, or a throw naming the byte. */
function frames(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    assert.ok(i + 4 <= buf.length && buf[i] === 0xff && (buf[i + 1] & 0xfe) === 0xf2, `no MPEG-2 L3 frame header at byte ${i}`);
    const kbps = MPEG2_L3_KBPS[buf[i + 2] >> 4];
    const rate = MPEG2_RATES[(buf[i + 2] >> 2) & 3];
    const size = Math.floor((72 * kbps * 1000) / rate) + ((buf[i + 2] >> 1) & 1);
    out.push({ offset: i, size, kbps, rate, mono: buf[i + 3] >> 6 === 3 });
    i += size;
  }
  assert.equal(i, buf.length, "the last frame runs past the end of the file");
  return out;
}

/** The tag a first frame carries, if any: Xing/Info sit after 9 bytes of MPEG-2 mono side info, VBRI at 36. */
function tagOf(buf) {
  const at = (o, s) => buf.subarray(o, o + s.length).toString("latin1") === s;
  if (at(4 + 9, "Xing")) return "Xing";
  if (at(4 + 9, "Info")) return "Info";
  if (at(36, "VBRI")) return "VBRI";
  return null;
}

test("every fixture is the file the descriptor names, byte for byte, and the set is under the card's 1 MB", () => {
  /* The descriptor is what the Swift tests read durations and the ruler from;
     a fixture regenerated without its descriptor (or edited by hand) is caught
     here. MUTATION: change one byte of any fixture. */
  assert.deepEqual(descriptor.fixtures.map((f) => f.kind).sort(), ["mp3-cbr", "mp3-vbr-notoc", "mp3-vbr-xing", "wav-pcm-u8"]);
  let total = 0;
  for (const f of descriptor.fixtures) {
    const buf = read(f.file);
    assert.equal(buf.length, f.bytes, `${f.file}: size`);
    assert.equal(crypto.createHash("sha256").update(buf).digest("hex"), f.sha256, `${f.file}: sha256`);
    total += buf.length;
  }
  assert.ok(total < descriptor.maxBytesTotal && descriptor.maxBytesTotal <= 1_000_000, `click tracks total ${total} bytes; the card caps them at 1 MB`);
  const onDisk = fs.readdirSync(DIR).sort();
  assert.deepEqual(onDisk, [...descriptor.fixtures.map((f) => f.file), "click-tracks.json"].sort(), "a file in ClickTracks/ the descriptor does not name");
});

test("the WAV is sample-exact: mono u8 PCM, a 1 ms click on every whole second, a double every ten, silence elsewhere", () => {
  /* The control every MP3 number is read against, so it is checked sample by
     sample. MUTATION: move one click by a sample in the generator, drop a
     double, or leave a stray non-silent sample; each fails. */
  const f = fixture("wav-pcm-u8");
  const buf = read(f.file);
  assert.equal(buf.toString("latin1", 0, 4), "RIFF");
  assert.equal(buf.toString("latin1", 8, 12), "WAVE");
  assert.equal(buf.toString("latin1", 12, 16), "fmt ");
  assert.equal(buf.readUInt16LE(20), 1, "PCM");
  assert.equal(buf.readUInt16LE(22), 1, "mono");
  assert.equal(buf.readUInt32LE(24), f.sampleRate);
  assert.equal(buf.readUInt16LE(34), 8, "8-bit");
  assert.equal(buf.toString("latin1", 36, 40), "data");
  const data = buf.subarray(44, 44 + buf.readUInt32LE(40));
  assert.equal(data.length, f.durationSec * f.sampleRate, "duration");

  const clickLen = Math.round(descriptor.clickLengthSec * f.sampleRate);
  const expected = new Set();
  for (const t of onsets(f.durationSec)) {
    const start = Math.round(t * f.sampleRate);
    for (let k = 0; k < clickLen; k++) expected.add(start + k);
  }
  const loud = [];
  for (let i = 0; i < data.length; i++) {
    if (data[i] !== 128) {
      loud.push(i);
      assert.ok(expected.has(i), `a non-silent sample at ${(i / f.sampleRate).toFixed(4)} s, outside every click`);
    }
  }
  /* Each click is one sine cycle; its zero crossings are silent, the rest is not. */
  const firstOfEach = onsets(f.durationSec).map((t) => Math.round(t * f.sampleRate) + 1);
  for (const i of firstOfEach) assert.ok(data[i] > 128 + 60, `click onset missing at sample ${i}`);
  assert.equal(onsets(f.durationSec).length, 59 + 5, "59 whole seconds, 5 of them doubles");
});

test("the CBR MP3 is constant-rate MPEG-2 L3 mono with no header frame, 90 s long", () => {
  /* "CBR" must mean every frame, or an approximate seek on it is not the easy
     case the doc calls it. MUTATION: encode with VBR, or prepend an Info frame. */
  const f = fixture("mp3-cbr");
  const buf = read(f.file);
  const all = frames(buf);
  assert.equal(tagOf(buf), null, "the CBR file carries a tag frame");
  assert.deepEqual([...new Set(all.map((x) => x.kbps))], [f.bitrateKbps]);
  assert.ok(all.every((x) => x.rate === f.sampleRate && x.mono));
  const seconds = (all.length * 576) / f.sampleRate;
  assert.ok(seconds >= f.durationSec && seconds < f.durationSec + 0.2, `${seconds} s of frames`);
});

test("the no-TOC VBR MP3 really varies its bitrate and carries no Xing, Info or VBRI frame", () => {
  /* The hard case: an approximate seek into it has only an average bitrate to
     go on. If LAME ever wrote a tag here, the "no TOC" column would silently
     measure the TOC case. MUTATION: write the Xing frame into this file too. */
  const f = fixture("mp3-vbr-notoc");
  const buf = read(f.file);
  const all = frames(buf);
  assert.equal(tagOf(buf), null);
  assert.ok(new Set(all.map((x) => x.kbps)).size >= 3, "a VBR file with fewer than three bitrates is not exercising VBR");
  const seconds = (all.length * 576) / f.sampleRate;
  assert.ok(seconds >= f.durationSec && seconds < f.durationSec + 0.2);
});

test("the Xing VBR MP3 is the no-TOC file's frames behind a correct Xing header: frame count, byte count, and a TOC that points at frames", () => {
  /* The two VBR files must differ ONLY by the header, or a difference between
     their rows could be the encoder's rather than the TOC's. And a TOC that
     points between frames would make AVFoundation's approximate seek look
     worse than a real podcast file's. MUTATION: count the header frame in
     `frames`, leave it out of `bytes`, or scale the TOC by 255. */
  const xing = read(fixture("mp3-vbr-xing").file);
  const notoc = read(fixture("mp3-vbr-notoc").file);
  assert.equal(tagOf(xing), "Xing");
  const header = frames(xing)[0];
  assert.deepEqual(xing.subarray(header.size), notoc, "the audio after the Xing frame is not the no-TOC file byte for byte");

  const tag = 4 + 9;
  assert.equal(xing.readUInt32BE(tag + 4), 0x7, "flags: frames, bytes, TOC");
  const audio = frames(notoc);
  assert.equal(xing.readUInt32BE(tag + 8), audio.length, "frame count (the header frame is not counted)");
  assert.equal(xing.readUInt32BE(tag + 12), xing.length, "byte count (the whole file)");
  const toc = [...xing.subarray(tag + 16, tag + 116)];
  assert.equal(toc.length, 100);
  for (let pct = 0; pct < 100; pct++) {
    const frame = audio[Math.min(audio.length - 1, Math.floor((pct / 100) * audio.length))];
    assert.equal(toc[pct], Math.min(255, Math.floor(((header.size + frame.offset) * 256) / xing.length)), `TOC[${pct}]`);
    if (pct > 0) assert.ok(toc[pct] >= toc[pct - 1], "the TOC must not go backwards");
  }
});

test("the click tracks ship in the plugin's TEST target only, and the Swift side reads the ruler from the descriptor", () => {
  /* 964 KB of test audio must never reach the app: resources belong to
     ForayAudioPluginTests, never to ForayAudioPlugin. And the Swift tests must
     take the ruler (double period, gap, first click) from click-tracks.json,
     not from a second copy of the numbers.
     The plugin target carries exactly ONE resource since NE-34, the seam
     jingle (tools/audio/interlude-asset.test.mjs pins it), and never these.
     MUTATION: add `.copy("Fixtures/ClickTracks")` (or any second resource) to
     the ForayAudioPlugin target; hard-code `doubleEverySec: 10` in the
     measurement test. */
  const manifest = fs.readFileSync(path.join(PLUGIN_DIR, "Package.swift"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const pluginTarget = /\.target\(\s*name:\s*"ForayAudioPlugin"[\s\S]*?path:\s*"ios\/Sources\/ForayAudioPlugin"[\s\S]*?\)\s*,\s*\.testTarget/.exec(manifest);
  assert.ok(pluginTarget, "the ForayAudioPlugin target is missing");
  assert.doesNotMatch(pluginTarget[0], /ClickTracks/, "the click tracks must never reach the plugin target (which ships in the app)");
  assert.deepEqual([...pluginTarget[0].matchAll(/\.(?:copy|process)\("([^"]*)"\)/g)].map((m) => m[1]), ["Resources/interlude-placeholder.wav"],
    "the plugin target's one resource is the jingle");
  const testTarget = /\.testTarget\(\s*name:\s*"ForayAudioPluginTests"[\s\S]*?\)\s*\]\s*\)/.exec(manifest);
  assert.ok(testTarget, "the ForayAudioPluginTests target is missing");
  assert.match(testTarget[0], /resources:\s*\[\s*\.copy\("Fixtures\/ClickTracks"\)\s*\]/);

  const swiftDir = path.join(TESTS_DIR, "ClickTrack");
  const fixtureSwift = fs.readFileSync(path.join(swiftDir, "ClickTrackFixture.swift"), "utf8");
  assert.match(fixtureSwift, /"click-tracks\.json"/);
  const measurement = fs.readFileSync(path.join(swiftDir, "InOutPointMeasurementTests.swift"), "utf8");
  assert.match(measurement, /doubleEverySec:\s*descriptor\.doubleEverySec/);
  assert.match(measurement, /doubleGapSec:\s*descriptor\.doubleGapSec/);
  assert.doesNotMatch(measurement, /doubleEverySec:\s*10\b/);
});

test("the never-early rule is not loosened: 1 ms of CMTime slack plus NE-32's stopPad, and it is asserted", () => {
  /* The one out-point rule the plan will not trade (P-2). The measurement is
     allowed to report any overshoot; it is NOT allowed to absorb an early stop
     into a tolerance. If CI measures an early stop, the card's answer is to
     record it and set NE-32's stopPad from it, which is a visible edit to
     `stopPadSec` here and in the doc, not a quiet widening of the slack.
     MUTATION: raise the 0.001, set stopPadSec without editing this test, or
     delete the XCTAssertEqual(early, []). */
  const measurement = fs.readFileSync(path.join(TESTS_DIR, "ClickTrack", "InOutPointMeasurementTests.swift"), "utf8");
  assert.match(measurement, /static let stopPadSec = 0\.0\n/);
  assert.match(measurement, /static let neverEarlyToleranceSec = 0\.001 \+ stopPadSec\n/);
  assert.match(measurement, /XCTAssertEqual\(early, \[\]/);
  assert.match(measurement, /fire\.mediaSec < end - Self\.neverEarlyToleranceSec/);
  assert.match(measurement, /trial\.settledSec < end - Self\.neverEarlyToleranceSec/);
});
