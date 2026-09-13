/* The Foray running order's rows — founder report, 2026-09-12:
 *
 *   "when I have a foray open and I'm interested in what I'm hearing, I want to
 *    be able to easily navigate to the show's page. not just for what I'm
 *    currently listening to, but for anything in the foray. please improve
 *    this. also, for each segment in a foray, there's some column on the left
 *    with some index nonsense - takes up screen space, please remove"
 *
 * and, on the same rows:
 *
 *   "we should add the AI's transcript with cited sources to the foray, likely
 *    instead of the show name for that beat, title it something like 'AI
 *    Narrator' and have the full transcript there. for long transcripts, by
 *    default have them collapsed ... which then expands in place"
 *
 * WHAT THIS PROVES, in order:
 *  1. Every beat — playing or not, playable or not — reaches its show page
 *     through a real <a href="#/show/:id">, and reaches it by the identifier
 *     join first and the title join second.
 *  2. A beat whose show joins NEITHER way renders exactly the plain text it
 *     rendered before this card, never a link to a page that says "Show not
 *     found."
 *  3. The link is a SIBLING of the play button, never a descendant — the same
 *     invalid-HTML rule that put the thumbs outside it.
 *  4. The curation code (`ORI-1`, `GRID-1`) is gone from the row and from the
 *     accessible names, and `.fy-label` is gone from the stylesheet.
 *  5. A narration beat is credited "AI Narrator" in the slot a show credit
 *     occupies, is never a link, and carries its transcript with a collapse
 *     that expands in place.
 *  6. Citations (F-103) render when an item carries them and are INVISIBLE when
 *     it does not — which is the state of all eight committed Forays.
 *
 * Every test names the mutation that turns it red, per CLAUDE.md.
 *
 * Harness: the node:vm DOM stub from test/show-page.test.js, trimmed to what a
 * row render needs. Duplicated rather than imported for the reason that file
 * gives — a shared harness module is a bigger refactor than this card.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const APP_SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const SEARCH_SRC = fs.readFileSync(path.join(ROOT, "search-engine.js"), "utf8");
const STYLES = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8");
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));

process.on("unhandledRejection", () => {});

function makeEl(tag) {
  return {
    tagName: String(tag || "div").toUpperCase(),
    id: null, className: "", innerHTML: "", textContent: "", value: "",
    hidden: false, disabled: false, dataset: {}, style: {}, children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {},
    appendChild(k) { this.children.push(k); return k; },
    append(...k) { this.children.push(...k); },
    setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    querySelector: () => null, querySelectorAll: () => [],
    closest: () => null, focus() {}, select() {}, click() {},
    remove() {},
  };
}

const PAGE_IDS = [
  "view", "drawer", "drawer-overlay", "drawer-playlists", "family-toggle",
  "player-toggle", "autoadvance-toggle", "menu-btn", "refresh-btn", "banner-slot",
  "pl-form", "pl-input", "pl-note", "tab-topics", "tab-shows", "sh-form",
  "sh-input", "sh-note", "sh-results", "browse-all-link",
];

function mount() {
  const store = new Map();
  const byId = new Map(PAGE_IDS.map((id) => {
    const el = makeEl("div");
    el.id = id;
    return [id, el];
  }));
  const body = makeEl("body");
  const ctx = {
    console: { ...console, warn() {}, error() {} },
    fetch: () => new Promise(() => {}),
    localStorage: {
      get length() { return store.size; },
      key: (i) => [...store.keys()][i] ?? null,
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); },
    },
    document: {
      body, documentElement: body, readyState: "complete",
      addEventListener() {}, createElement: (t) => makeEl(t),
      querySelector: (sel) => {
        const s = String(sel);
        return s.startsWith("#") ? byId.get(s.slice(1)) ?? null : null;
      },
      querySelectorAll: () => [],
    },
    navigator: { userAgent: "node" },
    addEventListener() {}, removeEventListener() {},
    location: { hash: "#/", search: "", pathname: "/", href: "https://x.test/" },
    history: { replaceState() {}, pushState() {} },
    CSS: { escape: (s) => String(s) },
    URL, URLSearchParams, Math, Date, JSON, Promise, clearTimeout,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
    encodeURIComponent, decodeURIComponent,
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SEARCH_SRC, ctx, { filename: "search-engine.js" });
  vm.runInContext(APP_SRC, ctx, { filename: "app.js" });
  /* The clock comes from the ES-module bridge, which this harness does not
     load. Stubbed so the meta line has a duration beside the credit — the
     separator between them is part of what these tests read. */
  ctx.ForayPlayer = { fmtSpan: (s) => `${Math.round(Number(s) || 0)}s` };
  const state = vm.runInContext("state", ctx);
  state.catalog = {
    shows: [
      { show_id: "being-an-engineer", title: "Being an Engineer", taxonomy_node_ids: [] },
      { show_id: "practical-ai", title: "Practical AI", taxonomy_node_ids: [] },
      { show_id: "the-bbq-central-show", title: "The BBQ Central Show", taxonomy_node_ids: [] },
    ],
  };
  return { ctx, state };
}

