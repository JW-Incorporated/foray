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

test("no control in the sheet is decoration: the dots open the player menu, Sleep really pauses, and the legacy second row lives on as that menu", () => {
  /* RULING THAT FELL (iteration 2, fidelity): build-log call 7 kept the legacy row (Stop, Next, Save, Episode, Back to this Foray)
     visible at the foot of the detail posture. The prototype has no such row; it read as a second control row, with a Unicode skip
     glyph and a violet "Saved". Its buttons are now display:none and the dots menu forwards a click to each, so nothing is lost.
     MUTATION 1: delete `spec.source.click();` in the menu item handler -> red (every menu item would be a dead button).
     MUTATION 2: change `minutes * 60000` to `minutes * 6000` in player/client.js -> red (the timer would fire 10x early).
     MUTATION 3: set `.ag-np-legacy-actions` back to `display: flex` -> red (the second row returns beside the menu).
     MUTATION 4: delete the `if (!spec.source || spec.source.hidden) continue;` line -> red (Next offered at the end of the queue, Save inside a Foray).
     MUTATION 5: change `.ag-np-menu-item.is-saved { color: var(--ember); }` to `var(--violet)` -> red (Saved is the listener's own mark: Ember). */
  assert.match(ui, /moreMenuBtn\.addEventListener\("click", \(\) => \(menu\.hidden \? openMenu\(\) : closeMenu\(true\)\)\);/);
  assert.match(ui, /item\.addEventListener\("click", \(\) => \{\s*closeMenu\(false\);\s*spec\.source\.click\(\);\s*\}\);/);
  for (const source of ["ui.saveBtn", "ui.nextBtn", "ui.openLink", "ui.forayLink", "ui.stopBtn"]) {
    assert.ok(ui.includes(`{ source: ${source},`), `${source} has a menu item`);
  }
  assert.match(ui, /if \(!spec\.source \|\| spec\.source\.hidden\) continue;/, "an item the page hides is not offered");
  assert.match(ui, /event\.stopPropagation\(\);\s*closeMenu\(true\);/, "Escape closes the menu, not the whole player");
  assert.match(ui, /ui\.requestSleep\?\.\(sleepMinutes\)/);
  assert.match(client, /ui\.requestSleep = \(minutes\) => \{[\s\S]*?if \(isRunning\(\)\) setRunning\(false, "sleep"\);[\s\S]*?\}, minutes \* 60000\);/);
  assert.match(css, /\.ag-np-legacy-actions \{ display: none; \}/);
  assert.match(css, /\.ag-np-menu-item\.is-saved \{ color: var\(--ember\); \}/);
  assert.doesNotMatch(css, /\.ag-np-menu[^{]*\{[^}]*backdrop-filter/, "the Dock is the only glass");
  /* No Unicode glyph in the menu: every icon is a sprite symbol, in the sprite and in the local allow-list (an unknown name falls back to the play glyph). */
  const menuBlock = /const menuSpecs = \[[\s\S]*?\n  \];/.exec(ui)[0];
  const icons = [...menuBlock.matchAll(/"([a-z]+(?:-[a-z]+)*)"/g)].map((m) => m[1]).filter((n) => /^(check-circle|check-circle-fill|skip-next|books|sparkle|x)$/.test(n));
  assert.ok(icons.length >= 6, "all five items name their sprite icon (Save names two)");
  const sprite = read("ui/icons.svg");
  const allow = /const AG_NP_ICONS = new Set\(\[[^\]]*\]\)/.exec(ui)[0];
  for (const name of icons) {
    assert.ok(sprite.includes(`id="i-${name}"`), `${name} is a sprite symbol`);
    assert.ok(allow.includes(`"${name}"`), `${name} is in AG_NP_ICONS`);
  }
  assert.doesNotMatch(menuBlock, /[⏭✓✔]/, "no Unicode skip glyph or checkmark");
});

