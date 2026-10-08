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
/* Sleep timer ticks, in minutes; 0 is Off. Every 5 minutes to 20, then the
   half-hour steps people actually set: the prototype's own list. */
var DIAL_SLEEP_TICKS = [0, 5, 10, 15, 20, 30, 45, 60];
/* A press becomes a drag after this many px; under it, it is a tap on a tick. */
var DIAL_ROTARY_DRAG_PX = 4;

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
  /* It opens the sleep dial, a dialog: say so to voice control (the speed chip
     carries the same attribute from player/client.js). */
  sleepBtn.setAttribute("aria-haspopup", "dialog");
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
  var rotaryHost = dialNpEl("div", "np__dial");
  rotaryHost.hidden = true;
  dock.append(parts.row, parts.row2, rotaryHost);
  parts.scroll.classList.add("np__scroll");
  parts.scroll.replaceChildren(top, more);
  /* A class flip on the threshold only (passive, no layout read beyond
     scrollTop), so the head can hold the sheet's colour once text is under it. */
  parts.scroll.addEventListener("scroll", function () {
    var scrolled = parts.scroll.scrollTop > 8;
    if (sheet.classList.contains("np--scrolled") !== scrolled) sheet.classList.toggle("np--scrolled", scrolled);
  }, { passive: true });
  sheet.replaceChildren(bg, parts.grabZone, parts.scroll, dock);
  return { bg: bg, top: top, artWrap: artWrap, collage: collage, chips: chips, bandVisual: bandVisual, bandSvg: bandSvg, bandCodes: codes, bandNeedle: needle, bubble: bubble, sleepBtn: sleepBtn, upNext: upNext, segments: segments, origin: origin, chapters: chapters, notes: notes, legacy: legacy, dock: dock, row2: parts.row2, rotaryHost: rotaryHost };
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

function dialSrgbToLinear(v) {
  var x = v / 255;
  return x <= .04045 ? x / 12.92 : Math.pow((x + .055) / 1.055, 2.4);
}

/* BUILD-NOTES 7: "average in linear light". Each opaque pixel's channels are
   linearised BEFORE they are summed. Averaging the encoded bytes and converting
   afterwards (the first build) darkens every mixed colour: a half-red,
   half-black cover read L .38 instead of .50 and tinted muddy. Pixels under half
   alpha are skipped. Returns null when nothing is opaque. */
function dialAverageLinear(pixels) {
  var sum = [0, 0, 0], count = 0;
  for (var i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] < 128) continue;
    sum[0] += dialSrgbToLinear(pixels[i]);
    sum[1] += dialSrgbToLinear(pixels[i + 1]);
    sum[2] += dialSrgbToLinear(pixels[i + 2]);
    count += 1;
  }
  return count ? sum.map(function (v) { return v / count; }) : null;
}

function dialRgbToOklch(rgb) {
  return dialLinearToOklch(rgb.map(dialSrgbToLinear));
}

