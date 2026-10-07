#!/usr/bin/env node
// Builds the Phase 2 checkpoint package's local, gitignored half.
//
//   node docs/redesign-2026/checkpoint/build-checkpoint.mjs [--compare-only]
//
// --compare-only refreshes shots/ and publish/compare/ and skips the prototype
// bundles (no network, no artwork downloads).
//
// Writes only under data-local/redesign/checkpoint/ (gitignored; public repo):
//   shots/<dir>/<screen>.png   hero-screen renders copied from data-local/redesign/shots/
//   artwork/<hash>.<ext>       podcast artwork cache, downloaded once from the URLs the prototypes use
//   bundles/<slug>/            each prototype made self-contained for a claude.ai artifact:
//                              artwork as local files, fonts inlined into the CSS, no remote loads
//   publish/compare/           compare.html plus shots/, laid out for the artifact publish
//
// Nothing here is committed except this script and compare.html. The PNGs and
// the artwork are third-party imagery and stay in data-local/.

import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');
const DIRS = join(ROOT, 'docs/redesign-2026/directions');
const SHOTS = join(ROOT, 'data-local/redesign/shots');
const OUT = join(ROOT, 'data-local/redesign/checkpoint');

export const DIRECTIONS = ['tactile', 'ambient', 'editorial', 'native-2026', 'clarity'];
// Each direction's final critique round: the round its art director passed it
// at (polish-to-ready pass, 2026-10-06). The checkpoint shows these renders.
// Tactile is r7: the owner's second header-font round (Archivo -> Anybody,
// provisional; Archivo stays the fallback), 2026-10-06.
export const ROUNDS = { tactile: 'r7', ambient: 'r4', editorial: 'r4', 'native-2026': 'r5', clarity: 'r4' };
export const SCREENS = ['home', 'now-playing', 'foray', 'search', 'library', 'mini', 'onboarding'];
const TODAY_LABEL = {
  home: 'returning__home', 'now-playing': 'player__now-playing', foray: 'returning__foray',
  search: 'returning__search', library: 'returning__library', mini: 'player__mini-player-home',
  onboarding: 'first-run__intro-sheet',
};
// Tactile header-font candidates (round 2 of the font pass, rendered in r7-fonts),
// shown side by side on the page: three fun picks, then Archivo as the fallback.
export const TACTILE_FONTS = ['anybody', 'big-shoulders', 'dela-gothic-one', 'archivo'];
const FONT_ROUND = 'r7-fonts';
const FONT_SCREENS = ['home', 'now-playing', 'foray'];
const TITLES = { tactile: 'Tactile', ambient: 'Ambient', editorial: 'Editorial', 'native-2026': 'Native 2026', clarity: 'Clarity' };
const VIEWPORT = '393x852';
const TEXT = new Set(['.html', '.css', '.js', '.json', '.svg']);
// Not published: notes, build tools, JSON mirrors of data.js (Edition falls back
// to data.js when data.json 404s), the unused icon sprite, and font files
// (inlined into the CSS below).
const SKIP = (p) => /\.(md|json)$/i.test(p) || /(^|[\\/])(tools|fonts)([\\/]|$)/.test(p) || /icons\.svg$/.test(p);
// Whole URL up to its closing quote/paren: Apple's thumbs look like
// .../mza_1.png/600x600bb.jpg, so a lazy match on an extension would stop early.
const ART = /https:\/\/is\d-ssl\.mzstatic\.com\/[^"'\s)\\]+/g;

function walk(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, base));
    else out.push(relative(base, p));
  }
  return out;
}

function copyShots() {
  const missing = [];
  for (const slug of [...DIRECTIONS, 'today']) {
    mkdirSync(join(OUT, 'shots', slug), { recursive: true });
    for (const s of SCREENS) {
      const label = slug === 'today' ? TODAY_LABEL[s] : `default__${s}`;
      const src = slug === 'today'
        ? join(SHOTS, 'today/shots', `${label}__${VIEWPORT}.png`)
        : join(SHOTS, slug, ROUNDS[slug], 'shots', `${label}__${VIEWPORT}.png`);
      if (existsSync(src)) copyFileSync(src, join(OUT, 'shots', slug, `${s}.png`));
      else missing.push(relative(ROOT, src));
    }
  }
  // Faces from an earlier round must not linger: publishCompare() copies all of shots/.
  rmSync(join(OUT, 'shots', 'tactile-fonts'), { recursive: true, force: true });
  for (const face of TACTILE_FONTS) {
    mkdirSync(join(OUT, 'shots', 'tactile-fonts', face), { recursive: true });
    for (const s of FONT_SCREENS) {
      const src = join(SHOTS, 'tactile', FONT_ROUND, face, 'shots', `default__${s}__${VIEWPORT}.png`);
      if (existsSync(src)) copyFileSync(src, join(OUT, 'shots', 'tactile-fonts', face, `${s}.png`));
      else missing.push(relative(ROOT, src));
    }
  }
  return missing;
}

