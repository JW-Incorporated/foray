/* Afterglow Now Playing. This screen file owns the redesign markup while
   player/client.js keeps ownership of playback, clocks, focus and gestures.
   Dynamic listener/publisher text is assigned with textContent; artwork URLs
   cross safeUrl() before either an img.src or CSSOM --room-art write. */

function agNpEl(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.append(document.createTextNode(String(text)));
  return node;
}

const AG_NP_ICONS = new Set(["back15", "bookmark", "chevron-down", "dots", "fwd30", "gauge", "moon", "pause", "play", "share"]);

function agNpIconNode(name, size = 24) {
  const icon = AG_NP_ICONS.has(name) ? name : "play";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  svg.setAttribute("class", size === 24 ? "icon" : `icon icon-${size}`);
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  use.setAttribute("href", safeUrl(`ui/icons.svg#i-${icon}`));
  svg.append(use);
  return svg;
}

function agNpSetIcon(button, name, size = 24) {
  if (!button) return;
  button.replaceChildren(agNpIconNode(name, size));
  button.dataset.agGlyph = name;
}

function agNpIconButton(label, icon, cls = "ag-np-icon-btn") {
  const button = agNpEl("button", cls);
  button.type = "button";
  button.setAttribute("aria-label", label);
  agNpSetIcon(button, icon, icon === "play" || icon === "pause" ? 36 : 24);
  return button;
}

function agNpSafeArt(node, src) {
  const url = safeUrl(src || "");
  if (!url || url === "#") {
    node.hidden = true;
    node.removeAttribute("src");
    return "";
  }
  node.src = url;
  node.hidden = false;
  return url;
}

/* Artwork for a row or tile: the image when the item has a URL that passes safeUrl(), otherwise a square in the
   show's own colour (the one its strip bar wears), so a missing sleeve never leaves a hole. */
function agNpArtNode(cls, item, name) {
  const src = safeUrl(agNpArt(item) || "");
  if (src && src !== "#") {
    const img = agNpEl("img", cls);
    img.alt = "";
    img.src = src;
    return img;
  }
  const tile = agNpEl("span", `${cls} ag-np-art-fallback`);
  tile.style.setProperty("--c", agNpColour(name));
  return tile;
}

