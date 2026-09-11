# Player streaming brief — WS-D2's status payload and the append contract

For Hermes (UI owner). Companion to `docs/curation/generation-fix-plan-2026-09-09.md`
("D2 (streaming publish)") and `docs/curation/generation-architecture.md` §1.4/§6/§7.
WS-D2 built the **backend half only** — the partial-candidate shape, the pipeline hook
that emits it, and the (not-yet-wired) status read path — and deliberately did not touch
`app.js` or any player code. This is the contract the player side builds against.

## 0. What exists today, stated plainly

There is **no live HTTP service** anywhere in this repo yet. `backend/src` has no
express/fastify/router of any kind. Foray generation runs only as a founder-operated CLI
(`npm run generate-forays`), and `app.js` already says why the UI half is off:
`renderCreate()`'s Foray toggle is permanently disabled with "Custom Forays aren't
available yet" (D8's own comment, `app.js` around the Create-screen block). The Desktop
plan `4a-forays-in-app-plan.md` (2026-09-08, Wyatt's own session) names the four founder
decisions a live, app-facing generation service needs before it can exist (a tailnet
host, a spend cap, a review-gate exception for the streaming path, a CSP change) — none
of those are made yet.

**So this document is a contract, not a changelog of shipped UI.** What WS-D2 shipped:
the CLI now writes a machine-readable "generation in progress" file, act by act, and a
pure read function that enforces who may see it. What this document specifies: the
payload shape that file has, and what a player would do with it once a real service (or,
short of that, a direct file read on a machine that already has the candidate directory —
Path A in the Desktop plan) can serve it to a listener.

## 1. The payload — `PartialCandidate`

Defined in `backend/src/generation/partialCandidate.ts`. One JSON object, rewritten in
place every time an act finishes:

```ts
interface PartialCandidate {
  id: string;                 // the eventual data/forays.json id
  title: string;
  topic: string;               // a data/taxonomy.json node
  summary: string;
  status: "partial" | "complete";        // top-level: "complete" once every act is "ready"
  visibility: "private";                 // ALWAYS — never the shared catalogue (see §3)
  authorId: string;                      // the requesting listener; the auth check (§3)
  acts: Array<{ index: number; title: string; status: "ready" | "pending" }>;
  slots: Array<{ id: string; title: string }>;   // cumulative — only acts finished so far
  items: ForayItem[];                            // cumulative, disclosure item ALREADY first
  runtimeSec: number;                             // cumulative, listener's clock
  ttlA1Ms: number | null;      // prompt received -> Act 1 ready; set once, never changes after
  builtAt: string;              // ISO — when the generation run started
  updatedAt: string;            // ISO — when THIS write happened (use to detect staleness)
  validation: {                 // check-forays.mjs/check-narration.mjs run on the items-so-far
    ok: boolean;
    checkForaysErrors: string[];
    checkForaysWarnings: string[];
    checkNarrationErrors: string[];
    checkNarrationWarnings: string[];
  };
}
```

Worked example — a "medium" Foray (4 acts), the file's content right after Act 2 lands:

```json
{
  "id": "the-history-of-grilling-and-barbecue-...",
  "title": "The history of grilling and barbecue",
  "topic": "food/grilling-bbq",
  "summary": "the history of grilling and barbecue",
  "status": "partial",
  "visibility": "private",
  "authorId": "founder-1",
  "acts": [
    { "index": 0, "title": "Act 1: The origin", "status": "ready" },
    { "index": 1, "title": "Act 2: How it actually works", "status": "ready" },
    { "index": 2, "title": "Act 3: The part nobody expects", "status": "pending" },
    { "index": 3, "title": "Act 4: The controversy", "status": "pending" }
  ],
  "items": [ /* disclosure, then every act-1 and act-2 item, in play order */ ],
  "runtimeSec": 940.2,
  "ttlA1Ms": 4963,
  "builtAt": "2026-09-08T22:57:04.000Z",
  "updatedAt": "2026-09-08T22:57:11.000Z",
  "validation": { "ok": true, "checkForaysErrors": [], "checkForaysWarnings": [], "checkNarrationErrors": [], "checkNarrationWarnings": [] }
}
```

Notes that matter for the player:

- **`items` is always a valid PREFIX of the eventual whole-Foray `items` array**, in the
  same order, same shape as `data/forays.json` (`type: "segment" | "narration" | "jingle"`
  — see `backend/src/generation/forayItems.ts`). The disclosure item is always `items[0]`.
  Nothing is ever reordered or rewritten once written — only appended.
- **`acts[].status` never regresses.** Once an act is `"ready"` it stays `"ready"` on
  every later rewrite of the file. Only later acts flip from `"pending"` to `"ready"`.
- **`ttlA1Ms` is set once** (the first time `acts[0]` goes `"ready"`) and carried
  unchanged on every subsequent rewrite — it is not "time since last update."
- **`validation` is real, scoped-down `check-forays.mjs`/`check-narration.mjs` output**
  run against only the items written so far (see caveat in §4) — not a preview of the
  final whole-Foray verdict.

## 2. Where the file lives today, and where a real endpoint would read it from

Today (CLI-only, Path A): `generateForays.ts` writes it to
`<out>/<slug>-<hash>.partial.json`, next to the eventual final candidate
(`<slug>-<hash>.json`), inside whatever `--out` directory the run used (default
`data-local/foray-candidates/`). It is **deleted** once the whole Foray finishes and the
real candidate file is written successfully — its only job is covering the gap before
that.

`backend/src/generation/generationStatus.ts` exports `readPartialCandidate(candidateDir,
forayId, requestingUserId)` — the READ logic a future `GET /generation/:id/status` route
calls. It scans `<candidateDir>/*.partial.json` for the one whose `id` matches (not by
filename — a listener/player only ever knows the Foray id, never the CLI's internal
slug+hash), and returns one of:

```ts
type GenerationStatusOutcome =
  | { found: false }
  | { found: true; authorized: false }
  | { found: true; authorized: true; candidate: PartialCandidate };
```

**The `authorized` check is the ENTIRE privacy enforcement for `visibility: "private"`.**
It compares `candidate.authorId` to the caller's own id. A real HTTP handler's job is
just: authenticate the caller, call `readPartialCandidate(dir, forayId, callerId)`, map
`found:false` → 404, `authorized:false` → 403 (or 404 — do not distinguish the two in the
response; a 403 confirms the id exists, which is itself a small leak), `authorized:true`
→ 200 with `candidate`. Nothing about `PartialCandidate`'s shape needs to change for
that; this is a routing exercise once Path B's four founder decisions land.

## 3. The append contract — what the player does with it

This is the piece WS-D2 left for Hermes to build (no `app.js`/`player/*.js` changes
shipped with this brief). The target behavior, per `generation-architecture.md` §1.4/§6:

1. **Playback starts the moment `acts[0].status === "ready"`.** Do not wait for
   `status: "complete"`. Build the queue from `items` as it stands at that point (see
   `player/foray-queue.js`'s `buildForayQueue` — it already turns a Foray's `items` array
   into a player queue; a partial candidate's `items` prefix is a valid input to it
   as-is, since it is always disclosure-first and well-formed for every item written so
   far).
2. **Poll (or subscribe, once a real service exists) on some interval** — a few seconds
   is plenty; `updatedAt` tells you whether the response actually changed before you do
   any work. Compare `updatedAt` (or just `items.length`) to the last response you
   applied; skip the append step entirely if nothing changed.
3. **When `items.length` grows, append ONLY the new tail to the live queue — never
   rebuild it, never touch `currentIndex` or anything already loaded/playing.** The new
   items are `response.items.slice(previousItems.length)`. This is the "without
   interrupting playback" requirement: appending to the end of an array the player is
   walking forward through does not affect what is currently loaded or what plays next
   until the listener actually reaches that point.
   - **Id collisions.** `buildForayQueue` derives each queue item's id from its position
     in the Foray's OWN `items` array (`${forayId}#${index}`, `player/foray-queue.js`).
     If you re-run `buildForayQueue` on just the new tail in isolation, its internal
     index will restart at 0 and collide with ids already in the live queue. Either (a)
     re-run `buildForayQueue` on the FULL updated `items` array each time and diff by
     `items.length` (simplest, and correct — this is a `<110`-item array even for a long
     Foray, so re-deriving the whole queue each poll is cheap), or (b) if you want a true
     incremental append without rebuilding, `buildForayQueue` will need a `startIndex`
     option so id numbering continues correctly — that is a real, small change to
     `player/foray-queue.js`, not yet made; flag it back to this workstream (or just make
     it — it is a two-line, backward-compatible addition, default `startIndex: 0`) before
     wiring option (b).
4. **Stop polling once `status === "complete"`.** At that point every act is `"ready"`
   and the queue is exactly the whole Foray's `items` array. The player is now
   listening to unpublished, private, generated content — remind the listener (a badge,
   a line of copy) that this Foray has not gone through the founder-reviewed publish
   step (§1.3) and is not yet in the shared catalogue. Nothing about playback changes
   when the founder-reviewed PR eventually lands and it becomes a catalogue Foray — see
   §5.
5. **`validation.ok === false` at any point is informational, not fatal to playback** —
   see the caveat in §4. Surface it in a debug/dev view if useful; do not block playback
   on it, since the SAME content may validate cleanly once every act is in (a false
   negative here is expected, not a bug to chase).

## 4. Known caveat: scoped validation can false-negative

`buildPartialCandidate` runs the SAME `check-forays.mjs`/`check-narration.mjs` gates the
whole-Foray publish path uses, but against only the items written so far — literally
what the fix plan asks for ("validated with the same check-forays gates, but for Act 1's
items only"). Some of those gates are sized for a whole Foray's worth of content (D5's
inter-quartile floor over segment durations, for one) and may read a short one- or
two-act slice as failing when the same content clears once every act is in. Treat
`validation` on a `"partial"`-status candidate as advisory; only a `"complete"`-status
candidate's `validation.ok` (or, better, the actual whole-Foray `publishForay.ts` run) is
a real verdict.

## 5. Acceptance test (what "done" looks like on the player side)

No API key, no real HTTP service needed — everything above is exercisable against a
`PartialCandidate` fixture (see `backend/test/generateForays.test.ts` for the backend-side
version of this same idea, driving the real pipeline with stub builders). A player-side
acceptance test should:

1. Start with a `PartialCandidate` fixture where `acts[0].status === "ready"`,
   `acts[1..].status === "pending"`, `status: "partial"`. Build a queue from `items` and
   start playback (or a fake/mock player backend — this repo already has fakes for this,
   see `player/*.test.js`'s existing backend stubs).
2. Advance to a SECOND fixture representing the same Foray after Act 2 finishes
   (`acts[1].status` now `"ready"`, `items` longer by that act's own items, same `id`,
   `updatedAt` advanced). Apply it. Assert:
   - the queue's length grew by exactly the new items' count;
   - every item that was already in the queue is byte-identical, same array position
     (nothing got rebuilt/reordered);
   - if something is currently playing, it is UNCHANGED (same id, same play position) —
     the append must not touch playback state;
   - the new items are reachable (the player can advance into them) once the listener
     gets there.
3. Advance to a THIRD, `status: "complete"` fixture. Assert the queue now equals
   `buildForayQueue(fullForay).items` exactly (same content as if the whole Foray had
   been loaded from `data/forays.json` in one shot) — a streamed-in Foray and a
   loaded-whole one must converge to the identical queue.
4. A fixture whose `authorId` does not match the "current listener" must never reach the
   player at all — that check belongs on whatever calls `readPartialCandidate`
   (`generationStatus.ts`), not in player code, but the acceptance suite should still
   assert the player never crashes/misbehaves if handed a 403/404 instead of a candidate
   (i.e., "no partial to append yet" is a normal, silent state, not an error state).

## Open questions this brief surfaces but does not answer

- **Where does the player actually GET a `PartialCandidate` from?** Nothing serves one
  over HTTP yet (§0/§2). Until Path B's four founder decisions land, there is no live
  target to poll. Building the append logic against the fixture contract above (§5) now
  is still worthwhile — it is real, testable work independent of that gate — but wiring
  it to an actual fetch/poll loop in `app.js` is blocked on that infrastructure decision,
  not on anything in this brief.
- **`buildForayQueue`'s `startIndex` option** (§3, item 3b) — a small, real change to
  `player/foray-queue.js` if Hermes wants true incremental append instead of "rebuild
  from the full array and diff." Flagged, not built, by this workstream.
- **The mobile shell.** Everything above is written against the web player
  (`player/*.js`, `app.js`). Whether/how a poll-and-append loop behaves under the iOS/
  Android shell (background/lock-screen playback continuing while polling happens, or
  not) is untouched by this brief and needs its own look before this ships there.
