/* ui/library.js — Yours, formerly Library (#/library), and the Playlists list (#/playlists).
   A CLASSIC script like app.js, not a module: it shares app.js's globals and
   is loaded by index.html after app.js, in the order listed in
   docs/redesign-2026/split-notes.md. Declarations only at the top level, so
   nothing here runs until app.js's boot (ui/boot.js) starts init(). */


/* ---------- Library (#/library, docs/ux/foray-mockup.jsx's LibraryScreen) ----------

   Card t_a1e7a69c. One AGGREGATE view over four things that already live in
   localStorage and already have their own render paths — this page adds no
   new per-item UI, only a new place that lists what is already there:

     Saved     cp_saved   via savedMap()     — reuses epRow/archivedRow
     History   cp_history via pickedHistory()— reuses epRow/archivedRow
     Playlists cp_playlists via playlists()  — reuses the same summary row
                                                renderPlaylists() prints, capped
     Up Next   cp_queue   via queueRows()    — the page's own list since Redesign
                                                2026 (tactile `library`): see
                                                "YOURS (TACTILE)" below. It was a
                                                summary row linking to #/queue.

   Playlists is LINKED, not embedded (Joey's call is made here, for the PR to
   explain): it already has a real page (#/playlists) with its own controls
   (build/remove) that this aggregate view has no room for at mobile width —
   Library shows a short summary (title + count, capped at 5) that opens
   straight into the real page, the same "browse here, act there" split the
   mockup itself draws between LibraryScreen and the screens it links out to
   (`playForay`/`openShow` in the mockup, `#/playlist/:id` and `#/show/:id`
   here). Saved and History get the FULL row treatment (epRow/archivedRow)
   because Library IS their only page — there is no separate #/saved or
   #/history to defer to.

   Every link on this page is in-app: episode rows resolve through
   epRow/archivedRow (which already only ever link within 4a or, for a part
   with no in-app audio, out to the episode's own listening app — the same
   fallback every other row in the app already uses, never a new one), and
   the Playlists summaries link to their own in-app pages. Nothing here
   introduces a new external link-out.

   History is newest-first (`pickedHistory()` appends, so the raw array is
   oldest-first) and capped at the same 20 rows for the same reason renderHome
   caps its rails — a scroll-forever list is not what "recently listened"
   means. Saved has no cap: an unbounded star list is the one honest reading
   of "everything you saved". */
/* The href is `"#" + hashPath` through safeUrl like every other (CLAUDE.md
   § Conventions: "all href/src through safeUrl()"; test/app-security.test.js
   reads every interpolated href, whatever it opens with). hashPath is this
   module's own constant route or an encoded id, which safeUrl passes as an
   in-app route. */
function libSummaryRow(hashPath, title, sub) {
  return `<a class="pl-row" href="${esc(safeUrl("#" + hashPath))}">
    <div class="info">
      <div class="t">${esc(title)}</div>
      <div class="s">${esc(sub)}</div>
    </div>
    <span class="chev">›</span>
  </a>`;
}

/* FORAYS AND FOLLOWED SHOWS ARE LIBRARY SECTIONS (founder, 2026-09-22: "Forays
   into Library, no new tab"; audit personas 32 and 50). The tab bar lit Library
   for #/forays and every Foray page while Library listed no Forays, and the only
   way to the shows a listener followed was a row inside the Search page's browse
   furniture, hidden the moment the field was focused. Both are LINKED, capped at
   five like Playlists, and open their real page for the rest — the "browse here,
   act there" split the header above describes. */
const LIBRARY_SECTION_CAP = 5;

function libraryForaysHtml() {
  /* The player module lists Forays; until it has loaded, the count is unknown,
     and an unknown count is not zero — offer the way in, claim nothing. */
  if (!state.forays || !window.ForayPlayer) return libSummaryRow("/forays", "All forays", "");
  const list = forayCards();
  if (!list.length) return `<p class="note">No forays to show yet.</p>`;
  const progress = forayProgressLabels();
  return list.slice(0, LIBRARY_SECTION_CAP).map(f =>
    libSummaryRow(`/foray/${encodeURIComponent(f.id)}`, f.title || f.id,
      forayListSubLabel(f, progress))).join("")
    + (list.length > LIBRARY_SECTION_CAP ? `<a class="lib-more" href="#/forays">All ${list.length} forays ›</a>` : "");
}

function libraryFollowedHtml() {
  const followed = Object.values(starredShowsMap())
    .sort((a, b) => (b.starred_at || "").localeCompare(a.starred_at || ""));
  if (!followed.length) return `<p class="note">No followed shows yet — follow a show from its page to keep it here.</p>`;
  return `<div class="show-results">${followed.slice(0, LIBRARY_SECTION_CAP).map(starredShowRow).join("")}</div>`
    + (followed.length > LIBRARY_SECTION_CAP ? `<a class="lib-more" href="#/starred-shows">All ${followed.length} followed shows ›</a>` : "");
}

