/* Tap targets are sized by a RULE, not by eye (audit 2026-09-22, theme F).
 *
 * THE DEFECT. styles.css had four 44px targets in ~3,300 lines, and two of its
 * own comments promised sizes the CSS did not deliver: the chapter-row comment
 * said 48px over a ~19px live button (the padding was on the `<li>`), and the
 * Foray thumbs' neighbour sized the layout around "the 44px-ish thumb target"
 * over 30px squares. The misses were not neutral — a missed reorder arrow
 * removed the episode, a missed Audition changed the narration voice, a missed
 * star started audio — and two of the fourteen findings were gestures, not
 * sizes: a vertical flick on the sticky Foray strip SEEKED, and the Now Playing
 * scrubber lost every drag to the sheet's scroller.
 *
 * WHAT NOW HOLDS IT. One rule near the top of styles.css gives every listed
 * control an invisible ≥44x44 hit box (a centred `::after`), so a 40px star
 * keeps looking 40px while a thumb gets 44. This suite:
 *   1. WALKS EVERY <button> THE APP RENDERS (audit round 2, touch-5) — every
 *      `<button …>` template and every `el("button", …)` in app.js,
 *      player/*.js and index.html — and requires each to be in the hit-area
 *      rule, ≥44px both ways by its own declarations, or ≥44px tall and wider
 *      by construction (a full-width row, a labelled text button), with the
 *      reason written down. Round 1 enumerated only the controls it measured,
 *      and six it had not (Follow, every sheet's Cancel and primary, the
 *      Interests reset at 26px, the notice's ✕) stayed small; a census cannot
 *      miss the next one, because an unclassified class fails it. The list of
 *      controls round 1 measured is kept below as a second, narrower floor;
 *   2. checks the hit-area rule itself is the shape that works (centred,
 *      `max(100%, 44px)`, zero-specificity `:where()` so it never overrides a
 *      component's own `position`), and that nothing else claims `::after` on a
 *      listed control;
 *   3. pins the gesture and layout findings one by one, each with the one-line
 *      mutation that turns it red.
 *
 * WHAT ONLY A DEVICE CAN CONFIRM, said rather than faked: actual tap accuracy
 * with a thumb, iOS's treatment of `touch-action: pan-y` on a sticky element,
 * and the notch geometry of the mini player's inset. This suite reads the
 * stylesheet's declarations; it cannot watch a finger miss.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const CSS = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8").replace(/\r\n/g, "\n");

/** Every style rule with its at-rule context, comments removed (a comment
    ABOUT a rule must never satisfy an assertion about the rule). */
function parseRules(css) {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, " ");
  const rules = [];
  const stack = [];
  let buf = "";
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") {
      const prelude = buf.trim();
      buf = "";
      if (prelude.startsWith("@")) { stack.push(prelude); continue; }
      const end = src.indexOf("}", i);
      rules.push({
        prelude,
        selectors: splitSelectors(prelude),
        atRules: stack.slice(),
        decls: src.slice(i + 1, end).split(";").map((d) => d.trim()).filter(Boolean).map((d) => {
          const c = d.indexOf(":");
          return { prop: d.slice(0, c).trim(), value: d.slice(c + 1).trim() };
        }),
      });
      i = end;
    } else if (ch === "}") {
      stack.pop();
      buf = "";
    } else {
      buf += ch;
    }
  }
  return rules;
}

/** Split a selector list on top-level commas (not the ones inside :where()). */
function splitSelectors(prelude) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of prelude) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim().replace(/\s+/g, " ")); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim().replace(/\s+/g, " "));
  return out;
}

const RULES = parseRules(CSS);
const UNCONDITIONAL = RULES.filter((r) => r.atRules.length === 0);

/** The last value `prop` gets on exactly `sel`, among unconditional rules. */
function valueOf(sel, prop) {
  let v = null;
  for (const r of UNCONDITIONAL) {
    if (!r.selectors.includes(sel)) continue;
    for (const d of r.decls) if (d.prop === prop) v = d.value;
  }
  return v;
}
const px = (v) => {
  const m = /^(-?\d+(?:\.\d+)?)px$/.exec(String(v || "").trim());
  return m ? Number(m[1]) : null;
};

/* ---------- the hit-area rule ---------- */

