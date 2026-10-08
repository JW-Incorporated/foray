/* ui/now-playing.js — Dial (Tactile) Now Playing view.
 *
 * player/client.js owns audio and supplies real state. This file owns the
 * screen's markup, tint/material treatment, safe artwork sampling and haptic
 * shim. Dynamic prose is added as text nodes (never parsed); primitive HTML
 * routes all interpolations through esc() and all image URLs through safeUrl().
 *
 * Copy: the detail list of a foray's pieces is headed "Clips", not the
 * prototype's "Segments" — "segment" is pipeline vocabulary the listener copy
 * rules ban (build-loop.md section 2), and "clip" is the player's own word for
 * the pieces inside a foray's titled parts (client.js, audit 2026-09-22).
 */

var DIAL_HAPTIC_AT = 0;
var DIAL_ART_TINT_PREFIX = "cp_art_tint:";
/* Sleep timer stops, in minutes; 0 is Off. The rotary detent strip is the
   rotary primitive's job (BUILD-NOTES 3.14); the chip steps through these. */
var DIAL_SLEEP_STOPS = [0, 15, 30, 45, 60];

function dialNpEl(tag, cls, text) {
  var node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.append(String(text));
  return node;
}

function dialNpIcon(id, size) {
  return typeof tactileIcon === "function" ? tactileIcon(id, size) : "";
}

function dialSafeImageUrl(url) {
  var value = typeof safeUrl === "function" ? safeUrl(url) : "#";
  return value === "#" ? "" : value;
}

/* BUILD-NOTES 6: one call per 100ms at most, never on scroll, and a no-op on
   the web build (no Capacitor Haptics plugin) or when the OS has haptics off.
   Returns whether a call was let through the throttle, for the tests. */
function dialHaptic(kind, now) {
  var at = typeof now === "number" ? now : Date.now();
  if (at - DIAL_HAPTIC_AT < 100) return false;
  DIAL_HAPTIC_AT = at;
  try {
    var plugin = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Haptics;
    if (!plugin) return true;
    if (kind === "selection" && typeof plugin.selectionChanged === "function") plugin.selectionChanged();
    else if (kind === "success" && typeof plugin.notification === "function") plugin.notification({ type: "SUCCESS" });
    else if (typeof plugin.impact === "function") plugin.impact({ style: kind === "medium" ? "MEDIUM" : kind === "heavy" ? "HEAVY" : "LIGHT" });
  } catch (_) { /* Web build and OS-disabled haptics are intentional no-ops. */ }
  return true;
}

/* A control whose glyph this view owns: client.js's paintControl then writes
   only its accessible name, never its text, so a skip key keeps its mark. */
