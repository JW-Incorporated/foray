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

/* `extra` is an opt-in class (a screen's own hook, e.g. `i--swap`); it is escaped
 * like every other interpolation and defaults to nothing, so every existing
 * caller's markup is byte-identical. */
function tactileIcon(id, size, extra) {
  var cls = size === "sm" ? " i--sm" : size === "lg" ? " i--lg" : "";
  if (extra) cls += " " + esc(extra);
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
  var shape = (d.round ? " art-frame--round" : "") + (d.subject ? " art-frame--subject" : "");
  var state = d.loading ? " is-loading" : d.offline ? " is-offline" : "";
  var label = typeof d.alt === "string" ? d.alt : "";
  var px = TACTILE_ART_PX[size];
  var image = d.url
    ? '<img src="' + esc(safeUrl(artUrl(d.url, px * 3))) + '" alt="' + esc(label) + '" loading="lazy" decoding="async" width="' + px + '" height="' + px + '">'
    : d.plain ? "" : '<span class="art-frame__initials" aria-hidden="true">' + esc(d.initials || "4a") + "</span>";
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
  /* `iconOnly` is the round or row key that has no room for the sentence: it keeps the
   * cloud-slash and names itself ("Needs a connection: <what>") through `label`, and the
   * sentence is drawn once beside it by tactileNeedsLine. */
  var text = d.offline ? (d.iconOnly ? "" : (d.text || "Needs a connection")) : d.text;
  var iconSize = size === "xl" || size === "glance" ? "lg" : "";
  /* Opt-in hooks for a screen that wires the key to the app's own engines.
   * `data` becomes data-* attributes (names are checked, values escaped).
   * `swapIcon` draws a second icon, shown instead of the first while the
   * engine marks the key data-playing="1": the engine then never writes text
   * into the key (data-ctl-icons), so the play and pause glyphs stay sprite
   * icons and never fall back to a text character. */
  var hooks = "";
  if (d.data) {
    Object.keys(d.data).forEach(function (name) {
      if (/^[a-z][a-z0-9-]*$/.test(name) && d.data[name] != null) hooks += ' data-' + name + '="' + esc(d.data[name]) + '"';
    });
  }
  if (d.swapIcon) hooks += " data-ctl-icons";
  return '<button type="button" class="keycap ' + esc(cls) + '"' +
    (d.id ? ' id="' + esc(d.id) + '"' : "") +
    (d.action ? ' data-action="' + esc(d.action) + '"' : "") +
    hooks +
    (d.pressed ? ' data-pressed="true"' : "") +
    (d.loading ? ' aria-busy="true"' : "") +
    (disabled ? " disabled" : "") +
    ' aria-label="' + esc(d.label || text || "Action") + '">' +
    (icon ? tactileIcon(icon, iconSize) : "") +
    (icon && d.swapIcon ? tactileIcon(d.swapIcon, iconSize, "i--swap") : "") +
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
  /* The downloaded mark names itself in both forms: the check-circle alone while online
   * (`iconOnly`; the word is the aria-label), the word beside it while offline, where
   * "what is on this device" is the point of the screen. */
  if (kind === "downloaded" && d.iconOnly) return '<span class="tag tag--downloaded tag--icon" role="img" aria-label="Downloaded">' + tactileIcon(icons.downloaded, "sm") + "</span>";
  return '<span class="tag tag--' + esc(kind) + '"' + (kind === "downloaded" ? ' role="img" aria-label="Downloaded"' : "") + ">" + tactileIcon(icons[kind], "sm") + '<span>' + esc(d.text || kind) + "</span></span>";
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

/* The enamels a SHOW may take: the prototype's six (teal, persimmon, mustard,
   plum, moss, rose). Index 2 is ultramarine, which is what 4a itself authored
   (the narration ticks), and 6 is the sky blue that sits next to it in both
   schemes; a show in either would read as narration on a band that has no
   station codes to tell them apart. The token set still defines all eight. */
var TACTILE_SHOW_ENAMELS = [0, 1, 3, 4, 5, 7];

function tactileHash(value) {
  var text = String(value || "");
  var h = 2166136261;
  for (var i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return TACTILE_SHOW_ENAMELS[(h >>> 0) % TACTILE_SHOW_ENAMELS.length];
}

/* One enamel per show WITHIN a band that wants a key (Today's foray card). The hash above
 * is global and stable, so two shows in one foray can land on the same enamel (a seven-show
 * foray reused teal three times and the key could only tell them apart by their codes). This
 * keeps each show's own hash enamel when it is free and otherwise walks on to the next free
 * one, trying the six show enamels first and the two the narration and sky blues share only
 * once those are spent. Past eight shows an enamel repeats (there are only eight). `ids` is
 * the show ids in first-appearance order; returns { id: enamelIndex }. */
var TACTILE_KEY_ENAMELS = [0, 1, 3, 4, 5, 7, 6, 2];

function tactileDistinctEnamels(ids) {
  var out = {};
  var used = {};
  var taken = 0;
  (Array.isArray(ids) ? ids : []).forEach(function (id) {
    var key = String(id);
    if (Object.prototype.hasOwnProperty.call(out, key)) return;
    if (taken >= TACTILE_KEY_ENAMELS.length) { used = {}; taken = 0; }
    var start = TACTILE_KEY_ENAMELS.indexOf(tactileHash(key));
    for (var step = 0; step < TACTILE_KEY_ENAMELS.length; step += 1) {
      var candidate = TACTILE_KEY_ENAMELS[(start + step) % TACTILE_KEY_ENAMELS.length];
      if (!used[candidate]) { out[key] = candidate; used[candidate] = true; taken += 1; return; }
    }
  });
  return out;
}

function tactileStationCode(name) {
  var words = String(name || "Show").replace(/^The\s+/i, "").trim().split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : (words[0] || "SH").slice(0, 2)).toUpperCase();
}

/* ONE RESOLVER for every station code on screen (review 2026-10-07). The chip,
 * the swatches and the band each carried their own copy of the collision rule,
 * and the copies disagreed past two shows: Daily / Daring / Dashing read DA / DD /
 * DA in the model and DA / DD / DD in the band, so two stations shared a code and
 * colour was the only thing telling them apart. Both callers now ask here.
 *
 * `shows` is an array of { id, name } in first-appearance order; the answer is a
 * Map id -> two-letter code, and no two ids share a code. The ladder, each rung
 * taken only if the one before it is already used by an earlier show:
 *   1. the base code (first letters of the first two words, or the first two
 *      letters of a single word);
 *   2. the first word's first letter + the LAST word's first letter (the band's
 *      documented rule);
 *   3. the first word's first two letters;
 *   4. the first word's first letter + each later letter of the name, in order;
 *   5. the first word's first letter + A-Z, 0-9: a last resort that cannot run
 *      out for any real foray, so a key never names two shows. */
function tactileStationCodes(shows) {
  var codes = new Map();
  var taken = {};
  (Array.isArray(shows) ? shows : []).forEach(function (entry) {
    if (!entry || codes.has(entry.id)) return;
    var name = entry.name == null ? "Show" : entry.name;
    var words = String(name).replace(/^The\s+/i, "").trim().split(/\s+/).filter(Boolean);
    var first = words[0] || "SH";
    var last = words[words.length - 1] || first;
    var head = first[0];
    var candidates = [tactileStationCode(name), head + last[0], first.slice(0, 2)];
    words.join("").slice(1).split("").forEach(function (letter) { candidates.push(head + letter); });
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".split("").forEach(function (letter) { candidates.push(head + letter); });
    var pick = candidates.map(function (code) { return code.toUpperCase(); }).find(function (code) { return !taken[code]; });
    if (!pick) pick = candidates[0].toUpperCase();
    taken[pick] = true;
    codes.set(entry.id, pick);
  });
  return codes;
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

/* Which runs carry a station code (BUILD-NOTES 3.6: one code per run). A run of
 * at least 24px rendered always does. A narrower run still does when its two
 * letters fit under it without touching a neighbour's code, because colour must
 * never be the only thing that says which show a short run is (the first two
 * runs of a 7-show foray are 13 and 19px wide): runs are tried left to right
 * after the wide ones have claimed their room, two labels' centres stay at least
 * CODE_PX + CODE_GAP_PX apart, and a run narrower than MIN_RUN_PX (a bar too
 * thin to read as the thing the letters sit under) keeps only its aria-label. A
 * code may overhang the band's own edge by EDGE_PX: the well round the band has
 * 10px of padding, so the first run's code stays inside the well. */
var TACTILE_CODE_PX = 14;
var TACTILE_CODE_GAP_PX = 2;
var TACTILE_CODE_MIN_RUN_PX = 8;
var TACTILE_CODE_FULL_RUN_PX = 24;
var TACTILE_CODE_EDGE_PX = 8;

function tactileBandLabelRuns(runs, renderWidth) {
  var px = 1 / 1000 * renderWidth;
  var pitch = TACTILE_CODE_PX + TACTILE_CODE_GAP_PX;
  var placed = [];
  function fits(run) {
    var centre = (run.x + run.right) / 2 * px;
    if (centre - TACTILE_CODE_PX / 2 < -TACTILE_CODE_EDGE_PX || centre + TACTILE_CODE_PX / 2 > renderWidth + TACTILE_CODE_EDGE_PX) return false;
    return placed.every(function (other) { return Math.abs((other.x + other.right) / 2 * px - centre) >= pitch; });
  }
  [true, false].forEach(function (wide) {
    runs.forEach(function (run) {
      var widthPx = (run.right - run.x) * px;
      if (wide ? widthPx < TACTILE_CODE_FULL_RUN_PX : widthPx >= TACTILE_CODE_FULL_RUN_PX || widthPx < TACTILE_CODE_MIN_RUN_PX) return;
      if (wide || fits(run)) placed.push(run);
    });
  });
  return runs.filter(function (run) { return placed.indexOf(run) >= 0; });
}

function tactileBandSegments(input) {
  return (Array.isArray(input) ? input : []).map(function (segment, index) {
    var s = segment || {};
    return {
      showId: String(s.showId || (s.narration ? "narration" : "show-" + index)),
      show: String(s.show || (s.narration ? "4a narration" : "Show")),
      duration: Math.max(1, Number(s.duration) || 1),
      narration: Boolean(s.narration),
      enamel: Number.isInteger(s.enamel) && s.enamel >= 0 && s.enamel <= 7 ? s.enamel : -1,
    };
  });
}

/* Band geometry in the 0-1000 viewBox. Bars sit a gap apart, in order, and
 * the last one ends at 1000. The gap is 2px RENDERED (never the bare 2 units,
 * which is under a pixel at phone widths and let neighbouring bars of one
 * enamel run together into a single bar): 2000 / renderWidth units, and 1px
 * (the floor, BUILD-NOTES 3.6) only when 2px gaps would push a bar under its
 * minimum. Each bar gets its runtime share of the width the
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
  var mins = segments.map(function (segment) {
    return (segment.narration && kind !== "mini" && kind !== "line" ? 8 : 3) / width * 1000;
  });
  /* Narration in the tick kinds (mini, line) is a SHORT tick between station bars
     whatever its runtime: capped at 4px rendered, the surplus going to the stations,
     so a long narrated stretch never reads as a second wide bar (the stations-on-a-dial
     read). Only when a station bar exists to take the surplus; an all-narration band
     keeps proportional widths so the last bar still ends at 1000.
     MUTATION: make `maxs` all Infinity -> the long-narration test fails. */
  var tickKind = kind === "mini" || kind === "line";
  var hasStation = segments.some(function (segment) { return !segment.narration; });
  var maxs = segments.map(function (segment) {
    return tickKind && hasStation && segment.narration ? 4 / width * 1000 : Infinity;
  });
  var minSum = mins.reduce(function (sum, m) { return sum + m; }, 0);
  var gap = [Math.max(2, 2000 / width), Math.max(2, 1000 / width), 2].find(function (g, i, all) {
    return i === all.length - 1 || minSum + g * (n - 1) <= 1000;
  });
  var available = Math.max(0, 1000 - gap * (n - 1));
  var widths;
  if (minSum >= available) {
    widths = mins.map(function (m) { return m * available / minSum; });
  } else {
    var pinned = mins.map(function () { return false; });
    var pinW = mins.slice();
    var changed = true;
    while (changed) {
      var free = available;
      var freeTime = 0;
      segments.forEach(function (segment, i) { if (pinned[i]) free -= pinW[i]; else freeTime += segment.duration; });
      widths = segments.map(function (segment, i) { return pinned[i] ? pinW[i] : segment.duration / freeTime * free; });
      changed = false;
      widths.forEach(function (w, i) {
        if (pinned[i]) return;
        if (w < mins[i]) { pinned[i] = true; pinW[i] = mins[i]; changed = true; }
        else if (w > maxs[i]) { pinned[i] = true; pinW[i] = maxs[i]; changed = true; }
      });
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

/* The detail band renders 60px tall (`.band--detail`), so one viewBox unit is exactly
 * one pixel on y and 1000 / renderWidth units are one pixel on x. Everything the
 * eye reads as a shape rather than a stretch (the needle's 2px width and round
 * head, the station codes' glyphs) is drawn through that, never in bare units. */
var TACTILE_DETAIL_PX = 60;

function tactileBand(data) {
  var d = data || {};
  var kind = ["mini", "detail", "scrub", "line"].includes(d.kind) ? d.kind : "mini";
  var segments = tactileBandSegments(d.segments);
  /* The mini player's 3px line (BUILD-NOTES 3.12) carries the foray's colours,
     or one persimmon bar for a single episode, which has no segments. */
  /* A plain episode (Tactile Now Playing, episode) is one persimmon bar, never a
     station per show: no codes, no hatch, and a 1px --ink-3 tick at each chapter
     start when the feed publishes chapters (`chapters` is their fractions of the
     runtime, 0 < f < 1). Only the scrub and detail bands carry it; the mini and
     the line already draw a plain episode as one bar. */
  var plain = Boolean(d.episode) && (kind === "scrub" || kind === "detail");
  var episode = (kind === "line" && !segments.length) || plain;
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

  var codes = tactileStationCodes(segments.filter(function (segment) { return !segment.narration; })
    .map(function (segment) { return { id: segment.showId, name: segment.show }; }));
  /* The mini band's bars fill its 8px (the viewBox is 60 high, so 3.7px of bar in
     a 28-unit rect, half the prototype's 8px). The corner radius is 2 rendered px:
     the SVG stretches x and y separately, so it is stated per axis in viewBox
     units (a bare rx="2" is 0.65px wide and 2px tall, a squarish end). */
  var mini = kind === "mini";
  var barY = mini ? 0 : 8;
  var barH = mini ? 60 : 28;
  var stagePx = kind === "detail" ? TACTILE_DETAIL_PX : kind === "scrub" ? 56 : 8;
  /* A plain episode has no code row under the bar, so its stage is only the bar
     and an even 6px of well above and below it (the prototype's
     `.band--episode` stage: 44px, bar 32px at 6px). `stagePx` says how many
     rendered px the 60-unit viewBox is stretched over; the bar is then 6px in
     and 32px tall on any stage, centred. */
  if (plain && Number(d.stagePx) > 0) {
    stagePx = Number(d.stagePx);
    barY = +(60 * 6 / stagePx).toFixed(3);
    barH = +(60 * (stagePx - 12) / stagePx).toFixed(3);
  }
  var rx = 2000 / renderWidth;
  var ry = 2 * 60 / stagePx;
  var bars = widths.map(function (box, index) {
    var segment = segments[index];
    var cls = episode ? "t-band__bar t-band__bar--episode"
      : segment.narration ? "t-band__bar t-band__bar--narration" + (hatch ? "" : " t-band__bar--tick")
      : "t-band__bar t-band__bar--c" + (segment.enamel >= 0 ? segment.enamel : tactileHash(segment.showId));
    var shape = line ? '" y="0" width="' + box.width.toFixed(2) + '" height="60" rx="0"'
      : '" y="' + barY + '" width="' + box.width.toFixed(2) + '" height="' + barH + '" rx="' + rx.toFixed(2) + '" ry="' + ry.toFixed(2) + '"';
    return '<rect class="' + cls + '"' + (segment.narration && hatch ? ' fill="url(#' + esc(id) + '-hatch)"' : "") + ' data-segment-index="' + index + '" x="' + box.x.toFixed(2) + shape + "></rect>";
  }).join("");
  var labels = kind === "mini" || kind === "line" || plain ? "" : tactileBandLabelRuns(tactileBandRuns(segments, widths), renderWidth).map(function (run) {
    var isCurrent = current >= run.start && current <= run.end;
    var centre = ((run.x + run.right) / 2).toFixed(2);
    /* Detail codes are counter-scaled on x so a glyph is 13px wide and 13px tall, not
       the 0.3 of that the stretched viewBox would make it (preserveAspectRatio none). */
    var place = kind === "detail"
      ? ' x="0" y="0" transform="translate(' + centre + " 53) scale(" + (1000 / renderWidth).toFixed(4) + ' 1)"'
      : ' x="' + centre + '" y="53"';
    return '<text class="t-band__code' + (isCurrent ? " is-current" : "") + '" data-run-start="' + run.start + '" data-run-end="' + run.end + '"' + place + ' text-anchor="middle">' + esc(codes.get(run.showId)) + "</text>";
  }).join("");
  var ticks = !plain ? "" : '<g class="t-band__ticks" aria-hidden="true">' + (Array.isArray(d.chapters) ? d.chapters : [])
    .map(Number).filter(function (f) { return f > 0 && f < 1; })
    .map(function (f) {
      var x = (f * 1000).toFixed(2);
      return '<line class="t-band__tick" x1="' + x + '" x2="' + x + '" y1="' + barY + '" y2="' + (barY + barH) + '" vector-effect="non-scaling-stroke"></line>';
    }).join("") + "</g>";
  var role = kind === "scrub" ? "slider" : "img";
  var valueText = d.valueText || Math.round(progress * (Number(d.totalSeconds) || total)) + " seconds of " + Math.round(Number(d.totalSeconds) || total) + " seconds, " + (segments[current] ? segments[current].show : "4a");
  /* The line is decoration on the mini player, whose region label names what
     is playing; it is hidden from assistive tech, as in the prototype. */
  var aria = line ? ' aria-hidden="true" focusable="false"' : role === "slider"
    ? ' tabindex="0" aria-valuemin="0" aria-valuemax="' + Math.round(Number(d.totalSeconds) || total) + '" aria-valuenow="' + Math.round(progress * (Number(d.totalSeconds) || total)) + '" aria-valuetext="' + esc(valueText) + '"'
    : ' aria-label="' + esc(d.label || (plain ? "Episode progress" : "Foray band with " + codes.size + " stations")) + '"';
  return '<svg class="band band--' + esc(kind) + (d.buffering ? " band--buffering" : "") + '"' + (line ? "" : ' data-draw="true" role="' + role + '"') + aria + ' viewBox="0 0 1000 60" preserveAspectRatio="none">' +
    '<defs><pattern id="' + esc(id) + '-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="scale(' + (1000 / renderWidth).toFixed(4) + " " + (60 / stagePx).toFixed(4) + ') rotate(45)"><rect width="6" height="6" class="t-band__hatch-bg"></rect><rect width="3" height="6" class="t-band__hatch"></rect></pattern>' +
    '<clipPath id="' + esc(id) + '-progress"><rect class="band__progress" x="0" y="0" width="' + progressX.toFixed(2) + '" height="60"></rect></clipPath></defs>' +
    '<g class="' + (line ? "band__layers" : "band__draw") + '"><g class="t-band__base">' + bars + '</g><g class="t-band__fill" clip-path="url(#' + esc(id) + '-progress)">' + bars + "</g>" + ticks + labels +
    (line || (mini && !progress) ? "" : mini
      ? '<g class="needle" transform="translate(' + progressX.toFixed(2) + ' 0)"><rect x="' + (-1000 / renderWidth).toFixed(2) + '" y="-30" width="' + (2000 / renderWidth).toFixed(2) + '" height="120" rx="0"></rect></g>'
      : kind === "detail"
        /* 2px wide, 6px past the bars at both ends, a round 8px head on top (BUILD-NOTES 3.6),
           in rendered pixels: x units are 1000 / renderWidth to the pixel. */
        ? '<g class="needle" transform="translate(' + progressX.toFixed(2) + ' 0)"><rect x="' + (-1000 / renderWidth).toFixed(2) + '" y="2" width="' + (2000 / renderWidth).toFixed(2) + '" height="40" rx="' + (1000 / renderWidth).toFixed(2) + '" ry="1"></rect><ellipse cx="0" cy="3" rx="' + (4000 / renderWidth).toFixed(2) + '" ry="4"></ellipse></g>'
        : '<g class="needle" transform="translate(' + progressX.toFixed(2) + ' 0)"><rect x="-1" y="3" width="2" height="39" rx="1"></rect><circle cx="0" cy="3" r="4"></circle></g>') + "</g></svg>";
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
  var shown = String(name || "Show").replace(/\s+(?:-|\||with|\()[\s\S]*$/i, "").trim();
  /* The generic noun is not the name (BUILD-NOTES 3.9: "The Partially Examined
   * Life" is "The Partially Examined Life Philosophy Podcast" on a meta line, and
   * the prototype's shortShow strips it the same way). Kept when nothing real
   * would be left: "The Podcast" stays "The Podcast". */
  var bare = shown.replace(/\s+(?:Philosophy\s+)?Podcast$/i, "").trim();
  return bare.length >= 4 && !/^(?:the|a|an)$/i.test(bare) ? bare : shown;
}

/* THE ENGINE HOOKS (opt-in, Today and later screens). A row or bridge handed an
 * `id` is wired to the app's own engines instead of being a specimen:
 *   - the Play key carries data-play / data-title / data-ctx, which app.js's
 *     bindPlay and the player's syncCardButtons already drive, and a second
 *     (pause) icon that CSS shows while the engine marks it data-playing="1";
 *   - "+ Up Next" carries data-upnext, which bindUpNext drives, and draws its
 *     three states (off, just queued, queued) as sibling spans the `on` and
 *     `is-fresh` classes choose between, so the engines never write a text
 *     glyph into it (data-ctl-icons);
 *   - the title is a link when `link` names a route kind ("episode"). The `#/`
 *     is literal here and only the encoded id is interpolated.
 * Without an `id` every one of these is the gallery specimen it always was. */
function tactilePlayKey(d, title) {
  var live = Boolean(d.id) && d.playable !== false;
  if (d.id && !live) return "";
  /* OFFLINE (BUILD-NOTES 3.1): a pick that is not on this device takes the blocked
   * key: paper-2 fill, line lip, ink-3 cloud-slash, disabled, no engine hooks (a
   * press can start nothing), named for what it would have played. */
  if (d.blocked) return tactileKeycap({ size: "sm", variant: "paper", offline: true, iconOnly: true, label: "Needs a connection: " + title });
  return tactileKeycap({
    /* The prototype's row key is the 44px rounded key (a 48x44 plate), not a
       round one: `round` makes a 48x44 key an oval. */
    size: "sm", variant: "persimmon", icon: "ph-play-fill", label: "Play " + title,
    data: live ? { play: d.id, title: title, ctx: d.ctx } : null,
    swapIcon: live ? "ph-pause-fill" : null,
  });
}

function tactileQueueAction(d, title) {
  var name = (d.queued ? "Queued: " : "Add to Up Next: ") + title;
  if (!d.id) {
    return '<button type="button" class="row__queue" aria-label="' + esc(name) + '">' + tactileIcon(d.queued ? "ph-check" : "ph-plus", "sm") + '<span>' + esc(d.queued ? "Queued" : "Up Next") + "</span></button>";
  }
  if (d.queueable === false) return "";
  return `<button type="button" class="row__queue${d.queued ? " on" : ""}" data-upnext="${esc(d.id)}" data-ctl-icons aria-label="${esc(d.queued ? "In Up Next" : "Add to Up Next: " + title)}">` +
    tactileIcon("ph-plus", "sm") + tactileIcon("ph-check", "sm", "i--swap") +
    '<span class="row__queue-off">Up Next</span><span class="row__queue-fresh">Queued</span><span class="row__queue-on">In Up Next</span></button>';
}

/* The sentence the blocked keys share, drawn once under the row or card they sit on. */
function tactileNeedsLine() {
  return '<p class="needs">' + tactileIcon("ph-cloud-slash") + "<span>Needs a connection</span></p>";
}

/* The downloaded mark on a row's meta line: absent when the episode is not on the
 * device; the check-circle alone for `downloadedMark: "icon"` (online), the word beside
 * it otherwise. A caller that only says `downloaded: true` (the gallery) gets the word,
 * as it always has. */
function tactileDownloadedMark(d) {
  if (!d.downloaded) return "";
  return tactileTag({ kind: "downloaded", text: "Downloaded", iconOnly: d.downloadedMark === "icon" });
}

/* A length the caller does not know is "" and draws nothing; only an ABSENT
 * length falls back to the specimen's 35 min (a gallery call). A real episode
 * with no duration_min must never read as 35 minutes. */
function tactileReadout(value) {
  var text = value == null ? "35 min" : value;
  return text === "" ? "" : '<span class="readout">' + esc(text) + "</span>";
}

/* The subject an episode was dealt for (Home's slots), as data-branch: what the
 * first-run picks tests and any later "which subject is this" reader look for. */
function tactileBranchAttr(d) {
  return d.branch ? ' data-branch="' + esc(d.branch) + '"' : "";
}

function tactileTitleLink(d, text) {
  if (!d.id || d.link !== "episode") return esc(text);
  /* A template literal, the one form the "scheme fixed in code" scan accepts: the
     `#/` is literal and only the encoded id is interpolated. */
  return `<a class="row__link" href="${esc(safeUrl("#/episode/" + encodeURIComponent(d.id)))}">${esc(text)}</a>`;
}

function tactileEpisodeRow(data) {
  var d = data || {};
  var title = d.title || "Episode title";
  return '<article class="row-episode' + (d.loading ? " is-loading" : "") + '"' + tactileBranchAttr(d) + (d.loading ? ' aria-busy="true"' : "") + ">" +
    tactileArtFrame({ size: "row", title: d.title, url: d.artwork, initials: d.initials, loading: d.loading }) +
    '<div class="row__body"><h3 class="row__title">' + tactileTitleLink(d, title) + '</h3><div class="row__meta"><span class="row__show">' + esc(tactileDisplayName(d.show)) + '</span><span class="row__facts">' + tactileReadout(d.duration) +
    tactileDownloadedMark(d) +
    tactileQueueAction(d, d.title || "episode") + "</span></div>" + (d.blocked ? tactileNeedsLine() : "") + "</div>" +
    '<div class="row__end">' + (d.id ? tactilePlayKey(d, d.title || "episode") : tactileKeycap({ size: "sm", variant: "persimmon", round: true, icon: "ph-play-fill", label: "Play " + (d.title || "episode") })) + "</div>" +
    /* The why-line is the grid's own third row, spanning the text column and the
       key's (`grid-column: 2 / -1`), as in the prototype; inside the body it wrapped at
       the title's narrower width and cost a line. */
    (d.why ? '<p class="row__why">' + esc(d.why) + "</p>" : "") + "</article>";
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
  return '<article class="card bridge" data-draw="true"' + tactileBranchAttr(d) + '><p class="bridge__sentence">' + esc(d.sentence || "Machining and language both reveal change through small repeated pressures.") + '</p><div class="bridge__arc">' + tactileArtFrame({ size: "queue", title: d.knownTitle, url: d.knownArtwork, initials: d.knownInitials || "KN", subject: Boolean(d.knownSubject) }) + '<span class="bridge__line"><svg aria-hidden="true" viewBox="0 0 100 48" preserveAspectRatio="none"><path class="bridge__path" pathLength="1" d="M2 30 C22 -6 78 -6 98 20"></path></svg><i class="bridge__dot bridge__dot--a"></i><i class="bridge__dot bridge__dot--b"></i></span>' + tactileArtFrame({ size: "row", title: title, url: d.artwork, initials: d.initials || "ST" }) + '</div><div class="bridge__meta"><div class="bridge__copy">' + tactileTag({ kind: "stretch", text: "Stretch" }) + '<strong class="bridge__title">' + tactileTitleLink(d, title) + '</strong><div class="bridge__details"><span class="bridge__show">' + esc(tactileDisplayName(d.show)) + '</span><span class="row__facts">' + tactileReadout(d.duration) + tactileQueueAction(d, title) + '</span></div></div><div class="bridge__play">' + (d.id ? tactilePlayKey(d, title) : tactileKeycap({ size: "sm", variant: "persimmon", round: true, icon: "ph-play-fill", label: "Play " + title })) + "</div></div></article>";
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

/** A placeholder shaped like what is coming. `opts.decorative` is for a page that
    wraps its skeletons in ONE busy region (the Today boot paint): each block is
    then `aria-hidden` instead of announcing "Loading" once per block. `opts.why`
    adds the row's two why-line bars (the loaded Today row carries a why-line, so
    its skeleton has to be as tall); the gallery's bare row leaves it off. `bridge`
    is the Stretch slot (a sentence, the arc between two artworks, the pick): the
    loaded page always reserves it, so the boot paint does too. */
function tactileSkeleton(kind, opts) {
  var type = ["hero", "row", "card", "bridge"].includes(kind) ? kind : "row";
  var a = opts && opts.decorative ? 'aria-hidden="true"' : 'aria-busy="true" aria-label="Loading"';
  if (type === "hero") return '<div class="skel skel--hero" ' + a + '><span class="skel__shape skel__eyebrow"></span><div class="skel__title"><span class="skel__shape"></span><span class="skel__shape"></span><span class="skel__shape"></span></div><span class="skel__shape skel__band"></span><div class="skel__meta"><span class="skel__discs"><span class="skel__shape"></span><span class="skel__shape"></span><span class="skel__shape"></span></span><span class="skel__shape skel__readout"></span></div><div class="skel__why"><span class="skel__shape"></span><span class="skel__shape"></span></div><div class="skel__actions"><span class="skel__shape skel__primary"></span><span class="skel__shape skel__secondary"></span></div></div>';
  if (type === "bridge") return '<div class="skel skel--bridge" ' + a + '><div class="skel__why skel__bridge-sentence"><span class="skel__shape"></span><span class="skel__shape"></span></div><div class="skel__bridge-arc"><span class="skel__shape skel__bridge-known"></span><span class="skel__shape skel__bridge-line"></span><span class="skel__shape skel__bridge-stretch"></span></div><div class="skel__bridge-pick"><div class="skel__bridge-lines"><span class="skel__shape skel__bridge-tag"></span><span class="skel__shape"></span><span class="skel__shape"></span><span class="skel__shape skel__row-meta"></span></div><span class="skel__shape skel__row-control"></span></div></div>';
  if (type === "card") return '<div class="skel skel--card" ' + a + '><span class="skel__shape skel__card-art"></span><div class="skel__card-lines"><span class="skel__shape"></span><span class="skel__shape"></span></div></div>';
  return '<div class="skel skel--row" ' + a + '><span class="skel__shape skel__row-art"></span><div class="skel__row-lines"><span class="skel__shape"></span><span class="skel__shape"></span><span class="skel__shape skel__row-meta"></span></div><span class="skel__shape skel__row-control"></span>' + (opts && opts.why ? '<div class="skel__why skel__row-why"><span class="skel__shape"></span><span class="skel__shape"></span></div>' : "") + '</div>';
}

/* The one drawn mark in the app (BUILD-NOTES 3.16): a 96px small radio, 2px --ink-2
 * stroke, the prototype's own drawing. `href` makes the keycap a link (an <a> styled
 * as the persimmon key, the way Today's Details key is) for an empty state whose
 * way out is a route; without it the key is the gallery specimen's button. Both
 * routes pass safeUrl(). */
function tactileEmpty(data) {
  var d = data || {};
  var label = d.action || "Find a show";
  var key = d.href
    ? '<a class="keycap keycap--md keycap--persimmon" href="' + esc(safeUrl(d.href)) + '"><span class="keycap__label">' + esc(label) + "</span></a>"
    : tactileKeycap({ size: "md", variant: "persimmon", text: label, label: label });
  return '<section class="empty"><svg aria-hidden="true" focusable="false" viewBox="0 0 96 96"><rect x="12" y="30" width="72" height="48" rx="10"></rect><circle cx="34" cy="54" r="12"></circle><circle cx="34" cy="54" r="3"></circle><path d="M52 44h20M52 54h20M52 64h12"></path><path d="M28 30 62 12"></path></svg><p class="empty__copy">' + esc(d.copy || "Nothing here yet. Follow a show and it lands here.") + "</p>" + key + "</section>";
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
