/* GV-08 (R2-01, MQ-20, QK-30) — the listening card: one founder verdict on one
 * act of one blind version, as data.
 *
 * WHY A CARD AND NOT Q-06's THREE YES/NO QUESTIONS
 * Q-06 (docs/curation/listening-quality-plan.md) asked three yes/no questions
 * after a listen: one voice? every clip introduced? any clip cut short? Three
 * yeses closed the deck. Yes/no saturates: two acts that both "pass" cannot be
 * told apart, and a swap that makes the narration a little better or a little
 * worse moves nothing. The card scores four axes 1-5, an overall 1-5, keeps a
 * list of timestamped winces (what made the listener flinch, and when), and —
 * when two versions were heard blind — which one the listener preferred. The
 * three Q-06 answers ride along in `q06` so MQ-20 stays continuous with the
 * baseline definition: a run graded the old way and a run graded the new way
 * still share three fields.
 *
 * THE SHAPE (listen-card/1)
 *   {
 *     schema: "listen-card/1",
 *     cardId:  "<id>",                 // unique in the store
 *     packId:  "<id>",                 // the sealed pack the listen came from
 *     label:   "A" | "B" | "solo",     // which blind version, never a candidate id
 *     act:     1,                      // integer >= 1
 *     listener: "<who listened>",
 *     listenedAt: "2026-10-11T19:04:00Z",   // ISO 8601 with a zone
 *     scores: { onSubject, flowsAtSeams, oneNarrator, nothingFalseOrOdd },  // integers 1-5
 *     overall: 1-5,
 *     q06: { oneVoice, everyClipIntroduced, anyClipCutShort },              // booleans
 *     winces: [{ atSec, note }],       // note <= 280 characters
 *     preference: "A" | "B" | "tie"    // REQUIRED on an A/B card, FORBIDDEN on a solo card
 *   }
 *
 * The card names a LABEL, not a candidate: what was heard is sealed. The map
 * from label to candidate, provider and stage swap lives in the pack's key
 * (data-local/listening/keys/<packId>.key.json, never committed), and
 * tools/listening/unseal.mjs joins the two.
 *
 * WHY UNKNOWN KEYS ARE REFUSED
 * The store (docs/curation/listening/cards.jsonl) is committed and sits under
 * docs/, which auto-merges. It must hold verdicts only — no transcript text, no
 * narration script, no candidate id that would unblind a pack. A card with an
 * extra field is refused rather than stored, and the only free text a card can
 * carry is a wince note, capped at MAX_NOTE_CHARS.
 *
 * USAGE
 *   node tools/listening/card.mjs check [store.jsonl]          # validate the store
 *   node tools/listening/card.mjs append <card.json> [--store <store.jsonl>]
 *
 * `append` validates the card and the whole store first, refuses a duplicate
 * cardId, and only ever adds one line at the end: it never rewrites a line
 * already there. docs/curation/listening/README.md says who may append (the
 * founder's own pasted card JSON, nothing else).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isEntryScript } from "../ci/entry.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..");

/** The committed, append-only store of founder listening cards. */
export const DEFAULT_STORE = path.join(REPO_ROOT, "docs", "curation", "listening", "cards.jsonl");

export const CARD_SCHEMA = "listen-card/1";

/** The four scored axes, in the order a card form asks them. */
export const AXES = Object.freeze(["onSubject", "flowsAtSeams", "oneNarrator", "nothingFalseOrOdd"]);

/** Q-06's three yes/no questions, kept so MQ-20 stays continuous with the baseline. */
export const Q06_KEYS = Object.freeze(["oneVoice", "everyClipIntroduced", "anyClipCutShort"]);

export const LABELS = Object.freeze(["A", "B", "solo"]);
export const PREFERENCES = Object.freeze(["A", "B", "tie"]);

/** Every key a card may carry. Anything else is refused (see the header). */
export const CARD_KEYS = Object.freeze([
  "schema",
  "cardId",
  "packId",
  "label",
  "act",
  "listener",
  "listenedAt",
  "scores",
  "overall",
  "q06",
  "winces",
  "preference"
]);

