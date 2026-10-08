/* ui/create.js — Create page (#/create): the build-a-playlist form.
   A CLASSIC script like app.js, not a module: it shares app.js's globals and
   is loaded by index.html after app.js, in the order listed in
   docs/redesign-2026/split-notes.md. Declarations only at the top level, so
   nothing here runs until app.js's boot (ui/boot.js) starts init(). */


/* ---------- Create (#/create, U-06 / docs/ui-transition-plan.md D7+D8) ----------

   The mockup's Create screen (docs/ux/foray-mockup.jsx CreateScreen), restyled
   under the ui-v2 tokens, with the **Foray | Playlist** toggle rendered but the
   Foray half permanently disabled: "Foray generation stays out of the UI for
   now" (D8) -- the pipeline exists, its key and segment pool don't, and a
   toggle that silently did nothing would be worse than one that says so.
   Playlist mode is NOT a new builder: it is today's buildPlaylist() (the same
   function #/playlists' form calls), reached through the new chrome, so a
   playlist built from here and one built from the old Playlists page produce
   byte-identical cp_playlists entries (the card's acceptance line).

   The mockup's ~20/~40/~75 minute LENGTH picker is Foray-specific (it sizes a
   stitched run of segments) and has no meaning for a playlist of whole
   episodes, so D8 explicitly excludes it here -- showing it would imply a
   knob that does nothing.

   The mockup's phase machine (idle -> building -> done) fakes progress with a
   fixed step list and a timer with no backing work. buildPlaylist() is real,
   synchronous work with no intermediate stages to report, so this reuses only
   the honest part of that shape -- a "Building…" transient long enough for
   the browser to paint before the synchronous call blocks the main thread
   (the same bindPlaylistFormSubmit fix, same reason) -- and then either opens
   the built playlist (the mockup's "done" destination) or shows why not. No
   invented step list, because inventing one here would be exactly the kind of
   promise D8 forbids: a progress bar for work that is not actually happening
   in stages. */

const CREATE_SUBJECT_SUGGESTIONS = [
  "The history of the Fed", "Mechanical watches", "Small launch economics",
];

function createToggleHtml() {
  return `<div class="cr-toggle" role="group" aria-label="Create mode">
    <button type="button" class="cr-toggle-btn is-on" data-cr-mode="playlist" aria-pressed="true">Playlist</button>
    <button type="button" class="cr-toggle-btn is-disabled" data-cr-mode="foray" disabled aria-disabled="true" aria-pressed="false"
        aria-describedby="cr-foray-note">Foray</button>
  </div>
  <p class="note cr-foray-note" id="cr-foray-note">Custom Forays aren't available yet — you can still build a playlist below.</p>`;
}

/** Loading-state guard around #cr-form's submit -- the same shape as
    bindPlaylistFormSubmit (see that function's header for why the
    setTimeout(0) is load-bearing) because this calls the exact same
    buildPlaylist(), just from the new screen's form. Kept as a separate
    function rather than a shared one because the two forms' DOM (note
    element id, disabled-label text) differ enough that forcing a shared
    signature would need extra parameters for no real reuse -- U-02's own
    history (two `#pl-form` mounts sharing one handler) is the caution here:
    that ended with only one of the two mounts still using it. */
/* ONE BUILD AT A TIME (review 2026-09-23). The suggestion pills call the
   submit handler directly, so the disabled Build button never had a say: on a
   cold boot the build waits for the search data, a tap looked like nothing,
   and a second tap (on the same pill or another) queued a second playlist and
   a second navigation. The flag covers every entry point; the pills are also
   disabled so the page says so. */
let createBuildPending = false;

/* THE PENDING STATE IS PAINTED FROM THE FLAG, ONTO WHATEVER CREATE PAGE IS ON
   SCREEN (audit round 2, races-3). The build waits on `whenSearchDataReady`,
   which since round 1 can be a 30 s wait on a cold start; a listener who left
   and came back found fresh, enabled pills that did nothing (the flag was
   still set) and a Build button that said Build. Now every render of the page
   asks the flag, and the build's end restores the button on the page that is
   there THEN — not the detached one it started from. `"Build"` is the
   button's one label, so no captured original is needed. */
function paintCreatePending(pending) {
  const view = $("#view");
  if (!view) return;
  view.querySelectorAll("[data-cr-subject]").forEach(p => { p.disabled = pending; });
  const form = $("#cr-form");
  const btn = form && typeof form.querySelector === "function" ? form.querySelector("button[type='submit']") : null;
  if (!btn) return;
  btn.disabled = pending;
  setControlLabel(btn, pending ? "Building…" : "Build", null);
}

/** Why a build did not open a playlist, in the listener's words. One sentence
    per status, shared by the Create form and Discover's button. */
function createFailureNote(result, query) {
  return result.status === "unsaved"
    ? "That playlist could not be saved — this device has no storage space left. Removing a playlist you have finished with frees enough for a new one."
    : result.status === "full"
      ? `You have ${PLAYLISTS_CAP} playlists, the most 4a keeps. Remove one to build another.`
      : result.suggestions.length
        ? `Not much on ${quoteQuery(query)} yet — try ${result.suggestions.map(s => s.label).join(", ")} instead.`
        : `Not much on ${quoteQuery(query)} yet — try different words.`;
}

