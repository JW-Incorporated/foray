/* Afterglow Now Playing. This screen file owns the redesign markup while
   player/client.js keeps ownership of playback, clocks, focus and gestures.
   Dynamic listener/publisher text is assigned with textContent; artwork URLs
   cross safeUrl() before either an img.src or CSSOM --room-art write. */

function agNpEl(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = String(text);
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

function agNpHash(value) {
  let hash = 2166136261;
  for (const ch of String(value || "4a")) {
    hash ^= ch.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function agNpColour(value, index = 0) {
  const hue = (agNpHash(value) + index * 30) % 360;
  return `oklch(0.70 0.13 ${hue})`;
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
  ui.root.classList.add("ag", "ag-player");
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
  detailHandle.setAttribute("aria-label", "More: speed, sleep, bookmark, share, segments and show notes");
  detailHandle.append(agNpEl("span", "ag-np-more-label", "More"));
  const detailChevron = agNpEl("span", "ag-np-handle-icon");
  detailChevron.append(agNpIconNode("chevron-down", 20));
  detailHandle.append(detailChevron);

  first.append(ui.grabZone, mid, progress, ui.row, detailHandle);

  const detail = agNpEl("div", "ag-np-detail");
  const actionRow = agNpEl("div", "ag-np-actions");
  const action = (button, icon, label) => {
    button.classList.add("ag-np-action");
    button.textContent = "";
    const glyph = agNpEl("span", "ag-np-action-icon");
    glyph.append(agNpIconNode(icon, 24));
    button.append(glyph, agNpEl("span", "t-caption", label));
    return button;
  };
  action(ui.rateBtn, "gauge", "Speed");
  const sleepBtn = action(agNpIconButton("Sleep timer", "moon", "ag-np-action"), "moon", "Sleep");
  action(ui.bookmarkBtn, "bookmark", "Bookmark");
  const shareBtn = action(agNpIconButton("Share a link to this moment", "share", "ag-np-action"), "share", "Share");
  actionRow.append(ui.rateBtn, sleepBtn, ui.bookmarkBtn, shareBtn);

  const segmentsSection = agNpEl("section", "ag-np-section ag-np-segments");
  segmentsSection.append(agNpEl("h3", "t-headline", "Segments"), agNpEl("div", "ag-np-segment-list"));
  const sourcesSection = agNpEl("section", "ag-np-section ag-np-sources");
  sourcesSection.append(agNpEl("h3", "t-headline", "Where this came from"), agNpEl("div", "ag-np-source-grid"));
  const notesSection = agNpEl("section", "ag-np-section ag-np-notes");
  const notesToggle = ui.sDesc.querySelector("summary");
  ui.sDesc.open = true;
  if (notesToggle) {
    notesToggle.textContent = "More";
    notesToggle.addEventListener("click", (event) => {
      event.preventDefault();
      const expanded = ui.sDesc.classList.toggle("is-expanded");
      notesToggle.textContent = expanded ? "Less" : "More";
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

  detailHandle.addEventListener("click", () => detail.scrollIntoView({ behavior: "smooth", block: "start" }));
  let sleepMinutes = 0;
  sleepBtn.addEventListener("click", () => {
    sleepMinutes = sleepMinutes === 0 ? 15 : sleepMinutes === 15 ? 30 : 0;
    sleepBtn.querySelector(".t-caption").textContent = sleepMinutes ? `${sleepMinutes} min` : "Sleep";
    sleepBtn.setAttribute("aria-label", sleepMinutes ? `Sleep timer, ${sleepMinutes} minutes` : "Sleep timer");
  });
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
  window.__afterglowNowPlayingUi = ui;
  return ui;
}

function agNpSetRoom(ui, src, show, { announce = false } = {}) {
  if (!ui?.ag) return;
  const css = agNpCssUrl(src);
  const next = ui.roomLayer === 0 ? 1 : 0;
  const incoming = ui.roomLayers[next];
  const outgoing = ui.roomLayers[ui.roomLayer];
  incoming.style.setProperty("--room-art", css);
  incoming.classList.add("is-on");
  outgoing.classList.remove("is-on");
  ui.roomLayer = next;
  const glow = agNpColour(show);
  ui.sheet.style.setProperty("--glow", glow);
  ui.root.style.setProperty("--glow", glow);
  ui.sArt.style.setProperty("--art-glow", glow);
  if (announce) agNpFlashCaption(ui, `Now: ${show}`);
}

function agNpFlashCaption(ui, text, hold = false) {
  if (!ui?.eyebrow) return;
  clearTimeout(ui.captionTimer);
  ui.eyebrow.textContent = String(text || "");
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
      button.style.setProperty("--c", item?.kind === "tts" ? "var(--lamp)" : agNpColour(name, order));
      const bar = agNpEl("span", item?.kind === "tts" ? "ag-np-strip-bar is-narration" : "ag-np-strip-bar");
      bar.append(agNpEl("span", "ag-np-strip-fill"));
      button.append(bar);
      button.addEventListener("click", () => onSeek?.(starts[segment.index] || 0));
      ui.strip.append(button);
    });
    agNpPaintDetails(ui, items, onSeek);
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
  ui.sTitle.textContent = title;
  ui.sShow.textContent = `${new Set(items.map(agNpShow).filter((name) => name !== "4a narration")).size} shows · ${show}`;
  ui.sShow.classList.add("is-crossfading");
  requestAnimationFrame(() => ui.sShow.classList.remove("is-crossfading"));
  ui.strip.setAttribute("aria-label", `Foray position ${agNpClock(elapsed)}`);
}

function agNpPaintCollage(ui, items) {
  const sources = [];
  for (const item of items) {
    const name = agNpShow(item);
    const src = agNpArt(item);
    if (!src || name === "4a narration" || sources.some((source) => source.name === name)) continue;
    sources.push({ name, src });
    if (sources.length === 4) break;
  }
  if (!sources.length) return;
  let collage = ui.artSwap.querySelector(".ag-np-collage");
  if (!collage) {
    collage = agNpEl("div", "ag-np-collage lit-art lit-96");
    ui.artSwap.append(collage);
  }
  collage.replaceChildren();
  for (const source of sources) {
    const img = agNpEl("img", "ag-np-collage-art");
    img.alt = "";
    agNpSafeArt(img, source.src);
    collage.append(img);
  }
  collage.dataset.count = String(sources.length);
  ui.sArt.hidden = true;
}

function agNpPaintDetails(ui, items, onSeek) {
  const list = ui.segmentsSection.querySelector(".ag-np-segment-list");
  const grid = ui.sourcesSection.querySelector(".ag-np-source-grid");
  list.replaceChildren();
  grid.replaceChildren();
  const seen = new Set();
  let elapsed = 0;
  items.forEach((item, index) => {
    const duration = Number(item?.duration_sec || item?.durationSec || item?.length_sec || 0);
    const narration = item?.kind === "tts";
    const row = agNpEl("button", narration ? "ag-np-segment-row is-narration" : "ag-np-segment-row");
    row.type = "button";
    row.setAttribute("aria-label", `Seek to ${agNpShow(item)}, ${agNpClock(elapsed)}`);
    if (!narration) {
      const image = agNpEl("img", "ag-np-segment-art");
      image.alt = "";
      agNpSafeArt(image, agNpArt(item));
      row.append(image);
    }
    const copy = agNpEl("span", "ag-np-segment-copy");
    copy.append(agNpEl("span", narration ? "t-label lamp" : "t-label", narration ? "Narration" : (item?.title || agNpShow(item))));
    copy.append(agNpEl("span", "t-caption", `${agNpShow(item)} · ${agNpClock(elapsed)}–${agNpClock(elapsed + duration)}`));
    row.append(copy);
    const seekAt = elapsed;
    row.addEventListener("click", () => onSeek?.(seekAt));
    list.append(row);
    elapsed += duration;

    const show = agNpShow(item);
    if (narration || seen.has(show)) return;
    seen.add(show);
    const tile = agNpEl("article", "ag-np-source-tile");
    const art = agNpEl("img", "ag-np-source-art lit-art lit-40");
    art.alt = "";
    agNpSafeArt(art, agNpArt(item));
    art.style.setProperty("--art-glow", agNpColour(show));
    const name = agNpEl("p", "t-caption clamp3", show);
    const follow = agNpEl("button", "ag-np-follow t-label", "Follow");
    follow.type = "button";
    follow.setAttribute("aria-pressed", "false");
    follow.addEventListener("click", () => {
      const on = follow.getAttribute("aria-pressed") !== "true";
      follow.setAttribute("aria-pressed", on ? "true" : "false");
      follow.textContent = on ? "Following" : "Follow";
    });
    tile.append(art, name, follow);
    grid.append(tile);
  });
}

function agNpPaintEpisode(ui) {
  if (!ui?.ag) return;
  ui.sheet.classList.remove("is-foray");
  ui.strip.hidden = true;
  ui.scrub.hidden = false;
  ui.segmentsSection.hidden = true;
  ui.sourcesSection.hidden = true;
  ui.notesSection.hidden = ui.sDesc.hidden;
  ui.sArt.hidden = false;
  ui.artSwap.querySelector(".ag-np-collage")?.remove();
}

function agNpPaintUpNext(ui, item, count = 0) {
  if (!ui?.ag) return;
  ui.upNextSection.hidden = !item;
  ui.upNextRow.replaceChildren();
  if (!item) return;
  const image = agNpEl("img", "ag-np-up-next-art");
  image.alt = "";
  agNpSafeArt(image, agNpArt(item));
  const copy = agNpEl("div", "ag-np-up-next-copy");
  copy.append(agNpEl("span", "eyebrow lamp", "4a added"));
  copy.append(agNpEl("p", "t-label clamp2", item.title || "Up next"));
  const minutes = Math.max(1, Math.round(Number(item.duration_sec || 0) / 60));
  copy.append(agNpEl("p", "t-caption clamp1", `${agNpShow(item)} · ${minutes} min`));
  copy.append(agNpEl("p", "t-why clamp2", item.why || item.hook || "A different angle on the same subject."));
  ui.upNextRow.append(image, copy);
  ui.queueLink.textContent = `Up Next (${count})`;
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
  paintForay: agNpPaintForay,
  paintEpisode: agNpPaintEpisode,
  paintUpNext: agNpPaintUpNext,
  handoff: agNpHandoff,
  setIcon: agNpSetIcon,
  colour: agNpColour,
};
