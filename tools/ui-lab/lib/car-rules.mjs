/* Pure evaluation of car posture's facts (docs/redesign-2026/directions/ambient/BUILD-NOTES.md 4.2, BUILD-PLAN.md 2.2
 * screen 8): measurements in, violations out. No browser and no DOM, so car-check.test.mjs runs anywhere;
 * lib/car-measure.mjs is the half that runs in the page and produces the `m` these functions read, and car-check.mjs
 * drives both.
 *
 * A violation is { rule, screen, detail }, `screen` being "<state>/<label>@<viewport>/<scheme>". Each rule is one line of
 * the acceptance, so a failing line names itself. */

export const EPS = 0.75;
export const near = (a, b, eps = EPS) => Math.abs(a - b) <= eps;

/** Play's bottom edge must clear the viewport bottom by this much (round 1 clipped it at 375x667). */
export const PLAY_CLEARANCE_PX = 24;
export const ART_PX = 240;
export const ART_SHORT_PX = 200;
export const SHORT_BELOW_PX = 700;       // "200 under 700px tall"
export const TALL_FROM_PX = 800;         // the title takes three lines from here, two below
export const PLAY_PX = 112;
export const SKIP_PX = 72;
export const PLAY_GLYPH_PX = 52;
export const SKIP_GLYPH_PX = 48;
export const TITLE_PX = 40;              // --t-display 32 x 1.25
export const TITLE_LEADING = 1.125;      // unitless: the line height scales with the size
export const LABEL_PX = 17.5;            // --t-label 14 x 1.25
export const LABEL_LEADING = 1.3;
export const TAP_PX = 44;
export const NOT_RENDERED = [".fp-s-why", ".ag-np-actions", ".ag-np-legacy-actions", ".ag-np-detail-handle", ".ag-np-detail", ".fp-s-desc", ".ag-np-clips", ".ag-np-more-btn"];

const v = (rule, screen, detail) => ({ rule, screen, detail });

/** The expected artwork edge for a viewport: 240, or 200 under 700px tall. */
export const artFor = (viewportH) => (viewportH < SHORT_BELOW_PX ? ART_SHORT_PX : ART_PX);
/** The expected title clamp for a viewport: three lines from 800px tall, two below. */
export const clampFor = (viewportH) => (viewportH >= TALL_FROM_PX ? 3 : 2);

/** Posture is on, the sheet it opened is open, and the Dock, its fade, its cast and today's tab bar are all out. */
export function evaluateEntered(screen, m) {
  const out = [];
  if (m.posture !== "car") out.push(v("posture-attribute", screen, `data-posture is ${JSON.stringify(m.posture)}, expected "car"`));
  if (!m.sheetOpen) out.push(v("now-playing-opens-by-itself", screen, "the sheet is not open"));
  for (const [sel, shown] of Object.entries(m.dock)) {
    if (shown) out.push(v("dock-hidden", screen, `${sel} is still rendered in car posture`));
  }
  return out;
}

/** Artwork, Play and the skips, and the glyphs inside them. */
export function evaluateSizes(screen, m) {
  const out = [];
  const art = artFor(m.viewport.h);
  if (!m.art || !near(m.art.width, art) || !near(m.art.height, art)) out.push(v("artwork-size", screen, `artwork is ${m.art ? `${m.art.width}x${m.art.height}` : "missing"}, expected ${art}x${art} at ${m.viewport.h}px tall`));
  if (!m.play || !near(m.play.width, PLAY_PX) || !near(m.play.height, PLAY_PX)) out.push(v("play-size", screen, `Play is ${m.play ? `${m.play.width}x${m.play.height}` : "missing"}, expected ${PLAY_PX}`));
  if (!m.skips.length) out.push(v("skip-size", screen, "no skip buttons found"));
  m.skips.forEach((s, i) => {
    if (!s || !near(s.width, SKIP_PX) || !near(s.height, SKIP_PX)) out.push(v("skip-size", screen, `skip ${i + 1} is ${s ? `${s.width}x${s.height}` : "missing"}, expected ${SKIP_PX}`));
  });
  if (!m.playIcon || !near(m.playIcon.width, PLAY_GLYPH_PX)) out.push(v("play-glyph-size", screen, `Play glyph is ${m.playIcon ? m.playIcon.width : "missing"}, expected ${PLAY_GLYPH_PX}`));
  if (!m.skipIcon || !near(m.skipIcon.width, SKIP_GLYPH_PX)) out.push(v("skip-glyph-size", screen, `skip glyph is ${m.skipIcon ? m.skipIcon.width : "missing"}, expected ${SKIP_GLYPH_PX}`));
  return out;
}

