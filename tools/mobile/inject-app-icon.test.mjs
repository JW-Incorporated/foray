/* Tests for wiring 4a's icon into the generated iOS asset catalog (2026-09-03).
 *
 * EVERY TEST HERE RUNS ON WINDOWS, like `inject-background-audio.test.mjs` beside
 * it and for the same reason: `cap add ios` and `xcodebuild` need a Mac, but
 * "which file does the catalog declare, and are those bytes our icon" is a pure
 * question about a JSON manifest and a PNG. Nothing in this file asserts anything
 * about a build — see `.github/workflows/ios-build.yml` for the checks only a
 * runner can make, and read them as unverified until a run is linked.
 *
 * WHAT WENT WRONG, so the fixtures are read as the shape of a real failure. On
 * 2026-09-03 a build reached TestFlight wearing CAPACITOR'S PLACEHOLDER ICON:
 * `cap add ios` generates `Assets.xcassets/AppIcon.appiconset` with its own
 * artwork, nothing replaced it, and the workflow archived it as-is. Every check
 * was green, because nothing had ever looked.
 *
 * AND THE STAKES ARE HIGHER THAN THE HOME SCREEN. Apple removed App Store
 * Connect's icon-upload field in Xcode 14; the PUBLIC LISTING icon is now
 * EXTRACTED from the uploaded binary's asset catalog. So this script is the only
 * path to a correct icon anywhere — home screen, TestFlight tile and product page
 * alike — with no dashboard fallback and no way to fix a build already uploaded.
 * That is why several tests below assert on an ABSENCE of forgiveness: a partial
 * write, a missing 1024 slot, or a check that passes on a file that merely exists
 * would all reproduce the original bug exactly.
 *
 * THE PLACEHOLDER IS ALSO 1024x1024, which is the single most important fact in
 * this file. It is why `--check` compares BYTES and not existence, and why the
 * placeholder fixture below is a real, valid, correctly-sized PNG rather than
 * something obviously wrong. A fixture more broken than the thing it stands for
 * is the failure CLAUDE.md's "a green test is not evidence" section lists five
 * times.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { decode, encode, header } from "../brand/png.mjs";
import {
  DEFAULT_SOURCE,
  IconError,
  SOURCE_PX,
  assertAppStoreLegalSource,
  assertIconsLanded,
  assertMarketingSlot,
  checkAppIcon,
  declaredIcons,
  injectAppIcon,
  planAppIcon,
  renderIconBytes,
} from "./inject-app-icon.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");

/** What Capacitor 8's `cap add ios` writes: ONE universal 1024 image, which in
 *  Xcode 14+ covers every slot from the home screen to the store listing. */
const CAPACITOR_CONTENTS = JSON.stringify(
  {
    images: [{ filename: "AppIcon-512@2x.png", idiom: "universal", platform: "ios", size: "1024x1024" }],
    info: { author: "xcode", version: 1 },
  },
  null,
  2
);

/** The pre-Xcode-14 shape, still what several Capacitor templates emit: many
 *  per-device slots PLUS the 1024 `ios-marketing` one. Kept as a fixture because
 *  the filename this script must write is different in it, which is the entire
 *  argument for reading the manifest instead of hardcoding a name. */
const MULTI_SIZE_CONTENTS = JSON.stringify({
  images: [
    { filename: "Icon-60@2x.png", idiom: "iphone", size: "60x60", scale: "2x" },
    { filename: "Icon-60@3x.png", idiom: "iphone", size: "60x60", scale: "3x" },
    { filename: "Icon-83.5@2x.png", idiom: "ipad", size: "83.5x83.5", scale: "2x" },
    { filename: "Icon-marketing.png", idiom: "ios-marketing", size: "1024x1024", scale: "1x" },
  ],
  info: { author: "xcode", version: 1 },
});

/** A solid square of one colour, as a real PNG. `alpha: true` emits colour type
 *  6 — the App Store's rejection case — and it is fully opaque, because "opaque
 *  RGBA" is exactly the file a well-meaning regeneration produces. */