/* ---------- YOURS (TACTILE): the Library as a chip strip over one list ----------

   Redesign 2026, tactile `library` (docs/redesign-2026/directions/tactile/
   BUILD-PLAN.md 2.12, BUILD-NOTES 4.5). "Yours" is the third tab; this page was
   "Library", one scroll of seven stacked sections. It is now a display-xl
   title over a readout line, a chip strip (Forays, Shows, Saved, Playlists, Up
   Next, History) and ONE panel at a time.

   RULING THAT FELL: "Library is one aggregate scroll of sections" (the header
   above, and test/library-screen.test.js). Up Next used to be a single summary
   row that linked out to #/queue; it is now the page's own list, so the thing
   the listener most often reorders is on the screen they land on.

   EVERY PANEL IS IN THE DOCUMENT, ONLY ONE IS SHOWN. A chip press hides and
   shows panels (the `hidden` attribute); it never re-renders them, so a scroll
   position, a half-read Saved list and an open action row survive a trip to
   another chip and back, and a press costs no network and no layout of the
   other panels. The hidden ones are out of the accessibility tree and their
   lazy images never load.

   THE CHIP IS MEMORY, NOT STORAGE (`state.yoursChip`). A new `cp_` key would
   have to be named in the privacy policy and counted in the data-deletion
   screen for a convenience that is cheap to lose on a reload; the page opens on
   Up Next when something is queued and on Forays otherwise.

   DOWNLOADS is a seventh chip only where the native shell's download bridge
   exists (it was a Library section for the same reason). It sits before
   History; the six the prototype draws are the six everyone else gets.

   UP NEXT IS `cp_queue`, nothing more. The playing episode is a row only when
   it is in the list, which it is whenever it was played from Up Next (the played
   row jumps to the top, `playedFromUpNext`); an episode started from Today is
   not queued and so is not drawn here, the same as the badge on the tab, which
   counts the list. `#/queue` stays as the standalone page (drag, swipe, Play
   next) the Now Playing sheet and the drawer still link to; this panel is the
   Tactile list and writes through the same `saveQueueIds`. */
const YOURS_UNDO_MS = 4000;

function yoursChipDefs() {
  const defs = [
    { key: "forays", label: "Forays" },
    { key: "shows", label: "Shows" },
    { key: "saved", label: "Saved" },
    { key: "playlists", label: "Playlists" },
    { key: "upnext", label: "Up Next" },
  ];
  if (state.downloadBridge) defs.push({ key: "downloads", label: "Downloads" });
  defs.push({ key: "history", label: "History" });
  return defs;
}

/** The chip shown now: the listener's last choice this session when it still
    exists, else Up Next with something queued, else Forays. On the first-run
    screen (`empty`: nothing of the listener's anywhere) it is Up Next, so the
    readout line says "0 queued" and the strip is the one the screen will have
    the day something lands. */
function yoursActiveKey(queued, empty) {
  const keys = yoursChipDefs().map((c) => c.key);
  if (state.yoursChip && keys.includes(state.yoursChip)) return state.yoursChip;
  return queued > 0 || empty ? "upnext" : "forays";
}

/** The readout line under the title for the chip on screen: the Up Next one is
    "5 queued · 4 hr 55 min" (the full lengths, so it holds still while an
    episode plays), the others are the count the panel lists. A count that is
    not known yet (the Forays list before the player has loaded) says nothing
    about the number. */
function yoursReadoutText(key, d) {
  switch (key) {
    case "upnext": return joinMeta(`${d.queued} queued`, d.queued ? fmtDur(d.minutes) : "");
    case "forays": return d.forays == null ? "Forays" : countLabel(d.forays, "foray");
    case "shows": return countLabel(d.shows, "show");
    case "saved": return countLabel(d.saved, "saved episode");
    case "playlists": return countLabel(d.playlists, "playlist");
    case "downloads": return "Downloads";
    default: return `${countLabel(d.history, "episode")} played`;
  }
}

/** The tabpanel a chip controls is its own panel, or, on the whole-screen empty
    state (one panel, "yours-panel-empty"), that one. */
function yoursChipsHtml(active, queued, emptyPage) {
  return yoursChipDefs().map((c) => {
    const on = c.key === active;
    const badge = c.key === "upnext" && queued > 0 ? `<span class="chip__count readout">${esc(queued)}</span>` : "";
    const name = badge ? ` aria-label="${esc(`Up Next, ${queued} queued`)}"` : "";
    return `<button type="button" class="chip" role="tab" id="yours-chip-${esc(c.key)}" data-yours-chip="${esc(c.key)}" aria-selected="${on ? "true" : "false"}" aria-controls="${esc(emptyPage || $("#yours-panel-empty") ? "yours-panel-empty" : `yours-panel-${c.key}`)}" tabindex="${on ? "0" : "-1"}"${name}>${on ? tactileIcon("ph-check", "sm") : ""}<span>${esc(c.label)}</span>${badge}</button>`;
  }).join("");
}

/** First run: nothing queued, followed, saved, played, built, downloaded or
    part-played. ONE `.empty` for the whole screen (BUILD-NOTES 3.16, 4.5): the
    radio mark, a sentence, the Find key. It stands in for the six panels, so
    there is no per-chip "nothing here" line to disagree with it, and it is a
    mark and a key, never a bare sentence. The key opens Find, the tab the app
    draws as Find (`#/shows`; `#/search` is the prototype's name for it). */
const YOURS_EMPTY_COPY = "Nothing here yet. Follow a show or play today's foray and it lands here.";

function yoursEmptyPanelHtml(active) {
  return `<div class="yours-panel yours-panel--empty" role="tabpanel" id="yours-panel-empty" aria-labelledby="yours-chip-${esc(active)}">${tactileEmpty({ copy: YOURS_EMPTY_COPY, action: "Find a show", href: yoursFindHash() })}</div>`;
}

/** The Find tab's own route, read from the tab bar's definition so the two
    cannot drift apart. */
function yoursFindHash() {
  const tab = typeof TAB_ROUTES !== "undefined" && Array.isArray(TAB_ROUTES) ? TAB_ROUTES.find((t) => t.key === "search") : null;
  return tab && tab.hash ? tab.hash : "#/shows";
}