/** A hydrated tape beat, in the shape player/foray-resolve.js hands the row. */
const beat = (extra = {}) => ({
  type: "segment", ord: 3, position: 3, playable: true, queueIndex: 2,
  label: "ORI-1", segment_id: "seg-1", topic: "tech/engineering",
  show: "Being an Engineer", show_id: "being-an-engineer",
  source_id: "being-an-engineer--s7e17", episode_title: "S7E17",
  why: "The bit where the ladder stops being about skill.", duration_sec: 240,
  ...extra,
});

/** A hydrated narration beat. */
const narration = (script, extra = {}) => ({
  type: "narration", id: "act-1-introduction", ord: 4, position: 4,
  playable: true, queueIndex: 3, script, duration_sec: 40, cites: null, ...extra,
});

/** The text inside the play button, so a test can ask what is NOT in there. */
function insideButton(html) {
  const open = html.indexOf("<button");
  if (open < 0) return "";
  return html.slice(html.indexOf(">", open) + 1, html.indexOf("</button>", open));
}

/* ==================================================================== */
/* 1. EVERY BEAT REACHES ITS SHOW PAGE                                   */
/* ==================================================================== */

test("a beat whose source id names a catalogue show renders a real anchor to that show page", () => {
  /* THE FOUNDER'S FIRST ASK. The row already showed the show's NAME; what it
     did not do was let anyone go there, for any beat but the one playing.

     A real <a href>, deliberately, rather than a button wired through JS — the
     reasoning is written against `taxonomyChip`: right-click, long-press and
     open-in-new-tab are browser behaviours no click handler can fake.

     MUTATION: make forayCreditHtml always return the `<span class="fy-credit">`
     branch. The anchor assertion fails. MUTATION 2: drop the `<a>` in favour of
     a `<button data-show>` wired through a handler — the href assertion fails,
     and so does open-in-new-tab, which is the point. */
  const { ctx } = mount();
  const html = ctx.forayRow(beat());
  assert.ok(html.includes('href="#/show/being-an-engineer"'),
    `the row must link to the show page, got: ${html}`);
  assert.ok(/<a class="fy-credit show-link" href="#\/show\/being-an-engineer">Being an Engineer<\/a>/.test(html),
    `the show NAME must be the link text, got: ${html}`);
});

test("the identifier join is asked before the title join, and a stale title cannot break the link", () => {
  /* WHY THERE ARE TWO JOINS AND WHY THIS ORDER. On the committed data they
     nearly coincide — 76 source rows join by `--` prefix, 78 by title, the
     first set inside the second — so the reason to prefer the identifier is
     not reach — on today's data the identifier join adds no linkable row the
     title join would have missed. It is that a publisher can rename a show and
     cannot rename the id we harvested it under. This beat's title is the
     renamed one, which is the ONLY case in this suite that separates the two
     joins, and it is synthetic because the committed data does not contain one
     yet.

     MUTATION: delete the `entry.show_id && showById(...)` line from
     forayShowId. This is the only test in the repo that goes red for it —
     verified, not assumed: the coverage test over the real Forays stays green,
     because every show they draw on happens to join by title as well. */
  const { ctx } = mount();
  const html = ctx.forayRow(beat({ show: "Being an Engineer (re-branded 2026)" }));
  assert.ok(html.includes('href="#/show/being-an-engineer"'),
    `a reworded title must not cost the link, got: ${html}`);
  assert.ok(html.includes("Being an Engineer (re-branded 2026)"),
    "the row must still print the show's CURRENT name, not the catalogue's");
});

