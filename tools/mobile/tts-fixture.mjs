#!/usr/bin/env node
/* The narrowest real proof this card asks for (docs/research/on-device-tts.md
 * §7 item 2 / this card's own scope item 2): take a beat's claim text from
 * one of the two committed spines, plus the hard-term lexicon, and show
 * EXACTLY what `mobile/plugins/foray-tts/web/foray-tts.js`'s `speak()` would
 * hand to the native plugin -- the same JS module the shell loads, run here
 * in Node against the real lexicon file and real spine text.
 *
 * WHAT THIS PROVES: the beat-text -> lexicon-match -> override-payload
 * pipeline is wired correctly end-to-end in JS, using the actual production
 * module (`foray-tts.js`), not a reimplementation of its logic.
 *
 * WHAT THIS DOES NOT PROVE, stated plainly because pretending otherwise would
 * be exactly the kind of unlabelled claim this repo's own research docs warn
 * against: nothing here has spoken through a real `AVSpeechSynthesizer` or
 * `android.speech.tts.TextToSpeech`, because this is a Node process with no
 * WebView, no simulator and no device -- there is no `window.Capacitor` to
 * call, and this repo's own CI does not build a real iOS/Android app either
 * (`docs/ios-ci.md`, `docs/mobile-shell.md`'s own "launched on Android: No").
 * Running this for real against a live voice needs the fixture
 * `docs/research/narrator-voice.md` §5.7 designed, executed inside the
 * Capacitor shell on real devices -- see this plugin's README.md.
 *
 * USAGE
 *   node tools/mobile/tts-fixture.mjs [--beat N] [--spine grilling|alcohol]
 *
 *   Defaults to the first beat of the grilling spine that contains at least
 *   one lexicon term, so a bare run always shows a non-trivial payload.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { speak, buildIpaOverrides, buildAndroidSsml } from "../../mobile/plugins/foray-tts/web/foray-tts.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

const LEXICON_PATH = path.join(REPO_ROOT, "mobile/plugins/foray-tts/lexicon/hard-terms.json");
const SPINES = {
  grilling: path.join(REPO_ROOT, "docs/curation/grilling-history-spine.md"),
  alcohol: path.join(REPO_ROOT, "docs/curation/alcohol-forms-spine.md"),
};

export function loadLexicon(lexiconPath = LEXICON_PATH) {
  const doc = JSON.parse(fs.readFileSync(lexiconPath, "utf8"));
  return doc.entries;
}

/** Extract `**Claim.**` paragraphs from a spine document, same method
 *  `docs/research/narrator-voice.md` §2's own "Reproducing the measurements"
 *  note describes: the paragraph immediately following a `**Claim.**`
 *  marker, under a `#### N.` beat heading. */
export function extractClaims(markdown) {
  const claims = [];
  const beatHeadingRe = /^####\s+(\d+)\./gm;
  const headings = [...markdown.matchAll(beatHeadingRe)];
  for (let i = 0; i < headings.length; i++) {
    const start = headings[i].index;
    const end = i + 1 < headings.length ? headings[i + 1].index : markdown.length;
    const section = markdown.slice(start, end);
    const m = section.match(/\*\*Claim\.\*\*\s*([\s\S]*?)(?:\n\n|\n\*\*|$)/);
    if (m) {
      const text = m[1].replace(/\*\*/g, "").replace(/\*/g, "").replace(/\s+/g, " ").trim();
      if (text) claims.push({ beat: Number(headings[i][1]), text });
    }
  }
  return claims;
}

/** A fake bridge that records the exact call it received instead of
 *  reaching a real WebView -- this is the fake the honesty note above
 *  refers to. It resolves like a real accepted call so `speak()`'s success
 *  path runs, but it never touches a synthesizer. */
function recordingBridge(sink) {
  return {
    nativePromise: async (plugin, method, payload) => {
      sink.push({ plugin, method, payload });
      return { platform: "fixture", ok: true, accepted: true, overridesApplied: (payload.ipaOverrides || []).length };
    },
  };
}

