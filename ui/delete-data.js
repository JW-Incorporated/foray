/* ui/delete-data.js — Delete-my-data flow: remote and local deletion and its sheet.
   A CLASSIC script like app.js, not a module: it shares app.js's globals and
   is loaded by index.html after app.js, in the order listed in
   docs/redesign-2026/split-notes.md. Declarations only at the top level, so
   nothing here runs until app.js's boot (ui/boot.js) starts init(). */


/* ---------- delete my data (#42) ----------

   WHY THIS EXISTS
   Google Play's Data Safety form asks whether users can request that their data
   be deleted, and until this control existed the only honest answer was No — a
   store-submission blocker, and long before that a real gap: a listener who
   wanted out had nothing but their browser's site-data screen, which cannot
   touch the rows already sent to our database.

   WHAT "DELETE" MEANS HERE, exactly, because a control that clears half of it
   and says "done" is worse than no control at all:

     1. BOTH LOCAL TIERS. Every `cp_` key, in `localStorage` AND in the IndexedDB
        database, enumerated FROM THE TIERS THEMSELVES (`DurableStore.purge`) and
        then re-read to prove they are gone. There is deliberately no key list in
        this file: the audit behind `docs/legal/privacy-policy.md` found **20**
        keys where every earlier count said 11, two of them patterned
        (`cp_foray:<id>`, `cp_pos:<id>`), and a list typed here would rot exactly
        the way that count did. In the native app the Preferences tier is a third
        tier, and `purge()` reaches it the same way.
     1b. THE EVENT QUEUE, which is NOT a `cp_` key: M3 moved it into its own
        IndexedDB database (`foray_events`, `player/event-log.js`), outside the
        enumeration above. Until the 2026-09-22 audit this control said "This
        device is clear" while every event row survived there — episode ids,
        positions, the old profile id — and the unsynced ones were then uploaded
        under the NEW anonymous account the next launch mints. `clearEventLog()`
        purges it and re-reads it, and its answer is folded into `ok`.
        `test/data-deletion.test.js` enumerates every database and cache the
        shipped code opens, so a third store cannot appear unaccounted for.
     2. THE SERVER ROWS. Every per-user table's row-level-security policy is
        `for all` (`backend/migrations/supabase/0001_auth_and_rls.sql`), so this
        client can delete its own rows under its own `auth.uid()`. It was a
        missing request, never a missing permission.
     3. NOT THE ANONYMOUS ACCOUNT ROW ITSELF, and the UI says so in words.
        Deleting a Supabase auth user needs the admin API and a service-role key,
        and a key that can delete any account cannot ship inside a public web
        page (this repo's automation is deliberately keyless — CLAUDE.md). What
        this control can do, and does, is cut the link: the token and the local
        id are two of the 20 keys, so the next event creates a NEW anonymous
        account instead of re-attaching to the old one. What stays behind is a row
        with no name, email, phone number or password — and `app_users` plus the
        events keyed to it are deleted, so it is an empty shell. Removing the
        shell is `HUMAN-ACTIONS.md` #14.
     4. NOT THE PUBLISHER AND ATTRIBUTION HOSTS. Playing a segment points an
        `<audio>` element at the publisher's own URL, so 43 first-hop hosts —
        several of them ad-attribution prefixes the publisher put there — saw
        this listener's IP address directly. We never received it and cannot
        delete it. The policy discloses that (§4) and this control must not imply
        otherwise, which is why one line of the sheet says so.

   TWO ORDERING RULES, both load bearing:
     - PLAYBACK STOPS FIRST, without flushing. A running player writes a position
       roughly every 15 seconds and a Foray resume row with it, so a clear
       underneath live playback is undone one tick later.
     - REMOTE BEFORE LOCAL. `cp_sb_session` is the only credential that can
       delete the server rows, and clearing local destroys it. So a remote
       failure STOPS the run with the device untouched and the token intact,
       rather than stranding rows nothing can ever reach again. It is also why
       nothing on that path is worded as a success: a false success is the worst
       outcome this control can produce. */

/* The per-user tables an anonymous client owns rows in, in deletion order —
   `events` first because it is the only table this client writes and therefore
   the one the promise rests on, `app_users` last because everything else keys to
   it. The list is pinned against the RLS migration by
   `test/data-deletion.test.js`, so a new per-user table cannot appear there
   without this list failing. */
