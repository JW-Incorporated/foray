/* The network contract of the harness: NOTHING leaves the machine except
 * (optionally) read-only image/font GETs, and nothing is ever written to
 * production.
 *
 *   127.0.0.1 (our static server)         -> passes through
 *   *.supabase.co  (the app's telemetry)  -> answered here with fixtures
 *   foray-web-seven.vercel.app (the API)  -> answered here with fixtures
 *   any https audio / video               -> the silent WAV
 *   any https image / font / stylesheet   -> passes through (artwork loads
 *                                            normally), or a flat placeholder
 *                                            with --no-remote-images
 *   anything else, and every non-GET      -> refused with 404, and recorded
 *
 * Every stubbed or refused request is appended to `log`, so a run can say
 * exactly what it answered instead of fetching.
 */
import { AUDIO } from "./server.mjs";

const SUPABASE_HOST = "qjdllvqdcgacvujhclny.supabase.co";
const API_HOST = "foray-web-seven.vercel.app";

/* 1x1 mid-grey PNG, for --no-remote-images. */
const GREY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNsaGj4DwAF/gL+n8tvVQAAAABJRU5ErkJggg==",
  "base64"
);

const json = (status, body) => ({
  status,
  contentType: "application/json; charset=utf-8",
  headers: { "access-control-allow-origin": "*" },
  body: JSON.stringify(body),
});

function fakeSession() {
  return {
    access_token: "uilab.fixture.access",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: 4102444800,
    refresh_token: "uilab-fixture-refresh",
    user: { id: "00000000-0000-4000-8000-00000000u1ab", aud: "authenticated", role: "authenticated", is_anonymous: true },
  };
}

/** Pure: what a stubbed Supabase request is answered with. Exported for README/tests of the contract. */
export function supabaseFixture(method, pathname) {
  if (method === "OPTIONS") return { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" };
  if (pathname.startsWith("/auth/v1/signup") || pathname.startsWith("/auth/v1/token")) return json(200, fakeSession());
  if (pathname.startsWith("/auth/v1/logout")) return { status: 204, headers: { "access-control-allow-origin": "*" }, body: "" };
  if (pathname.startsWith("/rest/v1/")) return json(method === "GET" ? 200 : 201, []);
  return json(200, {});
}

/** Pure: the Vercel API fixture. Empty-but-valid, NOT degraded, so search pages show their
    real "answered, nothing extra" state and the local index drives the results. */
export function apiFixture(pathname, searchParams) {
  if (pathname.startsWith("/api/shows/search")) {
    return searchParams.has("id") ? json(200, { show: null }) : json(200, { shows: [], degraded: false });
  }
  if (pathname.startsWith("/api/episodes/search")) return json(200, { episodes: [], degraded: false });
  return json(404, { error: "uilab: no fixture for " + pathname });
}

/**
 * @param {import('playwright').BrowserContext} context
 * @param {{localOrigins?: string[], remoteImages?: boolean}} opts
 * @returns {{log: Array<{kind:string, method:string, url:string}>}}
 */
export async function installStubs(context, { localOrigins = [], remoteImages = true } = {}) {
  const log = [];
  await context.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    const type = req.resourceType();

    if (url.protocol === "data:" || url.protocol === "blob:") return route.continue();
    if (localOrigins.includes(url.origin) || url.hostname === "127.0.0.1" || url.hostname === "localhost") return route.continue();

    if (url.hostname === SUPABASE_HOST) {
      log.push({ kind: "stub-supabase", method, url: url.origin + url.pathname });
      return route.fulfill(supabaseFixture(method, url.pathname));
    }
    if (url.hostname === API_HOST) {
      if (method === "OPTIONS") {
        log.push({ kind: "stub-api", method, url: url.origin + url.pathname });
        return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" });
      }
      log.push({ kind: "stub-api", method, url: url.origin + url.pathname + url.search });
      return route.fulfill(apiFixture(url.pathname, url.searchParams));
    }
    if (type === "media") {
      log.push({ kind: "stub-media", method, url: url.origin + url.pathname });
      return route.fulfill({ status: 200, contentType: "audio/wav", headers: { "access-control-allow-origin": "*", "accept-ranges": "none" }, body: AUDIO });
    }
    /* a media-session / fetch() of artwork is not typed "image" but is the same read-only GET */
    const imageLike = type === "image" || (method === "GET" && /\.(png|jpe?g|webp|gif|svg|avif)$/i.test(url.pathname));
    if (method === "GET" && imageLike) {
      if (remoteImages) return route.continue();
      log.push({ kind: "stub-image", method, url: url.origin + url.pathname });
      return route.fulfill({ status: 200, contentType: "image/png", body: GREY_PNG });
    }
    if (method === "GET" && (type === "font" || type === "stylesheet")) return route.continue();

    log.push({ kind: "refused", method, url: url.origin + url.pathname });
    return route.fulfill({ status: 404, contentType: "text/plain", body: "uilab: refused" });
  });
  return { log };
}