function agNpHash(value) {
  let hash = 2166136261;
  for (const ch of String(value || "4a")) {
    hash ^= ch.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/* One colour per show, so a show's bar, its Room and its source tile always agree (the hash hue is the fallback the direction names when no palette is precomputed). */
function agNpColour(value) {
  const hue = agNpHash(value) % 360;
  return `oklch(0.66 0.14 ${hue})`;
}

function agNpCssUrl(src) {
  const url = safeUrl(src || "");
  return !url || url === "#" ? "none" : `url(${JSON.stringify(url)})`;
}

function agNpClock(seconds) {
  const n = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = n % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

function agNpShow(item) {
  return item?.show || item?.show_title || (item?.kind === "tts" ? "4a narration" : "Unknown show");
}

function agNpArt(item) {
  return item?.artwork_url || item?.artworkUrl || item?.image || "";
}

function agNpAdopt(ui) {
  if (!ui?.sheet || ui.sheet.dataset.afterglow === "1") return ui;
  ui.root.classList.add("ag-player");
  ui.sheet.classList.add("room", "ag-np");
  ui.sheet.dataset.theme = "dusk";
  ui.sheet.dataset.afterglow = "1";

  const roomLayers = agNpEl("div", "ag-np-room-layers");
  const roomA = agNpEl("div", "ag-np-room-layer is-on");
  const roomB = agNpEl("div", "ag-np-room-layer");
  roomLayers.append(roomA, roomB);

  ui.grabZone.classList.add("ag-np-head");
  const grabber = ui.grabZone.querySelector(".fy-grab");
  agNpSetIcon(ui.closeBtn, "chevron-down", 24);
  ui.closeBtn.classList.add("ag-np-icon-btn");
  const moreMenuBtn = agNpIconButton("More player options", "dots");
  ui.grabZone.replaceChildren(ui.closeBtn, grabber, moreMenuBtn);

  const first = agNpEl("section", "ag-np-first");
  const mid = agNpEl("div", "ag-np-mid");
  const artWrap = agNpEl("div", "ag-np-art-wrap");
  const artSwap = agNpEl("div", "ag-np-art-swap");
  ui.sArt.classList.add("lit-art", "lit-96", "ag-np-art-current");
  artSwap.append(ui.sArt);
  artWrap.append(artSwap);

  const titles = agNpEl("div", "ag-np-titles");
  const eyebrow = agNpEl("p", "t-caption ag-np-eyebrow");
  eyebrow.setAttribute("aria-live", "polite");
  ui.sTitle.classList.add("t-display", "clamp3");
  ui.sShow.classList.add("t-body", "clamp1");
  ui.sWhy.classList.add("t-why", "clamp2");
  titles.append(eyebrow, ui.sTitle, ui.sShow, ui.sWhy);
  mid.append(artWrap, titles);

  const progress = agNpEl("div", "ag-np-progress");
  const strip = agNpEl("div", "ag-np-strip");
  strip.hidden = true;
  ui.scrub.classList.add("ag-np-scrubber");
  ui.times = ui.tNow.parentElement || ui.times;
  ui.tNow.parentElement?.classList.add("ag-np-times", "t-caption");
  progress.append(strip, ui.scrub, ui.tNow.parentElement);

  ui.row.classList.add("ag-np-transport");
  agNpSetIcon(ui.backBtn, "back15", 36);
  ui.backBtn.classList.add("ag-np-skip");
  agNpSetIcon(ui.bigPlay, "play", 36);
  ui.bigPlay.classList.add("ag-np-play");
  agNpSetIcon(ui.fwdBtn, "fwd30", 36);
  ui.fwdBtn.classList.add("ag-np-skip");

  const detailHandle = agNpEl("button", "ag-np-detail-handle t-label");
  detailHandle.type = "button";
  detailHandle.setAttribute("aria-label", "More: speed, sleep, bookmark, share, clips and show notes");
  detailHandle.append(agNpEl("span", "ag-np-more-label", "More"));
  const detailChevron = agNpEl("span", "ag-np-handle-icon");
  detailChevron.append(agNpIconNode("chevron-down", 20));
  detailHandle.append(detailChevron);

  first.append(ui.grabZone, mid, progress, ui.row, detailHandle);

  const detail = agNpEl("div", "ag-np-detail");
  const actionRow = agNpEl("div", "ag-np-actions");
  const action = (button, icon, label) => {
    button.classList.add("ag-np-action");
    button.replaceChildren();
    const glyph = agNpEl("span", "ag-np-action-icon");
    glyph.append(agNpIconNode(icon, 24));
    button.append(glyph, agNpEl("span", "t-caption ag-np-action-caption", label));
    return button;
  };
  action(ui.rateBtn, "gauge", "Speed");
  const sleepBtn = action(agNpIconButton("Sleep timer", "moon", "ag-np-action"), "moon", "Sleep");
  action(ui.bookmarkBtn, "bookmark", "Bookmark");
  const shareBtn = action(agNpIconButton("Share a link to this moment", "share", "ag-np-action"), "share", "Share");
  actionRow.append(ui.rateBtn, sleepBtn, ui.bookmarkBtn, shareBtn);

  const segmentsSection = agNpEl("section", "ag-np-section ag-np-clips");
  segmentsSection.append(agNpEl("h3", "t-headline", "Clips"), agNpEl("div", "ag-np-clip-list"));
  const sourcesSection = agNpEl("section", "ag-np-section ag-np-sources");
  sourcesSection.append(agNpEl("h3", "t-headline", "Where this came from"), agNpEl("div", "ag-np-source-grid"));
  const notesSection = agNpEl("section", "ag-np-section ag-np-notes");
  const notesToggle = ui.sDesc.querySelector("summary");
  ui.sDesc.open = true;
  if (notesToggle) {
    setControlLabel(notesToggle, "More", "Show more of the notes");
    notesToggle.addEventListener("click", (event) => {
      event.preventDefault();
      const expanded = ui.sDesc.classList.toggle("is-expanded");
      setControlLabel(notesToggle, expanded ? "Less" : "More", expanded ? "Show less of the notes" : "Show more of the notes");
      notesToggle.setAttribute("aria-expanded", expanded ? "true" : "false");
    });
  }
  notesSection.append(agNpEl("h3", "t-headline", "Show notes"), ui.sDesc);
  const upNextSection = agNpEl("section", "ag-np-section ag-np-up-next");
  upNextSection.append(agNpEl("h3", "t-headline", "Up next"), agNpEl("div", "ag-np-up-next-row"), ui.queueLink);

  ui.row2.classList.add("ag-np-legacy-actions");
  detail.append(actionRow, segmentsSection, sourcesSection, notesSection, upNextSection, ui.clips, ui.row2, ui.sErr, ui.note);
  ui.scroll.replaceChildren(first, detail);
  ui.sheet.prepend(roomLayers);

  /* The More handle and the dots both bring the detail posture up and park focus on its first control. */
  const openDetail = () => {
    /* The detail is not drawn in car posture (ui/car.css): the dots there end it first, so what they lead to exists. */
    window.AfterglowCar?.leave(document);
    detail.scrollIntoView({ behavior: "smooth", block: "start" });
    ui.rateBtn.focus({ preventScroll: true });
  };
  detailHandle.addEventListener("click", openDetail);
  moreMenuBtn.addEventListener("click", openDetail);
  /* Sleep cycles off, 15, 30, 60, off. The timer itself belongs to player/client.js (it owns playback): it is
     handed the minutes through ui.requestSleep and calls ui.resetSleep when it fires. */
  let sleepMinutes = 0;
  const paintSleep = () => {
    setStatusText(sleepBtn.querySelector(".ag-np-action-caption"), sleepMinutes ? `${sleepMinutes} min` : "Sleep");
    sleepBtn.setAttribute("aria-label", sleepMinutes ? `Sleep timer, ${sleepMinutes} minutes, tap to change` : "Sleep timer");
    sleepBtn.setAttribute("aria-pressed", sleepMinutes ? "true" : "false");
  };
  sleepBtn.addEventListener("click", () => {
    sleepMinutes = sleepMinutes === 0 ? 15 : sleepMinutes === 15 ? 30 : sleepMinutes === 30 ? 60 : 0;
    paintSleep();
    ui.requestSleep?.(sleepMinutes);
  });
  ui.resetSleep = () => { sleepMinutes = 0; paintSleep(); };
  shareBtn.addEventListener("click", async () => {
    const url = safeUrl(location.href);
    try {
      if (navigator.share) await navigator.share({ title: ui.sTitle.textContent, url });
      else if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(url);
    } catch (_) { /* cancellation is not a playback error */ }
  });

  Object.assign(ui, {
    ag: true, roomLayers: [roomA, roomB], roomLayer: 0, eyebrow, strip, detail,
    detailHandle, segmentsSection, sourcesSection, notesSection, upNextSection,
    upNextRow: upNextSection.querySelector(".ag-np-up-next-row"), artSwap,
    artWrap, moreMenuBtn, sleepBtn, shareBtn,
  });
  if (typeof ResizeObserver === "function") new ResizeObserver(() => agNpMeasureTitle(ui)).observe(ui.sTitle);
  window.__afterglowNowPlayingUi = ui;
  return ui;
}

/* Three title lines shrink the artwork to 180 (BUILD-NOTES 4.2). Measured on the laid-out title,
   so it only counts while the sheet is open (a hidden sheet reports height 0 and keeps its class);
   the title's width never depends on the artwork's size, so toggling the class cannot loop. */
function agNpMeasureTitle(ui) {
  if (!ui?.ag || ui.sheet.hidden) return;
  const height = ui.sTitle.getBoundingClientRect().height;
  if (!height) return;
  const line = parseFloat(getComputedStyle(ui.sTitle).lineHeight) || 36;
  ui.sheet.classList.toggle("is-long-title", Math.round(height / line) >= 3);
}

/* The show line under the title crossfades on a segment change: out for half of --m-ui, the text swaps
   while it is invisible, in for the other half (280ms in all). The title never changes, so its box cannot move. */
function agNpSetShowLine(ui, text) {
  if (!ui?.ag) return;
  if (ui.showLine == null) {
    ui.showLine = text;
    setStatusText(ui.sShow, text);
    return;
  }
  if (ui.showLine === text) return;
  ui.showLine = text;
  clearTimeout(ui.showTimer);
  ui.sShow.classList.add("is-crossfading");
  ui.showTimer = setTimeout(() => {
    setStatusText(ui.sShow, text);
    ui.sShow.classList.remove("is-crossfading");
  }, 140);
}

/* The Room's copy of the Foray collage: the same sleeves (or, for a show with no artwork URL, the same colour tiles)
   that the big collage shows, laid out in the top band of the layer so every sleeve's tone sits inside the scrim's
   light zone once the layer is blurred (a 2x2 across the whole layer buries the lower row under the 0.86 scrim). */
function agNpFillRoomCollage(layer, sources) {
  if (!layer || !Array.isArray(sources) || !sources.length) return;
  const grid = agNpEl("div", "ag-np-room-collage");
  grid.dataset.count = String(sources.length);
  sources.forEach((source) => {
    if (!source.src) {
      const tile = agNpEl("span", "ag-np-room-tile");
      tile.style.setProperty("--c", agNpColour(source.name));
      grid.append(tile);
      return;
    }
    const img = agNpEl("img", "ag-np-room-tile");
    img.alt = "";
    agNpSafeArt(img, source.src);
    grid.append(img);
  });
  layer.replaceChildren(grid);
}

function agNpSetRoom(ui, src, show, { announce = false } = {}) {
  if (!ui?.ag) return;
  const css = agNpCssUrl(src);
  const next = ui.roomLayer === 0 ? 1 : 0;
  const incoming = ui.roomLayers[next];
  const outgoing = ui.roomLayers[ui.roomLayer];
  incoming.style.setProperty("--room-art", css);
  incoming.replaceChildren();
  /* A show with no artwork URL lights the Room with the Foray's collage instead of a flat colour: the Room is the
     sleeve's own tones (BUILD-NOTES 1.5). Narration is 4a's voice, so it takes no collage and falls back to lamp-warm. */
  const artless = css === "none" && show !== "4a narration";
  incoming.dataset.artless = artless ? "1" : "";
  if (artless) agNpFillRoomCollage(incoming, ui.collageSources);
  incoming.classList.add("is-on");
  outgoing.classList.remove("is-on");
  ui.roomLayer = next;
  /* Narration is 4a's own voice: the Room returns to lamp-warm neutral instead of taking a show's hue. */
  const glow = show === "4a narration" ? "oklch(0.74 0.05 75)" : agNpColour(show);
  ui.sheet.style.setProperty("--glow", glow);
  ui.root.style.setProperty("--glow", glow);
  ui.artSwap.style.setProperty("--art-glow", glow);
  if (announce) agNpFlashCaption(ui, `Now: ${show}`);
}

function agNpFlashCaption(ui, text, hold = false) {
  if (!ui?.eyebrow) return;
  clearTimeout(ui.captionTimer);
  setStatusText(ui.eyebrow, String(text || ""));
  ui.eyebrow.classList.toggle("is-lit", Boolean(text));
  if (text && !hold) ui.captionTimer = setTimeout(() => ui.eyebrow.classList.remove("is-lit"), 3000);
}

function agNpPaintForay(ui, { items = [], model = null, currentIndex = 0, starts = [], title = "", show = "", elapsed = 0, onSeek } = {}) {
  if (!ui?.ag) return;
  ui.sheet.classList.add("is-foray");
  ui.strip.hidden = false;
  ui.scrub.hidden = true;
  ui.segmentsSection.hidden = false;
  ui.sourcesSection.hidden = false;
  ui.notesSection.hidden = true;
  const signature = items.map((item) => item?.id || agNpShow(item)).join("|");
  if (ui.foraySignature !== signature) {
    ui.foraySignature = signature;
    ui.strip.replaceChildren();
    const segments = model?.segments || [];
    segments.forEach((segment, order) => {
      const item = items[segment.index] || items[order] || {};
      const name = agNpShow(item);
      const button = agNpEl("button", "ag-np-strip-button");
      button.type = "button";
      button.dataset.index = String(segment.index);
      button.setAttribute("aria-label", `Seek to ${name}, ${agNpClock(starts[segment.index] || 0)}`);
      button.style.setProperty("--grow", String(segment.grow || 1));
      button.style.setProperty("--c", item?.kind === "tts" ? "var(--lamp)" : agNpColour(name));
      const bar = agNpEl("span", item?.kind === "tts" ? "ag-np-strip-bar is-narration" : "ag-np-strip-bar");
      bar.append(agNpEl("span", "ag-np-strip-fill"));
      button.append(bar);
      /* Neighbouring cuts from one show are one lantern: they touch (no gap, square inner corners), so the strip reads
         as shows joined by narration instead of a row of equal chips. */
      const runOf = (at) => {
        const other = items[segments[at]?.index];
        return other && other.kind !== "tts" && item?.kind !== "tts" && agNpShow(other) === name;
      };
      if (runOf(order - 1)) button.dataset.joinPrev = "1";
      if (runOf(order + 1)) button.dataset.joinNext = "1";
      button.addEventListener("click", () => onSeek?.(starts[segment.index] || 0));
      ui.strip.append(button);
    });
    agNpPaintDetails(ui, items, onSeek, model);
    agNpPaintCollage(ui, items);
  }
  [...ui.strip.children].forEach((button, order) => {
    const segment = model?.segments?.[order];
    const index = Number(button.dataset.index);
    const current = index === currentIndex;
    button.classList.toggle("is-current", current);
    button.classList.toggle("is-past", segment?.state === "past");
    button.querySelector(".ag-np-strip-fill")?.style.setProperty("--fill", String(current ? segment?.progress ?? 0 : 0));
  });
  setStatusText(ui.sTitle, title);
  agNpSetShowLine(ui, `${new Set(items.map(agNpShow).filter((name) => name !== "4a narration")).size} shows · ${show}`);
  ui.strip.setAttribute("aria-label", `Foray position ${agNpClock(elapsed)}`);
}

function agNpPaintCollage(ui, items) {
  const sources = [];
  for (const item of items) {
    const name = agNpShow(item);
    const src = agNpArt(item);
    if (name === "4a narration" || sources.some((source) => source.name === name)) continue;
    sources.push({ name, src });
    if (sources.length === 4) break;
  }
  if (!sources.length) return;
  ui.collageSources = sources;
  for (const layer of ui.roomLayers) if (layer.dataset.artless === "1") agNpFillRoomCollage(layer, sources);
  let collage = ui.artSwap.querySelector(".ag-np-collage");
  if (!collage) {
    collage = agNpEl("div", "ag-np-collage lit-art lit-96");
    ui.artSwap.append(collage);
  }
  collage.replaceChildren();
  sources.forEach((source, order) => {
    /* A show with no artwork URL still gets its square, in the colour the strip derives for it:
       the collage is the Foray's identity, so it is never an empty hole in the Room. */
    if (!source.src) {
      const tile = agNpEl("span", "ag-np-collage-art ag-np-collage-tile");
      tile.style.setProperty("--c", agNpColour(source.name));
      collage.append(tile);
      return;
    }
    const img = agNpEl("img", "ag-np-collage-art");
    img.alt = "";
    agNpSafeArt(img, source.src);
    collage.append(img);
  });
  collage.dataset.count = String(sources.length);
  ui.artSwap.querySelector(".ag-np-halo")?.remove();
  const halo = collage.cloneNode(true);
  halo.className = "ag-np-halo";
  halo.setAttribute("aria-hidden", "true");
  ui.artSwap.prepend(halo);
  ui.sArt.hidden = true;
}

function agNpFollowStore() {
  const store = typeof window !== "undefined" ? window.ForayNav?.showFollow : null;
  return store && typeof store.followable === "function" && typeof store.toggle === "function" && typeof store.isFollowing === "function" ? store : null;
}

function agNpPaintFollow(button, on) {
  const show = button.dataset.npFollowName || "";
  button.setAttribute("aria-pressed", on ? "true" : "false");
  setControlLabel(button, on ? "Following" : "Follow", on ? `Following ${show}` : `Follow ${show}`);
}

function agNpPaintDetails(ui, items, onSeek, model) {
  const list = ui.segmentsSection.querySelector(".ag-np-clip-list");
  const grid = ui.sourcesSection.querySelector(".ag-np-source-grid");
  list.replaceChildren();
  grid.replaceChildren();
  const seen = new Set();
  items.forEach((item, index) => {
    /* The strip model owns the Foray clock (runtimes, cumulative starts), so a row's time range is the
       range its bar covers and a seek from the row lands where the same bar's seek lands. */
    const seg = model?.segments?.find((segment) => segment.index === index);
    const elapsed = Number(seg?.startSec) || 0;
    const duration = Number(seg?.lengthSec) || 0;
    const narration = item?.kind === "tts";
    const row = agNpEl("button", narration ? "ag-np-clip-row is-narration" : "ag-np-clip-row");
    row.type = "button";
    row.setAttribute("aria-label", `Seek to ${agNpShow(item)}, ${agNpClock(elapsed)}`);
    if (!narration) {
      row.append(agNpArtNode("ag-np-clip-art", item, agNpShow(item)));
    }
    const copy = agNpEl("span", "ag-np-clip-copy");
    copy.append(agNpEl("span", narration ? "t-label lamp" : "t-label", narration ? "Narration" : (item?.title || agNpShow(item))));
    copy.append(agNpEl("span", "t-caption", `${agNpShow(item)} · ${agNpClock(elapsed)}–${agNpClock(elapsed + duration)}`));
    row.append(copy);
    row.addEventListener("click", () => onSeek?.(elapsed));
    list.append(row);

    const show = agNpShow(item);
    if (narration || seen.has(show)) return;
    seen.add(show);
    const tile = agNpEl("article", "ag-np-source-tile");
    const art = agNpArtNode("ag-np-source-art lit-art lit-40", item, show);
    art.style.setProperty("--art-glow", agNpColour(show));
    const name = agNpEl("p", "t-caption clamp3", show);
    tile.append(art, name);
    /* No decorative controls: Follow is the library's real follow (cp_starred_shows, through ForayNav.showFollow), so
       what it says is what the Library holds. A source whose show the catalogue does not know cannot be followed, and
       gets no button rather than one that only changes its own label. */
    const follows = agNpFollowStore();
    if (follows && follows.followable(item?.show_id)) {
      const follow = agNpEl("button", "ag-np-follow t-label", "Follow");
      follow.type = "button";
      follow.dataset.npFollow = item.show_id;
      follow.dataset.npFollowName = show;
      agNpPaintFollow(follow, follows.isFollowing(item.show_id));
      follow.addEventListener("click", () => {
        follows.toggle(item.show_id);
        /* Repainted from the store, not from the old label, so a stale tile corrects itself on the tap. */
        grid.querySelectorAll("[data-np-follow]").forEach((btn) => agNpPaintFollow(btn, follows.isFollowing(btn.dataset.npFollow)));
      });
      tile.append(follow);
    }
    grid.append(tile);
  });
}

function agNpPaintEpisode(ui) {
  if (!ui?.ag) return;
  ui.sheet.classList.remove("is-foray");
  ui.showLine = null;
  /* The collage and the strip are torn down below, so the same Foray played again must rebuild both. */
  ui.foraySignature = null;
  ui.collageSources = null;
  for (const layer of ui.roomLayers) if (layer.dataset.artless === "1") layer.replaceChildren();
  ui.strip.hidden = true;
  ui.scrub.hidden = false;
  ui.segmentsSection.hidden = true;
  ui.sourcesSection.hidden = true;
  ui.notesSection.hidden = ui.sDesc.hidden;
  ui.sArt.hidden = false;
  ui.artSwap.querySelector(".ag-np-collage")?.remove();
  ui.artSwap.querySelector(".ag-np-halo")?.remove();
}

function agNpPaintUpNext(ui, item, count = 0) {
  if (!ui?.ag) return;
  ui.upNextSection.hidden = !item;
  ui.upNextRow.replaceChildren();
  if (!item) return;
  const image = agNpArtNode("ag-np-up-next-art", item, agNpShow(item));
  const copy = agNpEl("div", "ag-np-up-next-copy");
  /* "4a added" only for a pick 4a made (the app hands over source "tail") AND wrote a reason for; an entry the listener
     queued, or the next row of a list they started, is theirs and gets no 4a label or why-line, hook or not. */
  const reason = item.source === "tail" ? (item.why || "") : "";
  const eyebrow = reason ? "4a added" : (item.source === "list" ? "Next in your list" : (item.source === "tail" ? "Up next" : "In your queue"));
  copy.append(agNpEl("span", reason ? "eyebrow lamp" : "eyebrow", eyebrow));
  copy.append(agNpEl("p", "t-label clamp2", item.title || "Up next"));
  const minutes = Math.round(Number(item.duration_sec || 0) / 60);
  copy.append(agNpEl("p", "t-caption clamp1", minutes > 0 ? `${agNpShow(item)} · ${minutes} min` : agNpShow(item)));
  if (reason) copy.append(agNpEl("p", "t-why clamp2", reason));
  ui.upNextRow.append(image, copy);
  setControlLabel(ui.queueLink, `Up Next (${count})`);
}

function agNpHandoff(ui, previousSrc, nextSrc, { freeze = false } = {}) {
  if (!ui?.ag || !previousSrc || !nextSrc || previousSrc === nextSrc) return;
  const old = agNpEl("img", "ag-np-art-out");
  old.alt = "";
  agNpSafeArt(old, previousSrc);
  ui.artSwap.prepend(old);
  ui.sArt.classList.add("ag-np-art-in");
  ui.artSwap.classList.toggle("is-frozen-ending", freeze);
  agNpFlashCaption(ui, "Up next", freeze);
  if (!freeze) setTimeout(() => {
    old.remove();
    ui.sArt.classList.remove("ag-np-art-in");
  }, 580);
}

window.AfterglowNowPlaying = {
  adopt: agNpAdopt,
  setRoom: agNpSetRoom,
  flashCaption: agNpFlashCaption,
  measureTitle: agNpMeasureTitle,
  setShowLine: agNpSetShowLine,
  paintForay: agNpPaintForay,
  paintEpisode: agNpPaintEpisode,
  paintUpNext: agNpPaintUpNext,
  handoff: agNpHandoff,
  setIcon: agNpSetIcon,
  colour: agNpColour,
};