const SB_USER_TABLES = [
  "events", "saved_items", "user_interests", "sessions", "session_items",
  "subscriptions", "taxonomy_nodes", "learning_cursor", "app_users",
];

/** Three outcomes per table, and the difference between them is the whole
    honesty of this feature. `absent` is a 404: the table is not in this project's
    API at all, so it holds no rows of ours — a true statement, not a shrug. */
const DEL_DELETED = "deleted";
const DEL_ABSENT = "absent";
const DEL_FAILED = "failed";
/* A fourth, for a table whose delete policy this build cannot rely on: the
   DELETE was accepted and no row came back, so we cannot say one was removed. */
const DEL_UNCONFIRMED = "unconfirmed";

/* Tables whose own-rows DELETE policy is not known to be live (round-3 review,
   L6). `learning_cursor` gets `own_delete_learning_cursor` from
   supabase/0003, which is NOT applied to production (founder Q3); under 0002
   the table is deny-all, and a DELETE there is a 204 that removes nothing. So
   for these the request asks for the deleted rows back, and only rows it SAW
   removed count as deleted. An empty answer is "unconfirmed", never "deleted",
   and the sheet says so. Take a table off this list once its policy is live. */
const SB_DELETE_UNVERIFIED = new Set(["learning_cursor"]);

/**
 * The account this device already has — never a new one.
 *
 * `ensureAnonSession()` signs up when it finds no token, which is right for
 * syncing and absurd here: creating an account in order to delete one would
 * leave a fresh row behind and delete nothing. A stale token is refreshed if we
 * can; if the refresh fails we try the token we have and let the server's answer
 * be the answer.
 *
 * A REFRESH IS SAVED THE MOMENT IT ARRIVES (round-2 audit, persist-1). Supabase
 * rotates refresh tokens: the one we send is spent by the call that answers it.
 * This used to return the refreshed session without storing it, so a run that
 * then hit one failing table left `cp_sb_session` holding a spent token — every
 * retry 401'd, and the next event sync's own refresh failed and signed up a NEW
 * account, stranding the rows the "remote before local" rule exists to keep
 * reachable. It is written through `lsSet`, and ALSO held in `rotatedSession`,
 * because a store that refused the write would otherwise hand the retry the
 * spent token all the same.
 */
let rotatedSession = null;

async function existingAnonSession() {
  const now = Math.floor(Date.now() / 1000);
  const stored = lsGet("cp_sb_session", null);
  /* Only while the store still holds the token this module spent: a newer
     session written since (a sync's own refresh) is the newer truth. */
  const s = rotatedSession && stored && stored.refresh_token === rotatedSession.spent
    ? rotatedSession.session
    : stored;
  if (!s || !s.access_token || !s.user_id) return null;
  if (s.expires_at && s.expires_at - 60 > now) return s;
  if (s.refresh_token) {
    const res = await sbAuth("/auth/v1/token?grant_type=refresh_token", { refresh_token: s.refresh_token });
    const r = res.ok ? res.body : null;
    if (r && r.access_token) {
      /* `r.user.id` is not assumed to exist. A refresh response without a `user`
         object is not a shape we have seen, but reading through it would throw a
         TypeError out of the whole deletion — and the id we already hold is the
         same account by definition, since this is a refresh of its own token. */
      const fresh = {
        user_id: (r.user && r.user.id) || s.user_id,
        access_token: r.access_token,
        refresh_token: r.refresh_token || s.refresh_token,
        expires_at: r.expires_at || now + 3600,
      };
      rotatedSession = { spent: stored && stored.refresh_token, session: fresh };
      lsSet("cp_sb_session", fresh);
      return fresh;
    }
  }
  return s;
}