test("a beat with no usable source id still links when its title joins the catalogue", () => {
  /* The fallback, and it is not hypothetical: 22 of the 98 committed source
     rows are hand-curated ids with no `--` at all, and `The BBQ Central Show`
     is one whose title does join. Without this branch those rows lose a link
     they can have for free.
     MUTATION: `return null` instead of `showIdForShowName(entry.show)` in
     forayShowId. Red. */
  const { ctx } = mount();
  const html = ctx.forayRow(beat({
    show: "The BBQ Central Show", show_id: null, source_id: "bbq-central-brisket",
  }));
  assert.ok(html.includes('href="#/show/the-bbq-central-show"'),
    `the title join must still answer, got: ${html}`);
});

test("a beat whose show joins neither way degrades to exactly plain text, never a dead link", () => {
  /* THE RULE THAT PROTECTS THE LISTENER. 55 of the 131 committed tape beats
     are small independent shows that were never in the curated 220. A link for
     them would land on "Show not found." — strictly worse than the plain text
     the row has always shown.

     MUTATION: in forayShowId, `return entry.show_id` without the
     `showById(...)` check. `satay-okay` is not a catalogue show, an anchor
     appears, and this is red — which is exactly the dead link the check exists
     to prevent. */
  const { ctx } = mount();
  const html = ctx.forayRow(beat({
    show: "Satay? Okay!", show_id: "satay-okay", source_id: "satay-okay--e01",
  }));
  assert.ok(!html.includes("<a "), `an unjoinable show must not be a link, got: ${html}`);
  assert.ok(html.includes("Satay? Okay!"), "the show name must still be printed as plain text");
  assert.ok(html.includes("<span class=\"fy-credit\">Satay? Okay!</span>"),
    "plain text lives in the same slot the link would have, so the line does not move");
});

test("an unplayable row links its show too", () => {
  /* The founder said "anything in the foray", and a beat that could not be
     resolved is still a beat whose publisher a listener may want to find — it
     is the one they were promised and did not get.
     MUTATION: drop `${metaHtml}` from the `is-out` branch of forayRow (or
     restore the old `esc(meta)`). Red. */
  const { ctx } = mount();
  const html = ctx.forayRow(beat({ playable: false, queueIndex: null, reason: "no audio url" }));
  assert.ok(html.includes('class="fy-row is-out"'), "still the unplayable row");
  assert.ok(html.includes('href="#/show/being-an-engineer"'),
    `an unplayable beat must link its show, got: ${html}`);
  assert.ok(html.includes("Can't play: no audio url"), "and must still say why it cannot play");
});

test("the show link is a SIBLING of the play button, never inside it", () => {
  /* THE STRUCTURAL RULE, and the reason the credit line had to move at all.
     An interactive element inside a <button> is invalid HTML and its click
     never survives the parent's handler — the same rule that already put the
     thumbs outside the button. A link nested in there would navigate on some
     browsers, play the segment on others, and be untestable on all of them.

     MUTATION: put `<div class="fy-meta">` back inside `<button class="fy-jump">`
     where it used to live. The "not inside the button" assertion fails. */
  const { ctx } = mount();
  const html = ctx.forayRow(beat());
  assert.ok(!insideButton(html).includes("<a "),
    `the anchor must not be a descendant of the play button, got: ${insideButton(html)}`);
  assert.ok(html.indexOf('class="fy-meta"') < html.indexOf("<button"),
    "the credit line must precede the play button in the markup, as it reads on screen");
});

