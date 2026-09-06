/* Tests for `mobile/plugins/foray-tts/web/foray-tts.js` -- the JS-side
 * interface of the on-device TTS plugin. Same honesty standard as
 * `foray-audio-shell.test.mjs`'s own header: this drives the real module
 * against a fake bridge and a fake `speechSynthesis`, in Node. It proves the
 * MESSAGE SHAPE and the FALLBACK BEHAVIOUR when native isn't available. It
 * proves nothing about a real AVSpeechSynthesizer or TextToSpeech, no WebView
 * ran, and no audio was heard -- see this plugin's README.md.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  PLUGIN_NAME,
  FINISHED_EVENT,
  buildIpaOverrides,
  buildAndroidSsml,
  languageMatches,
  listVoices,
  shellApplies,
  speak,
  createForayTtsShell,
  onFinished,
} from "../../mobile/plugins/foray-tts/web/foray-tts.js";

const LEXICON = [
  { term: "binchōtan", ipa: "biɲtɕoːtaɰ̃" },
  { term: "koji", ipa: null },
  { term: "ch'arki", ipa: "tʃarki" },
  { term: "Taíno", ipa: null },
];

/* ------------------------------------------------------------- buildIpaOverrides */

test("buildIpaOverrides: matches a term with an authored ipa", () => {
  const overrides = buildIpaOverrides("The binchōtan burns hot.", LEXICON);
  assert.equal(overrides.length, 1);
  assert.equal(overrides[0].term, "binchōtan");
  assert.equal(overrides[0].ipa, "biɲtɕoːtaɰ̃");
  assert.equal("The binchōtan burns hot.".slice(overrides[0].start, overrides[0].end), "binchōtan");
});

test("buildIpaOverrides: a lexicon entry with ipa:null produces NO override", () => {
  const overrides = buildIpaOverrides("A dash of koji does the work.", LEXICON);
  assert.equal(overrides.length, 0, "null-ipa entries must never become a guessed override");
});

test("buildIpaOverrides: case-insensitive, word-boundary match", () => {
  const overrides = buildIpaOverrides("TAÍNO peoples, not tainoism.", [{ term: "Taíno", ipa: "tajˈino" }]);
  assert.equal(overrides.length, 1);
  assert.equal(overrides[0].term, "Taíno");
});

test("buildIpaOverrides: apostrophe term (ch'arki) matches on its own word boundary", () => {
  const overrides = buildIpaOverrides("Dried ch'arki was traded widely.", LEXICON);
  assert.equal(overrides.length, 1);
  assert.equal(overrides[0].term, "ch'arki");
});

test("buildIpaOverrides: 'sake' (Japanese drink) gets its own override, not the English 'sake' reading", () => {
  // Regression test for the bug Joey heard in the beat-6 Kokoro fixture sample
  // (alcohol-forms-spine.md beat 6): 'sake' was missing from hard-terms.json
  // entirely, so Kokoro read the Japanese rice-wine loanword as the English word
  // 'sake' (as in 'for the sake of'). This case matters specifically because
  // 'sake' is a common English dictionary word that ALSO happens to be an
  // unrelated foreign loanword -- unlike this file's other lexicon entries,
  // which are foreign-looking spellings a plain-English reading never touches.
  const SAKE_LEXICON = [{ term: "sake", ipa: "ˈsɑːkeɪ" }];
  const overrides = buildIpaOverrides("Beer, sake and every grain spirit require an extra step.", SAKE_LEXICON);
  assert.equal(overrides.length, 1);
  assert.equal(overrides[0].term, "sake");
  assert.equal(overrides[0].ipa, "ˈsɑːkeɪ");
});

test("buildIpaOverrides: 'sake' does not false-match inside a longer word", () => {
  const SAKE_LEXICON = [{ term: "sake", ipa: "ˈsɑːkeɪ" }];
  const overrides = buildIpaOverrides("sakedom is not a real word, sake is.", SAKE_LEXICON);
  assert.equal(overrides.length, 1, "only the standalone 'sake' should match, not the 'sake' inside 'sakedom'");
});

