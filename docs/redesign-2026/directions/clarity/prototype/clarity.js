/* Clarity ("The Board") prototype, round 3 (critique-r2 applied). Classic script, no build, no inline styles:
   widths and fills are set through the CSSOM after render (hydrate()).
   Playback is simulated; no audio is loaded. */
(function () { try { var t = new URLSearchParams(location.search).get("theme"); if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t); } catch (e) {} })();
(function () {
  "use strict";
  var D = window.CLARITY_DATA;
  var QS = new URLSearchParams(location.search);
  var STATE = QS.get("state") || "";
  var URL_THEME = /^(light|dark)$/.test(QS.get("theme") || "") ? QS.get("theme") : "";
  var E = D.episodes, F = D.foray;
  var byId = {}; E.forEach(function (e) { byId[e.id] = e; });
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)");

  /* ---------------------------------------------------------------- helpers */
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function safeUrl(u) { return /^https:\/\//i.test(u || "") ? u : ""; }
  function store(k, v) { try { if (v === undefined) return localStorage.getItem("cp_" + k); localStorage.setItem("cp_" + k, v); } catch (e) { return null; } }
  function icon(id, cls) { return '<svg class="i' + (cls ? " " + cls : "") + '" aria-hidden="true"><use href="#i-' + id + '"/></svg>'; }
  function plural(n, a, b) { return n + " " + (n === 1 ? a : b); }
  /* r1 critique 8: an hour or more is one mono line, "3h 14m"; under an hour, "37 min". */
  function fmtMin(min) {
    min = Math.round(min);
    if (min < 60) return min + " min";
    var h = Math.floor(min / 60), m = min % 60;
    return m ? h + "h " + String(m).padStart(2, "0") + "m" : h + "h";  /* r2 item 12: 3h 05m, so the h aligns down the mono column */
  }
  function fmtSpoken(min) {
    min = Math.round(min);
    if (min < 60) return min + " minutes";
    var h = Math.floor(min / 60), m = min % 60;
    return h + (h === 1 ? " hour" : " hours") + (m ? " " + m + " minutes" : "");
  }
  function durHTML(min) { return "<span>" + fmtMin(min) + "</span>"; }
  function tbtn(label, attrs, o) {
    o = o || {};
    return '<button class="btn ' + (o.quiet ? "btn--text-quiet" : "btn--text") + '" ' + attrs + ">" + esc(label) + (o.quiet ? "" : icon("chevron-right")) + "</button>";
  }
  function clock(sec, neg) {
    sec = Math.max(0, Math.round(sec));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    var t = h ? h + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0") : m + ":" + String(s).padStart(2, "0");
    return (neg ? "-" : "") + t;
  }
  function spoken(sec) { sec = Math.round(sec); return Math.floor(sec / 60) + " minutes " + (sec % 60) + " seconds"; }
  function haptic() { /* Web+: @capacitor/haptics calls go here; silent in a plain web build. */ }
  function art(url, alt, eager) { var u = safeUrl(url); return u ? '<img src="' + esc(u) + '" alt="' + esc(alt || "") + '" loading="' + (eager ? "eager" : "lazy") + '" decoding="async">' : ""; }
  function mono(name) { return '<span class="art--mono">' + esc((name || "?").replace(/^the\s+/i, "").charAt(0).toUpperCase()) + "</span>"; }
  document.addEventListener("error", function (ev) { var t = ev.target; if (t && t.tagName === "IMG") t.style.visibility = "hidden"; }, true);

  /* ---------------------------------------------------------------- foray model */
  var parts = STATE === "foray-unnarrated" ? F.parts.filter(function (p) { return p.type === "segment"; }) : F.parts, segCount = 0, acc = 0;
  parts.forEach(function (p) { p.start = acc; acc += p.sec; if (p.type === "segment") { segCount++; p.no = segCount; } });
  var TOTAL = acc;
  var showMeta = {}; F.shows.forEach(function (s) { showMeta[s.id] = s; });
  function segPartAt(pos) {
    for (var i = parts.length - 1; i >= 0; i--) if (pos >= parts[i].start) return parts[i];
    return parts[0];
  }
  /* r2 item 1: the foray composite is drawn ONCE (a 256px master canvas, kept in memory for the session) and copied
     with drawImage into every slot that shows it: the lead row, the mini, the sheet, the flyers. It is never drawn during
     a transition, so no slot is ever empty when the shared element arrives. Nothing is persisted. */
  var compArts = F.shows.slice(0, 4).map(function (s) { return safeUrl(s.art); });
  var compMaster = null, compReady = false;
  function ensureComp() {
    if (compMaster) return;
    compMaster = document.createElement("canvas"); compMaster.width = compMaster.height = 256;
    var ctx = compMaster.getContext("2d"), left = compArts.length;
    ctx.fillStyle = "#7a7a7a"; ctx.fillRect(0, 0, 256, 256);
    var done = function () { if (--left > 0) return; compReady = true; paintComps(document); };
    compArts.forEach(function (u, i) {
      var im = new Image(); im.decoding = "async";
      im.onload = function () { ctx.drawImage(im, (i % 2) * 129, Math.floor(i / 2) * 129, 127, 127); done(); };
      im.onerror = function () { done(); };
      if (u) im.src = u; else done();
    });
  }
  function paintComps(root) {
    if (!compReady || !compMaster) return;
    $$("canvas.compc", root).forEach(function (c) { var x = c.getContext("2d"); if (x) x.drawImage(compMaster, 0, 0, c.width, c.height); });
  }
  function compHTML() { ensureComp(); return '<span class="art--compbox"><canvas class="compc" width="256" height="256" aria-hidden="true"></canvas></span>'; }

  function stripHTML(opts) {
    opts = opts || {};
    var cls = "strip" + (opts.lg ? " strip--lg" : "") + (opts.prog ? " strip--prog" : "") + (opts.cls ? " " + opts.cls : "");
    var h = '<span class="' + cls + '" data-strip aria-hidden="true">';
    parts.forEach(function (p, i) {
      var c = p.type === "segment" ? " c" + showMeta[p.show_id].color : " seg--n";
      h += '<i class="seg' + c + '" data-sec="' + p.sec + '" data-i="' + i + '">' + (opts.prog ? '<b class="seg__fill"></b>' : "") + "</i>";
    });
    if (opts.prog) h += '<s class="strip__head" data-p="0"></s>';
    return h + "</span>";
  }
  function ticksHTML() {
    var h = '<div class="ticks" aria-hidden="true">';
    for (var t = 0; t <= TOTAL; t += 300) {
      h += '<i data-left="' + (t / TOTAL * 100).toFixed(3) + '"></i>';
      if (t % 600 === 0) h += '<b class="' + (t / TOTAL > 0.94 ? "tick--end" : "") + '" data-left="' + (t / TOTAL * 100).toFixed(3) + '">' + (t / 60) + "</b>";
    }
    return h + "</div>";
  }
  function paintStrip(strip, pos, state) {
    if (!strip) return;
    var kids = strip.children;
    for (var i = 0; i < kids.length; i++) {
      var k = kids[i]; if (!k.classList.contains("seg")) continue;
      var p = parts[+k.dataset.i], f = Math.max(0, Math.min(1, (pos - p.start) / p.sec));
      var fill = k.firstChild; if (fill) fill.style.setProperty("--f", f.toFixed(4));
    }
    var head = strip.querySelector(".strip__head");
    if (head) head.style.setProperty("--p", (pos / TOTAL).toFixed(5));
    strip.classList.toggle("strip--done", state === "done");
  }
  function hydrate(root) {
    $$("[data-sec]", root).forEach(function (e) { e.style.flexGrow = e.dataset.sec; });
    $$("[data-left]", root).forEach(function (e) { e.style.left = e.dataset.left + "%"; });
    $$("[data-p]", root).forEach(function (e) { e.style.setProperty("--p", e.dataset.p); });
    paintComps(root);
  }

  /* ---------------------------------------------------------------- state */
  var P = null;           // player: {kind, id, pos, dur, playing}
  var Q = [];             // up next episode ids
  var pickIds = ["lex-353-whyte", "sysk-damascus-steel", "foc-assyrians", "conan-mcbride-returns", E[8].id];
  var resumeEp = E[6], resumeP = 0.42;
  var resumeRows = [[E[6], 0.42], [E[7], 0.18]];
  var savedIds = [E[10].id, E[11].id, E[12].id];
  var historyRows = [[E[13].id, "Yesterday"], [E[14].id, "3 Oct"], [E[15].id, "1 Oct"], [E[16].id, "14 Dec 2025"]];
  var skipUsed = {}; pickIds.concat([resumeEp.id, E[7].id]).concat(savedIds).concat(historyRows.map(function (h) { return h[0]; })).forEach(function (i) { skipUsed[i] = 1; });
  E.forEach(function (e) { if (Q.length < 8 && !skipUsed[e.id]) Q.push(e.id); });
  /* ?state= seeds: offline marks the foray and two picks as saved (downloaded); midlisten gives the foray a resume point. */
  var offlineSaved = {}; offlineSaved["foray"] = 1; offlineSaved[pickIds[2]] = 1; offlineSaved[pickIds[3]] = 1;
  var S = { view: "home", prev: "#/home", q: "", npAll: false, notes: false, speed: 1.5, sleep: 0, bookmarked: {}, weights: {}, theme: URL_THEME || store("theme") || "system", fpos: STATE === "midlisten" ? 580 : 0, offlineOnly: false, allSubj: false };
  if (STATE === "find-empty") S.q = "fusion";
  D.subjects.slice(0, 7).forEach(function (s, i) { S.weights[s.id] = [8, 7, 6, 5, 5, 4, 3][i]; });
  var undoState = null, undoTimer = 0, menuOpen = null;

  function startForay() {
    var seg8 = parts.filter(function (p) { return p.type === "segment" && p.no === 8; })[0];
    P = { kind: "foray", id: F.id, pos: seg8.start + 61, dur: TOTAL, playing: true };
  }
  function startEnding() {
    /* np-end: an episode three seconds from its end, held there so the Up next line can rise into the title slot. */
    var e = byId[pickIds[3]];
    P = { kind: "ep", id: e.id, pos: Math.round(e.min * 60) - 3, dur: Math.round(e.min * 60), playing: true, hold: true };
  }
  function ensureP() { if (!P) { if (STATE === "np-end") startEnding(); else { startForay(); if (STATE === "np-buffering") P.buffering = true; } } }
  function forayPos() { return P && P.kind === "foray" ? P.pos : S.fpos || 0; }
  function endNear() { return !!(P && P.kind === "ep" && P.dur - P.pos <= 5 && Q[0]); }
  function cur() { return P && (P.kind === "foray" ? { title: F.title, show: "Foray · " + F.subject, why: F.why, foray: true } : (function () { var e = byId[P.id]; return { title: e.title, show: e.show, why: e.hook, art: e.art, ep: e }; })()); }
  function playEp(id) { var e = byId[id]; P = { kind: "ep", id: id, pos: 0, dur: Math.round(e.min * 60), playing: true }; var qi = Q.indexOf(id); if (qi > -1) Q.splice(qi, 1); }
  function playForay() { if (!(P && P.kind === "foray")) { P = { kind: "foray", id: F.id, pos: S.fpos || 0, dur: TOTAL, playing: true }; } else P.playing = true; }

  /* ---------------------------------------------------------------- rows */
  function bridgeParts(b) {
    var t = b.replace(/^your\s+/i, "").replace(/\s+interest\b/i, "").split("->");
    return [t[0].trim(), (t[1] || "").trim()];
  }
  /* r2 item 9: the arrow and the target never part ("→ materials science" is one nowrap pair); the only break
     allowed is between the source and the arrow, so a wrapped bridge starts its second line with the arrow. */
  function bridgeHTML(e) {
    var b = bridgeParts(e.bridge);
    return '<span class="bridge"><span>' + esc(b[0]) + '</span><span class="bridge__to">' + icon("arrow-right") + "<span>" + esc(b[1]) + "</span></span></span>";
  }
  /* r2 item 5: the lead's control is always the 44px Signal circle; mid-play it is labelled "Resume" for assistive tech only. */
  function capsuleHTML(act, id, aria) {
    return '<button class="capsule capsule--icon" data-act="' + act + '"' + (id ? ' data-id="' + esc(id) + '"' : "") + ' aria-label="' + esc(aria) + '">' + icon("play") + "</button>";
  }
  function leftHTML(min) { return '<span class="dur2"><span>' + fmtMin(min) + '</span><span class="t-data-sm">left</span></span>'; }
  function rowEp(e, o) {
    o = o || {};
    var lead = !!o.lead, stretch = !!e.bridge && !o.noBridge && o.why !== false && !lead;
    var cls = "row" + (lead ? " row--lead" : "") + (stretch ? " row--stretch" : "") + (o.dim ? " row--dim" : "") + (o.prog != null ? " row--resume" : "");
    var why = o.whyText || e.hook;
    var h = '<div class="' + cls + '" role="button" tabindex="0" data-act="open-ep" data-id="' + esc(e.id) + '"' + (o.dim ? ' aria-disabled="true"' : "");
    h += ' aria-label="' + esc((stretch ? "Stretch pick: " : "") + e.title + ", " + e.show + ", " + fmtSpoken(e.min) + (o.badge ? ", saved" : "") + (o.why !== false ? ", " + why : "")) + '">';
    if (o.prog != null) h += '<span class="row__art row__art--prog"><span class="row__artbox">' + (art(e.art, "") || mono(e.show)) + '</span><span class="prog" data-p="' + o.prog + '"></span></span>';
    else h += '<span class="row__art">' + (art(e.art, "") || mono(e.show)) + "</span>";
    h += '<span class="row__stack">';
    if (lead) h += '<span class="t-caption row__eyebrow">' + esc(o.eyebrow || "Today’s lead") + "</span>";
    if (stretch) h += bridgeHTML(e);
    h += '<span class="t-caption row__show clamp1">' + esc(e.show) + (e.explicit ? ' <span class="badge">E</span>' : "") + "</span>";
    h += '<span class="t-strong row__title ' + (lead ? "clamp2" : "clamp1") + '" title="' + esc(e.title) + '">' + esc(e.title) + "</span>";
    if (o.why !== false) h += '<span class="t-body row__why clamp2">' + esc(why) + "</span>";
    h += "</span>";
    h += '<span class="row__data">';
    if (lead) h += capsuleHTML("play-ep", e.id, (o.mid ? "Resume " : "Play ") + e.title);
    h += o.data != null ? o.data : durHTML(e.min);
    if (o.badge) h += '<span class="badge">saved</span>';
    h += "</span></div>";
    return h;
  }
  function rowForay(o) {
    o = o || {};
    var lead = !!o.lead;
    var cls = "row" + (lead ? " row--lead" : "") + (o.dim ? " row--dim" : "");
    var h = '<div class="' + cls + '" role="button" tabindex="0" data-act="open-foray" aria-label="' + esc("Foray: " + F.title + ", " + fmtSpoken(TOTAL / 60) + ", " + F.shows.length + " shows" + (o.badge ? ", saved" : "")) + '">';
    h += '<span class="row__art">' + compHTML() + "</span>";
    h += '<span class="row__stack">';
    /* r2 item 4: the same two caption lines as every other lead: "Today's lead", then "Foray · 7 shows" (ink, 500) */
    if (lead) h += '<span class="t-caption row__eyebrow">' + esc(o.eyebrow || "Today’s lead") + "</span>";
    h += '<span class="t-caption row__show">Foray · ' + F.shows.length + " shows</span>";
    h += '<span class="t-strong row__title ' + (lead ? "clamp2" : "clamp1") + '">' + esc(F.title) + "</span>";
    h += '<span class="t-body row__why clamp2">' + esc(F.why) + "</span>";
    h += stripHTML({ cls: "strip--row" }) + "</span>";
    h += '<span class="row__data">';
    if (lead) h += capsuleHTML("play-foray", "", (o.mid ? "Resume " : "Play ") + F.title);
    h += o.mid ? leftHTML((TOTAL - S.fpos) / 60) : durHTML(TOTAL / 60);
    if (o.badge) h += '<span class="badge">saved</span>';
    h += "</span></div>";
    return h;
  }
  function sechead(t, n) { return '<div class="sechead t-caption"><h2>' + esc(t) + "</h2>" + (n != null ? '<span class="t-data-sm">' + esc(n) + "</span>" : "") + "</div>"; }
  function rowShow(s) {
    return '<div class="row row--show" role="button" tabindex="0" data-act="open-show" data-id="' + esc(s.id) + '"><span class="row__art">' + (art(s.art, "") || mono(s.name)) + '</span><span class="row__stack"><span class="t-strong clamp1">' + esc(s.name) + '</span></span><span class="row__data">' + s.eps + "</span></div>";
  }
  function rowSubject(s) {
    return '<div class="row row--show row--noart subjrow" role="button" tabindex="0" data-act="open-subject" data-id="' + esc(s.id) + '"><span class="row__stack"><span class="t-strong row__title clamp1">' + esc(s.label) + '</span></span><span class="row__data">' + s.shows + "</span></div>";
  }
  function skelRow(lead) {
    return '<div class="row row--skel' + (lead ? " row--lead" : "") + '" aria-hidden="true"><span class="row__art skel"></span><span class="row__stack"><span class="skel skel--cap"></span><span class="skel skel--title"></span><span class="skel skel--why"></span><span class="skel skel--why skel--short"></span>' + (lead ? '<span class="skel skel--strip"></span>' : "") + '</span><span class="row__data"><span class="skel skel--dur"></span></span></div>';
  }

  /* ---------------------------------------------------------------- screens */
  var DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function dateLabel() { var d = new Date(2026, 9, 5); return DAYS[d.getDay()] + " " + d.getDate() + " " + MON[d.getMonth()]; }

  /* Today: lead, Resume (only when something is mid-play), Forays for you, Picked for you (r1 critique 6).
     ?state= seeds: firstrun, midlisten, offline, loading. */
  function screenToday() {
    var firstrun = STATE === "firstrun", offline = STATE === "offline", mid = STATE === "midlisten", loading = STATE === "loading";
    var picks = pickIds.map(function (i) { return byId[i]; });
    var leadForay = !firstrun;
    var n = picks.length + (leadForay ? 1 : 0);
    var outside = firstrun ? 0 : picks.filter(function (e) { return e.bridge; }).length;
    var stat = !firstrun && !loading && outside > 0 && n - outside > 0 ? n + " picks · " + outside + " outside your usual lane" : "";
    /* r2 item 7: two date elements, both always present; collapse is a transform + opacity crossfade, never font-size */
    var h = '<header class="hdr hdr--today" id="todayHdr"><span class="hdr__dates"><h1 class="today__date t-data-lg">' + esc(dateLabel()) + '</h1><span class="today__date-sm t-caption" aria-hidden="true">' + esc(dateLabel()) + '</span></span><button class="iconbtn" data-act="open-you" aria-label="You">' + icon("user") + "</button></header>";
    if (stat) h += '<p class="stat t-data muted" id="todayStat">' + esc(stat) + "</p>";
    if (loading) {
      h += '<div class="gap12"></div><div role="status" aria-label="Loading today’s picks">' + skelRow(true) + sechead("Picked for you") + skelRow() + skelRow() + skelRow() + skelRow() + "</div>";
      return h;
    }
    if (offline) h += '<div class="empty empty--top"><span class="t-body">Offline. Saved episodes play.</span>' + tbtn(S.offlineOnly ? "Show all" : "Show saved", 'data-act="offline-toggle"') + "</div>";
    else h += '<div class="gap12"></div>';
    var rowOpts = function (e) { return offline ? { dim: !offlineSaved[e.id], badge: !!offlineSaved[e.id] } : {}; };
    if (leadForay) h += rowForay({ lead: true, mid: S.fpos > 5, badge: offline });
    else h += rowEp(picks[0], { lead: true, eyebrow: "Picked to start", whyText: picks[0].fr, noBridge: true });
    if (mid) {
      h += sechead("Resume", String(resumeRows.length));
      resumeRows.forEach(function (r) {
        var left = Math.round(r[0].min * (1 - r[1]));
        h += rowEp(r[0], { why: false, prog: r[1], data: '<span class="dur2"><span>' + left + ' min</span><span class="t-data-sm">left</span></span>' });
      });
    }
    if (!leadForay) h += sechead("Forays for you", "1") + rowForay();
    var list = leadForay ? picks : picks.slice(1);
    h += sechead("Picked for you", String(list.length));
    list.forEach(function (e) {
      var o = rowOpts(e);
      if (offline && S.offlineOnly && o.dim) return;
      if (firstrun) { o.whyText = e.fr; o.noBridge = true; }
      h += rowEp(e, o);
    });
    return h;
  }

  function screenFind() {
    var h = '<header class="hdr"><h1 class="t-title">Find</h1></header><div class="gap16"></div><div id="results"></div>';
    return h;
  }
  function resultsHTML(q) {
    q = (q || "").trim();
    var ql = q.toLowerCase(), h = "";
    if (!q) {
      /* r1 critique 14: a row, not a heading: 56px, plus in a 44px hairline circle, a caption under the label. */
      h += '<div class="row row--noart row--name" role="button" tabindex="0" data-act="focus-field"><span class="row__stack"><span class="t-strong">Name a subject</span><span class="t-caption muted">Build a foray on anything</span></span><span class="row__data"><span class="pluscircle">' + icon("plus") + "</span></span></div>";
      h += sechead("Subjects", String(D.subjects.length));
      /* r2 item 11: six subjects, then one ink row, so "Shows you follow" and its first row sit in the first viewport. */
      D.subjects.slice(0, S.allSubj ? D.subjects.length : 6).forEach(function (s) { h += rowSubject(s); });
      if (!S.allSubj && D.subjects.length > 6) h += '<div class="textrow">' + tbtn("All " + D.subjects.length + " subjects", 'data-act="all-subjects"') + "</div>";
      h += sechead("Shows you follow", String(D.shows.length));
      D.shows.slice(0, 5).forEach(function (s) { h += rowShow(s); });
      h += sechead("Recent");
      [E[17], E[18], E[19]].forEach(function (e) { h += rowEp(e, { why: false }); });
      return h;
    }
    var forced = STATE === "find-empty" && ql === "fusion";
    var shows = forced ? [] : D.shows.filter(function (s) { return s.name.toLowerCase().indexOf(ql) > -1; });
    var eps = forced ? [] : E.filter(function (e) { return (e.title + " " + e.show + " " + e.hook).toLowerCase().indexOf(ql) > -1; });
    var pls = [];
    if (!forced) {
      if ((F.title + " " + F.subject + " " + F.summary).toLowerCase().indexOf(ql) > -1) pls.push("foray");
      D.playlists.forEach(function (p) { if (p.label.toLowerCase().indexOf(ql) > -1) pls.push(p); });
    }
    if (!shows.length && !eps.length && !pls.length) {
      h += '<p class="noresult t-body">Nothing for ‘' + esc(q) + "’.</p>";
      var subj = D.subjects.filter(function (s) { return s.label.toLowerCase().split(/[^a-z]+/).some(function (w) { return w && w.indexOf(ql) === 0; }); })[0];
      if (subj) h += '<p class="noresult noresult--tight t-body muted">' + esc(subj.label) + " has " + plural(subj.shows, "show", "shows") + "</p>" + rowSubject(subj);
      else h += '<p class="noresult t-body muted">Try a show name or a subject.</p>';
      if (q.length >= 3 && !subj) h += '<div class="textrow"><button class="btn btn--secondary" data-act="toast" data-msg="Playlists on your own subjects arrive with custom forays.">Build a playlist on ‘' + esc(q) + "’</button></div>";
      return h;
    }
    if (shows.length) { h += sechead("Shows", String(shows.length)); shows.forEach(function (s) { h += rowShow(s); }); }
    if (eps.length) { h += sechead("Episodes", String(eps.length)); eps.slice(0, 6).forEach(function (e) { h += rowEp(e, { why: false }); }); }
    if (pls.length) {
      h += sechead("Playlists", String(pls.length));
      pls.forEach(function (p) {
        if (p === "foray") h += rowForay();
        else h += '<div class="row row--noart row--show" role="button" tabindex="0"><span class="row__stack"><span class="t-strong clamp1">' + esc(p.label) + '</span></span><span class="row__data">' + p.n + "</span></div>";
      });
    }
    return h;
  }

  /* r1 critique 9: queue row title is body-strong, one line; position is data muted; "Now" is the one Signal word. */
  function nowRowQ(i, label, ep, isNow) {
    var c = P && isNow ? cur() : null;
    var artH = isNow && P && P.kind === "foray" ? compHTML() : art(ep && ep.art, "") || mono(ep && ep.show);
    var title = isNow && c ? c.title : ep.title, sub = isNow && c ? c.show : ep.show;
    var rem = isNow && P ? Math.round((P.dur - P.pos) / 60) : ep.min;
    var h = '<div class="rowq' + (isNow ? " is-now" : "") + '" data-qi="' + (isNow ? -1 : label) + '">';
    h += '<span class="rowq__pos"><span class="t-data">' + i + "</span>" + (isNow ? '<span class="t-data-sm now">Now</span>' : "") + "</span>";
    h += '<span class="rowq__art">' + artH + "</span>";
    h += '<span class="rowq__txt"><span class="t-strong clamp1">' + esc(title) + '</span><span class="t-caption muted clamp1">' + esc(sub) + "</span></span>";
    h += '<span class="rowq__data">' + (rem < 1 ? "<1 min" : fmtMin(rem)) + "</span>";
    h += isNow ? "<span></span>" : '<button class="iconbtn" data-act="qmenu" data-id="' + esc(ep.id) + '" aria-label="More for ' + esc(ep.title) + '">' + icon("more") + "</button>";
    return h + "</div>";
  }
  function screenLibrary() {
    var h = '<header class="hdr"><h1 class="t-title">Library</h1><button class="iconbtn" data-act="scroll-saved" aria-label="Saved">' + icon("download") + "</button></header><div class=\"gap16\"></div>";
    h += '<div class="shows-grid">' + D.shows.slice(0, 6).map(function (s) { return '<a class="cell" href="#/search" aria-label="' + esc(s.name) + '"><span class="cell__art">' + (art(s.art, "") || mono(s.name)) + '</span><span class="t-caption cell__name clamp1">' + esc(s.name) + "</span></a>"; }).join("") + "</div>";
    h += '<div class="textrow">' + tbtn("All " + D.shows.length + " shows", 'data-act="nav" data-to="#/search"') + "</div>";
    h += sechead("Forays", "1") + rowForay();
    var total = Q.length + (P ? 1 : 0);
    h += sechead("Up Next", String(total));
    var n = 1;
    if (P) { h += nowRowQ(n++, 0, P.kind === "ep" ? byId[P.id] : null, true); }
    Q.slice(0, P ? 4 : 5).forEach(function (id, qi) { h += nowRowQ(n++, qi, byId[id], false); });
    if (total > 5) h += '<div class="textrow">' + tbtn("All " + total, 'data-act="toast" data-msg="The full Up Next page lists all ' + total + '."') + "</div>";
    h += '<div id="savedAnchor"></div>' + sechead("Saved", String(savedIds.length));
    savedIds.forEach(function (id) { h += rowEp(byId[id], { why: false, badge: true }); });
    h += sechead("Playlists", String(D.playlists.length));
    D.playlists.forEach(function (p) { h += '<div class="row row--noart row--show" role="button" tabindex="0"><span class="row__stack"><span class="t-strong clamp1">' + esc(p.label) + '</span></span><span class="row__data">' + p.n + "</span></div>"; });
    h += sechead("History");
    historyRows.forEach(function (r) { h += rowEp(byId[r[0]], { why: false, data: "<span>" + esc(r[1]) + "</span>" }); });
    return h;
  }

  var forayAllSegs = false;
  function screenForay() {
    var pos = forayPos(), unavailable = STATE === "foray-unavailable", unnarrated = STATE === "foray-unnarrated";
    var state = pos >= TOTAL - 1 && P && P.kind === "foray" ? "done" : pos > 5 ? "prog" : "new";
    /* r1 critique 20: back chevron and the eyebrow share one 44px line, the eyebrow centred. */
    var h = '<header class="hdr hdr--fd"><button class="iconbtn iconbtn--back" data-act="back" aria-label="Back">' + icon("chevron-left") + '</button><p class="t-caption fd__eyebrow">Foray · ' + esc(F.subject) + '</p><span class="hdr__sp"></span></header>';
    h += '<div class="fd"><h1 class="t-display fd__title clamp3">' + esc(F.title) + "</h1>";
    h += '<p class="t-data fd__meta">' + esc(fmtMin(TOTAL / 60) + " · " + segCount + " segments · " + F.shows.length + " shows") + "</p>";
    if (unavailable) h += '<div class="fd__strip" id="fdStrip">' + stripHTML({ lg: true, cls: "strip--off" }) + ticksHTML() + "</div>";
    else h += '<div class="fd__strip" id="fdStrip">' + stripHTML({ lg: true, prog: true, cls: state === "done" ? "strip--done" : "" }) + ticksHTML() + "</div>";
    if (unnarrated) h += '<p class="t-caption fd__note">No narration yet</p>';
    h += '<p class="fd__why t-body"><span class="t-caption">Why for you</span>' + esc(F.why) + "</p>";
    if (unavailable) h += '<p class="fd__why t-body">Not available right now; the shows are still here.</p></div>';
    else {
      h += '<div class="fd__actions"><button class="btn btn--primary" data-act="play-foray">' + icon("play") + (state === "prog" ? "Resume at " + clock(pos) : state === "done" ? "Play again" : "Play") + '</button>';
      h += '<button class="btn btn--secondary" data-act="toast" data-msg="Added to Up Next.">' + icon("list-plus") + 'Up Next</button><button class="iconbtn" data-act="share" aria-label="Share">' + icon("share") + "</button></div></div>";
    }
    h += sechead("Where this came from", plural(F.shows.length, "show", "shows"));
    F.shows.forEach(function (s) {
      var ps = parts.filter(function (p) { return p.show_id === s.id; });
      var sec = ps.reduce(function (a, p) { return a + p.sec; }, 0);
      h += '<div class="rowseg rowseg--legend c' + s.color + '"><span class="rowseg__chip"></span><span class="rowseg__txt"><span class="t-label clamp1">' + esc(s.name) + '</span></span><span class="t-data-sm seg-n">' + ps.length + ' seg</span><span class="data">' + Math.round(sec / 60) + " min</span></div>";
    });
    h += sechead("Segments", String(segCount));
    var shown = 0;
    parts.forEach(function (p) {
      if (p.type !== "segment") return;
      shown++; if (!forayAllSegs && shown > 6) return;
      h += segRow(p);
    });
    if (!forayAllSegs) h += '<div class="textrow">' + tbtn("All " + segCount + " segments", 'data-act="all-segs"') + "</div>";
    h += '<div class="fd"><p class="t-body fd__sum">' + esc(F.summary) + "</p></div>";
    return h;
  }
  function segRow(p, isNow) {
    if (p.type === "narration") return '<div class="rowseg rowseg--n' + (isNow ? " is-now" : "") + '" data-pi="' + parts.indexOf(p) + '"><span class="rowseg__idx t-data-sm"></span><span class="rowseg__chip"></span><span class="rowseg__txt"><span class="t-label">Narration' + (isNow ? ' <span class="t-data-sm now">Now</span>' : "") + '</span></span><span class="data">' + clock(p.sec) + "</span></div>";
    var s = showMeta[p.show_id];
    return '<div class="rowseg c' + s.color + (isNow ? " is-now" : "") + '" data-pi="' + parts.indexOf(p) + '"><span class="rowseg__idx t-data-sm">' + p.no + '</span><span class="rowseg__chip"></span><span class="rowseg__txt"><span class="t-label muted clamp1">' + esc(p.show) + (isNow ? ' <span class="t-data-sm now">Now</span>' : "") + '</span><span class="t-body clamp1" title="' + esc(p.title) + '">' + esc(p.title) + '</span></span><span class="data">' + clock(p.sec) + "</span></div>";
  }

  function screenOnboarding() {
    var s = [byId["lex-353-whyte"], byId["sysk-damascus-steel"], byId["foc-assyrians"]];
    var h = '<div class="ob"><div class="ob__head"><h1 class="t-display">Each morning, 4a picks a few episodes and says why.</h1></div>';
    h += '<div class="ob__board" aria-hidden="true">' + s.map(function (e) { return rowEp(e, { whyText: e.fr || e.hook, noBridge: true }).replace(/ tabindex="0"/, ' tabindex="-1"'); }).join("") + "</div>";
    h += '<div class="ob__strip">' + stripHTML({ lg: true }) + '<p class="t-body ob__def">A foray is one listen built from parts of several shows, with short narration between them.</p></div>';
    h += '<div class="ob__spacer"></div><div class="ob__cta"><button class="btn btn--primary btn--block" data-act="nav" data-to="#/home">Show my picks</button><button class="btn btn--text-quiet" data-act="nav" data-to="#/home">Later</button></div></div>';
    return h;
  }

  /* ---------------------------------------------------------------- render + router */
  var view = $("#view");
  function render(name) {
    var h;
    S.view = name;
    var scheme = { home: screenToday, search: screenFind, library: screenLibrary, foray: screenForay, onboarding: screenOnboarding };
    h = (scheme[name] || screenToday)();
    view.innerHTML = h;
    hydrate(view);
    document.body.classList.toggle("is-onboarding", name === "onboarding");
    document.body.classList.toggle("has-find", name === "search");
    document.body.classList.toggle("has-mini", !!P);
    $$(".tab").forEach(function (t) { var on = t.dataset.tab === (name === "foray" ? "home" : name); if (on) t.setAttribute("aria-current", "page"); else t.removeAttribute("aria-current"); });
    var fd = $("#findDock");
    if (name === "search") {
      fd.hidden = false;
      fd.innerHTML = '<label class="field"><svg class="i" aria-hidden="true"><use href="#i-search"/></svg><input id="q" type="search" enterkeyhint="search" autocomplete="off" placeholder="A subject, a show, or an episode" aria-label="Search" value="' + esc(S.q) + '"><button class="iconbtn" data-act="clear-q" aria-label="Clear" ' + (S.q ? "" : "hidden") + ">" + icon("x") + "</button></label>";
      $("#results").innerHTML = resultsHTML(S.q); hydrate($("#results")); paintAllStrips();
    } else { fd.hidden = true; fd.innerHTML = ""; }
    if (name === "foray" || name === "home" || name === "library") paintAllStrips();
    updateMini(); syncPlayer();
    window.scrollTo(0, 0);
    collapseCheck(true);
  }
  function paintAllStrips() {
    $$(".strip--row").forEach(function (s) { /* plain colour strips need no fill */ });
  }

  function parseRoute() {
    var h = location.hash || "#/home";
    var p = h.replace(/^#\/?/, "").split("/");
    return { name: p[0] || "home", arg: decodeURIComponent(p.slice(1).join("/") || "") };
  }
  var inNP = false;
  function route() {
    var r = parseRoute(), n = r.name;
    if (n === "mini") { ensureP(); n = "home"; }
    if (n === "foray") ensureP();
    if (n === "library") ensureP();
    if (n === "now-playing") {
      ensureP();
      if (!view.innerHTML) render(S.view === "now-playing" ? "home" : S.view);
      if (!inNP) openNP();
      return;
    }
    if (n === "search") S.q = r.arg || S.q;
    if (["home", "search", "library", "foray", "onboarding"].indexOf(n) < 0) n = "home";
    if (n !== "foray" && n !== "onboarding") S.prev = "#/" + n;
    closeMenu();
    if (inNP) {
      var same = n === S.view && n !== "search";
      var anim = S.animClose; S.animClose = false; closeNP(!anim, same ? null : function () { render(n); });
      return;
    }
    pageSwap(n);
  }
  function closeNPNav() { S.animClose = true; if (S.npPushed) { S.npPushed = false; history.back(); } else nav(S.prev || "#/home"); }
  function nav(h) { if (location.hash === h) { route(); return; } history.pushState(null, "", h); route(); }

  /* ---------------------------------------------------------------- transitions
     r2 items 1 and 2: FLIP owns every shared element. Fixed "flyers" (clones of the full-size element,
     bitmap already in hand) travel between the small rect and the full-size rect on the sheet's own
     curve; the real element is revealed on arrival, so no slot is ever empty and nothing is drawn or
     loaded during a transition. View Transitions are not used. */
  var booted = false;
  function tok(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
  function ms(n) { return parseFloat(tok(n)) || 0; }
  function easeOf(n) { return tok(n) || "cubic-bezier(.2,0,0,1)"; }
  function R(el) { return el.getBoundingClientRect(); }
  function tf(r, base) { return "translate(" + (r.left - base.left) + "px," + (r.top - base.top) + "px) scale(" + (r.width / base.width) + "," + (r.height / base.height) + ")"; }
  function run(el, kf, o) {
    if (!el || !el.animate) return null;
    try { return el.animate(kf, o); } catch (e) { o.easing = "cubic-bezier(.2,0,0,1)"; try { return el.animate(kf, o); } catch (e2) { return null; } }
  }
  function whenDone(list, fn) {
    var done = false, once = function () { if (done) return; done = true; fn(); };
    var ps = list.filter(Boolean).map(function (a) { return a.finished; });
    if (!ps.length) { once(); return; }
    Promise.all(ps).then(once, once);
  }
  var flyers = [];
  function clearFlyers() { flyers.forEach(function (f) { if (f.parentNode) f.parentNode.removeChild(f); }); flyers = []; }
  function place(f, r) {
    f.style.left = r.left + "px"; f.style.top = r.top + "px"; f.style.width = r.width + "px"; f.style.height = r.height + "px";
    document.body.appendChild(f); flyers.push(f); return f;
  }
  function artFlyer(srcEl, r) {
    var f = document.createElement("div"); f.className = "flyer flyer--art"; f.setAttribute("aria-hidden", "true"); f.innerHTML = srcEl.innerHTML;
    $$("img", f).forEach(function (i) { i.loading = "eager"; });
    place(f, r); paintComps(f); return f;
  }
  function titleFlyer(text, r) {
    var f = document.createElement("div"); f.className = "flyer flyer--title t-title clamp2"; f.setAttribute("aria-hidden", "true"); f.textContent = text;
    return place(f, r);
  }
  function stripFlyer(srcStrip, r) {
    var f = srcStrip.cloneNode(true); f.classList.add("flyer", "flyer--strip"); f.removeAttribute("id"); f.setAttribute("aria-hidden", "true"); f.style.visibility = "";
    return place(f, r);
  }
  function onScreen(r) { return r && r.width > 0 && r.bottom > 0 && r.top < window.innerHeight; }
  function lineOf(el) { var cs = getComputedStyle(el); var lh = parseFloat(cs.lineHeight); return { fs: parseFloat(cs.fontSize), lh: isNaN(lh) ? parseFloat(cs.fontSize) * 1.3 : lh }; }

  /* a fixed snapshot of the outgoing page, faded out over the incoming one */
  function makeGhost() {
    var g = document.createElement("div"); g.className = "ghost"; g.setAttribute("aria-hidden", "true");
    var inn = document.createElement("div"); inn.className = "ghost__in";
    var c = view.cloneNode(true); c.removeAttribute("id"); c.removeAttribute("tabindex"); c.className = "ghost__view";
    $$("[id]", c).forEach(function (e) { e.removeAttribute("id"); });
    c.style.transform = "translateY(" + (-window.scrollY) + "px)";
    inn.appendChild(c); g.appendChild(inn); document.body.appendChild(g); paintComps(g); return g;
  }

  /* Row <-> Foray detail: the row's 4px strip IS the 24px timeline. It travels (translate + scale from
     transform-origin 0 0), the page fades in beneath it; the reverse on back. r2 item 2. */
  function pageSwap(n) {
    var involves = booted && n !== S.view && (n === "foray" || S.view === "foray");
    if (!involves) { render(n); return; }
    if (reduce.matches) { render(n); run(view, [{ opacity: 0 }, { opacity: 1 }], { duration: 120 }); return; }
    var D = ms("--t-3"), E = easeOf("--ease"), toDetail = n === "foray";
    var src = toDetail ? S.tapStrip : $("#fdStrip .strip");
    S.tapStrip = null;
    if (src && !document.contains(src)) src = null;
    var oldRect = src ? R(src) : null, bigClone = null;
    if (src && !toDetail) bigClone = src;
    var ghost = makeGhost();
    var clone = bigClone ? bigClone.cloneNode(true) : null;
    render(n);
    var newStrip = toDetail ? $("#fdStrip .strip") : $(".strip--row");
    var newRect = newStrip ? R(newStrip) : null;
    var fly = !!(oldRect && newRect && onScreen(oldRect) && onScreen(newRect));
    var targets = [];
    (function collect(el) {
      if (!newStrip || !el.contains(newStrip)) targets.push(el);
      else if (el !== newStrip) Array.prototype.forEach.call(el.children, collect);
    })(view);
    var anims = targets.map(function (t) { return run(t, [{ opacity: 0 }, { opacity: 1 }], { duration: D, easing: E }); });
    var f = null;
    if (fly) {
      newStrip.style.visibility = "hidden";
      if (toDetail) { f = stripFlyer(newStrip, newRect); anims.push(run(f, [{ transform: tf(oldRect, newRect) }, { transform: "none" }], { duration: D, easing: E })); }
      else { clone.classList.add("flyer", "flyer--strip"); clone.removeAttribute("id"); f = place(clone, oldRect); anims.push(run(f, [{ transform: "none" }, { transform: tf(newRect, oldRect) }], { duration: D, easing: E, fill: "forwards" })); }
    }
    var ga = run(ghost, [{ opacity: 1 }, { opacity: 0 }], { duration: ms("--t-1"), easing: "linear", fill: "forwards" });
    whenDone([ga], function () { if (ghost.parentNode) ghost.parentNode.removeChild(ghost); });
    whenDone(anims, function () { if (f && f.parentNode) f.parentNode.removeChild(f); if (newStrip) newStrip.style.visibility = ""; });
  }

  /* ---------------------------------------------------------------- mini player */
  function updateMini() {
    var m = $("#mini"), c = cur();
    document.body.classList.toggle("has-mini", !!P);
    if (!P) { m.hidden = true; m.innerHTML = ""; return; }
    m.hidden = false;
    var artH = c.foray ? compHTML() : art(c.art, "", true) || mono(c.show);
    m.innerHTML = '<span class="mini__line" data-p="0" aria-hidden="true"></span><button class="mini__body" data-act="open-np" aria-label="Now playing: ' + esc(c.title + ", " + c.show) + '"><span class="mini__art">' + artH + '</span><span class="mini__txt"><span class="mini__title">' + esc(c.title) + '</span><span class="mini__show">' + esc(c.show) + "</span></span></button>" +
      '<button class="mini__play" data-act="toggle" data-playicon aria-label="Pause">' + icon("pause") + '</button><button class="mini__fwd" data-act="fwd30" aria-label="Forward 30 seconds">' + icon("skip-fwd-30") + "</button>";
    hydrate(m);
    syncPlayer();
  }

  /* ---------------------------------------------------------------- now playing */
  var np = $("#np"), scrim = $("#scrim"), npEndShown = false;
  function buildNP() {
    var c = cur(), foray = c.foray;
    /* End of item: the Up next line has risen into the title slot and the artwork has swapped (BUILD-NOTES 4.2). */
    var end = endNear(); npEndShown = end;
    var hc = c;
    if (end) { var ne = byId[Q[0]]; hc = { title: ne.title, show: ne.show, why: ne.hook, art: ne.art }; }
    var artH = hc.foray ? compHTML() : art(hc.art, "", true) || mono(hc.show);
    var h = '<div class="np__top" id="npTop"><span class="np__grab"></span><button class="iconbtn np__close" data-act="close-np" aria-label="Close">' + icon("x") + "</button></div>";
    h += '<div class="np__in"><div class="np__art">' + artH + "</div>";
    h += '<div class="np__meta">' + (end ? '<p class="t-data-sm np__eyebrow" id="npEye">Up next · in ' + clock(P.dur - P.pos) + "</p>" : "") + '<h2 class="t-title np__title clamp2" tabindex="-1" title="' + esc(hc.title) + '">' + esc(hc.title) + '</h2><p class="t-label np__show"><span class="clamp1">' + esc(hc.show) + '</span></p><p class="t-body np__why clamp2">' + esc(hc.why) + "</p></div>";
    h += '<div class="scrub' + (foray ? "" : " scrub--ep") + '" id="scrub">';
    if (foray) {
      h += '<div class="scrub__hit scrub__hit--strip" id="scrubHit" role="slider" tabindex="0" aria-label="Position" aria-valuemin="0" aria-valuemax="' + Math.round(TOTAL) + '" aria-valuenow="0">' + stripHTML({ lg: true, prog: true }) + ticksHTML() + "</div>";
    } else {
      h += '<div class="scrub__hit" id="scrubHit" role="slider" tabindex="0" aria-label="Position" aria-valuemin="0" aria-valuemax="' + P.dur + '" aria-valuenow="0"><div class="scrub__track"><span class="scrub__fill"></span><span class="scrub__thumb"></span><span class="scrub__bubble" id="bubble">0:00</span></div></div>';
    }
    h += '<div class="scrub__clocks t-data-lg"><span id="clkL" class="clock-l">0:00</span><span id="clkR">-0:00</span></div>';
    if (foray) h += '<p class="scrub__readout t-data-sm" id="readout"></p>';
    h += "</div>";
    h += '<div class="transport"><button class="tbtn" data-act="back15" aria-label="Back 15 seconds">' + icon("skip-back-15") + '</button><button class="tplay" data-act="toggle" data-playicon aria-label="Pause">' + icon("pause") + '</button><button class="tbtn" data-act="fwd30" aria-label="Forward 30 seconds">' + icon("skip-fwd-30") + "</button></div>";
    h += '<div class="ctrls">' +
      '<div class="ctrl"><button class="iconbtn" data-act="speed" aria-label="Speed"><span class="t-data" id="speedLbl"></span></button><span class="t-caption">Speed</span></div>' +
      '<div class="ctrl"><button class="iconbtn" data-act="sleep" aria-label="Sleep timer">' + icon("clock") + '</button><span class="t-caption" id="sleepLbl">Sleep</span></div>' +
      '<div class="ctrl"><button class="iconbtn" data-act="bookmark" aria-label="Save" aria-pressed="false" id="bmBtn">' + icon("bookmark") + '</button><span class="t-caption">Save</span></div>' +
      '<div class="ctrl"><button class="iconbtn" data-act="share" aria-label="Share">' + icon("share") + '</button><span class="t-caption">Share</span></div>' +
      '<div class="ctrl"><button class="iconbtn" data-act="nav" data-to="#/library" aria-label="Up Next, ' + Q.length + ' items"><span class="t-data" id="qCount">' + Q.length + '</span></button><span class="t-caption">Up Next</span></div></div>';
    h += '<div class="np__sec">';
    if (foray) {
      h += sechead("Segments", String(segCount)) + '<div id="npSegs"></div>';
    }
    h += sechead("Notes") + '<p class="t-body np__notes clamp4" id="notes">' + esc(foray ? F.summary : c.ep.hook) + '</p><div>' + tbtn("More", 'data-act="notes"').replace('class="btn btn--text"', 'class="btn btn--text np__more"') + "</div>";
    var nx = Q[end ? 1 : 0] ? byId[Q[end ? 1 : 0]] : null;
    if (nx) h += sechead("Up next") + rowEp(nx, { data: '<span class="dur2"><span id="inLbl">in 0:00</span></span>' });
    h += "</div></div>";
    np.innerHTML = h; hydrate(np);
    $("#speedLbl").textContent = S.speed + "×";
    syncPlayer(true);
  }
  function npSegs() {
    var box = $("#npSegs"); if (!box || !P || P.kind !== "foray") return;
    var curP = segPartAt(P.pos), ci = parts.indexOf(curP);
    var list = S.npAll ? parts : parts.slice(Math.max(0, ci - 1), Math.max(0, ci - 1) + 6);
    box.innerHTML = list.map(function (p) { return segRow(p, p === curP); }).join("") + (S.npAll ? "" : '<div class="textrow"><button class="btn btn--text" data-act="np-all">All ' + segCount + " segments</button></div>");
    box.dataset.ci = ci;
  }
  /* Mini (or tapped row) -> Now Playing. The sheet rises over the dock (the dock stays painted beneath it) on the
     spring; the artwork and the title are shared elements flown by fixed flyers on the same curve. The art slot keeps
     its --surface tile while the flyer is in the air, so it is never a hole. r2 item 1. */
  function openNP() {
    inNP = true; clearFlyers();
    var src = S.npFrom || {}; S.npFrom = null;
    var aEl = src.art && document.contains(src.art) ? src.art : $(".mini__art");
    var tEl = src.title && document.contains(src.title) ? src.title : $(".mini__title");
    var fromA = aEl && R(aEl), fromT = tEl && R(tEl), fromL = tEl && lineOf(tEl);
    var miniTitle = $(".mini__title");
    buildNP();
    np.hidden = false; scrim.hidden = false; np.scrollTop = 0;
    document.body.classList.add("np-open");
    np.classList.add("is-open");
    np.removeAttribute("aria-hidden"); np.setAttribute("aria-modal", "true");
    $("#view").setAttribute("inert", ""); $("#dockwrap").setAttribute("inert", "");
    var focusIt = function () { var cl = $(".np__title"); if (cl) cl.focus({ preventScroll: true }); };
    if (!booted) { focusIt(); return; }
    if (reduce.matches) { run(np, [{ opacity: 0 }, { opacity: 1 }], { duration: 120 }); run(scrim, [{ opacity: 0 }, { opacity: 1 }], { duration: 120 }); focusIt(); return; }
    var D = ms("--t-4"), E = easeOf("--spring"), H = np.offsetHeight;
    var npA = $(".np__art"), npT = $(".np__title");
    var toA = R(npA), toT = R(npT), anims = [];
    anims.push(run(np, [{ transform: "translateY(" + H + "px)" }, { transform: "none" }], { duration: D, easing: E }));
    anims.push(run(scrim, [{ opacity: 0 }, { opacity: 1 }], { duration: D * 0.6, easing: "linear" }));
    if (fromA && onScreen(fromA) && toA.width) {
      np.classList.add("is-flying"); document.body.classList.add("is-flying");
      var fa = artFlyer(npA, toA);
      anims.push(run(fa, [{ transform: tf(fromA, toA) }, { transform: "none" }], { duration: D, easing: E }));
    }
    var titleAnim = null;
    if (fromT && onScreen(fromT) && toT.width) {
      np.classList.add("is-flying");
      var to = lineOf(npT), sc = fromL.fs / to.fs;
      var ft = titleFlyer(npT.textContent, toT);
      var dx = fromT.left - toT.left, dy = (fromT.top + fromL.lh / 2) - (toT.top + to.lh * sc / 2);
      anims.push(run(ft, [{ transform: "translate(" + dx + "px," + dy + "px) scale(" + sc + ")", opacity: 0 }, { opacity: 1, offset: 0.4 }, { transform: "none", opacity: 1 }], { duration: D, easing: E }));
      if (miniTitle && tEl === miniTitle) titleAnim = run(miniTitle, [{ opacity: 1 }, { opacity: 0 }], { duration: D * 0.4, easing: "linear", fill: "forwards" });
    }
    whenDone(anims, function () {
      clearFlyers(); np.classList.remove("is-flying"); document.body.classList.remove("is-flying");
      if (titleAnim) titleAnim.cancel();
      if (inNP) focusIt();
    });
  }
  function closeNP(fast, cb) {
    if (!inNP) return;
    inNP = false; clearFlyers();
    var fin = false;
    var finish = function () {
      if (fin) return; fin = true;
      clearFlyers();
      np.getAnimations().forEach(function (a) { a.cancel(); }); scrim.getAnimations().forEach(function (a) { a.cancel(); });
      np.classList.remove("is-open", "is-dragging", "is-flying"); document.body.classList.remove("np-open", "is-flying");
      scrim.hidden = true; np.hidden = true; np.style.transform = "";
      $("#view").removeAttribute("inert"); $("#dockwrap").removeAttribute("inert");
      if (cb) cb();
      var b = $(".mini__body"); if (b) b.focus({ preventScroll: true });
    };
    if (fast || !booted || !np.animate) { finish(); return; }
    if (reduce.matches) { var ra = run(np, [{ opacity: 1 }, { opacity: 0 }], { duration: 120, fill: "forwards" }); run(scrim, [{ opacity: 1 }, { opacity: 0 }], { duration: 120, fill: "forwards" }); whenDone([ra], finish); return; }
    var D = ms("--t-3"), E = easeOf("--ease"), H = np.offsetHeight, anims = [];
    var dy0 = 0; try { dy0 = new DOMMatrix(getComputedStyle(np).transform).m42 || 0; } catch (e) { dy0 = 0; }
    var npA = $(".np__art"), npT = $(".np__title"), mA = $(".mini__art"), mT = $(".mini__title");
    var fromA = npA && R(npA), fromT = npT && R(npT);
    var dockMin = $("#dock").classList.contains("is-min");
    var toA = mA && !dockMin ? R(mA) : null, toT = mT && !dockMin ? R(mT) : null;
    anims.push(run(np, [{ transform: "translateY(" + dy0 + "px)" }, { transform: "translateY(" + H + "px)" }], { duration: D, easing: E, fill: "forwards" }));
    anims.push(run(scrim, [{ opacity: 1 }, { opacity: 0 }], { duration: D, easing: "linear", fill: "forwards" }));
    if (fromA && onScreen(fromA) && toA && toA.width) {
      np.classList.add("is-flying"); document.body.classList.add("is-flying");
      var fa = artFlyer(npA, fromA);
      anims.push(run(fa, [{ transform: "none" }, { transform: tf(toA, fromA) }], { duration: D, easing: E, fill: "forwards" }));
    }
    if (fromT && onScreen(fromT) && toT && toT.width) {
      np.classList.add("is-flying");
      var fl = lineOf(mT), tl = lineOf(npT), sc = fl.fs / tl.fs;
      var ft = titleFlyer(npT.textContent, fromT);
      var dx = toT.left - fromT.left, dy = (toT.top + fl.lh / 2) - (fromT.top + tl.lh * sc / 2);
      anims.push(run(ft, [{ transform: "none", opacity: 1 }, { opacity: 1, offset: 0.6 }, { transform: "translate(" + dx + "px," + dy + "px) scale(" + sc + ")", opacity: 0 }], { duration: D, easing: E, fill: "forwards" }));
    }
    whenDone(anims, finish);
  }

  /* drag to dismiss (grabber area): the sheet follows the finger 1:1; release over 120px or 0.6px/ms dismisses
     (closeNP flies the shared elements home from wherever the finger left them), otherwise it springs back. */
  (function () {
    var y0 = 0, dy = 0, on = false, lastY = 0, lastT = 0, vel = 0;
    np.addEventListener("pointerdown", function (e) { if (!e.target.closest("#npTop") || e.target.closest(".np__close")) return; on = true; y0 = lastY = e.clientY; lastT = e.timeStamp; dy = 0; np.classList.add("is-dragging"); np.setPointerCapture(e.pointerId); });
    np.addEventListener("pointermove", function (e) { if (!on) return; dy = Math.max(0, e.clientY - y0); vel = (e.clientY - lastY) / Math.max(1, e.timeStamp - lastT); lastY = e.clientY; lastT = e.timeStamp; np.style.transform = "translateY(" + dy + "px)"; });
    function end() {
      if (!on) return; on = false; np.classList.remove("is-dragging");
      if (dy > 120 || vel > .6) { closeNPNav(); }
      else if (dy > 0) { var d = dy; np.style.transform = ""; run(np, [{ transform: "translateY(" + d + "px)" }, { transform: "none" }], { duration: ms("--t-3"), easing: easeOf("--spring-stiff") }); }
    }
    np.addEventListener("pointerup", end); np.addEventListener("pointercancel", end);
  })();

  /* ---------------------------------------------------------------- player sync + tick */
  function syncPlayer(force) {
    if (!P) return;
    var pos = P.pos, dur = P.dur, c = cur();
    $$("[data-playicon]").forEach(function (b) {
      var u = b.querySelector("use"), want = "#i-" + (P.playing ? "pause" : "play");
      if (u && u.getAttribute("href") !== want) u.setAttribute("href", want);
      b.setAttribute("aria-label", P.playing ? "Pause" : "Play");
    });
    var line = $(".mini__line"); if (line) line.style.setProperty("--p", (pos / dur).toFixed(4));
    if (np.hidden && !force) { fdSync(); return; }
    var l = $("#clkL"), r = $("#clkR"), hit = $("#scrubHit"), sc = $("#scrub");
    if (l) { l.textContent = P.buffering ? "buffering" : clock(pos); r.textContent = clock(dur - pos, true); l.classList.toggle("is-word", !!P.buffering); }
    if (!np.hidden && endNear() !== npEndShown) { buildNP(); return; }
    var eye = $("#npEye"); if (eye) eye.textContent = "Up next · in " + clock(dur - pos);
    if (hit) {
      hit.setAttribute("aria-valuenow", Math.round(pos)); hit.setAttribute("aria-valuetext", spoken(pos) + " of " + spoken(dur));
      if (P.kind === "ep") sc.style.setProperty("--p", (pos / dur).toFixed(4));
      else paintStrip($(".strip", hit), pos);
    }
    var ro = $("#readout");
    if (ro && P.kind === "foray") {
      var p = segPartAt(pos), rem = p.start + p.sec - pos;
      ro.textContent = p.type === "narration" ? "Narration · " + clock(rem) + " left" : p.no + " of " + segCount + " · " + p.show + " · " + clock(rem) + " left";
      var box = $("#npSegs"), pi = parts.indexOf(p);
      if (box && box.dataset.ci !== String(pi)) npSegs();
    }
    var inl = $("#inLbl"); if (inl) inl.textContent = "in " + clock(dur - pos);
    fdSync();
  }
  function fdSync() {
    var st = $("#fdStrip .strip");
    if (st && P && P.kind === "foray") paintStrip(st, P.pos, P.pos >= TOTAL - 1 ? "done" : "");
  }
  setInterval(function () {
    if (!P || !P.playing || P.hold || P.buffering || document.hidden) return;
    P.pos += 1;
    if (P.pos >= P.dur) {
      var nid = Q.shift();
      if (nid) { playEp(nid); updateMini(); if (inNP) { buildNP(); np.classList.add("fade-in"); } }
      else { P.pos = P.dur; P.playing = false; }
    }
    syncPlayer();
  }, 1000);

  /* scrubber pointer + keys */
  (function () {
    var active = false;
    function posFrom(e) {
      var hit = $("#scrubHit"); var tr = P.kind === "foray" ? $(".strip", hit) : $(".scrub__track", hit);
      var b = tr.getBoundingClientRect(); var f = Math.max(0, Math.min(1, (e.clientX - b.left) / b.width)); return f * P.dur;
    }
    np.addEventListener("pointerdown", function (e) {
      var hit = e.target.closest("#scrubHit"); if (!hit || !P) return;
      active = true; hit.setPointerCapture(e.pointerId); $("#scrub").classList.add("is-touch"); P.pos = posFrom(e); bubble(); syncPlayer(true);
    });
    np.addEventListener("pointermove", function (e) { if (!active) return; var before = segPartAt(P.pos); P.pos = posFrom(e); if (segPartAt(P.pos) !== before) haptic("selection"); bubble(); syncPlayer(true); });
    function up() { if (!active) return; active = false; var s = $("#scrub"); if (s) s.classList.remove("is-touch"); }
    np.addEventListener("pointerup", up); np.addEventListener("pointercancel", up);
    function bubble() { var b = $("#bubble"); if (b) b.textContent = clock(P.pos); }
    np.addEventListener("keydown", function (e) {
      if (e.target.id !== "scrubHit") return;
      if (e.key === "ArrowRight" || e.key === "ArrowUp") { seek(15); e.preventDefault(); } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") { seek(-15); e.preventDefault(); }
    });
  })();
  function seek(d) { if (!P) return; P.pos = Math.max(0, Math.min(P.dur - 1, P.pos + d)); syncPlayer(true); }

  /* ---------------------------------------------------------------- menu, undo, sheets */
  function closeMenu() { var m = $(".menu"); if (m) m.remove(); menuOpen = null; }
  function openMenu(btn, id) {
    closeMenu(); menuOpen = id;
    var b = btn.getBoundingClientRect(), qi = Q.indexOf(id);
    var m = document.createElement("div"); m.className = "menu"; m.setAttribute("role", "menu");
    m.innerHTML = '<button role="menuitem" data-act="m-now">' + icon("play") + 'Play now</button><button role="menuitem" data-act="m-up"' + (qi === 0 ? " disabled" : "") + ">" + icon("arrow-up") + 'Move up</button><button role="menuitem" data-act="m-down"' + (qi === Q.length - 1 ? " disabled" : "") + ">" + icon("arrow-down") + 'Move down</button><button role="menuitem" data-act="m-rm">' + icon("trash") + "Remove</button>";
    document.body.appendChild(m);
    m.style.top = Math.min(window.innerHeight - 190, b.bottom + 4) + "px";
    m.style.left = Math.max(8, Math.min(window.innerWidth - 248, b.right - 240)) + "px";
    var f = m.querySelector("button"); if (f) f.focus();
  }
  function toast(msg, undoFn) {
    var u = $("#undo"); clearTimeout(undoTimer);
    u.innerHTML = "<span>" + esc(msg) + "</span>" + (undoFn ? '<button data-act="undo">Undo</button>' : "");
    undoState = undoFn || null; u.hidden = false; void u.offsetWidth; u.classList.add("is-in");
    undoTimer = setTimeout(function () { u.classList.remove("is-in"); setTimeout(function () { u.hidden = true; }, 240); }, 6000);
  }
  function refreshLib() { if (S.view === "library") { var y = window.scrollY; render("library"); window.scrollTo(0, y); } }

  var you = $("#you");
  function openYou() {
    var rows = D.subjects.slice(0, 7).map(function (s) {
      return '<div class="interest"><span class="t-strong clamp1">' + esc(s.label) + '</span><span class="step"><button class="iconbtn" data-act="w-dn" data-id="' + esc(s.id) + '" aria-label="Less ' + esc(s.label) + '">' + icon("minus") + '</button><span class="t-data" id="w-' + esc(s.id.replace(/\W/g, "")) + '">' + S.weights[s.id] + '</span><button class="iconbtn" data-act="w-up" data-id="' + esc(s.id) + '" aria-label="More ' + esc(s.label) + '">' + icon("plus") + "</button></span></div>";
    }).join("");
    you.innerHTML = '<div class="np__top" id="youTop"><span class="np__grab"></span><button class="iconbtn np__close" data-act="close-you" aria-label="Close">' + icon("x") + '</button></div><div class="sheet__in"><h2 class="t-title">You</h2>' +
      sechead("Appearance") + '<div class="seg3" role="group" aria-label="Appearance">' + ["system", "light", "dark"].map(function (t) { return '<button data-act="theme" data-t="' + t + '" aria-pressed="' + (S.theme === t) + '">' + t.charAt(0).toUpperCase() + t.slice(1) + "</button>"; }).join("") + "</div>" +
      sechead("What 4a has seen you play", "weights") + rows + sechead("Downloads") + '<div class="empty"><span>' + plural(savedIds.length, "episode", "episodes") + " saved</span>" + tbtn("Show", 'data-act="close-you"') + "</div></div>";
    you.hidden = false; scrim.hidden = false; void you.offsetWidth; you.classList.add("is-open");
    $("#view").setAttribute("inert", ""); $("#dockwrap").setAttribute("inert", ""); document.body.classList.add("np-open");
    var c = you.querySelector(".np__close"); if (c) c.focus();
  }
  function closeYou() { you.classList.remove("is-open"); scrim.hidden = true; $("#view").removeAttribute("inert"); $("#dockwrap").removeAttribute("inert"); document.body.classList.remove("np-open"); setTimeout(function () { if (!you.classList.contains("is-open")) you.hidden = true; }, 520); var b = $('[data-act="open-you"]'); if (b) b.focus({ preventScroll: true }); }
  function applyTheme() {
    var r = document.documentElement; if (S.theme === "system") r.removeAttribute("data-theme"); else r.setAttribute("data-theme", S.theme);
  }
  applyTheme();

  /* ---------------------------------------------------------------- scroll behaviour */
  var lastY = 0;
  function collapseCheck(reset) {
    var y = window.scrollY, hdr = $("#todayHdr"), st = $("#todayStat");
    if (hdr) hdr.classList.toggle("is-collapsed", y > 48);
    if (st) st.classList.toggle("is-collapsed", y > 48);
    var dock = $("#dock"), b = document.body;
    if (reset) { dock.classList.remove("is-min"); b.classList.remove("dock-min"); lastY = y; return; }
    if (y > 48 && y > lastY + 4) { dock.classList.add("is-min"); b.classList.add("dock-min"); } else if (y < lastY - 4 || y <= 48) { dock.classList.remove("is-min"); b.classList.remove("dock-min"); }
    lastY = y;
  }
  window.addEventListener("scroll", function () { collapseCheck(false); }, { passive: true });

  /* ---------------------------------------------------------------- events */
  var tapTimer = null;
  document.addEventListener("click", function (ev) {
    var t = ev.target.closest("[data-act]");
    if (menuOpen && !ev.target.closest(".menu") && !(t && t.dataset.act === "qmenu")) closeMenu();
    if (!t) { if (ev.target === scrim) { if (inNP) closeNPNav(); else if (!you.hidden) closeYou(); } return; }
    act(t, ev);
  });
  document.addEventListener("keydown", function (ev) {
    if ((ev.key === "Enter" || ev.key === " ") && ev.target.matches && ev.target.matches('.row[role="button"]')) { ev.preventDefault(); ev.target.click(); }
    if (ev.key === "Escape") { if (menuOpen) closeMenu(); else if (inNP) closeNPNav(); else if (!you.hidden) closeYou(); }
  });
  function act(t, ev) {
    var a = t.dataset.act, id = t.dataset.id;
    switch (a) {
      case "offline-toggle": S.offlineOnly = !S.offlineOnly; render("home"); break;
      case "all-subjects": S.allSubj = true; { var rs = $("#results"); if (rs) { rs.innerHTML = resultsHTML(S.q); hydrate(rs); } } break;
      case "open-ep": if (t.getAttribute("aria-disabled") === "true") { toast("Not saved on this phone. Needs a connection."); break; } S.npFrom = { art: t.querySelector(".row__art"), title: t.querySelector(".row__title") }; playEp(id); haptic("light"); updateMini(); S.npAll = false; S.npPushed = true; nav("#/now-playing"); break;
      case "play-ep": ev.stopPropagation(); playEp(id); updateMini(); haptic("light"); break;
      case "open-foray": S.tapStrip = t.querySelector(".strip"); S.fwdPushed = true; history.pushState(null, "", "#/foray"); route(); break;
            case "play-foray": playForay(); updateMini(); S.npPushed = true; nav("#/now-playing"); break;
      case "open-show": nav("#/search/" + encodeURIComponent((D.shows.filter(function (s) { return s.id === id; })[0] || {}).name || "")); break;
      case "open-subject": toast("Subject page: " + (D.subjects.filter(function (s) { return s.id === id; })[0] || {}).label); break;
      case "open-np": S.npPushed = true; nav("#/now-playing"); break;
      case "close-np": closeNPNav(); break;
      case "toggle": if (P) { P.playing = !P.playing; haptic("light"); syncPlayer(true); } break;
      case "back15": seek(-15); haptic("medium"); break;
      case "fwd30": seek(30); haptic("medium"); break;
      case "speed": S.speed = { 1: 1.25, 1.25: 1.5, 1.5: 2, 2: 1 }[S.speed] || 1; $("#speedLbl").textContent = S.speed + "×"; break;
      case "sleep": S.sleep = { 0: 15, 15: 30, 30: 0 }[S.sleep]; $("#sleepLbl").textContent = S.sleep ? "Sleep " + S.sleep : "Sleep"; break;
      case "bookmark": {
        var k = P.kind + P.id; S.bookmarked[k] = !S.bookmarked[k]; t.setAttribute("aria-pressed", String(!!S.bookmarked[k]));
        t.innerHTML = icon(S.bookmarked[k] ? "bookmark-check" : "bookmark"); if (S.bookmarked[k]) { haptic("success"); toast("Saved"); } break;
      }
      case "share": if (navigator.share) navigator.share({ title: P ? cur().title : F.title }).catch(function () {}); else toast("Share sheet opens here."); break;
      case "notes": S.notes = !S.notes; $("#notes").classList.toggle("clamp4", !S.notes); t.innerHTML = (S.notes ? "Less" : "More") + icon("chevron-right"); break;
      case "np-all": S.npAll = !S.npAll; npSegs(); break;
      case "all-segs": forayAllSegs = true; render("foray"); break;
      case "back": if (S.fwdPushed) { S.fwdPushed = false; history.back(); } else nav("#/home"); break;
      case "nav": nav(t.dataset.to); break;
      case "open-you": openYou(); break;
      case "close-you": closeYou(); break;
      case "theme": S.theme = t.dataset.t; store("theme", S.theme); applyTheme(); $$("[data-act=theme]").forEach(function (b) { b.setAttribute("aria-pressed", String(b === t)); }); break;
      case "w-up": case "w-dn": { var w = Math.max(0, Math.min(10, S.weights[id] + (a === "w-up" ? 1 : -1))); S.weights[id] = w; $("#w-" + id.replace(/\W/g, "")).textContent = w; break; }
      case "focus-field": { var q = $("#q"); if (q) q.focus(); break; }
      case "clear-q": { S.q = ""; var qi = $("#q"); qi.value = ""; qi.focus(); t.hidden = true; $("#results").innerHTML = resultsHTML(""); hydrate($("#results")); break; }
      case "scroll-saved": { var an = $("#savedAnchor"); if (an) an.scrollIntoView({ behavior: reduce.matches ? "auto" : "smooth" }); break; }
      case "toast": toast(t.dataset.msg || ""); break;
      case "qmenu": ev.stopPropagation(); openMenu(t, id); break;
      case "m-now": { var mid = menuOpen; closeMenu(); playEp(mid); updateMini(); refreshLib(); break; }
      case "m-up": case "m-down": {
        var i = Q.indexOf(menuOpen), j = a === "m-up" ? i - 1 : i + 1; closeMenu(); if (i < 0 || j < 0 || j >= Q.length) break;
        var row = $('.rowq[data-qi="' + i + '"]'), other = $('.rowq[data-qi="' + j + '"]');
        var tmp = Q[i]; Q[i] = Q[j]; Q[j] = tmp;
        if (row && other && !reduce.matches) { var d = other.getBoundingClientRect().top - row.getBoundingClientRect().top; row.style.transform = "translateY(" + d + "px)"; other.style.transform = "translateY(" + (-d) + "px)"; setTimeout(refreshLib, 330); } else refreshLib();
        break;
      }
      case "m-rm": { var rid = menuOpen, ri = Q.indexOf(rid); closeMenu(); if (ri < 0) break; Q.splice(ri, 1); refreshLib(); haptic("success"); toast("Removed", function () { Q.splice(ri, 0, rid); refreshLib(); }); break; }
      case "undo": { var f = undoState; undoState = null; $("#undo").classList.remove("is-in"); haptic("light"); if (f) f(); break; }
    }
  }

  var qTimer = 0;
  document.addEventListener("input", function (ev) {
    if (ev.target.id !== "q") return;
    clearTimeout(qTimer); var v = ev.target.value;
    var clr = $('[data-act="clear-q"]'); if (clr) clr.hidden = !v;
    qTimer = setTimeout(function () { S.q = v; var r = $("#results"); if (r) { r.innerHTML = resultsHTML(v); hydrate(r); } }, 250);
  });

  window.addEventListener("hashchange", route);
  window.addEventListener("popstate", route);
  if (!location.hash) history.replaceState(null, "", "#/home");
  ensureComp();
  route();
  /* the first route paints without motion (a direct load must be a still); every route after it animates */
  requestAnimationFrame(function () { booted = true; });
})();