/** One authenticated DELETE, filtered to this account's own rows. */
async function sbDeleteOwnRows(table, session) {
  const verify = SB_DELETE_UNVERIFIED.has(table);
  const url = `${SB_URL}/rest/v1/${table}?user_id=eq.${encodeURIComponent(session.user_id)}${verify ? "&select=user_id" : ""}`;
  try {
    const res = await fetch(url, {
      method: "DELETE",
      headers: {
        apikey: SB_KEY,
        Authorization: "Bearer " + session.access_token,
        Prefer: verify ? "return=representation" : "return=minimal",
      },
    });
    if (res.ok && verify) {
      let rows = null;
      try { rows = await res.json(); } catch (_) { rows = null; }
      const removed = Array.isArray(rows) ? rows.length : 0;
      return { table, state: removed > 0 ? DEL_DELETED : DEL_UNCONFIRMED, status: res.status };
    }
    if (res.ok) return { table, state: DEL_DELETED, status: res.status };
    // Not in the API schema => no rows of ours are in it. Anything else — 401,
    // 403, 409, 500 — is a refusal we must not round down to success.
    if (res.status === 404) return { table, state: DEL_ABSENT, status: 404 };
    return { table, state: DEL_FAILED, status: res.status };
  } catch (_) {
    // Offline, DNS, CSP, a dropped connection: no answer at all.
    return { table, state: DEL_FAILED, status: 0 };
  }
}

/**
 * Sign the account out EVERYWHERE, on the server: every refresh token it was
 * ever issued stops working (`POST /auth/v1/logout?scope=global`, with the
 * account's own access token — no administrative key needed).
 *
 * WHY A DELETION DOES THIS (review of #773, 2026-09-24). Clearing the device
 * destroys this copy of the token, not the others. A phone backup made by a
 * build before the device-only vault holds `cp_sb_session` in three places,
 * and restoring it onto a new phone put the deleted account's live refresh
 * token back in the app, which re-attached to it. Revoked here, that copy is
 * dead wherever it is, which is what the privacy policy's §3 and §7 promise.
 */
async function sbRevokeSessions(session) {
  try {
    const res = await fetch(SB_URL + "/auth/v1/logout?scope=global", {
      method: "POST",
      headers: { apikey: SB_KEY, Authorization: "Bearer " + session.access_token },
    });
    return { ok: Boolean(res.ok), status: res.status };
  } catch (_) {
    return { ok: false, status: 0 };
  }
}

/**
 * Delete every server row this device's account owns, then revoke its sign-in.
 *
 * `ok` is false if ANY table refused or the revocation failed, and the caller
 * must then not clear local storage — see the ordering rules above. The
 * revocation comes LAST: it needs the token the row DELETEs need, and a retry
 * after a failed table must still be able to reach the rows.
 */
/* A REMOTE STEP THAT ALREADY SUCCEEDED, remembered for the retry (audit round
   3, app-3-6). A run whose server step succeeded and whose local clear did not
   says "Close 4a fully and try again". The retry used to start from scratch:
   with cp_sb_session gone it said the device was "never signed in" (the rows
   were deleted a moment ago), and with a surviving expired token it refreshed
   a token this module had just revoked, every DELETE 401'd, and the sheet said
   the server copy was NOT deleted and left the device uncleared. So the success
   is kept here -- in memory, deliberately not a `cp_` key: it names the
   account the run deleted, and the purge must not have to spare it -- and a
   retry for that same account (or with no token left) reports it as done
   without a request. Across a relaunch the memory is gone, and what keeps the
   retry honest there is that cp_sb_session is removed FIRST, on its own, the
   moment the server step succeeds (deleteMyData). */
let ddRemoteDone = null;

async function deleteRemoteData() {
  if (ddRemoteDone) {
    const stored = lsGet("cp_sb_session", null);
    if (!stored || !stored.user_id || stored.user_id === ddRemoteDone.userId) {
      return { ok: true, attempted: true, alreadyDeleted: true, tables: [], failed: [], unconfirmed: ddRemoteDone.unconfirmed || [], deleted: 0, userId: ddRemoteDone.userId };
    }
  }
  const session = await existingAnonSession();
  if (!session) return { ok: true, attempted: false, tables: [], deleted: 0 };
  const tables = [];
  for (const t of SB_USER_TABLES) tables.push(await sbDeleteOwnRows(t, session));
  const failed = tables.filter(r => r.state === DEL_FAILED);
  const revoked = failed.length === 0 ? await sbRevokeSessions(session) : null;
  return {
    ok: failed.length === 0 && Boolean(revoked && revoked.ok),
    attempted: true,
    tables,
    failed,
    // Accepted, but no row seen removed: not counted, and not called deleted.
    unconfirmed: tables.filter(r => r.state === DEL_UNCONFIRMED).map(r => r.table),
    revoked,
    deleted: tables.filter(r => r.state === DEL_DELETED).length,
    userId: session.user_id,
  };
}

