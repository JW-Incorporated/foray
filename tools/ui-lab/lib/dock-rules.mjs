/* Pure evaluation of the Dock's facts (BUILD-PLAN 2.1 screen 2, "dock"): measurements in, violations out.
 * No browser and no DOM, so dock-check.test.mjs runs anywhere; lib/dock-measure.mjs is the half that runs in
 * the page and produces the `m` these functions read, and dock-check.mjs drives both.
 *
 * A violation is { rule, screen, detail }. `screen` is "<state>/<label>@<viewport>/<scheme>". Each evaluator
 * is one acceptance line of the screen, so a failing line names itself. */

/** Sub-pixel layout tolerance. */
export const EPS = 0.75;
export const near = (a, b, eps = EPS) => Math.abs(a - b) <= eps;

/** The gutter the Dock is inset by (tokens.css: 16 at 375, 20 from 393). */
export const gutterFor = (vw) => (vw >= 393 ? 20 : 16);
export const DOCK_INSET = 12;          // the Dock floats this far above the safe area
export const FIELD_ROW = 48;
export const MINI_ROW = 64;
export const TAB_ROW = 64;
export const TAB_ROW_RECEDED = 36;
export const FADE_STOP_PX = 32;        // the fade reaches the page colour at 32px
export const FADE_EXTRA = 44;          // fade height = safe-bottom + 12 + 44
export const CAST_RADIUS = 260;
export const CAST_ALPHA = { dark: 0.14, light: 0.09 };
export const TEXT_OPACITY_FLOOR = 0.02;

const v = (rule, screen, detail) => ({ rule, screen, detail });

/** The visible rows, top to bottom. */
const visibleRows = (m) => m.rows.filter((r) => r.visible).sort((a, b) => a.rect.top - b.rect.top);

/** One Veil surface at the gutter inset, 12px above the safe area, radius 24; its rows are divided by the 1px
 *  rim with no gap: consecutive rows' rects share an edge, the first starts at the Dock's top and the last
 *  ends at its bottom. `m.expect` = { field, mini } says which rows this screen must show. */
export function evaluateRows(screen, m) {
  const out = [];
  const vis = visibleRows(m);
  const ids = vis.map((r) => r.id);
  const want = ["dock-field", "dock-mini", "tab-bar"].filter((id) => id === "tab-bar" || (id === "dock-field" ? m.expect.field : m.expect.mini));
  if (JSON.stringify(ids) !== JSON.stringify(want)) out.push(v("rows-present", screen, `rows ${JSON.stringify(ids)}, expected ${JSON.stringify(want)}`));
  for (let i = 1; i < vis.length; i++) {
    const gap = vis[i].rect.top - vis[i - 1].rect.bottom;
    if (!near(gap, 0)) out.push(v("rows-share-an-edge", screen, `${vis[i - 1].id} ends at ${vis[i - 1].rect.bottom} but ${vis[i].id} starts at ${vis[i].rect.top} (gap ${gap}px)`));
  }
  if (vis.length) {
    if (!near(vis[0].rect.top, m.dock.top)) out.push(v("rows-fill-the-dock", screen, `the first row starts at ${vis[0].rect.top}, the Dock at ${m.dock.top}`));
    if (!near(vis[vis.length - 1].rect.bottom, m.dock.bottom)) out.push(v("rows-fill-the-dock", screen, `the last row ends at ${vis[vis.length - 1].rect.bottom}, the Dock at ${m.dock.bottom}`));
  }
  const gutter = gutterFor(m.viewport.w);
  if (!near(m.dock.left, gutter) || !near(m.viewport.w - m.dock.right, gutter)) {
    out.push(v("dock-gutter-inset", screen, `left ${m.dock.left}, right inset ${m.viewport.w - m.dock.right}, expected ${gutter} each`));
  }
  if (!near(m.viewport.h - m.dock.bottom, DOCK_INSET + m.safeBottom)) {
    out.push(v("dock-floats-12px", screen, `${m.viewport.h - m.dock.bottom}px above the bottom, expected ${DOCK_INSET + m.safeBottom}`));
  }
  if (!near(m.dockStyle.radius, 24)) out.push(v("dock-radius", screen, `radius ${m.dockStyle.radius}, expected 24 (--r-xl)`));
  if (!/blur\(20px\)/.test(m.dockStyle.backdrop || "")) out.push(v("dock-is-a-veil", screen, `backdrop-filter is "${m.dockStyle.backdrop}", expected the Veil's blur(20px)`));
  /* The rim between rows: every visible row but the first draws the 1px line, the first draws none. */
  vis.forEach((r, i) => {
    if (i === 0 && r.rim) out.push(v("rim-between-rows", screen, `${r.id} is the first row and still draws a rim (a stray line at the Dock's top edge)`));
    if (i > 0 && !r.rim) out.push(v("rim-between-rows", screen, `${r.id} draws no rim: the rows are not divided`));
  });
  const heights = { "dock-field": FIELD_ROW, "dock-mini": MINI_ROW, "tab-bar": m.receded ? TAB_ROW_RECEDED : TAB_ROW };
  for (const r of vis) {
    if (!near(r.rect.height, heights[r.id])) out.push(v("row-height", screen, `${r.id} is ${r.rect.height}px tall, expected ${heights[r.id]}`));
  }
  return out;
}

