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
  assert.strictEqual(valueOf(".show-hero", "margin"), "0 0 20px", "the show page's art + Follow + note block");
  assert.strictEqual(valueOf(".show-hero", "text-align"), "center", "…which is one centred block");
  assert.strictEqual(valueOf(".show-hero .show-star", "display"), "inline-block", "Follow centres with it");
  assert.strictEqual(valueOf(".ep-actions", "justify-content"), "center", "the episode page's actions centre under its art the same way");
  assert.match(APP_SRC, /<div class="show-hero">\s*\$\{showArt \? `<img class="show-art"[\s\S]*?\$\{showStarBtn\(show\.show_id\)\}\s*<p class="note show-follow-note">[\s\S]*?<\/div>/,
    "renderShow wraps art, Follow and the note in the hero");
  assert.match(APP_SRC, /<p class="note fy-about">/, "renderForays' intro carries the class the margin hangs on");
});
