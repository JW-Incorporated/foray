/* GV-08 (R2-01, R2-21, MQ-20) — unseal listening cards against their packs'
 * keys: which candidate each blind label was, which one the listener
 * preferred, and how the stage swaps fared pair by pair.
 *
 * WHAT IS SEALED, AND WHERE THE SEAL LIVES
 * A listening pack (tools/listening/pack.mjs, GV-36) plays act N of one
 * candidate ("solo") or of two candidates as "A" and "B" in a seeded random
 * order. The listener never sees which is which, and neither does the card:
 * cards name a label. The pack's KEY says what each label was:
 *
 *   data-local/listening/keys/<packId>.key.json   (never committed)
 *   {
 *     schema: "listen-key/1",
 *     packId, promptId, act,
 *     A:    { candidateId, provider, stageSwap },   // a pair pack has A and B
 *     B:    { candidateId, provider, stageSwap },
 *     solo: { candidateId, provider, stageSwap }    // a solo pack has only this
 *   }
 *
 * `candidateId` is the candidate file's name without `.json` — the basename
 * generateForays.ts writes as a report entry's `file` — so the bench can join a
 * report row to its listens without reading the candidate. `stageSwap` names
 * the arm of a swap experiment ("baseline", "spine:local:second", ...); a solo
 * listen of an ordinary run says "baseline".
 *
 * WITHOUT THE KEY NOTHING IS UNSEALED
 * The keys live on the machine that built the packs. Anywhere else, unseal
 * REFUSES — it names the missing key file — rather than guessing, and the
 * bench's `listen` columns stay absent (rule 1 of tools/generation-bench/run.mjs).
 *
 * WHAT COMES OUT
 *   unseal(cards)           one result per pack:
 *                           { packId, promptId, act, mode, A, B, solo,
 *                             preferred, preferredCandidateId, preferenceConflict,
 *                             axisDeltas, overall, cards, lastListenedAt }
 *                           axisDeltas is A's score minus B's, per axis and
 *                           overall, when both versions were carded.
 *   aggregate(results)      per stageSwap label: { pairs, wins, ties, losses, rate }
 *                           with rate = wins / pairs (a tie is not a win). This
 *                           is R2-21's go/no-go reading for a stage swap.
 *   listenByCandidate(cards) Map candidateId -> { meanOverall, lastListenedAt, cards }
 *                           over every card that unseals to that candidate (a
 *                           re-listen is another data point) — MQ-20 in the bench.
 *
 * Within one pack, unseal() reads the LATEST card per label (by listenedAt,
 * then store order): a re-listen of the same pack supersedes the earlier
 * verdict for the pairwise result, while listenByCandidate still counts both.
 *
 * USAGE
 *   node tools/listening/unseal.mjs [--cards <store.jsonl>] [--keys <dir>]
 */

import fs from "node:fs";
import path from "node:path";
import { isEntryScript } from "../ci/entry.mjs";
import { AXES, DEFAULT_STORE, ID_RE, REPO_ROOT, readCards } from "./card.mjs";

export const KEY_SCHEMA = "listen-key/1";

/** Where pack.mjs writes keys: local, gitignored (data-local/). */
export const DEFAULT_KEY_DIR = path.join(REPO_ROOT, "data-local", "listening", "keys");

/** The error code a missing key carries, so a caller (the bench) can tell
 * "the keys are not on this machine" from a malformed key or store. */
export const KEY_MISSING = "LISTEN_KEY_MISSING";

/** `<keyDir>/<packId>.key.json`. The packId is checked against ID_RE first, so
 * a card cannot point the reader outside the key directory. */
export function keyPathFor(keyDir, packId) {
  if (typeof packId !== "string" || !ID_RE.test(packId)) throw new Error(`not a pack id: ${JSON.stringify(packId)}`);
  return path.join(keyDir, `${packId}.key.json`);
}

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function armErrors(arm, name) {
  if (!isPlainObject(arm)) return [`${name} must be { candidateId, provider, stageSwap }`];
  const errors = [];
  for (const field of ["candidateId", "provider", "stageSwap"]) {
    if (typeof arm[field] !== "string" || arm[field].trim() === "") errors.push(`${name}.${field} must be a non-empty string`);
  }
  return errors;
}