function solidPng(px, [r, g, b], { alpha = false } = {}) {
  const data = Buffer.alloc(px * px * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
  }
  return encode({ width: px, height: px, data }, { rgb: !alpha });
}

/* CRC32 as the PNG spec defines it, so the tRNS fixture below is a VALID file
   rather than one `header()` merely fails to notice is broken. `header()` does
   not verify CRCs, so a bogus one would still pass — and a fixture that only
   works because the code under test is lax is the "more forgiving than the thing
   it stands for" failure. */
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** The same PNG with a `tRNS` chunk spliced in before its IDAT: colour type 2,
 *  and transparent anyway. */
function withTrns(png) {
  const idat = png.indexOf(Buffer.from("IDAT", "ascii")) - 4;
  const body = Buffer.concat([Buffer.from("tRNS", "ascii"), Buffer.from([0, 0, 0, 0, 0, 0])]);
  const len = Buffer.alloc(4); len.writeUInt32BE(6);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([png.subarray(0, idat), len, body, crc, png.subarray(idat)]);
}

let tmpSeq = 0;
/** A throwaway `.appiconset` holding `contents` and whatever placeholder files
 *  the caller names. Under the OS temp dir, never in the checkout. */
function catalog(contents = CAPACITOR_CONTENTS, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `foray-appicon-${tmpSeq++}-`));
  const set = path.join(dir, "AppIcon.appiconset");
  fs.mkdirSync(set);
  fs.writeFileSync(path.join(set, "Contents.json"), contents);
  for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(set, name), bytes);
  return set;
}

const REAL_SOURCE = fs.readFileSync(DEFAULT_SOURCE);

/* ══════════════════ the source icon must be App Store legal ══════════════════ */

test("REAL REPO: the committed icon-1024.png is what the App Store will accept", () => {
  /* THE POINT OF ASSERTING RATHER THAN ASSUMING. Today `icon-1024.png` is
     1024x1024 colour type 2 with no tRNS — but that is a property of a GENERATED
     file: `build-icons.mjs` passes `{ rgb: true }` to `encode()`, and a
     regeneration that loses that option produces an icon that looks perfect,
     builds, archives, uploads, and is rejected by Apple's validator after the
     wait. This test moves that failure to a Windows machine with no Mac.
     It also CANNOT FAIL ON TODAY'S FILE, and that is deliberate — CLAUDE.md's
     point 5. It is the only thing standing between a future icon regeneration and
     a rejected submission.
     MUTATION: `node -e "…"` re-encode icon-1024.png with `{ rgb: false }` -> fails
     on the alpha-channel message. RUN (against a temp copy). */
  const h = assertAppStoreLegalSource(REAL_SOURCE, "icon-1024.png");
  assert.equal(h.width, SOURCE_PX);
  assert.equal(h.height, SOURCE_PX);
  assert.equal(h.colour, 2, "colour type 2 is 8-bit RGB with no alpha channel");
});

test("an RGBA source is refused even when every pixel is opaque", () => {
  /* THE REJECTION IS ON THE CHANNEL, NOT ON THE PIXELS. A fully opaque colour
     type 6 icon is indistinguishable on screen and still bounces at Apple's
     validator, which is why this fixture is opaque.
     MUTATION: `if (h.colour === 4)` (drop the `|| h.colour === 6`) -> fails. RUN. */
  assert.throws(() => assertAppStoreLegalSource(solidPng(SOURCE_PX, [250, 250, 245], { alpha: true })),
    /ALPHA CHANNEL/);
});

test("a tRNS chunk is refused too, which colour type alone cannot see", () => {
  /* `tRNS` makes one colour transparent in a colour-type-2 image WITHOUT changing
     the colour type, so a check that reads `colour !== 2` passes on it. Apple
     rejects it the same way.
     MUTATION: delete the `h.transparency` branch in assertAppStoreLegalSource ->
     fails. RUN. */
  assert.throws(() => assertAppStoreLegalSource(withTrns(solidPng(SOURCE_PX, [250, 250, 245]))),
    /tRNS/);
});

