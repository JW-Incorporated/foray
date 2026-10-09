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
 *  5. A narration beat is credited by the narrator's one name (NARRATOR_NAME,
 *     p-foray-12) in the slot a show credit
 *     occupies, is never a link, and carries its transcript with a collapse
 *     that expands in place.
 *  6. Citations (F-103) render when an item carries them and are INVISIBLE when
 *     it does not — which is the state of all eight committed Forays.
 *
 * REWRITTEN ON PURPOSE (Redesign 2026, Tactile `foray`, BUILD-PLAN 2.17): the page's
 * clip rows are now row-wide play buttons (tap a row, start the Foray THERE), so a show
 * credit link can no longer sit on every row. The founder's ask ("navigate to the show's
 * page ... for anything in the foray") is answered by the page's "From" section, one row
 * per show the Foray draws on, each a link when the show has a page. Sections 1 and 3
 * below now read those rows; the rule they keep is the same one (a real anchor, the
 * identifier join first and the title join second, plain text when neither answers, the
 * link never inside the play button). Sections 2 and 4 are unchanged.
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
const { readAppSource, runAppSource } = require("./helpers/app-source.js");

const ROOT = path.join(__dirname, "..");
const APP_SRC = readAppSource();
/* The narrator's one name, read from the module that owns it (p-foray-12).
   Read as text because this CommonJS harness loads app.js, not the ES module;
   the bridge stub below hands it over the way player/client.js does. */
const NARRATOR = /export const NARRATOR_NAME = "([^"]+)";/.exec(
  fs.readFileSync(path.join(ROOT, "player/segment-strip.js"), "utf8"))[1];
const SEARCH_SRC = fs.readFileSync(path.join(ROOT, "search-engine.js"), "utf8");
const STYLES = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8");
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));

/* The Foray documents the real-data tests below walk: the live `data/` AND the
   frozen fixture (tools/foray/fixtures/frozen/, #236, 2026-09-22) — verbatim
   copies of real curated and generated Forays that never move. The live set is
   what the publish gate is about; the frozen set is what keeps every "at least
   one" below from going vacuous when a curator retires the last Foray of a
   kind. Until then these tests carried "289 when this landed", "157" and "48"
   as floors over live data, so deleting any Foray turned them red for a pure
   data edit. Each set resolves against its own pool. */
const FORAY_SETS = [
  { where: "data", dir: "data" },
  { where: "frozen", dir: "tools/foray/fixtures/frozen/data" },
].map(({ where, dir }) => ({
  where,
  forays: readJson(`${dir}/forays.json`).forays,
  segmentsDoc: readJson(`${dir}/segments.json`),
  sourcesDoc: readJson(`${dir}/segment-sources.json`),
}));

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
  runAppSource(APP_SRC, ctx);
  /* The clock comes from the ES-module bridge, which this harness does not
     load. Stubbed so the meta line has a duration beside the credit — the
     separator between them is part of what these tests read. */
  ctx.ForayPlayer = { fmtSpan: (s) => `${Math.round(Number(s) || 0)}s`, narratorName: NARRATOR };
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


/** The "From" rows the page builds for a list of beats, as html strings. */
function fromRows(ctx, entries) {
  const shows = ctx.forayDetailShows({ entries });
  const codes = ctx.forayStationCodes(shows);
  return shows.map((show) => ctx.forayFromRowHtml(show, codes));
}

/* ==================================================================== */
/* 1. EVERY SHOW REACHES ITS PAGE (the From section)                     */
/* ==================================================================== */

test("a show whose source id names a catalogue show gets a From row that is a real anchor to its page", () => {
  /* THE FOUNDER'S FIRST ASK. The row used to show the show's NAME; what it did not
     do was let anyone go there, for any beat but the one playing. Now the From
     section carries one row per show, and every clip of that show is reachable
     through it.

     A real <a href>, deliberately, rather than a button wired through JS: right-click,
     long-press and open-in-new-tab are browser behaviours no click handler can fake.

     MUTATION: make forayDetailShows always set `showId: null`. The anchor assertion
     fails. MUTATION 2: drop the `<a>` in favour of a `<button data-show>` wired through
     a handler: the href assertion fails, and so does open-in-new-tab, which is the point. */
  const { ctx } = mount();
  const [html] = fromRows(ctx, [beat()]);
  assert.ok(html.includes('href="#/show/being-an-engineer"'), `the From row must link to the show page, got: ${html}`);
  assert.ok(/<a class="row__link" href="#\/show\/being-an-engineer">Being an Engineer<\/a>/.test(html),
    `the show NAME must be the link text, got: ${html}`);
  assert.ok(html.includes("1 clip"), "and it says how many clips of the show the Foray plays");
});