/** Check one key. A pair key has A and B and no solo; a solo key has only solo. */
export function validateKey(key) {
  if (!isPlainObject(key)) return { ok: false, errors: ["a key is a JSON object"] };
  const errors = [];
  if (key.schema !== KEY_SCHEMA) errors.push(`schema must be "${KEY_SCHEMA}"`);
  if (typeof key.packId !== "string" || !ID_RE.test(key.packId)) errors.push("packId must be a short id");
  if (typeof key.promptId !== "string" || key.promptId.trim() === "") errors.push("promptId must be a non-empty string");
  if (!Number.isInteger(key.act) || key.act < 1) errors.push("act must be an integer >= 1");
  const pair = key.A !== undefined || key.B !== undefined;
  if (pair && key.solo !== undefined) errors.push("a key is a pair (A, B) or a solo, not both");
  if (pair) errors.push(...armErrors(key.A, "A"), ...armErrors(key.B, "B"));
  else errors.push(...armErrors(key.solo, "solo"));
  return { ok: errors.length === 0, errors };
}

/**
 * Read the key of every pack id given. Refuses — one Error naming EVERY
 * missing key file, with `code: KEY_MISSING` — when any is absent; throws a
 * plain Error for a key that is unreadable, malformed, or for another pack.
 */
export function loadKeys(packIds, keyDir = DEFAULT_KEY_DIR) {
  const keys = new Map();
  const missing = [];
  for (const packId of [...new Set(packIds)].sort()) {
    const file = keyPathFor(keyDir, packId);
    if (!fs.existsSync(file)) {
      missing.push(file);
      continue;
    }
    let key;
    try {
      key = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
      throw new Error(`cannot read key ${file}: ${err.message}`);
    }
    const { ok, errors } = validateKey(key);
    if (!ok) throw new Error(`key ${file}: ${errors.join("; ")}`);
    if (key.packId !== packId) throw new Error(`key ${file} is for pack "${key.packId}", not "${packId}"`);
    keys.set(packId, key);
  }
  if (missing.length) {
    const err = new Error(
      `cannot unseal: missing key ${missing.join(", ")} (keys are written by tools/listening/pack.mjs on the machine that built the pack, and never committed)`
    );
    err.code = KEY_MISSING;
    err.missing = missing;
    throw err;
  }
  return keys;
}

/** The key's arm for a card's label, or a thrown Error when the card and the
 * key disagree about what kind of pack it was. */
function armFor(key, card) {
  if (!key) throw new Error(`card ${card.cardId}: no key for pack ${card.packId}`);
  const arm = card.label === "solo" ? key.solo : key[card.label];
  if (!arm) throw new Error(`card ${card.cardId}: label ${card.label} is not in pack ${key.packId}'s key`);
  if (card.act !== key.act) throw new Error(`card ${card.cardId}: act ${card.act} but pack ${key.packId} is act ${key.act}`);
  return arm;
}

const armView = (arm) => (arm ? { candidateId: arm.candidateId, provider: arm.provider, stageSwap: arm.stageSwap } : null);
const later = (a, b) => Date.parse(b.listenedAt) >= Date.parse(a.listenedAt);

