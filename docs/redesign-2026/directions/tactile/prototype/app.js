/* Dial prototype. Classic script, no build. Simulated playback; real show data (data.js).
   Hard limits honoured: every interpolation through esc(), every URL through safeUrl(),
   no inline style attributes or scripts (styles go through CSSOM / custom properties),
   storage only through the shim with cp_ keys. */
(function () {
  "use strict";
  var D = window.__DATA__;
  var root = document.documentElement;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  /* ---------- safety + storage ---------- */
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function safeUrl(u) { try { var x = new URL(u); return x.protocol === "https:" ? x.href : ""; } catch (e) { return ""; } }
  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private window */ } }
  };

  /* ---------- motion helpers (tokens are the single source) ---------- */
  var cs = function () { return getComputedStyle(root); };
  var tok = function (n) { return cs().getPropertyValue(n).trim(); };
  var dur = function (n) { return parseFloat(tok(n)) || 0; };
  function anim(el, frames, easeTok, durTok) {
    var o = { duration: dur(durTok), easing: tok(easeTok) || "ease", fill: "both" };
    try { return el.animate(frames, o); } catch (e) { o.easing = "cubic-bezier(.2,.8,.2,1)"; return el.animate(frames, o); }
  }
  var lastHaptic = 0;
  function haptic() { /* Web+: @capacitor/haptics in the app. Prototype: light vibrate where supported. */
    var n = Date.now(); if (n - lastHaptic < 100) return; lastHaptic = n;
    try { if (navigator.vibrate) navigator.vibrate(6); } catch (e) { /* none */ }
  }

  /* ---------- data ---------- */
  var EP = {}; D.episodes.forEach(function (e) { e.sec = Math.round(e.duration_min * 60); EP[e.id] = e; });
  var SH = {}; D.shows.forEach(function (s) { SH[s.id] = s; });
  var F = D.foray;
  var FSH = {}; F.shows.forEach(function (s) { FSH[s.id] = s; });
  var EPS = D.episodes;
  function findEp(prefix) { for (var i = 0; i < EPS.length; i++) if (EPS[i].id.indexOf(prefix) === 0) return EPS[i]; return null; }

  var SEED = 1;
  function colorIdx(id) {
    var h = 2166136261 ^ SEED;
    for (var i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0) % 8;
  }
  function ini(name) { var m = String(name).replace(/^(the|a|an)\s+/i, "").match(/[A-Za-z0-9]/); return m ? m[0].toUpperCase() : "?"; }
  /* Station codes (BUILD-NOTES 3.6): strip a leading "The "; first letter of the first two words; a one-word title takes its first two letters. */
  function wordsOf(name) { return String(name).replace(/^the\s+/i, "").split(/\s+/).map(function (w) { return w.replace(/[^A-Za-z0-9]/g, ""); }).filter(Boolean); }
  function baseCode(name) {
    var w = wordsOf(name); if (!w.length) return "??";
    return (w.length === 1 ? w[0].slice(0, 2) : w[0][0] + w[1][0]).toUpperCase();
  }
  var FCODE = {}; /* within one foray, a collision swaps the second letter for the first letter of the show's last word */
  (function () {
    var used = {};
    F.shows.forEach(function (s) {
      var c = baseCode(s.name), w = wordsOf(s.name), alt = w.length ? w[w.length - 1][0].toUpperCase() : "X", k = 0;
      while (used[c]) { c = c[0] + (k === 0 ? alt : String(k)); k++; }
      used[c] = 1; FCODE[s.id] = c;
    });
  })();
  function codeFor(id, name) { return FCODE[id] || baseCode(name); }

  /* ---------- formatting ---------- */
  /* Display-name rule (r2 P1-1): meta lines drop a trailing " - ...", " | ...", " with ..." or " (...)" clause. Full names stay on tiles, Find and "From" rows. */
  function shortShow(name) {
    var n = String(name), m = n.match(/^(.{3,}?)(?:\s+[-\u2013\u2014|]\s+.*|\s+with\s+.*|\s+\(.*\))$/i);
    n = m ? m[1] : n;
    return n.replace(/\s+(?:Philosophy\s+)?Podcast$/i, "") || n; /* the generic noun is not the name */
  }
  function durText(min) { min = Math.round(min); if (min < 60) return min + " min"; var h = Math.floor(min / 60), m = min % 60; return m ? h + " hr " + m + " min" : h + " hr"; }
  function clock(sec) {
    sec = Math.max(0, Math.floor(sec)); var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? h + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0") : m + ":" + String(s).padStart(2, "0");
  }
  /* clock with the colon wrapped so the mono colon's wide sidebearings can be tightened (P1-5) */
  function clk(sec) { return esc(clock(sec)).replace(/:/g, '<span class="colon">:</span>'); }
  var DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function dateLine() { var d = new Date(); return DAYS[d.getDay()] + " " + d.getDate() + " " + MONTHS[d.getMonth()]; }

  /* ---------- foray timeline: band geometry and time <-> x ---------- */
  function buildTL(skipNarr) {
    var items = F.items.filter(function (it) { return !(skipNarr && it.type === "narration"); }).map(function (it) { return Object.assign({}, it); });
    var total = items.reduce(function (a, b) { return a + b.sec; }, 0);
    var MINN = 26; /* narration ticks never thinner than this many of 1000 units (8px at 323px; r1 had 11 and read as slivers) */
    var narrU = 0, segSec = 0;
    items.forEach(function (it) { if (it.type === "narration") narrU += Math.max(MINN, it.sec / total * 1000); else segSec += it.sec; });
    var k = (1000 - narrU) / segSec, x = 0, t = 0;
    items.forEach(function (it) {
      var u = it.type === "narration" ? Math.max(MINN, it.sec / total * 1000) : it.sec * k;
      it.l = x / 10; it.w = u / 10; it.t0 = t; it.t1 = t + it.sec; x += u; t += it.sec;
      it.ci = it.show_id ? colorIdx(it.show_id) : 0;
    });
    return { items: items, total: total };
  }
  var TL = buildTL(false);
  function idxAt(t) { var it = TL.items; for (var i = 0; i < it.length; i++) if (t < it[i].t1) return i; return it.length - 1; }
  function timeToX(t) { var i = idxAt(t), it = TL.items[i], f = Math.min(1, Math.max(0, (t - it.t0) / (it.t1 - it.t0))); return (it.l + it.w * f) / 100; }
  function xToTime(x) {
    var p = x * 100, it = TL.items, i;
    for (i = 0; i < it.length; i++) if (p <= it[i].l + it[i].w + 0.0001 || i === it.length - 1) break;
    var q = it[i]; var f = Math.min(1, Math.max(0, (p - q.l) / q.w)); return q.t0 + (q.t1 - q.t0) * f;
  }

  /* ---------- state ---------- */
  var S;
  function freshState() {
    return {
      now: null, playing: false, pos: {}, speed: 1, sleep: 0, dial: null,
      queue: [findEp("partially-examined").id, findEp("design-matters").id, findEp("common-descent").id, findEp("being-an-engineer").id, findEp("alpinist").id],
      saved: new Set([findEp("99-percent").id, findEp("huberman").id, findEp("advent-of-computing").id, findEp("odd-lots").id, findEp("happiness-lab").id, findEp("strong-towns").id]),
      history: [findEp("business-wars").id, findEp("spycast").id, findEp("5-4-podcast").id, findEp("designer-notes").id, findEp("fast-talk").id],
      downloaded: new Set([findEp("99-percent").id, findEp("odd-lots").id, findEp("main-engine-cut-off").id]),
      followed: new Set(D.meta.followed_show_ids), bookmarks: new Set(),
      resume: null, libTab: "upnext", q: "", openRow: null, subjRot: 0,
      npOpen: false, base: null, rendered: null, firstRun: false, miniHidden: false, offline: false, loading: false, libEmpty: false, unavailable: false, buffering: false
    };
  }
  S = freshState();
  var RESUME = { id: D.today.resume.id, pos: D.today.resume.pos_sec };

  function nowInfo() {
    if (!S.now) return null;
    if (S.now.kind === "foray") {
      var shows = F.shows;
      return { kind: "foray", id: F.id, title: F.title, show: "4a foray · " + shows.length + " shows", sec: TL.total, ci: colorIdx(shows[0].id), shows: shows, why: F.why };
    }
    var e = EP[S.now.id];
    return { kind: "ep", id: e.id, title: e.title, show: e.show, sec: e.sec, ci: colorIdx(e.show_id), ep: e, why: e.hook };
  }
  function posOf(kind, id) { return S.pos[kind === "foray" ? "foray" : id] || 0; }
  function curPos() { var n = S.now; return n ? posOf(n.kind, n.id) : 0; }
  function setPos(v) { var n = S.now; if (n) S.pos[n.kind === "foray" ? "foray" : n.id] = v; }

  var LIBKEYS = ["forays", "shows", "saved", "playlists", "upnext", "history"];
  function applyFixture(name, sub) {
    var keepTheme = S.theme; S = freshState(); S.theme = keepTheme;
    var sp = (sub || "").split("/"), s0 = sp[0] || "", s1 = sp[1] || "";
    TL = buildTL(name === "foray" && s0 === "unnarrated");
    var epNow = function () { S.now = { kind: "ep", id: RESUME.id }; S.playing = true; S.pos[RESUME.id] = RESUME.pos; S.queue = S.queue.filter(function (i) { return i !== RESUME.id; }).slice(0, 4); };
    if (name === "mini" || name === "library" || name === "toast") epNow();
    if (name === "now-playing") {
      if (s0 === "episode") epNow(); else seedForay();
      if (s0 === "paused") S.playing = false;
      if (s0 === "buffering") S.buffering = true;
    }
    if (name === "home") {
      if (s0 === "resume") { S.resume = { kind: "ep", id: RESUME.id }; S.pos[RESUME.id] = RESUME.pos; }
      if (s0 === "first") S.firstRun = true;
      if (s0 === "offline") { S.offline = true; S.downloaded = new Set([EP[D.today.also[1].id].id, findEp("main-engine-cut-off").id]); }
      if (s0 === "loading") S.loading = true;
    }
    if (name === "library") {
      if (LIBKEYS.indexOf(s0) >= 0) S.libTab = s0;
      if (s0 === "upnext" && s1 === "open") S.openRow = S.queue[0];
      if (s0 === "empty") { S.now = null; S.playing = false; S.queue = []; S.followed = new Set(); S.libEmpty = true; }
    }
    if (name === "toast") { S.libTab = "upnext"; S.toastOnLoad = true; S.toastIdx = 3; S.toastRemoved = S.queue[3]; S.queue.splice(3, 1); }
    if (name === "settings") S.settingsOnLoad = true;
    if (name === "foray") {
      if (s0 === "progress") S.pos.foray = 760;
      if (s0 === "done") S.pos.foray = TL.total;
      if (s0 === "unavailable") S.unavailable = true;
    }
    if (name === "search") {
      if (s0 === "typing") S.q = "chern";
      if (s0 === "none") S.q = "fusion";
    }
    if (name === "onboarding" && s0 === "return") S.firstRun = true;
  }
  function seedForay() {
    S.now = { kind: "foray", id: F.id }; S.playing = true;
    var i = 0; TL.items.forEach(function (it, n) { if (it.label === "JERK-1") i = n; });
    S.pos.foray = (TL.items[i].t0 + TL.items[i].t1) / 2;
  }

  /* ---------- html builders ---------- */
  function hydrate(r) {
    $$('[data-v^="--"]', r).forEach(function (el) { /* data-v="--prop:value;..." is style-by-CSSOM (no inline style attributes under CSP) */
      el.dataset.v.split(";").forEach(function (p) { var i = p.indexOf(":"); if (i > 0) el.style.setProperty(p.slice(0, i).trim(), p.slice(i + 1).trim()); });
      el.removeAttribute("data-v");
    });
  }
  function icon(id, cls) { return '<svg class="i' + (cls ? " " + cls : "") + '" aria-hidden="true"><use href="#' + esc(id) + '"/></svg>'; }
  function art(o) { /* o: {url, id, name, s, cls} */
    var u = safeUrl(o.url);
    return '<span class="art c' + colorIdx(o.id) + (o.cls ? " " + o.cls : "") + '" data-i="' + esc(ini(o.name)) + '"' + (o.s === 0 ? "" : ' data-v="--s:' + (o.s || 56) + 'px"') + ">" + (u ? '<img src="' + esc(u) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">' : "") + "</span>";
  }
  function epArt(e, s, cls) { return art({ url: e.artwork_url, id: e.show_id, name: e.show, s: s, cls: cls }); }
  function forayArt(s, cls) { return art({ url: FSH[F.shows[0].id].artwork_url, id: F.shows[0].id, name: F.shows[0].name, s: s, cls: cls }); }
  function collage(urls, names, s) {
    var cells = urls.slice(0, 4).map(function (o) { return art({ url: o.url, id: o.id, name: o.name, s: 48 }); }).join("");
    return '<span class="collage"' + (s ? ' data-v="--s:' + s + 'px"' : "") + ">" + cells + "</span>";
  }
  function forayCollage(s) { return collage(F.shows.slice(0, 4).map(function (x) { return { url: x.artwork_url, id: x.id, name: x.name }; }), null, s); }
  function tag(kind, text) {
    var ic = { stretch: "bridge", narration: "narration", downloaded: "ph-check-circle", played: "", playing: "needle" }[kind];
    return '<span class="tag tag--' + kind + '">' + (ic ? icon(ic) : "") + esc(text) + "</span>";
  }
  function keycap(o) { /* o: {act, cls, label, icon, text, attrs} */
    return '<button type="button" class="keycap ' + (o.cls || "") + '" data-act="' + o.act + '"' + (o.label ? ' aria-label="' + esc(o.label) + '"' : "") + (o.attrs || "") + ">" + (o.icon ? icon(o.icon) : "") + (o.text ? esc(o.text) : "") + "</button>";
  }
  function isCur(kind, id) { return S.now && S.now.kind === kind && (kind === "foray" || S.now.id === id); }
  function blocked(kind, id) { return S.offline && !(kind === "ep" && S.downloaded.has(id)); }
  function playBtn(kind, id, cls, label) {
    var cur = isCur(kind, id) && S.playing;
    if (blocked(kind, id)) return '<button type="button" class="keycap keycap--blocked ' + (cls || "keycap--sm") + '" disabled aria-label="Needs a connection: ' + esc(label) + '">' + icon("ph-cloud-slash") + "</button>";
    return '<button type="button" class="keycap keycap--persimmon ' + (cls || "keycap--sm") + '" data-act="play" data-kind="' + kind + '" data-id="' + esc(id) + '" aria-label="' + esc((cur ? "Pause " : "Play ") + label) + '">' + icon(cur ? "ph-pause-fill" : "ph-play-fill") + "</button>";
  }
  function needsLine() { return '<p class="needs">' + icon("ph-cloud-slash", "i--xs") + "Needs a connection</p>"; }

  function bandHTML(kind, model, o) {
    o = o || {};
    var bars = "", labels = "", key;
    if (model === "foray") {
      key = o.key || "f";
      var W = o.w || Math.min(window.innerWidth || 393, 430) - 52; /* rendered stage width in px; labels need 24px of bar */
      TL.items.forEach(function (it, ix) {
        bars += it.type === "narration" ? '<i class="bar bar--n" data-v="--l:' + it.l.toFixed(3) + ";--w:" + it.w.toFixed(3) + '"></i>'
          : '<i class="bar c' + it.ci + '" data-v="--l:' + it.l.toFixed(3) + ";--w:" + it.w.toFixed(3) + '"></i>';
      });
      /* r7 (critique-r5 band-codes note): one code per RUN of adjacent bars from one show, narration does not break a run */
      var runs = [];
      TL.items.forEach(function (it, ix) {
        if (it.type !== "segment") return;
        var last = runs[runs.length - 1];
        if (last && last.show === it.show_id) { last.r = it.l + it.w; last.b = ix; }
        else runs.push({ show: it.show_id, l: it.l, r: it.l + it.w, a: ix, b: ix });
      });
      runs.forEach(function (ru) {
        if ((ru.r - ru.l) / 100 * W < 24) return;
        labels += '<span data-a="' + ru.a + '" data-b="' + ru.b + '" data-v="--l:' + ((ru.l + ru.r) / 2).toFixed(3) + '">' + esc(codeFor(ru.show, FSH[ru.show].name)) + "</span>";
      });
    } else {
      key = "e:" + model;
      bars = '<i class="bar bar--ep" data-v="--l:0;--w:100"></i>';
    }
    var cls = "band band--" + kind + (kind === "scrub" && model !== "foray" ? " band--episode" : "") + (o.empty ? " band--empty" : "");
    var aria;
    if (kind === "scrub") aria = ' role="slider" tabindex="0" aria-label="Playback position" aria-valuemin="0" aria-valuemax="' + (model === "foray" ? TL.total : EP[model].sec) + '" aria-valuenow="0" aria-valuetext=""';
    else aria = ' role="img" aria-label="' + esc(model === "foray" ? "Foray band: " + F.items.filter(function (i) { return i.type === "segment"; }).length + " segments from " + F.shows.length + " shows, with 4a narration between them" : "Episode progress") + '"';
    if (kind === "line") aria = ' aria-hidden="true"';
    return '<div class="' + cls + '" data-band="' + esc(key) + '"' + (o.draw === false ? "" : " data-draw") + aria + '>' +
      '<div class="band__stage"><div class="band__layers"><div class="band__base">' + bars + '</div><div class="band__fill">' + bars + "</div></div>" +
      (kind === "scrub" && model !== "foray" ? '<div class="band__ticks" aria-hidden="true">' + CHAPTERS.slice(1).map(function (c) { return '<i data-v="--l:' + (c * 100).toFixed(2) + '"></i>'; }).join("") + "</div>" : "") +
      (kind === "detail" || kind === "scrub" ? '<div class="band__labels" aria-hidden="true">' + labels + "</div>" : "") +
      (kind === "line" || o.empty && false ? "" : '<b class="needle"></b>') +
      (kind === "scrub" ? '<div class="band-bubble" aria-hidden="true"></div>' : "") + "</div></div>";
  }
  function wellBand(kind, model, o) { return '<div class="well band-wrap ' + (kind === "mini" ? "" : "") + '">' + bandHTML(kind, model, o) + "</div>"; }

  function upNextBtn(id, queued, title) {
    return '<button type="button" class="upnext' + (queued ? " is-on" : "") + '" data-act="queue-add" data-id="' + esc(id) + '" aria-label="' + (queued ? "In Up Next: " : "Add to Up Next: ") + esc(title) + '">' + icon(queued ? "ph-check" : "ph-plus", "i--xs") + "<span>" + (queued ? "In Up Next" : "Up Next") + "</span></button>";
  }
  function epRow(e, o) {
    o = o || {};
    var tags = "";
    if (S.downloaded.has(e.id)) tags += S.offline ? '<span class="tag tag--downloaded">' + icon("ph-check-circle") + "Downloaded</span>" : '<span class="tag tag--downloaded tag--icon" role="img" aria-label="Downloaded">' + icon("ph-check-circle") + "</span>";
    if (o.played) tags += tag("played", "Played");
    var queued = S.queue.indexOf(e.id) >= 0 || (S.now && S.now.kind === "ep" && S.now.id === e.id);
    return '<article class="row row--episode" data-card>' + epArt(e, 56) +
      '<div class="row__body"><h3 class="row__title clamp2">' + esc(e.title) + '</h3><div class="row__meta"><span class="ell show">' + esc(shortShow(e.show)) + '</span><span class="readout">' + durText(e.duration_min) + "</span>" + tags + (o.played ? "" : upNextBtn(e.id, queued, e.title)) + "</div>" +
      (blocked("ep", e.id) ? needsLine() : "") + "</div>" +
      '<div class="row__end">' + playBtn("ep", e.id, "keycap--sm", e.title) + "</div>" + (o.why ? '<p class="row__why">' + esc(o.why) + "</p>" : "") + "</article>";
  }
  function showRow(s, o) {
    o = o || {}; var on = S.followed.has(s.id);
    return '<div class="row row--show">' + art({ url: s.artwork_url, id: s.id, name: s.name, s: 44 }) + '<div class="row__body"><h3 class="row__title clamp1">' + esc(s.name) + '</h3><div class="row__meta">' + esc(o.meta || "") + "</div></div>" +
      '<button type="button" class="chip" data-act="follow" data-id="' + esc(s.id) + '" aria-pressed="' + on + '">' + (on ? icon("ph-check") + "Following" : "Follow") + "</button></div>";
  }

  /* ---------- screens ---------- */
  function screenHome() {
    var resume = "";
    if (!S.now && S.resume) {
      var re = EP[S.resume.id], p = S.pos[re.id] || 0;
      resume = '<section class="card resume" data-card aria-label="Resume: ' + esc(re.title) + ', ' + esc(re.show) + '"><div class="resume__art">' + epArt(re, 80) + "</div>" +
        '<div class="resume__body"><div class="resume__tag"><span class="tag tag--resume">' + icon("needle") + "Resume</span></div>" +
        '<h2 class="h17 clamp2">' + esc(re.title) + '</h2>' +
        '<div class="resume__line"><div class="well resume__prog" data-v="--p:' + (p / re.sec).toFixed(3) + '"><i></i></div><span class="readout muted">' + Math.max(1, Math.round((re.sec - p) / 60)) + ' min left</span></div></div>' +
        '<div class="resume__key">' + playBtn("ep", re.id, "keycap--round", re.title) + "</div></section>";
    }
    var segN = F.items.filter(function (i) { return i.type === "segment"; }).length;
    var discs = F.shows.slice(0, 3).map(function (s) { return art({ url: s.artwork_url, id: s.id, name: s.name, s: 40 }); }).join("");
    var mins = Math.round(TL.total / 60);
    var hero = '<section class="card card--lg hero" data-card aria-labelledby="h-foray">' +
      '<div><span class="tag tag--narration">' + icon("narration") + "Today’s foray</span></div>" +
      '<h2 class="display clamp3" id="h-foray"><a href="#/foray" class="hero__link">' + esc(F.title) + "</a></h2>" +
      wellBand("mini", "foray") +
      '<div class="hero__meta"><span class="discs">' + discs + '</span><span class="readout muted">about ' + mins + " min · " + F.shows.length + " shows</span></div>" +
      '<p class="body-lg">' + esc(S.firstRun ? "4a starts with wide bets. Each listen narrows the dial." : F.why) + "</p>" +
      '<div class="hero__keys">' + playBtn("foray", F.id, "keycap--xl keycap--round", "today’s foray") +
      '<a class="keycap keycap--paper" href="#/foray" role="button">Details</a></div>' + (S.offline ? needsLine() : "") + "</section>";

    var T = D.today, pa = EP[T.also[0].id], pb = EP[T.also[1].id], pc = EP[T.third.id];
    var bk = EP[T.bridge.known], bs = EP[T.bridge.stretch];
    var bq = S.queue.indexOf(bs.id) >= 0 || (S.now && S.now.kind === "ep" && S.now.id === bs.id);
    var bridge = '<article class="card bridge" data-card data-draw aria-label="Stretch pick">' +
      '<p class="bridge__sentence">' + esc(T.bridge.sentence) + "</p>" +
      '<div class="bridge__arc">' + epArt(bk, 48) +
      '<span class="bridge__svg"><svg viewBox="0 0 200 48" preserveAspectRatio="none" aria-hidden="true"><path d="M0 34 C 40 -6, 160 -6, 200 20" pathLength="1"/></svg><i class="bdot bdot--a"></i><i class="bdot bdot--b"></i></span>' +
      epArt(bs, 72, "art--md") + "</div>" +
      '<div class="bridge__pick"><div class="bridge__text"><div><span class="tag tag--stretch">' + icon("bridge") + 'Stretch</span></div><h3 class="row__title clamp2">' + esc(bs.title) + '</h3><div class="row__meta"><span class="ell show">' + esc(shortShow(bs.show)) + '</span><span class="readout">' + durText(bs.duration_min) + "</span>" + upNextBtn(bs.id, bq, bs.title) + "</div></div>" +
      '<div class="row__end">' + playBtn("ep", bs.id, "keycap--sm", bs.title) + "</div></div></article>";

    var also = '<section class="sect" id="sec-also"><div class="sect__head"><h2 class="heading">Also today</h2></div><div class="rows">' +
      epRow(pa, { why: T.also[0].why }) + bridge + epRow(pb, { why: T.also[1].why }) + epRow(pc, { why: T.third.why }) + "</div></section>";

    var pls = '<section class="sect" id="sec-playlists"><div class="sect__head"><h2 class="heading">Playlists for you</h2></div><div class="pgrid">' +
      D.playlists.map(plCard).join("") + "</div></section>";
    var gauge = '<section class="card" id="sec-ground" aria-label="New ground"><div class="stack">' + gaugeHTML() + "</div></section>";
    return '<div class="screen' + (S.loading ? " is-loading" : "") + (S.offline ? " is-offline" : "") + '" id="s-home"' + (S.loading ? ' aria-busy="true"' : "") + '><header class="top"><div class="top__title"><h1 class="display-xl">Today</h1><span class="readout muted">' + dateLine() + (S.offline ? " · Offline" : "") + "</span></div>" +
      keycap({ act: "settings", cls: "keycap--sm keycap--paper", label: "Settings and dials", icon: "knob" }) + "</header>" +
      resume + hero + also + pls + gauge + "</div>";
  }
  function gaugeHTML() {
    var txt = "About a third of today sits outside your usual subjects. 4a keeps it that way.";
    return '<div class="gauge-head"><h2 class="heading">New ground</h2><span class="readout">1 in 3</span></div>' +
      '<div class="well gauge" role="img" aria-label="' + esc(txt) + '" data-v="--g:0.33"><i class="gauge__bar"></i><i class="gauge__fill"></i><i class="gauge__needle"></i></div><p class="label muted gauge__cap">' + esc(txt) + "</p>";
  }
  function plCard(p) {
    var arts = p.episodes.map(function (id) { var e = EP[id]; return { url: e.artwork_url, id: e.show_id, name: e.show }; });
    return '<button type="button" class="pcard" data-act="play-pl" data-id="' + esc(p.id) + '" data-card aria-label="Play playlist ' + esc(p.name) + '">' + collage(arts, null, 96) +
      '<span class="h17 clamp2">' + esc(p.name) + '</span><span class="readout muted">' + p.played + ' of ' + p.episodes.length + ' played</span><span class="well progress" data-v="--p:' + (p.played / p.episodes.length) + '"><i></i></span></button>';
  }

  function screenFind() {
    var followed = D.shows.filter(function (s) { return S.followed.has(s.id); });
    var strip = followed.length ? '<section class="sect"><h2 class="heading">Followed shows</h2><div class="strip">' + followed.map(function (s) {
      return '<span class="strip__item">' + art({ url: s.artwork_url, id: s.id, name: s.name, s: 64, cls: "art--md" }) + '<span class="micro clamp2">' + esc(s.name) + "</span></span>";
    }).join("") + "</div></section>" : "";
    return '<div class="screen screen--find" id="s-find"><header class="top"><div class="top__title"><h1 class="display-xl">Find</h1><span class="label muted find__hint">Type any subject and 4a builds a playlist</span></div></header>' +
      '<div id="results">' + (S.q ? resultsHTML() : idleHTML(strip)) + "</div></div>";
  }
  function subjectsOrdered() {
    var a = D.subjects.slice(), r = S.subjRot % a.length; return a.slice(r).concat(a.slice(0, r));
  }
  function tileHTML(s, hit) {
    var discs = s.size === "l" ? collage(s.art.map(function (u, i) { return { url: u, id: s.id + i, name: s.name }; }), null, 0)
      : '<span class="discs">' + s.art.slice(0, 3).map(function (u, i) { return art({ url: u, id: s.id + i, name: s.name, s: 36 }); }).join("") + "</span>";
    return '<button type="button" class="tile tile--' + s.size + (hit ? " is-hit" : "") + '" data-act="subject" data-id="' + esc(s.id) + '">' + discs + '<span><span class="tile__name clamp2">' + esc(s.name) + '</span><span class="readout muted">' + esc(s.shows + " shows") + "</span></span></button>";
  }
  function idleHTML(strip) {
    return strip + '<section class="sect" id="sec-mosaic"><h2 class="heading">Subjects</h2><div class="mosaic">' + subjectsOrdered().map(function (s) { return tileHTML(s); }).join("") + "</div>" +
      '<div><button type="button" class="keycap keycap--paper" data-act="more-subjects">More subjects</button></div></section>';
  }
  var ALIAS = { fusion: "engineering/energy-grid", nuclear: "engineering/energy-grid", solar: "engineering/energy-grid", power: "engineering/energy-grid" };
  function resultsHTML() {
    var q = S.q.trim().toLowerCase(); if (!q) return idleHTML("");
    var toks = q.split(/\s+/);
    var match = function (s) { s = s.toLowerCase(); return toks.every(function (t) { return s.indexOf(t) >= 0; }); };
    var shows = D.shows.filter(function (s) { return match(s.name); });
    var eps = EPS.filter(function (e) { return match(e.title + " " + e.show + " " + e.hook); });
    var pls = D.playlists.filter(function (p) { return match(p.name); });
    var make = '<button type="button" class="keycap keycap--ultramarine keycap--wide" data-act="make" data-q="' + esc(S.q.trim()) + '">' + icon("ph-sparkle") + "Make a playlist about ‘" + esc(S.q.trim()) + "’</button>";
    if (!shows.length && !eps.length && !pls.length) {
      var sj = D.subjects.filter(function (s) { return s.name.toLowerCase().indexOf(q) >= 0 || ALIAS[q] === s.id; })[0];
      return '<section class="sect"><h2 class="heading">No shows match ‘' + esc(S.q.trim()) + "’.</h2>" + (sj ? '<p class="body-lg">' + esc(sj.name) + " has " + sj.shows + ' shows.</p><div class="mosaic">' + tileHTML(Object.assign({}, sj, { size: "m" }), true) + "</div>" : "") + make + "</section>";
    }
    var out = "";
    if (shows.length) out += '<section class="sect"><div class="sect__head"><h2 class="h17">Shows</h2><span class="readout muted">' + shows.length + '</span></div><div class="rows">' + shows.slice(0, 5).map(function (s) { return showRow(s, { meta: EPS.filter(function (e) { return e.show_id === s.id; }).length + " episode today" }); }).join("") + "</div></section>";
    if (eps.length) out += '<section class="sect"><div class="sect__head"><h2 class="h17">Episodes</h2><span class="readout muted">' + eps.length + '</span></div><div class="rows">' + eps.slice(0, 6).map(function (e) { return epRow(e); }).join("") + "</div></section>";
    if (pls.length) out += '<section class="sect"><div class="sect__head"><h2 class="h17">Playlists</h2><span class="readout muted">' + pls.length + '</span></div><div class="pgrid">' + pls.map(plCard).join("") + "</div></section>";
    return out + make;
  }

  var LIBTABS = [["forays", "Forays"], ["shows", "Shows"], ["saved", "Saved"], ["playlists", "Playlists"], ["upnext", "Up Next"], ["history", "History"]];
  function upnextCount() { return S.queue.length + (S.now && S.now.kind === "ep" ? 1 : 0); }
  function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }
  function libReadout() {
    var t = S.libTab;
    if (t === "upnext") {
      var ids = (S.now && S.now.kind === "ep" ? [S.now.id] : []).concat(S.queue);
      return plural(ids.length, "queued", "queued") + " · " + durText(ids.reduce(function (a, id) { return a + EP[id].sec; }, 0) / 60);
    }
    if (t === "forays") return plural(1, "foray", "forays");
    if (t === "shows") return plural(D.shows.filter(function (s) { return S.followed.has(s.id); }).length, "show", "shows");
    if (t === "saved") return plural(S.saved.size, "saved episode", "saved episodes");
    if (t === "playlists") return plural(D.playlists.length, "playlist", "playlists");
    return plural(S.history.length, "episode played", "episodes played");
  }
  function chipsHTML() {
    return LIBTABS.map(function (t) {
      return '<button type="button" class="chip" role="tab" data-act="lib-tab" data-tab="' + t[0] + '" aria-selected="' + (S.libTab === t[0]) + '">' + (S.libTab === t[0] ? icon("ph-check") : "") + t[1] + (t[0] === "upnext" && upnextCount() ? '<span class="chip__n">' + upnextCount() + "</span>" : "") + "</button>";
    }).join("");
  }
  function screenLibrary() {
    var knobBtn = keycap({ act: "settings", cls: "keycap--sm keycap--paper", label: "Settings and dials", icon: "knob" });
    if (S.libEmpty) {
      return '<div class="screen" id="s-lib"><header class="top"><div class="top__title"><h1 class="display-xl">Yours</h1><span class="readout muted">Nothing saved yet</span></div>' + knobBtn + "</header>" +
        empty("Nothing here yet. Follow a show or play today’s foray and it lands here.", '<a class="keycap keycap--persimmon" href="#/search" role="button">Find a show</a>') + "</div>";
    }
    return '<div class="screen" id="s-lib"><header class="top"><div class="top__title"><h1 class="display-xl">Yours</h1><span class="readout muted" id="libread">' + esc(libReadout()) + "</span></div>" + knobBtn + "</header>" +
      '<div class="strip" role="tablist" aria-label="Yours">' + chipsHTML() + '</div><div id="libbody">' + libBody() + "</div></div>";
  }
  function empty(msg, btn) {
    return '<div class="empty"><svg viewBox="0 0 96 96" aria-hidden="true"><rect x="12" y="30" width="72" height="48" rx="10"/><circle cx="34" cy="54" r="12"/><circle cx="34" cy="54" r="3"/><path d="M52 44h20M52 54h20M52 64h12"/><path d="M28 30 62 12"/></svg><p class="body-lg">' + esc(msg) + "</p>" + btn + "</div>";
  }
  function libBody() {
    var t = S.libTab;
    if (t === "forays") {
      var p = S.pos.foray || 0;
      return '<div class="rows"><article class="card" data-card><div class="stack">' + '<h2 class="h17 clamp2"><a href="#/foray" class="hero__link">' + esc(F.title) + "</a></h2>" + wellBand("mini", "foray") +
        '<div class="resume__foot"><span class="readout muted">about ' + Math.round(TL.total / 60) + " min · " + F.shows.length + " shows" + (p > 0 ? " · " + Math.max(1, Math.round((TL.total - p) / 60)) + " left" : "") + "</span>" + playBtn("foray", F.id, "keycap--md keycap--round", "today’s foray") + "</div></div></article></div>";
    }
    if (t === "shows") {
      var fs = D.shows.filter(function (s) { return S.followed.has(s.id); });
      if (!fs.length) return empty("Nothing here yet. Follow a show or play today’s foray and it lands here.", '<a class="keycap keycap--persimmon" href="#/search" role="button">Find a show</a>');
      return '<div class="agrid">' + fs.map(function (s) { return '<div class="agrid__item">' + art({ url: s.artwork_url, id: s.id, name: s.name, s: 108 }) + '<span class="label clamp2">' + esc(s.name) + "</span></div>"; }).join("") + "</div>";
    }
    if (t === "saved") return '<div class="rows">' + EPS.filter(function (e) { return S.saved.has(e.id); }).map(function (e) { return epRow(e); }).join("") + "</div>";
    if (t === "history") return '<div class="rows">' + S.history.map(function (id) { return epRow(EP[id], { played: true }); }).join("") + "</div>";
    if (t === "playlists") return '<div class="pgrid">' + D.playlists.map(plCard).join("") + "</div>";
    /* up next */
    var ids = [], n = S.now && S.now.kind === "ep" ? S.now.id : null;
    if (n) ids.push(n); ids = ids.concat(S.queue);
    if (!ids.length) return empty("Nothing here yet. Follow a show or play today’s foray and it lands here.", '<a class="keycap keycap--persimmon" href="#/search" role="button">Find a show</a>');
    var head = '<div class="sect__head"><span class="label muted">Plays in this order</span>' + '<button type="button" class="keycap keycap--sm keycap--paper" data-act="qclear">Clear</button></div>';
    return head + '<div class="rows">' + ids.map(function (id, i) {
      var e = EP[id], cur = id === n, open = S.openRow === id;
      return '<div class="qwrap" data-flip="' + esc(id) + '"><article class="row row--queue' + (cur ? " is-current" : "") + '">' +
        '<span class="pos readout">' + (cur ? icon("needle", "i--sm") : i + 1) + "</span>" + epArt(e, 48) +
        '<div class="row__body"><h3 class="row__title clamp2">' + esc(e.title) + '</h3><div class="row__meta">' + (cur ? '<span class="playing">' + icon("needle", "i--xs") + 'Playing</span><span class="readout">· ' + Math.max(1, Math.round((e.sec - (S.pos[id] || 0)) / 60)) + " min left</span>" : '<span class="ell show">' + esc(shortShow(e.show)) + '</span><span class="readout">' + durText(e.duration_min) + "</span>") + "</div></div>" +
        '<div class="row__end"><button type="button" class="iconbtn" data-act="qmore" data-id="' + esc(id) + '" aria-expanded="' + open + '" aria-label="More for ' + esc(e.title) + '">' + icon("ph-dots-three") + "</button></div></article>" +
        (open ? '<div class="qacts">' + (cur ? "" : keycap({ act: "qup", cls: "keycap--sm keycap--paper", text: "Move up", icon: "ph-arrow-up", attrs: ' data-id="' + esc(id) + '"' }) + keycap({ act: "qdown", cls: "keycap--sm keycap--paper", text: "Move down", icon: "ph-arrow-down", attrs: ' data-id="' + esc(id) + '"' })) + keycap({ act: "qrm", cls: "keycap--sm keycap--paper", text: "Remove", icon: "ph-trash", attrs: ' data-id="' + esc(id) + '"' }) + "</div>" : "") + "</div>";
    }).join("") + "</div>";
  }

  function slotGroups(rowFn) {
    return F.slots.map(function (sl) {
      var rows = TL.items.map(function (it, i) { return { it: it, i: i }; }).filter(function (x) { return x.it.slot === sl.id; });
      return '<div class="slotgroup"><h3 class="h17">' + esc(sl.title) + "</h3>" + rows.map(function (x) { return rowFn(x.it, x.i); }).join("") + "</div>";
    }).join("");
  }
  function segRow(it, i, curI) {
    var narr = it.type === "narration", cur = i === curI;
    var name = narr ? "4a narration" : FSH[it.show_id].name;
    return '<button type="button" class="segrow' + (narr ? " segrow--n" : "") + (cur ? " is-cur" : "") + '" data-act="play-seg" data-i="' + i + '"' + (cur ? ' aria-current="true"' : "") + ">" +
      '<span class="sw ' + (narr ? "" : "c" + it.ci) + '">' + (narr ? "" : esc(codeFor(it.show_id, name))) + '</span><span class="grow"><span class="row__title clamp1">' + esc(name) + "</span>" +
      '<span class="label muted clamp1">' + esc(narr ? it.text : it.why) + "</span></span>" + (cur ? icon("needle", "i--sm") : "") + '<span class="readout muted">' + clock(it.sec) + "</span></button>";
  }
  function fromRow(s, counts) {
    var n = counts[s.id] || 0;
    return '<div class="row row--show"><span class="sw c' + colorIdx(s.id) + '">' + esc(codeFor(s.id, s.name)) + "</span>" + art({ url: s.artwork_url, id: s.id, name: s.name, s: 44 }) + '<div class="row__body"><h3 class="row__title clamp1">' + esc(s.name) + '</h3><div class="row__meta"><span class="readout">' + n + (n === 1 ? " segment" : " segments") + "</span></div></div></div>";
  }
  /* One extended keycap (r2 P0-5): icon + word + mono readout. Play 22 min / Resume 12:40 / Start over. */
  function pinParts() {
    var p = S.pos.foray || 0, fin = p >= TL.total - 1, prog = p > 3 && !fin, cur = isCur("foray", F.id) && S.playing;
    return { cur: cur, word: cur ? "Pause" : fin ? "Start over" : prog ? "Resume" : "Play", read: fin ? "" : prog ? clock(p) : Math.round(TL.total / 60) + " min" };
  }
  function pinInner() {
    var q = pinParts();
    return icon(q.cur ? "ph-pause-fill" : "ph-play-fill") + '<span class="pin__word">' + esc(q.word) + "</span>" + (q.read ? '<span class="readout pin__read">' + esc(q.read) + "</span>" : "");
  }
  function pinBtn() {
    var q = pinParts();
    return '<button type="button" class="keycap keycap--persimmon keycap--lg keycap--round keycap--pin" data-act="play" data-kind="foray" data-id="' + esc(F.id) + '" data-pin="1" aria-label="' + esc((q.cur ? "Pause" : q.word) + " this foray") + '">' + pinInner() + "</button>";
  }
  function screenForay() {
    var p = S.pos.foray || 0, playingF = isCur("foray", F.id), fin = p >= TL.total - 1, prog = p > 3 && !fin;
    var segN = F.items.filter(function (i) { return i.type === "segment"; }).length;
    var curI = prog || playingF ? idxAt(p) : -1;
    var counts = {}; F.items.forEach(function (it) { if (it.type === "segment") counts[it.show_id] = (counts[it.show_id] || 0) + 1; });
    var from = F.shows.map(function (s) { return fromRow(s, counts); }).join("");
    var cur = isCur("foray", F.id) && S.playing;
    var bar = '<div class="fdet__bar">' + keycap({ act: "back", cls: "keycap--sm keycap--paper", label: "Back", icon: "ph-arrow-left" }) + keycap({ act: "share", cls: "keycap--sm keycap--paper", label: "Share this foray", icon: "ph-share-network" }) + "</div>";
    if (S.unavailable) {
      return '<div class="screen screen--fdet fdet" id="s-foray">' + bar +
        '<header class="stack"><div class="row__meta"><span class="tag tag--narration">' + icon("narration") + 'Foray</span></div><h1 class="display clamp4">This foray isn’t available right now.</h1></header>' +
        wellBand("detail", "foray", { empty: true, draw: false, key: "empty" }) +
        '<div class="hero__keys"><a class="keycap keycap--persimmon" href="#/foray" role="button">Try another foray</a><a class="keycap keycap--paper" href="#/library" role="button">Yours</a></div></div>';
    }
    var unnarr = !TL.items.some(function (it) { return it.type === "narration"; });
    return '<div class="screen screen--fdet fdet" id="s-foray">' + bar +
      '<header class="stack"><div class="row__meta"><span class="tag tag--narration">' + icon("narration") + "Foray</span>" + (fin ? tag("played", "Played") : "") + '</div><h1 class="display-xl clamp4">' + esc(F.title) + "</h1></header>" +
      wellBand("detail", "foray", {}) +
      '<div class="stack"><p class="readout muted">about ' + Math.round(TL.total / 60) + " min · " + F.shows.length + " shows · " + segN + " segments</p>" + (unnarr ? '<p class="label muted">No narration yet on this one.</p>' : "") + '<p class="body-lg">' + esc(F.summary) + '</p><div class="why"><span class="label muted">Why today</span><p class="body">' + esc(F.why) + "</p></div></div>" +
      '<section class="sect"><h2 class="heading">From</h2><div class="rows">' + from + "</div></section>" +
      '<section class="sect" id="sec-segments"><h2 class="heading">Segments</h2>' + slotGroups(function (it, i) { return segRow(it, i, curI); }) + "</section>" +
      '<div class="pin">' + pinBtn() + "</div></div>";
  }

  function screenOnboarding() {
    var arts = F.shows.slice(0, 4).map(function (x) { return { url: x.artwork_url, id: x.id, name: x.name }; });
    var skipped = S.firstRun, W = Math.min(window.innerWidth || 393, 430) - 92;
    return '<div class="onb" id="s-onb"><section class="onb__card" aria-label="Today’s foray, playing"><div class="onb__wm"><span class="onb__brand">' + icon("band") + "4a</span></div>" +
      '<div class="onb__stage"><div class="onb__art">' + collage(arts, null, 0) + "</div>" + wellBand("detail", "foray", { draw: !skipped, key: "demo", w: W }) +
      '<div class="hero__meta"><span class="readout"><span data-onb-clock>' + clock(skipped ? 0 : TL.total * 0.31) + '</span><span class="muted"> / ' + clock(TL.total) + " · " + F.shows.length + " shows</span></span></div></div></section>" +
      '<div class="onb__copy"><h1 class="display">Podcasts, stitched around you.</h1><p class="body-lg muted">4a picks real shows each day and lines up the best parts into one listen.</p></div>' +
      '<div class="onb__actions"><button type="button" class="keycap keycap--persimmon keycap--lg keycap--wide" data-act="onb-play">' + icon("ph-play-fill") + (skipped ? "Play" : "Play today’s foray") + '</button><button type="button" class="textbtn" data-act="onb-skip">Just show me</button></div></div>';
  }

  /* ---------- deck: mini + tabs ---------- */
  function renderDeck() {
    var info = nowInfo(), mini = $("#mini"), sep = $("#decksep"), onb = S.base === "onboarding";
    var show = info && !S.miniHidden && !onb;
    document.body.classList.toggle("has-mini", !!show);
    mini.hidden = !show; sep.hidden = !show;
    if (show) {
      var lineModel = info.kind === "foray" ? "foray" : info.id;
      var artHTML = info.kind === "foray" ? forayCollage(44) : epArt(info.ep, 44);
      mini.setAttribute("aria-label", "Now playing: " + info.title + ", " + info.show);
      mini.innerHTML = '<div class="band band--line" data-band="' + (info.kind === "foray" ? "f" : "e:" + info.id) + '" aria-hidden="true"><div class="band__stage"><div class="band__layers">' +
        (info.kind === "foray" ? lineBars() : '<div class="band__base"><i class="bar bar--ep" data-v="--l:0;--w:100"></i></div><div class="band__fill"><i class="bar bar--ep" data-v="--l:0;--w:100"></i></div>') + "</div></div></div>" +
        '<button type="button" class="mini__body" data-act="np-open" aria-label="Open now playing">' + artHTML + '<span class="mini__text"><b class="clamp1">' + esc(info.title) + '</b><span class="ell">' + esc(info.show) + "</span></span></button>" +
        '<button type="button" class="keycap keycap--persimmon keycap--round" data-act="toggle" aria-label="' + (S.playing ? "Pause" : "Play") + '">' + icon(S.playing ? "ph-pause-fill" : "ph-play-fill") + "</button>" +
        '<button type="button" class="keycap keycap--paper keycap--sm" data-act="skip" data-s="30" aria-label="Skip forward 30 seconds">' + icon("skip-30") + "</button>";
      hydrate(mini);
    } else mini.innerHTML = "";
    var map = { home: 0, mini: 0, search: 1, library: 2 }, tabs = $("#tabs"), cur = S.base in map ? S.base : "home";
    tabs.style.setProperty("--i", map[cur] === undefined ? 0 : map[cur]);
    $$(".tab", tabs).forEach(function (a) {
      var on = (a.dataset.tab === "home" && (cur === "home" || cur === "mini")) || a.dataset.tab === cur;
      if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    var b = $("#badge"), n = upnextCount(); b.hidden = !n; b.textContent = n;
  }
  function lineBars() {
    var b = TL.items.map(function (it) { return it.type === "narration" ? '<i class="bar bar--n" data-v="--l:' + it.l.toFixed(3) + ";--w:" + it.w.toFixed(3) + '"></i>' : '<i class="bar c' + it.ci + '" data-v="--l:' + it.l.toFixed(3) + ";--w:" + it.w.toFixed(3) + '"></i>'; }).join("");
    return '<div class="band__base">' + b + '</div><div class="band__fill">' + b + "</div>";
  }

  /* ---------- progress + live UI ---------- */
  function xFor(key) {
    if (key === "empty") return 0.5;
    if (key === "f") return timeToX(S.pos.foray || 0);
    if (key === "demo") return S.firstRun ? 0 : timeToX(S.pos.demo == null ? TL.total * 0.31 : S.pos.demo);
    var id = key.slice(2), e = EP[id]; return Math.min(1, (S.pos[id] || 0) / e.sec);
  }
  function posFor(key) { return key === "f" ? (S.pos.foray || 0) : key === "demo" ? (S.firstRun ? 0 : (S.pos.demo == null ? TL.total * 0.31 : S.pos.demo)) : 0; }
  function updateBands() {
    $$("[data-band]").forEach(function (b) {
      if (b.classList.contains("band--dragging")) return;
      var key = b.dataset.band, x = xFor(key); b.style.setProperty("--x", x.toFixed(4));
      if (x < 0.002) b.setAttribute("data-idle", ""); else b.removeAttribute("data-idle");
      if (key === "f" || key === "demo") { /* the station under the needle gets the heavier label */
        var pos = posFor(key), ci = pos > 0 ? idxAt(pos) : -1;
        $$(".band__labels span", b).forEach(function (sp) { sp.classList.toggle("is-cur", ci >= +sp.dataset.a && ci <= +sp.dataset.b); });
      }
    });
  }
  /* Now Playing tint follows the station: the enamel of the show under the needle; narration ticks keep the previous tint (P0-5) */
  function stationTint() {
    if (!S.npOpen || !S.now || S.now.kind !== "foray") return;
    var it = TL.items[idxAt(S.pos.foray || 0)];
    if (it.type === "segment") np.style.setProperty("--np-tint", "var(--seg-c" + it.ci + ")");
  }
  var lastCur = -2;
  function tickUI() {
    updateBands();
    var n = S.now; if (!n) return;
    var p = curPos(), info = nowInfo();
    $$("[data-elapsed]").forEach(function (el) { el.innerHTML = S.buffering ? "…" : clk(p); });
    $$("[data-remaining]").forEach(function (el) { el.innerHTML = "-" + clk(info.sec - p); });
    var sl = $(".band--scrub"); if (sl && !sl.classList.contains("band--dragging")) { sl.setAttribute("aria-valuenow", Math.round(p)); }
    if (n.kind === "foray") { var ci = idxAt(p); if (ci !== lastCur) { lastCur = ci; if (S.npOpen) { renderNPChips(); stationTint(); } } }
  }

  var timer = setInterval(function () {
    if (!S.playing || !S.now) return;
    var info = nowInfo(), p = curPos() + 0.25 * S.speed;
    if (p >= info.sec) { setPos(info.sec); endOfItem(); return; }
    setPos(p); tickUI();
  }, 250);
  function endOfItem() {
    var info = nowInfo();
    if (info.kind === "ep") S.history.unshift(info.id);
    var next = S.queue.shift();
    if (next) { S.now = { kind: "ep", id: next }; S.pos[next] = 0; if (S.npOpen) renderNP(); }
    else S.playing = false;
    renderDeck(); updateBands(); refreshPlayButtons();
  }
  function refreshPlayButtons() {
    $$('[data-act="play"]').forEach(function (b) {
      if (b.dataset.pin) { b.innerHTML = pinInner(); return; }
      var cur = isCur(b.dataset.kind, b.dataset.id) && S.playing, lab = b.getAttribute("aria-label").replace(/^(Play|Pause) /, "");
      b.setAttribute("aria-label", (cur ? "Pause " : "Play ") + lab);
      b.innerHTML = icon(cur ? "ph-pause-fill" : "ph-play-fill");
    });
  }

  /* ---------- Now Playing ---------- */
  var np = $("#np");
  function npChipsHTML() {
    var info = nowInfo(), out = "";
    if (info.kind === "foray") {
      var it = TL.items[idxAt(S.pos.foray || 0)];
      out = it.type === "narration" ? tag("narration", "4a narration") : '<span class="tag tag--station"><i class="swatch c' + it.ci + '"></i><b class="code">' + esc(codeFor(it.show_id, FSH[it.show_id].name)) + "</b>" + esc(FSH[it.show_id].name) + "</span>";
    } else {
      if (S.downloaded.has(info.id)) out += tag("downloaded", "Downloaded");
      if (S.history.indexOf(info.id) >= 0) out += tag("played", "Played");
    }
    return out;
  }
  function renderNPChips() { var c = $("#npchips"); if (c) c.innerHTML = npChipsHTML(); var u = $("#npupnext"); if (u) u.innerHTML = upNextCard(); }
  function upNextCard() {
    var info = nowInfo();
    if (info.kind === "foray") {
      var i = idxAt(S.pos.foray || 0), nx = null;
      for (var j = i + 1; j < TL.items.length; j++) if (TL.items[j].type === "segment") { nx = TL.items[j]; break; }
      if (!nx) return '<p class="body muted">That is the last segment of this foray.</p>';
      var sh = FSH[nx.show_id];
      return '<div class="sheetcard row">' + art({ url: sh.artwork_url, id: sh.id, name: sh.name, s: 56 }) + '<div class="row__body"><h3 class="row__title clamp1">' + esc(sh.name) + '</h3><p class="row__why clamp2">' + esc(nx.why) + '</p></div><span class="readout muted">' + clock(nx.sec) + "</span></div>";
    }
    var nid = S.queue[0]; if (!nid) return '<p class="body muted">Nothing queued. Add an episode and it plays next.</p>';
    var e = EP[nid];
    return '<div class="sheetcard row">' + epArt(e, 56) + '<div class="row__body"><h3 class="row__title clamp2">' + esc(e.title) + '</h3><p class="row__why clamp2">' + esc(e.hook) + '</p></div><span class="readout muted">' + durText(e.duration_min) + "</span></div>";
  }
  function dockHTML() {
    var info = nowInfo();
    var transport = '<div class="transport">' + keycap({ act: "skip", cls: "keycap--rubber keycap--lg keycap--round", label: "Back 15 seconds", icon: "skip-15", attrs: ' data-s="-15"' }) +
      keycap({ act: "toggle", cls: "keycap--persimmon keycap--xl keycap--round", label: S.playing ? "Pause" : "Play", icon: S.playing ? "ph-pause-fill" : "ph-play-fill", attrs: ' id="npplay"' }) +
      keycap({ act: "skip", cls: "keycap--rubber keycap--lg keycap--round", label: "Forward 30 seconds", icon: "skip-30", attrs: ' data-s="30"' }) + "</div>";
    if (S.dial) return transport + dialHTML();
    var bm = S.bookmarks.has(info.id), n = upnextCount();
    return transport + '<div class="second">' +
      '<button type="button" class="chip" data-act="dial" data-dial="speed" aria-expanded="false" aria-label="Playback speed"><span class="readout">' + S.speed.toFixed(1) + "×</span></button>" +
      '<button type="button" class="chip" data-act="dial" data-dial="sleep" aria-expanded="false" aria-label="Sleep timer"><span class="lbl">Sleep ·</span><span class="readout">' + (S.sleep ? S.sleep + " min" : "Off") + "</span></button>" +
      '<button type="button" class="keycap keycap--sm keycap--paper" data-act="bookmark" aria-label="' + (bm ? "Remove bookmark" : "Bookmark this moment") + '"' + (bm ? ' data-on="1"' : "") + ">" + icon(bm ? "ph-bookmark-simple-fill" : "ph-bookmark-simple") + "</button>" +
      '<button type="button" class="iconbtn iconbtn--badge" data-act="to-upnext" aria-label="Up Next, ' + n + ' queued">' + icon("ph-list-bullets", "i--sm") + '<span class="chip__n">' + n + "</span></button></div>";
  }
  var SPEEDS = [0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.8, 2], SLEEPS = [0, 5, 10, 15, 20, 30, 45, 60];
  function dialHTML() {
    var isSpeed = S.dial === "speed", vals = isSpeed ? SPEEDS : SLEEPS, cur = isSpeed ? S.speed : S.sleep;
    var ticks = vals.map(function (v) {
      return '<button type="button" class="dial__tick" role="radio" data-act="dial-pick" data-v="' + v + '" aria-checked="' + (v === cur) + '" aria-label="' + (isSpeed ? v.toFixed(1) + " times" : v ? v + " minutes" : "Off") + '"><span class="readout">' + (isSpeed ? v.toFixed(1) : v || "Off") + "</span></button>";
    }).join("");
    return '<div class="dial" role="group" aria-label="' + (isSpeed ? "Speed" : "Sleep timer") + '">' + keycap({ act: "dial-step", cls: "keycap--sm keycap--paper", label: "Less", icon: "ph-arrow-left", attrs: ' data-d="-1"' }) +
      '<div class="well dial__strip" role="radiogroup">' + ticks + "</div>" + keycap({ act: "dial-step", cls: "keycap--sm keycap--paper", label: "More", icon: "ph-arrow-right", attrs: ' data-d="1"' }) + keycap({ act: "dial-close", cls: "keycap--sm keycap--persimmon", label: "Done", icon: "ph-check" }) + "</div>";
  }
  function renderDock() {
    var d = $(".np__dock", np); if (!d) return; d.innerHTML = dockHTML(); hydrate(d);
    var sel = $('.dial__tick[aria-checked="true"]', d); if (sel) { var st = sel.parentNode; st.scrollLeft = sel.offsetLeft - st.clientWidth / 2 + 22; }
  }
  /* demo chapters (episodes carry none in the catalogue): positions as a share of runtime */
  var CHAPTERS = [0, 0.09, 0.24, 0.41, 0.58, 0.74, 0.9];
  function renderNP() {
    var info = nowInfo(); if (!info) return;
    var isF = info.kind === "foray", p = curPos();
    var artHTML = isF ? forayCollage(0) : epArt(info.ep, 0, "art--main");
    var badge = !isF && S.downloaded.has(info.id) ? '<span class="badge" aria-label="Downloaded">' + icon("ph-check-circle-fill") + "</span>" : "";
    var more = "";
    if (isF) {
      var curI = idxAt(p), counts = {}; TL.items.forEach(function (it) { if (it.type === "segment") counts[it.show_id] = (counts[it.show_id] || 0) + 1; });
      more = '<section id="sec-upnext"><h2 class="heading">Up next</h2><div id="npupnext">' + upNextCard() + "</div></section>" +
        '<section><h2 class="heading">Segments</h2>' + slotGroups(function (it, i) { return segRow(it, i, curI); }) + "</section>" +
        '<section><h2 class="heading">Where this came from</h2>' + F.shows.map(function (s) { return fromRow(s, counts); }).join("") + "</section>";
    } else {
      more = '<section id="sec-upnext"><h2 class="heading">Up next</h2><div id="npupnext">' + upNextCard() + "</div></section>" +
        '<section><h2 class="heading">Chapters</h2>' + CHAPTERS.map(function (c, i) {
          var t = Math.round(c * info.sec);
          return '<button type="button" class="chrow" data-act="seek-ch" data-t="' + t + '"><span class="readout muted">' + clock(t) + '</span><span class="row__title clamp1">Chapter ' + (i + 1) + "</span></button>";
        }).join("") + "</section>" +
        '<section><h2 class="heading">Show notes</h2><p class="body">' + esc(info.ep.hook) + "</p></section>";
    }
    np.setAttribute("aria-label", "Now playing: " + info.title);
    np.classList.toggle("glance", false);
    np.classList.toggle("is-buffering", !!S.buffering);
    np.innerHTML = '<div class="np__bg"></div><div class="np__scroll" id="npscroll"><div class="np__top">' +
      '<div class="np__head" data-drag><button type="button" class="np__collapse" data-act="np-close" aria-label="Collapse now playing">' + icon("ph-caret-down") + '</button><span class="grabber"></span></div>' +
      '<div class="np__hero" data-drag><div class="np__art" id="npart">' + artHTML + badge + "</div></div>" +
      '<div class="np__text"><h2 class="title clamp3">' + esc(info.title) + '</h2><p class="body-lg muted clamp1">' + esc(info.show) + '</p><div class="np__chips" id="npchips">' + npChipsHTML() + "</div></div>" +
      '<div class="np__band"><div class="well band-wrap">' + bandHTML("scrub", isF ? "foray" : info.id) + '</div><div class="np__read"><span class="readout-lg" data-elapsed>' + clk(p) + '</span><span class="readout muted" data-remaining>-' + clk(info.sec - p) + "</span></div></div></div>" +
      '<div class="np__more">' + more + "</div></div>" +
      '<div class="np__dock">' + dockHTML() + "</div>";
    hydrate(np); updateBands(); setTint(info);
    $$("[data-drag]", np).forEach(function (el) { el.addEventListener("pointerdown", dragStart); });
    var sl = $(".band--scrub", np); wireScrub(sl);
    if (S.buffering && sl) sl.classList.add("band--buffering");
    lastCur = isF ? idxAt(p) : -2; tickUI();
  }

  /* ---- tint (P0-5): foray = the enamel under the needle; episode = artwork colour via OKLCH, enamel when grey ---- */
  function parseColor(str) {
    str = String(str || "").trim(); var m;
    if ((m = str.match(/^#([0-9a-f]{6})$/i))) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16), 1];
    if ((m = str.match(/^rgba?\(([^)]+)\)$/i))) { var a = m[1].split(/[ ,\/]+/).filter(Boolean).map(parseFloat); return [a[0], a[1], a[2], a.length > 3 ? a[3] : 1]; }
    return null;
  }
  function lin(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  function gam(c) { c = Math.max(0, Math.min(1, c)); return 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055); }
  function lum(rgb) { return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]); }
  function toOklab(r, g, b) {
    var l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b), m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b), s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s, 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s];
  }
  function fromOklab(L, a, b) {
    var l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3), m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3), s = Math.pow(L - 0.0894841775 * a - 1.2914855480 * b, 3);
    return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s];
  }
  function inGamut(v) { return v[0] >= 0 && v[0] <= 1 && v[1] >= 0 && v[1] <= 1 && v[2] >= 0 && v[2] <= 1; }
  /* runtime contrast check: ink over (scrim over tint) must reach 4.5:1, else the scrim goes to 0.9 */
  function checkScrim(tintRgb) {
    var sc = parseColor(tok("--scrim-np")), ink = parseColor(tok("--ink")); np.style.removeProperty("--np-scrim");
    if (!sc || !ink || !tintRgb) return;
    var bg = [0, 1, 2].map(function (i) { return sc[i] * sc[3] + tintRgb[i] * (1 - sc[3]); });
    var a = lum(bg) + 0.05, b = lum(ink) + 0.05, ratio = Math.max(a, b) / Math.min(a, b);
    if (ratio < 4.5) np.style.setProperty("--np-scrim", "rgba(" + sc[0] + "," + sc[1] + "," + sc[2] + ",0.9)");
  }
  function enamelFor(ci) { np.style.setProperty("--np-tint", "var(--seg-c" + ci + ")"); checkScrim(parseColor(tok("--seg-c" + ci))); }
  function hashStr(s) { var h = 5381; for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }
  function setTint(info) {
    if (info.kind === "foray") { /* nearest segment at or before the needle */
      var i = idxAt(S.pos.foray || 0); while (i > 0 && TL.items[i].type !== "segment") i--;
      enamelFor(TL.items[i].type === "segment" ? TL.items[i].ci : info.ci); return;
    }
    enamelFor(info.ci);
    var url = safeUrl(info.ep.artwork_url), key = "cp_art_tint:" + info.ep.show_id; if (!url) return;
    var h = hashStr(url), c = store.get(key);
    var apply = function (rgbStr) { np.style.setProperty("--np-tint", rgbStr); checkScrim(parseColor(rgbStr)); };
    if (c && c.indexOf(h + "|") === 0) { var v = c.slice(h.length + 1); if (v !== "enamel") apply(v); return; }
    var im = new Image(); im.crossOrigin = "anonymous";
    im.onload = function () {
      try {
        var cv = document.createElement("canvas"); cv.width = cv.height = 32; var cx = cv.getContext("2d"); cx.drawImage(im, 0, 0, 32, 32);
        var d = cx.getImageData(0, 0, 32, 32).data, r = 0, g = 0, b = 0, n = 0;
        for (var k = 0; k < d.length; k += 4) { r += lin(d[k]); g += lin(d[k + 1]); b += lin(d[k + 2]); n++; }
        var lab = toOklab(r / n, g / n, b / n), C = Math.hypot(lab[1], lab[2]), hue = Math.atan2(lab[2], lab[1]);
        if (C < 0.04) { store.set(key, h + "|enamel"); return; } /* grey average: keep the show's enamel */
        var L = Math.min(0.6, Math.max(0.45, lab[0])), rgb = fromOklab(L, C * Math.cos(hue), C * Math.sin(hue)), guard = 0;
        while (!inGamut(rgb) && guard++ < 24) { C *= 0.92; rgb = fromOklab(L, C * Math.cos(hue), C * Math.sin(hue)); }
        var out = "rgb(" + rgb.map(function (x) { return Math.round(gam(x)); }).join(",") + ")";
        store.set(key, h + "|" + out); apply(out);
      } catch (e) { /* CORS: keep the enamel */ }
    };
    im.src = url;
  }


  var kb = false; document.addEventListener("keydown", function () { kb = true; }, true); document.addEventListener("pointerdown", function () { kb = false; }, true);
  var npOpener = null;
  function restRect(el, bodyClass, restoreFn) { /* rect of el with body class toggled, transitions off */ return null; }
  function openNP(animate) {
    var info = nowInfo(); if (!info) return;
    var wasOpen = S.npOpen; S.npOpen = true; renderNP();
    var miniArt = $("#mini .mini__body .art, #mini .mini__body .collage");
    var from = miniArt && animate && !wasOpen ? miniArt.getBoundingClientRect() : null;
    document.body.classList.add("np-open");
    ["#screen", "#deck", "#field"].forEach(function (s) { var el = $(s); if (el) el.setAttribute("inert", ""); });
    if (!animate) { np.style.transition = "none"; }
    np.classList.add("open");
    var art = $("#npart", np);
    if (from && art) {
      np.style.transition = "none"; var to = art.getBoundingClientRect();
      np.classList.remove("open"); void np.offsetWidth; np.style.transition = ""; np.classList.add("open");
      art.style.opacity = "0";
      flyer(miniArt, from, { left: to.left, top: to.top, width: to.width, height: to.height }, "--spring-sheet", "--d-sheet", 8, 22, function () { art.style.opacity = ""; });
    }
    if (!animate) { void np.offsetWidth; np.style.transition = ""; }
    npOpener = document.activeElement; np.setAttribute("tabindex", "-1"); setTimeout(function () { var pl = kb && $("#npplay"); (pl || np).focus({ preventScroll: true }); }, animate ? 60 : 0);
  }
  function closeNP(animate) {
    if (!S.npOpen) return;
    S.npOpen = false; S.dial = null;
    var art = $("#npart", np), from = art && animate ? art.getBoundingClientRect() : null, to = null;
    var miniArt = $("#mini .mini__body .art, #mini .mini__body .collage");
    if (from && miniArt && !$("#mini").hidden) { /* where the mini art will rest: its sunk rect minus the deck's current translation */
      var r = miniArt.getBoundingClientRect(), ty = new DOMMatrix(getComputedStyle($("#deck")).transform).m42;
      to = { left: r.left, top: r.top - ty, width: r.width, height: r.height };
    }
    document.body.classList.remove("np-open");
    ["#screen", "#deck", "#field"].forEach(function (s) { var el = $(s); if (el) el.removeAttribute("inert"); });
    if (!animate) np.style.transition = "none";
    np.classList.remove("open"); np.style.transform = "";
    if (!animate) { void np.offsetWidth; np.style.transition = ""; }
    if (from && to) { miniArt.style.visibility = "hidden"; flyer(art, from, to, "--spring-sheet", "--d-sheet", 22, 8, function () { miniArt.style.visibility = ""; }); }
    if (npOpener && npOpener.focus) { try { npOpener.focus({ preventScroll: true }); } catch (e) { /* gone */ } }
  }
  function flyer(src, a, b, easeTok, durTok, r0, r1, done) {
    if (!src || !a.width || !b.width || dur(durTok) < 5) { if (done) done(); return; }
    var c = src.cloneNode(true); c.removeAttribute("id"); c.classList.add("chip-fly");
    c.style.cssText = "left:" + a.left + "px;top:" + a.top + "px;width:" + a.width + "px;height:" + a.height + "px;";
    c.style.setProperty("--s", a.width + "px"); document.body.appendChild(c);
    var sx = b.width / a.width, sy = b.height / a.height;
    var an = anim(c, [{ transform: "translate(0,0) scale(1,1)", borderRadius: r0 + "px", transformOrigin: "0 0" }, { transform: "translate(" + (b.left - a.left) + "px," + (b.top - a.top) + "px) scale(" + sx + "," + sy + ")", borderRadius: r1 / sx + "px", transformOrigin: "0 0" }], easeTok, durTok);
    an.onfinish = an.oncancel = function () { c.remove(); if (done) done(); };
  }

  /* drag-to-dismiss: finger-tracked, released to the sheet spring */
  var drag = null;
  function dragStart(e) {
    if (e.button > 0) return; drag = { y: e.clientY, t: e.timeStamp, dy: 0, id: e.pointerId, last: e.clientY, lt: e.timeStamp, v: 0 };
    np.classList.add("dragging"); document.addEventListener("pointermove", dragMove); document.addEventListener("pointerup", dragEnd); document.addEventListener("pointercancel", dragEnd);
  }
  function dragMove(e) {
    if (!drag) return; drag.dy = Math.max(0, e.clientY - drag.y); np.style.transform = "translateY(" + drag.dy + "px)";
    var dt = e.timeStamp - drag.lt; if (dt > 0) drag.v = (e.clientY - drag.last) / dt; drag.last = e.clientY; drag.lt = e.timeStamp;
  }
  function dragEnd() {
    document.removeEventListener("pointermove", dragMove); document.removeEventListener("pointerup", dragEnd); document.removeEventListener("pointercancel", dragEnd);
    if (!drag) return; var d = drag; drag = null; np.classList.remove("dragging");
    if (d.dy > np.offsetHeight * 0.3 || d.v > 0.5) { haptic(); go(S.base === "mini" ? "#/mini" : "#/" + (S.base || "home")); np.style.transform = ""; }
    else np.style.transform = "";
  }

  /* scrubber: needle follows the finger, snaps to segment boundaries, seeks on release */
  function wireScrub(sl) {
    if (!sl) return;
    var model = sl.dataset.band, rect, snapped = null;
    function frac(e) { rect = sl.querySelector(".band__stage").getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)); }
    function show(x) {
      var info = nowInfo(), t = model === "f" ? xToTime(x) : x * info.sec, label = "";
      if (model === "f") { var it = TL.items[idxAt(t)]; label = (it.type === "narration" ? "4a narration" : FSH[it.show_id].name) + " · "; }
      sl.style.setProperty("--x", x.toFixed(4)); sl.style.setProperty("--bx", Math.min(0.8, Math.max(0.2, x)).toFixed(3));
      $(".band-bubble", sl).innerHTML = esc(label) + clk(t); $("[data-elapsed]", np).innerHTML = clk(t); $("[data-remaining]", np).innerHTML = "-" + clk(info.sec - t);
      sl.setAttribute("aria-valuetext", Math.round(t / 60) + " minutes of " + Math.round(info.sec / 60));
    }
    sl.addEventListener("pointerdown", function (e) {
      sl.setPointerCapture(e.pointerId); sl.classList.add("band--dragging"); sl.classList.remove("band--snap"); haptic();
      var move = function (ev) {
        var x = frac(ev), snap = null;
        if (model === "f") TL.items.forEach(function (it) { if (Math.abs(it.l / 100 - x) * rect.width < 12) snap = it.l / 100; });
        if (snap !== null) { if (snapped !== snap) { snapped = snap; haptic(); } x = snap; } else snapped = null;
        show(x); sl._x = x;
      };
      var up = function () {
        sl.removeEventListener("pointermove", move); sl.removeEventListener("pointerup", up); sl.removeEventListener("pointercancel", up);
        sl.classList.add("band--snap"); sl.classList.remove("band--dragging");
        var info = nowInfo(), x = sl._x == null ? 0 : sl._x; setPos(model === "f" ? xToTime(x) : x * info.sec); tickUI(); setTimeout(function () { sl.classList.remove("band--snap"); }, 400);
      };
      sl.addEventListener("pointermove", move); sl.addEventListener("pointerup", up); sl.addEventListener("pointercancel", up); move(e);
    });
    sl.addEventListener("keydown", function (e) {
      var info = nowInfo(), p = curPos(), k = e.key, t = null;
      if (k === "ArrowLeft") t = p - 15; else if (k === "ArrowRight") t = p + 30;
      else if ((k === "ArrowUp" || k === "ArrowDown") && model === "f") { var i = idxAt(p); i = Math.max(0, Math.min(TL.items.length - 1, i + (k === "ArrowUp" ? 1 : -1))); t = TL.items[i].t0 + 0.1; }
      if (t === null) return; e.preventDefault(); setPos(Math.max(0, Math.min(info.sec - 1, t))); tickUI(); haptic();
      sl.setAttribute("aria-valuetext", Math.round(curPos() / 60) + " minutes of " + Math.round(info.sec / 60));
    });
  }

  /* ---------- playback actions ---------- */
  function startPlay(kind, id, srcEl, at) {
    var wasNow = S.now; var same = isCur(kind, id);
    if (same && !at && at !== 0) { S.playing = !S.playing; renderDeck(); refreshPlayButtons(); if (S.npOpen) renderDock(); haptic(); return; }
    S.now = { kind: kind, id: id }; S.playing = true; S.resume = null; S.miniHidden = false;
    if (at != null) S.pos[kind === "foray" ? "foray" : id] = at;
    else if (kind === "foray" && (S.pos.foray || 0) >= TL.total - 1) S.pos.foray = 0;
    S.queue = S.queue.filter(function (q) { return q !== id; });
    var fromEl = srcEl && srcEl.closest("[data-card], .row, .segrow, .pin, .onb") ? (srcEl.closest("[data-card], .row, .segrow, .pin, .onb").querySelector(".art, .collage")) : null;
    var from = fromEl ? fromEl.getBoundingClientRect() : null;
    renderDeck(); hydrate($("#deck")); updateBands(); refreshPlayButtons(); haptic();
    mediaSession();
    var dst = $("#mini .mini__body .art, #mini .mini__body .collage");
    if (from && dst && !wasNow) { var m = $("#mini"); anim(m, [{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "none" }], "--spring-settle", "--d-settle"); }
    if (from && dst) { var to = dst.getBoundingClientRect(); dst.style.visibility = "hidden"; flyer(fromEl, from, { left: to.left, top: to.top, width: to.width, height: to.height }, "--spring-settle", "--d-settle", 8, 8, function () { dst.style.visibility = ""; }); }
    if (S.npOpen) renderNP();
    if (S.base === "library") refreshLibrary();
  }
  function mediaSession() {
    try {
      var i = nowInfo(); if (!i || !("mediaSession" in navigator)) return;
      var u = safeUrl(i.kind === "foray" ? F.shows[0].artwork_url : i.ep.artwork_url);
      navigator.mediaSession.metadata = new MediaMetadata({ title: i.title, artist: i.kind === "foray" ? "4a foray · " + F.shows.length + " shows" : i.show, album: i.why || "", artwork: u ? [96, 128, 192, 256, 384, 512].map(function (n) { return { src: u, sizes: n + "x" + n, type: "image/jpeg" }; }) : [] });
    } catch (e) { /* unsupported */ }
  }
  function skip(sec) { if (!S.now) return; var info = nowInfo(); setPos(Math.max(0, Math.min(info.sec - 1, curPos() + sec))); tickUI(); haptic(); }

  /* ---------- toast, sheet ---------- */
  var toastT = null, toastUndo = null;
  function toast(msg, undo) {
    var t = $("#toast"); toastUndo = undo || null;
    t.innerHTML = "<span>" + esc(msg) + "</span>" + (undo ? '<button type="button" class="textbtn" data-act="undo">Undo</button>' : "");
    t.classList.add("show"); clearTimeout(toastT); toastT = setTimeout(function () { t.classList.remove("show"); }, undo ? 5000 : 3200);
    t.onpointerdown = function () { clearTimeout(toastT); };
  }
  function openSettings() {
    var sh = $("#sheet"), th = S.theme || "auto";
    sh.innerHTML = '<div class="sect__head"><h2 class="title">Settings</h2><button type="button" class="textbtn" data-act="settings-close">Done</button></div>' +
      '<div class="dialrow"><span class="label">Appearance</span><div class="well seg" role="radiogroup" aria-label="Appearance">' +
      [["light", "Cream"], ["dark", "Bakelite"], ["auto", "Auto"]].map(function (o) { return '<button type="button" role="radio" data-act="theme" data-v="' + o[0] + '" aria-checked="' + (th === o[0]) + '">' + o[1] + "</button>"; }).join("") + "</div></div>" +
      '<div class="dialrow"><div class="dialrow__top"><span class="label">Dials</span><span class="micro muted">4a’s setting is the centre detent</span></div>' +
      [["Engineering", 7], ["History", 4]].map(function (d) { var n = d[0], v = d[1]; return '<div class="dialrow__top"><span class="body">' + n + '</span><span class="readout muted" data-dial-read>' + (v === 5 ? "" : (v > 5 ? "+" : "\u2212") + Math.abs(v - 5)) + '</span></div><label class="well knobtrack" data-v="--g:' + (v / 10).toFixed(2) + '"><span class="sr">' + n + '</span><input type="range" min="0" max="10" step="1" value="' + v + '" aria-valuetext="' + (v === 5 ? "4a’s setting" : (v > 5 ? "plus " : "minus ") + Math.abs(v - 5)) + '"><i class="dial__detent"></i><i class="dial__fill"></i><i class="dial__needle"></i></label>'; }).join("") +
      '<p class="micro muted">The exploration floor stays at about a third. It is not a dial.</p></div>';
    hydrate(sh); $("#scrim").classList.add("show"); sh.classList.add("show"); sh.setAttribute("tabindex", "-1"); try { sh.focus({ preventScroll: true }); } catch (e) { sh.focus(); }
  }
  var dialLast = {};
  function dialInput(inp) { /* fill, needle and offset follow the value; crossing the detent is a selection haptic */
    var v = +inp.value, lab = inp.closest(".knobtrack"), rd = lab.previousElementSibling && lab.previousElementSibling.querySelector("[data-dial-read]"), k = $$(".knobtrack").indexOf(lab);
    lab.style.setProperty("--g", (v / 10).toFixed(2));
    if (rd) rd.textContent = v === 5 ? "" : (v > 5 ? "+" : "\u2212") + Math.abs(v - 5);
    inp.setAttribute("aria-valuetext", v === 5 ? "4a’s setting" : (v > 5 ? "plus " : "minus ") + Math.abs(v - 5));
    if (v === 5 && dialLast[k] !== 5) haptic();
    dialLast[k] = v;
  }
  function closeSettings() { $("#scrim").classList.remove("show"); $("#sheet").classList.remove("show"); }
  function setTheme(v) {
    S.theme = v; store.set("cp_theme", v);
    if (v === "auto") root.removeAttribute("data-theme"); else root.setAttribute("data-theme", v);
  }

  /* ---------- library helpers ---------- */
  /* the selected chip scrolls into view with "nearest" semantics; a chip left clipped at the edge is stepped past so no sliver shows */
  function fitChip() {
    var st = $(".strip[role=tablist]"); if (!st) return;
    var sel = $('.chip[aria-selected="true"]', st); if (!sel) return;
    st.scrollLeft = 0;
    var sr = st.getBoundingClientRect(), r = sel.getBoundingClientRect(), pad = 16;
    if (r.right > sr.right - pad) st.scrollLeft += r.right - (sr.right - pad);
    var chips = $$(".chip", st);
    for (var i = 0; i < chips.length; i++) {
      var c = chips[i].getBoundingClientRect();
      if (c.left < sr.left + pad - 1 && c.right > sr.left) { st.scrollLeft += c.right - sr.left + 2; break; }
    }
  }
  function refreshLibrary() {
    var b = $("#libbody"); if (!b) return;
    b.innerHTML = libBody(); hydrate(b); updateBands();
    var strip = $(".strip[role=tablist]"); if (strip) strip.innerHTML = chipsHTML();
    var rd = $("#libread"); if (rd) rd.textContent = libReadout();
    fitChip();
  }

  function flipRows(fn) {
    var before = {}; $$("[data-flip]").forEach(function (r) { before[r.dataset.flip] = r.getBoundingClientRect().top; });
    fn();
    $$("[data-flip]").forEach(function (r) { var o = before[r.dataset.flip]; if (o == null) return; var d = o - r.getBoundingClientRect().top; if (d) anim(r, [{ transform: "translateY(" + d + "px)" }, { transform: "none" }], "--spring-settle", "--d-settle"); });
  }
  function flyChipToYours(srcBtn) {
    var tab = $('.tab[data-tab="library"] .tab__icon'), a = srcBtn.closest("[data-card]"); a = a ? a.querySelector(".art") : null;
    var badge = $("#badge"); var tick = function () { badge.classList.add("tick"); setTimeout(function () { badge.classList.remove("tick"); }, 220); };
    renderDeck(); if (!a || !tab) { tick(); return; }
    var ra = a.getBoundingClientRect(), rt = tab.getBoundingClientRect();
    flyer(a, ra, { left: rt.left, top: rt.top, width: 24, height: 24 }, "--spring-settle", "--d-settle", 8, 6, tick);
  }

  /* ---------- routing ---------- */
  var screenEl = $("#screen");
  var BUILD = { home: screenHome, mini: screenHome, search: screenFind, library: screenLibrary, foray: screenForay, onboarding: screenOnboarding, toast: screenLibrary, settings: screenHome };
  var BASE = { toast: "library", settings: "home" }; /* state routes that live on a tab */
  /* sub-routes that scroll a section to the top on mount (P0-3) */
  var SCROLLS = { "home/also": "#sec-also", "home/playlists": "#sec-playlists", "home/ground": "#sec-ground", "foray/segments": "#sec-segments", "search/mosaic": "#sec-mosaic" };
  function afterRender(name, fresh) {
    if (!fresh) return;
    var sel = SCROLLS[name + "/" + String(S.sub || "").split("/")[0]];
    if (sel) {
      var go2 = function () { var el = $(sel); if (el) window.scrollTo(0, Math.max(0, el.getBoundingClientRect().top + window.scrollY - 12)); };
      go2(); if (document.fonts && document.fonts.ready) document.fonts.ready.then(go2);
    }
    if (S.toastOnLoad) { S.toastOnLoad = false; toast("Removed from Up Next", function () { var i = Math.min(S.toastIdx, S.queue.length); S.queue.splice(i, 0, S.toastRemoved); refreshLibrary(); renderDeck(); }); }
    if (S.settingsOnLoad) { S.settingsOnLoad = false; openSettings(); }
  }
  function renderScreen(name, instant, fresh) {
    var apply = function () {
      S.base = BASE[name] || name; S.rendered = name; screenEl.innerHTML = BUILD[name](); hydrate(screenEl);
      document.body.classList.toggle("onboarding", name === "onboarding");
      document.body.classList.toggle("route-foray", name === "foray");
      document.body.classList.toggle("route-search", name === "search");
      $("#field").hidden = name !== "search";
      var q = $("#q"); if (q) { q.value = S.q; $("#qclear").hidden = !S.q; }
      renderDeck(); updateBands(); window.scrollTo(0, 0); deckCollapse(false); startOnb(name); fitChip();
      afterRender(name, fresh);
    };
    if (!instant && document.startViewTransition && S.rendered) { try { document.startViewTransition(apply); return; } catch (e) { /* fall through */ } }
    apply();
  }
  var onbT = null;
  function startOnb(name) {
    clearInterval(onbT); if (name !== "onboarding" || S.firstRun) return;
    if (S.pos.demo == null) S.pos.demo = TL.total * 0.31;
    var c0 = $("[data-onb-clock]"); if (c0) c0.textContent = clock(S.pos.demo);
    onbT = setInterval(function () { var t = S.pos.demo + 0.1 * TL.total * 0.08; if (t >= TL.total) t = 0; S.pos.demo = t; var b = $("#s-onb .band"); if (b) b.style.setProperty("--x", timeToX(t).toFixed(4)); var c = $("[data-onb-clock]"); if (c) c.textContent = clock(t); }, 100);
  }
  function parse() { var m = (location.hash || "").match(/^#\/([a-z-]+)(?:\/([\w\/-]+))?/); return m ? { name: m[1], sub: m[2] || null } : null; }
  function handleRoute(external) {
    var r = parse();
    if (!r || !(r.name in BUILD || r.name === "now-playing")) { history.replaceState({ int: 1 }, "", "#/onboarding"); r = { name: "onboarding", sub: null }; external = true; }
    var name = r.name;
    if (external) {
      applyFixture(name, r.sub);
      if (S.npOpen) { closeNP(false); }
      S.sub = r.sub;
    }
    if (name === "now-playing") {
      if (!S.now) seedForay();
      if (S.rendered == null || external) { renderScreen(S.base && S.base !== "onboarding" && !external ? S.base : "home", true, false); }
      openNP(!external && S.rendered != null);
      if (external && r.sub === "more") { var sc = $("#npscroll"), up = $("#sec-upnext"); if (sc && up) sc.scrollTop = Math.max(0, up.offsetTop - 12); }
      renderDeck();
      return;
    }
    if (S.npOpen) { var same = S.base === name && !external; closeNP(!external); if (same) { renderDeck(); return; } }
    renderScreen(name, external, external);
  }

  function go(hash) { history.pushState({ int: 1 }, "", hash); handleRoute(false); }
  window.addEventListener("popstate", function (e) { handleRoute(!(e.state && e.state.int)); });

  /* ---------- events ---------- */
  document.addEventListener("error", function (e) { var t = e.target; if (t && t.tagName === "IMG") t.remove(); }, true);
  document.addEventListener("touchstart", function () { }, { passive: true });
  document.addEventListener("click", function (e) {
    var a = e.target.closest("a[href^='#/']");
    if (a) { e.preventDefault(); if (a.classList.contains("tab")) { if (a.dataset.tab === S.base || (a.dataset.tab === "home" && S.base === "mini")) { window.scrollTo({ top: 0 }); return; } haptic(); } go(a.getAttribute("href")); return; }
    var b = e.target.closest("[data-act]"); if (!b) return;
    var act = b.dataset.act, id = b.dataset.id;
    switch (act) {
      case "play": startPlay(b.dataset.kind, id, b); break;
      case "toggle": S.playing = !S.playing; renderDeck(); refreshPlayButtons(); if (S.npOpen) renderDock(); haptic(); break;
      case "skip": skip(+b.dataset.s); break;
      case "seek-ch": setPos(+b.dataset.t); tickUI(); haptic(); break;
      case "np-open": go("#/now-playing"); break;
      case "np-close": go(S.base === "mini" ? "#/mini" : "#/" + (S.base || "home")); break;
      case "queue-add":
        if (S.queue.indexOf(id) < 0 && !(S.now && S.now.id === id)) { S.queue.push(id); haptic(); flyChipToYours(b); refreshQueueButtons(id); toast("Added to Up Next"); }
        break;
      case "lib-tab": S.libTab = b.dataset.tab; S.openRow = null; haptic(); refreshLibrary(); break;
      case "qmore": S.openRow = S.openRow === id ? null : id; refreshLibrary(); break;
      case "qup": case "qdown": { var i = S.queue.indexOf(id); var j = act === "qup" ? i - 1 : i + 1; if (i >= 0 && j >= 0 && j < S.queue.length) { flipRows(function () { var t = S.queue[i]; S.queue[i] = S.queue[j]; S.queue[j] = t; refreshLibrary(); }); haptic(); } break; }
      case "qrm": {
        var wasCur = S.now && S.now.id === id, idx = S.queue.indexOf(id), snap = { now: S.now, playing: S.playing };
        flipRows(function () { if (wasCur) { S.now = null; S.playing = false; } else if (idx >= 0) S.queue.splice(idx, 1); S.openRow = null; refreshLibrary(); renderDeck(); });
        haptic(); toast("Removed from Up Next", function () { if (wasCur) { S.now = snap.now; } else S.queue.splice(Math.min(idx, S.queue.length), 0, id); refreshLibrary(); renderDeck(); }); break;
      }
      case "qclear": { var old = { q: S.queue.slice(), now: S.now }; S.queue = []; S.openRow = null; refreshLibrary(); renderDeck(); toast("Up Next cleared", function () { S.queue = old.q; refreshLibrary(); renderDeck(); }); break; }
      case "undo": if (toastUndo) toastUndo(); toastUndo = null; $("#toast").classList.remove("show"); break;
      case "dial": S.dial = b.dataset.dial; haptic(); renderDock(); break;
      case "dial-close": S.dial = null; renderDock(); break;
      case "dial-pick": if (S.dial === "speed") S.speed = +b.dataset.v; else S.sleep = +b.dataset.v; haptic(); renderDock(); break;
      case "dial-step": { var vals = S.dial === "speed" ? SPEEDS : SLEEPS, cur = S.dial === "speed" ? S.speed : S.sleep, k = vals.indexOf(cur) + (+b.dataset.d); k = Math.max(0, Math.min(vals.length - 1, k)); if (S.dial === "speed") S.speed = vals[k]; else S.sleep = vals[k]; haptic(); renderDock(); break; }
      case "bookmark": { var nid = S.now && (S.now.kind === "foray" ? F.id : S.now.id); if (S.bookmarks.has(nid)) S.bookmarks.delete(nid); else { S.bookmarks.add(nid); toast("Saved to Yours"); } haptic(); renderDock(); break; }
      case "to-upnext": S.libTab = "upnext"; go("#/library"); break;
      case "settings": openSettings(); break;
      case "settings-close": closeSettings(); break;
      case "theme": setTheme(b.dataset.v); $$("[data-act=theme]").forEach(function (x) { x.setAttribute("aria-checked", x === b); }); break;
      case "follow": if (S.followed.has(id)) S.followed.delete(id); else S.followed.add(id); haptic(); b.setAttribute("aria-pressed", S.followed.has(id)); b.innerHTML = S.followed.has(id) ? icon("ph-check") + "Following" : "Follow"; break;
      case "subject": { var sj = D.subjects.filter(function (s) { return s.id === id; })[0]; var q = $("#q"); q.value = sj.name; S.q = sj.name; $("#qclear").hidden = false; $("#results").innerHTML = resultsHTML(); hydrate($("#results")); break; }
      case "more-subjects": S.subjRot += 5; $("#results").innerHTML = idleHTML(""); hydrate($("#results")); haptic(); break;
      case "focus-field": $("#q").focus(); break;
      case "make": toast("4a is building a playlist about ‘" + b.dataset.q + "’."); break;
      case "play-seg": { var it = TL.items[+b.dataset.i]; startPlay("foray", F.id, b, it.t0); break; }
      case "play-pl": { var pl = D.playlists.filter(function (p) { return p.id === id; })[0]; startPlay("ep", pl.episodes[0], b); pl.episodes.slice(1).forEach(function (q) { if (S.queue.indexOf(q) < 0) S.queue.push(q); }); renderDeck(); break; }
      case "onb-play": S.firstRun = true; go("#/home"); startPlay("foray", F.id, null); break;
      case "onb-skip": S.firstRun = true; go("#/home"); break;
      case "back": if (history.state && history.state.int && history.length > 1) history.back(); else go("#/home"); break;
      case "share": toast("The system share sheet opens here in the app."); break;
    }
  });
  function refreshQueueButtons(id) {
    $$('[data-act="queue-add"]').forEach(function (b) {
      if (b.dataset.id !== id) return;
      b.classList.add("is-on", "is-fresh"); b.innerHTML = icon("ph-check", "i--xs") + "<span>Queued</span>"; b.setAttribute("aria-label", "In Up Next");
      setTimeout(function () { b.classList.remove("is-fresh"); var sp = $("span", b); if (sp) sp.textContent = "In Up Next"; }, 2000); /* ✓ Queued for 2s, then the quiet state */
    });
  }
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { if ($("#sheet").classList.contains("show")) closeSettings(); else if (S.npOpen) go(S.base === "mini" ? "#/mini" : "#/" + (S.base || "home")); }
    if (e.key === "Tab" && S.npOpen) { var f = $$("button, [tabindex='0']", np).filter(function (x) { return x.offsetParent; }); if (!f.length) return; var first = f[0], last = f[f.length - 1]; if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); } }
  });
  $("#scrim").addEventListener("click", closeSettings);
  $("#sheet").addEventListener("input", function (e) { if (e.target.matches(".knobtrack input")) dialInput(e.target); });
  $("#q").addEventListener("input", function (e) { S.q = e.target.value; $("#qclear").hidden = !S.q; var r = $("#results"); if (r) { r.innerHTML = S.q.trim() ? resultsHTML() : idleHTML(""); hydrate(r); } });
  $("#qclear").addEventListener("click", function () { $("#q").value = ""; S.q = ""; $("#qclear").hidden = true; var r = $("#results"); if (r) { r.innerHTML = idleHTML(""); hydrate(r); } $("#q").focus(); });

  /* mini player: swipe down on the body to stop, with undo */
  (function () {
    var m = $("#mini"), st = null;
    m.addEventListener("pointerdown", function (e) { var b = e.target.closest(".mini__body"); if (!b) return; st = { y: e.clientY, x: e.clientX }; });
    window.addEventListener("pointerup", function (e) {
      if (!st) return; var dy = e.clientY - st.y, dx = Math.abs(e.clientX - st.x); st = null;
      if (dy > 60 && dx < 40 && S.now) {
        var snap = { now: S.now, playing: S.playing }; if (S.now.kind === "ep" || S.pos.foray > 3) S.resume = { kind: S.now.kind, id: S.now.id };
        S.now = null; S.playing = false; haptic(); renderDeck(); toast("Stopped playback", function () { S.now = snap.now; S.playing = snap.playing; S.resume = null; renderDeck(); updateBands(); });
        if (S.base === "home") { screenEl.innerHTML = screenHome(); hydrate(screenEl); updateBands(); }
      }
    });
  })();

  /* deck collapses to icons on scroll-down */
  var lastY = 0, deckTick = null;
  function deckCollapse(on) { $("#deck").classList.toggle("deck--collapsed", on); }
  window.addEventListener("scroll", function () {
    if (deckTick) return; deckTick = setTimeout(function () { deckTick = null; var y = window.scrollY; if (y > 24 && y > lastY + 4) deckCollapse(true); else if (y < lastY - 4 || y <= 24) deckCollapse(false); lastY = y; }, 100);
  }, { passive: true });

  /* ---------- boot ---------- */
  /* ?theme=dark|light (set before first paint by boot.js) wins over the stored choice and is not stored */
  var qTheme = (location.search.match(/[?&]theme=(dark|light)/) || [])[1];
  var savedTheme = qTheme || store.get("cp_theme"); if (savedTheme === "light" || savedTheme === "dark") { S.theme = savedTheme; root.setAttribute("data-theme", savedTheme); }
  window.__dial = { S: function () { return S; }, go: go };
  handleRoute(true);
})();