/** The harness assertion round 1 failed: Play's bottom edge at least 24px above the viewport bottom. Also: the posture
 *  fits without scrolling, so Play is never reachable only by scrolling the sheet. */
export function evaluatePlayClearance(screen, m) {
  const out = [];
  if (!m.play) return [v("play-bottom-clearance", screen, "no Play button to measure")];
  const clearance = m.viewport.h - m.play.bottom;
  if (clearance < PLAY_CLEARANCE_PX - EPS) out.push(v("play-bottom-clearance", screen, `Play's bottom edge is ${Math.round(clearance * 10) / 10}px above the viewport bottom, expected at least ${PLAY_CLEARANCE_PX}`));
  if (m.scroller && m.scroller.scrollHeight > m.scroller.clientHeight + 1) out.push(v("fits-without-scrolling", screen, `the sheet scrolls (${m.scroller.scrollHeight}px of content in ${m.scroller.clientHeight}px)`));
  return out;
}

/** Type x1.25 with unitless leading: the title is 40 on 45 (1.125), the label 17.5 on 22.75 (1.3). A leading frozen in px
 *  (round 1 double-spaced) would leave the title at 36 whatever the size. */
export function evaluateType(screen, m) {
  const out = [];
  if (!near(m.title.fontSize, TITLE_PX)) out.push(v("title-size", screen, `title is ${m.title.fontSize}px, expected ${TITLE_PX}`));
  if (!near(m.title.lineHeight, TITLE_PX * TITLE_LEADING)) out.push(v("title-leading", screen, `title line height is ${m.title.lineHeight}px, expected ${TITLE_PX * TITLE_LEADING} (unitless ${TITLE_LEADING})`));
  if (!m.chip) return [...out, v("label-size", screen, "no label to measure (the car chip is missing)")];
  if (!near(m.chip.fontSize, LABEL_PX)) out.push(v("label-size", screen, `label is ${m.chip.fontSize}px, expected ${LABEL_PX}`));
  if (!near(m.chip.lineHeight, LABEL_PX * LABEL_LEADING)) out.push(v("label-leading", screen, `label line height is ${m.chip.lineHeight}px, expected ${LABEL_PX * LABEL_LEADING} (unitless ${LABEL_LEADING})`));
  return out;
}

/** The why-line, the secondary row, the More handle, the show notes and the chapters are not rendered at all. */
export function evaluateHidden(screen, m) {
  const out = [];
  for (const sel of NOT_RENDERED) {
    if (!(sel in m.notRendered)) out.push(v("not-rendered", screen, `${sel} was not measured`));
    else if (!m.notRendered[sel]) out.push(v("not-rendered", screen, `${sel} is rendered in car posture`));
  }
  return out;
}

/** Title clamp: three lines at 800px tall and above, two below, and an ellipsis only where the clamp is reached, so no
 *  ellipsis sits beside empty Room: at 393x852 a two-line clamp ended in "..." with ~110px free (critique round 3). */
export function evaluateTitle(screen, m) {
  const out = [];
  const want = clampFor(m.viewport.h);
  if (m.title.clamp !== want) out.push(v("title-clamp", screen, `clamp is ${m.title.clamp}, expected ${want} at ${m.viewport.h}px tall`));
  if (m.title.lines > want) out.push(v("title-clamp", screen, `the title runs ${m.title.lines} lines, past the clamp of ${want}`));
  if (m.title.truncated && m.title.lines < want) out.push(v("no-ellipsis-beside-empty-room", screen, `the title ends in an ellipsis on line ${m.title.lines} of ${want}`));
  return out;
}

