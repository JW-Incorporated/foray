/* The in-page half of the car posture check: ONE function, `measureCar`, evaluated with page.evaluate(), that reads
 * the laid-out Now Playing sheet and returns plain numbers and booleans. lib/car-rules.mjs is the pure half that
 * decides what they mean, and car-check.mjs drives both. Nothing here judges; it only measures, so a fake that
 * answers "yes" cannot hide in it (CLAUDE.md, "audit the harness, not only the test").
 *
 * Self-contained on purpose: page.evaluate() serialises the function, so it may not close over anything. */

export function measureCar() {
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
  };
  /* "Rendered" is the browser's own answer: an element with display:none anywhere above it has no client rects. */
  const rendered = (sel) => {
    const els = Array.from(document.querySelectorAll(sel));
    return els.some((el) => el.getClientRects().length > 0);
  };
  const first = (sel) => document.querySelector(sel);
  const px = (v) => Number.parseFloat(v);
  const style = (el) => (el ? getComputedStyle(el) : null);

  const root = document.documentElement;
  const sheet = first(".fp-sheet");
  const title = first(".fp-s-title");
  const show = first(".fp-s-show");
  const progress = first(".ag-np-progress");
  const head = first(".ag-np-head");
  const play = first(".ag-np-play");
  const skips = Array.from(document.querySelectorAll(".ag-np-skip"));
  const chip = first(".ag-np-car-chip");
  const scroller = first(".fp-sheet-scroll");
  const art = first(".ag-np-art-swap");

  const titleStyle = style(title);
  const lineHeight = titleStyle ? px(titleStyle.lineHeight) : 0;
  const titleBox = box(title);
  /* The clamp is read from the computed style, the rendered line count from the laid-out height: the two must agree
     (a clamp that is declared but never reached is not an ellipsis; a count above the clamp is not a clamp). */
  const clamp = titleStyle ? Number.parseInt(titleStyle.webkitLineClamp, 10) || 0 : 0;
  const lines = titleBox && lineHeight ? Math.round(titleBox.height / lineHeight) : 0;
  /* Ellipsis exists only when the clamped box hides a line: scrollHeight above the box by half a line or more (a lone line
     overflows its 1.125 leading by ~2px of glyph, which is not a hidden line). */
  const truncated = title ? title.scrollHeight > title.clientHeight + lineHeight / 2 : false;

  const chipStyle = style(chip);
  const playIcon = play ? play.querySelector("svg") : null;
  const skipIcon = skips[0] ? skips[0].querySelector("svg") : null;

  return {
    viewport: { w: innerWidth, h: innerHeight },
    posture: root.getAttribute("data-posture"),
    sheetOpen: Boolean(sheet && !sheet.hidden && sheet.getClientRects().length > 0),
    dock: {
      "#dock": rendered("#dock"),
      ".dock-fade": rendered(".dock-fade"),
      ".dock-cast": rendered(".dock-cast"),
      "#tab-bar": rendered("#tab-bar"),
    },
    art: box(art),
    play: box(play),
    playIcon: playIcon ? { width: playIcon.getBoundingClientRect().width } : null,
    skips: skips.map(box),
    skipIcon: skipIcon ? { width: skipIcon.getBoundingClientRect().width } : null,
    title: {
      text: title ? title.textContent : "",
      fontSize: titleStyle ? px(titleStyle.fontSize) : 0,
      lineHeight,
      clamp,
      lines,
      truncated,
      scrollHeight: title ? title.scrollHeight : 0,
      clientHeight: title ? title.clientHeight : 0,
      box: titleBox,
    },
    chip: chip
      ? {
          rendered: chip.getClientRects().length > 0,
          box: box(chip),
          fontSize: chipStyle ? px(chipStyle.fontSize) : 0,
          lineHeight: chipStyle ? px(chipStyle.lineHeight) : 0,
          pressed: chip.getAttribute("aria-pressed"),
          label: chip.getAttribute("aria-label") || "",
        }
      : null,
    notRendered: Object.fromEntries(
      [".fp-s-why", ".ag-np-actions", ".ag-np-legacy-actions", ".ag-np-detail-handle", ".ag-np-detail", ".fp-s-desc", ".ag-np-clips", ".ag-np-more-btn"]
        .map((sel) => [sel, !rendered(sel)])
    ),
    scroller: scroller ? { scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight } : null,
    /* Room left under the show line, above the progress strip: reported, never gated (the spec fixes the clamp). */
    slack: show && progress ? Math.round(progress.getBoundingClientRect().top - show.getBoundingClientRect().bottom) : null,
    headBottom: head ? head.getBoundingClientRect().bottom : null,
  };
}
