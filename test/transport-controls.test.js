/* Visual pass 1 (2026-09-23): the transport's shape on every surface
 * (docs/audit/status.tsv persona rows 10 and 58).
 *
 *   - THE MINI BAR HAS TWO CONTROLS: ▶ and ↺15, both 44px, the skip
 *     borderless so the bar stays quiet. Stop stays in the sheet, in the
 *     danger colour (test/tap-targets.test.js holds that half).
 *   - THE SEEK PAIR IS THE SEEK PAIR: ↺15 / 30↻ in the sheet and on the Foray
 *     page in EVERY mode; previous/next clip are their own labelled row.
 *   - ONE NUDGE: every surface calls `nudgeBy` (the bridge's `nudge`), and the
 *     Foray page reads the step sizes from the bridge's `nudgeSteps`.
 *
 * The behavioural half — a ↺15 inside a Foray lands 15 s back in the same
 * clip, the clip row shows only for a Foray — boots the real module in
 * player/transport-reconcile.test.js ("VISUAL PASS" tests). This file pins the
 * markup, the wiring and the CSS, each with its killing mutation.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const APP = fs.readFileSync(path.join(ROOT, "app.js"), "utf8").replace(/\r\n/g, "\n");
const CLIENT = fs.readFileSync(path.join(ROOT, "player/client.js"), "utf8").replace(/\r\n/g, "\n");
const CSS = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8").replace(/\r\n/g, "\n");
const CODE = CLIENT.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
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
      if (c > 0 && d.slice(0, c).trim() === prop) v = d.slice(c + 1).trim();
    }
  }
  return v;
}
const px = (v) => { const m = /^(\d+(?:\.\d+)?)px$/.exec(String(v || "")); return m ? Number(m[1]) : null; };

/* ---------- the mini bar ---------- */

test("the mini bar carries ▶ and a back-15 nudge, in that order, and nothing else", () => {
  /* MUTATION: `bar.append(art, info, playBtn, announce)` (the one-control bar)
     -> red. MUTATION 2: add `fwdBtn` to the bar -> the third assertion names
     the crowding. */
  assert.match(CODE, /const skipBtn = el\("button", "fp-skip", `↺ \$\{SEEK_BACK\}`\);/);
  assert.match(CODE, /skipBtn\.setAttribute\("aria-label", `Back \$\{SEEK_BACK\} seconds`\);/);
  assert.match(CODE, /bar\.append\(art, info, skipBtn, playBtn, announce\);/, "art · title · ↺15 · ▶");
  const appended = /bar\.append\(([^)]*)\)/.exec(CODE)[1].split(",").map((s) => s.trim());
  assert.deepStrictEqual(appended.filter((n) => /Btn$/.test(n)), ["skipBtn", "playBtn"], "two controls on the bar, not three");
  assert.match(CODE, /ui\.skipBtn\.addEventListener\("click", \(\) => nudgeBy\(-SEEK_BACK\)\);/);
});

test("the bar's skip is a 44px borderless glyph beside the filled ▶", () => {
  /* MUTATION: `.fp-skip { width: 36px }` -> red (tap-targets lists it too). */
  assert.strictEqual(px(valueOf(".fp-skip", "width")), 44);
  assert.strictEqual(px(valueOf(".fp-skip", "height")), 44);
  assert.strictEqual(valueOf(".fp-skip", "border"), "0", "borderless: the bar's one filled control is ▶");
  assert.strictEqual(valueOf(".fp-skip", "background"), "none");
  assert.strictEqual(valueOf(".fp-skip", "border-radius"), "var(--radius-round)");
  assert.match(valueOf("body.ui-v2 .fp-play", "background") || "", /var\(--violet\)/, "▶ keeps the filled violet circle");
});

/* ---------- the sheet ---------- */

test("the sheet's ↺15 / 30↻ never repaint as ‹‹ / ›› and always call the one nudge", () => {
  /* MUTATION: put `isForay ? "‹‹" : …` back in setSkipButtonMode, or
     `foray ? ForayPlayer.forayPrevious() : seekEpisodeBy(-SEEK_BACK)` back in
     the handler -> red. */
  assert.doesNotMatch(CODE, /"‹‹"|"››"/, "no glyph swap anywhere in the module");
  assert.match(CODE, /ui\.backBtn\.addEventListener\("click", \(\) => nudgeBy\(-SEEK_BACK\)\);/);
  assert.match(CODE, /ui\.fwdBtn\.addEventListener\("click", \(\) => nudgeBy\(SEEK_FWD\)\);/);
  const mode = CODE.slice(CODE.indexOf("function setSkipButtonMode("), CODE.indexOf("window.ForayPlayer = ForayPlayer;"));
  assert.match(mode, /ui\.clips\.hidden = !isForay;/, "the clip row is what a Foray switches on");
  assert.match(mode, /paintControl\(ui\.backBtn, `↺ \$\{SEEK_BACK\}`, `Back \$\{SEEK_BACK\} seconds`\);/);
  assert.match(mode, /paintControl\(ui\.fwdBtn, `\$\{SEEK_FWD\} ↻`, `Forward \$\{SEEK_FWD\} seconds`\);/);
});

