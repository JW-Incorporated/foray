# How the Play screenshots were produced

For engineers, not for the founder — the founder's file is `README.md` next to
this one. This exists so the screenshots can be **re-cut when the UI moves**
rather than sitting here going quietly out of date. `tools/store/play-listing.test.mjs`
fails if this file disappears while the screenshots remain.

Captured **2026-08-25** against the live deployment,
`https://jw-incorporated.github.io/foray/`. That is the same web root the
Android shell bundles (`tools/mobile/prepare-webdir.mjs` copies these exact
files into `webDir`; there is no second `index.html` and no second `app.js`), so
what the browser renders is what the app renders. Nothing was mocked, drawn or
retouched.

## The problem this recipe solves

Play wants a phone screenshot: 9:16, each side between 320 px and 3840 px. A
desktop browser window is nothing like a phone, and the two obvious ways to fix
that are both closed here:

- **Resizing the window** is unreliable through automation and, in the session
  that produced these, stopped applying part-way through.
- **An iframe at phone size** is blocked outright. `index.html` ships
  `default-src 'none'` in its CSP, so the page cannot frame itself; the frame
  renders as a crash tile. That same CSP (`style-src 'self'`) also blocks an
  injected `<style>` element, which is why the harness below sets everything
  through CSSOM (`el.style.…`) — CSP does not intercept that.

So the harness shrinks the **layout** instead of the window: it pins `<body>` to
405 × 720 CSS px — a phone — and paints it at `zoom: Z` so it fills as much of
the real window as it can. The result is a genuine 405 × 720 phone rendering at
Z× density, not a scaled screenshot of a desktop layout.

Three details in it are load-bearing:

- **`transform: translateZ(0)` on `<body>`.** A transformed ancestor becomes the
  containing block for `position: fixed` descendants. Without it the top bar and
  the "build me a playlist" bar are laid out against the real window and hang
  off the right-hand side of the phone.
- **`.home`'s height is overridden.** `styles.css` gives it
  `calc(100dvh - var(--topbar-h))`, and `dvh` is the *window*, not our fake
  phone, so `.cards4` (a `1fr × 4` grid) stretches each card to a quarter of a
  1300 px column and the screen reads as four cards adrift in whitespace. The
  harness recomputes it from the topbar's real height — divided by `Z`, because
  `getBoundingClientRect()` returns the painted size, not the CSS size.
- **`loading="lazy"` is defeated.** The captures are taken from a background
  tab, where the lazy images never intersect the viewport and every card shows a
  grey placeholder. The harness flips them to `eager` and re-assigns `src`.

`<html>` is painted magenta so that everything outside the phone is a sentinel
the crop step can find without arithmetic.

## The harness

Paste into the page's console (or run through browser automation) on
`https://jw-incorporated.github.io/foray/`, then call `__phone()` again after
**every** navigation — the app re-renders `#view` and `.home` comes back with
its `dvh` height.

```js
window.__phone = function () {
  const W = 405, H = 720;                       // the phone being emulated, CSS px
  const h = document.documentElement, b = document.body;
  const Z = Math.min(innerWidth / W, innerHeight / H);   // paint it as large as the window allows
  h.style.zoom = String(Z);
  h.style.margin = '0'; h.style.padding = '0'; h.style.overflow = 'hidden';
  h.style.background = '#ff00ff';               // sentinel: everything outside the phone
  b.style.width = W + 'px'; b.style.maxWidth = W + 'px'; b.style.minWidth = '0';
  b.style.height = H + 'px'; b.style.margin = '0'; b.style.overflow = 'hidden';
  b.style.background = 'rgb(250,247,242)';
  b.style.transform = 'translateZ(0)';          // containing block for position:fixed
  b.style.transformOrigin = '0 0';
  const tb = document.querySelector('.topbar');
  const tbh = tb ? tb.getBoundingClientRect().height / Z : 52;
  for (const el of document.querySelectorAll('.home')) el.style.height = (H - tbh) + 'px';
  for (const im of document.querySelectorAll('img[loading=lazy]')) {
    im.loading = 'eager'; const s = im.src; im.src = ''; im.src = s;
  }
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  return { Z, vw: innerWidth, vh: innerHeight };
};
__phone();
```

