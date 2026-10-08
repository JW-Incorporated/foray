/* ui/primitives.js — Dial (Tactile) foundation primitives.
 *
 * Real app renderers, intentionally unused by listener screens until their
 * Phase 4 adoption branches. The guarded component gallery is the only caller
 * in Phase 3. Every caller-supplied string is escaped here, and every href/src
 * (artwork, and each icon's sprite href) passes through safeUrl().
 */

/* An icon's sprite href. safeUrl() is the gate, as for every href: it passes
 * "#" + a symbol id from the sprite (app.js SPRITE_IDS) and answers "#" for any
 * other fragment. This only maps an unknown id to the radio glyph first, so a
 * typo still draws an icon instead of an empty box. */
function tactileSpriteRef(id) {
  return "#" + (SPRITE_IDS.has(id) ? id : "ph-radio");
}

function tactileIcon(id, size) {
  var cls = size === "sm" ? " i--sm" : size === "lg" ? " i--lg" : "";
  return '<svg class="i' + cls + '" aria-hidden="true" focusable="false"><use href="' + esc(safeUrl(tactileSpriteRef(id))) + '"></use></svg>';
}

/* Drawn size of each frame in CSS px (the --art-* tokens; hero is --key-xl +
 * --s-4). The image asks Apple's CDN for 3x that (artUrl, as rowArtImg does),
 * never the 600px original, and reserves its box. */
var TACTILE_ART_PX = { row: 56, queue: 48, mini: 44, disc: 40, hero: 96 };

/* Artwork is decorative by default: every caller in the system sits beside the
 * title it would repeat, so `alt=""` keeps screen readers from reading it twice.
 * A caller whose artwork stands alone passes `alt` explicitly. */
function tactileArtFrame(data) {
  var d = data || {};
  var size = ["row", "queue", "mini", "disc", "hero"].includes(d.size) ? d.size : "row";
  var shape = d.round ? " art-frame--round" : "";
  var state = d.loading ? " is-loading" : d.offline ? " is-offline" : "";
  var label = typeof d.alt === "string" ? d.alt : "";
  var px = TACTILE_ART_PX[size];
  var image = d.url
    ? '<img src="' + esc(safeUrl(artUrl(d.url, px * 3))) + '" alt="' + esc(label) + '" loading="lazy" decoding="async" width="' + px + '" height="' + px + '">'
    : '<span class="art-frame__initials" aria-hidden="true">' + esc(d.initials || "4a") + "</span>";
  return '<span class="art-frame art-frame--' + esc(size) + shape + state + '"' + (d.loading ? ' aria-busy="true"' : "") + ">" + image + "</span>";
}

function tactileKeycap(data) {
  var d = data || {};
  var size = ["sm", "md", "lg", "xl", "glance"].includes(d.size) ? d.size : "md";
  var variant = ["persimmon", "ultramarine", "rubber", "paper"].includes(d.variant) ? d.variant : "paper";
  var cls = "keycap--" + size + " keycap--" + variant;
  if (d.round) cls += " keycap--round";
  if (d.wide) cls += " keycap--wide";
  if (d.focus) cls += " is-focus";
  if (d.loading) cls += " is-loading";
  if (d.offline) cls += " keycap--blocked";
  var disabled = d.disabled || d.loading || d.offline;
  var icon = d.offline ? "ph-cloud-slash" : d.loading ? "ph-radio" : d.icon;
  var text = d.offline ? (d.text || "Needs a connection") : d.text;
  return '<button type="button" class="keycap ' + esc(cls) + '"' +
    (d.id ? ' id="' + esc(d.id) + '"' : "") +
    (d.action ? ' data-action="' + esc(d.action) + '"' : "") +
    (d.pressed ? ' data-pressed="true"' : "") +
    (d.loading ? ' aria-busy="true"' : "") +
    (disabled ? " disabled" : "") +
    ' aria-label="' + esc(d.label || text || "Action") + '">' +
    (icon ? tactileIcon(icon, size === "xl" || size === "glance" ? "lg" : "") : "") +
    (text ? '<span class="keycap__label">' + esc(text) + "</span>" : "") +
    (d.readout ? '<span class="readout keycap__readout">' + esc(d.readout) + "</span>" : "") +
    "</button>";
}

function tactileTextButton(data) {
  var d = data || {};
  return '<button type="button" class="textbtn ' + (d.focus ? "is-focus" : "") + '"' +
    (d.disabled ? " disabled" : "") + ' aria-label="' + esc(d.label || d.text || "Action") + '">' + esc(d.text || "Action") + "</button>";
}

function tactileChip(data) {
  var d = data || {};
  return '<button type="button" class="chip ' + (d.focus ? "is-focus " : "") + (d.loading ? "is-loading" : "") + '"' +
    ' aria-pressed="' + (d.selected ? "true" : "false") + '"' +
    (d.disabled || d.loading ? " disabled" : "") +
    (d.loading ? ' aria-busy="true"' : "") + ">" +
    (d.selected ? tactileIcon("ph-check", "sm") : "") + '<span>' + esc(d.text || "Choice") + "</span>" +
    (Number.isFinite(d.count) ? '<span class="chip__count readout">' + esc(d.count) + "</span>" : "") +
    "</button>";
}

