/* ui/forays.js — Forays directory (#/forays) and the Foray list, resume and ribbon rows.
   A CLASSIC script like app.js, not a module: it shares app.js's globals and
   is loaded by index.html after app.js, in the order listed in
   docs/redesign-2026/split-notes.md. Declarations only at the top level, so
   nothing here runs until app.js's boot (ui/boot.js) starts init(). */


/* ---------- Forays page (#/forays) ----------

   The menu destination the foray list moved to (founder instruction, item 2:
   "get rid of the recommended foray at the top of Home. Move it into a page
   accessible via the menu exclusively for Forays").

   "Jump back in" moves here WITH the list rather than staying on Home. The
   two render the same `.fy-home-row` markup and read as one block, so
   splitting them would have left Home with a row that looks exactly like the
   thing the founder asked to remove. Both are still gated by the same
   visibility rule (forayCards / forayResumeRows) — an unpublished Foray is
   listed only to someone who arrived with its `?foray=` link this session. */
/* THE THREE STATES, AND WHAT THE PAGE SAYS ABOVE THEM (audit 2026-09-22).

   It used to be synchronous and take `forayCards()` at face value — and that
   function answers `[]` for "the player module has not evaluated yet", for "the
   Forays document failed to load" and for "there genuinely are none" alike. So a
   cold deep link, a slow phone or a stale cache painted "0 forays" and "No forays
   right now", and nothing ever repainted it. The detail route one screen away
   already awaited the player and named each failure; this page threw that
   distinction away. Now:

     loading — the module is not here yet: say so, claim nothing, wait for it the
               bounded way `renderForay` does, then paint again.
     failed  — the module never came, or the document did not load: say which,
               with "Try again" wired to the thing that failed.
     empty   — only when both are here and the list really is empty.

   NO COUNT IN THE SUBTITLE. "1 foray" was the page's only line of text, and it
   told a listener who skipped the first-run sheet nothing about what a Foray
   IS — which, after that sheet, nothing in the app said again (persona audit
   #18/#37/#45/#83: "Skip for now" deleted the product's only explanation of
   itself). The subtitle is now that explanation, from the same constant the
   sheet uses, so the two cannot drift and the sheet's "Skip for now" is no
   longer destructive: the sentence has a permanent home a tap away. */
function renderForays() {
  setBodyClass("view-page");
  const head = `
      <div class="page-head">
        <a class="back" href="#/">‹</a>
        <div>
          <h2>Forays</h2>
        </div>
      </div>
      <p class="note fy-about">${esc(forayAbout())}</p>`;
  const paintStatus = (body) => { $("#view").innerHTML = `<div class="page">${head}${body}</div>`; };

  if (!window.ForayPlayer) {
    paintStatus(`<p class="note">Loading…</p>`);
    playerBridge().then((player) => {
      if ((location.hash || "") !== "#/forays") return; // the listener has moved on
      if (player) { renderForays(); return; }
      /* A module that FAILED gets the reload, a module that is merely slow gets
         the re-await — see playerModuleFailed(). */
      if (playerModuleFailed()) {
        paintStatus(reloadNoteHtml("The player didn't load."));
        bindReload($("#view"));
        return;
      }
      paintStatus(failedNoteHtml("The player didn't load."));
      bindRetry($("#view"), renderForays);
    });
    return;
  }
  if (!state.forays) {
    paintStatus(failedNoteHtml("Couldn't load forays right now."));
    bindRetry($("#view"), retryForayDocs);
    return;
  }

  const list = forayCards();
  const resume = forayResumeRows();
  $("#view").innerHTML = `
    <div class="page">
      ${head}
      ${jumpBackInHtml(resume)}
      ${list.length
        ? forayListHtml({ inSection: true })
        : `<p class="note">No forays right now — 4a puts these together by hand, so they arrive a few at a time.</p>`}
    </div>`;
  sizeProgressBars($("#view"));
}

/** The Forays this visitor may see on the Forays page (#/forays). As of 2026-08-30 that is
    ONE — `capital-types-1` is published — plus any draft reached by name. It
    was empty for everyone before that.

    It reads the bridge synchronously rather than awaiting it, so on a cold load
    where the module has not evaluated yet it answers `[]` — which is NOT a claim
    that there are none, and no caller may paint it as one. The two pages that
    list Forays now close the gap themselves (audit 2026-09-22, theme G):
    `renderForays` awaits the bridge before it will say "No forays right now",
    and `restoreNowPlayingRibbon` repaints Home once when the module arrives
    after Home's first paint. Recorded in docs/curation/foray2-capital.md §11c. */
/** One listed Foray, resolved through the same `forayViewOpts()` gate every
    Foray this page opens goes through, or null (no module, no documents, a
    draft the viewer may not see, or data the resolver threw on). The one way a
    LIST surface (Home's cards, the Forays list, Library, Jump back in, the
    welcome strip) reads a Foray's running order, so none of them can resolve
    it by a rule of its own. */
