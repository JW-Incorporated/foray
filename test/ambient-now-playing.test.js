const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const css = read("ui/now-playing.css");
const ui = read("ui/now-playing.js");
const client = read("player/client.js");
const tokens = read("ui/tokens.css");

test("Now Playing ships as an adopted artwork-lit Room in both player lanes", () => {
  /* MUTATION: remove the ui/now-playing.js script tag from index.html -> red. */
  const html = read("index.html");
  assert.match(html, /ui\/primitives\.css[\s\S]*ui\/now-playing\.css/);
  assert.match(html, /ui\/primitives\.js[\s\S]*ui\/now-playing\.js[\s\S]*ui\/gallery\.js/);
  assert.equal((client.match(/AfterglowNowPlaying\?\.adopt\(ui\)/g) || []).length, 2, "native and JS boot adopt the screen");
  assert.match(ui, /classList\.add\("room", "ag-np"\)/);
  assert.match(css, /\.ag-np\.fp-sheet::after\s*\{[^}]*--rs1:[^}]*--rs2:/s, "the Room keeps the two pixel-stop scrim boundaries");
  for (const rel of ["tools/ci/generate-manifest.mjs", "tools/mobile/prepare-webdir.mjs", "tools/web/prepare-dist.mjs"]) {
    assert.match(read(rel), /ui\/now-playing\.css/, `${rel} ships the screen stylesheet`);
  }
});

test("glance posture pins safe geometry, responsive artwork and reachable controls", () => {
  /* MUTATION: change the short-height artwork override from 220px to 219px -> red. */
  assert.match(css, /--np-art:\s*clamp\(220px,\s*calc\(100dvh - 520px\),\s*320px\)/);
  assert.match(css, /@media \(max-height: 700px\)[\s\S]*?\.ag-np\s*\{\s*--np-art:\s*220px;/);
  assert.match(css, /\.ag-np\.is-long-title\s*\{[^}]*clamp\(180px,/);
  assert.match(css, /ag-np-textscale \.ag-np\s*\{\s*--np-art:\s*160px;/);
  assert.match(css, /ag-np-textscale \.ag-np\.fp-sheet \.fp-s-why\s*\{\s*display:\s*none;/);
  assert.match(css, /\.ag-np-first\s*\{[^}]*min-height:\s*100%[^}]*safe-top/s);
  assert.match(css, /\.ag-np\.fp-sheet \.ag-np-play\.fp-big\s*\{[^}]*width:\s*88px;[^}]*height:\s*88px;/s);
  assert.match(css, /\.ag-np-detail-handle\s*\{[^}]*height:\s*44px;[^}]*safe-bottom/s);
  assert.doesNotMatch(css, /@media\s*\(prefers-reduced-motion/, "the direction owns one reduced-motion block in tokens.css");
  assert.equal((tokens.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)/g) || []).length, 1);
});

test("Foray and episode progress expose proportional 44px seek targets and a quiet slider", () => {
  /* MUTATION: change the Foray seek label prefix from 'Seek to' to 'Jump to' -> red. */
  assert.match(ui, /setAttribute\("aria-label", `Seek to \$\{name\}, \$\{agNpClock\(starts\[segment\.index\] \|\| 0\)\}`\)/);
  assert.match(ui, /setProperty\("--grow", String\(segment\.grow \|\| 1\)\)/);
  assert.match(ui, /kind === "tts" \? "var\(--lamp\)" : agNpColour/);
  assert.match(ui, /button\.addEventListener\("click", \(\) => onSeek\?\.\(starts\[segment\.index\] \|\| 0\)\)/);
  assert.match(css, /\.ag-np-strip-button\s*\{[^}]*height:\s*44px;/s);
  assert.match(css, /\.ag-np-strip-bar\s*\{[^}]*height:\s*16px;/s);
  assert.match(css, /\.ag-np-strip-button\.is-current \.ag-np-strip-bar\s*\{[^}]*height:\s*20px;/s);
  assert.match(css, /\.ag-np-strip-bar\.is-narration[^}]*height:\s*4px;/s);
  assert.match(css, /transform-origin:\s*left/);
  assert.match(css, /slider-runnable-track\s*\{[^}]*height:\s*4px;/s);
  assert.match(css, /slider-thumb\s*\{[^}]*width:\s*16px;[^}]*height:\s*16px;/s);
  assert.match(client, /paintClocks\(pos, dur, !held && !\(ui\.ag && document\.activeElement === ui\.scrub\)\)/, "ticks do not rewrite the focused Afterglow slider's spoken value");
  assert.match(client, /addEventListener\("change"[\s\S]*if \(ui\.ag\) paintClocks\([^;]+, true\)/, "a committed change updates aria-valuetext");
});

