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
  assert.match(APP, /class="fy-btn"[^>]*>↺/, "the page's ↺ is a .fy-btn");
});

/* ---------- the mini bar ---------- */

test("the mini bar carries ▶ and a back-15 nudge, in that order, and nothing else", () => {
  /* MUTATION: `bar.append(art, info, playBtn)` (the one-control bar)
     -> red. MUTATION 2: add `fwdBtn` to the bar -> the third assertion names
     the crowding. (The live region is no longer on the bar — audit round 2,
     a11y-2: it is a sibling of the bar and the sheet, so expanding Now
     Playing cannot make it inert; player/now-playing-sheet.test.js pins it.) */
  assert.match(CODE, /const skipBtn = el\("button", "fp-skip", `↺ \$\{SEEK_BACK\}`\);/);
  assert.match(CODE, /skipBtn\.setAttribute\("aria-label", `Back \$\{SEEK_BACK\} seconds`\);/);
  assert.match(CODE, /bar\.append\(art, info, skipBtn, playBtn\);/, "art · title · ↺15 · ▶");
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
  assert.match(CODE, /ui\.clipNext\.disabled = Boolean\(foray\) && foray\.index >= foray\.playable\.length - 1;/);
  assert.doesNotMatch(CODE, /ui\.fwdBtn\.disabled/, "30↻ is never disabled — it is a seek, not a clip change");
  assert.match(CODE, /scroll\.append\(sArt, sTitle, sShow, chapterBox, sWhy, scrub, times, row, clips, row2,/, "the clip row sits under the seek pair");
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
  assert.match(steps, /return \{ back: \d+, fwd: \d+ \};/, "falls back to a literal pair for an older cached module (pinned below)");
  assert.match(APP, /const nudge = forayNudgeSteps\(player\);\n\n  \$\("#view"\)\.innerHTML = `\n    <div class="page foray">/, "renderForay reads the steps before it paints");
});

test("CH-38: the Foray page's nudge fallback is media-session.js's SEEK_BACKWARD_SEC / SEEK_FORWARD_SEC", async () => {
  /* A3-07: the fallback pair was pinned to the text "15/30", so a seek change
     in player/media-session.js left bridge-current pages on the new pair and
     the skew fallback on the old one, with this suite green. It is compared to
     the module's exports now. MUTATION: change SEEK_FORWARD_SEC to 45 in
     player/media-session.js -> red. */
  const { SEEK_BACKWARD_SEC, SEEK_FORWARD_SEC } = await import(
    require("node:url").pathToFileURL(path.join(ROOT, "player", "media-session.js")).href);
  const steps = APP.slice(APP.indexOf("function forayNudgeSteps("), APP.indexOf("function bindForayTransport("));
  const literal = /return \{ back: (\d+), fwd: (\d+) \};/.exec(steps);
  assert.ok(literal, "fixture: the fallback is a literal pair");
  assert.deepStrictEqual([Number(literal[1]), Number(literal[2])], [SEEK_BACKWARD_SEC, SEEK_FORWARD_SEC]);
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
  /* Stop first; the round-2 staples (⏭, Save, Up Next), PQ-13's Bookmark
     (#30) and SH-2's Share (#690) sit between the speed and the two navigation links, ⏭ and Save in the transport family's plain
     `.fp-btn` box so they are at the same tap floor. */
  assert.match(CODE, /row2\.append\(stopBtn, rateBtn, nextBtn, saveBtn, bookmarkBtn, shareBtn, queueLink, openLink, forayLink\);/, "Stop leads the row, alone at the danger end");
  assert.match(CODE, /ui\.closeBtn\.addEventListener\("click", \(\) => setExpanded\(false\)\);/, "the ✕ is the way out");
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

test("both speed buttons say they open a menu — the Foray page's as well as the sheet's", () => {
  /* Audit round 2, player-9, completed in the sweep: the sheet's rate button
     gained `aria-haspopup="dialog"` and the Foray page's `#fy-rate`, which opens
     the same `openRateMenu` dialog, did not — VoiceOver read one "pop-up button"
     and one plain button for the one control. MUTATION: drop the attribute
     from the `#fy-rate` markup -> red. */
  const tag = /<button[^>]*\bid="fy-rate"[^>]*>/.exec(APP);
  assert.ok(tag, "fixture assumption: the Foray page draws #fy-rate");
  assert.match(tag[0], /\baria-haspopup="dialog"/, "the Foray page's speed button does not say it opens a menu");
  assert.match(CODE, /rateBtn\.setAttribute\("aria-haspopup", "dialog"\);/, "the sheet's, for comparison");
  const menu = APP.slice(APP.indexOf("function openRateMenu("), APP.indexOf("function openRateMenu(") + 800);
  assert.match(menu, /panel\.setAttribute\("role", "dialog"\);/, "fixture assumption: what it opens is a dialog");
});

/* ---------- CH3-18 (R4-05, docs/roadmap/code-health-3.md): a native-lane nudge ----------

   In the native lane the ENGINE owns the playhead. A load the engine starts by
   itself (the wheel's ⏭, Continuous playback at an episode's end) is one the
   page did not ask for, so the page's `loadingStart` is not about it, and the
   snapshot's `positionSec` is 0 until the deck holds the item. A nudge in that
   window was computed from the page's 0 and sent as an absolute `seekTo`, so
   30↻ before the load landed started the episode at 0:30 and the resume point
   at 38:00 was overwritten.

   Harness: the real client.js in a pretend iOS shell over the reference
   engine, cut down from player/native-mode.test.js's `bootNative` (duplicated
   rather than imported, as test/engine-continuation.test.js does: importing a
   test file runs its tests). The engine-started load is a snapshot the
   reference cannot hold still (its fake deck reports the load's start at
   once), so it is pushed to the page as the Swift engine sends it. */

let nativeBootSeq = 0;

function nativeNode(tag) {
  return {
    tagName: String(tag).toUpperCase(), children: [], attrs: new Map(), listeners: new Map(),
    style: {}, dataset: {}, className: "", textContent: "", hidden: false,
    classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false },
    append(...kids) { for (const k of kids) this.children.push(k); },
    appendChild(k) { this.children.push(k); return k; },
    setAttribute(k, v) { this.attrs.set(k, String(v)); },
    getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; },
    removeAttribute(k) { this.attrs.delete(k); },
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); },
  };
}