/**
 * Clear everything this device holds about the listener: the event queue
 * (`clearEventLog`) and every `cp_` key in every tier (`clearStoredKeys`).
 *
 * The real work for the keys is `DurableStore.purge()`, which enumerates the tiers rather
 * than the facade and verifies afterwards. The fallback in `clearStoredKeys` matters and is not
 * decoration: app.js and `player/client.js` deploy independently through the
 * service worker, so a page can be running with no store published — and then
 * `localStorage` is reachable and IndexedDB is not. That case reports `ok: false`
 * with a reason, because a cleared mirror is not cleared storage.
 */
async function clearLocalData() {
  /* FIRST, before any await, AND HERE RATHER THAN IN `stopForDataDeletion()` (#264). `purge()` empties
     both tiers of every `cp_` key including `cp_diag`, but the player module holds
     that ring IN MEMORY — so without this the next time the listener pockets their
     phone, the record is written straight back under a key they just asked to be
     emptied. It belongs in THIS function and not in the stop, because the stop runs
     before the server step and a remote failure leaves the device untouched on
     purpose; clearing there destroyed the record on a path that promises not to. */
  try {
    if (typeof window.forayForgetDiagnostics === "function") window.forayForgetDiagnostics();
  } catch (_) { /* a diagnostic that will not clear is not a reason to refuse a deletion */ }

  /* The pre-module buffer (`logEvent` before `window.forayEventLog` exists) is
     event rows in memory, and `flushBufferedEvents()` would hand them to the
     queue this function is about to empty. */
  _bufferedEvents = [];
  /* THE KEYS FIRST, THE QUEUE LAST (review 2026-09-23), and nothing logged in
     between (`dataDeletionInProgress`). The queue used to be emptied first, so
     a storage fault raised by the key purge landed a fresh row — under a fresh
     profile id — in a queue already reported empty. */
  dataDeletionInProgress = true;
  localClears++;
  rotatedSession = null;
  try {
    /* THE DOWNLOADED FILES BEFORE THE KEYS (#29, PQ-18): `clearDownloads` has to
       read `cp_downloads` to know whether any file was ever written, and the key
       purge below removes that row. Here and not before the server step in
       `deleteMyData`, because a remote failure promises "Nothing on this device
       was touched", and after the player stop, so nothing is playing a file
       that is about to go. */
    const downloads = await clearDownloads();
    const local = await clearStoredKeys();
    const events = await clearEventLog();
    const shards = await clearShardCache();
    /* One `ok` for the whole device. A clear `cp_` namespace beside a surviving
       event queue is exactly the false "This device is clear" this replaced. */
    return {
      ...local,
      ok: Boolean(local.ok) && Boolean(events.ok) && Boolean(shards.ok) && Boolean(downloads.ok),
      events, shards, downloads,
    };
  } finally {
    dataDeletionInProgress = false;
  }
}

/**
 * Drop the Shows-search shard cache (round-2 audit, persist-4).
 *
 * Its rows are public, but WHICH rows it holds is not: one entry per two-letter
 * prefix of the longest word the listener searched for, so the set of keys is
 * a trace of their searches. It is a cache — losing it costs one re-fetch — so
 * it goes with everything else. `caches.delete` answers false for a bucket that
 * was never opened, which is a clear bucket, not a failure; only a throw is.
 */
async function clearShardCache() {
  if (typeof caches === "undefined" || !caches || typeof caches.delete !== "function") return { ok: true, reason: "no-cache-storage" };
  try {
    await caches.delete(SHARD_CACHE_NAME);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: "shard-cache", error: errLabel(err) };
  }
}