function dialOwnGlyph(button) {
  if (button && button.dataset) button.dataset.dialOwned = "1";
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
  var collage = dialNpEl("div", "np__collage");
  collage.setAttribute("aria-hidden", "true");
  collage.hidden = true;
  artWrap.append(parts.sArt, collage);
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
  var bandSvg = dialNpEl("div", "np__band-svg");
  var codes = dialNpEl("div", "np__codes");
  codes.setAttribute("aria-hidden", "true");
  var needle = dialNpEl("div", "np__needle");
  needle.setAttribute("aria-hidden", "true");
  bandVisual.append(bandSvg, codes, needle);
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
  dialPaintSleep(sleepBtn, 0);

  parts.rateBtn.className = "fp-rate rotary-chip";
  dialPaintNowPlayingRate(parts.rateBtn, 1);
  parts.bookmarkBtn.className = "fp-btn fp-bookmark keycap keycap--sm keycap--paper";
  parts.bookmarkBtn.innerHTML = dialNpIcon("ph-bookmark-simple");
  parts.queueLink.className = "fp-upnext keycap keycap--sm keycap--paper";
  parts.queueLink.innerHTML = dialNpIcon("ph-list-bullets") + '<span class="np__badge readout" hidden>0</span>';
  [parts.backBtn, parts.fwdBtn, parts.rateBtn, parts.bookmarkBtn, parts.queueLink].forEach(dialOwnGlyph);
  /* Icon keys are named from the first paint, before the player's own label
     painters have run. */
  [[parts.backBtn, "Back 15 seconds"], [parts.fwdBtn, "Forward 30 seconds"], [parts.bookmarkBtn, "Bookmark this point"], [parts.rateBtn, "Playback speed"]].forEach(function (pair) {
    if (pair[0] && !pair[0].getAttribute("aria-label")) pair[0].setAttribute("aria-label", pair[1]);
  });

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
  segments.append(dialNpEl("h2", "heading", "Clips"), dialNpEl("div", "np__segment-groups"));
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
  /* A class flip on the threshold only (passive, no layout read beyond
     scrollTop), so the head can hold the sheet's colour once text is under it. */
  parts.scroll.addEventListener("scroll", function () {
    var scrolled = parts.scroll.scrollTop > 8;
    if (sheet.classList.contains("np--scrolled") !== scrolled) sheet.classList.toggle("np--scrolled", scrolled);
  }, { passive: true });
  sheet.replaceChildren(bg, parts.grabZone, parts.scroll, dock);
  return { bg: bg, top: top, artWrap: artWrap, collage: collage, chips: chips, bandVisual: bandVisual, bandSvg: bandSvg, bandCodes: codes, bandNeedle: needle, bubble: bubble, sleepBtn: sleepBtn, upNext: upNext, segments: segments, origin: origin, chapters: chapters, notes: notes, legacy: legacy, dock: dock };
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

/* BUILD-NOTES 7: the sheet is the tint under the scrim. When ink over
   mix(tint, scrim) falls below 4.5:1 the scrim rises to 0.9. Returns the
   alpha it chose, for the tests. */
function dialApplyNowPlayingTint(sheet, tint) {
  if (!sheet || !tint || typeof getComputedStyle !== "function") return null;
  var styles = getComputedStyle(document.documentElement);
  var ink = dialHexRgb(styles.getPropertyValue("--ink"));
  var paper = dialHexRgb(styles.getPropertyValue("--paper"));
  var tintRgb = dialHexRgb(tint);
  if (!ink || !paper || !tintRgb) return null;
  var systemDark = typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches && document.documentElement.dataset.theme !== "light";
  var defaultAlpha = document.documentElement.dataset.theme === "dark" || systemDark ? .72 : .78;
  function mixed(alpha) { return tintRgb.map(function (v, i) { return Math.round(v * (1 - alpha) + paper[i] * alpha); }); }
  var alpha = dialContrast(ink, mixed(defaultAlpha)) < 4.5 ? .9 : defaultAlpha;
  var surface = mixed(alpha);
  sheet.style.setProperty("--np-tint", tint);
  sheet.style.setProperty("--np-scrim", "rgba(" + paper.join(",") + "," + alpha + ")");
  /* The solid twin of the composited tint: the sheet's own background colour,
     so contrast tools and forced-colour engines read the surface the layers
     paint. */
  sheet.style.setProperty("--np-surface", "rgb(" + surface.join(",") + ")");
  sheet.dataset.scrimAlpha = String(alpha);
  return alpha;
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

/* The station under the needle. Narration keeps the previous show's enamel
   (BUILD-NOTES 7), so a narration tick never flashes the tint. */
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
  parts.chips.replaceChildren();
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
  chip.append(swatch, code, dialNpEl("span", "np__station-name", station.show));
  parts.chips.append(chip);
}

function dialInitials(name) {
  return String(name || "4a").replace(/[^A-Za-z0-9 ]/g, " ").trim().split(/\s+/).slice(0, 2).map(function (word) { return word.charAt(0); }).join("").toUpperCase() || "4a";
}

/* A foray's hero is a 2x2 of its first four shows (the prototype's collage);
   a show with no published artwork is its enamel tile with its code. */
function dialPaintCollage(parts, model) {
  if (!parts.collage) return;
  var tiles = model.foray && Array.isArray(model.collage) ? model.collage.slice(0, 4) : [];
  parts.collage.replaceChildren();
  parts.collage.hidden = !tiles.length;
  parts.artWrap.classList.toggle("np__art--collage", tiles.length > 0);
  if (tiles.length) parts.sArt.hidden = true;
  tiles.forEach(function (tile) {
    var cell = dialNpEl("span", "np__tile t-band__bar--c" + (Number(tile.colorIndex) || 0));
    var url = dialSafeImageUrl(tile.artwork);
    if (url) {
      var image = dialNpEl("img", "");
      image.alt = "";
      image.decoding = "async";
      image.src = url;
      cell.append(image);
    } else cell.append(dialNpEl("b", "np__tile-code readout", tile.code || dialInitials(tile.show)));
    parts.collage.append(cell);
  });
}

function dialPaintDetails(parts, model) {
  var key = model.detailKey || "";
  if (parts.moreKey === key) return;
  parts.moreKey = key;
  dialPaintCollage(parts, model);
  var nextHost = parts.upNext.querySelector(".np__up-next-card");
  nextHost.replaceChildren();
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
      nextArt.classList.add("t-band__bar--c" + (Number(model.next.colorIndex) || 0));
      nextArt.append(dialNpEl("span", "", model.next.code || dialInitials(model.next.show)));
    }
    var nextBody = dialNpEl("span", "np__up-next-body");
    var nextTitle = dialNpEl("h3", "np__detail-title", model.next.title || model.next.show);
    nextBody.append(nextTitle);
    if (model.next.why) nextBody.append(dialNpEl("p", "np__detail-copy", model.next.why));
    var nextTime = dialNpEl("span", "readout", model.next.duration || "");
    nextHost.append(nextArt, nextBody, nextTime);
  } else {
    nextHost.append(dialNpEl("p", "np__empty-detail", "Nothing queued."));
  }

  var groups = parts.segments.querySelector(".np__segment-groups");
  groups.replaceChildren();
  (model.slots || []).forEach(function (slot) {
    var group = dialNpEl("div", "np__slot");
    group.append(dialNpEl("h3", "np__slot-title", slot.title || "Clips"));
    (slot.items || []).forEach(function (item) {
      var row = dialNpEl("button", "segrow" + (item.current ? " is-current" : "") + (item.narration ? " segrow--n" : ""));
      row.type = "button";
      row.dataset.seek = String(item.start || 0);
      row.setAttribute("aria-label", "Play from " + (item.narration ? "4a narration" : item.show) + ", " + (item.duration || ""));
      var swatch = dialNpEl("span", "np__origin-swatch t-band__bar--c" + item.colorIndex, item.narration ? "" : item.code);
      var body = dialNpEl("span", "np__segment-copy");
      body.append(dialNpEl("strong", "np__detail-title", item.narration ? "4a narration" : item.show));
      row.append(swatch, body, dialNpEl("span", "readout", item.duration || ""));
      if (item.narration) {
        var tag = dialNpEl("span", "tag tag--narration");
        tag.innerHTML = dialNpIcon("narration", "sm");
        tag.append(dialNpEl("span", "", "narration"));
        row.append(tag);
      }
      group.append(row);
    });
    groups.append(group);
  });
  parts.segments.hidden = !model.foray;

  var origins = parts.origin.querySelector(".np__origin-rows");
  origins.replaceChildren();
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
        row.setAttribute("aria-label", "Play from " + chapter.title);
        row.append(dialNpEl("span", "np__detail-title", chapter.title), dialNpEl("span", "readout", chapter.clock || ""));
        parts.chapters.append(row);
      });
    } else parts.chapters.append(dialNpEl("p", "np__empty-detail", "No chapters published."));
  }
  var details = parts.notes.querySelector("details");
  parts.notes.hidden = model.foray || !details || details.hidden;
}