function yoursPanelHtml(key, active, inner) {
  return `<div class="yours-panel" role="tabpanel" id="yours-panel-${esc(key)}" aria-labelledby="yours-chip-${esc(key)}"${key === active ? "" : " hidden"}>${inner}</div>`;
}

/* ---------- the Up Next panel ---------- */

/** Station-coloured artwork with the show's two letters under it, the Find
    screen's own `.find-art` (enamel by the show's hash), so a queued row's
    cover is the same object everywhere. The image replaces the letters. */
function yoursArtHtml(item) {
  const name = tactileDisplayName(item.show || "");
  const img = item.artwork_url
    ? `<img src="${esc(safeUrl(artUrl(item.artwork_url, 144)))}" alt="" loading="lazy" decoding="async" width="48" height="48" referrerpolicy="no-referrer">`
    : "";
  return `<span class="find-art find-art--queue find-art--c${tactileHash(item.show_id || item.show || item.id)}" data-i="${esc(tactileStationCode(name))}">${img}</span>`;
}

/** "42 min left" for the playing row: the player's own progress label when it
    has one, else the whole length. */
function yoursLeftLabel(item) {
  const prog = rowProgress(item);
  if (prog && typeof prog.label === "string" && /left$/.test(prog.label)) return prog.label;
  const len = fmtDur(episodeMinutes(item));
  return len ? `${len} left` : "";
}

function yoursIsCurrent(id) {
  try { return !!window.ForayPlayer?.isCurrent?.(id); } catch (_) { return false; }
}

/** One data-action value: "verb:id". The verb never contains a colon, so the id
    is everything after the first one. */
function yoursActionKey(verb, id) { return `${verb}:${id}`; }

function yoursActionsHtml(r, idx, total, rows) {
  const { id, item } = r;
  const title = r.state === "unnamed" ? "this episode" : item.title;
  const cur = yoursIsCurrent(id);
  /* The playing row only offers Remove (the prototype's rule): its place is the
     top, and Move up on the row under it would put an episode ahead of the one
     that is playing. */
  const above = idx > 0 ? rows[idx - 1] : null;
  const upOff = idx === 0 || (above && yoursIsCurrent(above.id));
  const downOff = idx === total - 1;
  const keys = cur ? "" : tactileKeycap({ size: "sm", variant: "paper", icon: "ph-arrow-up", text: "Move up", label: `Move up: ${title}`, action: yoursActionKey("up", id), disabled: upOff })
    + tactileKeycap({ size: "sm", variant: "paper", icon: "ph-arrow-down", text: "Move down", label: `Move down: ${title}`, action: yoursActionKey("down", id), disabled: downOff });
  return `<div class="yours-qtools" id="yours-tools-${esc(idx)}" role="group" aria-label="${esc(`Actions for ${title}`)}">${keys}${tactileKeycap({ size: "sm", variant: "paper", icon: "ph-trash", text: "Remove", label: `Remove from Up Next: ${title}`, action: yoursActionKey("rm", id) })}</div>`;
}

function yoursQueueRowHtml(r, idx, total, rows, openId) {
  const { id, item, state: rowState } = r;
  const named = rowState !== "unnamed";
  const playable = rowState === "live";
  const cur = playable && yoursIsCurrent(id);
  const open = openId === id;
  const title = named ? (item.title || "Episode") : "Episode no longer available";
  const showName = named ? tactileDisplayName(item.show || "") : "";
  let metaHtml;
  let metaText;
  if (cur) {
    const left = yoursLeftLabel(item);
    metaText = joinMeta("Playing", left);
    metaHtml = `<span class="tag tag--playing">${tactileIcon("needle", "sm")}<span>Playing</span></span>${left ? `<span class="readout">· ${esc(left)}</span>` : ""}`;
  } else if (playable) {
    const prog = rowProgress(item);
    const rest = prog && prog.label ? prog.label : fmtDur(episodeMinutes(item));
    metaText = joinMeta(showName, rest);
    metaHtml = `<span class="row__show">${esc(showName)}</span>${rest ? `<span class="readout">${esc(rest)}</span>` : ""}`;
  } else if (named) {
    metaText = joinMeta(showName, "not available right now");
    metaHtml = `<span class="row__show">${esc(showName)}</span><span>not available right now</span>`;
  } else {
    metaText = "4a no longer has this episode's details";
    metaHtml = `<span>${esc(metaText)}</span>`;
  }
  const position = cur ? tactileIcon("needle", "sm") : esc(idx + 1);
  const inner = `${yoursArtHtml(named ? item : { id })}<span class="row__body"><span class="row__title">${esc(title)}</span><span class="row__meta">${metaHtml}</span></span>`;
  const main = playable
    ? `<button type="button" class="row-queue__main" data-action="${esc(yoursActionKey("play", id))}" aria-label="${esc(cur ? `Pause or resume: ${title}, ${metaText}` : `Play ${title}, ${metaText}`)}">${inner}</button>`
    : `<div class="row-queue__main">${inner}</div>`;
  return `<li class="yours-qwrap" data-queue-id="${esc(id)}">
    <article class="row-queue${cur ? " is-current" : ""}"${cur ? ' aria-current="true"' : ""}>
      <span class="row-queue__position readout">${position}</span>
      ${main}
      <button type="button" class="iconbtn" data-action="${esc(yoursActionKey("more", id))}" aria-expanded="${open ? "true" : "false"}" aria-label="${esc(`More for ${title}`)}"${open ? ` aria-controls="yours-tools-${esc(idx)}"` : ""}>${tactileIcon("ph-dots-three")}</button>
    </article>${open ? yoursActionsHtml(r, idx, total, rows) : ""}
  </li>`;
}

