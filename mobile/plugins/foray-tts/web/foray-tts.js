/* The web half of `foray-tts`: on-device text-to-speech, called by whatever
 * one real call site this card wires up (see `tools/mobile/tts-fixture.mjs`
 * and README.md in this directory for what that is and is not).
 *
 * SHIPS EVERYWHERE, unlike `foray-audio-shell.js`. That file is Android-shell
 * only (`docs/research/mp1-background-audio.md` §7.3: iOS needs no JS-side
 * foreground-service bookkeeping). This one is the opposite shape on purpose:
 * `docs/research/on-device-tts.md` §3 found that NEITHER the plain Web Speech
 * API NOR either surveyed Capacitor community plugin exposes iOS's own
 * `AVSpeechSynthesisIPANotationAttribute`, so the only way to reach it is a
 * native plugin call from ordinary page JS — inside the Capacitor shell when
 * one is present, degrading to the standard `speechSynthesis` API otherwise
 * (a browser tab, a desktop preview, CI). That fallback is the SAME
 * graceful-degradation shape `foray-audio-shell.js`'s own `shellApplies()`
 * uses and the player's `playBtn` in-app-vs-external fallback already
 * established as this app's house style — see the card body for the pointer.
 *
 * WHO CALLS IT (updated for HUMAN-ACTIONS.md #29). The line above about "one real
 * call site this card wires up" was true of `tools/mobile/tts-fixture.mjs` and of
 * nothing else for months: `player/client.js` never passed a `tts` bridge to
 * `PlayerQueueManager`, so `_speakNarration` — which was complete — could only ever
 * throw. `player/tts-bridge.js` is now the wire, and it imports THIS FILE
 * dynamically because the shell and the website hold it at different URLs (see that
 * file's header). A Foray whose data carries a narration `script` is now spoken.
 *
 * WHAT THIS FILE DOES NOT DO, stated per the card's explicit scope:
 *   - No narration-authoring UI, and no way for a listener to type something for
 *     the phone to read. What reaches `speak()` is a `script` a curator committed
 *     to `data/forays.json`.
 *   - No IPA authoring. `../lexicon/hard-terms.json`'s `ipa` fields are all
 *     `null` today — see that file's own honesty note. A term with a `null`
 *     ipa is treated exactly like a term not in the lexicon at all: spoken as
 *     plain text, no override attempted. Shipping a guessed IPA string here
 *     would be exactly the kind of unlabelled claim this repo's own research
 *     docs (`docs/research/narrator-voice.md`, `on-device-tts.md`) warn
 *     against, and it would silently mispronounce something on a real device
 *     with nobody the wiser until the §5.7 fixture — the whole point of
 *     building the fixture in the first place — actually runs.
 *
 * THE TWO PLATFORMS GET DIFFERENT TREATMENT, because the evidence differs:
 *   - iOS: `AVSpeechSynthesisIPANotationAttribute` is Apple's own documented,
 *     first-party override (on-device-tts.md §1). So this file sends a
 *     structured `ipaOverrides` list — [{ term, start, end, ipa }], character
 *     offsets into `text` — and `ForayTtsPlugin.swift` builds the
 *     `NSAttributedString` / `attributedSpeechString` from it directly. No
 *     markup round-trip, no escaping hazard.
 *   - Android: the official `TextToSpeech` reference documents NO phoneme/IPA
 *     attribute at all (on-device-tts.md §2) — SSML `<phoneme>` passed into
 *     `speak()` is, at best, an undocumented, engine-dependent side effect.
 *     So Android gets a *best-effort* SSML string
 *     (`<speak><phoneme alphabet="ipa" ph="...">term</phoneme>...</speak>`)
 *     built the same way, and the native side is required to pass it through
 *     rather than silently drop it (per the card's explicit instruction) —
 *     whether it actually changes the pronunciation on a given device is
 *     exactly what the §5.7 fixture has to determine, not something this file
 *     can know in advance.
 *
 * NOTHING IN THIS FILE HAS BEEN OBSERVED IN A WEBVIEW OR HEARD ON A DEVICE.
 * The suite in `tools/mobile/foray-tts.test.mjs` drives every path against a
 * fake bridge and a fake `speechSynthesis` in Node — same honesty standard as
 * `foray-audio-shell.js`'s own header and `docs/android-native-code.md`'s
 * claims table.
 */

export const PLUGIN_NAME = "ForayTts";

/** Case-insensitive word-boundary match, same method
 *  `docs/research/narrator-voice.md`'s own Appendix ("Reproducing the
 *  measurements") describes for reproducing its lexicon counts — this file
 *  does not invent a second matching rule for the same lexicon. Apostrophes
 *  (`ch'arki`) are handled by treating `'` as a boundary-safe interior
 *  character, mirroring that document's own note that its plain \b regex
 *  approach breaks on that one entry and has to special-case it. */
