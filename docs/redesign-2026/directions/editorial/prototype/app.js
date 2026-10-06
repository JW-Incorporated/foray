/* Edition prototype. Plain classic script, no build. Playback is simulated; no audio plays.
   Rules kept from the repo: every interpolation through esc(), every src through safeUrl(),
   no inline style attributes (custom properties are set through the CSSOM), storage via a
   try/catch shim with cp_ keys. */
(function () {
  'use strict';

  /* ---------- helpers ---------- */
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ESC[c]; }); }
  function safeUrl(u) { try { var x = new URL(u, location.href); return /^(https?:)$/.test(x.protocol) ? x.href : ''; } catch (e) { return ''; } }
  function clamp(n, a, b) { return Math.min(b, Math.max(a, n)); }
  var store = {
    get: function (k) { try { return localStorage.getItem('cp_' + k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem('cp_' + k, v); } catch (e) { /* private window */ } }
  };
  var webdriver = !!navigator.webdriver; // the screenshot harness: freeze the playhead so renders are repeatable
  var reduceMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  function ic(name, cls) { return '<svg class="ic' + (cls ? ' ' + cls : '') + '" aria-hidden="true" focusable="false"><use href="#' + name + '"/></svg>'; }
  function fmtMin(sec) { return Math.max(1, Math.round(sec / 60)) + ' min'; }
  function clock(s) {
    s = Math.max(0, Math.floor(s)); var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(ss).padStart(2, '0');
  }
  function spoken(s) { s = Math.floor(s); var m = Math.floor(s / 60); return m + ' minutes ' + (s % 60) + ' seconds'; }
  function hrMin(totalMin) { var h = Math.floor(totalMin / 60), m = totalMin % 60; return (h ? h + ' HR ' : '') + (m ? m + ' MIN' : ''); }
  function wordCount(s) { return String(s).trim().split(/\s+/).length; }

  /* ---------- state ---------- */
  var D = null, F = null;
  var S = {
    page: null, under: 'home', cur: null, pos: 0, playing: false, buffering: false, speed: 1, bookmarked: false,
    queue: [], saved: [], followed: [], history: [], q: '', mode: 'returning', offline: false, loading: false,
    firstEdition: false, large: store.get('large') === '1', scheme: store.get('scheme') || 'auto', npOpen: false,
    segIdx: -1, fromTab: 'today', lastPlate: null, text: null, vt: true, openerFocus: null, resume: null
  };
  // r1 critique 12: ?scheme= ?text= ?large= ?state= are render instructions. They reach the DOM only;
  // the store is written from the Colophon controls alone (S.scheme / S.large hold the stored preference).
  var SHOW_IDX = {}, ART_SHOW = {};
  function hashStr(s) { var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 7919; return h; }
  function inkOf(name) { return SHOW_IDX[name] != null ? SHOW_IDX[name] : hashStr(String(name || '?')) % 8; }
  function artOf(u) { return S.noart ? '' : u; }

  /* ---------- data selection ---------- */
  function ep(sub) { for (var i = 0; i < D.episodes.length; i++) if (D.episodes[i].show.indexOf(sub) >= 0) return D.episodes[i]; return D.episodes[0]; }
  function epById(id) { for (var i = 0; i < D.episodes.length; i++) if (D.episodes[i].id === id) return D.episodes[i]; return null; }
  var PICKS, STRETCH_EP, BEATEN;
  function selectData() {
    F = D.foray;
    var c = 0;
    F.segments.forEach(function (s) { s.i = F.segments.indexOf(s); s.n = s.narration ? null : ++c; }); // r1 critique 9: number content segments only, 1-11
    F.total = F.segments.reduce(function (a, s) { return a + s.duration_sec; }, 0);
    F.core = c;
    F.shows.forEach(function (s) { SHOW_IDX[s.name] = s.idx % 8; });
    D.shows.forEach(function (s) { ART_SHOW[s.artwork_url] = s.name; });
    D.episodes.forEach(function (e) { ART_SHOW[e.artwork_url] = ART_SHOW[e.artwork_url] || e.show; });
    F.shows.forEach(function (s) { ART_SHOW[s.artwork_url] = s.name; });
    var pm = ep('Planet Money'), spolia = ep('99% Invisible'), mw = ep('The Matt Walker');
    spolia.bridge = 'Adjacent to your money picks: how builders reused salvaged stone, from Liverpool back to ancient Rome.';
    spolia.stretch = true;
    PICKS = [pm, spolia, mw];
    STRETCH_EP = spolia;
    var want = ['Fretboard', 'The Allusionist', 'Shipwrecks', 'Philosophy Bites', 'Myths', 'Software'];
    BEATEN = want.map(function (w) { return ep(w); });
    S.followed = D.shows.slice(0, 8);
    S.saved = [ep('Odd Lots'), ep('Hidden Brain'), ep('Switched on'), ep('The Race'), ep('Weather Geeks')];
    S.history = [ep('Planet Money'), ep('The Ancients'), ep('Science Vs'), ep('Strong Towns'), ep('Freakonomics')];
  }
  function seedQueue() {
    S.queue = [spoliaAuto(), ep('The Matt Walker'), ep('Hidden Brain'), ep('Switched on'), ep('The Ancients')];
  }
  function spoliaAuto() { var e = ep('99% Invisible'); e.auto = true; return e; }

  /* current item abstraction */
  function item() {
    if (!S.cur) return null;
    if (S.cur.kind === 'foray') {
      var sg = F.segments[segIndex()];
      return { kind: 'foray', title: F.title, show: sg.narration ? '4a' : sg.show, segTitle: sg.title, label: 'A FORAY', art: F.shows[0].artwork_url, arts: F.shows.map(function (s) { return s.artwork_url; }),
        note: F.note, dur: F.total, id: F.id, sg: sg };
    }
    var e = S.cur.ep; return { kind: 'ep', title: e.title, show: e.show, label: 'NOW PLAYING', art: e.artwork_url, note: e.note, dur: e.duration_min * 60, id: e.id, ep: e };
  }
  function segIndex(pos) {
    pos = pos == null ? S.pos : pos; var segs = F.segments;
    for (var i = segs.length - 1; i >= 0; i--) if (pos >= segs[i].start_sec) return i;
    return 0;
  }

  /* ---------- fragments ---------- */
  /* A plate with art loads the image; one without (or whose image fails) shows the show's initial.
     Single plates: stock-2 and the initial in --ink-3. Contact cells and grid cells: the show's segment ink at
     16% over stock-2 with the initial in that ink (r1 critique 7). Blank stock never ships. */
  function plate(url, cls, name) {
    var u = safeUrl(artOf(url)), ini = esc((name || '?').charAt(0)), inked = /plate--grid/.test(cls || '');
    return '<span class="plate ' + (cls || '') + (u ? '' : ' is-fb') + (inked ? ' is-inked' : '') + '" data-show="' + inkOf(name) + '">' +
      (u ? '<span class="initial initial--late t-d2">' + ini + '</span><img src="' + esc(u) + '" alt="" decoding="async">' : '<span class="initial t-d2">' + ini + '</span>') + '</span>';
  }
  function contact(urls, cls) {
    var seen = [], out = [];
    urls.forEach(function (u) { if (u && seen.indexOf(u) < 0) seen.push(u); });
    var n = Math.min(4, seen.length) || 1;
    if (n === 1) return plate(seen[0], cls, ART_SHOW[seen[0]] || 'F');
    // r2 critique 1: at 4:3 the 2x2 beheads every typographic cover; lead plates are lead-and-column (a full-height square
    // plus a column of squares), so no cell is ever cropped. Square plates keep the 2x2.
    var lead = /plate--lead/.test(cls || '') ? ' is-lead' : '';
    return '<span class="plate plate--contact n' + n + lead + ' ' + (cls || '') + '">' + seen.slice(0, n).map(function (u) {
      var name = ART_SHOW[u] || '?', url = safeUrl(artOf(u)), ini = esc(name.charAt(0));
      return '<span class="cell-fb' + (url ? '' : ' is-fb') + '" data-show="' + inkOf(name) + '">' + (url ? '<span class="initial initial--late t-d2">' + ini + '</span><img src="' + esc(url) + '" alt="" decoding="async">' : '<span class="initial t-d2">' + ini + '</span>') + '</span>';
    }).join('') + '</span>';
  }
  function strip(segs, cls, opts) {
    opts = opts || {};
    var total = segs.reduce(function (a, s) { return a + s.duration_sec; }, 0);
    var shows = {}, k = 0;
    return '<div class="strip ' + (cls || '') + '" role="img" aria-label="' + esc(segs.length + ' segments from ' + (opts.shows || 1) + ' shows, ' + fmtMin(total)) + '"' + (opts.frac != null ? ' data-frac="' + opts.frac + '"' : '') + (opts.live ? ' data-live="1"' : '') + '>' +
      segs.map(function (s, i) { return '<i class="seg' + (s.narration ? ' seg--n' : '') + '"' + (s.narration ? '' : ' data-show="' + (s.show_idx % 8) + '"') + ' data-w="' + s.duration_sec + '"></i>'; }).join('') +
      '<b class="strip-cursor" aria-hidden="true"></b></div>';
  }
  function strandSegs(arr) { return arr.map(function (n, i) { return { duration_sec: n * 60, show_idx: i % 5, narration: false }; }); }
  function key(cap) {
    return '<div class="strip-key t-meta' + (cap ? ' strip-key--cap' : '') + '"><span class="key key-n"><i class="n"></i>4a</span>' + F.shows.map(function (s) { return '<span class="key key-s"><i data-show="' + (s.idx % 8) + '"></i>' + esc(s.name) + '</span>'; }).join('') + (cap ? '<span class="key key-more" hidden></span>' : '') + '</div>';
  }
  /* Today's key is capped at two lines; whatever does not fit becomes a "+n shows" item (r1 critique 5). */
  function fitKey(root) {
    $$('.strip-key--cap', root || document).forEach(function (el) {
      var items = $$('.key-s', el), more = $('.key-more', el), lim = parseFloat(getComputedStyle(el).maxHeight) || 40;
      items.forEach(function (i) { i.hidden = false; }); more.hidden = true;
      var hidden = 0;
      while (el.scrollHeight > lim + 1 && hidden < items.length - 1) {
        hidden++; items[items.length - hidden].hidden = true;
        more.hidden = false; more.textContent = '+' + hidden + (hidden === 1 ? ' show' : ' shows');
      }
    });
  }
  function metaTxt(show, tail, pre) { return '<span class="meta-txt">' + (pre || '') + '<span class="ell">' + esc(show) + '</span><span class="nw"> · ' + esc(tail) + '</span></span>'; }
  /* Hooks are authored, never derived (r2 critique 5): a `hook` field on the item, one complete sentence of at most
     16 words. fitHooks is only the 3-line guard: it warns when a hook overflows, it never cuts one. */
  function fitHooks(root) {
    $$('.hook', root || document).forEach(function (el) {
      if (el.scrollHeight > el.clientHeight + 1 && window.console) console.warn('hook overflows three lines:', el.textContent);
    });
  }
  function note(text, cls) { return '<p class="note ' + (cls || '') + '"><span class="t-note">' + esc(text) + '</span></p>'; }
  function head(label, o) {
    o = o || {};
    return '<div class="section-head t-label"><span>' + esc(label) + '</span>' + (o.meta ? '<span class="t-meta' + (o.sub ? ' is-sub' : '') + '">' + (o.metaHTML ? o.meta : esc(o.meta)) + '</span>' : '') + (o.action ? '<button class="btn-text" data-act="' + o.act + '">' + esc(o.action) + '</button>' : '') + '</div>';
  }
  function section(label, body, o) { return '<section class="section">' + head(label, o) + body + '</section>'; }
  function foot(label, href) { return '<div class="section-foot"><a class="btn-foot t-meta" href="' + esc(href) + '">' + esc(label) + ic('arrow-right', 'ic--16') + '</a></div>'; }
  function inQueue(id) { return S.queue.some(function (e) { return e.id === id; }); }
  function addBtn(e) {
    var on = inQueue(e.id);
    return '<button class="btn-icon" data-act="add" data-id="' + esc(e.id) + '" aria-label="' + (on ? 'In Up Next: ' : 'Add to Up Next: ') + esc(e.title) + '"' + (on ? ' aria-pressed="true"' : '') + '>' + ic(on ? 'check' : 'list-plus') + '</button>';
  }
  function offlineDim(e) { return S.offline && (e.id.charCodeAt(0) % 2 === 0); }

  function rowEp(e, o) {
    o = o || {}; var off = offlineDim(e);
    return '<li class="row row-ep' + (off ? ' is-offline-item' : '') + '">' +
      '<a class="row-plain" href="#/home" data-act="play-ep" data-id="' + esc(e.id) + '"' + (off ? ' aria-disabled="true"' : '') + '>' + plate(e.artwork_url, 'plate--lg', e.show) +
      '<span class="row-body"><span class="t-title clamp-2">' + esc(e.title) + '</span><span class="t-meta">' + metaTxt(e.show, o.meta || e.duration_min + ' min', off ? ic('cloud-slash', 'ic--16') : '') + '</span></span></a>' + (o.noAdd ? '<span></span>' : addBtn(e)) + '</li>';
  }
  function rowNumbered(e, n) {
    var off = offlineDim(e);
    return '<li class="row row-numbered' + (e.stretch ? ' is-stretch' : '') + (off ? ' is-offline-item' : '') + '"><span class="t-num">' + n + '</span>' +
      '<a class="plate-link" href="#/home" data-act="play-ep" data-id="' + esc(e.id) + '" tabindex="-1" aria-hidden="true">' + plate(e.artwork_url, 'plate--lg', e.show) + '</a>' +
      '<span class="row-body"><a class="row-link" href="#/home" data-act="play-ep" data-id="' + esc(e.id) + '"' + (off ? ' aria-disabled="true"' : '') + '>' + (e.stretch ? '<span class="slug t-label">Stretch</span>' : '') + '<span class="t-title clamp-3">' + esc(e.title) + '</span>' + note(e.bridge || e.note, '') + '</a>' +
      '<span class="meta-line"><span class="t-meta c-2">' + metaTxt(e.show, e.duration_min + ' min', off ? ic('cloud-slash', 'ic--16') : '') + '</span>' + addBtn(e) + '</span></span></li>';
  }
  function rowForay(f) {
    var frac = f.progress || 0;
    return '<li class="row row-foray"><a class="row-plain" href="#/foray" data-act="open-foray" data-art="1">' + contact(f.art, 'plate--lg') + '<span class="row-body"><span class="t-title clamp-2">' + esc(f.title) + '</span>' +
      strip(strandSegs(f.strip), 'strip--row', { frac: frac, shows: f.shows }) + '<span class="t-meta">' + fmtMin(f.runtime_sec) + ' · ' + f.shows + (f.shows === 1 ? ' show' : ' shows') + '</span></span></a></li>';
  }
  function rowForayMain() {
    var arts = F.shows.map(function (s) { return s.artwork_url; });
    var frac = S.cur && S.cur.kind === 'foray' ? S.pos / F.total : (S.opts.progress ? 0.38 : 0);
    return '<li class="row row-foray"><a class="row-plain" href="#/foray" data-act="open-foray" data-art="1">' + contact(arts, 'plate--lg') + '<span class="row-body"><span class="t-title clamp-2">' + esc(F.title) + '</span>' +
      strip(F.segments, 'strip--row', { frac: frac, shows: F.shows.length }) + '<span class="t-meta">' + fmtMin(F.total) + ' · ' + F.shows.length + ' shows</span></span></a></li>';
  }
  function rowPlaylist(p) {
    var eps = p.episodes.map(epById).filter(Boolean);
    return '<li class="row row-foray"><a class="row-plain" href="#/search?q=' + encodeURIComponent(p.name) + '">' + contact(eps.map(function (e) { return e.artwork_url; }), 'plate--lg') + '<span class="row-body"><span class="t-title clamp-2">' + esc(p.name + ', set in order') + '</span>' +
      '<span class="progress-rule" data-p="' + Math.round(p.played / eps.length * 100) + '"></span><span class="t-meta">' + eps.length + ' episodes · ' + p.played + ' of ' + eps.length + ' played</span></span></a></li>';
  }
  function rowShow(s) {
    return '<li class="row row-show"><a class="row-plain" href="#/search?q=' + encodeURIComponent(s.name) + '">' + plate(s.artwork_url, 'plate--md', s.name) + '<span class="row-body"><span class="t-title clamp-1">' + esc(s.name) + '</span><span class="t-meta">' + s.episodes + ' episodes · ' + esc(s.subject) + '</span></span></a><span></span></li>';
  }
  /* The numeral column is 28px on every row. The current row keeps that column and puts a 16px red glyph in it
     (stitch for a foray, speaker for an episode); the PLAYING slug sits in the text column above the title, so
     every plate shares one x (r1 critique 1). */
  function rowQueue(e, i, now) {
    var isF = now && e.kind === 'foray';
    var plateHTML = isF ? contact(e.arts, 'plate--sm') : plate(e.artwork_url, 'plate--sm', e.show);
    var left = now ? (isF ? Math.max(1, Math.round((F.total - S.pos) / 60)) : Math.max(1, e.duration_min - Math.round(S.pos / 60))) + ' min left' : e.duration_min + ' min';
    return '<li class="row row-queue' + (now ? ' is-now' : '') + '" data-key="' + esc(e.id) + '">' +
      (now ? '<span class="lead-num lead-glyph">' + ic(isF ? 'stitch' : 'speaker-simple-high', 'ic--16') + '</span>' : '<span class="lead-num t-num t-num--sm">' + (i + 1) + '</span>') +
      '<a class="row-plain" href="' + (isF ? '#/foray' : '#/home') + '"' + (isF ? '' : ' data-act="play-ep" data-id="' + esc(e.id) + '"') + '>' + plateHTML + '<span class="row-body">' +
      (now ? '<span class="slug t-label">Playing</span>' : '') +
      '<span class="t-title t-title--sm clamp-1">' + esc(e.title) + '</span><span class="t-meta">' + metaTxt(isF ? F.shows.length + ' shows' : e.show, left) + '</span></span></a>' +
      '<button class="btn-icon" data-act="queue-menu" data-id="' + esc(e.id) + '" aria-label="Actions for ' + esc(e.title) + '">' + ic('dots-three') + '</button></li>';
  }
  function subjectRows(list) {
    return '<ul class="cols-2">' + list.map(function (s) { return '<li class="row-subject"><a class="t-title t-title--sm" href="#/search?q=' + encodeURIComponent(s.name) + '">' + esc(s.name) + '</a><span class="t-meta c-3">' + s.count + '</span></li>'; }).join('') + '</ul>';
  }
  function empty(sentence, label, href) { return '<div class="empty"><span class="t-d2">' + esc(sentence) + '</span>' + (label ? '<a class="btn-text" href="' + esc(href) + '">' + esc(label) + '</a>' : '') + '</div>'; }
  function skeleton() {
    var lines = '<div class="sk-line"></div><div class="sk-line"></div><div class="sk-line"></div><div class="sk-line"></div>';
    var row = '<div class="sk-row"><div class="sk-plate"></div><div>' + lines + '</div></div>';
    return '<div class="sk-plate"></div>' + lines + '<div class="mt-24">' + row + row + row + '</div>';
  }

  /* ---------- dateline ---------- */
  function dateParts() {
    var d = new Date(), parts = {};
    new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }).formatToParts(d).forEach(function (p) { parts[p.type] = p.value; });
    return { when: (parts.weekday + ' ' + parts.day + ' ' + parts.month).toUpperCase(), dm: (parts.day + ' ' + parts.month).toUpperCase() };
  }
  /* Two explicit lines, each its own block, so a line never opens with a separator. Offline is a third line above,
     in ink-2: a state, not 4a's authorship, so not red. */
  function datelineHTML() {
    var dp = dateParts(), first = S.mode === 'first' || S.firstEdition;
    var mins = Math.round(F.total / 60) + PICKS.reduce(function (a, e) { return a + e.duration_min; }, 0);
    var l1 = first ? 'FIRST EDITION · ' + dp.dm : dp.when + ' · YOUR EDITION';
    var l2 = '3 PICKS · 1 STRETCH' + (first ? '' : ' · ' + hrMin(mins));
    return (S.offline ? '<span class="dl dl-off">' + ic('wifi-slash', 'ic--14') + 'OFFLINE · DOWNLOADED ONLY</span>' : '') + '<span class="dl">' + esc(l1) + '</span><span class="dl">' + esc(l2) + '</span>';
  }

  /* ---------- views ---------- */
  function masthead(opts) {
    opts = opts || {};
    return '<header><div class="masthead"><a class="t-masthead" href="#/colophon" aria-label="4a, open the Colophon">4a</a>' +
      (opts.noPlay || S.loading ? '' : '<button class="btn-text" data-act="play-foray">' + ic('play', 'ic--20') + 'Play the edition</button>') + '</div>' +
      '<p class="dateline t-label" id="dateline">' + datelineHTML() + '</p><hr class="masthead-rule"></header>';
  }
  function viewHome() {
    var first = S.mode === 'first' || S.firstEdition;
    var h = masthead({ noPlay: false });
    if (S.loading) return h + '<div class="mt-24">' + skeleton() + '</div>';
    var out = h;
    // Resume is for a cold start or after Stop: while the ticker shows the item, Resume would repeat it (r1 critique 11).
    var rs = !S.cur && S.resume ? S.resume : null;
    if (rs && !first) {
      var cur = rs.ep, left = Math.max(1, cur.duration_min - Math.round(rs.pos / 60));
      out += '<section class="mt-24"><span class="slug t-label">' + ic('ribbon', 'ic--16') + 'Resume</span><ul><li class="row row-ep row-resume mt-8"><a class="row-plain" href="#/home" data-act="resume">' + plate(cur.artwork_url, 'plate--lg', cur.show) +
        '<span class="row-body"><span class="t-title clamp-2">' + esc(cur.title) + '</span><span class="progress-rule" data-p="' + Math.round(rs.pos / (cur.duration_min * 60) * 100) + '"></span><span class="t-meta">' + metaTxt(cur.show, left + ' min left') + '</span></span></a></li></ul></section>';
    }
    var arts = F.shows.map(function (s) { return s.artwork_url; });
    var leadNote = first ? 'A first edition, picked widely. Play one and tomorrow’s narrows.' : F.note;
    var dl = !S.offline || S.opts.dl !== '0';   // offline: the lead is downloaded unless ?dl=0
    var dlSlug = S.offline && dl ? '<span class="slug t-label slug--dl">Downloaded</span>' : '';
    var cloud = S.offline && !dl ? ic('cloud-slash', 'ic--16') : '';
    out += '<section class="lead"><p class="kicker t-label">Today’s foray</p>' + dlSlug +
      '<a class="lead-link" href="#/foray" data-act="open-foray" data-art="1"><h1 class="t-d1">' + esc(F.title) + '</h1>' + contact(arts, 'plate--lead') + strip(F.segments, '', { shows: F.shows.length }) + key(true) + note(leadNote) + '</a>' +
      '<div class="lead-meta"><span class="t-meta">' + cloud + fmtMin(F.total) + ' · ' + F.shows.length + ' shows · ' + F.core + ' segments</span><button class="btn-play" data-act="play-foray"' + (S.offline && !dl ? ' aria-disabled="true"' : '') + ' aria-label="Play ' + esc(F.title) + '">' + ic('play-fill', 'ic--play') + '</button></div></section>';
    var rows = PICKS.map(function (e, i) { return rowNumbered(e, i + 2); }).join('');
    var notice = S.offline ? '<p class="notice t-text mt-8">' + ic('wifi-slash', 'ic--20') + 'Offline. Downloaded items play; the rest wait for a connection.</p>' : '';
    out += section('Also today', notice + '<ul>' + rows + '</ul>');
    out += section('More forays', '<ul>' + D.more_forays.map(rowForay).join('') + '</ul>' + foot('All forays', '#/library'));
    if (!first) out += section('Your subjects', '<ul>' + D.playlists.slice(0, 3).map(rowPlaylist).join('') + '</ul>');
    out += '<div class="footer-line t-meta"><span>Assembled ' + esc(D.edition.assembled) + ' this morning</span><button class="btn-text" data-act="why">Why these?</button></div>';
    return out;
  }

  function viewSearch() {
    var q = S.q.trim();
    var out = '<header><div class="page-title"><h1 class="t-d1">Browse</h1></div><hr class="masthead-rule"></header>';
    if (q) return out + searchResults(q);
    out += section('Commission', '<button class="field" data-act="focus-find" data-mode="commission">' + ic('pencil-simple-line', 'ic--20') + 'Name a subject…</button>' +
      '<div class="chips mt-12">' + D.commissions.map(function (c) { return '<button class="chip" data-act="chip" data-q="' + esc(c) + '">' + esc(c) + '</button>'; }).join('') + '</div>' +
      '<p class="t-meta c-3 mt-12">Forays by commission come later.</p>', { meta: 'A playlist, on any subject', sub: true });
    var pat = ['', 's', 's', '', '', 's'];
    out += section('Off your beaten path', '<div class="splat">' + BEATEN.map(function (e, i) {
      return '<a class="splat-item ' + pat[i] + '" href="#/home" data-act="play-ep" data-id="' + esc(e.id) + '">' + plate(e.artwork_url, 'plate--sq', e.show) + '<span class="t-title">' + esc(e.title) + '</span><span class="t-text-sm hook">' + esc(e.hook) + '</span></a>';
    }).join('') + '</div>');
    out += section('Subjects', subjectRows(D.subjects.slice(0, 12)));
    out += section('Followed', '<div class="grid-4">' + S.followed.map(function (s) { return '<a class="cell" href="#/search?q=' + encodeURIComponent(s.name) + '" aria-label="' + esc(s.name) + '">' + plate(s.artwork_url, 'plate--grid', s.name) + '<span class="t-meta">' + esc(s.name) + '</span></a>'; }).join('') + '</div>' + foot('All followed', '#/library'));
    return out;
  }
  var SYN = { fusion: ['Science', 'Engineering'], rockets: ['Space', 'Engineering'], money: ['Economics', 'Business'] };
  function searchResults(q) {
    var lq = q.toLowerCase(), out = '<div class="mt-24"></div>';
    var shows = D.shows.filter(function (s) { return s.name.toLowerCase().indexOf(lq) >= 0; });
    var eps = D.episodes.filter(function (e) { return (e.title + ' ' + e.show + ' ' + e.subject + ' ' + e.note).toLowerCase().indexOf(lq) >= 0; });
    var pls = D.playlists.filter(function (p) { return p.name.toLowerCase().indexOf(lq) >= 0; });
    if (!shows.length && !eps.length && !pls.length) {
      var subs = (SYN[lq] || []).concat(D.subjects.filter(function (s) { return s.name.toLowerCase().indexOf(lq) >= 0; }).map(function (s) { return s.name; }));
      var rows = D.subjects.filter(function (s) { return subs.indexOf(s.name) >= 0; });
      if (rows.length) return out + '<div class="empty"><span class="t-d2">Nothing titled ‘' + esc(q) + '’. Subjects that touch it:</span></div><div class="mt-16">' + subjectRows(rows) + '</div>' +
        '<p class="commission-line t-text mt-24">Or commission a playlist on <button class="chip" data-act="commission" data-q="' + esc(q) + '">' + esc(q) + '</button></p>';
      return out + empty('Nothing titled ‘' + q + '’.', 'Browse subjects', '#/search');
    }
    if (shows.length) out += section('Shows', '<ul>' + shows.slice(0, 5).map(rowShow).join('') + '</ul>' + (shows.length > 5 ? '<button class="btn-text">More shows (' + (shows.length - 5) + ')</button>' : ''));
    if (eps.length) out += section('Episodes', '<ul>' + eps.slice(0, 5).map(function (e) { return rowEp(e); }).join('') + '</ul>' + (eps.length > 5 ? '<button class="btn-text">More episodes (' + (eps.length - 5) + ')</button>' : ''));
    if (pls.length) out += section('Playlists', '<ul>' + pls.map(rowPlaylist).join('') + '</ul>');
    return out;
  }

  function upNextBlock() {
    var cur = S.cur && S.cur.kind === 'ep' ? S.cur.ep : null;
    var rows = '', i = 0;
    if (cur) rows += rowQueue(cur, 0, true);
    else if (S.cur && S.cur.kind === 'foray') rows += rowQueue({ kind: 'foray', id: F.id, title: F.title, arts: F.shows.map(function (x) { return x.artwork_url; }), duration_min: Math.round(F.total / 60) }, 0, true);
    S.queue.forEach(function (e) { if (cur && e.id === cur.id) return; rows += rowQueue(e, i, false); i++; });
    var count = S.queue.filter(function (e) { return !cur || e.id !== cur.id; }).length;
    var body = rows ? '<ul id="queue-list">' + rows + '</ul>' : empty('The queue is empty. 4a keeps playing after an item ends anyway.', 'Browse', '#/search');
    return '<section class="section" id="up-next"><div class="section-head t-label"><span>Up Next · <span class="roll" data-count><span>' + count + '</span></span></span>' + (count ? '<button class="btn-text" data-act="clear-q">Clear</button>' : '') + '</div>' + body + '</section>';
  }
  function viewLibrary() {
    var out = '<header><div class="page-title"><h1 class="t-d1">Library</h1></div><hr class="masthead-rule"></header>';
    var forays = '<ul>' + rowForayMain() + D.more_forays.map(rowForay).join('') + '</ul>' + foot('All forays', '#/library');
    out += section('Forays', forays, { meta: '3' });
    out += upNextBlock();
    out += section('Followed', '<div class="grid-4">' + S.followed.map(function (s) { return '<a class="cell" href="#/search?q=' + encodeURIComponent(s.name) + '" aria-label="' + esc(s.name) + '">' + plate(s.artwork_url, 'plate--grid', s.name) + '<span class="t-meta">' + esc(s.name) + '</span></a>'; }).join('') + '</div>', { meta: '8' });
    out += section('Saved', '<ul>' + S.saved.map(function (e) { return rowEp(e); }).join('') + '</ul>' + foot('All saved', '#/library'), { meta: '5' });
    out += section('Playlists', '<ul>' + D.playlists.map(rowPlaylist).join('') + '</ul>', { meta: String(D.playlists.length) });
    var days = ['Tuesday', 'Tuesday', 'Monday', 'Sunday', 'Saturday'];
    out += section('History', '<ul>' + S.history.map(function (e, i) { return rowEp(e, { meta: 'Played ' + days[i], noAdd: true }); }).join('') + '</ul>' + foot('All history', '#/library'));
    return out;
  }

  function contentsHTML(withNow) {
    var cur = S.cur && S.cur.kind === 'foray' ? segIndex() : -1;
    return '<ol class="contents" id="contents">' + F.segments.map(function (s, i) {
      var now = i === cur && withNow;
      var num = now ? ic('stitch', 'ic--16') : (s.narration ? ic('stitch', 'ic--20') : '<span class="t-num t-num--sm">' + s.n + '</span>');
      return '<li class="' + (now ? 'is-now' : '') + '"><button class="c-btn" data-act="seek-seg" data-i="' + i + '" aria-description="' + esc(fmtMin(s.duration_sec)) + '"><span class="c-num">' + num + '</span>' + (now ? '<span class="slug t-label">Playing</span>' : '') +
        '<span class="c-line"><span class="c-title">' + esc(s.title) + '</span><span class="c-lead"></span><span class="c-time">' + clock(s.start_sec) + '</span></span>' +
        '<span class="c-sub t-meta"><i' + (s.narration ? ' class="n"' : ' data-show="' + (s.show_idx % 8) + '"') + '></i>' + (s.narration ? '<span class="c-red">4a</span>' : esc(s.show)) + '</span></button></li>';
    }).join('') + '</ol>';
  }
  /* The row is the link; no trailing Open (it truncated every title in r1). */
  function cameFrom() {
    return section('Where this came from', '<ul>' + F.shows.map(function (s) {
      var seg = F.segments.filter(function (x) { return x.show === s.name; })[0];
      return '<li class="row row-show"><a class="row-plain" href="#/search?q=' + encodeURIComponent(s.name) + '">' + plate(s.artwork_url, 'plate--md', s.name) + '<span class="row-body"><span class="t-title clamp-1">' + esc(s.name) + '</span><span class="t-meta clamp-1">' + esc(seg ? seg.episode : '') + '</span></span></a></li>';
    }).join('') + '</ul>');
  }
  function viewForay() {
    var arts = F.shows.map(function (s) { return s.artwork_url; });
    var st = S.opts.fstate || 'unplayed';
    var prog = S.cur && S.cur.kind === 'foray' ? S.pos : (st === 'progress' ? 1120 : 0);
    var played = st === 'finished', un = st === 'unavailable';
    var act = prog > 5 ? 'Resume at ' + clock(prog) : (played ? 'Play again' : 'Play');
    var kick = 'A FORAY · ' + Math.round(F.total / 60) + ' MIN · ' + F.shows.length + ' SHOWS';
    var out = '<div class="nav-row"><button class="btn-icon" data-act="back" aria-label="Back">' + ic('caret-left') + '</button><div class="right"><button class="btn-icon" data-act="share" aria-label="Share">' + ic('share-network') + '</button><button class="btn-icon" data-act="foray-more" aria-label="More">' + ic('dots-three') + '</button></div></div>';
    out += '<div class="' + (un ? 'is-unavailable' : '') + '"><p class="kicker t-label mt-8">' + esc(kick) + '</p>' + (played ? '<p class="t-meta c-2">Played Tuesday</p>' : '') + '<h1 class="t-d1 mt-8">' + esc(F.title) + '</h1>';
    out += '<div class="mt-16" id="detail-plate-host">' + contact(arts, 'plate--lead') + '</div><div class="mt-12">' + strip(F.segments, 'strip--detail', { frac: prog / F.total, shows: F.shows.length, live: true }) + key() + '</div></div>';
    out += '<div class="mt-16">' + note(F.note) + '</div>';
    if (un) out += '<p class="notice t-text">' + ic('info', 'ic--20') + 'This foray can’t play right now: one show moved its audio. 4a re-checks tonight.<a class="btn-text" href="#/search?q=Business">Browse similar</a></p>';
    else out += '<div class="detail-actions"><button class="btn-play" data-act="play-foray" aria-label="' + esc(act) + '">' + ic(S.playing && S.cur && S.cur.kind === 'foray' ? 'pause-fill' : 'play-fill', 'ic--play') + '</button><span class="t-button">' + esc(act) + '</span>' + '<button class="btn-icon" data-act="toast-add" aria-label="Add to Up Next">' + ic('list-plus') + '</button><button class="btn-icon" data-act="toast-dl" aria-label="Download">' + ic('download-simple') + '</button></div>';
    out += section('Contents', contentsHTML(true));
    out += cameFrom();
    out += section('About', '<p class="t-text about-p">Eight ways to fund a company, cut from real podcast episodes and set in one order. Each segment keeps its show’s colour; 4a’s own narration is hatched in red. Audio plays from the publishers’ own feeds, untouched.</p><p class="t-meta c-3 mt-12">Assembled ' + esc(D.edition.assembled) + ' this morning</p>');
    return out;
  }

  /* ---------- render pipeline ---------- */
  var viewEl = null;
  function hydrate(root) {
    $$('[data-w]', root).forEach(function (e) { e.style.setProperty('--w', e.getAttribute('data-w')); });
    $$('[data-p]', root).forEach(function (e) { e.style.setProperty('--p', e.getAttribute('data-p')); });
    $$('[data-frac]', root).forEach(function (e) { paintFrac(e, parseFloat(e.getAttribute('data-frac'))); });
    fitKey(root); fitHooks(root);
  }
  function paintFrac(stripEl, frac) {
    var segs = $$('.seg', stripEl), total = 0, ws = segs.map(function (s) { var w = parseFloat(s.getAttribute('data-w')); total += w; return w; });
    var t = clamp(frac, 0, 1) * total, acc = 0, cur = 0, f = 0;
    segs.forEach(function (el, i) {
      var fi = clamp((t - acc) / ws[i], 0, 1); el.style.setProperty('--f', fi);
      if (t >= acc) { cur = i; f = fi; }
      acc += ws[i];
    });
    var cursor = $('.strip-cursor', stripEl);
    if (cursor) {
      if (frac <= 0) { cursor.hidden = true; return; }
      cursor.hidden = false;
      var el = segs[cur]; var x = el.offsetWidth ? el.offsetLeft + f * el.offsetWidth : clamp(frac, 0, 1) * stripEl.offsetWidth;
      cursor.style.setProperty('--px', x + 'px');
    }
  }
  function tabFor(page) { return page === 'search' ? 'browse' : page === 'library' ? 'library' : page === 'foray' ? S.fromTab : 'today'; }
  function setTab(page) {
    var t = tabFor(page);
    $$('#folio a').forEach(function (a) { if (a.getAttribute('data-tab') === t) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  }
  function renderPage(page, anim) {
    var html = page === 'search' ? viewSearch() : page === 'library' ? viewLibrary() : page === 'foray' ? viewForay() : viewHome();
    viewEl.removeAttribute('inert'); viewEl.style.removeProperty('transform'); $('#folio').removeAttribute('inert');
    viewEl.innerHTML = html;
    viewEl.className = 'view' + (anim ? ' view--' + anim : '') + (page === 'onboarding' ? ' onb-under' : '');
    hydrate(viewEl);
    setTab(page);
    document.body.setAttribute('data-page', page);
    document.body.setAttribute('data-find', page === 'search' ? '1' : '0');
    renderFind();
    renderTicker();
    if (page === 'foray') tintFor(F.shows[0].artwork_url, function (h) { viewEl.style.setProperty('--tint-h', h); });
  }
  function rerender() { var y = window.scrollY; renderPage(S.page); window.scrollTo(0, y); }

  /* ---------- find field ---------- */
  var findTimer = null;
  function renderFind() {
    var slot = $('#find-slot');
    if (S.page !== 'search') { slot.innerHTML = ''; return; }
    slot.innerHTML = '<div class="find chrome" role="search">' + ic('magnifying-glass', 'ic--20') + '<input type="search" id="find" placeholder="Find a show, episode or subject" aria-label="Find a show, episode or subject" autocomplete="off" enterkeyhint="search" value="' + esc(S.q) + '">' + (S.q ? '<button class="btn-icon" data-act="clear-find" aria-label="Clear">' + ic('x', 'ic--20') + '</button>' : '') + '</div>';
    var inp = $('#find');
    inp.addEventListener('input', function () {
      clearTimeout(findTimer);
      findTimer = setTimeout(function () {
        S.q = inp.value; var pos = inp.selectionStart;
        renderPageKeepFind(); }, 200);
    });
    inp.addEventListener('focus', function () { document.body.classList.add('kbd'); });
    inp.addEventListener('blur', function () { document.body.classList.remove('kbd'); });
  }
  function renderPageKeepFind() {
    var html = viewSearch(); viewEl.innerHTML = html; hydrate(viewEl);
    var has = !!S.q, existing = $('.find .btn-icon');
    if (has && !existing) { $('.find').insertAdjacentHTML('beforeend', '<button class="btn-icon" data-act="clear-find" aria-label="Clear">' + ic('x', 'ic--20') + '</button>'); }
    if (!has && existing) existing.remove();
  }

  /* ---------- ticker ---------- */
  function renderTicker() {
    var slot = $('#ticker-slot'), it = item();
    var show = !!it && S.page !== 'onboarding';
    document.body.setAttribute('data-ticker', show ? '1' : '0');
    if (!show) { slot.innerHTML = ''; return; }
    var key = it.kind + (it.kind === 'foray' ? '' : it.id), existing = $('.ticker', slot);
    if (existing && existing.getAttribute('data-key') === key) { updateTicker(); return; }
    var wasThere = !!existing;
    var label = 'Now playing: ' + it.title + ', ' + it.show + '. Open player';
    slot.innerHTML = '<div class="ticker chrome' + (wasThere ? '' : ' is-in') + '" id="ticker" data-key="' + esc(key) + '"><i class="ticker-progress" id="tk-prog"></i>' +
      '<button class="ticker-main" data-act="np-open" aria-label="' + esc(label) + '">' + plate(it.kind === 'foray' ? it.arts[0] : it.art, 'plate--xs', it.show) +
      '<span class="tk-text"><span class="t-ticker">' + esc(it.kind === 'foray' ? F.title : it.title) + '</span><span class="tk-show t-label">' + esc(it.show) + '</span></span></button>' +
      '<button class="btn-icon" data-act="toggle-play" id="tk-play" aria-label="' + (S.playing ? 'Pause' : 'Play') + '">' + ic(S.playing ? 'pause-fill' : 'play-fill') + '</button>' +
      '<button class="btn-icon" data-act="skip" data-d="30" aria-label="Forward 30 seconds">' + ic('skip-30') + '</button></div>';
    updateTicker();
    wireTicker($('#ticker'));
  }
  function updateTicker() {
    var tp = $('#tk-prog'); if (tp && S.cur) tp.style.setProperty('--p', (S.pos / item().dur * 100).toFixed(2));
    var b = $('#tk-play'); if (b) { b.innerHTML = ic(S.playing ? 'pause-fill' : 'play-fill'); b.setAttribute('aria-label', S.playing ? 'Pause' : 'Play'); }
  }
  function wireTicker(el) {
    var y0 = null, t0 = 0;
    el.addEventListener('pointerdown', function (e) { if (e.target.closest('.btn-icon')) return; y0 = e.clientY; t0 = e.timeStamp; });
    el.addEventListener('pointerup', function (e) {
      if (y0 == null) return; var dy = e.clientY - y0, v = dy / Math.max(1, e.timeStamp - t0); y0 = null;
      if (dy <= -24) { e.preventDefault(); location.hash = '#/now-playing'; }
      else if (dy >= 48 && v > 0.3) { stopWithUndo(); }
    });
  }
  function stopWithUndo() {
    var keep = { cur: S.cur, pos: S.pos, playing: S.playing };
    if (S.cur && S.cur.kind === 'ep') S.resume = { ep: S.cur.ep, pos: S.pos };
    S.cur = null; S.playing = false; renderTicker(); if (S.page === 'home' || S.page === 'mini') rerender();
    toast('Stopped', 'Undo', function () { S.cur = keep.cur; S.pos = keep.pos; S.playing = keep.playing; S.resume = null; renderTicker(); rerender(); });
  }

  /* ---------- toast ---------- */
  function toast(msg, action, fn) {
    var host = $('#toasts'), el = document.createElement('div'); el.className = 'toast';
    el.innerHTML = '<span class="t-meta">' + esc(msg) + '</span>' + (action ? '<button class="btn-text">' + esc(action) + '</button>' : '');
    host.innerHTML = ''; host.appendChild(el);
    var t = setTimeout(function () { el.remove(); }, 5000);
    if (action) $('button', el).addEventListener('click', function () { clearTimeout(t); el.remove(); fn && fn(); });
  }

  /* ---------- artwork tint ---------- */
  var tintCache = {};
  function hashHue(s) { var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360; return h; }
  function tintFor(url, cb) {
    if (tintCache[url] != null) { cb(tintCache[url]); return; }
    var fallback = hashHue(url);
    try {
      var img = new Image(); img.crossOrigin = 'anonymous';
      img.onload = function () {
        try {
          var c = document.createElement('canvas'); c.width = c.height = 16; var x = c.getContext('2d'); x.drawImage(img, 0, 0, 16, 16);
          var d = x.getImageData(0, 0, 16, 16).data, bins = {}, best = null, bs = 0;
          for (var i = 0; i < d.length; i += 4) {
            var r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, sat = mx === mn ? 0 : (mx - mn) / (1 - Math.abs(2 * l - 1));
            if (l < .15 || l > .9) continue; var h;
            if (mx === r) h = ((g - b) / (mx - mn) + 6) % 6; else if (mx === g) h = (b - r) / (mx - mn) + 2; else h = (r - g) / (mx - mn) + 4;
            var k = Math.round(h * 60 / 20) * 20 % 360; bins[k] = (bins[k] || 0) + sat;
          }
          Object.keys(bins).forEach(function (k) { if (bins[k] > bs) { bs = bins[k]; best = +k; } });
          tintCache[url] = best == null ? fallback : best;
        } catch (e) { tintCache[url] = fallback; }
        cb(tintCache[url]);
      };
      img.onerror = function () { tintCache[url] = fallback; cb(fallback); };
      img.src = safeUrl(url);
    } catch (e) { cb(fallback); }
  }

  /* ---------- sheets ---------- */
  var sheetStack = [];
  function syncInert() {
    var any = sheetStack.length > 0;
    ['#page', '#folio', '#ticker-slot', '#find-slot'].forEach(function (s) { var el = $(s); if (el) { if (any) el.setAttribute('inert', ''); else el.removeAttribute('inert'); } });
    sheetStack.forEach(function (sh, i) { if (i < sheetStack.length - 1) sh.el.setAttribute('inert', ''); else sh.el.removeAttribute('inert'); });
    document.body.classList.toggle('sheet-open', sheetStack.some(function (s) { return !s.np; }));
  }
  function openSheet(o) {
    var el = document.createElement('div'); el.className = 'sheet ' + (o.cls || ''); if (o.id) el.id = o.id;
    el.innerHTML = '<div class="sheet-scrim" data-act="sheet-close"></div><div class="sheet-panel ' + (o.panel || '') + '" role="dialog" aria-modal="true" aria-label="' + esc(o.label || '') + '" tabindex="-1">' + o.html + '</div>';
    $('#sheets').appendChild(el);
    var rec = { el: el, np: !!o.np, onClose: o.onClose, opener: document.activeElement };
    sheetStack.push(rec);
    var panel = $('.sheet-panel', el);
    if (o.after) o.after(el, panel);
    syncInert();
    if (o.instant) { el.classList.add('is-open'); } else { void panel.offsetWidth; requestAnimationFrame(function () { el.classList.add('is-open'); }); }
    var h = $('h1, h2, .sheet-title', panel); if (h) { h.setAttribute('tabindex', '-1'); try { h.focus({ preventScroll: true }); } catch (e) { } } else { try { panel.focus({ preventScroll: true }); } catch (e) { } }
    dismissable(rec, panel);
    return rec;
  }
  function closeSheet(rec, silent) {
    if (!rec || rec.closing) return; rec.closing = true;
    rec.el.classList.add('is-closing'); rec.el.classList.remove('is-open');
    var i = sheetStack.indexOf(rec); if (i >= 0) sheetStack.splice(i, 1);
    syncInert();
    setTimeout(function () { rec.el.remove(); }, reduceMotion ? 160 : 300);
    if (rec.opener && rec.opener.isConnected) { try { rec.opener.focus({ preventScroll: true }); } catch (e) { } }
    if (!silent && rec.onClose) rec.onClose();
  }
  function topSheet() { return sheetStack[sheetStack.length - 1]; }
  function dismissable(rec, panel) {
    var y0 = null, t0 = 0, dy = 0, h = 1;
    panel.addEventListener('pointerdown', function (e) {
      if (e.target.closest('button, input, a, .scrub')) return;
      if (panel.scrollTop > 0) return; if (e.clientY - panel.getBoundingClientRect().top > 120) return;
      e.preventDefault(); // r2 critique 4: a drag must never start a text selection
      y0 = e.clientY; t0 = e.timeStamp; dy = 0; h = panel.offsetHeight; panel.setPointerCapture && panel.setPointerCapture(e.pointerId);
    });
    panel.addEventListener('pointermove', function (e) {
      if (y0 == null) return; dy = Math.max(0, e.clientY - y0); panel.classList.add('is-dragging'); panel.style.setProperty('transform', 'translateY(' + dy + 'px)');
      if (rec.np) { var p = clamp(dy / h, 0, 1); $('#page').style.setProperty('transform', 'scale(' + (0.96 + 0.04 * p) + ')'); }
    });
    function end(e) {
      if (y0 == null) return; var v = dy / Math.max(1, e.timeStamp - t0); y0 = null; panel.classList.remove('is-dragging'); panel.style.removeProperty('transform'); $('#page').style.removeProperty('transform');
      if (dy / h > .35 || v > .6) { if (rec.np) location.hash = '#/' + (S.under === 'home' && S.cur ? 'mini' : S.under); else closeSheet(rec); }
      dy = 0;
    }
    panel.addEventListener('pointerup', end); panel.addEventListener('pointercancel', end);
  }
  function actionSheet(title, opts, label) {
    var html = '<h2 class="t-label c-2 sheet-title">' + esc(title) + '</h2><div class="sheet-list">' + opts.map(function (o, i) {
      return '<button class="sheet-opt' + (o.on ? ' is-on' : '') + '" data-opt="' + i + '">' + (o.icon ? ic(o.icon, 'ic--20') : '') + esc(o.label) + (o.meta ? '<span class="t-meta">' + esc(o.meta) + '</span>' : '') + '</button>';
    }).join('') + '</div>';
    var rec = openSheet({ html: html, label: label || title, cls: 'action' });
    $$('.sheet-opt', rec.el).forEach(function (b) { b.addEventListener('click', function () { var o = opts[+b.getAttribute('data-opt')]; closeSheet(rec); if (o.fn) o.fn(); }); });
    return rec;
  }

  /* ---------- Now Playing ---------- */
  var npRec = null, npDrag = false;
  function npHTML() {
    var it = item(), isF = it.kind === 'foray', up = S.queue.filter(function (e) { return !(S.cur.kind === 'ep' && e.id === S.cur.ep.id); });
    var nextTitle = up[0] ? up[0].title : 'nothing queued';
    var scrub = isF ? strip(F.segments, 'strip--np', { shows: F.shows.length, live: true }) : '<div class="track"><i class="track-fill"></i><b class="strip-cursor" aria-hidden="true"></b></div>';
    return '<div class="np-first"><div class="np-head"><span class="t-label c-2" id="np-label">' + (isF ? 'A foray' : 'Now playing') + '</span>' +
      '<button class="btn-text btn-text--quiet" data-act="peek" aria-label="Up next: ' + esc(nextTitle) + '"><span>Up next: ' + esc(nextTitle) + '</span>' + ic('caret-down', 'ic--20') + '</button></div>' +
      '<div class="np-plate-region"><div class="np-plate" id="np-plate">' + (isF ? contact(it.arts, 'plate--sq') : plate(it.art, 'plate--sq', it.show)) + '</div></div>' +
      '<div class="np-scrub"><div class="scrub" id="scrub">' + scrub + '<span class="time-bubble" id="bubble">0:00</span><input type="range" id="range" min="0" max="' + Math.round(it.dur) + '" step="1" value="0" aria-label="Playback position"></div>' +
      '<div class="clocks t-meta"><span id="clk-a">0:00</span><span id="clk-b">−0:00</span></div><div class="keyline t-meta" id="keyline"></div></div>' +
      '<div class="np-titles"><h1 class="t-d2" id="np-title">' + esc(it.title) + '</h1>' + (isF ? '<p class="np-seg t-text c-2" id="np-show">' + esc(it.segTitle) + '</p>' : '<a class="t-label" id="np-show" href="#/search?q=' + encodeURIComponent(it.show) + '">' + esc(it.show) + '</a>') + '<p class="note" id="np-note" data-act="note-toggle"><span class="t-note">' + esc(it.note) + '</span></p></div>' +
      '<div class="np-transport"><button class="btn-skip" data-act="skip" data-d="-15" aria-label="Back 15 seconds">' + ic('skip-15') + '</button><button class="btn-play btn-play--80" data-act="toggle-play" id="np-play" aria-label="Pause">' + ic('pause-fill', 'ic--play') + '</button><button class="btn-skip" data-act="skip" data-d="30" aria-label="Forward 30 seconds">' + ic('skip-30') + '</button></div>' +
      '<div class="np-actions"><button class="btn-labelled" data-act="speed" id="np-speed"><span class="speed">' + (S.speed === 1 ? '1×' : S.speed + '×') + '</span>Speed</button><button class="btn-labelled" data-act="sleep">' + ic('moon') + 'Sleep</button>' +
      '<button class="btn-labelled" data-act="bookmark" id="np-bm" aria-pressed="' + S.bookmarked + '">' + ic(S.bookmarked ? 'bookmark-simple-fill' : 'bookmark-simple') + 'Bookmark</button>' +
      '<button class="btn-labelled" data-act="peek" aria-label="Up Next, ' + up.length + ' items">' + ic('queue') + 'Up Next · ' + up.length + '</button><button class="btn-labelled" data-act="np-more">' + ic('dots-three') + 'More</button></div></div>' +
      '<div class="np-sticky"><div class="np-sticky-inner chrome"><div class="scrub" id="scrub2">' + (isF ? strip(F.segments, 'strip--np', { live: true }) : '<div class="track"><i class="track-fill"></i><b class="strip-cursor" aria-hidden="true"></b></div>') + '</div><div class="clocks t-meta"><span id="clk-a2">0:00</span><span id="clk-b2">−0:00</span></div></div></div>' +
      '<div class="np-detail">' + npDetail(it) + '</div>';
  }
  function npDetail(it) {
    var out = '';
    if (it.kind === 'foray') {
      out += section('Contents', contentsHTML(true));
      out += cameFrom();
      out += section('Notes', '<p class="t-text about-p">' + esc(F.note) + ' Segments are cut from the publishers’ own episodes and play from their original files.</p>');
    } else {
      out += section('Notes', '<p class="t-text about-p">' + esc(it.ep.note) + ' Show notes arrive with the episode from ' + esc(it.ep.show) + '.</p>');
    }
    var up = S.queue.filter(function (e) { return !(S.cur.kind === 'ep' && e.id === S.cur.ep.id); }).slice(0, 3);
    out += section('Up Next', '<ul>' + up.map(function (e, i) { return rowQueue(e, i, false); }).join('') + '</ul><div class="section-foot"><a class="btn-foot t-meta" href="#/library/up-next" data-act="all-queue">All of Up Next' + ic('arrow-right', 'ic--16') + '</a></div>', { meta: String(S.queue.length) });
    return out;
  }
  function openNP(fromRect) {
    if (npRec || !S.cur) return;
    S.npOpen = true;
    var it = item();
    npRec = openSheet({ id: 'sheet-np', cls: 'np', np: true, html: npHTML(), label: 'Now playing', instant: !booted || webdriver,
      onClose: function () { npRec = null; S.npOpen = false; document.body.classList.remove('np-open'); } });
    document.body.classList.add('np-open');
    var el = npRec.el;
    hydrate(el);
    wireNP(el);
    tintFor(it.kind === 'foray' ? it.arts[0] : it.art, function (h) { $('.sheet-panel', el).style.setProperty('--tint-h', h); });
    npUpdate(true);
    if (fromRect && !reduceMotion && !webdriver) flyPlate(fromRect, el);
  }
  /* The page turn. The plate is the shared element; the title and the progress rule fly with it. Only transform
     and opacity animate. */
  function flyPlate(from, el) {
    var target = $('#np-plate .plate', el); if (!target) return;
    var panel = $('.sheet-panel', el), nt = $('#np-title', el), sc = $('#scrub .strip, #scrub .track', el);
    panel.style.setProperty('transition', 'none'); panel.style.setProperty('transform', 'none');
    var to = target.getBoundingClientRect(), nr = nt && nt.getBoundingClientRect(), sr = sc && sc.getBoundingClientRect();
    panel.style.removeProperty('transform'); void panel.offsetWidth; panel.style.removeProperty('transition');
    var src = $('.ticker .plate img'); if (!src) return;
    var fly = document.createElement('div'); fly.className = 'fly'; fly.innerHTML = '<img alt="" src="' + esc(safeUrl(src.src)) + '">';
    fly.style.setProperty('left', from.left + 'px'); fly.style.setProperty('top', from.top + 'px'); fly.style.setProperty('width', from.width + 'px'); fly.style.setProperty('height', from.height + 'px');
    document.body.appendChild(fly); target.style.setProperty('opacity', '0');
    var s = to.width / from.width, EASE = 'cubic-bezier(.2,.7,.2,1)';
    var a = fly.animate([{ transform: 'translate(0,0) scale(1)' }, { transform: 'translate(' + (to.left - from.left) + 'px,' + (to.top - from.top) + 'px) scale(' + s + ')' }], { duration: 420, easing: EASE, fill: 'forwards' });
    a.onfinish = function () { target.style.removeProperty('opacity'); fly.remove(); };
    a.oncancel = a.onfinish;
    var tk = $('#ticker');
    // r2 critique (should-fix): the title cross-fades in place; only the plate and the rule fly.
    if (nt) { nt.animate([{ opacity: 0 }, { opacity: 0, offset: .3 }, { opacity: 1 }], { duration: 420, easing: 'linear' }); }
    if (tk && sr) {
      var kr = tk.getBoundingClientRect(), fr = document.createElement('div'); fr.className = 'fly-rule';
      fr.style.setProperty('left', sr.left + 'px'); fr.style.setProperty('top', (sr.top + sr.height / 2 - 1) + 'px'); fr.style.setProperty('width', sr.width + 'px');
      document.body.appendChild(fr);
      var d = fr.animate([{ transform: 'translate(' + (kr.left - sr.left) + 'px,' + (kr.top - (sr.top + sr.height / 2 - 1)) + 'px) scaleX(' + (kr.width / sr.width) + ')', opacity: 1, transformOrigin: '0 50%' }, { transform: 'none', opacity: 1, offset: .75, transformOrigin: '0 50%' }, { transform: 'scaleY(3)', opacity: 0, transformOrigin: '0 50%' }], { duration: 420, easing: EASE, fill: 'forwards' });
      d.onfinish = function () { fr.remove(); };
    }
  }
  function closeNP(silent) { if (npRec) { var r = npRec; npRec = null; S.npOpen = false; document.body.classList.remove('np-open'); closeSheet(r, true); } }
  function npUpdate(force) {
    if (!npRec) return; var el = npRec.el, it = item(); if (!it) return;
    var pos = S.pos, dur = it.dur, isF = it.kind === 'foray';
    var range = $('#range', el); if (range && !npDrag) range.value = Math.round(pos);
    $('#clk-a', el).textContent = clock(pos); $('#clk-b', el).textContent = '−' + clock(dur - pos);
    $('#clk-a2', el).textContent = clock(pos); $('#clk-b2', el).textContent = '−' + clock(dur - pos);
    range && range.setAttribute('aria-valuetext', spoken(pos) + ' of ' + fmtMin(dur));
    var scrub = $('#scrub', el); scrub.style.setProperty('--p', (pos / dur * 100).toFixed(2)); $('#bubble', el).textContent = clock(pos);
    if (isF) {
      $$('.strip', el).forEach(function (st) { paintFrac(st, pos / dur); });
      var i = segIndex(), sg = F.segments[i], left = Math.max(0, Math.round(sg.start_sec + sg.duration_sec - pos));
      $('#keyline', el).innerHTML = sg.narration ? ic('stitch', 'ic--16') + '<span class="ell">4a · narration · ' + left + ' s left</span>' : '<span class="nw">' + sg.n + ' of ' + F.core + '</span><span class="sep" aria-hidden="true">·</span><span class="ell">' + esc(sg.show) + '</span><span class="sep" aria-hidden="true">·</span><span class="nw">' + (left >= 60 ? Math.round(left / 60) + ' min' : left + ' s') + ' left</span>';
      var show = $('#np-show', el); show.textContent = sg.title;
      if (S.segIdx !== i || force) {
        S.segIdx = i; $$('.strip--np .seg', el).forEach(function (s2, k) { s2.classList.toggle('is-now', k === i); });
        setTimeout(function () { $$('.strip--np .seg.is-now', el).forEach(function (s2) { s2.classList.remove('is-now'); }); }, 200);
        $$('#contents li', el).forEach(function (li, k) { li.classList.toggle('is-now', k === i); });
        var cl = $('#contents', el); if (cl) cl.outerHTML = contentsHTML(true), hydrate(el);
      }
    } else {
      $$('.track', el).forEach(function (t) { t.style.setProperty('--p', (pos / dur * 100).toFixed(2)); var c = $('.strip-cursor', t); if (c) c.style.setProperty('--px', (pos / dur * t.offsetWidth) + 'px'); });
      $('#keyline', el).textContent = '';
    }
    var pb = $('#np-play', el); pb.innerHTML = ic(S.playing ? 'pause-fill' : 'play-fill', 'ic--play'); pb.setAttribute('aria-label', S.playing ? 'Pause' : 'Play');
    el.classList.toggle('is-buffering', S.buffering);
    var lab = $('#np-label', el); lab.textContent = isF ? 'A foray' : 'Now playing';
  }
  function wireNP(el) {
    var range = $('#range', el), sc = $('#scrub', el);
    range.addEventListener('pointerdown', function () { npDrag = true; sc.classList.add('is-drag'); });
    range.addEventListener('input', function () { S.pos = +range.value; npUpdate(); updateTicker(); });
    function up() { npDrag = false; sc.classList.remove('is-drag'); }
    range.addEventListener('pointerup', up); range.addEventListener('pointercancel', up); range.addEventListener('change', up);
    range.addEventListener('keydown', function () { sc.classList.add('is-drag'); setTimeout(function () { sc.classList.remove('is-drag'); }, 600); });
    var panel = $('.sheet-panel', el);
    panel.addEventListener('keydown', function (e) { if (e.key === 'Escape') location.hash = '#/' + (S.under === 'home' && S.cur ? 'mini' : S.under); });
  }

  /* ---------- playback simulation ---------- */
  function startItem(cur, pos) {
    var firstTime = !S.cur;
    S.cur = cur; S.pos = pos || 0; S.playing = true; S.segIdx = -1; S.firstEdition = false;
    renderTicker();
    if (S.page === 'home' || S.page === 'mini' || S.page === 'foray') rerender();
    if (npRec) { var r = npRec; closeNP(); }
  }
  function tick() {
    if (!S.playing || !S.cur || webdriver) return;
    S.pos += 0.25 * S.speed; var it = item();
    if (S.pos >= it.dur) { advance(); return; }
    updateTicker(); npUpdate();
  }
  function advance() {
    var next = S.queue.filter(function (e) { return !(S.cur.kind === 'ep' && e.id === S.cur.ep.id); })[0];
    if (!next) { S.playing = false; S.pos = item().dur; updateTicker(); npUpdate(); return; }
    S.queue = S.queue.filter(function (e) { return e !== next && !(S.cur.kind === 'ep' && e.id === S.cur.ep.id); });
    S.cur = { kind: 'ep', ep: next }; S.pos = 0; S.segIdx = -1;
    renderTicker();
    if (npRec) { var el = npRec.el; el.classList.add('np-flash'); var kept = npRec; closeNP(); openNP(null); }
    if (S.page === 'library') rerender();
  }
  setInterval(tick, 250);

  /* ---------- queue ---------- */
  function flipList(listEl, mutate) {
    var before = {}; $$('[data-key]', listEl).forEach(function (r) { before[r.getAttribute('data-key')] = r.getBoundingClientRect(); });
    mutate();
    if (reduceMotion) return;
    var nl = $('#queue-list'); if (!nl) return;
    $$('[data-key]', nl).forEach(function (r) {
      var k = r.getAttribute('data-key'), b = before[k], a = r.getBoundingClientRect();
      if (b) { var dy = b.top - a.top; if (dy) r.animate([{ transform: 'translateY(' + dy + 'px)' }, { transform: 'none' }], { duration: 200, easing: 'cubic-bezier(.2,.7,.2,1)' }); }
      else r.animate([{ opacity: 0, transform: 'translateY(-8px)' }, { opacity: 1, transform: 'none' }], { duration: 200, easing: 'cubic-bezier(.2,.7,.2,1)' });
    });
  }
  function bumpCount() {
    $$('[data-count]').forEach(function (c) {
      var n = S.queue.filter(function (e) { return !(S.cur && S.cur.kind === 'ep' && e.id === S.cur.ep.id); }).length;
      var inner = c.firstElementChild; if (!inner) return;
      if (reduceMotion) { inner.textContent = n; return; }
      c.classList.add('is-rolling'); setTimeout(function () { inner.textContent = n; c.classList.remove('is-rolling'); }, 120);
    });
  }
  function addToQueue(e, srcEl) {
    if (inQueue(e.id)) return;
    S.queue.push(e);
    var btn = srcEl && srcEl.closest('[data-act="add"]');
    if (btn) { btn.innerHTML = ic('check'); btn.setAttribute('aria-pressed', 'true'); btn.setAttribute('aria-label', 'In Up Next: ' + e.title); }
    var pl = srcEl && srcEl.closest('.row, .splat-item');
    var img = pl && $('.plate img', pl), tab = $('#folio a[data-tab="library"]');
    if (img && tab && !reduceMotion) {
      var r = img.getBoundingClientRect(), t = tab.getBoundingClientRect(); var fly = document.createElement('div'); fly.className = 'fly';
      fly.innerHTML = '<img alt="" src="' + esc(safeUrl(img.src)) + '">';
      ['left:' + r.left, 'top:' + r.top, 'width:' + r.width, 'height:' + r.height].forEach(function (p) { var kv = p.split(':'); fly.style.setProperty(kv[0], kv[1] + 'px'); });
      document.body.appendChild(fly);
      var s = 24 / r.width, tx = t.left + t.width / 2 - 12 - r.left, ty = t.top + 4 - r.top;
      var a = fly.animate([{ transform: 'translate(0,0) scale(1)', opacity: 1 }, { transform: 'translate(' + tx + 'px,' + ty + 'px) scale(' + s + ')', opacity: 1, offset: .85 }, { transform: 'translate(' + tx + 'px,' + ty + 'px) scale(' + s + ')', opacity: 0 }], { duration: 360, easing: 'cubic-bezier(.5,0,.8,.2)' });
      a.onfinish = function () { fly.remove(); var g = $('.ic-on', tab); tab.classList.remove('bump'); void tab.offsetWidth; tab.classList.add('bump'); };
    }
    bumpCount();
    toast('Added to Up Next', 'Undo', function () { S.queue = S.queue.filter(function (x) { return x.id !== e.id; }); bumpCount(); rerender(); });
    if (S.page === 'library') { var list = $('#queue-list'); if (list) flipList(list, function () { var ul = $('#up-next'); ul.outerHTML = upNextBlock(); hydrate(viewEl); }); else rerender(); }
  }
  function moveInQueue(id, d) {
    var i = -1; S.queue.forEach(function (e, k) { if (e.id === id) i = k; }); var j = i + d; if (i < 0 || j < 0 || j >= S.queue.length) return;
    var list = $('#queue-list'); var swap = function () { var t = S.queue[i]; S.queue[i] = S.queue[j]; S.queue[j] = t; $('#up-next').outerHTML = upNextBlock(); hydrate(viewEl); };
    list ? flipList(list, swap) : swap();
  }
  function removeFromQueue(id) {
    var idx = -1, e; S.queue.forEach(function (x, k) { if (x.id === id) { idx = k; e = x; } });
    if (idx < 0) return; var list = $('#queue-list');
    var rm = function () { S.queue.splice(idx, 1); $('#up-next').outerHTML = upNextBlock(); hydrate(viewEl); bumpCount(); };
    list ? flipList(list, rm) : rm();
    toast('Removed', 'Undo', function () { var l2 = $('#queue-list'); var ins = function () { S.queue.splice(idx, 0, e); $('#up-next').outerHTML = upNextBlock(); hydrate(viewEl); bumpCount(); }; l2 ? flipList(l2, ins) : ins(); });
  }
  function playEp(e) {
    var i = S.queue.indexOf(e); if (i >= 0) S.queue.splice(i, 1);
    if (S.cur && S.cur.kind === 'ep' && S.cur.ep.id !== e.id) { /* old current drops off, the queue after it stays */ }
    startItem({ kind: 'ep', ep: e }, 0);
  }

  /* ---------- sheets: colophon, why, peek ---------- */
  function openColophon() {
    var interests = D.subjects.slice(0, 8), words = ['more', 'usual', 'usual', 'more', 'less', 'usual', 'usual', 'less'];
    var html = '<h2 class="t-d2 sheet-title">Colophon</h2>' +
      section('Edition', '<div class="setting"><span class="t-text">Scheme</span><span class="chips" role="group" aria-label="Scheme">' + ['paper:Paper', 'night:Night', 'auto:Follow system'].map(function (p) { var v = p.split(':'); return '<button class="chip" data-act="scheme" data-v="' + v[0] + '" aria-pressed="' + ((S.opts.scheme || S.scheme) === v[0]) + '">' + v[1] + '</button>'; }).join('') + '</span></div>' +
        '<div class="setting"><span class="t-text">Large print</span><button class="switch" role="switch" data-act="large" aria-checked="' + largeOn() + '" aria-label="Large print"></button></div>' +
        '<p class="t-meta c-3 mt-8">Text size follows your phone’s text size.</p>') +
      section('Interests', '<ul>' + interests.map(function (s, i) { return '<li class="row-subject"><span class="t-title t-title--sm">' + esc(s.name) + '</span><span class="t-meta weight">' + words[i] + '</span></li>'; }).join('') + '</ul><div class="section-foot"><button class="btn-text">Reset</button><button class="btn-text">All interests</button></div>') +
      section('About', '<p class="t-text about-p">4a is a daily listening edition set from real podcasts. About a third is picked to stretch you, and 4a says why, every time. Audio plays from the publishers’ own files.</p><p class="t-meta c-3 mt-12">Prototype 0.1 · Open source licences</p>');
    var rec = openSheet({ html: html, label: 'Colophon', panel: 'sheet-panel--tall', onClose: function () { if (/colophon/.test(location.hash)) location.hash = '#/' + S.under; } });
    return rec;
  }
  function openWhy() {
    openSheet({ label: 'Why these', html: '<h2 class="t-d2 sheet-title">Why these?</h2><p class="t-text mt-16">Every morning 4a sets one edition from what you finished, saved and skipped. The lead is a foray, cut from several shows.</p><p class="t-text mt-12">About a third of the page is picked to stretch you, and each of those says what it borders. That share is printed in the dateline, every day.</p><p class="t-text mt-12">Nothing here is sponsored, and no streak is counted.</p>' });
  }
  function openPeek() {
    var up = S.queue.filter(function (e) { return !(S.cur && S.cur.kind === 'ep' && e.id === S.cur.ep.id); }).slice(0, 5);
    var first = up[0];
    var html = '<h2 class="t-d2 sheet-title">Up Next</h2><ul class="mt-16">' + up.map(function (e, i) { return rowQueue(e, i, false); }).join('') + '</ul>' + (first && first.auto ? note('Added by 4a under the stretch rule: reused stone, adjacent to your business picks.') : '') + '<div class="section-foot mt-12"><a class="btn-foot t-meta" href="#/library/up-next" data-act="all-queue">All of Up Next' + ic('arrow-right', 'ic--16') + '</a></div>';
    openSheet({ html: html, label: 'Up Next' });
  }
  function qMenu(id) {
    var e = epById(id);
    actionSheet(e ? e.title : 'Item', [
      { label: 'Play next', icon: 'arrow-up', fn: function () { var i = S.queue.indexOf(e); if (i > 0) { S.queue.splice(i, 1); S.queue.unshift(e); rerender(); } } },
      { label: 'Move up', icon: 'arrow-up', fn: function () { moveInQueue(id, -1); } },
      { label: 'Move down', icon: 'arrow-down', fn: function () { moveInQueue(id, 1); } },
      { label: 'Remove', icon: 'x', fn: function () { removeFromQueue(id); } }
    ], 'Queue actions');
  }

  /* ---------- router ---------- */
  function applyParams(q) {
    var o = S.opts = S.opts || {};
    ['state', 'np', 'scheme', 'text', 'kbd', 'progress', 'fstate', 'large', 'vt', 'dl', 'cur', 'noart'].forEach(function (k) { if (q.has(k)) o[k] = q.get(k); });
    S.offline = o.state === 'offline'; S.loading = o.state === 'loading';
    S.vt = o.vt !== '0'; S.noart = o.noart === '1';
    if (o.text) document.documentElement.setAttribute('data-text', o.text);
    document.body.classList.toggle('kbd', o.kbd === '1');
    applyScheme(); applyLarge();
  }
  // A URL param reaches the DOM only. The store holds the listener's own choice, written by the Colophon alone.
  function applyScheme() {
    var r = document.documentElement, v = S.opts.scheme || S.scheme;
    if (v === 'auto') r.removeAttribute('data-scheme'); else r.setAttribute('data-scheme', v);
  }
  function largeOn() { return S.opts.large === '1' || S.large; }
  function applyLarge() { document.documentElement.classList.toggle('large-print', largeOn()); }
  function parseHash() {
    var h = location.hash.replace(/^#\/?/, ''), i = h.indexOf('?'), name = (i < 0 ? h : h.slice(0, i)) || 'home', q = new URLSearchParams(i < 0 ? '' : h.slice(i + 1));
    return { name: name, q: q };
  }
  function seedMid() {
    if (S.cur) return; S.cur = { kind: 'ep', ep: ep('Odd Lots') }; S.pos = 18 * 60 + 12; S.playing = true; seedQueue();
  }
  function seedForay(opts) {
    S.cur = { kind: 'foray' }; var si = 8; S.pos = F.segments[si].start_sec + 40; S.playing = true; S.queue = S.queue.length ? S.queue : []; seedQueue();
    if (opts.np === 'paused') S.playing = false; if (opts.np === 'buffering') S.buffering = true;
    if (opts.np === 'episode') { S.cur = { kind: 'ep', ep: ep('Odd Lots') }; S.pos = 18 * 60 + 12; }
  }
  var booted = false;
  function onRoute() {
    var r = parseHash(), name = r.name;
    if (name.indexOf('library/') === 0) name = 'library';
    applyParams(r.q);
    var o = S.opts;
    if (!S.queue.length) seedQueue();
    if (name === 'now-playing') {
      if (!S.cur || o.np) seedForay(o);
      if (!S.page) { S.page = 'home'; renderPage('home'); }
      S.under = S.under || 'home'; if (!npRec) openNP(ticketRect());
      return;
    }
    if (npRec) closeNP();
    var topSh = topSheet(); if (topSh && name !== 'colophon') { /* page-level sheets stay open on navigation */ }
    if (name === 'colophon') {
      if (!S.page) { S.page = 'home'; renderPage('home'); }
      if (!sheetStack.some(function (s) { return s.el.querySelector('[aria-label="Colophon"]'); })) openColophon();
      return;
    }
    sheetStack.slice().forEach(function (s) { closeSheet(s, true); });
    var page = name === 'mini' ? 'home' : (['home', 'search', 'library', 'foray', 'onboarding'].indexOf(name) >= 0 ? name : 'home');
    if (name === 'mini') seedMid();
    if (name === 'library' && !S.cur) { if (o.cur === 'foray') { S.cur = { kind: 'foray' }; S.pos = F.segments[8].start_sec + 40; S.playing = true; seedQueue(); } else seedMid(); }
    if (o.state === 'mid-listen' && !S.cur && !S.resume) S.resume = { ep: ep('Odd Lots'), pos: 18 * 60 + 12 };
    if (o.state === 'first-run') { S.mode = 'first'; } else if (name === 'onboarding') { S.mode = 'first'; } else { S.mode = 'returning'; }
    if (name === 'library' || name === 'search') S.fromTab = name === 'library' ? 'library' : 'browse';
    if (page === 'home' || name === 'mini') S.fromTab = 'today';
    var q = r.q.get('q'); if (q != null) S.q = q; else if (page === 'search' && S.page !== 'search') S.q = '';
    var prev = S.page; S.under = name === 'mini' ? 'mini' : (page === 'onboarding' ? 'home' : name);
    var push = prev && prev !== page && page === 'foray', pop = prev === 'foray' && page !== 'foray';
    var same = prev === page && !(page === 'search' && q != null);
    S.page = page;
    document.body.classList.toggle('is-onb', page === 'onboarding');
    if (booted && same && name !== 'onboarding') { setTab(page); return; }
    var go = function () { renderPage(page, booted && !push && !pop ? 'enter' : ''); if (page === 'onboarding') renderOnboarding(); else $('#onb').innerHTML = ''; };
    if (booted && (push || pop) && document.startViewTransition && S.vt && !reduceMotion) {
      if (pop) document.documentElement.classList.add('vt-back');
      var srcPlate = push ? S.lastPlate : null;
      if (srcPlate) srcPlate.style.setProperty('view-transition-name', 'detail-plate');
      var vt = document.startViewTransition(function () {
        if (srcPlate) srcPlate.style.removeProperty('view-transition-name');
        go(); var dp = $('#detail-plate-host .plate'); if (dp && push) dp.style.setProperty('view-transition-name', 'detail-plate'); window.scrollTo(0, 0);
      });
      vt.finished.finally(function () { document.documentElement.classList.remove('vt-back'); var dp = $('#detail-plate-host .plate'); if (dp) dp.style.removeProperty('view-transition-name'); });
    } else { go(); if (booted && prev !== page) window.scrollTo(0, 0); else if (!booted) window.scrollTo(0, 0); }
    if (S.opts.kbd === '1' && page === 'search') { var inp = $('#find'); inp && inp.focus(); }
  }
  function ticketRect() { var p = $('.ticker .plate'); return p ? p.getBoundingClientRect() : null; }

  /* ---------- onboarding ---------- */
  function renderOnboarding() {
    var host = $('#onb'); host.innerHTML = '<div class="veil top"></div><div class="veil-cut"></div><div class="veil bot"></div>' +
      '<div class="onb-content"><div class="onb-top"><span class="t-masthead">4a</span><p class="t-label">FIRST EDITION · ' + esc(dateParts().dm) + '</p><hr class="masthead-rule"><h1 class="t-d1">A daily listening edition, set from real podcasts, around you.</h1>' + note('About a third is picked to stretch you. 4a says why, every time.') + '</div><div class="onb-spacer"></div>' +
      '<div class="first-actions"><a class="btn-primary" href="#/home" data-act="onb-open">Open today’s edition</a><a class="btn-secondary" href="#/home" data-act="onb-skip">Not now</a></div></div>';
    viewEl.setAttribute('inert', ''); $('#folio').setAttribute('inert', ''); $('#folio').hidden = false;
    requestAnimationFrame(function () { placeVeil(); });
    setTimeout(placeVeil, 120);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(placeVeil);
  }
  /* The real first edition shows through a 70% veil; over the lead plate the veil is 40% (.veil-cut), so the
     one thing the veil is meant to let through is visible. The action band is solid page and covers the
     real page's meta row and play circle. */
  function placeVeil() {
    var host = $('#onb'); if (!host || !host.firstChild) return;
    var content = $('.onb-top', host), lead = $('.lead .plate', viewEl); if (!content || !lead) return;
    var H = window.innerHeight, bottom = content.getBoundingClientRect().bottom + 16;
    viewEl.style.removeProperty('transform');
    var shift = bottom - lead.getBoundingClientRect().top;
    viewEl.style.setProperty('transform', 'translateY(' + shift + 'px)');
    var r = lead.getBoundingClientRect();
    var top = $('.veil.top', host), cut = $('.veil-cut', host), bot = $('.veil.bot', host);
    top.style.setProperty('top', '0'); top.style.setProperty('height', Math.max(0, r.top) + 'px');
    cut.style.setProperty('top', r.top + 'px'); cut.style.setProperty('height', r.height + 'px');
    bot.style.setProperty('top', r.bottom + 'px'); bot.style.setProperty('height', Math.max(0, H - r.bottom) + 'px');
  }

  /* ---------- events ---------- */
  document.addEventListener('error', function (e) {
    var t = e.target; if (t && t.tagName === 'IMG' && t.parentNode) {
      var p = t.parentNode; p.classList.add('is-fb'); var ini = p.querySelector('.initial'); if (ini) ini.classList.remove('initial--late'); t.remove();
    }
  }, true);
  window.addEventListener('keydown', function (e) { if (e.key === 'Escape') { var s = topSheet(); if (s && !s.np) closeSheet(s); } });
  document.addEventListener('click', function (ev) {
    var el = ev.target.closest('[data-act]'); if (!el) return;
    var act = el.getAttribute('data-act'), id = el.getAttribute('data-id');
    if (act === 'open-foray') { var pl = $('.plate', el); S.lastPlate = pl; return; }
    if (act === 'play-foray') { ev.preventDefault(); ev.stopPropagation(); if (S.cur && S.cur.kind === 'foray') { S.playing = !S.playing; updateTicker(); if (S.page === 'foray') rerender(); return; } startItem({ kind: 'foray' }, 0); return; }
    if (act === 'play-ep') { ev.preventDefault(); var e = epById(id); if (e && !(S.offline && offlineDim(e))) playEp(e); return; }
    if (act === 'resume') { ev.preventDefault(); location.hash = '#/now-playing?np=episode'; return; }
    if (act === 'add') { ev.preventDefault(); var e2 = epById(id); if (e2) addToQueue(e2, el); return; }
    if (act === 'np-open') { ev.preventDefault(); S.under = S.page === 'home' ? 'mini' : S.page; location.hash = '#/now-playing'; return; }
    if (act === 'toggle-play') { S.playing = !S.playing; updateTicker(); npUpdate(); return; }
    if (act === 'skip') { var d = +el.getAttribute('data-d'); S.pos = clamp(S.pos + d, 0, item().dur - 1); updateTicker(); npUpdate(); return; }
    if (act === 'peek') { openPeek(); return; }
    if (act === 'note-toggle') { el.classList.toggle('is-open'); return; }
    if (act === 'speed') { actionSheet('Speed', [0.8, 1, 1.25, 1.5, 2, 2.5].map(function (v) { return { label: (v === 1 ? '1' : v) + '×', on: S.speed === v, meta: v === 1 ? 'Narration stays at 1×' : '', fn: function () { S.speed = v; var b = $('#np-speed .speed'); if (b) b.textContent = v + '×'; } }; })); return; }
    if (act === 'sleep') { actionSheet('Sleep', ['15 minutes', '30 minutes', '45 minutes', 'End of this item', 'Off'].map(function (l) { return { label: l, icon: 'moon', fn: function () { toast(l === 'Off' ? 'Sleep timer off' : 'Sleep in ' + l.toLowerCase()); } }; })); return; }
    if (act === 'bookmark') { S.bookmarked = !S.bookmarked; el.setAttribute('aria-pressed', S.bookmarked); el.innerHTML = ic(S.bookmarked ? 'bookmark-simple-fill' : 'bookmark-simple') + 'Bookmark'; if (S.bookmarked) toast('Bookmarked at ' + clock(S.pos)); return; }
    if (act === 'np-more') { actionSheet('More', [{ label: 'Share', icon: 'share-network' }, { label: 'Show notes', icon: 'info' }, { label: 'Go to episode', icon: 'arrow-bend-up-left' }, { label: 'Download', icon: 'download-simple', fn: function () { toast('Download complete'); } }, { label: 'Stop', icon: 'x', fn: function () { location.hash = '#/home'; setTimeout(stopWithUndo, 350); } }]); return; }
    if (act === 'queue-menu') { qMenu(id); return; }
    if (act === 'clear-q') { actionSheet('Up Next', [{ label: 'Clear ' + S.queue.length + ' items', icon: 'x', fn: function () { var keep = S.queue.slice(); S.queue = []; rerender(); bumpCount(); toast('Up Next cleared', 'Undo', function () { S.queue = keep; rerender(); }); } }, { label: 'Cancel' }]); return; }
    if (act === 'all-queue') { ev.preventDefault(); sheetStack.slice().forEach(function (s) { closeSheet(s, true); }); S.under = 'library'; location.hash = '#/library'; setTimeout(function () { var u = $('#up-next'); u && u.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth' }); }, 80); return; }
    if (act === 'seek-seg') { var sg = F.segments[+el.getAttribute('data-i')]; if (!S.cur || S.cur.kind !== 'foray') { S.cur = { kind: 'foray' }; renderTicker(); } S.pos = sg.start_sec; S.playing = true; updateTicker(); npUpdate(); return; }
    if (act === 'chip') { S.q = el.getAttribute('data-q'); renderPage('search'); return; }
    if (act === 'commission') { var cq = el.getAttribute('data-q'); S.q = ''; renderPage('search'); var cf = $('#find'); if (cf) { cf.value = cq; cf.setAttribute('data-mode', 'commission'); cf.focus(); } var fld = $('.field'); if (fld) fld.scrollIntoView({ block: 'center' }); return; }
    if (act === 'focus-find') { var f = $('#find'); f && f.focus(); return; }
    if (act === 'clear-find') { S.q = ''; var inp = $('#find'); if (inp) { inp.value = ''; inp.focus(); } renderPageKeepFind(); return; }
    if (act === 'back') { if (history.length > 1 && S.fromBack !== false) history.back(); else location.hash = '#/home'; return; }
    if (act === 'why') { openWhy(); return; }
    if (act === 'scheme') { S.scheme = el.getAttribute('data-v'); store.set('scheme', S.scheme); S.opts.scheme = null; applyScheme(); $$('[data-act="scheme"]').forEach(function (b) { b.setAttribute('aria-pressed', b === el); }); return; }
    if (act === 'large') { S.large = !largeOn(); store.set('large', S.large ? '1' : '0'); S.opts.large = null; el.setAttribute('aria-checked', S.large); applyLarge(); return; }
    if (act === 'sheet-close') { var t = topSheet(); if (t && t.np) location.hash = '#/' + (S.under === 'home' && S.cur ? 'mini' : S.under); else if (t) closeSheet(t); return; }
    if (act === 'onb-open' || act === 'onb-skip') { store.set('first_seen', '1'); viewEl.removeAttribute('inert'); viewEl.style.removeProperty('transform'); viewEl.classList.remove('onb-under'); $('#folio').removeAttribute('inert'); $('#onb').innerHTML = ''; S.firstEdition = act === 'onb-skip'; S.mode = 'returning'; return; }
    if (act === 'toast-add') { toast('Added to Up Next'); return; }
    if (act === 'toast-dl') { toast('Download complete'); return; }
    if (act === 'share') { toast('Share sheet opens here'); return; }
    if (act === 'foray-more') { actionSheet('This foray', [{ label: 'Add to Up Next', icon: 'list-plus', fn: function () { toast('Added to Up Next'); } }, { label: 'Download', icon: 'download-simple', fn: function () { toast('Download complete'); } }]); return; }
  });
  window.addEventListener('hashchange', onRoute);
  var lastY = 0, minTimer = null;
  window.addEventListener('scroll', function () {
    var y = window.scrollY, f = $('#folio'); if (!f) return;
    if (y > lastY + 4 && y > 24) f.classList.add('is-min'); else if (y < lastY - 4 || y <= 24) f.classList.remove('is-min');
    lastY = y; clearTimeout(minTimer); minTimer = setTimeout(function () { f.classList.remove('is-min'); }, 900);
  }, { passive: true });
  window.addEventListener('resize', function () { fitKey(); fitHooks(); if (S.page === 'onboarding') placeVeil(); $$('[data-frac]').forEach(function (e) { paintFrac(e, parseFloat(e.getAttribute('data-frac'))); }); if (npRec) npUpdate(true); });

  /* ---------- boot ---------- */
  function loadData() {
    return fetch('data.json').then(function (r) { if (!r.ok) throw 0; return r.json(); }).catch(function () {
      return new Promise(function (res, rej) { var s = document.createElement('script'); s.src = 'data.js'; s.onload = function () { res(window.EDITION_DATA); }; s.onerror = rej; document.head.appendChild(s); });
    });
  }
  loadData().then(function (d) {
    D = d; viewEl = $('#view'); selectData(); S.opts = {};
    if (!location.hash) location.replace('#/home');
    onRoute(); booted = true;
    // faces load lazily, after first paint: refit everything whose size depends on them each time a batch lands
    if (document.fonts && document.fonts.addEventListener) document.fonts.addEventListener('loadingdone', function () {
      fitKey(); fitHooks(); $$('[data-frac]').forEach(function (e) { paintFrac(e, parseFloat(e.getAttribute('data-frac'))); }); if (npRec) npUpdate(true); if (S.page === 'onboarding') placeVeil();
    });
    // after fonts settle, repaint strip cursors and the onboarding veil: widths change when faces swap
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { fitKey(); fitHooks(); $$('[data-frac]').forEach(function (e) { paintFrac(e, parseFloat(e.getAttribute('data-frac'))); }); if (npRec) npUpdate(true); if (S.page === 'onboarding') placeVeil(); });
  });
})();