test("buildIpaOverrides: does not match a substring inside a longer word", () => {
  const overrides = buildIpaOverrides("kojima is a surname, not koji.", [{ term: "koji", ipa: "koʑi" }]);
  // "koji" alone should match once (the standalone occurrence), not twice (not inside "kojima")
  assert.equal(overrides.length, 1);
});

test("buildIpaOverrides: multiple distinct terms, sorted by position", () => {
  const overrides = buildIpaOverrides("ch'arki and binchōtan appear here.", LEXICON);
  assert.equal(overrides.length, 2);
  assert.ok(overrides[0].start < overrides[1].start);
});

test("buildIpaOverrides: empty lexicon or no matches -> empty array", () => {
  assert.deepEqual(buildIpaOverrides("nothing special here", []), []);
  assert.deepEqual(buildIpaOverrides("nothing special here", LEXICON), []);
});

/* ------------------------------------------------------------- buildAndroidSsml */

test("buildAndroidSsml: null when nothing to mark up", () => {
  assert.equal(buildAndroidSsml("plain text, no hard terms", LEXICON), null);
  assert.equal(buildAndroidSsml("just koji, no authored ipa", LEXICON), null);
});

test("buildAndroidSsml: wraps only authored terms in <phoneme>, leaves the rest as text", () => {
  const ssml = buildAndroidSsml("The binchōtan and koji were both present.", LEXICON);
  assert.ok(ssml.startsWith("<speak>") && ssml.endsWith("</speak>"));
  assert.match(ssml, /<phoneme alphabet="ipa" ph="biɲtɕoːtaɰ̃">binchōtan<\/phoneme>/);
  assert.doesNotMatch(ssml, /<phoneme[^>]*>koji<\/phoneme>/, "koji has no authored ipa and must stay plain text");
  assert.match(ssml, /koji/);
});

test("buildAndroidSsml: escapes XML-significant characters in surrounding text", () => {
  const ssml = buildAndroidSsml("A & B < C with binchōtan here.", LEXICON);
  assert.match(ssml, /A &amp; B &lt; C with/);
});

/* ------------------------------------------------------------- shellApplies */

test("shellApplies: false with no bridge (plain browser tab)", () => {
  assert.equal(shellApplies(undefined), false);
  assert.equal(shellApplies({}), false);
  assert.equal(shellApplies({ nativePromise: "not-a-function" }), false);
});

test("shellApplies: true with a bridge exposing nativePromise", () => {
  assert.equal(shellApplies({ nativePromise: async () => ({}) }), true);
});

/* ------------------------------------------------------------- speak() */

function fakeBridge(handler) {
  const calls = [];
  return {
    calls,
    bridge: {
      nativePromise: async (plugin, method, payload) => {
        calls.push({ plugin, method, payload });
        return handler ? handler(payload) : { ok: true };
      },
    },
  };
}

test("speak: empty text resolves { ok: false }, never throws", async () => {
  const result = await speak("", {});
  assert.equal(result.ok, false);
  assert.equal(result.path, "none");
});

test("speak: with a native bridge present, calls ForayTts.speak with the right payload", async () => {
  const { calls, bridge } = fakeBridge();
  const result = await speak("The binchōtan burns.", { lexiconEntries: LEXICON, bridge });
  assert.equal(result.ok, true);
  assert.equal(result.path, "native");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].plugin, PLUGIN_NAME);
  assert.equal(calls[0].method, "speak");
  assert.equal(calls[0].payload.text, "The binchōtan burns.");
  assert.equal(calls[0].payload.ipaOverrides.length, 1);
  assert.ok(calls[0].payload.androidSsml.includes("phoneme"));
});

test("speak: no lexiconEntries passed -> native call with an empty overrides list, not a crash", async () => {
  const { calls, bridge } = fakeBridge();
  const result = await speak("Plain narration text.", { bridge });
  assert.equal(result.ok, true);
  assert.deepEqual(calls[0].payload.ipaOverrides, []);
  assert.equal(calls[0].payload.androidSsml, null);
});

