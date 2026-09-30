/* NE-34's hash pin (docs/native-engine-plan.md, card NE-34): the jingle the
 * native engine plays is the web's jingle, byte for byte.
 *
 * Since 2026-09-29 there is ONE copy in the repo (player/assets/), injected
 * into App.app/public/player/assets/ by tools/mobile/inject-interlude.mjs. It
 * used to be a SwiftPM resource of the ForayAudioPlugin target, and that broke
 * the signed archive (a resource bundle cannot take a provisioning profile,
 * release run 36535801479). The Simulator half
 * (InterludeSeamTests.testTheAppsJingleIsTheWebAssetByHash) hashes the file
 * through InterludePlayer's own lookup; this half runs on every machine and
 * holds the places the pin is written (this module, the web asset,
 * InterludePlayer.swift) to one value, the lookup to the injector's
 * destination, and the App Review note (for NE-37) to the facts it states.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { INTERLUDE_APP_PATH, INTERLUDE_SHA256, INTERLUDE_SOURCE, sha256Hex, sha256Of } from "./interlude-asset.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PLUGIN_DIR = path.join(ROOT, "mobile", "plugins", "foray-audio");
const PLAYER_SWIFT = path.join(PLUGIN_DIR, "ios/Sources/ForayAudioPlugin/Engine/InterludePlayer.swift");
const NOTE = path.join(ROOT, "docs/store/app-review-background-audio.md");

test("the hash pin: the web jingle hashes to INTERLUDE_SHA256, InterludePlayer.swift carries the same literal, and make() checks it", () => {
  /* MUTATION: re-export the WAV (any byte), change assetSHA256 in the Swift,
     or drop the isPinned guard from make(). Each fails here. */
  assert.equal(sha256Of(ROOT, INTERLUDE_SOURCE), INTERLUDE_SHA256, `${INTERLUDE_SOURCE} is not the pinned jingle`);
  assert.equal(sha256Hex(Buffer.from("")), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  const swift = fs.readFileSync(PLAYER_SWIFT, "utf8");
  assert.deepEqual([...swift.matchAll(/static let assetSHA256 = "([0-9a-f]{64})"/g)].map((m) => m[1]), [INTERLUDE_SHA256]);
  assert.match(swift, /static let assetName = "interlude-placeholder"/);
  assert.match(swift, /static let assetExtension = "wav"/);
  assert.match(swift, /guard isPinned\(url\) else \{/);
  assert.equal(path.basename(INTERLUDE_APP_PATH), path.basename(INTERLUDE_SOURCE));
});

test("the app looks for the jingle where the injector puts it, and the plugin target ships no resources", () => {
  /* MUTATION: change assetSubdirectory or INTERLUDE_APP_PATH without the
     other; put the jingle back as a SwiftPM resource (the archive failure);
     leave a Resources/ directory under the plugin. */
  const swift = fs.readFileSync(PLAYER_SWIFT, "utf8");
  const sub = /static let assetSubdirectory = "([^"]+)"/.exec(swift)?.[1];
  assert.equal(`${sub}/${path.basename(INTERLUDE_APP_PATH)}`, `public/${INTERLUDE_APP_PATH}`,
    "InterludePlayer looks under public/ where tools/mobile/inject-interlude.mjs writes");
  assert.equal(INTERLUDE_APP_PATH, INTERLUDE_SOURCE, "the app carries it at the web's own path");
  const manifest = fs.readFileSync(path.join(PLUGIN_DIR, "Package.swift"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const pluginTarget = /\.target\(\s*name:\s*"ForayAudioPlugin"[\s\S]*?path:\s*"ios\/Sources\/ForayAudioPlugin"[\s\S]*?\)\s*,\s*\.testTarget/.exec(manifest);
  assert.ok(pluginTarget, "the ForayAudioPlugin target is missing");
  assert.doesNotMatch(pluginTarget[0], /resources\s*:/, "the plugin target declares resources again");
  assert.doesNotMatch(swift.replace(/\/\/.*$/gm, ""), /Bundle\.module/);
  assert.equal(fs.existsSync(path.join(PLUGIN_DIR, "ios/Sources/ForayAudioPlugin/Resources")), false);
});

