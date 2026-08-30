/* The icons are GENERATED, and this suite is the only thing that keeps that
   true. Without it, `build-icons.mjs` is a script someone ran once: the next
   person edits icon-512.png in an image editor, every test stays green, and the
   master and the shipped icon quietly disagree for months.

   WHY PIXELS AND NOT BYTES. The obvious test is `readFileSync(icon) ===
   renderIcon(master)`. It is wrong. `encode()` compresses with node:zlib, and
   zlib's output is not guaranteed identical across zlib versions, so a byte
   comparison fails on CI's Node 22 against a developer's Node 24 for a reason
   that has nothing to do with the icons. Decoding both sides and comparing pixel
   buffers pins exactly the property we care about -- the committed icon shows
   what the master says it should -- and is indifferent to how it was packed.

   MUTATIONS THESE KILL, all run:
     - flip one byte in the middle of icon-512.png   -> "pixels differ" (test 2)
     - regenerate with SPAN = 0.70, PUT SPAN BACK    -> "pixels differ" (test 2)
     - regenerate with SNAP = 30, PUT SNAP BACK      -> "pixels differ" (test 2)
     - encode({rgb:false}) so icons carry alpha      -> "colour type" (test 3)
     - drop "icon-512.png" from prepare-webdir       -> test 6
     - add "icon-1024.png" to prepare-dist           -> test 7
     - break decode()'s Paeth arm                    -> test 2 (the master
       decodes differently, so every icon stops matching)

   THE TWO "regenerate with" LINES ABOVE SAY "PUT IT BACK" FOR A REASON, and it
   is a correction: they previously read "regenerate with SPAN = 0.70 -> pixels
   differ", which is FALSE and was found false by re-running it during review of
   the Play-listing suite (2026-08-25). Leave the constant changed and test 2 is
   GREEN — it re-renders through `renderIcon`, so the committed icon and the
   fresh render move together and agree at the new size. What test 2 catches is a
   STALE icon: a file that no longer matches the generator as it stands. That is
   the property this suite exists for and it is worth having; it is simply not
   "you cannot change SPAN unnoticed". Nothing here pins SPAN or SNAP, and a
   deliberate re-proportioning of the icons is a one-character edit no test sees.
   `tools/store/play-listing.test.mjs` pins its own equivalents for that reason;
   these are left unpinned because raising it here means arguing about the right
   SPAN for three masks, which nobody has needed to do yet. Recorded rather than
   quietly deleted, because a false evidence claim is worse than none: the next
   reader stops checking.

   ONE FURTHER MUTATION IS DELIBERATELY NOT COVERED, because it is not a defect.
   Collapsing encode()'s Paeth arm onto Sub (`v = cur[x] - a`) makes the two
   candidates score identically; the tie goes to Sub, filter 4 is never selected,
   and the PNG still decodes to exactly the right pixels. It costs 2.8 KB on the
   512 and nothing else. A ceiling tight enough to catch 2.8 KB would fire on any
   ordinary logo change, so test 9 guards the budget at a real threshold instead
   and this stays uncovered on purpose. Paeth is chosen for 187 of icon-512's 512
   scanlines, so the arm is load-bearing for size even though no test pins it. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decode, encode } from "./png.mjs";
import { loadMaster, renderIcon, SIZES, MASTER } from "./build-icons.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel));
const text = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

/* IHDR is at a fixed offset in every PNG: 8 signature bytes, then a 4-byte
   length and the 4-byte type, so the fields start at 16. */
function header(buf) {
  return {
    width: buf.readUInt32BE(16), height: buf.readUInt32BE(20),
    depth: buf[24], colour: buf[25],
  };
}

test("the master exists and is the one file the icons come from", () => {
  assert.ok(fs.existsSync(MASTER), "tools/brand/4a-logo.png is missing");
  const m = loadMaster();
  assert.ok(m.width > 0 && m.height > 0);
  /* Opaque. A master with real transparency would need compositing decisions
     this script does not make, and would silently produce icons with fringes. */
  for (let i = 3; i < m.data.length; i += 4) {
    if (m.data[i] !== 255) assert.fail("master has transparent pixels; build-icons.mjs assumes opaque");
  }
});

for (const { file, px } of SIZES) {
  test(`${file} is exactly what the master renders to`, () => {
    const committed = decode(read(file));
    const fresh = decode(renderIcon(loadMaster(), px));
    assert.equal(committed.width, fresh.width, `${file}: width`);
    assert.equal(committed.height, fresh.height, `${file}: height`);
    assert.ok(
      committed.data.equals(fresh.data),
      `${file} pixels differ from a fresh render of the master. ` +
        `Do not edit icons by hand: change tools/brand/4a-logo.png and run ` +
        `node tools/brand/build-icons.mjs.`
    );
  });

  test(`${file} is square, 8-bit, and carries no alpha channel`, () => {
    const h = header(read(file));
    assert.equal(h.width, px, `${file}: width`);
    assert.equal(h.height, px, `${file}: height`);
    assert.equal(h.depth, 8, `${file}: bit depth`);
    /* Colour type 2 is RGB. The App Store rejects an icon with an alpha
       channel outright, and these are opaque anyway. */
    assert.equal(h.colour, 2, `${file}: must be RGB (colour type 2), not RGBA`);
  });
}

