/* G-21c part (2) — fixture-before-emit: every shape `check-forays.mjs` accepts
 * is carried by at least one committed Foray in `data/`.
 *
 * WHY (docs/curation/foray-to-spec-roadmap.md, G-21c). On 2026-09-11 the first
 * generated Foray carrying a `type: "jingle"` item passed the checker and broke
 * three consumers in CI — the lock-screen credit, the checker test's clock
 * arithmetic and the bundle-slice alarm (F-89) — because no consumer had ever
 * been shown a jingle before a real run emitted one. The checker's idea of
 * "valid" was wider than anything in `data/`. The rule that closes it: any
 * change that lets the generator emit a new item type, source kind, duration
 * source or segment field lands WITH a committed fixture Foray carrying that
 * shape, so every consumer sees it in CI first.
 *
 * WHAT THIS FILE DOES
 *   1. For every value in `ACCEPTED_SHAPES` (the checker's own enumeration —
 *      each list is the constant its checks read, not a copy), asserts a
 *      committed Foray, or a pool row a committed Foray plays, carries it.
 *   2. Scans `check-forays.mjs`'s source for a string literal compared against
 *      one of the vocabulary fields and fails if it is not in
 *      `ACCEPTED_SHAPES` — so a new accepted value cannot be added to the
 *      checker without also being enumerated, and therefore without a fixture.
 *   3. Keeps `KNOWN_UNCOVERED`: shapes the checker accepts that no committed
 *      Foray carries TODAY. Nothing here invents data. Each entry is asserted
 *      to be genuinely uncovered (so the entry is deleted the day a carrier
 *      lands) and the list has a ceiling (so it can only shrink).
 *
 * MUTATION (run before trusting): remove the jingle item from the generated
 * Foray in `data/forays.json` -> red on `item.type = jingle is carried by a
 * committed Foray` (the carrier is #632's "The Chain Reaction", merged
 * 2026-09-11; the entry this list held for it until then is gone).
 *
 * `FORAY_DATA_ROOT` points this file at another checkout's `data/`, exactly as
 * `--root` does for the checker CLI and for the same reason its header gives:
 * the honest proof of a coverage gate runs it against data with the shape
 * removed, not against a reading of the code. Unset, it reads the live repo.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { narrationDuration, SEGMENT, NARRATION } from "../../player/foray-queue.js";
import { ACCEPTED_SHAPES, loadFiles } from "./check-forays.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const CHECKER = path.join(HERE, "check-forays.mjs");
const DATA_ROOT = process.env.FORAY_DATA_ROOT ? path.resolve(process.env.FORAY_DATA_ROOT) : REPO_ROOT;

/* ------------------------------------------------------------ the data */

const files = loadFiles(DATA_ROOT);
const forays = files.forays.forays;
const segments = new Map((files.segments.segments || []).map((s) => [s.id, s]));
const sources = new Map((files.sources.sources || []).map((s) => [s.id, s]));

const nonEmpty = (s) => typeof s === "string" && s.trim().length > 0;
const ids = (rows) => [...new Set(rows.map((r) => r.foray.id))];

/** Every item of every committed Foray, with the Foray it belongs to. */
const items = () => forays.flatMap((foray) => (foray.items || []).map((item) => ({ foray, item })));
const narrationItems = () => items().filter((x) => x.item?.type === NARRATION);
/** Segment items that resolve to a pool row — the rows a consumer actually
    renders. A pool row no Foray plays is not a fixture in G-21c's sense. */
const playedSegments = () =>
  items()
    .filter((x) => x.item?.type === SEGMENT)
    .map((x) => ({ ...x, seg: segments.get(x.item.segment_id) }))
    .filter((x) => x.seg);
const playedSources = () => playedSegments().map((x) => ({ ...x, src: sources.get(x.seg.item_id) })).filter((x) => x.src);