test("one copy of the jingle's bytes in the repo: no other file hashes to the pin", () => {
  /* MUTATION: commit a copy anywhere (the old SwiftPM resource path, a test
     fixture): the audio guards no longer exempt one, and the pin has one file
     to hold. */
  const hits = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".") || e.name === "www" || e.name === "ios" && rel === "mobile") continue;
      const next = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(next);
      else if (/\.wav$/i.test(e.name) && sha256Of(ROOT, next) === INTERLUDE_SHA256) hits.push(next);
    }
  };
  walk("");
  assert.deepEqual(hits, [INTERLUDE_SOURCE]);
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

/* A-41 (docs/plans/android-assessment.md §5.5): the Android engine plays the same
 * jingle. foray-audio's build.gradle ships player/assets/ (and the lexicon's
 * directory) as the module's assets, read in place, so there is still one copy;
 * InterludePlayer.java carries the same pin and MediaJingle.make hashes the
 * asset before any player exists. The Robolectric half (EngineAssetsTest) finds
 * and hashes the merged asset; android-build.yml hashes it inside the APK. */
const PLAYER_JAVA = path.join(PLUGIN_DIR, "android/src/main/java/ai/jwlabs/foura/audio/engine/InterludePlayer.java");
const JINGLE_JAVA = path.join(PLUGIN_DIR, "android/src/main/java/ai/jwlabs/foura/audio/engine/MediaJingle.java");
const GRADLE = path.join(PLUGIN_DIR, "android/build.gradle");

test("A-41: InterludePlayer.java carries the same pin, make() checks it, and build.gradle ships the one copy", () => {
  /* MUTATION: change ASSET_SHA256 in the Java; drop the hash check from make();
     copy the WAV into the module instead of reading player/assets/ in place;
     put a second file in player/assets/ (it would ship at the assets' root). */
  const java = fs.readFileSync(PLAYER_JAVA, "utf8");
  assert.deepEqual([...java.matchAll(/ASSET_SHA256 = "([0-9a-f]{64})"/g)].map((m) => m[1]), [INTERLUDE_SHA256]);
  assert.match(java, /ASSET_NAME = "interlude-placeholder\.wav"/);
  assert.equal(path.basename(INTERLUDE_SOURCE), "interlude-placeholder.wav");
  const make = fs.readFileSync(JINGLE_JAVA, "utf8");
  assert.match(make, /if \(!InterludePlayer\.ASSET_SHA256\.equals\(hash\)\) \{\s*unavailable\(diag, "hash-mismatch"\);\s*return null;/);
  const gradle = fs.readFileSync(GRADLE, "utf8");
  assert.match(gradle, /new File\(forayRepoRoot, 'player\/assets'\)/);
  assert.match(gradle, /new File\(forayRepoRoot, 'mobile\/plugins\/foray-tts\/lexicon'\)/);
  assert.match(gradle, /assets\.srcDirs \+= forayEngineAssets/);
  assert.deepEqual(fs.readdirSync(path.join(ROOT, path.dirname(INTERLUDE_SOURCE))), ["interlude-placeholder.wav"],
    "player/assets/ ships whole at the app's assets root: one file");
  assert.deepEqual(fs.readdirSync(path.join(ROOT, "mobile/plugins/foray-tts/lexicon")), ["hard-terms.json"],
    "the lexicon's directory ships whole at the app's assets root: one file");
  const found = fs.readdirSync(path.join(PLUGIN_DIR, "android"), { recursive: true }).filter((f) => String(f).endsWith(".wav"));
  assert.deepEqual(found, [], "no second copy of the jingle in the Android module");
});