function resolveListedForay(id) {
  const player = window.ForayPlayer;
  if (!id || !state.forays || typeof player?.resolve !== "function") return null;
  try {
    return player.resolve(state.forays, {
      id, segmentsDoc: state.segments, sourcesDoc: state.segmentSources, ...forayViewOpts(),
    }) || null;
  } catch (_) {
    return null;   // malformed segments/sources must not break a list
  }
}

function forayCards() {
  if (!state.forays || !window.ForayPlayer) return [];
  /* Published + `?foray=`-unlocked first, in file order, exactly as before;
     the test-track drafts (switch on) follow — see withTestTrackDrafts. */
  return withTestTrackDrafts(opts => window.ForayPlayer.listForays(state.forays, opts));
}

/* Renamed from forayHomeHtml on 2026-09-03: this list is no longer on Home.
   The `.fy-home*` class names stay as they are — renaming them would touch
   every foray style for no behaviour, and `.fy-home-row` is still an accurate
   description of the row shape. */
/* `inSection`: the list sits under the page's own "Forays" heading, so a
   published row's FORAY tag only restated it (audit round 2, visual-9). A
   draft keeps its tag — "draft" is news the heading does not carry. */
function forayListHtml({ inSection = false } = {}) {
  const list = forayCards();
  if (!list.length) return "";
  return forayRowsHtml(list, { inSection });
}

/** THE ONE FORAY ROW (audit round 2 review): the #/forays list and Search's
    Forays group both render through here, so "a Foray found here looks like a
    Foray found there" is the code and not a comment — the search group used to
    hand-copy the old row and kept the FORAY tag under its own "Forays" heading
    (visual-9) with no length or progress line (p-foray-8).
    HOW LONG, AND HOW FAR (audit round 2, p-foray-8 / honesty-2): a row was a
    tag and a title, so nothing before a Foray's own page said how long it
    was, and a finished Foray looked never opened. The kicker already says
    "draft", so the sub line leaves it out. */
function forayRowsHtml(list, { inSection = false } = {}) {
  const progress = forayProgressLabels();
  return `<div class="fy-home">${list.map(f => {
    const sub = forayListSubLabel(f, progress, { draftTag: false });
    return `
    <a class="fy-home-row" href="#${esc(forayRoutePath(f.id))}">
      ${inSection && f.status === "published" ? "" : `<span class="fy-home-kicker">foray${f.status === "published" ? "" : " · draft"}</span>`}
      <span class="fy-home-title">${esc(f.title)}</span>
      ${sub ? `<span class="fy-home-sub">${esc(sub)}</span>` : ""}
    </a>`;
  }).join("")}</div>`;
}

/** Every listed Foray's progress label by id: "Played" for a finished one,
    "N min left" for a part-played one. NO cap, because this is data, not the
    rail (honesty-12). */
function forayProgressLabels() {
  return new Map(forayResumeRows({ limit: Infinity, includeFinished: true }).map(p => [p.id, p.label]));
}

/** A list row's second line: draft tag, progress, then length and makeup,
    JOINED, never one in place of another (honesty-12: a part-played draft's
    "20 min left" used to replace its "draft"). */
function forayListSubLabel(f, progress, { draftTag = true } = {}) {
  return joinMeta(
    draftTag && f.status !== "published" ? "draft" : "",
    progress.get(f.id) || "",
    forayFactsLabel(resolveListedForay(f.id), window.ForayPlayer),
  );
}

/* "Jump back in" — the mockup's own heading for a part-played Foray, and the
   home screen's half of resuming.

   Gated through the SAME visibility rule as the list above, deliberately. A
   stored position is not permission: `player/foray-resolve.js` decided that an
   unpublished Foray is reachable only by asking for it by id, and the unlock is
   pointedly not persisted so that opening a draft link on a shared machine does
   not leave it on someone else's home screen. A resume row that ignored that
   would reintroduce exactly the leak that rule closed — so with no `?foray=` in
   the URL, a draft's progress is remembered and simply not advertised. */
/** Ask the player to repaint the mini bar from the stored pointer, once the
    bridge exists. Re-renders home afterwards so "Jump back in" picks up the
    restored episode on the same paint rather than on the next navigation. */