test("a source that is not exactly 1024x1024 is refused", () => {
  /* MUTATION: `h.width < SOURCE_PX` instead of `!==` -> the 2048 case passes. RUN. */
  assert.throws(() => assertAppStoreLegalSource(solidPng(512, [250, 250, 245])), /must be exactly 1024x1024/);
  assert.throws(() => assertAppStoreLegalSource(solidPng(2048, [250, 250, 245])), /must be exactly 1024x1024/);
});

test("something that is not a PNG at all is refused, not written through", () => {
  for (const bad of [Buffer.alloc(0), Buffer.from("<svg/>"), Buffer.from("\x89PNG\r\n\x1a\n")]) {
    assert.throws(() => assertAppStoreLegalSource(bad), IconError);
  }
});

/* ═══════════════════ the catalog's manifest decides the name ═════════════════ */

test("the filename comes from Contents.json, not from this script", () => {
  /* THE WHOLE REASON THIS IS NOT `cp icon-1024.png AppIcon-512@2x.png`. That name
     is Capacitor 8's; it was different in 5, and it is a TEMPLATE. A copy to a
     name the catalog no longer declares leaves the placeholder in place and
     compiles, archives, uploads and ships the wrong icon with every check green.
     MUTATION: hardcode "AppIcon-512@2x.png" as the filename in declaredIcons ->
     the renamed and multi-size cases below fail. RUN. */
  assert.deepEqual(
    declaredIcons(CAPACITOR_CONTENTS).images.map((i) => `${i.filename}@${i.px}`),
    ["AppIcon-512@2x.png@1024"]
  );
  const renamed = CAPACITOR_CONTENTS.replace("AppIcon-512@2x.png", "AppIcon-1024-universal.png");
  assert.deepEqual(
    declaredIcons(renamed).images.map((i) => i.filename),
    ["AppIcon-1024-universal.png"]
  );
  assert.deepEqual(
    declaredIcons(MULTI_SIZE_CONTENTS).images.map((i) => `${i.filename}@${i.px}`),
    ["Icon-60@2x.png@120", "Icon-60@3x.png@180", "Icon-83.5@2x.png@167", "Icon-marketing.png@1024"]
  );
});

test("size x scale is the pixel count, and a fractional size still resolves", () => {
  /* `83.5x83.5` at `2x` is 167 real pixels — the iPad Pro slot, and the only
     place in an .appiconset where the arithmetic is not obvious.
     MUTATION: `const px = size;` (ignore scale) -> the 120/180/167 entries above
     all come back 60/60/83.5 and both tests fail. RUN. */
  const byName = new Map(declaredIcons(MULTI_SIZE_CONTENTS).images.map((i) => [i.filename, i.px]));
  assert.equal(byName.get("Icon-83.5@2x.png"), 167);
  assert.equal(byName.get("Icon-60@3x.png"), 180);
});

test("an unassigned slot is skipped rather than refused or written", () => {
  /* Xcode writes an entry with no `filename` for an empty slot. It is not an
     error and it is not a file — treating it as either would fail a catalog that
     is perfectly valid, or write a file called "undefined".
     MUTATION: drop the `filename === undefined` guard -> throws on the empty
     entry. RUN. */
  const withHole = JSON.stringify({
    images: [
      { idiom: "iphone", size: "60x60", scale: "2x" },
      { filename: "AppIcon-512@2x.png", idiom: "universal", size: "1024x1024" },
    ],
  });
  const d = declaredIcons(withHole);
  assert.equal(d.unassigned, 1);
  assert.deepEqual(d.images.map((i) => i.filename), ["AppIcon-512@2x.png"]);
});

test("a catalog that names no file at all is refused, not reported as done", () => {
  /* The silent-nothing case: zero writes, exit 0, placeholder shipped. It is the
     original bug in manifest form.
     MUTATION: `return { images, unassigned };` before the `!images.length` throw
     -> this fails, and so does "injecting is verified by re-reading". RUN. */
  assert.throws(() => declaredIcons(JSON.stringify({ images: [{ idiom: "iphone" }] })), /would write nothing/);
  assert.throws(() => declaredIcons(JSON.stringify({ images: [] })), /would write nothing/);
});

