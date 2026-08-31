/* The app's own name, pinned on every surface that displays it.
 *
 * THAT CLAIM WAS FALSE WHEN #302 MADE IT, and this file said so. #302 pinned
 * six display surfaces, #304 added the two legal documents, and a KNOWN GAP
 * block at the bottom listed eighteen shipped UI strings still reading
 * "Foray" that nothing asserted anywhere -- including a SECOND `<title>`, in
 * the offline fallback page `sw.js` serves, which the `index.html` assertion
 * below cannot reach. All eighteen are renamed and pinned now, so the claim
 * holds. What the gap block became is the block at the bottom: a record of
 * what is still called "Foray", and why each one stays.
 *
 * WHY THIS EXISTS. The app was renamed Foray -> 4a on 2026-08-21. Reverting
 * `index.html`'s `<title>` back to "Foray" passed every test in the repo:
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
 * name. The Capacitor `appId` (`ai.jwlabs.foura`, ruled 2026-08-25) is pinned
 * separately in `tools/mobile/shell-invariants.test.mjs`; it no longer carries
 * the word at all -- a bundle id is permanent once published, so it moved while
 * moving was still free.
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

/* ---------------------------------------------------------------------------
   SHIPPED UI COPY. #302 renamed six display surfaces, #304 the two published
   legal documents, and this PR the twenty strings a listener actually reads.
   Every one of them still said "Foray" until now, and NOT ONE was asserted
   anywhere: the KNOWN GAP block this replaces recorded them by hand, and a
   hand-written record is a note, not a guard. It was also WRONG TWICE -- it
   quoted `app.js:1170` as already half-renamed when both halves said Foray, and
   it listed eighteen strings when there were twenty. The two it missed are in
   `mobile/.../values/strings.xml`, one line above and one line below the string
   #302 DID rename in that very file. A list is not a guard.

   These are pinned here rather than in the suites that own each feature because
   they answer one question -- what is this app called? -- and three PRs in a row
   proved that a question owned per-file gets answered per-file, which is how a
   product ends up half-renamed.

   HOW THESE ASSERTIONS ARE ANCHORED, and why it is not `read(rel).includes()`.
   A bare file-wide substring check passes when the phrase survives ANYWHERE in
   the file, a comment included -- and this repo quotes UI copy in comments
   constantly, including twice in this PR (`sw.js:284`,
   `test/sw-generation.test.js:442`). A reviewer demonstrated the false pass:
   reverting `player/client.js:370` to "Back to the Foray" while leaving a
   comment quoting the lowercase form kept the lowercase test GREEN. So every
   assertion below reads the string out of the CODE CONSTRUCT that renders it --
   the `el()` call, the `<span>` template, the `#view` note template, the
   `head.push` -- and fails loudly when that construct moves.

   WHY NOT A MECHANICAL SWEEP for a capitalised "Foray" in every string literal,
   which would catch the NEXT new string as well as today's. It was written and
   thrown away: extracting string literals from these files with a regex cannot
   tell a template literal from a backtick inside a comment (`playForay` appears
   in prose 40 times in app.js alone), and the two honest outcomes were a sweep
   with a growing exemption list or a sweep that misses nested templates -- which
   is `app.js:1144` exactly, a `${}` inside a `${}`. If a sweep is wanted, it
   wants a parser, not a regex. What IS swept, below, is every member of a
   bounded set the code already enumerates: every `<title>`, every `#view` note,
   every Android `<string>`. Those are censuses, and a census catches the string
   nobody thought to list.
   ------------------------------------------------------------------------- */

/* The body of a named top-level function, with comments stripped. Anchors an
   assertion on code rather than on a file, for the reason given above.
   THROWS if the function is gone, so a rename fails loudly instead of vacuously
   passing on an empty string. */
const fnBody = (rel, name) => {
  const src = read(rel);
  const start = src.indexOf(`function ${name}(`);
  assert.notEqual(
    start,
    -1,
    `${rel} has no top-level function ${name}() -- the surface this pins moved`
  );
  const end = src.indexOf("\n}", start);
  assert.notEqual(end, -1, `${rel}'s ${name}() never closes at column 0`);
  return src
    .slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ");
};