test("the identifier join is asked before the title join, and a stale title cannot break the link", () => {
  /* WHY THERE ARE TWO JOINS AND WHY THIS ORDER. On the committed data they
     nearly coincide: 76 source rows join by `--` prefix, 78 by title, the
     first set inside the second. So the reason to prefer the identifier is
     not reach: on today's data the identifier join adds no linkable row the
     title join would have missed. It is that a publisher can rename a show and
     cannot rename the id we harvested it under. This beat's title is the
     renamed one, which is the ONLY case in this suite that separates the two
     joins, and it is synthetic because the committed data does not contain one
     yet.

     MUTATION: delete the `entry.show_id && showById(...)` line from
     forayShowId. This is the only test in the repo that goes red for it. */
  const { ctx } = mount();
  const [html] = fromRows(ctx, [beat({ show: "Being an Engineer (re-branded 2026)" })]);
  assert.ok(html.includes('href="#/show/being-an-engineer"'), `a reworded title must not cost the link, got: ${html}`);
  assert.ok(html.includes("Being an Engineer (re-branded 2026)"), "the row must still print the show's CURRENT name, not the catalogue's");
});

test("a show with no usable source id still links when its title joins the catalogue", () => {
  /* The fallback, and it is not hypothetical: 22 of the 98 committed source
     rows are hand-curated ids with no `--` at all, and `The BBQ Central Show`
     is one whose title does join. Without this branch those rows lose a link
     they can have for free.
     MUTATION: `return null` instead of `showIdForShowName(entry.show)` in
     forayShowId. Red. */
  const { ctx } = mount();
  const [html] = fromRows(ctx, [beat({ show: "The BBQ Central Show", show_id: null, source_id: "bbq-central-brisket" })]);
  assert.ok(html.includes('href="#/show/the-bbq-central-show"'), `the title join must still answer, got: ${html}`);
});

test("a show that joins neither way degrades to plain text, never a dead link", () => {
  /* THE RULE THAT PROTECTS THE LISTENER. 55 of the 131 committed tape beats
     are small independent shows that were never in the curated 220. A link for
     them would land on "Show not found." — strictly worse than plain text.

     MUTATION: in forayShowId, `return entry.show_id` without the
     `showById(...)` check. `satay-okay` is not a catalogue show, an anchor
     appears, and this is red — which is exactly the dead link the check exists
     to prevent. */
  const { ctx } = mount();
  const [html] = fromRows(ctx, [beat({ show: "Satay? Okay!", show_id: "satay-okay", source_id: "satay-okay--e01" })]);
  assert.ok(!html.includes("<a "), `an unjoinable show must not be a link, got: ${html}`);
  assert.ok(html.includes("Satay? Okay!"), "the show name must still be printed as plain text");
  /* `data-credit-show` (audit round 2, p-foray-2) is what lets the page relink it in
     place if the show index, loaded after paint, knows the show. */
  assert.ok(html.includes('data-credit-show="Satay? Okay!"'),
    "plain text carries the hook the late show-index join relinks through");
});

