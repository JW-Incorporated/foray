/* Which build made this record? (founder report 3, 2026-09-22)

   THE DEFECT. The founder pastes "playback diagnostics" to report a bug, and the
   record could not say which build wrote it. `app.js` carries no build stamp,
   and `sw.js`'s `BUILD_ID` is excluded from the native bundle
   (`tools/mobile/prepare-webdir.mjs`'s `EXCLUDED_FROM_BUNDLE`), so a field report
   could not be placed against a release. That cost real time twice on
   2026-09-22: a fix merged, the store upload failed, and the next record could
   not say whether it came from the build with the fix or the one before.

   TWO NUMBERS, because a native shell is two things shipped together:

     - THE WEB DEPLOY ID — which `app.js`/`player/*.js` is running. It is
       `deploy-manifest.json`'s `deploy_id`, the value `tools/ci/generate-
       manifest.mjs` stamps into the deployed `sw.js` as `BUILD_ID` at every
       deploy build (never committed since issue #701).
       On the website it is read from the manifest (or from the generation the
       service worker pinned this page to — app.js's `pinnedDeployId` — which is
       the more exact answer when there is one). In the shell there is no worker
       and no manifest, so `prepare-webdir.mjs` computes the same id for the
       commit it packages and writes it into the bundle as `build-stamp.json`.
     - THE NATIVE BUILD NUMBER — which binary (`YYYYMMDDnn`, the number the
       stores show). Only the binary knows it, so it is asked at runtime through
       `@capacitor/app`'s `getInfo`, which is already a dependency of the shell
       (mobile/package.json) — no new native code.

   THE SIMPLEST OPTION THAT CARRIES BOTH, which is why it is this one: no
   generated file committed to the repo (a new conflict magnet on every merge),
   no workflow change, and nothing new for the native side. Recorded as one
   `build` row per boot by `diagnostic-log.js`, so a ring that spans an update
   says which rows came from which build.

   Pure except for what is injected, and TOTAL: every function here returns
   nulls rather than throwing, because a stamp that could fail the boot would be
   the instrument becoming the outage. Values are admitted BY SHAPE — the record
   is pasted into issues and may only hold tokens (diagnostic-log.js's rule). */

/** The file `prepare-webdir.mjs` writes into the native bundle. */
export const BUILD_STAMP_FILE = "build-stamp.json";
/** The web's own statement of its deploy id. */
export const DEPLOY_MANIFEST_FILE = "deploy-manifest.json";

/** A deploy id is hex — `generate-manifest.mjs` makes 16 characters of it. */
export function deployIdOf(value) {
  const s = typeof value === "string" ? value.trim() : "";
  return /^[0-9a-f]{8,64}$/i.test(s) ? s.toLowerCase() : null;
}

/** A native build number (`2026092224`) or version (`1.4.0`): digits and dots. */
function nativeTokenOf(value) {
  const s = typeof value === "number" && Number.isFinite(value) ? String(value)
    : typeof value === "string" ? value.trim() : "";
  return /^[0-9][0-9.]{0,31}$/.test(s) ? s : null;
}

/** What the bundle carries: the manifest's id and nothing else. Throws on a
    manifest with no usable id, because a bundle that silently stamps nothing is
    the defect this file exists to remove — the build should stop instead. */
export function buildStampDoc(manifest) {
  const id = deployIdOf(manifest?.deploy_id);
  if (!id) throw new Error("deploy-manifest.json has no usable deploy_id; the bundle cannot say which build it is");
  return { deploy_id: id };
}

/** `@capacitor/app`'s `getInfo()` answer -> `{ build, version }`, by shape. */
export function nativeBuildOf(info) {
  return {
    build: nativeTokenOf(info?.build),
    version: nativeTokenOf(info?.version),
  };
}

/** How long either half may take before the row is written with what is known.
    Five seconds, the same bound `app.js` puts on storage hydration: a file read
    from the bundle or a bridge call that has not answered in that long is not
    going to, and a row saying `native ?` is worth more than no row. */
export const BUILD_STAMP_WAIT_MS = 5000;

/**
 * `promise`, or `null` once `ms` has passed — never a rejection. The timer is
 * cleared when the answer lands, so a resolved read does not keep a process (or
 * a test) alive for the full bound. A non-finite `ms` means no bound at all.
 */
function withinMs(promise, ms) {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  let timer = null;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); });
  return Promise.race([promise, late]).finally(() => { if (timer != null) clearTimeout(timer); });
}

/**
 * Both numbers, never throwing, and NEVER HANGING (2026-09-23).
 *
 * The founder's record that day had no build row at all. Each half here is an
 * asynchronous call into something this file does not control — a bundle file,
 * the native bridge — and until now a half that never answered meant the row
 * that would have named the OTHER half was never written either: `client.js`
 * writes the row from this promise's resolution, and a promise that never
 * settles writes nothing. So each half is bounded separately by `timeoutMs`,
 * and whatever answered in time goes in the row; a half that did not is `null`,
 * which the record prints as `?`. "This build could not say" is a finding; a
 * missing row is not.
 *
 * @param {object} env
 * @param {boolean} env.inShell        running inside the Capacitor shell
 * @param {Function} env.fetchJson     (url) => Promise<object>
 * @param {object|null} env.capacitor  `window.Capacitor`, for `nativePromise`
 * @param {string|null} env.pinned     the deploy id the service worker pinned this
 *                                     page to, when it did (app.js's `pinnedDeployId`)
 * @param {number} env.timeoutMs       per-half bound; `Infinity` for none
 * @returns {Promise<{ shell: boolean, web: string|null, native: string|null, version: string|null }>}
 */
export async function readBuildStamp({
  inShell = false, fetchJson = null, capacitor = null, pinned = null, timeoutMs = BUILD_STAMP_WAIT_MS,
} = {}) {
  const out = { shell: inShell === true, web: null, native: null, version: null };
  const get = async (url) => {
    if (typeof fetchJson !== "function") return null;
    try { return await withinMs(Promise.resolve().then(() => fetchJson(url)), timeoutMs); } catch (_) { return null; }
  };
  if (inShell) {
    out.web = deployIdOf((await get(BUILD_STAMP_FILE))?.deploy_id);
    try {
      if (capacitor && typeof capacitor.nativePromise === "function") {
        const answer = await withinMs(
          Promise.resolve().then(() => capacitor.nativePromise("App", "getInfo", {})), timeoutMs,
        );
        const info = nativeBuildOf(answer);
        out.native = info.build;
        out.version = info.version;
      }
    } catch (_) { /* an older shell without the App plugin: the build stays unknown */ }
    return out;
  }
  out.web = deployIdOf(pinned) ?? deployIdOf((await get(DEPLOY_MANIFEST_FILE))?.deploy_id);
  return out;
}
