/* ui/playlist.js — Playlist detail (#/playlist/<id>, #/subject/<branch>) and the Playlists list (#/playlists).
   A CLASSIC script like app.js, not a module: it shares app.js's globals and
   is loaded by index.html after app.js, in the order listed in
   docs/redesign-2026/split-notes.md. Declarations only at the top level, so
   nothing here runs until app.js's boot (ui/boot.js) starts init(). */

/* ==================================================================== */
/* PLAYLISTS — Redesign 2026, ambient direction ("Afterglow"), phase 4.  */
/*                                                                      */
/* The prototype draws no playlist page, so this is built from the        */
/* component inventory (BUILD-NOTES §3: PlaylistTile, EpisodeRow,         */
/* EmptyState, Collage) and ui/playlist.css. Three pages:                 */
/*   detail   a composite cover (120, 2x2, never crops a square), the     */
/*            name, "<n> episodes, <h> hr <m> min", "3 of 6 played" in    */
/*            Ember once one has finished, then the episodes as           */
/*            EpisodeRows (96).                                           */
/*   list     2-up PlaylistTiles (164 wide at 393, 176 at 412).           */
/*   gone     an EmptyState: one line, one button.                        */
/*                                                                      */
/* WHAT THE EPISODE ROW IS HERE. It is Today's: the markup helpers        */
/* (todayArt, todayMetaHtml, todayPlayButton, todayRowState) and the      */
/* `.td-row` styles are the one EpisodeRow, so a playlist's row cannot    */
/* drift from Today's. What differs is the wiring: a row's Play plays     */
/* the PLAYLIST (ctx "playlist-<id>", the rows as the continuous-play     */
/* list, last_played_at stamped by startEpisodePlay).                     */
/*                                                                      */
/* RULINGS THIS SCREEN OVERTURNS, by name (test-classification.md §0):    */
/*   - "Card/row anatomy" on playlist pages: the numbered, three-control  */
/*     row (play, star, + Up Next) becomes the EpisodeRow, whose one      */
/*     control is Play. "Numbers mean order" goes with it: the next row   */
/*     is marked by the word "Next" in Lamp, not by a numbered circle.    */
/*     Save and + Up Next stay one tap away on the episode page, which    */
/*     the row's title opens.                                             */
/* WHAT IT KEEPS: "played" is the player's own verdict (rowProgress,      */
/* audit round 2 honesty-6), so the count above the rows cannot disagree  */
/* with what a row says; an archived part keeps its place and its count;  */
/* Family Mode hides what it hid; a generated playlist or subject queue   */
/* can be kept; a listener's own playlist can be removed.                 */
/* ==================================================================== */

/* The cover holds at most four artworks. */
const PL_COVERS_MAX = 4;

/** The distinct artworks of a playlist's episodes, up to four, in order. Distinct because a playlist of four episodes
    from one show is one picture, and a 2x2 of the same square four times says nothing; the collage's own rule
    (one art is the art, two or three overlap whole squares, four are a 2x2) then never crops a square. Family Mode's
    hidden parts show nothing of themselves, the cover included. */
function playlistCovers(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const it = r && r.item;
    if (!it || r.state === "hidden") continue;
    const src = it.artwork_url || "";
    const key = src || it.show || it.title || "";
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ name: it.show || it.title || "", src });
    if (out.length === PL_COVERS_MAX) break;
  }
  return out;
}

/** The playlist's runtime in minutes, or 0. All or nothing: a sum over rows some of which have no length is a
    shorter number than the truth, and a shorter number than the truth is worse than none. A part Family Mode holds
    back counts as unknown, for the reason the cover skips it. */
function playlistMinutes(rows) {
  if (!rows.length) return 0;
  let total = 0;
  for (const r of rows) {
    const m = r.state === "hidden" ? 0 : episodeMinutes(r.item || {});
    if (!(m > 0)) return 0;
    total += m;
  }
  return total;
}

/** "6 episodes, 2 hr 10 min", or "6 episodes" when the length is not known for every part. A comma, not a dot:
    BUILD-NOTES §3 PlaylistTile. */
function playlistSummary(rows) {
  const count = countLabel(rows.length, "episode");
  const min = playlistMinutes(rows);
  return min ? `${count}, ${fmtDur(min)}` : count;
}

/** The same line as two unbreakable halves ("6 episodes," and "2 hr 10 min"), so a narrow tile wraps at the comma and
    never strands "min" on a line of its own. The words are playlistSummary's; this only adds the break points. */