function yoursQueueInner(rows) {
  if (!rows.length) return `<p class="note">Nothing in Up Next yet — add an episode from any row's "+ Up Next" button.</p>`;
  const openId = rows.some((r) => r.id === state.yoursOpenRow) ? state.yoursOpenRow : null;
  const clearable = rows.filter((r) => !yoursIsCurrent(r.id)).length;
  const head = `<div class="yours-qhead"><span class="label yours-qlabel">Plays in this order</span>${clearable ? tactileKeycap({ size: "sm", variant: "paper", text: "Clear", label: "Clear Up Next", action: "clear" }) : ""}</div>`;
  return `${head}<ol class="yours-queue" aria-label="Up Next">${rows.map((r, i) => yoursQueueRowHtml(r, i, rows.length, rows, openId)).join("")}</ol>`;
}

/** The sum of the queued episodes' lengths, in minutes. */
function yoursQueueMinutes(rows) {
  return rows.reduce((sum, r) => sum + (r.state === "unnamed" ? 0 : episodeMinutes(r.item)), 0);
}

/* ---------- repaint: the page is a live view of cp_queue ---------- */

let yoursReadouts = {};

/** The strip and the readout, after anything that changes the badge or the Up
    Next numbers. The strip is rebuilt (the check icon and the badge are
    markup); its listeners are delegated on the strip, so nothing is rebound. */
function paintYoursChrome(rows) {
  const queued = rows.length;
  yoursReadouts.upnext = yoursReadoutText("upnext", { queued, minutes: yoursQueueMinutes(rows) });
  const active = yoursActiveKey(queued);
  const strip = $("#yours-chips");
  if (strip) {
    const had = document.activeElement && typeof document.activeElement.getAttribute === "function"
      ? document.activeElement.getAttribute("data-yours-chip") : null;
    strip.innerHTML = yoursChipsHtml(active, queued);
    if (had) focusQuietly(strip.querySelector(`[data-yours-chip="${had}"]`));
  }
  const readout = $("#yours-readout");
  setStatusText(readout, yoursReadouts[active] || "");
}

function yoursRowTops(panel) {
  const tops = new Map();
  if (!panel || typeof panel.querySelectorAll !== "function") return tops;
  panel.querySelectorAll(".yours-qwrap").forEach((el) => {
    const box = typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : null;
    if (box && Number.isFinite(box.top)) tops.set(el.dataset.queueId, box.top);
  });
  return tops;
}

/** FLIP. Rows that kept their id are put back where they were with a
    translateY, then released to their new place on `--spring-settle`. Only
    `transform` moves: a removal closes the gap by sliding the rows under it up,
    never by animating a height. The class that carries the transition is added
    after the first write has been flushed, so the jump to the old place does
    not itself animate. A row that was not there before (an undone removal)
    simply appears. */
function yoursFlip(panel, from) {
  if (!from || !from.size || !panel || typeof panel.querySelectorAll !== "function") return;
  const moved = [];
  panel.querySelectorAll(".yours-qwrap").forEach((el) => {
    const was = from.get(el.dataset.queueId);
    if (was == null || typeof el.getBoundingClientRect !== "function" || !el.style) return;
    const dy = was - el.getBoundingClientRect().top;
    if (!dy) return;
    el.style.transform = `translateY(${dy}px)`;
    moved.push(el);
  });
  if (!moved.length) return;
  if (typeof reflow === "function") reflow(moved[0]);
  const release = () => moved.forEach((el) => {
    el.classList.add("is-flipping");
    el.style.transform = "";
    const done = () => el.classList.remove("is-flipping");
    if (typeof el.addEventListener === "function") el.addEventListener("transitionend", done, { once: true });
    setTimeout(done, 400);
  });
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(release); else release();
}

/** Which control had focus, by its data-action, so a repaint that replaced it
    can put focus back on the same control for the same episode. */
function yoursFocusBefore(panel) {
  const active = document.activeElement;
  if (!active || typeof active.getAttribute !== "function" || !panel || typeof panel.contains !== "function" || !panel.contains(active)) return null;
  const key = active.getAttribute("data-action");
  if (!key) return null;
  const all = typeof panel.querySelectorAll === "function" ? [...panel.querySelectorAll("[data-action]")] : [];
  const li = typeof active.closest === "function" ? active.closest(".yours-qwrap") : null;
  const lis = typeof panel.querySelectorAll === "function" ? [...panel.querySelectorAll(".yours-qwrap")] : [];
  return { key, index: Math.max(0, all.indexOf(active)), row: Math.max(0, lis.indexOf(li)) };
}

function yoursFocusAfter(panel, held) {
  if (!held || !panel || typeof panel.querySelectorAll !== "function") return;
  const all = [...panel.querySelectorAll("[data-action]")];
  let target = all.find((b) => b.getAttribute("data-action") === held.key);
  /* Move up on the row that has just reached the top is disabled: the other
     arrow of the same episode is where the finger was. */
  if (!target || target.disabled) {
    const at = held.key.indexOf(":");
    const verb = held.key.slice(0, at);
    const id = held.key.slice(at + 1);
    const sibling = verb === "up" ? "down" : verb === "down" ? "up" : "more";
    target = all.find((b) => b.getAttribute("data-action") === yoursActionKey(sibling, id) && !b.disabled);
  }
  /* The row itself left (Remove): the ⋯ of the row that took its place, or the
     one above it when that was the last row. */
  if (!target) {
    const mores = all.filter((b) => (b.getAttribute("data-action") || "").startsWith("more:"));
    target = mores[Math.min(held.row, mores.length - 1)] || null;
  }
  if (!target) target = $("#view h2");
  focusQuietly(target);
}