function findMatches(text, entries) {
  const matches = [];
  for (const entry of entries) {
    if (!entry || !entry.term) continue;
    const escaped = entry.term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?<![\\p{L}\\p{N}'])${escaped}(?![\\p{L}\\p{N}'])`, "giu");
    let m;
    while ((m = re.exec(text)) !== null) {
      matches.push({ term: entry.term, ipa: entry.ipa ?? null, start: m.index, end: m.index + m[0].length });
      if (m.index === re.lastIndex) re.lastIndex++; // guard zero-width
    }
  }
  matches.sort((a, b) => a.start - b.start);
  return matches;
}

/** Structured overrides for iOS: only terms with an authored (non-null) ipa.
 *  A term present in the lexicon but with `ipa: null` produces NO override —
 *  see this file's header for why that is correct rather than a bug. */
export function buildIpaOverrides(text, lexiconEntries = []) {
  return findMatches(text, lexiconEntries).filter((m) => m.ipa != null);
}

/** Best-effort SSML for Android, per on-device-tts.md §2's documented (if
 *  unverified) approach: wrap only the terms with an authored ipa in
 *  `<phoneme alphabet="ipa" ph="...">`, leave everything else as plain text,
 *  and escape XML-significant characters so an unrelated `<` or `&` in
 *  narration text cannot break the document. If there is nothing to mark up,
 *  return `null` — the caller sends plain `text` and does not build an SSML
 *  document that says nothing an SSML document needs to say. */
export function buildAndroidSsml(text, lexiconEntries = []) {
  const overrides = buildIpaOverrides(text, lexiconEntries);
  if (overrides.length === 0) return null;
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  let out = "";
  let cursor = 0;
  for (const o of overrides) {
    out += esc(text.slice(cursor, o.start));
    out += `<phoneme alphabet="ipa" ph="${esc(o.ipa)}">${esc(text.slice(o.start, o.end))}</phoneme>`;
    cursor = o.end;
  }
  out += esc(text.slice(cursor));
  return `<speak>${out}</speak>`;
}

/** True when a Capacitor bridge with this plugin's native side is reachable.
 *  Same shape as `foray-audio-shell.js`'s own `shellApplies` -- absence of
 *  `window.Capacitor` (a plain browser tab) is the expected, non-error case,
 *  not a thing to throw about. */
export function shellApplies(bridge = (typeof window !== "undefined" ? window.Capacitor : undefined)) {
  return !!(bridge && typeof bridge.nativePromise === "function");
}

/** Speak `text` via the native plugin when available, else the standard Web
 *  Speech API, else resolve `{ ok: false, reason }` -- NEVER throws and NEVER
 *  rejects, matching `ForayAudioPlugin.java`'s own "every method resolves"
 *  rule, for the same reason: a caller may be driving this from a render
 *  path, and an unhandled rejection there is worse than an honest failure
 *  flag.
 *
 *  @param {string} text
 *  @param {object} [opts]
 *  @param {Array<{term:string, ipa:?string}>} [opts.lexiconEntries]
 *  @param {string} [opts.lang]
 *  @param {number} [opts.rate]
 *  @param {number} [opts.pitch]
 *  @param {number} [opts.volume]
 *  @param {object} [opts.bridge] injected `window.Capacitor` (or a fake, for tests)
 *  @param {object} [opts.speechSynth] injected `window.speechSynthesis` (or a fake)
 *  @param {function} [opts.UtteranceCtor] injected `SpeechSynthesisUtterance`
 *  @param {function} [opts.log] injected logger, defaults to `console.warn`
 */
export async function speak(text, opts = {}) {
  const {
    lexiconEntries = [],
    lang,
    rate,
    pitch,
    volume,
    bridge = (typeof window !== "undefined" ? window.Capacitor : undefined),
    speechSynth = (typeof window !== "undefined" ? window.speechSynthesis : undefined),
    UtteranceCtor = (typeof window !== "undefined" ? window.SpeechSynthesisUtterance : undefined),
    log = (typeof console !== "undefined" ? console.warn.bind(console) : () => {}),
  } = opts;

  if (typeof text !== "string" || text.length === 0) {
    return { ok: false, path: "none", reason: "empty text" };
  }

  if (shellApplies(bridge)) {
    const ipaOverrides = buildIpaOverrides(text, lexiconEntries);
    const androidSsml = buildAndroidSsml(text, lexiconEntries);
    try {
      const result = await bridge.nativePromise(PLUGIN_NAME, "speak", {
        text,
        ipaOverrides,
        androidSsml,
        lang: lang ?? null,
        rate: rate ?? null,
        pitch: pitch ?? null,
        volume: volume ?? null,
      });
      return { ok: true, path: "native", overridesApplied: ipaOverrides.length, native: result };
    } catch (e) {
      /* Native call itself threw/rejected -- fall through to Web Speech
         rather than surface a rejection, same degradation the class comment
         above describes as this file's whole reason to exist. */
      try { log("foray-tts: native speak failed, falling back", e); } catch (_e) { /* logging must never throw */ }
    }
  }

  if (speechSynth && typeof speechSynth.speak === "function" && typeof UtteranceCtor === "function") {
    try {
      const utter = new UtteranceCtor(text);
      if (lang) utter.lang = lang;
      if (typeof rate === "number") utter.rate = rate;
      if (typeof pitch === "number") utter.pitch = pitch;
      if (typeof volume === "number") utter.volume = volume;
      speechSynth.speak(utter);
      /* Documented, W3C Web Speech API spec, quoted in on-device-tts.md §3:
         no phoneme/IPA control exists on this path at all -- 0 overrides is
         not a bug report, it is the truth about this fallback. */
      return { ok: true, path: "web-speech", overridesApplied: 0 };
    } catch (e) {
      try { log("foray-tts: Web Speech fallback failed", e); } catch (_e) { /* never throw */ }
      return { ok: false, path: "web-speech", reason: (e && e.message) || String(e) };
    }
  }

  return { ok: false, path: "none", reason: "no native bridge and no speechSynthesis available" };
}

export function createForayTtsShell(defaults = {}) {
  return {
    speak: (text, opts = {}) => speak(text, { ...defaults, ...opts }),
    shellApplies: (bridge) => shellApplies(bridge ?? defaults.bridge),
  };
}