test("iteration 2 (strip + queue): the current bar steps apart from its neighbours, and Up Next's peek reads queued episodes outside the session", () => {
  /* MUTATION 1: delete the `data-gap-prev` rule's `margin-left: 0` -> red (a same-show neighbour touches the taller current bar again: the nub).
     MUTATION 2: in ui/now-playing.js change `current || nearCurrent(ui.strip.children[order - 1])` to `current` -> red (the bar before the current one stays welded to it).
     MUTATION 3: in app.js drop `|| state.itemIndex[id] || storedEpisode(id)` from `nextItem` -> red (a queued episode outside today's session gave a null
       peek, and the Up Next section vanished from the detail posture exactly when a listener had an Up Next). */
  assert.match(ui, /button\.dataset\.gapPrev = current \|\| nearCurrent\(ui\.strip\.children\[order - 1\]\) \? "1" : "0";/);
  assert.match(ui, /button\.dataset\.gapNext = current \|\| nearCurrent\(ui\.strip\.children\[order \+ 1\]\) \? "1" : "0";/);
  assert.match(css, /\[data-join-prev\]\[data-gap-prev="1"\] \{ margin-left: 0; \}/);
  assert.match(css, /\[data-join-next\]\[data-gap-next="1"\] \.ag-np-strip-bar \{ border-top-right-radius: var\(--r-xs\)/);
  /* MUTATION 4: delete the `.fp-upnext` rule's `color: var(--ember)` -> red (body.ui-v2 .fp-openep paints the Up Next link violet, which the direction overturned). */
  assert.match(css, /\.ag-np-up-next \.fp-upnext \{[^}]*color: var\(--ember\)/);
  assert.match(css, /\.fp-s-desc summary::after \{ content: none; \}/);
  assert.match(read("app.js"), /const item = id \? \(episode\(id\) \|\| state\.itemIndex\[id\] \|\| storedEpisode\(id\)\) : null;/);
});

test("a Foray with no artwork URLs still draws its collage, from the strip's own colours", () => {
  /* MUTATION: filter sources by `src` again (drop the tile branch) -> red (the Room's art slot was an empty 220px hole). */
  assert.match(ui, /ag-np-collage-art ag-np-collage-tile/);
  assert.match(ui, /tile\.style\.setProperty\("--c", agNpColour\(source\.name\)\)/);
  assert.match(css, /\.ag-np-collage-tile \{[^}]*background: var\(--c\)/);
});

test("a Foray's Room is its blurred collage, the sleeve casts ONE tone of light, and the strip joins one show's cuts", () => {
  /* MUTATION 1: in agNpSetRoom change `if (artless) agNpFillRoomCollage(incoming, ui.collageSources)` to `if (false)` -> red
       (iteration 2: the Room was one flat Glow colour and none of the sleeves' purple or cyan reached the wall).
     MUTATION 2 (iteration 3: the blurred-collage halo read as a multi-hue smudge, so it is gone): re-add `ui.artSwap.prepend(halo)` or an `.ag-np-halo` rule -> the doesNotMatch lines below go red.
     MUTATION 3: set `.ag-np-strip-button[data-join-prev] { margin-left: -2px }` to `0` -> red (24 equal chips with uniform gaps again).
     MUTATION 4: drop the `show !== "4a narration"` clause from `artless` -> red (narration would keep a show's collage instead of lamp-warm). */
  assert.match(ui, /const artless = css === "none" && show !== "4a narration";/);
  assert.match(ui, /if \(artless\) agNpFillRoomCollage\(incoming, ui\.collageSources\);/);
  assert.match(ui, /for \(const layer of ui\.roomLayers\) if \(layer\.dataset\.artless === "1"\) agNpFillRoomCollage\(layer, sources\);/, "a collage that arrives after setRoom still reaches the layer that is on");
  assert.match(ui, /for \(const layer of ui\.roomLayers\) if \(layer\.dataset\.artless === "1"\) layer\.replaceChildren\(\);/, "an episode never inherits a Foray's collage");
  assert.match(css, /\.ag-np-room-collage \{[^}]*position: absolute;[^}]*height: 66%;[^}]*display: grid;/s);
  assert.match(css, /\.ag-np-room-tile \{[^}]*background: var\(--c, transparent\)/);
  assert.match(ui, /ui\.artSwap\.style\.setProperty\("--art-glow", glow\);/, "the glow colour lives on the art box so the collage and an episode sleeve both cast it, in ONE tone");
  assert.doesNotMatch(ui, /halo/i, "no second blurred copy of the collage: its tones spilled as a purple/teal/orange ring");
  assert.doesNotMatch(css, /halo/i);
  assert.match(css, /\.ag-np-art-swap > \.lit-art \{ box-shadow: var\(--shadow-1\), 0 0 calc\(var\(--lit-r\) \* \.6\)[^;]*var\(--art-glow, var\(--glow\)\)/);
  assert.match(ui, /if \(runOf\(order - 1\)\) button\.dataset\.joinPrev = "1";/);
  assert.match(ui, /if \(runOf\(order \+ 1\)\) button\.dataset\.joinNext = "1";/, "a data attribute, not a class: gates.mjs keys its tap-target exemption on the class list, so a new class would void it");
  assert.match(css, /\.ag-np-strip-button\[data-join-prev\] \{ margin-left: -2px; \}/);
  assert.match(css, /\[data-join-prev\] \.ag-np-strip-bar \{ border-top-left-radius: 0; border-bottom-left-radius: 0; \}/);
});