test("a Contents.json that is not an asset catalog is refused", () => {
  for (const bad of ["", "not json", "[]", '"x"', "{}", '{"images": {}}']) {
    assert.throws(() => declaredIcons(bad), IconError, `accepted ${JSON.stringify(bad)}`);
  }
});

test("a filename that is a path cannot escape the .appiconset", () => {
  /* `mobile/ios/` is generated by a third-party CLI on a runner, so its manifest
     is not a trusted input. `../../../../etc/icon.png` must be an error, not a
     write.
     MUTATION: delete the separator check -> fails. RUN. */
  for (const bad of ["../evil.png", "a/b.png", "a\\b.png", ".."]) {
    const c = CAPACITOR_CONTENTS.replace("AppIcon-512@2x.png", bad.replace(/\\/g, "\\\\"));
    assert.throws(() => declaredIcons(c), /path\s+rather than a name|path rather than a name/);
  }
});

test("a non-square size or a malformed scale is refused, never stretched", () => {
  /* MUTATION: return `Number(m[1])` from squareSize without comparing the two
     dimensions -> the 1024x512 case is silently rendered square. RUN. */
  assert.throws(() => declaredIcons(CAPACITOR_CONTENTS.replace("1024x1024", "1024x512")), /not a square/);
  assert.throws(() => declaredIcons(CAPACITOR_CONTENTS.replace('"size": "1024x1024"', '"size": "big"')), /not a square/);
  const badScale = CAPACITOR_CONTENTS.replace('"platform": "ios"', '"scale": "2"');
  assert.throws(() => declaredIcons(badScale), /not an Nx factor/);
});

test("one filename declared at two different sizes is refused", () => {
  /* One file cannot satisfy both slots. Whichever entry won, the other would
     render a wrongly-sized icon and nothing would say so.
     MUTATION: `if (seen !== undefined) continue;` -> fails. RUN. */
  const clash = JSON.stringify({
    images: [
      { filename: "Icon.png", idiom: "universal", size: "1024x1024" },
      { filename: "Icon.png", idiom: "iphone", size: "60x60", scale: "2x" },
    ],
  });
  assert.throws(() => declaredIcons(clash), /at both 1024px and 120px/);
});

/* ════════════ the 1024 slot is the store listing, so it must exist ═══════════ */

test("a catalog with no 1024 slot is REFUSED rather than partially filled", () => {
  /* App Store Connect extracts the PUBLIC LISTING icon from the uploaded binary's
     asset catalog — the upload field went away in Xcode 14 — and the slot it reads
     is the 1024 one. A catalog with only home-screen sizes would let this script
     write four small icons, report success, build, upload, and produce a listing
     with no icon of ours, unfixable without a new build.
     MUTATION: `return images;` as the first line of assertMarketingSlot -> this
     fails, and the "every declared file exists" test stops proving the listing
     case. RUN. */
  const noMarketing = JSON.stringify({
    images: [
      { filename: "Icon-60@2x.png", idiom: "iphone", size: "60x60", scale: "2x" },
      { filename: "Icon-60@3x.png", idiom: "iphone", size: "60x60", scale: "3x" },
    ],
  });
  assert.throws(() => assertMarketingSlot(declaredIcons(noMarketing).images), /no 1024x1024 image/);
  assert.throws(() => planAppIcon(noMarketing, REAL_SOURCE), /PUBLIC LISTING/);
  const set = catalog(noMarketing);
  assert.throws(() => injectAppIcon(set, DEFAULT_SOURCE), /no 1024x1024 image/);
  /* And it wrote NOTHING — a partial set is worse than a loud failure, because it
     looks finished. */
  assert.deepEqual(fs.readdirSync(set).sort(), ["Contents.json"]);
});

