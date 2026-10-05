/* Incoming links: a shared 4a web link, opened on a phone that has the app,
   lands on the same page INSIDE the app (#1071, founder answer on the issue:
   "work towards opening shared links directly in the app").

   THE SHARE ORIGIN is the Vercel deployment of this repo, the origin whose
   root we control: `/.well-known/apple-app-site-association` (iOS) and, once
   the Play signing fingerprint exists, `/.well-known/assetlinks.json`
   (Android) are served from it, and the app claims its links. One constant: a
   custom domain later (HUMAN-ACTIONS) changes SHARE_ORIGIN and the two
   site-association files, nothing else.

   WHAT ARRIVES. The OS hands the full https URL to the app, and Capacitor's App
   plugin fires `appUrlOpen` with `{ url }`. Routing in this app is hash-only
   (`#/show/<id>`, `#/foray/<id>`, ...), and the shell's own page is
   `capacitor://localhost/` (iOS) or `https://localhost/` (Android), so the
   shared URL cannot simply be loaded: its HASH is the in-app route, and the
   router takes it from there exactly as it takes a tap on an in-app link. The
   same input check the relaunch route uses (app.js `relaunchRoute`): only one
   of this app's own hash routes, no whitespace, at most 2048 characters.

   `?foray=<id>` on the site root is the web's way into a Foray (app.js
   `enterForayFromQuery`); it maps to `#/foray/<id>`. The web's draft UNLOCK
   that the same parameter carries does not travel: the shell's own address has
   no `?foray=`, so a draft link opens the Foray page as any listed Foray would,
   and an unlisted draft stays unlisted. iOS does not hand these links to the
   app at all (the association matches hash routes only); Android's filter
   cannot match on a query, so they arrive and are mapped here.

   ANYTHING ELSE IS IGNORED, returned as null: another host (a lookalike suffix
   such as `foray-web-seven.vercel.app.example.com` included), http, a port, a
   login part, another path (`/api/...` is never an app link), and a hash that
   is not one of our routes. The OS only delivers links the app claimed, but a
   custom scheme or a future filter could deliver more, and an address that
   lands in `location.hash` is checked like any input.

   COLD AND WARM. A warm app gets the event. A cold launch from a link is
   where the platforms differ (Android delivers the launch intent through
   `getLaunchUrl()`, not the event), so `getLaunchUrl()` is read as well, and a
   second navigation to the same hash is a no-op. It is read ONLY ON A BARE
   ARRIVAL: the launch URL stays the same for the life of the process, so a
   page reload in a shell launched from a link (a service-worker update, a
   boot retry) would otherwise drag the listener back to the shared page from
   wherever they had gone. The shell's cold load has no hash at all; a reload
   keeps the one app.js wrote, `#/` at least. app.js's boot
   keeps a hash that is already set (the relaunch route applies only to a bare
   arrival), and a route set after boot arrives as an ordinary `hashchange`.
   Either way the landing has no in-app history behind it, which is the
   cold-open case app.js's ‹ already handles (its `#/` href fallback). */

export const SHARE_ORIGIN = "https://foray-web-seven.vercel.app";

const SHARE_HOST = new URL(SHARE_ORIGIN).host;
const MAX_ROUTE = 2048;
const ROUTE_RE = /^#\/[^\s]*$/;

/**
 * The in-app hash route a shared link asks for, or null when the link is not
 * one of ours.
 * @param {string} url  the URL the OS opened the app with
 * @returns {string|null}  e.g. "#/show/abc", "#/" for the bare site root
 */
export function inAppRouteFor(url) {
  if (typeof url !== "string" || url.length > MAX_ROUTE * 2) return null;
  let u;
  try {
    u = new URL(url);
  } catch (_) {
    return null;
  }
  if (u.protocol !== "https:" || u.host !== SHARE_HOST || u.port !== "") return null;
  if (u.username !== "" || u.password !== "") return null;
  if (u.pathname !== "/") return null;
  const hash = u.hash;
  if (hash && hash !== "#" && hash !== "#/") {
    return ROUTE_RE.test(hash) && hash.length <= MAX_ROUTE ? hash : null;
  }
  const foray = u.searchParams.get("foray");
  if (foray) {
    const route = `#/foray/${encodeURIComponent(foray)}`;
    return route.length <= MAX_ROUTE ? route : null;
  }
  return "#/";
}

/**
 * Listen for links the app is opened with and route each one in place.
 * @param {object} opts
 * @param {object|null} opts.app  Capacitor's App plugin (`Capacitor.Plugins.App`), or null on the web
 * @param {(hash: string) => void} opts.navigate  sets the page's hash
 * @param {boolean} [opts.arrivedBare]  the page loaded with no hash (a cold launch, not a reload);
 *   only then is `getLaunchUrl()` read
 * @returns {boolean}  whether a listener was installed (false on the web, where the browser opens links itself)
 */
export function bindIncomingLinks({ app, navigate, arrivedBare = false } = {}) {
  if (!app || typeof app.addListener !== "function" || typeof navigate !== "function") return false;
  const open = (url) => {
    const route = inAppRouteFor(url);
    if (route === null) return;
    try { navigate(route); } catch (_) { /* a hash we cannot set leaves the page where it was */ }
  };
  try {
    app.addListener("appUrlOpen", (event) => open(event && event.url));
  } catch (_) {
    return false;
  }
  if (arrivedBare === true && typeof app.getLaunchUrl === "function") {
    try {
      const launched = app.getLaunchUrl();
      if (launched && typeof launched.then === "function") {
        launched.then((r) => open(r && r.url), () => {});
      }
    } catch (_) { /* no launch URL is the ordinary launch */ }
  }
  return true;
}