/** The selectors inside the ONE `:where(...)::after` rule that grows hit areas. */
function hitAreaSelectors() {
  const rule = UNCONDITIONAL.find((r) => /^:where\(/.test(r.prelude) && /\)::after$/.test(r.prelude));
  assert.ok(rule, "styles.css has no `:where(...)::after` tap-target rule");
  const inner = /^:where\(([\s\S]*)\)::after$/.exec(rule.prelude)[1];
  return { rule, list: splitSelectors(inner) };
}

test("the tap-target rule is a centred, zero-specificity box of at least 44x44", () => {
  /* MUTATION: write the rule as `:is(...)` instead of `:where(...)`. The
     `position: relative` half would then out-rank `.fp-grab-zone .fp-close`'s
     own `position: absolute` and drop the ✕ into the flow of the grab row —
     the prelude check fails first. MUTATION: `width: 44px` instead of
     `max(100%, 44px)` -> a control WIDER than 44 (the + Up Next pill) would
     have its hit box shrunk to 44; the width assertion fails. */
  const { rule, list } = hitAreaSelectors();
  const d = Object.fromEntries(rule.decls.map((x) => [x.prop, x.value]));
  assert.strictEqual(d.content, '""');
  assert.strictEqual(d.position, "absolute");
  assert.strictEqual(d.width, "max(100%, 44px)");
  assert.strictEqual(d.height, "max(100%, 44px)");
  assert.match(d.transform || "", /translate\(-50%,\s*-50%\)/, "the box is centred on the control");
  const anchor = UNCONDITIONAL.find((r) => /^:where\(/.test(r.prelude) && !/::after/.test(r.prelude)
    && r.decls.some((x) => x.prop === "position" && x.value === "relative"));
  assert.ok(anchor, "the listed controls need `position: relative` for the box to anchor to");
  const anchored = splitSelectors(/^:where\(([\s\S]*)\)$/.exec(anchor.prelude)[1]);
  assert.deepStrictEqual([...anchored].sort(), [...list].sort(),
    "the anchoring rule and the ::after rule must list the same controls");
});

test("no other rule claims ::after on a control that relies on the hit-area rule", () => {
  /* A second `::after` on a listed control would either replace the hit box
     or be replaced by it. MUTATION: add `.fy-thumb::after { content: "" }`. */
  const { list } = hitAreaSelectors();
  const clashes = [];
  for (const r of UNCONDITIONAL) {
    if (/^:where\(/.test(r.prelude)) continue;
    for (const sel of r.selectors) {
      const m = /^(.*)::?after$/.exec(sel);
      if (m && list.includes(m[1].trim())) clashes.push(sel);
    }
  }
  assert.deepStrictEqual(clashes, []);
});

/* ---------- the census: every rendered <button>, classified ---------- */

const MARKUP_FILES = ["app.js", "index.html", ...fs.readdirSync(path.join(ROOT, "player"))
  .filter((f) => f.endsWith(".js") && !f.endsWith(".test.js")).map((f) => `player/${f}`)];

/** Every button the app can render, keyed by its first class (or its id, or
    its whole open tag when it has neither). Block comments are stripped first:
    prose ABOUT a <button> is not one. */
function renderedButtons() {
  const keys = new Map();
  const add = (k, f) => keys.set(k, [...new Set([...(keys.get(k) || []), f])]);
  for (const f of MARKUP_FILES) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, " ");
    for (const m of src.matchAll(/<button\b([^>]*)>/g)) {
      const cls = /class="([^"$]*)/.exec(m[1]);
      const id = /\bid="([^"$]+)"/.exec(m[1]);
      add(cls && cls[1].trim() ? `.${cls[1].trim().split(/\s+/)[0]}` : id ? `#${id[1]}` : `<button ${m[1].trim()}>`, f);
    }
    for (const m of src.matchAll(/\b(?:el|ddEl)\(\s*"button"\s*,\s*"([^"]+)"/g)) add(`.${m[1].split(/\s+/)[0]}`, f);
    for (const m of src.matchAll(/<[a-z]+\b[^>]*\brole="button"[^>]*>/g)) add(`[role=button] ${m[0].slice(0, 60)}`, f);
  }
  return keys;
}

/* How each one reaches 44. `rule`: the hit-area rule lists this selector.
   `size`: these selectors' own width and height reach 44. `tall`: 44+ tall by
   its own declarations and wider than 44 by construction — `why` says how.
   `inline`: a text-flow control, with the reason it is allowed to be. */
