/* The app's own name, pinned on the surfaces listed below.
 *
 * NOT "every surface that displays it" -- that is what this file claimed when
 * #302 created it, and it was not true. See KNOWN GAP at the bottom.
 *
 * WHY THIS EXISTS. The app was renamed Foray -> 4a on 2026-08-21. Reverting
 * `index.html`'s `<title>` back to "Foray" passed all 339 tests in this repo:
 * the name a browser tab, a home-screen icon and the page header show was
 * asserted NOWHERE. A rename that nothing pins is a rename that comes back one
 * careless edit later, in the surface users actually look at.
 *
 * WHAT THIS DELIBERATELY DOES NOT PIN. The stitched-audio unit is still called
 * a "foray" and that is intentional, so this file must never assert the absence
 * of the word -- only, in the two legal documents, the absence of its
 * CAPITALISED form in prose, which is the old app name unless it is explicitly
 * disclosed as the former name (see FORMER_NAME_RE).
 * `data/forays.json`, `?foray=`, `playForay()`, `cp_foray:` keys,
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

/* ---------------------------------------------------------------------------
   The published legal documents. PR #302 renamed the app on six DISPLAY
   surfaces and missed `docs/legal/`, which is the surface with the longest
   half-life: the privacy policy becomes a public URL in both store listings,
   and a document that names the app wrongly is a published wrong statement.
   These two tests close that specific gap.
   ------------------------------------------------------------------------- */

const LEGAL_DOCS = ["docs/legal/privacy-policy.md", "docs/legal/data-safety.md"];

/* A deliberate prose use of the old name: disclosing it as the former name.
   A renamed product's policy is expected to say so -- see the privacy policy's
   "Applies to" line, which explains why `foray` is still in the URL and in the
   storage keys. This is the ONE capitalised prose use that is correct, so it is
   exempted explicitly rather than by loosening the rule.

   KNOWN LIMIT: this is applied per line, so a future reflow that wraps between
   "formerly" and "Foray" would silently drop the exemption and the test would
   start failing on a correct sentence. If that happens, rewrap the sentence --
   do not delete the test. */
const FORMER_NAME_RE = /\b(?:formerly|previously)(?:\s+(?:known\s+as|called|named))?\s+Foray\b/g;

/* Returns the prose of a markdown file: every line, with fenced code blocks
   dropped and inline code spans blanked. Literals live in code spans here by
   convention, and this test must not read them as prose.

   THROWS ON AN UNBALANCED FENCE, and that assertion is the whole reason this is
   a function rather than four inline lines. Without it an unclosed ``` silently
   exempts the entire remainder of the file from every check below: a reviewer
   demonstrated the false pass by adding one stray fence near the top of
   privacy-policy.md and reverting §5's heading to "What Foray does not do" --
   the suite went green. A guard that can be switched off by a typo is not a
   guard. */
