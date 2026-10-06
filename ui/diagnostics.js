/* ui/diagnostics.js — Diagnostics sheet and the drawer's delete/diagnostics control bindings.
   A CLASSIC script like app.js, not a module: it shares app.js's globals and
   is loaded by index.html after app.js, in the order listed in
   docs/redesign-2026/split-notes.md. Declarations only at the top level, so
   nothing here runs until app.js's boot (ui/boot.js) starts init(). */


/* ---------- playback diagnostics (#264) ----------

   THE ENTIRE POINT OF THIS SURFACE IS WHERE IT CAN BE READ. The record it shows
   exists because two founder reports came out of a car with no numbers in them,
   and the instrument that was supposed to carry those numbers wrote them to
   `console.warn` — "a console line nobody has open", in `player/client.js`'s own
   words. So this is a drawer item and a sheet: reachable on a phone, in a car,
   with no devtools, and copyable.

   READ-ONLY AND LOCAL. There is no network call anywhere below, by design and not
   by omission — `cp_diag` is deliberately outside the `cp_events` pipeline, which
   has no consent gate (`player/diagnostic-log.js`'s header carries the argument).
   `test/diagnostics-surface.test.js` asserts that, because "we forgot to add it to
   the sync" and "it must never be in the sync" look identical in a diff.

   The text itself is rendered by `formatDiagnosticReport` in the player module, not
   here: app.js is a classic script and cannot import it, so it arrives over
   `window.forayDiagnosticReport` exactly as the storage health record does. Built
   with createElement/textContent like the delete sheet above, for the same two
   reasons — the CSP is strict, and `index.html` is outside the auto-merge
   allowlist. */
let diagUi = null;

const DIAG_SUB =
  "Technical details about how audio played on this device. "
  + "Stored here only, never sent anywhere. "
  + "Copy this into a bug report if asked for it.";

function buildDiagSheet() {
  const root = ddEl("div", "fy-sheet");
  root.id = "diag-sheet";
  root.hidden = true;

  const scrim = ddEl("div", "fy-scrim");
  const panel = ddEl("div", "fy-panel diag-panel");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");

  const title = ddEl("h3", null, "Playback diagnostics");
  title.id = "diag-title";
  panel.setAttribute("aria-labelledby", "diag-title");

  /* A readonly <textarea> and not a <pre>, and that is the phone decision. A long
     <pre> on iOS gives a tap-and-hold selection that stops at the visible box; a
     textarea's Select All takes the whole record, scrolls inside its own frame,
     and cannot be edited into something that misreports what was measured. */
  const text = ddEl("textarea", "diag-text");
  text.id = "diag-text";
  text.setAttribute("readonly", "readonly");
  text.setAttribute("spellcheck", "false");
  text.setAttribute("aria-labelledby", "diag-title");

  const actions = ddEl("div", "fy-sheet-actions");
  const close = ddEl("button", "fy-sheet-cancel", "Close");
  close.type = "button";
  const copy = ddEl("button", "fy-sheet-go diag-copy", "Copy");
  copy.type = "button";
  actions.append(close, copy);

  /* Clear is the founder's loop: clear, drive, copy. Three earlier drives in a
     200-entry ring make the drive under test hard to find. It is destructive only
     of diagnostics, so it does not carry the delete sheet's typed confirmation —
     but it is set apart from Copy so a mis-hit does not land on it. */
  const clear = ddEl("button", "diag-clear", "Clear the record");
  clear.type = "button";

  const status = ddEl("p", "dd-status");
  status.id = "diag-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");

  panel.append(
    ddEl("div", "fy-grab"), title,
    ddEl("p", "fy-sheet-sub", DIAG_SUB),
    text, actions, clear, status,
  );
  root.append(scrim, panel);
  document.body.appendChild(root);
  return { root, scrim, panel, text, copy, clear, close, status };
}

function diagSheet() {
  if (!diagUi) diagUi = buildDiagSheet();
  return diagUi;
}

/** The record, or an honest sentence about why there is not one. A blank box is
    the one answer this surface must never give: it reads as "nothing went wrong"
    when it can also mean "the player module never loaded". */
function diagText() {
  if (typeof window.forayDiagnosticReport !== "function") {
    return "The player module has not loaded on this page, so there is no record to show. "
      + "Play something and open this again.";
  }
  try {
    const out = String(window.forayDiagnosticReport() || "");
    return out || "Nothing recorded yet. Play a foray and come back.";
  } catch (err) {
    return `The record could not be read: ${err && err.message ? err.message : String(err)}`;
  }
}

/* NE-26 (docs/native-engine-plan.md): the record WITH the native engine's rows
   merged in — the page's ring and the engine's 2,000-row file ring, by wall
   clock, under one header that says which engine played. It needs one bridge
   call (engineRead 'diagnostics'), so it is a promise, and the synchronous
   `diagText()` above stays the instant answer and the fallback. Null when the
   player module has not published it (an older module, or none at all). */
function diagTextWithEngine() {
  if (typeof window.forayDiagnosticReportWithEngine !== "function") return null;
  let pending;
  try {
    pending = Promise.resolve(window.forayDiagnosticReportWithEngine());
  } catch (err) {
    pending = Promise.reject(err);
  }
  /* A merged report that failed is not a blank box either: the page's own
     record, and its own honest sentence, are what `diagText()` gives. */
  return pending.then((out) => String(out || "") || diagText(), () => diagText());
}