/**
 * Empty the outbound event queue (`player/event-log.js`, database
 * `foray_events`) and report whether the re-read found it empty.
 *
 * With no queue published there is nothing this page can open to check, and
 * that is reported as not-done rather than assumed done: the queue and the
 * store arrive together from `player/client.js`, so its absence means the
 * module did not load, which `clearStoredKeys` reports too.
 */
async function clearEventLog() {
  const log = window.forayEventLog;
  if (!log || typeof log.purge !== "function") return { ok: false, remaining: null, reason: "no-event-log" };
  try {
    const out = await log.purge();
    return out && typeof out === "object" ? out : { ok: false, remaining: null, reason: "no-answer" };
  } catch (err) {
    return { ok: false, remaining: null, reason: "purge-failed", error: errLabel(err) };
  }
}

/** Every `cp_` key in every tier — see `DurableStore.purge()`. */
async function clearStoredKeys() {
  const store = storageBackend();
  if (!store) return { ok: false, keys: [], remaining: [], reason: "no-storage" };
  if (typeof store.purge === "function") {
    /* `purge()` is written not to throw, but "written not to throw" is not a
       guarantee, and a throw here would leave the control stuck mid-delete
       (`ddBusy`) with a spinner and no way out. Report it as what it is. */
    try { return await store.purge(); }
    catch (err) { return { ok: false, keys: [], remaining: [], reason: "purge-failed", error: errLabel(err) }; }
  }

  /* EVERY read here is guarded, not just the writes. This branch exists for the
     browser where storage is degraded, and `SecurityError` (blocked cookies, some
     private modes) comes out of `length` and `getItem` exactly as readily as out
     of `removeItem`. Review found the unguarded ones. */
  const keys = [];
  try {
    const n = Number(store.length) || 0;
    for (let i = 0; i < n; i++) {
      const k = store.key(i);
      if (typeof k === "string" && k.startsWith("cp_")) keys.push(k);
    }
  } catch (err) {
    return { ok: false, keys: [], remaining: [], reason: "no-storage", error: errLabel(err) };
  }
  // Collected before removing: removing while enumerating shifts every index
  // after it, which silently skips half the keys.
  const remaining = [];
  for (const k of keys) {
    let gone = false;
    try { store.removeItem(k); gone = store.getItem(k) === null; } catch (_) { gone = false; }
    if (!gone) remaining.push(k);
  }
  return { ok: false, keys, remaining, reason: "no-durable-tier" };
}

/** An error's name, for a status line a listener reads. Never the message: a
    browser's storage error text is not English anyone asked for. */
function errLabel(err) {
  return err && err.name ? String(err.name) : "error";
}

/**
 * Everything the sheet says, in one place, so the wording is testable without a
 * browser and cannot drift from the result.
 *
 * Two rules it is written to, both pinned by `test/data-deletion.test.js`:
 *   - EVERY sentence is inside the copy budget (CLAUDE.md principle 4, ≤ 18
 *     words), because these are the words a listener reads at the one moment
 *     they are least inclined to re-read anything.
 *   - IT CLAIMS ONLY WHAT WAS OBSERVED. A `DELETE` returns 204 whether or not a
 *     row matched, so "deleted from 8 tables" would be a number we did not
 *     measure. "Your rows on our server are deleted" is true either way.
 */
function deletionMessage(result) {
  const { state, remote, local } = result;
  /* No storage vocabulary reaches the listener here — no "key", no "tier", no
     error class. Those are in `result.local` for diagnostics. The audit found
     this line reading "0 key(s) would not clear.": a count that could be zero
     while the sentence said something failed, in a word nobody uses. */
  if (state === "unconfirmed") return "Type DELETE to confirm.";
  if (state === "busy") return "Deleting…";
  if (state === "remote-failed") {
    /* Every table answered but the sign-in could not be revoked: the rows ARE
       gone, and saying otherwise would be its own untruth. */
    if (remote && Array.isArray(remote.failed) && !remote.failed.length && remote.revoked && !remote.revoked.ok) {
      return "Your rows on 4a's server are deleted, but its sign-in is NOT switched off yet. Nothing on this device was touched, so you can try again.";
    }
    return "What 4a's server kept about you was NOT deleted. Nothing on this device was touched, so you can try again.";
  }
  const server = remote && remote.deviceOnly
    ? "What 4a's server kept about you was left in place, as you chose."
    : !remote || !remote.attempted
      ? "No sign-in remains on this device, so nothing on 4a's server is reachable from it."
      /* A table the server accepted the DELETE for but showed no removed row
         (SB_DELETE_UNVERIFIED): claiming it is gone would be a false success. */
      : Array.isArray(remote.unconfirmed) && remote.unconfirmed.length
        ? "What 4a's server kept about you is deleted, except possibly one bookkeeping record."
        : "What 4a's server kept about you is deleted.";
  if (local && local.ok) return `Done. ${server} This device is clear.`;
  return `${server} This device is NOT fully clear. ${deviceNotClearReason(local)}`;
}