function playlistSummaryHtml(rows) {
  const count = countLabel(rows.length, "episode");
  const min = playlistMinutes(rows);
  return min
    ? `<span class="pl-nb">${esc(count)},</span> <span class="pl-nb">${esc(fmtDur(min))}</span>`
    : `<span class="pl-nb">${esc(count)}</span>`;
}

/** Has the listener finished this part? The player's verdict when it has one (rowProgress: state "played"), the history
    ring only while the player has not arrived. `hasOpened` is wider (any position at all) and is the NEXT marker's
    question, not this one's: a row 31 minutes from its end is not played. */
function playlistRowPlayed(r, history) {
  const item = r && r.item;
  if (!item || !item.id || r.state === "hidden") return false;
  const progress = rowProgress(item);
  return progress ? progress.state === "played" : history.has(item.id);
}

function playlistPlayedCount(rows, history) {
  return rows.filter(r => playlistRowPlayed(r, history)).length;
}

/** "3 of 6 played", or nothing: a zero is not a fact worth a line (audit round 2, copy-13). */
function playlistPlayedLine(rows, history) {
  const n = playlistPlayedCount(rows, history);
  return rows.length && n ? `${n} of ${rows.length} played` : "";
}

/** The cover: a Collage of the playlist's artworks, decorative (the name beside it says what it is). */
function playlistCoverHtml(rows, title, size) {
  const covers = playlistCovers(rows);
  return agCollage(covers.length ? covers : [{ name: title || "Playlist" }], { size });
}

/* ---------- the detail page's Foray-detail structure (iteration 2) ---------- */

/** The distinct shows of a playlist, in order of first appearance: the name, the artwork the episode carried, and the
    show page when the name joins one. Family Mode's hidden parts name nothing, so they add nothing. */
function playlistShows(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const it = r && r.item;
    if (!it || r.state === "hidden" || !it.show || seen.has(it.show)) continue;
    seen.add(it.show);
    let id = null;
    try { id = typeof showIdForShowName === "function" ? showIdForShowName(it.show) : null; } catch (_) { id = null; }
    out.push({ name: it.show, src: it.artwork_url || "", id: id || null });
  }
  return out;
}

/** The subject a playlist is mostly about, by the taxonomy's own label, or "". The most common root branch among its
    episodes (ties go to the one that appears first); an episode with no topics says nothing. */
function playlistSubject(rows) {
  const count = new Map();
  for (const r of rows) {
    const it = r && r.item;
    if (!it || r.state === "hidden" || !(it.topics && it.topics.length)) continue;
    const branch = String(it.topics[0]).split("/")[0];
    if (branch) count.set(branch, (count.get(branch) || 0) + 1);
  }
  let best = "";
  let bestN = 0;
  for (const [branch, n] of count) if (n > bestN) { best = branch; bestN = n; }
  return best ? subjectLabel(best) : "";
}

/** "Why 4a made this": only for the two playlists 4a built. A listener's own playlist has no authored line, because 4a
    did not make it. Each line says only what the builder did (subjectItemsForBranch, generatedPlaylistById). */
const PL_WHY_SUBJECT = "The newest episodes on this subject, gathered for today.";
const PL_WHY_GENERATED = "Built from one of your strongest subjects: the newest episodes, two at most from any show.";
function playlistWhy(p) {
  return p && p.isSubject ? PL_WHY_SUBJECT : (p && p.isGenerated ? PL_WHY_GENERATED : "");
}

/** The eyebrow, in Lamp: what the playlist is, then its subject when that is a different thing from its name
    (a subject queue's name IS the subject). */
function playlistEyebrow(p, rows, title) {
  const kind = p.isSubject ? "Picked for you" : (p.isGenerated ? "Generated for you" : "Playlist");
  const subject = playlistSubject(rows);
  return subject && subject.toLowerCase() !== String(title || "").toLowerCase() ? `${kind} · ${subject}` : kind;
}

/** Show name -> tone for the strip and its thumbnails: the Foray detail's own derivation (BUILD-NOTES 1.2). A page
    without that script gets no tones and the bars fall back to Text-3. */
function playlistTones(names) {
  try { return typeof forayTones === "function" ? forayTones(names) : new Map(); } catch (_) { return new Map(); }
}

/** One bar per episode that has a length, in order. Width follows the runtime (set through the CSSOM, below), colour the
    show. The strip is a map and not a control: a bar is a few px of colour, not a 44px target, so the page says in words
    what it shows and the rows below are the way in. */