/* EVERY <title> ANY SHIPPED SURFACE CAN RENDER, which is the specific hole this
   file shipped with. #302 asserted `index.html`'s title and called the job
   done; `sw.js`'s `unavailable()` builds a SECOND HTML document with its own
   `<title>`, served on a 504 to an offline visitor with nothing cached, and it
   still said "Foray". The one surface nobody looks at is the one a rename is
   most likely to miss, and the one a listener sees on their worst day.

   THE COUNT IS PINNED ON PURPOSE. Asserting "every title found is 4a" would
   have passed on `main` the day `sw.js` grew its title, because a title nobody
   collects is a title nobody checks -- the failure mode here was never a WRONG
   title, it was an UNCOUNTED one. A third document is a deliberate act: add it
   to TITLE_SURFACES, raise the count, and it is covered from that day.

   KILLED BY: reverting either title to "Foray" (both reverts run individually,
   both fail here, and the sw.js one fails NOTHING else in the repo -- verified
   against all 1,289 tests, and that is the hole). ALSO KILLED BY: deleting
   `sw.js`'s title, which drops the count. */
const TITLE_SURFACES = ["index.html", "sw.js"];

test("every <title> a shipped surface can render is the app name", () => {
  const found = [];
  for (const rel of TITLE_SURFACES) {
    for (const m of read(rel).matchAll(/<title>([^<]*)<\/title>/g)) {
      found.push({ rel, title: m[1].trim() });
    }
  }
  assert.equal(
    found.length,
    2,
    "expected exactly two documents with a <title>: index.html's, and the " +
      "offline fallback page sw.js builds in unavailable(). Found " +
      `${found.length}: ${found.map((f) => `${f.rel}=${f.title}`).join(", ")}. ` +
      "A NEW one is not a failure -- add its file to TITLE_SURFACES and raise " +
      "this count, so it is pinned from the day it ships. A MISSING one means a " +
      "page lost its title, which is its own bug."
  );
  for (const f of found) {
    assert.equal(f.title, APP_NAME, `${f.rel} titles its document "${f.title}"`);
  }
});

/* The body of that same offline page -- the only sentence an offline visitor
   with an empty cache gets. Asserted separately from the title because they are
   two different renames in one string concatenation, and #302's miss shows that
   "I fixed that file" is not the same as "I fixed that surface".

   KILLED BY: reverting to "<p>Foray couldn't load and there is no saved copy".
   `test/sw-generation.test.js:550` matches /no saved copy on this device/ on
   this same response and passes either way, so nothing but this fails. */
test("the offline fallback page's one sentence names the app", () => {
  const m = read("sw.js").match(
    /<p>(\S+) couldn't load and there is no saved copy on this device\./
  );
  assert.ok(m, "sw.js's 504 fallback page no longer opens with that sentence");
  assert.equal(m[1], APP_NAME);
});

/* The first-visit intro card: the first sentence a new visitor reads, and the
   one place the product says what it is. The name OPENS the sentence, which is
   asserted rather than merely allowed -- see the note on the shell notices.

   THE COUNT WAS SPELLED OUT to land this rename. The line read "grouped into 4
   topic queues", so renaming the app put `4a` and `4` eight words apart in one
   sentence, doing different jobs -- a name and a count -- in the first sentence
   a new visitor ever reads. It read like a typo. "four topic queues" costs one
   word and leaves `4a` as the only numeral on the card. Recorded because it is
   the clearest evidence in the repo for the naming question #304 raised: a
   lowercase digit-initial name collides with ordinary copy, and this is what
   paying that cost looks like.

   KILLED BY: reverting to "Foray picks podcast episodes for you". */
test("the first-visit intro popup names the app", () => {
  const m = fnBody("app.js", "showIntroPopupOnce").match(
    /ddEl\("h3", null, "([^"]*)"\)/
  );
  assert.ok(m, "showIntroPopupOnce() no longer builds an <h3> title node");
  assert.ok(
    m[1].startsWith(`${APP_NAME} `),
    `the intro popup must open with the app's name; it opens "${m[1].slice(0, 40)}"`
  );
  assert.ok(
    !/\b4 \w/.test(m[1]),
    "spell any count on this card out in words: a bare digit next to a " +
      `digit-initial app name reads as a typo. Got: "${m[1]}"`
  );
});