/** Why the device is not clear, in the listener's words: the first reason that
    applies, and always something to do next where there is one. */
function deviceNotClearReason(local) {
  const reason = local && local.reason;
  if (reason === "no-storage") return "This device gives 4a nowhere to store anything.";
  if (reason === "no-durable-tier") return "Part of this device's storage is out of reach. Close 4a fully and try again.";
  if (reason === "purge-failed") return "Storage refused the delete. Close 4a fully and try again.";
  if (local && Array.isArray(local.unverified) && local.unverified.length) {
    return "Storage could not be checked afterwards. Close 4a fully and try again.";
  }
  if (local && Array.isArray(local.remaining) && local.remaining.length) {
    return "Some of what 4a saved here would not clear. Close 4a fully and try again.";
  }
  if (local && local.events && !local.events.ok) {
    return "The record of what you played here would not clear. Close 4a fully and try again.";
  }
  return "Some of what 4a saved here would not clear. Close 4a fully and try again.";
}

/* The sheet and the drawer button are built in JavaScript rather than written
   into `index.html`, for the same mechanical reason `player/client.js` builds the
   whole mini-player that way: `index.html` is outside the auto-merge allowlist
   (`tools/ci/path-policy.mjs`), and this control should not need a founder merge
   to reach the listener it is for. createElement + textContent throughout — the
   page CSP is strict and none of this text is user-supplied anyway. */
let ddUi = null;
let ddBusy = false;

function ddEl(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/** What the control covers and what it cannot. Every line is read by a listener,
    so every line is inside the copy budget (CLAUDE.md principle 4). */
const DD_COVERS = [
  "This device: everything 4a stored here, including the record of what you played.",
  "4a's server: the events this device sent, and what it keeps about this device.",
  "Your anonymous account row stays. It holds no name, email or phone number.",
  "Publisher and ad hosts saw your IP as audio played. 4a cannot delete that.",
];

const DD_DEVICE_ONLY_COST = "After this, what 4a's server kept about you can no longer be deleted.";

function buildDeleteSheet() {
  const root = ddEl("div", "fy-sheet");
  root.id = "dd-sheet";
  root.hidden = true;

  const scrim = ddEl("div", "fy-scrim");
  const panel = ddEl("div", "fy-panel dd-panel");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");

  const title = ddEl("h3", null, "Delete my data");
  title.id = "dd-title";
  panel.setAttribute("aria-labelledby", "dd-title");

  const list = ddEl("ul", "dd-covers");
  for (const line of DD_COVERS) list.append(ddEl("li", null, line));

  const label = ddEl("label", "dd-label", "Type DELETE to confirm");
  label.setAttribute("for", "dd-confirm");
  const input = ddEl("input", "dd-input");
  input.id = "dd-confirm";
  input.type = "text";
  input.setAttribute("maxlength", "12");
  input.setAttribute("autocomplete", "off");
  input.setAttribute("spellcheck", "false");

  const actions = ddEl("div", "fy-sheet-actions");
  const cancel = ddEl("button", "fy-sheet-cancel", "Cancel");
  cancel.type = "button";
  const go = ddEl("button", "fy-sheet-go dd-go", "Delete everything");
  go.type = "button";
  go.disabled = true;
  actions.append(cancel, go);

  /* Offered only after a remote failure, and never before: it is the honest
     escape hatch for someone who cannot reach the server and still wants this
     device cleared, and it states the cost on its own face. */
  const deviceOnly = ddEl("button", "dd-device-only", "Clear this device only");
  deviceOnly.type = "button";
  deviceOnly.hidden = true;
  /* The cost the button's label cannot carry (round-2 audit, persist-7). This
     device's token is the only credential that reaches the server copy, and
     this clear erases it — so "try again" stops being true the moment it runs.
     Shown beside the button, before the tap, and left up after it. */
  const deviceOnlyCost = ddEl("p", "fy-sheet-sub dd-device-only-cost", DD_DEVICE_ONLY_COST);
  deviceOnlyCost.hidden = true;
  /* BEFORE THE TAP FOR A SCREEN READER TOO (audit round 2 review): the
     sentence sat AFTER the button in DOM order and was not linked to it, so
     VoiceOver and TalkBack read "Clear this device only, button" and the one
     irreversible choice on the sheet could be taken before the cost was heard.
     It now comes first in the panel, and the button is described by it. */
  deviceOnlyCost.id = "dd-device-only-cost";
  deviceOnly.setAttribute("aria-describedby", deviceOnlyCost.id);

  const status = ddEl("p", "dd-status");
  status.id = "dd-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");

  panel.append(
    ddEl("div", "fy-grab"), title,
    ddEl("p", "fy-sheet-sub", "This cannot be undone. Here is what it covers."),
    list, label, input, actions, deviceOnlyCost, deviceOnly, status,
  );
  root.append(scrim, panel);
  document.body.appendChild(root);
  return { root, scrim, panel, input, go, cancel, deviceOnly, deviceOnlyCost, status };
}

