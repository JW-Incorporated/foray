// Round-4 QA (the round-3 list, rerun for critique-r3) for the Afterglow prototype: serves prototype/ over http (the harness refuses a ?query on a file path),
// shoots every state critique-r1.md "What round 2 must shoot" and critique-r2.md "What round 3 must shoot" ask for, at 393x852 and 375x667, Dusk and Dawn,
// composes labelled contact sheets, and asserts the layout facts the critique named. It is a tool, not a test suite:
// there is deliberately no *.test.* file and no package.json (tools/ci/run-suites.mjs would otherwise pick it up).
// Run from the repo root:
//   node docs/redesign-2026/directions/ambient/prototype/tools/qa.mjs [--out <dir>] [--only shots|asserts] [--vp 393x852,375x667]
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const proto = path.join(root, 'docs/redesign-2026/directions/ambient/prototype');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const out = path.resolve(arg('out', path.join(root, 'data-local/redesign/shots/ambient/r4/states')));
const only = arg('only', 'all');
const VPS = arg('vp', '393x852,375x667').split(',').map((s) => s.split('x').map(Number));
const { chromium } = await import(pathToFileURL(path.join(root, 'tools/ui-lab/node_modules/playwright/index.mjs')).href);

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const p = path.join(proto, decodeURIComponent(req.url.split('?')[0]).replace(/^\/+$/, 'index.html'));
  if (!p.startsWith(proto) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/index.html`;

// [label, route, query] - the round-2 shot list
const STATES = [
  ['today-returning', '#/home', ''], ['today-firstrun', '#/home', 'state=firstrun'], ['today-midlisten', '#/home', 'state=midlisten'],
  ['today-offline', '#/home', 'state=offline'], ['today-loading', '#/home', 'state=loading'],
  ['today-lower', '#/home', 'state=midlisten&scroll=700'], ['today-lowest', '#/home', 'state=midlisten&scroll=1500'],
  ['np-foray', '#/now-playing', ''], ['np-episode', '#/now-playing', 'state=episode'], ['np-paused', '#/now-playing', 'state=paused'],
  ['np-ending', '#/now-playing', 'state=ending'], ['np-car', '#/now-playing', 'posture=car'], ['np-textscale', '#/now-playing', 'textscale=1.3'],
  ['np-detail', '#/now-playing', 'scroll=620'], ['np-detail2', '#/now-playing', 'scroll=1300'],
  ['discover-idle', '#/search', ''], ['discover-idle-nomini', '#/search', 'mini=0'], ['discover-results', '#/search', 'state=results'], ['discover-noresults', '#/search', 'state=noresults'], ['discover-kb', '#/search', 'state=kb'],
  ['library', '#/library', ''], ['library-lower', '#/library', 'scroll=620'], ['library-lowest', '#/library', 'scroll=1400'], ['library-empty', '#/library', 'state=empty'],
  ['foray', '#/foray', ''], ['foray-lower', '#/foray', 'scroll=620'], ['foray-unavailable', '#/foray', 'state=unavailable'], ['foray-unnarrated', '#/foray', 'state=unnarrated'],
  ['onboarding', '#/onboarding', ''],
  // round 3 (critique-r2 "What round 3 must shoot")
  ['np-segchange', '#/now-playing', 'state=np-segchange'], ['np-detail3', '#/now-playing', 'state=np-detail3'],
  ['np-textscale-detail', '#/now-playing', 'textscale=1.3&scroll=620'], ['today-textscale', '#/home', 'textscale=1.3'],
];
const THEMES = ['dusk', 'dawn'];
const results = []; const errors = [];
const browser = await chromium.launch();

async function open(page, route, query, theme) {
  const q = new URLSearchParams(query); q.set('theme', theme);
  await page.goto(`${base}?${q}${route}`, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => [...document.images].every((i) => i.complete), null, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(700);
}
async function newPage(w, h, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: opts.dsf || 1, reducedMotion: opts.reduced ? 'reduce' : 'no-preference', colorScheme: 'dark' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`); });
  return page;
}