/** Let the engine client's serial send reach the wire. */
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };

async function bootNativeClient(t) {
  const { pathToFileURL } = require("node:url");
  const { createReferenceEngine } = await import("../player/parity/reference-engine.js");
  const { __resetInstanceForTests } = await import("../player/queue-manager.js");
  let mono = 0;
  const scheduler = { nowMs: () => ++mono, schedule: () => () => {} };
  const ref = createReferenceEngine({ scheduler, now: () => 1_790_000_000_000 });
  const base = ref.asCapacitor({ platform: "ios" });
  /** Every transport command the page sent the engine, as the wire carried it. */
  const sent = [];
  const capacitor = {
    ...base,
    nativePromise(plugin, method, payload) {
      if (plugin === "ForayAudio" && method === "engineSend") sent.push(JSON.parse(JSON.stringify({ cmd: payload.cmd, args: payload.args })));
      return base.nativePromise(plugin, method, payload);
    },
  };
  const rows = new Map();
  const storage = {
    get length() { return rows.size; },
    key: (i) => [...rows.keys()][i] ?? null,
    getItem: (k) => (rows.has(k) ? rows.get(k) : null),
    setItem: (k, v) => { rows.set(k, String(v)); },
    removeItem: (k) => { rows.delete(k); },
  };
  const docListeners = new Map();
  const doc = {
    hidden: false,
    activeElement: null,
    body: nativeNode("body"),
    createElement: (tag) => nativeNode(tag),
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, new Set());
      docListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) { docListeners.get(type)?.delete(fn); },
    fire(type) { for (const fn of [...(docListeners.get(type) ?? [])]) fn(); },
  };
  const win = {
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true,
    Capacitor: capacitor,
    speechSynthesis: { speak() {}, cancel() {}, pause() {}, resume() {}, getVoices: () => [], addEventListener() {} },
    ForayMediaSession: { install: () => true, uninstall: () => true },
  };
  const names = ["window", "document", "localStorage", "navigator", "Event", "Audio"];
  const prev = new Map(names.map((n) => [n, Object.getOwnPropertyDescriptor(globalThis, n)]));
  const set = (n, value) => Object.defineProperty(globalThis, n, { value, writable: true, configurable: true });
  set("window", win);
  set("document", doc);
  set("localStorage", storage);
  set("navigator", { storage: { persisted: async () => false }, mediaSession: null });
  set("Event", class { constructor(type) { this.type = type; } });
  set("Audio", function Audio() { throw new Error("the native lane builds no <audio>"); });
  __resetInstanceForTests();
  const href = pathToFileURL(path.join(ROOT, "player", "client.js")).href;
  const client = (await import(`${href}?ch3-18=${++nativeBootSeq}`)).default;
  t.after(async () => {
    try {
      doc.hidden = true;
      doc.fire("visibilitychange");
      await settle();
    } finally {
      ref.dispose();
      for (const [n, d] of prev) {
        if (d) Object.defineProperty(globalThis, n, d);
        else delete globalThis[n];
      }
    }
  });
  assert.strictEqual(await client.whenEngineReady(), "native", "fixture premise: the native lane");
  /** Push a snapshot to the page the way the engine's event does: the
      reference's own, with `over` on top, newer than anything it has sent. */
  const push = async (over) => {
    const snapshot = { ...ref.snapshot(), ...over, seq: ref.snapshot().seq + 1000 };
    ref._emit({ type: "snapshot", snapshot });
    await settle();
    return snapshot;
  };
  return { client, ref, sent, push };
}