test("speak: passes through lang/rate/pitch/volume when given", async () => {
  const { calls, bridge } = fakeBridge();
  await speak("hello", { bridge, lang: "en-US", rate: 0.9, pitch: 1.0, volume: 0.8 });
  assert.equal(calls[0].payload.lang, "en-US");
  assert.equal(calls[0].payload.rate, 0.9);
  assert.equal(calls[0].payload.pitch, 1.0);
  assert.equal(calls[0].payload.volume, 0.8);
});

test("speak: falls back to Web Speech when no native bridge is present", async () => {
  const speakCalls = [];
  const fakeSynth = { speak: (utter) => speakCalls.push(utter) };
  class FakeUtterance {
    constructor(text) { this.text = text; }
  }
  const result = await speak("hello there", {
    bridge: undefined,
    speechSynth: fakeSynth,
    UtteranceCtor: FakeUtterance,
  });
  assert.equal(result.ok, true);
  assert.equal(result.path, "web-speech");
  assert.equal(result.overridesApplied, 0, "Web Speech has no documented pronunciation control");
  assert.equal(speakCalls.length, 1);
  assert.equal(speakCalls[0].text, "hello there");
});

test("speak: native call rejects -> falls back to Web Speech rather than rejecting", async () => {
  const bridge = { nativePromise: async () => { throw new Error("native boom"); } };
  const speakCalls = [];
  const fakeSynth = { speak: (utter) => speakCalls.push(utter) };
  class FakeUtterance { constructor(text) { this.text = text; } }
  const logs = [];
  const result = await speak("fallback path", {
    bridge,
    speechSynth: fakeSynth,
    UtteranceCtor: FakeUtterance,
    log: (...args) => logs.push(args),
  });
  assert.equal(result.ok, true);
  assert.equal(result.path, "web-speech");
  assert.equal(speakCalls.length, 1);
  assert.ok(logs.length >= 1, "the fallback should be logged, not silent");
});

test("speak: nothing available at all -> { ok: false, path: 'none' }, never throws", async () => {
  const result = await speak("no bridge, no speechSynthesis", { bridge: undefined, speechSynth: undefined, UtteranceCtor: undefined });
  assert.equal(result.ok, false);
  assert.equal(result.path, "none");
});

test("speak: a throwing logger must not break the fallback path", async () => {
  const bridge = { nativePromise: async () => { throw new Error("native boom"); } };
  const speakCalls = [];
  const fakeSynth = { speak: (utter) => speakCalls.push(utter) };
  class FakeUtterance { constructor(text) { this.text = text; } }
  const result = await speak("robust logging", {
    bridge,
    speechSynth: fakeSynth,
    UtteranceCtor: FakeUtterance,
    log: () => { throw new Error("logger itself is broken"); },
  });
  assert.equal(result.ok, true);
  assert.equal(result.path, "web-speech");
});

/* ------------------------------------------------------------- voice selection

   Added 2026-09-05. The defect these cover is on the NATIVE side (iOS asked
   `AVSpeechSynthesisVoice(language:)` for the system default — the compact,
   robotic tier — and never for the installed Enhanced/Premium voices), and it
   cannot be tested from Node. What CAN be tested here, and is, is the half this
   file owns: that a `voice` request reaches the native payload at all, that the
   Web Speech fallback honours one, that "not installed" is reported instead of
   swallowed, and that `listVoices()` answers on every path without throwing. */

// TO SEE IT FAIL: change `a.split("-")[0] === b.split("-")[0]` in
// `languageMatches` to `a === b` — the en-GB widening case goes false, and
// `listVoices({ lang: "en-US" })` hides every voice a device has for `en`.
test("languageMatches: exact locale, then primary subtag, never across languages", () => {
  assert.equal(languageMatches("en-US", "en-US"), true);
  assert.equal(languageMatches("en-GB", "en-US"), true, "same primary subtag is relevant");
  assert.equal(languageMatches("EN_us", "en-US"), true, "case and separator normalised");
  assert.equal(languageMatches("fr-FR", "en-US"), false);
  assert.equal(languageMatches("en-US", undefined), true, "no filter means everything matches");
  assert.equal(languageMatches(undefined, "en-US"), false, "a voice with no language cannot match one");
});

