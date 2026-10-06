// Computes one [hue, chroma] pair per show from its artwork and writes palettes.json (numbers only).
// This is the build-time stand-in for the nightly refresh's palette step (BUILD-NOTES 1.2 and 9.1):
// publisher art often lacks CORS, so the runtime never reads pixels; it reads this file.
// Run from the repo root:  node docs/redesign-2026/directions/ambient/prototype/tools/palettes.mjs
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.cwd();
const { chromium } = await import(pathToFileURL(path.join(root, 'tools/ui-lab/node_modules/playwright/index.mjs')).href);
const dir = path.join(root, 'docs/redesign-2026/directions/ambient/prototype');
const data = JSON.parse(fs.readFileSync(path.join(dir, 'data.json'), 'utf8'));

const shows = new Map();
for (const e of data.episodes) if (!shows.has(e.show)) shows.set(e.show, e.art);
for (const s of data.foray.items) if (s.type === 'segment' && s.art && !shows.has(s.show)) shows.set(s.show, s.art);

for (const f of data.forays_lite || []) for (const s of f.shows) if (s.art && !shows.has(s.show)) shows.set(s.show, s.art);

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
await page.goto('about:blank');
const result = {};
for (const [show, url] of shows) {
  try {
    const res = await ctx.request.get(url, { timeout: 20000 });
    if (!res.ok()) throw new Error('http ' + res.status());
    const b64 = (await res.body()).toString('base64');
    const mime = (res.headers()['content-type'] || 'image/jpeg').split(';')[0];
    const hc = await page.evaluate(async ({ b64, mime }) => {
      const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const bmp = await createImageBitmap(new Blob([bin], { type: mime }));
      const N = 32, cv = new OffscreenCanvas(N, N), g = cv.getContext('2d');
      g.drawImage(bmp, 0, 0, N, N);
      const px = g.getImageData(0, 0, N, N).data;
      const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      const bins = Array.from({ length: 12 }, () => ({ w: 0, x: 0, y: 0, c: 0 }));
      for (let i = 0; i < px.length; i += 4) {
        const r = lin(px[i]), gg = lin(px[i + 1]), b = lin(px[i + 2]);
        const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * gg + 0.0514459929 * b);
        const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * gg + 0.1073969566 * b);
        const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * gg + 0.6299787005 * b);
        const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
        const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
        const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
        const C = Math.hypot(A, B);
        if (L < 0.2 || L > 0.96 || C < 0.03) continue;
        let h = Math.atan2(B, A) * 180 / Math.PI; if (h < 0) h += 360;
        const k = Math.floor(h / 30) % 12, w = C * C;
        bins[k].w += w; bins[k].x += Math.cos(h * Math.PI / 180) * w; bins[k].y += Math.sin(h * Math.PI / 180) * w; bins[k].c += C * w;
      }
      let best = null;
      for (const b of bins) if (b.w > 0 && (!best || b.w > best.w)) best = b;
      if (!best) return null;
      let h = Math.atan2(best.y, best.x) * 180 / Math.PI; if (h < 0) h += 360;
      return [Math.round(h), Math.round((best.c / best.w) * 1000) / 1000];
    }, { b64, mime });
    result[show] = hc;
  } catch (e) { result[show] = null; console.warn('palette failed:', show, e.message); }
}
await browser.close();
fs.writeFileSync(path.join(dir, 'palettes.json'), JSON.stringify(result, null, 1));
console.log(Object.values(result).filter(Boolean).length + '/' + shows.size + ' palettes');