/**
 * field -> (value) -> ids of the committed Forays carrying it. One entry per
 * key of `ACCEPTED_SHAPES`; a test below asserts the two key sets are equal,
 * so a field added to the checker's enumeration without a lookup here is red.
 */
const CARRIERS = {
  "foray.kind": (v) => forays.filter((f) => f.kind === v).map((f) => f.id),
  "foray.status": (v) => forays.filter((f) => f.status === v).map((f) => f.id),
  "foray.generated": (v) => forays.filter((f) => f.generated === v).map((f) => f.id),
  "item.type": (v) => ids(items().filter((x) => x.item?.type === v)),
  "narration.mode": (v) => ids(narrationItems().filter((x) => x.item.mode === v)),
  "narration.duration_source": (v) => ids(narrationItems().filter((x) => narrationDuration(x.item).source === v)),
  "narration.voice": (v) => ids(narrationItems().filter((x) => nonEmpty(x.item[v]))),
  "segment.role": (v) => ids(playedSegments().filter((x) => (x.seg.role ?? x.item.role ?? null) === v)),
  "segment.transcript_source": (v) => ids(playedSegments().filter((x) => x.seg.transcript_source === v)),
  "segment.source": (v) => ids(playedSegments().filter((x) => x.seg.source === v)),
  "segment.boundary": (v) => ids(playedSegments().filter((x) => x.seg.boundary === v)),
  "segment.dai_suspected": (v) => ids(playedSegments().filter((x) => x.seg.dai_suspected === v)),
  "source.dai_suspected": (v) => ids(playedSources().filter((x) => x.src.dai_suspected === v)),
  "source.source": (v) => ids(playedSources().filter((x) => x.src.source === v)),
};

/* ---------------------------------------------------------- the gap list */

/**
 * Shapes the checker accepts that NO committed Foray carries as of
 * 2026-09-11. Measured, not guessed: each is asserted below to still be
 * uncovered, so the entry has to go in the PR that lands its carrier. Nothing
 * is added here to make a test pass — a new accepted shape lands with its
 * fixture (G-21c), not with a line in this list.
 */
const KNOWN_UNCOVERED = [
  {
    field: "narration.mode",
    value: "correction",
    why: "neither generated Foray on main wrote a Correction beat; the pipeline may emit one on any run.",
  },
  {
    field: "narration.duration_source",
    value: "measured",
    why: "tools/narrate/ has not stamped `duration_sec` on any committed narration item yet.",
  },
  {
    field: "narration.duration_source",
    value: "fallback",
    why: "a narration item with neither script nor duration — the admin-authored 'unvoiced' state the checker warns on and the player drops; none is committed.",
  },
  {
    field: "narration.voice",
    value: "audio_url",
    why: "every committed narration item is script-only (on-device TTS); no rendered audio has been attached.",
  },
  {
    field: "narration.voice",
    value: "asset",
    why: "as above — `asset` is the second field the player reads for rendered audio.",
  },
  {
    field: "segment.role",
    value: "narrative",
    why: "no committed Foray plays a `narrative`-role segment (quote/explanation/exchange are all carried).",
  },
  /* Q-01 (2026-09-12): `boundary` is written by the tier-2 mint once the claim
     window has been extended to its thought (`tapeExtent.ts`). No generation
     run has been launched since — the listening-quality deck forbids one until
     Q-06 — so no committed row carries any of the three values yet. The first
     Q-01 Foray to publish carries `turn` and `sentence` on the run-8 measurement
     (10 and 5 of 16); `claim-only` was 1 of 16 there. */
  {
    field: "segment.boundary",
    value: "turn",
    why: "no Foray has been generated under Q-01 yet; the deck holds generation runs until Q-06.",
  },
  {
    field: "segment.boundary",
    value: "sentence",
    why: "as above.",
  },
  {
    field: "segment.boundary",
    value: "claim-only",
    why: "as above — 1 of 16 run-8 clips landed here (a clip the floor growth carried past its boundary).",
  },
];
/** Raise this only with a written reason in the same PR. Lowering it is free. */
const KNOWN_UNCOVERED_CEILING = 9; // 6 -> 9 with Q-01's `segment.boundary` (2026-09-12): three values, no run since