function tactileTag(data) {
  var d = data || {};
  var kind = ["stretch", "narration", "downloaded", "played", "playing"].includes(d.kind) ? d.kind : "played";
  var icons = { stretch: "bridge", narration: "narration", downloaded: "ph-check-circle", played: "ph-check", playing: "needle" };
  return '<span class="tag tag--' + esc(kind) + '">' + tactileIcon(icons[kind], "sm") + '<span>' + esc(d.text || kind) + "</span></span>";
}

function tactileCard(data) {
  var d = data || {};
  return '<article class="card' + (d.hero ? " card--hero" : "") + (d.loading ? " is-loading" : "") + '"' +
    (d.loading ? ' aria-busy="true"' : "") + '><p class="card__eyebrow">' + esc(d.eyebrow || "Card") +
    '</p><h3 class="heading">' + esc(d.title || "A tactile surface") + '</h3><p class="card__copy">' +
    esc(d.copy || "Raised enamel keeps related controls together.") + "</p></article>";
}

function tactileWell(data) {
  var d = data || {};
  return '<div class="well' + (d.loading ? " is-loading" : "") + '"' + (d.loading ? ' aria-busy="true"' : "") +
    '><span class="readout">' + esc(d.text || "Inset well") + "</span></div>";
}

function tactileHash(value) {
  var text = String(value || "");
  var h = 2166136261;
  for (var i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 8;
}

function tactileStationCode(name) {
  var words = String(name || "Show").replace(/^The\s+/i, "").trim().split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : (words[0] || "SH").slice(0, 2)).toUpperCase();
}

function tactileBandRuns(segments, widths) {
  var runs = [];
  var active = null;
  segments.forEach(function (segment, index) {
    if (segment.narration) return;
    if (!active || active.showId !== segment.showId) {
      if (active) runs.push(active);
      active = { showId: segment.showId, show: segment.show, start: index, end: index, x: widths[index].x, right: widths[index].x + widths[index].width };
      return;
    }
    active.end = index;
    active.right = widths[index].x + widths[index].width;
  });
  if (active) runs.push(active);
  return runs;
}

function tactileBandSegments(input) {
  return (Array.isArray(input) ? input : []).map(function (segment, index) {
    var s = segment || {};
    return {
      showId: String(s.showId || (s.narration ? "narration" : "show-" + index)),
      show: String(s.show || (s.narration ? "4a narration" : "Show")),
      duration: Math.max(1, Number(s.duration) || 1),
      narration: Boolean(s.narration),
    };
  });
}

/* The gap between bars, in viewBox units. The prototype's stitched rhythm is a
 * gap you can see: 3px rendered (2px on the 8px mini band and the 3px line),
 * not a 2-unit hairline (0.7px on a 345px band, which read as one slab with
 * seams). It never drops under 2 units, and where hundreds of clips would make
 * the gaps eat the band they are capped at a quarter of it between them. */
function tactileBandGap(kind, renderWidth, count) {
  var px = kind === "mini" || kind === "line" ? 2 : 3;
  var units = px / Math.max(1, Number(renderWidth) || 345) * 1000;
  return Math.max(2, count > 1 ? Math.min(units, 250 / (count - 1)) : units);
}

/* Corner radius as a viewBox (rx, ry) pair. The viewBox is stretched
 * non-uniformly (preserveAspectRatio none), so one number would draw an ellipse:
 * x and y are each converted from the rendered px radius. */
var TACTILE_BAND_PX = { scrub: 64, detail: 44, mini: 8, line: 3 };
/* Where a bar sits in the 0-60 viewBox. The scrub band draws the prototype's
 * 28px bars 6px down a 64px stage (.band--scrub .band__stage: --bt 6px, --bh
 * 28px), which leaves the station codes 4px under the bars and 10px of well
 * under them. The older 8/28 units rendered 8.5px / 29.9px at 64px, 2px taller
 * and 2.5px lower, which pushed the codes down against the well's edge. The
 * other kinds keep 8/28. */
var TACTILE_BAND_BAR = { scrub: { y: 6 * 60 / 64, h: 28 * 60 / 64 } };
function tactileBandBar(kind) { return TACTILE_BAND_BAR[kind] || { y: 8, h: 28 }; }
function tactileBandRadius(kind, renderWidth, boxWidth) {
  var px = kind === "line" ? 0 : kind === "mini" ? 1 : 3;
  return {
    rx: Math.min(px / Math.max(1, Number(renderWidth) || 345) * 1000, boxWidth / 2),
    ry: Math.min(px * 60 / TACTILE_BAND_PX[kind], 14),
  };
}