function restoreNowPlayingRibbon() {
  /* `late` is the module arriving AFTER Home's first paint — and then Home is
     repainted whether or not a ribbon came back (audit 2026-09-22). That first
     paint read `forayCards()` with no module to read it through, so its Forays
     rail was missing for a listener who had never played anything, and until
     now only a restored episode ever triggered the repaint that fixed it. */
  const go = (late) => {
    try {
      /* WHATEVER WAS PLAYED LAST (persona audit 2026-09-22, the car tier): a
         part-played Foray that is newer than the last episode takes the bar;
         otherwise the episode pointer does, as before. */
      const restored = restoreLastForayRibbon(window.ForayPlayer)
        || window.ForayPlayer?.restoreLastEpisode?.();
      /* Seed the restored episode on EVERY route, not only via Home's render:
         the bar's "Open episode" link points at #/episode/<id>, and on a cold
         start anywhere else nothing else would ever put it in the index. */
      if (restored) playerPointerEpisode(null);
      if ((restored || late) && isHomeRoute()) renderCurrentPage();
    } catch (_) { /* a ribbon that cannot be restored is not a reason to fail boot */ }
  };
  /* THE LANE FIRST (NE-22). Inside the iOS shell the player cannot restore
     anything until engineHello has said whether the native engine or the page
     plays; until then both restores would answer a promise, and a promise is
     truthy, so the episode fallback below would never run. Everywhere else
     `engineModePending` answers false at once and this stays synchronous. */
  const whenLaneKnown = (late) => {
    const p = window.ForayPlayer;
    let pending = false;
    try { pending = typeof p?.engineModePending === "function" && p.engineModePending() === true; } catch (_) { pending = false; }
    if (!pending) return go(late);
    Promise.resolve(p.whenEngineReady()).then(() => go(late), () => go(late));
  };
  if (window.ForayPlayer) whenLaneKnown(false);
  else window.addEventListener("forayplayer:ready", () => whenLaneKnown(true), { once: true });
}

/** The part-played Foray for the bar, when it is the most recent thing played —
    or null, and the caller falls back to the episode pointer.

    Resolved HERE because only the page holds the three Foray documents, and
    through `forayViewOpts()` like every other Foray this page opens: a draft
    the listener may not see resolves to null and is never advertised on the
    bar. The resume point is read with the resolved running order in hand, so a
    Foray whose segments moved resumes to the same audio (#40). Every step is
    capability-checked: an older player module simply has no Foray ribbon. */
function restoreLastForayRibbon(player) {
  if (!player || typeof player.lastPlayedForay !== "function" || typeof player.restoreForay !== "function") return null;
  if (!state.forays) return null;
  const id = player.lastPlayedForay();
  if (!id) return null;
  const r = player.resolve(state.forays, {
    id, segmentsDoc: state.segments, sourcesDoc: state.segmentSources, ...forayViewOpts(),
  });
  if (!r) return null;
  const at = player.forayResume(id, { resolved: r });
  if (!at) return null;
  return player.restoreForay(r, { startElapsedSec: at.elapsedSec, discoverDoc: state.discover || null });
}

/** True when the current route is the home screen — the only page whose content
    changes as a result of the restore. */
function isHomeRoute() {
  return currentHash() === "#/";
}

/* `limit` and `includeFinished` belong to the CALLER (audit round 2,
   honesty-12 / honesty-2). The 3-row cap is the Home rail's layout; Library
   reused this helper as its data source and inherited the cap, so a fourth
   part-played Foray there showed an empty subtitle. A finished Foray is left
   off Jump back in (founder question 3: finished things leave the rail,
   episodes and Forays alike), but its own rows say "Played". */
function forayResumeRows({ limit = 3, includeFinished = false } = {}) {
  if (typeof window.ForayPlayer?.forayResumeList !== "function") return [];
  const visible = new Set(forayCards().map(f => f.id));
  /* `foraysDoc` is FD-05: a row whose Foray is no longer in the directory reads
     `drift: "dropped"` and is not offered — the visibility set below already
     excludes it (it is not listed), and the drift is what a test can name. */
  /* `resolveFor` (audit 2026-09-22, qa row 163): the row's percent and "min
     left" are read against the Foray as it resolves NOW, through the same
     `forayViewOpts()` gate every other Foray this page opens goes through —
     not against the runtime stored when the row was written. */
  const player = window.ForayPlayer;
  const resolveFor = typeof player.resolve === "function" && state.forays ? resolveListedForay : null;
  return player.forayResumeList({ foraysDoc: state.forays, resolveFor })
    .filter(p => visible.has(p.id) && p.drift !== "dropped" && (includeFinished || !p.finished) && p.label)
    .slice(0, limit);
}

function jumpBackInHtml(rows) {
  if (!rows.length) return "";
  return `<div class="fy-home fy-jbi">${rows.map(p => `
    <a class="fy-home-row fy-jbi-row" href="#${esc(forayRoutePath(p.id))}">
      <span class="fy-home-kicker">Jump back in</span>
      <span class="fy-home-title">${esc(p.title || p.id)}</span>
      <span class="fy-bar"><span class="fy-bar-fill" data-pct="${esc(String(p.percent))}"></span></span>
      <span class="fy-jbi-left">${esc(p.label)}</span>
    </a>`).join("")}</div>`;
}

/** Bar widths are a DOM property, never a style attribute — the page CSP is
    `style-src 'self'` and test/app-security.test.js gates it. */
function sizeProgressBars(scope) {
  for (const selector of [".fy-bar-fill[data-pct]", ".today-prog__fill[data-pct]"]) {
    scope.querySelectorAll(selector).forEach(fill => {
      const pct = Math.max(0, Math.min(100, Number(fill.dataset.pct) || 0));
      fill.style.width = `${pct}%`;
    });
  }
}