const isKnownUncovered = (field, value) => KNOWN_UNCOVERED.some((k) => k.field === field && k.value === value);

/* -------------------------------------------------------- the enumeration */

test("ACCEPTED_SHAPES is a frozen enumeration of non-empty value lists", () => {
  assert.ok(Object.isFrozen(ACCEPTED_SHAPES), "ACCEPTED_SHAPES must be frozen — it is the checker's contract, not a scratch object");
  assert.ok(Object.keys(ACCEPTED_SHAPES).length > 0);
  for (const [field, values] of Object.entries(ACCEPTED_SHAPES)) {
    assert.match(field, /^(foray|item|narration|segment|source)\.[a-z_]+$/, `${field}: keys are <record>.<field>`);
    assert.ok(Array.isArray(values) && values.length > 0, `${field}: must enumerate at least one value`);
    assert.equal(new Set(values).size, values.length, `${field}: duplicate value`);
    for (const v of values) {
      assert.ok(typeof v === "string" || typeof v === "boolean", `${field}: ${JSON.stringify(v)} is not a string or boolean`);
    }
  }
});

test("every field in ACCEPTED_SHAPES has a carrier lookup here, and every lookup names a field the checker enumerates", () => {
  const enumerated = Object.keys(ACCEPTED_SHAPES).sort();
  const lookedUp = Object.keys(CARRIERS).sort();
  assert.deepEqual(
    lookedUp,
    enumerated,
    "ACCEPTED_SHAPES and CARRIERS disagree about which fields exist. A field added to the checker's enumeration needs a " +
      "lookup in fixture-coverage.test.mjs (G-21c), and a lookup for a field the checker no longer enumerates is dead."
  );
});

/* ------------------------------------------------------ each shape, carried */

for (const [field, values] of Object.entries(ACCEPTED_SHAPES)) {
  for (const value of values) {
    const shape = `${field} = ${JSON.stringify(value)}`;
    const carriers = () => CARRIERS[field](value);
    if (isKnownUncovered(field, value)) {
      test(`KNOWN_UNCOVERED: ${shape} still has no committed carrier`, () => {
        const found = carriers();
        assert.equal(
          found.length,
          0,
          `${shape} is now carried by ${found.join(", ")} — delete its entry from KNOWN_UNCOVERED in ` +
            `tools/foray/fixture-coverage.test.mjs so the coverage gate holds it from here on (G-21c).`
        );
      });
    } else {
      test(`${shape} is carried by a committed Foray`, () => {
        const found = carriers();
        assert.ok(
          found.length > 0,
          `${shape}: check-forays.mjs accepts this shape but no committed Foray in data/ carries it, so no consumer has ` +
            `seen it in CI (G-21c fixture-before-emit, docs/curation/foray-to-spec-roadmap.md). Land a fixture Foray ` +
            `carrying it (status: draft, generated: true) in the same PR — or, if the carrier was just removed, put it back.`
        );
      });
    }
  }
}

/* ----------------------------------------------------- the list only shrinks */

test("KNOWN_UNCOVERED can only shrink: under its ceiling, no duplicates, every entry names a shape the checker still accepts", () => {
  assert.ok(
    KNOWN_UNCOVERED.length <= KNOWN_UNCOVERED_CEILING,
    `KNOWN_UNCOVERED has ${KNOWN_UNCOVERED.length} entries, over the ceiling of ${KNOWN_UNCOVERED_CEILING}. ` +
      `A new accepted shape lands with its fixture (G-21c), not with an entry here.`
  );
  const seen = new Set();
  for (const k of KNOWN_UNCOVERED) {
    const key = `${k.field} = ${JSON.stringify(k.value)}`;
    assert.ok(!seen.has(key), `${key} is listed twice`);
    seen.add(key);
    assert.ok(nonEmpty(k.why), `${key}: an uncovered shape needs a written reason`);
    assert.ok(
      Object.hasOwn(ACCEPTED_SHAPES, k.field) && ACCEPTED_SHAPES[k.field].includes(k.value),
      `${key} is in KNOWN_UNCOVERED but check-forays.mjs no longer enumerates it — delete the entry`
    );
  }
});

