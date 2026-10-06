/* ui/downloads.js — Downloads: the device store glue, controls, and the Library downloads section.
   A CLASSIC script like app.js, not a module: it shares app.js's globals and
   is loaded by index.html after app.js, in the order listed in
   docs/redesign-2026/split-notes.md. Declarations only at the top level, so
   nothing here runs until app.js's boot (ui/boot.js) starts init(). */


/* ---------- offline downloads (#29, docs/roadmap/player-features.md PQ-18) ----------

   The listener-visible half of downloads: the Download control on the episode
   page, the Library's "Downloads" section, the "Download over cellular" switch
   and the files' share of "Delete my data". The founder defaults in force
   (roadmap README Q17; player-features §1 question 2): downloads are MANUAL and
   per episode — nothing here prefetches Up Next or anything else — Wi-Fi only
   unless the switch is on, and a 2 GB cap enforced by least-recently-played
   eviction that never takes an episode the listener is partway through.

   WHAT LIVES ELSEWHERE, AND IS NOT RESTATED HERE. The RULES — the record's
   shape, which event means which status, who is evicted, what the usage line
   says — are `player/download-store.js` (PQ-16). The WIRE to the native plugin
   is `player/download-bridge.js` (PQ-17). Both reach this classic script on
   `window.forayDownloads` (player/client.js), so this block keeps no copy of a
   rule: with no player module it has no store, no bridge, and draws nothing.
   Playing FROM the file is PQ-19, which reads `recordFor` / `onMissing` below.

   NO BRIDGE, NO CONTROL. `createBridge` answers null off the shell (a web build
   never downloads — CORS, #29), and every surface here is drawn only when
   `state.downloadBridge` is non-null: an honest absence, not a disabled button.

   `cp_downloads` is ONE row (download-store.js says why); it is read and
   written through lsGet/lsSet like every other `cp_` key, so the durable store
   and "Delete my data" see it. */

function downloadRules() {
  const rules = window.forayDownloads && window.forayDownloads.store;
  return rules && typeof rules.normaliseDownloads === "function" ? rules : null;
}

/** The record, normalised by the store's own rule; the empty record (Wi-Fi only,
    nothing downloaded) when the player module is not there to normalise it. */
function downloadsValue() {
  const raw = lsGet("cp_downloads", null);
  const rules = downloadRules();
  if (rules) return rules.normaliseDownloads(raw);
  return { settings: { cellular: false }, items: {} };
}

function saveDownloads(value) {
  const rules = downloadRules();
  return lsSet("cp_downloads", rules ? rules.normaliseDownloads(value) : value);
}

/** The record without one episode's row: what Remove (and an eviction) leaves. */
function downloadsWithout(value, id) {
  const items = { ...value.items };
  delete items[id];
  return { ...value, items };
}

function downloadsCellularOn() { return downloadsValue().settings.cellular === true; }

function setDownloadsCellular(on) {
  const v = downloadsValue();
  saveDownloads({ ...v, settings: { ...v.settings, cellular: on === true } });
}

/**
 * Build the bridge once and publish what PQ-19's play path reads. Idempotent: a
 * second call returns the bridge the first one built. Null — and nothing drawn
 * anywhere — off the shell or with no player module.
 */
/** True only when the shell positively says it lacks `name`; a shell that
    cannot say (no isPluginAvailable, or it throws) is not refused here. */
function pluginMissing(name) {
  const cap = window.Capacitor;
  try {
    return typeof cap?.isPluginAvailable === "function" && cap.isPluginAvailable(name) === false;
  } catch (_) { return false; }
}

function bootDownloads() {
  if (state.downloadBridge) return state.downloadBridge;
  const surface = window.forayDownloads;
  if (!surface || typeof surface.createBridge !== "function") {
    state.downloadBridge = null;
    return null;
  }
  /* A SHELL WITHOUT THE PLUGIN DRAWS NOTHING. createBridge only asks for
     `nativePromise`, which every shell has; one built before ForayDownloads
     (#1052) would get a Download control whose every tap answers "not
     implemented", a `failed` row, and — through that row — a "NOT fully
     clear" Delete my data on a device that never held a file. Capacitor's own
     answer decides, as player/native-engine.js reads it for its plugin.
     MUTATION: delete this check — test/downloads.test.js "off the shell…"
     draws the control on a plugin-less shell. */
  if (pluginMissing("ForayDownloads")) {
    state.downloadBridge = null;
    surface.bridge = null;
    return null;
  }
  let bridge = null;
  try {
    bridge = surface.createBridge({ bridge: window.Capacitor, onEvent: onDownloadEvent }) || null;
  } catch (_) { bridge = null; }
  state.downloadBridge = bridge;
  surface.bridge = bridge;
  surface.recordFor = (id) => downloadsValue().items[id] || null;
  /* The file the record points at is gone (the OS reclaimed it, a restore
     without the files): the row stays, as `missing`, so the Library and the
     episode page say so and offer the download again; the play streams. */
  surface.onMissing = (id) => {
    const rules = downloadRules();
    if (!rules) return;
    saveDownloads(rules.markMissing(downloadsValue(), id));
    announce("Downloaded copy missing — streaming instead.");
    repaintDownload(id);
  };
  return bridge;
}