function playlistStripEntries(rows) {
  return rows
    .map((r) => ({ r, min: r.state === "hidden" ? 0 : episodeMinutes(r.item || {}) }))
    .filter((e) => e.min > 0)
    .map((e) => ({ id: e.r.item.id || "", show: e.r.item.show || "", art: e.r.item.artwork_url || "", min: e.min }));
}

function playlistStripHtml(rows, history) {
  const entries = playlistStripEntries(rows);
  if (!entries.length) return "";
  const shows = new Set(entries.map((e) => e.show).filter(Boolean)).size;
  const label = `${countLabel(entries.length, "episode")}${shows ? ` from ${countLabel(shows, "show")}` : ""}, drawn by length`;
  /* The strip is drawn in its FINAL state: is-started and is-here are in the markup, not toggled on after the first style
     recalculation, because a class that flips an opacity after the bars have been styled is a 200ms transition (the
     reduced-motion gate counts it) and nothing here is meant to move at load. */
  const player = window.ForayPlayer;
  let started = false;
  const bars = entries.map((e) => {
    const played = playlistRowPlayed({ item: { id: e.id }, state: "live" }, history);
    let here = false;
    try { here = !!(player && player.isPlaying && player.isPlaying(e.id)); } catch (_) { here = false; }
    if (played || here) started = true;
    return `<span class="pl-bar${played ? " is-played" : ""}${here ? " is-here" : ""}" data-pl-bar="${esc(e.id)}" data-min="${esc(String(e.min))}" data-show="${esc(e.show)}"></span>`;
  }).join("");
  return `<div class="pl-sill" role="img" aria-label="${esc(label)}">
      <div class="pl-strip${started ? " is-started" : ""}" aria-hidden="true">${bars}</div>
      <div class="pl-thumbs" aria-hidden="true"></div>
    </div>`;
}

const PL_THUMB_MIN_BAR_PX = 12;
const PL_THUMB_PX = 20;
const PL_THUMB_GAP_PX = 4;
/** The thumbnails under a laid-out strip, the Foray detail's rule: a bar of 12px or more gets a 20px artwork under its left
    edge, if it starts clear of the last one (4px) and ends inside the strip. `bars` report offsetWidth and offsetLeft, in bar
    order; `entries` are { show, art } in the same order. Pure, so the rule is tested without a browser. */
function playlistThumbCells(entries, bars, stripWidth = Infinity) {
  const cells = [];
  let freeFrom = 0;
  bars.forEach((bar, i) => {
    const e = entries[i];
    if (!e || !e.show) return;
    if (!(bar.offsetWidth >= PL_THUMB_MIN_BAR_PX)) return;
    if (bar.offsetLeft < freeFrom || bar.offsetLeft + PL_THUMB_PX > stripWidth) return;
    freeFrom = bar.offsetLeft + PL_THUMB_PX + PL_THUMB_GAP_PX;
    const letter = String(e.show).trim().charAt(0).toUpperCase() || "?";
    cells.push({ x: bar.offsetLeft, show: e.show, html: e.art
      ? `<img src="${esc(safeUrl(artUrl(e.art, 60)))}" alt="" loading="lazy" decoding="async" width="20" height="20">`
      : `<span class="pl-thumb-mono">${esc(letter)}</span>` });
  });
  return cells;
}

/** A custom property written through the CSSOM (the CSP forbids a style attribute, not this). */
function playlistCssVar(el, name, value) {
  if (el && el.style && typeof el.style.setProperty === "function") el.style.setProperty(name, value);
}

/** Size and tint the bars, then lay the thumbnails under them. The widths are the runtimes; the tones are the shows'. The
    artwork for a thumbnail is read off the episode row the bar belongs to (one source for the picture); a bar whose
    row has none gets the show's initial. */
function playlistPaintStrip(scope, givenTones) {
  const strip = scope && typeof scope.querySelector === "function" ? scope.querySelector(".pl-strip") : null;
  if (!strip || !strip.children) return;
  const bars = [...strip.children];
  const tones = givenTones || playlistTones([...new Set(bars.map((b) => b.dataset.show).filter(Boolean))]);
  bars.forEach((bar) => {
    playlistCssVar(bar, "--w", String(Number(bar.dataset.min) || 1));
    const tone = tones.get(bar.dataset.show);
    if (tone) playlistCssVar(bar, "--seg-tone", tone);
  });
  const row = scope.querySelector(".pl-thumbs");
  if (!row || typeof strip.getBoundingClientRect !== "function") return;
  const art = new Map();
  scope.querySelectorAll("[data-pl-ep]").forEach((rowEl) => {
    const img = rowEl.querySelector(".ag-art img");
    if (img) art.set(rowEl.dataset.plEp, img.getAttribute("src") || "");
  });
  const entries = bars.map((b) => ({ show: b.dataset.show || "", art: art.get(b.dataset.plBar) || "" }));
  const cells = playlistThumbCells(entries, bars, strip.clientWidth || Infinity);
  row.innerHTML = cells.map((c) => `<span class="pl-thumb">${c.html}</span>`).join("");
  [...row.children].forEach((el, k) => {
    playlistCssVar(el, "--x", `${cells[k].x}px`);
    const tone = tones.get(cells[k].show);
    if (tone) playlistCssVar(el, "--tone", tone);
  });
}