const BUTTONS = {
  "#menu-btn": { rule: ".topbar button" },
  "#refresh-btn": { rule: ".topbar button" },
  "#sh-dismiss": { size: ["#sh-dismiss"] },
  "#shell-notice-reload": { rule: ".shell-notice button" },
  "#shell-notice-dismiss": { rule: ".shell-notice button" },
  ".cr-toggle-btn": { tall: ".cr-toggle-btn", why: "flex: 1 — half of Create's toggle row" },
  ".danger": { tall: "button.danger", why: "a labelled text button (\"remove this playlist\")" },
  ".dd-device-only": { tall: ".dd-device-only", why: "width: 100% of the sheet" },
  ".diag-clear": { tall: ".diag-clear", why: "width: 100% of the sheet" },
  ".drawer-item": { tall: ".drawer-item", why: "display: block, the drawer's full width" },
  ".ep-chapter-row": { tall: ".ep-chapter-row", why: "width: 100% of the chapter list or the description" },
  ".ep-ts": { inline: "a stamp inside running prose; its hit box is its line, and a line that STARTS with a stamp renders as .ep-chapter-row instead (touch-10)" },
  ".fp-btn": { size: [".fp-btn"] },
  ".fp-clip": { size: [".fp-clip"] },
  ".fp-close": { size: [".fp-close"] },
  ".fp-info": { tall: ".fp-info", why: "flex: 1 1 auto — the mini bar's whole title column" },
  ".fp-play": { size: [".fp-play"] },
  ".fp-rate": { rule: ".fp-rate" },
  ".fp-skip": { size: [".fp-skip"] },
  ".fp-stop": { rule: ".fp-stop" },
  ".fy-btn": { size: [".fy-btn"] },
  ".fy-chip": { rule: ".fy-chip" },
  ".fy-clip": { size: [".fy-clip"] },
  ".fy-jump": { tall: ".fy-jump", why: "flex: 1 — the clip card's whole play band" },
  ".fy-restart": { tall: ".fy-restart", why: "a labelled text button (\"Start over\") with 8px side padding" },
  ".fy-script-more": { rule: ".fy-script-more" },
  ".fy-sheet-cancel": { rule: ".fy-sheet-cancel" },
  ".fy-sheet-go": { rule: ".fy-sheet-go" },
  ".fy-thumb": { rule: ".fy-thumb" },
  ".interest-reset": { rule: ".interest-reset" },
  ".hv2-play": { tall: "body.ui-v2 .hv2-play", why: "Home's one play button (founder, 2026-09-24): a labelled capsule, \"▶ Play <title>\", 48px tall with 16/20px side padding" },
  ".play-btn": { rule: ".play-btn" },
  ".rate-option": { tall: ".rate-option", why: "a row of the speed sheet's full-width column" },
  ".reorder": { rule: "button.reorder" },
  ".show-star": { rule: "button.show-star" },
  ".star": { rule: "button.star" },
  ".up-next": { rule: "button.up-next" },
  ".up-next-remove": { rule: "button.up-next-remove" },
  ".voice-row-audition": { rule: ".voice-row-audition" },
  /* #pl-form's Go went with the #/playlists builder (round-3 audit,
     search-api-css-10); Create's Build is the one submit button left. */
  '<button type="submit">': { size: ["#cr-form button"] },
};

test("every <button> the app renders is classified, and reaches 44px the way its class says", () => {
  /* THE WALKER (round 2, touch-5). MUTATIONS, each run and red:
       - drop `button.show-star` from the hit-area rule (both halves) -> red,
         naming .show-star (Follow is ~39px by its own padding);
       - `.drawer-item { min-height: 40px }` -> red, naming .drawer-item;
       - add `<button class="new-thing">` to any template in app.js -> red,
         "not classified", until someone decides how it reaches 44. */
  const { list } = hitAreaSelectors();
  const found = renderedButtons();
  const unclassified = [...found.keys()].filter((k) => !(k in BUTTONS));
  assert.deepStrictEqual(unclassified, [], "a rendered <button> nobody has classified — put it in the hit-area rule or size it, then list it here");
  const stale = Object.keys(BUTTONS).filter((k) => !found.has(k));
  assert.deepStrictEqual(stale, [], "a classified control the app no longer renders — delete its entry");
  assert.ok(found.size >= 35, `fixture assumption: the walker sees the app's buttons (${found.size})`);

  const bad = [];
  const dim = (sel, a, b) => px(valueOf(sel, a)) ?? px(valueOf(sel, b));
  for (const [key, how] of Object.entries(BUTTONS)) {
    if (how.rule && !list.includes(how.rule)) bad.push(`${key}: "${how.rule}" is not in the hit-area rule`);
    for (const sel of how.size || []) {
      const w = dim(sel, "width", "min-width");
      const h = dim(sel, "height", "min-height");
      if (!(w >= 44 && h >= 44)) bad.push(`${key}: ${sel} is ${w ?? "?"}x${h ?? "?"}`);
    }
    if (how.tall) {
      const h = dim(how.tall, "height", "min-height");
      if (!(h >= 44)) bad.push(`${key}: ${how.tall} is ${h ?? "?"}px tall`);
      if (!how.why) bad.push(`${key}: a height-only pass must say why the width is not a problem`);
    }
    if (how.inline && !/touch-10/.test(how.inline)) bad.push(`${key}: an inline control needs its reason`);
  }
  assert.deepStrictEqual(bad, [], "below the 44px floor");
});