async function fetchArt(url) {
  const ext = extname(new URL(url).pathname).replace('jpeg', 'jpg') || '.jpg';
  const name = createHash('sha1').update(url).digest('hex').slice(0, 16) + ext;
  const file = join(OUT, 'artwork', name);
  if (!existsSync(file)) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  }
  return name;
}

async function bundle(slug) {
  const src = join(DIRS, slug, 'prototype');
  const dst = join(OUT, 'bundles', slug);
  rmSync(dst, { recursive: true, force: true });
  mkdirSync(join(dst, 'img'), { recursive: true });
  const files = walk(src).filter((p) => !SKIP(p));
  const urls = new Set();
  for (const f of files) if (TEXT.has(extname(f))) for (const m of readFileSync(join(src, f), 'utf8').matchAll(ART)) urls.add(m[0]);
  const map = new Map();
  const failed = [];
  await Promise.all([...urls].map(async (u) => {
    try { const n = await fetchArt(u); map.set(u, n); copyFileSync(join(OUT, 'artwork', n), join(dst, 'img', n)); }
    catch (e) { failed.push(String(e.message || e)); }
  }));
  for (const f of files) {
    const from = join(src, f);
    const to = join(dst, f);
    mkdirSync(dirname(to), { recursive: true });
    if (!TEXT.has(extname(f))) { cpSync(from, to); continue; }
    let t = readFileSync(from, 'utf8').replace(ART, (u) => (map.has(u) ? `img/${map.get(u)}` : u));
    if (extname(f) === '.css') {
      t = t.replace(/url\((["']?)(fonts\/[^"')]+\.woff2)\1\)/g, (all, _q, p) => {
        const fp = join(src, dirname(f), p);
        return existsSync(fp) ? `url(data:font/woff2;base64,${readFileSync(fp).toString('base64')})` : all;
      });
    }
    if (extname(f) === '.js') {
      // Each prototype's safeUrl() admits only https:, which rejects the bundle's
      // relative img/ paths. Bundle-only patch: resolve against the page and also
      // admit same-origin URLs. javascript:/data: stay rejected.
      const SAFE = "{ if (typeof u !== 'string' || !u) return ''; try { var x = new URL(u, location.href); return (x.protocol === 'https:' || x.origin === location.origin) ? x.href : ''; } catch (e) { return ''; } }";
      t = t.replace(/^([ \t]*)function safeUrl\(u\) \{.*\}[ \t]*$/m, (_a, ind) => `${ind}function safeUrl(u) ${SAFE}`)
        .replace(/^const safeUrl = u => .*;[ \t]*$/m, `const safeUrl = (u) => ${SAFE};`);
    }
    if (f === 'index.html') {
      // The artifact host serves its own CSP and skeleton; drop the page's meta
      // CSP and font preloads (fonts are inlined above).
      t = t.replace(/<title>[^<]*<\/title>/i, `<title>4a Redesign: ${TITLES[slug]}</title>`)
        .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\s*/i, '')
        .replace(/<link rel="preload"[^>]*as="font"[^>]*>\s*/gi, '');
    }
    writeFileSync(to, t);
  }
  const left = walk(dst).filter((p) => TEXT.has(extname(p)))
    .filter((p) => /https:\/\/is\d-ssl\.mzstatic\.com/.test(readFileSync(join(dst, p), 'utf8')));
  return { slug, images: map.size, failed, remoteLeft: left };
}

function publishCompare() {
  const dst = join(OUT, 'publish/compare');
  rmSync(dst, { recursive: true, force: true });
  mkdirSync(dst, { recursive: true });
  cpSync(join(OUT, 'shots'), join(dst, 'shots'), { recursive: true });
  // The artifact host wraps the page in its own document skeleton.
  const html = readFileSync(join(HERE, 'compare.html'), 'utf8')
    .replace(/<!doctype html>\s*/i, '').replace(/<\/?html[^>]*>\s*/gi, '')
    .replace(/<\/?head>\s*/gi, '').replace(/<\/?body[^>]*>\s*/gi, '')
    .replace(/<meta charset[^>]*>\s*/i, '').replace(/<meta name="viewport"[^>]*>\s*/i, '');
  writeFileSync(join(dst, 'index.html'), html);
}

const missing = copyShots();
mkdirSync(join(OUT, 'artwork'), { recursive: true });
const results = [];
if (!process.argv.includes('--compare-only')) for (const slug of DIRECTIONS) results.push(await bundle(slug));
if (existsSync(join(HERE, 'compare.html'))) publishCompare();
console.log(JSON.stringify({ missingShots: missing, bundles: results }, null, 1));