test("an unplayable clip still counts toward its show's From row, and says it cannot play in plain words", () => {
  /* The founder said "anything in the foray", and a beat that could not be
     resolved is still a beat whose publisher a listener may want to find: it
     is the one they were promised and did not get.
     MUTATION: skip unplayable entries in forayDetailShows -> the From row is
     gone for a show whose only clip will not play; red. */
  const { ctx } = mount();
  const gone = beat({ playable: false, queueIndex: null, reason: "no audio url" });
  const [from] = fromRows(ctx, [gone]);
  assert.ok(from.includes('href="#/show/being-an-engineer"'), `an unplayable beat must link its show, got: ${from}`);
  const html = ctx.forayRow(gone);
  assert.ok(html.includes('class="fdet-seg is-out"'), "still the unplayable row");
  /* It says so in the listener's words; the raw reason is kept on the row for
     a field report and never shown (audit 2026-09-22, persona row 62). */
  assert.ok(html.includes("This clip isn't available right now."), "and must still say it cannot play");
  assert.ok(html.includes('data-reason="no audio url"'), "with the raw reason kept off-screen");
  assert.ok(!html.includes("Can't play: no audio url"), "and never the raw reason as copy");
  assert.ok(!html.includes("<button"), "an unplayable row is not a button that does nothing");
});

test("no link sits inside a clip row's play button, and the row carries none at all", () => {
  /* THE STRUCTURAL RULE, and the reason the show link left the row. An interactive
     element inside a <button> is invalid HTML and its click never survives the
     parent's handler (the same rule that put the thumbs outside the button). A link
     nested in there would navigate on some browsers, play the clip on others, and
     be untestable on all of them. The row is the button; the link is the From row.

     MUTATION: put `${forayCreditHtml(entry)}` (an anchor) back inside the `.segrow`
     button in forayRow. Both assertions fail. */
  const { ctx } = mount();
  const html = ctx.forayRow(beat());
  assert.ok(html.includes("<button"), "fixture assumption: a playable row is a button");
  assert.ok(!insideButton(html).includes("<a "), `the anchor must not be a descendant of the play button, got: ${insideButton(html)}`);
  assert.ok(!html.includes("<a "), `the row itself carries no show link; the From section does: ${html}`);
});