/** Repaint the Up Next panel in place. Called by `repaintQueuePage` (app.js)
    after every write to cp_queue and every playback move while #/library is the
    page. Returns whether there was a panel to paint. */
function repaintYoursQueue() {
  /* The whole-screen empty state has no Up Next panel. The first thing queued
     (from the Now Playing sheet, say) ends it: paint the page again, with the
     listener's chip kept. */
  if ($("#yours-panel-empty")) {
    if (queueRows().length) renderLibrary();
    return true;
  }
  const panel = $("#yours-panel-upnext");
  if (!panel) return false;
  const held = yoursFocusBefore(panel);
  const from = yoursRowTops(panel);
  const rows = queueRows();
  if (state.yoursOpenRow && !rows.some((r) => r.id === state.yoursOpenRow)) state.yoursOpenRow = null;
  panel.innerHTML = yoursQueueInner(rows);
  yoursFlip(panel, from);
  paintYoursChrome(rows);
  yoursFocusAfter(panel, held);
  return true;
}

/* ---------- actions ---------- */

async function yoursPlay(id) {
  const item = liveEpisode(id) || state.itemIndex[id] || episode(id);
  if (!item || !window.ForayPlayer) return;
  /* The same rule as every row's play: a row showing the player's own item
     pauses or resumes it, anything else starts, and `UP_NEXT_CTX` is what moves
     the pressed row to the top. */
  if (window.ForayPlayer.isCurrent?.(id)) {
    await window.ForayPlayer.togglePlayback();
    return;
  }
  await startEpisodePlay(id, item, { ctx: UP_NEXT_CTX, list: [] });
}

/** ⋯ opens the 48px action row under its own row, or closes it. One row is
    open at a time. It goes through the same repaint as a queue write, so the
    rows below slide down by FLIP on `--spring-settle` (the gap opening) and
    the pressed ⋯ keeps focus. */
function yoursToggleActions(id) {
  state.yoursOpenRow = state.yoursOpenRow === id ? null : id;
  repaintYoursQueue();
}

function yoursMove(id, dir) {
  moveQueueItem(id, dir);
  const ids = queueIds();
  const pos = ids.indexOf(id) + 1;
  if (pos > 0) announce(`Moved to position ${pos} of ${ids.length}.`);
}

/** Remove, with four seconds to take it back. The removal is written at once
    (the list, the badge and the readout tick down together); Undo writes the
    id back at the place it left. */
function yoursRemove(id) {
  const ids = queueIds();
  const index = ids.indexOf(id);
  if (index < 0) return;
  removeFromQueue(id);
  showYoursUndo({ id, index });
  announce(ids.length > 1 ? "Removed from Up Next. Undo is available for four seconds." : "Removed from Up Next. Up Next is empty. Undo is available for four seconds.");
}

let yoursUndo = null;

function yoursToastHost() {
  let host = $("#yours-toast");
  if (host) return host;
  host = document.createElement("div");
  host.id = "yours-toast";
  host.className = "deck-toast yours-toast";
  host.innerHTML = tactileToast({ text: "Removed from Up Next", action: "Undo" });
  document.body.appendChild(host);
  const toast = host.querySelector(".toast");
  const undo = host.querySelector(".textbtn");
  if (undo) undo.addEventListener("click", () => undoYoursRemove());
  /* Held while touched: the clock stops on a press and runs again, with what
     was left of it, on release. */
  if (toast) {
    toast.addEventListener("pointerdown", () => pauseYoursUndo());
    toast.addEventListener("pointerup", () => resumeYoursUndo());
    toast.addEventListener("pointercancel", () => resumeYoursUndo());
  }
  return host;
}

function showYoursUndo(entry) {
  if (yoursUndo) clearTimeout(yoursUndo.timer);
  const host = yoursToastHost();
  yoursUndo = { ...entry, left: YOURS_UNDO_MS, started: Date.now(), timer: null };
  tactileSetToast(host.querySelector(".toast"), true);
  yoursUndo.timer = setTimeout(hideYoursUndo, YOURS_UNDO_MS);
}

function pauseYoursUndo() {
  if (!yoursUndo || yoursUndo.timer == null) return;
  clearTimeout(yoursUndo.timer);
  yoursUndo.timer = null;
  yoursUndo.left = Math.max(0, yoursUndo.left - (Date.now() - yoursUndo.started));
}

function resumeYoursUndo() {
  if (!yoursUndo || yoursUndo.timer != null) return;
  yoursUndo.started = Date.now();
  yoursUndo.timer = setTimeout(hideYoursUndo, yoursUndo.left);
}

function hideYoursUndo() {
  if (yoursUndo) clearTimeout(yoursUndo.timer);
  yoursUndo = null;
  const host = $("#yours-toast");
  if (host) tactileSetToast(host.querySelector(".toast"), false);
}

function undoYoursRemove() {
  const entry = yoursUndo;
  if (!entry) return false;
  hideYoursUndo();
  const ids = queueIds();
  if (ids.includes(entry.id)) return false;
  ids.splice(Math.min(entry.index, ids.length), 0, entry.id);
  saveQueueIds(ids);
  /* After the id is back in the list, so the snapshot prune keeps it. */
  rememberEpisode(entry.id);
  logEvent("queued", { episode_id: entry.id });
  announce("Put back in Up Next.");
  const panel = $("#yours-panel-upnext");
  focusQuietly(panel && panel.querySelector(`[data-action="${yoursActionKey("more", entry.id)}"]`));
  return true;
}