/* Band geometry in the 0-1000 viewBox. Bars sit a visible gap apart
 * (tactileBandGap), in order, and the last one ends at 1000. Each bar gets its runtime share of the width the
 * gaps leave, but never less than its rendered minimum (3px; 8px for hatched
 * narration outside the mini and line bands). A bar under its minimum is
 * pinned at it and the others share what is left in runtime proportion,
 * repeated until nothing else falls under (so pinning can never push a later
 * bar past the end or under a neighbour). When the minima alone cannot fit (a
 * band of hundreds of clips on a narrow render) every bar is scaled down evenly
 * from its minimum: still ordered, still inside the box; that is the one case a
 * bar renders under its minimum. Each box carries the runtime fractions it
 * covers (`from`, `to`) so progress maps onto the bars, not onto raw runtime. */
function tactileBandLayout(segments, renderWidth, kind) {
  var n = segments.length;
  if (!n) return [];
  var width = Math.max(1, Number(renderWidth) || 345);
  var gap = tactileBandGap(kind, width, n);
  var available = Math.max(0, 1000 - gap * (n - 1));
  var mins = segments.map(function (segment) {
    return (segment.narration && kind !== "mini" && kind !== "line" ? 8 : 3) / width * 1000;
  });
  var minSum = mins.reduce(function (sum, m) { return sum + m; }, 0);
  var widths;
  if (minSum >= available) {
    widths = mins.map(function (m) { return m * available / minSum; });
  } else {
    var pinned = mins.map(function () { return false; });
    var changed = true;
    while (changed) {
      var free = available;
      var freeTime = 0;
      segments.forEach(function (segment, i) { if (pinned[i]) free -= mins[i]; else freeTime += segment.duration; });
      widths = segments.map(function (segment, i) { return pinned[i] ? mins[i] : segment.duration / freeTime * free; });
      changed = false;
      widths.forEach(function (w, i) { if (!pinned[i] && w < mins[i]) { pinned[i] = true; changed = true; } });
    }
  }
  var total = segments.reduce(function (sum, segment) { return sum + segment.duration; }, 0);
  var cursor = 0;
  var elapsed = 0;
  return segments.map(function (segment, i) {
    var box = { x: cursor, width: widths[i], from: elapsed / total, to: (elapsed + segment.duration) / total };
    cursor += widths[i] + gap;
    elapsed += segment.duration;
    return box;
  });
}

/* Runtime fraction (0-1) -> viewBox x on the laid-out bars. */
function tactileBandX(boxes, fraction) {
  var f = Math.max(0, Math.min(1, Number(fraction) || 0));
  if (!boxes.length) return f * 1000;
  for (var i = 0; i < boxes.length; i += 1) {
    var box = boxes[i];
    if (f <= box.to || i === boxes.length - 1) {
      var span = box.to - box.from;
      return box.x + (span > 0 ? Math.max(0, Math.min(1, (f - box.from) / span)) : 1) * box.width;
    }
  }
  return 1000;
}

/* viewBox x -> runtime fraction; a point in a gap reads as the end of the bar before it. */
function tactileBandFraction(boxes, x) {
  var v = Math.max(0, Math.min(1000, Number(x) || 0));
  if (!boxes.length) return v / 1000;
  for (var i = 0; i < boxes.length; i += 1) {
    var box = boxes[i];
    var next = boxes[i + 1];
    if (!next || v < next.x) {
      return box.from + Math.max(0, Math.min(1, box.width > 0 ? (v - box.x) / box.width : 1)) * (box.to - box.from);
    }
  }
  return 1;
}

/* A band's <pattern> and <clipPath> ids are document-global, and a url(#id)
 * reference resolves to the FIRST element with that id. A band rendered
 * without an id therefore gets a fresh one per render: a shared default would
 * make every later band hatch and clip through the first band's definitions
 * (its progress, not their own). A caller-supplied id is the caller's to keep
 * unique on the page. */
var tactileBandSerial = 0;
function tactileBandAutoId() {
  tactileBandSerial += 1;
  return "dial-band-" + tactileBandSerial;
}

