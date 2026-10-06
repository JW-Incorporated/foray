/* Contact sheets: one PNG per viewport tiling every screen with a label. Composed
 * in the browser (an HTML page of the shots, screenshotted), so labels are real
 * text and the layout is the browser's, not a canvas hack. Shots are embedded as
 * data: URIs, so the sheet needs no file access and no network.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/**
 * @param {import('playwright').Browser} browser
 * @param {string} outDir
 * @param {{w:number,h:number,name:string}} vp
 * @param {Array<{state:string,label:string,route:string,path:string}>} shots  one viewport's shots, in order
 * @param {{title:string, tileW?:number, cols?:number}} opts
 */
export async function writeContactSheet(browser, outDir, vp, shots, { title, tileW = 260, cols = 6 } = {}) {
  const groups = [];
  for (const s of shots) {
    let g = groups.find((x) => x.state === s.state);
    if (!g) groups.push((g = { state: s.state, items: [] }));
    g.items.push(s);
  }
  const gap = 14;
  const tileH = Math.round((tileW * vp.h) / vp.w) + 40;
  /* keep the sheet under Chromium's 16384 px screenshot limit */
  let c = cols;
  const rowsFor = (n) => groups.reduce((a, g) => a + Math.ceil(g.items.length / n) * (tileH + gap) + 44, 70);
  while (rowsFor(c) > 15000 && c < 20) c++;
  const width = c * tileW + (c + 1) * gap;

  const figs = (g) => g.items.map((s) => {
    const b64 = readFileSync(path.join(outDir, s.path)).toString("base64");
    return `<figure><img src="data:image/png;base64,${b64}" width="${tileW}" alt=""><figcaption><b>${esc(s.label)}</b><span>${esc(s.route || "")}</span></figcaption></figure>`;
  }).join("");

  const html = `<!doctype html><meta charset="utf-8"><style>
    *{box-sizing:border-box} body{margin:0;background:#15161a;color:#e8e8ee;font:12px/1.3 system-ui,Segoe UI,Arial,sans-serif;width:${width}px;padding:${gap}px}
    h1{font-size:16px;margin:0 0 ${gap}px} h2{font-size:13px;margin:${gap}px 0 8px;color:#9aa0ff;text-transform:uppercase;letter-spacing:.06em}
    .grid{display:grid;grid-template-columns:repeat(${c},${tileW}px);gap:${gap}px}
    figure{margin:0;display:flex;flex-direction:column;gap:6px} img{display:block;border-radius:10px;border:1px solid #33343c;background:#000}
    figcaption{display:flex;flex-direction:column;gap:1px;min-height:28px} figcaption span{color:#8a8d98;font-size:10px;word-break:break-all}
  </style><h1>${esc(title)} - ${vp.name} - ${shots.length} screens</h1>
  ${groups.map((g) => `<h2>${esc(g.state)} (${g.items.length})</h2><div class="grid">${figs(g)}</div>`).join("")}`;

  const page = await browser.newPage({ viewport: { width, height: 800 }, deviceScaleFactor: 1 });
  try {
    await page.setContent(html, { waitUntil: "load" });
    await page.evaluate(() => Promise.all(Array.from(document.images).map((i) => i.decode().catch(() => {}))));
    const file = `contact-${vp.name}.png`;
    await page.screenshot({ path: path.join(outDir, file), fullPage: true });
    return file;
  } finally {
    await page.close();
  }
}
