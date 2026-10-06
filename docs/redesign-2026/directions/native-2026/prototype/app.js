/* 4a - Native 2026 prototype, round 3 (critique-r2 applied). No build step, no real audio: playback is simulated.
   Calls carried from round 2: (1) the credits' second line is "<clip length> · <gist>" because the data has no
   per-clip episode titles; (2) during a narration beat the art slot already shows the NEXT clip's show, so the listener
   sees who is about to speak; (3) library played-state counts clips (9 of 22), not the r1 "2 of 4" fudge.
   Round-3 calls made without asking: (a) os / scheme / transparency are read from the hash query as well as the search
   string, so the harness can drive every platform on a file or http URL; (b) every foray cover is the real cover of the
   show named beside it (data.json show_art, resolved once through the iTunes Search API), a composite is one tile per
   credited show and so has 1 to 6 tiles; (c) the seam is a continuous dashed thread under solid clip bars, progress is
   opacity plus a --label playhead, never amber; (d) the long-press ContextMenu replaces the row overflow button.
   Markup is built as strings, but every interpolation goes through esc() and every
   src/href through safeUrl(); dynamic sizes are applied through CSSOM (hydrate()), never
   through style="" attributes, so the page would pass the app's CSP. */
(() => {
'use strict';

const D = window.__4A_DATA;
const EP = D.episodes;
const FORAYS = D.forays;
const LEAD = FORAYS[0];
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = u => (typeof u === 'string' && /^https:\/\//.test(u)) ? u : '';
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
const qp = new URLSearchParams(location.search);
const hq = new URLSearchParams((location.hash.split('?')[1]) || '');
const P = k => hq.get(k) || qp.get(k);
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const SPRING = {
  snappy: 'linear(0, 0.013 1.6%, 0.051 3.3%, 0.199 6.9%, 0.429 11%, 0.665 15.5%, 0.856 20.3%, 0.977 25.5%, 1.045 31.1%, 1.065 36.4%, 1.052 42.6%, 1.019 51.5%, 0.996 62.5%, 0.993 72%, 1)',
  dflt: 'linear(0, 0.009 2%, 0.037 4.2%, 0.142 8.7%, 0.316 14%, 0.52 19.7%, 0.716 25.6%, 0.868 31.6%, 0.967 37.6%, 1.021 43.7%, 1.04 49.9%, 1.034 57.2%, 1.014 66.3%, 1 78%, 0.997 89%, 1)'
};

/* ---------- platform and scheme ---------- */
const root = document.documentElement;
const OS = P('os') === 'android' ? 'android' : P('os') === 'ios' ? 'ios' : (/Android/i.test(navigator.userAgent) ? 'android' : 'ios');
root.setAttribute('data-os', OS);
if (P('scheme') === 'light' || P('scheme') === 'dark') root.setAttribute('data-scheme', P('scheme'));
if (P('transparency') === 'reduced') root.setAttribute('data-transparency', 'reduced');
const IOS = OS === 'ios';
/* the drawn status bar is part of the shell: iOS notch-era bar, Android's plain bar (time left, three plain glyphs right) */
$('.statusbar').innerHTML = IOS
  ? '<span class="sb-time">9:41</span><span class="sb-right"><svg class="sb-ic sb-signal"><use href="#i-sb-signal"/></svg><svg class="sb-ic sb-wifi"><use href="#i-sb-wifi"/></svg><svg class="sb-ic sb-batt"><use href="#i-sb-batt"/></svg></span>'
  : '<span class="sb-time">9:41</span><span class="sb-right"><svg class="sb-ic sb-signal"><use href="#i-sba-signal"/></svg><svg class="sb-ic sb-wifi"><use href="#i-sba-wifi"/></svg><svg class="sb-ic sb-batt"><use href="#i-sba-batt"/></svg></span>';

/* ---------- formatting ---------- */
const fmtMin = m => { m = Math.max(1, Math.round(m)); return m < 60 ? m + ' min' : (Math.floor(m / 60) + ' hr' + (m % 60 ? ' ' + (m % 60) + ' min' : '')); };
const fmtSec = s => fmtMin(s / 60);
const clock = s => { s = Math.max(0, Math.floor(s)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };
const fmtMS = s => { s = Math.round(s); const m = Math.floor(s / 60), x = s % 60; return (m ? m + ' min ' : '') + (x ? x + ' sec' : '').trim(); };
const left = s => { const m = Math.max(0, Math.round(s / 60)); return m + ' min left'; };
const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');

/* ---------- small renderers ---------- */
const ic = (n, c = '') => `<svg class="ic ${c}" aria-hidden="true"><use href="#i-${n}"/></svg>`;
const im = (u, lazy = true) => { const s = safeUrl(u); return s ? `<img src="${esc(s)}" alt="" decoding="async"${lazy ? ' loading="lazy"' : ''}>` : ''; };
const art = (u, cls = '', lazy = true) => `<div class="art ${cls}">${im(u, lazy)}</div>`;
/* ArtComposite: one tile per credited show (never a stand-in), so 1 to 6 tiles; the layout class n1..n6 reads it as one cover.
   max 4 for the square composite, 6 for the Foray detail mosaic. */
const comp = (urls, cls = '', lazy = true, max = 4) => { const u = [...new Set(urls)].slice(0, max); return `<div class="comp n${u.length} ${cls}">${u.map(x => im(x, lazy)).join('')}</div>`; };
const durSec = e => e.dur_sec;

/* ---------- foray timeline ---------- */
const NARR_LEN = 10;
function mkTL(f) {
  const tl = []; let t = 0;
  f.clips.forEach((c, i) => {
    if (i > 0 && f.narrated) { tl.push({ type: 'narr', start: t, len: NARR_LEN, line: (f.narration && f.narration[i - 1]) || '' }); t += NARR_LEN; }
    const a = (f.show_art && f.show_art[c.show]) || f.art[i % f.art.length];
    tl.push({ type: 'clip', start: t, len: c.sec, show: c.show, c: c.c, art: a, n: i, gist: c.gist || '' }); t += c.sec;
  });
  return { f, tl, total: t };
}
const TLS = {}; FORAYS.forEach(f => { TLS[f.id] = mkTL(f); });
const curIdx = (F, pos) => { for (let i = F.tl.length - 1; i >= 0; i--) if (pos >= F.tl[i].start) return i; return 0; };
const clipsOnly = F => F.tl.filter(s => s.type === 'clip');

/* SeamStrip (critique r2, item 3). One solid bar per clip, flex-grow = seconds, laid on THE THREAD: a single dashed hairline
   running the full width under the bars (CSS ::before), visible only in the gaps. Narration has no element of its own.
   Progress is opacity (played 100%, unplayed 40%, the current bar split at --p) plus a --label playhead; never amber. */
function strip(F, size, pos, o = {}) {
  const cur = o.noCur ? -1 : curIdx(F, pos);
  let clips = F.tl.filter(s => s.type === 'clip');
  if (o.cap) clips = clips.slice(0, o.cap);
  const prog = !!(o.prog || (o.played > 0) || (!o.noCur && pos > 0.5));
  const preK = (cur >= 0 && F.tl[cur].type === 'narr') ? cur - 1 : -1; // during narration the playhead sits on the thread after this bar
  let h = `<div class="seam ${size}${prog ? ' prog' : ''}${F.f.narrated ? '' : ' no-thread'}"${o.slider ? ` role="slider" tabindex="0" aria-label="Foray position" aria-valuemin="0" aria-valuemax="${Math.round(F.total)}" aria-valuenow="${Math.round(pos)}" aria-valuetext="${esc(sliderText(F, pos))}"` : ' aria-hidden="true"'}${o.id ? ` id="${o.id}"` : ''}>`;
  clips.forEach((s, ci) => {
    const k = F.tl.indexOf(s);
    const p = clamp((pos - s.start) / s.len, 0, 1);
    const loop = o.loop ? (ci === 0 ? ' loop-a' : ci === 1 ? ' loop-b' : '') : '';
    h += `<span class="sb c${s.c}${k === cur ? ' is-cur' : ''}${k === preK ? ' is-pre' : ''}${p >= 1 ? ' is-done' : ''}${o.played > 0 && s.n < o.played ? ' is-played' : ''}${o.unavail ? ' is-unavail' : ''}${loop}" data-grow="${s.len}" data-p="${p.toFixed(4)}" data-k="${k}">${size === 'sm' ? '' : '<i class="ph"></i>'}</span>`;
  });
  h += '</div>';
  if (o.labels) {
    // one label per run of clips from the same show (the thread between them sits inside the run)
    h += '<div class="seam-labels" aria-hidden="true">';
    let g = 0;
    while (g < clips.length) {
      let e = g; while (e + 1 < clips.length && clips[e + 1].show === clips[g].show) e++;
      h += `<span data-k0="${F.tl.indexOf(clips[g])}" data-k1="${F.tl.indexOf(clips[e])}">${esc(clips[g].show)}</span>`;
      g = e + 1;
    }
    h += '</div>';
  }
  return h;
}
function sliderText(F, pos) {
  const i = curIdx(F, pos), s = F.tl[i], all = clipsOnly(F);
  if (s.type === 'narr') return `Narration before clip ${all.indexOf(F.tl[i + 1]) + 1} of ${all.length}`;
  return `Clip ${all.indexOf(s) + 1} of ${all.length}, ${s.show}, ${clock(pos - s.start)} in`;
}

/* apply data-* to CSSOM so no inline style attribute ever exists */
function hydrate(r) {
  $$('[data-grow]', r).forEach(el => { el.style.flexGrow = el.getAttribute('data-grow'); });
  $$('[data-p]', r).forEach(el => { el.style.setProperty('--p', el.getAttribute('data-p')); });
  $$('.seam-labels', r).forEach(placeLabels);
}
/* A show name is written under its run of bars only when the whole name fits (never an ellipsis);
   when no name fits, the 16px label row is removed. The tap chip identifies the short bars. */
function placeLabels(box) {
  const run = () => {
    const seam = box.previousElementSibling; if (!seam || !seam.classList.contains('seam')) return;
    const sr = seam.getBoundingClientRect(); if (!sr.width) return;
    let any = false;
    $$('span', box).forEach(sp => {
      const a = seam.querySelector(`[data-k="${sp.getAttribute('data-k0')}"]`), b = seam.querySelector(`[data-k="${sp.getAttribute('data-k1')}"]`);
      if (!a || !b) return;
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      sp.style.left = (ra.left - sr.left) + 'px'; sp.style.width = (rb.right - ra.left) + 'px';
      const fits = sp.scrollWidth + 4 <= sp.clientWidth;
      sp.classList.toggle('hide', !fits); if (fits) any = true;
    });
    box.classList.toggle('none', !any);
  };
  requestAnimationFrame(() => { run(); setTimeout(run, 120); });
}
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { $$('.seam-labels').forEach(placeLabels); $$('.onb-card').forEach(c => fitOnb(c.parentNode)); });

/* ---------- state ---------- */
const S = {
  item: null, pos: 0, total: 1, playing: false, speed: 1, sleep: false, buffering: false,
  bookmarks: new Set(), upnext: D.library.upnext.slice(), saved: new Set(D.library.saved), npOpen: false,
  lastRoute: '#/home', scroll: {}, seg: 'forays', completedUndo: null
};
const RESUME = { i: 13, pos: 0.38 };
function setEpisode(i, frac = 0) { const e = EP[i]; S.item = { kind: 'ep', e, i }; S.total = e.dur_sec; S.pos = e.dur_sec * frac; }
function setForay(id, pos = 0) { const F = TLS[id]; S.item = { kind: 'foray', F }; S.total = F.total; S.pos = pos; }
const itemTitle = () => S.item.kind === 'ep' ? S.item.e.title : S.item.F.f.title;

/* ---------- views ---------- */
const host = $('#view-host');
let curView = null;

function navbar(o) {
  const back = o.back ? `<button class="nb-btn${o.hero ? ' on-hero' : ''}" data-act="back" aria-label="Back">${ic(IOS ? 'chevron-left' : 'arrow-back', 's28')}</button>` : '';
  const title = o.title ? `<div class="nb-title">${esc(o.title)}</div>` : '';
  const tr = (o.trailing || []).map(t => `<button class="nb-btn${o.hero ? ' on-hero' : ''}" data-act="${t.act}"${t.arg ? ` data-arg="${esc(t.arg)}"` : ''} aria-label="${esc(t.label)}">${ic(t.icon, 's24')}</button>`).join('');
  return `<header class="navbar${o.back ? ' has-back' : ''}${o.hero ? ' is-transparent' : ''}">${back}${title}<span class="nb-spacer"></span>${tr}</header>`;
}

function pickRow(i, o = {}) {
  const e = EP[i]; const br = e.bridge && !o.noBridge;
  const cur = S.item && S.item.kind === 'ep' && S.item.i === i;
  const why = (o.prefix || '') + e.why;
  // trailing: one 44px play only (critique r2 #7); Play next, Add to Up Next, Save, Download, Share and Go to show live in the long-press ContextMenu
  const act = `<div class="row-act"><button class="icon-btn" data-act="play-ep" data-i="${i}" aria-label="Play ${esc(e.title)}">${ic('play', 's28')}</button></div>`;
  const hit = `<button class="row-hit" data-act="play-ep" data-i="${i}" data-ctx="1" aria-label="${esc(e.title)}, ${esc(e.show)}. Press and hold for more."></button>`;
  const prog = o.progress != null ? `<div class="row-prog"><i data-p="${o.progress}"></i></div>` : '';
  if (br) {
    return `<div class="row bridge-row${cur ? ' is-cur' : ''}${o.dim ? ' dim' : ''}"><div class="bart sm"><div class="main r-sm">${im(e.artwork_url)}</div><span class="chip-from">${im(e.bridge.from_art)}</span></div><div class="row-body"><div class="eyebrow">${ic('stretch', 's14')}Stretch</div><div class="voice lg clamp2">${esc(e.bridge.line)}</div><div class="row-s clamp1">${esc(e.title)} · ${esc(e.show)}</div></div>${act}${hit}${prog}</div>`;
  }
  // two tiers: art + title + meta + actions, then the why-line at full row width (duration first so it survives truncation)
  return `<div class="row pick${cur ? ' is-cur' : ''}${o.dim ? ' dim' : ''}">${art(e.artwork_url, 'r-sm')}<div class="row-body"><div class="row-t clamp1">${esc(e.title)}</div><div class="row-s clamp1">${fmtMin(e.dur_min)} · ${esc(e.show)}</div></div>${act}<div class="row-w voice clamp1">${esc(why)}</div>${hit}${prog}</div>`;
}

function rail(items) { return `<div class="rail">${items.join('')}</div>`; }
function forayCard(F, o = {}) {
  const f = F.f; const br = o.bridge;
  const artBlock = br
    ? `<div class="bart"><div class="main r-md">${comp(f.art, 'r-md')}</div><span class="stitch"></span><span class="chip-from">${im(br.from_art)}</span></div>`
    : comp(f.art, 'r-md');
  const body = br
    ? `<div class="eyebrow">${ic('stretch', 's14')}Stretch</div><div class="voice lg clamp3">${esc(br.line)}</div><div class="rcard-t clamp2">${esc(f.title)}</div><div class="rcard-m">${fmtSec(F.total)} · ${plural(f.shows.length, 'show')}</div>`
    : `${strip(F, 'sm', 0, { noCur: true })}<div class="rcard-t clamp2">${esc(f.title)}</div><div class="rcard-m">${fmtSec(F.total)} · ${plural(f.shows.length, 'show')}</div>`;
  return `<button class="rcard${br ? ' bridge' : ''}" data-act="open-foray" data-id="${esc(f.id)}" aria-label="${esc(f.title)}, foray">${artBlock}${body}</button>`;
}
function epCard(i, kind) {
  const e = EP[i];
  if (e.bridge) return `<button class="rcard bridge" data-act="play-ep" data-i="${i}"><div class="bart"><div class="main r-md">${im(e.artwork_url)}</div><span class="stitch"></span><span class="chip-from">${im(e.bridge.from_art)}</span></div><div class="eyebrow">${ic('stretch', 's14')}Stretch</div><div class="voice lg clamp3">${esc(e.bridge.line)}</div><div class="rcard-t clamp2">${esc(e.title)}</div><div class="rcard-m">${esc(e.show)}</div></button>`;
  return `<button class="rcard" data-act="play-ep" data-i="${i}">${art(e.artwork_url, 'r-md')}<div class="rcard-t clamp2">${esc(e.title)}</div><div class="rcard-m">${esc(e.show)} · ${fmtMin(e.dur_min)}</div></button>`;
}
function plCard(p) {
  const urls = p.ids.slice(0, 4).map(k => EP[k].artwork_url);
  return `<button class="rcard" data-act="menu-pl" data-id="${esc(p.id)}">${comp(urls, 'r-md')}<div class="rcard-t clamp2">${esc(p.title)}</div><div class="rcard-m">${plural(p.count, 'episode')} · ${fmtMin(p.mins)}</div></button>`;
}

/* ----- Home ----- */
function actionRow(o) {
  return `<div class="act-row"><button class="play s56" data-act="play-foray" data-id="${esc(o.id)}" aria-label="${esc(o.aria)}">${ic('play-fill', 's28')}</button><div class="lab">${esc(o.label)}${o.sub ? `<small>${esc(o.sub)}</small>` : ''}</div>${o.extra || ''}</div>`;
}
/* one secondary-action grammar on Home and Foray detail (critique r2 #8): a 44px tonal pill, optional 20px glyph */
const pill = (act, label, o = {}) => `<button class="btn pill grow" data-act="${act}"${o.id ? ` data-id="${esc(o.id)}"` : ''}>${o.icon ? ic(o.icon, 's20') : ''}${esc(label)}</button>`;
function heroCard(opts = {}) {
  const F = TLS[LEAD.id]; const f = LEAD;
  const inProg = S.item && S.item.kind === 'foray' && S.item.F === F;
  const pos = inProg ? S.pos : 0;
  const eyebrow = opts.first ? 'Your first foray' : inProg ? 'Jump back in' : "Today's foray";
  const meta = inProg ? `${left(F.total - pos)} · ${plural(f.shows.length, 'show')}` : `${fmtSec(F.total)} · ${plural(f.shows.length, 'show')}`;
  const why = opts.first ? 'A sampler: ten clips from six shows on how barbecue grew up.' : f.why;
  return `<article class="hero" aria-label="${esc(f.title)}">
    <div class="hero-top">${comp(f.art, 'r-art', false)}
      <div class="hero-txt"><div class="eyebrow">${ic('4a', 's14')}${esc(eyebrow)}</div><h2 class="hero-title clamp3">${esc(f.title)}</h2><div class="hero-meta">${esc(meta)}</div></div></div>
    ${strip(F, 'lg', pos, { noCur: !inProg })}
    <p class="why voice clamp3">${esc(why)}</p>
    <div class="hero-actions">${actionRow({ id: f.id, aria: `${inProg ? 'Resume' : 'Play'} ${f.title}`, label: inProg ? 'Resume' : 'Play', extra: pill('open-foray', 'Details', { id: f.id }) })}</div>
  </article>`;
}

function renderHome(q) {
  const st = q.get('state') || '';
  const first = st === 'first-run';
  const rows = [7, 33, 20, 27, 29, 36];
  let body = '';
  if (st === 'loading') {
    // the real boxes of the hero and two rails, so content fades in with no shift (critique r2 #13)
    const skCard = '<div class="sk-card"><div class="sk sk-sq"></div><div class="sk sk-l"></div><div class="sk sk-l w60"></div></div>';
    const skRail = `<section class="section"><div class="sec-h"><div class="sk sk-h"></div></div><div class="rail sk-rail">${skCard}${skCard}${skCard}</div></section>`;
    body = `<article class="hero sk-hero" aria-hidden="true"><div class="hero-top"><div class="sk sk-comp"></div><div class="hero-txt"><div class="sk sk-l w40"></div><div class="sk sk-t"></div><div class="sk sk-t"></div><div class="sk sk-t w70"></div><div class="sk sk-l w50"></div></div></div><div class="sk sk-strip"></div><div class="sk sk-w"></div><div class="sk sk-w w80"></div><div class="hero-actions"><div class="act-row"><div class="sk sk-play"></div><div class="sk sk-l w30"></div></div></div></article>${skRail}${skRail}`;
  } else {
    const rails = [1, 2, 3, 4, 5, 6].map(k => FORAYS[k]).map(f => f.id === 'geology-plates-1'
      ? forayCard(TLS[f.id], { bridge: { from_art: EP[25].artwork_url, line: "You play Don't Panic Geocast. This one goes deeper into how plates began." } })
      : forayCard(TLS[f.id]));
    const resumeShown = !first && !(S.item && S.item.kind === 'ep' && S.item.i === RESUME.i) && !(S.item && S.item.kind === 'foray');
    body = `
      ${st === 'offline' ? `<div class="banner">${ic('wifi-off', 's16')}Offline. Downloaded items come first.</div>` : ''}
      ${heroCard({ first })}
      ${resumeShown ? `<section class="section"><div class="sec-h"><h2>Jump back in</h2></div><div class="list">${pickRow(RESUME.i, { progress: RESUME.pos, prefix: '' })}</div></section>` : ''}
      <section class="section"><div class="sec-h"><h2>Forays for you</h2><button class="link" data-act="nav" data-arg="#/library/forays">See all</button></div>${rail(rails)}</section>
      <section class="section"><div class="sec-h"><h2>Playlists for you</h2><button class="link" data-act="nav" data-arg="#/library/playlists">See all</button></div>${rail(D.playlists.map(plCard))}</section>
      <section class="section"><div class="sec-h"><h2>More picks</h2></div><div class="list">${rows.map(i => pickRow(i, st === 'offline' && i % 2 ? { dim: true } : {})).join('')}</div>${st === 'offline' ? '<p class="foot pad">Needs a connection: the faded rows.</p>' : ''}</section>`;
  }
  return { nav: navbar({ title: 'Today', trailing: [{ act: 'settings', icon: 'settings', label: 'Interests and settings' }] }), html: `<h1 class="ltitle">Today</h1>${body}` };
}

/* ----- Search ----- */
const SUBJ = D.subjects;
function findSubject(q) { const t = q.trim().toLowerCase(); if (!t) return null; return SUBJ.find(s => s.label.toLowerCase().includes(t) || s.terms.some(x => x === t || x.includes(t))) || null; }
function uniqShows() { const m = new Map(); EP.forEach((e, i) => { if (!m.has(e.show)) m.set(e.show, i); }); return m; }
function searchResults(q) {
  const t = q.trim().toLowerCase();
  if (!t) return '';
  const shows = [...uniqShows()].filter(([n]) => n.toLowerCase().includes(t));
  const eps = EP.map((e, i) => [e, i]).filter(([e]) => (e.title + ' ' + e.show + ' ' + e.hook + ' ' + e.subject).toLowerCase().includes(t)).slice(0, 5);
  const pls = D.playlists.filter(p => p.title.toLowerCase().includes(t));
  const subj = findSubject(q);
  let h = '';
  if (subj) h += `<button class="build-row" data-act="build" data-arg="${esc(q.trim())}">${ic('playlist-add')}<span>Build a playlist about ${esc(q.trim())}<small>${esc(subj.label)} · ${plural(subj.shows, 'show')}</small></span></button>`;
  if (!shows.length && !eps.length && !pls.length) {
    const msg = subj ? `The subject ${esc(subj.label)} has ${plural(subj.shows, 'show')}.` : 'Try a show name, a guest or a subject.';
    h += `<div class="empty">${ic('search')}<div class="t">No shows match ‘${esc(q.trim())}’.</div><div class="s">${msg}</div>${subj ? `<button class="btn tonal" data-act="toast" data-arg="Subject pages are not in this prototype.">Open ${esc(subj.label)}</button>` : ''}</div>`;
    return h;
  }
  if (shows.length) h += `<h2 class="group-h">Shows</h2><div class="list">${shows.slice(0, 4).map(([n, i]) => `<div class="row sz40">${art(EP[i].artwork_url, 'r-sm')}<div class="row-body"><div class="row-t clamp1">${esc(n)}</div><div class="row-s">${plural(EP.filter(e => e.show === n).length, 'episode')}</div></div><button class="row-hit" data-act="toast" data-arg="Show pages are not in this prototype." aria-label="${esc(n)}"></button></div>`).join('')}</div>`;
  if (eps.length) h += `<h2 class="group-h">Episodes</h2><div class="list">${eps.map(([, i]) => pickRow(i, { noBridge: true })).join('')}</div>`;
  if (pls.length) h += `<h2 class="group-h">Playlists</h2><div class="list">${pls.map(p => `<div class="row">${comp(p.ids.slice(0, 4).map(k => EP[k].artwork_url), 'r-sm')}<div class="row-body"><div class="row-t clamp2">${esc(p.title)}</div><div class="row-s">${plural(p.count, 'episode')} · ${fmtMin(p.mins)}</div></div><div class="row-act"></div><button class="row-hit" data-act="toast" data-arg="Playlists open in the full app." aria-label="${esc(p.title)}"></button></div>`).join('')}</div>`;
  return h;
}
function renderSearch(arg) {
  const cl = D.clusters; const colA = [cl[0], cl[2], cl[3]], colB = [cl[1], cl[5], cl[4]];
  // right column 40px lower, tall (1:1.25) tiles alternate by column: tile tops differ by 40, 84, 40 at 393 (40, 80, 40 at 375),
  // so the two columns never share a horizontal edge in the first screen (critique r2 #15; measured at all three viewports)
  const tallA = [false, true, false], tallB = [true, false, true];
  const cc = (c, tall) => `<button class="cluster${tall ? ' tall' : ''}" data-act="search-set" data-arg="${esc(c.label)}">${comp(c.ids.map(k => EP[k].artwork_url), 'r-md')}<div class="cluster-t">${esc(c.label)}</div><div class="cluster-m">${plural(c.shows, 'show')}</div></button>`;
  const fol = [...uniqShows()].filter(([, i]) => D.library.shows.includes(i)).slice(0, 8);
  const idle = `<div class="masonry"><div class="mcol">${colA.map((c, k) => cc(c, tallA[k])).join('')}</div><div class="mcol">${colB.map((c, k) => cc(c, tallB[k])).join('')}</div></div>
    <section class="section"><div class="sec-h"><h2>Followed shows</h2></div><div class="followed">${fol.map(([n, i]) => `<button class="fol" data-act="toast" data-arg="Show pages are not in this prototype.">${art(EP[i].artwork_url, '')}<div class="fol-n clamp1">${esc(n)}</div></button>`).join('')}</div></section>`;
  const field = `<label class="search-field" id="sf">${ic('search', 's20')}<input id="q" type="search" enterkeyhint="search" autocomplete="off" placeholder="Shows, episodes, subjects" aria-label="Search" value="${esc(arg || '')}"><button class="clear" data-act="clear-search" aria-label="Clear"${arg ? '' : ' hidden'}>${ic('close', 's16')}</button></label>`;
  return {
    nav: IOS ? navbar({ title: 'Search' }) : '', cls: 'has-field' + (IOS ? '' : ' android-search'), field: IOS ? field : '',
    html: `${IOS ? '<h1 class="ltitle">Search</h1>' : field}<div id="results">${arg ? searchResults(arg) : idle}</div>`, idle
  };
}

/* ----- Library ----- */
const PLAYED = { 'capital-types-1': 9 };
const SEGS = [['forays', 'Forays'], ['shows', 'Shows'], ['saved', 'Saved'], ['playlists', 'Playlists'], ['upnext', 'Up Next'], ['history', 'History']];
function libBody(seg, st) {
  const emptyCard = (icon, t, s, btn, hash) => `<div class="empty">${ic(icon)}<div class="t">${t}</div><div class="s">${s}</div><button class="btn tonal" data-act="nav" data-arg="${hash}">${btn}</button></div>`;
  if (st === 'empty') return ({
    // glyphs that survive 28px (critique r2 #10); the foray seam glyph is for 16px eyebrows only
    forays: emptyCard('library', 'No forays yet', "Today's foray is waiting on Home.", "Open today's picks", '#/home'),
    shows: emptyCard('headphones', 'No followed shows', 'Follow a show and it appears here.', 'Find shows', '#/search'),
    saved: emptyCard('headphones', 'Nothing saved', 'Saved episodes collect here.', "Open today's picks", '#/home'),
    playlists: emptyCard('library', 'No playlists', 'Search a subject to build one.', 'Find shows', '#/search'),
    upnext: emptyCard('queue', 'Nothing queued', 'Add an episode from any row.', "Open today's picks", '#/home'),
    history: emptyCard('headphones', 'No history yet', 'Finished episodes show up here.', "Open today's picks", '#/home')
  })[seg];
  if (seg === 'forays') return `<div class="list">${FORAYS.slice(0, 5).map(f => { const F = TLS[f.id]; const pl = PLAYED[f.id] || 0; const meta = pl ? `${pl} of ${f.clips.length} clips played` : `${fmtSec(F.total)} · ${plural(f.shows.length, 'show')}`;
    return `<div class="row fy-row">${comp(f.art, 'r-sm')}<div class="row-body"><div class="row-t clamp1">${esc(f.title)}</div>${strip(F, 'sm', 0, { noCur: true, played: pl })}<div class="row-s pad-t">${esc(meta)}</div></div><button class="row-hit" data-act="open-foray" data-id="${esc(f.id)}" aria-label="${esc(f.title)}"></button></div>`; }).join('')}</div>`;
  if (seg === 'shows') return `<div class="shows-grid">${D.library.shows.map(i => `<button class="show-tile" data-act="toast" data-arg="Show pages are not in this prototype.">${art(EP[i].artwork_url, 'r-md')}<div class="show-tile-n clamp1">${esc(EP[i].show)}</div></button>`).join('')}</div>`;
  if (seg === 'saved') return `<div class="list">${[...S.saved].map(i => pickRow(i)).join('')}</div>`;
  if (seg === 'playlists') return `<div class="list">${D.playlists.map(p => `<div class="row">${comp(p.ids.slice(0, 4).map(k => EP[k].artwork_url), 'r-sm')}<div class="row-body"><div class="row-t clamp2">${esc(p.title)}</div><div class="row-s">${plural(p.count, 'episode')} · ${fmtMin(p.mins)}</div></div><button class="row-hit" data-act="toast" data-arg="Playlists open in the full app." aria-label="${esc(p.title)}"></button></div>`).join('')}</div>`;
  if (seg === 'upnext') {
    const mins = S.upnext.reduce((a, i) => a + EP[i].dur_min, 0);
    const curI = S.item && S.item.kind === 'ep' ? S.item.i : null;
    return `<div class="q-head"><span>${S.upnext.length} queued · ${fmtMin(mins)}</span><button class="icon-btn" data-act="menu-queue" aria-label="Queue options">${ic('more-h', 's20')}</button></div>
      <div class="list" id="qlist">${S.upnext.map((i, k) => { const e = EP[i]; const cur = i === (curI != null && S.upnext.includes(curI) ? curI : S.upnext[0]);
        return `<div class="qrow${cur ? ' is-cur' : ''}"><span class="drag" aria-hidden="true">${ic('drag', 's20')}</span>${art(e.artwork_url, '')}<div class="row-body"><div class="row-t clamp1" >${esc(e.title)}</div><div class="row-s clamp1">${esc(e.show)} · ${fmtMin(e.dur_min)}</div></div>
          <div class="qrow-end">${cur ? ic('eq', 's20') : ''}<span class="pos" aria-label="Position ${k + 1}${cur ? ', playing' : ''}">${k + 1}</span><button class="icon-btn" data-act="menu-q" data-i="${i}" aria-label="Options for ${esc(e.title)}">${ic('more-v', 's20')}</button></div>
          <button class="row-hit" data-act="play-ep" data-i="${i}" aria-label="Play ${esc(e.title)}"></button></div>`; }).join('')}</div>`;
  }
  if (seg === 'history') return `<div class="list">${D.library.history.map(i => { const e = EP[i]; return `<div class="row sz40"><div class="art r-sm">${im(e.artwork_url)}</div><div class="row-body"><div class="row-t clamp1">${esc(e.title)}</div><div class="row-s clamp1">${esc(e.show)}</div></div><div class="row-act tick">${ic('check-circle', 's20')}</div><button class="row-hit" data-act="play-ep" data-i="${i}" aria-label="Play ${esc(e.title)} again"></button></div>`; }).join('')}</div>`;
  return '';
}
function renderLibrary(arg, q) {
  const seg = SEGS.some(s => s[0] === arg) ? arg : S.seg; S.seg = seg;
  const st = q.get('state') || '';
  const tabs = `<div class="seg" role="tablist" aria-label="Library">${SEGS.map(([k, l]) => `<button role="tab" data-act="seg" data-arg="${k}" aria-selected="${k === seg}">${l}</button>`).join('')}</div>`;
  return { nav: navbar({ title: 'Library', trailing: [{ act: 'toast', arg: 'New playlist: search a subject and choose Build a playlist.', icon: 'plus', label: 'New playlist' }, { act: 'menu-lib', icon: 'more-h', label: 'More' }] }),
    html: `<h1 class="ltitle">Library</h1>${tabs}<div id="libbody">${libBody(seg, st)}</div>`, st };
}

/* ----- Foray detail ----- */
/* "Where this came from": 56px rows only, in play order. mode 'seek' (Now Playing) or 'show' (detail). */
function credits(F, curK, mode) {
  return F.tl.map((s, k) => {
    const cur = k === curK; const tag = 'button';
    const at = mode === 'seek' ? ` data-act="seek-clip" data-arg="${k}"` : ` data-act="toast" data-arg="Show pages are not in this prototype."`;
    if (s.type === 'clip') return `<${tag} class="credit${cur ? ' is-cur' : ''}" data-k="${k}" data-t="clip"${at}>${art(s.art, 'r-sm')}<div><div class="t clamp1">${esc(s.show)}</div><div class="s clamp1">${fmtMS(s.len)} · ${esc(s.gist)}</div></div><span class="row-act">${ic(cur ? 'eq' : 'open', 's20')}</span></${tag}>`;
    return `<${tag} class="credit${cur ? ' is-cur' : ''}" data-k="${k}" data-t="narr"${at}><span class="narr-ic">${ic('4a', 's20')}</span><div><div class="t voice clamp1">Narration</div><div class="s clamp1">${esc(s.line)}</div></div><span class="row-act">${cur ? ic('eq', 's20') : ''}</span></${tag}>`;
  }).join('');
}
function renderForay(arg, q) {
  const st = (q && q.get('state')) || '';
  const F = TLS[FORAYS.some(f => f.id === arg) ? arg : LEAD.id]; const f = F.f;
  const unavail = st === 'unavailable', done = st === 'played';
  const mine = !unavail && !done && S.item && S.item.kind === 'foray' && S.item.F === F;
  const pos = mine ? S.pos : done ? F.total : 0; const clips = clipsOnly(F);
  const meta = `${fmtSec(F.total)} · ${plural(f.shows.length, 'show')} · made today`;
  const curK = mine ? curIdx(F, pos) : -1;
  const actions = unavail ? '' : `<div class="fd-actions">${actionRow({ id: f.id, aria: mine ? 'Resume' : done ? 'Play again' : 'Play', label: mine ? 'Resume' : done ? 'Play again' : 'Play', sub: mine ? left(F.total - pos) : '', extra: pill('queue-add', 'Add to Up Next', { id: f.id, icon: 'playlist-add' }) })}</div>`;
  const stateCard = unavail ? `<div class="empty fd-empty">${ic('error')}<div class="t">This foray can't play right now.</div><div class="s">One of its shows has pulled the episode this clip came from.</div><button class="btn tonal" data-act="nav" data-arg="#/search?q=${encodeURIComponent(f.subject)}">Find something similar</button></div>` : '';
  const whyForay = f.narrated || f.id === LEAD.id
    ? 'Each foray starts from a subject you keep returning to. 4a finds the strongest minutes in real shows, orders them so each clip leads into the next, and adds a short link only where one is needed.'
    : 'Each foray starts from a subject you keep returning to. 4a finds the strongest minutes in real shows and orders them so each clip leads into the next.';
  return {
    nav: navbar({ back: true, hero: true, trailing: [{ act: 'share', icon: IOS ? 'share-ios' : 'share-and', label: 'Share' }, { act: 'menu-foray', icon: 'more-h', label: 'More' }] }),
    // title below the mosaic, not on it (critique r2 #6): a 200px 3x2 mosaic of the credited shows' covers, no text on the art
    html: `<div class="fd-hero">${comp(f.art, 'mosaic', false, 6)}</div>
    <div class="fd-body"><div class="eyebrow">${ic('4a', 's14')}Foray</div><h1 class="fd-title clamp2">${esc(f.title)}</h1>
      <div class="fd-meta">${done ? `${ic('check-circle', 's16 good')}Played · ` : ''}${esc(meta)}</div>
      <div class="seam-wrap">${strip(F, 'lg', pos, { labels: true, noCur: !mine, unavail })}</div>
      ${f.narrated ? '' : '<p class="foot">Clips play back to back.</p>'}
      <p class="why voice">${esc(f.why)}</p>
      ${actions}${stateCard}
      <section class="fd-sec"><h2>Where this came from</h2><div class="list">${credits(F, curK, 'show')}</div></section>
      <section class="fd-sec"><h2>Why this foray</h2><p>${esc(whyForay)}</p></section>
    </div>`, cls: 'fd', hero: true };
}

/* ----- Onboarding ----- */
function fitOnb(r) { const c = $('.onb-card', r); const h = c && $('.hero', c); if (h) c.style.height = Math.round(h.offsetHeight * 0.86) + 'px'; }
function renderOnboarding() {
  const F = TLS[LEAD.id]; const f = LEAD;
  // the loop: bar one fills over 4 s, the playhead crosses the thread over 1 s, bar two begins (static at 40% under reduced motion)
  const sh = strip(F, 'lg', 0, { noCur: true, prog: true, loop: true });
  return { onb: `<div class="onb"><div class="onb-block">
    <div class="onb-card"><div class="onb-glow"></div><article class="hero" aria-hidden="true"><div class="hero-top">${comp(f.art, 'r-art', false)}<div class="hero-txt"><div class="eyebrow">${ic('4a', 's14')}Today's foray</div><h2 class="hero-title clamp3">${esc(f.title)}</h2><div class="hero-meta">${fmtSec(F.total)} · ${plural(f.shows.length, 'show')}</div></div></div>${sh}<p class="why voice clamp3">${esc(f.why)}</p></article></div>
    <div class="onb-copy"><h1>Podcasts, stitched around you</h1><p>4a picks real shows and joins their best parts into one listen, with a reason for each.</p></div></div>
    <div class="onb-btns"><button class="btn fill block" data-act="nav" data-arg="#/home">Show my picks</button><button class="btn tonal block" data-act="nav" data-arg="#/home">Skip for now</button></div></div>` };
}

/* ---------- route rendering ---------- */
function parseHash() {
  const h = location.hash.replace(/^#\/?/, ''); const [path, query] = h.split('?'); const parts = path.split('/');
  return { name: parts[0] || 'home', arg: decodeURIComponent(parts.slice(1).join('/') || ''), q: new URLSearchParams(query || ''), raw: location.hash || '#/home' };
}
const TAB_OF = { home: 'home', mini: 'home', 'now-playing': 'home', search: 'search', library: 'library', foray: 'home', onboarding: 'home' };
let booted = false;

function route() {
  const r = parseHash();
  const first = !booted; booted = true;
  // state seeding for routes that imply a playing item
  if (r.name === 'mini' && !S.item) { setEpisode(RESUME.i, RESUME.pos); S.playing = true; }
  if (r.name === 'now-playing' && !S.item) {
    const st = r.q.get('state');
    if (st === 'episode') setEpisode(r.q.get('ep') != null ? clamp(+r.q.get('ep'), 0, EP.length - 1) : 6, 0.38); else if (st === 'unnarrated') setForay('capital-types-1', 520); else if (st === 'narration') setForay(LEAD.id, 153 + 4); else setForay(LEAD.id, 275);
    S.playing = r.q.get('paused') !== '1'; S.buffering = r.q.get('state') === 'buffering';
  }
  if (r.name === 'library' && r.arg === 'upnext' && !S.item) { setEpisode(S.upnext[0], 0.22); S.playing = true; }
  if (r.name === 'search' && r.q.get('mini') === '1' && !S.item) { setEpisode(RESUME.i, RESUME.pos); S.playing = true; }

  if (r.name === 'now-playing') {
        if (!curView) mountView('home', '', new URLSearchParams(), { instant: true, first: true });
    if (!S.npOpen) openNP({ instant: first || r.q.get('instant') === '1' });
    return;
  }
  if (S.npOpen) closeNP({ quick: true });
  S.lastRoute = r.raw;
  const name = r.name === 'mini' ? 'home' : r.name;
  mountView(name, r.arg, r.q, { fromRoute: r.name, first });
}

function mountView(name, arg, q, o = {}) {
  let spec;
  if (name === 'onboarding') spec = renderOnboarding();
  else if (name === 'search') spec = renderSearch(arg || q.get('q') || ({ typing: 'history', empty: 'fusion' })[q.get('state')] || '');
  else if (name === 'library') spec = renderLibrary(arg, q);
  else if (name === 'foray') spec = renderForay(arg, q);
  else spec = renderHome(q);
  // remember scroll of previous tab view
  if (curView && curView.el) { const sc = $('.view', curView.el); if (sc) S.scroll[curView.key] = sc.scrollTop; }
  const key = name + (name === 'foray' ? ':' + arg : '');
  const screen = document.createElement('div');
  screen.className = 'screen';
  screen.setAttribute('data-view', name);
  if (spec.onb) { screen.innerHTML = spec.onb; }
  else {
    const noMini = !S.item;
    screen.innerHTML = `${spec.nav || ''}<div class="view${noMini ? ' no-mini' : ''} ${spec.cls || ''}">${spec.html}</div>${spec.field || ''}`;
    if (name === 'search' && !IOS) $('.view', screen).classList.add('no-nav');
  }
  const prev = curView && curView.el;
  const swap = () => {
    host.appendChild(screen);
    if (prev) prev.remove();
    hydrate(screen);
    bindScroll(screen);
    const sc = $('.view', screen);
    if (sc && S.scroll[key] != null && !o.first && name !== 'foray') sc.scrollTop = S.scroll[key];
    if (name === 'search') bindSearch(screen, spec);
    if (name === 'library') scrollSeg(screen);
    if (name === 'foray') $('#app').classList.add('over-hero');
    if (name === 'onboarding') fitOnb(screen);
    chromeFor(name);
  };
  const pushed = name === 'foray' && !o.first;
  if (pushed && !reduced()) screen.classList.add('push-in');
  else if (!o.first && !o.instant && !IOS && !reduced() && curView && curView.name !== name) screen.classList.add('tab-in');
  const useVT = !IOS && !reduced() && !pushed && !o.first && !o.instant && curView && curView.name !== name && typeof document.startViewTransition === 'function';
  if (useVT) { try { document.startViewTransition(swap); } catch (e) { swap(); } } else swap();
  curView = { name, key, el: screen };
  renderChrome();
  $('#app').classList.remove('np-open');
  if (name !== 'foray') $('#app').classList.remove('over-hero');
  if (name === 'home' && q.get('state') === 'menu') setTimeout(() => { const r = $('.row.pick'); if (r) ctxOpen(r); }, 60);
}

/* Android chips row bleeds to the screen edge; the selected chip is scrolled into view so an edge cuts a chip, never the gutter */
function scrollSeg(r) {
  if (IOS) return; const s = $('.seg', r); const b = s && $('[aria-selected="true"]', s); if (!b) return;
  s.scrollLeft = Math.max(0, b.offsetLeft - (s.clientWidth - b.offsetWidth) / 2);
}

function chromeFor(name) {
  const tabbar = $('#tabbar'), chrome = $('#chrome');
  const onb = name === 'onboarding';
  chrome.hidden = onb;
  tabbar.classList.remove('is-min', 'is-hid');
}

/* ---------- chrome: tab bar + mini ---------- */
const TABS = [['home', 'Home', 'home'], ['search', 'Search', 'search'], ['library', 'Library', 'library']];
function renderChrome() {
  const active = curView ? TAB_OF[curView.name] : 'home';
  $('#tabbar').innerHTML = TABS.map(([k, l, icn]) => `<button class="tab" data-act="tab" data-arg="${k}"${k === active ? ' aria-current="page"' : ''}><span class="pill">${ic(k === active ? icn + '-fill' : icn, 's24')}</span><span class="tab-lab">${l}</span></button>`).join('');
  renderMini();
}
function miniArt() {
  const it = S.item; if (!it) return '';
  return `<div class="mini-art art r-sm">${im(it.kind === 'foray' ? nowArt(it.F, S.pos) : it.e.artwork_url, false)}</div>`;
}
function renderMini() {
  const slot = $('#mini-slot'); const it = S.item;
  $('#app').classList.toggle('has-mini', !!it);
  if (!it) { slot.innerHTML = ''; return; }
  const title = it.kind === 'ep' ? it.e.title : it.F.f.title;
  const show = it.kind === 'ep' ? it.e.show : fcurLabel();
  slot.innerHTML = `<section class="mini" aria-label="Now playing: ${esc(title)}"><div class="mini-prog"><i data-p="${(S.pos / S.total).toFixed(4)}"></i></div>
    <button class="mini-open" data-act="np-open" aria-label="Open now playing">${miniArt()}<div class="mini-txt"><div class="mini-t">${esc(title)}</div><div class="mini-s">${esc(show)}</div></div></button>
    <button class="icon-btn pp" data-act="pp" aria-label="${S.playing ? 'Pause' : 'Play'}">${ic(S.playing ? 'pause-fill' : 'play-fill', 's28')}</button>
    <button class="icon-btn mini-skip" data-act="fwd30" aria-label="Forward 30 seconds">${ic('fwd30', 's28')}<span>30</span></button></section>`;
  hydrate(slot);
  const v = $('.view', curView && curView.el); if (v) v.classList.toggle('no-mini', false);
}
function fcurLabel() {
  const it = S.item; if (!it || it.kind !== 'foray') return '';
  const s = it.F.tl[curIdx(it.F, S.pos)];
  return s.type === 'narr' ? '4a narration' : s.show;
}

/* ---------- scroll behaviours ---------- */
function bindScroll(screen) {
  const v = $('.view', screen); if (!v) return;
  const nb = $('.navbar', screen); let last = 0;
  const tabbar = $('#tabbar');
  const onScroll = () => {
    const y = v.scrollTop;
    if (nb) nb.classList.toggle('is-collapsed', y > (v.classList.contains('fd') ? 120 : IOS ? 24 : 2));
    // status bar and nav controls sit over the foray mosaic until it scrolls away
    if (v.classList.contains('fd')) $('#app').classList.toggle('over-hero', y < 120);
    const d = y - last;
    if (Math.abs(d) > 6) {
      if (d > 0 && y > 120) tabbar.classList.add(IOS ? 'is-min' : 'is-hid');
      else if (d < 0) tabbar.classList.remove('is-min', 'is-hid');
      last = y;
    }
  };
  v.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
}

/* ---------- search wiring ---------- */
function bindSearch(screen, spec) {
  const input = $('#q', screen); if (!input) return;
  const res = $('#results', screen); const clear = $('.clear', screen);
  const tabbar = $('#tabbar');
  const update = () => { const v = input.value; clear.hidden = !v; res.innerHTML = v.trim() ? searchResults(v) : spec.idle; hydrate(res); };
  input.addEventListener('input', update);
  if (IOS) {
    input.addEventListener('focus', () => { tabbar.classList.add('is-hid'); const sf = $('#sf', screen); if (sf) sf.classList.add('kb'); });
    input.addEventListener('blur', () => { tabbar.classList.remove('is-hid'); const sf = $('#sf', screen); if (sf) sf.classList.remove('kb'); });
  }
}

/* ---------- player ---------- */
let timer = null;
function startTicker() { if (timer) return; timer = setInterval(tick, 250); }
function tick() {
  if (!S.item || !S.playing || S.buffering) return;
  const before = S.item.kind === 'foray' ? curIdx(S.item.F, S.pos) : 0;
  S.pos += 0.25 * S.speed * (S.item.kind === 'foray' ? 1 : 1);
  if (S.pos >= S.total) { advance(); return; }
  paintProgress(before);
}
function advance() {
  // continuous playback: next in Up Next
  const nxt = S.upnext.find(i => !(S.item.kind === 'ep' && S.item.i === i)) ;
  if (nxt != null) { setEpisode(nxt, 0); S.playing = true; renderMini(); if (S.npOpen) renderNP(); }
  else { S.playing = false; S.pos = S.total; renderMini(); }
}
function paintProgress(beforeIdx) {
  const p = S.pos / S.total;
  const mp = $('.mini-prog i'); if (mp) mp.style.setProperty('--p', p.toFixed(4));
  if (!S.item) return;
  if (S.item.kind === 'foray') {
    const F = S.item.F; const idx = curIdx(F, S.pos);
    if (S.npOpen) {
      const pre = F.tl[idx].type === 'narr' ? idx - 1 : -1;
      $$('#np-strip .sb').forEach(el => { const k = +el.getAttribute('data-k'); const s = F.tl[k]; const pp = clamp((S.pos - s.start) / s.len, 0, 1); el.style.setProperty('--p', pp.toFixed(4)); el.classList.toggle('is-done', pp >= 1); el.classList.toggle('is-cur', k === idx); el.classList.toggle('is-pre', k === pre); });
      const sl = $('#np-strip .seam'); if (sl) { sl.classList.toggle('prog', S.pos > 0.5); sl.setAttribute('aria-valuenow', Math.round(S.pos)); sl.setAttribute('aria-valuetext', sliderText(F, S.pos)); }
      if (idx !== beforeIdx) { paintNPText(); renderMini(); }
      paintTimes();
    } else if (idx !== beforeIdx) renderMini();
  } else if (S.npOpen) { const tr = $('#np-track'); if (tr) tr.style.setProperty('--p', p.toFixed(4)); paintTimes(); }
}
function paintTimes() {
  const a = $('#t-l'), b = $('#t-r'); if (!a) return;
  a.textContent = clock(S.pos); b.textContent = '-' + clock(S.total - S.pos);
}
function togglePlay() {
  if (!S.item) return;
  S.playing = !S.playing; if (S.pos >= S.total) { S.pos = 0; }
  renderMini();
  const np = $('#np'); if (np) { np.classList.toggle('is-paused', !S.playing); }
  const pb = $('#np-play'); if (pb) { pb.innerHTML = playGlyph(); pb.classList.toggle('is-paused', !S.playing); pb.setAttribute('aria-label', S.playing ? 'Pause' : 'Play'); }
}
function playGlyph() { return S.buffering ? '<span class="ring"></span>' : ic(S.playing ? 'pause-fill' : 'play-fill', 's32'); }
function seek(to) { const b = S.item && S.item.kind === 'foray' ? curIdx(S.item.F, S.pos) : 0; S.pos = clamp(to, 0, S.total - 0.5); paintProgress(b); if (S.item.kind === 'foray' && S.npOpen) { paintNPText(); } renderMiniIfForay(); }
function renderMiniIfForay() { if (S.item && S.item.kind === 'foray') { const t = $('.mini-s'); if (t) t.textContent = fcurLabel(); } }

function startEpisode(i, src) {
  const same = S.item && S.item.kind === 'ep' && S.item.i === i;
  if (!same) setEpisode(i, 0);
  S.playing = true; S.buffering = false;
  afterStart(src);
}
function startForay(id, src) {
  const F = TLS[id]; const same = S.item && S.item.kind === 'foray' && S.item.F === F;
  if (!same) setForay(id, 0);
  S.playing = true; S.buffering = false;
  afterStart(src);
}
function afterStart(src) {
  const had = !!$('.mini');
  renderChrome();
  if (curView) { const v = $('.view', curView.el); if (v) v.classList.remove('no-mini'); }
  if (src) flyArt(src);
  if (!had && !reduced()) { const m = $('.mini'); if (m) m.animate([{ transform: 'translateY(24px)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 320, easing: SPRING.snappy }); }
}
function flyArt(src) {
  const img = $('img', src) || src; const a = $('.mini-art'); if (!a || !img || reduced()) return;
  const s = (src.getBoundingClientRect ? src : img).getBoundingClientRect(); const d = a.getBoundingClientRect();
  if (!s.width || !d.width) return;
  const fly = document.createElement('div'); fly.className = 'fly';
  const clone = img.tagName === 'IMG' ? img.cloneNode() : null; if (clone) fly.appendChild(clone);
  fly.style.left = s.left + 'px'; fly.style.top = s.top + 'px'; fly.style.width = s.width + 'px'; fly.style.height = s.height + 'px';
  document.body.appendChild(fly);
  a.style.visibility = 'hidden';
  const dx = d.left - s.left, dy = d.top - s.top, k = d.width / s.width;
  const anim = fly.animate([{ transform: 'none', borderRadius: '12px' }, { transform: `translate(${dx}px, ${dy}px) scale(${k})`, borderRadius: (8 / k) + 'px' }], { duration: 320, easing: SPRING.snappy, fill: 'forwards' });
  fly.style.transformOrigin = 'top left';
  anim.onfinish = () => { fly.remove(); a.style.visibility = ''; };
  anim.oncancel = () => { fly.remove(); a.style.visibility = ''; };
}

/* ---------- Now Playing ---------- */
const SPEEDS = [1, 1.25, 1.5, 2, 0.8];
/* The room comes from one cover, never a collage, and from one derivation on both platforms (critique r2 #5): the cover's
   vivid-first hue (most common hue among pixels with oklch chroma >= 0.10, chroma-weighted; plain dominant hue when fewer than 2%
   qualify) feeds the oklch base in CSS. data.json tones were extracted on a 24x24 canvas. Grey art has no meaningful hue, so it
   takes a neutral slate (265) rather than drifting to brown. */
const isDark = () => root.getAttribute('data-scheme') ? root.getAttribute('data-scheme') === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
/* Two gamut calls for a dark room, measured against the harness chroma gate (>= 0.05 at the title's y): sRGB cannot hold chroma at
   L 0.2 for yellow-olive hues (80 to 125, which is exactly the khaki the AD flagged), so they take copper (40); the cyan
   band (190 to 245) clips too, so it takes blue (255). Light rooms are not gamut-limited and keep the true hue. */
const artTone = u => {
  const a = (D.tones && D.tones[u]) || { h: 30, c: 0.06 }; let h = a.c < 0.03 ? 265 : a.h;
  if (isDark()) { if (h >= 80 && h <= 125) h = 40; else if (h >= 190 && h <= 245) h = 255; }
  return { h, c: Math.max(0.04, a.c) };
};
/* art for a foray position: the current clip's show; during a narration beat, the show it introduces */
function nowArt(F, pos) {
  let k = curIdx(F, pos);
  if (F.tl[k].type === 'narr') k = Math.min(F.tl.length - 1, k + 1);
  return F.tl[k].art;
}
function clipNo(F, pos) { let k = curIdx(F, pos); if (F.tl[k].type === 'narr') k = Math.min(F.tl.length - 1, k + 1); return clipsOnly(F).indexOf(F.tl[k]) + 1; }
function renderNP() {
  const it = S.item; const np = $('#np'); const foray = it.kind === 'foray';
  const bgUrl = foray ? nowArt(it.F, S.pos) : it.e.artwork_url;
  const tone = artTone(bgUrl);
  const subj = foray ? 'Today' : it.e.subject;
  const title = foray ? it.F.f.title : it.e.title;
  const remaining = S.upnext.filter(i => !(it.kind === 'ep' && it.i === i));
  const nextI = remaining[0];
  const F = foray ? it.F : null;
  const scrub = foray
    ? `<div class="seam-wrap" id="np-strip">${strip(F, 'lg', S.pos, { slider: true, labels: true })}</div>${F.f.narrated ? '' : '<p class="seam-cap">Clips play back to back.</p>'}`
    : `<div class="track" id="np-track" role="slider" tabindex="0" aria-label="Position" aria-valuemin="0" aria-valuemax="${S.total}" aria-valuenow="${Math.round(S.pos)}" data-p="${(S.pos / S.total).toFixed(4)}"><i></i></div>`;
  const below = foray ? `<section class="np-sec"><div class="sec-h"><h2>Where this came from</h2></div><div class="list">${credits(F, curIdx(F, S.pos), 'seek')}</div></section>`
    : `<section class="np-sec"><div class="sec-h"><h2>Show notes</h2></div><p class="notes">${esc(it.e.hook)}</p><p class="foot">Subject: ${esc(it.e.subject)} · ${fmtMin(it.e.dur_min)}</p></section>`;
  const nextBlock = nextI != null ? `<section class="np-sec" id="np-upnext"><div class="sec-h"><h2>Up Next (${S.upnext.length})</h2><button class="link" data-act="nav" data-arg="#/library/upnext">See all</button></div><div class="list">${pickRow(nextI, { prefix: 'Next: ', noBridge: true })}${remaining.slice(1, 3).map(i => `<div class="row sz44">${art(EP[i].artwork_url, 'r-sm')}<div class="row-body"><div class="row-t clamp1">${esc(EP[i].title)}</div><div class="row-s clamp1">${esc(EP[i].show)}</div></div><button class="row-hit" data-act="play-ep" data-i="${i}" aria-label="Play ${esc(EP[i].title)}"></button></div>`).join('')}</div></section>` : '';
  np.style.setProperty('--art-h', tone.h); np.style.setProperty('--art-c', tone.c);
  np.innerHTML = `<div class="np-sheet" id="np-sheet" role="dialog" aria-modal="true" aria-label="Now playing">
    <div class="np-bg" id="np-bg"><div class="np-tex" id="np-tex">${im(bgUrl, false)}</div></div>
    <div class="np-scroll" id="np-scroll">
      <div class="np-fold">
        ${IOS ? '<div class="grabber" id="np-grab"></div>' : ''}
        <div class="np-head" id="np-head"><button class="icon-btn" data-act="np-close" aria-label="Close">${ic('chevron-down', IOS ? 's28' : 's24')}</button><div class="np-ctx" id="np-ctx">Playing from <b>${esc(subj)}</b></div><button class="icon-btn" data-act="menu-np" aria-label="More">${ic('more-h', 's24')}</button></div>
        <div class="np-art-wrap"><div class="np-art" id="np-art">${im(bgUrl, false)}</div></div>
        <div class="np-meta"><h2 class="np-title clamp2" id="np-title">${esc(title)}</h2><div class="np-show" id="np-show"></div></div>
        <div class="np-scrub">${scrub}<div class="times clock"><span id="t-l">${clock(S.pos)}</span><span id="t-r">-${clock(S.total - S.pos)}</span></div></div>
        <div class="transport"><button class="skip" data-act="back15" aria-label="Back 15 seconds">${ic('back15')}<span>15</span></button>
          <button class="play s64${S.playing ? '' : ' is-paused'}" id="np-play" data-act="pp" aria-label="${S.playing ? 'Pause' : 'Play'}">${playGlyph()}</button>
          <button class="skip" data-act="fwd30" aria-label="Forward 30 seconds">${ic('fwd30')}<span>30</span></button></div>
        <div class="secondary">
          <button class="sec-btn" data-act="speed" aria-label="Speed"><span id="spd" class="tnum">${S.speed === 1 ? '1×' : S.speed + '×'}</span><small>Speed</small></button>
          <button class="sec-btn${S.sleep ? ' on' : ''}" data-act="sleep" aria-label="Sleep timer">${ic(S.sleep ? 'sleep-fill' : 'sleep', 's24')}<small>Sleep</small></button>
          <button class="sec-btn${S.bookmarks.has(itemKey()) ? ' on' : ''}" data-act="bookmark" aria-label="Bookmark">${ic(S.bookmarks.has(itemKey()) ? 'bookmark-fill' : 'bookmark', 's24')}<small>Bookmark</small></button>
          <button class="sec-btn" data-act="share" aria-label="Share">${ic(IOS ? 'share-ios' : 'share-and', 's24')}<small>Share</small></button>
          <button class="sec-btn" data-act="upnext-jump" aria-label="Up Next, ${S.upnext.length} queued">${ic('queue', 's24')}<span class="badge" id="un-badge">${S.upnext.length}</span><small>Up Next</small></button>
        </div>
      </div>
      <div class="np-below">${below}${nextBlock}</div>
    </div></div>`;
  np.classList.toggle('is-paused', !S.playing);
  hydrate(np);
  paintNPText(true);
  bindNPInteractions();
}
/* cross-fade the artwork and the blurred room to a new cover (spring-default 450ms); the tint follows over 600ms */
function swapArt(u) {
  const np = $('#np'); if (!np || !u) return;
  const t = artTone(u); np.style.setProperty('--art-h', t.h); np.style.setProperty('--art-c', t.c);
  [$('#np-art'), $('#np-tex')].forEach(box => {
    if (!box) return;
    const imgs = $$('img', box); const last = imgs[imgs.length - 1];
    if (last && last.getAttribute('src') === u) return;
    const n = document.createElement('img'); n.src = u; n.alt = ''; n.decoding = 'async';
    box.appendChild(n);
    const done = () => imgs.forEach(x => x.remove());
    if (reduced() || !n.animate) { done(); return; }
    const a = n.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 450, easing: SPRING.dflt });
    a.onfinish = done; a.oncancel = done;
  });
}
const itemKey = () => S.item.kind === 'ep' ? 'e' + S.item.i : 'f' + S.item.F.f.id;
function paintNPText(first) {
  const it = S.item; const el = $('#np-show'); if (!el) return;
  if (it.kind === 'ep') { el.className = 'np-show'; el.innerHTML = `<span class="nm">${esc(it.e.show)}</span>`; return; }
  const F = it.F; const idx = curIdx(F, S.pos); const s = F.tl[idx];
  if (!first) swapArt(nowArt(F, S.pos));
  if (s.type === 'narr') { el.className = 'np-show narr'; el.innerHTML = `${ic('4a', 's16')}<span>Narration</span>`; }
  else { el.className = 'np-show'; el.innerHTML = `<span class="nm">${esc(s.show)}</span><span class="cn"> · clip ${clipNo(F, S.pos)} of ${clipsOnly(F).length}</span>`; }
  $$('.credit[data-k]', $('#np')).forEach(c => {
    const on = +c.getAttribute('data-k') === idx; if (c.classList.contains('is-cur') === on) return;
    c.classList.toggle('is-cur', on);
    const a = $('.row-act', c); if (a) a.innerHTML = on ? ic('eq', 's20') : (c.getAttribute('data-t') === 'clip' ? ic('open', 's20') : '');
  });
  $$('.seam-labels', $('#np')).forEach(placeLabels);
}
function bindNPInteractions() {
  const np = $('#np');
  // scrubbing
  const strp = $('#np-strip .seam', np);
  if (strp) {
    strp.addEventListener('click', e => {
      const F = S.item.F; const t = e.target.closest('.sb');
      if (t) { const s = F.tl[+t.getAttribute('data-k')]; const r = t.getBoundingClientRect(); const f = clamp((e.clientX - r.left) / r.width, 0, 1); seek(s.start + f * s.len); chipFor(t, s); return; }
      // a tap on the thread itself: seek to the narration in the nearest gap
      const bars = $$('.sb', strp); let best = null, bd = 1e9;
      bars.forEach((b, i) => { if (i === bars.length - 1) return; const d = Math.abs(e.clientX - b.getBoundingClientRect().right); if (d < bd) { bd = d; best = b; } });
      if (best) { const n = F.tl[+best.getAttribute('data-k') + 1]; if (n && n.type === 'narr') seek(n.start); }
    });
    strp.addEventListener('keydown', e => { if (e.key === 'ArrowRight') seek(S.pos + 30); if (e.key === 'ArrowLeft') seek(S.pos - 15); });
  }
  const tr = $('#np-track', np);
  if (tr) {
    const f = e => { const r = tr.getBoundingClientRect(); seek(clamp((e.clientX - r.left) / r.width, 0, 1) * S.total); };
    tr.addEventListener('pointerdown', e => { f(e); tr.setPointerCapture(e.pointerId); tr.addEventListener('pointermove', f); });
    tr.addEventListener('pointerup', () => tr.removeEventListener('pointermove', f));
    tr.addEventListener('keydown', e => { if (e.key === 'ArrowRight') seek(S.pos + 30); if (e.key === 'ArrowLeft') seek(S.pos - 15); });
  }
  // drag to dismiss from the grabber / header
  const head = $('#np-head', np), grab = $('#np-grab', np), sheet = $('#np-sheet', np);
  [head, grab].forEach(h => { if (!h) return; let y0 = null, dy = 0, t0 = 0;
    h.addEventListener('pointerdown', e => { if (e.target.closest('button')) return; y0 = e.clientY; t0 = e.timeStamp; dy = 0; h.setPointerCapture(e.pointerId); sheet.style.transition = 'none'; });
    h.addEventListener('pointermove', e => { if (y0 == null) return; dy = Math.max(0, e.clientY - y0); sheet.style.transform = `translateY(${dy}px)`; });
    const end = e => { if (y0 == null) return; const v = dy / Math.max(1, e.timeStamp - t0); y0 = null; sheet.style.transition = '';
      if (dy > 110 || v > 0.6) { sheet.style.transform = ''; closeNP({ from: dy }); } else { sheet.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 320, easing: SPRING.snappy }); sheet.style.transform = ''; } };
    h.addEventListener('pointerup', end); h.addEventListener('pointercancel', end); });
}
function chipFor(bar, s) {
  const wrap = bar.closest('.seam-wrap'); if (!wrap) return; $$('.chip-pop', wrap).forEach(c => c.remove());
  const r = bar.getBoundingClientRect(), w = wrap.getBoundingClientRect();
  const c = document.createElement('div'); c.className = 'chip-pop';
  c.innerHTML = `<div class="art">${im(s.art, false)}</div><span>${esc(s.show)}</span>`;
  c.style.left = clamp(r.left - w.left + r.width / 2, 100, w.width - 100) + 'px'; c.style.top = '-6px';
  wrap.appendChild(c); setTimeout(() => c.remove(), 2400);
}

function openNP(o = {}) {
  if (!S.item) return;
  S.npOpen = true; renderNP();
  const np = $('#np'); np.hidden = false; $('#app').classList.add('np-open'); $$('.seam-labels', np).forEach(placeLabels);
  $('#tabbar').classList.add('is-hid'); const m = $('.mini'); if (m) m.classList.add('is-hid');
  const sheet = $('#np-sheet');
  if (!o.instant && !reduced()) {
    const H = sheet.offsetHeight; const a = $('#np-art'); const mini = $('.mini-art');
    const opts = { duration: 450, easing: SPRING.dflt };
    try {
      sheet.animate([{ transform: 'translateY(100%)' }, { transform: 'none' }], opts);
      if (IOS === false) { sheet.classList.add('is-opening'); setTimeout(() => sheet.classList.remove('is-opening'), 460); }
      if (a && mini) {
        const f = a.getBoundingClientRect(); const mr = mini.getBoundingClientRect();
        const end = getComputedStyle(a).transform; const W0 = a.offsetWidth; const k = mr.width / W0;
        a.animate([{ transform: `translate(${mr.left + mr.width / 2 - (f.left + f.width / 2)}px, ${mr.top + mr.height / 2 - (f.top + f.height / 2) - H}px) scale(${k})`, borderRadius: (8 / k) + 'px' }, { transform: end === 'none' ? 'none' : end, borderRadius: '20px' }], opts);
      }
    } catch (err) { /* old engines: no animation */ }
  }
  if (!o.instant) { const h = $('.np-head .icon-btn', np); if (h) h.focus({ preventScroll: true }); }
  startTicker();
}
function closeNP(o = {}) {
  if (!S.npOpen) return;
  S.npOpen = false;
  const np = $('#np'); const sheet = $('#np-sheet');
  const fin = () => { np.hidden = true; np.innerHTML = ''; $('#app').classList.remove('np-open'); };
  const m = $('.mini'); $('#tabbar').classList.remove('is-hid'); if (m) m.classList.remove('is-hid');
  renderMini();
  if (sheet && !o.quick && !reduced()) {
    const a = sheet.animate([{ transform: `translateY(${o.from || 0}px)` }, { transform: 'translateY(100%)' }], { duration: 320, easing: 'cubic-bezier(0.2, 0, 0, 1)', fill: 'forwards' });
    a.onfinish = fin;
  } else fin();
  if (!o.quick) { const t = S.lastRoute && !/now-playing/.test(S.lastRoute) ? S.lastRoute : '#/home'; history.replaceState(null, '', t); }
}

/* ---------- sheets, menus, toast ---------- */
let sheetOpener = null;
function openSheet(title, inner, o = {}) {
  const sh = $('#sheet'), sc = $('#scrim');
  sheetOpener = document.activeElement;
  sh.innerHTML = `<div class="grabber"></div><h2 tabindex="-1" id="sheet-t">${esc(title)}</h2>${inner}`;
  sh.hidden = false; sc.hidden = false;
  requestAnimationFrame(() => { sh.classList.add('on'); sc.classList.add('on'); const t = $('#sheet-t'); if (t) t.focus({ preventScroll: true }); });
  $('#view-host').inert = true; $('#chrome').inert = true;
}
function closeSheet() {
  const sh = $('#sheet'), sc = $('#scrim'); if (sh.hidden) return;
  sh.classList.remove('on'); sc.classList.remove('on');
  $('#view-host').inert = false; $('#chrome').inert = false;
  setTimeout(() => { sh.hidden = true; sc.hidden = true; sh.innerHTML = ''; }, reduced() ? 120 : 360);
  if (sheetOpener && sheetOpener.focus) sheetOpener.focus({ preventScroll: true });
}
function menu(title, items) {
  openSheet(title, items.map(i => `<button class="menu-i${i.danger ? ' danger' : ''}" data-act="${i.act}"${i.i != null ? ` data-i="${i.i}"` : ''}${i.arg ? ` data-arg="${esc(i.arg)}"` : ''}>${ic(i.icon, 's20')}${esc(i.label)}</button>`).join(''));
}
let toastT = null;
function toast(msg, undo) {
  const t = $('#toast'); t.innerHTML = `<span>${esc(msg)}</span>${undo ? '<button data-act="undo">Undo</button>' : ''}`; t.hidden = false;
  t.style.animation = 'none'; void t.offsetWidth; t.style.animation = '';
  clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, undo ? 5000 : 2200);
}
function bumpBadge() { const b = $('#un-badge'); if (b) { b.textContent = S.upnext.length; b.classList.remove('bump'); void b.offsetWidth; b.classList.add('bump'); } }

function noticedSheet() {
  const rows = [['History and war stories', 1], ['Founders and startups', 1], ['Drinks and fermentation', 0], ['Songs taken apart', 1], ['Earth science', 0]];
  openSheet('What 4a has noticed', `<p class="muted pad-b">Subjects you keep coming back to. Less or More changes what 4a picks next.</p>${rows.map(([l, on]) => `<div class="noticed"><span>${esc(l)}</span><button data-act="noticed" class="${on ? '' : 'on'}">Less</button><button data-act="noticed" class="${on ? 'on' : ''}">More</button></div>`).join('')}
    <button class="menu-i" data-act="how">${ic('info', 's20')}How 4a works</button>`);
}

/* ---------- queue ops ---------- */
function qMove(i, to) { const a = S.upnext; const k = a.indexOf(i); if (k < 0) return; a.splice(k, 1); a.splice(clamp(to, 0, a.length), 0, i); refreshLib(); }
function refreshLib() { if (curView && curView.name === 'library') { const b = $('#libbody'); if (b) { b.innerHTML = libBody(S.seg, ''); hydrate(b); } } }

/* ---------- ContextMenu: long-press (critique r2 #7) ----------
   Every row's overflow items live here. iOS: the page blurs, the row lifts (scale 1.03) and a glass menu appears beneath it.
   Android: the same items as a bottom sheet. */
const epMenuItems = i => [{ act: 'play-ep', i, icon: 'play', label: 'Play' }, { act: 'qnext', i, icon: 'queue', label: 'Play next' }, { act: 'qadd', i, icon: 'playlist-add', label: 'Add to Up Next' }, { act: 'save', i, icon: 'bookmark', label: S.saved.has(i) ? 'Remove from Saved' : 'Save' }, { act: 'toast', arg: 'Downloads are not in this prototype.', icon: 'download', label: 'Download' }, { act: 'share', icon: IOS ? 'share-ios' : 'share-and', label: 'Share' }, { act: 'toast', arg: 'Show pages are not in this prototype.', icon: 'headphones', label: 'Go to show' }];
let ctxOpener = null;
function ctxOpen(rowEl) {
  const src = rowEl.hasAttribute('data-i') ? rowEl : $('[data-i]', rowEl); if (!src) return;
  const i = +src.getAttribute('data-i'); const items = epMenuItems(i);
  if (!IOS) { menu(EP[i].title, items); return; }
  ctxClose(true);
  ctxOpener = document.activeElement;
  const app = $('#app'), ar = app.getBoundingClientRect(), r = rowEl.getBoundingClientRect();
  const ov = document.createElement('div'); ov.className = 'ctx'; ov.id = 'ctx';
  ov.innerHTML = `<div class="ctx-bg" data-act="ctx-close"></div>`;
  const lift = rowEl.cloneNode(true); lift.classList.add('ctx-lift'); lift.setAttribute('inert', ''); lift.setAttribute('aria-hidden', 'true');
  lift.style.left = (r.left - ar.left) + 'px'; lift.style.top = (r.top - ar.top) + 'px'; lift.style.width = r.width + 'px';
  if (rowEl.classList.contains('rcard')) lift.style.height = r.height + 'px';
  const menuEl = document.createElement('div'); menuEl.className = 'ctx-menu'; menuEl.setAttribute('role', 'menu'); menuEl.setAttribute('aria-label', EP[i].title);
  menuEl.innerHTML = items.map(m => `<button role="menuitem" class="ctx-i${m.danger ? ' danger' : ''}" data-act="${m.act}"${m.i != null ? ` data-i="${m.i}"` : ''}${m.arg ? ` data-arg="${esc(m.arg)}"` : ''}><span>${esc(m.label)}</span>${ic(m.icon, 's20')}</button>`).join('');
  ov.appendChild(lift); ov.appendChild(menuEl); app.appendChild(ov);
  const mh = menuEl.offsetHeight, mw = menuEl.offsetWidth;
  const below = r.bottom - ar.top + 10 + mh <= ar.height - 24;
  menuEl.style.top = (below ? r.bottom - ar.top + 10 : Math.max(60, r.top - ar.top - 10 - mh)) + 'px';
  menuEl.style.left = clamp(r.left - ar.left + 16, 16, ar.width - mw - 16) + 'px';
  $('#view-host').inert = true; $('#chrome').inert = true;
  requestAnimationFrame(() => { ov.classList.add('on'); const f = $('.ctx-i', menuEl); if (f) f.focus({ preventScroll: true }); });
}
function ctxClose(now) {
  const ov = $('#ctx'); if (!ov) return;
  $('#view-host').inert = false; $('#chrome').inert = false;
  ov.classList.remove('on'); setTimeout(() => ov.remove(), now || reduced() ? 0 : 200);
  if (ctxOpener && ctxOpener.focus) ctxOpener.focus({ preventScroll: true }); ctxOpener = null;
}
let lpT = null, lpAt = 0, lpX = 0, lpY = 0;
const LP_SEL = '.row.pick, .row.bridge-row, .rcard[data-ctx]';
document.addEventListener('pointerdown', e => {
  const row = e.target.closest(LP_SEL); if (!row || e.target.closest('.icon-btn') || e.button > 0) return;
  lpX = e.clientX; lpY = e.clientY; clearTimeout(lpT);
  lpT = setTimeout(() => { lpAt = Date.now(); ctxOpen(row); }, 450);
});
['pointerup', 'pointercancel', 'scroll'].forEach(t => document.addEventListener(t, () => clearTimeout(lpT), true));
document.addEventListener('pointermove', e => { if (Math.hypot(e.clientX - lpX, e.clientY - lpY) > 8) clearTimeout(lpT); });
document.addEventListener('contextmenu', e => { const row = e.target.closest(LP_SEL); if (row) { e.preventDefault(); clearTimeout(lpT); ctxOpen(row); } });
document.addEventListener('click', e => { if (Date.now() - lpAt < 700) { e.stopPropagation(); e.preventDefault(); lpAt = 0; } }, true);

/* ---------- actions ---------- */
let lastRemoved = null;
document.addEventListener('click', e => {
  if (e.target.closest('#ctx')) ctxClose();
  const bar = e.target.closest('.fd-body .seam.lg .sb');
  if (bar) { const F = TLS[(curView && curView.key.split(':')[1]) || LEAD.id] || TLS[LEAD.id]; const s = F.tl[+bar.getAttribute('data-k')]; if (s) chipFor(bar, s); return; }
  const t = e.target.closest('[data-act]'); if (!t) return;
  const a = t.getAttribute('data-act'); const arg = t.getAttribute('data-arg'); const i = t.getAttribute('data-i') != null ? +t.getAttribute('data-i') : null; const id = t.getAttribute('data-id');
  const srcArt = () => { const row = t.closest('.row, .rcard, .hero, .credit, .qrow'); return row ? ($('.art, .comp', row)) : null; };
  switch (a) {
    case 'nav': closeSheet(); location.hash = arg; break;
    case 'tab': { const h = arg === 'home' ? '#/home' : '#/' + arg; if (curView && TAB_OF[curView.name] === arg && curView.name !== 'foray') { const v = $('.view', curView.el); if (v) v.scrollTo({ top: 0, behavior: reduced() ? 'auto' : 'smooth' }); } else location.hash = h; break; }
    case 'back': if (history.length > 1 && /foray/.test(location.hash)) history.back(); else location.hash = '#/home'; break;
    case 'play-ep': closeSheet(); startEpisode(i, srcArt()); break;
    case 'play-foray': startForay(id, srcArt()); break;
    case 'open-foray': location.hash = '#/foray/' + id; break;
    case 'np-open': location.hash = '#/now-playing'; break;
    case 'np-close': closeNP(); break;
    case 'pp': togglePlay(); break;
    case 'back15': seek(S.pos - 15); break;
    case 'fwd30': seek(S.pos + 30); break;
    case 'speed': { const k = (SPEEDS.indexOf(S.speed) + 1) % SPEEDS.length; S.speed = SPEEDS[k]; const s = $('#spd'); if (s) s.textContent = S.speed === 1 ? '1×' : S.speed + '×'; break; }
    case 'sleep': S.sleep = !S.sleep; t.classList.toggle('on', S.sleep); t.innerHTML = `${ic(S.sleep ? 'sleep-fill' : 'sleep', 's24')}<small>Sleep</small>`; toast(S.sleep ? 'Sleep timer: 30 min' : 'Sleep timer off'); break;
    case 'bookmark': { const k = itemKey(); const on = !S.bookmarks.has(k); on ? S.bookmarks.add(k) : S.bookmarks.delete(k); t.classList.toggle('on', on); t.innerHTML = `${ic(on ? 'bookmark-fill' : 'bookmark', 's24')}<small>Bookmark</small>`; toast(on ? 'Bookmarked at ' + clock(S.pos) : 'Bookmark removed'); break; }
    case 'share': toast('Link copied'); break;
    case 'upnext-jump': { const u = $('#np-upnext'); if (u) u.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'start' }); break; }
    case 'seek-clip': { const s = S.item.F.tl[+arg]; seek(s.start); break; }
    case 'settings': noticedSheet(); break;
    case 'noticed': { const row = t.closest('.noticed'); $$('button', row).forEach(b => b.classList.toggle('on', b === t)); break; }
    case 'how': closeSheet(); location.hash = '#/onboarding'; break;
    case 'seg': { S.seg = arg; history.replaceState(null, '', '#/library/' + arg); const q = parseHash().q; $$('.seg button').forEach(b => b.setAttribute('aria-selected', b === t)); scrollSeg(document); const b = $('#libbody'); b.innerHTML = libBody(arg, q.get('state') || ''); hydrate(b); b.classList.remove('fade-in'); void b.offsetWidth; b.classList.add('fade-in'); break; }
    case 'search-set': { const inp = $('#q'); if (inp) { inp.value = arg; inp.dispatchEvent(new Event('input')); inp.focus(); } break; }
    case 'clear-search': { const inp = $('#q'); if (inp) { inp.value = ''; inp.dispatchEvent(new Event('input')); inp.focus(); } break; }
    case 'build': toast('Building a playlist about ' + arg + '. Nothing is saved in this prototype.'); break;
    case 'toast': closeSheet(); toast(arg); break;
    case 'queue-add': closeSheet(); toast('Added to Up Next'); bumpBadge(); break;
    case 'menu-ep': menu(EP[i].title, epMenuItems(i)); break;
    case 'ctx-close': break;
    case 'menu-pl': menu(D.playlists.find(p => p.id === id).title, [{ act: 'toast', arg: 'Playlists open in the full app.', icon: 'play', label: 'Play' }, { act: 'toast', arg: 'Added to Up Next', icon: 'queue', label: 'Add to Up Next' }]); break;
    case 'menu-np': menu(itemTitle(), [{ act: 'bookmark', icon: 'bookmark', label: 'Bookmark' }, { act: 'share', icon: IOS ? 'share-ios' : 'share-and', label: 'Share' }, { act: 'toast', arg: 'Downloads are not in this prototype.', icon: 'download', label: 'Download' }]); break;
    case 'menu-foray': menu('Foray', [{ act: 'queue-add', id: '', icon: 'queue', label: 'Add to Up Next' }, { act: 'share', icon: IOS ? 'share-ios' : 'share-and', label: 'Share' }]); break;
    case 'menu-lib': menu('Library', [{ act: 'how', icon: 'info', label: 'How 4a works' }, { act: 'settings', icon: 'settings', label: 'What 4a has noticed' }]); break;
    case 'menu-queue': menu('Up Next', [{ act: 'qclear', icon: 'delete', label: 'Clear Up Next', danger: true }]); break;
    case 'menu-q': { const k = S.upnext.indexOf(i); menu(EP[i].title, [{ act: 'qtop', i, icon: 'to-top', label: 'Move to top' }, ...(k > 0 ? [{ act: 'qup', i, icon: 'up', label: 'Move up' }] : []), ...(k < S.upnext.length - 1 ? [{ act: 'qdown', i, icon: 'down', label: 'Move down' }] : []), { act: 'qrm', i, icon: 'delete', label: 'Remove', danger: true }]); break; }
    case 'qtop': closeSheet(); qMove(i, 0); break;
    case 'qup': closeSheet(); qMove(i, S.upnext.indexOf(i) - 1); break;
    case 'qdown': closeSheet(); qMove(i, S.upnext.indexOf(i) + 1); break;
    case 'qnext': closeSheet(); qMove(i, 0); if (!S.upnext.includes(i)) S.upnext.unshift(i); toast('Playing next'); bumpBadge(); break;
    case 'qadd': closeSheet(); if (!S.upnext.includes(i)) S.upnext.push(i); toast('Added to Up Next'); bumpBadge(); break;
    case 'save': closeSheet(); S.saved.has(i) ? S.saved.delete(i) : S.saved.add(i); toast(S.saved.has(i) ? 'Saved' : 'Removed from Saved'); break;
    case 'qrm': { closeSheet(); const k = S.upnext.indexOf(i); lastRemoved = { i, k }; S.upnext.splice(k, 1); refreshLib(); toast('Removed from Up Next', true); break; }
    case 'qclear': closeSheet(); S.upnext = []; refreshLib(); toast('Up Next cleared'); break;
    case 'undo': if (lastRemoved) { S.upnext.splice(lastRemoved.k, 0, lastRemoved.i); lastRemoved = null; refreshLib(); $('#toast').hidden = true; } break;
  }
});
$('#scrim').addEventListener('click', closeSheet);
document.addEventListener('keydown', e => { if (e.key === 'Escape') { if ($('#ctx')) ctxClose(); else if (!$('#sheet').hidden) closeSheet(); else if (S.npOpen) closeNP(); } });
document.addEventListener('error', e => { const t = e.target; if (t && t.tagName === 'IMG') t.style.visibility = 'hidden'; }, true);

window.addEventListener('hashchange', route);
startTicker();
if (!location.hash) history.replaceState(null, '', location.pathname + location.search + '#/home');
route();
window.__4A = { S, route };
})();
