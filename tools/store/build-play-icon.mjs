/* Regenerates the Google Play STORE icon from ONE file: tools/brand/4a-logo.png.
   Run: node tools/store/build-play-icon.mjs

   WHY THIS EXISTS AT ALL, GIVEN icon-512.png ALREADY IS 512x512
   Google Play rejected `icon-512.png`, and both reasons are real.

   1. COLOUR TYPE. Play's spec is not "a 512px PNG", it is:

        "32-bit PNG (with alpha)  ...  Dimensions: 512px by 512px"
        -- https://support.google.com/googleplay/android-developer/answer/9866151

      `icon-512.png` is colour type 2 -- 24-bit RGB, no alpha channel -- and
      that is DELIBERATE and must stay that way: the App Store rejects an icon
      that carries an alpha channel, `tools/brand/png.mjs` documents it at
      `encode()`, and `tools/brand/build-icons.test.mjs` asserts colour type 2
      for exactly that reason. The two stores want opposite files. This is
      therefore a SECOND icon, not an edit to the first, and the alpha channel
      here is fully opaque (255 everywhere) because Play also says:

        "Pick a background color appropriate for your brand without
         transparency (transparent assets will display the Google Play UI
         background color)"
        -- https://developer.android.com/distribute/google-play/resources/icon-design-specifications

      So: 32 bits per pixel, none of them transparent. The alpha plane is a
      constant, which is why it costs 8.7 KB and not a third of the file.

   2. COMPOSITION, which is the more interesting half. `build-icons.mjs` places
      the mark at SPAN = 0.78 of the square, fitting by whichever axis binds.
      The master is a WIDE wordmark at 804x426 (1.887:1), so width binds and the
      mark lands 399x212 -- 41.4% of the icon's height. The other 58.6% is
      cream. Play masks every icon with a corner radius of 30% of its size and
      renders it at roughly 48px in a list, and at that size a mark floating in
      a horizontal band reads as a small logo in a box rather than as an app
      icon. Play's own guidance is "fill your entire asset with artwork when
      possible".

   WHAT IS SHARED AND WHAT IS NOT, stated as precisely as
   `build-feature-graphic.mjs` states it, because that file is this one's
   closest precedent and the same honesty is owed. SHARED, imported from
   `build-icons.mjs`: `loadMaster()`, `background()`, `inkBox()`, `resizeArea()`
   and `SNAP`. Those four are where a second implementation would drift the day
   the logo is redrawn, and the drift would show -- the icon and the banner sit
   a centimetre apart in the Play listing. COPIED, deliberately: the compose
   step is the same allocate / flood-fill / row-copy / snap / encode as
   `renderIcon()` and `renderFeatureGraphic()`. It is copied for the same reason
   the banner copied it, plus one more: this is now the THIRD caller, which is
   the point the banner's header nominated for revisiting. It was revisited and
   the answer is still no, because all three differ in the only part that
   matters and the differences are what the comments carry -- `renderIcon` fits
   a square with no crop, `renderFeatureGraphic` fits 2.05:1 by width, and this
   one CROPS FIRST and then fits, and emits a different colour type. A shared
   `compose(canvasW, canvasH, box, span, rgb)` would take five parameters to
   save eighteen lines and would put the Play-listing crop rule inside the
   generator for the icons that ship on devices.

   THE DESIGN JUDGEMENT: CROPPED, NOT SCALED. ARGUED, BECAUSE IT IS A CHOICE.
   Scaling the whole wordmark up is the smaller change and it was measured
   first: at SPAN 0.94 with no crop the mark is 481x255, still only 49.8% of the
   height, and the trailing waveform -- the three strokes after the "a" -- is
   under two pixels wide once Play renders it at 48. It does not read as a
   waveform there; it reads as a grey-green smudge with a fuzzy "4a" beside it.
   The band problem is halved and the legibility problem is not touched.

   So the crop keeps the "4a" ligature -- the 4, the wave stroke that crosses
   it, and the "a" whose bowl the wave forms -- and drops the wordmark's
   trailing oscillation. Rendered at 48px and inspected, all four glyph
   decisions survive: the 4's counter stays open, the a's counter stays open,
   the wave still visibly passes THROUGH the 4 and turns into the a, and the
   tail still curls. That is the whole idea of the mark, and it is the part that
   is still legible at list size. Nothing is invented, recoloured or restyled --
   every pixel emitted here is the master's, resampled.

   WHAT THE CROP COSTS, honestly: the trailing oscillation is the most literally
   "audio" element in the logo, and at 512px, where it would have been legible,
   it is gone. This asset is a list thumbnail before it is anything else -- the
   same argument `build-feature-graphic.mjs` makes for carrying no tagline --
   and the full wordmark is still what the feature graphic beside it shows, what
   the app itself ships as `icon-512.png`, and what the App Store gets. The crop
   also invents a stroke terminal: the tail is cut mid-curve, because the only
   genuine right-hand terminal in this artwork is the end of the wordmark
   itself. CROP_ASPECT was chosen to land that cut just past the wave's trough,
   where the stroke has turned upward and the cut reads as a flourish.

   NO ROUNDED CORNERS AND NO SHADOW ARE BAKED IN, which is why neither appears
   below. Play applies both itself -- "Don't round the edges of your final
   asset", "Don't add drop shadows to your final asset" -- and artwork that
   pre-rounds gets rounded twice. The ground is flood-filled to all four edges
   for the same reason: after a 30% corner radius, a border would be eaten
   unevenly. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encode } from "../brand/png.mjs";
import { loadMaster, background, inkBox, resizeArea, SNAP } from "../brand/build-icons.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");

/* Play's requirement, to the pixel. Not a maximum and not a preference: the
   Console rejects any other size. Square, so one number. */