/* Both stale-shell notices. Two entries, one test, because they are one object
   literal and a rename that catches one and not the other is the exact shape of
   `app.js:1170` before this PR -- a single line that said "Foray" once and "4a"
   once.

   THE NAME OPENS BOTH SENTENCES AND THAT IS PINNED, not tolerated. "4a is
   showing its last saved copy" begins a sentence with a lowercase digit-initial
   word, which #304 already flagged as reading like a typo to a lay eye. It is
   pinned in this position anyway: the alternative is a rewrite that buries the
   name mid-sentence in five places to dodge one typography complaint, and a
   product whose name cannot open a sentence has a naming problem, not a copy
   problem. If the name is ever changed for that reason, this assertion is where
   the decision was recorded.

   KILLED BY: reverting either value to "Foray is showing ..." / "Foray updated
   ...". `test/sw-generation.test.js` matches /last saved copy/ and /updated in
   the background/ on these same two strings and passes either way. */
test("both shell notices name the app", () => {
  const src = read("app.js");
  for (const reason of ["stale-shell", "generation-changed"]) {
    const m = src.match(new RegExp(`"${reason}": "([^"]*)"`));
    assert.ok(m, `SHELL_NOTICE has no "${reason}" entry`);
    assert.ok(
      m[1].startsWith(`${APP_NAME} `),
      `the ${reason} notice must open with the app's name; it opens "${m[1].slice(0, 40)}"`
    );
  }
});

/* EVERY ONE-LINE NOTE THIS APP PUTS IN #view -- a census, not a list, so a note
   added next year is covered the day it ships. There are six: two name the app
   ("Couldn't load 4a", the load-failure page) and two name the unit ("Couldn't
   load forays right now.", "That foray isn't available."), and the rest name
   neither.

   IT ASSERTS THE ABSENCE OF THE CAPITALISED FORM, which is the one absence rule
   this file allows itself and the same one it already applies to the two legal
   documents. These notes are prose; the unit is a common noun; so a capital
   "Foray" in one of them is the old app name. The word itself must survive --
   it is the unit -- so the case is what can be checked.

   `app.js:1589` WAS ALSO REWORDED and the reason belongs here. It read "Forays
   aren't available right now." -- sentence-initial, where a capital is correct
   English for a common noun and therefore indistinguishable from the old app
   name to a listener who has never read an ADR. It could not simply be
   lowercased. "Couldn't load forays right now." moves the noun off the front so
   it CAN be lowercase, and keeps the sense: the trigger is `!state.forays`, a
   fetch that failed, not an empty catalogue -- a first attempt at this reword
   ("No forays are available right now.") lost that and said "there are none"
   about a network error. It now rhymes with `app.js:3054`'s "Couldn't load 4a",
   which is the same event one layer up. Two comments quoting the old wording
   (`sw.js:284`, `test/sw-generation.test.js:442`) were updated with it.

   KILLED BY: recapitalising either unit note, or reverting 1589's wording (both
   run individually). ALSO KILLED BY: adding a seventh note that says "Foray",
   which is the case a list would have missed. */
test("no note this app renders into #view capitalises the unit", () => {
  const notes = [
    ...read("app.js").matchAll(
      /innerHTML = `<div class="page"><p class="note">([^<]*)<\/p><\/div>`/g
    ),
  ].map((m) => m[1]);
  assert.equal(
    notes.length,
    7,
    `expected seven one-line #view notes, found ${notes.length}. More is fine -- ` +
      "raise this count so the new one is covered. Fewer means a note was lost " +
      `or reshaped: ${notes.join(" | ")}`
  );
  for (const n of notes) {
    assert.ok(
      !/Foray/.test(n),
      `"${n}" capitalises the unit. The app is ${APP_NAME}; the stitched-audio ` +
        "unit is a common noun and is lowercase. Do not lowercase a proper noun " +
        "to get past this -- decide which sense the sentence means."
    );
  }
  for (const expected of [
    "Couldn't load forays right now.",
    "That foray isn't available.",
  ]) {
    assert.ok(
      notes.includes(expected),
      `the note "${expected}" is gone; #view now renders: ${notes.join(" | ")}`
    );
  }
});

/* The hard-failure page: session.json did not load, so this replaces the whole
   app with one line. Nothing else in the repo reads it. The best-reading string
   in this whole rename -- the name sits mid-sentence, so nothing collides.

   KILLED BY: reverting to "Couldn't load Foray — check your connection". */
test("the load-failure page names the app", () => {
  const m = read("app.js").match(
    /Couldn't load (.+?) — check your connection and reload\./
  );
  assert.ok(m, "app.js's init() no longer has its load-failure note");
  assert.equal(m[1], APP_NAME);
});

