#!/usr/bin/env node
/* Add `UIBackgroundModes: audio` to a generated iOS `Info.plist`.
 *
 * WHY THIS EXISTS (issue #38, MP4)
 * `docs/research/mp1-background-audio.md` §7.3 is the whole reason this file is
 * four hundred lines of care rather than a `sed`: on iOS the ENTIRE
 * background-audio requirement is one Info.plist key. WebKit sets the
 * `AVAudioSession` category itself for an audible `<audio>` element
 * (`MediaSessionManagerCocoa.mm`), so there is no plugin, no `AppDelegate` edit
 * and no Swift. The key is the only missing piece — and Capacitor has no config
 * option for it, so something has to edit the generated project.
 *
 * That "something" used to be a human on a Mac (`HUMAN-ACTIONS.md` #16 step 4).
 * This script is that step, so a CI runner can do it, and so it can be TESTED on
 * a machine with no Mac at all — which is the only part of #38 that is testable
 * here.
 *
 * WHY IT IS NOT A REGEX
 * A regex that stops matching produces a plist with no background mode, a build
 * that succeeds, an app that installs, and audio that dies the moment the phone
 * locks. That is the "fails green" shape this repo keeps getting burned by
 * (`tools/ci/run-suites.mjs`'s header; `prepare-webdir.mjs`'s derivation floor).
 * So:
 *
 *   1. The plist is walked as a tag stream, and only the ROOT dict's own keys
 *      are considered. A nested `UIBackgroundModes` — inside
 *      `NSAppTransportSecurity`, say — must not be mistaken for the real one,
 *      and a regex cannot tell them apart.
 *   2. Anything unexpected THROWS rather than being skipped: no `<plist>`, a
 *      non-dict root, a key with no value, `UIBackgroundModes` that is not an
 *      `<array>`, an unclosed tag.
 *   3. The result is RE-PARSED and asserted before it is returned. If the edit
 *      did not land, this function fails instead of reporting success.
 *
 * On the runner, `/usr/libexec/PlistBuddy` re-reads the file afterwards, so
 * Apple's own parser is the second opinion on our output. Neither check can
 * substitute for the other: PlistBuddy proves the file is valid, the re-parse
 * proves the value is there.
 *
 * USAGE
 *   node tools/mobile/inject-background-audio.mjs <Info.plist>
 *   node tools/mobile/inject-background-audio.mjs <Info.plist> --check
 *   node tools/mobile/inject-background-audio.mjs <Info.plist> --mode audio
 * Any other argument is an error, not an ignored flag (same rule as
 * run-suites.mjs and prepare-webdir.mjs).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The one value iOS needs for backgrounded `<audio>`. Named so the reason
 *  travels with it. */
export const BACKGROUND_AUDIO_MODE = "audio";

/* ------------------------------------------------------------ tag scanning */

/** Walk the XML as a flat stream of tags, skipping comments, the XML
 *  declaration and the DOCTYPE. Text content is not tokenised — callers slice
 *  it out of the source between two tag positions, which is what keeps the
 *  output byte-identical everywhere it was not edited. */
export function* tags(xml, from = 0) {
  let i = from;
  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) return;
    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt);
      if (end < 0) throw new PlistError("unterminated XML comment");
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<!", lt) || xml.startsWith("<?", lt)) {
      const end = xml.indexOf(">", lt);
      if (end < 0) throw new PlistError("unterminated <! or <? declaration");
      i = end + 1;
      continue;
    }
    const gt = xml.indexOf(">", lt);
    if (gt < 0) throw new PlistError(`unterminated tag at offset ${lt}`);
    const inner = xml.slice(lt + 1, gt).trim();
    const closing = inner.startsWith("/");
    const selfClosing = inner.endsWith("/");
    const name = inner.replace(/^\//, "").replace(/\/$/, "").trim().split(/\s/)[0];
    if (!name) throw new PlistError(`empty tag name at offset ${lt}`);
    yield { name, closing, selfClosing, start: lt, end: gt + 1 };
    i = gt + 1;
  }
}

export class PlistError extends Error {}

/** Consume exactly one element starting at token `i`. Returns its byte span and
 *  the index of the token after it. Depth is counted on the element's OWN name,
 *  which is correct for well-formed XML and is what makes nested `<dict>` and
 *  `<array>` safe. */
