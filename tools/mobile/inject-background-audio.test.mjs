/* Tests for the one Info.plist edit iOS background audio needs (#38, MP4).
 *
 * EVERY TEST HERE RUNS ON WINDOWS. That is the point: #38's whole value is that
 * a macOS runner does the parts a Mac must do, and the parts that DON'T need a
 * Mac are pure functions over fixture XML that anyone can run. Nothing in this
 * file asserts anything about a build, a simulator or a device — see
 * `.github/workflows/ios-build.yml` for the checks that only a runner can make,
 * and read them as unverified until a run is linked.
 *
 * The fixture is the real shape Capacitor 8 generates (`mobile/ios/App/App/
 * Info.plist`): an XML plist whose root dict is tab-indented, carrying
 * CFBundle* keys, a UILaunchStoryboardName and an NSAppTransportSecurity dict.
 * The nested dict is not decoration — the decoy test below depends on it.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  BACKGROUND_AUDIO_MODE,
  PlistError,
  assertModePresent,
  backgroundModes,
  injectBackgroundAudio,
  rootEntries,
} from "./inject-background-audio.mjs";

/** What `npx cap add ios` writes, trimmed to the keys that matter here. */
const CAPACITOR_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>CFBundleDevelopmentRegion</key>
\t<string>en</string>
\t<key>CFBundleDisplayName</key>
\t<string>Foray</string>
\t<key>CFBundleExecutable</key>
\t<string>$(EXECUTABLE_NAME)</string>
\t<key>CFBundleIdentifier</key>
\t<string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
\t<key>CFBundlePackageType</key>
\t<string>APPL</string>
\t<key>CFBundleShortVersionString</key>
\t<string>1.0</string>
\t<key>CFBundleVersion</key>
\t<string>1</string>
\t<key>LSRequiresIPhoneOS</key>
\t<true/>
\t<key>UILaunchStoryboardName</key>
\t<string>LaunchScreen</string>
\t<key>UIRequiresFullScreen</key>
\t<false/>
\t<key>UISupportedInterfaceOrientations</key>
\t<array>
\t\t<string>UIInterfaceOrientationPortrait</string>
\t\t<string>UIInterfaceOrientationLandscapeLeft</string>
\t</array>
\t<key>UIViewControllerBasedStatusBarAppearance</key>
\t<true/>
</dict>
</plist>
`;

/* ─────────────────────────── reading what is there ───────────────────────── */

test("a freshly generated plist has no UIBackgroundModes at all", () => {
  /* The premise of the whole issue. If this ever returns a list, Capacitor
     started setting it and this script becomes a no-op that should be deleted. */
  assert.equal(backgroundModes(CAPACITOR_PLIST), null);
});

test("the root dict's keys are read in file order and nothing is missed", () => {
  const keys = rootEntries(CAPACITOR_PLIST).entries.map((e) => e.key);
  assert.deepEqual(keys, [
    "CFBundleDevelopmentRegion",
    "CFBundleDisplayName",
    "CFBundleExecutable",
    "CFBundleIdentifier",
    "CFBundlePackageType",
    "CFBundleShortVersionString",
    "CFBundleVersion",
    "LSRequiresIPhoneOS",
    "UILaunchStoryboardName",
    "UIRequiresFullScreen",
    "UISupportedInterfaceOrientations",
    "UIViewControllerBasedStatusBarAppearance",
  ]);
});

test("self-closing <true/> and <false/> values do not desynchronise the walk", () => {
  /* The failure this catches is silent and total: treat `<true/>` as an opening
     tag and every subsequent key/value pair is off by one, so the key named
     `UIBackgroundModes` would be paired with somebody else's value. The
     assertion above would still pass; this one names the mechanism. */
  const e = rootEntries(CAPACITOR_PLIST).entries;
  assert.equal(e.find((x) => x.key === "LSRequiresIPhoneOS").value.name, "true");
  assert.equal(e.find((x) => x.key === "UIRequiresFullScreen").value.name, "false");
  assert.equal(e.find((x) => x.key === "UILaunchStoryboardName").value.name, "string");
});

/* ────────────────────────────── the injection ────────────────────────────── */

test("injecting into a generated plist adds exactly the audio mode", () => {
  const r = injectBackgroundAudio(CAPACITOR_PLIST);
  assert.equal(r.changed, true);
  assert.deepEqual(r.modes, ["audio"]);
  assert.deepEqual(backgroundModes(r.xml), ["audio"]);
});

test("the exported mode name is the one Apple documents", () => {
  /* Pinned rather than inlined: `audio` is the value
     docs/research/mp1-background-audio.md §7.1 quotes from
     AVAudioSession.Category.playback, and a typo here is a silent no-op on a
     device — the app builds, installs, and stops playing when the screen locks. */
  assert.equal(BACKGROUND_AUDIO_MODE, "audio");
});

test("everything else in the plist is left byte-for-byte alone", () => {
  /* The generated Info.plist carries build-setting substitutions like
     `$(EXECUTABLE_NAME)`. A reserialising editor (parse to JS, write back out)
     would reformat or escape them, and the app would fail to launch for a reason
     that looks nothing like this script. So the edit is a splice, and this test
     is what says so. */
  const r = injectBackgroundAudio(CAPACITOR_PLIST);
  const removed = r.xml.replace(
    /\t<key>UIBackgroundModes<\/key>\n\t<array>\n\t\t<string>audio<\/string>\n\t<\/array>\n/,
    ""
  );
  assert.equal(removed, CAPACITOR_PLIST);
});

test("the inserted block matches the file's own indentation", () => {
  const r = injectBackgroundAudio(CAPACITOR_PLIST);
  assert.match(r.xml, /\n\t<key>UIBackgroundModes<\/key>\n\t<array>\n\t\t<string>audio<\/string>\n\t<\/array>\n<\/dict>/);

  const spaces = CAPACITOR_PLIST.replace(/\t/g, "    ");
  const rs = injectBackgroundAudio(spaces);
  assert.match(rs.xml, /\n    <key>UIBackgroundModes<\/key>\n    <array>\n        <string>audio<\/string>\n    <\/array>\n<\/dict>/);
});

test("running it twice changes nothing the second time", () => {
  /* CI re-runs, and `cap sync` can regenerate. A script that only works once is
     a script somebody will run twice. */
  const once = injectBackgroundAudio(CAPACITOR_PLIST);
  const twice = injectBackgroundAudio(once.xml);
  assert.equal(twice.changed, false);
  assert.equal(twice.xml, once.xml);
  assert.deepEqual(twice.modes, ["audio"]);
});

test("an existing UIBackgroundModes keeps its other modes", () => {
  /* Nobody has asked for `location` or `voip` yet, but destroying a mode
     somebody added on a Mac would be a data-loss bug in a file a human edits. */
  const withLocation = CAPACITOR_PLIST.replace(
    "\t<key>UIViewControllerBasedStatusBarAppearance</key>",
    "\t<key>UIBackgroundModes</key>\n\t<array>\n\t\t<string>location</string>\n\t</array>\n\t<key>UIViewControllerBasedStatusBarAppearance</key>"
  );
  const r = injectBackgroundAudio(withLocation);
  assert.equal(r.changed, true);
  assert.deepEqual(r.modes, ["location", "audio"]);
});

test("an emptied <array/> is expanded rather than left broken", () => {
  /* Xcode's UI writes `<array/>` when the last member is deleted. Appending
     before a closing tag that does not exist would corrupt the file. */
  const emptied = CAPACITOR_PLIST.replace(
    "\t<key>UIViewControllerBasedStatusBarAppearance</key>",
    "\t<key>UIBackgroundModes</key>\n\t<array/>\n\t<key>UIViewControllerBasedStatusBarAppearance</key>"
  );
  const r = injectBackgroundAudio(emptied);
  assert.deepEqual(r.modes, ["audio"]);
  assert.match(r.xml, /<array>\n\t\t<string>audio<\/string>\n\t<\/array>/);
  assert.equal(rootEntries(r.xml).entries.length, 13);
});

test("a key/value pair written on one line still works", () => {
  const oneLine = CAPACITOR_PLIST.replace(
    "\t<key>CFBundleDisplayName</key>\n\t<string>Foray</string>",
    "\t<key>CFBundleDisplayName</key><string>Foray</string>"
  );
  assert.deepEqual(injectBackgroundAudio(oneLine).modes, ["audio"]);
});

test("comments in the plist do not break the walk", () => {
  const commented = CAPACITOR_PLIST.replace(
    "<dict>",
    "<dict>\n\t<!-- <key>UIBackgroundModes</key><array><string>audio</string></array> -->"
  );
  /* The commented-out key must NOT count as present: if it did, this script
     would report success and write nothing. */
  assert.equal(backgroundModes(commented), null);
  assert.deepEqual(injectBackgroundAudio(commented).modes, ["audio"]);
});

/* ──────────────────── the decoy: nesting must not be seen ────────────────── */

test("a UIBackgroundModes nested in another dict is NOT mistaken for the real one", () => {
  /* THE REASON THIS IS NOT A REGEX. `/UIBackgroundModes/.test(xml)` is true
     here, and a script that trusted it would decide the key already exists,
     write nothing, exit 0 — and the app would stop playing the moment the screen
     locked, with CI green. The root dict genuinely has no UIBackgroundModes, so
     the injection must still happen and must land at the ROOT. */
  const nested = CAPACITOR_PLIST.replace(
    "\t<key>UIViewControllerBasedStatusBarAppearance</key>",
    "\t<key>NSAppTransportSecurity</key>\n" +
      "\t<dict>\n" +
      "\t\t<key>UIBackgroundModes</key>\n" +
      "\t\t<array>\n\t\t\t<string>audio</string>\n\t\t</array>\n" +
      "\t\t<key>NSAllowsArbitraryLoads</key>\n\t\t<false/>\n" +
      "\t</dict>\n" +
      "\t<key>UIViewControllerBasedStatusBarAppearance</key>"
  );
  assert.equal(backgroundModes(nested), null, "a nested key was read as a root key");

  const r = injectBackgroundAudio(nested);
  assert.equal(r.changed, true);
  assert.deepEqual(r.modes, ["audio"]);
  /* And it landed at the root, not inside the nested dict: the root dict now has
     one more key than before, and the nested dict still has exactly two. */
  const rootKeys = rootEntries(r.xml).entries.map((e) => e.key);
  assert.ok(rootKeys.includes("UIBackgroundModes"));
  assert.ok(rootKeys.includes("NSAppTransportSecurity"));
  assert.equal(rootKeys.length, 14);
});

test("a nested array of the same shape does not desynchronise the root walk", () => {
  /* `UISupportedInterfaceOrientations` is already a root-level <array>, and the
     fixture has a nested <dict> too. Both are spanned, not descended into. */
  const keys = rootEntries(injectBackgroundAudio(CAPACITOR_PLIST).xml).entries.map((e) => e.key);
  assert.equal(new Set(keys).size, keys.length, "a key was read twice");
});

/* ─────────────────────── failing loud, never failing green ───────────────── */

test("a file that is not a plist is refused, not silently rewritten", () => {
  for (const bad of ["", "   ", "<html><body>nope</body></html>", "{\"UIBackgroundModes\":[\"audio\"]}"]) {
    assert.throws(() => injectBackgroundAudio(bad), PlistError, `accepted ${JSON.stringify(bad.slice(0, 20))}`);
  }
});

test("a plist whose root is not a dict is refused", () => {
  const arrayRoot = `<?xml version="1.0"?>\n<plist version="1.0">\n<array>\n\t<string>x</string>\n</array>\n</plist>\n`;
  assert.throws(() => injectBackgroundAudio(arrayRoot), /expected <dict> as the plist root/);
});

test("a self-closing root dict is refused rather than guessed at", () => {
  const empty = `<?xml version="1.0"?>\n<plist version="1.0">\n<dict/>\n</plist>\n`;
  assert.throws(() => injectBackgroundAudio(empty), /self-closing <dict\/>/);
});

test("UIBackgroundModes of the wrong type is refused, in both directions", () => {
  /* Reading it and writing it must agree that a <string> is not an <array>. A
     writer that "fixed" it by replacing the value would throw away whatever a
     human meant. */
  const wrong = CAPACITOR_PLIST.replace(
    "\t<key>UIViewControllerBasedStatusBarAppearance</key>",
    "\t<key>UIBackgroundModes</key>\n\t<string>audio</string>\n\t<key>UIViewControllerBasedStatusBarAppearance</key>"
  );
  assert.throws(() => backgroundModes(wrong), /requires an <array>/);
  assert.throws(() => injectBackgroundAudio(wrong), /requires an <array>/);
});

test("an unclosed tag is refused", () => {
  assert.throws(() => injectBackgroundAudio(CAPACITOR_PLIST.replace("</dict>", "")), /never closed/);
  assert.throws(
    () => injectBackgroundAudio(CAPACITOR_PLIST.replace("<string>Foray</string>", "<string>Foray")),
    PlistError
  );
});

test("a root key with no value is refused", () => {
  const dangling = CAPACITOR_PLIST.replace(
    "\t<key>UIViewControllerBasedStatusBarAppearance</key>\n\t<true/>",
    "\t<key>UIViewControllerBasedStatusBarAppearance</key>"
  );
  assert.throws(() => injectBackgroundAudio(dangling), /has no value/);
});

test("a non-string member of UIBackgroundModes is refused", () => {
  const weird = CAPACITOR_PLIST.replace(
    "\t<key>UIViewControllerBasedStatusBarAppearance</key>",
    "\t<key>UIBackgroundModes</key>\n\t<array>\n\t\t<integer>1</integer>\n\t</array>\n\t<key>UIViewControllerBasedStatusBarAppearance</key>"
  );
  assert.throws(() => injectBackgroundAudio(weird), /must be a <string>/);
});

test("a mode name that would break the XML is refused", () => {
  for (const bad of ["", "  ", "<script>", "audio&more", null, 7]) {
    assert.throws(() => injectBackgroundAudio(CAPACITOR_PLIST, bad), PlistError, `accepted ${bad}`);
  }
});

/* ─────────── three holes an adversarial pass opened, now closed ──────────── */

test("a padded <string> audio </string> is refused, not read as present", () => {
  /* FOUND BY AN ADVERSARIAL PASS, AND IT DEFEATED EVERY CHECK IN THE PIPELINE.
     `arrayStrings` used to `.trim()` each member, so a padded mode read as
     "audio" — the injector reported "already present", wrote nothing, and its own
     re-parse agreed. On the runner `--check` passed, `plutil -lint` passed, and
     `PlistBuddy | grep -q audio` passed on the padded value. All three
     "independent confirmations" agreed and all three were wrong: iOS does not
     honour a mode with surrounding whitespace, so audio would have died on the
     lock screen with CI fully green. */
  const padded = CAPACITOR_PLIST.replace(
    "\t<key>UIViewControllerBasedStatusBarAppearance</key>",
    "\t<key>UIBackgroundModes</key>\n\t<array>\n\t\t<string> audio </string>\n\t</array>\n\t<key>UIViewControllerBasedStatusBarAppearance</key>"
  );
  assert.throws(() => backgroundModes(padded), /surrounding whitespace/);
  assert.throws(() => injectBackgroundAudio(padded), /surrounding whitespace/);
});

test("a newline inside a <string> member is the same refusal", () => {
  const wrapped = CAPACITOR_PLIST.replace(
    "\t<key>UIViewControllerBasedStatusBarAppearance</key>",
    "\t<key>UIBackgroundModes</key>\n\t<array>\n\t\t<string>\n\t\t\taudio\n\t\t</string>\n\t</array>\n\t<key>UIViewControllerBasedStatusBarAppearance</key>"
  );
  assert.throws(() => injectBackgroundAudio(wrapped), /surrounding whitespace/);
});

test("two root-level UIBackgroundModes keys are refused, not merged into the first", () => {
  /* ALSO FOUND BY AN ADVERSARIAL PASS. `.find()` took the first key; every plist
     reader, Apple's included, takes the LAST. So the script appended `audio` to a
     key nothing reads, reported success, and `--check` — which used the same
     `.find()` — agreed. The effective value stayed `["location"]`. */
  const twice = CAPACITOR_PLIST.replace(
    "\t<key>UIViewControllerBasedStatusBarAppearance</key>",
    "\t<key>UIBackgroundModes</key>\n\t<array>\n\t\t<string>fetch</string>\n\t</array>\n" +
      "\t<key>UIBackgroundModes</key>\n\t<array>\n\t\t<string>location</string>\n\t</array>\n" +
      "\t<key>UIViewControllerBasedStatusBarAppearance</key>"
  );
  assert.throws(() => backgroundModes(twice), /declares UIBackgroundModes 2 times/);
  assert.throws(() => injectBackgroundAudio(twice), /declares UIBackgroundModes 2 times/);
});

test("assertModePresent is a real function, and it rejects what it should", () => {
  /* THE THIRD HOLE. This check used to be an inline `if` at the end of
     `injectBackgroundAudio`; changing it to `if (false)` left all 22 tests green,
     while its own comment says that without it every failure above "degrades to
     'returned the input unchanged and said it worked'". A guard that can be
     deleted invisibly is not a guard, so it is named and tested directly. */
  assert.throws(() => assertModePresent(CAPACITOR_PLIST, "audio"), /the edit did not take/);
  const withLocationOnly = CAPACITOR_PLIST.replace(
    "\t<key>UIViewControllerBasedStatusBarAppearance</key>",
    "\t<key>UIBackgroundModes</key>\n\t<array>\n\t\t<string>location</string>\n\t</array>\n\t<key>UIViewControllerBasedStatusBarAppearance</key>"
  );
  assert.throws(() => assertModePresent(withLocationOnly, "audio"), /does not include "audio"/);
  assert.deepEqual(assertModePresent(injectBackgroundAudio(CAPACITOR_PLIST).xml, "audio"), ["audio"]);
});