// TO SEE IT FAIL: drop `voice: voice ?? null,` from the native payload in
// `speak()` — an explicitly chosen voice never reaches the plugin and every
// device test silently compares the default voice against itself.
test("speak: passes an explicit voice identifier through to the native payload", async () => {
  const { calls, bridge } = fakeBridge();
  await speak("hello", { bridge, voice: "com.apple.voice.enhanced.en-US.Ava" });
  assert.equal(calls[0].payload.voice, "com.apple.voice.enhanced.en-US.Ava");
});

// TO SEE IT FAIL: same mutation — with `voice` absent from the payload the key
// is `undefined`, not `null`, and `assert.equal(..., null)` fails on strict.
test("speak: no voice requested -> the payload carries null, not a missing key", async () => {
  const { calls, bridge } = fakeBridge();
  await speak("hello", { bridge });
  assert.equal(calls[0].payload.voice, null);
});

// TO SEE IT FAIL: remove the `voice:` / `voiceFallback:` lines from the native
// return in `speak()`. A caller then has to reach into `.native` and know which
// platform it is talking to, which is precisely what makes a founder's report
// ("the enhanced voice sounds the same") unreadable.
test("speak: hoists the native voice report so 'not installed' is distinguishable", async () => {
  const { bridge } = fakeBridge(() => ({
    ok: true,
    voice: "com.apple.ttsbundle.Samantha-compact",
    voiceRequested: "com.apple.voice.premium.en-US.Zoe",
    voiceFallback: true,
    voiceReason: "requested voice is not installed on this device",
  }));
  const result = await speak("hello", { bridge, voice: "com.apple.voice.premium.en-US.Zoe" });
  assert.equal(result.voice, "com.apple.ttsbundle.Samantha-compact");
  assert.equal(result.voiceFallback, true, "the ask was not honoured and the caller must be able to see that");
  assert.equal(result.native.voiceReason, "requested voice is not installed on this device");
});

/** A Web Speech stand-in with a catalogue. */
function fakeSynthWithVoices(voices) {
  const spoken = [];
  return {
    spoken,
    synth: { speak: (u) => spoken.push(u), getVoices: () => voices },
  };
}
class FakeUtter {
  constructor(text) { this.text = text; }
}
const WEB_VOICES = [
  { voiceURI: "urn:moz-tts:sapi:Zira", name: "Microsoft Zira", lang: "en-US", default: true },
  { voiceURI: "urn:moz-tts:sapi:David", name: "Microsoft David", lang: "en-US", default: false },
  { voiceURI: "urn:moz-tts:sapi:Hortense", name: "Microsoft Hortense", lang: "fr-FR", default: false },
];

// TO SEE IT FAIL: delete the `if (match) utter.voice = match;` line in the
// Web Speech branch of `speak()` — the requested voice is accepted and ignored,
// which is the same class of bug as the native one being fixed here.
test("speak (web-speech): an explicit voice is applied to the utterance", async () => {
  const { spoken, synth } = fakeSynthWithVoices(WEB_VOICES);
  const result = await speak("hello", {
    bridge: undefined, speechSynth: synth, UtteranceCtor: FakeUtter,
    voice: "urn:moz-tts:sapi:David",
  });
  assert.equal(result.ok, true);
  assert.equal(spoken[0].voice.name, "Microsoft David");
  assert.equal(result.voice, "urn:moz-tts:sapi:David");
  assert.equal(result.voiceFallback, false);
});