export const SIZE = 512;

/* Where it goes. `docs/store/play/` with the rest of the submission package,
   NOT the repo root, because nothing ships this file -- it is uploaded to the
   Console once and never enters a bundle. Putting it at the root next to
   `icon-512.png` would invite exactly the confusion this whole file exists to
   prevent, and would put a 32-bit PNG one tab-completion away from the 24-bit
   one the App Store needs. */
export const OUTPUT = "docs/store/play/app-icon-512.png";

/* THE CROP. The master's ink box is trimmed on the RIGHT to at most this
   aspect, keeping its left edge, which is where the "4a" ligature starts.
   Expressed as an aspect rather than a pixel column so a redrawn logo still
   gets a crop that means "no wider than this in a square" instead of a cut at
   column 596 of an image that no longer has 804 columns.
 *
 * 1.40 is measured, not picked. Against today's master it cuts at column 596 of
 * 804, which is 52 px past the "a"'s right stem and just past the trough of the
 * wave that follows it -- the stroke has turned upward again, so the cut lands
 * on a rising curve and reads as a terminal flourish rather than a severed
 * horizontal. Cutting tighter is worse in a way that is visible: at 1.35 and
 * 1.30 the cut walks back into the trough and then into the "a" itself, and the
 * bowl starts to look clipped.
 *
 * It also interacts with SPAN through Play's 30% corner mask, and THAT
 * INTERACTION IS NOT MONOTONIC, which is worth stating because the obvious
 * mental model is wrong and a reader who assumes it will pick a bad number.
 * Measured, counting ink pixels whose CENTRES fall outside the mask on the
 * finished 512 at SPAN 0.94: 1.10 clips 654, 1.20 clips 0, 1.25 clips 52, 1.30
 * clips 57, 1.35 clips 25, 1.40 clips 0, 1.45 clips 0. (Centres, not pixel
 * origins -- the difference is half a pixel and it biases the count toward the
 * bottom-right, which is the corner that matters here. See the mask test.)
 *
 * "Tighter crop, taller mark, more ink in the corners" predicts a curve that
 * only rises as the aspect falls. It is not what happens, and every clipped
 * pixel in the table above says why: they are all in the BOTTOM-RIGHT corner,
 * around (496, 428). What lands there is not the mark in general, it is
 * whatever the crop's right edge cuts. Between 1.25 and 1.35 the cut falls in
 * or near the TROUGH of the wave that follows the "a" -- the lowest ink on that
 * side -- and a mark that tall drops the trough into the corner the mask takes.
 * By 1.40 the cut has moved past the trough onto the rising stroke, so the
 * right-hand ink sits higher and clears it. Below 1.20 the cut is back inside
 * the "a", whose right stem also sits high, until 1.10 makes the mark tall
 * enough that the bowl itself reaches the corner.
 *
 * So 1.40 is not "the tightest aspect that clips nothing" -- 1.20 also clips
 * nothing and is a much worse icon. It is the aspect that both clears the
 * trough and keeps the "a" whole, and it has a neighbour (1.45) that is also
 * clear, which is the margin. `play-listing.test.mjs` asserts the zero rather
 * than trusting any of this arithmetic to survive the next redraw.
 *
 * `Math.min` with the box's own width means a redrawn logo that is ALREADY
 * squarer than 1.40:1 is not cropped at all, only scaled. */
export const CROP_ASPECT = 1.40;