test("SIZES still names exactly the three icons we publish", () => {
  /* The per-icon tests above are GENERATED from this list, so deleting an entry
     deletes its tests too and the static floor in test/suite-integrity.test.js
     -- which counts `test(` call sites, not runtime tests -- would not move.
     This is the guard for that. */
  assert.deepEqual(
    SIZES.map((s) => s.file).sort(),
    ["icon-1024.png", "icon-180.png", "icon-512.png"]
  );
  assert.deepEqual(SIZES.map((s) => s.px).sort((a, b) => a - b), [180, 512, 1024]);
});

test("manifest.json declares icons that exist at the sizes it claims", () => {
  const manifest = JSON.parse(text("manifest.json"));
  assert.ok(manifest.icons?.length, "manifest.json has no icons");
  for (const icon of manifest.icons) {
    assert.ok(fs.existsSync(path.join(ROOT, icon.src)), `manifest icon missing: ${icon.src}`);
    const h = header(read(icon.src));
    assert.equal(`${h.width}x${h.height}`, icon.sizes, `${icon.src}: manifest says ${icon.sizes}`);
  }
});

test("index.html's touch icon and favicon both resolve to committed files", () => {
  const html = text("index.html");
  const hrefs = [...html.matchAll(/<link\s+rel="(?:apple-touch-)?icon"[^>]*href="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(hrefs.length >= 2, "expected both an apple-touch-icon and an icon link");
  for (const href of hrefs) {
    if (href.startsWith("data:")) continue;
    assert.ok(fs.existsSync(path.join(ROOT, href)), `index.html references a missing icon: ${href}`);
  }
});

test("both shipped icons are copied into the mobile shell and the web dist", () => {
  const shipped = ["icon-180.png", "icon-512.png"];
  for (const script of ["tools/mobile/prepare-webdir.mjs", "tools/web/prepare-dist.mjs"]) {
    const src = text(script);
    for (const icon of shipped) {
      assert.ok(src.includes(`"${icon}"`), `${script} no longer copies ${icon}`);
    }
  }
});

test("the 1024 marketing icon is NOT shipped in either bundle", () => {
  /* It exists for App Store Connect's submission form and nothing else. At
     126 KB it is larger than both shipped icons together, and the mobile slice
     is budgeted in hundreds of KB. */
  for (const script of ["tools/mobile/prepare-webdir.mjs", "tools/web/prepare-dist.mjs", "sw.js"]) {
    assert.ok(!text(script).includes("icon-1024"), `${script} must not ship icon-1024.png`);
  }
});

test("the PNG codec round-trips every scanline filter it can choose", () => {
  /* encode() picks a filter per scanline by heuristic, so a bug in one arm --
     Paeth is the easy one to get wrong -- corrupts only some images, and only
     some rows of those. Gradients, flat runs and noise between them make the
     heuristic reach for different arms on different rows. */
  const w = 64, h = 64;
  const data = Buffer.alloc(w * h * 4);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) >> 16) & 0xff;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (y < 20) { data[i] = data[i + 1] = data[i + 2] = 200; }        // flat -> Up
      else if (y < 40) { data[i] = x * 4; data[i + 1] = y * 4; data[i + 2] = 128; } // ramp -> Sub/Paeth
      else { data[i] = rnd(); data[i + 1] = rnd(); data[i + 2] = rnd(); }          // noise -> None
      data[i + 3] = 255;
    }
  }
  for (const rgb of [false, true]) {
    const back = decode(encode({ width: w, height: h, data }, { rgb }));
    assert.equal(back.width, w);
    assert.equal(back.height, h);
    assert.ok(back.data.equals(data), `round-trip lost pixels (rgb=${rgb})`);
  }
});

test("the two shipped icons stay inside their bundle budget", () => {
  /* Not a style rule. Both of these are copied into the mobile shell and
     precached by sw.js, and the mobile slice is budgeted in hundreds of KB. The
     first version of this generator emitted a 105 KB icon-512 -- filter 0 on
     every scanline, against a gradient -- which nothing would have caught.

     Ceilings are ~20% above the current 46.9 KB and 9.1 KB, so a redrawn logo
     has room and a 2x mistake does not. */
  const CEILING = { "icon-512.png": 56 * 1024, "icon-180.png": 12 * 1024 };
  for (const [file, max] of Object.entries(CEILING)) {
    const size = read(file).length;
    assert.ok(size <= max, `${file} is ${(size / 1024).toFixed(1)} KB, over its ${(max / 1024).toFixed(0)} KB budget`);
  }
});