/** The mini row: 44 art, a one-line label title, a show caption, Ember Play 48, Fwd30 44, a 2px Glow progress
 *  line on its top edge (aria-hidden), the region named for what plays, the row stretching to open Now Playing. */
export function evaluateMiniRow(screen, m) {
  const out = [];
  const mini = m.mini;
  if (!mini) return [v("mini-present", screen, "no mini row to measure")];
  const size = (name, r, w, h) => { if (!near(r.width, w) || !near(r.height, h)) out.push(v("mini-sizes", screen, `${name} is ${r.width}x${r.height}, expected ${w}x${h}`)); };
  size("artwork", mini.art, 44, 44);
  size("Play", mini.play, 48, 48);
  size("Fwd30", mini.skip, 44, 44);
  if (!(mini.play.right <= mini.skip.left + EPS)) out.push(v("mini-order", screen, "Play must sit before Fwd30"));
  if (mini.titleLines !== 1) out.push(v("mini-title-one-line", screen, `the title is ${mini.titleLines} lines`));
  if (!mini.showText) out.push(v("mini-show-caption", screen, "the show caption is empty"));
  if (!mini.titleFontIsLabel) out.push(v("mini-title-style", screen, `title font is "${mini.titleFont}", expected the label style (600 14px DM Sans)`));
  if (mini.playBg !== m.colours.ember) out.push(v("mini-play-ember", screen, `Play paints ${mini.playBg}, expected Ember ${m.colours.ember}`));
  if (mini.skipBg && mini.skipBg !== "rgba(0, 0, 0, 0)") out.push(v("mini-skip-bare", screen, `Fwd30 paints ${mini.skipBg}: the bar's one filled control is Play`));
  const p = mini.progress;
  if (!near(p.rect.height, 2, 0.1)) out.push(v("mini-progress-2px", screen, `the progress line is ${p.rect.height}px tall`));
  if (!near(p.rect.top, mini.rect.top, 0.1)) out.push(v("mini-progress-on-the-top-edge", screen, `the line is at ${p.rect.top}, the row's top edge at ${mini.rect.top}`));
  if (p.ariaHidden !== "true") out.push(v("mini-progress-aria-hidden", screen, `aria-hidden is ${JSON.stringify(p.ariaHidden)}`));
  if (p.fillBg !== m.colours.glow) out.push(v("mini-progress-glow", screen, `the fill paints ${p.fillBg}, expected Glow ${m.colours.glow}`));
  if (mini.region.role !== "region" || !/^Now playing: .+, .+$/.test(mini.region.label || "")) {
    out.push(v("mini-region-label", screen, `role ${JSON.stringify(mini.region.role)}, label ${JSON.stringify(mini.region.label)}; expected a region named "Now playing: <title>, <show>"`));
  }
  if (mini.info.height + EPS < mini.rect.height - 1) out.push(v("mini-tap-opens", screen, `the title button is ${mini.info.height}px in a ${mini.rect.height}px row: bands above and below it are dead`));
  return out;
}