/* The band's drawn geometry for this paint: the same layout the primitive
   used, so the needle and the clip land on the bars, not on raw runtime. */
function dialBandBoxes(d, width) {
  if (typeof tactileBandLayout !== "function" || typeof tactileBandSegments !== "function") return [];
  return tactileBandLayout(tactileBandSegments(d.segments || []), width, "scrub");
}

function dialBandX(boxes, fraction) {
  if (typeof tactileBandX === "function" && boxes.length) return tactileBandX(boxes, fraction);
  return Math.max(0, Math.min(1, Number(fraction) || 0)) * 1000;
}

/* Station codes as HTML under the bars. The primitive's SVG <text> stretches
   with the band's non-uniform viewBox scale (a 1000-unit box drawn ~345px wide
   squeezes each glyph to a third), which made the codes read as faint
   condensed ticks. The runs, the >= 24px rule and the current run are the
   primitive's own: this reads its rendered <text> and re-sets them as spans. */
function dialPaintBandCodes(parts) {
  if (!parts.bandCodes) return;
  parts.bandCodes.replaceChildren();
  parts.bandSvg.querySelectorAll(".t-band__code").forEach(function (text) {
    var span = dialNpEl("span", "np__code" + (text.classList.contains("is-current") ? " is-current" : ""), text.textContent);
    span.style.setProperty("--x", String(Number(text.getAttribute("x")) / 1000));
    parts.bandCodes.append(span);
  });
}