/** Clear is asked first: a sheet with the count, "Clear" and "Keep". It is the
    app's own modal (focus moves in, Tab stays in, Escape and the scrim close
    it, focus goes back to the key that opened it), dressed as the Tactile
    sheet. What is playing stays, as `clearQueue` has always done. */
function openYoursClearSheet() {
  if ($("#yours-clear-sheet")) return;
  const playing = currentPlayingId();
  const rows = queueRows();
  const n = rows.filter((r) => r.id !== playing).length;
  if (!n) return;
  const keeps = rows.some((r) => r.id === playing) ? " What is playing stays." : "";
  const holder = document.createElement("div");
  holder.innerHTML = `<div class="yours-scrim" id="yours-clear-scrim"></div>${tactileSheet({
    id: "yours-clear-sheet", closeId: "yours-clear-close", title: "Clear Up Next?",
    copy: `This removes ${countLabel(n, "episode")} from Up Next.${keeps}`, primary: "Clear", secondary: "Keep",
  })}`;
  const scrim = holder.firstElementChild;
  const sheet = holder.lastElementChild;
  document.body.appendChild(scrim);
  document.body.appendChild(sheet);
  const opener = document.activeElement;
  const shut = () => {
    closeSheet(sheet, { removeIfOwned: true });
    if (scrim.remove) scrim.remove();
    if (!document.activeElement || document.activeElement === document.body) {
      focusQuietly($("#yours-panel-upnext [data-action=\"clear\"]") || (opener && opener.isConnected !== false ? opener : null) || $("#view h2"));
    }
  };
  openSheet(sheet, { onRequestClose: shut, keepReachable: ["#yours-clear-scrim"], returnFocus: opener && opener.isConnected !== false ? opener : null });
  const primary = sheet.querySelector(".keycap");
  const secondary = sheet.querySelector(".sheet__actions .textbtn");
  const close = sheet.querySelector(".sheet__close");
  scrim.addEventListener("click", shut);
  if (close) close.addEventListener("click", shut);
  if (secondary) secondary.addEventListener("click", shut);
  if (primary) {
    primary.addEventListener("click", () => {
      const removed = clearQueue();
      shut();
      announce(removed === 1 ? "Removed 1 episode from Up Next." : `Removed ${removed} episodes from Up Next.`);
      focusQuietly($("#view h2"));
    });
  }
}

function onYoursQueueClick(e) {
  const hit = e && e.target && typeof e.target.closest === "function" ? e.target.closest("[data-action]") : null;
  if (!hit || hit.disabled) return;
  const raw = hit.getAttribute("data-action") || "";
  const at = raw.indexOf(":");
  const verb = at < 0 ? raw : raw.slice(0, at);
  const id = at < 0 ? "" : raw.slice(at + 1);
  if (typeof e.preventDefault === "function") e.preventDefault();
  if (verb === "play") yoursPlay(id);
  else if (verb === "more") yoursToggleActions(id);
  else if (verb === "up") yoursMove(id, -1);
  else if (verb === "down") yoursMove(id, 1);
  else if (verb === "rm") yoursRemove(id);
  else if (verb === "clear") openYoursClearSheet();
}

/* ---------- chips ---------- */

/** The chosen chip, wholly in view, the strip snapped to a chip edge. A strip
    wider than the screen opens at its left end, and "Up Next", the chip the page
    opens on, is the fifth of six. The strip is scrolled from its left end just
    far enough to bring the chosen chip inside the right gutter, then on until
    the chip the left edge has cut is gone and the one after it starts at the
    gutter (the fade would show the cut chip as a sliver). What is left over on
    the right is the chips that do not fit; the last of them runs into the right
    fade, so the strip says it goes on. The prototype's fitChip, ported, with
    its single step made a snap to the next chip. Nothing to do where the strip
    does not scroll. */
function fitYoursChip(strip) {
  if (!strip || typeof strip.querySelector !== "function") return;
  const chip = strip.querySelector('[aria-selected="true"]');
  if (!chip || !(strip.clientWidth > 0)) return;
  const gutter = 16;
  strip.scrollLeft = 0;
  const edge = strip.getBoundingClientRect();
  const sel = chip.getBoundingClientRect();
  if (sel.right > edge.right - gutter) strip.scrollLeft += sel.right - (edge.right - gutter);
  const chips = Array.from(strip.querySelectorAll(".chip"));
  for (let i = 0; i < chips.length; i++) {
    const box = chips[i].getBoundingClientRect();
    if (box.left < edge.left + gutter - 1 && box.right > edge.left) {
      const next = chips[i + 1] && chips[i + 1] !== chip ? chips[i + 1].getBoundingClientRect() : null;
      strip.scrollLeft += next ? next.left - edge.left - gutter : box.right - edge.left + 2;
    }
  }
}

/** Show one panel. No render: hide the others, move the check and the roving
    tabindex, say the new count. */
function selectYoursChip(key, { focus = false } = {}) {
  const keys = yoursChipDefs().map((c) => c.key);
  if (!keys.includes(key)) return;
  state.yoursChip = key;
  const panels = typeof $("#view").querySelectorAll === "function" ? [...$("#view").querySelectorAll(".yours-panel")] : [];
  const emptyPanel = $("#yours-panel-empty");
  if (emptyPanel) emptyPanel.setAttribute("aria-labelledby", `yours-chip-${key}`);
  else panels.forEach((p) => { p.hidden = p.id !== `yours-panel-${key}`; });
  const queued = queueIds().length;
  const strip = $("#yours-chips");
  if (strip) strip.innerHTML = yoursChipsHtml(key, queued);
  const readout = $("#yours-readout");
  setStatusText(readout, yoursReadouts[key] || "");
  const chip = strip && strip.querySelector(`[data-yours-chip="${key}"]`);
  if (chip) {
    if (focus) focusQuietly(chip);
    fitYoursChip(strip);
  }
}