/** The tabs: three, one current, Fill glyph + --text for it, Regular + --text-2 for the rest (so a tab change is a
 *  change of glyph, visible in greyscale); icons 28 (24 receded), labels shown (faded receded). */
export function evaluateTabs(screen, m) {
  const out = [];
  const keys = m.tabs.items.map((t) => t.key);
  if (JSON.stringify(keys) !== JSON.stringify(["today", "discover", "library"])) out.push(v("three-tabs", screen, `tabs ${JSON.stringify(keys)}`));
  const current = m.tabs.items.filter((t) => t.current);
  if (current.length !== 1) out.push(v("one-tab-current", screen, `${current.length} tabs read as current`));
  for (const t of m.tabs.items) {
    if (t.current) {
      if (!near(t.onOpacity, 1, 0.02) || !near(t.offOpacity, 0, 0.02)) out.push(v("active-tab-fill-glyph", screen, `${t.key}: Fill ${t.onOpacity}, Regular ${t.offOpacity}`));
      if (t.color !== m.colours.text) out.push(v("active-tab-text", screen, `${t.key} paints ${t.color}, expected --text ${m.colours.text}`));
    } else {
      if (!near(t.onOpacity, 0, 0.02) || !near(t.offOpacity, 1, 0.02)) out.push(v("inert-tab-regular-glyph", screen, `${t.key}: Fill ${t.onOpacity}, Regular ${t.offOpacity}`));
      if (t.color !== m.colours.text2) out.push(v("inert-tab-text-2", screen, `${t.key} paints ${t.color}, expected --text-2 ${m.colours.text2}`));
    }
  }
  const fills = new Set(m.tabs.items.map((t) => t.fillHref));
  const regs = new Set(m.tabs.items.map((t) => t.regularHref));
  if (fills.size !== 3 || regs.size !== 3 || m.tabs.items.some((t) => t.fillHref === t.regularHref)) out.push(v("glyph-pair-differs", screen, "each tab needs a Regular and a Fill glyph that differ"));
  const icon = m.receded ? 24 : 28;
  if (!near(m.tabs.iconBox.width, icon) || !near(m.tabs.iconBox.height, icon)) out.push(v("tab-icon-size", screen, `icons are ${m.tabs.iconBox.width}x${m.tabs.iconBox.height}, expected ${icon}`));
  const label = m.receded ? 0 : 1;
  if (!near(m.tabs.labelOpacity, label, 0.05)) out.push(v("tab-label", screen, `label opacity ${m.tabs.labelOpacity}, expected ${label}`));
  if (m.receded) {
    const reach = (m.tabs.afterTop === null || m.tabs.afterBottom === null) ? null : 36 + Math.abs(m.tabs.afterTop) + Math.abs(m.tabs.afterBottom);
    if (reach === null || reach + EPS < 44) out.push(v("receded-tab-44", screen, `a receded tab's hit area is ${reach}px tall (the 36px row + its ::after), expected at least 44`));
  }
  return out;
}

/** The fade and the cast, present on every tab page. The fade is `safe-bottom + 12 + 44` tall and reaches the page
 *  colour at 32px; the cast is a 260px radial in Glow at 14% (9% in Dawn), lit only while something is loaded. */