/* Every control the audit measured below 44px, and the selector that sizes
   it. A control passes when its own declarations reach 44 in both directions
   (`width`/`min-width` and `height`/`min-height`), or when it is in the
   hit-area rule. `.page-head .back` is sized, not expanded. */
const MEASURED_CONTROLS = [
  ".topbar button",            // ☰ and ↻, 42x42
  ".page-head .back",          // ‹, 42x42
  "button.star",               // ☆ on every row, 40x40
  ".play-btn",                 // ▶ on every row, 40x40
  "button.up-next",            // + Up Next, 40 tall
  "button.reorder",            // ↑ ↓, 28x22 stacked 2px apart
  "button.up-next-remove",     // ✕ beside them, 32x32
  ".fy-thumb",                 // 👍 👎, 30x30
  ".fp-grab-zone .fp-close",   // the sheet's ✕, 36x36
  ".fp-rate", ".fp-stop", ".fp-openep", // the sheet's second row (`.fp-collapse` is gone: the ✕ and the handle close it)
  ".voice-row-audition",       // ~29 tall, inside a row that SELECTS on a miss
  /* Visual pass 1 (2026-09-23): the mini bar's ↺15 and the clip rows' text
     buttons are sized by their own declarations, like the transport. */
  ".fp-skip", ".fp-clip", ".fy-clip",
  /* The one pill (review of the pass): ~35px by its own padding on Search,
     Create and the reason sheet; expanded by the rule, not resized. */
  ".fy-chip",
];

test("every control the audit measured has a 44px hit area, by size or by the rule", () => {
  /* THE TEST THAT WOULD HAVE CAUGHT THE SIZE FINDINGS. MUTATION: remove
     `button.reorder` from the hit-area rule's list (both halves) -> fails
     naming it, because its own size is 40x40. */
  const { list } = hitAreaSelectors();
  const short = [];
  for (const sel of MEASURED_CONTROLS) {
    if (list.includes(sel)) continue;
    const w = px(valueOf(sel, "width")) ?? px(valueOf(sel, "min-width"));
    const h = px(valueOf(sel, "height")) ?? px(valueOf(sel, "min-height"));
    if (!(w >= 44 && h >= 44)) short.push(`${sel} (${w ?? "?"}x${h ?? "?"})`);
  }
  assert.deepStrictEqual(short, [], "below the 44px floor with no hit-area expansion");
});

test("the Foray running order's play targets and the chapter rows are 44px, and the comments now tell the truth", () => {
  /* MUTATION: `.fy-jump.is-bare { min-height: 30px }` (the old floor) -> red.
     MUTATION: put `padding: 6px 0` back on `.ep-chapters-list li` and zero the
     button's -> red (the row LOOKS tall while the live button is ~19px). */
  assert.ok(px(valueOf(".fy-jump", "min-height")) >= 44, ".fy-jump floor");
  assert.ok(px(valueOf(".fy-jump.is-bare", "min-height")) >= 44, "a narration beat's play strip");
  assert.ok(px(valueOf(".ep-chapter-row", "min-height")) >= 44, "the chapter row's own button");
  assert.match(valueOf(".ep-chapters-list li", "padding") || "", /^0(px)?$/,
    "the padding belongs to the button, not the <li> around it");
  assert.doesNotMatch(CSS, /a 48px row is the\s+tap size/, "the chapter comment must not claim 48px any more");
  assert.doesNotMatch(CSS, /clears the 44px-ish thumb target/, "nor the credit comment a 44px thumb it did not have");
});

