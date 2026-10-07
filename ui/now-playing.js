/* ui/now-playing.js — Dial (Tactile) Now Playing view.
 *
 * player/client.js owns audio and supplies real state. This file owns the
 * screen's markup, tint/material treatment, safe artwork sampling and haptic
 * shim. Dynamic prose is assigned with textContent; primitive HTML routes all
 * interpolations through esc() and all image URLs through safeUrl().
 */

var DIAL_HAPTIC_AT = 0;
var DIAL_ART_TINT_PREFIX = "cp_art_tint:";

function dialNpEl(tag, cls, text) {
  var node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

function dialNpIcon(id, size) {
  return typeof tactileIcon === "function" ? tactileIcon(id, size) : "";
}

function dialSafeImageUrl(url) {
  var value = typeof safeUrl === "function" ? safeUrl(url) : "#";
  return value === "#" ? "" : value;
}

function dialHaptic(kind) {
  var now = Date.now();
  if (now - DIAL_HAPTIC_AT < 100) return;
  DIAL_HAPTIC_AT = now;
  try {
    var plugin = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Haptics;
    if (!plugin) return;
    if (kind === "selection" && typeof plugin.selectionChanged === "function") plugin.selectionChanged();
    else if (kind === "success" && typeof plugin.notification === "function") plugin.notification({ type: "SUCCESS" });
    else if (typeof plugin.impact === "function") plugin.impact({ style: kind === "medium" ? "MEDIUM" : kind === "heavy" ? "HEAVY" : "LIGHT" });
  } catch (_) { /* Web build and OS-disabled haptics are intentional no-ops. */ }
}

function dialBuildNowPlaying(parts) {
  if (!parts || !parts.sheet || !parts.scroll) return {};
  var sheet = parts.sheet;
  sheet.classList.add("np", "sheet");
  sheet.setAttribute("aria-modal", "true");
  sheet.setAttribute("aria-labelledby", "fp-s-title");

  parts.grabZone.classList.add("np__head");
  parts.closeBtn.className = "fp-close np__collapse iconbtn";
  parts.closeBtn.setAttribute("aria-label", "Collapse");
  parts.closeBtn.innerHTML = dialNpIcon("ph-caret-down");

  var bg = dialNpEl("div", "np__bg");
  bg.setAttribute("aria-hidden", "true");
  var top = dialNpEl("div", "np__top");
  var hero = dialNpEl("div", "np__hero");
  var artWrap = dialNpEl("div", "np__art");
  artWrap.append(parts.sArt);
  hero.append(artWrap);

  var copy = dialNpEl("div", "np__text");
  parts.sTitle.className = "fp-s-title title clamp3";
  parts.sShow.className = "fp-s-show np__show";
  parts.sWhy.classList.add("np__why");
  var chips = dialNpEl("div", "np__chips");
  chips.id = "np-chips";
  copy.append(parts.sTitle, parts.sShow, chips, parts.sWhy);

  var bandSection = dialNpEl("div", "np__band");
  var bandWell = dialNpEl("div", "np__band-well well");
  var bandVisual = dialNpEl("div", "np__band-visual");
  var bubble = dialNpEl("output", "band-bubble readout");
  bubble.hidden = true;
  parts.scrub.className = "fp-scrub np__range";
  parts.scrub.setAttribute("aria-label", "Seek");
  bandWell.append(bandVisual, parts.scrub, bubble);
  parts.times.classList.add("np__read");
  parts.tNow.className = "fp-now readout-lg";
  parts.tLeft.className = "fp-left readout";
  bandSection.append(bandWell, parts.times);
  top.append(hero, copy, bandSection);

  parts.row.classList.add("transport");
  parts.backBtn.className = "fp-btn keycap keycap--lg keycap--rubber keycap--round";
  parts.backBtn.innerHTML = dialNpIcon("skip-15", "lg");
  parts.bigPlay.className = "fp-btn fp-big keycap keycap--xl keycap--persimmon keycap--round";
  parts.fwdBtn.className = "fp-btn keycap keycap--lg keycap--rubber keycap--round";
  parts.fwdBtn.innerHTML = dialNpIcon("skip-30", "lg");

  var sleepBtn = dialNpEl("button", "fp-sleep rotary-chip");
  sleepBtn.type = "button";
  sleepBtn.setAttribute("aria-label", "Sleep timer, off");
  sleepBtn.innerHTML = '<span>Sleep · <span class="readout">Off</span></span>';

  parts.rateBtn.className = "fp-rate rotary-chip";
  parts.rateBtn.innerHTML = '<span class="readout">1.0×</span>';
  parts.bookmarkBtn.className = "fp-btn fp-bookmark keycap keycap--sm keycap--paper";
  parts.bookmarkBtn.innerHTML = dialNpIcon("ph-bookmark-simple");
  parts.queueLink.className = "fp-openep fp-upnext keycap keycap--sm keycap--paper";
  parts.queueLink.innerHTML = dialNpIcon("ph-list-bullets") + '<span class="np__badge readout" hidden>0</span>';

  parts.row2.className = "fp-row2 second";
  parts.row2.replaceChildren(parts.rateBtn, sleepBtn, parts.bookmarkBtn, parts.queueLink);

  var legacy = dialNpEl("section", "np__legacy");
  var legacyHeading = dialNpEl("h2", "heading", "Playback");
  var legacyActions = dialNpEl("div", "np__legacy-actions");
  legacyActions.append(parts.stopBtn, parts.nextBtn, parts.saveBtn, parts.openLink, parts.forayLink, parts.clips);
  legacy.append(legacyHeading, legacyActions, parts.sErr, parts.note);

  var more = dialNpEl("div", "np__more");
  var upNext = dialNpEl("section", "np__section np__up-next");
  upNext.append(dialNpEl("h2", "heading", "Up next"), dialNpEl("div", "np__up-next-card sheetcard"));
  var segments = dialNpEl("section", "np__section np__segments");
  segments.append(dialNpEl("h2", "heading", "Segments"), dialNpEl("div", "np__segment-groups"));
  var origin = dialNpEl("section", "np__section np__origin");
  origin.append(dialNpEl("h2", "heading", "Where this came from"), dialNpEl("div", "np__origin-rows"));
  var chapters = dialNpEl("section", "np__section np__chapters");
  chapters.append(dialNpEl("h2", "heading", "Chapters"), dialNpEl("p", "np__empty-detail", "No chapters published."));
  var notes = dialNpEl("section", "np__section np__notes");
  notes.append(dialNpEl("h2", "heading", "Show notes"), parts.sDesc);
  more.append(upNext, segments, origin, chapters, notes, legacy);

  var dock = dialNpEl("div", "np__dock");
  dock.append(parts.row, parts.row2);
  parts.scroll.classList.add("np__scroll");
  parts.scroll.replaceChildren(top, more);
  sheet.replaceChildren(bg, parts.grabZone, parts.scroll, dock);
  return { bg: bg, top: top, artWrap: artWrap, chips: chips, bandVisual: bandVisual, bubble: bubble, sleepBtn: sleepBtn, upNext: upNext, segments: segments, origin: origin, chapters: chapters, notes: notes, legacy: legacy, dock: dock };
}

function dialHexRgb(value) {
  var text = String(value || "").trim();
  var short = /^#([0-9a-f]{3})$/i.exec(text);
  if (short) return short[1].split("").map(function (c) { return parseInt(c + c, 16); });
  var hex = /^#([0-9a-f]{6})$/i.exec(text);
  if (hex) return [0, 2, 4].map(function (i) { return parseInt(hex[1].slice(i, i + 2), 16); });
  var rgb = /^rgba?\(\s*([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)/i.exec(text);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  var oklch = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/i.exec(text);
  if (!oklch) return null;
  var L = Number(oklch[1]), C = Number(oklch[2]), h = Number(oklch[3]) * Math.PI / 180;
  var a = C * Math.cos(h), b = C * Math.sin(h);
  var l3 = Math.pow(L + .3963377774 * a + .2158037573 * b, 3);
  var m3 = Math.pow(L - .1055613458 * a - .0638541728 * b, 3);
  var s3 = Math.pow(L - .0894841775 * a - 1.291485548 * b, 3);
  var linear = [
    4.0767416621 * l3 - 3.3077115913 * m3 + .2309699292 * s3,
    -1.2684380046 * l3 + 2.6097574011 * m3 - .3413193965 * s3,
    -.0041960863 * l3 - .7034186147 * m3 + 1.707614701 * s3,
  ];
  return linear.map(function (channel) {
    var value = channel <= .0031308 ? 12.92 * channel : 1.055 * Math.pow(channel, 1 / 2.4) - .055;
    return Math.round(Math.max(0, Math.min(1, value)) * 255);
  });
}

function dialLuminance(rgb) {
  return rgb.map(function (v) { var x = v / 255; return x <= .04045 ? x / 12.92 : Math.pow((x + .055) / 1.055, 2.4); })
    .reduce(function (sum, value, index) { return sum + value * [.2126, .7152, .0722][index]; }, 0);
}

function dialContrast(a, b) {
  var x = dialLuminance(a), y = dialLuminance(b);
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
}

function dialApplyNowPlayingTint(sheet, tint) {
  if (!sheet || !tint || typeof getComputedStyle !== "function") return;
  var styles = getComputedStyle(document.documentElement);
  var ink = dialHexRgb(styles.getPropertyValue("--ink"));
  var paper = dialHexRgb(styles.getPropertyValue("--paper"));
  var tintRgb = dialHexRgb(tint);
  if (!ink || !paper || !tintRgb) return;
  var systemDark = typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
  var defaultAlpha = document.documentElement.dataset.theme === "dark" || systemDark ? .72 : .78;
  function mixed(alpha) { return tintRgb.map(function (v, i) { return Math.round(v * (1 - alpha) + paper[i] * alpha); }); }
  var alpha = dialContrast(ink, mixed(defaultAlpha)) < 4.5 ? .9 : defaultAlpha;
  var surface = mixed(alpha);
  sheet.style.setProperty("--np-tint", tint);
  sheet.style.setProperty("--np-scrim", "rgba(" + paper.join(",") + "," + alpha + ")");
  /* This solid twin of the composited tint gives contrast tools and
     forced-colour engines the same surface the pseudo-element paints. */
  sheet.style.setProperty("--np-surface", "rgb(" + surface.join(",") + ")");
  sheet.dataset.scrimAlpha = String(alpha);
}

function dialStorageGet(key) {
  if (!/^cp_/.test(key)) return null;
  if (typeof lsGet === "function") return lsGet(key, null);
  return null;
}

function dialStorageSet(key, value) {
  if (!/^cp_/.test(key)) return false;
  return typeof lsSet === "function" ? lsSet(key, value) : false;
}

function dialUrlHash(url) {
  var h = 2166136261;
  String(url || "").split("").forEach(function (c) { h = Math.imul(h ^ c.charCodeAt(0), 16777619); });
  return (h >>> 0).toString(36);
}

function dialRgbToOklch(rgb) {
  var linear = rgb.map(function (v) { var x = v / 255; return x <= .04045 ? x / 12.92 : Math.pow((x + .055) / 1.055, 2.4); });
  var l = .4122214708 * linear[0] + .5363325363 * linear[1] + .0514459929 * linear[2];
  var m = .2119034982 * linear[0] + .6806995451 * linear[1] + .1073969566 * linear[2];
  var s = .0883024619 * linear[0] + .2817188376 * linear[1] + .6299787005 * linear[2];
  var l3 = Math.cbrt(l), m3 = Math.cbrt(m), s3 = Math.cbrt(s);
  var L = .2104542553 * l3 + .793617785 * m3 - .0040720468 * s3;
  var a = 1.9779984951 * l3 - 2.428592205 * m3 + .4505937099 * s3;
  var b = .0259040371 * l3 + .7827717662 * m3 - .808675766 * s3;
  var c = Math.sqrt(a * a + b * b);
  var h = (Math.atan2(b, a) * 180 / Math.PI + 360) % 360;
  return { l: L, c: c, h: h };
}

function dialNormalizeArtworkTint(oklch, fallback) {
  if (!oklch || oklch.c < .07) return fallback;
  return "oklch(" + Math.max(.45, Math.min(.6, oklch.l)).toFixed(3) + " " + Math.max(.1, oklch.c).toFixed(3) + " " + oklch.h.toFixed(1) + ")";
}

function dialExtractArtworkTint(url, showId, fallback) {
  var safe = dialSafeImageUrl(url);
  if (!safe) return Promise.resolve(fallback);
  var key = DIAL_ART_TINT_PREFIX + String(showId || "show");
  var hash = dialUrlHash(safe);
  var cached = dialStorageGet(key);
  if (cached && cached.hash === hash && typeof cached.tint === "string") return Promise.resolve(cached.tint);
  return new Promise(function (resolve) {
    var image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = function () {
      try {
        var canvas = document.createElement("canvas");
        canvas.width = canvas.height = 32;
        var context = canvas.getContext("2d", { willReadFrequently: true });
        context.drawImage(image, 0, 0, 32, 32);
        var pixels = context.getImageData(0, 0, 32, 32).data;
        var rgb = [0, 0, 0], count = 0;
        for (var i = 0; i < pixels.length; i += 4) {
          if (pixels[i + 3] < 128) continue;
          rgb[0] += pixels[i]; rgb[1] += pixels[i + 1]; rgb[2] += pixels[i + 2]; count += 1;
        }
        rgb = rgb.map(function (v) { return count ? v / count : 0; });
        var tint = dialNormalizeArtworkTint(dialRgbToOklch(rgb), fallback);
        dialStorageSet(key, { hash: hash, tint: tint });
        resolve(tint);
      } catch (_) { resolve(fallback); }
    };
    image.onerror = function () { resolve(fallback); };
    image.src = safe;
  });
}

function dialStationToken(index) {
  var name = "--dial-seg-c" + Math.max(0, Math.min(7, Number(index) || 0));
  return typeof getComputedStyle === "function" ? getComputedStyle(document.documentElement).getPropertyValue(name).trim() : "";
}

function dialCurrentStation(model) {
  var segments = model && Array.isArray(model.segments) ? model.segments : [];
  var index = Math.max(0, Math.min(segments.length - 1, Number(model && model.currentIndex) || 0));
  var current = segments[index];
  if (!current || !current.narration) return current || null;
  for (var before = index - 1; before >= 0; before -= 1) {
    if (!segments[before].narration) return segments[before];
  }
  return segments.find(function (item) { return !item.narration; }) || null;
}

function dialPaintChip(parts, model) {
  if (!parts.chips) return;
  parts.chips.textContent = "";
  if (!model.foray) return;
  var segment = model.segments[model.currentIndex] || model.segments[0];
  if (!segment) return;
  if (segment.narration) {
    var narration = dialNpEl("span", "tag tag--narration");
    narration.innerHTML = dialNpIcon("narration", "sm");
    narration.append(dialNpEl("span", "", "4a narration"));
    parts.chips.append(narration);
    return;
  }
  var station = dialCurrentStation(model);
  if (!station) return;
  var chip = dialNpEl("span", "tag tag--station");
  var swatch = dialNpEl("i", "np__swatch");
  swatch.classList.add("t-band__bar--c" + station.colorIndex);
  var code = dialNpEl("b", "np__station-code readout", station.code);
  chip.append(swatch, code, document.createTextNode(station.show));
  parts.chips.append(chip);
}

function dialPaintDetails(parts, model) {
  var key = model.detailKey || "";
  if (parts.moreKey === key) return;
  parts.moreKey = key;
  var nextHost = parts.upNext.querySelector(".np__up-next-card");
  nextHost.textContent = "";
  if (model.next) {
    var nextArt = dialNpEl("span", "np__up-next-art");
    var artworkUrl = dialSafeImageUrl(model.next.artwork);
    if (artworkUrl) {
      var image = dialNpEl("img", "");
      image.alt = "";
      image.decoding = "async";
      image.src = artworkUrl;
      nextArt.append(image);
    } else {
      var initials = String(model.next.show || "4a").replace(/[^A-Za-z0-9 ]/g, " ").trim().split(/\s+/).slice(0, 2).map(function (word) { return word.charAt(0); }).join("").toUpperCase();
      nextArt.append(dialNpEl("span", "", initials || "4a"));
    }
    var nextBody = dialNpEl("span", "np__up-next-body");
    var nextTitle = dialNpEl("h3", "np__detail-title", model.next.title || model.next.show);
    var nextWhy = dialNpEl("p", "np__detail-copy", model.next.why || "Continues this foray.");
    var nextTime = dialNpEl("span", "readout", model.next.duration || "");
    nextBody.append(nextTitle, nextWhy);
    nextHost.append(nextArt, nextBody, nextTime);
  } else {
    nextHost.append(dialNpEl("p", "np__empty-detail", "Nothing queued."));
  }

  var groups = parts.segments.querySelector(".np__segment-groups");
  groups.textContent = "";
  (model.slots || []).forEach(function (slot) {
    var group = dialNpEl("div", "np__slot");
    group.append(dialNpEl("h3", "np__slot-title", slot.title || "Segments"));
    (slot.items || []).forEach(function (item) {
      var row = dialNpEl("button", "segrow" + (item.current ? " is-current" : ""));
      row.type = "button";
      row.dataset.seek = String(item.start || 0);
      row.setAttribute("aria-label", "Seek to " + (item.narration ? "4a narration" : item.show));
      var swatch = dialNpEl("span", "np__origin-swatch t-band__bar--c" + item.colorIndex, item.narration ? "" : item.code);
      var body = dialNpEl("span", "np__segment-copy");
      body.append(dialNpEl("strong", "np__detail-title", item.narration ? "4a narration" : item.show));
      if (item.why) body.append(dialNpEl("span", "np__detail-copy", item.why));
      row.append(swatch, body, dialNpEl("span", "readout", item.duration || ""));
      if (item.narration) {
        var tag = dialNpEl("span", "tag tag--narration");
        tag.innerHTML = dialNpIcon("narration", "sm");
        tag.append(dialNpEl("span", "", "Narration"));
        row.append(tag);
      }
      group.append(row);
    });
    groups.append(group);
  });
  parts.segments.hidden = !model.foray;

  var origins = parts.origin.querySelector(".np__origin-rows");
  origins.textContent = "";
  (model.origins || []).forEach(function (show) {
    var row = dialNpEl("div", "row-show");
    var swatch = dialNpEl("span", "np__origin-swatch t-band__bar--c" + show.colorIndex, show.code);
    var body = dialNpEl("span", "row__body");
    body.append(dialNpEl("strong", "row__title", show.name), dialNpEl("span", "row__meta", show.meta));
    row.append(swatch, body);
    origins.append(row);
  });
  parts.origin.hidden = !model.foray;
  parts.chapters.hidden = model.foray;
  if (!model.foray) {
    var heading = parts.chapters.querySelector(".heading");
    parts.chapters.replaceChildren(heading);
    if (model.chapters && model.chapters.length) {
      model.chapters.forEach(function (chapter) {
        var row = dialNpEl("button", "np__chapter");
        row.type = "button";
        row.dataset.seek = String(chapter.start || 0);
        row.setAttribute("aria-label", "Seek to " + chapter.title);
        row.append(dialNpEl("span", "np__detail-title", chapter.title), dialNpEl("span", "readout", chapter.clock || ""));
        parts.chapters.append(row);
      });
    } else parts.chapters.append(dialNpEl("p", "np__empty-detail", "No chapters published."));
  }
  parts.notes.hidden = model.foray || parts.notes.querySelector("details").hidden;
}

function dialPaintNowPlaying(parts, model) {
  if (!parts || !parts.bandVisual) return;
  var d = model || {};
  var tintRequest = (parts.tintRequest || 0) + 1;
  parts.tintRequest = tintRequest;
  parts.sheet.classList.toggle("np--foray", Boolean(d.foray));
  parts.sheet.classList.toggle("np--buffering", Boolean(d.buffering));
  if (d.show && parts.sShow.textContent !== d.show) parts.sShow.textContent = d.show;
  parts.bigPlay.innerHTML = dialNpIcon(d.running ? "ph-pause-fill" : "ph-play-fill", "lg");
  parts.bigPlay.setAttribute("aria-label", d.running ? "Pause" : "Play");
  if (parts.queueLink) {
    var count = Math.max(0, Number(d.queueCount) || 0);
    parts.queueLink.hidden = false;
    parts.queueLink.innerHTML = dialNpIcon("ph-list-bullets") + '<span class="np__badge readout" hidden>0</span>';
    parts.queueLink.setAttribute("aria-label", "Up Next, " + count + " queued");
    var badge = parts.queueLink.querySelector(".np__badge");
    if (badge) { badge.textContent = String(count); badge.hidden = count < 1; }
  }
  if (parts.bookmarkBtn) parts.bookmarkBtn.hidden = false;
  var bandKey = [d.foray ? "f" : "e", d.currentIndex, d.duration, d.segments && d.segments.length].join(":");
  if (parts.bandKey !== bandKey) {
    parts.bandKey = bandKey;
    parts.bandVisual.innerHTML = tactileBand({
      id: "np-band", kind: "scrub", segments: d.segments || [], progress: d.duration ? d.position / d.duration : 0,
      currentIndex: d.currentIndex || 0, totalSeconds: d.duration || 1, renderWidth: Math.max(1, parts.bandVisual.clientWidth || 345), buffering: d.buffering,
      valueText: d.valueText,
    });
    var visual = parts.bandVisual.querySelector(".band");
    if (visual) { visual.setAttribute("aria-hidden", "true"); visual.removeAttribute("tabindex"); }
    if (d.valueText) parts.scrub.setAttribute("aria-valuetext", d.valueText);
  } else {
    var x = d.duration ? Math.max(0, Math.min(1000, d.position / d.duration * 1000)) : 0;
    var clip = parts.bandVisual.querySelector(".band__progress");
    var needle = parts.bandVisual.querySelector(".needle");
    if (clip) clip.setAttribute("width", x.toFixed(2));
    if (needle) needle.setAttribute("transform", "translate(" + x.toFixed(2) + " 0)");
  }
  dialPaintChip(parts, d);
  dialPaintDetails(parts, d);
  var station = dialCurrentStation(d);
  var fallback = dialStationToken(station ? station.colorIndex : 0);
  if (d.foray) dialApplyNowPlayingTint(parts.sheet, fallback);
  else dialExtractArtworkTint(d.artwork, d.showId, fallback).then(function (tint) {
    if (parts.tintRequest === tintRequest && !parts.sheet.classList.contains("np--foray")) dialApplyNowPlayingTint(parts.sheet, tint);
  });
  var nextFrame = typeof requestAnimationFrame === "function" ? requestAnimationFrame : function (fn) { fn(); };
  nextFrame(function () {
    var lh = parseFloat(getComputedStyle(parts.sTitle).lineHeight) || 30;
    parts.sheet.classList.toggle("np--three-title", parts.sTitle.scrollHeight > lh * 2.35);
  });
}

function dialPaintNowPlayingRate(button, rate) {
  if (!button) return;
  var value = Number(rate);
  var text = Number.isFinite(value) ? value.toFixed(1) + "×" : "1.0×";
  button.innerHTML = '<span class="readout">' + esc(text) + "</span>";
}

function dialPreviewNowPlaying(parts, model) {
  if (!parts || !parts.bubble) return;
  var d = model || {};
  parts.bubble.hidden = false;
  parts.bubble.textContent = (d.show || "4a") + " · " + (d.clock || "0:00");
  var pct = d.duration ? Math.max(0, Math.min(1, d.position / d.duration)) : 0;
  parts.bubble.style.setProperty("--bubble-x", String(pct));
}

function dialHideNowPlayingPreview(parts) {
  if (parts && parts.bubble) parts.bubble.hidden = true;
}

function dialTransitionNowPlaying(open, miniArt, heroArt, commit) {
  if (typeof commit !== "function") return;
  var reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce) { commit(); return; }
  if (open && document.startViewTransition) {
    window.DialNowPlaying.transitioning = true;
    var transition = document.startViewTransition(function () { commit(); });
    transition.finished.finally(function () { window.DialNowPlaying.transitioning = false; });
    return;
  }
  var from = open ? miniArt : heroArt;
  var target = open ? heroArt : miniArt;
  var first = from && from.getBoundingClientRect ? from.getBoundingClientRect() : null;
  commit();
  var nextFrame = typeof requestAnimationFrame === "function" ? requestAnimationFrame : function (fn) { fn(); };
  nextFrame(function () {
    if (!first || !target || typeof target.animate !== "function") return;
    var last = target.getBoundingClientRect();
    if (!last.width || !last.height) return;
    var dx = first.left - last.left;
    var dy = first.top - last.top;
    target.animate([
      { transformOrigin: "top left", transform: "translate(" + dx + "px," + dy + "px) scale(" + first.width / last.width + "," + first.height / last.height + ")" },
      { transformOrigin: "top left", transform: "none" },
    ], { duration: 480, easing: "cubic-bezier(.2,.8,.2,1)", fill: "both" });
  });
}

window.DialNowPlaying = {
  transitioning: false,
  build: dialBuildNowPlaying,
  paint: dialPaintNowPlaying,
  preview: dialPreviewNowPlaying,
  hidePreview: dialHideNowPlayingPreview,
  applyTint: dialApplyNowPlayingTint,
  normalizeArtworkTint: dialNormalizeArtworkTint,
  extractArtworkTint: dialExtractArtworkTint,
  haptic: dialHaptic,
  transition: dialTransitionNowPlaying,
  paintRate: dialPaintNowPlayingRate,
};