/** "Where this came from": the shows' own artwork, three-up, the name whole under each. A show with a page is a link to it. */
function playlistCameHtml(rows) {
  const shows = playlistShows(rows);
  if (!shows.length) return "";
  const tiles = shows.map((s) => {
    const art = `<span class="pl-tile-art" aria-hidden="true">${agArtwork({ name: s.name, src: s.src, size: 104 })}</span>`;
    const name = `<span class="t-caption pl-show-name">${esc(s.name)}</span>`;
    const face = s.id
      ? `<a class="pl-show-face" href="#${esc(showRoutePath(s.id))}">${art}${name}</a>`
      : `<div class="pl-show-face">${art}${name}</div>`;
    return `<li class="pl-show">${face}</li>`;
  }).join("");
  return `<section class="pl-came" aria-labelledby="pl-came-head">
      <h2 class="t-headline" id="pl-came-head">Where this came from</h2>
      <ul class="pl-shows">${tiles}</ul>
    </section>`;
}

/* ---------- pieces ---------- */

/** The head: Back (the history-aware `a.back`; `route`, written after a literal "#/", is where it goes with no history
    to step back through), and an optional trailing control. */
function playlistTopHtml(route, trailing = "") {
  return `<header class="pl-top"><a class="back ag-btn ag-btn-icon" href="#/${esc(route)}" aria-label="Back">${agIcon("chevron-left", 24)}</a>${trailing}</header>`;
}

/** EmptyState (BUILD-NOTES §3): one line, one button (outlined, pill, 44). The button is a link to one of our own routes,
    written after a literal "#/" like every other in-app link. */
function playlistEmptyHtml(line, label, route) {
  return `<section class="ag-empty pl-empty"><p class="t-body">${esc(line)}</p><a class="ag-btn ag-btn-secondary ag-btn-size-44" href="#/${esc(route)}">${esc(label)}</a></section>`;
}

/** One PlaylistTile, three-up (iteration 2: the direction's art grids are 3-up so a name never cuts): the lit cover, the name
    in full (caption, never clamped), the length line, and "3 of 6 played" in Ember when one has finished. The whole tile is
    the link. No card around it: a 3-up tile is art and words, like a ShowTile. */
function playlistTileHtml(p, history) {
  const rows = resolveParts(p);
  const played = playlistPlayedLine(rows, history);
  /* One "played" line per tile: the count when one has finished, else the day it was last played ("played Sep 21, 2026",
     through fmtDate, and nothing at all for a date that does not parse). */
  const last = played ? "" : playedOnLabel(p.last_played_at);
  return `<a class="pl-tile" href="#/${esc(playlistRoute(p))}" data-pl-tile="${esc(p.id)}">
    <span class="pl-tile-cover" aria-hidden="true">${playlistCoverHtml(rows, p.title, 104)}</span>
    <h2 class="t-caption pl-tile-name">${esc(p.title || "Playlist")}</h2>
    <p class="t-caption num pl-tile-meta">${playlistSummaryHtml(rows)}</p>
    ${played ? `<p class="t-caption num ag-progress-copy pl-tile-played">${esc(played)}</p>` : (last ? `<p class="t-caption pl-tile-last">${esc(last)}</p>` : "")}
  </a>`;
}

/** An episode row's Play: a Phosphor glyph on the 24px grid in a 44px target, no ring and no fill (the direction has no
    hairline borders, and the Ember hero Play is the one filled control). Pause when it is playing. */
function playlistRowPlayHtml({ label, attrs = "", disabled = false, icon = "play" }) {
  return `<button type="button" class="ag-btn ag-btn-play ag-btn-size-44 pl-row-play"${attrs} aria-label="${esc(label)}"${disabled ? ' disabled aria-disabled="true"' : ""}>${agIcon(icon, 24)}</button>`;
}