/** The title when it is short: it takes the lines it needs and shows no ellipsis, whatever the clamp. */
export function evaluateShortTitle(screen, m) {
  const out = [];
  if (m.title.truncated) out.push(v("short-title-untruncated", screen, `"${m.title.text}" is clipped (scrollHeight ${m.title.scrollHeight}, clientHeight ${m.title.clientHeight})`));
  if (m.title.lines > 1) out.push(v("short-title-untruncated", screen, `"${m.title.text}" takes ${m.title.lines} lines`));
  return out;
}

/** The car chip: the control that leaves posture. 44px target, named, pressed because posture is on. */
export function evaluateChip(screen, m) {
  const out = [];
  if (!m.chip || !m.chip.rendered) return [v("chip-visible", screen, "the car chip is not rendered in car posture")];
  if (m.chip.box.height < TAP_PX - EPS || m.chip.box.width < TAP_PX - EPS) out.push(v("chip-tap-target", screen, `the chip is ${m.chip.box.width}x${m.chip.box.height}, expected at least ${TAP_PX}`));
  if (m.chip.pressed !== "true") out.push(v("chip-pressed", screen, `aria-pressed is ${JSON.stringify(m.chip.pressed)} while posture is on`));
  if (!/leave car mode/i.test(m.chip.label)) out.push(v("chip-label", screen, `aria-label is ${JSON.stringify(m.chip.label)}`));
  return out;
}

/** The interaction facts, measured by car-check.mjs around real pointer input.
 *  facts = { earlyReleasePosture, postureAfterHold, sheetOpenAfterHold, hapticCalls, postureAfterChip, sheetOpenAfterChip,
 *            chipRenderedAfterChip, postureAfterCollapse } */
export function evaluateInteractions(screen, f) {
  const out = [];
  if (f.earlyReleasePosture !== null) out.push(v("early-release-does-not-enter", screen, `a 150ms press left data-posture at ${JSON.stringify(f.earlyReleasePosture)}`));
  if (f.postureAfterHold !== "car") out.push(v("hold-enters-posture", screen, `after a 750ms hold data-posture is ${JSON.stringify(f.postureAfterHold)}`));
  if (!f.sheetOpenAfterHold) out.push(v("hold-opens-now-playing", screen, "the hold did not open Now Playing"));
  if (!(f.hapticCalls >= 1)) out.push(v("hold-fires-the-haptic-hook", screen, `the medium haptic hook ran ${f.hapticCalls} times`));
  if (f.postureAfterChip !== null) out.push(v("chip-leaves-posture", screen, `after the chip data-posture is ${JSON.stringify(f.postureAfterChip)}`));
  if (!f.sheetOpenAfterChip) out.push(v("chip-keeps-the-sheet", screen, "leaving by the chip closed Now Playing"));
  if (f.chipRenderedAfterChip) out.push(v("chip-hides-outside-the-car", screen, "the chip is still rendered after leaving"));
  if (f.postureAfterCollapse !== null) out.push(v("collapse-ends-posture", screen, `after collapsing the sheet data-posture is ${JSON.stringify(f.postureAfterCollapse)}`));
  return out;
}

/** One screen, every measured rule. */
export function evaluateCar(screen, m) {
  return [
    ...evaluateEntered(screen, m), ...evaluateSizes(screen, m), ...evaluatePlayClearance(screen, m), ...evaluateType(screen, m),
    ...evaluateHidden(screen, m), ...evaluateTitle(screen, m), ...evaluateChip(screen, m),
  ];
}

export function renderReport(violations, { screens, checks }) {
  const L = ["# car-check", "", `${screens} screens, ${checks} evaluations, ${violations.length} violations.`, ""];
  if (!violations.length) L.push("Clean.");
  for (const x of violations) L.push(`- **${x.rule}** ${x.screen}: ${x.detail}`);
  return L.join("\n") + "\n";
}