/** DISCOVER'S "CREATE A PLAYLIST ABOUT X" BUTTON (Redesign 2026, ambient, the
    Dock: three tabs, Create folded into Discover's field). It used to hand the
    query to the Create page's form and navigate there; `#/create` now lands on
    Discover, so the build runs from the page that asked. The same builder, the
    same one-build-at-a-time flag and the same result handling as the form
    below - a build that finishes after the listener left Discover opens
    nothing, exactly as the form's rule (audit round 2, races-3). A failure is
    said in Discover's own status line. */
function buildPlaylistFromDiscover(query, btn) {
  if (createBuildPending || !query) return;
  createBuildPending = true;
  const idle = btn ? btn.textContent : "";
  if (btn) { btn.disabled = true; setControlLabel(btn, "Building…", null); }
  whenSearchDataReady(() => {
    try {
      const result = buildPlaylist(query);
      logEvent("playlist_built", { query, status: result.status, found: result.playlist ? result.playlist.items.length : 0, source: "create" });
      const onDiscover = /^#\/shows($|\/)/.test(currentHash());
      if (result.status === "ok" || result.status === "sparse") {
        if (onDiscover) location.hash = "#/" + playlistRoute(result.playlist);
      } else if (onDiscover) {
        const note = $("#sh-note");
        if (note) { note.textContent = createFailureNote(result, query); note.hidden = false; }
      }
    } finally {
      createBuildPending = false;
      if (btn && btn.isConnected) { btn.disabled = false; setControlLabel(btn, idle, null); }
    }
  });
}

function bindCreateFormSubmit(e) {
  e.preventDefault();
  if (createBuildPending) return;
  const form = e.currentTarget;
  const input = form.querySelector("input[type='text']");
  const query = input.value.trim();
  if (!query) return;
  createBuildPending = true;
  paintCreatePending(true);
  const staleNote = $("#cr-note");
  if (staleNote) staleNote.hidden = true;
  whenSearchDataReady(() => {
    try {
      const result = buildPlaylist(query);
      logEvent("playlist_built", { query, status: result.status, found: result.playlist ? result.playlist.items.length : 0, source: "create" });
      /* ONLY IF CREATE IS STILL THE PAGE ON SCREEN (audit round 2, races-3).
         The wait above can outlast the listener's patience; a build that
         finished while they were on Home or in a show yanked them to the new
         playlist from wherever they were. The playlist is already saved
         either way — Library and #/playlists list it — so a listener who
         moved on loses nothing but the jump. The PAGE is the test, not the
         render token: a listener who left and CAME BACK to Create is looking
         at "Building…" (painted from the flag above) and expects the result
         to land. It was the route (`#/create`) until Create folded into
         Discover; the route no longer exists (ROUTE_ALIASES in app.js), so
         the question is whether this page's form is on screen. */
      const onCreate = Boolean($("#cr-form"));
      if (result.status === "ok" || result.status === "sparse") {
        if (onCreate) location.hash = "#/" + playlistRoute(result.playlist);
      } else if (onCreate) {
        const note = $("#cr-note"); // the live page's note, never the one captured before the wait
        if (note) {
          note.textContent = createFailureNote(result, query);
          note.hidden = false;
        }
      }
    } finally {
      createBuildPending = false;
      paintCreatePending(false);
    }
  });
}

function renderCreate() {
  setBodyClass("view-page");
  $("#view").innerHTML = `
    <div class="page cr-page">
      <div class="page-head">
        <div><h2>Create</h2><p class="sub">Name a subject and 4a builds a playlist from across the catalogue.</p></div>
      </div>
      ${createToggleHtml()}
      <form id="cr-form" autocomplete="off">
        <input id="cr-input" type="text" maxlength="120" placeholder="e.g. the semiconductor supply chain" aria-label="Subject for your playlist">
        <button type="submit">Build</button>
      </form>
      <div class="cr-suggestions">
        ${CREATE_SUBJECT_SUGGESTIONS.map(s => `<button type="button" class="fy-chip" data-cr-subject="${esc(s)}">${esc(s)}</button>`).join("")}
      </div>
      <p id="cr-note" class="note" hidden></p>
    </div>`;

  $("#cr-form").addEventListener("submit", bindCreateFormSubmit);
  /* A build that is still waiting on the search documents is shown as one,
     on this render too (races-3): the page says why a tap does nothing. */
  paintCreatePending(createBuildPending);
  /* A SUGGESTION BUILDS (audit 2026-09-22, persona 26). The pill used to fill
     the field and raise the keyboard, and building took a second tap on a Build
     button the keyboard now covered — so the tap read as a miss. Nobody who
     taps a canned suggestion wants to type: the field is filled (so the
     listener can see what was asked for) and the same submit path runs, with
     no focus. The founder's ruling on the Search tiles (#684: a tile runs the
     search for its own label) is the same rule. */
  $("#view").querySelectorAll("[data-cr-subject]").forEach(btn => {
    btn.addEventListener("click", () => {
      if (createBuildPending) return;   /* a build is already on its way */
      const form = $("#cr-form");
      const input = $("#cr-input");
      if (input) input.value = btn.dataset.crSubject;
      if (form) bindCreateFormSubmit({ preventDefault() {}, currentTarget: form });
    });
  });
  /* A Search CTA's hand-off (app-2-11): prefilled and submitted through the
     same path, now that the form exists. Consumed once. */
  if (pendingCreateQuery !== null) {
    const query = pendingCreateQuery;
    pendingCreateQuery = null;
    const form = $("#cr-form");
    const input = $("#cr-input");
    if (input) input.value = query;
    if (form && !createBuildPending) bindCreateFormSubmit({ preventDefault() {}, currentTarget: form });
  }
}