test("the one nudge: inside a Foray it seeks on the Foray clock, otherwise on the episode's", () => {
  /* MUTATION: make `nudgeBy` call `seekEpisodeBy` unconditionally -> a Foray
     nudge seeks the source episode's clock and skips the clip boundary rule. */
  const fn = CODE.slice(CODE.indexOf("function nudgeBy("), CODE.indexOf("function render()"));
  /* Audit round 2 (player-5): the Foray step is clamped one second short of
     the end, like the episode's, before it goes to `foraySeek`. */
  assert.match(fn, /if \(!foray\) return seekEpisodeBy\(offset\);/);
  assert.match(fn, /const ceiling = Math\.max\(0, foray\.resolved\.totalSec - SEEK_END_GUARD_SEC\);/);
  assert.match(fn, /return ForayPlayer\.foraySeek\(target\);/);
  assert.match(CODE, /seekBy: \(offset\) => nudgeBy\(offset\),/, "the lock screen's seek is the same nudge");
  assert.match(CODE, /nudge\(offsetSec\) \{ return nudgeBy\(offsetSec\); \},/, "the bridge exposes it to the page");
  assert.match(CODE, /nudgeSteps\(\) \{ return \{ back: SEEK_BACK, fwd: SEEK_FWD \}; \},/, "and the step sizes");
});