/* Fraction of the square the CROPPED mark spans. 0.94, against 0.78 for the
   shipped icons, and the difference is not a style preference -- it is the
   whole reason this file exists.
 *
 * `build-icons.mjs` justifies 0.78 by the Android ADAPTIVE-icon safe zone: a
 * launcher may cut the central 80% into a circle, so a wide box has to stay
 * small. That reasoning is correct for the icon on the device and does not
 * apply here. This file is never a launcher icon; it is the Play STORE listing
 * icon, which Play masks with a fixed 30% corner radius and nothing else. A
 * corner radius takes the corners; a circle takes everything outside the
 * inscribed disc. Reusing the launcher's budget for a store asset is what left
 * 58.6% of the square empty.
 *
 * At 0.94 the mark lands 481x344 at (16, 84): 15-16 px of ground either side,
 * 84 above and below, and 67.2% of the icon's height carries ink, against
 * 41.4% today. Measured, not estimated. 0.96 and 0.98 fill more and start
 * clipping (34 and 189 ink pixels), so 0.94 is where this stops. */
export const SPAN = 0.94;

/* SNAP is IMPORTED, not restated, for the reason build-icons.mjs gives where it
   is defined and build-feature-graphic.mjs repeats: three assets quantised from
   one master must be quantised identically, or a redraw produces three
   backgrounds that do not match in a listing that shows two of them together.

   MEASURED HERE on this composition rather than assumed from the other two,
   because the crop changed the ratio of ground to ink: 0 gives 99.9 KB, 4 gives
   99.3, 8 gives 88.2, 12 gives 81.6, 20 gives 77.4, 30 gives 75.9. Same shape as
   both other curves and the same call -- past 12 the return is under 6 KB and a
   larger threshold starts eating the anti-aliased edge where ink meets ground.

   This asset is not under bundle pressure: it is uploaded to Play and never
   shipped to a device, and Play's own ceiling is 1024 KB. */
export { SNAP };

/* Exported so the test can re-render in memory and compare against the
   committed bytes, rather than shelling out and diffing the working tree. */
export function renderPlayIcon(master) {
  const bg = background(master);
  const box = inkBox(master, bg);

  /* Crop from the left edge of the ink, never past the ink's own width. */
  const cropW = Math.min(box.w, Math.round(box.h * CROP_ASPECT));
  const crop = { x0: box.x0, y0: box.y0, w: cropW, h: box.h };

  /* Fit by whichever axis binds. Width binds at today's 1.399:1, but a redrawn
     logo taller than it is wide must not run off the top and bottom. */
  const scale = Math.min((SIZE * SPAN) / crop.w, (SIZE * SPAN) / crop.h);
  const dw = Math.max(1, Math.round(crop.w * scale));
  const dh = Math.max(1, Math.round(crop.h * scale));

  const mark = resizeArea(master, crop, dw, dh);

  /* Full bleed: the ground reaches all four edges. No border, no rounding, no
     shadow -- Play adds the radius and the shadow itself. */
  const canvas = Buffer.alloc(SIZE * SIZE * 4);
  for (let i = 0; i < canvas.length; i += 4) {
    canvas[i] = bg[0]; canvas[i + 1] = bg[1]; canvas[i + 2] = bg[2]; canvas[i + 3] = 255;
  }
  const ox = Math.round((SIZE - dw) / 2), oy = Math.round((SIZE - dh) / 2);
  for (let y = 0; y < dh; y++) {
    mark.data.copy(canvas, ((oy + y) * SIZE + ox) * 4, y * dw * 4, (y + 1) * dw * 4);
  }

  for (let i = 0; i < canvas.length; i += 4) {
    const dist = Math.abs(canvas[i] - bg[0]) + Math.abs(canvas[i + 1] - bg[1]) + Math.abs(canvas[i + 2] - bg[2]);
    if (dist > 0 && dist <= SNAP) {
      canvas[i] = bg[0]; canvas[i + 1] = bg[1]; canvas[i + 2] = bg[2];
    }
  }

  /* `rgb: false` KEEPS the alpha channel: colour type 6, 32 bits per pixel,
     which is Play's stated requirement. This is the ONE PNG in this repo that
     is not colour type 2, and the inversion is the point -- see the header.
     Every alpha byte is 255; nothing here is transparent. */
  return encode({ width: SIZE, height: SIZE, data: canvas }, { rgb: false });
}

if (process.argv[1] && process.argv[1].endsWith("build-play-icon.mjs")) {
  const png = renderPlayIcon(loadMaster());
  const out = path.join(ROOT, OUTPUT);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, png);
  console.log(`${OUTPUT}  ${SIZE}x${SIZE}  RGBA  ${(png.length / 1024).toFixed(1)} KB`);
}