/**
 * One plugin event → the record. `reportFromEvent` is the event → status rule
 * (`downloadFailed`'s own `status` is HTTP, not a record status — integration
 * review 2026-10-04); `applyProgress` refuses what the record cannot take, and
 * a refusal (identity) writes and repaints nothing.
 *
 * AN EVENT FOR AN EPISODE THE RECORD DOES NOT HOLD IS DROPPED. Every real
 * download starts as a `queued` row (`startDownload`), so a row-less event is a
 * late one for a file the listener removed — or for a purge "Delete my data"
 * just ran, where writing it back would put `cp_downloads` straight back.
 */
function onDownloadEvent(name, payload) {
  if (dataDeletionInProgress) return;
  const rules = downloadRules();
  if (!rules) return;
  const bridge = state.downloadBridge;
  const path = payload && typeof payload.path === "string" ? payload.path : null;
  const webSrc = name === "downloadDone" && path && bridge ? bridge.fileSrc({ path }) : undefined;
  const report = rules.reportFromEvent(name, payload, { webSrc, now: Date.now() });
  if (!report) return;
  const before = downloadsValue();
  if (!before.items[report.id]) return;
  const next = rules.applyProgress(before, report);
  if (next === before) return;
  saveDownloads(next);
  repaintDownload(report.id);
  if (name === "downloadFailed") announce("Download failed.");
  if (name === "downloadDone") {
    announce("Downloaded.");
    /* The cap is checked when it can have been crossed: a file just landed. */
    evictDownloads().finally(() => {
      if (currentHash() === "#/library") renderCurrentPage();
    });
  }
}

/* An episode the listener is partway through, as `evictionPlan` reads a
   position: `isInProgress` needs a finite `sec` at or past MIN_RESUME_SEC and
   at most NEAR_END_SEC short of the duration. The sentinel carries its OWN
   duration, so the row's `observed_duration_sec` is never consulted — with a
   null one, a row that knows its length (3600 s) would read the huge `sec` as
   past the end, "finished", and evict the half-heard episode.
   MUTATION: `{ sec: Number.MAX_SAFE_INTEGER, durationSec: null }` — test 9's
   in-progress row (observed_duration_sec 3600) is evicted. */
const DOWNLOAD_IN_PROGRESS = Object.freeze({ sec: 1e9, durationSec: 2e9 });

/**
 * `evictionPlan`'s `positions`, from the player's own reading of each stored
 * position (`window.ForayPlayer.episodeProgress`, the one "Jump back in" and the
 * rows use). That reading answers a STATE — played / in-progress / sampled /
 * unplayed — not seconds, and it applies the same MIN_RESUME_SEC/NEAR_END_SEC
 * rules the planner does, so an `in-progress` episode is passed as one the
 * guard protects and every other state is left out (evictable, as the plan
 * says an id with no position is). A reading that throws is protected: an
 * unknown position is not permission to delete. No player at all → null, and
 * nothing is evicted rather than everything being guessed at.
 */
function downloadPositions(items) {
  const player = window.ForayPlayer;
  if (!player || typeof player.episodeProgress !== "function") return null;
  const out = {};
  for (const id of Object.keys(items)) {
    let p = null;
    try { p = player.episodeProgress(id, items[id].observed_duration_sec ?? null); } catch (_) { p = null; }
    if (!p || p.state === "in-progress") out[id] = DOWNLOAD_IN_PROGRESS;
  }
  return out;
}

/** Remove what the cap says must go, oldest-played first. Returns the plan. */
async function evictDownloads() {
  const rules = downloadRules();
  const bridge = state.downloadBridge;
  if (!rules || !bridge) return [];
  const value = downloadsValue();
  const positions = downloadPositions(value.items);
  if (!positions) return [];
  const plan = rules.evictionPlan(value, positions);
  for (const id of plan) {
    const res = await bridge.remove({ id });
    if (res && res.ok) saveDownloads(downloadsWithout(downloadsValue(), id));
  }
  return plan;
}

