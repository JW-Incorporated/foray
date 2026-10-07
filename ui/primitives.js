/* ui/primitives.js — Dial (Tactile) foundation primitives.
 *
 * Real app renderers, intentionally unused by listener screens until their
 * Phase 4 adoption branches. The guarded component gallery is the only caller
 * in Phase 3. Every caller-supplied string is escaped here; artwork is the one
 * URL-bearing primitive and always passes through safeUrl().
 */

var TACTILE_ICON_IDS = new Set([
  "ph-play", "ph-pause", "ph-sun-horizon", "ph-magnifying-glass", "ph-bookmarks",
  "ph-caret-down", "ph-arrow-left", "ph-dots-three", "ph-plus", "ph-check",
  "ph-check-circle", "ph-cloud-slash", "ph-bookmark-simple", "ph-list-plus",
  "ph-timer", "ph-share-network", "ph-x", "ph-arrow-up", "ph-arrow-down",
  "ph-trash", "ph-radio", "ph-speaker-high", "ph-moon", "ph-sun",
  "ph-list-bullets", "ph-shuffle", "ph-sparkle", "ph-play-fill", "ph-pause-fill",
  "ph-sun-horizon-fill", "ph-magnifying-glass-fill", "ph-bookmarks-fill",
  "ph-bookmark-simple-fill", "ph-check-circle-fill", "skip-15", "skip-30",
  "band", "needle", "bridge", "narration", "knob",
]);

function tactileIcon(id, size) {
  var name = TACTILE_ICON_IDS.has(id) ? id : "ph-radio";
  var cls = size === "sm" ? " i--sm" : size === "lg" ? " i--lg" : "";
  return '<svg class="i' + cls + '" aria-hidden="true" focusable="false"><use href="#' + esc(name) + '"></use></svg>';
}