function parseElement(toks, i) {
  const t = toks[i];
  if (!t) throw new PlistError("unexpected end of plist");
  if (t.closing) throw new PlistError(`unexpected </${t.name}>`);
  if (t.selfClosing) {
    return { name: t.name, start: t.start, end: t.end, next: i + 1, empty: true };
  }
  let depth = 1;
  for (let j = i + 1; j < toks.length; j++) {
    const u = toks[j];
    if (u.name !== t.name) continue;
    if (u.closing) {
      if (--depth === 0) {
        return {
          name: t.name,
          start: t.start,
          end: u.end,
          openEnd: t.end,
          closeStart: u.start,
          next: j + 1,
          empty: false,
        };
      }
    } else if (!u.selfClosing) {
      depth++;
    }
  }
  throw new PlistError(`<${t.name}> is never closed`);
}

/** The root dict's own key/value pairs, in file order. Nested containers are
 *  spanned but not descended into — see the header on why that matters. */
export function rootEntries(xml) {
  const toks = [...tags(xml)];
  const pi = toks.findIndex((t) => t.name === "plist" && !t.closing);
  if (pi < 0) {
    throw new PlistError(
      "no <plist> element — this does not look like an Info.plist. Refusing to edit it."
    );
  }
  let di = -1;
  for (let k = pi + 1; k < toks.length; k++) {
    if (toks[k].closing) continue;
    di = k;
    break;
  }
  if (di < 0) throw new PlistError("<plist> has no root element");
  if (toks[di].name !== "dict") {
    throw new PlistError(`expected <dict> as the plist root, found <${toks[di].name}>`);
  }
  const rootDict = parseElement(toks, di);
  if (rootDict.empty) {
    throw new PlistError(
      "the plist root is a self-closing <dict/>. A generated Info.plist is never empty, " +
        "so this file is not the one you think it is. Refusing to edit it."
    );
  }

  const entries = [];
  const closeTok = rootDict.next - 1;
  let i = di + 1;
  while (i < closeTok) {
    const key = parseElement(toks, i);
    if (key.name !== "key") {
      throw new PlistError(
        `expected <key> in the root dict, found <${key.name}> at offset ${key.start}`
      );
    }
    const name = xml.slice(key.openEnd, key.closeStart).trim();
    if (key.next >= closeTok) throw new PlistError(`root key "${name}" has no value`);
    const value = parseElement(toks, key.next);
    if (value.name === "key") throw new PlistError(`root key "${name}" has no value`);
    entries.push({ key: name, value });
    i = value.next;
  }
  return { rootDict, entries };
}

/** The `<string>` members of an `<array>` element, at that array's own depth. */
function arrayStrings(xml, arrayEl) {
  if (arrayEl.empty) return [];
  const toks = [...tags(xml, arrayEl.openEnd)];
  const out = [];
  let i = 0;
  while (i < toks.length) {
    const t = toks[i];
    if (t.closing && t.name === "array") break;
    const el = parseElement(toks, i);
    if (el.name !== "string") {
      throw new PlistError(
        `UIBackgroundModes contains a <${el.name}>; every member must be a <string>.`
      );
    }
    const raw = el.empty ? "" : xml.slice(el.openEnd, el.closeStart);
    /* NOT trimmed, and an adversarial pass found why. `<string> audio </string>`
       is a mode iOS does not honour — but trimming made it read as "audio",
       which made `injectBackgroundAudio` report "already present", write
       nothing, and pass its own re-parse. `--check` passed too, `plutil -lint`
       passed, and `PlistBuddy | grep audio` passed on the padded value. All
       three "independent confirmations" agreed, and all three were wrong. So a
       member with surrounding whitespace is refused rather than normalised: a
       human wrote it, and quietly disagreeing with them is how this gets found
       on a device instead of here. */
    if (raw !== raw.trim()) {
      throw new PlistError(
        `UIBackgroundModes contains <string>${JSON.stringify(raw)}</string> — a mode with ` +
          `surrounding whitespace. iOS will not honour it, and treating it as ${JSON.stringify(raw.trim())} ` +
          `would make this script report success while changing nothing. Fix the plist by hand.`
      );
    }
    out.push(raw);
    i = el.next;
  }
  return out;
}