test("previous/next clip are a labelled row: words, 44px tall, next disabled on the last clip", () => {
  /* MUTATION: `el("button", "fp-clip fp-clip-next", "››")` -> red. */
  assert.match(CODE, /const clipPrev = el\("button", "fp-clip fp-clip-prev", "‹ Previous clip"\);/);
  assert.match(CODE, /const clipNext = el\("button", "fp-clip fp-clip-next", "Next clip ›"\);/);
  /* The accessible name is the words alone — a guillemet in the name is read
     out as "single left-pointing angle quotation mark" (review, 2026-09-23).
     MUTATION: drop either setAttribute -> red. */
  assert.match(CODE, /clipPrev\.setAttribute\("aria-label", "Previous clip"\);/);
  assert.match(CODE, /clipNext\.setAttribute\("aria-label", "Next clip"\);/);
  assert.match(CODE, /ui\.clipNext\.disabled = Boolean\(foray\) && foray\.index >= foray\.resolved\.playable\.length - 1;/);
  assert.doesNotMatch(CODE, /ui\.fwdBtn\.disabled/, "30↻ is never disabled — it is a seek, not a clip change");
  assert.match(CODE, /scroll\.append\(sArt, sTitle, sShow, sWhy, scrub, times, row, clips, row2,/, "the clip row sits under the seek pair");
  assert.ok(px(valueOf(".fp-clip, .fy-clip", "min-height")) >= 44);
  assert.ok(px(valueOf(".fp-clip, .fy-clip", "min-width")) >= 44);
  assert.match(valueOf(".fp-clip:disabled, .fy-clip:disabled", "opacity") || "", /^0\.\d+$/);
});

/* ---------- the Foray page ---------- */

test("the Foray page's transport is ↺15 · Play · 30↻ · speed, with a clip row beneath", () => {
  /* MUTATION: `<button … id="fy-prev" aria-label="Previous clip">‹‹</button>`
     back in the .fy-controls row -> red. */
  const page = APP.slice(APP.indexOf('<div class="fy-controls">'), APP.indexOf('<p class="fy-error"'));
  const ids = [...page.matchAll(/id="(fy-[a-z]+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(ids, ["fy-back", "fy-play", "fy-fwd", "fy-rate", "fy-prev", "fy-next"]);
  assert.match(page, /id="fy-back" aria-label="Back \$\{nudge\.back\} seconds">↺ \$\{nudge\.back\}</, "the step comes from the bridge");
  assert.match(page, /id="fy-fwd" aria-label="Forward \$\{nudge\.fwd\} seconds">\$\{nudge\.fwd\} ↻</);
  assert.match(page, /<div class="fy-clips">\s*<button type="button" class="fy-clip" id="fy-prev" aria-label="Previous clip">‹ Previous clip<\/button>\s*<button type="button" class="fy-clip" id="fy-next" aria-label="Next clip">Next clip ›<\/button>/,
    "labelled in words, with the guillemet kept out of the accessible name");
  assert.doesNotMatch(page, /‹‹|››/, "no glyph-only clip control on the page");
});

test("the Foray page's nudges call the bridge's nudge, start the Foray before it has begun, and read the steps from the bridge", () => {
  /* MUTATION: bind #fy-back to `player.forayPrevious()` -> red. MUTATION 2:
     hardcode 15/30 in the template instead of `forayNudgeSteps(player)`. */
  assert.match(APP, /\$\("#fy-back"\)\.addEventListener\("click", \(\) => playerHasForay\(r\) \? guardForayTap\(\(\) => player\.nudge\(-nudge\.back\)\) : startOrResume\(\)\);/);
  assert.match(APP, /\$\("#fy-fwd"\)\.addEventListener\("click", \(\) => playerHasForay\(r\) \? guardForayTap\(\(\) => player\.nudge\(nudge\.fwd\)\) : startOrResume\(\)\);/);
  assert.match(APP, /\["#fy-play", "#fy-next", "#fy-prev", "#fy-back", "#fy-fwd"\]\.forEach\(sel => \{ \$\(sel\)\.disabled = true; \}\);/,
    "an empty Foray disables the nudges with the rest");
  const steps = APP.slice(APP.indexOf("function forayNudgeSteps("), APP.indexOf("function bindForayTransport("));
  assert.match(steps, /player\.nudgeSteps\(\)/, "reads the bridge");
  assert.match(steps, /return \{ back: 15, fwd: 30 \};/, "falls back to the documented pair for an older cached module");
  assert.match(APP, /const nudge = forayNudgeSteps\(player\);\n\n  \$\("#view"\)\.innerHTML = `\n    <div class="page foray">/, "renderForay reads the steps before it paints");
});

/* ---------- the sheet's shape, after the review of visual pass 1 (2026-09-23) ---------- */

test("the sheet's Play is the bar's Play, scaled: one filled round object, not a grey box like the skips", () => {
  /* Four play affordances shipped; the sheet's primary ▶ was the unfilled one,
     a rounded square identical to ↺15 / 30↻ beside it. MUTATION: delete
     `.fp-btn.fp-big { … border-radius: var(--radius-round) … }` -> red. */
  assert.strictEqual(valueOf(".fp-btn.fp-big", "border-radius"), "var(--radius-round)", "round, like .fp-play");
  assert.strictEqual(valueOf(".fp-play", "border-radius"), "var(--radius-round)");
  assert.ok(px(valueOf(".fp-btn.fp-big", "width")) >= 56 && px(valueOf(".fp-btn.fp-big", "height")) >= 56, "and it leads the row");
  assert.strictEqual(valueOf("body.ui-v2 .fp-btn.fp-big", "background"), "var(--violet)", "the same fill as the bar's ▶ under ui-v2");
  assert.strictEqual(valueOf("body.ui-v2 .fp-play", "background"), "var(--violet)");
  assert.strictEqual(valueOf("body.ui-v2 .fp-btn.fp-big", "color"), valueOf("body.ui-v2 .fp-play", "color"));
  /* The skips stay the quiet boxed pair. */
  assert.strictEqual(valueOf(".fp-btn", "border-radius"), "var(--radius-md)");
  assert.strictEqual(valueOf("body.ui-v2 .fp-btn", "background"), "var(--surface2)");
});

test("the sheet's second row is one treatment: 44px boxes at the body step, a quiet text link, and no second Close", () => {
  /* It mixed a caption-size grey box, a danger box, a bare underlined link and
     a Close beside the grab zone's ✕. MUTATION: `.fp-rate, .fp-stop { padding:
     8px 12px; font-size: var(--fs-xs) }` -> red; `el("button", "fp-collapse",
     "Close")` back in client.js -> red. */
  assert.ok(px(valueOf(".fp-rate, .fp-stop", "min-height")) >= 44, "the boxed controls are at the tap floor by their own size");
  assert.strictEqual(valueOf(".fp-rate, .fp-stop", "font-size"), valueOf(".fy-btn", "font-size"),
    "the speed control reads the same step here as on the Foray page");
  assert.strictEqual(valueOf(".fp-rate", "font-variant-numeric"), "tabular-nums", "1× -> 1.25× does not jitter");
  assert.ok(px(valueOf(".fp-openep", "min-height")) >= 44, "'Episode' is a 44px text button");
  assert.strictEqual(valueOf(".fp-openep", "text-decoration"), "none", "…not an underlined inline link");
  assert.doesNotMatch(CODE, /"fp-collapse"/, "no Close button is built");
  assert.doesNotMatch(CODE, /ui\.collapse/, "…and nothing is wired to one");
  assert.match(CODE, /row2\.append\(stopBtn, rateBtn, openLink, forayLink\);/, "Stop leads the row, alone at the danger end");
  assert.match(CODE, /ui\.closeBtn\.addEventListener\("click", \(\) => setExpanded\(false\)\);/, "the ✕ is the way out");
  assert.strictEqual(valueOf(".fp-collapse", "color"), null, "and its rule is gone");
});