export function evaluateDecorations(screen, m) {
  const out = [];
  const f = m.fade;
  if (!f.present || f.display === "none") out.push(v("fade-present", screen, "the Dock fade is missing or hidden"));
  else {
    const want = m.safeBottom + DOCK_INSET + FADE_EXTRA;
    if (!near(f.rect.height, want)) out.push(v("fade-height", screen, `the fade is ${f.rect.height}px tall, expected ${want} (safe + 12 + 44)`));
    if (!near(f.rect.bottom, m.viewport.h)) out.push(v("fade-at-the-bottom", screen, `the fade ends at ${f.rect.bottom}, the viewport at ${m.viewport.h}`));
    if (!new RegExp(`\\b${FADE_STOP_PX}px\\b`).test(f.backgroundImage || "")) out.push(v("fade-reaches-bg-at-32px", screen, `gradient "${f.backgroundImage}" has no ${FADE_STOP_PX}px stop`));
    if (f.pointerEvents !== "none") out.push(v("fade-takes-no-tap", screen, `pointer-events is ${f.pointerEvents}`));
    if (f.ariaHidden !== "true") out.push(v("fade-aria-hidden", screen, "the fade is not aria-hidden"));
  }
  const c = m.cast;
  if (m.expect.mini) {
    if (c.state !== "playing" || c.display === "none") out.push(v("cast-lit-with-a-mini-row", screen, `cast state ${c.state}, display ${c.display}`));
    else {
      if (!new RegExp(`\\b${CAST_RADIUS}px\\b`).test(c.backgroundImage || "")) out.push(v("cast-260px", screen, `gradient "${c.backgroundImage}" has no ${CAST_RADIUS}px radius`));
      const alpha = /\/\s*([\d.]+)\)/.exec(c.backgroundImage || "");
      const want = CAST_ALPHA[m.scheme];
      if (!alpha || !near(Number(alpha[1]), want, 0.005)) out.push(v("cast-alpha", screen, `cast alpha ${alpha ? alpha[1] : "?"}, expected ${want} in ${m.scheme}`));
      if (!near(c.rect.bottom, m.viewport.h)) out.push(v("cast-reaches-the-bottom", screen, `the cast's box ends at ${c.rect.bottom}: it would step in the gutters (see ui/dock.css)`));
    }
  } else if (c.display !== "none") {
    out.push(v("cast-hidden-with-no-mini", screen, `nothing plays but the cast displays (${c.display})`));
  }
  if (c.ariaHidden !== "true") out.push(v("cast-aria-hidden", screen, "the cast is not aria-hidden"));
  return out;
}

/** Fade alpha at page y: 0 at the fade's top, 1 from `stop` px below it (the gradient's own last stop, as
 *  the page computed it - NOT the spec's 32, so a wrong stop is seen by the band rule and not only by the
 *  string check). A fade with no stop is a hard edge. */
export const fadeAlphaAt = (fadeTop, y, stop = FADE_STOP_PX) => (stop > 0 ? Math.min(1, Math.max(0, (y - fadeTop) / stop)) : (y >= fadeTop ? 1 : 0));

/** No text node intersects the band below the Dock's bottom edge at rendered opacity above 0.02. The band is the
 *  Dock's bottom edge down to the viewport's; a text node's rendered opacity is its own (the product of its
 *  ancestors') through the fade that lies over it. `samples` counts the text rects that DID enter the band, so
 *  a page with nothing in it cannot make the rule pass vacuously: the caller requires at least one across a
 *  screen's scroll positions (`requireSamples`). */
export function evaluateBand(screen, m, { requireSamples = false } = {}) {
  const out = [];
  const bandTop = m.dock.bottom;
  const bandBottom = m.viewport.h;
  const fadeTop = m.fade.present ? m.fade.rect.top : bandBottom;
  let samples = 0;
  for (const t of m.text) {
    if (t.bottom <= bandTop || t.top >= bandBottom) continue;
    samples++;
    /* the most visible part of the rect inside the band is its highest one: alpha grows downward */
    const y = Math.max(t.top, bandTop);
    const rendered = t.opacity * (1 - fadeAlphaAt(fadeTop, y, m.fade.present ? m.fade.stopPx : 0));
    if (rendered > TEXT_OPACITY_FLOOR) out.push(v("no-text-in-the-band", screen, `"${t.text}" shows at opacity ${rendered.toFixed(3)} at y=${Math.round(y)}, in the band below the Dock's edge (${bandTop}..${bandBottom})`));
  }
  if (requireSamples && samples === 0) out.push(v("band-sampled", screen, "no text passed through the band at any scroll position: the rule would pass vacuously"));
  return { violations: out, samples };
}

/** While the field has focus the Dock is the field row alone. */
export function evaluateFocused(screen, f) {
  const out = [];
  if (!f.searching) out.push(v("field-focus-class", screen, "body.sh-searching is not set while the field has focus"));
  if (!f.field.visible) out.push(v("field-stays", screen, "the field row is hidden while it has focus"));
  if (f.mini.visible) out.push(v("mini-yields-to-focus", screen, "the mini row still shows while the field has focus"));
  if (f.tabs.visible) out.push(v("tabs-yield-to-focus", screen, "the tab row still shows while the field has focus"));
  return out;
}