/** The root dict's ONE `UIBackgroundModes` entry, plus its parsed modes. `hit` is
 *  null when the key is absent, and `modes` is null with it.
 *
 *  DUPLICATE KEYS THROW, and that hole was opened by an adversarial pass rather
 *  than imagined: with two root-level `UIBackgroundModes` keys, a `.find()`
 *  appends to the FIRST while every plist reader — Apple's included — takes the
 *  LAST. The script reported success, its own re-parse agreed, `--check` agreed,
 *  and the effective value was still `["location"]`. A plist with two of the same
 *  root key is malformed; say so instead of picking one. */
function backgroundModesEntry(xml) {
  const { rootDict, entries } = rootEntries(xml);
  const hits = entries.filter((e) => e.key === "UIBackgroundModes");
  if (hits.length > 1) {
    throw new PlistError(
      `the root dict declares UIBackgroundModes ${hits.length} times. Plist readers take the ` +
        `last one, so an edit to any other is invisible. Delete the duplicates by hand first.`
    );
  }
  const hit = hits[0] ?? null;
  if (!hit) return { rootDict, entries, hit: null, modes: null };
  if (hit.value.name !== "array") {
    throw new PlistError(
      `UIBackgroundModes is a <${hit.value.name}>, but iOS requires an <array> of strings. ` +
        `Fix the plist by hand — this script will not rewrite a value it did not write.`
    );
  }
  return { rootDict, entries, hit, modes: arrayStrings(xml, hit.value) };
}

/** Whatever `UIBackgroundModes` the ROOT dict declares, or null if it has none.
 *  Exported because "what does the plist say?" is the question a reader has,
 *  and because it is what `injectBackgroundAudio` verifies itself with. */
export function backgroundModes(xml) {
  return backgroundModesEntry(xml).modes;
}

/**
 * Assert that `xml` really declares `mode`, and throw if it does not.
 *
 * EXPORTED SO IT CAN BE TESTED DIRECTLY. It was previously an inline `if` at the
 * end of `injectBackgroundAudio`, and an adversarial pass changed it to
 * `if (false)` with all 22 tests still green — a guard whose own comment says
 * that without it "every failure mode above degrades to 'returned the input
 * unchanged and said it worked'". A guard that can be deleted invisibly is not a
 * guard, so it is now a named function with tests of its own.
 */
export function assertModePresent(xml, mode) {
  const modes = backgroundModes(xml);
  if (!modes || !modes.includes(mode)) {
    throw new PlistError(
      `the edit did not take: UIBackgroundModes reads ${JSON.stringify(modes)} after ` +
        `injection, which does not include ${JSON.stringify(mode)}. This is a bug in ` +
        `inject-background-audio.mjs, not in the plist.`
    );
  }
  return modes;
}

/* ---------------------------------------------------------------- injection */

/** The indentation used by the root dict's first key, so the inserted block
 *  matches the file rather than a guess about it. Capacitor's generated plist
 *  uses tabs; Xcode's UI rewrites with tabs too. */
function rootIndent(xml, entries) {
  const first = entries[0];
  if (!first) return "\t";
  const lineStart = xml.lastIndexOf("\n", first.value.start) + 1;
  const before = xml.slice(lineStart, first.value.start);
  const m = /^[ \t]*/.exec(before);
  return m && m[0] ? m[0] : "\t";
}

/**
 * Add `mode` to the root dict's `UIBackgroundModes`, creating the key if it is
 * absent and leaving any other modes alone.
 *
 * @returns {{xml: string, changed: boolean, reason: string, modes: string[]}}
 * @throws {PlistError} on anything it does not understand, and on an edit that
 *   did not take effect.
 */
