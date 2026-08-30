/* Regenerates the Google Play feature graphic from ONE file:
   tools/brand/4a-logo.png.  Run: node tools/store/build-feature-graphic.mjs

   WHY THIS IS A SCRIPT AND NOT A PNG SOMEONE MADE
   Same reason `tools/brand/build-icons.mjs` exists. Play requires a feature
   graphic at exactly 1024x500 and we had nothing at that size, so the obvious
   move is to open an editor once and commit the result. That is how the two
   pre-#-icons got into this repo with no recorded ancestor, and it is what
   `build-icons.test.mjs` was written to stop. The banner is the biggest piece of
   brand surface in the listing; it must come from the master, and it must break
   the build if it stops matching it.

   WHAT IS SHARED WITH THE ICONS AND WHAT IS COPIED, stated precisely, because
   "no duplication" would be a comfortable overstatement. SHARED, imported from
   build-icons.mjs: `background()`, `inkBox()`, `resizeArea()` and `SNAP` — read
   the cream, trim to the ink, area-average, quantise. Those are the four places
   a second implementation would drift the day the logo is redrawn, and the drift
   would show: the banner and the icon appear a centimetre apart in the listing.
   COPIED, deliberately: the compose step below is about eighteen lines that also
   appear in `renderIcon()` — allocate, flood-fill, row-copy, snap, encode. It
   was left copied because the two differ in the only part that matters and the
   comments explaining each difference are the value: `renderIcon` fits a SQUARE
   by whichever axis binds, this fits a 2.05:1 canvas by WIDTH with a height
   backstop. Extracting a shared `compose()` would also put a store-listing
   concern inside the generator for the icons that ship on devices. Revisit at
   the third caller; two copies of a flood-fill is not the problem worth solving.

   Where the founder actually uses this: `docs/store/play/README.md` §5, and
   `HUMAN-ACTIONS.md` #26.

   WHAT THE GRAPHIC IS, AND WHY IT IS ONLY THE MARK
   A feature graphic is a LIST THUMBNAIL before it is anything else — Play scales
   it down hard in promotional rails and crops it to other aspect ratios in
   places we do not control. So it carries the wordmark on the brand ground and
   nothing else. No tagline: at rail size a tagline is a grey smear, and Play
   overlays its own title on some surfaces, which is exactly where a second line
   of type collides. Nothing here is invented either — every pixel is the master
   or the master's own background colour.

   THE ASPECT IS THE WHOLE DESIGN PROBLEM. 1024x500 is 2.05:1 and the mark is
   about 1.89:1, so unlike the square icons this is nearly a natural fit and the
   mark is placed by WIDTH, not padded into a shape it does not want. See SPAN_W
   / SPAN_H below for why it is not simply flush. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encode } from "../brand/png.mjs";
import { loadMaster, background, inkBox, resizeArea, SNAP } from "../brand/build-icons.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");

/* Play's requirement, to the pixel. Not a preference and not a maximum: the
   Console rejects any other size outright. */
export const WIDTH = 1024;
export const HEIGHT = 500;

/* Where it goes. `docs/` so it sits with the copy the founder pastes beside it,
   and so it is never mistaken for something the app or the web bundle ships. */
export const OUTPUT = "docs/store/play/feature-graphic.png";

/* Fraction of each axis the mark's bounding box may span.
 *
 * Width binds at these numbers (0.64*1024/1.8873 = 347 tall, against 0.70*500 =
 * 350), which is the intent: the mark should be sized by the long axis of a wide
 * canvas, and the height limit is only there so a REDRAWN, taller logo cannot
 * run off the top and bottom edges.
 *
 * They are not 1.0 for two reasons specific to this asset rather than general
 * good taste. Play re-crops the feature graphic to other ratios in surfaces we
 * do not choose, and a mark flush to the edge loses its ends in the first such
 * crop; and Play composites its own text over the graphic on some placements,
 * which needs quiet edges to land on.
 *
 * MEASURED at today's master, not estimated: the mark lands 655x347 at offset
 * (185, 77), so 185 px of ground left and 184 right, 77 above and 76 below. A
 * 16:9 centre crop of this canvas is 889x500, which clears the mark by 117 px a
 * side.
 *
 * BOTH ARE EXPORTED AND BOTH ARE PINNED in play-listing.test.mjs. That is not
 * ceremony: the pixel test there re-renders through THIS function, so changing a
 * span moves the committed file and the fresh render together and the comparison
 * still passes. Without a pinned constant, "the banner is 22% smaller now" is a
 * one-character edit that no test sees. Same argument as WIDTH/HEIGHT above. */
