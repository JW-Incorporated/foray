/* Visual pass 1 (2026-09-23): the card, row, pill, tag and artwork anatomy the
 * founder-approved visual changes converge on (docs/audit/status.tsv qa rows
 * 43/54/59/78, persona 40), pinned so the next restyle cannot quietly undo
 * them one selector at a time.
 *
 *   1. NO <button> INSIDE AN <a>. Three cards did it (qa row 78): Jump back in,
 *      the subject cards, the Continue banner. Each is now a positioned card
 *      whose title is the one real link, stretched over the card by its
 *      ::after, with the control a SIBLING lifted above it. The HTML the
 *      renderers emit is walked tag by tag here — a source grep for "<a" could
 *      not tell nesting from adjacency.
 *   2. THE EPISODE ROW HAS TWO TIERS (persona 40): the text block owns the
 *      first line, the controls wrap under it.
 *   3. ONE PILL (qa row 54): Create's suggestions and Search's browse subjects
 *      are both `.fy-chip`; `.cr-pill` has no rule and no user.
 *   4. ONE ARTWORK TREATMENT (qa row 59): the show page, the episode page and
 *      Now Playing share one radius/border/shadow rule.
 *   5. ONE TAG SHAPE: Home's tags and Search's "Generated for you" badge agree.
 *
 * Every test names its killing mutation.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const APP_SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8").replace(/\r\n/g, "\n");
const CSS = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8").replace(/\r\n/g, "\n");

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
  vm.runInContext(APP_SRC, ctx, { filename: "app.js" });
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

test("the subject card is a card: the title is the link, the star is a sibling above it", () => {
  /* MUTATION: put `<a class="mini-card" …>` back around the whole card ->
     the star is inside an anchor again and the first assertion names it. */
  const run = loadApp();
  const html = run(`miniCard(${JSON.stringify(SLOT)})`);
  assert.deepStrictEqual(buttonsInsideAnchors(html), [], "a <button> opened inside an <a>");
  assert.match(html, /^<div class="mini-card" data-branch="science">/, "the card is a <div> (first-time-onboarding's dealt-roots regex reads this attribute order)");
  assert.match(html, /<h3><a class="mc-link" href="#\/[^"]+">[^<]+<\/a><\/h3>/, "the subject title is the one real link");
  assert.match(html, /<button class="star[^>]*>[\s\S]*<\/div>$/, "the star is a child of the card, after the text block");
  assert.strictEqual(valueOf(".mini-card", "position"), "relative", "the card is the link's containing block");
  assert.strictEqual(valueOf(".mc-link::after", "inset"), "0", "the link stretches over the card");
  assert.strictEqual(valueOf(".mini-card > button.star", "z-index"), "1", "the star sits above the stretched link");
  /* And the stretch card's bridge line still lands inside the card. */
  const stretch = run(`miniCardV2(${JSON.stringify({ ...SLOT, role: "stretch" })})`);
  assert.match(stretch, /<p class="hv2-bridge">[^<]+<\/p><\/div>$/, "miniCardV2 appends the bridge before the card's closing tag");
});

test("the Jump back in card is a card: the title is the link, play is a sibling above it", () => {
  /* MUTATION: `<a class="hv2-jbi-card" …>` back around the card -> red. */
  const run = loadApp();
  const html = run(`jumpBackInCardHtml(${JSON.stringify(JBI)})`);
  assert.deepStrictEqual(buttonsInsideAnchors(html), [], "a <button> opened inside an <a>");
  assert.match(html, /<div class="hv2-jbi-card">/);
  assert.match(html, /<a class="hv2-jbi-title hv2-jbi-link" href="#\/episode\/e1" data-ev="picked" data-ep="e1" data-ctx="jbi-episode">Dennis Whyte: Nuclear Fusion<\/a>/,
    "the title link carries the `picked` logging attributes bindPickLogging binds");
  assert.match(html, /<button class="play-btn" data-play="e1"/, "the card still carries its play button");
  assert.strictEqual(valueOf("body.ui-v2 .hv2-jbi-card, body.ui-v2 .hv2-foray-card, body.ui-v2 .hv2-playlist-card", "position"), "relative");
  assert.strictEqual(valueOf("body.ui-v2 .hv2-jbi-link::after", "inset"), "0");
  assert.strictEqual(valueOf("body.ui-v2 .hv2-jbi-card > .play-btn", "z-index"), "1");
});

test("the Continue banner is a card: the title is the link, the ✓ is a sibling above it", () => {
  /* MUTATION: `<a class="banner" …>` back around the banner -> red. */
  const body = APP_SRC.slice(APP_SRC.indexOf("function bannerHtml()"), APP_SRC.indexOf("function subjectBlurb("));
  const tpl = /return `([\s\S]*?)`;/.exec(body);
  assert.ok(tpl, "bannerHtml returns one template");
  assert.deepStrictEqual(buttonsInsideAnchors(tpl[1]), []);
  assert.match(tpl[1], /^<div class="banner">/);
  assert.match(tpl[1], /<a class="b-title" href="#\/episode\/[^"]+"\s+data-ev="picked"/);
  assert.strictEqual(valueOf(".banner", "position"), "relative");
  assert.strictEqual(valueOf(".banner .b-title::after", "inset"), "0");
  assert.strictEqual(valueOf(".banner > .b-done", "z-index"), "1");
});