/** The Swift engine's snapshot while it loads `b` on its own (a wheel ⏭ off
    `a`): the deck does not hold `b` yet, so the playhead is 0 and nothing is
    measured; the resume point it is loading at lives only in the engine. */
const engineLoadingB = {
  mode: "episode", index: 0, itemId: "b", itemKind: "episode", state: "loadingItem",
  running: true, ended: false, buffering: false, inSeamGap: false, inInterlude: false,
  positionSec: 0, durationSec: null, sourceTimeSec: null, playheadItemId: "a",
  isNarrationPlayhead: false, effectiveRate: 0, canNext: false, canPrevious: true,
  nowPlaying: { title: "Title b", artist: "Show", album: "" },
};

test("CH3-18 characterization: a native-lane 30↻ during an engine-started load sends seekTo from the page's 0 (R4-05)", async (t) => {
  /* Today's behaviour, pinned so commit 2 flips it: `seekEpisodeBy` reads
     `episodePositionSec()` — the page's `loadingStart` is a's (or nothing), so
     it falls to the facade's playhead, the snapshot's 0 — and lands
     `skipTarget(0 + 30)` as an absolute seekTo. */
  const { client, sent, push } = await bootNativeClient(t);
  await push(engineLoadingB);
  const painted = client.restoreLastEpisode();
  await settle();
  assert.strictEqual(painted?.id, "b", "fixture premise: the bar is the engine's episode");
  const before = sent.length;
  await client.nudge(30);
  await settle();
  const nudges = sent.slice(before).filter((c) => c.cmd === "seekTo" || c.cmd === "seekBy");
  assert.deepStrictEqual(nudges, [{ cmd: "seekTo", args: { sec: 30 } }]);
});

test("CH3-18 characterization: off the native lane an episode nudge steps from the bar's position and lands through landEpisodeSeek", () => {
  /* The JS lane's rule is untouched by CH3-18: the element is the page's own,
     so the page's playhead IS the playhead (`episodePositionSec`'s
     `loadingStart` covers the cold load, transport-reconcile's ROUND 2
     p-impatient-1 runs it). Pinned as source so a native-lane change cannot
     quietly reach it. MUTATION: step from `backend.currentTime` instead of
     `episodePositionSec()` -> red. */
  const fn = CODE.slice(CODE.indexOf("function seekEpisodeBy("), CODE.indexOf("async function landEpisodeSeek("));
  assert.match(fn, /return landEpisodeSeek\(skipTarget\(\{\s*foray: false, positionSec: episodePositionSec\(\), offsetSec, durationSec: episodeDurationSec\(\),\s*\}\)\);/);
  assert.match(CODE, /seekBy: \(offset\) => seekEpisodeBy\(offset\),/, "the episode lock-screen surface is the same seek");
});