// TO SEE IT FAIL: remove the `list.find((v) => v && v.name === wanted)` clause
// from `findWebSpeechVoice` — a human-readable name (what anyone copies out of
// a device report) stops resolving.
test("speak (web-speech): a voice can also be named rather than URI'd", async () => {
  const { spoken, synth } = fakeSynthWithVoices(WEB_VOICES);
  await speak("hello", {
    bridge: undefined, speechSynth: synth, UtteranceCtor: FakeUtter,
    voice: "Microsoft Hortense",
  });
  assert.equal(spoken[0].voice.lang, "fr-FR");
});

// TO SEE IT FAIL: set `voiceFallback = false` unconditionally in the Web Speech
// branch. The utterance still speaks — it always did — but the report claims the
// requested voice was used when it was not, which is the exact ambiguity this
// whole change exists to remove.
test("speak (web-speech): an unknown voice still speaks, and says it fell back", async () => {
  const { spoken, synth } = fakeSynthWithVoices(WEB_VOICES);
  const result = await speak("hello", {
    bridge: undefined, speechSynth: synth, UtteranceCtor: FakeUtter,
    voice: "com.apple.voice.premium.en-US.Zoe",
  });
  assert.equal(result.ok, true, "a missing voice must never stop the narration");
  assert.equal(spoken.length, 1);
  assert.equal(result.voiceFallback, true);
});

// TO SEE IT FAIL: remove the try/catch around `speechSynth.getVoices()` in
// `findWebSpeechVoice` — `speak()` then rejects, breaking its own documented
// "never throws" contract on a path a caller cannot control.
test("speak (web-speech): a throwing getVoices() must not break speak()", async () => {
  const spoken = [];
  const synth = { speak: (u) => spoken.push(u), getVoices: () => { throw new Error("no voices for you"); } };
  const result = await speak("hello", {
    bridge: undefined, speechSynth: synth, UtteranceCtor: FakeUtter, voice: "anything",
  });
  assert.equal(result.ok, true);
  assert.equal(spoken.length, 1);
  assert.equal(result.voiceFallback, true);
});

/* ------------------------------------------------------------- listVoices */

// TO SEE IT FAIL: change the native branch of `listVoices` to call
// `bridge.nativePromise(PLUGIN_NAME, "speak", …)`. Nothing else in this suite
// notices, and on a device the founder gets a spoken "null" instead of a list.
test("listVoices: calls the plugin's listVoices and returns its catalogue", async () => {
  const { calls, bridge } = fakeBridge(() => ({
    ok: true,
    voices: [
      { identifier: "com.apple.voice.premium.en-US.Zoe", name: "Zoe", language: "en-US", quality: "premium", isDefaultChoice: true },
      { identifier: "com.apple.ttsbundle.Samantha-compact", name: "Samantha", language: "en-US", quality: "default", isDefaultChoice: false },
    ],
    defaultIdentifier: "com.apple.voice.premium.en-US.Zoe",
  }));
  const out = await listVoices({ bridge, lang: "en-US" });
  assert.equal(calls[0].method, "listVoices");
  assert.equal(calls[0].payload.lang, "en-US");
  assert.equal(out.path, "native");
  assert.equal(out.voices.length, 2);
  assert.equal(out.defaultIdentifier, "com.apple.voice.premium.en-US.Zoe");
});

// TO SEE IT FAIL: remove the try/catch around the native call in `listVoices`.
// A shell whose native half predates this change rejects on an unknown method,
// and the whole call rejects instead of answering from Web Speech.
test("listVoices: a rejecting native side falls back to Web Speech, never rejects", async () => {
  const bridge = { nativePromise: async () => { throw new Error("no such method"); } };
  const { synth } = fakeSynthWithVoices(WEB_VOICES);
  const out = await listVoices({ bridge, speechSynth: synth, log: () => {} });
  assert.equal(out.path, "web-speech");
  assert.equal(out.voices.length, 3);
});