test("a show name carrying HTML-significant characters is escaped in both the link and the plain-text degrade", () => {
  /* The credit is now interpolated as HTML rather than as escaped text, which
     is exactly the shape that lets an unescaped field become an injection.
     MUTATION: drop either `esc()` around `entry.show` in forayCreditHtml. Red. */
  const { ctx } = mount();
  const nasty = `Quote" & <script>alert(1)</script>`;
  const plain = ctx.forayRow(beat({ show: nasty, show_id: null, source_id: "x" }));
  assert.ok(!plain.includes("<script>"), `unescaped show name reached the markup: ${plain}`);
  assert.ok(plain.includes("&lt;script&gt;"), "the show name must be escaped");
});

/* ==================================================================== */
/* 2. THE CURATION-CODE GUTTER IS GONE                                   */
/* ==================================================================== */

test("no row prints the curation code, and .fy-label is gone from the stylesheet", () => {
  /* THE FOUNDER'S SECOND ASK. `entry.label` is a curation code — `ORI-1`,
     `GRID-1`, `SATAY-1` — and on all four GENERATED Forays it is null, so the
     column was a permanently empty 52px gutter. It means nothing to a listener
     either way.

     The field is deliberately NOT deleted from the resolver or the data: it is
     curation provenance and player/segment-strip.js still reads it for the
     strip's own labels. It simply stops being rendered here.

     MUTATION: restore `<span class="fy-label">${esc(entry.label)}</span>` to
     either branch of forayRow. The "ORI-1" assertion fails. MUTATION 2: leave
     the `.fy-label` rules in styles.css. The stylesheet assertion fails. */
  const { ctx } = mount();
  for (const entry of [beat(), beat({ playable: false, queueIndex: null })]) {
    const html = ctx.forayRow(entry);
    assert.ok(!html.includes("ORI-1"), `the curation code is still rendered: ${html}`);
    assert.ok(!html.includes("fy-label"), `the gutter element is still rendered: ${html}`);
  }
  assert.ok(!/\.fy-label\b/.test(STYLES),
    "styles.css still carries a .fy-label rule for an element nothing renders");
  assert.ok(!/\.fy-label\b/.test(APP_SRC.slice(APP_SRC.indexOf("function forayRow"))),
    "app.js still references fy-label below forayRow");
});

test("the play button's accessible name is the show and the beat, not the curation code", () => {
  /* A screen reader used to hear "Play ORI-1, Origin Stories" — the producer's
     spreadsheet shorthand, read aloud. What distinguishes two rows for a
     listener is the show and the beat's own `why`, so that is what it says.

     MUTATION: put `${esc(entry.label)}` back into the aria-label. The "no
     ORI-1" assertion fails. MUTATION 2: make forayBeatName return only
     `entry.show` — the `why` assertion fails and two beats from the same show
     become indistinguishable by ear. */
  const { ctx } = mount();
  const html = ctx.forayRow(beat());
  const label = /aria-label="Play ([^"]*)"/.exec(html);
  assert.ok(label, `the play button must carry an aria-label, got: ${html}`);
  assert.ok(!label[1].includes("ORI-1"), `the accessible name still reads the code: ${label[1]}`);
  assert.ok(label[1].includes("Being an Engineer"), `must name the show: ${label[1]}`);
  assert.ok(label[1].includes("the ladder stops being about skill"), `must name the beat: ${label[1]}`);
});