test("the 1024 slot is the committed icon-1024.png, byte for byte", () => {
  /* The committed `icon-1024.png` is what the store listing shows and what the PWA
     manifest points at. Shipping a near-copy inside the bundle would mean two files
     that are both "the icon" and differ, with nothing able to say which is right.

     A MUTATION SURVIVED HERE AND THE RESULT IS RECORDED RATHER THAN QUIETLY
     DROPPED, because it makes this assertion weaker than it reads. The obvious
     killer — `return encode(decode(sourceBuf), { rgb: true })` instead of returning
     the source — did NOT break it: `icon-1024.png` was produced by that exact
     encoder from those exact pixels, so a `{ rgb: true }` re-encode is a FIXED
     POINT on today's master and comes back byte-identical. So what this test
     actually pins is "the bundle icon is the committed file and not some other
     one", which is the claim that matters and is the one mutated below.
     MUTATIONS, both run: point `DEFAULT_SOURCE` at `icon-512.png` -> fails; drop
     `{ rgb: true }` from that re-encode -> fails (on the alpha channel, via
     assertIconsLanded). RUN. */
  assert.equal(
    path.resolve(DEFAULT_SOURCE),
    path.join(ROOT, "icon-1024.png"),
    "the bundle icon no longer comes from the committed icon-1024.png"
  );
  const set = catalog();
  injectAppIcon(set, DEFAULT_SOURCE);
  const written = fs.readFileSync(path.join(set, "AppIcon-512@2x.png"));
  assert.equal(Buffer.compare(written, REAL_SOURCE), 0, "the 1024 slot is not icon-1024.png");
});

/* ═════════════════════════════ writing the icon ══════════════════════════════ */

test("every file Contents.json references exists on disk after injection", () => {
  /* The assertion that would have caught the original bug, stated as the
     coordinator asked for it: nothing the manifest declares may be missing.
     MUTATION: `for (const p of plan.slice(0, 1))` in injectAppIcon's write loop
     -> the multi-size case fails on the second filename. RUN. */
  for (const contents of [CAPACITOR_CONTENTS, MULTI_SIZE_CONTENTS]) {
    const set = catalog(contents);
    const r = injectAppIcon(set, DEFAULT_SOURCE);
    for (const { filename } of declaredIcons(contents).images) {
      assert.ok(fs.existsSync(path.join(set, filename)), `${filename} is declared but was not written`);
      assert.ok(r.files.includes(filename));
    }
  }
});

test("each written slot is the pixel size its slot declares, and carries no alpha", () => {
  /* A downscale that ignored `px`, or one that emitted RGBA, would produce files
     that exist, are valid PNGs, and are wrong in the two ways iOS notices.
     MUTATION: `encode(small)` without `{ rgb: true }` in renderIconBytes -> the
     colour-type assertion fails on every downscaled slot (and `assertIconsLanded`
     throws first). RUN. */
  const set = catalog(MULTI_SIZE_CONTENTS);
  injectAppIcon(set, DEFAULT_SOURCE);
  for (const { filename, px } of declaredIcons(MULTI_SIZE_CONTENTS).images) {
    const h = header(fs.readFileSync(path.join(set, filename)));
    assert.equal(h.width, px, filename);
    assert.equal(h.height, px, filename);
    assert.equal(h.colour, 2, `${filename} carries an alpha channel`);
    assert.equal(h.transparency, false, filename);
  }
});

test("a downscaled slot is really the icon, not a blank square", () => {
  /* The cheapest way to satisfy every assertion above is to write a solid colour
     of the right size, and it would pass all of them. The master is dark ink on a
     cream ground, so SOME pixel must be far from the corner — asserted as a
     maximum distance rather than at a named coordinate, because where the ink
     lands is a property of the logo and this test must not go red when the logo is
     redrawn.
     MUTATION: `resizeArea(img, { x0: 0, y0: 0, w: 1, h: 1 }, px, px)` -> the whole
     output becomes one corner pixel, the spread collapses to 0, and this fails. RUN. */
  const small = decode(renderIconBytes(180, REAL_SOURCE));
  const at = (i) => [small.data[i * 4], small.data[i * 4 + 1], small.data[i * 4 + 2]];
  const ground = at(2 * 180 + 2);
  let spread = 0;
  for (let i = 0; i < 180 * 180; i++) {
    const p = at(i);
    spread = Math.max(spread, Math.abs(p[0] - ground[0]) + Math.abs(p[1] - ground[1]) + Math.abs(p[2] - ground[2]));
  }
  assert.ok(spread > 100, `the downscaled icon is nearly flat (max distance from the ground: ${spread})`);
});