test("the two thumbs' hit boxes meet instead of overlapping", () => {
  /* 30px thumbs with 44px hit boxes overlap by 14px unless the gap is ≥14.
     A near-miss on 👍 must not open 👎's reason sheet.
     MUTATION: `.fy-fb { gap: 6px }` (the old value) -> red. */
  const size = px(valueOf(".fy-thumb", "width"));
  const gap = px(valueOf(".fy-fb", "gap"));
  assert.ok(size && gap != null, "fixture assumption: the thumbs and their gap are px values");
  assert.ok(gap >= 44 - size, `gap ${gap}px lets two 44px hit boxes on ${size}px thumbs overlap`);
});

test("Up Next keeps its destructive ✕ a clear distance from the reorder arrows, on a line of their own", () => {
  /* MUTATION: drop `flex-wrap: wrap` from `.up-next-row` -> the controls share
     the title's line again (the title had ~124px). MUTATION: drop the ✕'s
     `margin-left` -> red. MUTATION: put the arrows back in a column -> red. */
  assert.strictEqual(valueOf(".up-next-row", "flex-wrap"), "wrap");
  assert.strictEqual(valueOf(".up-next-reorder", "flex-direction"), "row", "↑ and ↓ side by side, not stacked");
  assert.ok(px(valueOf("button.up-next-remove", "margin-left")) >= 16,
    "the ✕ must sit apart from ↓ — remove is immediate and has no undo");
});

test("an episode row's WHOLE CARD opens the episode, with its controls and the show link lifted above it", () => {
  /* Round 2, touch-9: the stretched link covered `.info` only, and once the
     controls wrapped to a second tier half the card was dead — the space right
     of ▶ ☆ + Up Next, the number, the padding ring — and a live tap underlined
     the title and nothing else. MUTATIONS: put `.ep-row .info { position:
     relative }` back -> red (the link stops at the text block again); drop the
     controls' `z-index: 1` -> red (the stretched link would swallow ▶); delete
     the `:has(… :active)` rule -> red. (The delete-the-::after mutation of
     round 1 still turns this red too.) */
  assert.strictEqual(valueOf(".ep-row", "position"), "relative", "the row is the stretched link's containing block");
  assert.strictEqual(valueOf(".ep-row .info", "position"), null, "…and the text block is not, or the link stops there");
  assert.strictEqual(valueOf(".ep-row .ep-title-link::after", "position"), "absolute");
  assert.strictEqual(valueOf(".ep-row .ep-title-link::after", "inset"), "0");
  assert.strictEqual(valueOf(".ep-row > :is(.play-btn, button.star, button.up-next)", "z-index"), "1",
    "every second-tier control sits above the stretched link");
  const { list } = hitAreaSelectors();
  for (const c of [".play-btn", "button.star", "button.up-next"]) {
    assert.ok(list.includes(c), `${c} gets its position: relative (the z-index needs one) from the hit-area rule`);
  }
  assert.strictEqual(valueOf(".ep-row:has(.ep-title-link:active)", "background"), "var(--surface-2)",
    "the card answers the press as one surface");
  assert.strictEqual(valueOf(".ep-row .info .show-link", "z-index"), "1", "the show link must sit above the stretched link");
});

test("the show link inside a row is a real target: ~26px tall, past WCAG 2.5.8, without moving a glyph", () => {
  /* Round 2, touch-6: a bare inline link, ~13px tall, with the episode link on
     every side of it. Vertical padding on an inline box grows its hit box and
     not the line; a vertical margin would do nothing, so writing one is a
     false claim (it was, on `.ep-ts`). MUTATION: `padding: 0` -> red;
     `margin: -5px -6px` -> red. */
  const [pv, ph] = (valueOf(".ep-row .info .show-link", "padding") || "").split(/\s+/).map(px);
  const [mv, mh] = (valueOf(".ep-row .info .show-link", "margin") || "").split(/\s+/).map((v) => (v === "0" ? 0 : px(v)));
  const fontPx = 0.82 * 16; // `.ep-row .s` is --fs-sm
  assert.ok(fontPx * 1.302 + 2 * pv >= 24, `hit height ${(fontPx * 1.302 + 2 * pv).toFixed(1)}px (DM Sans content area + padding)`);
  assert.ok(pv <= 6, "and no taller than the gap it has: the title line above, the second tier 8px below");
  assert.strictEqual(mv, 0, "no vertical margin — it would claim a reflow guard it cannot give");
  assert.strictEqual(mh, -ph, "the horizontal margin cancels the horizontal padding");
});