/* The one sentence under a refused download. A 403 from the host is the usual
   cause (PQ-20/22's rule); the plugin's own reason rides on `data-reason` for a
   field report, never in the listener's words. */
const DOWNLOAD_REFUSED_NOTE = "This publisher's server refused the download on this device. Streaming may still work.";

function downloadingLabel(rec) {
  if (!(rec.total > 0)) return "Downloading…";
  const pct = Math.max(0, Math.min(99, Math.round((rec.bytes / rec.total) * 100)));
  return `Downloading ${pct}%`;
}

/** The control's contents for one record (or none). */
function downloadControlInner(item, rec) {
  const id = esc(item.id);
  const btn = (label, { action = null, aria = null } = {}) =>
    `<button type="button" class="up-next ep-download-btn" data-download="${id}"`
    + `${action ? ` data-download-action="${action}"` : " disabled"}`
    + `${aria ? ` aria-label="${esc(aria)}"` : ""}>${esc(label)}</button>`;
  switch (rec && rec.status) {
    case "queued": return btn("Download queued");
    case "downloading": return btn(downloadingLabel(rec));
    case "done": return btn("Downloaded ✓", { action: "remove", aria: "Downloaded. Remove the download" });
    case "unplayable-here":
      return btn("Not available for download here")
        + `<p class="note ep-download-note"${rec.reason ? ` data-reason="${esc(rec.reason)}"` : ""}>${esc(DOWNLOAD_REFUSED_NOTE)}</p>`;
    case "failed": return btn("Download failed — try again", { action: "enqueue" });
    /* No row, or `missing` (the file went away): offer it again. */
    default: return btn("Download", { action: "enqueue" });
  }
}

/** The episode page's Download control: only on the shell, only for an episode
    that has audio to fetch. Its own row under the actions, which are already at
    their phone-width ceiling (▶ ☆ + Up Next, Play next). */
function downloadControlHtml(item) {
  if (!state.downloadBridge || !item || !item.id || !item.audio_url) return "";
  const rec = downloadsValue().items[item.id] || null;
  return `<div class="ep-download" data-download-slot="${esc(item.id)}">${downloadControlInner(item, rec)}</div>`;
}

/** Repaint one episode's control where it is on screen, in place (a progress
    tick every couple of seconds must not re-render the page under a thumb). */
function repaintDownload(id) {
  const view = $("#view");
  if (!view || typeof view.querySelectorAll !== "function") return;
  view.querySelectorAll("[data-download-slot]").forEach(slot => {
    if (!slot.dataset || slot.dataset.downloadSlot !== id) return;
    const item = resolveEpisode(id);
    if (!item) return;
    slot.innerHTML = downloadControlInner(item, downloadsValue().items[id] || null);
    bindDownloads(slot);
  });
}

function bindDownloads(scope) {
  if (!scope || typeof scope.querySelectorAll !== "function") return;
  scope.querySelectorAll("[data-download]").forEach(btn => {
    if (btn._bound) return;
    btn._bound = true;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const id = btn.dataset.download;
      const action = btn.dataset.downloadAction;
      if (action === "enqueue") startDownload(id);
      else if (action === "remove") removeDownload(id);
    });
  });
  scope.querySelectorAll("[data-downloads-remove-all]").forEach(btn => {
    if (btn._bound) return;
    btn._bound = true;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      removeAllDownloads();
    });
  });
}

/**
 * Ask the phone to fetch one episode. The URL is the episode's ORIGINAL
 * enclosure (`source_audio_url` when PQ-19 has put a local file in
 * `audio_url`): CLAUDE.md principle 3 — downloads go to the publisher's own URL,
 * never through anything of ours. The row is written `queued` BEFORE the call,
 * so the events that follow have a row to land on (`onDownloadEvent`).
 */
async function startDownload(id) {
  const rules = downloadRules();
  const bridge = state.downloadBridge;
  const item = id ? resolveEpisode(id) : null;
  if (!rules || !bridge || !item || !item.audio_url) return null;
  const url = item.isLocalFile && item.source_audio_url ? item.source_audio_url : item.audio_url;
  if (safeUrl(url) === "#") return null;
  const surface = window.forayDownloads || {};
  const userAgent = typeof surface.userAgent === "string" ? surface.userAgent : surface.USER_AGENT;
  const allowCellular = downloadsCellularOn();
  saveDownloads(rules.applyProgress(downloadsValue(), { id, status: "queued", bytes: 0, source_url: url, now: Date.now() }));
  repaintDownload(id);
  const res = await bridge.enqueue({ id, url, userAgent, allowCellular });
  if (!res || !res.ok) {
    const cur = downloadsValue();
    if (cur.items[id] && cur.items[id].status === "queued") {
      saveDownloads(rules.applyProgress(cur, { id, status: "failed", reason: (res && res.reason) || "refused", now: Date.now() }));
    }
    repaintDownload(id);
    announce("Download failed.");
  } else {
    announce(allowCellular ? "Downloading." : "Downloading on Wi-Fi.");
  }
  return res;
}