test("motion, detail posture and dynamic content keep the final Afterglow contracts", () => {
  /* MUTATION: change the segment caption hold from 3000ms to 2999ms -> red. */
  assert.match(tokens, /--m-room:\s*560ms/);
  assert.match(tokens, /--m-ui:\s*280ms/);
  assert.match(ui, /setTimeout\(\(\) => ui\.eyebrow\.classList\.remove\("is-lit"\), 3000\)/);
  assert.match(css, /@keyframes ag-np-art-out\s*\{\s*to\s*\{[^}]*translateX\(-24%\)[^}]*opacity:\s*\.4/s);
  assert.match(css, /@keyframes ag-np-art-in\s*\{\s*from\s*\{[^}]*translateX\(100%\)/s);
  assert.match(css, /is-frozen-ending \.ag-np-art-out[^}]*translateX\(-36%\)[^}]*opacity:\s*\.2/s);
  assert.match(css, /\.ag-np-actions\s*\{[^}]*justify-content: space-around/s);
  assert.match(css, /\.ag-np-source-grid\s*\{[^}]*repeat\(3,/s);
  assert.match(css, /-webkit-line-clamp:\s*4/);
  assert.match(ui, /"4a added"/);
  assert.match(client, /document\.startViewTransition/);
  assert.match(client, /duration: 420, easing:/, "the FLIP fallback is 420ms");
  assert.match(client, /ui\.sheet\.classList\.add\("is-entering"\)/, "Reduce Motion crossfades the sheet instead of sliding it");
  assert.match(tokens, /\.room\.ag-np \{[^}]*transition: opacity 200ms !important/, "and the crossfade is 200ms inside the one reduced-motion block");
  assert.match(client, /returnFocus:\s*ui\.info/);
  assert.doesNotMatch(ui, /innerHTML|style\s*=/, "screen DOM uses nodes and CSSOM, never interpolated markup or inline attributes");
  assert.match(ui, /node\.src = url/);
  assert.match(ui, /const url = safeUrl\(src \|\| ""\)/);
});