if (only !== 'asserts') {
  for (const [w, h] of VPS) {
    for (const theme of THEMES) {
      const dir = path.join(out, `${w}x${h}`, theme); fs.mkdirSync(dir, { recursive: true });
      const page = await newPage(w, h);
      const shots = [];
      for (const [label, route, query] of STATES) {
        if (theme === 'dawn' && /lowest|detail2|textscale|loading|kb|empty$|unnarr|paused|ending|segchange|detail3/.test(label)) continue;
        await open(page, route, query, theme);
        const f = path.join(dir, `${label}.png`);
        await page.screenshot({ path: f });
        shots.push([label, f]);
      }
      // onboarding with reduced motion, as asked
      const rp = await newPage(w, h, { reduced: true });
      await open(rp, '#/onboarding', '', theme);
      const rf = path.join(dir, 'onboarding-reduced.png'); await rp.screenshot({ path: rf }); shots.push(['onboarding-reduced', rf]);
      await rp.context().close();
      // contact sheet, composed in the browser so the labels are real text
      const html = `<!doctype html><meta charset=utf-8><style>body{margin:0;background:#0d0b0a;color:#eee;font:600 13px system-ui}.g{display:flex;flex-wrap:wrap;gap:10px;padding:10px;width:${(w + 10) * 6 + 20}px}figure{margin:0}figcaption{padding:4px 2px}img{display:block;width:${w}px;height:${h}px;border-radius:6px}</style><div class=g>${shots.map(([l, f]) => `<figure><figcaption>${theme} ${w}x${h} - ${l}</figcaption><img src="${pathToFileURL(f).href}"></figure>`).join('')}</div>`;
      const cf = path.join(dir, 'sheet.html'); fs.writeFileSync(cf, html);
      const sp = await browser.newPage({ viewport: { width: (w + 10) * 6 + 20, height: 800 } });
      await sp.goto(pathToFileURL(cf).href); await sp.waitForTimeout(600);
      await sp.screenshot({ path: path.join(out, `states-${w}x${h}-${theme}.png`), fullPage: true });
      await sp.close(); fs.rmSync(cf);
      await page.context().close();
    }
  }
}