function deleteSheet() {
  if (!ddUi) ddUi = buildDeleteSheet();
  return ddUi;
}

/** The confirmation itself, and the ONLY thing that permits a deletion.
    Deliberately a typed word rather than a second click: the sheet's own buttons
    sit where a scrim tap or a mis-hit lands, and one stray click must not be
    able to delete a listener's account. */
function deleteConfirmed() {
  return Boolean(ddUi) && String(ddUi.input.value || "").trim().toUpperCase() === "DELETE";
}

function syncDeleteCta() {
  if (!ddUi) return;
  // BOTH destructive buttons answer to the typed word. The device-only one is
  // still destructive — it is the same clear with the server step skipped.
  const armed = !ddBusy && deleteConfirmed();
  ddUi.go.disabled = !armed;
  ddUi.deviceOnly.disabled = !armed;
}

/* Opening always DISARMS. The drawer item is the surface a stray tap lands on,
   and a sheet that reopened still holding a typed `DELETE` would turn the second
   stray tap into a deletion. Review found this: closing cleared the field, and
   reopening without closing did not. */
function openDeleteSheet() {
  const ui = deleteSheet();
  ui.input.value = "";
  ui.status.textContent = "";
  ui.deviceOnly.hidden = true;
  ui.deviceOnlyCost.hidden = true;
  ddBusy = false;
  syncDeleteCta();
  openSheet(ui.root, { panel: ui.panel, onRequestClose: closeDeleteSheet });
}

function closeDeleteSheet() {
  if (!ddUi || ddBusy) return;     // never vanish mid-delete
  closeSheet(ddUi.root);
  ddUi.root.hidden = true;
  ddUi.input.value = "";
  syncDeleteCta();
}

/**
 * Delete it all. Returns the result rather than only painting it, so the
 * ordering and the failure paths are testable.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.deviceOnly] skip the server step — offered only after a
 *   remote failure, so that someone offline can still clear their device having
 *   been told plainly that the rows remain.
 */
