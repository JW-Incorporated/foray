/* Visual pass 1 (2026-09-23): the card, row, pill, tag and artwork anatomy the
 * founder-approved visual changes converge on (docs/audit/status.tsv qa rows
 * 43/54/59/78, persona 40), pinned so the next restyle cannot quietly undo
 * them one selector at a time.
 *
 *   1. NO <button> INSIDE AN <a>. Three cards did it (qa row 78): Jump back in,
 *      the subject cards, the Continue banner. The two that are rendered are
 *      now positioned cards whose title is the one real link, stretched over
 *      the card by its ::after, with the control a SIBLING lifted above it.
 *      (The banner had no caller since the U-11 cutover and was deleted with
 *      its CSS in the review of this pass — a test on unreachable markup reads
 *      as coverage and is not.) The HTML the renderers emit is walked tag by
 *      tag here — a source grep for "<a" could not tell nesting from adjacency.
 *   2. THE EPISODE ROW HAS TWO TIERS (persona 40): the text block owns the
 *      first line, the controls wrap under it.
 *   3. ONE PILL (qa row 54): Create's suggestions and Search's browse subjects
 *      are both `.fy-chip`; `.cr-pill` has no rule and no user.
 *   4. ONE ARTWORK TREATMENT (qa row 59): the show page, the episode page and
 *      Now Playing share one radius/border/shadow rule.
 *   5. ONE TAG SHAPE, ONE TINT: Home's tags, Search's "Generated for you"
 *      badge and both kickers (the Forays index's "foray", "Jump back in")
 *      share the box and an 18% mix of their own colour.
 *   6. ROWS ARE `--radius-lg` (the review of this pass): any card on
 *      `--surface` with row-sized padding reads the row radius, so a clip row
 *      cannot sit at 12px beside an episode row at 16px.
 *   7. THE RHYTHM between an intro paragraph and the first card is a section
 *      (20px), not the row gap.
 *   8. WHAT A ROW, A CARD AND A PAGE HEAD CARRY (audit round 2): a number only
 *      where order is the content (visual-10), a tag only where its section
 *      does not already say it (visual-9), one name per Interests block
 *      (visual-17), the credits ↗ as a right-hand column (visual-7), no ‹ on a
 *      tab's root (visual-6), an eyebrow on every search tier (visual-16), a
 *      two-line show row with its full name in `title=` (search-11), one
 *      silhouette on the Up Next row (visual-11).
 *
 * Every test names its killing mutation.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { readAppSource, runAppSource } = require("./helpers/app-source.js");

const ROOT = path.join(__dirname, "..");
const APP_SRC = readAppSource().replace(/\r\n/g, "\n");
const CSS = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8").replace(/\r\n/g, "\n");
const TODAY_CSS = fs.readFileSync(path.join(ROOT, "ui/today.css"), "utf8").replace(/\r\n/g, "\n").replace(/\/\*[\s\S]*?\*\//g, " ");

/* ---------- a minimal app.js loader (the jump-back-in-kinds shape) ---------- */
function loadApp() {
  const noop = () => {};
  function makeEl() {
    return {
      addEventListener: noop, removeEventListener: noop, appendChild: noop,
      setAttribute: noop, removeAttribute: noop,
      classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
      style: {}, dataset: {}, children: [], hidden: false,
      innerHTML: "", textContent: "", className: "",
      querySelector: () => makeEl(), querySelectorAll: () => [],
    };
  }
  const store = new Map();
  const ctx = {
    console,
    fetch: () => new Promise(() => {}),
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    document: {
      body: makeEl(), documentElement: makeEl(),
      addEventListener: noop, createElement: makeEl,
      querySelector: () => makeEl(), querySelectorAll: () => [],
    },
    navigator: { userAgent: "node" },
    location: { hash: "#/", href: "https://example.test/" },
    history: { replaceState: noop, pushState: noop },
    CSS: { escape: (s) => String(s) },
    URL, Math, Date, JSON, Promise, setTimeout, clearTimeout,
    crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000000" },
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  ctx.ForayPlayer = { forayResumeList: () => [], lastEpisodeCard: () => null };
  vm.createContext(ctx);
  process.on("unhandledRejection", noop);
  runAppSource(APP_SRC, ctx);
  return (code) => vm.runInContext(code, ctx);
}

/** Walk the tags of an HTML fragment and return every <button> that opens
    while an <a> is still open — the nesting the HTML spec forbids and a
    screen reader flattens into one control. */
function buttonsInsideAnchors(html) {
  const bad = [];
  let anchorDepth = 0;
  for (const m of html.matchAll(/<(\/?)(a|button)\b[^>]*>/g)) {
    const [, close, tag] = m;
    if (tag === "a") anchorDepth += close ? -1 : 1;
    else if (!close && anchorDepth > 0) bad.push(m[0]);
  }
  return bad;
}

/** The last value `prop` gets on exactly `sel` (comments stripped, unconditional rules). */
const SRC = CSS.replace(/\/\*[\s\S]*?\*\//g, " ");
/** Top-level comma split (a comma inside :is()/:where() is not a list separator). */
function splitSelectors(prelude) {
  const out = []; let depth = 0; let cur = "";
  for (const ch of prelude) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim().replace(/\s+/g, " ")); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim().replace(/\s+/g, " "));
  return out;
}
/** Does `sel` name this rule: one of its selectors, or its whole list as written? */
function names(prelude, sel) {
  const list = splitSelectors(prelude);
  return list.includes(sel) || list.join(", ") === sel;
}
function valueOf(sel, prop) {
  let v = null;
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(SRC))) {
    if (!names(m[1], sel)) continue;
    for (const d of m[2].split(";")) {
      const c = d.indexOf(":");
      if (c < 0) continue;
      if (d.slice(0, c).trim() === prop) v = d.slice(c + 1).trim();
    }
  }
  return v;
}
/** The last value `prop` gets on exactly `sel` in ui/today.css (Today, Redesign 2026). */
function todayValueOf(sel, prop) {
  let v = null;
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(TODAY_CSS))) {
    if (!names(m[1], sel)) continue;
    for (const d of m[2].split(";")) {
      const c = d.indexOf(":");
      if (c >= 0 && d.slice(0, c).trim() === prop) v = d.slice(c + 1).trim();
    }
  }
  return v;
}
function hasRule(sel) {
  const re = /([^{}]+)\{/g;
  let m;
  while ((m = re.exec(SRC))) {
    if (names(m[1], sel)) return true;
  }
  return false;
}

const SLOT = {
  branch: "science", role: "core",
  item: { id: "e1", title: "An episode", show: "A Show", artwork_url: "https://cdn.test/a.png", duration_min: 30 },
  items: [{ id: "e1", title: "An episode", show: "A Show", duration_min: 30 }],
};
const JBI = {
  kind: "episode", id: "e1", at: null, title: "Dennis Whyte: Nuclear Fusion", sub: "Lex Fridman Podcast",
  percent: 25, left: "90 min left",
  item: { id: "e1", title: "Dennis Whyte: Nuclear Fusion", show: "Lex Fridman Podcast", audio_url: "https://cdn.test/a.mp3" },
};

/* ==================================================================== */
/* 1. no <button> inside an <a>                                          */
/* ==================================================================== */

test("a Today row is a card: the title is the one link, Play is a sibling above it (and so on the Stretch card)", () => {
  /* Overturns "Card/row anatomy" for Home (Redesign 2026): the subject card and the Jump back in card
     are gone; the EpisodeRow and the StretchCard carry the same rule that visual pass 1 set.
     MUTATION: wrap the whole row in `<a class="td-row" …>` in todayEpisodeRow -> the Play button is
     inside an anchor again and the first assertion names it. MUTATION 2: delete the `.ag .td-link::after`
     rule from ui/today.css, or the row's z-index 2 on its button -> the link no longer stretches / Play
     sits under it. */
  const run = loadApp();
  const item = { id: "e1", title: "An episode", show: "A Show", artwork_url: "https://cdn.test/a.png", duration_min: 30, audio_url: "https://cdn.test/a.mp3", hook: "Why it matters." };
  const html = run(`todayEpisodeRow(${JSON.stringify({ item, branch: "science" })})`);
  assert.deepStrictEqual(buttonsInsideAnchors(html), [], "a <button> opened inside an <a>");
  assert.match(html, /^<article class="raised td-row is-default" data-td-ep="e1" data-branch="science">/, "the row is an <article>");
  assert.match(html, /<h3 class="t-headline clamp2 td-row-title"><a class="td-link" href="#\/episode\/e1" data-ev="picked" data-ep="e1" data-ctx="today">An episode<\/a><\/h3>/,
    "the title is the one real link, and it carries the `picked` logging attributes bindPickLogging binds");
  assert.match(html, /<button type="button" class="ag-btn ag-btn-play ag-btn-size-44" data-td-play="e1"/, "Play is a sibling of the title, after it");
  assert.strictEqual(todayValueOf(".ag .td-row", "position"), "relative", "the row is the link's containing block");
  assert.strictEqual(todayValueOf(".ag .td-link::after", "inset"), "0", "the link stretches over the row");
  assert.strictEqual(todayValueOf(".ag .td-row > .ag-btn", "z-index"), "2", "Play sits above the stretched link");
  /* The Stretch card is the same shape, with its bridge line inside it. */
  const stretch = run(`todayStretchCard(${JSON.stringify({ item, branch: "science", familiar: { name: "Home Show", src: null } })})`);
  assert.deepStrictEqual(buttonsInsideAnchors(stretch), [], "a <button> opened inside an <a> on the Stretch card");
  assert.match(stretch, /^<article class="raised ag-stretch-card td-stretch is-default"/);
  assert.match(stretch, /<p class="t-why td-bridge">[^<]+<\/p>/, "the bridge line is inside the card");
  assert.strictEqual(todayValueOf(".ag .td-stretch .ag-card-end .ag-btn", "z-index"), "2", "and its Play is above the link too");
});

test("the Keep listening row is a card too: a foray or a playlist resumes from a sibling Play above the title link", () => {
  /* MUTATION: `<a class="raised td-row" …>` around the keep row in todayKeepHtml -> red. */
  const run = loadApp();
  const html = run(`(() => { const t = homePlayable; homePlayable = () => ({ kind: "foray", r: { id: "f1", playable: [] }, title: "F" }); try { return todayKeepHtml({ kind: "foray", id: "f1", title: "A foray", percent: 40, sub: "Foray", left: "30 min left" }); } finally { homePlayable = t; } })()`);
  assert.deepStrictEqual(buttonsInsideAnchors(html), [], "a <button> opened inside an <a>");
  assert.match(html, /<h3 class="t-headline clamp2 td-row-title"><a class="td-link" href="#\/foray\/f1">A foray<\/a><\/h3>/);
  assert.match(html, /<button type="button" class="ag-btn ag-btn-play ag-btn-size-44" data-td-keep/, "Play resumes through Home's own start path");
});

test("the Continue banner is gone: no renderer, no rule, no test on unreachable markup", () => {
  /* The third card of qa row 78. `bannerHtml()` had no caller since the U-11
     cutover (renderHome always renders Home v2), so the stretched-link rework
     of it and the two tests that pinned it guarded markup no listener could
     reach — a real regression in that template could never surface, while
     the floor read as coverage. Deleted with `.banner` / `#banner-slot`.
     MUTATION: restore `function bannerHtml()` (or a `.banner {` rule) -> red. */
  assert.doesNotMatch(APP_SRC, /function bannerHtml\(|function currentContinue\(/, "the dead renderer stays deleted");
  assert.doesNotMatch(APP_SRC, /class="banner"|id="banner-slot"/, "no markup emits the banner");
  assert.ok(!hasRule(".banner") && !hasRule("#banner-slot:empty"), "and its rules went with it");
});

/** Every template literal in `src` as one flat string: the text of the
    template plus, in place, the text of every template nested inside its
    `${…}` holes (`${cond ? `<img …>` : ""}`). A regex over backticks cannot do
    this — it pairs the outer template's opening tick with the NESTED
    template's opening tick and walks the pieces out of order, which is how the
    first version of the test below stayed green on the pre-fix app.js. */
function templateLiterals(src) {
  const out = [];
  const n = src.length;
  let i = 0;
  const skipComment = () => {
    if (src.startsWith("//", i)) { while (i < n && src[i] !== "\n") i++; return true; }
    if (src.startsWith("/*", i)) { i = src.indexOf("*/", i + 2); i = i < 0 ? n : i + 2; return true; }
    return false;
  };
  const skipString = (q) => { i++; while (i < n && src[i] !== q) { if (src[i] === "\\") i++; i++; } i++; };
  /* Reads one template starting at the opening backtick; returns its flat text. */
  const readTemplate = () => {
    let text = "";
    i++; // the opening `
    while (i < n && src[i] !== "`") {
      if (src[i] === "\\") { text += src[i] + (src[i + 1] || ""); i += 2; continue; }
      if (src.startsWith("${", i)) {
        i += 2;
        let depth = 1;
        while (i < n && depth > 0) {
          if (skipComment()) continue;
          const ch = src[i];
          if (ch === "'" || ch === '"') { skipString(ch); continue; }
          if (ch === "`") { text += readTemplate(); continue; }
          if (ch === "{") depth++;
          if (ch === "}") depth--;
          i++;
        }
        continue;
      }
      text += src[i++];
    }
    i++; // the closing `
    return text;
  };
  while (i < n) {
    if (skipComment()) continue;
    const ch = src[i];
    if (ch === "'" || ch === '"') { skipString(ch); continue; }
    if (ch === "`") { out.push(readTemplate()); continue; }
    i++;
  }
  return out;
}

test("no template literal in app.js nests a <button> inside an <a>, nested templates included", () => {
  /* The general rule behind the qa-78 fixes, as a source scan: every template
     literal is flattened (nested templates in `${…}` holes spliced in place)
     and walked tag by tag. Cross-template nesting (an <a> opened in one
     function, a button injected by another through `${starBtn(id)}`) is what
     the two render tests above catch; this one catches a LITERAL nesting in
     any template, rendered or not.
     MUTATION (run, red): `<a class="hv2-jbi-card">…${play}…</a>` with the play
     button written out as `<button class="play-btn">` inside it; or run this
     walker over `git show 30ecc0f~1:app.js`, where the banner's
     `<a class="banner" …><button class="b-done">` is nested behind a nested
     `<img>` template — the backtick regex this test used to use reported 0. */
  const bad = [];
  for (const t of templateLiterals(APP_SRC)) {
    if (!/<a\b/.test(t) || !/<button\b/.test(t)) continue;
    const hits = buttonsInsideAnchors(t);
    if (hits.length) bad.push(`${t.trim().split("\n")[0].slice(0, 80)} … ${hits[0]}`);
  }
  assert.deepStrictEqual(bad, [], "templates with a <button> inside an <a>:\n" + bad.join("\n"));
  /* The walker itself, on the shape that defeated the regex. */
  const sample = "const x = `<a class=\"c\">${art ? `<img src=\"${u}\">` : \"\"}<button class=\"b\">x</button></a>`; // `not a template`";
  const flat = templateLiterals(sample);
  assert.strictEqual(flat.length, 1, "the nested template is part of the outer one, not a second literal");
  assert.deepStrictEqual(buttonsInsideAnchors(flat[0]), ['<button class="b">'], "and the nesting behind it is seen");
});

/* ==================================================================== */
/* 2. the episode row's two tiers (persona 40)                           */
/* ==================================================================== */

test("an episode row wraps its controls under the title instead of squeezing the title to ~114px", () => {
  /* MUTATION: delete `.ep-row { flex-wrap: wrap; … }` -> the number, the
     text block, ▶, ☆ and "+ Up Next" share one line again. */
  assert.strictEqual(valueOf(".ep-row", "flex-wrap"), "wrap");
  assert.strictEqual(valueOf(".ep-row > .info", "flex"), "1 1 100%", "the text block takes the whole first line");
  /* Where a number leads the row (a playlist, Up Next — round 2, visual-10),
     the text block gives it its width and the second tier indents to match. */
  assert.match(valueOf(".ep-row > .q-num + .info", "flex-basis") || "", /^calc\(100% - \d+px\)$/, "…minus the number, when there is one");
  assert.match(valueOf(".ep-row > .q-num + .info + :is(.play-btn, button.star, button.up-next, .not-playable)", "margin-left") || "", /^\d+px$/,
    "the first control on the second line aligns under the title, not under the number");
  assert.ok(!hasRule(".ep-row > .info + :is(.play-btn, button.star, button.up-next, .not-playable)"),
    "and an un-numbered row does not indent its controls under a number that is not there");
  /* A playlist row is a one-line link row and must NOT wrap. */
  assert.notStrictEqual(valueOf(".pl-row", "flex-wrap"), "wrap");
  /* The row title is the display face at the title step, like every card. */
  assert.strictEqual(valueOf(".ep-row .t, .pl-row .t", "font-family"), "var(--font-display)");
  assert.strictEqual(valueOf(".ep-row .t, .pl-row .t", "font-size"), "var(--fs-lg)");
});

/* ==================================================================== */
/* 2b. audit round 2: what a row, a card and a page head carry          */
/* ==================================================================== */

const ITEM = { id: "show-x--ep-1", title: "An episode", show: "A Show", duration_min: 30, audio_url: "https://cdn.test/a.mp3" };

test("only a list whose order is the point is numbered: a playlist, not Saved, History, a show or search", () => {
  /* Round 2, visual-10: every epRow printed a numbered circle, so a Saved list
     read as a playlist the listener never built and a show's episodes counted
     the newest as "1". MUTATION: make `orderedRowCtx` return true -> red on
     every unordered context; return false -> red on the playlist. */
  const run = loadApp();
  for (const ctx of ["library-saved", "library-history", "show-x", "search", "episode-more", undefined]) {
    const html = run(`epRow(${JSON.stringify(ITEM)}, 2, ${JSON.stringify(ctx ?? null)}, -1)`);
    assert.doesNotMatch(html, /class="q-num/, `${ctx}: no number`);
    const gone = run(`archivedRow(${JSON.stringify(ITEM)}, 2, ${JSON.stringify(ctx ?? null)})`);
    assert.doesNotMatch(gone, /class="q-num/, `${ctx}: an archived row carries none either`);
  }
  for (const ctx of ["playlist-p1", "subject-science", "generated-g1"]) {
    const html = run(`epRow(${JSON.stringify(ITEM)}, 2, ${JSON.stringify(ctx)}, 2)`);
    assert.match(html, /<span class="q-num next">3<\/span>/, `${ctx}: numbered, and "start here" still marks the next part`);
    assert.match(run(`archivedRow(${JSON.stringify(ITEM)}, 4, ${JSON.stringify(ctx)})`), /<span class="q-num">5<\/span>/,
      `${ctx}: an archived part keeps its number, so the count above stays true`);
  }
  /* RULING THAT FELL (Redesign 2026, ambient; card anatomy, the Up Next page unit): "Up Next is a queue: its own row
     always numbers" is gone. The page's row is Library's QueueRow (art, title, caption, handle, menu); the order is the
     order on screen and a move says its new place aloud ("Moved to position 2 of 5."). MUTATION: put a `q-num` span
     back into libQueueRowHtml -> red. */
  const rowAt = APP_SRC.indexOf("function libQueueRowHtml(");
  assert.ok(rowAt >= 0, "the QueueRow is where this test looks for it");
  assert.doesNotMatch(APP_SRC.slice(rowAt, APP_SRC.indexOf("\n}\n", rowAt)), /q-num/, "the QueueRow carries no number");
  assert.doesNotMatch(APP_SRC, /function upNextRow/, "the page has no row of its own");
  /* The Library's unnamed-history fallback row carries none. */
  assert.doesNotMatch(APP_SRC, /<div class="ep-row gone"><span class="q-num">/, "the History fallback row is not numbered");
});

test("a tag says what its section does not: no FORAY under 'Forays'", () => {
  /* Round 2, visual-9 (the Jump back in half of this test went with the rail, 2026-10-07: Today's
     Keep listening row restates nothing, and its section head is its only label).
     MUTATION: drop `{ inSection: true }` from renderForays' forayListHtml call -> red. */
  const run = loadApp();
  assert.match(APP_SRC, /\? forayListHtml\(\{ inSection: true \}\)/, "the Forays page's list sits under its 'Forays' heading");
  const pub = { id: "f1", title: "A Foray", status: "published" };
  const draft = { id: "f2", title: "A draft", status: "draft" };
  run(`forayCards = () => ${JSON.stringify([pub, draft])};`);
  const inSection = run("forayListHtml({ inSection: true })");
  const rows = inSection.split('class="fy-home-row"').slice(1);
  assert.doesNotMatch(rows[0], /fy-home-kicker/, "a published row under 'Forays' carries no FORAY tag");
  assert.match(rows[1], /<span class="fy-home-kicker">foray · draft<\/span>/, "a draft keeps its tag — 'draft' is news");
  assert.match(run("forayListHtml()"), /<span class="fy-home-kicker">foray<\/span>/, "outside a section, every row is tagged");
});

test("the Interests page names a lone root once: its card, with no heading restating it", () => {
  /* Round 2, visual-17: every root is always its own group's first row, so a
     new listener's page was "Adventure" over a card named "Adventure", 39
     times. MUTATION: always render the h3 -> red on the lone root; never
     render it -> red on the root with a sub-topic. */
  const run = loadApp();
  const root = { id: "adventure", label: "Adventure", parent: null, weight: 0.5 };
  const leaf = { id: "adventure/climbing", label: "Climbing", parent: "adventure", weight: 0.2 };
  const lone = run(`interestGroupHtml(${JSON.stringify({ root, rows: [root] })})`);
  assert.doesNotMatch(lone, /st-group-label/, "a lone root: the row names itself");
  assert.strictEqual((lone.match(/Adventure/g) || []).length >= 1, true);
  const grouped = run(`interestGroupHtml(${JSON.stringify({ root, rows: [root, leaf] })})`);
  assert.match(grouped, /<h3 class="st-group-label t-headline">Adventure<\/h3>/, "a root with a sub-subject keeps the heading that gathers them");
});

test("a came-from tile is the art, then the name to three lines, and a show with no page opens its Apple page", () => {
  /* Ambient Foray detail (Redesign 2026) replaced the credits row (name, count, arrow) with a three-up tile:
     the card-anatomy ruling that fell is "a credits row ends in its arrow". The tile's face is one link, the
     art above the name; a show the catalogue has no page for opens its Apple Podcasts page, says so in its
     accessible name, and has no Follow (there is nothing to bookmark).
     MUTATIONS: clamp3 -> clamp2 on the name: red. Drop target/rel from the external face: red. Put a
     data-fd-follow button on a show with no catalogue record: red. */
  const run = loadApp();
  const html = run(`forayCameFromHtml({ shows: ["A Show"], entries: [{ show: "A Show" }] }, {
    forayCredits: () => ({ summary: "1 show", credits: [{ show: "A Show", link: "https://podcasts.apple.com/x", linkKind: "apple-show", clips: 2, seconds: 300, episodes: [] }] }),
  })`);
  assert.match(html, /<a class="fd-tile-face" href="https:\/\/podcasts\.apple\.com\/x" target="_blank" rel="noopener"[^>]*aria-label="Open A Show on Apple Podcasts"><span class="fd-tile-art"[\s\S]*?<span class="t-caption name clamp3">A Show<\/span><\/a>/, html);
  assert.ok(html.indexOf('class="fd-tile-art"') < html.indexOf('class="t-caption name clamp3"'), "the art, then the name");
  assert.doesNotMatch(html, /data-fd-follow/, "a show with no catalogue page cannot be followed");
});

test("a tab's root page has no ‹; a page you were sent to keeps one", () => {
  /* Round 2, visual-6: Search, Create and Library carried a boxed ‹ that only
     duplicated the Home tab. MUTATION: drop `{ tabRoot: true }` from
     renderAllShows, or put the ‹ back in renderLibrary / renderCreate -> red. */
  const body = (name) => {
    const at = APP_SRC.indexOf(`function ${name}(`);
    return APP_SRC.slice(at, APP_SRC.indexOf("\n}\n", at));
  };
  for (const fn of ["renderLibrary", "renderCreate"]) {
    assert.doesNotMatch(body(fn), /class="back"/, `${fn} is a tab root`);
  }
  assert.match(body("renderShowIndexPage"), /\$\{tabRoot \? "" : `<a class="back" href="#\/">‹<\/a>`\}/, "the shared template omits it on request");
  /* REDESIGN 2026: Discover no longer uses the shared template (it has its own page-head, `page-head disc-head`,
     and no ‹), so the proof that it is a tab root is that it never draws one. MUTATION: put
     `<a class="back" href="#/">‹</a>` in renderAllShows's page-head -> red. */
  assert.doesNotMatch(body("renderAllShows"), /class="back"/, "Discover is a tab root and draws no ‹");
  assert.doesNotMatch(body("renderCategory"), /tabRoot/, "a category page is pushed: it keeps its ‹");
  for (const fn of ["renderPlaylists", "renderForays"]) {
    assert.match(body(fn), /class="back"/, `${fn} is pushed from a tab and keeps its ‹`);
  }
  /* The Up Next page (Redesign 2026, ambient) is pushed from Library and keeps its ‹, drawn by its own head and still the
     history-aware a.back. MUTATION: drop `back` from that link's class (leave `qp-back`) -> the route no longer steps back. */
  assert.match(body("queuePageHeadHtml"), /<a class="back qp-back /, "the Up Next page keeps its ‹ (a.back, the history-aware one)");
  assert.match(body("renderQueue"), /queuePageHeadHtml|libUpNextInnerHtml\(true\)/, "and renderQueue draws that head");
  /* Tuning, Settings and About (Redesign 2026) share one head, stHeadHtml, whose Back chevron is the history-aware a.back. */
  assert.match(body("renderInterests"), /stPageHtml\(/, "Tuning is a Settings page: it wears the shared head");
  assert.match(body("stHeadHtml"), /<a class="back st-back /, "the shared head keeps its ‹ (a.back, the history-aware one)");
});

test("search's shows tier wears the head its Episodes and Playlists tiers do, only while it has rows", () => {
  /* Round 2, visual-16. REDESIGN 2026: the eyebrow became the SectionHead (`--t-headline`, `.t-headline`) for ALL
     three groups; the Shows head is the one the page emits itself (the others come from agSectionHead), so it is
     given the same type class and the same hide-with-its-list rule.
     MUTATION: delete the `<h3 class="sh-results-head t-headline">` or its `:has(+ #sh-results[hidden])` rule -> red. */
  assert.match(APP_SRC, /<h3 class="sh-results-head t-headline">Shows<\/h3>\s*<div id="sh-results" class="show-results dsc-list" hidden><\/div>/,
    "the label sits directly before the tier it names");
  assert.strictEqual(valueOf(".sh-results-head:has(+ #sh-results[hidden])", "display"), "none", "and hides with it");
  const css = fs.readFileSync(path.join(ROOT, "ui", "primitives.css"), "utf8").replace(/\r\n/g, "\n");
  assert.match(css, /\.ag\.disc \.sh-results-head \{[^}]*font: var\(--t-headline\)/, "the same head as the other groups' SectionHead (--t-headline)");
});

test("a show row's title is two lines at most and the whole name is still on the row", () => {
  /* Round 2, search-11: 152 index titles run past 80 characters. MUTATION:
     delete the clamp, or the `title=` -> red. */
  const run = loadApp();
  const long = "Budget Effect: How to Budget, How to Pay off Debt, Save Money, Live on a Budget, Improve your Money Mindset";
  const html = run(`showResultRow(${JSON.stringify({ show_id: "s1", title: long })})`);
  assert.match(html, new RegExp(`<a class="show-result" href="#/show/s1" title="${long}">`), "the row carries the full name");
  assert.strictEqual(valueOf(".show-result-title", "-webkit-line-clamp"), "2");
  assert.strictEqual(valueOf(".show-result-title", "overflow"), "hidden");
  assert.strictEqual(valueOf(".show-result-title", "display"), "-webkit-box");
});

test("the Up Next row is one silhouette: every control on it is round", () => {
  /* Round 2, visual-11: round ▶ and ✕ around rounded-square ↑ ↓. MUTATION:
     `button.reorder { border-radius: var(--radius-md) }` -> red. */
  for (const sel of ["button.reorder", "button.up-next-remove", ".play-btn"]) {
    assert.strictEqual(valueOf(sel, "border-radius"), "var(--radius-round)", sel);
  }
});

/* ==================================================================== */
/* 3. one pill                                                           */
/* ==================================================================== */

test("Create's suggestions are the one pill; Discover has no pills (REDESIGN 2026: subjects are tiles)", () => {
  /* The original claim — Create's suggestions and Search's browse subjects are the same `.fy-chip` — lost its second
     half: Discover's subjects are SubjectTiles, not a pill wall (BUILD-NOTES 4.4), and the pill row's rules went with
     it. What is pinned now: Create still renders the one pill, no `.cr-pill` exists, and nothing on Discover emits a
     `.fy-chip` or the `.sh-browse-pills` row.
     MUTATION: render `class="cr-pill"` in renderCreate again, or add a `.cr-pill {` rule, or emit
     `class="sh-browse-pills"` from renderAllShows -> red. */
  assert.match(APP_SRC, /<button type="button" class="fy-chip" data-cr-subject=/, "Create renders .fy-chip");
  assert.doesNotMatch(APP_SRC, /<a class="fy-chip" href="#\/shows\/q\//, "Discover's tiles are not pills");
  assert.doesNotMatch(APP_SRC, /class="sh-browse-pills"/, "and the pill row is gone");
  assert.doesNotMatch(APP_SRC, /class="cr-pill/, "no renderer emits .cr-pill");
  assert.ok(!hasRule(".cr-pill"), ".cr-pill has no rule left");
  assert.ok(!hasRule("body.ui-v2 .sh-browse-pills"), "the pill row's own rule is deleted, not orphaned");
  assert.strictEqual(valueOf(".fy-chip", "border-radius"), "var(--radius-pill)", "a pill is a capsule");
  assert.strictEqual(valueOf(".fy-chip", "font-family"), "var(--font-body)");
  assert.ok(hasRule(".fy-chip:hover, .fy-chip:active"), "touch feedback beside hover");
});

/* ==================================================================== */
/* 4. one artwork treatment                                              */
/* ==================================================================== */

test("the episode page and Now Playing share one square-artwork treatment (the show page's art is the Afterglow primitive's, ui/show.css)", () => {
  /* MUTATION: give `.fp-s-art` its own `box-shadow` again, or `.ep-art` its
     own `border-radius` -> red. */
  const shared = ".ep-art, .fp-s-art";
  assert.strictEqual(valueOf(shared, "border-radius"), "var(--radius-md)");
  assert.match(valueOf(shared, "border") || "", /1px solid var\(--line\)/);
  assert.strictEqual(valueOf(shared, "box-shadow"), "var(--shadow-lift)");
  /* Only a rule written for ONE of them counts as a restatement; the shared
     rule above names all three. */
  const own = (sel, prop) => {
    let v = null;
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    while ((m = re.exec(SRC))) {
      if (splitSelectors(m[1]).join(", ") !== sel) continue;
      for (const d of m[2].split(";")) {
        const c = d.indexOf(":");
        if (c > 0 && d.slice(0, c).trim() === prop) v = d.slice(c + 1).trim();
      }
    }
    return v;
  };
  for (const sel of [".ep-art", ".fp-s-art", "body.ui-v2 .ep-art"]) {
    for (const prop of ["border-radius", "box-shadow", "border"]) {
      assert.strictEqual(own(sel, prop), null, `${sel} must not restate ${prop} on its own`);
    }
  }
});

/* ==================================================================== */
/* 5. one tag shape                                                      */
/* ==================================================================== */

test("Home's tags, Search's Generated badge and both kickers are one shape on one tint", () => {
  /* The family was three shapes: plain violet text ("foray" on the Forays
     index, at the eyebrow's 0.08em tracking), plain amber text ("Jump back
     in"), and boxed tags at 15/18/22% tints. One box, one tracking, one mix.
     MUTATION: `body.ui-v2 .fy-badge { border-radius: var(--radius-md) }`,
     or `.fy-home-kicker { letter-spacing: 0.08em }` with no background, or
     `.fy-badge-generated` back at 22% -> red, naming the selector. */
  const tags = [
    "body.ui-v2 .hv2-stretch-tag", "body.ui-v2 .hv2-draft-tag", "body.ui-v2 .hv2-generated-badge",
    "body.ui-v2 .fy-badge", ".mc-stretch", ".fy-home-kicker", "body.ui-v2 .hv2-jbi-kicker",
  ];
  for (const sel of tags) {
    assert.strictEqual(valueOf(sel, "border-radius"), "var(--radius-xs)", `${sel} radius`);
    assert.strictEqual(valueOf(sel, "font-size"), "var(--fs-2xs)", `${sel} size`);
    assert.strictEqual(valueOf(sel, "text-transform"), "uppercase", `${sel} case`);
    assert.strictEqual(valueOf(sel, "padding"), "1px 7px", `${sel} padding`);
    assert.strictEqual(valueOf(sel, "letter-spacing"), "0.04em", `${sel} tracking`);
  }
  /* The tint: 18% of the tag's own colour, on every tag that paints one. The
     shape-only `.fy-badge` is coloured by `.fy-badge-generated`. */
  const tinted = [...tags.filter((s) => s !== "body.ui-v2 .fy-badge"), "body.ui-v2 .fy-badge-generated"];
  for (const sel of tinted) {
    assert.match(valueOf(sel, "background") || "",
      /^color-mix\(in srgb, (currentColor|var\(--violet\)|var\(--amber\)) 18%, transparent\)$/, `${sel} tint`);
  }
  /* The kickers sit in flex columns: the box is the word's width, not the row's. */
  for (const sel of [".fy-home-kicker", "body.ui-v2 .hv2-jbi-kicker"]) {
    assert.strictEqual(valueOf(sel, "align-self"), "flex-start", `${sel} hugs its text`);
  }
  /* Amber only where it marks the listener's own material. */
  assert.strictEqual(valueOf("body.ui-v2 .hv2-jbi-kicker", "color"), "var(--amber)");
  assert.strictEqual(valueOf("body.ui-v2 .fy-jbi-row .fy-home-kicker", "color"), "var(--amber)");
  assert.strictEqual(valueOf("body.ui-v2 .fy-home-kicker", "color"), "var(--violet)");
});

/* ==================================================================== */
/* 6. rows read the row radius                                          */
/* ==================================================================== */

/** The vertical padding a shorthand declares, in px (`11px 12px` -> 11). */
const vpad = (v) => { const m = /^(\d+(?:\.\d+)?)px/.exec(String(v || "").trim()); return m ? Number(m[1]) : null; };

test("every card on --surface with row-sized padding reads --radius-lg — a clip row is not a 12px object beside 16px rows", () => {
  /* The role check the ui-tokens radius test does not make: it only asks that
     a corner read SOME token. `.fy-row` (a 100-130px clip card) and `.fy-src`
     sat at `--radius-md`, the buttons-and-controls step, beside `.ep-row`,
     `.fy-home-row` and the Home cards at `--radius-lg`.
     MUTATION: `.fy-row { border-radius: var(--radius-md) }` -> red, naming it. */
  const offenders = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(SRC))) {
    const decls = Object.fromEntries(m[2].split(";").map((d) => d.trim()).filter(Boolean)
      .map((d) => { const c = d.indexOf(":"); return [d.slice(0, c).trim(), d.slice(c + 1).trim()]; }));
    if (decls.background !== "var(--surface)" || vpad(decls.padding) == null || vpad(decls.padding) < 11) continue;
    const sel = m[1].trim().replace(/\s+/g, " ");
    if (/^\.fy-panel$/.test(sel)) continue; // the sheet: xl top corners by design
    const radius = decls["border-radius"] || valueOf(sel, "border-radius");
    if (radius !== "var(--radius-lg)") offenders.push(`${sel} (${radius})`);
  }
  assert.deepStrictEqual(offenders, [], "surface cards with row padding not on --radius-lg");
  for (const sel of [".fy-row", ".fy-src", ".interest-row", ".ep-row, .pl-row", ".fy-home-row"]) {
    assert.strictEqual(valueOf(sel, "border-radius"), "var(--radius-lg)", sel);
  }
});

/* ==================================================================== */
/* 7. the rhythm above the first card                                   */
/* ==================================================================== */

test("an intro paragraph sits a section (20px) above the first card, not the row gap", () => {
  /* `.note { margin: 0 }` and `.page` has no gap, so the Forays index's intro
     and the show page's Follow note bottomed out 0-5px above the first card —
     tighter than the 8px between the cards themselves.
     MUTATION: delete `.fy-about { margin: 0 0 20px }` -> red. */
  assert.strictEqual(valueOf(".fy-about", "margin"), "0 0 20px", "the Forays intro");
  /* REDESIGN 2026 (ambient, show page): the show page's art + Follow + note block is the Room (ui/show.css); the legacy
     `.show-hero` rules went with it. Its rhythm is now the Room's own: the note sits 12px under Follow, which sits 16px
     under the count. MUTATION: set `.ag .sh-note { margin-top: 0 }` -> red. */
  const showCss = fs.readFileSync(path.join(ROOT, "ui/show.css"), "utf8").replace(/\r\n/g, "\n").replace(/\/\*[\s\S]*?\*\//g, " ");
  assert.match(showCss, /\.ag \.sh-note \{[^}]*margin-top: var\(--s-3\)/, "the note sits a step under Follow");
  assert.match(showCss, /\.ag \.sh-follow \{[^}]*margin-top: var\(--s-4\)/, "Follow sits a step under the count");
  assert.match(showCss, /\.room\.sh-room \{[^}]*align-items: center; text-align: center/, "and the Room is one centred block");
  assert.strictEqual(valueOf(".ep-actions", "justify-content"), "center", "the episode page's actions centre under its art the same way");
  assert.match(APP_SRC, /<div class="sh-art">\$\{agArtwork\([^)]*\)\}<\/div>[\s\S]*?\$\{showStarBtn\(show\.show_id\)\}\s*<p class="t-caption sh-note show-follow-note">[\s\S]*?<\/section>/,
    "renderShow's Room wraps art, Follow and the note");
  assert.match(APP_SRC, /<p class="note fy-about">/, "renderForays' intro carries the class the margin hangs on");
});
