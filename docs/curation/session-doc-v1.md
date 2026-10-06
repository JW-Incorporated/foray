# Session doc v1 — `data/session.json`

The session document is the four-card menu the clients download: the web player
reads `data/session.json`, the iOS reference app decodes the same shape
(`ios/ForayKit/Sources/ForayKit/SessionModels.swift`), and the backend session
builder (`backend/src/curation/sessionBuilder.ts`, `npm run build-session`)
emits it.

**The executable contract is `backend/src/types/session.ts` (`SessionDocSchema`).**
This page explains it; where the two disagree, the schema wins and this page is
the bug. Two suites hold the real file to it:

- `backend/test/sessionDoc.test.ts` parses the committed `data/session.json`
  with `SessionDocSchema` and checks every provenance signal against the real
  `data/taxonomy.json` and `data/personas.json`.
- `backend/test/sessionBuilder.test.ts` holds the builder to the same schema and
  checks that its signals come from the ranking, not from the episode afterwards.

## Top level

| Field | Type | Meaning |
|---|---|---|
| `version` | `1` | Literal. A breaking change is a new version, not an edit. |
| `session_id` | string | e.g. `"2026-07-08-morning"`. Events carry it as `session_key`. |
| `builder` | string | Who built this menu: `"hand-architect-v1"` (hand-curated) or `"machine-v1"` / `"auto-v1"` (the builder). The client stamps it into every event — the blind hand-vs-machine test (REQUIREMENTS-DELTA R1). Never shown in the UI. |
| `built_at` | ISO 8601 string | When the menu was built. |
| `commute` | `{ minutes, playback_speed, content_minutes }` | Learned listening context. Never rendered as copy (commute-length framing is banned — DECISIONS 2026-07-08). |
| `cards` | `SessionCard[]` | The menu, one card per archetype slot. |
| `categories` | `{ id, label, description, groups: [{ label, episode_ids }] }[]` | Browse shelves for this session. |
| `episodes` | `Record<episode id, EpisodeDetail>` | Every episode a card, alternate or category references. CI fails a dangling reference. |

## Cards

| Field | Type | Meaning |
|---|---|---|
| `slot` | int ≥ 1 | Menu position. |
| `archetype` | `deep-learn` \| `stretch` \| `narrative` \| `comfort` | Which pool the pick came from (03_CURATION_SPEC.md). |
| `archetype_label` | string | Header copy ("Go deep", "Stretch", "Story", "Comfort"). Copy-gated. |
| `episode_id` | string | Key into `episodes`. |
| `why_line` | string | ≤ 18 words, copy-gated (`backend/test/copyRules.test.ts`). |
| `fit_line` | string | A plain duration statement. Copy-gated. |
| `alternates` | string[] | Runner-up episode ids from the same pool. |
| `provenance` | object | **Required.** Why this card was picked — below. |

## Provenance

Added by #72 (REQUIREMENTS-DELTA R17): *"the session doc gains a
machine-readable `provenance` field per card (signals used, bridge, wildcard
flag) that the automated builder must emit from its first R1 run — retrofitting
explanations later would mean the blind test validated a builder that can't
explain itself."* The tap-through UI that shows it is iOS v1 and out of scope;
the schema, the builder emitting it, and CI validating it are in.

```json
"provenance": {
  "signals": ["pool:stretch", "topic:science/materials", "depth:medium"],
  "bridge": "your fusion interest -> materials science",
  "wildcard": true,
  "builder": "machine-v1"
}
```

| Field | Type | Rule |
|---|---|---|
| `signals` | string[], at least one | What actually drove the pick. If the ranker used it, it is listed; if it did not, it is not. Closed grammar, below. |
| `bridge` | string, optional | **Required when `archetype` is `stretch`** — CLAUDE.md copy rule 4, "Stretch picks must state their bridge", made machine-readable. Holds the same copy rules as every other string on a card. |
| `wildcard` | boolean | The exploration-floor pick (~30%), flagged so it can be labelled honestly instead of looking like a bad recommendation. |
| `builder` | string | Must equal the session's top-level `builder`. |

No other keys: the object is strict, so a typo (`signal`, `wild_card`) fails
instead of passing silently.

### Signal grammar

| Signal | Means | Emitted by the builder when |
|---|---|---|
| `topic:<node id>` | A `data/taxonomy.json` node the pick matched. | The enriched topic is a node of the effective taxonomy — exactly the set `computeRelevance` averaged. A topic the taxonomy lacks scored nothing and is omitted. |
| `persona:<persona id>` | A `data/personas.json` persona weighted that match. | A matched topic took its effective weight from the persona (tier 2 of `resolveEffectiveTaxonomy`, or a user row a persona seed wrote). |
| `pool:<archetype>` | The archetype pool the pick was ranked within. | Always: `pickSlots` ranks within the pool. |
| `depth:<low\|medium\|high>` | The episode's depth fed the quality term. | `computeQuality`'s depth bonus was non-zero (medium or high). |
| `recency` | Freshness counted for the pick. | `computeFreshness` beat 0.5, the neutral value an undated episode gets. |
| `fatigue` | A same-show repetition penalty applied. | `computeFatigue` was above zero. |

The schema enforces the grammar (so `"placeholder"` or `""` cannot validate);
`backend/test/sessionDoc.test.ts` enforces what it cannot see without the data
files: a `topic:` id is a real taxonomy node **and** one of that card's episode
topics, a `persona:` id is a real persona, a `pool:` matches the card's
archetype, and a `depth:` matches the episode's depth.

### What the builder does today

- **wildcard** is `true` on the Stretch card and `false` elsewhere. The
  exploration floor in this builder is structural, not a coin flip: the Stretch
  pool is restricted upstream to adjacent/cold material
  (`backend/src/curation/archetypes.ts`), so the Stretch slot — 1 of 4 — is the
  wildcard.
- **bridge** is the curator-written `bridge` the research candidate carries
  when it has one (the same text the why-line generator is given); otherwise
  `your <dominant interest> interest -> <the pick's topic>`, from the node the
  why-line generator was told to bridge from.

### Hand-built sessions

`"builder": "hand-architect-v1"` cards carry provenance too: the four cards in
`data/session.json` were backfilled in #72 from each episode's own taxonomy
topics and depth, plus `recency` on the comfort pick its why-line calls "still
warm". A hand curator may list `depth:low` (the comfort pick is low-effort on
purpose); the builder never does, because low depth adds nothing to its score.

### Editing `data/session.json`

The file is hand-authored and kept readable — one line per episode block, one
line per provenance object. Edit its text; never re-serialise it with
`JSON.stringify` (see `tools/refresh/session-patch.mjs`, which regex-patches the
episode blocks for the same reason).