async function deleteMyData({ deviceOnly = false } = {}) {
  // A second click while the first run is in flight would race two purges and
  // two DELETEs against one token.
  if (ddBusy) return { ok: false, state: "busy", remote: null, local: null };
  /* The confirmation gates BOTH paths, device-only included: it is the same
     destructive clear with the server step skipped, and its button is only ever
     on screen after a failure — which is exactly when someone is jabbing at the
     sheet. */
  if (!deleteConfirmed()) {
    const out = { ok: false, state: "unconfirmed", remote: null, local: null };
    paintDeletion(out);
    return out;
  }
  ddBusy = true;
  deletionEpoch += 1;
  syncDeleteCta();
  if (ddUi) ddUi.status.textContent = "Deleting…";

  /* try/finally, because `ddBusy` is what disables the buttons AND what stops
     `closeDeleteSheet` dismissing a run mid-flight. Review proved the cost of
     getting this wrong: one throw left the sheet reading "Deleting…" forever with
     Cancel, the scrim and the confirm button all dead until a reload. */
  try {
    // Stop first, and write nothing on the way out.
    try {
      const player = window.ForayPlayer;
      if (player && typeof player.stopForDataDeletion === "function") {
        await player.stopForDataDeletion();
      }
    } catch (_) { /* an unstoppable player is not a reason to refuse a deletion */ }

    /* Then wait out any event sync already running (persist-8), so its POST
       cannot land after the `events` DELETE. Bounded: a sync stuck on a dead
       socket must not hold the deletion, and the `syncOutlived()` checks
       inside it stop it writing anything once it wakes. */
    if (syncsInFlight.size) {
      await withDeadline(Promise.allSettled([...syncsInFlight]), SYNC_SETTLE_MS, () => null);
    }

    const remote = deviceOnly
      ? { ok: true, attempted: false, deviceOnly: true, tables: [], deleted: 0 }
      : await deleteRemoteData();
    if (remote && !remote.ok) {
      // The device is untouched on purpose: its token is the only way back to
      // those rows.
      const out = { ok: false, state: "remote-failed", remote, local: null };
      paintDeletion(out);
      return out;
    }

    /* The server rows are gone and the sign-in revoked: remember it for a
       retry, and drop the now-dead token FIRST and on its own, so a purge
       that fails part-way can never leave a retry holding it (app-3-6). */
    if (remote && remote.attempted && remote.ok && !remote.deviceOnly) {
      ddRemoteDone = { userId: remote.userId || null, unconfirmed: remote.unconfirmed || [] };
      rotatedSession = null;
      try { const st = storageBackend(); if (st) st.removeItem("cp_sb_session"); } catch (_) { /* the purge below tries again */ }
    }

    const local = await clearLocalData();
    const out = { ok: Boolean(local.ok), state: local.ok ? "done" : "local-incomplete", remote, local };

    /* In-memory state outlives storage, so a page left as it was would still show
       a resume rail and thumbs that no longer exist anywhere. Interests are reset
       to taxonomy defaults, which `loadInterests` does WITHOUT writing.
       `buildCards()` is deliberately not called: it writes `cp_recent_branches`
       and `cp_seen`, which would put two of the 20 keys straight back.
       Bump `_interestsGen` here too, same as nudgeTopics does on every
       pick/play/thumbs — otherwise buildPlaylist's `searchCache` (keyed on
       [query, familyMode, _interestsGen]) would happily serve back a
       pre-wipe, interest-ranked result for the exact same query, silently
       undercutting "reset personalization". */
    state.interests = {};
    interestsSetThisSession = new Set();
    loadInterests();
    state._interestsGen = (state._interestsGen || 0) + 1;
    state.forayResume = null;
    state.forayPlaying = null;
    state.foray = null;
    state.forayPainted = null;
    /* And this is the one action the app does not log. `logEvent` writes
       `cp_events` and mints `cp_profile_id`, and the next sync would create a
       fresh anonymous account — telling our server about a deletion by starting a
       new identity. */
    paintDeletion(out);
    /* The re-render happens UNDER the open sheet, and a device just emptied is
       exactly the profile the first-time explainer opens for — it used to slide
       up over "This device is clear" (persist-2). Held for this one render
       only; the next real navigation shows it as it would on a new install. */
    onboardingHeld = true;
    try { route(); } finally { onboardingHeld = false; }
    return out;
  } finally {
    ddBusy = false;
    syncDeleteCta();
  }
}

/* How long `deleteMyData` waits for an event sync already in flight. `let`, so
   a suite can shorten it. */
let SYNC_SETTLE_MS = 5000;

function paintDeletion(result) {
  if (!ddUi) return;
  ddUi.status.textContent = deletionMessage(result);
  ddUi.deviceOnly.hidden = result.state !== "remote-failed";
  ddUi.deviceOnlyCost.hidden = !(result.state === "remote-failed" || (result.remote && result.remote.deviceOnly));
  syncDeleteCta();
}
