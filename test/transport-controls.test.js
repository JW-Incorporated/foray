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
const { readAppSource } = require("./helpers/app-source.js");

const ROOT = path.join(__dirname, "..");
const APP = readAppSource().replace(/\r\n/g, "\n");
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

/* ---------- one transport button on every surface (audit round 2, visual-5) ---------- */

test("the seek pair and the speed box are one object on the Foray page and in Now Playing", () => {
  /* ↺15 / 30↻ were 60x48 bold 0.9rem LIFTED on the page and 56x48 regular
     0.82rem FLAT in the sheet; speed was 48px on one and 44px on the other
     under a comment claiming they matched. One rule sizes all of them now,
     and neither surface restates what it sets.
     MUTATIONS, each red: `.fp-btn { font-size: var(--fs-sm) }` (the sheet's old
     step); `.fy-btn { box-shadow: var(--shadow) }` (the page's old lift);
     `.fp-rate { min-height: 44px }` (the old speed height). */
  const FAMILY = ".fy-btn, .fp-btn, .fp-rate, .fp-stop";
  assert.strictEqual(px(valueOf(FAMILY, "min-height")), 48, "48px: a car product (the note on .fp-play)");
  assert.strictEqual(valueOf(FAMILY, "font-size"), "var(--fs-md)");
  assert.strictEqual(valueOf(FAMILY, "font-weight"), "600");
  assert.strictEqual(valueOf(FAMILY, "border-radius"), "var(--radius-md)");
  assert.strictEqual(valueOf(".fy-btn, .fp-btn", "min-width"), "56px", "the seek pair is one width on both surfaces");
  /* Nobody restates a family declaration on one surface only — that is how
     the two drifted. Checked on every rule that names exactly one member. */
  const SHARED = ["min-height", "height", "font-size", "font-weight", "box-shadow", "min-width"];
  const restated = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(SRC))) {
    const sels = splitSelectors(m[1]);
    if ([FAMILY, ".fy-btn, .fp-btn", ".fy-btn.fy-rate, .fp-rate"].includes(sels.join(", "))) continue;
    for (const sel of sels) {
      if (!/^(body\.ui-v2 )?\.(fy-btn|fp-btn|fp-rate|fp-stop)$/.test(sel)) continue;
      for (const d of m[2].split(";")) {
        const prop = d.slice(0, d.indexOf(":")).trim();
        if (SHARED.includes(prop) && !/:disabled|:hover/.test(sel)) restated.push(`${sel} { ${d.trim()} }`);
      }
    }
  }
  assert.deepStrictEqual(restated, [], "a surface restating the family's metrics");
  /* The speed box: one rule, both surfaces, 48 tall by the family. */
  assert.strictEqual(valueOf(".fy-btn.fy-rate, .fp-rate", "font-variant-numeric"), "tabular-nums");
  assert.strictEqual(valueOf(".fy-btn.fy-rate, .fp-rate", "min-width"), "52px");
  assert.strictEqual(valueOf("body.ui-v2 .fy-btn.fy-rate, body.ui-v2 .fp-rate", "color"), "var(--muted)", "one colour for speed on both");
  /* The comment that claimed 44 is gone. */
  assert.doesNotMatch(CSS, /metrics \(44px, body step/, "no comment may promise a height neither surface has");
  /* And both renderers really do use these classes for the same controls. */
  assert.match(CLIENT, /el\("button", "fp-btn", `↺ \$\{SEEK_BACK\}`\)/);
  /* REWRITTEN ON PURPOSE (Tactile `foray`): the Foray page's ↺ was a `.fy-btn`; the page no
     longer has a seek pair (one pinned Play key, BUILD-PLAN 2.17), so what is left of "one
     object on both surfaces" is the sheet's own pair and the load-failure keys that still
     wear `.fy-btn`. MUTATION: draw a `.fy-btn` ↺ on the Foray page again -> the page test
     below ("the Foray page's transport is one pinned key") goes red. */
});

/* ---------- the mini bar ---------- */