test("upscaling is refused rather than attempted", () => {
  /* MUTATION: delete the `px > SOURCE_PX` branch in renderIconBytes -> resizeArea
     happily upsamples and both assertions fail. RUN.
     The catalog fixture keeps its 1024 marketing slot on purpose, so the refusal
     under test is the UPSCALE and not `assertMarketingSlot` firing first. */
  assert.throws(() => renderIconBytes(2048, REAL_SOURCE), /will not upscale/);
  const tooBig = JSON.stringify({
    images: [
      { filename: "AppIcon-512@2x.png", idiom: "universal", size: "1024x1024" },
      { filename: "AppIcon-1024@2x.png", idiom: "universal", size: "1024x1024", scale: "2x" },
    ],
  });
  assert.throws(() => planAppIcon(tooBig, REAL_SOURCE), /will not upscale/);
});

test("running it twice writes nothing the second time", () => {
  /* CI re-runs and `cap sync` regenerates. Reported as unchanged rather than
     rewritten, so a log line saying "wrote" means something happened.
     MUTATION: remove the `Buffer.compare(...) === 0` skip -> `changed` is true on
     the second run and this fails. RUN. */
  const set = catalog();
  const once = injectAppIcon(set, DEFAULT_SOURCE);
  assert.equal(once.changed, true);
  const twice = injectAppIcon(set, DEFAULT_SOURCE);
  assert.equal(twice.changed, false);
  assert.deepEqual(twice.wrote, []);
  assert.match(twice.reason, /already matched/);
});

test("the placeholder is REPLACED, not left because a file was already there", () => {
  /* THE ACTUAL BUG, reproduced. Capacitor's placeholder is a valid 1024x1024 PNG
     sitting at exactly the declared filename, so any check shaped like "does the
     file exist" passes on it.
     MUTATION: `if (fs.existsSync(at)) continue;` in the write loop -> the
     placeholder survives and this fails. RUN. */
  const placeholder = solidPng(SOURCE_PX, [16, 32, 64]);
  const set = catalog(CAPACITOR_CONTENTS, { "AppIcon-512@2x.png": placeholder });
  const r = injectAppIcon(set, DEFAULT_SOURCE);
  assert.deepEqual(r.wrote, ["AppIcon-512@2x.png"]);
  assert.equal(
    Buffer.compare(fs.readFileSync(path.join(set, "AppIcon-512@2x.png")), REAL_SOURCE),
    0
  );
});

/* ═════════════════════ failing loud, never failing green ═════════════════════ */

test("--check compares BYTES, so Capacitor's placeholder does not satisfy it", () => {
  /* THE ANTI-FAILS-GREEN CHECK, and the reason it is not "the file exists": the
     placeholder exists, is a valid PNG, and is also 1024x1024. A `test -f` in the
     workflow would have passed on the build that shipped it.
     MUTATION: change `Buffer.compare(got, bytes) !== 0` in assertIconsLanded to
     compare `got.length` against nothing, or simply `false` -> this fails. RUN. */
  const set = catalog(CAPACITOR_CONTENTS, { "AppIcon-512@2x.png": solidPng(SOURCE_PX, [16, 32, 64]) });
  assert.throws(() => checkAppIcon(set, DEFAULT_SOURCE), /is not our icon/);
  injectAppIcon(set, DEFAULT_SOURCE);
  assert.deepEqual(checkAppIcon(set, DEFAULT_SOURCE), ["AppIcon-512@2x.png"]);
});