/** The row's second line: the state, the show (whole, it wraps rather than cutting), then the length and the day. The dot
    after the show trails it, so a line that wraps starts with a word and never with a dot. */
function playlistMetaHtml(rowState, item) {
  const dur = fmtDur(episodeMinutes(item));
  const date = rowState === "default" ? fmtDate(item.release_date || item.published_at) : "";
  const facts = [dur ? `<span class="dur">${esc(dur)}</span>` : "", date ? `<span>${esc(date)}</span>` : ""].filter(Boolean);
  return `${todayStateLine(rowState)}<span class="pl-show-line">${esc(item.show || "")}</span>${facts.length ? `<span class="pl-facts">${facts.join('<span class="td-sep" aria-hidden="true"></span>')}</span>` : ""}`;
}

/** One EpisodeRow of the detail page, by the state resolveParts gave the part. */
function playlistRowHtml(r, ctx, isNext) {
  const item = r.item || {};
  if (r.state === "live") {
    const rowState = todayRowState(item);
    const pct = todayEpisodePct(item);
    const id = esc(encodeURIComponent(item.id));
    const playing = rowState === "playing";
    const blocked = rowState === "unavailable";
    const why = item.hook || episodeRowSnippet(item);
    const next = isNext && rowState === "default" ? `<span class="ag-row-state pl-next">Next</span>` : "";
    /* The title and the why-line carry no clamp: a vertical list is where a title never cuts, and the why-line is the
       product's main copy (iteration 2). The row grows with its words, from the 96 floor. */
    return `<article class="raised td-row pl-ep is-${esc(rowState)}" data-pl-ep="${esc(item.id)}">
    ${todayArt({ name: item.show, src: item.artwork_url, size: 72, dim: blocked, pct })}
    <h3 class="t-headline td-row-title"><a class="td-link" href="#/episode/${id}" data-ev="picked" data-ep="${esc(item.id)}" data-ctx="${esc(ctx)}">${esc(item.title || "")}</a></h3>
    ${item.audio_url ? playlistRowPlayHtml({ label: `${playing ? "Pause" : "Play"} ${item.title || "this episode"}`, attrs: ` data-pl-play="${esc(item.id)}" data-title="${esc(item.title || "")}"`, disabled: blocked, icon: playing ? "pause" : "play" }) : ""}
    <p class="t-caption td-row-meta">${next}${playlistMetaHtml(rowState, item)}</p>
    ${why ? `<p class="t-why td-row-why">${esc(why)}</p>` : ""}
  </article>`;
  }
  if (r.state === "archived") {
    /* The part is in the playlist and not in the catalogue: its place and its count stay (the length above the rows
       is true), its art dims, it says Unavailable and carries no Play. Its title still opens the episode page, which
       draws from the snapshot seeded below. */
    const id = esc(encodeURIComponent(item.id));
    const dur = fmtDur(episodeMinutes(item));
    /* The publish date a part stored (PLAYLIST_PART_FIELDS) is what is left to say about it; it has the why-line's slot,
       because the meta line gives its date up to the state (Today's rule for any row that carries a state line). */
    const date = fmtDate(item.release_date);
    return `<article class="raised td-row pl-ep is-unavailable" data-pl-gone="archived">
    ${todayArt({ name: item.show, src: item.artwork_url, size: 72, dim: true })}
    <h3 class="t-headline td-row-title"><a class="td-link" href="#/episode/${id}">${esc(item.title || "")}</a></h3>
    <p class="t-caption td-row-meta">${todayStateLine("unavailable")}<span class="pl-show-line">${esc(item.show || "")}</span>${dur ? `<span class="pl-facts"><span class="dur">${esc(dur)}</span></span>` : ""}</p>
    ${date ? `<p class="t-caption td-row-why">Published ${esc(date)}</p>` : ""}
  </article>`;
  }
  if (r.state === "hidden") {
    return `<article class="raised td-row pl-ep is-unavailable" data-pl-gone="hidden">
    ${todayArt({ name: "", src: "", size: 72, dim: true })}
    <h3 class="t-headline td-row-title">Hidden by Family Mode</h3>
    <p class="t-caption td-row-meta">${todayStateLine("unavailable")}</p>
    <p class="t-why td-row-why">Turn Family Mode off to see and play it.</p>
  </article>`;
  }
  return `<article class="raised td-row pl-ep is-unavailable" data-pl-gone="unnamed">
    ${todayArt({ name: "", src: "", size: 72, dim: true })}
    <h3 class="t-headline td-row-title">Episode no longer in the catalogue</h3>
    <p class="t-caption td-row-meta">${todayStateLine("unavailable")}</p>
    <p class="t-why td-row-why">Saved before 4a kept episode details.</p>
  </article>`;
}