/* The delete-data sheet's first line -- what a listener is told the control
   covers, immediately before they press it. It is the app's keys that go, and
   the storage keys themselves are still literally `cp_foray:` (deliberately,
   and permanently: see the header). So this line has to name the APP while the
   thing it describes keeps the old name in its bytes, which is why it needed a
   judgement call rather than a substitution. The privacy policy discloses the
   discrepancy, so a listener who wonders can find out.

   KILLED BY: reverting to "This device: every Foray key". */
test("the delete-data sheet names the app", () => {
  const m = read("app.js").match(/"This device: every (\S+) key/);
  assert.ok(m, "DD_COVERS no longer has its 'This device: every … key' line");
  assert.equal(m[1], APP_NAME);
});

/* THE PLAYLIST-SHORTFALL COPY: five app-sense uses across four lines, all of
   them about the CATALOGUE (what the product has today), none about a
   stitched-audio unit -- a playlist part was never "in a foray"; there is no
   foray anywhere in this feature. Judged individually and they all came out the
   same way, which is why they are one test.

   FIVE, NOT FOUR. `app.js:1170` says the name TWICE in one sentence ("saved
   before ... kept episode details" and "what ... has today"), and the KNOWN GAP
   record this file used to carry quoted that line as ALREADY half-renamed. It
   was not: on `main` both halves said "Foray". A per-line record miscounting a
   line it quoted is the argument for pinning strings instead of listing them.

   READ OUT OF THE TWO FUNCTIONS THAT RENDER THEM, not out of the file: the
   caption is `archivedRow`'s, the note is `partsNote`'s, and `partsNote`
   carries a block comment of its own that a file-wide search would read.

   KILLED BY: reverting any one of the five. `test/playlist-durability.test.js`
   asserts three of them (its lines 529/564/594 for the caption, 679/681 for the
   note) and was updated in this same commit -- so reverting the caption alone
   fails there too, but reverting "what 4a has today" fails ONLY here. */
test("the playlist-shortfall copy names the app, not the unit", () => {
  const row = fnBody("app.js", "archivedRow");
  const note = fnBody("app.js", "partsNote");
  for (const [where, body, phrase] of [
    ["archivedRow", row, `not in ${APP_NAME}'s catalogue right now`],
    ["archivedRow", row, `Saved before ${APP_NAME} kept episode details`],
    ["partsNote", note, `not in ${APP_NAME}'s catalogue right now`],
    ["partsNote", note, `saved before ${APP_NAME} kept episode details`],
    ["partsNote", note, `from what ${APP_NAME} has today`],
  ]) {
    assert.ok(body.includes(phrase), `${where}() no longer says "${phrase}"`);
    assert.ok(
      !/Foray/.test(body),
      `${where}() still capitalises the name somewhere in its rendered copy`
    );
  }
});

/* The header of the Playback diagnostics report -- the first line of the text a
   listener selects and pastes into an issue, so it travels further than any
   other string here. #304 edited `privacy-policy.md:101` and
   `data-safety.md:99`, which both DESCRIBE this drawer, and left its own header
   saying Foray: the PR that documented the surface did not read it.

   Also the one rename that made a string SHORTER, which matters on this
   surface: the block above this line in `diagnostic-log.js` holds the header to
   ~44 characters so a founder can read it on a phone without scrolling
   sideways. "4a" buys three characters back.

   KILLED BY: reverting to `Foray playback diagnostics — v${...}`.
   `player/diagnostic-record.test.js:867` matches /4a playback diagnostics/ on
   the real generated report and was updated in this same commit; that one
   proves the header is PRODUCED, this one proves it is the app's name. */
test("the diagnostics report header names the app", () => {
  const m = read("player/diagnostic-log.js").match(
    /`([^`\n]*?) playback diagnostics — v\$\{/
  );
  assert.ok(m, "formatDiagnosticReport() no longer opens with a versioned header");
  assert.equal(m[1], APP_NAME);
});

/* ---------------------------------------------------------------------------
   THE OTHER HALF OF THE SAME JOB: the unit is a common noun, so it is
   lowercase. `#view`'s notes are covered by the census above; these are the
   three remaining places a listener meets the word.
   ------------------------------------------------------------------------- */