The `blur()` is not cosmetic housekeeping: without it the last-clicked control
keeps its focus ring and the screenshot ships with a blue outline round the play
button.

## The four states, in listing order

| File | Route | How to get there |
| --- | --- | --- |
| `screenshot-1-daily-picks.jpg` | `#/` | Load the app. First-run intro banner plus the four subject cards. |
| `screenshot-2-built-playlist.jpg` | `#/playlist/<id>` | From `#/`, type `the roman empire` into the bottom field and submit. |
| `screenshot-3-queue.jpg` | `#/subject/<branch>` | From `#/`, tap a card. Take the `href` off `#view a.mini-card` — **the four subjects change on every load**, so a hard-coded branch renders "Playlist not found." |
| `screenshot-4-player.jpg` | any queue, player open | Click `#view button.play-btn`, then the mini-player bar, which expands the sheet. |

The player sheet shows `0:00` and a paused transport because these were captured
from a hidden background tab, where Chrome throttles media loading and the
episode never settles inside the player's 20 s deadline. That is a property of
the capture environment, not of the app. Capturing with the tab foregrounded
would give a playing transport and a non-zero position, and would be better.

## Cutting the captures to 720 × 1280

The raw capture is the whole browser viewport with the phone in its top-left
corner and magenta everywhere else. Find the sentinel edge, crop to it, resample
to exactly **720 × 1280**, save JPEG. On the machine that produced these
(Windows, no image dependency in the repo) that was `System.Drawing`:

```powershell
Add-Type -AssemblyName System.Drawing
$img  = [System.Drawing.Bitmap]::FromFile($rawJpg)
# scan a mid-height row for the first magenta pixel -> the phone's width
$cutX = 0; for ($x = 0; $x -lt $img.Width; $x++) {
  $c = $img.GetPixel($x, [int]($img.Height / 2))
  if ($c.R -gt 200 -and $c.G -lt 60 -and $c.B -gt 200) { $cutX = $x; break }
}
$sub = $img.Clone((New-Object System.Drawing.Rectangle 0, 0, ($cutX - 2), $img.Height), $img.PixelFormat)
$dst = New-Object System.Drawing.Bitmap 720, 1280
$g   = [System.Drawing.Graphics]::FromImage($dst)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.DrawImage($sub, (New-Object System.Drawing.Rectangle 0, 0, 720, 1280))
$dst.Save($outJpg, $jpegEncoder, $qualityParams)   # quality 94
```

`$cutX - 2` because JPEG chroma subsampling bleeds the magenta a pixel or two
into the phone's right edge; the two columns given up are page padding.

**Why this step is not a committed Node script**, when the feature graphic's
generator is. `tools/brand/png.mjs` is a PNG codec and the browser hands back
JPEG. Converting to PNG first is possible but produces ~530 KB files — JPEG
noise is close to worst-case for PNG — so committing raw PNG captures would put
several megabytes of binary in `docs/` to enable a resize whose input can only
ever be produced by hand-driving a browser anyway. The trade taken is: the
procedure is recorded here exactly, and `tools/store/play-listing.test.mjs` pins
every property of the result that Play cares about.

**Why 720 × 1280 and not the native crop.** The captures came out ~626 × 1114,
which is 9:16 to within a rounding error but not exactly, and Play's aspect
check has no documented tolerance. 720 × 1280 is exactly 9:16, is a real Android
resolution, and is the size the Console's own examples use. The 1.15× resample
is the price.

## Regenerating

1. Open the deployment, paste the harness, call `__phone()`.
2. Walk the four states in the table, screenshotting after each `__phone()`.
3. Crop and resample each to 720 × 1280.
4. Overwrite the files in `docs/store/play/`, keeping the names.
5. `node --test tools/store/play-listing.test.mjs`.
6. Update the capture date at the top of this file.

The feature graphic is **not** part of this: it is generated, and regenerating it
is `node tools/store/build-feature-graphic.mjs`.
