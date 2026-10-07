/* ui/icons.js — the Afterglow icon helper (Redesign 2026, ambient, phase 3 step 2).
   A CLASSIC script like app.js, loaded by index.html after app.js: it shares app.js's
   globals (`esc`) and runs nothing at the top level, so it changes no screen until a
   screen calls it.

   THE SYSTEM. One sprite, `ui/icons.svg` (tools/icons/build-sprite.mjs writes it):
   thirty-seven symbols, Phosphor Regular / Fill plus four custom transport glyphs, all
   filled paths on a 256 grid, painted by `currentColor`. A screen never draws an icon
   inline and never uses a text glyph (no play triangle, cross, ellipsis or chevron
   character): it calls agIcon(). The
   markup is a `<use href>` to a same-origin file, which the strict CSP already allows
   (`img-src 'self'`, no inline style, no script), and the size is a class, not a style.

   WHY A HELPER AND NOT MARKUP IN EVERY SCREEN. Thirty-seven names, five sizes and an
   `aria-hidden` that must never be forgotten: a typo in a hand-written `href` renders as
   an empty box with no error. agIcon() returns "" for a name that is not in the sprite
   rather than an empty box, and test/afterglow-icons.test.js reads every `agIcon("…")`
   and every literal `#i-…` in ui/*.js against the sprite on disk, so a rename that
   misses a call site fails CI instead of shipping a blank tab.

   The glyph is decorative: the control that wraps it carries the accessible name
   (`aria-label`, or visible text beside it), so the svg is `aria-hidden` and not focusable.
*/

/* Where the sprite is fetched from, relative to index.html (routes are hash-based, so the
   document base never changes). */
const AG_ICON_SPRITE = "ui/icons.svg";

/* Every symbol in the sprite, without the `i-` prefix, in the order BUILD-PLAN 1.2 lists
   them. Regular / Fill pairs sit together: a toggle is a change of glyph, never only of colour. */
const AG_ICON_NAMES = [
  "house", "house-fill", "compass", "compass-fill", "books", "books-fill",
  "play", "play-fill", "pause", "back15", "fwd30", "skip-next",
  "bookmark", "bookmark-fill", "check-circle", "check-circle-fill",
  "download", "download-fill", "queue", "dots",
  "chevron-left", "chevron-right", "chevron-down",
  "magnifier", "x", "share", "moon", "gauge", "sliders", "gear",
  "wifi-slash", "sparkle", "car", "arrow-up", "arrow-down", "plus", "trash",
];

/* The sizes a screen may ask for: 24 default, 20 inside chips and captions, 28 in the tab
   bar, 32 for transport secondary, 36 inside the 88 Play and the 56 skips. Each is a class
   in ui/tokens.css; 24 is the base `.icon`. */
const AG_ICON_SIZES = [20, 24, 28, 32, 36];

/** The markup for one icon: `<svg class="icon icon-28" aria-hidden="true" focusable="false">
 *  <use href="ui/icons.svg#i-house"></use></svg>`. `name` is without the `i-` prefix.
 *  A name not in the sprite, or a size not in AG_ICON_SIZES, returns "" (nothing is drawn),
 *  so a bad argument can never put a caller-chosen string into a `href` or a class. The
 *  allow-list constrains the fragment; safeUrl() constrains the relative sprite path; esc()
 *  protects the attribute context. */
function agIcon(name, size) {
  if (!AG_ICON_NAMES.includes(name)) return "";
  const px = size === undefined ? 24 : size;
  if (!AG_ICON_SIZES.includes(px)) return "";
  const cls = px === 24 ? "icon" : "icon icon-" + px;
  return '<svg class="' + cls + '" aria-hidden="true" focusable="false"><use href="' +
    esc(safeUrl(AG_ICON_SPRITE + "#i-" + name)) + '"></use></svg>';
}

/** The sprite's own section of the component gallery (build-loop 3 step 4 mounts it under
 *  `#/gallery`): every symbol at 24 with its name, then the Regular / Fill pairs side by
 *  side and the transport glyphs at each size they are used. Pure markup, no handlers;
 *  names come from AG_ICON_NAMES and pass through esc() all the same. */
function agIconGallery(id = "") {
  const cell = (n) =>
    '<li class="ag-icon-cell">' + agIcon(n) + '<span class="ag-icon-name">' + esc("i-" + n) + "</span></li>";
  const sizes = (n) =>
    '<li class="ag-icon-cell ag-icon-sizes"><span class="ag-icon-row">' + AG_ICON_SIZES.map((s) => agIcon(n, s)).join("") +
    '</span><span class="ag-icon-name">' + esc("i-" + n) + "</span></li>";
  return (
    '<section class="ag-icons"' + (id ? ' id="' + esc(id) + '"' : "") + '>' +
    '<h2 class="ag-icons-title">Icons</h2>' +
    '<ul class="ag-icon-grid">' + AG_ICON_NAMES.map(cell).join("") + "</ul>" +
    '<h3 class="ag-icons-title">Sizes</h3>' +
    '<ul class="ag-icon-grid">' + ["house", "play", "pause", "back15", "fwd30"].map(sizes).join("") + "</ul>" +
    "</section>"
  );
}