/** The folded routes: `#/create` lands on Discover with the field focused, `#/starred-shows` on Library,
 *  `#/interests` on Tuning. */
export function evaluateRedirects(screen, r) {
  const out = [];
  if (r.create.hash !== "#/shows") out.push(v("create-redirects", screen, `#/create became ${r.create.hash}`));
  if (r.create.activeId !== "sh-input") out.push(v("create-focuses-the-field", screen, `focus is on "${r.create.activeId}", expected sh-input`));
  if (!r.create.fieldInDock) out.push(v("create-field-in-the-dock", screen, "the focused field is not inside the Dock's field row"));
  if (r.starred.hash !== "#/library") out.push(v("starred-redirects", screen, `#/starred-shows became ${r.starred.hash}`));
  if (r.interests.hash !== "#/tuning") out.push(v("interests-redirects", screen, `#/interests became ${r.interests.hash}`));
  if (!/^Tuning\b/.test(r.interests.heading || "")) out.push(v("interests-is-tuning", screen, `the page says "${r.interests.heading}"`));
  return out;
}

/** Car posture by a long press on the mini row: the Dock is hidden, Now Playing opened by itself, and collapsing
 *  the sheet ends it. */
export function evaluateCar(screen, c) {
  const out = [];
  if (c.postureAfterHold !== "car") out.push(v("long-press-enters-car", screen, `data-posture is ${JSON.stringify(c.postureAfterHold)} after a 600ms+ hold`));
  if (!c.sheetOpen) out.push(v("car-opens-now-playing", screen, "Now Playing did not open by itself"));
  if (c.dockVisibleInCar) out.push(v("car-hides-the-dock", screen, "the Dock is visible in car posture"));
  if (c.fadeVisibleInCar || c.castVisibleInCar) out.push(v("car-hides-fade-and-cast", screen, `fade ${c.fadeVisibleInCar}, cast ${c.castVisibleInCar}`));
  if (c.postureAfterClose !== null) out.push(v("collapse-ends-car", screen, `data-posture is ${JSON.stringify(c.postureAfterClose)} after the sheet closed`));
  if (c.earlyReleasePosture !== null) out.push(v("early-release-no-car", screen, "a quick tap entered car posture"));
  return out;
}

/** The recede transitions: down past 80px -> receded, any upward scroll -> tall, always receded on Discover. */
export function evaluateRecede(screen, r) {
  const out = [];
  if (r.at60Receded) out.push(v("no-recede-before-80", screen, "the row receded after only 60px of scroll"));
  if (!r.at120Receded) out.push(v("recede-after-80", screen, "the row did not recede after 120px of downward scroll"));
  if (r.after1pxUpReceded) out.push(v("restore-on-any-upward-scroll", screen, "one pixel back up did not restore the tall row"));
  if (!r.afterRescrollReceded) out.push(v("recede-again", screen, "scrolling down again did not recede it"));
  if (r.atTopReceded) out.push(v("restore-at-top", screen, "back at the top the row is still receded"));
  if (!near(r.durationMs, 280, 1)) out.push(v("recede-280ms", screen, `the tab row's height transition lasts ${r.durationMs}ms, expected 280`));
  if (!/cubic-bezier\(0\.2,\s*0\.8,\s*0\.2,\s*1\)/.test(r.easing || "")) out.push(v("recede-e-out", screen, `easing ${r.easing}, expected --e-out`));
  return out;
}

export function renderReport(violations, meta) {
  const lines = [`# Dock check`, ``, `${meta.screens} screens, ${meta.checks} evaluations, **${violations.length} violation(s)**.`, ``];
  if (!violations.length) return lines.join("\n") + "\nAll clear.\n";
  const by = new Map();
  for (const x of violations) { if (!by.has(x.rule)) by.set(x.rule, []); by.get(x.rule).push(x); }
  for (const [rule, list] of by) {
    lines.push(`## ${rule} (${list.length})`);
    for (const x of list.slice(0, 8)) lines.push(`- ${x.screen}: ${x.detail}`);
    if (list.length > 8) lines.push(`- ... and ${list.length - 8} more`);
    lines.push("");
  }
  return lines.join("\n");
}