/** A wince note is a reminder of what jarred, not a transcript. */
export const MAX_NOTE_CHARS = 280;

/** cardId and packId: a packId names a key FILE, so it must be a safe file
 * name — no separators, no `..`, nothing a path join could escape with. */
export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** ISO 8601 date-time with an explicit zone. A zoneless time is read in the
 * reader's local zone, so the same card would date differently on two
 * machines. */
export const LISTENED_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isScore = (v) => Number.isInteger(v) && v >= 1 && v <= 5;

/**
 * Check one card against listen-card/1. Never throws; returns every problem,
 * so a pasted card that is wrong in three places is fixed in one round.
 *
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateCard(card) {
  const errors = [];
  if (!isPlainObject(card)) return { ok: false, errors: ["a card is a JSON object"] };

  for (const key of Object.keys(card)) {
    if (!CARD_KEYS.includes(key)) errors.push(`unknown field "${key}" (a card holds verdicts only)`);
  }
  if (card.schema !== CARD_SCHEMA) errors.push(`schema must be "${CARD_SCHEMA}"`);
  if (typeof card.cardId !== "string" || !ID_RE.test(card.cardId)) errors.push("cardId must be a short id (letters, digits, . _ -)");
  if (typeof card.packId !== "string" || !ID_RE.test(card.packId)) errors.push("packId must be a short id (letters, digits, . _ -)");
  if (!LABELS.includes(card.label)) errors.push(`label must be one of ${LABELS.join(", ")}`);
  if (!Number.isInteger(card.act) || card.act < 1) errors.push("act must be an integer >= 1");
  if (typeof card.listener !== "string" || card.listener.trim() === "" || card.listener.length > 64) {
    errors.push("listener must name who listened (1-64 characters)");
  }
  if (typeof card.listenedAt !== "string" || !LISTENED_AT_RE.test(card.listenedAt) || !Number.isFinite(Date.parse(card.listenedAt))) {
    errors.push("listenedAt must be an ISO 8601 date-time with a zone, e.g. 2026-10-11T19:04:00Z");
  }

  if (!isPlainObject(card.scores)) {
    errors.push(`scores must be an object with ${AXES.join(", ")}`);
  } else {
    for (const axis of AXES) {
      if (!(axis in card.scores)) errors.push(`scores.${axis} is missing`);
      else if (!isScore(card.scores[axis])) errors.push(`scores.${axis} must be an integer 1-5`);
    }
    for (const key of Object.keys(card.scores)) {
      if (!AXES.includes(key)) errors.push(`scores.${key} is not an axis`);
    }
  }
  if (!isScore(card.overall)) errors.push("overall must be an integer 1-5");

  if (!isPlainObject(card.q06)) {
    errors.push(`q06 must be an object with ${Q06_KEYS.join(", ")}`);
  } else {
    for (const key of Q06_KEYS) {
      if (typeof card.q06[key] !== "boolean") errors.push(`q06.${key} must be true or false`);
    }
    for (const key of Object.keys(card.q06)) {
      if (!Q06_KEYS.includes(key)) errors.push(`q06.${key} is not a Q-06 question`);
    }
  }

  if (!Array.isArray(card.winces)) {
    errors.push("winces must be a list (empty when nothing jarred)");
  } else {
    card.winces.forEach((w, i) => {
      if (!isPlainObject(w)) {
        errors.push(`winces[${i}] must be { atSec, note }`);
        return;
      }
      if (typeof w.atSec !== "number" || !Number.isFinite(w.atSec) || w.atSec < 0) errors.push(`winces[${i}].atSec must be seconds >= 0`);
      if (typeof w.note !== "string") errors.push(`winces[${i}].note must be text`);
      else if (w.note.length > MAX_NOTE_CHARS) errors.push(`winces[${i}].note is over ${MAX_NOTE_CHARS} characters (a note, not a transcript)`);
      for (const key of Object.keys(w)) {
        if (key !== "atSec" && key !== "note") errors.push(`winces[${i}].${key} is not a wince field`);
      }
    });
  }

  /* A pair card without a preference is half a pairwise result: the whole
     point of hearing two versions blind is which one the listener would
     rather hear again. A solo card has nothing to prefer between. */
  if (card.label === "A" || card.label === "B") {
    if (!PREFERENCES.includes(card.preference)) errors.push(`a pair card (label ${card.label}) needs preference ${PREFERENCES.join(" | ")}`);
  } else if (card.label === "solo" && card.preference !== undefined) {
    errors.push("a solo card has no preference");
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Parse a store's text into cards. Every line must be a valid card and every
 * cardId unique; the first problem throws, naming `name:line`. Blank lines are
 * skipped; a CRLF line ending is tolerated.
 */
export function parseCards(text, name = "cards.jsonl") {
  const cards = [];
  const seen = new Map();
  const lines = String(text).split("\n");
  lines.forEach((raw, index) => {
    const line = raw.replace(/\r$/, "");
    if (line.trim() === "") return;
    const at = `${name}:${index + 1}`;
    let card;
    try {
      card = JSON.parse(line);
    } catch (err) {
      throw new Error(`${at}: not JSON (${err.message})`);
    }
    const { ok, errors } = validateCard(card);
    if (!ok) throw new Error(`${at}: ${errors.join("; ")}`);
    if (seen.has(card.cardId)) throw new Error(`${at}: duplicate cardId "${card.cardId}" (first on line ${seen.get(card.cardId)})`);
    seen.set(card.cardId, index + 1);
    cards.push(card);
  });
  return cards;
}

/** Every card in a store file, validated. A store that does not exist holds
 * no cards (a checkout without docs/, or a scratch path); a store that exists
 * and is malformed throws — a reader that skipped a bad line would report a
 * listen that never happened, or hide one that did. */
export function readCards(file = DEFAULT_STORE) {
  if (!fs.existsSync(file)) return [];
  return parseCards(fs.readFileSync(file, "utf8"), file);
}

/**
 * Append one card to the store. The card is validated, the whole store is
 * re-read (so a store already broken is not appended to), and a duplicate
 * cardId is refused. Existing bytes are never rewritten: the only change is a
 * newline if the last line lacks one, and the new line.
 */
export function appendCard(file, card) {
  const { ok, errors } = validateCard(card);
  if (!ok) throw new Error(`card refused: ${errors.join("; ")}`);
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const cards = parseCards(existing, file);
  if (cards.some((c) => c.cardId === card.cardId)) throw new Error(`card refused: cardId "${card.cardId}" is already in ${file}`);
  const lead = existing !== "" && !existing.endsWith("\n") ? "\n" : "";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${lead}${JSON.stringify(card)}\n`);
  return cards.length + 1;
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

export function main(argv, out = console.log) {
  const [command, ...rest] = argv;
  if (command === "check") {
    const file = rest[0] ? path.resolve(rest[0]) : DEFAULT_STORE;
    const cards = readCards(file);
    out(`${cards.length} valid card(s) in ${file}`);
    return cards.length;
  }
  if (command === "append") {
    let store = DEFAULT_STORE;
    let source = null;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--store") store = path.resolve(rest[++i]);
      else if (rest[i].startsWith("--")) throw new Error(`unknown flag ${rest[i]}`);
      else source = rest[i];
    }
    if (!source) throw new Error("usage: node tools/listening/card.mjs append <card.json> [--store <store.jsonl>]");
    let card;
    try {
      card = JSON.parse(fs.readFileSync(source, "utf8"));
    } catch (err) {
      throw new Error(`cannot read ${source}: ${err.message}`);
    }
    const count = appendCard(store, card);
    out(`appended ${card.cardId}; ${count} card(s) in ${store}`);
    return count;
  }
  throw new Error("usage: node tools/listening/card.mjs check [store.jsonl] | append <card.json> [--store <store.jsonl>]");
}

if (isEntryScript(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(String(err.message || err));
    process.exit(2);
  }
}