function tactileBand(data) {
  var d = data || {};
  var kind = ["mini", "detail", "scrub", "line"].includes(d.kind) ? d.kind : "mini";
  var segments = tactileBandSegments(d.segments);
  /* The mini player's 3px line (BUILD-NOTES 3.12) carries the foray's colours,
     or one persimmon bar for a single episode, which has no segments. */
  var episode = kind === "line" && !segments.length;
  if (episode) segments = [{ showId: "episode", show: "Episode", duration: 1, narration: false }];
  var line = kind === "line";
  /* Narration is hatched where it is wide enough to read (detail, scrub); in
     the 8px mini band and the 3px line it is a solid ultramarine tick (3.6). */
  var hatch = kind !== "mini" && !line;
  var total = segments.reduce(function (sum, segment) { return sum + segment.duration; }, 0) || 1;
  var renderWidth = Math.max(1, Number(d.renderWidth) || 345);
  var widths = tactileBandLayout(segments, renderWidth, kind);
  var id = d.id ? String(d.id).replace(/[^A-Za-z0-9_-]/g, "-") : tactileBandAutoId();
  var progress = Math.max(0, Math.min(1, Number(d.progress) || 0));
  var progressX = tactileBandX(widths, progress);
  var current = Math.max(0, Math.min(segments.length - 1, Number(d.currentIndex) || 0));
  var codes = new Map();
  segments.forEach(function (segment) {
    if (!segment.narration && !codes.has(segment.showId)) codes.set(segment.showId, tactileStationCode(segment.show));
  });
  var used = new Map();
  codes.forEach(function (code, showId) {
    if (!used.has(code)) used.set(code, showId);
    else {
      var words = segments.find(function (segment) { return segment.showId === showId; }).show.replace(/^The\s+/i, "").trim().split(/\s+/);
      codes.set(showId, (code[0] + (words[words.length - 1][0] || code[1])).toUpperCase());
    }
  });
  var barBox = tactileBandBar(kind);
  var bars = widths.map(function (box, index) {
    var segment = segments[index];
    var cls = episode ? "t-band__bar t-band__bar--episode"
      : segment.narration ? "t-band__bar t-band__bar--narration" + (hatch ? "" : " t-band__bar--tick")
      : "t-band__bar t-band__bar--c" + tactileHash(segment.showId);
    var radius = tactileBandRadius(kind, renderWidth, box.width);
    var shape = line ? '" y="0" width="' + box.width.toFixed(2) + '" height="60" rx="0"' : '" y="' + barBox.y.toFixed(2) + '" width="' + box.width.toFixed(2) + '" height="' + barBox.h.toFixed(2) + '" rx="' + radius.rx.toFixed(2) + '" ry="' + radius.ry.toFixed(2) + '"';
    return '<rect class="' + cls + '"' + (segment.narration && hatch ? ' fill="url(#' + esc(id) + '-hatch)"' : "") + ' data-segment-index="' + index + '" x="' + box.x.toFixed(2) + shape + "></rect>";
  }).join("");
  var labels = kind === "mini" || kind === "line" ? "" : tactileBandRuns(segments, widths).map(function (run) {
    var widthPx = (run.right - run.x) / 1000 * renderWidth;
    /* The 24px gate stands unless the caller (Now Playing) asks for a code on
       every run, "so colour is never alone": it then lays the narrow ones out
       itself (ui/now-playing.js dialPaintBandCodes) and reads data-narrow. */
    var narrow = widthPx < 24;
    if (narrow && !d.codeEveryRun) return "";
    var isCurrent = current >= run.start && current <= run.end;
    return '<text class="t-band__code' + (isCurrent ? " is-current" : "") + '"' + (narrow ? ' data-narrow="true"' : "") + ' data-run-start="' + run.start + '" data-run-end="' + run.end + '" x="' + ((run.x + run.right) / 2).toFixed(2) + '" y="53" text-anchor="middle">' + esc(codes.get(run.showId)) + "</text>";
  }).join("");
  var role = kind === "scrub" ? "slider" : "img";
  var valueText = d.valueText || Math.round(progress * (Number(d.totalSeconds) || total)) + " seconds of " + Math.round(Number(d.totalSeconds) || total) + " seconds, " + (segments[current] ? segments[current].show : "4a");
  /* The line is decoration on the mini player, whose region label names what
     is playing; it is hidden from assistive tech, as in the prototype. */
  var aria = line ? ' aria-hidden="true" focusable="false"' : role === "slider"
    ? ' tabindex="0" aria-valuemin="0" aria-valuemax="' + Math.round(Number(d.totalSeconds) || total) + '" aria-valuenow="' + Math.round(progress * (Number(d.totalSeconds) || total)) + '" aria-valuetext="' + esc(valueText) + '"'
    : ' aria-label="' + esc(d.label || "Foray band with " + codes.size + " stations") + '"';
  return '<svg class="band band--' + esc(kind) + (d.buffering ? " band--buffering" : "") + '"' + (line ? "" : ' data-draw="true" role="' + role + '"') + aria + ' viewBox="0 0 1000 60" preserveAspectRatio="none">' +
    '<defs><pattern id="' + esc(id) + '-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="scale(' + (1000 / renderWidth).toFixed(4) + " " + (60 / TACTILE_BAND_PX[kind]).toFixed(4) + ') rotate(45)"><rect width="6" height="6" class="t-band__hatch-bg"></rect><rect width="3" height="6" class="t-band__hatch"></rect></pattern>' +
    '<clipPath id="' + esc(id) + '-progress"><rect class="band__progress" x="0" y="0" width="' + progressX.toFixed(2) + '" height="60"></rect></clipPath></defs>' +
    '<g class="' + (line ? "band__layers" : "band__draw") + '"><g class="t-band__base">' + bars + '</g><g class="t-band__fill" clip-path="url(#' + esc(id) + '-progress)">' + bars + "</g>" + labels +
    (line ? "" : '<g class="needle" transform="translate(' + progressX.toFixed(2) + ' 0)"><rect x="-1" y="3" width="2" height="39" rx="1"></rect><circle cx="0" cy="3" r="4"></circle></g>') + "</g></svg>";
}