function bindYoursChips(strip) {
  if (!strip || strip._bound) return;
  strip._bound = true;
  strip.addEventListener("click", (e) => {
    const hit = e.target && typeof e.target.closest === "function" ? e.target.closest("[data-yours-chip]") : null;
    if (hit) selectYoursChip(hit.getAttribute("data-yours-chip"), { focus: true });
  });
  /* The tab pattern: the arrows, Home and End move between chips and choose
     as they go; only the chosen one is in the Tab order. */
  strip.addEventListener("keydown", (e) => {
    const keys = yoursChipDefs().map((c) => c.key);
    const hit = e.target && typeof e.target.closest === "function" ? e.target.closest("[data-yours-chip]") : null;
    if (!hit) return;
    const at = keys.indexOf(hit.getAttribute("data-yours-chip"));
    let to = -1;
    if (e.key === "ArrowRight") to = (at + 1) % keys.length;
    else if (e.key === "ArrowLeft") to = (at - 1 + keys.length) % keys.length;
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = keys.length - 1;
    if (to < 0) return;
    if (typeof e.preventDefault === "function") e.preventDefault();
    selectYoursChip(keys[to], { focus: true });
  });
}

/** The knob opens the drawer (Settings, until the Settings screen lands) like
    the topbar's ☰, which this page hides. The drawer hands focus back to the ☰
    when it closes, and a hidden ☰ cannot take it, so the knob takes it. */
function bindYoursKnob(knob) {
  if (!knob || knob._bound) return;
  knob._bound = true;
  knob.setAttribute("aria-controls", "drawer");
  knob.setAttribute("aria-expanded", "false");
  knob.addEventListener("click", () => {
    openDrawer(!drawerIsOpen());
    knob.setAttribute("aria-expanded", drawerIsOpen() ? "true" : "false");
  });
  /* One watcher at a time: the page is painted again for many reasons, and each
     paint makes a new knob. The old watcher is let go with the old knob. */
  const drawer = $("#drawer");
  if (yoursDrawerWatch) { yoursDrawerWatch.disconnect(); yoursDrawerWatch = null; }
  if (drawer && typeof MutationObserver === "function") {
    yoursDrawerWatch = new MutationObserver(() => {
      if (knob.isConnected === false) { if (yoursDrawerWatch) yoursDrawerWatch.disconnect(); yoursDrawerWatch = null; return; }
      knob.setAttribute("aria-expanded", drawerIsOpen() ? "true" : "false");
      if (!drawerIsOpen() && (!document.activeElement || document.activeElement === document.body)) focusQuietly(knob);
    });
    yoursDrawerWatch.observe(drawer, { attributes: true, attributeFilter: ["hidden"] });
  }
}

let yoursDrawerWatch = null;