test("the mini bar carries ▶ and a 30-forward nudge, and nothing else", () => {
  /* REWRITTEN ON PURPOSE (Redesign 2026, Tactile `mini`, BUILD-PLAN 2.4): the
     Dial mini is Play 48 + the 30-FORWARD keycap 44, where the old bar had
     back 15. The ruling that fell is the mini's transport pair; what stays
     guaranteed is two controls, not three, and a label that says what the
     click does (the glyph, the aria-label and the handler agree).
     MUTATION: `bar.append(art, info, playBtn)` (the one-control bar) -> red.
     MUTATION 2: add `fwdBtn` to the bar -> the third assertion names the
     crowding. MUTATION 3: point the handler back at `nudgeBy(-SEEK_BACK)` -> red.
     (The live region is no longer on the bar — audit round 2, a11y-2: it is a
     sibling of the bar and the sheet, so expanding Now Playing cannot make it
     inert; player/now-playing-sheet.test.js pins it.) */
  assert.match(CODE, /const skipBtn = el\("button", "fp-skip", \x60\$\{SEEK_FWD\} ↻\x60\);/);
  assert.match(CODE, /skipBtn\.setAttribute\("aria-label", \x60Forward \$\{SEEK_FWD\} seconds\x60\);/);
  assert.match(CODE, /bar\.append\(art, info, skipBtn, playBtn\);/, "art · title · +30 · ▶ (ui/mini.js puts ▶ first)");
  const appended = /bar\.append\(([^)]*)\)/.exec(CODE)[1].split(",").map((s) => s.trim());
  assert.deepStrictEqual(appended.filter((n) => /Btn$/.test(n)), ["skipBtn", "playBtn"], "two controls on the bar, not three");
  assert.match(CODE, /ui\.skipBtn\.addEventListener\("click", \(\) => nudgeBy\(SEEK_FWD\)\);/);
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
  /* Tactile adds ONE haptic tick ahead of the nudge (R-class rewrite: the old
     pin was the bare `() => nudgeBy(..)`; the ruling that fell is only "the
     handler body is exactly the nudge"). It must still end in the one nudge and
     nothing else may sit in the body. MUTATION: replace the body with
     `foray ? ForayPlayer.forayPrevious() : seekEpisodeBy(-SEEK_BACK)` -> red. */
  const HAPTIC = String.raw`(?:window\.DialNowPlaying\?\.haptic\?\.\("light"\); )?`;
  assert.match(CODE, new RegExp(String.raw`ui\.backBtn\.addEventListener\("click", \(\) => (?:\{ ${HAPTIC}nudgeBy\(-SEEK_BACK\); \}|nudgeBy\(-SEEK_BACK\))\);`));
  assert.match(CODE, new RegExp(String.raw`ui\.fwdBtn\.addEventListener\("click", \(\) => (?:\{ ${HAPTIC}nudgeBy\(SEEK_FWD\); \}|nudgeBy\(SEEK_FWD\))\);`));
  const mode = CODE.slice(CODE.indexOf("function setSkipButtonMode("), CODE.indexOf("window.ForayPlayer = ForayPlayer;"));
  assert.match(mode, /ui\.clips\.hidden = !isForay;/, "the clip row is what a Foray switches on");
  assert.match(mode, /paintControl\(ui\.backBtn, `↺ \$\{SEEK_BACK\}`, `Back \$\{SEEK_BACK\} seconds`\);/);
  assert.match(mode, /paintControl\(ui\.fwdBtn, `\$\{SEEK_FWD\} ↻`, `Forward \$\{SEEK_FWD\} seconds`\);/);
});

