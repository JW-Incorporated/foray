/* Tests for default-voice.js — the ONE rule for "no `cp_voice` stored".

   Founder decision 2026-09-10: Samantha is the default. Pure module, so
   every test is list work: which entry of a `listVoices()` result wins, and
   when the answer is "nobody — let the plugin's #491 heuristic pick".
   `player/client.js` applies the answer to the manager and `app.js` paints
   it as the selected row (covered by `test/voice-settings.test.js`, which
   imports THIS module into its fake bridge so the two surfaces cannot
   drift); this file pins the rule itself. */

import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_VOICE_NAME, VOICE_LIST_LANG,
  qualityRank, primarySubtag, isEnglish, bestInstalledByName, pickDefaultVoice,
} from "./default-voice.js";

const v = (identifier, name, language, quality) => ({ identifier, name, language, quality });

/** A stock-ish iOS 17+ catalogue: Samantha compact, a handful of novelty and
    Eloquence voices at the same `default` tier, one other locale. */
const STOCK = [
  v("com.apple.speech.synthesis.voice.Albert", "Albert", "en-US", "default"),
  v("com.apple.eloquence.en-US.Eddy", "Eddy", "en-US", "default"),
  v("com.apple.ttsbundle.Samantha-compact", "Samantha", "en-US", "default"),
  v("com.apple.speech.synthesis.voice.Zarvox", "Zarvox", "en-US", "default"),
  v("com.apple.ttsbundle.Daniel-compact", "Daniel", "en-GB", "default"),
];

test("the default is Samantha, requested across every English locale", () => {
  // MUTATION: change either constant. Both are product decisions the
  // founder made by name, and both are read by two other files.
  assert.equal(DEFAULT_VOICE_NAME, "Samantha");
  assert.equal(VOICE_LIST_LANG, "en", "a bare primary subtag is what makes both native halves widen to every en-* voice");
});

test("on a stock phone the default is Samantha compact, not whichever novelty voice sorts first", () => {
  // MUTATION: in `bestInstalledByName`, drop the name comparison. Albert
  // (sorts first, same tier) then wins — the "stranger arrived" verdict.
  assert.equal(pickDefaultVoice(STOCK), "com.apple.ttsbundle.Samantha-compact");
});

test("with Samantha installed at two tiers, the best tier's identifier wins", () => {
  // MUTATION: in `bestInstalledByName`, flip `>` to `<`. Compact wins and
  // this fails — the exact bug #491 fixed inside the plugin, reintroduced
  // one layer up.
  const both = [...STOCK, v("com.apple.voice.enhanced.en-US.Samantha", "Samantha", "en-US", "enhanced")];
  assert.equal(pickDefaultVoice(both), "com.apple.voice.enhanced.en-US.Samantha");
  const three = [...both, v("com.apple.voice.premium.en-US.Samantha", "Samantha", "en-US", "premium")];
  assert.equal(pickDefaultVoice(three), "com.apple.voice.premium.en-US.Samantha");
});

test("a better voice of ANOTHER name never displaces Samantha as the default", () => {
  // MUTATION: make `pickDefaultVoice` return the overall best voice. Ava
  // premium then wins, which is the #491 behaviour the founder overruled.
  const withAva = [v("com.apple.voice.premium.en-US.Ava", "Ava", "en-US", "premium"), ...STOCK];
  assert.equal(pickDefaultVoice(withAva), "com.apple.ttsbundle.Samantha-compact");
});

test("no Samantha installed at all -> null, which means 'the plugin picks' (#491 unchanged)", () => {
  const none = STOCK.filter((x) => x.name !== "Samantha");
  assert.equal(pickDefaultVoice(none), null);
  assert.equal(pickDefaultVoice([]), null);
  assert.equal(pickDefaultVoice(undefined), null);
  assert.equal(pickDefaultVoice(null), null);
});

test("the name match is case-insensitive and ignores entries with no identifier", () => {
  const odd = [
    { identifier: "", name: "Samantha", language: "en-US", quality: "premium" },
    v("x-samantha", "samantha", "en-US", "default"),
  ];
  assert.equal(pickDefaultVoice(odd), "x-samantha");
});

test("a same-named voice in a non-English locale is not the English default", () => {
  // Eloquence ships the same names across locales; a French "Samantha"
  // would be a different voice, and must not be picked for English narration.
  const foreign = [v("com.apple.voice.compact.fr-FR.Samantha", "Samantha", "fr-FR", "enhanced")];
  assert.equal(pickDefaultVoice(foreign), null);
  assert.equal(pickDefaultVoice([...foreign, ...STOCK]), "com.apple.ttsbundle.Samantha-compact");
});

test("qualityRank orders iOS and Android tiers within a platform, and never crashes on junk", () => {
  assert.ok(qualityRank("premium") > qualityRank("enhanced"));
  assert.ok(qualityRank("enhanced") > qualityRank("default"));
  assert.ok(qualityRank("very-high") > qualityRank("high"));
  assert.ok(qualityRank("high") > qualityRank("normal"));
  assert.ok(qualityRank("normal") > qualityRank("low"));
  assert.ok(qualityRank("low") > qualityRank("very-low"));
  // Unknown/absent labels sit below every known-good tier and above `low`.
  assert.ok(qualityRank("unknown") < qualityRank("default"));
  assert.ok(qualityRank(undefined) > qualityRank("low"));
  assert.equal(qualityRank("PREMIUM"), qualityRank("premium"));
});

test("primarySubtag / isEnglish accept BCP-47, underscores, and Android's ISO-639-2 spelling", () => {
  assert.equal(primarySubtag("en-US"), "en");
  assert.equal(primarySubtag("en_GB"), "en");
  assert.equal(primarySubtag("eng-USA"), "eng");
  assert.equal(primarySubtag(undefined), "");
  assert.ok(isEnglish("en-AU"));
  assert.ok(isEnglish("eng-IND"));
  assert.ok(!isEnglish("fr-FR"));
  assert.ok(!isEnglish(""));
});

test("bestInstalledByName is the same rule for any name, so the picker's per-row dedup cannot drift from the default", () => {
  const dup = [
    v("com.apple.ttsbundle.Daniel-compact", "Daniel", "en-GB", "default"),
    v("com.apple.voice.enhanced.en-GB.Daniel", "Daniel", "en-GB", "enhanced"),
  ];
  assert.equal(bestInstalledByName(dup, "daniel").identifier, "com.apple.voice.enhanced.en-GB.Daniel");
  assert.equal(bestInstalledByName(dup, "Kate"), null);
  assert.equal(bestInstalledByName(dup, ""), null);
});
