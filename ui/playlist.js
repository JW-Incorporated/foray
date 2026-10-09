/* ui/playlist.js — Playlist detail page (#/playlist/<id>).
   A CLASSIC script like app.js, not a module: it shares app.js's globals and
   is loaded by index.html after app.js, in the order listed in
   docs/redesign-2026/split-notes.md. Declarations only at the top level, so
   nothing here runs until app.js's boot (ui/boot.js) starts init(). */


function renderPlaylistDetail(id) {
  setBodyClass("view-page");
  const p = playlistById(id) || subjectQueueById(id) || generatedPlaylistById(id);
  /* A gone playlist still gets a real page head, ‹ included: with ‹ now
     going back one real step (see § in-app history) instead of always
     Home, an entry for a just-removed playlist sits one step behind the
     Playlists list, so landing here with no ‹ at all would be a dead end
     for whoever tapped a now-stale link (e.g. from the drawer). */
  if (!p) {
    $("#view").innerHTML = agNotFoundPage();
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
  /* The "next" marker belongs on the next part that can actually be opened.
     Both it and the count below read `hasOpened` — history OR a stored position
     — so neither can regress when the 200-entry history ring rotates an
     episode out (audit 2026-09-22). */
  const nextIdx = rows.findIndex(r => r.state === "live" && !hasOpened(r.item.id, history));
  /* "PLAYED" MEANS FINISHED, the same word the rows use (audit round 2,
     honesty-6). This counted `hasOpened` — history OR any stored position — so a
     playlist read "2 played" above rows that said "31 min left" and nothing at
     all: one screen, two definitions. The count now reads the player's own
     verdict (`rowProgress`, state "played") per row, so the header and the row
     labels cannot disagree; `hasOpened` stays what the next-up marker asks. */
  const played = rows.filter(r => rowProgress(r.item)?.state === "played").length;
  const ctx = playlistCtx(p);
  /* A generated playlist or a subject queue can be kept (savePlaylistCopy);
     the listener's own playlists, saved copies included, are not saved again. */
  const source = savedFromOf(p);

  $("#view").innerHTML = `
    <div class="page">
      <div class="page-head">
        <a class="back" href="#/">‹</a>
        <div>
          <h2>${esc(p.title)}</h2>
          <p class="sub">${joinMeta(countLabel(rows.length, "episode"), p.isSubject ? "picked for you" : (p.isGenerated ? "generated for you" : "playlist"), played ? `${played} played` : "")}</p>
        </div>
      </div>
      ${source ? savePlaylistControlHtml(p) : ""}
      ${p.sparse ? `<p class="note">Only found a few on this — here's what 4a has.</p>` : ""}
      ${p.relaxed === "duration" ? `<p class="note">Couldn't match the length you asked for — here's what 4a found without it.</p>` : ""}
      ${partsNote(rows)}
      ${rows.map((r, i) => r.state === "live" ? epRow(r.item, i, ctx, nextIdx) : r.state === "hidden" ? familyHiddenRow(i, ctx) : archivedRow(r.item, i, ctx)).join("")}
      ${(p.isSubject || p.isGenerated) ? "" : `<button class="danger" id="pl-remove">remove this playlist</button>`}
    </div>`;

  if (!p.isSubject && !p.isGenerated) $("#pl-remove")?.addEventListener("click", () => {
    /* A pure edit (editPlaylists), so a remove made before hydration composes
       with a save still queued there instead of being undone by it. */
    editPlaylists(list => list.filter(x => x.id !== p.id));
    logEvent("playlist_removed", { playlist_id: p.id });
    leaveRemovedPlaylist();
  });
  if (source) bindSavePlaylist(p);
  bindPickLogging($("#view"));
  bindStars($("#view"));
  bindUpNext($("#view"));
  bindPlay($("#view"));
}