const prose = (rel) => {
  const out = [];
  let fenced = false;
  read(rel)
    .split(/\r?\n/)
    .forEach((line, i) => {
      if (/^\s*```/.test(line)) {
        fenced = !fenced;
        return;
      }
      if (fenced) return;
      const text = line.replace(/`[^`]*`/g, "``").replace(FORMER_NAME_RE, "");
      out.push({ n: i + 1, text, raw: line });
    });
  assert.equal(
    fenced,
    false,
    `${rel} ends inside an unclosed \`\`\` fence, so everything after it was ` +
      "skipped. Balance the fence -- an unbalanced one turns this test off."
  );
  return out;
};

/* KILLED BY: reverting any prose "Foray" in either legal document -- e.g.
   putting `docs/legal/privacy-policy.md`'s title back to
   `# Foray — Privacy Policy`, or §5's heading back to
   `## 5. What Foray does not do`. Both reverts were run individually and both
   fail here; neither fails anything else in the repo, which is exactly the hole
   #302 left.

   WHY THIS MATCHES ON CASE AND NOT ON THE WORD. The word "foray" must survive
   in these documents. It is the stitched-audio unit ("inside a given foray",
   "the assembled forays"), and it is inside identifiers the documents are
   obliged to name verbatim: `cp_foray:<id>`, `cp_foray_feedback`, `foray-v5`,
   the IndexedDB database `foray`, the `foray_play` / `foray_restart` /
   `foray_progress_drift` event types, and the Pages URL. So this cannot assert
   the word is absent. What it CAN assert is the capitalisation: the unit is a
   common noun and is lowercase mid-sentence, so a capitalised "Foray" in prose
   is the old app name.

   WHERE THAT RULE IS NOT AIRTIGHT, stated rather than discovered later. A
   reviewer found three legitimate English uses it would reject: the unit at the
   start of a sentence ("Forays are assembled from..."), the unit in a
   title-case heading, and disclosing the former name. The third is the real one
   and it is now exempted above (FORMER_NAME_RE) because the policy does it. The
   other two are style choices the documents do not currently make; if one is
   ever wanted, widen the rule deliberately rather than deleting the test.

   WHY CODE SPANS AND FENCES ARE EXEMPT. They hold literals quoted exactly, and
   one of them is legitimately capitalised: the `Foray/0.1` User-Agent, which
   #302 deliberately did not rename because it is our identity to podcast hosts.
   If §4 ever discloses it, it belongs in backticks like every other literal. */
test("the legal documents call the app 4a, never Foray", () => {
  const offenders = [];
  for (const rel of LEGAL_DOCS) {
    for (const line of prose(rel)) {
      if (/Foray/.test(line.text)) offenders.push(`${rel}:${line.n}: ${line.raw.trim()}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "these lines still call the app Foray in prose; the app is " +
      `${APP_NAME} (#302). Decide per occurrence: the stitched-audio UNIT is a ` +
      "common noun, so lowercase it; a literal (a key, a cache name, a " +
      "User-Agent) belongs in backticks; the app's FORMER name is allowed only " +
      'as "formerly Foray". Do not lowercase a proper noun to get past this ' +
      `test:\n${offenders.join("\n")}`
  );
});

/* KILLED BY: changing the privacy policy's first line to any other title --
   e.g. `# CommutePilot — Privacy Policy`, which the test above does NOT catch
   because it contains no "Foray". Run and confirmed failing. Pinned separately
   because this one line is the title of a document that will be hosted at the
   privacy-policy URL both stores require, so it is the first name a store
   reviewer reads. */
test("the privacy policy is titled with the app name", () => {
  const first = read("docs/legal/privacy-policy.md").split(/\r?\n/)[0].trim();
  assert.equal(first, `# ${APP_NAME} \u2014 Privacy Policy`);
});

/* ===========================================================================
   KNOWN GAP -- shipped UI copy still says "Foray", and is NOT pinned here.
   ===========================================================================
   Found by the reviewer on this PR, recorded rather than quietly fixed because
   it is a change to what users see and belongs in its own reviewed PR, not as a
   ride-along on a legal-copy change that auto-merges.

   App-sense strings still reading "Foray" in shipped code:
     app.js:1023  the first-visit intro card: "Foray picks podcast episodes for
                  you, grouped into 4 topic queues below..."
     app.js:1144  "... · not in Foray right now"
     app.js:1145  "Saved before Foray kept episode details"
     app.js:1161  "not in Foray's catalogue right now"
     app.js:1170  "saved before Foray kept episode details ... what 4a has
                  today"  <- already half-renamed, so this line is inconsistent
                  with ITSELF
     app.js:2598  the delete-data sheet: "This device: every Foray key, ..."
     app.js:3181  "Foray is showing its last saved copy ..."
     app.js:3182  "Foray updated in the background ..."
     sw.js:289    the offline fallback page's own <title>Foray</title> -- a
                  SECOND <title>, which the index.html assertion above does not
                  reach
     sw.js:290    "Foray couldn't load and there is no saved copy on this device"
     app.js:3054  "Couldn't load Foray -- check your connection and reload"
     player/diagnostic-log.js:1034
                  `Foray playback diagnostics -- v${r.v ?? "?"}` -- the first
                  line of formatDiagnosticReport(), i.e. the header of the text
                  a listener COPIES OUT of the Playback diagnostics drawer. That
                  drawer is described in `privacy-policy.md:101` and
                  `data-safety.md:99`, both of which THIS PR edits, so the PR
                  documents a surface whose own header still says Foray.

   Unit-sense strings, which may be correct as-is or may want lowercasing --
   each needs the same per-occurrence call the legal documents got:
     app.js:1589, 1602, 2274
     player/client.js:370            "Back to the Foray" (mini-player back link)
     player/diagnostic-log.js:1047   "Nothing recorded yet. Play a Foray and
                                     come back."
     app.js:2886                     the SAME sentence as diagnostic-log.js:1047

   READ THOSE LAST TWO TOGETHER. `app.js:2879 diagText()` does
   `String(window.forayDiagnosticReport() || "")` and only falls back to its own
   copy of the sentence when the record is empty -- so `diagnostic-log.js:1047`
   is the common path and `app.js:2886` is the fallback. Renaming only the one in
   `app.js` fixes the fallback, leaves the primary, and reads as "handled" to the
   next person. That half-fix is the specific thing this block exists to prevent.

   `player/` is already within this file's reach -- it asserts on
   `player/media-session.js` -- so covering these is not a scope expansion.

   AND THE SUITE CURRENTLY CONTRADICTS ITSELF: test/playlist-durability.test.js
   asserts the OLD name in shipped copy five times (lines 529, 564, 594, 679,
   681 -- e.g. `html.includes("not in Foray right now")`). So renaming app.js
   means updating those five assertions in the same PR. That contradiction is
   the reason this is written down here instead of left to be rediscovered.

   Do not add assertions for the strings above until they are renamed; a failing
   pin is worse than a recorded gap. Delete this block when the follow-up
   lands. */