async function main(argv) {
  const args = argv.slice(2);
  const flag = (name, dflt) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
  };
  const spineName = flag("--spine", "grilling");
  const beatArg = flag("--beat", null);
  const spinePath = SPINES[spineName];
  if (!spinePath) {
    console.error(`unknown --spine ${spineName}; choices: ${Object.keys(SPINES).join(", ")}`);
    return 1;
  }

  const lexicon = loadLexicon();
  const markdown = fs.readFileSync(spinePath, "utf8");
  const claims = extractClaims(markdown);
  if (claims.length === 0) {
    console.error(`no **Claim.** paragraphs found in ${spinePath}`);
    return 1;
  }

  let chosen;
  if (beatArg != null) {
    chosen = claims.find((c) => c.beat === Number(beatArg));
    if (!chosen) {
      console.error(`beat ${beatArg} not found in ${spineName} spine (have ${claims.map((c) => c.beat).join(", ")})`);
      return 1;
    }
  } else {
    chosen = claims.find((c) => buildIpaOverrides(c.text, lexicon).length > 0 || findAnyLexiconHit(c.text, lexicon)) ?? claims[0];
  }

  const calls = [];
  const bridge = recordingBridge(calls);
  const result = await speak(chosen.text, { lexiconEntries: lexicon, bridge, log: () => {} });

  console.log(`spine: ${spineName}  beat: ${chosen.beat}`);
  console.log(`text:  ${chosen.text}`);
  console.log("");
  console.log(`speak() result: ${JSON.stringify(result)}`);
  console.log("");
  if (calls.length === 0) {
    console.log("NO native call was made (fell back or failed before reaching the bridge).");
  } else {
    const call = calls[0];
    console.log(`native call: ${call.plugin}.${call.method}`);
    console.log(`  ipaOverrides authored (non-null ipa): ${call.payload.ipaOverrides.length}`);
    for (const o of call.payload.ipaOverrides) {
      console.log(`    - "${o.term}" [${o.start}-${o.end}] ipa=${JSON.stringify(o.ipa)}`);
    }
    console.log(`  androidSsml built: ${call.payload.androidSsml ? "yes" : "no (no authored ipa in this beat, or none needed)"}`);
  }

  const matchedTerms = matchTermsOnly(chosen.text, lexicon);
  console.log("");
  console.log(`lexicon terms matched in this beat's claim text (ipa authored or not): ${matchedTerms.length}`);
  for (const t of matchedTerms) console.log(`    - "${t.term}" ipa=${t.ipa === null ? "null (not yet authored)" : JSON.stringify(t.ipa)}`);

  console.log("");
  console.log("NOT PROVEN BY THIS RUN: no real AVSpeechSynthesizer / TextToSpeech call happened.");
  console.log("This Node process has no WebView; the payload above is exactly what would be sent to");
  console.log("window.Capacitor.nativePromise('ForayTts', 'speak', ...) inside the Capacitor shell.");
  console.log("Running it against real voices needs the narrator-voice.md §5.7 fixture on real devices.");

  return 0;
}

function findAnyLexiconHit(text, lexiconEntries) {
  const lower = text.toLowerCase();
  return lexiconEntries.some((e) => lower.includes(e.term.toLowerCase()));
}

function matchTermsOnly(text, lexiconEntries) {
  // Reuse the same word-boundary approach as buildIpaOverrides but without
  // filtering out null-ipa entries, so the report shows the FULL lexicon hit
  // set for this beat, not just the (today, zero) authored-ipa subset.
  const matches = [];
  for (const entry of lexiconEntries) {
    if (!entry || !entry.term) continue;
    const escaped = entry.term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?<![\\p{L}\\p{N}'])${escaped}(?![\\p{L}\\p{N}'])`, "giu");
    if (re.test(text)) matches.push({ term: entry.term, ipa: entry.ipa ?? null });
  }
  return matches;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv).then((code) => process.exit(code));
}