export function injectBackgroundAudio(xml, mode = BACKGROUND_AUDIO_MODE) {
  if (typeof xml !== "string" || xml.trim() === "") {
    throw new PlistError("empty plist source");
  }
  if (typeof mode !== "string" || mode.trim() === "" || /[<>&]/.test(mode)) {
    throw new PlistError(`invalid background mode ${JSON.stringify(mode)}`);
  }

  const { rootDict, entries, hit } = backgroundModesEntry(xml);
  const indent = rootIndent(xml, entries);

  let out;
  let reason;
  if (!hit) {
    const block =
      `${indent}<key>UIBackgroundModes</key>\n` +
      `${indent}<array>\n` +
      `${indent}${indent}<string>${mode}</string>\n` +
      `${indent}</array>\n`;
    /* Insert immediately before `</dict>`, after backing over the indentation on
       that line so the closing tag keeps its own position. */
    let at = rootDict.closeStart;
    while (at > 0 && (xml[at - 1] === " " || xml[at - 1] === "\t")) at--;
    out = xml.slice(0, at) + block + xml.slice(at);
    reason = `added UIBackgroundModes with "${mode}"`;
  } else {
    /* The type check and the duplicate-key check both happened in
       backgroundModesEntry(), so by here `hit.value` is known to be an array. */
    const existing = arrayStrings(xml, hit.value);
    if (existing.includes(mode)) {
      /* Idempotent on purpose: CI re-runs, and `cap sync` can regenerate. A
         script that only works once is a script somebody will run twice. */
      return { xml, changed: false, reason: `"${mode}" already present`, modes: existing };
    }
    if (hit.value.empty) {
      /* `<array/>` — Xcode writes this for an emptied array. Expand it. */
      const expanded =
        `<array>\n` + `${indent}${indent}<string>${mode}</string>\n` + `${indent}</array>`;
      out = xml.slice(0, hit.value.start) + expanded + xml.slice(hit.value.end);
    } else {
      let at = hit.value.closeStart;
      while (at > 0 && (xml[at - 1] === " " || xml[at - 1] === "\t")) at--;
      out = xml.slice(0, at) + `${indent}${indent}<string>${mode}</string>\n` + xml.slice(at);
    }
    reason = `appended "${mode}" to the existing UIBackgroundModes (was: ${existing.join(", ") || "empty"})`;
  }

  /* THE ANTI-FAILS-GREEN CHECK. Re-parse our own output and insist the mode is
     really there. Without it, every failure mode above degrades to "returned the
     input unchanged and said it worked". It is `assertModePresent` rather than an
     inline `if` because an adversarial pass replaced the inline version with
     `if (false)` and left all 22 tests green. */
  return { xml: out, changed: true, reason, modes: assertModePresent(out, mode) };
}

/* --------------------------------------------------------------------- main */

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const argv = process.argv.slice(2);
  let file = null;
  let checkOnly = false;
  let mode = BACKGROUND_AUDIO_MODE;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--check") checkOnly = true;
    else if (argv[i] === "--mode") {
      mode = argv[++i];
      /* `--mode --check` used to consume the flag as the value and inject
         `<string>--check</string>`. A flag is never a value. */
      if (!mode || mode.startsWith("-")) {
        console.error(`--mode needs a value, got ${mode === undefined ? "nothing" : mode}`);
        process.exit(2);
      }
    } else if (!argv[i].startsWith("-") && file === null) file = argv[i];
    else {
      console.error(`Unknown argument: ${argv[i]}`);
      console.error("Usage: node tools/mobile/inject-background-audio.mjs <Info.plist> [--check] [--mode audio]");
      process.exit(2);
    }
  }
  if (!file) {
    console.error("Usage: node tools/mobile/inject-background-audio.mjs <Info.plist> [--check] [--mode audio]");
    process.exit(2);
  }

  try {
    const src = fs.readFileSync(file, "utf8");
    if (checkOnly) {
      const modes = backgroundModes(src);
      if (!modes || !modes.includes(mode)) {
        console.error(`${file}: UIBackgroundModes is ${JSON.stringify(modes)} — "${mode}" is missing.`);
        process.exit(1);
      }
      console.log(`${file}: UIBackgroundModes = ${JSON.stringify(modes)}`);
    } else {
      const r = injectBackgroundAudio(src, mode);
      if (r.changed) fs.writeFileSync(file, r.xml);
      console.log(`${file}: ${r.reason} -> ${JSON.stringify(r.modes)}`);
    }
  } catch (e) {
    console.error(`inject-background-audio failed: ${e.message}`);
    process.exit(1);
  }
}