test("a show name carrying HTML-significant characters is escaped in the From row, the clip row and the plain-text degrade", () => {
  /* The credit is interpolated as HTML rather than as escaped text, which is
     exactly the shape that lets an unescaped field become an injection.
     MUTATION: drop any `esc()` around the show name in forayFromRowHtml or forayRow. Red. */
  const { ctx } = mount();
  const nasty = `Quote" & <script>alert(1)</script>`;
  const entry = beat({ show: nasty, show_id: null, source_id: "x" });
  const [from] = fromRows(ctx, [entry]);
  const row = ctx.forayRow(entry);
  for (const html of [from, row]) {
    assert.ok(!html.includes("<script>"), `unescaped show name reached the markup: ${html}`);
    assert.ok(html.includes("&lt;script&gt;"), "the show name must be escaped");
  }
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

test("a narration beat is named by the narrator's one name in the row's title slot, and is not a link", () => {
  /* The founder asked for this "instead of the show name for that beat", in
     the same slot and the same visual weight, so the two row kinds read as
     siblings: one credits a podcast, one credits us.

     NOT a link, deliberately. There is no 4a show page to send anyone to, and
     a control that navigates nowhere is worse than a label.

     MUTATION: drop the isForayNarration branch of `name` in forayRow so narration
     falls through to `entry.show` (a narration entry has none: the row reads "This
     clip"). MUTATION 2: wrap the name in an <a>. The "not a link" assertion fails. */
  const { ctx } = mount();
  const html = ctx.forayRow(narration("Short bridge."));
  const name = `<span class="row__title">${NARRATOR.replace("'", "&#39;")}</span>`;
  assert.ok(html.includes(name), `the narration name is missing, got: ${html}`);
  assert.ok(!html.includes("<a "), `the narrator name must not be a link, got: ${html}`);
  assert.ok(html.includes("fdet-sw--narration"), "and its swatch is the hatched narration enamel, not a show's");
});

test("the narrator has ONE name on the row, in the accessible name, and in the player's own strip (p-foray-12)", () => {
  /* The page said "AI Narrator" on the row, "4a's AI Narrator" to a screen
     reader and "4a's narrator" in the header and the strip. MUTATION (killed):
     put the literal "narration by 4a's AI Narrator" back in forayBeatName —
     the accessible-name assertion is red. MUTATION 2 (killed): put "AI
     Narrator" back in forayCreditHtml — the row assertion is red. */
  assert.equal(NARRATOR, "4a's AI narrator", "keeps the AI disclosure");
  const { ctx } = mount();
  assert.equal(ctx.forayBeatName(narration("Short bridge.")), `narration by ${NARRATOR}`);
  const html = ctx.forayRow(narration("Short bridge."));
  assert.ok(!/AI Narrator/.test(html), `no second spelling on the row: ${html}`);
  const strip = fs.readFileSync(path.join(ROOT, "player/segment-strip.js"), "utf8");
  assert.ok(!/4a's narrator/.test(strip), "the strip speaks the constant, not a literal of its own");
});

test("the episode a clip came from is named on its row when the row has no why-line, and in the sources block always (p-foray-5)", () => {
  /* The episode lived only in the credits block at the foot of the page, so a
     caption leaning on it had nothing on the row. The Dial row has two lines, a
     show name and a why-line, so the episode takes the second line only where
     there is no why-line; the "Where this came from" block names every episode
     with its clip count either way.
     MUTATION (killed): drop `entry.episode_title` from the `sub` expression in
     forayRow -> the bare row loses its episode; red. */
  const { ctx } = mount();
  const withWhy = ctx.forayRow(beat());
  assert.ok(withWhy.includes("The bit where the ladder stops being about skill."), "a row with a why-line shows it");
  assert.ok(!withWhy.includes("S7E17"), "and not the episode beside it: two lines, one sub");
  const bare = ctx.forayRow(beat({ why: "" }));
  assert.match(bare, /<span class="label fdet-seg__sub">S7E17<\/span>/, `a bare row names its episode: ${bare}`);
  assert.ok(!insideButton(withWhy).includes("<a "), "and never as a link inside the button");
  const nar = ctx.forayRow(narration("Short bridge.", { episode_title: "never shown" }));
  assert.ok(!nar.includes("never shown"), "a narration beat has no episode");
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
     is invalid HTML whose inner click never survives (the thumbs' rule again).
     BEHAVIOURAL: the transcript text is outside the play button too, so a drag
     to select a sentence, or a tap while reading, cannot start the audio. The
     play affordance stays the button, a 56px row whether or not the beat has a
     why-line to fill it.

     MUTATION: nest the `.fy-script-wrap` inside `.segrow`. Both assertions
     fail. MUTATION 2: drop `segrow--narration` -> the narration row loses the
     hook its swatch and transcript indent hang on; red. */
  const { ctx } = mount();
  const html = ctx.forayRow(narration("y".repeat(400)));
  const inner = insideButton(html);
  assert.ok(!inner.includes("fy-script"), `the transcript must be outside the play button, got: ${inner}`);
  assert.ok(!inner.includes("<button"), "and the expander with it");
  assert.ok(html.includes('class="segrow segrow--narration"'),
    `a narration row's play button is the Dial row, flagged as narration, got: ${html}`);
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
  for (const set of FORAY_SETS) {
    for (const f of set.forays) {
      for (const it of f.items || []) {
        if (it.type === "segment") continue;
        if (typeof it.script === "string" && it.script.trim()) lengths.push(it.script.trim().length);
      }
    }
  }
  /* Was `>= 157` ("157 when this landed") over data/ alone — a floor that a
     curator retiring one generated Foray would trip. The frozen set carries a
     generated Foray, so there is always something on both sides to measure;
     the band is still asserted against every live script as well. */
  assert.ok(lengths.length > 0, "no scripted narration item anywhere, so the band proves nothing");
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

test("every show of every generated Foray gets a From row that links to its page", async () => {
  /* THE COVERAGE CLAIM, measured rather than asserted in a comment, and the
     place the two joins are separated: ON TODAY'S DATA THEY DO NOT SEPARATE
     THEMSELVES. Every generated Foray draws on Being an Engineer, Practical AI,
     Causality and Geology Bites, and those are four of the five shows whose titles
     ALSO match the catalogue, so either join alone would link them all. So this
     asserts the identifier join answered for each show as well, which is the claim
     that actually decays if it stops working.

     The hand-curated Forays are a different story and not a bug: their small
     independent shows were never in the curated 220, so they are floored rather than
     required to be whole.

     MEASURED, not assumed: deleting the identifier branch from forayShowId leaves
     THIS test green, because the title join answers identically for these shows. That
     is a fact about the committed data, not a hole: the branch is guarded by "the
     identifier join is asked before the title join" above, which is synthetic
     precisely because the real data cannot separate them yet.

     MUTATION: `return null` from forayShowId: every count falls to zero.
     MUTATION 2: change showIdFromSourceId's separator to a single "-": the derived ids
     stop being catalogue ids, `byIdentifier` collapses and the per-show assertion fails.
     MUTATION 3: drop the `showById(...)` verification so a candidate id is trusted
     unchecked: green here, red in the dead-link test above. */
  const { ctx, state } = mount();
  state.catalog = readJson("data/catalog.json");
  const resolve = await import("../player/foray-resolve.js");
  let generated = 0, generatedLinked = 0, byIdentifier = 0, curated = 0, curatedLinked = 0;
  for (const set of FORAY_SETS) {
    const segments = resolve.indexSegments(set.segmentsDoc);
    const sources = resolve.indexSources(set.sourcesDoc);
    for (const foray of set.forays) {
      const entries = resolve.hydrateForayItems(foray, { segments, sources }).items
        .map((e) => ({ ...e, playable: true, queueIndex: 0 }));
      const shows = ctx.forayDetailShows({ entries });
      const codes = ctx.forayStationCodes(shows);
      for (const show of shows) {
        const linked = ctx.forayFromRowHtml(show, codes).includes('href="#/show/');
        /* THE SCALE-FREE INVARIANT, asserted on every show of every Foray: a row links
           exactly when the join answers, and never otherwise. It cannot be broken by new
           data, only by a code regression, which is why the counts below are floors. This
           suite runs inside the publish gate; a publish that adds a Foray drawing on a
           show outside the curated 220 must NOT be refused, because plain text is the
           designed degrade, not a defect. */
        assert.equal(linked, show.showId !== null, `${set.where}:${foray.id} (${show.name}): rendered link=${linked} but the join says ${show.showId}`);
        if (!foray.generated) { curated++; if (linked) curatedLinked++; continue; }
        generated++;
        if (linked) generatedLinked++;
        const entry = entries.find((e) => e.show === show.name);
        if (entry && entry.show_id && ctx.showById(entry.show_id)) byIdentifier++;
      }
    }
  }
  assert.ok(generated > 0, "no show of a generated Foray anywhere, so this proved nothing");
  assert.equal(generatedLinked, generated, `${generated - generatedLinked} generated-Foray shows lost their link`);
  assert.ok(byIdentifier > 0, `none of ${generated} generated shows resolved by IDENTIFIER, the join this test exists to watch`);
  assert.ok(curatedLinked > 0, `none of ${curated} hand-curated shows link: the title join has stopped answering for the curated shows`);
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

  let rows = 0, labelled = 0, authored = 0;
  for (const set of FORAY_SETS) {
    const segments = resolve.indexSegments(set.segmentsDoc);
    const sources = resolve.indexSources(set.sourcesDoc);
    for (const foray of set.forays) {
      authored += (foray.items || []).length;
      for (const entry of resolve.hydrateForayItems(foray, { segments, sources }).items) {
        rows++;
        if (entry.label) labelled++;
        const html = ctx.forayRow({ ...entry, playable: true, queueIndex: 0 });
        assert.ok(!html.includes("fy-label"), `${set.where}:${foray.id}/${entry.ord} still renders the gutter`);
        if (entry.label) {
          assert.ok(!html.includes(entry.label),
            `${set.where}:${foray.id}/${entry.ord} still prints its curation code ${entry.label}`);
        }
      }
    }
  }
  /* Was `rows >= 289` ("289 when this landed") — a floor any retired Foray
     tripped (#236). Every authored item reaching the renderer is the claim, so
     that is what is asserted: exactly, and from the documents themselves. */
  assert.ok(rows > 0, "no authored item reached the renderer, so this proved nothing");
  assert.equal(rows, authored, `${authored - rows} authored item(s) never reached the renderer`);
  assert.ok(labelled > 0,
    "no committed item carries a label any more — this test can no longer prove the code is hidden");
});