function tactileWireScrubber(scrubber, data) {
  if (!scrubber || scrubber.getAttribute("role") !== "slider") return function () {};
  var d = data || {};
  var total = Math.max(1, Number(d.totalSeconds || scrubber.getAttribute("aria-valuemax")) || 1);
  var segments = tactileBandSegments(d.segments);
  var segmentTotal = segments.reduce(function (sum, segment) { return sum + segment.duration; }, 0);
  var boundaries = [0];
  var elapsed = 0;
  segments.forEach(function (segment) {
    elapsed += segment.duration;
    boundaries.push(segmentTotal ? elapsed / segmentTotal * total : 0);
  });
  if (boundaries[boundaries.length - 1] !== total) boundaries.push(total);
  var progressRect = scrubber.querySelector(".band__progress");
  var needle = scrubber.querySelector(".needle");
  var dragging = false;

  /* The bars are laid out with minimum widths (tactileBandLayout), so the
     needle and the pointer map through the same boxes the band drew, never
     through raw runtime: a needle at a boundary sits in the gap between bars. */
  function measure() {
    var rect = scrubber.getBoundingClientRect ? scrubber.getBoundingClientRect() : null;
    return rect && rect.width > 0 ? rect : null;
  }
  function layout(rect) {
    return tactileBandLayout(segments, rect ? rect.width : Number(d.renderWidth) || 345, "scrub");
  }
  function clamp(value) { return Math.max(0, Math.min(total, Math.round(Number(value) || 0))); }
  function valueText(value) {
    return typeof d.formatValue === "function" ? d.formatValue(value) : value + " seconds of " + Math.round(total) + " seconds";
  }
  function setValue(next, source, commit) {
    var value = clamp(next);
    var x = tactileBandX(layout(measure()), value / total);
    scrubber.setAttribute("aria-valuenow", String(value));
    scrubber.setAttribute("aria-valuetext", valueText(value));
    if (progressRect) progressRect.setAttribute("width", x.toFixed(2));
    if (needle) needle.setAttribute("transform", "translate(" + x.toFixed(2) + " 0)");
    if (typeof d.onInput === "function") d.onInput(value, source);
    if (commit && typeof d.onChange === "function") d.onChange(value, source);
    return value;
  }
  function pointerUnits(event, rect) { return (event.clientX - rect.left) / rect.width * 1000; }
  function pointerValue(event) {
    var rect = measure();
    if (!rect) return Number(scrubber.getAttribute("aria-valuenow")) || 0;
    return tactileBandFraction(layout(rect), pointerUnits(event, rect)) * total;
  }
  function snappedPointerValue(event) {
    var rect = measure();
    if (!rect) return pointerValue(event);
    var boxes = layout(rect);
    var units = pointerUnits(event, rect);
    var best = null;
    var bestPx = Infinity;
    boundaries.forEach(function (boundary) {
      var px = Math.abs(tactileBandX(boxes, boundary / total) - units) / 1000 * rect.width;
      if (px < bestPx) { bestPx = px; best = boundary; }
    });
    return bestPx <= 12 ? best : tactileBandFraction(boxes, units) * total;
  }
  function pointerDown(event) {
    dragging = true;
    scrubber.setAttribute("data-scrubbing", "true");
    if (scrubber.setPointerCapture && event.pointerId !== undefined) scrubber.setPointerCapture(event.pointerId);
    setValue(pointerValue(event), "pointer", false);
    event.preventDefault();
  }
  function pointerMove(event) {
    if (!dragging) return;
    setValue(pointerValue(event), "pointer", false);
    event.preventDefault();
  }
  function pointerUp(event) {
    if (!dragging) return;
    dragging = false;
    scrubber.removeAttribute("data-scrubbing");
    if (scrubber.releasePointerCapture && event.pointerId !== undefined) scrubber.releasePointerCapture(event.pointerId);
    setValue(snappedPointerValue(event), "pointer", true);
  }
  function pointerCancel(event) {
    if (!dragging) return;
    dragging = false;
    scrubber.removeAttribute("data-scrubbing");
    if (scrubber.releasePointerCapture && event.pointerId !== undefined) scrubber.releasePointerCapture(event.pointerId);
  }
  function previousBoundary(value) {
    for (var i = boundaries.length - 1; i >= 0; i -= 1) if (boundaries[i] < value - 0.5) return boundaries[i];
    return 0;
  }
  function nextBoundary(value) {
    for (var i = 0; i < boundaries.length; i += 1) if (boundaries[i] > value + 0.5) return boundaries[i];
    return total;
  }
  function keyDown(event) {
    var value = Number(scrubber.getAttribute("aria-valuenow")) || 0;
    var next = null;
    if (event.key === "ArrowLeft") next = value - 15;
    else if (event.key === "ArrowRight") next = value + 30;
    else if (event.key === "ArrowDown") next = previousBoundary(value);
    else if (event.key === "ArrowUp") next = nextBoundary(value);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = total;
    if (next === null) return;
    event.preventDefault();
    setValue(next, "keyboard", true);
  }

  scrubber.addEventListener("pointerdown", pointerDown);
  scrubber.addEventListener("pointermove", pointerMove);
  scrubber.addEventListener("pointerup", pointerUp);
  scrubber.addEventListener("pointercancel", pointerCancel);
  scrubber.addEventListener("keydown", keyDown);
  return function () {
    scrubber.removeEventListener("pointerdown", pointerDown);
    scrubber.removeEventListener("pointermove", pointerMove);
    scrubber.removeEventListener("pointerup", pointerUp);
    scrubber.removeEventListener("pointercancel", pointerCancel);
    scrubber.removeEventListener("keydown", keyDown);
  };
}