/* The mini-player's back link. Unit-sense beyond argument -- it routes to the
   page of the foray currently playing, which is why it is hidden until one is.

   READ OUT OF THE `el()` CALL, on its two class names. This is the assertion a
   reviewer broke with a file-wide `includes()`: recapitalising the label while
   leaving a comment that quoted the lowercase form kept the test green.

   NOTED, NOT FIXED, because it is a copy decision and not a rename: lowercase
   "the foray" now collides with the "into the fray/foray" idiom, where the
   capital at least signalled "a thing in this app". Both casings are ambiguous
   and the honest fix is naming what it actually is -- "Back to the running
   order", the vocabulary `player/queue-manager.js` already uses. That is a
   founder's copy call, not a rename's.

   KILLED BY: reverting to "Back to the Foray". */
test("the mini-player's back link lowercases the unit", () => {
  const m = read("player/client.js").match(
    /el\("a", "fp-openep fp-toforay", "([^"]*)"\)/
  );
  assert.ok(m, "player/client.js no longer builds the .fp-toforay link");
  assert.equal(m[1], "Back to the running order");
});

/* The home screen's kicker above each foray's title. A LABEL, not prose, so a
   capital would have been defensible the way a title-case heading is -- and
   `styles.css:598` sets `text-transform: uppercase`, so it renders "FORAY"
   whichever case the source holds.

   LOWERCASED ANYWAY, and that is the point of pinning it. Because the transform
   makes the two visually identical, lowercasing costs nothing and buys the
   three paths CSS does not reach: what a screen reader reads out of the DOM,
   what lands on the clipboard when a listener copies the card, and what shows
   if the stylesheet fails. All three now agree with the convention.

   THE FAILURE THIS GUARDS IS NOT A REVERT. It is someone "finishing the
   rename" and making this `4a`, which would ship a home screen labelling every
   foray with the app's name -- an app-sense edit to a unit-sense label. Pinning
   the lowercase unit fails that as loudly as it fails a revert to "Foray".

   KILLED BY: either "Foray" or "4a" in this span. Both were run. */
test("the home-screen kicker labels the unit, lowercase, and never the app", () => {
  const m = read("app.js").match(
    /<span class="fy-home-kicker">([^$<]*)\$\{/
  );
  assert.ok(m, "forayHomeHtml() no longer renders an .fy-home-kicker");
  assert.equal(m[1], "foray");
});

/* THE HALF-FIX GUARD. One sentence exists TWICE: `diagnostic-log.js:1047`
   produces it inside the real report, and `app.js:2886` is the fallback --
   `diagText()` does `String(window.forayDiagnosticReport() || "")` and only
   reaches its own copy when the record is empty or the module never loaded. So
   the app.js one is the easy one to find and the WRONG one to fix alone:
   renaming it leaves the common path saying "Foray" and reads as handled to the
   next person.

   One test over both, for that reason -- a per-file pin would let the half-fix
   land green in the file it covered. Each is read out of its own construct, the
   `head.push(...)` and the `return out || ...`.

   KILLED BY: recapitalising either copy. Both reverts were run separately and
   this fails on each, naming which file. */
test("the diagnostics empty-state sentence is renamed in the primary AND the fallback", () => {
  const SENTENCE = "Nothing recorded yet. Play a foray and come back.";
  const sites = [
    ["player/diagnostic-log.js", /head\.push\("([^"]*)"\)/, "the report itself"],
    ["app.js", /return out \|\| "([^"]*)"/, "diagText()'s fallback"],
  ];
  for (const [rel, re, what] of sites) {
    const m = read(rel).match(re);
    assert.ok(m, `${rel} no longer carries ${what}`);
    assert.equal(
      m[1],
      SENTENCE,
      `${what} (${rel}) says "${m[1]}". If only one of the two was renamed, the ` +
        "other is the one a listener actually sees -- diagnostic-log.js is the " +
        "common path, app.js is the decoy."
    );
  }
});

/* ---------------------------------------------------------------------------
   THE ANDROID STRING TABLE, in full. #302 renamed
   `foray_playback_notification_title` here (pinned above) and left the two
   strings either side of it saying "Foray" -- the KNOWN GAP record never
   listed them, which is how a rename misses a file it had already opened.
   Both are user-visible: `foray_playback_channel_description` is set on the
   notification channel (`PlaybackKeepAliveService.java:369`) and shows in
   Settings -> Apps -> 4a -> Notifications -> Playback;
   `foray_playback_service_description` is `android:description` on the
   `<service>` (`AndroidManifest.xml:48`) and shows in the system's
   running-services UI. Both are unit-sense ("keeps a foray playing"), so both
   are lowercase.

   A CENSUS, like the #view notes: every `<string>` in the table, so the next
   one added is covered on the day it ships rather than the day someone
   remembers. The file's header comment quotes the old title as history and is
   correctly untouched -- only element values are read.

   KILLED BY: recapitalising either description (both run individually; neither
   fails anything else in the repo, including the Gradle build, because nothing
   else reads these two strings). */