/* The spoken clock: written when what is under the needle changes, or (with
   the slider not focused) when the whole minute moves. Never per tick: a
   focused slider whose text changes is re-announced (a11y-7). */
function dialPaintValueText(parts, d, force) {
  if (!d.valueText || !parts.scrub) return;
  var minute = Math.floor((Number(d.position) || 0) / 60);
  var focused = typeof document !== "undefined" && document.activeElement === parts.scrub;
  if (!force && (focused || parts.valueMinute === minute)) return;
  parts.valueMinute = minute;
  if (parts.scrub.getAttribute("aria-valuetext") !== d.valueText) parts.scrub.setAttribute("aria-valuetext", d.valueText);
}

function dialPaintNowPlaying(parts, model) {
  if (!parts || !parts.bandVisual) return;
  var d = model || {};
  var tintRequest = (parts.tintRequest || 0) + 1;
  parts.tintRequest = tintRequest;
  parts.sheet.classList.toggle("np--foray", Boolean(d.foray));
  parts.sheet.classList.toggle("np--buffering", Boolean(d.buffering));
  var subtitle = d.subtitle || d.show;
  if (subtitle && parts.sShow.textContent !== subtitle) parts.sShow.replaceChildren(subtitle);
  var playIcon = d.running ? "ph-pause-fill" : "ph-play-fill";
  if (parts.bigPlay.dataset.icon !== playIcon) {
    parts.bigPlay.dataset.icon = playIcon;
    parts.bigPlay.innerHTML = dialNpIcon(playIcon, "lg");
  }
  parts.bigPlay.setAttribute("aria-label", d.running ? "Pause" : "Play");
  if (parts.queueLink) {
    var count = Math.max(0, Number(d.queueCount) || 0);
    parts.queueLink.hidden = false;
    parts.queueLink.setAttribute("aria-label", "Up Next, " + count + " queued");
    var badge = parts.queueLink.querySelector(".np__badge");
    if (badge) { badge.replaceChildren(String(count)); badge.hidden = count < 1; }
  }
  if (parts.bookmarkBtn) parts.bookmarkBtn.hidden = false;
  var width = Math.max(1, parts.bandSvg.clientWidth || parts.bandVisual.clientWidth || 345);
  var bandKey = [d.foray ? "f" : "e", d.detailKey, d.currentIndex, d.duration, d.segments && d.segments.length, Math.round(width)].join(":");
  var fraction = d.duration ? d.position / d.duration : 0;
  if (parts.bandKey !== bandKey) {
    parts.bandKey = bandKey;
    parts.bandBoxes = dialBandBoxes(d, width);
    parts.bandSvg.innerHTML = tactileBand({
      id: "np-band", kind: "scrub", segments: d.segments || [], progress: fraction,
      currentIndex: d.currentIndex || 0, totalSeconds: d.duration || 1, renderWidth: width, buffering: d.buffering,
      valueText: d.valueText,
    });
    var visual = parts.bandSvg.querySelector(".band");
    /* The <input type=range> over the band is the one slider; the drawing is
       decoration to assistive tech. */
    if (visual) { visual.setAttribute("aria-hidden", "true"); visual.removeAttribute("role"); visual.removeAttribute("tabindex"); }
    dialPaintBandCodes(parts);
    dialPaintValueText(parts, d, true);
  } else dialPaintValueText(parts, d, false);
  var x = dialBandX(parts.bandBoxes || [], fraction);
  var clip = parts.bandSvg.querySelector(".band__progress");
  var svgNeedle = parts.bandSvg.querySelector(".needle");
  if (clip) clip.setAttribute("width", x.toFixed(2));
  if (svgNeedle) svgNeedle.setAttribute("transform", "translate(" + x.toFixed(2) + " 0)");
  parts.bandNeedle.style.setProperty("--x", String(x / 1000));
  parts.bandNeedle.classList.toggle("is-buffering", Boolean(d.buffering));
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
  var text = Number.isFinite(value) && value > 0 ? value.toFixed(1) + "×" : "1.0×";
  button.innerHTML = '<span class="readout">' + esc(text) + "</span>";
}