/** One result per pack, sorted by packId. See the header for the shape. */
export function unseal(cards, options = {}) {
  const keys = options.keys || loadKeys(cards.map((c) => c.packId), options.keyDir || DEFAULT_KEY_DIR);
  const byPack = new Map();
  for (const card of cards) {
    if (!byPack.has(card.packId)) byPack.set(card.packId, []);
    byPack.get(card.packId).push(card);
  }
  const results = [];
  for (const packId of [...byPack.keys()].sort()) {
    const key = keys.get(packId);
    const packCards = byPack.get(packId);
    const latest = {};
    for (const card of packCards) {
      armFor(key, card);
      if (!latest[card.label] || later(latest[card.label], card)) latest[card.label] = card;
    }
    const mode = key.solo ? "solo" : "pair";
    const lastListenedAt = packCards.reduce((m, c) => (m === null || Date.parse(c.listenedAt) > Date.parse(m) ? c.listenedAt : m), null);

    let preferred = null;
    let preferenceConflict = false;
    let axisDeltas = null;
    if (mode === "pair") {
      const pairCards = [latest.A, latest.B].filter(Boolean);
      const newest = pairCards.reduce((m, c) => (m === null || later(m, c) ? c : m), null);
      preferred = newest ? newest.preference : null;
      preferenceConflict = new Set(pairCards.map((c) => c.preference)).size > 1;
      if (latest.A && latest.B) {
        axisDeltas = {};
        for (const axis of AXES) axisDeltas[axis] = latest.A.scores[axis] - latest.B.scores[axis];
        axisDeltas.overall = latest.A.overall - latest.B.overall;
      }
    }
    const preferredCandidateId = preferred === "A" || preferred === "B" ? key[preferred].candidateId : null;

    results.push({
      packId,
      promptId: key.promptId,
      act: key.act,
      mode,
      A: armView(key.A),
      B: armView(key.B),
      solo: armView(key.solo),
      preferred,
      preferredCandidateId,
      preferenceConflict,
      axisDeltas,
      overall:
        mode === "pair"
          ? { A: latest.A ? latest.A.overall : null, B: latest.B ? latest.B.overall : null }
          : { solo: latest.solo ? latest.solo.overall : null },
      cards: packCards.length,
      lastListenedAt
    });
  }
  return results;
}

/**
 * R2-21's go/no-go: per stageSwap label, how often the arm carrying it was
 * preferred. A pair whose two arms carry the same label compares nothing and
 * is left out; a pair with no preference (no card yet) is left out. rate is
 * wins / pairs — a tie counts in `pairs` and `ties`, never as a win.
 */
export function aggregate(results) {
  const out = {};
  for (const r of results) {
    if (r.mode !== "pair" || !r.preferred || !r.A || !r.B) continue;
    if (r.A.stageSwap === r.B.stageSwap) continue;
    for (const label of ["A", "B"]) {
      const swap = r[label].stageSwap;
      const row = (out[swap] ||= { pairs: 0, wins: 0, ties: 0, losses: 0, rate: null });
      row.pairs += 1;
      if (r.preferred === "tie") row.ties += 1;
      else if (r.preferred === label) row.wins += 1;
      else row.losses += 1;
    }
  }
  for (const row of Object.values(out)) row.rate = row.wins / row.pairs;
  return Object.fromEntries(Object.keys(out).sort().map((k) => [k, out[k]]));
}

/**
 * MQ-20 per candidate: the mean `overall` over every card that unseals to it,
 * the latest listenedAt, and how many cards. Refuses without the keys, like
 * unseal(). A candidate nobody listened to is simply not in the map.
 */
export function listenByCandidate(cards, options = {}) {
  const keys = options.keys || loadKeys(cards.map((c) => c.packId), options.keyDir || DEFAULT_KEY_DIR);
  const acc = new Map();
  for (const card of cards) {
    const arm = armFor(keys.get(card.packId), card);
    const row = acc.get(arm.candidateId) || { sum: 0, cards: 0, lastListenedAt: null };
    row.sum += card.overall;
    row.cards += 1;
    if (row.lastListenedAt === null || Date.parse(card.listenedAt) > Date.parse(row.lastListenedAt)) row.lastListenedAt = card.listenedAt;
    acc.set(arm.candidateId, row);
  }
  return new Map(
    [...acc.entries()].map(([id, row]) => [id, { meanOverall: row.sum / row.cards, lastListenedAt: row.lastListenedAt, cards: row.cards }])
  );
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

export function main(argv, out = console.log) {
  let cardsFile = DEFAULT_STORE;
  let keyDir = DEFAULT_KEY_DIR;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--cards") cardsFile = path.resolve(argv[++i]);
    else if (argv[i] === "--keys") keyDir = path.resolve(argv[++i]);
    else throw new Error(`unknown argument ${argv[i]}; usage: node tools/listening/unseal.mjs [--cards <store.jsonl>] [--keys <dir>]`);
  }
  const cards = readCards(cardsFile);
  const keys = loadKeys(cards.map((c) => c.packId), keyDir);
  const packs = unseal(cards, { keys });
  for (const pack of packs) out(JSON.stringify(pack));
  out(JSON.stringify({ aggregate: aggregate(packs) }));
  return packs;
}

if (isEntryScript(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(String(err.message || err));
    process.exit(2);
  }
}
