#!/usr/bin/env node
/* Build a blind pairwise judging set (docs/redesign-2026/judge/protocol.md).
 *
 *   node tools/ui-lab/judge-set.mjs --pairs <pairs.json> --out <dir> [--root <dir>] [--judges 6] [--seed 7]
 *
 * Score afterwards by mapping each judge's verdicts through <out>/key.json (move
 * key.json, diff.json and _framed/ out of <out> before judges start).
 *
 * pairs.json: { "root": "<dir images are relative to>", "pairs": [
 *   { "id", "kind", "group", "x": "<path>" | {"frame": "<path>", "caption": "..."},
 *     "y": ..., "expected": "x" | "y" | "tie" | null } ] }
 * `group` = the screen a pair shows; one judge never sees two pairs from the same
 * group (the untouched image would recur across pairs and give the answer away).
 *
 * Every pair is judged twice, once in each order, by two different judges, so
 * position bias is measured, not assumed away. Writes:
 *   <out>/j<k>/<nn>/A.png, B.png   neutral names, nothing else in the folder
 *   <out>/key.json                 which file is A/B per judgment (do not show judges)
 *   <out>/diff.json                % of pixels that differ between x and y per pair
 * Images go under data-local/ only (gitignored): third-party refs never get committed.
 * A {"frame"} side is composed into a marketing-style frame (backdrop, caption,
 * device bezel) to test whether framing alone sways a judge.
 */
import path from "node:path";
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { chromium } from "playwright";
import { parseArgs } from "./lib/args.mjs";

const args = parseArgs(process.argv.slice(2));
if (!args.pairs || !args.out) { console.error("usage: judge-set.mjs --pairs <pairs.json> --out <dir> [--judges 6] [--seed 7]"); process.exit(2); }
const spec = JSON.parse(readFileSync(args.pairs, "utf8").replace(/^﻿/, "")); // tolerate a BOM (PowerShell writes one)
const root = path.resolve(typeof args.root === "string" ? args.root : spec.root || "."); // --root: where the images live (e.g. the trunk checkout's data-local/redesign)
const out = path.resolve(args.out);
const J = +(args.judges || 6);
let s = +(args.seed || 7);
const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const framedDir = path.join(out, "_framed");
mkdirSync(framedDir, { recursive: true });
const b64 = (p) => readFileSync(p).toString("base64");
/* The render has no status bar or home-indicator inset, so the frame adds both
   (in the app's own background colour) and the screen is sized to the render's
   aspect: nothing of the UI is clipped or covered by the camera cutout. An
   earlier version put the render straight under the cutout, which clipped the
   header and gave judges a real defect to pick on (skeptic-review.md). */
async function frame(src, caption, name) {
  const page = await browser.newPage({ viewport: { width: 645, height: 1398 }, deviceScaleFactor: 2 });
  await page.setContent(`<html><body style="margin:0;width:645px;height:1398px;overflow:hidden;
    background:linear-gradient(160deg,#5b3fd1 0%,#2a1a6e 55%,#0f0b24 100%);font-family:'Segoe UI',Arial,sans-serif">
    <div style="color:#fff;text-align:center;font-weight:800;font-size:46px;line-height:1.12;padding:90px 50px 0;letter-spacing:-0.5px">${caption}</div>
    <div style="position:absolute;left:92px;top:320px;width:461px;background:#0a0a0a;border-radius:64px;padding:14px;box-sizing:border-box;box-shadow:0 30px 80px rgba(0,0,0,.55),0 0 0 2px #3a3a3a">
      <div style="background:#151119;border-radius:50px;overflow:hidden;padding:46px 0 22px;position:relative">
        <div style="position:absolute;top:14px;left:34px;color:#fff;font:600 15px 'Segoe UI',Arial,sans-serif">9:41</div>
        <div style="position:absolute;top:10px;left:50%;transform:translateX(-50%);width:112px;height:30px;background:#000;border-radius:18px"></div>
        <img src="data:image/png;base64,${b64(src)}" style="width:100%;display:block">
        <div style="position:absolute;bottom:8px;left:50%;transform:translateX(-50%);width:130px;height:5px;background:#e8e4ef;border-radius:3px"></div>
      </div>
    </div></body></html>`);
  const p = path.join(framedDir, name + ".png");
  await page.screenshot({ path: p });
  await page.close();
  return p;
}
async function diffPct(a, b) {
  const page = await browser.newPage();
  const pct = await page.evaluate(async ([da, db]) => {
    const load = (d) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = "data:image/png;base64," + d; });
    const [ia, ib] = await Promise.all([load(da), load(db)]);
    if (ia.width !== ib.width || ia.height !== ib.height) return null;
    const px = (i) => { const c = document.createElement("canvas"); c.width = i.width; c.height = i.height; const x = c.getContext("2d"); x.drawImage(i, 0, 0); return x.getImageData(0, 0, i.width, i.height).data; };
    const [pa, pb] = [px(ia), px(ib)];
    let n = 0; for (let k = 0; k < pa.length; k += 4) if (Math.abs(pa[k] - pb[k]) + Math.abs(pa[k + 1] - pb[k + 1]) + Math.abs(pa[k + 2] - pb[k + 2]) > 24) n++;
    return +(100 * n / (pa.length / 4)).toFixed(2);
  }, [b64(a), b64(b)]);
  await page.close();
  return pct;
}