/* ---------- behaviour ---------- */

/** Glow: the page is lit by the playlist's first show, the way Today is lit by its hero's. The wash and the cover's own
    light read it; both are written through the CSSOM (the CSP forbids a style attribute, not this). */
function playlistApplyGlow(scope) {
  if (!scope || typeof scope.querySelector !== "function") return;
  const wash = scope.querySelector(".pl-wash");
  if (!wash || !wash.dataset || !wash.dataset.glowShow) return;
  agSetGlow(wash, wash.dataset.glowShow);
  const cover = scope.querySelector(".pl-cover .ag-collage");
  if (cover) agSetGlow(cover, wash.dataset.glowShow, "--art-glow");
}

/** Repaint every row's playing state from the player (the single authority), and the hero Play's glyph and name. */
function playlistSyncPlay() {
  const scope = document.querySelector(".pl-detail");
  const player = window.ForayPlayer;
  if (!scope || !player || typeof scope.querySelectorAll !== "function") return;
  let anyPlaying = false;
  scope.querySelectorAll("[data-pl-ep]").forEach(row => {
    const id = row.dataset.plEp;
    let on = false;
    try { on = !!player.isPlaying?.(id); } catch (_) { on = false; }
    if (on) anyPlaying = true;
    if (row.classList.contains("is-playing") === on) return;
    row.classList.toggle("is-playing", on);
    const btn = row.querySelector("[data-pl-play]");
    const meta = row.querySelector(".td-row-meta");
    if (btn) {
      btn.setAttribute("aria-label", `${on ? "Pause" : "Play"} ${btn.dataset.title || "this episode"}`);
      btn.innerHTML = agIcon(on ? "pause" : "play", 24);
    }
    if (meta) {
      /* The state line is the one `.ag-row-state` that is not the "Next" marker. */
      const line = [...meta.querySelectorAll(".ag-row-state")].find(el => !el.classList.contains("pl-next"));
      if (line) line.remove();
      if (on) meta.insertAdjacentHTML("afterbegin", todayStateLine("playing"));
    }
  });
  /* The strip follows the player too: the bar of the episode that is playing is the taller one, and the strip dims what is
     still ahead once the listener is anywhere in the playlist. */
  const strip = scope.querySelector(".pl-strip");
  if (strip && typeof strip.querySelectorAll === "function") {
    const playingId = anyPlaying ? (scope.querySelector(".pl-ep.is-playing") || {}).dataset?.plEp : "";
    strip.querySelectorAll("[data-pl-bar]").forEach(bar => bar.classList.toggle("is-here", !!playingId && bar.dataset.plBar === playingId));
    strip.classList.toggle("is-started", anyPlaying || !!strip.querySelector(".is-played"));
  }
  const hero = scope.querySelector("[data-pl-playall]");
  if (hero) {
    const name = hero.dataset.title || "this playlist";
    hero.setAttribute("aria-label", `${anyPlaying ? "Pause" : "Play"} ${name}`);
    hero.innerHTML = agIcon(anyPlaying ? "pause" : "play", 28);
  }
}

let playlistPollTimer = null;
function playlistStartPoll() {
  if (playlistPollTimer || typeof setInterval !== "function") return;
  playlistPollTimer = setInterval(() => {
    if (!document.querySelector(".pl-detail")) { clearInterval(playlistPollTimer); playlistPollTimer = null; return; }
    playlistSyncPlay();
  }, 1000);
}

/** A row's Play: the playlist's own play. A row showing Pause pauses (the rule bindPlay learned, founder 2026-09-22);
    otherwise the press starts that episode with the page's rows as the continuous-play list under the playlist's ctx,
    which is also what stamps a real playlist's `last_played_at`. */
async function playlistPlayPress(btn, scope) {
  const id = btn.dataset.plPlay;
  const player = window.ForayPlayer;
  const item = liveEpisode(id) || state.itemIndex[id] || episode(id);
  if (!item || !player) return;
  if (player.isCurrent?.(id)) { await player.togglePlayback(); playlistSyncPlay(); return; }
  const ctx = scope.dataset.plCtx || null;
  const row = btn.closest("[data-pl-ep]");
  const art = row ? row.querySelector(".ag-art") : null;
  todayGlowTo(item.show);
  const list = [...scope.querySelectorAll("[data-pl-play]")].filter(b => !b.disabled).map(b => ({ id: b.dataset.plPlay, ctx }));
  const ok = await startEpisodePlay(id, item, { ctx, list });
  playlistSyncPlay();
  if (ok) todayFlipToMini(art, scope);
}