test("inline description timestamps grow into the half-leading and no further", () => {
  /* Round 2, touch-10: 10px of vertical padding made each stamp ~37px tall in
     a 21.6px line, so stamps on consecutive lines overlapped and the LATER one
     won — a tap on the bottom of 12:00 seeked to 15:30. The negative margin
     beside it did nothing vertically (inline box). Now the padding is at most
     the half-leading, so boxes on neighbouring lines meet and never overlap.
     MUTATION: `padding: 10px 4px; margin: -10px -4px` (round 1) -> red. */
  const [pv, ph] = (valueOf(".ep-ts", "padding") || "").split(/\s+/);
  const [mv, mh] = (valueOf(".ep-ts", "margin") || "").split(/\s+/);
  const em = /^(\d*\.?\d+)em$/.exec(pv || "");
  assert.ok(em, `the vertical padding is in em, so it scales with the text it pads (${pv})`);
  const lineHeight = Number(valueOf(".ep-description-text", "line-height"));
  assert.ok(lineHeight > 1, "fixture assumption: the description's line-height is unitless");
  const DM_SANS_CONTENT_EM = 1.302; // (ascender 992 + |descender| 310) / 1000
  assert.ok(DM_SANS_CONTENT_EM + 2 * Number(em[1]) <= lineHeight,
    `a stamp's box (${(DM_SANS_CONTENT_EM + 2 * Number(em[1])).toFixed(3)}em) must fit its ${lineHeight}em line`);
  assert.ok(Number(em[1]) > 0, "…and still reach it");
  assert.match(mv, /^0(px)?$/, "no vertical margin");
  assert.strictEqual(px(mh), -px(ph), "the horizontal margin cancels the horizontal padding: no reflow");
});

test('"Start over" is a real target and sits clear of the seek strip', () => {
  /* MUTATION: `.fy-restart { min-height: 0 }` -> red. MUTATION: `.fy-resume
     { margin-bottom: 10px }` -> the strip's 16px-up hit box would sit over
     "Start over"; red. */
  assert.ok(px(valueOf(".fy-restart", "min-height")) >= 44);
  const reach = -px(valueOf("#fy-strip::after", "top"));
  assert.ok(px(valueOf(".fy-resume", "margin-bottom")) >= reach,
    "the gap above the strip must cover the strip's upward hit box");
});

test("the Foray strip is 44px to hit, and its hit box never reaches the transport buttons", () => {
  /* MUTATION: delete `#fy-strip::after` -> red. MUTATION: `.fy-controls {
     margin-top: 10px }` -> the box overlaps Play by 6px; red. */
  const up = -px(valueOf("#fy-strip::after", "top"));
  const down = -px(valueOf("#fy-strip::after", "bottom"));
  const stripH = px(valueOf(".fy-strip--lg", "--strip-h"));
  assert.ok(stripH, "fixture assumption: the lg strip's height is a px custom property");
  assert.ok(stripH + up + down >= 44, `hit height ${stripH + up + down}px`);
  const controlsGap = px((valueOf(".fy-controls", "margin-top")));
  assert.ok(controlsGap > down, `the strip's ${down}px-down hit box must stop short of .fy-controls (${controlsGap}px)`);
});

test("a static strip inside a sideways rail hands every pan to the rail", () => {
  /* Round 2, touch-11: the Home card's strip inherited the live strip's
     `pan-y`, and touch-action intersects up the tree, so a sideways flick that
     started on the strip could not scroll the horizontal rail around it.
     MUTATION: `.fy-strip--static { touch-action: pan-y }` -> red. */
  assert.strictEqual(valueOf(".fy-strip--static", "touch-action"), "auto");
  assert.strictEqual(valueOf(".fy-strip", "touch-action"), "pan-y", "the live scrubber keeps its own");
});

