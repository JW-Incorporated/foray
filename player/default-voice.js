/* The default narration voice — ONE rule, in one place (founder decision,
   2026-09-10: "Samantha was the least worst so let's go with that for now").

   Before this module, "no `cp_voice` stored" meant "let the plugin pick its
   own best-installed tier" — `ForayTtsPlugin.swift`'s `bestVoice()`, PR #491:
   highest quality rank wins, ties toward the system default's name. That rule
   is still the FALLBACK, but it is the wrong FIRST answer: on a phone where
   the founder has downloaded one Enhanced voice to try, #491 silently swaps
   narration onto it, and on a stock phone it can land on any compact voice
   that sorts first. Both are "a stranger arrived", which is exactly the
   verdict the first listening test came back with.

   So the rule is now: when nothing is stored, narration AND the picker use
   Samantha's BEST INSTALLED identifier (premium > enhanced > compact — the
   plugin's own `quality` labels, ranked here only to compare duplicates of
   the same name), and only when no Samantha is installed at all does the
   plugin's #491 heuristic get its turn (`null` from `pickDefaultVoice`, which
   `queue-manager.js` passes through unchanged as "plugin picks").

   Pure, like `playback-rate.js`: no storage, no DOM, no bridge. `client.js`
   owns reading `cp_voice` and applying the answer to the manager; `app.js`
   owns rendering it as the selected row. Neither re-derives the rule — both
   call `pickDefaultVoice` on the same `listVoices()` result.

   NOT WRITTEN TO `cp_voice`. A default is a default: storing it would turn
   "the founder never chose" into "the founder chose Samantha", and a later
   change of default (or a later Samantha Enhanced download, which changes
   the best identifier) would then be ignored on that phone forever. */

/** The voice whose best installed tier is the default. Name, not identifier:
    the identifier differs by tier (`com.apple.ttsbundle.Samantha-compact`
    vs `com.apple.voice.enhanced.en-US.Samantha`) and by iOS version
    (`mobile/plugins/foray-tts/README.md` §"Identifier shapes"), and the
    whole point is to follow the best one the device has. */
export const DEFAULT_VOICE_NAME = "Samantha";

/** The `lang` the page and the boot-time default resolution pass to
    `listVoices()`. A bare primary subtag, deliberately: both native halves
    match the exact locale FIRST AND ALONE (`ForayTtsPlugin.swift`'s
    `candidates(_:language:)`, `ForayTtsPlugin.java`'s `candidates`), so
    `"en-US"` never returns Daniel (en-GB) or Karen (en-AU) while any en-US
    voice is installed — and one always is. `"en"` matches no exact locale,
    so both halves widen to the primary subtag and return every `en-*`
    voice; the web shim's `languageMatches` does the same by construction. */
export const VOICE_LIST_LANG = "en";

/** Rank a `listVoices()` `quality` label so two installs of the SAME name
    can be compared. iOS reports `premium | enhanced | default`; Android
    `very-high | high | normal | low | very-low`; Web Speech `unknown`. The
    tiers are not comparable ACROSS platforms and this never compares them
    across platforms — a device reports one platform's labels. Unknown
    labels rank between `default` and `low` so an unexpected new tier is
    neither promoted above a known-good one nor buried under `very-low`. */
export function qualityRank(quality) {
  switch (String(quality || "").toLowerCase()) {
    case "premium":
    case "very-high":
      return 5;
    case "enhanced":
    case "high":
      return 4;
    case "default":
    case "normal":
      return 3;
    case "low":
      return 1;
    case "very-low":
      return 0;
    default:
      return 2;
  }
}

/** The primary language subtag, lower-cased: `en-US` -> `en`, `en_GB` ->
    `en`, `eng-USA` (an Android engine spelling) -> `eng`. Empty for a
    missing language. */
export function primarySubtag(language) {
  if (typeof language !== "string") return "";
  return language.toLowerCase().split(/[-_]/)[0];
}

/** Is this voice's language English at all? Accepts BCP-47 (`en-*`) and the
    ISO-639-2 spelling some Android engines use (`eng-*`). */
export function isEnglish(language) {
  const p = primarySubtag(language);
  return p === "en" || p === "eng";
}

/** Among `voices` (a `listVoices()` result's `voices` array), the entry with
    `name` (case-insensitive) and the highest `qualityRank`, or `null`. Ties
    go to the FIRST listed — the plugin already sorts best-first within a
    language, so this never reorders what it reported. Non-English entries
    are skipped even when the name matches (Eloquence ships the same names
    across many locales). */
export function bestInstalledByName(voices, name) {
  if (!Array.isArray(voices) || !name) return null;
  const wanted = String(name).toLowerCase();
  let best = null;
  for (const v of voices) {
    if (!v || typeof v.identifier !== "string" || !v.identifier) continue;
    if (String(v.name || "").toLowerCase() !== wanted) continue;
    if (!isEnglish(v.language)) continue;
    if (!best || qualityRank(v.quality) > qualityRank(best.quality)) best = v;
  }
  return best;
}

/** THE DECISION. `voices` is a `listVoices()` result's `voices` array.
    Returns the identifier narration and the picker should treat as chosen
    when nothing is stored: Samantha's best installed tier, or `null` when
    no Samantha is installed — which `queue-manager.js`/`foray-tts.js`
    already treat as "the plugin picks" (#491's heuristic, unchanged). */
export function pickDefaultVoice(voices) {
  const best = bestInstalledByName(voices, DEFAULT_VOICE_NAME);
  return best ? best.identifier : null;
}