test("no renderer in app.js nests a <button> inside an <a>", () => {
  /* The general rule behind the three fixes: every template literal in app.js
     is walked; a template that opens an <a> and then a <button> before closing
     it fails here by its first line. Cross-template nesting (an <a> opened in
     one function and a button injected by another) is what the three renders
     above catch. MUTATION: any of the three reverts. */
  const bad = [];
  for (const m of APP_SRC.matchAll(/`([^`]*)`/g)) {
    const t = m[1];
    if (!/<a\b/.test(t) || !/<button\b/.test(t)) continue;
    const hits = buttonsInsideAnchors(t);
    if (hits.length) bad.push(`${t.trim().split("\n")[0].slice(0, 80)} … ${hits[0]}`);
  }
  assert.deepStrictEqual(bad, [], "templates with a <button> inside an <a>:\n" + bad.join("\n"));
});

/* ==================================================================== */
/* 2. the episode row's two tiers (persona 40)                           */
/* ==================================================================== */

test("an episode row wraps its controls under the title instead of squeezing the title to ~114px", () => {
  /* MUTATION: delete `.ep-row { flex-wrap: wrap; … }` -> the number, the
     text block, ▶, ☆ and "+ Up Next" share one line again. */
  assert.strictEqual(valueOf(".ep-row", "flex-wrap"), "wrap");
  assert.match(valueOf(".ep-row > .info", "flex") || "", /^1 1 calc\(100% - \d+px\)$/, "the text block takes the first line minus the number");
  assert.match(valueOf(".ep-row > .info + :is(.play-btn, button.star, button.up-next, .not-playable)", "margin-left") || "", /^\d+px$/,
    "the first control on the second line aligns under the title, not under the number");
  /* A playlist row is a one-line link row and must NOT wrap. */
  assert.notStrictEqual(valueOf(".pl-row", "flex-wrap"), "wrap");
  /* The row title is the display face at the title step, like every card. */
  assert.strictEqual(valueOf(".ep-row .t, .pl-row .t", "font-family"), "var(--font-display)");
  assert.strictEqual(valueOf(".ep-row .t, .pl-row .t", "font-size"), "var(--fs-lg)");
});

/* ==================================================================== */
/* 3. one pill                                                           */
/* ==================================================================== */

test("Create's suggestions and Search's browse subjects are the same pill", () => {
  /* MUTATION: render `class="cr-pill"` in renderCreate again, or add a
     `.cr-pill {` rule -> red. */
  assert.match(APP_SRC, /<button type="button" class="fy-chip" data-cr-subject=/, "Create renders .fy-chip");
  assert.match(APP_SRC, /<a class="fy-chip" href="#\/shows\/q\//, "Search's browse tiles render .fy-chip");
  assert.doesNotMatch(APP_SRC, /class="cr-pill/, "no renderer emits .cr-pill");
  assert.ok(!hasRule(".cr-pill"), ".cr-pill has no rule left");
  assert.ok(!hasRule("body.ui-v2 .sh-browse-pills .fy-chip"), "Search does not restyle the pill's geometry on its own");
  assert.strictEqual(valueOf(".fy-chip", "border-radius"), "var(--radius-pill)", "a pill is a capsule");
  assert.strictEqual(valueOf(".fy-chip", "font-family"), "var(--font-body)");
  assert.ok(hasRule(".fy-chip:hover, .fy-chip:active"), "touch feedback beside hover");
});

/* ==================================================================== */
/* 4. one artwork treatment                                              */
/* ==================================================================== */

test("the show page, the episode page and Now Playing share one square-artwork treatment", () => {
  /* MUTATION: give `.fp-s-art` its own `box-shadow` again, or `.ep-art` its
     own `border-radius` -> red. */
  const shared = ".show-art, .ep-art, .fp-s-art";
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
  for (const sel of [".show-art", ".ep-art", ".fp-s-art", "body.ui-v2 .ep-art", "body.ui-v2 .show-art"]) {
    for (const prop of ["border-radius", "box-shadow", "border"]) {
      assert.strictEqual(own(sel, prop), null, `${sel} must not restate ${prop} on its own`);
    }
  }
});

/* ==================================================================== */
/* 5. one tag shape                                                      */
/* ==================================================================== */

test("Home's tags and Search's Generated badge are one shape", () => {
  /* MUTATION: `body.ui-v2 .fy-badge { border-radius: var(--radius-md) }` -> red. */
  const tags = ["body.ui-v2 .hv2-stretch-tag", "body.ui-v2 .hv2-draft-tag", "body.ui-v2 .hv2-generated-badge", "body.ui-v2 .fy-badge", ".mc-stretch"];
  for (const sel of tags) {
    assert.strictEqual(valueOf(sel, "border-radius"), "var(--radius-xs)", `${sel} radius`);
    assert.strictEqual(valueOf(sel, "font-size"), "var(--fs-2xs)", `${sel} size`);
    assert.strictEqual(valueOf(sel, "text-transform"), "uppercase", `${sel} case`);
    assert.strictEqual(valueOf(sel, "padding"), "1px 7px", `${sel} padding`);
  }
});
