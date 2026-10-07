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
  assert.match(css, /ag-np-textscale \.ag-np \.fp-s-why\s*\{\s*display:\s*none;/);
  assert.match(css, /\.ag-np-first\s*\{[^}]*min-height:\s*100%[^}]*safe-top/s);
  assert.match(css, /\.ag-np \.ag-np-play\s*\{[^}]*width:\s*88px;[^}]*height:\s*88px;/s);
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
  assert.match(client, /paintClocks\(pos, dur, !held && !ui\.ag\)/, "ticks do not rewrite the Afterglow slider's spoken value");
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
  assert.match(css, /\.ag-np-actions\s*\{[^}]*repeat\(4, 1fr\)/s);
  assert.match(css, /\.ag-np-source-grid\s*\{[^}]*repeat\(3,/s);
  assert.match(css, /-webkit-line-clamp:\s*4/);
  assert.match(ui, /"4a added"/);
  assert.match(client, /document\.startViewTransition/);
  assert.match(client, /duration: reduce \? 200 : 420/);
  assert.match(client, /returnFocus:\s*ui\.info/);
  assert.doesNotMatch(ui, /innerHTML|style\s*=/, "screen DOM uses nodes and CSSOM, never interpolated markup or inline attributes");
  assert.match(ui, /node\.src = url/);
  assert.match(ui, /const url = safeUrl\(src \|\| ""\)/);
});