test("iteration 3: every show bar is at full art colour, the current bar's fill is the lighter tint, narration is a thin shrinkable light, an un-narrated Foray carries one caption", () => {
  /* MUTATION 1: put `color-mix(in oklab, var(--c) 38%, transparent)` back as the bar's base background -> the first doesNotMatch goes red
       (bars ahead of the playhead went dark teal/olive/brown, so the map was unreadable ahead).
     MUTATION 2: delete the `[data-narration] { min-width: 2px; }` rule -> red (a Foray with 40 bridges in 51 items ran 90px off the right edge of the strip).
     MUTATION 3: change `ui.stripCaption.hidden = narrated` to `= false` -> red (an un-narrated Foray said nothing, a narrated one said "Not narrated" over its own ivory lights). */
  const bar = css.match(/\.ag-np\.fp-sheet \.ag-np-strip-bar \{[^}]*\}/s)?.[0] || "";
  assert.match(bar, /background: var\(--c\);/);
  assert.doesNotMatch(bar, /transparent/, "a bar ahead of the playhead is not a faded copy of its colour");
  assert.match(css, /\.ag-np-strip-fill \{[^}]*background: color-mix\(in oklab, var\(--c\) 78%, var\(--lamp\)\)/s, "the fill is a lighter tint of the same colour, not a different hue");
  assert.match(css, /\.ag-np-strip-button\[data-narration\] \{ min-width: 2px; \}/);
  assert.match(ui, /if \(item\?\.kind === "tts"\) button\.dataset\.narration = "1";/);
  assert.match(ui, /const narrated = items\.some\(\(item\) => item\?\.kind === "tts"\);/);
  assert.match(ui, /ui\.stripCaption\.textContent = narrated \? "" : "Not narrated";/);
  assert.match(ui, /ui\.stripCaption\.hidden = narrated;/);
});

test("review round 1: Follow is the Library's record, Share is a timestamp link, the detail scroll honours Reduce Motion, the timeline exemption is width-only", () => {
  const gates = read("tools/ui-lab/lib/gates/config.mjs");
  const rules = read("tools/ui-lab/lib/gates/rules.mjs");
  /* MUTATION: replace `toggleShowStar(showId)` in the Follow click handler with a local aria-pressed flip -> red (Following and the Library disagree). */
  assert.match(ui, /follow\.addEventListener\("click", \(\) => \{ toggleShowStar\(showId\); paintFollow\(\); \}\)/);
  assert.match(ui, /const on = Boolean\(showId\) && isShowStarred\(showId\);/, "the label is read back from cp_starred_shows, never held locally");
  assert.doesNotMatch(ui, /getAttribute\("aria-pressed"\) !== "true"/, "no local toggle of aria-pressed survives");
  /* MUTATION: put `safeUrl(location.href)` back as the only argument of the Share handler's url -> red (it shares the page, not the moment). */
  assert.match(ui, /episodeDeepLinkHash\(target\)/);
  assert.doesNotMatch(ui, /const url = safeUrl\(location\.href\);/);
  assert.match(client, /ui\.shareTarget = \(\) => \{[\s\S]*?ForayPlayer\.currentEpisodeId\(\)[\s\S]*?episodePositionSec\(\)/, "the player says what is playing and where, as Bookmark does");
  /* MUTATION: change `behavior: reduce ? "auto" : "smooth"` back to `behavior: "smooth"` -> red. */
  assert.match(ui, /prefers-reduced-motion: reduce\)"\)\.matches/);
  assert.match(ui, /behavior: reduce \? "auto" : "smooth"/);
  /* MUTATION: delete `heightFloor: true` from one timeline selector in gates/config.mjs -> red (tools/ui-lab/gates.test.mjs pins the rule itself). */
  assert.equal((gates.match(/heightFloor: true/g) || []).length, 3, "all three timeline selectors keep the height floor");
  assert.match(rules, /!s\.heightFloor \|\| e\.h \+ tol >= min/);
});

test("round 2: the Foray's 'Now: <show>' caption does not follow the listener into an episode, and the detail step shoots an episode like the prototype", () => {
  /* MUTATION 1: delete the `/^Now: /` block at the top of agNpPaintEpisode -> red (an episode opened inside the 3s window wore the
     previous Foray's caption; found in the first episode-detail render).
     MUTATION 2: change the `detail` step's startEpisodePlayback back to startForayPlayback in tools/ui-lab/lib/states.mjs -> red
     (the prototype's np-detail3 is an episode scrolled to the bottom; the Foray's detail has its own `now-playing-detail-foray` step). */
  const paint = /function agNpPaintEpisode\(ui\) \{[\s\S]*?\n\}/.exec(ui)[0];
  assert.match(paint, /classList\.contains\("is-lit"\) && \/\^Now: \/\.test\(ui\.eyebrow\.textContent/);
  assert.match(paint, /clearTimeout\(ui\.captionTimer\)/);
  const states = read("tools/ui-lab/lib/states.mjs");
  const detail = /label: "now-playing-detail",[\s\S]*?ready: "\.ag-np-detail"/.exec(states)[0];
  assert.match(detail, /startEpisodePlayback\(page, ep0, \{\s*description:/, "the detail step plays an episode WITH notes, so Show notes is on screen to be judged");
  assert.match(detail, /scrollTop = scroller\.scrollHeight/);
  assert.match(states, /label: "now-playing-detail-foray"/);
});