/* Which paint of the box is current. A merged report lands a bridge call
   later, and by then the listener may have pressed Clear or closed the sheet;
   a late answer must not paint cleared rows back into the box. */
let diagPaint = 0;

function refreshDiagSheet() {
  const ui = diagSheet();
  diagPaint++;
  ui.text.value = diagText();
}

function openDiagSheet() {
  const ui = diagSheet();
  refreshDiagSheet();
  ui.status.textContent = "";
  openSheet(ui.root, { panel: ui.panel, onRequestClose: closeDiagSheet });
  /* The page's record shows at once; the engine's rows join it when the one
     read answers, so the header a founder reads on screen is the one Copy
     takes. */
  const paint = diagPaint;
  const merged = diagTextWithEngine();
  if (merged) {
    merged.then((text) => {
      if (paint === diagPaint && !ui.root.hidden) ui.text.value = text;
    });
  }
}

function closeDiagSheet() {
  if (!diagUi) return;
  diagPaint++;
  closeSheet(diagUi.root);
  diagUi.root.hidden = true;
}

/**
 * Put the record on the clipboard.
 *
 * Two paths, because the async Clipboard API is not available everywhere this
 * app runs — it needs a secure context, and WKWebView has historically refused
 * it. The fallback selects the whole record so the listener's own Copy gesture
 * takes all of it rather than the visible box, and the status line SAYS which
 * happened. A copy that silently did nothing is worse than one that asks.
 */
async function copyDiagnostics() {
  const ui = diagSheet();
  /* NE-26: Copy takes the record with the engine's rows merged in, read ONCE,
     now — not whatever the box held when it opened — and shows what it took.

     THE CLIPBOARD IS ASKED INSIDE THE TAP. The merged text is a bridge call
     away, and WebKit grants clipboard writes only within the user's gesture; a
     writeText after that await can be refused as outside it. A ClipboardItem
     whose content is a PROMISE is WebKit's own answer to exactly this: the
     write is requested synchronously, and the text fills it when it resolves.
     Where that is missing, the text is awaited and written the old way, and a
     refusal falls through to selection as it always has. */
  const merged = diagTextWithEngine();
  if (merged) {
    diagPaint++;
    const paint = diagPaint;
    const clip = navigator.clipboard;
    if (clip && typeof clip.write === "function" && typeof ClipboardItem === "function" && typeof Blob === "function") {
      try {
        const wrote = clip.write([new ClipboardItem({
          "text/plain": merged.then((text) => new Blob([text], { type: "text/plain" })),
        })]);
        const text = await merged;
        if (paint === diagPaint) ui.text.value = text;
        await wrote;
        ui.status.textContent = "Copied to the clipboard.";
        return true;
      } catch (_) { /* fall through: the text is in the box, and writeText or selection takes it */ }
    }
    const text = await merged;
    if (paint === diagPaint) ui.text.value = text;
  }
  const body = ui.text.value;
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(body);
      ui.status.textContent = "Copied to the clipboard.";
      return true;
    }
  } catch (_) { /* fall through to selection: a refused clipboard is not an error */ }
  try {
    ui.text.focus();
    if (typeof ui.text.select === "function") ui.text.select();
  } catch (_) { /* nothing left to try */ }
  ui.status.textContent = "The record is selected. Use your device's copy to take it.";
  return false;
}

function clearDiagnostics() {
  const ui = diagSheet();
  if (typeof window.forayDiagnosticClear === "function") {
    try {
      window.forayDiagnosticClear();
      refreshDiagSheet();
      ui.status.textContent = "Cleared. The next thing you play starts a fresh record.";
      return true;
    } catch (_) { /* fall through to the honest message */ }
  }
  ui.status.textContent = "There is nothing to clear on this page.";
  return false;
}

/** Appended at startup to the Developer group, which sits ABOVE "Delete my
    data" — see the note in `init()`. Bound once, like the control below it. */
function bindDiagnosticsControl() {
  const drawer = $("#drawer");
  if (!drawer || $("#diag-open")) return;
  const btn = ddEl("button", "drawer-item as-btn", "Playback diagnostics");
  btn.type = "button";
  btn.id = "diag-open";
  (drawerDevGroup() || drawer).appendChild(btn);
  btn.addEventListener("click", openDiagSheet);

  const ui = diagSheet();
  ui.close.addEventListener("click", closeDiagSheet);
  ui.scrim.addEventListener("click", closeDiagSheet);
  ui.copy.addEventListener("click", () => copyDiagnostics());
  ui.clear.addEventListener("click", () => clearDiagnostics());
}

/** Appended to the drawer at startup. Bound once — `init()` is the only caller,
    and a second call must not stack a second button or a second listener. */
function bindDeleteControl() {
  const drawer = $("#drawer");
  if (!drawer || $("#delete-data")) return;
  const btn = ddEl("button", "drawer-item as-btn dd-open", "Delete my data");
  btn.type = "button";
  btn.id = "delete-data";
  drawer.appendChild(btn);
  btn.addEventListener("click", openDeleteSheet);

  const ui = deleteSheet();
  ui.input.addEventListener("input", syncDeleteCta);
  ui.cancel.addEventListener("click", closeDeleteSheet);
  ui.scrim.addEventListener("click", closeDeleteSheet);
  ui.go.addEventListener("click", () => deleteMyData());
  ui.deviceOnly.addEventListener("click", () => deleteMyData({ deviceOnly: true }));
}