test("no Android string capitalises the unit, and none of them says the old app name", () => {
  const rel = "mobile/plugins/foray-audio/android/src/main/res/values/strings.xml";
  const entries = [
    ...read(rel).matchAll(/<string name="([^"]+)">([^<]*)<\/string>/g),
  ].map((m) => ({ name: m[1], value: m[2] }));
  assert.equal(
    entries.length,
    10,
    `expected 10 <string> entries, found ${entries.length}: ` +
      entries.map((e) => e.name).join(", ")
  );
  for (const e of entries) {
    assert.ok(
      !/Foray/.test(e.value),
      `${e.name} = "${e.value}". This ships to a listener's notification ` +
        `settings. The app is ${APP_NAME}; the unit is a lowercase common noun.`
    );
  }
  for (const name of [
    "foray_playback_service_description",
    "foray_playback_channel_description",
  ]) {
    const e = entries.find((x) => x.name === name);
    assert.ok(e, `${name} is gone from the string table`);
    assert.match(
      e.value,
      /\ba foray\b/,
      `${name} must name the unit in lowercase; it says "${e.value}"`
    );
  }
});

/* ===========================================================================
   WHAT IS STILL CALLED "Foray", ON PURPOSE OR PENDING A FOUNDER
   ===========================================================================
   The KNOWN GAP block that stood here listed 12 app-sense and 6 unit-sense
   shipped strings. There were twenty, not eighteen. All twenty are renamed and
   pinned above. What is left is not a gap in shipped UI:

   ON PURPOSE, FOREVER -- identifiers, verified byte-identical by this PR:
   `foray-v5`, `cp_foray:`, `cp_foray_feedback`, the IndexedDB database `foray`,
   the `foray_play` / `foray_restart` / `foray_progress_drift` event types, the
   `?foray=` parameter, the Pages URL, both
   User-Agents (`Foray/0.1`, the client's, and `ForayBot/0.1`, the audio
   fetcher's -- #302 named only the first), every `foray_*` Android resource
   NAME, and 56 file and directory paths. Renaming any of these breaks live user state or a
   published contract. See the header.

   THE BUNDLE ID WAS ON THAT LIST AND IS NOT ANY MORE, which is the one thing
   #302's "forever" got wrong: `com.jwincorporated.foray` was ruled
   `dev.jwlabs.foura` on 2026-08-24, the plugin's Java package followed on
   2026-08-25, and both moved again the same day to `ai.jwlabs.foura` when
   `jwlabs.ai` became the company's primary domain (`docs/DECISIONS.md`).
   "Permanent once published" is the whole argument, and nothing is published --
   so the window was open, not closed, all three times. It is pinned in
   `tools/mobile/shell-invariants.test.mjs`, not here.

   NOT SHIPPED, so out of scope: `docs/ux/foray-m3-prototype.html` and
   `tools/mobile/probe/probe-{outpoint,seam}.html` each have a `<title>Foray`.
   They are a UX reference and two developer probes, served to nobody. They are
   deliberately NOT in TITLE_SURFACES -- adding them would make this file assert
   on artefacts no listener can reach.

   PENDING A FOUNDER -- two documents on `DENIED_PREFIXES`, which an agent PR
   cannot touch without a `founder-approved` label:

     docs/DECISIONS.md:28   still records "Renamed CommutePilot -> Foray" as the
                            standing naming decision, with no entry superseding
                            it. The decision log is the one place a reader goes
                            to ask what the app is called, and it answers
                            "Foray".
     docs/adr/0007-segment-anchoring.md:1
                            capitalises the unit in the canonical definition
                            ("how a Foray segment boundary is represented"),
                            re-seeding in the authoritative document the exact
                            ambiguity #302 removed everywhere else.

   Not assertable from here either way: a pin on a path this repo's own policy
   forbids editing is a red build nobody is allowed to fix. Recorded so the
   founder PR that renames them has its list ready. */