// TO SEE IT FAIL: drop the `.filter((v) => v && languageMatches(v.lang, lang))`
// in the Web Speech branch — asking for English returns the French voice too.
test("listVoices (web-speech): maps the shape, filters by language, marks the default", async () => {
  const { synth } = fakeSynthWithVoices(WEB_VOICES);
  const out = await listVoices({ bridge: undefined, speechSynth: synth, lang: "en-GB" });
  assert.equal(out.ok, true);
  assert.equal(out.voices.length, 2, "both en-US voices are relevant to en-GB; the fr-FR one is not");
  assert.deepEqual(Object.keys(out.voices[0]).sort(), ["identifier", "isDefaultChoice", "language", "name", "quality"]);
  assert.equal(out.voices[0].quality, "unknown", "Web Speech exposes no quality tier and must not invent one");
  assert.equal(out.defaultIdentifier, "urn:moz-tts:sapi:Zira");
});

// TO SEE IT FAIL: make the empty-list case return `{ ok: false }`. A browser
// that simply has not fired `voiceschanged` yet then reports a broken TTS
// stack, and a caller retries nothing because it was told it failed.
test("listVoices (web-speech): an empty catalogue is 'not loaded yet', not a failure", async () => {
  const { synth } = fakeSynthWithVoices([]);
  const out = await listVoices({ bridge: undefined, speechSynth: synth });
  assert.equal(out.ok, true);
  assert.deepEqual(out.voices, []);
  assert.match(out.reason, /loading/);
});

// TO SEE IT FAIL: have the final `return` in `listVoices` throw instead. Every
// caller in a headless/CI context (no bridge, no speechSynthesis) gets a
// rejection from a function documented to resolve.
test("listVoices: nothing available at all -> { ok: false, path: 'none' }, never throws", async () => {
  const out = await listVoices({ bridge: undefined, speechSynth: undefined });
  assert.equal(out.ok, false);
  assert.equal(out.path, "none");
  assert.deepEqual(out.voices, []);
});

/* ------------------------------------------------------------- createForayTtsShell */

// TO SEE IT FAIL: delete the `listVoices:` line from `createForayTtsShell` —
// `shell.listVoices` is undefined and this throws a TypeError.
test("createForayTtsShell: exposes listVoices with the same baked-in defaults", async () => {
  const { calls, bridge } = fakeBridge(() => ({ ok: true, voices: [], defaultIdentifier: "" }));
  const shell = createForayTtsShell({ bridge, lang: "en-GB" });
  await shell.listVoices();
  assert.equal(calls[0].method, "listVoices");
  assert.equal(calls[0].payload.lang, "en-GB");
});

test("createForayTtsShell: bakes in defaults, per-call opts override them", async () => {
  const { calls, bridge } = fakeBridge();
  const shell = createForayTtsShell({ bridge, lang: "en-GB" });
  await shell.speak("hi");
  assert.equal(calls[0].payload.lang, "en-GB");

  await shell.speak("bonjour", { lang: "fr-FR" });
  assert.equal(calls[1].payload.lang, "fr-FR");
});

test("createForayTtsShell: shellApplies reflects the baked-in bridge by default", () => {
  const { bridge } = fakeBridge();
  const shell = createForayTtsShell({ bridge });
  assert.equal(shell.shellApplies(), true);
  assert.equal(shell.shellApplies({}), false);
});

/* ------------------------------------------------------------- §7 item 3: onFinished

   L-03's advance-past-narration signal — the web half of the contract
   `ForayTtsPlugin.speechSynthesizer(_:didFinish:)` (iOS) and
   `UtteranceProgressListener.onDone` (Android) raise natively, surfaced the
   same way `foray-media-session.js`'s `TRANSPORT_EVENT` already is. */

/** A bridge that also answers `addListener`, the way `foray-media-session.js`'s
    own `subscribe()` expects Capacitor's real bridge to. `fakeBridge()` above
    has no such method — `speak`/`listVoices` never call it — so this is a
    distinct fixture rather than an extension of that one. */