function tactileGauge(data) {
  var d = data || {};
  return '<figure class="gauge" role="img" aria-label="' + esc(d.label || "About one in three picks is new ground") + '"><figcaption><span class="heading">' + esc(d.title || "New ground") + '</span><span class="readout">' + esc(d.readout || "1 in 3") + '</span></figcaption><div class="gauge__well" aria-hidden="true"><span class="gauge__fill"></span><span class="gauge__needle"></span></div><p>' + esc(d.copy || "About a third of today sits outside your usual subjects. 4a keeps it that way.") + "</p></figure>";
}

function tactileDisplayName(name) {
  return String(name || "Show").replace(/\s+(?:-|\||with|\()[\s\S]*$/i, "").trim();
}

function tactileEpisodeRow(data) {
  var d = data || {};
  return '<article class="row-episode' + (d.loading ? " is-loading" : "") + '"' + (d.loading ? ' aria-busy="true"' : "") + ">" +
    tactileArtFrame({ size: "row", title: d.title, url: d.artwork, initials: d.initials, loading: d.loading }) +
    '<div class="row__body"><h3 class="row__title">' + esc(d.title || "Episode title") + '</h3><div class="row__meta"><span class="row__show">' + esc(tactileDisplayName(d.show)) + '</span><span class="readout">' + esc(d.duration || "35 min") + '</span>' +
    (d.downloaded ? tactileTag({ kind: "downloaded", text: "Downloaded" }) : "") +
    '<button type="button" class="row__queue" aria-label="' + esc((d.queued ? "Queued: " : "Add to Up Next: ") + (d.title || "episode")) + '">' + tactileIcon(d.queued ? "ph-check" : "ph-plus", "sm") + '<span>' + esc(d.queued ? "Queued" : "Up Next") + "</span></button></div>" +
    (d.why ? '<p class="row__why">' + esc(d.why) + "</p>" : "") + "</div>" +
    '<div class="row__end">' + tactileKeycap({ size: "sm", variant: "persimmon", round: true, icon: "ph-play-fill", label: "Play " + (d.title || "episode") }) + "</div></article>";
}

function tactileShowRow(data) {
  var d = data || {};
  return '<article class="row-show">' + tactileArtFrame({ size: "mini", title: d.name, url: d.artwork, initials: d.initials }) + '<div class="row__body"><h3 class="row__title">' + esc(d.name || "Show") + '</h3><p class="row__meta">' + esc(d.meta || "12 episodes") + '</p></div>' + tactileChip({ text: d.following ? "Following" : "Follow", selected: d.following }) + "</article>";
}

function tactileQueueRow(data) {
  var d = data || {};
  return '<article class="row-queue' + (d.current ? " is-current" : "") + '"' + (d.current ? ' aria-current="true"' : "") + '><span class="row-queue__position readout">' + (d.current ? tactileIcon("needle", "sm") : esc(d.position || 1)) + '</span>' + tactileArtFrame({ size: "queue", title: d.title, url: d.artwork, initials: d.initials }) + '<div class="row__body"><h3 class="row__title">' + esc(d.title || "Queued episode") + '</h3><p class="row__meta">' + esc(d.current ? "Playing · " + (d.remaining || "42 min left") : tactileDisplayName(d.show) + " · " + (d.remaining || "42 min")) + '</p></div><button type="button" class="iconbtn" aria-label="' + esc("More actions for " + (d.title || "queued episode")) + '">' + tactileIcon("ph-dots-three") + "</button></article>";
}

function tactileBridgeCard(data) {
  var d = data || {};
  var title = d.title || "A stretch pick";
  return '<article class="card bridge" data-draw="true"><p class="bridge__sentence">' + esc(d.sentence || "Machining and language both reveal change through small repeated pressures.") + '</p><div class="bridge__arc">' + tactileArtFrame({ size: "queue", title: d.knownTitle, initials: d.knownInitials || "KN" }) + '<svg aria-hidden="true" viewBox="0 0 100 48" preserveAspectRatio="none"><path class="bridge__path" d="M2 30 C22 -6 78 -6 98 20"></path><circle cx="2" cy="30" r="3"></circle><circle cx="98" cy="20" r="3"></circle></svg>' + tactileArtFrame({ size: "row", title: title, initials: d.initials || "ST" }) + '</div><div class="bridge__meta"><div class="bridge__copy">' + tactileTag({ kind: "stretch", text: "Stretch" }) + '<strong class="bridge__title">' + esc(title) + '</strong><div class="bridge__details"><span class="bridge__show">' + esc(tactileDisplayName(d.show)) + '</span><span class="readout">' + esc(d.duration || "35 min") + '</span><button type="button" class="row__queue" aria-label="' + esc((d.queued ? "Queued: " : "Add to Up Next: ") + title) + '">' + tactileIcon(d.queued ? "ph-check" : "ph-plus", "sm") + '<span>' + esc(d.queued ? "Queued" : "Up Next") + '</span></button></div></div><div class="bridge__play">' + tactileKeycap({ size: "sm", variant: "persimmon", round: true, icon: "ph-play-fill", label: "Play " + title }) + "</div></div></article>";
}

function tactileTile(data) {
  var d = data || {};
  var size = ["s", "m", "l"].includes(d.size) ? d.size : "s";
  return '<button type="button" class="tile tile--' + esc(size) + (d.focus ? " is-focus" : "") + '"><span class="tile__art">' + tactileArtFrame({ size: size === "l" ? "hero" : "row", initials: d.initials || "FM", title: d.name }) + '</span><span><strong class="tile__name">' + esc(d.name || "Subject") + '</strong><span class="readout">' + esc(d.count || "14 shows") + "</span></span></button>";
}

/* The 3px progress line along the mini's top edge (BUILD-NOTES 3.12): the
 * foray's colours when `segments` is given, one persimmon bar for a single
 * episode otherwise. It is the line that stretches into the Now Playing scrub
 * band when the deck opens. Its drawn width at 375: the deck sits 16px in from
 * each side and the line 22px in from the deck's. */
var TACTILE_MINI_LINE_PX = 299;

function tactileMiniPlayer(data) {
  var d = data || {};
  var progressLine = tactileBand({ kind: "line", segments: d.segments, progress: d.progress, renderWidth: d.lineWidth || TACTILE_MINI_LINE_PX });
  return '<section class="mini" role="region" aria-label="' + esc("Now playing: " + (d.title || "Episode") + ", " + (d.show || "Show")) + '">' + progressLine + '<button type="button" class="mini__body" aria-label="Open Now Playing">' + tactileArtFrame({ size: "mini", title: d.title, initials: d.initials || "NP" }) + '<span class="mini__text"><strong>' + esc(d.title || "Episode title") + '</strong><span>' + esc(d.show || "Show") + "</span></span></button>" + tactileKeycap({ size: "md", variant: "persimmon", round: true, icon: d.playing ? "ph-pause-fill" : "ph-play-fill", label: d.playing ? "Pause" : "Play" }) + tactileKeycap({ size: "sm", variant: "paper", icon: "skip-30", label: "Forward 30 seconds" }) + "</section>";
}

function tactileTabBar(data) {
  var d = data || {};
  var active = ["today", "find", "yours"].includes(d.active) ? d.active : "today";
  var tabs = [
    { id: "today", label: "Today", icon: "ph-sun-horizon" },
    { id: "find", label: "Find", icon: "ph-magnifying-glass" },
    { id: "yours", label: "Yours", icon: "ph-bookmarks" },
  ];
  return '<nav class="deck' + (d.collapsed ? " deck--collapsed" : "") + '" aria-label="Primary">' + (d.mini ? tactileMiniPlayer(d.mini) + '<div class="deck__separator"></div>' : "") + '<div class="tabbar" role="tablist">' + tabs.map(function (tab) {
    var on = tab.id === active;
    return '<button type="button" class="tab" role="tab" aria-selected="' + (on ? "true" : "false") + '">' + tactileIcon(tab.icon + (on ? "-fill" : "")) + '<span class="tab__label">' + esc(tab.label) + "</span>" + (tab.id === "yours" && Number(d.count) > 0 ? '<span class="tab__count readout">' + esc(d.count) + "</span>" : "") + (on ? '<span class="tab__indicator"></span>' : "") + "</button>";
  }).join("") + "</div></nav>";
}

function tactileSheet(data) {
  var d = data || {};
  var id = String(d.id || "tactile-sheet").replace(/[^A-Za-z0-9_-]/g, "-");
  var dialog = d.preview ? ' role="group" aria-label="Sheet preview"' : ' role="dialog" aria-modal="true" aria-labelledby="' + esc(id) + '-title" tabindex="-1" hidden';
  return '<section class="sheet' + (d.preview ? " sheet--preview" : "") + '" id="' + esc(id) + '"' + dialog + '><div class="sheet__grabber" aria-hidden="true"></div><header><h2 class="heading" id="' + esc(id) + '-title">' + esc(d.title || "Sheet") + '</h2><button type="button" class="iconbtn sheet__close" id="' + esc(d.closeId || id + "-close") + '" aria-label="Close">' + tactileIcon("ph-x") + '</button></header><p>' + esc(d.copy || "Focus moves in, stays here, then returns to the opener.") + '</p><div class="sheet__actions">' + tactileKeycap({ size: "md", variant: "persimmon", text: d.primary || "Done", label: d.primary || "Done" }) + tactileTextButton({ text: d.secondary || "Not now" }) + "</div></section>";
}

function tactileWireSheet(opener, sheet) {
  if (!opener || !sheet) return function () {};
  var close = sheet.querySelector(".sheet__close");
  var siblings = Array.from(sheet.parentElement ? sheet.parentElement.children : []).filter(function (el) { return el !== sheet; });
  function focusables() { return Array.from(sheet.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])')); }
  function inside(el) { return el === sheet || Boolean(el && sheet.contains && sheet.contains(el)); }
  function containFocus(event) {
    if (sheet.hidden || inside(event.target)) return;
    var items = focusables();
    (items[0] || sheet).focus();
  }
  function shut() {
    sheet.hidden = true;
    if (document.removeEventListener) document.removeEventListener("focusin", containFocus);
    siblings.forEach(function (el) { el.removeAttribute("inert"); });
    opener.focus();
  }
  function open() {
    siblings.forEach(function (el) { el.setAttribute("inert", ""); });
    sheet.hidden = false;
    sheet.focus();
    if (document.addEventListener) document.addEventListener("focusin", containFocus);
  }
  function keys(event) {
    if (event.key === "Escape") { event.preventDefault(); shut(); return; }
    if (event.key !== "Tab") return;
    var items = focusables();
    if (!items.length) { event.preventDefault(); sheet.focus(); return; }
    var first = items[0];
    var last = items[items.length - 1];
    if (document.activeElement === sheet || !inside(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
    else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
  opener.addEventListener("click", open);
  if (close) close.addEventListener("click", shut);
  sheet.addEventListener("keydown", keys);
  return shut;
}

function tactileRotary(data) {
  var d = data || {};
  var values = Array.isArray(d.values) && d.values.length ? d.values : ["0.8×", "0.9×", "1.0×", "1.1×", "1.2×"];
  return '<div class="rotary" role="group" aria-label="' + esc(d.label || "Playback speed") + '">' + tactileKeycap({ size: "sm", variant: "paper", icon: "ph-arrow-down", label: "Less" }) + '<div class="well rotary__track" role="radiogroup">' + values.map(function (value) { var selected = value === (d.value || "1.0×"); return '<button type="button" class="rotary__tick" role="radio" aria-checked="' + (selected ? "true" : "false") + '"><span class="readout">' + esc(value) + "</span></button>"; }).join("") + "</div>" + tactileKeycap({ size: "sm", variant: "paper", icon: "ph-arrow-up", label: "More" }) + "</div>";
}

function tactileSkeleton(kind) {
  var type = ["hero", "row", "card"].includes(kind) ? kind : "row";
  if (type === "hero") return '<div class="skel skel--hero" aria-busy="true" aria-label="Loading"><span class="skel__shape skel__eyebrow"></span><div class="skel__title"><span class="skel__shape"></span><span class="skel__shape"></span><span class="skel__shape"></span></div><span class="skel__shape skel__band"></span><div class="skel__meta"><span class="skel__discs"><span class="skel__shape"></span><span class="skel__shape"></span><span class="skel__shape"></span></span><span class="skel__shape skel__readout"></span></div><div class="skel__why"><span class="skel__shape"></span><span class="skel__shape"></span></div><div class="skel__actions"><span class="skel__shape skel__primary"></span><span class="skel__shape skel__secondary"></span></div></div>';
  if (type === "card") return '<div class="skel skel--card" aria-busy="true" aria-label="Loading"><span class="skel__shape skel__card-art"></span><div class="skel__card-lines"><span class="skel__shape"></span><span class="skel__shape"></span></div></div>';
  return '<div class="skel skel--row" aria-busy="true" aria-label="Loading"><span class="skel__shape skel__row-art"></span><div class="skel__row-lines"><span class="skel__shape"></span><span class="skel__shape"></span><span class="skel__shape skel__row-meta"></span></div><span class="skel__shape skel__row-control"></span></div>';
}

function tactileEmpty(data) {
  var d = data || {};
  return '<section class="empty"><svg aria-hidden="true" viewBox="0 0 96 96"><rect x="18" y="26" width="60" height="46" rx="12"></rect><path d="M30 42h36M34 54h12M54 54h8"></path><circle cx="38" cy="66" r="3"></circle><circle cx="62" cy="66" r="3"></circle><path d="M34 26c2-9 26-9 28 0"></path></svg><p>' + esc(d.copy || "Nothing here yet. Follow a show and it lands here.") + "</p>" + tactileKeycap({ size: "md", variant: "persimmon", text: d.action || "Find a show", label: d.action || "Find a show" }) + "</section>";
}

/* A resting toast is invisible, so its Undo must be unreachable too: it renders
 * `inert` (no focus, no pointer, out of the accessibility tree) and the CSS
 * adds `visibility: hidden`. Screens show and hide it with tactileSetToast,
 * which moves the class and the inert flag together, never one without the other. */
function tactileToast(data) {
  var d = data || {};
  return '<div class="toast' + (d.show ? " is-visible" : "") + '" role="status"' + (d.show ? "" : " inert") + '><span>' + esc(d.text || "Removed from Up Next") + "</span>" + tactileTextButton({ text: d.action || "Undo" }) + "</div>";
}

function tactileSetToast(toast, visible) {
  if (!toast) return;
  toast.classList.toggle("is-visible", Boolean(visible));
  if (visible) toast.removeAttribute("inert");
  else toast.setAttribute("inert", "");
}