test("a held in-app link opens no web preview and no callout, in the shell or the page", () => {
  /* Round 2, touch-3: a whole card is one `<a href="#/…">` (the stretched
     link), and a long-press opened WKWebView's peek of `capacitor://…`.
     MUTATIONS: delete `"allowsLinkPreview": false` -> red; delete the
     `a[href^="#/"]` rule -> red; give `.fy-chip` the transparent tap
     highlight (it has no press of its own on record here) -> red. */
  const cap = JSON.parse(fs.readFileSync(path.join(ROOT, "mobile/capacitor.config.json"), "utf8"));
  assert.strictEqual(cap.ios && cap.ios.allowsLinkPreview, false, "Capacitor's default is true: it has to be stated");
  assert.ok(cap.ios["//allowsLinkPreview"], "…with the reason beside it, like zoomEnabled");
  assert.strictEqual(valueOf('a[href^="#/"]', "-webkit-touch-callout"), "none");
  assert.strictEqual(valueOf('a[href^="#/"]', "-webkit-user-select"), "none");
  /* Every stretched link really is an in-app route, so the rule reaches it. */
  const app = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
  for (const cls of ["mc-link", "ep-title-link", "hv2-jbi-link"]) {
    assert.match(app, new RegExp(`<a class="[^"]*\\b${cls}\\b[^"]*" href="#/`), `.${cls} is an <a href="#/…">`);
  }
  /* The flash goes only where the card authors its own press. */
  const PRESS = {
    ".mc-link": ".mini-card:active",
    ".ep-row .ep-title-link": ".ep-row:has(.ep-title-link:active)",
    ".pl-row": ".pl-row:active",
    ".page-link-row": ".page-link-row:active",
    ".drawer-item": ".drawer-item:active",
    ".drawer-section": ".drawer-section:active",
  };
  const quiet = UNCONDITIONAL.filter((r) => r.decls.some((d) => d.prop === "-webkit-tap-highlight-color" && d.value === "transparent"))
    .flatMap((r) => r.selectors);
  assert.ok(quiet.length >= 1, "fixture assumption: the rule exists");
  for (const sel of quiet) {
    assert.ok(PRESS[sel], `${sel} drops the tap flash but no authored press is on record for it`);
    assert.ok(UNCONDITIONAL.some((r) => r.selectors.includes(PRESS[sel]) && r.decls.some((d) => /^background/.test(d.prop))),
      `${sel}: ${PRESS[sel]} must paint a background`);
  }
});

test("a vertical flick on the strip scrolls; only sideways movement scrubs", () => {
  /* The browser half of the fix (the gesture half is in
     player/strip-scrub-gesture.test.js). `none` refused vertical pans, so a
     scroll flick that started on the sticky strip scrolled nothing and then
     seeked. MUTATION: restore `touch-action: none` on `.fy-strip` -> red. */
  assert.strictEqual(valueOf(".fy-strip", "touch-action"), "pan-y");
});

test("the Now Playing scrub bar hands vertical pans to the sheet and keeps horizontal ones", () => {
  /* The one slider that already had this carries a comment describing this
     exact failure (`.interest-slider`). MUTATION: delete `touch-action: pan-y`
     from `.fp-scrub` -> red: a drag on the thumb scrolled the description. */
  assert.strictEqual(valueOf(".fp-scrub", "touch-action"), "pan-y");
  assert.ok(px(valueOf(".fp-scrub", "min-height")) >= 44);
});

test("the mini bar's open-the-player button fills the bar's height", () => {
  /* MUTATION: drop `align-self: stretch` -> the ~8px bands above and below
     the two text lines, which look like the bar, are dead again. */
  assert.strictEqual(valueOf(".fp-info", "align-self"), "stretch");
  assert.ok(px(valueOf(".fp-info", "min-height")) >= 44);
});

test("docked above the tab bar, the mini player does not add the home-indicator inset a second time", () => {
  /* The tab bar's own box already contains the inset. MUTATION: delete
     `padding-bottom: 0` from `body.ui-v2.fp-open #foray-player` -> red; a
     ~34px dead band of bar sits above the tab bar on a notched iPhone. */
  assert.match(valueOf("#foray-player", "padding-bottom") || "", /safe-area-inset-bottom/,
    "fixture assumption: the base rule pads by the inset for the on-the-edge case");
  assert.match(valueOf("body.ui-v2.fp-open #foray-player", "padding-bottom") || "", /^0(px)?$/);
});

test("Stop reads as a different control from the speed box beside it", () => {
  /* MUTATION: delete `body.ui-v2 .fp-stop { ... }` -> the shared v2 rule
     paints Stop the same grey as `1×`; red. (Close left the row in visual
     pass 1: the sheet's ✕ and handle are its two ways out, so Stop is alone at
     the danger end and the comparison is with its remaining boxed neighbour.) */
  assert.match(valueOf("body.ui-v2 .fp-stop", "color") || "", /var\(--danger-text\)/);
  assert.notStrictEqual(valueOf("body.ui-v2 .fp-stop", "color"), valueOf("body.ui-v2 .fp-rate", "color"));
  assert.strictEqual(valueOf(".fp-collapse", "color"), null, "no .fp-collapse rule is left");
});