test("--check fails when a declared file is missing entirely", () => {
  const set = catalog();
  assert.throws(() => checkAppIcon(set, DEFAULT_SOURCE), /is not in the catalog/);
});

test("assertIconsLanded is a real function, and it rejects what it should", () => {
  /* NAMED AND EXPORTED for the reason `assertModePresent` in
     inject-background-audio.mjs is: that guard used to be an inline `if`, an
     adversarial pass changed it to `if (false)`, and all 22 tests stayed green.
     Without this one, every failure in this file degrades to "wrote nothing and
     said it worked".
     MUTATION: `return plan.map((p) => p.filename);` as the first line -> the three
     assert.throws here fail, and so does the --check test above. RUN. */
  const set = catalog();
  const plan = planAppIcon(CAPACITOR_CONTENTS, REAL_SOURCE);
  assert.throws(() => assertIconsLanded(set, plan), /is not in the catalog/);
  fs.writeFileSync(path.join(set, "AppIcon-512@2x.png"), solidPng(SOURCE_PX, [1, 2, 3]));
  assert.throws(() => assertIconsLanded(set, plan), /is not our icon/);
  assert.throws(() => assertIconsLanded(set, []), /nothing was planned/);
  fs.writeFileSync(path.join(set, "AppIcon-512@2x.png"), REAL_SOURCE);
  assert.deepEqual(assertIconsLanded(set, plan), ["AppIcon-512@2x.png"]);
});

test("a directory that is not an .appiconset is refused, not created", () => {
  /* The likeliest real-world failure is a path typo or a `cap add ios` that never
     ran, and both must say so rather than writing an icon into an empty directory
     nothing reads.
     MUTATION: `fs.mkdirSync(dir, { recursive: true })` in readCatalog -> fails. RUN. */
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "foray-appicon-empty-"));
  assert.throws(() => injectAppIcon(empty, DEFAULT_SOURCE), /is not an \.appiconset/);
  assert.throws(() => injectAppIcon(path.join(empty, "nope"), DEFAULT_SOURCE), /not a directory/);
});

test("a missing source icon is an error, not an empty write", () => {
  const set = catalog();
  assert.throws(() => injectAppIcon(set, path.join(ROOT, "no-such-icon.png")), /does not exist/);
  assert.deepEqual(fs.readdirSync(set).sort(), ["Contents.json"]);
});

test("REAL REPO: nothing else in the repo claims to put an icon in the bundle", () => {
  /* THE PREMISE, and it cannot fail on today's tree — CLAUDE.md's point 5. This
     script is now the only path to an icon in the .app, on the home screen and on
     the App Store product page alike. A second writer appearing later (a `cp` in a
     workflow, a Capacitor config option) would mean two things claiming the same
     file, and the loser would be silent. If this ever fails, decide which one owns
     the catalog before deleting the assertion.
     COMMENTS ARE EXCLUDED, and a first run of this test is why: the workflow step
     EXPLAINS the placeholder bug in prose, so a whole-file scan went red on its own
     explanation — which is how a test ends up rewarding silence about a bug. Same
     reasoning, and the same fix, as `ios-workflow.test.mjs`'s `commands()` helper.
     MUTATION: add a real (uncommented) `cp ... AppIcon.appiconset/...` line to any
     of these files -> fails. RUN. */
  const files = [
    ".github/workflows/ios-build.yml",
    "tools/brand/build-icons.mjs",
    "tools/mobile/prepare-webdir.mjs",
    "mobile/capacitor.config.json",
  ];
  for (const rel of files) {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    const mentions = src
      .split(/\r?\n/)
      .filter((l) => !/^\s*(#|\/\/|\*|\/\*)/.test(l))
      .filter((l) => /appiconset/i.test(l));
    for (const line of mentions) {
      assert.match(
        line,
        /inject-app-icon|APPICONSET:|"\$APPICONSET/,
        `${rel} touches the app icon catalog outside inject-app-icon.mjs: ${line.trim()}`
      );
    }
  }
});