test("the one nudge: inside a Foray it seeks on the Foray clock, otherwise on the episode's", () => {
  /* MUTATION: make `nudgeBy` call `seekEpisodeBy` unconditionally -> a Foray
     nudge seeks the source episode's clock and skips the clip boundary rule. */
  const fn = CODE.slice(CODE.indexOf("function nudgeBy("), CODE.indexOf("function render()"));
  /* NE-08 + audit round 2 (player-5, player-11): where the step lands is
     `skipTarget`'s, given the Foray's total so a Foray nudge stops one second
     short of the end like the episode's; what a nudge inside a spoken line
     does is `nudgeAction`'s (both fixture-pinned by the `transport` family).
     What stays here is the routing. */
  assert.match(fn, /if \(!foray\) return seekEpisodeBy\(offset\);/);
  assert.match(fn, /skipTarget\(\{\s*foray: true, positionSec: forayPosition\(\), offsetSec: offset, durationSec: foray\.resolved\.totalSec,\s*\}\)/);
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

test("the Foray page's transport is ONE pinned key, and the seek pair, speed and clip row live on the sheet", () => {
  /* REWRITTEN ON PURPOSE (Redesign 2026, Tactile `foray`, BUILD-PLAN 2.17): the page's
     ↺15 · Play · 30↻ · speed row and its Previous/Next clip row (visual pass 1, persona
     58) fell to ONE extended persimmon key pinned over the deck; the nudges, speed and
     clip stepping are the Now Playing sheet's, which this suite pins above. What stays
     guaranteed is that the page has a way to play, that it is a labelled button, and
     that no second transport grows back on it.
     MUTATION: put `<button type="button" class="fy-btn" id="fy-back" aria-label="Back 15
     seconds">` (or id fy-fwd / fy-rate / fy-prev / fy-next) back in renderForay -> red. */
  const page = APP.slice(APP.indexOf("function forayPinHtml("), APP.indexOf("function forayStateName("));
  const ids = [...page.matchAll(/id="(fy-[a-z]+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(ids, ["fy-play"], "the pin is the page's one transport control");
  assert.match(page, /<button type="button" class="keycap keycap--persimmon keycap--lg keycap--round keycap--pin" id="fy-play"/);
  const from = APP.indexOf("async function renderForay(");
  const render = APP.slice(from, APP.indexOf("joinForayCreditsToShowIndex(r, player);", from));
  for (const gone of ["fy-back", "fy-fwd", "fy-rate", "fy-prev", "fy-next", "fy-clips", "fy-controls"]) {
    assert.doesNotMatch(render, new RegExp(gone), `${gone} must not come back on the Foray page`);
  }
  assert.doesNotMatch(render, /‹‹|››|↺|↻/, "no glyph-only transport anywhere on the page");
});

test("the Foray page binds only the pin and the clip rows, starts a cold Foray from either, and an empty Foray disables the pin", () => {
  /* REWRITTEN ON PURPOSE (Tactile `foray`): this pinned the ↺/↻ handlers and
     `forayNudgeSteps`; both went with the transport row. What a press must still do:
     a live Foray toggles, a cold one starts or resumes, and a Foray with nothing
     playable says so on the key rather than firing a dead handler.
     MUTATION: bind `#fy-play` to `player.forayPrevious()` -> red. MUTATION 2: drop the
     `!r.playable.length` branch -> red. */
  const bind = APP.slice(APP.indexOf("function bindForayTransport("), APP.indexOf("function playerHasForay("));
  assert.match(bind, /\$\("#fy-play"\)\.addEventListener\("click", async \(\) => \{\s*if \(playerHasForay\(r\)\) return guardForayTap\(\(\) => player\.forayToggle\(\)\);/);
  assert.match(bind, /if \(!r\.playable\.length\) \{[\s\S]*?play\.disabled = true;[\s\S]*?"Nothing to play"/, "an empty Foray disables the key and says why");
  assert.doesNotMatch(APP, /forayNudgeSteps/, "the page no longer reads nudge steps; only the sheet does");
  assert.doesNotMatch(bind, /fy-back|fy-fwd|fy-next|fy-prev|fy-strip|fy-rate/, "no other transport is bound");
  assert.match(bind, /\$\("#view"\)\.querySelectorAll\("\[data-fy\]"\)/, "the clip rows still start the Foray at their clip");
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

test("the sheet's second row is one treatment: 48px transport boxes, a quiet text link, and no second Close", () => {
  /* It mixed a caption-size grey box, a danger box, a bare underlined link and
     a Close beside the grab zone's ✕. MUTATION: `.fp-rate, .fp-stop { padding:
     8px 12px; font-size: var(--fs-xs) }` -> red (the shared rule's size is
     out-ranked); `el("button", "fp-collapse", "Close")` back in client.js -> red. */
  const FAMILY = ".fy-btn, .fp-btn, .fp-rate, .fp-stop";
  assert.ok(px(valueOf(FAMILY, "min-height")) >= 44, "the boxed controls are at the tap floor by their own size");
  /* No member of the row restates the family's height or type step on its own:
     "one object on the Foray page and in Now Playing" checks every rule that
     names one member. */
  assert.strictEqual(valueOf(".fp-rate", "font-variant-numeric"), "tabular-nums", "1× -> 1.25× does not jitter");
  assert.ok(px(valueOf(".fp-openep", "min-height")) >= 44, "'Episode' is a 44px text button");
  assert.strictEqual(valueOf(".fp-openep", "text-decoration"), "none", "…not an underlined inline link");
  assert.doesNotMatch(CODE, /"fp-collapse"/, "no Close button is built");
  assert.doesNotMatch(CODE, /ui\.collapse/, "…and nothing is wired to one");
  /* Stop first; the round-2 staples (⏭, Save, Up Next) and PQ-13's Bookmark
     (#30) sit between the speed and the two navigation links, ⏭ and Save in the transport family's plain
     `.fp-btn` box so they are at the same tap floor. */
  assert.match(CODE, /row2\.append\(stopBtn, rateBtn, nextBtn, saveBtn, bookmarkBtn, queueLink, openLink, forayLink\);/, "Stop leads the row, alone at the danger end");
  /* R-class rewrite: the ✕ now goes through `requestExpanded` (the Now Playing
     art-to-sheet transition wraps `setExpanded`). It must still reach
     `setExpanded(open)` with no transition present. MUTATION: drop the `else
     setExpanded(open)` branch of requestExpanded -> the second assert goes red. */
  assert.match(CODE, /ui\.closeBtn\.addEventListener\("click", \(\) => requestExpanded\(false\)\);/, "the ✕ is the way out");
  assert.match(CODE, /requestExpanded = \(open\) => \{[^]*?\} else setExpanded\(open\);\s*\};/, "…and without the transition it is setExpanded itself");
  assert.strictEqual(valueOf(".fp-collapse", "color"), null, "and its rule is gone");
});

test("ROUND 2 review: the sheet's six-control second row wraps, and ⏭/Save are actions, not the muted speed readout", () => {
  /* Stop, 1×, ⏭, Save, "Up Next (N)" and "Episode" need ~380px against a
     375px phone's 343px content box, and the row did not wrap; ⏭ and Save
     borrowed `.fp-rate`, whose colour and weight are the speed readout's.
     MUTATIONS: drop `flex-wrap: wrap` from .fp-row2; build ⏭ or Save with
     "fp-rate" again; delete the pressed-state rule. */
  assert.strictEqual(valueOf(".fp-row2", "flex-wrap"), "wrap", "the row wraps at phone width");
  assert.doesNotMatch(CODE, /el\("button", "fp-rate fp-(next|save)"/, "⏭ and Save do not wear the speed readout's box");
  assert.match(CODE, /el\("button", "fp-btn fp-next", "⏭"\)/);
  assert.match(CODE, /el\("button", "fp-btn fp-save", "Save"\)/);
  for (const sel of [".fp-next, .fp-save", ".fp-upnext"]) assert.ok(SRC.includes(`${sel} {`), `${sel} has its own rule`);
  assert.ok(valueOf('.fp-save[aria-pressed="true"]', "color"), "Save shows its pressed state");
  assert.ok(valueOf('body.ui-v2 .fp-save[aria-pressed="true"]', "color"), "…in the v2 theme too");
});

test("the sheet's speed button says it opens a menu, and the Foray page no longer carries one", () => {
  /* REWRITTEN ON PURPOSE (Tactile `foray`): the pin was "both speed buttons say they open a
     menu — the Foray page's as well as the sheet's" (audit round 2, player-9). The page's
     `#fy-rate` and `openRateMenu` went with its transport row; the speed is the sheet's.
     MUTATION: drop `rateBtn.setAttribute("aria-haspopup", "dialog")` from client.js -> red.
     MUTATION 2: draw `id="fy-rate"` on the Foray page again -> the second assertion is red. */
  assert.match(CODE, /rateBtn\.setAttribute\("aria-haspopup", "dialog"\);/, "the sheet's button still says it");
  assert.doesNotMatch(APP, /id="fy-rate"|openRateMenu/, "and the page has no second speed control");
});