/** WCAG 2 relative-luminance contrast between two #rrggbb colours. */
function contrast(a, b) {
  const lum = (hex) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
/** A token's hex on a scope: the last declaration of it in a rule on `sel`
    whose at-rule context is exactly `atRules`. */
function tokenOn(sel, token, atRules = []) {
  let v = null;
  for (const r of RULES) {
    if (!r.selectors.includes(sel) || r.atRules.join("|") !== atRules.join("|")) continue;
    for (const d of r.decls) if (d.prop === token) v = d.value;
  }
  return v;
}

test("Stop's label is readable: 4.5:1 on its own background in every theme", () => {
  /* Review 2026-09-23: `color: var(--danger)` put #b3402f on #2A2333 — 2.66:1,
     under even the large-text bar, on the sheet's most consequential button.
     MUTATION: set `--danger-text` back to #b3402f in `body.ui-v2` -> red. */
  const LIGHT = ["@media (prefers-color-scheme: light)"];
  const cases = [
    ["v2", tokenOn("body.ui-v2", "--danger-text"), tokenOn("body.ui-v2", "--surface2")],
    ["v1 dark", tokenOn(":root", "--danger-text"), tokenOn(":root", "--surface-2")],
    ["v1 light", tokenOn(":root", "--danger-text", LIGHT), tokenOn(":root", "--surface-2", LIGHT)],
  ];
  for (const [name, fg, bg] of cases) {
    assert.match(String(fg), /^#[0-9a-f]{6}$/i, `${name}: --danger-text is a hex`);
    assert.match(String(bg), /^#[0-9a-f]{6}$/i, `${name}: the surface is a hex`);
    assert.ok(contrast(fg, bg) >= 4.5, `${name}: ${fg} on ${bg} is ${contrast(fg, bg).toFixed(2)}:1`);
  }
  assert.match(valueOf(".fp-stop", "color") || "", /var\(--danger-text\)/, "v1 Stop reads the text token too");
});

test("a disabled player button looks disabled and does not light up on hover", () => {
  /* '››' is disabled on a Foray's last clip, but `.fp-btn` sets its own colours
     and a pointer, which switch off the browser's greyed-out look, and both
     hover rules still lit its border. MUTATION: delete `.fp-btn:disabled`, or put
     `.fp-btn:hover` back without `:not(:disabled)` -> red. */
  const opacity = Number(valueOf(".fp-btn:disabled", "opacity"));
  assert.ok(opacity > 0 && opacity < 0.6, `a disabled .fp-btn is dimmed (opacity ${opacity})`);
  assert.strictEqual(valueOf(".fp-btn:disabled", "cursor"), "default");
  for (const sel of [".fp-btn:hover", "body.ui-v2 .fp-btn:hover"]) {
    assert.ok(!UNCONDITIONAL.some((r) => r.selectors.includes(sel)), `${sel} must exclude :disabled`);
  }
  assert.ok(valueOf("body.ui-v2 .fp-btn:hover:not(:disabled)", "border-color"), "the v2 hover still exists for live buttons");
});

test("hover is not 'playing': a tapped ▶ does not light up as if audio had started", () => {
  /* A phone leaves a sticky :hover on the last thing tapped, and hover used
     to be the byte-identical fill of `[data-playing="1"]`. MUTATION: put
     `.play-btn:hover` back in the unconditional `[data-playing]` rule -> red. */
  const unconditionalHover = UNCONDITIONAL.filter((r) => r.selectors.some((s) => /\.play-btn:hover$/.test(s)));
  assert.deepStrictEqual(unconditionalHover.map((r) => r.prelude), [],
    "a .play-btn:hover rule outside `@media (hover: hover)` sticks on touch");
  const hoverRules = RULES.filter((r) => r.selectors.some((s) => /\.play-btn:hover$/.test(s)));
  for (const r of hoverRules) {
    assert.ok(r.atRules.some((a) => /hover:\s*hover/.test(a)), `${r.prelude} must live under @media (hover: hover)`);
    assert.ok(!r.decls.some((d) => /^background/.test(d.prop)), `${r.prelude} must not paint the playing fill`);
  }
});