function tactileArtFrame(data) {
  var d = data || {};
  var size = ["row", "queue", "mini", "disc", "hero"].includes(d.size) ? d.size : "row";
  var shape = d.round ? " art-frame--round" : "";
  var state = d.loading ? " is-loading" : d.offline ? " is-offline" : "";
  var label = d.alt || d.title || "Podcast artwork";
  var image = d.url
    ? '<img src="' + esc(safeUrl(d.url)) + '" alt="' + esc(label) + '">'
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

function tactileBand(data) {
  var d = data || {};
  var kind = ["mini", "detail", "scrub", "line"].includes(d.kind) ? d.kind : "mini";
  var input = Array.isArray(d.segments) ? d.segments : [];
  var segments = input.map(function (segment, index) {
    return {
      showId: String(segment.showId || (segment.narration ? "narration" : "show-" + index)),
      show: String(segment.show || (segment.narration ? "4a narration" : "Show")),
      duration: Math.max(1, Number(segment.duration) || 1),
      narration: Boolean(segment.narration),
    };
  });
  var total = segments.reduce(function (sum, segment) { return sum + segment.duration; }, 0) || 1;
  var renderWidth = Math.max(1, Number(d.renderWidth) || 345);
  var gap = 2;
  var cursor = 0;
  var widths = segments.map(function (segment) {
    var raw = segment.duration / total * 1000;
    var minPx = segment.narration && kind !== "mini" && kind !== "line" ? 8 : 3;
    var width = Math.max(minPx / renderWidth * 1000, raw - gap);
    var out = { x: cursor, width: Math.min(width, Math.max(0, 1000 - cursor)) };
    cursor += raw;
    return out;
  });
  var id = String(d.id || "dial-band").replace(/[^A-Za-z0-9_-]/g, "-");
  var progress = Math.max(0, Math.min(1, Number(d.progress) || 0));
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
  var bars = widths.map(function (box, index) {
    var segment = segments[index];
    var cls = segment.narration ? "t-band__bar t-band__bar--narration" : "t-band__bar t-band__bar--c" + tactileHash(segment.showId);
    return '<rect class="' + cls + '"' + (segment.narration ? ' fill="url(#' + esc(id) + '-hatch)"' : "") + ' data-segment-index="' + index + '" x="' + box.x.toFixed(2) + '" y="8" width="' + box.width.toFixed(2) + '" height="28" rx="2"></rect>';
  }).join("");
  var labels = kind === "mini" || kind === "line" ? "" : tactileBandRuns(segments, widths).map(function (run) {
    var widthPx = (run.right - run.x) / 1000 * renderWidth;
    if (widthPx < 24) return "";
    var isCurrent = current >= run.start && current <= run.end;
    return '<text class="t-band__code' + (isCurrent ? " is-current" : "") + '" data-run-start="' + run.start + '" data-run-end="' + run.end + '" x="' + ((run.x + run.right) / 2).toFixed(2) + '" y="53" text-anchor="middle">' + esc(codes.get(run.showId)) + "</text>";
  }).join("");
  var role = kind === "scrub" ? "slider" : "img";
  var valueText = d.valueText || Math.round(progress * (Number(d.totalSeconds) || total)) + " seconds of " + Math.round(Number(d.totalSeconds) || total) + " seconds, " + (segments[current] ? segments[current].show : "4a");
  var aria = role === "slider"
    ? ' tabindex="0" aria-valuemin="0" aria-valuemax="' + Math.round(Number(d.totalSeconds) || total) + '" aria-valuenow="' + Math.round(progress * (Number(d.totalSeconds) || total)) + '" aria-valuetext="' + esc(valueText) + '"'
    : ' aria-label="' + esc(d.label || "Foray band with " + codes.size + " stations") + '"';
  return '<svg class="band band--' + esc(kind) + (d.buffering ? " band--buffering" : "") + '" data-draw="true" role="' + role + '"' + aria + ' viewBox="0 0 1000 60" preserveAspectRatio="none">' +
    '<defs><pattern id="' + esc(id) + '-hatch" width="12" height="12" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="12" class="t-band__hatch"></rect></pattern>' +
    '<clipPath id="' + esc(id) + '-progress"><rect x="0" y="0" width="' + (progress * 1000).toFixed(2) + '" height="60"></rect></clipPath></defs>' +
    '<g class="band__draw"><g class="t-band__base">' + bars + '</g><g class="t-band__fill" clip-path="url(#' + esc(id) + '-progress)">' + bars + "</g>" + labels +
    '<g class="needle" transform="translate(' + (progress * 1000).toFixed(2) + ' 0)"><rect x="-1" y="3" width="2" height="39" rx="1"></rect><circle cx="0" cy="3" r="4"></circle></g></g></svg>';
}

function tactileGauge(data) {
  var d = data || {};
  return '<figure class="gauge" role="img" aria-label="' + esc(d.label || "About one in three picks is new ground") + '"><figcaption><span class="heading">' + esc(d.title || "New ground") + '</span><span class="readout">' + esc(d.readout || "1 in 3") + '</span></figcaption><div class="gauge__well" aria-hidden="true"><span class="gauge__fill"></span><span class="gauge__needle"></span></div><p>' + esc(d.copy || "About a third of today’s episodes sit outside your usual subjects. 4a keeps it that way.") + "</p></figure>";
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
  return '<article class="card bridge" data-draw="true"><p class="bridge__sentence">' + esc(d.sentence || "Machining and language both reveal change through small repeated pressures.") + '</p><div class="bridge__arc">' + tactileArtFrame({ size: "queue", title: d.knownTitle, initials: d.knownInitials || "KN" }) + '<svg aria-hidden="true" viewBox="0 0 100 48" preserveAspectRatio="none"><path class="bridge__path" d="M2 30 C22 -6 78 -6 98 20"></path><circle cx="2" cy="30" r="3"></circle><circle cx="98" cy="20" r="3"></circle></svg>' + tactileArtFrame({ size: "row", title: d.title, initials: d.initials || "ST" }) + '</div><div class="bridge__meta">' + tactileTag({ kind: "stretch", text: "Stretch" }) + '<strong>' + esc(d.title || "A stretch pick") + "</strong></div></article>";
}

function tactileTile(data) {
  var d = data || {};
  var size = ["s", "m", "l"].includes(d.size) ? d.size : "s";
  return '<button type="button" class="tile tile--' + esc(size) + (d.focus ? " is-focus" : "") + '"><span class="tile__art">' + tactileArtFrame({ size: size === "l" ? "hero" : "row", initials: d.initials || "FM", title: d.name }) + '</span><span><strong class="tile__name">' + esc(d.name || "Subject") + '</strong><span class="readout">' + esc(d.count || "14 shows") + "</span></span></button>";
}

function tactileMiniPlayer(data) {
  var d = data || {};
  return '<section class="mini" role="region" aria-label="' + esc("Now playing: " + (d.title || "Episode") + ", " + (d.show || "Show")) + '"><button type="button" class="mini__body" aria-label="Open Now Playing">' + tactileArtFrame({ size: "mini", title: d.title, initials: d.initials || "NP" }) + '<span class="mini__text"><strong>' + esc(d.title || "Episode title") + '</strong><span>' + esc(d.show || "Show") + "</span></span></button>" + tactileKeycap({ size: "md", variant: "persimmon", round: true, icon: d.playing ? "ph-pause-fill" : "ph-play-fill", label: d.playing ? "Pause" : "Play" }) + tactileKeycap({ size: "sm", variant: "paper", icon: "skip-30", label: "Forward 30 seconds" }) + "</section>";
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
  function shut() {
    sheet.hidden = true;
    siblings.forEach(function (el) { el.removeAttribute("inert"); });
    opener.focus();
  }
  function open() {
    siblings.forEach(function (el) { el.setAttribute("inert", ""); });
    sheet.hidden = false;
    sheet.focus();
  }
  function keys(event) {
    if (event.key === "Escape") { event.preventDefault(); shut(); return; }
    if (event.key !== "Tab") return;
    var items = focusables();
    if (!items.length) { event.preventDefault(); sheet.focus(); return; }
    var first = items[0];
    var last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
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
  return '<div class="skel skel--' + esc(type) + '" aria-busy="true" aria-label="Loading"><span></span><span></span><span></span><span></span><span></span></div>';
}

function tactileEmpty(data) {
  var d = data || {};
  return '<section class="empty"><svg aria-hidden="true" viewBox="0 0 96 96"><rect x="18" y="26" width="60" height="46" rx="12"></rect><path d="M30 42h36M34 54h12M54 54h8"></path><circle cx="38" cy="66" r="3"></circle><circle cx="62" cy="66" r="3"></circle><path d="M34 26c2-9 26-9 28 0"></path></svg><p>' + esc(d.copy || "Nothing here yet. Follow a show and it lands here.") + "</p>" + tactileKeycap({ size: "md", variant: "persimmon", text: d.action || "Find a show", label: d.action || "Find a show" }) + "</section>";
}

function tactileToast(data) {
  var d = data || {};
  return '<div class="toast' + (d.show ? " is-visible" : "") + '" role="status"><span>' + esc(d.text || "Removed from Up Next") + "</span>" + tactileTextButton({ text: d.action || "Undo" }) + "</div>";
}