/** The hero Play: pauses what this playlist is playing, else plays the next part (the first one not yet opened; from the
    top when all are). */
function playlistPlayAllPress(scope) {
  const playing = scope.querySelector(".pl-ep.is-playing [data-pl-play]");
  const nextRow = [...scope.querySelectorAll("[data-pl-ep]")].find(row => row.dataset.plEp === scope.dataset.plNext);
  const next = nextRow ? nextRow.querySelector("[data-pl-play]") : null;
  const target = playing || (next && !next.disabled ? next : null)
    || [...scope.querySelectorAll("[data-pl-play]")].find(b => !b.disabled);
  if (target) playlistPlayPress(target, scope);
}

function bindPlaylistPlay(scope) {
  if (!scope || typeof scope.querySelectorAll !== "function") return;
  scope.querySelectorAll("[data-pl-play]").forEach(btn => {
    if (btn._bound) return;
    btn._bound = true;
    btn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); playlistPlayPress(btn, scope); });
  });
  const hero = scope.querySelector("[data-pl-playall]");
  if (hero && !hero._bound) {
    hero._bound = true;
    hero.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); playlistPlayAllPress(scope); });
  }
}

/* ---------- Playlist detail ---------- */

function renderPlaylistDetail(id) {
  setBodyClass("view-playlist");
  const p = playlistById(id) || subjectQueueById(id) || generatedPlaylistById(id);
  /* A gone playlist still gets a real page head, Back included: with Back going one real step (see § in-app history)
     instead of always Home, an entry for a just-removed playlist sits one step behind the Playlists list, so landing
     here with no Back at all would be a dead end for whoever tapped a now-stale link. The heading is for the router and
     for a screen reader (focus lands on it, and it is what is announced); the page SHOWS an EmptyState, one line and one
     button. */
  if (!p) {
    $("#view").innerHTML = `<div class="ag pl-page pl-gone">
      ${playlistTopHtml("playlists")}
      <h1 class="sr-only" data-page-heading>Playlist not found</h1>
      ${playlistEmptyHtml("That playlist isn’t here any more.", "All playlists", "playlists")}
    </div>`;
    return;
  }
  fullPool(); // populate itemIndex
  const rows = resolveParts(p);
  /* An archived part goes into the snapshot cache under its own id so the rest of
     the app can describe it: without this, starring one is a no-op (toggleStar
     needs a snapshot) and a `picked` from one reports no topics.

     This is safe ONLY because liveness is liveEpisode(), not "is in itemIndex":
     a part carries no audio_url, so a seeded part cannot read as playable.
     While it was the latter, this loop was the bug: it taught the cache the id, and
     the next render of the same playlist called the part live again. The absence
     check is kept because the pool's copy is always the better one, and a second
     render must not replace a full snapshot with a partial. */
  for (const r of rows) {
    if (r.state === "archived" && !state.itemIndex[r.item.id]) state.itemIndex[r.item.id] = r.item;
  }
  const history = new Set(pickedHistory());
  const played = playlistPlayedCount(rows, history);
  /* The NEXT part is the first one that can be opened and that the listener has not touched: `hasOpened` (history OR any
     stored position), so it cannot regress when the 200-entry history ring rotates (audit 2026-09-22). That is wider
     than "played" on purpose: next is where a fresh start goes, played is a count. With every part opened there is no
     "next", and the hero Play starts from the top. */
  const nextRow = rows.find(r => r.state === "live" && !hasOpened(r.item.id, history));
  const nextId = nextRow ? nextRow.item.id : "";
  const ctx = playlistCtx(p);
  /* A generated playlist or a subject queue can be kept (savePlaylistCopy);
     the listener's own playlists, saved copies included, are not saved again. */
  const source = savedFromOf(p);
  const firstShow = (playlistCovers(rows)[0] || {}).name || "";
  const anyLive = rows.some(r => r.state === "live");
  const title = p.title || p.name || "Playlist";
  const playedLine = rows.length && played ? `${played} of ${rows.length} played` : "";
  const why = playlistWhy(p);
  const stripHtml = playlistStripHtml(rows, history);
  /* The tones read the scheme's computed Glow lightness, which flushes style: do it BEFORE the bars exist, so they are never styled
     without their colour and then restyled (a transition at load, which the reduced-motion gate counts). */
  const stripTones = playlistTones([...new Set(playlistStripEntries(rows).map((e) => e.show).filter(Boolean))]);

  $("#view").innerHTML = `<div class="ag pl-page pl-detail" data-pl-ctx="${esc(ctx)}" data-pl-next="${esc(nextId)}">
    <div class="pl-wash" aria-hidden="true" data-glow-show="${esc(firstShow)}"></div>
    ${playlistTopHtml("playlists")}
    <section class="pl-hero" aria-label="Playlist">
      <div class="pl-cover" aria-hidden="true">${playlistCoverHtml(rows, title, 120)}</div>
      <div class="pl-copy">
        <p class="eyebrow lamp pl-eyebrow">${esc(playlistEyebrow(p, rows, title))}</p>
        <h1 class="t-headline pl-title" data-page-heading>${esc(title)}</h1>
        <p class="t-caption num pl-meta">${playlistSummaryHtml(rows)}</p>
        ${playedLine ? `<p class="t-caption num ag-progress-copy pl-played">${esc(playedLine)}</p>` : ""}
        <div class="pl-actions">${todayPlayButton({ size: 56, label: `Play ${title}`, attrs: ` data-pl-playall data-title="${esc(title)}"`, disabled: !anyLive })}</div>
      </div>
    </section>
    ${stripHtml}
    ${source ? savePlaylistControlHtml(p) : ""}
    ${p.sparse ? `<p class="t-body pl-note">Only found a few on this — here's what 4a has.</p>` : ""}
    ${p.relaxed === "duration" ? `<p class="t-body pl-note">Couldn't match the length you asked for — here's what 4a found without it.</p>` : ""}
    ${partsNote(rows)}
    ${why ? `<section class="pl-why" aria-labelledby="pl-why-head"><h2 class="t-headline" id="pl-why-head">Why 4a made this</h2><p class="t-why">${esc(why)}</p></section>` : ""}
    ${playlistCameHtml(rows)}
    <section class="pl-list-section" aria-labelledby="pl-list-head">
      <h2 class="t-headline" id="pl-list-head">Episodes, in order</h2>
      <div class="td-stack">${rows.map(r => playlistRowHtml(r, ctx, r.state === "live" && r.item.id === nextId && played > 0)).join("")}</div>
    </section>
    ${(p.isSubject || p.isGenerated) ? "" : `<button type="button" class="ag-btn ag-btn-secondary pl-remove" id="pl-remove">Remove this playlist</button>`}
  </div>`;

  const view = $("#view");
  /* FIRST, before anything that reads a computed style (agGlowLightness does): the bars' widths and tones are written while
     they have never been styled, so the first paint is the final one and no colour transitions in at load. */
  playlistPaintStrip(view.querySelector(".pl-detail"), stripTones);
  if (!p.isSubject && !p.isGenerated) $("#pl-remove")?.addEventListener("click", () => {
    /* A pure edit (editPlaylists), so a remove made before hydration composes
       with a save still queued there instead of being undone by it. */
    editPlaylists(list => list.filter(x => x.id !== p.id));
    logEvent("playlist_removed", { playlist_id: p.id });
    leaveRemovedPlaylist();
  });
  if (source) bindSavePlaylist(p);
  playlistApplyGlow(view);
  todaySizeRims(view);
  bindPickLogging(view);
  bindPlaylistPlay(view.querySelector(".pl-detail"));
  playlistSyncPlay();
  playlistStartPoll();
}

/* ---------- The Playlists list ---------- */

/* THE LIST, AND ONE DOOR TO THE BUILDER (audit round 2, p-first-6; founder
   question 4, default taken): the `#pl-form` builder that lived here is gone
   — see the removal note above `bindPickLogging`. The header's plus and the
   empty state both open Create. Back goes to Library, which lists these. */
function renderPlaylists() {
  setBodyClass("view-playlist");
  const all = playlists();
  const history = new Set(pickedHistory());
  const build = `<a class="ag-btn ag-btn-icon pl-build" href="#/create" aria-label="Build a playlist">${agIcon("plus", 24)}</a>`;
  $("#view").innerHTML = `<div class="ag pl-page pl-index">
    ${playlistTopHtml("library", all.length ? build : "")}
    <h1 class="t-title pl-heading" data-page-heading>Playlists</h1>
    ${all.length
      ? `<p class="t-caption num pl-count">${esc(countLabel(all.length, "playlist"))}</p>
    <div class="pl-grid">${all.map(p => playlistTileHtml(p, history)).join("")}</div>`
      : playlistEmptyHtml("No playlists yet.", "Build a playlist", "create")}
  </div>`;
}