export const SPAN_W = 0.64;
export const SPAN_H = 0.70;

/* SNAP is IMPORTED from build-icons.mjs rather than restated here. Same
   threshold, same reason: the master's "flat" cream ground is not flat, it
   carries compression noise, and PNG pays per unpredictable byte across the ~56%
   of this canvas that is bare ground — plus the cream inside the mark's own
   bounding box.

   MEASURED HERE, not assumed from the icons: 0 gives 121.5 KB, 4 gives 120.7,
   8 gives 105.3, 12 gives 96.8, 20 gives 91.3, 30 gives 89.4. The same shape as
   the icon curve and the same call — 12 to 20 buys 5.5 KB and 12 to 30 buys
   7.4 KB in total, against a real risk, because a large enough threshold starts
   eating the anti-aliased edge where the ink meets the ground.

   This asset is NOT under bundle pressure the way icon-512 is: the banner is
   uploaded to Play and never shipped to a device, and Play's own ceiling for it
   is 15 MB. Sharing the constant is about the two artefacts agreeing, not about
   bytes. */
export { SNAP };

/* Exported so the test can re-render in memory and compare against the committed
   bytes, rather than shelling out and diffing the working tree. */
export function renderFeatureGraphic(master) {
  const bg = background(master);
  const box = inkBox(master, bg);

  const scale = Math.min((WIDTH * SPAN_W) / box.w, (HEIGHT * SPAN_H) / box.h);
  const dw = Math.max(1, Math.round(box.w * scale));
  const dh = Math.max(1, Math.round(box.h * scale));

  const mark = resizeArea(master, box, dw, dh);

  const canvas = Buffer.alloc(WIDTH * HEIGHT * 4);
  for (let i = 0; i < canvas.length; i += 4) {
    canvas[i] = bg[0]; canvas[i + 1] = bg[1]; canvas[i + 2] = bg[2]; canvas[i + 3] = 255;
  }
  const ox = Math.round((WIDTH - dw) / 2), oy = Math.round((HEIGHT - dh) / 2);
  for (let y = 0; y < dh; y++) {
    mark.data.copy(canvas, ((oy + y) * WIDTH + ox) * 4, y * dw * 4, (y + 1) * dw * 4);
  }

  for (let i = 0; i < canvas.length; i += 4) {
    const dist = Math.abs(canvas[i] - bg[0]) + Math.abs(canvas[i + 1] - bg[1]) + Math.abs(canvas[i + 2] - bg[2]);
    if (dist > 0 && dist <= SNAP) {
      canvas[i] = bg[0]; canvas[i + 1] = bg[1]; canvas[i + 2] = bg[2];
    }
  }

  /* rgb: true drops the alpha channel. Play accepts a 32-bit PNG, but the image
     is opaque, the alpha channel is a quarter of the pixel data for no
     information, and every other PNG this repo emits is colour type 2. */
  return encode({ width: WIDTH, height: HEIGHT, data: canvas }, { rgb: true });
}

if (process.argv[1] && process.argv[1].endsWith("build-feature-graphic.mjs")) {
  const master = loadMaster();
  const png = renderFeatureGraphic(master);
  const out = path.join(ROOT, OUTPUT);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, png);
  console.log(`${OUTPUT}  ${WIDTH}x${HEIGHT}  ${(png.length / 1024).toFixed(1)} KB`);
}
