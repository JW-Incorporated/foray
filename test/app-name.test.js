/* The app's own name, pinned on every surface that displays it.
 *
 * WHY THIS EXISTS. The app was renamed Foray -> 4a on 2026-08-21. Reverting
 * `index.html`'s `<title>` back to "Foray" passed all 339 tests in this repo:
 * the name a browser tab, a home-screen icon and the page header show was
 * asserted NOWHERE. A rename that nothing pins is a rename that comes back one
 * careless edit later, in the surface users actually look at.
 *
 * WHAT THIS DELIBERATELY DOES NOT PIN. The stitched-audio unit is still called
 * a "foray" and that is intentional, so this file must never assert the absence
 * of the word. `data/forays.json`, `?foray=`, `playForay()`, `cp_foray:` keys,
 * `player/foray-*.js` and `tools/foray/` are the domain concept, not the app
 * name. The Capacitor `appId` (`com.jwincorporated.foray`) is pinned separately
 * in `tools/mobile/shell-invariants.test.mjs` and stays on `foray` on purpose --
 * a bundle id is permanent once published.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const APP_NAME = "4a";
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

/* KILLED BY: reverting `<title>4a</title>` to `<title>Foray</title>`. */
test("index.html <title> is the app name", () => {
  const m = read("index.html").match(/<title>([^<]*)<\/title>/);
  assert.ok(m, "index.html has no <title> at all");
  assert.equal(m[1].trim(), APP_NAME);
});

/* KILLED BY: reverting the apple-mobile-web-app-title content. This is the
   label under the icon when the site is added to an iOS home screen. */
test("the iOS home-screen title is the app name", () => {
  const m = read("index.html").match(
    /<meta\s+name="apple-mobile-web-app-title"\s+content="([^"]*)"/
  );
  assert.ok(m, "apple-mobile-web-app-title is missing");
  assert.equal(m[1].trim(), APP_NAME);
});

/* KILLED BY: reverting the <h1> anchor text. Asserts on the FIRST <h1>'s link
   text specifically, not on the file containing the string anywhere -- a test
   that merely greps for "4a" would pass on a page that had lost its header. */
test("the page header shows the app name", () => {
  const m = read("index.html").match(/<h1>\s*<a[^>]*>([^<]*)<\/a>/);
  assert.ok(m, "index.html's <h1> has no anchor");
  assert.equal(m[1].trim(), APP_NAME);
});

/* KILLED BY: changing either manifest field. Both matter: `name` is the install
   prompt, `short_name` is the icon label when the full name will not fit. */
test("the PWA manifest installs under the app name", () => {
  const mf = JSON.parse(read("manifest.json"));
  assert.equal(mf.name, APP_NAME);
  assert.equal(mf.short_name, APP_NAME);
});

/* KILLED BY: reverting `artist = "4a"` in player/media-session.js. This is the
   line a car stereo and a lock screen show for narration we recorded ourselves.
   It is deliberately our name and never a publisher's -- putting a publisher on
   audio they did not record is the one credit error that module must not make. */
test("the lock screen credits the app, not a publisher, for our own narration", () => {
  assert.match(read("player/media-session.js"), /artist = "4a";/);
});

/* KILLED BY: reverting the Android notification title string.
   A test that can never fail on today's data is still worth writing when it is
   the only thing standing between a rename and a half-renamed product. */
test("the Android playback notification shows the app name", () => {
  const xml = read("mobile/plugins/foray-audio/android/src/main/res/values/strings.xml");
  const m = xml.match(
    /<string name="foray_playback_notification_title">([^<]*)<\/string>/
  );
  assert.ok(m, "foray_playback_notification_title is missing");
  assert.equal(m[1].trim(), APP_NAME);
});
