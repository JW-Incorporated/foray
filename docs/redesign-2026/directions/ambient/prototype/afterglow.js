/* Afterglow: 4a "ambient" direction prototype, round 3. Plain classic script, no build step.
   Everything is built with DOM calls (textContent, setAttribute), never innerHTML with data, so there is
   nothing to escape; image URLs pass safeUrl(); no inline style attributes (CSSOM custom properties only).
   Playback is simulated: a 1 s ticker moves a position, nothing plays.
   Query hooks for the harness (BUILD-NOTES 8): ?state=, ?theme=, ?posture=car, ?mini=1, ?textscale=, ?scroll=<px>, ?eyebrow=on.
   Round 3 adds ?state=np-segchange and ?state=np-detail3; a deep-linked Now Playing is shot at rest (no transient caption). */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ utils */
  var D = window.AG_DATA;
  var $app = document.getElementById('app');
  if (window.AG_SPRITE) document.body.insertAdjacentHTML('afterbegin', window.AG_SPRITE);

  function safeUrl(u) { return typeof u === 'string' && /^https:\/\//i.test(u) ? u : ''; }
  function h(tag, a) {
    var el = document.createElement(tag), k, kids = Array.prototype.slice.call(arguments, 2);
    if (a) for (k in a) {
      var v = a[k];
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else if (k === 'css') { for (var p in v) el.style.setProperty(p, v[p]); }
      else el.setAttribute(k, v === true ? '' : v);
    }
    (function add(list) {
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (c == null || c === false) continue;
        if (Array.isArray(c)) add(c); else el.append(c.nodeType ? c : document.createTextNode(String(c)));
      }
    })(kids);
    return el;
  }
  var SVGNS = 'http://www.w3.org/2000/svg';
  function icon(id, cls) {
    var s = document.createElementNS(SVGNS, 'svg'); s.setAttribute('class', 'icon ' + (cls || '')); s.setAttribute('aria-hidden', 'true');
    var u = document.createElementNS(SVGNS, 'use'); u.setAttribute('href', '#' + id); s.appendChild(u); return s;
  }
  function toggleIcon(off, on, isOn) {
    var w = h('span', { class: 'toggle-icon' + (isOn ? ' is-on' : '') }); w.append(icon(off, 'off'), icon(on, 'on')); return w;
  }
  var store = {
    get: function (k) { try { return localStorage.getItem('cp_' + k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem('cp_' + k, v); } catch (e) { /* ignore */ } }
  };
  function fnv(s) { var x = 2166136261; for (var i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619) >>> 0; } return x >>> 0; }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function fmt(sec) { sec = Math.max(0, Math.round(sec)); var m = Math.floor(sec / 60), s = sec % 60; return m + ':' + pad(s); }
  function fmtLong(sec) { var h2 = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60); return h2 ? h2 + ' hr ' + (m ? m + ' min' : '') : m + ' min'; }
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function dshort(iso) { if (!iso) return ''; var p = iso.split('-'); return parseInt(p[2], 10) + ' ' + MONTHS[parseInt(p[1], 10) - 1]; }
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var Q = new URLSearchParams(location.search);

  /* ------------------------------------------------------------------ data */
  var EP = D.episodes, FORAY = D.foray, PAL = D.palettes || {};
  var EPBY = {}; EP.forEach(function (e) { EPBY[e.id] = e; });
  var ARTBY = {}; EP.forEach(function (e) { ARTBY[e.show] = e.art; });
  FORAY.items.forEach(function (i) { if (i.type === 'segment' && i.art) ARTBY[i.show] = i.art; });
  (D.forays_lite || []).forEach(function (f) { f.shows.forEach(function (s) { if (s.art) ARTBY[s.show] = s.art; }); });

  /* the Foray timeline */
  var FT = { items: [], total: 0, shows: [] };
  FORAY.items.forEach(function (it) {
    var o = Object.assign({}, it, { start: FT.total });
    FT.total += it.dur; o.end = FT.total; FT.items.push(o);
    if (it.type === 'segment' && FT.shows.indexOf(it.show) < 0) FT.shows.push(it.show);
  });
  function forayAt(t) {
    for (var i = 0; i < FT.items.length; i++) if (t < FT.items[i].end) return i;
    return FT.items.length - 1;
  }

  /* ------------------------------------------------------------------ colour (BUILD-NOTES 1.2) */
  function isDawn() {
    var t = document.documentElement.getAttribute('data-theme');
    if (t) return t === 'dawn';
    return window.matchMedia('(prefers-color-scheme: light)').matches;
  }
  /* <html data-scheme="dusk|dawn">: the resolved scheme, so Rooms that follow the scheme need one CSS block, not a media-query twin */
  function applyScheme() { document.documentElement.setAttribute('data-scheme', isDawn() ? 'dawn' : 'dusk'); }
  function hcOf(key) {
    var p = PAL[key];
    if (p) return [p[0], p[1]];
    return [fnv(String(key)) % 360, 0.10];
  }
  /* Dusk Glow lightness 0.66 (round 1 had 0.62 and the tint was below perception); Dawn stays 0.56 */
  function glowOf(key) { var hc = hcOf(key); return 'oklch(' + (isDawn() ? 0.56 : 0.66) + ' ' + clamp(hc[1], 0.07, 0.14).toFixed(3) + ' ' + hc[0] + ')'; }
  var NEUTRAL_GLOW = 'oklch(0.66 0.05 70)';
  var segHue = {};
  function buildSegColors() {
    segHue = {}; var used = [];
    FT.shows.forEach(function (s) {
      var hh = hcOf(s)[0], tries = 0;
      function near(x) { return used.some(function (u) { var d = Math.abs(u - x) % 360; return Math.min(d, 360 - d) < 24; }); }
      while (near(hh) && tries < 3) { hh = (hh + 30) % 360; tries++; }
      used.push(hh); segHue[s] = hh;
    });
  }
  function segColor(show) {
    var hh = segHue[show]; if (hh == null) hh = hcOf(show)[0];
    return isDawn() ? 'oklch(0.52 0.13 ' + hh + ')' : 'oklch(0.70 0.13 ' + hh + ')';
  }
  function roomArt(show) {
    var u = safeUrl(ARTBY[show]);
    if (u) return 'url("' + u + '")';
    var hh = hcOf(show)[0];
    return 'linear-gradient(135deg, oklch(0.6 0.13 ' + hh + '), oklch(0.4 0.1 ' + ((hh + 40) % 360) + '))';
  }
  var NEUTRAL_ART = 'linear-gradient(135deg, oklch(0.55 0.05 70), oklch(0.38 0.04 60))';
  function roomCssAt(idx) { var it = FT.items[idx]; return it.type === 'segment' ? roomArt(it.show) : NEUTRAL_ART; }
  function glowAt(idx) { var it = FT.items[idx]; return it.type === 'segment' ? glowOf(it.show) : NEUTRAL_GLOW; }

  /* ------------------------------------------------------------------ artwork components */
  function sized(url, sz) { return sz <= 80 ? url.replace(/\/\d+x\d+bb\./, '/200x200bb.') : url; }
  function monoOf(name) { name = String(name || '?').replace(/^(the|a)\s+/i, ''); return name.charAt(0).toUpperCase(); }
  function litCls(sz) { return sz >= 280 ? 'lit-96' : sz >= 160 ? 'lit-64' : 'lit-40'; }
  function art(show, url, sz, cls, o) {
    o = o || {};
    var key = show || url || 'x', hh = hcOf(key)[0];
    var css = { '--sz': sz + 'px', '--art-bg': 'linear-gradient(135deg, oklch(0.55 0.12 ' + hh + '), oklch(0.40 0.10 ' + ((hh + 30) % 360) + '))' };
    /* Lit art (round 3 item 5): 104px or more casts its OWN colour, never a black shadow */
    var lit = !o.nolit && (o.lit || sz >= 104);
    if (lit) css['--art-glow'] = glowOf(key);
    var el = h('span', { class: 'art ' + (cls || '') + (o.dim ? ' dim' : '') + (lit ? ' lit-art ' + litCls(sz) : ''), css: css });
    var u = safeUrl(url);
    function mono() { el.append(h('span', { class: 'mono', 'aria-hidden': 'true' }, monoOf(show))); }
    if (u) {
      var img = h('img', { src: sized(u, sz), alt: '', decoding: 'async' });
      img.addEventListener('error', function () { img.remove(); mono(); });
      el.append(img);
    } else mono();
    if (o.progress) el.append(h('span', { class: 'rim' }, h('i', { css: { '--p': o.progress } })));
    if (o.badge) { el.append(icon('i-check-circle-fill', 'badge')); }
    return el;
  }
  function collage(list, sz, cls, o) {
    list = list.slice(0, 4); o = o || {};
    /* a collage never crops a square (round 3 item 4): c4 the 2x2, c2 two squares at 68%, c3 three at 58%, c1 the art */
    var n = list.length, csz = n === 4 ? sz / 2 : n === 3 ? sz * 0.58 : n === 2 ? sz * 0.68 : sz;
    var css = { '--sz': sz + 'px' }, lit = !o.nolit && sz >= 104;
    if (lit) css['--art-glow'] = glowOf(list[0].show || list[0].art);
    var el = h('span', { class: 'collage c' + n + ' ' + (cls || '') + (o.dim ? ' dim' : '') + (lit ? ' lit-art ' + litCls(sz) : ''), css: css });
    list.forEach(function (x) { el.append(art(x.show, x.art, csz, '', { nolit: true })); });
    return el;
  }
  var FORAY_ARTS = FT.shows.map(function (s) { return { show: s, art: ARTBY[s] }; });

  /* ------------------------------------------------------------------ state */
  var S = {
    name: 'home', cur: null, playing: false, buffering: false, t: 0, speed: 1, npOpen: false, under: '#/home',
    followed: {}, saved: {}, bookmarked: false, downloaded: false, sleep: 0,
    upnext: [], history: [], prog: {},
    q: '', stateParam: Q.get('state') || ''
  };
  var FOLLOW_SHOWS = ['Science Vs', 'Planet Money', '99% Invisible', 'Hidden Brain', 'Freakonomics Radio', 'Unexplainable', 'Odd Lots', 'Founders'];
  FOLLOW_SHOWS.forEach(function (n) { S.followed[n] = true; });
  var KEEP = EP[2];            // the mid-listen episode
  S.prog[KEEP.id] = 0.42 * KEEP.dur * 60;
  S.prog['foray'] = Math.round(FT.total * 0.36);
  function epByShow(n) { return EP.filter(function (e) { return e.show === n; })[0]; }
  var PICK_IDS = [17, 7, 'STRETCH', 21, 23].map(function (i) { return i === 'STRETCH' ? i : EP[i].id; });
  var FIRST_PICK = EP[17];
  /* offline: two of the five picks are downloaded and play; the other three are unavailable (critique item 18) */
  var OFFLINE_OK = {}; OFFLINE_OK[EP[17].id] = true; OFFLINE_OK[EP[7].id] = true;
  var OFFPATH = [39, 38, 16].map(function (i) { return EP[i]; });
  var STRETCH = { familiar: EP[0], pick: EP[3], bridge: 'If Science Vs on insects held you, this asks the same question of an empire: what breaks first?' };
  S.upnext = [{ ep: EP[21], reason: '' }, { ep: EP[23], reason: '4a added: a follow-up on money you saved.' }, { ep: EP[36], reason: '' }, { ep: EP[34], reason: '4a added: shorter, for the end of the day.' }, { ep: EP[19], reason: '' }];
  S.history = [EP[8], EP[12], EP[27]];
  S.saved[EP[17].id] = true; S.saved[EP[22].id] = true; S.saved[EP[33].id] = true;
  var PLAYLISTS = [
    { name: 'Slow mornings', eps: [0, 2, 4, 17, 20, 30] },
    { name: 'Money, plainly', eps: [7, 22, 23, 21, 36, 6] },
    { name: 'Old stories, new angles', eps: [3, 18, 33, 39, 25, 9] },
    { name: 'Small machines', eps: [8, 12, 27, 13, 10, 29] }
  ].map(function (p) { p.eps = p.eps.map(function (i) { return EP[i]; }); p.mins = p.eps.reduce(function (a, e) { return a + e.dur; }, 0); p.played = p.name === 'Money, plainly' ? 3 : 0; return p; });

  /* ------------------------------------------------------------------ chrome elements: the Dock is ONE Veil surface (critique item 3) */
  var $screenHost = h('div', { id: 'screens' });
  var $fieldRow = h('div', { class: 'dock-field', role: 'search', hidden: true });
  var $tabbar = h('nav', { class: 'tabbar', 'aria-label': 'Primary' });
  var $mini = h('div', { class: 'mini', role: 'region', hidden: true });
  var $dock = h('div', { class: 'dock veil' }, $fieldRow, $mini, $tabbar);
  var $fade = h('div', { class: 'dock-fade', 'aria-hidden': 'true' });
  var $pageGlow = h('div', { class: 'page-glow', 'aria-hidden': 'true' });
  var $np = h('div', { class: 'np', 'aria-hidden': 'true', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Now playing' });
  var $toast = h('div', { class: 'toast raised', role: 'status', 'aria-live': 'polite' });
  var $scrim = h('div', { class: 'sheet-scrim' });
  var $sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' });
  var $kb = h('div', { class: 'kbpad', 'aria-hidden': 'true' });
  $app.append($pageGlow, $screenHost, $fade, $dock, $np, $scrim, $sheet, $toast, $kb);

  var TABS = [['home', 'Today', 'i-house', 'i-house-fill', '#/home'], ['discover', 'Discover', 'i-compass', 'i-compass-fill', '#/search'], ['library', 'Library', 'i-books', 'i-books-fill', '#/library']];
  var upCount = 0;
  TABS.forEach(function (t) {
    var b = h('button', { class: 'tab', 'data-tab': t[0], 'aria-label': t[1], onclick: function () { go(t[4]); } }, toggleIcon(t[2], t[3], false), h('span', { class: 'lbl' }, t[1]));
    $tabbar.append(b);
  });
  var $libBadge = h('span', { class: 'badge', hidden: true, 'aria-hidden': 'true' }, '0');
  $tabbar.querySelector('[data-tab="library"]').append($libBadge);

  /* ------------------------------------------------------------------ haptics (Web+, no-op here) */
  function haptic(kind) { try { if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Haptics) window.Capacitor.Plugins.Haptics.impact({ style: kind === 'medium' ? 'MEDIUM' : 'LIGHT' }); } catch (e) { /* none */ } }

  /* ------------------------------------------------------------------ toast, sheet */
  var toastTimer = 0;
  function toast(msg, actionLabel, onAction) {
    $toast.replaceChildren(h('span', { class: 't-label' }, msg));
    if (actionLabel) $toast.append(h('button', { class: 'btn btn-quiet', onclick: function () { $toast.classList.remove('show'); if (onAction) onAction(); } }, actionLabel));
    else $toast.append(h('span'));
    $toast.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(function () { $toast.classList.remove('show'); }, 5000);
  }
  var sheetOpener = null;
  function openSheet(title, body) {
    sheetOpener = document.activeElement;
    $sheet.replaceChildren(h('div', { class: 'sheet-head veil' }, h('span', { class: 'grabber' }), h('h2', { class: 't-headline' }, title), h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: closeSheet }, icon('i-x'))), h('div', { class: 'sheet-body' }, body));
    $sheet.setAttribute('aria-label', title);
    $scrim.classList.add('open'); $sheet.classList.add('open');
    var f = $sheet.querySelector('button'); if (f) f.focus();
  }
  function closeSheet() { $scrim.classList.remove('open'); $sheet.classList.remove('open'); if (sheetOpener && sheetOpener.focus) try { sheetOpener.focus(); } catch (e) { /* ignore */ } }
  $scrim.addEventListener('click', closeSheet);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { if ($sheet.classList.contains('open')) closeSheet(); else if (S.npOpen) closeNP(); }
    if (e.key === 'Tab' && $sheet.classList.contains('open')) {
      var f = $sheet.querySelectorAll('button, [href], input'); if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
      else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
    }
  });
  function menu(title, items) {
    openSheet(title, h('div', { class: 'menu-list' }, items.map(function (it) {
      return h('button', { onclick: function () { closeSheet(); it.run(); } }, icon(it.icon, 's20'), h('span', { class: 't-body' }, it.label));
    })));
  }

  /* ------------------------------------------------------------------ playback model */
  function curDur() { return !S.cur ? 0 : S.cur.kind === 'foray' ? FT.total : S.cur.ep.dur * 60; }
  function curKey() { return !S.cur ? '' : S.cur.kind === 'foray' ? 'foray' : S.cur.ep.id; }
  function curTitle() { return !S.cur ? '' : S.cur.kind === 'foray' ? FORAY.title : S.cur.ep.title; }
  function curShow() {
    if (!S.cur) return '';
    if (S.cur.kind === 'ep') return S.cur.ep.show;
    var it = FT.items[forayAt(S.t)];
    return it.type === 'segment' ? it.show : '4a narration';
  }
  function setHtmlGlow() {
    var css;
    if (S.cur) {
      var k = S.cur.kind === 'foray' ? (FT.items[forayAt(S.t)].show) : S.cur.ep.show;
      css = k ? glowOf(k) : NEUTRAL_GLOW;
    } else css = glowOf(FT.shows[0]);
    document.documentElement.style.setProperty('--glow', css);
  }
  function setCurrent(c, opts) {
    opts = opts || {};
    if (S.cur) S.prog[curKey()] = S.t;
    S.cur = c; S.t = S.prog[curKey()] || 0; S.playing = opts.paused ? false : true; S.buffering = false;
    S.downloaded = false; S.bookmarked = false;
    if (c.kind === 'ep') { S.upnext = S.upnext.filter(function (u) { return u.ep.id !== c.ep.id; }); }
    setHtmlGlow(); buildNP(opts.handoff); renderMini(opts.flipFrom); syncPlayUI(); updateTabs();
    if (opts.flipFrom) haptic('light');
  }
  function togglePlay() {
    if (!S.cur) return;
    S.playing = !S.playing; haptic('light');
    $np.classList.toggle('paused', !S.playing);
    syncPlayUI();
  }
  function playEp(e, srcArt) {
    if (S.cur && S.cur.kind === 'ep' && S.cur.ep.id === e.id) { togglePlay(); return; }
    setCurrent({ kind: 'ep', ep: e }, { flipFrom: srcArt });
  }
  function playForay(srcArt) {
    if (S.cur && S.cur.kind === 'foray') { togglePlay(); return; }
    setCurrent({ kind: 'foray' }, { flipFrom: srcArt });
  }
  function seekTo(t) {
    S.t = clamp(t, 0, curDur()); renderProgress(true);
  }
  /* end of item: the next artwork slides in from the right as the Room crossfades (BUILD-NOTES 5). `freeze` renders the frame mid-flight for ?state=ending */
  function endItem(freeze) {
    var nx = S.upnext[0];
    if (!nx) { S.playing = false; S.t = curDur(); syncPlayUI(); return; }
    S.history.unshift(S.cur.kind === 'ep' ? S.cur.ep : EP[0]);
    var prevArt = $np.querySelector('.np-art .swap > .art, .np-art .swap > .collage');
    var prevCss = NPR.layers ? NPR.layers[NPR.layerOn || 0].style.getPropertyValue('--art') : '';
    var ho = prevArt ? { artNode: prevArt.cloneNode(true), roomCss: prevCss, freeze: !!freeze } : null;
    setCurrent({ kind: 'ep', ep: nx.ep }, { handoff: ho });
  }
  var lastIdx = -1;
  setInterval(function () {
    if (!S.cur || !S.playing || S.buffering || S.freeze) return;
    S.t += S.speed;
    if (S.t >= curDur()) { endItem(); return; }
    renderProgress(false);
  }, 1000);

  /* ------------------------------------------------------------------ mini player (a Dock row) */
  var MR = {};
  function buildMini() {
    MR.art = h('span', { class: 'mini-art' });
    MR.title = h('div', { class: 't-label clamp1' }); MR.show = h('div', { class: 't-caption clamp1' });
    MR.prog = h('span', { class: 'prog', 'aria-hidden': 'true' });
    MR.play = h('button', { class: 'playbtn s48', 'aria-pressed': 'false', onclick: function (e) { e.stopPropagation(); togglePlay(); } });
    MR.fwd = h('button', { class: 'skipbtn s44', 'aria-label': 'Forward 30 seconds', onclick: function (e) { e.stopPropagation(); seekTo(S.t + 30); haptic('light'); } }, icon('i-fwd30'));
    MR.hit = h('button', { class: 'open-hit', 'aria-label': 'Open player', onclick: function () { openNPFromMini(); } });
    var pressTimer = 0;
    MR.hit.addEventListener('pointerdown', function () { pressTimer = setTimeout(function () { pressTimer = -1; toggleCar(); }, 600); });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(function (ev) { MR.hit.addEventListener(ev, function () { if (pressTimer > 0) clearTimeout(pressTimer); }); });
    MR.hit.addEventListener('click', function (e) { if (pressTimer === -1) { pressTimer = 0; e.stopImmediatePropagation(); } }, true);
    /* drag up opens (finger-tracked threshold 96px) */
    var sy = null, moved = 0;
    MR.hit.addEventListener('pointerdown', function (e) { sy = e.clientY; moved = 0; });
    MR.hit.addEventListener('pointermove', function (e) { if (sy != null) moved = sy - e.clientY; });
    MR.hit.addEventListener('pointerup', function () { if (sy != null && moved > 96) { haptic('medium'); openNPFromMini(); } sy = null; });
    $mini.append(MR.hit, MR.prog, MR.art, h('div', { class: 'txt' }, MR.title, MR.show), h('div', { class: 'btn-wrap' }, MR.play, MR.fwd));
  }
  buildMini();
  function renderMini(flipFrom) {
    if (!S.cur) { $mini.hidden = true; $app.classList.remove('has-mini'); return; }
    var wasHidden = $mini.hidden;
    var a = S.cur.kind === 'foray' ? collage(FORAY_ARTS, 44, 'r-sm') : art(S.cur.ep.show, S.cur.ep.art, 44, 'r-sm');
    MR.art.replaceChildren(a); MR.art.firstChild.classList.add('mini-art-el');
    MR.title.textContent = curTitle();
    MR.show.textContent = S.cur.kind === 'foray' ? '4 shows, narrated' : S.cur.ep.show;
    $mini.setAttribute('aria-label', 'Now playing: ' + curTitle() + ', ' + (S.cur.kind === 'foray' ? '4 shows' : S.cur.ep.show));
    $mini.hidden = (S.name === 'foray' || S.name === 'onboarding');
    $app.classList.toggle('has-mini', !$mini.hidden);
    if ((wasHidden || flipFrom) && !$mini.hidden && !reduce) { $mini.classList.remove('enter'); void $mini.offsetWidth; $mini.classList.add('enter'); }
    if (flipFrom && flipFrom.getBoundingClientRect && !reduce) flipArt(flipFrom, MR.art.firstChild);
    renderProgress(true);
  }
  function flipArt(fromEl, toEl) {
    try {
      var f = fromEl.getBoundingClientRect(), t = toEl.getBoundingClientRect(); if (!f.width || !t.width) return;
      var clone = fromEl.cloneNode(true); clone.style.position = 'fixed'; clone.style.left = f.left + 'px'; clone.style.top = f.top + 'px';
      clone.style.width = f.width + 'px'; clone.style.height = f.height + 'px'; clone.style.zIndex = 80; clone.style.pointerEvents = 'none'; clone.style.margin = '0';
      clone.style.setProperty('--sz', f.width + 'px');
      document.body.append(clone); toEl.style.opacity = '0';
      var dx = t.left - f.left, dy = t.top - f.top, sc = t.width / f.width;
      var an = clone.animate([{ transform: 'none' }, { transform: 'translate(' + dx + 'px,' + dy + 'px) scale(' + sc + ')', transformOrigin: 'top left' }], { duration: 560, easing: 'cubic-bezier(0.2,0.9,0.2,1.05)', fill: 'forwards' });
      an.onfinish = an.oncancel = function () { clone.remove(); toEl.style.opacity = ''; };
    } catch (e) { toEl.style.opacity = ''; }
  }

  /* ------------------------------------------------------------------ progress rendering */
  var strips = [];              // live strips (NP, foray detail) updated by the ticker
  function setStripFill(el, t) {
    var idx = forayAt(t);
    var bars = el.querySelectorAll('.sb');
    for (var k = 0; k < bars.length; k++) {
      var i = +bars[k].getAttribute('data-i'), it = FT.items[i], f = clamp((t - it.start) / it.dur, 0, 1);
      bars[k].style.setProperty('--f', f.toFixed(3));
      bars[k].classList.toggle('cur', i === idx);
    }
  }
  var NPR = {};
  function renderProgress(force) {
    if (!S.cur) return;
    var d = curDur(), p = d ? S.t / d : 0;
    $mini.style.setProperty('--p', p.toFixed(4));
    strips = strips.filter(function (x) { return document.body.contains(x); });
    if (S.cur.kind === 'foray') {
      var idx = forayAt(S.t);
      if (idx !== lastIdx) { var first = lastIdx === -1; lastIdx = idx; onSegmentChange(idx, !first && !force); }
    }
    if (NPR.fill) {
      NPR.scrub && NPR.scrub.style.setProperty('--p', p.toFixed(4));
      if (NPR.scrub) NPR.scrub.setAttribute('aria-valuenow', Math.round(S.t));
      if (NPR.scrub && (force || Math.round(S.t) % 15 === 0)) NPR.scrub.setAttribute('aria-valuetext', fmtLong(S.t) + ' of ' + fmtLong(d));
      NPR.el.textContent = fmt(S.t); NPR.rem.textContent = '-' + fmt(d - S.t);
    }
    strips.forEach(function (s) { if (document.body.contains(s)) setStripFill(s, S.t); });
    if (force) syncForayButton();
  }
  /* the eyebrow slot above the title holds only this transient Lamp caption, 3s, then fades (never a permanent line) */
  function flashCap(text, persist) {
    if (!NPR.cap) return;
    NPR.cap.textContent = text; NPR.cap.classList.add('lit'); clearTimeout(NPR.capTimer);
    if (!persist) NPR.capTimer = setTimeout(function () { NPR.cap.classList.remove('lit'); }, 3000);
  }
  function onSegmentChange(idx, animate) {
    if (!S.cur || S.cur.kind !== 'foray') return;
    var it = FT.items[idx], isSeg = it.type === 'segment';
    var glow = glowAt(idx);
    $np.style.setProperty('--glow', glow);
    document.documentElement.style.setProperty('--glow', glow);
    setRoomArt(roomCssAt(idx));
    if (NPR.showline) {
      var set = function () { NPR.showName.textContent = isSeg ? it.show : '4a narration'; NPR.showName.style.opacity = '1'; };
      if (animate && !reduce) { NPR.showName.style.opacity = '0'; setTimeout(set, 280); } else set();
    }
    if (animate) flashCap(isSeg ? 'Now: ' + it.show : '4a narration');
    NPR.segRows && NPR.segRows.forEach(function (r, i) { r.classList.toggle('is-playing', i === idx); var pl = r.querySelector('.state-playing'); if (pl) pl.hidden = (i !== idx); });
    if (animate) haptic('light');
  }
  /* two stacked layers: the new art fades in over the old (560ms --m-room) */
  function setRoomArt(css) {
    if (!NPR.layers) return;
    var next = NPR.layers[NPR.layerOn === 0 ? 1 : 0], cur = NPR.layers[NPR.layerOn || 0];
    if (next.style.getPropertyValue('--art') === css && cur.classList.contains('on')) return;
    next.style.setProperty('--art', css); next.classList.add('on'); cur.classList.remove('on'); NPR.layerOn = NPR.layerOn === 0 ? 1 : 0;
  }
  function syncPlayUI() {
    var playing = S.playing && S.cur;
    // mini
    MR.play.replaceChildren(icon(playing ? 'i-pause' : 'i-play')); MR.play.setAttribute('aria-pressed', playing ? 'true' : 'false'); MR.play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    // np
    if (NPR.play) { NPR.play.replaceChildren(icon(playing ? 'i-pause' : 'i-play')); NPR.play.setAttribute('aria-pressed', playing ? 'true' : 'false'); NPR.play.setAttribute('aria-label', playing ? 'Pause' : 'Play'); }
    $np.classList.toggle('paused', !playing);
    // rows and hero buttons
    var key = S.cur && S.cur.kind === 'ep' ? S.cur.ep.id : null;
    document.querySelectorAll('[data-ep]').forEach(function (r) {
      var on = r.getAttribute('data-ep') === key;
      if (r.classList.contains('row') || r.classList.contains('stretch')) { r.classList.toggle('is-playing', on); var pl = r.querySelector('.state-playing'); if (pl) pl.hidden = !on; }
      var pb = r.querySelector('.playbtn'); if (pb) { pb.replaceChildren(icon(on && playing ? 'i-pause' : 'i-play')); pb.setAttribute('aria-label', (on && playing ? 'Pause ' : 'Play ') + (EPBY[r.getAttribute('data-ep')] || {}).title); }
    });
    var hb = document.querySelector('[data-foray-play]');
    if (hb) { var fon = S.cur && S.cur.kind === 'foray' && playing; hb.replaceChildren(icon(fon ? 'i-pause' : 'i-play')); hb.setAttribute('aria-label', fon ? 'Pause today’s foray' : 'Play today’s foray'); }
    syncForayButton();
    // queue rows in library
    document.querySelectorAll('[data-qep]').forEach(function (r) { var on = r.getAttribute('data-qep') === key; r.classList.toggle('is-playing', on); var pl = r.querySelector('.state-playing'); if (pl) pl.hidden = !on; });
  }
  function syncForayButton() {
    var b = document.querySelector('[data-foray-cta]'); if (!b) return;
    var t = S.cur && S.cur.kind === 'foray' ? S.t : (S.prog['foray'] || 0);
    b.replaceChildren(S.cur && S.cur.kind === 'foray' && S.playing ? 'Now playing' : (t >= FT.total - 1 ? 'Play again' : t > 5 ? 'Resume · ' + Math.max(1, Math.round((FT.total - t) / 60)) + ' min left' : 'Play'));
  }

  /* ------------------------------------------------------------------ strip component */
  function strip(size, o) {
    o = o || {};
    var W = ($app.clientWidth || 393) - 2 * (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--gutter')) || 20) - (o.inset || 0);
    var gaps = (FT.items.length - 1) * 2;
    var el = h('div', { class: 'strip ' + size + (o.draw ? ' draw' : '') + (o.thumbs ? ' thumbed' : ''), role: 'group', 'aria-label': 'Foray strip: ' + FT.shows.length + ' shows' });
    FT.items.forEach(function (it, i) {
      var narr = it.type !== 'segment', px = (W - gaps) * it.dur / FT.total;
      if (narr && o.narr === false) return;
      var b = h('button', {
        'data-i': i, class: 'sb' + (narr ? ' narr' : ''), css: { '--w': it.dur, '--c': narr ? 'var(--lamp)' : segColor(it.show), '--i': i },
        'aria-label': 'Seek to ' + (narr ? 'narration' : it.show) + ', ' + fmt(it.start),
        onclick: function (e) { var r = b.getBoundingClientRect(); var fr = clamp((e.clientX - r.left) / r.width, 0, 1); seekTo(it.start + fr * it.dur); haptic('light'); }
      }, h('span', { class: 'bar' }, h('span', { class: 'fill' })));
      /* thumbnails: Foray detail only, their own row under the bars, only under bars 28px or wider */
      if (o.thumbs && !narr && px >= 28) b.append(h('span', { class: 'thumbs' }, art(it.show, it.art, 20, 'r-xs')));
      el.append(b);
    });
    strips.push(el); setStripFill(el, o.t != null ? o.t : (S.cur && S.cur.kind === 'foray' ? S.t : (S.prog['foray'] || 0)));
    return el;
  }
  function condense(bars, total) {
    if (bars.length <= 14) return bars;
    var n = 9, out = [], per = total / n, i = 0;
    for (var k = 0; k < n; k++) {
      var tally = {}, got = 0;
      while (i < bars.length && (got < per || k === n - 1)) { var b = bars[i]; if (b.s) tally[b.s] = (tally[b.s] || 0) + b.d; got += b.d; i++; }
      var best = null; for (var s2 in tally) if (!best || tally[s2] > tally[best]) best = s2;
      out.push({ s: best, d: got });
      if (k % 3 === 1 && k < n - 1) out.push({ s: null, d: Math.round(per * 0.08) });
    }
    return out;
  }
  function miniStrip(bars, total, doneFrac) {
    bars = condense(bars, total);
    total = bars.reduce(function (a, b) { return a + b.d; }, 0);
    var el = h('span', { class: 'mini-strip', 'aria-hidden': 'true' }), acc = 0;
    bars.forEach(function (b) {
      var done = acc / total < doneFrac; acc += b.d;
      el.append(h('i', { class: (b.s ? '' : 'n ') + (done ? 'f' : ''), css: { '--w': b.d, '--c': b.s ? segColor2(b.s) : 'var(--lamp)' } }));
    });
    return el;
  }
  function segColor2(show) { var hh = hcOf(show)[0]; return isDawn() ? 'oklch(0.52 0.13 ' + hh + ')' : 'oklch(0.70 0.13 ' + hh + ')'; }

  /* ------------------------------------------------------------------ list components */
  /* EpisodeRow: why-line clamps at 2 lines (the product's main copy); row min-height 96 (critique item 13) */
  function epRow(e, o) {
    o = o || {};
    var started = S.prog[e.id] ? S.prog[e.id] / (e.dur * 60) : 0;
    var aEl = art(e.show, e.art, 72, 'r-md', { progress: started || 0, dim: o.unavailable });
    var row = h('div', { class: 'row raised ep-row' + (o.unavailable ? ' unavailable' : '') + (o.noWhy ? ' nowhy' : ''), 'data-ep': e.id, onclick: function () { if (!o.unavailable) playEp(e, aEl); } },
      aEl,
      h('div', { class: 'main' },
        h('h3', { class: 't-headline clamp2' }, e.title),
        h('div', { class: 't-caption meta' },
          h('span', { class: 'state-playing', hidden: true }, icon('i-play-fill', 's16'), 'Playing'),
          o.unavailable && icon('i-wifi-slash', 's16 warn'),
          o.played && icon('i-check-circle-fill', 's16'),
          o.downloaded && icon('i-download-fill', 's16 ok'),
          h('span', { class: 'ell' }, e.show), h('span', { class: 'sep' }), h('span', { class: 'dur nos' }, e.dur + ' min'), h('span', { class: 'sep' }), h('span', { class: 'nos' }, dshort(e.date))),
        !o.noWhy && h('p', { class: 't-why clamp2 why' }, e.hook)),
      h('div', { class: 'trail' }, h('button', { class: 'playbtn ol', 'aria-label': 'Play ' + e.title, 'aria-disabled': o.unavailable ? 'true' : null, onclick: function (ev) { ev.stopPropagation(); if (!o.unavailable) playEp(e, aEl); } }, icon('i-play'))));
    longPress(row, function () { rowMenu(e, aEl); });
    return row;
  }
  function addToUpNext(e, fromEl) {
    S.upnext.push({ ep: e, reason: '' }); upCount++; haptic('light');
    $libBadge.textContent = String(upCount); $libBadge.hidden = false; $libBadge.classList.add('pop'); setTimeout(function () { $libBadge.classList.remove('pop'); }, 420);
    var target = $tabbar.querySelector('[data-tab="library"] .toggle-icon');
    if (fromEl && target && !reduce) flyArt(fromEl, target);
    toast('Added to Up Next', 'Undo', function () { S.upnext = S.upnext.filter(function (u) { return u.ep.id !== e.id; }); upCount = Math.max(0, upCount - 1); $libBadge.textContent = String(upCount); $libBadge.hidden = !upCount; });
    var lib = $screenHost.querySelector('.library'); if (lib && lib._renderUp) lib._renderUp();
  }
  function flyArt(fromEl, toEl) {
    try {
      var f = fromEl.getBoundingClientRect(), t = toEl.getBoundingClientRect(); if (!f.width) return;
      var clone = fromEl.cloneNode(true); clone.style.cssText = 'position:fixed;left:' + f.left + 'px;top:' + f.top + 'px;width:' + f.width + 'px;height:' + f.height + 'px;z-index:80;pointer-events:none;margin:0';
      document.body.append(clone);
      var an = clone.animate([{ transform: 'none', opacity: 1 }, { transform: 'translate(' + (t.left + t.width / 2 - f.left - f.width / 2) + 'px,' + (t.top + t.height / 2 - f.top - f.height / 2) + 'px) scale(0.2)', opacity: 0.4 }], { duration: 420, easing: 'cubic-bezier(0.2,0.9,0.2,1.05)', fill: 'forwards' });
      an.onfinish = an.oncancel = function () { clone.remove(); };
    } catch (err) { /* decoration only */ }
  }
  function rowMenu(e, aEl) {
    menu(e.title, [
      { icon: 'i-queue', label: 'Add to Up Next', run: function () { addToUpNext(e, aEl); } },
      { icon: S.saved[e.id] ? 'i-bookmark-fill' : 'i-bookmark', label: S.saved[e.id] ? 'Remove from Saved' : 'Save', run: function () { S.saved[e.id] = !S.saved[e.id]; haptic('light'); toast(S.saved[e.id] ? 'Saved' : 'Removed from Saved'); } },
      { icon: 'i-share', label: 'Share', run: function () { toast('Link copied'); } }
    ]);
  }
  function longPress(el, fn) {
    var tm = 0, fired = false;
    el.addEventListener('pointerdown', function () { fired = false; clearTimeout(tm); tm = setTimeout(function () { fired = true; fn(); }, 600); });
    ['pointerup', 'pointerleave', 'pointercancel', 'pointermove'].forEach(function (n) { el.addEventListener(n, function () { clearTimeout(tm); }); });
    el.addEventListener('click', function (ev) { if (fired) { fired = false; ev.stopImmediatePropagation(); ev.preventDefault(); } }, true);
    el.addEventListener('contextmenu', function (ev) { ev.preventDefault(); fn(); });
  }
  /* StretchCard: pill, two arts joined by a lit line, the bridge, then the EpisodeRow anatomy minus the art.
     Round 1 shipped it broken: the outlined Play carried the class "row" and stretched full width. */
  function stretchCard(o) {
    o = o || {};
    var st = STRETCH, e = st.pick, a1 = art(st.familiar.show, st.familiar.art, 56, 'r-sm', { dim: o.unavailable }), a2 = art(e.show, e.art, 56, 'r-sm', { dim: o.unavailable });
    return h('div', { class: 'stretch raised' + (o.unavailable ? ' unavailable' : ''), 'data-ep': e.id },
      h('span', { class: 'pill' }, icon('i-sparkle', 's16'), 'Stretch'),
      h('div', { class: 'bridge-line' }, a1, h('span', { class: 'line' }), a2),
      h('p', { class: 't-why bridge' }, st.bridge),
      h('div', { class: 'ep' },
        h('div', { class: 'main' },
          h('h3', { class: 't-headline clamp2' }, e.title),
          h('div', { class: 't-caption ep-sub' }, h('span', { class: 'state-playing', hidden: true }, icon('i-play-fill', 's16'), 'Playing · '), o.unavailable && icon('i-wifi-slash', 's16 warn'), o.unavailable ? ' ' : null, e.show + ' · ' + e.dur + ' min · ' + dshort(e.date))),
        h('button', { class: 'playbtn ol', 'aria-label': 'Play ' + e.title, 'aria-disabled': o.unavailable ? 'true' : null, onclick: function () { if (!o.unavailable) playEp(e, a2); } }, icon('i-play'))));
  }
  function qRow(o) {
    // o: {ep, reason, why (the item's why-line, Fraunces italic, 2 lines), auto (show the 4a added eyebrow), current, menu, date}
    var e = o.ep;
    var r = h('div', { class: 'row raised q-row' + (o.current ? ' is-playing' : ''), 'data-qep': e.id },
      art(e.show, e.art, 56, 'r-sm'),
      h('div', { class: 'main' },
        (o.reason || o.auto) && h('span', { class: 't-caption auto' }, '4a added'),
        h('div', { class: 't-label clamp2' }, o.current && icon('i-play-fill', 's16'), o.current ? ' ' : null, e.title),
        h('div', { class: 't-caption c2' }, o.current ? 'Playing' : (o.date ? dshort(e.date) + ' · ' : ''), o.current ? ' · ' : '', e.show, ' · ', e.dur + ' min'),
        o.why ? h('div', { class: 't-why clamp2 qwhy' }, o.why) : o.reason && h('div', { class: 't-caption c2 clamp2' }, o.reason.replace(/^4a added: /, ''))),
      o.menu && h('button', { class: 'icon-btn', 'aria-label': 'More for ' + e.title, onclick: function () { o.menu(e); } }, icon('i-dots')));
    return r;
  }
  /* ShowTile: art 104-ish --r-md in a 3-up grid, name 2 lines, never cut mid-word */
  function showTile(name, o) {
    o = o || {};
    return h('button', { class: 'stile', onclick: function () { var e = epByShow(name); if (e) toast(name + ': ' + (o.count || 12) + ' episodes'); } },
      art(name, ARTBY[name], o.sz || 104, 'r-md', { badge: o.badge }), h('span', { class: 't-caption name clamp2' }, name));
  }
  /* ForayTile: collage with its strip along the bottom edge inside the radius and a 16px Lamp "Foray" pill, same cell as a ShowTile */
  function forayTile(title, shows, bars, doneFrac, onclick) {
    var total = bars.reduce(function (a, b) { return a + b.d; }, 0);
    return h('button', { class: 'ftile', onclick: onclick, 'aria-label': 'Foray: ' + title },
      h('span', { class: 'tile-art lit-art lit-40', css: { '--art-glow': glowOf(shows[0].show) } }, collage(shows, 104, 'r-md', { nolit: true }), h('span', { class: 'pill sm' }, 'Foray'), miniStrip(bars, total, doneFrac), doneFrac >= 0.99 ? icon('i-check-circle-fill', 'done') : null),
      h('span', { class: 't-caption name clamp2' }, title));
  }
  /* SubjectTile: a 56 2x2 collage of the subject's first four shows (three overlapping arts read as a glitch) */
  function subjectTile(sub) {
    var list = sub.arts.map(function (u) { return { show: sub.name, art: u }; });
    return h('button', { class: 'subj raised', onclick: function () { toast(sub.name + ': ' + sub.shows + ' shows'); } }, collage(list, 56, 'r-sm'), h('span', { class: 'txt' }, h('span', { class: 't-label clamp2' }, sub.name), h('span', { class: 't-caption count' }, sub.shows + ' shows')));
  }
  function playlistTile(p, rowLike) {
    var arts = p.eps.slice(0, 4).map(function (e) { return { show: e.show, art: e.art }; });
    var meta = p.eps.length + ' episodes, ' + fmtLong(p.mins * 60);
    if (rowLike) return h('button', { class: 'row raised q-row', onclick: function () { toast(p.name + ' queued'); } }, collage(arts, 56, 'r-sm'), h('div', { class: 'main' }, h('div', { class: 't-label' }, p.name), h('div', { class: 't-caption c2' }, meta), p.played ? h('div', { class: 't-caption', css: { color: 'var(--ember)' } }, p.played + ' of ' + p.eps.length + ' played') : null));
    return h('button', { class: 'ptile raised', onclick: function () { toast(p.name + ' queued'); } }, collage(arts, 120, 'r-md'), h('span', { class: 't-headline clamp2' }, p.name), h('span', { class: 't-caption ep-count' }, meta), p.played ? h('span', { class: 't-caption prog' }, p.played + ' of ' + p.eps.length + ' played') : null);
  }
  /* a count appears only when there is something to count (round 1 showed seed counts beside empty sections) */
  function sectionHead(title, count, explainer) {
    return [h('div', { class: 'section-head' }, h('h2', { class: 't-headline' }, title), count ? h('span', { class: 't-caption count' }, count) : null), explainer && h('p', { class: 't-body explainer' }, explainer)];
  }
  function empty(line, label, to) { return h('div', { class: 'empty empty-sec' }, h('p', { class: 't-body' }, line), h('button', { class: 'btn btn-secondary', onclick: function () { go(to); } }, label)); }

  /* ------------------------------------------------------------------ screens */
  function dayLine() { var d = new Date(); return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getDay()] + ', ' + d.getDate() + ' ' + ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][d.getMonth()]; }
  function settingsBtn() { return h('button', { class: 'icon-btn', 'aria-label': 'Settings, Tuning and About', onclick: openSettings }, icon('i-gear')); }

  function buildToday() {
    var st = S.stateParam, first = st === 'firstrun', offline = st === 'offline', loading = st === 'loading';
    var scr = h('main', { class: 'screen today', 'aria-label': 'Today' });
    /* the wash is lit by the hero (its first show), not by whatever is playing; loading keeps the default Glow */
    var wash = h('div', { class: 'wash' });
    if (!loading) wash.style.setProperty('--glow', glowOf(first ? FIRST_PICK.show : FT.shows[0]));
    scr.append(wash,
      h('header', { class: 'screen-head' }, h('span', { class: 'wordmark' }, '4a'), settingsBtn()),
      h('p', { class: 't-caption greet' }, dayLine()));
    if (offline) scr.append(h('div', { class: 'banner raised t-label' }, icon('i-wifi-slash', 's20'), h('span', null, 'Offline. Downloaded items play.')));
    if (loading) {
      scr.append(h('div', { class: 'hero' }, h('div', { class: 'skel', css: { width: 'var(--hero-art)', height: 'var(--hero-art)' } }), h('div', { class: 'stack-8' }, h('div', { class: 'skel', css: { height: '18px', width: '60%' } }), h('div', { class: 'skel', css: { height: '90px' } }), h('div', { class: 'skel', css: { height: '56px', width: '56px', 'border-radius': '50%' } }))));
      var l = h('div', { class: 'section stack-8' }); for (var i = 0; i < 4; i++) l.append(h('div', { class: 'skel', css: { height: '128px' } })); scr.append(l);
      return scr;
    }
    /* hero */
    var hero;
    if (first) {
      var fp = FIRST_PICK, a0 = art(fp.show, fp.art, 160, 'r-lg');
      hero = h('section', { class: 'hero', 'aria-label': 'First pick' }, h('div', { class: 'hero-art' }, a0),
        h('div', { class: 'copy' }, h('span', { class: 'eyebrow lamp' }, 'Today’s picks'), h('h1', { class: 't-title clamp4' }, fp.title), h('p', { class: 't-caption' }, fp.show + ' · ' + fp.dur + ' min'), h('div', { class: 'actions' }, h('button', { class: 'playbtn', 'aria-label': 'Play ' + fp.title, onclick: function () { playEp(fp, a0); } }, icon('i-play')))),
        h('p', { class: 't-why why-wide clamp2' }, fp.hook));
      hero.append(h('p', { class: 't-body c2 why-wide' }, '4a found today’s picks. No account, no setup.'));
    } else {
      var col = collage(FORAY_ARTS, 160, 'r-lg');
      var pb = h('button', { class: 'playbtn', 'data-foray-play': '', 'aria-label': 'Play today’s foray', onclick: function () { playForay(col); } }, icon('i-play'));
      hero = h('section', { class: 'hero', 'aria-label': 'Today’s foray' },
        h('button', { class: 'hero-art', 'aria-label': 'Open today’s foray', onclick: function () { go('#/foray'); } }, col),
        h('div', { class: 'copy' },
          h('span', { class: 'eyebrow lamp' }, 'Today’s foray'),
          h('h1', { class: 't-title clamp4' }, h('button', { class: 'title-btn', onclick: function () { go('#/foray'); } }, FORAY.title)),
          h('div', { class: 'actions' }, pb, h('span', { class: 't-caption num' }, FT.shows.length + ' shows · ' + Math.round(FT.total / 60) + ' min'))),
        h('p', { class: 't-why why-wide clamp2' }, FORAY.why));
    }
    scr.append(hero);
    /* keep listening */
    if (!first) scr.append(h('section', { class: 'section', 'aria-label': 'Keep listening' }, sectionHead('Keep listening'), epRow(KEEP, { downloaded: offline })));
    /* picks: when the hero is the first pick, the list starts at the second pick and the count drops by one (critique item 7) */
    var ids = PICK_IDS.filter(function (id) { return !(first && id === FIRST_PICK.id); });
    var picks = h('div', { class: 'stack-8' });
    ids.forEach(function (id) {
      if (id === 'STRETCH') picks.append(stretchCard({ unavailable: offline }));
      else picks.append(epRow(EPBY[id], { unavailable: offline && !OFFLINE_OK[id], downloaded: offline && !!OFFLINE_OK[id] }));
    });
    scr.append(h('section', { class: 'section', 'aria-label': 'Today’s picks' }, sectionHead('Today’s picks', ids.length), picks));
    /* playlists */
    var rail = h('div', { class: 'rail' }); PLAYLISTS.forEach(function (p) { rail.append(playlistTile(p)); });
    scr.append(h('section', { class: 'section', 'aria-label': 'Playlists for you' }, sectionHead('Playlists for you'), rail));
    /* off your path */
    var off = h('div', { class: 'stack-8' }); OFFPATH.forEach(function (e) { off.append(epRow(e, { unavailable: offline })); });
    scr.append(h('section', { class: 'section', 'aria-label': 'Off your path' }, sectionHead('Off your path', null, 'About a third of each day sits outside your usual subjects. This is today’s third.'), off));
    return scr;
  }

  function buildDiscover() {
    var scr = h('main', { class: 'screen discover', 'aria-label': 'Discover' });
    scr.append(h('h1', { class: 't-title', css: { 'margin-top': '8px', 'min-height': '44px', display: 'flex', 'align-items': 'center' } }, 'Discover'));
    var body = h('div', { class: 'disc-body' }); scr.append(body);
    function renderBody() {
      var q = S.q.trim().toLowerCase();
      body.replaceChildren();
      if (!q) {
        /* idle = the five subject groups, SubjectTiles 2-up; followed shows live in Library only */
        var groups = []; D.subjects.forEach(function (s) { if (groups.indexOf(s.group) < 0) groups.push(s.group); });
        groups.forEach(function (g, gi) {
          var grid = h('div', { class: 'grid-2' }); D.subjects.filter(function (s) { return s.group === g; }).forEach(function (s) { grid.append(subjectTile(s)); });
          body.append(h('section', { class: 'section', css: gi === 0 ? { 'margin-top': '16px' } : null }, sectionHead(g), grid));
        });
        return;
      }
      var shows = [], seen = {};
      EP.forEach(function (e) { if (e.show.toLowerCase().indexOf(q) >= 0 && !seen[e.show]) { seen[e.show] = 1; shows.push(e); } });
      var eps = EP.filter(function (e) { return e.title.toLowerCase().indexOf(q) >= 0 || e.hook.toLowerCase().indexOf(q) >= 0; }).slice(0, 5);
      var pls = PLAYLISTS.filter(function (p) { return p.name.toLowerCase().indexOf(q) >= 0; });
      var subs = D.subjects.filter(function (s) { return s.name.toLowerCase().indexOf(q) >= 0 || s.group.toLowerCase().indexOf(q) >= 0; });
      if (!shows.length && !eps.length && !pls.length) {
        var box = h('div', { class: 'empty' }, h('p', { class: 't-body' }, 'Nothing named ‘' + S.q.trim() + '’.'));
        if (subs.length) { box.append(h('p', { class: 't-body' }, '‘' + subs[0].name + '’ is a subject, ' + subs[0].shows + ' shows.'), h('div', { css: { width: '100%' } }, subjectTile(subs[0]))); }
        body.append(box);
      } else {
        if (shows.length) { var sl = h('div', { class: 'stack-8' }); shows.slice(0, 4).forEach(function (e) { sl.append(h('div', { class: 'row raised q-row' }, art(e.show, e.art, 56, 'r-sm', { badge: !!S.followed[e.show] }), h('div', { class: 'main' }, h('div', { class: 't-label' }, e.show), h('div', { class: 't-caption c2' }, (S.followed[e.show] ? 'Following · ' : '') + '12 episodes')))); }); body.append(h('section', { class: 'section', css: { 'margin-top': '16px' } }, sectionHead('Shows'), sl)); }
        if (eps.length) { var el = h('div', { class: 'stack-8' }); eps.forEach(function (e) { el.append(epRow(e, { noWhy: true })); }); body.append(h('section', { class: 'section' }, sectionHead('Episodes'), el)); }
        if (pls.length) { var pl = h('div', { class: 'stack-8' }); pls.forEach(function (p) { pl.append(playlistTile(p, true)); }); body.append(h('section', { class: 'section' }, sectionHead('Playlists'), pl)); }
      }
      /* the Create function: at the bottom of results (round 1 had it only under "no result") */
      if (q.length >= 3) body.append(h('div', { class: 'make-chip' }, h('button', { class: 'btn btn-primary block', onclick: function () { toast('Making a playlist from ‘' + S.q.trim() + '’'); } }, icon('i-sparkle', 's20'), 'Make a playlist from ‘' + S.q.trim() + '’')));
      syncPlayUI();
    }
    renderBody();
    var input = h('input', { type: 'text', placeholder: 'Search, or name a subject', 'aria-label': 'Search, or name a subject', value: S.q, autocomplete: 'off', enterkeyhint: 'search' });
    var clear = h('button', { class: 'icon-btn' + (S.q ? '' : ' hidden'), 'aria-label': 'Clear search', onclick: function () { S.q = ''; input.value = ''; clear.classList.add('hidden'); renderBody(); input.focus(); } }, icon('i-x', 's20'));
    var t;
    input.addEventListener('input', function () { S.q = input.value; clear.classList.toggle('hidden', !S.q); clearTimeout(t); t = setTimeout(renderBody, 150); });
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === 'Escape') input.blur(); });
    input.addEventListener('focus', function () { $app.classList.add('kb'); });
    input.addEventListener('blur', function () { setTimeout(function () { $app.classList.remove('kb'); }, 120); });
    scr._field = h('div', { class: 'field' }, icon('i-magnifier', 's20'), input, clear);
    scr._input = input;
    return scr;
  }

  function buildLibrary() {
    var scr = h('main', { class: 'screen library', 'aria-label': 'Library' });
    scr.append(h('h1', { class: 't-title', css: { 'margin-top': '8px', 'min-height': '44px', display: 'flex', 'align-items': 'center' } }, 'Library'));
    var empty1 = S.stateParam === 'empty';
    /* grid: forays first as compact tiles, then followed shows, 3-up, every cell the same height */
    if (!empty1) {
      var g = h('div', { class: 'grid-3', css: { 'margin-top': '12px' } });
      var fbars = FT.items.map(function (i) { return { s: i.type === 'segment' ? i.show : null, d: i.dur }; });
      g.append(forayTile(FORAY.title, FORAY_ARTS, fbars, (S.prog['foray'] || 0) / FT.total, function () { go('#/foray'); }));
      (D.forays_lite || []).forEach(function (f) {
        g.append(forayTile(f.title, f.shows.map(function (s) { return { show: s.show, art: s.art }; }), f.bars, 0, function () { toast(f.title); }));
      });
      FOLLOW_SHOWS.slice(0, 5).forEach(function (n) { g.append(showTile(n, { sz: 104 })); });   /* every show here is followed, so no badge (round 3 item 10) */
      scr.append(g, h('div', null, h('button', { class: 'btn btn-quiet', onclick: function () { toast('Everything you have: 9 forays and shows'); } }, 'All')));
    } else scr.append(h('div', { css: { 'margin-top': '12px' } }, empty('Nothing followed yet.', 'Find shows', '#/search')));
    /* saved */
    var savedEps = EP.filter(function (e) { return S.saved[e.id]; });
    var sv = h('div', { class: 'stack-8' }); savedEps.slice(0, 5).forEach(function (e) { sv.append(epRow(e, { noWhy: true })); });
    scr.append(h('section', { class: 'section' }, sectionHead('Saved', empty1 ? 0 : savedEps.length), empty1 ? empty('Nothing saved yet.', 'See today’s picks', '#/home') : sv, !empty1 && h('button', { class: 'btn btn-quiet', onclick: function () { toast('All saved: ' + savedEps.length); } }, 'All saved')));
    var pls = h('div', { class: 'stack-8' }); PLAYLISTS.slice(0, 3).forEach(function (p) { pls.append(playlistTile(p, true)); });
    scr.append(h('section', { class: 'section' }, sectionHead('Playlists', empty1 ? 0 : PLAYLISTS.length), empty1 ? empty('No playlists yet.', 'Find shows', '#/search') : pls));
    /* up next */
    var un = h('div', { class: 'stack-8', id: 'upnext' });
    function renderUpNext() {
      un.replaceChildren();
      if (S.cur && S.cur.kind === 'ep') un.append(qRow({ ep: S.cur.ep, current: true }));
      else if (S.cur) un.append(h('div', { class: 'row raised q-row is-playing', 'data-qep': 'foray' }, collage(FORAY_ARTS, 56, 'r-sm'), h('div', { class: 'main' }, h('div', { class: 't-label clamp2' }, icon('i-play-fill', 's16'), ' ', FORAY.title), h('div', { class: 't-caption c2' }, 'Playing · foray'))));
      S.upnext.forEach(function (u, i) { un.append(qRow({ ep: u.ep, reason: u.reason, menu: function (e) { queueMenu(i, e, renderUpNext); } })); });
      var cnt = scr.querySelector('.up-count'); if (cnt) cnt.textContent = S.upnext.length + (S.cur ? 1 : 0);
    }
    renderUpNext();
    scr._renderUp = renderUpNext;
    var uh = sectionHead('Up Next', empty1 ? 0 : S.upnext.length + (S.cur ? 1 : 0)); var ucount = uh[0].querySelector('.count'); if (ucount) ucount.classList.add('up-count');
    scr.append(h('section', { class: 'section', 'aria-label': 'Up Next' }, uh, empty1 ? empty('Nothing queued.', 'See today’s picks', '#/home') : un));
    var hs = h('div', { class: 'stack-8' }); S.history.slice(0, 3).forEach(function (e) { hs.append(qRow({ ep: e, date: true })); });
    scr.append(h('section', { class: 'section' }, sectionHead('History'), empty1 ? empty('Nothing played yet.', 'See today’s picks', '#/home') : hs));
    return scr;
  }
  function queueMenu(i, e, rerender) {
    var u = S.upnext[i];
    menu(e.title, [
      { icon: 'i-arrow-up', label: 'Move up', run: function () { if (i > 0) { var t = S.upnext[i - 1]; S.upnext[i - 1] = u; S.upnext[i] = t; rerender(); } } },
      { icon: 'i-arrow-down', label: 'Move down', run: function () { if (i < S.upnext.length - 1) { var t = S.upnext[i + 1]; S.upnext[i + 1] = u; S.upnext[i] = t; rerender(); } } },
      { icon: 'i-queue', label: 'Play next', run: function () { S.upnext.splice(i, 1); S.upnext.unshift(u); rerender(); toast('Playing next'); } },
      { icon: 'i-x', label: 'Remove', run: function () { S.upnext.splice(i, 1); rerender(); toast('Removed from Up Next', 'Undo', function () { S.upnext.splice(i, 0, u); rerender(); }); } }
    ]);
  }

  /* Foray detail */
  function buildForayDetail() {
    var unavailable = S.stateParam === 'unavailable', unnarrated = S.stateParam === 'unnarrated';
    var scr = h('main', { class: 'screen foray-room room-scope' + (unavailable ? ' dim-room' : ''), 'aria-label': 'Foray: ' + FORAY.title, css: { padding: '0', '--glow': glowOf(FT.shows[0]) } });
    var bg = h('div', { class: 'room-bg' }, h('div', { class: 'layer on', css: { '--art': roomArt(FT.shows[0]) } }), h('div', { class: 'layer' }));
    var done = (S.prog['foray'] || 0), isCur = S.cur && S.cur.kind === 'foray', t = isCur ? S.t : done;
    var cta = h('button', { class: 'btn btn-primary block', 'data-foray-cta': '', onclick: function () { if (unavailable) { go('#/search'); return; } if (S.cur && S.cur.kind === 'foray') { openNPFromMini(); } else { playForay(); } } });
    var inner = h('div', { class: 'np-scroll' });
    var c = collage(FORAY_ARTS, 160, 'r-lg', { dim: unavailable });
    var cwrap = h('div', { class: 'foray-collage' }, c, unavailable ? icon('i-wifi-slash', 'badge-slash') : null);
    var body = h('div', { class: 'foray-body' }, cwrap,
      h('p', { class: 'eyebrow lamp' }, 'Foray · ' + FORAY.subject),
      h('h1', { class: 't-title clamp3' }, FORAY.title),
      h('p', { class: 't-caption cap num' }, FT.shows.length + ' shows · ' + Math.round(FT.total / 60) + ' min · ' + (unnarrated ? 'not narrated yet' : 'narrated')),
      h('div', { class: 'strip-wrap' }, strip('s48', { thumbs: true, draw: true, narr: !unnarrated, t: t, inset: 24 })),
      unavailable ? h('p', { class: 't-body c2', css: { 'margin-top': '16px' } }, 'This foray can’t play right now. Its shows are below.') : null,
      unavailable ? h('button', { class: 'btn btn-primary block', onclick: function () { go('#/search'); } }, 'Find similar') : cta,
      h('section', { class: 'whymade' }, h('h2', { class: 't-headline' }, 'Why 4a made this'), h('p', { class: 't-why' }, FORAY.why)));
    var came = h('div', { class: 'grid-3', css: { 'margin-top': '12px' } });
    FT.shows.forEach(function (s) { came.append(h('div', { class: 'stile' }, art(s, ARTBY[s], 104, 'r-md', { badge: !!S.followed[s] }), h('span', { class: 't-caption name clamp2' }, s), h('button', { class: 'follow t-label', 'aria-pressed': S.followed[s] ? 'true' : 'false', onclick: function (e) { var b = e.currentTarget; S.followed[s] = !S.followed[s]; b.setAttribute('aria-pressed', S.followed[s] ? 'true' : 'false'); b.replaceChildren(toggleIcon('i-plus', 'i-check-circle-fill', S.followed[s]), S.followed[s] ? 'Following' : 'Follow'); haptic('light'); } }, toggleIcon('i-plus', 'i-check-circle-fill', !!S.followed[s]), S.followed[s] ? 'Following' : 'Follow'))); });
    body.append(h('section', { class: 'came' }, h('h2', { class: 't-headline' }, 'Where this came from'), came));
    var seg = h('div', { class: 'seglist' }, h('h2', { class: 't-headline' }, 'Segments'));
    FT.items.forEach(function (it) { if (unnarrated && it.type !== 'segment') return; seg.append(segRow(it)); });
    body.append(seg);
    inner.append(h('div', { class: 'foray-top' }, h('button', { class: 'icon-btn', 'aria-label': 'Back', onclick: function () { go(S.prev && !/foray|now-playing|onboarding/.test(S.prev) ? S.prev : '#/home'); } }, icon('i-chevron-left')), h('button', { class: 'icon-btn', 'aria-label': 'Share this foray', onclick: function () { toast('Link to this foray copied'); } }, icon('i-share'))), body);
    scr.append(bg, inner); scr._cta = cta;
    return scr;
  }
  function segRow(it) {
    if (it.type !== 'segment') return h('div', { class: 'row q-row narr', onclick: function () { if (S.cur && S.cur.kind === 'foray') seekTo(it.start); } }, h('span', { class: 'nbar' }), h('div', { class: 'main' }, h('div', { class: 't-label lampc' }, 'Narration'), h('div', { class: 't-caption c2' }, it.script)), h('span', { class: 't-caption c3 num' }, fmt(it.dur)));
    return h('button', { class: 'row raised q-row', 'aria-label': 'Play ' + it.show + ' at ' + fmt(it.start), onclick: function () { if (!S.cur || S.cur.kind !== 'foray') playForay(); seekTo(it.start); } },
      art(it.show, it.art, 56, 'r-sm'),
      h('div', { class: 'main' }, h('span', { class: 'state-playing t-caption', hidden: true }, icon('i-play-fill', 's16'), 'Playing'), h('div', { class: 't-label' }, it.show), h('div', { class: 't-caption c2 clamp2' }, it.why), h('div', { class: 't-caption c3 num' }, 'Clip ' + fmt(it.src_start) + ' to ' + fmt(it.src_start + it.dur))));
  }

  /* Onboarding */
  var onbTimer = 0;
  function buildOnboarding() {
    var arts4 = FT.shows.map(function (s) { return s; });
    var scr = h('main', { class: 'screen onb room-scope', 'aria-label': 'Welcome', css: { padding: '0' } });
    var bg = h('div', { class: 'room-bg' }, h('div', { class: 'layer on', css: { '--art': roomArt(arts4[0]) } }), h('div', { class: 'layer' }));
    scr.style.setProperty('--glow', glowOf(arts4[0]));
    var tiles = arts4.map(function (sname) { return art(sname, ARTBY[sname], 96, 'r-lg', { lit: true }); });
    var tileWrap = h('div', { class: 'onb-arts', 'aria-hidden': 'true' });
    /* four scattered sleeves, rotations -8, 4, -3, 7 degrees (critique item 23) */
    var POS = [[2, 28, -8], [24, 4, 4], [47, 34, -3], [69, 8, 7]];
    tiles.forEach(function (t, k) { t.style.setProperty('--x', POS[k][0]); t.style.setProperty('--y', POS[k][1]); t.style.setProperty('--r', POS[k][2]); tileWrap.append(t); });
    tiles[0].classList.add('lit');
    var layers = bg.querySelectorAll('.layer'), on = 0, i = 0;
    clearInterval(onbTimer);
    if (!reduce) onbTimer = setInterval(function () {
      i = (i + 1) % arts4.length; var nx = layers[on ? 0 : 1], cu = layers[on];
      nx.style.setProperty('--art', roomArt(arts4[i])); nx.classList.add('on'); cu.classList.remove('on'); on = on ? 0 : 1; tiles.forEach(function (t, k) { t.classList.toggle('lit', k === i); }); scr.style.setProperty('--glow', glowOf(arts4[i]));
    }, 6000);
    var fakeT = FT.total * 0.18;
    var inner = h('div', { class: 'onb-inner' },
      h('div', { class: 'wordmark' }, '4a'),
      h('div', { class: 'onb-mid' },
        tileWrap,
        h('div', { class: 'strip-wrap' }, strip('s48', { draw: true, thumbs: false, t: fakeT })),
        h('div', null, h('h1', { class: 't-display' }, 'Hear things outside your lane.'), h('p', { class: 't-body' }, '4a picks a few podcasts a day and says why. No account.'))),
      h('div', { class: 'actions' },
        h('button', { class: 'btn btn-primary block', onclick: function () { go('#/home'); } }, 'Show my picks'),
        h('button', { class: 'btn btn-secondary block', onclick: function () { go('#/home'); } }, 'Skip for now')));
    scr.append(bg, inner);
    return scr;
  }

  /* ------------------------------------------------------------------ settings and tuning */
  function openSettings() {
    var cur = store.get('theme') || 'auto';
    var chips = h('div', { class: 'seg-ctl' });
    [['auto', 'Auto'], ['dusk', 'Dusk'], ['dawn', 'Dawn']].forEach(function (o) {
      var c = h('button', { class: 'chip' + (cur === o[0] ? ' sel' : ''), 'aria-pressed': cur === o[0] ? 'true' : 'false', onclick: function () { setTheme(o[0]); chips.querySelectorAll('.chip').forEach(function (x) { x.classList.remove('sel'); x.setAttribute('aria-pressed', 'false'); }); c.classList.add('sel'); c.setAttribute('aria-pressed', 'true'); } }, o[1]);
      chips.append(c);
    });
    var tune = h('div', { class: 'stack-8', css: { 'margin-top': '12px' } });
    ['Physics and cosmos', 'Stories from the past', 'Building companies'].forEach(function (n) {
      var sel = 1;
      var row = h('div', { class: 'raised', css: { padding: '12px' } }, h('div', { class: 't-label' }, n), h('div', { class: 'seg-ctl' }));
      ['Less', '4a’s pick', 'More'].forEach(function (l, j) {
        var c = h('button', { class: 'chip' + (j === sel ? ' sel' : ''), 'aria-pressed': j === sel ? 'true' : 'false', onclick: function () { row.querySelectorAll('.chip').forEach(function (x, m) { x.classList.toggle('sel', m === j); x.setAttribute('aria-pressed', m === j ? 'true' : 'false'); }); } }, l);
        row.lastChild.append(c);
      });
      tune.append(row);
    });
    openSheet('Settings', h('div', null,
      h('h3', { class: 't-label c2' }, 'Look'), chips,
      h('h3', { class: 't-label c2', css: { 'margin-top': '24px' } }, 'Tuning'), tune,
      h('div', { class: 'menu-list', css: { 'margin-top': '16px' } }, h('button', { onclick: function () { closeSheet(); go('#/onboarding'); } }, icon('i-sparkle', 's20'), h('span', { class: 't-body' }, 'What 4a does')))));
  }
  function setTheme(t) {
    store.set('theme', t);
    if (t === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t);
    applyScheme(); buildSegColors(); setHtmlGlow(); if (S.cur) { buildNP(); renderMini(); } render(S.name, true);
  }

  /* ------------------------------------------------------------------ Now Playing */
  function buildNP(handoff) {
    NPR = { layerOn: 0 }; lastIdx = -1;
    strips = strips.filter(function (s) { return !$np.contains(s); });
    $np.replaceChildren();
    if (!S.cur) return;
    var isF = S.cur.kind === 'foray', e = isF ? null : S.cur.ep;
    var l0 = h('div', { class: 'layer on' }), l1 = h('div', { class: 'layer' }); NPR.layers = [l0, l1];
    l0.style.setProperty('--art', isF ? roomCssAt(forayAt(S.t)) : roomArt(e.show));
    var bg = h('div', { class: 'room-bg' }, l0, l1);
    var artEl = isF ? collage(FORAY_ARTS, 280, 'r-xl') : art(e.show, e.art, 280, 'r-xl');
    if (isF) artEl.style.setProperty('--art-glow', 'var(--glow)');   /* the foray's lamp is whichever show is current */
    NPR.artEl = artEl; artEl.classList.add('np-art-el');
    NPR.artHolder = h('div', { class: 'swap' }, artEl);
    NPR.title = h('h1', { class: 't-display clamp3' }, curTitle());
    NPR.showName = h('span', { class: 'nowshow' }, isF ? '' : e.show);
    NPR.showline = h('p', { class: 't-body show' }, isF ? h('span', { class: 'num' }, FT.shows.length + ' shows ·') : null, NPR.showName);
    NPR.cap = h('div', { class: 't-caption np-eyebrow', 'aria-live': 'polite' });
    NPR.why = h('p', { class: 't-why why clamp2' }, isF ? FORAY.why : e.hook);
    NPR.el = h('span', { class: 'time' }, '0:00'); NPR.rem = h('span', { class: 'time' }, '0:00');
    var ctrl = h('div', { class: 'np-ctrl' });
    if (isF) {
      var st = strip('s32', { draw: !handoff }); NPR.fill = true; NPR.scrub = null; ctrl.append(h('div', { class: 'strip-wrap' }, st));
    } else {
      NPR.scrub = h('div', { class: 'scrub', role: 'slider', tabindex: '0', 'aria-label': 'Playback position', 'aria-valuemin': '0', 'aria-valuemax': String(Math.round(curDur())), 'aria-valuenow': '0' }, h('div', { class: 'track' }, h('span', { class: 'buf', css: { width: '0' } }), h('span', { class: 'fill' }), h('span', { class: 'thumb' }), h('span', { class: 'bubble raised' })));
      NPR.fill = true;
      scrubInteractions(NPR.scrub);
      ctrl.append(NPR.scrub);
    }
    ctrl.append(h('div', { class: 't-caption times' }, h('span', null, S.downloaded ? h('span', { class: 'dl' }, icon('i-download-fill', 's16')) : null, NPR.el), NPR.rem));
    NPR.play = h('button', { class: 'playbtn s88', onclick: togglePlay });
    var transport = h('div', { class: 'transport' }, h('button', { class: 'skipbtn', 'aria-label': 'Back 15 seconds', onclick: function () { seekTo(S.t - 15); haptic('light'); } }, icon('i-back15')), NPR.play, h('button', { class: 'skipbtn', 'aria-label': 'Forward 30 seconds', onclick: function () { seekTo(S.t + 30); haptic('light'); } }, icon('i-fwd30')));
    var handle = h('button', { class: 'handle t-label', 'aria-label': 'More: speed, sleep, segments, show notes', onclick: function () { NPR.scroll.scrollTo({ top: NPR.first.offsetHeight - 8, behavior: reduce ? 'auto' : 'smooth' }); } }, h('span', { class: 'hl' }, 'More'), icon('i-chevron-down'));
    NPR.first = h('div', { class: 'np-first' },
      h('div', { class: 'np-head' }, h('button', { class: 'icon-btn', 'aria-label': 'Close player', onclick: function () { closeNP(); } }, icon('i-chevron-down')), h('span', { class: 'grabber' }), h('button', { class: 'chip carchip', onclick: toggleCar }, icon('i-car', 's20'), ' Car'), h('button', { class: 'icon-btn', 'aria-label': 'More', onclick: npMenu }, icon('i-dots'))),
      h('div', { class: 'np-mid' },
        h('div', { class: 'np-art' }, NPR.artHolder),
        h('div', { class: 'np-titles' }, NPR.cap, NPR.title, NPR.showline, NPR.why)),
      ctrl, transport, handle);
    /* detail */
    var detail = h('div', { class: 'np-detail' });
    var secRow = h('div', { class: 'sec-row' });
    var speedBtn = h('button', { 'aria-label': 'Playback speed' }, icon('i-gauge'), h('span', { class: 't-caption num' }, S.speed + 'x'));
    speedBtn.onclick = function () { S.speed = S.speed === 1 ? 1.25 : S.speed === 1.25 ? 1.5 : 1; speedBtn.lastChild.textContent = S.speed + 'x'; haptic('light'); };
    var sleepBtn = h('button', { 'aria-label': 'Sleep timer' }, icon('i-moon'), h('span', { class: 't-caption' }, S.sleep ? S.sleep + ' min' : 'Sleep'));
    sleepBtn.onclick = function () { S.sleep = S.sleep === 0 ? 15 : S.sleep === 15 ? 30 : 0; sleepBtn.lastChild.textContent = S.sleep ? S.sleep + ' min' : 'Sleep'; };
    var bmBtn = h('button', { 'aria-label': 'Bookmark this moment', 'aria-pressed': S.bookmarked ? 'true' : 'false' }, toggleIcon('i-bookmark', 'i-bookmark-fill', S.bookmarked), h('span', { class: 't-caption' }, 'Bookmark'));
    bmBtn.onclick = function () { S.bookmarked = !S.bookmarked; bmBtn.setAttribute('aria-pressed', S.bookmarked ? 'true' : 'false'); if (S.bookmarked) { toast('Bookmarked at ' + fmt(S.t)); } };
    var shBtn = h('button', { 'aria-label': 'Share a link to this moment', onclick: function () { toast('Link to ' + fmt(S.t) + ' copied'); } }, icon('i-share'), h('span', { class: 't-caption' }, 'Share'));
    secRow.append(speedBtn, sleepBtn, bmBtn, shBtn); detail.append(secRow);
    NPR.segRows = null;
    if (isF) {
      var sl = h('div', { class: 'stack-8' }); NPR.segRows = [];
      FT.items.forEach(function (it) { var r = segRow(it); NPR.segRows.push(r); sl.append(r); });
      detail.append(h('section', { class: 'section' }, sectionHead('Segments', FT.items.length), sl));
      var came = h('div', { class: 'grid-3' }); FT.shows.forEach(function (s) { came.append(h('div', { class: 'stile' }, art(s, ARTBY[s], 104, 'r-md', { badge: !!S.followed[s] }), h('span', { class: 't-caption name clamp2' }, s))); });
      detail.append(h('section', { class: 'section' }, sectionHead('Where this came from'), came));
    } else {
      var notes = h('p', { class: 't-body notes clamp4' }, e.hook + ' ' + e.show + ', ' + dshort(e.date) + ', ' + e.dur + ' min. The publisher’s notes run here in full, with links, and timestamps that seek to the moment they name. Nothing is rehosted: the audio plays from the show’s own feed.');
      var more = h('button', { class: 'btn btn-quiet', 'aria-expanded': 'false', onclick: function () { var open = notes.classList.toggle('clamp4'); more.setAttribute('aria-expanded', open ? 'false' : 'true'); more.textContent = open ? 'More' : 'Less'; } }, 'More');
      detail.append(h('section', { class: 'section' }, sectionHead('Show notes'), notes, more));
    }
    var nx = S.upnext[0];
    if (nx && !handoff) detail.append(h('section', { class: 'section' }, sectionHead('Up next'), qRow({ ep: nx.ep, auto: true, why: nx.ep.hook }), h('button', { class: 'btn btn-quiet', onclick: function () { closeNP(true); go('#/library'); } }, 'Up Next (' + S.upnext.length + ')')));
    else if (nx) detail.append(h('section', { class: 'section' }, sectionHead('Up next'), qRow({ ep: nx.ep, auto: true, why: nx.ep.hook })));
    NPR.scroll = h('div', { class: 'np-scroll' }, NPR.first, detail);
    $np.append(bg, NPR.scroll);
    $np.style.setProperty('--glow', isF ? glowAt(forayAt(S.t)) : glowOf(e.show));
    $np.classList.toggle('paused', !S.playing);
    if (handoff) applyHandoff(handoff, isF ? roomCssAt(forayAt(S.t)) : roomArt(e.show));
    npDrag();
    syncPlayUI(); renderProgress(true);
    requestAnimationFrame(function () {
      var lh = parseFloat(getComputedStyle(NPR.title).lineHeight) || 36;
      var lines = Math.round(NPR.title.getBoundingClientRect().height / lh);
      $np.classList.toggle('np--long', lines >= 3);
    });
  }
  /* the end-of-item handoff: next art slides in from +100% as the old one exits to -24%, the Room crossfades, the title has already swapped */
  function applyHandoff(ho, newCss) {
    var out = ho.artNode; out.classList.remove('np-art-el'); out.classList.add('out');
    NPR.artHolder.prepend(out); NPR.artEl.classList.add('in');
    var l0 = NPR.layers[0], l1 = NPR.layers[1];
    l0.style.setProperty('--art', ho.roomCss || newCss); l1.style.setProperty('--art', newCss);
    NPR.layerOn = 1;
    if (ho.freeze) {
      NPR.artHolder.classList.add('frozen'); $np.classList.add('handoff-half');
      l1.classList.add('on');
      flashCap('Up next', true);
    } else {
      out.addEventListener('animationend', function () { out.remove(); });
      requestAnimationFrame(function () { requestAnimationFrame(function () { l1.classList.add('on'); l0.classList.remove('on'); }); });
      if (S.npOpen) flashCap('Up next');
    }
  }
  /* ?state=np-segchange: both Room layers at 50/50 (the old segment's art under the new), the glow halfway between them, the caption lit,
     the outgoing bar full and the incoming bar at 4% (the position is set by the caller), the show line mid-crossfade */
  function freezeSegChange(idx) {
    var it = FT.items[idx]; S.freeze = true;
    var cur = NPR.layers[NPR.layerOn || 0], other = NPR.layers[NPR.layerOn === 0 ? 1 : 0];
    other.style.setProperty('--art', roomCssAt(idx - 1)); other.classList.add('on'); cur.classList.add('on');
    $np.classList.add('segfrozen');
    var mid = 'color-mix(in oklab, ' + glowAt(idx - 1) + ' 50%, ' + glowAt(idx) + ' 50%)';
    $np.style.setProperty('--glow', mid); document.documentElement.style.setProperty('--glow', mid);
    NPR.showName.textContent = it.show; NPR.showName.style.opacity = '0.5';
    flashCap('Now: ' + it.show, true);
  }
  function scrubInteractions(el) {
    var drag = false;
    function at(ev) { var r = el.getBoundingClientRect(); var f = clamp((ev.clientX - r.left) / r.width, 0, 1); seekTo(f * curDur()); }
    el.addEventListener('pointerdown', function (ev) { drag = true; el.classList.add('drag'); el.setPointerCapture && el.setPointerCapture(ev.pointerId); at(ev); var b = el.querySelector('.bubble'); b.textContent = fmt(S.t); });
    el.addEventListener('pointermove', function (ev) { if (drag) { at(ev); el.querySelector('.bubble').textContent = fmt(S.t); } });
    ['pointerup', 'pointercancel'].forEach(function (n) { el.addEventListener(n, function () { drag = false; el.classList.remove('drag'); }); });
    el.addEventListener('keydown', function (ev) { if (ev.key === 'ArrowRight') seekTo(S.t + 15); if (ev.key === 'ArrowLeft') seekTo(S.t - 15); });
  }
  function npMenu() {
    var items = [
      { icon: 'i-share', label: 'Share a link to this moment', run: function () { toast('Link to ' + fmt(S.t) + ' copied'); } },
      { icon: 'i-books', label: 'Show page', run: function () { toast(curShow()); } },
      { icon: 'i-moon', label: 'Sleep in 15 min', run: function () { S.sleep = 15; toast('Sleep timer set for 15 min'); } },
      { icon: 'i-download', label: 'Download', run: function () { S.downloaded = true; toast('Downloaded'); buildNP(); } },
      { icon: 'i-x', label: 'Stop', run: function () { var c = S.cur, t = S.t; closeNP(true); S.cur = null; S.playing = false; $mini.hidden = true; $app.classList.remove('has-mini'); buildNP(); setHtmlGlow(); toast('Stopped', 'Undo', function () { S.cur = c; S.t = t; S.playing = true; setCurrent(c); S.t = t; }); } }
    ];
    menu('Player', items);
  }
  function npDrag() {
    var sy = null, dy = 0, scroll = NPR.scroll;
    scroll.addEventListener('pointerdown', function (e) { if (scroll.scrollTop <= 0 && e.target.closest && !e.target.closest('.scrub, .sb, button')) { sy = e.clientY; dy = 0; } });
    scroll.addEventListener('pointermove', function (e) {
      if (sy == null) return; dy = e.clientY - sy;
      if (dy > 8) { $np.classList.add('dragging'); $np.style.transform = 'translateY(' + dy + 'px)'; } else if (dy < 0) sy = null;
    });
    function end() {
      if (sy == null) return; var d = dy; sy = null; $np.classList.remove('dragging');
      if (d > 120) { closeNP(); } else { $np.style.transition = 'transform 420ms var(--e-spring)'; $np.style.transform = ''; setTimeout(function () { $np.style.transition = ''; }, 440); }
    }
    scroll.addEventListener('pointerup', end); scroll.addEventListener('pointercancel', end);
  }
  function miniClip() {
    var m = $mini.getBoundingClientRect(), a = $app.getBoundingClientRect();
    if (!m.width || $mini.hidden) return 'inset(100% 0px 0px 0px round 24px)';
    return 'inset(' + (m.top - a.top) + 'px ' + (a.right - m.right) + 'px ' + (a.bottom - m.bottom) + 'px ' + (m.left - a.left) + 'px round 24px)';
  }
  function showNP(instant, fromMini, quiet) {
    if (!S.cur || S.npOpen) return;
    S.npOpen = true; $app.classList.add('np-open'); $np.setAttribute('aria-hidden', 'false');
    var fromArt = fromMini && MR.art.firstChild ? MR.art.firstChild : null;
    function apply() {
      $np.style.removeProperty('transform'); $np.classList.remove('closing');
      $np.classList.add('open');
      if (!NPR.scroll) return;
      NPR.scroll.scrollTop = 0;
      /* the caption "Now: <show>" shows for 3s after the sheet opens (foray only; an episode's show is already the permanent line) */
      if (S.cur.kind === 'foray' && !quiet && !$np.classList.contains('handoff-half')) { var s = curShow(); flashCap(s === '4a narration' ? s : 'Now: ' + s); }
    }
    if (instant) { $np.classList.add('instant'); $np.style.setProperty('--clip-from', 'inset(0px 0px 0px 0px round 0px)'); apply(); void $np.offsetWidth; $np.classList.remove('instant'); renderProgress(true); return; }
    $np.classList.add('instant'); $np.style.setProperty('--clip-from', miniClip()); void $np.offsetWidth; $np.classList.remove('instant');
    var artEl = $np.querySelector('.np-art-el');
    if (!reduce && document.startViewTransition && fromArt && artEl) {
      fromArt.style.viewTransitionName = 'np-art';
      try {
        var vt = document.startViewTransition(function () { fromArt.style.viewTransitionName = ''; artEl.style.viewTransitionName = 'np-art'; apply(); });
        vt.finished.then(function () { artEl.style.viewTransitionName = ''; }, function () { artEl.style.viewTransitionName = ''; fromArt.style.viewTransitionName = ''; });
      } catch (e) { fromArt.style.viewTransitionName = ''; apply(); }
    } else {
      apply();
      if (!reduce && fromArt && artEl && artEl.animate) {
        var f = fromArt.getBoundingClientRect(), t = artEl.getBoundingClientRect();
        if (f.width && t.width) artEl.animate([{ transform: 'translate(' + (f.left - t.left) + 'px,' + (f.top - t.top) + 'px) scale(' + (f.width / t.width) + ')', transformOrigin: 'top left' }, { transform: 'none', transformOrigin: 'top left' }], { duration: 420, easing: 'cubic-bezier(0.2,0.9,0.2,1.02)' });
      }
    }
    haptic('light');
  }
  function openNPFromMini() { if (S.npOpen) return; S.under = location.hash && location.hash !== '#/now-playing' ? location.hash : '#/home'; internalHash('#/now-playing'); showNP(false, true); }
  function closeNP(silent) {
    if (!S.npOpen) return;
    S.npOpen = false; $app.classList.remove('np-open'); $np.setAttribute('aria-hidden', 'true');
    var done = function () { $np.classList.remove('open', 'closing'); $np.classList.add('instant'); $np.style.removeProperty('transform'); void $np.offsetWidth; $np.classList.remove('instant'); };
    if (reduce) { $np.classList.remove('open'); $np.style.removeProperty('transform'); } else { $np.classList.add('closing'); $np.style.transform = 'translateY(100%)'; setTimeout(done, 440); }
    if (!silent && location.hash === '#/now-playing') internalHash(S.under || '#/home');
  }
  function toggleCar() {
    var on = document.documentElement.getAttribute('data-posture') === 'car';
    if (on) document.documentElement.removeAttribute('data-posture'); else { document.documentElement.setAttribute('data-posture', 'car'); if (S.cur && !S.npOpen) showNP(true); }
  }

  /* ------------------------------------------------------------------ router */
  var internal = 0;
  function internalHash(hash) { if (location.hash === hash) return; internal++; location.hash = hash; }
  function go(hash) {
    if (S.npOpen && hash !== '#/now-playing') closeNP(true);
    if (location.hash === hash) { var sc = $screenHost.querySelector('.screen'); if (sc && sc.scrollTo) sc.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' }); return; }
    S.prev = location.hash; internalHash(hash);
  }
  var NAMES = { home: 'home', mini: 'home', 'now-playing': 'home', search: 'discover', library: 'library', foray: 'foray', onboarding: 'onboarding' };
  function fixture(name) {
    S.stateParam = Q.get('state') || ''; S.q = '';
    var st = S.stateParam;
    if (st === 'results') S.q = 'money'; if (st === 'noresults') S.q = 'cosmos'; if (st === 'typing') S.q = 'ma';
    if (S.npOpen) { S.npOpen = false; $app.classList.remove('np-open'); $np.classList.remove('open', 'closing'); }
    $np.classList.remove('handoff-half');
    S.cur = null; S.playing = false; lastIdx = -1; S.freeze = false; $np.classList.remove('segfrozen');
    var firstLike = st === 'empty' || st === 'firstrun' || st === 'loading';
    var withMini = !firstLike && Q.get('mini') !== '0' && (name === 'mini' || name === 'search' || name === 'library' || Q.get('mini') === '1' || st === 'midlisten');
    if (withMini) setCurrent({ kind: 'ep', ep: KEEP }, { paused: st === 'paused' });
    if (withMini) { S.t = S.prog[KEEP.id]; renderProgress(true); }
    if (name === 'now-playing') {
      if (st === 'episode' || st === 'ending' || st === 'np-detail3') {
        setCurrent({ kind: 'ep', ep: KEEP }, { paused: st === 'paused' });
        if (st === 'ending') { S.t = curDur() - 1; endItem(true); }
      } else if (st === 'np-segchange') {
        /* the signature moment, frozen 280ms after the boundary into The Bootstrapped Founder (BUILD-NOTES 10.12) */
        var bi = FT.items.findIndex(function (i) { return i.show === 'The Bootstrapped Founder'; }), bf = FT.items[bi];
        S.prog['foray'] = bf.start + bf.dur * 0.04;
        setCurrent({ kind: 'foray' }, {});
        freezeSegChange(bi);
      } else {
        var rt = FT.items.filter(function (i) { return i.show === 'Run the Numbers'; })[0];
        S.prog['foray'] = rt.start + Math.round(rt.dur * 0.4);
        setCurrent({ kind: 'foray' }, { paused: st === 'paused' });
      }
    }
    if (st === 'buffering' && S.cur) { S.buffering = true; $mini.classList.add('buffering'); } else $mini.classList.remove('buffering');
    if (Q.get('posture') === 'car') document.documentElement.setAttribute('data-posture', 'car');
    if (!S.cur) { setHtmlGlow(); renderMini(); buildNP(); }
    syncPlayUI();
  }
  var firstRender = true;
  function render(name, forceRebuild) {
    clearInterval(onbTimer);
    S.name = name; var tab = NAMES[name] || 'home';
    var kind = tab;
    var scr = kind === 'home' ? buildToday() : kind === 'discover' ? buildDiscover() : kind === 'library' ? buildLibrary() : kind === 'foray' ? buildForayDetail() : buildOnboarding();
    var old = $screenHost.querySelector('.screen');
    $fieldRow.replaceChildren(); $fieldRow.hidden = true; $app.classList.remove('has-field');
    if (old) { if (forceRebuild || firstRender || reduce) old.remove(); else { old.classList.add('leaving'); setTimeout(function () { old.remove(); }, 280); } }
    if (!(forceRebuild || firstRender)) scr.classList.add('entering');
    $screenHost.append(scr);
    if (scr._field) { $fieldRow.append(scr._field); $fieldRow.hidden = false; $app.classList.add('has-field'); }
    if (!(forceRebuild || firstRender)) requestAnimationFrame(function () { requestAnimationFrame(function () { scr.classList.remove('entering'); }); });
    firstRender = false;
    $app.classList.toggle('no-chrome', kind === 'foray' || kind === 'onboarding');
    $app.classList.remove('compact', 'kb');
    $mini.hidden = !S.cur || kind === 'foray' || kind === 'onboarding'; $app.classList.toggle('has-mini', !$mini.hidden);
    updateTabs();
    /* tab recede */
    var last = 0;
    scr.addEventListener('scroll', function () {
      var y = scr.scrollTop;
      if (y > last + 4 && y > 80) $app.classList.add('compact'); else if (y < last - 2) $app.classList.remove('compact');
      last = y;
    }, { passive: true });
    document.title = { home: 'Today', discover: 'Discover', library: 'Library', foray: 'Foray', onboarding: 'Welcome' }[kind] + ' · 4a Afterglow';
    scr.scrollTop = 0;
    if (kind === 'home') { if (!S.cur) document.documentElement.style.setProperty('--glow', glowOf(FT.shows[0])); }
    syncPlayUI(); renderProgress(true);
    if (name === 'now-playing' && S.cur) { showNP(true, false, Q.get('eyebrow') !== 'on'); }
    else if (S.npOpen && name !== 'now-playing') closeNP(true);
    if (kind === 'discover' && S.stateParam === 'kb' && scr._input) { $app.classList.add('kb'); try { scr._input.focus(); } catch (e) { /* ignore */ } }
    if (forceRebuild) applyScroll(scr);
  }
  /* ?scroll=<px>: scroll the active scroller after render so the harness can shoot the lower sections
     (Stretch card, Playlists rail, Off your path, the segment list, the Now Playing detail posture) */
  function applyScroll(scr) {
    var px = S.stateParam === 'np-detail3' ? 99999 : parseFloat(Q.get('scroll'));
    if (!(px > 0)) return;
    var go2 = function () {
      var tgt = S.npOpen && NPR.scroll ? NPR.scroll : (scr.querySelector('.np-scroll') || scr);
      tgt.scrollTop = px;
    };
    go2(); requestAnimationFrame(go2); setTimeout(go2, 400);
  }
  function updateTabs() {
    var tab = NAMES[S.name] || 'home';
    $tabbar.querySelectorAll('.tab').forEach(function (b) { var on = b.getAttribute('data-tab') === tab; if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  }
  function onHash() {
    var name = (location.hash || '#/home').replace(/^#\/?/, '') || 'home';
    if (!NAMES[name]) name = 'home';
    var external = internal === 0;
    if (internal > 0) internal--;
    if (external) { fixture(name); S.under = name === 'now-playing' ? '#/home' : '#/' + name; }
    if (!external && $screenHost.firstChild && (name === 'now-playing' || (NAMES[name] === NAMES[S.name] && name !== 'foray' && name !== 'onboarding'))) return;
    render(name, external);
  }
  window.addEventListener('hashchange', onHash);

  /* ------------------------------------------------------------------ boot */
  var savedTheme = Q.get('theme') || store.get('theme');
  if (savedTheme === 'dusk' || savedTheme === 'dawn') document.documentElement.setAttribute('data-theme', savedTheme);
  var ts = parseFloat(Q.get('textscale')); if (ts > 0) { document.documentElement.style.fontSize = (16 * ts) + 'px'; if (ts > 1.15) document.documentElement.classList.add('big'); }
  applyScheme();
  try { window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', applyScheme); } catch (e) { /* older engines */ }
  buildSegColors();
  if (!location.hash) { try { history.replaceState(null, '', location.pathname + location.search + '#/home'); } catch (e) { /* ignore */ } }
  onHash();
})();