/* --------------------------------------------- the enumeration is complete */

/** Fields whose literal comparisons in the checker's source are vocabulary. */
const VOCAB_FIELDS = ["type", "kind", "status", "mode", "role", "source", "transcript_source", "duration_source"];
const FIELD_ALT = VOCAB_FIELDS.join("|");
/** `x.type === "lit"`, `!==` too; `typeof x.type === "string"` is not a vocabulary check. */
const CMP_RX = new RegExp(`(?<![\\w$.])(?<!typeof\\s+)(?:[\\w$]+\\??\\.)*(?:${FIELD_ALT})\\s*[!=]==\\s*"([^"]*)"`, "g");
/** The reversed form, `"lit" === x.type`. */
const CMP_REV_RX = new RegExp(`"([^"]*)"\\s*[!=]==\\s*(?:[\\w$]+\\??\\.)*(?:${FIELD_ALT})\\b`, "g");
/** `["a", "b"].includes(` — an inline enumeration used as a membership test. A
    bare array that is merely iterated (`for (const f of ["show", "title"])`)
    is a field list, not a vocabulary, and is deliberately not matched. */
const INCLUDES_RX = /\[((?:\s*"[^"]*"\s*,?)+)\]\s*\.includes\(/g;
/** `new Set(["a", "b"])` — the other way an inline enumeration is written. */
const SET_RX = /new Set\(\[((?:\s*"[^"]*"\s*,?)+)\]\)/g;

/** Every string literal `source` compares a vocabulary field against. */
function vocabularyLiterals(source) {
  const out = [];
  for (const m of source.matchAll(CMP_RX)) out.push(m[1]);
  for (const m of source.matchAll(CMP_REV_RX)) out.push(m[1]);
  for (const rx of [INCLUDES_RX, SET_RX]) {
    for (const m of source.matchAll(rx)) for (const s of m[1].matchAll(/"([^"]*)"/g)) out.push(s[1]);
  }
  return out;
}

test("the literal scanner sees a vocabulary comparison and ignores a typeof check", () => {
  const snippet = [
    'if (item.type === "credits") {}',
    'if (foray?.status !== "archived") {}',
    'if ("intro" === entry.kind) {}',
    'if (typeof item.type === "string") {}',
    'if (typeof s.transcript_source !== "string") {}',
    'if (!["quote", "aside"].includes(role)) {}',
    'const M = new Set(["hinge", "coda"]);',
    'if (typeof s.id !== "string") {}',
    'for (const f of ["show", "title"]) {}',
  ].join("\n");
  assert.deepEqual(vocabularyLiterals(snippet).sort(), ["archived", "aside", "coda", "credits", "hinge", "intro", "quote"]);
});

test("every literal check-forays.mjs compares a vocabulary field against is enumerated in ACCEPTED_SHAPES", () => {
  const source = fs.readFileSync(CHECKER, "utf8");
  const accepted = new Set(Object.values(ACCEPTED_SHAPES).flat().filter((v) => typeof v === "string"));
  const stray = [...new Set(vocabularyLiterals(source))].filter((lit) => !accepted.has(lit));
  assert.deepEqual(
    stray,
    [],
    `check-forays.mjs compares a vocabulary field against ${stray.map((s) => JSON.stringify(s)).join(", ")}, which ` +
      `ACCEPTED_SHAPES does not enumerate. A shape the checker accepts must be listed there and carried by a committed ` +
      `fixture Foray before a run can emit it (G-21c). Route the check through the exported constant, not a literal.`
  );
});
