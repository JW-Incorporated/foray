/* Notification taps: a new-episode alert for a followed show, tapped, opens
   that show's page in the app (#761, docs/roadmap/player-features.md PQ-28
   step (2), the JS half).

   WHAT ARRIVES. The iOS `ForayNotify` plugin (PQ-28's Swift half, a
   human-merge PR) posts the local notification with the show's id in its
   userInfo and, when the listener taps it, fires `alertOpened` with
   `{ showId }`. Routing in this app is hash-only, so the tap becomes
   `#/show/<id>` and app.js's router renders it exactly as it renders a tap on
   an in-app link (the same landing player/incoming-link.js gives a shared
   link). The id is encoded, never trusted as a route: a payload without a
   non-empty string `showId` is ignored, returned as null.

   NEVER THROWS. A missing bridge, a bridge with no event path, a payload of
   the wrong shape and a `navigate` that throws all leave the page where it
   was. The event subscription is native-engine.js's `listenTo` (the ONE copy,
   code-health CH-12), imported, never re-written here.

   HOW PQ-28 MUST BIND THIS: the same way client.js binds bindIncomingLinks,
   at module evaluation, before app.js's async init() reaches its relaunch
   route. The Swift side buffers the last tap until a listener attaches, so a
   cold start from a notification lands on the show only if the listener is
   attached that early; bound later, the relaunch route wins and the tap is
   lost behind the page last left.

   DELIBERATELY NOT IMPORTED YET (code-health CH-07): nothing imports this
   module, so it is not in client.js's import closure and not on the boot
   list. PQ-28 adds the import in client.js (and so the boot list) in the same
   PR that ships the plugin; until then the plugin does not exist and there is
   nothing to listen to. */

import { listenTo } from "./native-engine.js";

export const ALERT_PLUGIN = "ForayNotify";
export const ALERT_EVENT = "alertOpened";

/**
 * The in-app hash route a tapped alert asks for, or null when the payload
 * names no show.
 * @param {{showId?: unknown}|null|undefined} payload  the `alertOpened` event
 * @returns {string|null}  e.g. "#/show/abc"
 */
export function routeForAlert(payload) {
  const showId = payload && typeof payload === "object" ? payload.showId : undefined;
  if (typeof showId !== "string" || showId === "") return null;
  return "#/show/" + encodeURIComponent(showId);
}

/**
 * Listen for tapped alerts and route each one in place.
 * @param {object|null} bridge  `window.Capacitor`, or anything shaped like it
 * @param {(hash: string) => void} navigate  sets the page's hash
 * @returns {*}  what `listenTo` returns: a handle with `remove()` on a real
 *   bridge, else null. Never throws.
 */
export function bindAlertOpen(bridge, navigate) {
  try {
    return listenTo(bridge, ALERT_PLUGIN, ALERT_EVENT, (event) => {
      const route = routeForAlert(event);
      if (route === null) return;
      try { navigate(route); } catch (_) { /* a hash we cannot set leaves the page where it was */ }
    });
  } catch (_) {
    return null;
  }
}
