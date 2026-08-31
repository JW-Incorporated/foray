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
  buildIpaOverrides,
  buildAndroidSsml,
  shellApplies,
  speak,
  createForayTtsShell,
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

/* ------------------------------------------------------------- createForayTtsShell */

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