function renderLibrary(chip) {
  setBodyClass("view-page");
  document.body.classList.add("view-yours");
  fullPool(); // populate itemIndex/poolIds so saved/history rows can play in-app

  /* Family Mode reaches Library too (data-integrity-4). An "unnamed" row has
     nothing in it to hide. */
  const family = (r) => r.state === "unnamed" || familyAllows(r.item);
  const allSavedRows = rowsForIds(Object.keys(savedMap()));
  const savedRows = allSavedRows.filter(family);
  const historyIds = pickedHistory().slice().reverse().slice(0, 20);
  const allHistoryRows = rowsForIds(historyIds);
  const historyRows = allHistoryRows.filter(family);
  /* WHAT FAMILY MODE HID IS SAID, NOT DENIED (round-3 review, L1). With every
     star filtered out the section said "Nothing saved yet", which is false:
     the stars exist and are only hidden. The show page says so
     (FAMILY_HIDES_NOTE); Library now does too, and counts a partial hide. */
  const familyHidNote = (hidden, what) => hidden > 0
    ? `<p class="note">Family mode is on, so ${hidden} ${what}${hidden === 1 ? " is" : "s are"} hidden.</p>`
    : "";
  const savedHidden = allSavedRows.length - savedRows.length;
  const historyHidden = allHistoryRows.length - historyRows.length;
  const allPlaylists = playlists();
  const queueList = queueRows();
  const followedNow = Object.keys(starredShowsMap()).length;
  const downloadsNow = state.downloadBridge && Object.values(downloadsValue().items).some((rec) => rec.status === "done");
  const forayProgressNow = window.ForayPlayer && state.forays ? forayProgressLabels().size : 0;
  const nothingYet = queueList.length === 0 && followedNow === 0 && allSavedRows.length === 0
    && allHistoryRows.length === 0 && allPlaylists.length === 0 && !downloadsNow && !forayProgressNow;

  const rowHtml = (r, i, ctx) => r.state === "live" ? epRow(r.item, i, ctx, -1) : archivedRow(r.item, i, ctx);
  // History's "unnamed" case (an id neither live in the pool nor covered by a
  // cp_saved snapshot) is real and common -- unlike Saved, a history entry was
  // never necessarily starred. archivedRow's "unnamed" copy ("Saved before 4a
  // kept episode details") is written for the saved/playlist snapshot path and
  // would misname what happened here, so History gets its own honest fallback
  // for that one state rather than reusing archivedRow's wording.
  const historyRowHtml = (r, i) => r.state === "unnamed"
    ? `<div class="ep-row gone"><div class="info"><div class="t">No longer available</div><div class="s">Previously played, no longer available</div></div></div>`
    : rowHtml(r, i, "library-history");

  const savedHtml = savedRows.length
    ? savedRows.map((r, i) => rowHtml(r, i, "library-saved")).join("") + familyHidNote(savedHidden, "saved episode")
    : savedHidden > 0
      ? familyHidNote(savedHidden, "saved episode")
      : `<p class="note">Nothing saved yet — tap ☆ on an episode to keep it here.</p>`;

  const historyHtml = historyRows.length
    ? historyRows.map((r, i) => historyRowHtml(r, i)).join("") + familyHidNote(historyHidden, "played episode")
    : historyHidden > 0
      ? familyHidNote(historyHidden, "played episode")
      : `<p class="note">No listening history yet — episodes you play show up here.</p>`;

  const playlistsHtml = allPlaylists.length
    ? allPlaylists.slice(0, 5).map(p =>
        libSummaryRow(`/${playlistRoute(p)}`, p.title, playlistLengthLabel(p))).join("")
      + (allPlaylists.length > 5 ? `<a class="lib-more" href="#/playlists">All ${allPlaylists.length} playlists ›</a>` : "")
    /* It said "build one from the home screen", and the builder left Home on
       2026-09-03 — the note named the one screen certain not to have it. It
       names the Create tab, and links there. */
    : `<p class="note">No playlists yet — <a href="#/create">build one on the Create tab</a>.</p>`;

  /* The counts the readout line quotes. Forays are unknown until the player
     module has loaded, and an unknown count is not zero. */
  const followedCount = Object.keys(starredShowsMap()).length;
  const forayCount = state.forays && window.ForayPlayer ? forayCards().length : null;
  const counts = { shows: followedCount, saved: savedRows.length, playlists: allPlaylists.length, history: historyRows.length, forays: forayCount };
  yoursReadouts = {};
  for (const c of yoursChipDefs()) yoursReadouts[c.key] = yoursReadoutText(c.key, counts);
  yoursReadouts.upnext = yoursReadoutText("upnext", { queued: queueList.length, minutes: yoursQueueMinutes(queueList) });

  if (typeof chip === "string" && yoursChipDefs().some((c) => c.key === chip)) state.yoursChip = chip;
  const active = yoursActiveKey(queueList.length, nothingYet);
  const inner = nothingYet ? null : {
    forays: libraryForaysHtml(),
    shows: libraryFollowedHtml(),
    saved: savedHtml,
    playlists: playlistsHtml,
    upnext: yoursQueueInner(queueList),
    downloads: state.downloadBridge ? libraryDownloadsHtml(family) : "",
    history: historyHtml,
  };

  $("#view").innerHTML = `
    <div class="page page--yours">
      <div class="page-head yours-head">
        <div>
          <h2 class="display-xl" aria-level="1">Yours</h2>
          <p class="readout yours-readout" id="yours-readout" aria-live="polite">${esc(yoursReadouts[active])}</p>
        </div>
        ${tactileKeycap({ size: "sm", variant: "paper", icon: "knob", label: "Settings and dials", id: "yours-knob" })}
      </div>
      <div class="yours-chips" id="yours-chips" role="tablist" aria-label="Yours">${yoursChipsHtml(active, queueList.length, nothingYet)}</div>
      <div class="yours-panels">
        ${nothingYet ? yoursEmptyPanelHtml(active) : yoursChipDefs().map((c) => yoursPanelHtml(c.key, active, inner[c.key])).join("")}
      </div>
    </div>`;

  bindYoursChips($("#yours-chips"));
  fitYoursChip($("#yours-chips"));
  bindYoursKnob($("#yours-knob"));
  const queuePanel = $("#yours-panel-upnext");
  if (queuePanel) queuePanel.addEventListener("click", onYoursQueueClick);

  bindPickLogging($("#view"));
  bindStars($("#view"));
  bindUpNext($("#view"));
  bindDownloads($("#view"));
  bindPlay($("#view"));

  /* A COLD OPEN BEFORE THE PLAYER MODULE (review 2026-09-23). The Forays
     section can only list once the player module is up, and the forayCards() header
     says every page that lists Forays must close that gap itself — as
     renderForays does. Nothing else repaints Library when the module lands. */
  if (!window.ForayPlayer && state.forays) {
    const isCurrentRender = renderToken();
    playerBridge().then(player => {
      if (player && isCurrentRender() && currentHash() === "#/library") renderCurrentPage();
    });
  }
}


/* THE LIST, AND ONE DOOR TO THE BUILDER (audit round 2, p-first-6; founder
   question 4, default taken): the `#pl-form` builder that lived here is gone —
   see the removal note above `bindPickLogging`. The empty state says the same
   sentence Library's does, and both point at Create. */
function renderPlaylists() {
  setBodyClass("view-page");
  const all = playlists();
  $("#view").innerHTML = `
    <div class="page">
      <div class="page-head">
        <a class="back" href="#/">‹</a>
        <div><h2>Playlists</h2>${all.length ? `<p class="sub">${countLabel(all.length, "playlist")}</p>` : ""}</div>
      </div>
      <a class="page-link-row" href="#/create">Build a playlist ›</a>
      ${all.length ? all.map(p => `
        <a class="pl-row" href="${esc(safeUrl("#/" + playlistRoute(p)))}">
          <div class="info">
            <div class="t">${esc(p.title)}</div>
            <div class="s">${joinMeta(playlistLengthLabel(p), playedOnLabel(p.last_played_at))}</div>
          </div>
          <span class="chev">›</span>
        </a>`).join("")
      : `<p class="note">No playlists yet — <a href="#/create">build one on the Create tab</a>.</p>`}
    </div>`;
}