const resolved = [];
for (const p of spec.pairs) {
  const side = async (v, tag) => (typeof v === "string" ? path.join(root, v) : await frame(path.join(root, v.frame), v.caption, `${p.id}-${tag}`));
  const x = await side(p.x, "x"), y = await side(p.y, "y");
  resolved.push({ ...p, xPath: x, yPath: y, diff: await diffPct(x, y) });
}
await browser.close();

/* judgments: each pair in both orders; assign to judges, one per group per judge,
   the two orders of a pair to different judges, loads balanced */
const load = Array.from({ length: J }, () => ({ groups: new Set(), items: [] }));
const groups = shuffle([...new Set(resolved.map((p) => p.group))]).sort((a, b) =>
  resolved.filter((p) => p.group === b).length - resolved.filter((p) => p.group === a).length);
for (const g of groups) {
  for (const p of shuffle(resolved.filter((q) => q.group === g))) {
    const used = new Set();
    for (const order of shuffle(["xy", "yx"])) {
      const cand = load.map((l, i) => i).filter((i) => !load[i].groups.has(g) && !used.has(i));
      if (!cand.length) throw new Error(`cannot place ${p.id}: group ${g} needs more judges`);
      const min = Math.min(...cand.map((i) => load[i].items.length));
      const pick = shuffle(cand.filter((i) => load[i].items.length === min))[0];
      used.add(pick); load[pick].groups.add(g); load[pick].items.push({ pair: p, order });
    }
  }
}
const key = [];
load.forEach((l, j) => {
  shuffle(l.items).forEach((it, n) => {
    const dir = path.join(out, `j${j + 1}`, String(n + 1).padStart(2, "0"));
    mkdirSync(dir, { recursive: true });
    const [A, B] = it.order === "xy" ? [it.pair.xPath, it.pair.yPath] : [it.pair.yPath, it.pair.xPath];
    copyFileSync(A, path.join(dir, "A.png")); copyFileSync(B, path.join(dir, "B.png"));
    key.push({ judge: j + 1, item: n + 1, pair: it.pair.id, kind: it.pair.kind, order: it.order, A, B,
      expected: it.pair.expected == null ? null : it.pair.expected === "tie" ? "tie" : (it.pair.expected === it.order[0] ? "A" : "B") });
  });
});
writeFileSync(path.join(out, "key.json"), JSON.stringify(key, null, 2));
writeFileSync(path.join(out, "diff.json"), JSON.stringify(resolved.map((p) => ({ id: p.id, diff_pct: p.diff })), null, 2));
console.log(`pairs ${resolved.length}  judgments ${key.length}  judges ${J}  per judge ${load.map((l) => l.items.length).join("/")}`);
console.log("diff %: " + resolved.map((p) => `${p.id}=${p.diff}`).join(" "));