/* Linear-light sRGB (each channel 0..1) -> OKLCH. */
function dialLinearToOklch(linear) {
  var l =.4122214708 * linear[0] + .5363325363 * linear[1] + .0514459929 * linear[2];
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

/* Everything after the pixels are read: linear-light average -> OKLCH ->
   normalised tint, or the show's enamel when no pixel is opaque. */
function dialTintFromPixels(pixels, fallback) {
  var linear = dialAverageLinear(pixels);
  return linear ? dialNormalizeArtworkTint(dialLinearToOklch(linear), fallback) : fallback;
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
        var tint = dialTintFromPixels(pixels, fallback);
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
   condensed ticks. The runs and the current run are the primitive's own (it is
   asked for EVERY run, narrow ones included: "one code per run, so colour is
   never alone"): this reads its rendered <text> and re-sets them as spans. */
function dialPaintBandCodes(parts) {
  if (!parts.bandCodes) return;
  parts.bandCodes.replaceChildren();
  var width = Math.max(1, parts.bandSvg.clientWidth || 345);
  var spans = [];
  parts.bandSvg.querySelectorAll(".t-band__code").forEach(function (text) {
    var span = dialNpEl("span", "np__code" + (text.classList.contains("is-current") ? " is-current" : ""), text.textContent);
    span.dataset.x = String(Number(text.getAttribute("x")) / 1000 * width);
    span.dataset.runStart = text.getAttribute("data-run-start");
    span.dataset.runEnd = text.getAttribute("data-run-end");
    parts.bandCodes.append(span);
    spans.push(span);
  });
  /* A run's code is centred under its bar; where neighbouring codes would
     collide (adjacent narrow runs) they are pushed apart, so every run keeps a
     readable code a few px from its bar rather than one stacked on the next. */
  var sizes = spans.map(function (span) { return span.offsetWidth || 14; });
  var centres = spans.map(function (span) { return Number(span.dataset.x); });
  var boxes = parts.bandBoxes || [];
  var runPx = spans.map(function (span) {
    var first = boxes[Number(span.dataset.runStart)];
    var last = boxes[Number(span.dataset.runEnd)];
    return first && last ? (last.x + last.width - first.x) / 1000 * width : 0;
  });
  var current = spans.map(function (span) { return span.classList.contains("is-current"); });
  var kept = dialFitCodes(centres, sizes, runPx, current, width);
  var shown = spans.filter(function (span, index) { return kept[index]; });
  var placed = dialSpreadCodes(centres.filter(function (c, index) { return kept[index]; }), sizes.filter(function (s, index) { return kept[index]; }), width);
  var at = 0;
  spans.forEach(function (span, index) {
    if (!kept[index]) { span.remove(); return; }
    span.style.setProperty("--x", String(centres[index] / width));
    span.style.setProperty("--dx", (placed[at] - centres[index]).toFixed(1) + "px");
    at += 1;
  });
  /* Keep what was dropped addressable for assistive tech and tests: the band's
     own accessible name carries every show, so nothing is lost with the label. */
  parts.bandCodes.dataset.shown = String(shown.length);
  parts.bandCodes.dataset.dropped = String(spans.length - shown.length);
}

/* The prototype's code row is a dial scale: a code per run with air around it.
   A foray with many short runs cannot give every one that, so the codes are
   laid out at DIAL_CODE_GAP px apart and, where that would push a code more than
   DIAL_CODE_SHIFT px off its own bar (or not fit at all), the narrowest run
   loses its code first, never the current run's. The bars keep their colours
   and the band's accessible name still lists every show. Returns a keep mask. */
var DIAL_CODE_GAP = 14;
var DIAL_CODE_SHIFT = 12;
function dialFitCodes(centres, sizes, runPx, current, total) {
  var keep = centres.map(function () { return true; });
  for (var pass = 0; pass < centres.length; pass += 1) {
    var idx = [];
    keep.forEach(function (k, i) { if (k) idx.push(i); });
    var placed = dialSpreadCodes(idx.map(function (i) { return centres[i]; }), idx.map(function (i) { return sizes[i]; }), total);
    var bad = -1;
    for (var n = 0; n < idx.length && bad < 0; n += 1) {
      var tight = n > 0 && placed[n] - placed[n - 1] < (sizes[idx[n]] + sizes[idx[n - 1]]) / 2 + DIAL_CODE_GAP - 0.01;
      if (tight || Math.abs(placed[n] - centres[idx[n]]) > DIAL_CODE_SHIFT) bad = n;
    }
    if (bad < 0) break;
    /* Drop the narrowest run among the offender and its neighbours (the whole
       row if they are all current), the current one last. */
    var pool = [bad - 1, bad, bad + 1].filter(function (n2) { return n2 >= 0 && n2 < idx.length && !current[idx[n2]]; });
    if (!pool.length) pool = idx.map(function (i, n2) { return n2; }).filter(function (n2) { return !current[idx[n2]]; });
    if (!pool.length) break;
    var victim = pool.reduce(function (best, n2) { return runPx[idx[n2]] < runPx[idx[best]] ? n2 : best; }, pool[0]);
    keep[idx[victim]] = false;
  }
  return keep;
}

/* Centres (px) -> non-overlapping centres inside [0, total]. Two passes keep
   the order and move a label only as far as its neighbour forces it: left to
   right pushes each past the one before, then right to left pulls the run back
   in from the far edge. Labels that cannot all fit keep their share of the
   squeeze (still ordered, still inside the box). */
function dialSpreadCodes(centres, sizes, total) {
  var gap = DIAL_CODE_GAP;
  var out = centres.slice();
  var n = out.length;
  for (var i = 0; i < n; i += 1) {
    var floor = i ? out[i - 1] + (sizes[i - 1] + sizes[i]) / 2 + gap : sizes[i] / 2;
    out[i] = Math.max(out[i], floor);
  }
  for (var j = n - 1; j >= 0; j -= 1) {
    var ceil = j < n - 1 ? out[j + 1] - (sizes[j + 1] + sizes[j]) / 2 - gap : total - sizes[j] / 2;
    out[j] = Math.min(out[j], ceil);
  }
  for (var k = 0; k < n; k += 1) out[k] = Math.max(sizes[k] / 2, Math.min(total - sizes[k] / 2, out[k]));
  return out;
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
      valueText: d.valueText, codeEveryRun: true,
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

/* The chip's reading: one decimal at least ("1.0×"), two where the ladder needs
   them ("1.25×", "0.75×"). toFixed(1) read 1.75 as "1.8×" and 0.75 as "0.8×". */
function dialRateText(rate) {
  var value = Number(rate);
  if (!Number.isFinite(value) || value <= 0) return "1.0×";
  var text = String(Math.round(value * 100) / 100);
  return (text.indexOf(".") < 0 ? text + ".0" : text) + "×";
}

function dialPaintNowPlayingRate(button, rate) {
  if (!button) return;
  var text = dialRateText(rate);
  button.innerHTML = '<span class="readout">' + esc(text) + "</span>";
}

/* "Sleep · Off" / "Sleep · 15 min": the word in the text face, the value in
   the mono readout (BUILD-NOTES 4.2, item 6). */
function dialSleepText(minutes) {
  var m = Math.max(0, Number(minutes) || 0);
  return m ? m + " min" : "Off";
}

function dialPaintSleep(button, minutes) {
  if (!button) return;
  var m = Math.max(0, Number(minutes) || 0);
  button.replaceChildren(dialNpEl("span", "", "Sleep · "), dialNpEl("span", "readout", dialSleepText(m)));
  button.setAttribute("aria-label", m ? "Sleep timer, " + m + " minutes. Change" : "Sleep timer, off. Set");
}

/* ---------- the rotary (BUILD-NOTES 3.14) ----------

   A horizontal detent strip in a well: a tick per stop, each at least 44px
   wide, with a 44px "-" key and a "+" key at the ends for keyboard and switch
   users. The three ways to move it all land on select():
     - tap a tick;
     - drag across the strip (the tick under the finger is the value, with a
       selection haptic per detent; a press under DIAL_ROTARY_DRAG_PX is a tap);
     - the "-" / "+" keys, and the arrow keys / Home / End on the strip.
   The strip is a radiogroup, one tab stop (the selected tick). Speed and sleep
   are both this widget; player/client.js hosts it in a sheet and supplies the
   stops and what a change does. */

/* The sleep stops as the rotary takes them: the tick shows the bare minutes
   ("15"), the accessible name and the sheet's readout say "15 min". */
function dialSleepStops() {
  return DIAL_SLEEP_TICKS.map(function (m) {
    return { value: m, text: m ? String(m) : "Off", label: m ? m + " minutes" : "Off", readout: dialSleepText(m) };
  });
}

/* Which tick is at `offset` px along the strip's content (scroll included).
   Clamped, so a drag that runs past either end holds the end tick. */
function dialRotaryIndexAt(offset, tickWidth, count) {
  if (!count || !(tickWidth > 0)) return 0;
  return Math.max(0, Math.min(count - 1, Math.floor(offset / tickWidth)));
}

function dialRotaryStop(stops, value) {
  for (var i = 0; i < stops.length; i += 1) if (stops[i].value === value) return i;
  return 0;
}

function dialBuildRotary(opts) {
  var o = opts || {};
  var stops = Array.isArray(o.stops) ? o.stops : [];
  var index = dialRotaryStop(stops, o.value);
  var root = dialNpEl("div", "rotary np-rotary");
  root.setAttribute("role", "group");
  root.setAttribute("aria-label", o.label || "Value");

  function stepKey(label, icon) {
    var key = dialNpEl("button", "keycap keycap--sm keycap--paper rotary__step");
    key.type = "button";
    key.setAttribute("aria-label", label);
    key.innerHTML = dialNpIcon(icon);
    return key;
  }
  var less = stepKey(o.lessLabel || "Less", "ph-minus");
  var more = stepKey(o.moreLabel || "More", "ph-plus");
  var done = null;
  if (typeof o.onDone === "function") {
    done = dialNpEl("button", "keycap keycap--sm keycap--persimmon rotary__done");
    done.type = "button";
    done.setAttribute("aria-label", "Done");
    done.innerHTML = dialNpIcon("ph-check");
    done.addEventListener("click", function () { o.onDone(); });
  }
  var track = dialNpEl("div", "well rotary__track");
  track.setAttribute("role", "radiogroup");
  track.setAttribute("aria-label", o.label || "Value");
  var ticks = stops.map(function (stop, i) {
    var tick = dialNpEl("button", "rotary__tick");
    tick.type = "button";
    tick.setAttribute("role", "radio");
    tick.setAttribute("aria-label", stop.label || stop.text);
    tick.dataset.index = String(i);
    tick.append(dialNpEl("span", "readout", stop.text));
    return tick;
  });
  track.append.apply(track, ticks);
  root.append(less, track, more);
  if (done) root.append(done);
  /* Escape closes the dial and nothing else: it must not reach the sheet
     owner's document listener, which would collapse Now Playing under it. */
  root.addEventListener("keydown", function (event) {
    if (event.key !== "Escape" && event.key !== "Esc") return;
    event.preventDefault();
    event.stopPropagation();
    if (typeof o.onDone === "function") o.onDone();
  });

  function paint() {
    ticks.forEach(function (tick, i) {
      tick.setAttribute("aria-checked", i === index ? "true" : "false");
      tick.tabIndex = i === index ? 0 : -1;
    });
    less.disabled = index <= 0;
    more.disabled = index >= stops.length - 1;
    var tick = ticks[index];
    if (!tick || !track.clientWidth) return;
    var left = tick.offsetLeft, right = left + tick.offsetWidth;
    if (left < track.scrollLeft) track.scrollLeft = left;
    else if (right > track.scrollLeft + track.clientWidth) track.scrollLeft = right - track.clientWidth;
  }

  function select(next, user) {
    next = Math.max(0, Math.min(stops.length - 1, next));
    var changed = next !== index;
    index = next;
    paint();
    if (changed && user) {
      dialHaptic("selection");
      if (typeof o.onChange === "function") o.onChange(stops[index].value, stops[index]);
    }
  }

  ticks.forEach(function (tick, i) {
    tick.addEventListener("click", function () { if (!api.suppressClick) select(i, true); });
  });
  [[less, -1], [more, 1]].forEach(function (pair) {
    pair[0].addEventListener("click", function () {
      select(index + pair[1], true);
      /* A key that just hit its end is now disabled and would drop focus. */
      if (pair[0].disabled && ticks[index]) ticks[index].focus();
    });
  });
  track.addEventListener("keydown", function (event) {
    var to = event.key === "ArrowLeft" || event.key === "ArrowDown" ? index - 1
      : event.key === "ArrowRight" || event.key === "ArrowUp" ? index + 1
        : event.key === "Home" ? 0 : event.key === "End" ? stops.length - 1 : null;
    if (to === null) return;
    event.preventDefault();
    select(to, true);
    if (ticks[index]) ticks[index].focus();
  });

  var press = null;
  track.addEventListener("pointerdown", function (event) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    press = { x: event.clientX, id: event.pointerId, drag: false };
  });
  track.addEventListener("pointermove", function (event) {
    if (!press || event.pointerId !== press.id) return;
    if (!press.drag) {
      if (Math.abs(event.clientX - press.x) < DIAL_ROTARY_DRAG_PX) return;
      press.drag = true;
      try { track.setPointerCapture(event.pointerId); } catch (_) { /* a synthetic pointer has nothing to capture */ }
    }
    var rect = track.getBoundingClientRect();
    select(dialRotaryIndexAt(event.clientX - rect.left + track.scrollLeft, ticks[0] ? ticks[0].offsetWidth : 0, stops.length), true);
  });
  function release(event) {
    if (!press || event.pointerId !== press.id) return;
    if (press.drag) {
      /* The click that ends a drag is not a tap on the tick under the finger. */
      api.suppressClick = true;
      setTimeout(function () { api.suppressClick = false; }, 0);
      try { track.releasePointerCapture(event.pointerId); } catch (_) { /* already released */ }
      /* Focus follows the value, so the next arrow key moves from where the drag ended. */
      if (ticks[index] && typeof ticks[index].focus === "function") ticks[index].focus({ preventScroll: true });
    }
    press = null;
  }
  track.addEventListener("pointerup", release);
  track.addEventListener("pointercancel", release);

  var api = {
    root: root, track: track, ticks: ticks, less: less, more: more, done: done, kind: o.kind || "", opener: o.opener || null, suppressClick: false,
    index: function () { return index; },
    value: function () { return stops[index] ? stops[index].value : null; },
    /* Move without reporting a change (the host already knows). */
    set: function (value) { select(dialRotaryStop(stops, value), false); },
    /* After the host attaches the strip: centre the selected tick. */
    reveal: function () {
      var tick = ticks[index];
      if (!tick || !track.clientWidth) return;
      track.scrollLeft = Math.max(0, tick.offsetLeft - (track.clientWidth - tick.offsetWidth) / 2);
    },
  };
  paint();
  return api;
}

/* The dial replaces the secondary row inside the dock (the prototype's dock
   swap): same height, same place, Done puts the row back. It is not a modal, so
   the sheet around it keeps its own focus trap; focus goes to the selected tick
   on open and back to the chip that opened it on close. `parts` is the view's
   built parts (player/client.js's `ui`). */
function dialOpenRotary(parts, spec) {
  if (!parts || !parts.rotaryHost || !parts.row2) return null;
  dialCloseRotary(parts, false);
  var rotary = dialBuildRotary({
    kind: spec.kind, label: spec.label, lessLabel: spec.lessLabel, moreLabel: spec.moreLabel,
    stops: spec.stops, value: spec.value, onChange: spec.onChange, opener: spec.opener,
    onDone: function () { dialCloseRotary(parts, true); },
  });
  parts.rotary = rotary;
  parts.rotaryHost.replaceChildren(rotary.root);
  parts.rotaryHost.hidden = false;
  parts.row2.hidden = true;
  if (parts.dock) parts.dock.classList.add("np__dock--dial");
  rotary.reveal();
  var tick = rotary.ticks[rotary.index()];
  if (tick && typeof tick.focus === "function") tick.focus({ preventScroll: true });
  return rotary;
}

/* Close the dial and put the secondary row back. Returns whether one was open. */
function dialCloseRotary(parts, restoreFocus) {
  var rotary = parts && parts.rotary;
  if (!rotary) return false;
  parts.rotary = null;
  parts.rotaryHost.replaceChildren();
  parts.rotaryHost.hidden = true;
  parts.row2.hidden = false;
  if (parts.dock) parts.dock.classList.remove("np__dock--dial");
  if (restoreFocus && rotary.opener && typeof rotary.opener.focus === "function") rotary.opener.focus({ preventScroll: true });
  return true;
}

/* A value changed somewhere else (the lock screen, the Foray page, the sleep
   timer running out) while the dial is open: the strip follows, silently. */
function dialSyncRotary(parts, kind, value) {
  var rotary = parts && parts.rotary;
  if (rotary && rotary.kind === kind) rotary.set(value);
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
  rateText: dialRateText,
  paintSleep: dialPaintSleep,
  sleepText: dialSleepText,
  sleepStops: dialSleepStops,
  rotary: dialBuildRotary,
  openRotary: dialOpenRotary,
  closeRotary: dialCloseRotary,
  syncRotary: dialSyncRotary,
  rotaryIndexAt: dialRotaryIndexAt,
  averageLinear: dialAverageLinear,
  tintFromPixels: dialTintFromPixels,
  spreadCodes: dialSpreadCodes,
  fitCodes: dialFitCodes,
  codeGap: DIAL_CODE_GAP,
  codeShift: DIAL_CODE_SHIFT,
};