test("the sheet is a fixed full-bleed Room and every screen rule outranks the legacy player rules", () => {
  /* MUTATION 1: delete `position: fixed;` from `.ag-np.fp-sheet` -> red (`.room` is position: relative and loads later, so without the
     explicit declaration the sheet drops into the mini bar's flow, 56px up and under the tab bar: the first build did exactly that).
     MUTATION 2: change the `.ag-np-play.fp-big` selector to `.ag-np-play` -> red (`body.ui-v2 .fp-btn.fp-big` is violet and wins by one class). */
  assert.match(css, /\.ag-np\.fp-sheet \{ position: fixed; inset: 0;/);
  const selectors = [...css.matchAll(/^\s*([^@{}\n][^{}\n]*)\{/gm)]
    .flatMap((m) => m[1].split(",").map((x) => x.trim()))
    .filter((x) => /(^|\s)\.ag-np-[a-z]/.test(x) && !/^(\.ag-player|::view-transition|:root|\[data-posture)/.test(x));
  assert.ok(selectors.length > 40, `the sweep reads the real rule list (raw count: ${selectors.length})`);
  for (const sel of selectors) assert.match(sel, /^\.ag-np\.fp-sheet |^\.ag-np\.is-/, `${sel} must start from .ag-np.fp-sheet so styles.css's body.ui-v2 rules cannot win`);
  assert.match(css, /\.ag-np\.fp-sheet \.ag-np-play\.fp-big\s*\{[^}]*background:\s*var\(--ember\)/s);
});

test("segment change: narration returns the Room to lamp-warm neutral, the show line crossfades once, the title class tracks the laid-out title", () => {
  /* MUTATION 1: delete the `show === "4a narration"` branch in agNpSetRoom -> red (narration would take a hash hue).
     MUTATION 2: change the 140ms swap delay in agNpSetShowLine to 0 -> red (no fade-out, so no crossfade; 2 x 140 = the 280ms --m-ui).
     MUTATION 3: delete the ResizeObserver line -> red (is-long-title would be measured once, before fonts and layout settle: the
     first build left a 3-line title on a 220 sleeve and pushed the More handle off a 375x667 screen). */
  assert.match(ui, /show === "4a narration" \? "oklch\(0\.74 0\.05 75\)"/);
  assert.match(ui, /ui\.showTimer = setTimeout\(\(\) => \{[^}]*setStatusText\(ui\.sShow, text\);[^}]*\}, 140\)/s);
  assert.match(css, /\.fp-s-show \{[^}]*transition: opacity calc\(var\(--m-ui\) \/ 2\)/s);
  assert.match(ui, /new ResizeObserver\(\(\) => agNpMeasureTitle\(ui\)\)\.observe\(ui\.sTitle\)/);
  assert.match(ui, /if \(!ui\?\.ag \|\| ui\.sheet\.hidden\) return;/, "a hidden sheet reports height 0 and must keep its class");
  assert.match(client, /"source_show" in item/, "a Foray's second line is painted by the screen file, not overwritten by setNowPlaying");
});

test("secondary buttons keep their icon: paintControl writes Speed's rate and Bookmark's state into the caption", () => {
  /* MUTATION: make paintControl write btn.textContent unconditionally -> red (the first build wiped the gauge glyph on every rate paint). */
  assert.match(client, /btn\.classList\.contains\("ag-np-action"\) \? btn\.querySelector\("\.ag-np-action-caption"\) : null/);
  assert.match(client, /const target = caption \|\| btn;[\s\S]*?if \(text != null && !btn\.dataset\?\.agGlyph && target\.textContent !== text\) target\.textContent = text;/, "and a sprite-glyph button (Play, the skips) is never overwritten by its legacy text");
  assert.match(ui, /"t-caption ag-np-action-caption"/);
});

test("no control in the sheet is decoration: the dots open the detail, Sleep really pauses, and the legacy second row stays reachable", () => {
  /* MUTATION 1: delete `moreMenuBtn.addEventListener("click", openDetail)` -> red (the dots were a dead 44px button).
     MUTATION 2: change `minutes * 60000` to `minutes * 6000` in player/client.js -> red (the timer would fire 10x early).
     MUTATION 3: put `display: none` back on `.ag-np-legacy-actions` -> red (Stop, Next, Save, Episode and Back to this Foray vanished with it). */
  assert.match(ui, /moreMenuBtn\.addEventListener\("click", openDetail\)/);
  assert.match(ui, /ui\.requestSleep\?\.\(sleepMinutes\)/);
  assert.match(client, /ui\.requestSleep = \(minutes\) => \{[\s\S]*?if \(isRunning\(\)\) setRunning\(false, "sleep"\);[\s\S]*?\}, minutes \* 60000\);/);
  assert.match(css, /\.ag-np-legacy-actions \{[^}]*display: flex/);
  assert.doesNotMatch(css, /\.ag-np-legacy-actions[^{]*\{[^}]*display:\s*none/);
});

test("a Foray with no artwork URLs still draws its collage, from the strip's own colours", () => {
  /* MUTATION: filter sources by `src` again (drop the tile branch) -> red (the Room's art slot was an empty 220px hole). */
  assert.match(ui, /ag-np-collage-art ag-np-collage-tile/);
  assert.match(ui, /tile\.style\.setProperty\("--c", agNpColour\(source\.name\)\)/);
  assert.match(css, /\.ag-np-collage-tile \{[^}]*background: var\(--c\)/);
});
