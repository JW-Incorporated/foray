/* NE-34's hash pin (docs/native-engine-plan.md, card NE-34): the jingle the
 * native engine plays from the iOS plugin's resources is the web's jingle,
 * byte for byte, and the exemption the audio guards grant the copy cannot
 * become a door.
 *
 * The Simulator half (InterludeSeamTests.testTheBundledJingleIsTheWebAssetByHash)
 * hashes the copy the resource bundle actually carries; this half runs on every
 * machine and holds the three places the pin is written (this module, the web
 * asset, InterludePlayer.swift) to one value, the manifest to one resource,
 * and the App Review note (for NE-37) to the facts it states.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { INTERLUDE_BUNDLED, INTERLUDE_SHA256, INTERLUDE_SOURCE, exemptInterludePaths, sha256Of } from "./interlude-asset.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PLUGIN_DIR = path.join(ROOT, "mobile", "plugins", "foray-audio");
const PLAYER_SWIFT = path.join(PLUGIN_DIR, "ios/Sources/ForayAudioPlugin/Engine/InterludePlayer.swift");
const NOTE = path.join(ROOT, "docs/store/app-review-background-audio.md");

test("the hash pin: the web jingle and the bundled copy both hash to INTERLUDE_SHA256, and InterludePlayer.swift carries the same literal", () => {
  /* MUTATION: re-export either WAV (any byte), or change assetSHA256 in the
     Swift. Each fails here; the Simulator test fails on the bundled bytes. */
  assert.equal(sha256Of(ROOT, INTERLUDE_SOURCE), INTERLUDE_SHA256, `${INTERLUDE_SOURCE} is not the pinned jingle`);
  assert.equal(sha256Of(ROOT, INTERLUDE_BUNDLED), INTERLUDE_SHA256, `${INTERLUDE_BUNDLED} is not a copy of ${INTERLUDE_SOURCE}`);
  const swift = fs.readFileSync(PLAYER_SWIFT, "utf8");
  assert.deepEqual([...swift.matchAll(/static let assetSHA256 = "([0-9a-f]{64})"/g)].map((m) => m[1]), [INTERLUDE_SHA256]);
  assert.match(swift, /static let assetName = "interlude-placeholder"/);
  assert.match(swift, /static let assetExtension = "wav"/);
  assert.equal(path.basename(INTERLUDE_BUNDLED), path.basename(INTERLUDE_SOURCE));
});

test("the plugin target ships exactly one resource, the jingle, and the test target keeps the click tracks", () => {
  /* MUTATION: `.process(` the WAV (SwiftPM may transcode a processed
     resource: the bytes would no longer be the pinned ones), add a second
     resource to the plugin target, or move the click tracks into it. */
  const manifest = fs.readFileSync(path.join(PLUGIN_DIR, "Package.swift"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const pluginTarget = /\.target\(\s*name:\s*"ForayAudioPlugin"[\s\S]*?path:\s*"ios\/Sources\/ForayAudioPlugin"[\s\S]*?\)\s*,\s*\.testTarget/.exec(manifest);
  assert.ok(pluginTarget, "the ForayAudioPlugin target is missing");
  const resources = [...pluginTarget[0].matchAll(/\.(copy|process)\("([^"]*)"\)/g)].map((m) => `${m[1]}:${m[2]}`);
  assert.deepEqual(resources, ["copy:Resources/interlude-placeholder.wav"]);
  const resourcesDir = path.join(PLUGIN_DIR, "ios/Sources/ForayAudioPlugin/Resources");
  assert.deepEqual(fs.readdirSync(resourcesDir), ["interlude-placeholder.wav"], "one file in the plugin's Resources");
  assert.equal(`mobile/plugins/foray-audio/ios/Sources/ForayAudioPlugin/Resources/interlude-placeholder.wav`, INTERLUDE_BUNDLED);
});

test("the exemption covers the one path, only while both files hash to the pin", () => {
  /* MUTATION: exempt by path alone, or check only the bundled copy's hash.
     A different WAV at that path, or a web jingle changed without its copy,
     must stay an offender for the two audio guards. */
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "interlude-exempt-"));
  try {
    const put = (rel, buf) => {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), buf);
    };
    const real = fs.readFileSync(path.join(ROOT, INTERLUDE_SOURCE));
    put(INTERLUDE_BUNDLED, Buffer.from("an episode somebody dropped here"));
    put(INTERLUDE_SOURCE, real);
    assert.deepEqual([...exemptInterludePaths(root)], [], "a different file at the bundled path");
    put(INTERLUDE_BUNDLED, real);
    assert.deepEqual([...exemptInterludePaths(root)], [INTERLUDE_BUNDLED]);
    const changed = Buffer.concat([real, Buffer.from([0])]);
    put(INTERLUDE_SOURCE, changed);
    put(INTERLUDE_BUNDLED, changed);
    assert.notEqual(crypto.createHash("sha256").update(changed).digest("hex"), INTERLUDE_SHA256);
    assert.deepEqual([...exemptInterludePaths(root)], [], "both re-exported: the pin must move with them");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  assert.deepEqual([...exemptInterludePaths(ROOT)], [INTERLUDE_BUNDLED], "on the real repo it exempts the copy");
});

test("the App Review note (for NE-37) states what the code does: a 3 s jingle stopped by 4.5 s, the silence node off and capped", () => {
  /* MUTATION: change INTERLUDE_CEILING_SEC or INTERLUDE_DURATION_SEC, default
     silenceNodeEnabled on, or loop the jingle, without changing the note. */
  const note = fs.readFileSync(NOTE, "utf8");
  const constants = fs.readFileSync(path.join(PLUGIN_DIR, "foray-engine-core/Sources/ForayEngineCore/EngineConstants.swift"), "utf8");
  const ceiling = /interludeCeilingSec: Double = ([\d.]+)/.exec(constants)?.[1];
  const duration = /interludeDurationSec: Double = ([\d.]+)/.exec(constants)?.[1];
  assert.equal(ceiling, "4.5");
  assert.equal(duration, "3");
  assert.match(note, /UIBackgroundModes: audio/);
  assert.match(note, /3-second interlude jingle/);
  assert.match(note, /never looped and is always stopped within 4\.5 seconds/);
  assert.match(note, /\(off in this build\)[^.]*at most 4\.5 seconds/);
  assert.match(note, /does not record audio/);

  const core = fs.readFileSync(path.join(PLUGIN_DIR, "foray-engine-core/Sources/ForayEngineCore/Engine/EngineCore.swift"), "utf8");
  assert.match(core, /silenceNodeEnabled: Bool = false/, "the note says the silence renderer is off");
  const swift = fs.readFileSync(PLAYER_SWIFT, "utf8");
  assert.match(swift, /numberOfLoops = 0/, "the note says the jingle is never looped");
  assert.match(swift, /ceilingMs: Double = Interlude\.ceilingSec \* 1000/, "the note says the jingle is stopped at the ceiling");
});