test("the thumbs are named by the show too, so one beat is never called two things", () => {
  /* `thumbsHtml` had the same "More like ORI-1" problem, and it shares
     forayBeatName with the play button precisely so the two controls on one row
     cannot name that row differently.
     MUTATION: give thumbsHtml its own label expression using `entry.label`.
     Red here. */
  const { ctx } = mount();
  const html = ctx.forayRow(beat());
  assert.ok(html.includes('aria-label="More like Being an Engineer'),
    `the up-thumb must name the show, got: ${html}`);
  assert.ok(!/aria-label="(More|Less) like ORI-1/.test(html), "the thumbs still read the code");
});

/* ==================================================================== */
/* 3. THE NARRATION ROW: "AI NARRATOR" AND THE TRANSCRIPT                */
/* ==================================================================== */

test("a narration beat is credited AI Narrator in the slot a show credit occupies, and is not a link", () => {
  /* The founder asked for this "instead of the show name for that beat", in
     the same slot and the same visual weight, so the two row kinds read as
     siblings: one credits a podcast, one credits us.

     NOT a link, deliberately. There is no 4a show page to send anyone to, and
     a control that navigates nowhere is worse than a label — the same rule
     thumbsHtml keeps by not rendering thumbs with nowhere to land.

     MUTATION: drop the isForayNarration branch of forayCreditHtml so narration
     falls through. The credit disappears (a narration entry has no `show`) and
     the row reads as a bare duration again. MUTATION 2: wrap "AI Narrator" in
     an <a>. The "not a link" assertion fails. */
  const { ctx } = mount();
  const html = ctx.forayRow(narration("Short bridge."));
  assert.ok(html.includes('<span class="fy-credit is-narrator">AI Narrator</span>'),
    `the narration credit is missing, got: ${html}`);
  assert.ok(!html.includes("<a "), `AI Narrator must not be a link, got: ${html}`);
  assert.ok(html.indexOf("AI Narrator") < html.indexOf("<button"),
    "it must sit where a show credit sits — above the play row, not inside it");
});

test("a long transcript renders clamped with an expander wired to it by id; a short one renders whole", () => {
  /* "for long transcripts, by default have them collapsed to a standard-sized
     card with some 'show more' functionality, which then expands in place."

     The collapse is CSS on `.fy-script.is-clamped`, so the full text is always
     in the DOM: expanding is one class toggle, the card grows in place, the
     rows below move down, and a screen reader or find-in-page reaches the whole
     script while it is visually collapsed.

     MUTATION: drop the `is-clamped` class from the long branch — the long
     script renders at full height with a "Show more" button that does nothing
     visible. MUTATION 2: emit the button for every script — the short-script
     assertion fails and a 96-character bridge grows a control that reveals
     nothing. MUTATION 3: drop `aria-controls`/`aria-expanded` — red here. */
  const { ctx } = mount();
  const long = "x".repeat(400);
  const longHtml = ctx.forayRow(narration(long));
  assert.ok(longHtml.includes('class="fy-script is-clamped" id="fy-script-4"'),
    `the long transcript must render clamped, got: ${longHtml}`);
  assert.ok(longHtml.includes('aria-expanded="false" aria-controls="fy-script-4"'),
    `the expander must carry its state and its target, got: ${longHtml}`);
  assert.ok(longHtml.includes(">Show more</button>"), "and must say what it does");
  assert.ok(longHtml.includes(long), "the whole script is in the DOM, clamped by CSS only");

  const shortHtml = ctx.forayRow(narration("A ninety-six character bridge line that nobody needs to expand."));
  assert.ok(shortHtml.includes('class="fy-script"'), "a short transcript still renders");
  assert.ok(!shortHtml.includes("is-clamped"), "a short transcript must not be clamped");
  assert.ok(!shortHtml.includes("fy-script-more"), `a short transcript must grow no control, got: ${shortHtml}`);
});

test("the expander is a sibling of the play button, so reading a transcript cannot start playback", () => {
  /* Two reasons, and they are different. STRUCTURAL: a button inside a button
     is invalid HTML whose inner click never survives — the thumbs' rule again.
     BEHAVIOURAL: the transcript text is outside the play button too, so a drag
     to select a sentence, or a tap while reading, cannot start the audio. The
     play affordance stays the button, which keeps a floor height (`is-bare`)
     precisely because a narration beat has no `why` to fill it.

     MUTATION: nest the `.fy-script-wrap` inside `.fy-jump`. Both assertions
     fail. MUTATION 2: drop the `is-bare` class — the narration row's play
     button collapses to a zero-height strip with nothing to aim at. */
  const { ctx } = mount();
  const html = ctx.forayRow(narration("y".repeat(400)));
  const inner = insideButton(html);
  assert.ok(!inner.includes("fy-script"), `the transcript must be outside the play button, got: ${inner}`);
  assert.ok(!inner.includes("<button"), "and the expander with it");
  assert.ok(html.includes('class="fy-jump is-bare"'),
    `a narration row's play button needs its own floor height, got: ${html}`);
});

test("the clamp threshold falls in an empty band of the committed transcript lengths", () => {
  /* WHY THIS NUMBER AND NOT A ROUND ONE. Over the 157 scripted narration items
     in the four committed generated Forays the lengths cluster by authored mode
     — hinges at 95-134, short frames at 71-166, markers at 223-250, then long
     frames at 305-1057, patches at 358-627 and carries at 941-1332. Nothing at
     all sits between 250 and 305, so every threshold in that band partitions
     the committed data identically and the choice inside it is arbitrary BY
     CONSTRUCTION. The honest pick is therefore the band's midpoint, which is as
     far as it can be from the nearest real script on either side.

     This test asserts the band, not the constant: it finds the committed
     scripts immediately below and above the threshold and requires real
     clearance from both. So a later regeneration that fills the band fails
     here and forces the number to be re-derived, rather than the number
     silently drifting into the middle of a cluster.

     MUTATION: change NARRATION_CLAMP_CHARS to 200 or 300. Both land inside a
     populated range — 200 cuts through the markers, 300 through the long
     frames — the clearance assertion fails, and either would ship a "Show
     more" that reveals a line and a half. */
  const threshold = /const NARRATION_CLAMP_CHARS = (\d+);/.exec(APP_SRC);
  assert.ok(threshold, "NARRATION_CLAMP_CHARS is no longer a named constant in app.js");
  const n = Number(threshold[1]);
  const lengths = [];
  for (const f of readJson("data/forays.json").forays) {
    for (const it of f.items || []) {
      if (it.type === "segment") continue;
      if (typeof it.script === "string" && it.script.trim()) lengths.push(it.script.trim().length);
    }
  }
  assert.ok(lengths.length >= 157, `only ${lengths.length} scripted narration items; 157 when this landed`);
  const below = Math.max(...lengths.filter((l) => l <= n));
  const above = Math.min(...lengths.filter((l) => l > n));
  assert.ok(Number.isFinite(below) && Number.isFinite(above),
    "a threshold that collapses everything or nothing is not a threshold");
  /* The clearance is asserted, NOT the two specific lengths (250 and 305 when
     this landed). This suite is in `REAL_DATA_SUITES`, so it runs inside the
     publish gate: pinning the extremes would refuse a publish merely for
     adding a Foray whose longest marker is 240, which is not a defect. Pinning
     the CLEARANCE refuses one only when new scripts crowd the threshold — and
     then the number really is wrong, because a card would collapse to reveal
     almost nothing, and re-deriving it is the right thing to be stopped for. */
  assert.ok(n - below >= 20 && above - n >= 20,
    `the threshold ${n} sits ${n - below} above the nearest short script and ${above - n} below the ` +
    "nearest long one — put it in the middle of the empty band, not at the edge of a cluster");
});

/* ==================================================================== */
/* 4. CITATIONS (F-103) — VISIBLE WHEN PRESENT, SILENT WHEN NOT          */
/* ==================================================================== */

test("citations render as a sources list, with tape cites linking to the cited show's page", () => {
  /* F-103. The producer ships a tape cite as `{kind, segment_id}` only;
     player/foray-resolve.js turns it into show + episode title + show_id
     against the pools it already holds, so this renderer never does a lookup.
     A print cite links out when it has a URL and is plain text when it does
     not — the honest degrade, same as a show that does not join.

     MUTATION: drop the `showById(...)` guard in citesHtml so a cite's show_id
     is trusted unchecked — the unjoinable tape cite grows a dead link and the
     last assertion fails. MUTATION 2: drop `safeUrl` on the print cite's href;
     the javascript: assertion fails. */
  const { ctx } = mount();
  const html = ctx.forayRow(narration("Bridge.", {
    cites: [
      { kind: "tape", segment_id: "s1", show: "Practical AI", show_id: "practical-ai", episode_title: "Episode 300" },
      { kind: "tape", segment_id: "s2", show: "Satay? Okay!", show_id: "satay-okay", episode_title: "E01" },
      { kind: "print", publication: "Smithsonian Magazine", url: "https://example.test/a" },
      { kind: "print", publication: "Journal of Human Evolution", url: null },
      { kind: "print", publication: "Bad Actor Weekly", url: "javascript:alert(1)" },
    ],
  }));
  assert.ok(html.includes("<p class=\"fy-cites-head\">Sources</p>"), `no sources block, got: ${html}`);
  assert.ok(html.includes('<a class="show-link" href="#/show/practical-ai">Practical AI</a> — Episode 300'),
    `a tape cite must link the cited show, got: ${html}`);
  assert.ok(html.includes('<a class="show-link" href="https://example.test/a"'),
    "a print cite with a URL must link out");
  assert.ok(html.includes("<li>Journal of Human Evolution</li>"),
    "a print cite with no URL is plain text, not an empty link");
  assert.ok(!html.includes("javascript:"), `an unsafe citation URL reached an href: ${html}`);
  assert.ok(html.includes("<li>Satay? Okay! — E01</li>"),
    "a cite whose show does not join the catalogue degrades to plain text like any other credit");
});

test("a narration beat with no citations renders exactly as it does today — no heading, no empty list", () => {
  /* THE STATE OF EVERY COMMITTED FORAY. All eight predate the pipeline change,
     and by the producer's honesty rule a page the verifier did not confirm
     ships no `cites` at all rather than its unconfirmed sources presented as
     support. So silence must be indistinguishable from the app before this
     card — an empty "Sources" heading under forty narration beats would be the
     UI implying something it does not know.

     MUTATION: render the heading unconditionally in citesHtml (drop the
     `if (!cites.length) return ""`). Red for all three shapes below, and red
     on every row of every Foray on main. */
  const { ctx } = mount();
  for (const cites of [null, undefined, []]) {
    const html = ctx.forayRow(narration("Bridge.", { cites }));
    assert.ok(!html.includes("fy-cites"), `cites=${JSON.stringify(cites)} drew a block: ${html}`);
    assert.ok(!html.includes("Sources"), `cites=${JSON.stringify(cites)} drew a heading`);
  }
});

/* ==================================================================== */
/* 5. AGAINST THE COMMITTED DATA                                         */
/* ==================================================================== */

test("every tape beat of all four generated Forays links to a show page", async () => {
  /* THE COVERAGE CLAIM, measured rather than asserted in a comment, and the
     place the two joins are separated — because ON TODAY'S DATA THEY DO NOT
     SEPARATE THEMSELVES. Every generated Foray draws on Being an Engineer,
     Practical AI, Causality and Geology Bites, and those are four of the five
     shows whose titles ALSO match the catalogue, so either join alone would
     link all 48 beats and neither is load-bearing for the count. Asserting
     only the count would therefore have let the identifier join be deleted
     silently. So this asserts the identifier join answered for each beat as
     well, which is the claim that actually decays if it stops working.

     The hand-curated Forays are a different story and not a bug: their small
     independent shows were never in the curated 220, so they are floored
     rather than required to be whole.

     MEASURED, not assumed: deleting the identifier branch from forayShowId
     leaves THIS test green, because the title join answers identically for all
     four of these shows. That is a fact about the committed data, not a hole —
     the branch is guarded by "the identifier join is asked before the title
     join" above, which is red for exactly that mutation and is synthetic
     precisely because the real data cannot separate them yet. Said here so the
     next reader does not mistake this test for the one that covers it.

     MUTATION: `return null` from forayShowId — every count falls to zero.
     MUTATION 2: change showIdFromSourceId's separator to a single "-" — the
     derived ids stop being catalogue ids, `byIdentifier` collapses and the
     per-beat assertion fails (five suites go red together).
     MUTATION 3: drop the `showById(...)` verification so a candidate id is
     trusted unchecked — green here, red in the dead-link test above. */
  const { ctx, state } = mount();
  state.catalog = readJson("data/catalog.json");
  const resolve = await import("../player/foray-resolve.js");
  const segments = resolve.indexSegments(readJson("data/segments.json"));
  const sources = resolve.indexSources(readJson("data/segment-sources.json"));

  let generated = 0, generatedLinked = 0, byIdentifier = 0, curated = 0, curatedLinked = 0;
  for (const foray of readJson("data/forays.json").forays) {
    for (const entry of resolve.hydrateForayItems(foray, { segments, sources }).items) {
      if (entry.type !== "segment") continue;
      const linked = ctx.forayRow({ ...entry, playable: true, queueIndex: 0 }).includes('href="#/show/');
      /* THE SCALE-FREE INVARIANT, asserted on every beat of every Foray: a row
         links exactly when the join answers, and never otherwise. This is the
         assertion that cannot be broken by new data — only by a code
         regression — and it is why the counts below are floors rather than
         equalities. This suite is in `REAL_DATA_SUITES` and runs inside the
         publish gate; a publish that adds a Foray drawing on a show outside
         the curated 220 must NOT be refused, because plain text is the
         designed degrade, not a defect. */
      assert.equal(linked, ctx.forayShowId(entry) !== null,
        `${foray.id}/${entry.ord} (${entry.source_id}): rendered link=${linked} but the join says ` +
        `${ctx.forayShowId(entry)}`);
      if (!foray.generated) { curated++; if (linked) curatedLinked++; continue; }
      generated++;
      if (linked) generatedLinked++;
      if (entry.show_id && ctx.showById(entry.show_id)) byIdentifier++;
    }
  }
  assert.ok(generated >= 48, `only ${generated} generated tape beats; 48 when this landed`);
  assert.equal(generatedLinked, generated,
    `${generated - generatedLinked} generated-Foray beats lost their show link`);
  assert.ok(byIdentifier >= 48,
    `only ${byIdentifier} generated beats resolved a show by IDENTIFIER; 48 did when this landed`);
  assert.ok(curatedLinked >= 9,
    `only ${curatedLinked} of ${curated} hand-curated beats link; 9 did when this landed`);
});

test("no committed Foray renders a curation code or an empty gutter", async () => {
  /* The end-to-end proof, over every authored item on main (289 when this
     landed) rather than over fixtures — because "it renders exactly as it did,
     only without the gutter" is this card's acceptance condition.

     ONLY PERMANENT INVARIANTS ARE ASSERTED HERE, because this suite is in
     `REAL_DATA_SUITES` and runs inside the publish gate. "The gutter is never
     rendered" and "a curation code is never printed" stay true for any data a
     publish can write. "No row draws a Sources block" does NOT: the moment a
     generation run emits `cites`, drawing them is correct behaviour, and
     asserting their absence here would refuse that publish for doing the right
     thing. That degrade is proven against synthetic entries instead, in "a
     narration beat with no citations renders exactly as it does today" above
     and in `resolveCites`' own null cases.

     MUTATION: render `entry.label` anywhere in the row — `GRID-1` and
     `SATAY-1` are real labels in data/forays.json and appear here. MUTATION 2:
     restore the `.fy-label` span to either branch of forayRow. */
  const { ctx, state } = mount();
  state.catalog = readJson("data/catalog.json");
  const resolve = await import("../player/foray-resolve.js");
  const segments = resolve.indexSegments(readJson("data/segments.json"));
  const sources = resolve.indexSources(readJson("data/segment-sources.json"));

  let rows = 0, labelled = 0;
  for (const foray of readJson("data/forays.json").forays) {
    for (const entry of resolve.hydrateForayItems(foray, { segments, sources }).items) {
      rows++;
      if (entry.label) labelled++;
      const html = ctx.forayRow({ ...entry, playable: true, queueIndex: 0 });
      assert.ok(!html.includes("fy-label"), `${foray.id}/${entry.ord} still renders the gutter`);
      if (entry.label) {
        assert.ok(!html.includes(entry.label),
          `${foray.id}/${entry.ord} still prints its curation code ${entry.label}`);
      }
    }
  }
  assert.ok(rows >= 289, `only ${rows} authored items reached the renderer; 289 when this landed`);
  assert.ok(labelled > 0,
    "no committed item carries a label any more — this test can no longer prove the code is hidden");
});