/* "Sleep · Off" / "Sleep · 15 min": the word in the text face, the value in
   the mono readout (BUILD-NOTES 4.2, item 6). */
function dialPaintSleep(button, minutes) {
  if (!button) return;
  var m = Math.max(0, Number(minutes) || 0);
  var value = m ? m + " min" : "Off";
  button.replaceChildren(dialNpEl("span", "", "Sleep · "), dialNpEl("span", "readout", value));
  button.setAttribute("aria-label", m ? "Sleep timer, " + m + " minutes. Change" : "Sleep timer, off. Set");
}

function dialNextSleepStop(minutes) {
  var at = DIAL_SLEEP_STOPS.indexOf(Number(minutes) || 0);
  return DIAL_SLEEP_STOPS[(at + 1) % DIAL_SLEEP_STOPS.length];
}

function dialPreviewNowPlaying(parts, model) {
  if (!parts || !parts.bubble) return;
  var d = model || {};
  parts.bubble.hidden = false;
  parts.bubble.replaceChildren((d.show || "4a") + " · " + (d.clock || "0:00"));
  var x = dialBandX(parts.bandBoxes || [], d.duration ? d.position / d.duration : 0);
  parts.bubble.style.setProperty("--bubble-x", String(x / 1000));
  if (parts.bandNeedle) parts.bandNeedle.style.setProperty("--x", String(x / 1000));
}

function dialHideNowPlayingPreview(parts) {
  if (parts && parts.bubble) parts.bubble.hidden = true;
}

/* The deck opens: the mini's artwork moves into the hero slot (BUILD-NOTES 5).
   View Transitions where the engine has them (both artworks carry
   view-transition-name np-art, and only the visible one does at capture), a
   WAAPI FLIP of the hero otherwise; reduced motion commits at once. */
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
    if (!last.width || !last.height || !first.width || !first.height) return;
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
  currentStation: dialCurrentStation,
  haptic: dialHaptic,
  transition: dialTransitionNowPlaying,
  paintRate: dialPaintNowPlayingRate,
  paintSleep: dialPaintSleep,
  nextSleepStop: dialNextSleepStop,
};