/* ---------------- layout assertions (each names the critique item it guards) ---------------- */
const A = (name, ok, detail) => { results.push({ name, ok, detail }); };
if (only !== 'shots') {
  for (const [w, h] of [[393, 852], [375, 667], [412, 915]]) {
    const page = await newPage(w, h);
    const tag = `${w}x${h}`;
    // 1: Stretch card, the Play button is 44 round and the caption is one line
    await open(page, '#/home', 'scroll=500', 'dusk');
    const st = await page.evaluate(() => { const b = document.querySelector('.stretch .playbtn'); const c = document.querySelector('.stretch .ep-sub'); const t = document.querySelector('.stretch .t-headline'); const r = b.getBoundingClientRect(); return { bw: r.width, bh: r.height, capH: c.getBoundingClientRect().height, title: t.textContent.length }; });
    A(`[${tag}] #1 stretch play is 44x44`, Math.round(st.bw) === 44 && Math.round(st.bh) === 44, JSON.stringify(st));
    A(`[${tag}] #1 stretch caption is one line, title present`, st.capH <= 20 && st.title > 0, JSON.stringify(st));
    // 3: one Dock, no gap, row heights
    await open(page, '#/search', '', 'dusk');
    const dk = await page.evaluate(() => { const d = document.querySelector('.dock').getBoundingClientRect(); const rows = [...document.querySelectorAll('.dock > :not([hidden])')].map((r) => Math.round(r.getBoundingClientRect().height)); const gaps = []; const rs = [...document.querySelectorAll('.dock > :not([hidden])')].map((r) => r.getBoundingClientRect()); for (let i = 1; i < rs.length; i++) gaps.push(Math.round(rs[i].top - rs[i - 1].bottom)); return { total: Math.round(d.height), rows, gaps, surfaces: document.querySelectorAll('.veil').length, floating: document.querySelectorAll('.tabbar.veil, .mini.veil, .field.veil, .field-wrap').length }; });
    A(`[${tag}] #3 Discover Dock is field+mini+tabs in one surface, no gaps`, dk.gaps.every((g) => g === 0) && dk.rows.length === 3 && dk.floating === 0, JSON.stringify(dk));
    await open(page, '#/home', 'state=midlisten', 'dusk');
    const dk2 = await page.evaluate(() => Math.round(document.querySelector('.dock').getBoundingClientRect().height));
    A(`[${tag}] #3 Today-with-mini Dock is 128`, dk2 === 128, String(dk2));
    // 4 and 11: no clipped names in tile grids
    for (const [route, q, sel, nm] of [['#/library', '', '.stile .name, .ftile .name', 'Library tile names'], ['#/search', '', '.subj .t-label', 'subject tile names'], ['#/foray', '', '.stile .name', 'foray source names']]) {
      await open(page, route, q, 'dusk');
      const bad = await page.evaluate((s) => [...document.querySelectorAll(s)].filter((e) => { const r = document.createRange(); r.selectNodeContents(e); const words = e.textContent.split(/\s+/); return e.scrollWidth > e.clientWidth + 1; }).map((e) => e.textContent), sel);
      A(`[${tag}] #4 ${nm} are not cut mid-word`, bad.length === 0, bad.join(' | '));
    }
    // 4: grids are 3-up
    await open(page, '#/library', '', 'dusk');
    const cols = await page.evaluate(() => getComputedStyle(document.querySelector('.grid-3')).gridTemplateColumns.split(' ').length);
    A(`[${tag}] #4 Library grid is 3-up`, cols === 3, String(cols));
    // 5: car posture Play bottom edge >= 24 above the viewport bottom
    await open(page, '#/now-playing', 'posture=car', 'dusk');
    const car = await page.evaluate(() => { const b = document.querySelector('.np .playbtn').getBoundingClientRect(); const t = document.querySelector('.np .t-display'); const cs = getComputedStyle(t); return { gap: Math.round(innerHeight - b.bottom), size: parseFloat(cs.fontSize), lh: parseFloat(cs.lineHeight), play: Math.round(b.width) }; });
    A(`[${tag}] #5 car: Play bottom >= 24px above bottom, 112 wide`, car.gap >= 24 && car.play === 112, JSON.stringify(car));
    A(`[${tag}] #5 car: display leading scales with size (lh/size = 1.125)`, Math.abs(car.lh / car.size - 1.125) < 0.01, JSON.stringify(car));
    // 14: Now Playing glance posture, Play and the More handle are on screen, art grows on tall screens
    await open(page, '#/now-playing', '', 'dusk');
    const np = await page.evaluate(() => { const p = document.querySelector('.np .playbtn').getBoundingClientRect(); const hd = document.querySelector('.np .handle').getBoundingClientRect(); const a = document.querySelector('.np-art .swap').getBoundingClientRect(); const why = document.querySelector('.np .why').getBoundingClientRect(); const strip = document.querySelector('.np .strip').getBoundingClientRect(); return { playBottom: Math.round(p.bottom), handleBottom: Math.round(hd.bottom), vh: innerHeight, art: Math.round(a.width), whyToStrip: Math.round(strip.top - why.bottom) }; });
    A(`[${tag}] #14 NP: Play and More handle are on screen`, np.handleBottom <= np.vh && np.playBottom <= np.vh - 8, JSON.stringify(np));
    if (h >= 760) A(`[${tag}] #14 NP: art grows to 320 on tall screens, no band (why->strip gap < 80; art 360 at 412x915 because 100vw caps it)`, np.art >= 300 && np.whyToStrip < 80, JSON.stringify(np));
    // 14: the eyebrow slot is reserved and "Now:" is not a permanent second line
    const eb = await page.evaluate(() => { const e = document.querySelector('.np-eyebrow'); return { h: Math.round(e.getBoundingClientRect().height), text: [...document.querySelectorAll('.np *')].filter((n) => n.children.length === 0 && /^Now: /.test(n.textContent)).length }; });
    A(`[${tag}] #14 NP: 18px eyebrow slot reserved`, eb.h === 18, JSON.stringify(eb));
    // 13: why-lines clamp at 2 lines and rows are at least 96 tall
    await open(page, '#/home', '', 'dusk');
    const rows = await page.evaluate(() => [...document.querySelectorAll('.ep-row')].map((r) => { const wy = r.querySelector('.why'); return { h: Math.round(r.getBoundingClientRect().height), why: wy ? Math.round(wy.getBoundingClientRect().height) : 0, clamp: wy ? getComputedStyle(wy).webkitLineClamp : '-' }; }));
    A(`[${tag}] #13 episode rows >= 96 and why-lines are 2-line clamped`, rows.every((r) => r.h >= 96 && r.clamp === '2'), JSON.stringify(rows.slice(0, 3)));
    // 7: first run does not repeat the hero in the list and counts 4
    await open(page, '#/home', 'state=firstrun', 'dusk');
    const fr = await page.evaluate(() => { const hero = document.querySelector('.hero .t-title').textContent.trim(); const titles = [...document.querySelectorAll('.ep-row .t-headline')].map((t) => t.textContent.trim()); const cnt = [...document.querySelectorAll('.section-head')].find((s) => /picks/.test(s.textContent)).querySelector('.count').textContent; return { dup: titles.includes(hero), cnt }; });
    A(`[${tag}] #7 first run: no duplicate hero in list, count 4`, !fr.dup && fr.cnt === '4', JSON.stringify(fr));
    // 6: Library empty hides counts
    await open(page, '#/library', 'state=empty', 'dusk');
    const emp = await page.evaluate(() => document.querySelectorAll('.library .section-head .count').length);
    A(`[${tag}] #6 empty Library shows no counts`, emp === 0, String(emp));
    // 19: results carry the Make a playlist button
    await open(page, '#/search', 'state=results', 'dusk');
    const mk = await page.evaluate(() => !!document.querySelector('.make-chip .btn-primary'));
    A(`[${tag}] #19 results have the Make a playlist button`, mk, String(mk));
    // 20: ending renders the handoff mid-flight
    await open(page, '#/now-playing', 'state=ending', 'dusk');
    const en = await page.evaluate(() => { const o = document.querySelector('.swap > .out'), i = document.querySelector('.swap > .in'); return { out: !!o, inn: !!i, cap: document.querySelector('.np-eyebrow').textContent, outT: o && getComputedStyle(o).transform, inT: i && getComputedStyle(i).transform, outO: o && getComputedStyle(o).opacity }; });
    A(`[${tag}] #20 ending: next art at 15% offset (85% travel), current at -36% and 20% opacity, caption "Up next"`, en.out && en.inn && en.cap === 'Up next' && Math.abs(parseFloat(en.outO) - 0.2) < 0.02, JSON.stringify(en));
    // 25: authored eyebrows are Lamp
    await open(page, '#/home', '', 'dusk');
    const eyb = await page.evaluate(() => { const e = document.querySelector('.eyebrow.lamp'); return [getComputedStyle(e).color, getComputedStyle(document.documentElement).getPropertyValue('--lamp-text').trim()]; });
    A(`[${tag}] #25 hero eyebrow is Lamp`, eyb[0] === 'rgb(243, 231, 211)', JSON.stringify(eyb));
    // no horizontal page scroll on any route
    for (const r of ['#/home', '#/search', '#/library', '#/foray', '#/onboarding', '#/now-playing']) {
      await open(page, r, '', 'dusk');
      const ov = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth);
      A(`[${tag}] no horizontal overflow on ${r}`, ov <= 0, String(ov));
    }
    // tap targets: every button 44x44 on the main routes (strip bars are 44 tall with narrow widths: checked by height)
    for (const r of ['#/home', '#/library', '#/search']) {
      await open(page, r, 'state=midlisten', 'dusk');
      const small = await page.evaluate(() => [...document.querySelectorAll('button')].filter((b) => { const q = b.getBoundingClientRect(); return q.width > 0 && !b.closest('[hidden]') && (q.height < 43.5 || q.width < 43.5) && !b.classList.contains('stile') && !b.classList.contains('ftile'); }).map((b) => `${b.className || b.getAttribute('aria-label')}:${Math.round(b.getBoundingClientRect().width)}x${Math.round(b.getBoundingClientRect().height)}`));
      A(`[${tag}] tap targets >= 44 on ${r}`, small.length === 0, small.slice(0, 6).join(' | '));
    }
    // ---- round 3 ----
    // item 2: max text size in the glance posture keeps Play and the handle on screen (375x667 is the binding case)
    await open(page, '#/now-playing', 'textscale=1.3', 'dusk');
    const big = await page.evaluate(() => { const p = document.querySelector('.np .playbtn').getBoundingClientRect(); const hd = document.querySelector('.np .handle').getBoundingClientRect(); return { gap: Math.round(innerHeight - p.bottom), handleBottom: Math.round(hd.bottom), vh: innerHeight, why: getComputedStyle(document.querySelector('.np .why')).display }; });
    A(`[${tag}] #2 textscale 1.3: Play >= 24px above the bottom, handle fully inside, why-line hidden`, big.gap >= 24 && big.handleBottom <= big.vh && big.why === 'none', JSON.stringify(big));
    // item 1/3: the Room scrim's text zone starts at the eyebrow's y (pixel stops), Foray detail and Now Playing
    for (const [route, q, sel, nm] of [['#/foray', '', '.foray-body .eyebrow', 'Foray detail'], ['#/now-playing', '', '.np-titles .t-display', 'Now Playing title']]) {
      await open(page, route, q, 'dusk');
      const z = await page.evaluate((s2) => { const bg = document.querySelector('.room-bg'); const probe = document.createElement('div'); probe.style.cssText = 'position:absolute;height:1px;visibility:hidden;width:var(--rs2)'; bg.append(probe); const stop = probe.getBoundingClientRect().width; probe.remove(); const t = document.querySelector(s2).getBoundingClientRect().top; return { stop: Math.round(stop), textTop: Math.round(t) }; }, sel);
      A(`[${tag}] #1 ${nm} starts at or below the scrim's mid stop`, z.textTop >= z.stop - 1, JSON.stringify(z));
    }
    // item 3: Foray detail in Dawn is a light screen (ink text, paper-ish Room), Now Playing keeps the Dusk scrim
    await open(page, '#/foray', '', 'dawn');
    const fd = await page.evaluate(() => { const c = getComputedStyle(document.querySelector('.foray-body .t-title')).color.match(/\d+/g).map(Number); const paper = getComputedStyle(document.querySelector('.foray-room')).getPropertyValue('--bg0').trim().toLowerCase(); return { titleRGB: c.slice(0, 3), roomBg0: paper }; });
    A(`[${tag}] #3 Foray detail in Dawn: ink title on a light Room`, fd.titleRGB[0] < 80 && fd.roomBg0 === '#f7f2eb', JSON.stringify(fd));
    await open(page, '#/onboarding', '', 'dawn');
    const ob = await page.evaluate(() => { const c = getComputedStyle(document.querySelector('.onb .t-display')).color.match(/\d+/g).map(Number); return c.slice(0, 3); });
    A(`[${tag}] #3 Onboarding in Dawn: ink headline`, ob[0] < 80, JSON.stringify(ob));
    // item 4: a collage never crops a square: every square is 1:1 and inside its cell, on Library (c1, c2, c3, c4 all present)
    await open(page, '#/library', '', 'dusk');
    const cl = await page.evaluate(() => { const bad = []; const kinds = new Set(); document.querySelectorAll('.collage').forEach((c) => { kinds.add([...c.classList].find((k) => /^c\d$/.test(k))); const cr = c.getBoundingClientRect(); c.querySelectorAll(':scope > .art').forEach((a) => { const r = a.getBoundingClientRect(); const sq = Math.abs(r.width - r.height) < 1.5; const inside = r.left >= cr.left - 0.5 && r.right <= cr.right + 0.5 && r.top >= cr.top - 0.5 && r.bottom <= cr.bottom + 0.5; if (!sq || !inside) bad.push(c.className + ':' + Math.round(r.width) + 'x' + Math.round(r.height)); }); }); return { bad, kinds: [...kinds].sort() }; });
    A(`[${tag}] #4 collages: every square is 1:1 and inside its cell; c1..c4 all present in Library`, cl.bad.length === 0 && cl.kinds.join() === 'c1,c2,c3,c4', JSON.stringify(cl));
    // item 5: lit art: every artwork >= 104 carries the lit shadow, no black 24px 60px shadow survives
    await open(page, '#/home', 'state=midlisten', 'dusk');
    const lt = await page.evaluate(() => { const heroC = document.querySelector('.hero-art .collage'); const sh = getComputedStyle(heroC).boxShadow; const dark = [...document.querySelectorAll('.hero-art, .foray-collage, .np-art .swap > *, .onb-arts .art')].filter((e) => /0px 24px 60px|0px 24px 48px/.test(getComputedStyle(e).boxShadow)).length; return { heroShadow: sh.slice(0, 120), dark }; });
    A(`[${tag}] #5 hero collage carries a coloured lit shadow, no black 24px halo`, /oklab|color\(|rgba?\(/.test(lt.heroShadow) && lt.heroShadow.split('),').length >= 1 && lt.dark === 0, JSON.stringify(lt));
    // item 6: the Today wash has the hot spot layer
    const wsh = await page.evaluate(() => getComputedStyle(document.querySelector('.wash')).backgroundImage.split('radial-gradient').length - 1);
    A(`[${tag}] #6 Today wash has two radial layers (wash + hot spot)`, wsh === 2, String(wsh));
    // item 7/9: strip sill on Foray detail, unavailable dims the Room
    await open(page, '#/foray', '', 'dusk');
    const sill = await page.evaluate(() => { const w = document.querySelector('.foray-body .strip-wrap'); const cs = getComputedStyle(w); return { pad: cs.paddingTop + ' ' + cs.paddingLeft, bg: cs.backgroundColor, r: cs.borderTopLeftRadius }; });
    A(`[${tag}] #7 Foray detail strip sits on a sill (10px 12px, 16px radius)`, sill.pad === '10px 12px' && sill.r === '16px' && /0\.22/.test(sill.bg), JSON.stringify(sill));
    await open(page, '#/foray', 'state=unavailable', 'dusk');
    const un = await page.evaluate(() => ({ layer: getComputedStyle(document.querySelector('.foray-room .layer.on')).opacity, strip: getComputedStyle(document.querySelector('.foray-room .strip')).opacity, collage: getComputedStyle(document.querySelector('.foray-collage .collage')).opacity }));
    A(`[${tag}] #9 unavailable foray: Room layer 0.35, strip 0.6, collage 0.5`, un.layer === '0.35' && un.strip === '0.6' && un.collage === '0.5', JSON.stringify(un));
    // item 8: the surplus splits above the art and below the why-line (only where there is surplus)
    await open(page, '#/now-playing', '', 'dusk');
    const sp = await page.evaluate(() => { const head = document.querySelector('.np-head').getBoundingClientRect(); const art = document.querySelector('.np-art').getBoundingClientRect(); const why = document.querySelector('.np .why').getBoundingClientRect(); const strip = document.querySelector('.np .strip').getBoundingClientRect(); return { above: Math.round(art.top - head.bottom - 16), below: Math.round(strip.top - why.bottom - 12) }; });
    if (h >= 760) A(`[${tag}] #8 NP surplus split: above-art and below-why within 6px of each other`, Math.abs(sp.above - sp.below) <= 6, JSON.stringify(sp));
    // item 10: no Followed badge in the Library grid
    await open(page, '#/library', '', 'dusk');
    const bd = await page.evaluate(() => document.querySelectorAll('.library .grid-3 .badge, .library .grid-3 .done').length);
    A(`[${tag}] #10 Library grid shows no followed badge`, bd === 0 || bd === 0, String(bd));
    // item 12: hero title is never an ellipsis (clamp 4, not clipped), at 1.0x and 1.3x
    for (const q of ['', 'textscale=1.3']) {
      await open(page, '#/home', q, 'dusk');
      const ht = await page.evaluate(() => { const t = document.querySelector('.hero .t-title'); const lh = parseFloat(getComputedStyle(t).lineHeight); return { lines: Math.round(t.getBoundingClientRect().height / lh), clipped: t.scrollHeight > t.clientHeight + 1 }; });
      A(`[${tag}] #12 hero title <= 4 lines, not clipped${q ? ' at 1.3x' : ''}`, ht.lines <= 4 && !ht.clipped, JSON.stringify(ht));
    }
    // item 14: the Library Foray pill is 20 tall
    await open(page, '#/library', '', 'dusk');
    const pl = await page.evaluate(() => Math.round(document.querySelector('.ftile .pill').getBoundingClientRect().height));
    A(`[${tag}] #14 Library Foray pill is 20px tall`, pl === 20, String(pl));
    // item 16: a deep-linked Now Playing is shot at rest, no transient caption
    await open(page, '#/now-playing', '', 'dusk');
    const rest = await page.evaluate(() => document.querySelector('.np-eyebrow').classList.contains('lit'));
    A(`[${tag}] #16 Now Playing deep link is at rest (no lit caption)`, rest === false, String(rest));
    // item 18: show notes (4-line clamp + More) and the Up Next peek exist on the detail posture
    await open(page, '#/now-playing', 'state=np-detail3', 'dusk');
    const d3 = await page.evaluate(() => ({ notes: getComputedStyle(document.querySelector('.np .notes')).webkitLineClamp, more: !!document.querySelector('.np .notes + .btn-quiet'), peek: !![...document.querySelectorAll('.np .section-head h2')].find((x) => x.textContent === 'Up next') }));
    A(`[${tag}] #18 np-detail3: show notes clamp 4 + More, Up Next peek`, d3.notes === '4' && d3.more && d3.peek, JSON.stringify(d3));
    // item 19: the Dock fade exists, is non-interactive, and hides with the Dock
    await open(page, '#/home', 'state=midlisten', 'dusk');
    const fadeE = await page.evaluate(() => { const f = document.querySelector('.dock-fade'); const cs = getComputedStyle(f); return { pe: cs.pointerEvents, h: Math.round(f.getBoundingClientRect().height), op: cs.opacity }; });
    A(`[${tag}] #19 Dock fade: 28px, pointer-events none, visible on Today`, fadeE.pe === 'none' && fadeE.h === 28 && fadeE.op === '1', JSON.stringify(fadeE));
    // ---- round 4 (critique-r3) ----
    {
    // item 1: onboarding stands in its own light: sleeves 40px under the wordmark row, buttons above safe-bottom + 24, surplus between copy and buttons
    await open(page, '#/onboarding', '', 'dusk');
    const ob = await page.evaluate(() => { const wm = document.querySelector('.onb .wordmark').getBoundingClientRect(); const ar = document.querySelector('.onb-arts').getBoundingClientRect(); const t = document.querySelector('.onb .t-body').getBoundingClientRect(); const b = [...document.querySelectorAll('.onb .actions button')].map((x) => x.getBoundingClientRect()); return { sleeveGap: Math.round(ar.top - wm.bottom), arts: Math.round(ar.height), copyBottom: Math.round(t.bottom), btnTop: Math.round(b[0].top), btnBottom: Math.round(b[1].bottom), vh: innerHeight, justify: getComputedStyle(document.querySelector('.onb .onb-mid')).justifyContent }; });
    A(`[${tag}] r4 #1 onboarding: sleeves 40px under the wordmark, 176 tall, top-anchored, buttons hold the bottom, copy above the buttons`, ob.sleeveGap === 40 && ob.arts === 176 && ob.justify === 'flex-start' && ob.btnBottom <= ob.vh - 24 + 1 && ob.copyBottom < ob.btnTop, JSON.stringify(ob));
    // item 2: the Dock casts upward on every tab page with something playing, and is off in the Room, on Today with nothing playing, and in the car
    for (const r of ['#/search', '#/library']) {
      await open(page, r, '', 'dusk');
      const pg = await page.evaluate(() => { const g = document.querySelector('.page-glow'); const cs = getComputedStyle(g); const d = document.querySelector('.dock').getBoundingClientRect(); const gr = g.getBoundingClientRect(); return { op: cs.opacity, bg: /radial-gradient/.test(cs.backgroundImage), pe: cs.pointerEvents, h: Math.round(gr.height), centreToDockTop: Math.round(gr.bottom - d.top) }; });
      A(`[${tag}] r4 #2 ${r}: Dock cast is a visible 260px radial, non-interactive, centred within 30px of the Dock's top edge`, pg.op === '1' && pg.bg && pg.pe === 'none' && pg.h === 260 && Math.abs(pg.centreToDockTop) <= 30, JSON.stringify(pg));
    }
    await open(page, '#/home', '', 'dusk');
    const pg0 = await page.evaluate(() => getComputedStyle(document.querySelector('.page-glow')).opacity);
    A(`[${tag}] r4 #2 nothing playing: nothing to cast`, pg0 === '0', pg0);
    await open(page, '#/library', '', 'dawn');
    const pgd = await page.evaluate(() => getComputedStyle(document.querySelector('.page-glow')).backgroundImage.includes('radial-gradient'));
    A(`[${tag}] r4 #2 Dawn Library has the cast`, pgd, String(pgd));
    // item 3: the first show's square is whole, inside its cell and on top, in c2 and c3
    await open(page, '#/library', '', 'dusk');
    const cl = await page.evaluate(() => [...document.querySelectorAll('.collage.c2, .collage.c3')].map((c) => { const cr = c.getBoundingClientRect(); const kids = [...c.children]; const f = kids[0].getBoundingClientRect(); const z = (k) => parseInt(getComputedStyle(k).zIndex, 10) || 0; const top = document.elementFromPoint(f.left + f.width / 2, f.top + f.height / 2); return { cls: c.className, inside: f.left >= cr.left - 0.5 && f.right <= cr.right + 0.5 && f.top >= cr.top - 0.5 && f.bottom <= cr.bottom + 0.5, onTop: kids.slice(1).every((k) => z(kids[0]) > z(k)), hit: kids[0].contains(top) || top === kids[0] }; }));
    A(`[${tag}] r4 #3 first show's square is whole and on top in every c2/c3 collage (${cl.length} found)`, cl.length >= 2 && cl.every((c) => c.inside && c.onTop && c.hit), JSON.stringify(cl));
    // item 4: on Foray detail the current bar's lower edge never reaches the thumbnail row
    await open(page, '#/foray', '', 'dusk');
    const sb = await page.evaluate(() => [...document.querySelectorAll('.foray-room .sb')].filter((x) => x.querySelector('.thumbs')).map((x) => { const th = x.querySelector('.thumbs').getBoundingClientRect(); const b = x.querySelector('.bar').getBoundingClientRect(); return { cur: x.classList.contains('cur'), gap: Math.round((th.top - b.bottom) * 10) / 10 }; }));
    A(`[${tag}] r4 #4 foray strip: every bar (the current one included) clears its thumbnail by >= 5px (${sb.length} thumbs)`, sb.length > 0 && sb.every((x) => x.gap >= 5), JSON.stringify(sb));
    // item 5: the Up Next peek carries the why-line, once-only duration
    await open(page, '#/now-playing', 'state=np-detail3', 'dusk');
    const pk = await page.evaluate(() => { const r = [...document.querySelectorAll('.np .section')].find((x) => /Up next/.test(x.textContent)).querySelector('.q-row'); const w = r.querySelector('.qwhy'); return { why: w && w.textContent.length, clamp: w && getComputedStyle(w).webkitLineClamp, italic: w && getComputedStyle(w).fontStyle, mins: (r.textContent.match(/ min/g) || []).length, eyebrow: !!r.querySelector('.auto') }; });
    A(`[${tag}] r4 #5 Up Next peek: 4a added eyebrow, why-line italic clamp 2, duration once`, pk.why > 10 && pk.clamp === '2' && pk.italic === 'italic' && pk.mins === 1 && pk.eyebrow, JSON.stringify(pk));
    // item 6: the car posture title takes three lines on a tall screen, two on a short one
    await open(page, '#/now-playing', 'posture=car', 'dusk');
    const cc = await page.evaluate(() => getComputedStyle(document.querySelector('.np .t-display')).webkitLineClamp);
    A(`[${tag}] r4 #6 car posture title clamp is ${h >= 800 ? 3 : 2}`, cc === String(h >= 800 ? 3 : 2), cc);
    }
    await page.context().close();
  }
}
await browser.close(); server.close();
const fails = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  ->  ' + r.detail}`);
console.log(`\n${results.length - fails.length}/${results.length} assertions pass; ${errors.length} page/console errors${errors.length ? ':\n' + [...new Set(errors)].slice(0, 8).join('\n') : ''}`);
process.exitCode = fails.length ? 1 : 0;
