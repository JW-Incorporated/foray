/* player/tts-bridge.js — the one thing that connects the page to on-device speech.
 *
 * ── Why this file exists ──────────────────────────────────────────────────
 * `PlayerQueueManager` has taken a `tts` option since the narration card
 * landed, and `_speakNarration` has been complete since then too. Nothing ever
 * passed one. `git grep -n tts -- player/client.js` returned nothing, so
 * `this._tts` was `null` in every build the app has ever shipped and a
 * script-only narration item could only ever fail to load with
 * "no on-device TTS plugin wired". The speech half was built (issue #382,
 * `mobile/plugins/foray-tts/`); the wire was not. This is the wire.
 *
 * ── Why it is not a plain `import` in client.js ────────────────────────────
 * `mobile/plugins/foray-tts/web/foray-tts.js` is not part of the player. It is
 * a Capacitor plugin's web half, and `tools/mobile/prepare-webdir.mjs` COPIES
 * it into the native bundle's root as `foray-tts.js` (see that file's copy
 * table). So the module sits at a DIFFERENT path depending on which of the two
 * things you are running:
 *
 *   in the Capacitor shell   ../foray-tts.js
 *   on the website           ../mobile/plugins/foray-tts/web/foray-tts.js
 *
 * — because GitHub Pages deploys the repo root verbatim, so the plugin's own
 * source path is a real URL there, and the bundle's flattened copy is not.
 * A static `import` would have to name one of them and 404 on the other, and a
 * top-level 404 in `client.js` takes the whole player down with it. So the
 * import is dynamic, deferred until something actually asks to speak, and the
 * two paths are TRIED IN THE RIGHT ORDER FOR THE HOST rather than in a fixed
 * order — a 404 on the first try is survivable but noisy, and the noise would
 * land in the one place (the shell) where the log is the only evidence anyone
 * has.
 *
 * ── What it deliberately does NOT do ──────────────────────────────────────
 * Fall back to `speechSynthesis` itself. `foray-tts.js`'s own `speak()`
 * already does that, by its own documented contract ("NEVER throws and NEVER
 * rejects"), and a second copy of that ladder here would be a second answer to
 * one question. This file's whole job is "get that module, or say honestly
 * that you could not".
 *
 * NOTHING HERE HAS BEEN HEARD ON A DEVICE. It is exercised against a fake
 * loader in `player/tts-bridge.test.js`; whether iOS keeps speaking with the
 * screen locked is HUMAN-ACTIONS.md #29 and is not knowable from this repo.
 */

/** Where the plugin's web half lives, per host. Order matters: the first entry
    is tried first, and the caller picks which host it is. */
export const SHELL_FIRST = Object.freeze([
  "../foray-tts.js",
  "../mobile/plugins/foray-tts/web/foray-tts.js",
]);
export const SITE_FIRST = Object.freeze([
  "../mobile/plugins/foray-tts/web/foray-tts.js",
  "../foray-tts.js",
]);

/** True when a Capacitor bridge is present — the same "are we in the shell?"
    test `foray-tts.js`'s own `shellApplies()` makes, asked here only to choose
    a URL. Kept as a predicate rather than read at module scope so the answer is
    never cached from before the bridge is injected. */
export function inShell(win = (typeof window !== "undefined" ? window : undefined)) {
  return !!(win && win.Capacitor);
}

/**
 * A `{ speak(text, opts) }` object shaped exactly like the `tts` option
 * `PlayerQueueManager`'s constructor documents.
 *
 * `speak()` resolves `{ ok: false, reason }` rather than throwing when the
 * module cannot be loaded at all. That is the same shape `foray-tts.js`
 * returns for "nothing available", and `_speakNarration` already turns an
 * `ok: false` into the queue's ordinary load-failure path — so a browser with
 * no plugin and no `speechSynthesis` reports one narration item it could not
 * play and the Foray moves on, which is corner case #12's existing rule.
 *
 * @param {object} [opts]
 * @param {(specifier: string) => Promise<object>} [opts.load]  injected importer
 * @param {string[]} [opts.candidates]  override the per-host path order
 * @param {Function} [opts.log]
 */
export function createTtsBridge({ load = null, candidates = null, log = null } = {}) {
  /* The default importer HAS to live in this file: a relative specifier in a
     dynamic import resolves against the module that wrote the `import()`, so
     handing this job to client.js would silently re-root both paths. */
  const importer = load ?? ((specifier) => import(/* @vite-ignore */ specifier));
  const warn = log ?? ((...a) => { try { console.warn(...a); } catch (_) { /* logging must never throw */ } });

  /** Memoised: the module, or `null` once every candidate has failed. One
      resolution attempt per page, not one per narration line — a Foray with
      six bridges must not produce six 404s. */
  let pending = null;

  async function loadModule() {
    const paths = candidates ?? (inShell() ? SHELL_FIRST : SITE_FIRST);
    const tried = [];
    for (const p of paths) {
      try {
        const mod = await importer(p);
        if (mod && typeof mod.speak === "function") return mod;
        tried.push(`${p} (loaded, no speak())`);
      } catch (e) {
        tried.push(`${p} (${e?.message ?? e})`);
      }
    }
    /* Logging must never throw — `foray-tts.js` states the same rule for the
       same reason: this runs while a listener is waiting for a voice, and a
       broken sink must not turn "no plugin here" into a rejected promise on a
       path whose whole contract is that it resolves. */
    try { warn("[player] foray-tts is not reachable:", tried.join("; ")); } catch (_e) { /* ignore */ }
    return null;
  }

  return {
    async speak(text, opts = {}) {
      if (!pending) pending = loadModule();
      const mod = await pending;
      if (!mod) {
        return { ok: false, path: "none", reason: "foray-tts module could not be loaded" };
      }
      return mod.speak(text, opts);
    },

    /* Threaded through rather than redesigned around: `PlayerQueueManager` asks
       this object for `speak` and nothing else, and that stays true. This exists
       because the module is loaded HERE and the two-URL problem in this file's
       header applies identically to any other call on it — a diagnostic screen
       that resolved `foray-tts.js` a second time would have to re-solve it.

       `typeof mod.listVoices !== "function"` is a REAL case, not defensive
       noise: the Capacitor shell carries a flattened COPY of the module made at
       build time by `tools/mobile/prepare-webdir.mjs`, so a shell built before
       this change loads a module with a `speak` and no `listVoices`. Saying so
       is more useful than a TypeError. */
    async listVoices(opts = {}) {
      if (!pending) pending = loadModule();
      const mod = await pending;
      if (!mod) {
        return { ok: false, path: "none", voices: [], reason: "foray-tts module could not be loaded" };
      }
      if (typeof mod.listVoices !== "function") {
        return { ok: false, path: "none", voices: [], reason: "this build of foray-tts has no listVoices()" };
      }
      return mod.listVoices(opts);
    },
  };
}