function fakeListenerBridge() {
  const listeners = new Map(); // "plugin:event" -> Set<fn>
  return {
    key: (p, e) => `${p}:${e}`,
    listeners,
    bridge: {
      nativePromise: async () => ({ ok: true }),
      addListener(plugin, event, fn) {
        const k = `${plugin}:${event}`;
        if (!listeners.has(k)) listeners.set(k, new Set());
        listeners.get(k).add(fn);
        return { remove: () => listeners.get(k)?.delete(fn) };
      },
    },
  };
}

// TO SEE IT FAIL: in `onFinished`, call `bridge.addListener(PLUGIN_NAME, "done", fn)`
// (a wrong event name) — the fixture's own listeners map would then never
// receive a callback and this assertion would find nothing to invoke.
test("onFinished: subscribes to PLUGIN_NAME/FINISHED_EVENT via addListener", () => {
  const { bridge, listeners } = fakeListenerBridge();
  onFinished(() => {}, { bridge });
  assert.equal(listeners.get(`${PLUGIN_NAME}:${FINISHED_EVENT}`)?.size, 1);
});

test("onFinished: the callback fires when the bridge dispatches the event", () => {
  const { bridge, listeners } = fakeListenerBridge();
  const seen = [];
  onFinished(() => seen.push("fired"), { bridge });
  for (const fn of listeners.get(`${PLUGIN_NAME}:${FINISHED_EVENT}`)) fn();
  assert.deepEqual(seen, ["fired"]);
});

// TO SEE IT FAIL: drop the `handle.remove()` call from the returned
// unsubscribe function — a caller that unsubscribes (the manager's own
// `dispose()`) would then keep receiving events from a torn-down listener.
test("onFinished: the returned unsubscribe stops the callback from firing again", () => {
  const { bridge, listeners } = fakeListenerBridge();
  const seen = [];
  const unsubscribe = onFinished(() => seen.push("fired"), { bridge });
  const key = `${PLUGIN_NAME}:${FINISHED_EVENT}`;
  for (const fn of listeners.get(key)) fn();
  unsubscribe();
  assert.equal(listeners.get(key)?.size, 0, "the native listener set must be empty after unsubscribe");
  assert.deepEqual(seen, ["fired"], "no further event may reach the callback");
});

// The card's own contract: absence changes nothing. A plain browser tab (no
// Capacitor bridge at all) must get a safe no-op, not a throw.
// TO SEE IT FAIL: remove the `!shellApplies(bridge)` guard — this then throws
// trying to call `.addListener` on `undefined`.
test("onFinished: no bridge at all is a safe no-op", () => {
  const unsubscribe = onFinished(() => {}, { bridge: undefined });
  assert.equal(typeof unsubscribe, "function");
  assert.doesNotThrow(() => unsubscribe());
});

test("onFinished: a non-function callback is a no-op, not a crash", () => {
  const { bridge } = fakeListenerBridge();
  assert.doesNotThrow(() => onFinished(null, { bridge })());
  assert.doesNotThrow(() => onFinished(undefined, { bridge })());
});

// `nativeCallback` is `foray-media-session.js`'s own documented fallback for
// a bridge exposing only the thinner primitive `addListener` wraps.
// TO SEE IT FAIL: check `addListener` only, with no `nativeCallback` branch —
// a bridge shaped this way would then be treated as having no listener API
// at all, silently dropping the subscription.
test("onFinished: falls back to nativeCallback when addListener is absent", () => {
  const calls = [];
  const bridge = {
    nativePromise: async () => ({ ok: true }),
    nativeCallback: (plugin, method, args, cb) => calls.push({ plugin, method, args, cb }),
  };
  onFinished(() => {}, { bridge });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].plugin, PLUGIN_NAME);
  assert.equal(calls[0].args.eventName, FINISHED_EVENT);
});

test("createForayTtsShell: exposes onFinished wired to the same baked-in bridge", () => {
  const { bridge, listeners } = fakeListenerBridge();
  const shell = createForayTtsShell({ bridge });
  shell.onFinished(() => {});
  assert.equal(listeners.get(`${PLUGIN_NAME}:${FINISHED_EVENT}`)?.size, 1);
});