/** "Downloaded ✓" → remove the file, then the row. A refusal keeps the row: a
    record that says "gone" over a file still on disk is the worse lie. */
async function removeDownload(id) {
  const bridge = state.downloadBridge;
  if (!bridge || !id) return null;
  const res = await bridge.remove({ id });
  if (res && res.ok) {
    saveDownloads(downloadsWithout(downloadsValue(), id));
    announce("Download removed.");
  } else {
    announce("Couldn't remove the download. Try again.");
  }
  repaintDownload(id);
  if (currentHash() === "#/library") renderCurrentPage();
  return res;
}

/** Library's "Remove all": every file, then every row; the cellular setting stays. */
async function removeAllDownloads() {
  const bridge = state.downloadBridge;
  if (!bridge) return null;
  const res = await bridge.removeAll();
  if (res && res.ok) {
    saveDownloads({ ...downloadsValue(), items: {} });
    announce("All downloads removed.");
  } else {
    announce("Couldn't remove the downloads. Try again.");
  }
  if (currentHash() === "#/library") renderCurrentPage();
  return res;
}

/**
 * Library's Downloads section: the usage line, the finished downloads newest
 * first as the same rows every other section draws (`rowsForIds`), Family mode
 * applied like Saved and History, and "Remove all". Only `done` rows are
 * listed — the usage line counts the same set, so the two cannot disagree.
 */
function libraryDownloadsHtml(family = () => true) {
  const rules = downloadRules();
  const value = downloadsValue();
  const done = Object.entries(value.items)
    .filter(([, rec]) => rec.status === "done")
    .sort(([, a], [, b]) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")))
    .map(([id]) => id);
  const usage = `<p class="note lib-downloads-usage">${esc(rules ? rules.usageLine(value) : "0 episodes downloaded")}</p>`;
  if (!done.length) {
    return usage + `<p class="note">Nothing downloaded yet — tap Download on an episode's page to keep it on this device.</p>`;
  }
  const rows = rowsForIds(done).filter(family).map((r, i) => r.state === "live"
    ? epRow(r.item, i, "library-downloads", -1)
    : r.state === "archived"
      ? archivedRow(r.item, i, "library-downloads")
      : `<div class="ep-row gone"><div class="info"><div class="t">Downloaded episode</div><div class="s">Its details are no longer available</div></div></div>`);
  return usage + rows.join("")
    + `<button type="button" class="up-next downloads-remove-all" data-downloads-remove-all="1">Remove all downloads</button>`;
}

/**
 * The files' share of "Delete my data", run by `clearLocalData` before the key
 * purge. Answers for the ledger in the same `{ ok, … }` shape as `events` and
 * `shards` beside it, with `state` saying what happened to the files:
 *
 *   deleted        the plugin emptied its directory (or there is no bridge,
 *                  so this device never downloaded: the web, an old shell)
 *   kept           the plugin refused or timed out: files may remain, so the
 *                  device is NOT clear and `ok` is false — "This device is
 *                  clear" would be untrue
 *   none-recorded  the shell has no ForayDownloads plugin at all (Capacitor
 *                  answers "not implemented" — every shell built before PQ-20)
 *                  AND the record lists nothing, so no file can exist: `ok`,
 *                  with the reason kept. Without this, every listener on an
 *                  older shell would read "NOT fully clear" forever.
 *
 * Any other refusal is `kept`, even with an empty record: a record can be lost
 * while its files are not, and a retry must ask the plugin again rather than
 * trust a row the previous attempt's key purge already removed.
 */
async function clearDownloads() {
  const bridge = state.downloadBridge;
  if (!bridge) return { ok: true, state: "deleted", reason: "no-bridge" };
  const recorded = Object.keys(downloadsValue().items).length;
  let res = null;
  try { res = await bridge.removeAll(); } catch (err) { res = { ok: false, reason: errLabel(err) }; }
  if (res && res.ok) return { ok: true, state: "deleted" };
  const reason = (res && typeof res.reason === "string" && res.reason) || "refused";
  if (!recorded && /not implemented|unimplemented/i.test(reason)) return { ok: true, state: "none-recorded", reason };
  return { ok: false, state: "kept", reason };
}
