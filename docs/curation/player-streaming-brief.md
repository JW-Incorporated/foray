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

## 1. The payload — `JobSnapshot` (GV-44)

Updated for GV-44 (`docs/roadmap/generation-v2.md`, #1286; decision 32). The player no
longer reads the `PartialCandidate`: that file is the CLI's own per-act record (validation,
slots, the whole item list so far) and stays on disk for the founder. What a phone reads is
the **job snapshot**, defined in `backend/src/generation/jobSink.ts` and pinned by its zod
`JobSnapshotSchema` (strict: an unknown key fails, and there is no `prompt` field). One JSON
object, rewritten on every act-ready and every item-ready event:

```ts
interface JobSnapshot {
  schema: "foray-job/1";
  jobId: string;                // random per run, never derived from the prompt
  forayId: string;              // the eventual data/forays.json id; /^[a-z0-9-]{1,120}$/
  authorId: string;             // the requesting listener; the auth check (§2)
  lane: "on-demand" | "catalogue";
  status: "running" | "complete" | "failed";
  seq: number;                  // strictly increasing per job file
  updatedAt: string;            // ISO, when THIS snapshot was written
  title: string | null;         // the understander's copy; null until act 1 is stitched
  topic: string | null;         // a data/taxonomy.json node
  summary: string | null;
  acts: Array<{ index: number; title: string; status: "ready" | "pending"; servable: boolean }>;
  items: ForayItem[];           // ONLY the servable prefix, disclosure first (see below)
  itemStates: Array<{           // 1:1 with items
    itemId: string;
    check: "verified" | "unverified" | "unchecked-seam" | "tape" | "jingle" | "prelude";
    audio: "pending" | "rendered" | "phone-voice";
    audioKey?: string;
  }>;
  runtimeSecSoFar: number;      // seconds of Foray made so far, servable or not
  delivery?: {
    servableThrough: number;    // always items.length: an ITEM COUNT, prelude included
    itemsGenerated: number;     // items made so far, servable or not (a count, no ids)
    servableThroughAct: number; // last act inside the prefix, or -1
    pausedAtIndex: number | null; // the made-but-unservable item the prefix stops at
  };
  closed?: { outcome: "complete" | "failed" | "aborted"; detail?: string }; // detail is a short code
}
```

Worked example — a "medium" Foray (4 acts) right after Act 2 is stitched, with Act 2 holding
a page the verifier did not pass:

```json
{
  "schema": "foray-job/1",
  "jobId": "6f1c0a52-3d7e-4f0b-9c64-0b8f6f1e2a10",
  "forayId": "fire-smoke-and-the-long-cook-1a2b3c",
  "authorId": "founder-1",
  "lane": "catalogue",
  "status": "running",
  "seq": 23,
  "updatedAt": "2026-10-12T10:00:11.000Z",
  "title": "Fire, smoke and the long cook",
  "topic": "food/grilling-bbq",
  "summary": "How people learned to cook with smoke.",
  "acts": [
    { "index": 0, "title": "Act 1: The origin", "status": "ready", "servable": true },
    { "index": 1, "title": "Act 2: How it actually works", "status": "ready", "servable": false },
    { "index": 2, "title": "Act 3: The part nobody expects", "status": "pending", "servable": false },
    { "index": 3, "title": "Act 4: The controversy", "status": "pending", "servable": false }
  ],
  "items": [ /* the disclosure, then act 1's items, in play order — nothing of act 2 */ ],
  "itemStates": [ /* one per item: { "itemId": "prelude", "check": "prelude", "audio": "pending" }, ... */ ],
  "runtimeSecSoFar": 940.2,
  "delivery": { "servableThrough": 12, "itemsGenerated": 21, "servableThroughAct": 0, "pausedAtIndex": 12 }
}
```

Notes that matter for the player:

- **The player plays `items` and nothing else.** `items` is exactly the leading servable
  prefix of the eventual whole-Foray `items` array (`delivery.servableThrough` items,
  disclosure first, same shape as `data/forays.json`). An act that is not servable (GV-21:
  an unverified page, the hand-off line, an ungrounded quote, a misaligned item list) stops
  the prefix there, and nothing from or after it is in the snapshot, not even as an id —
  even when later acts are ready.
- **`items` only grows.** A later snapshot's `items` starts with every item of an earlier
  one, in the same order; only the tail is new. The prefix can stand still for a long time
  (a paused act) and then jump.
- **`items` can run ahead of `acts`.** Item events arrive before the act they belong to is
  recorded, so `items` may hold the opening items of an act that `acts[]` still shows as
  `"pending"`. `acts` is for display; `items` is what plays.
- **`seq` is the change signal.** Skip any snapshot whose `seq` is not above the last one
  you applied. A resumed run of the same Foray continues the same job (same `jobId`, `seq`
  above the file's), and the sink never writes a row that serves fewer or other items than
  the row already there, so "`items` only grows" holds across the restart too; a resumed
  run that publishes nothing still closes the row it continues.
- **No prompt, ever.** The schema has no prompt field and is strict; `title`, `topic` and
  `summary` are the understander's copy (§9.4 keeps the title). `closed.detail` is a short
  code (`refused-partial`, `budget-stop`, `error`, `invalid`, ...), never an error message.
- **`audio` is `"pending"` for every item today.** The render cards (W6-07, GV-74) stamp
  `rendered` with an `audioKey`, or `phone-voice` when the phone speaks the script itself.

## 2. Where the file lives today, and where a real endpoint would read it from

Today (CLI-only, Path A): `npm run generate-forays -- ... --job-dir <dir>` publishes the
job to `<dir>/<forayId>.job.json` (`backend/src/cli/fileJobSink.ts`). Without `--job-dir`
nothing is published (the flag is off by default), and `--dry-run` writes nothing. Every
write is atomic (a temporary file in the same directory, then a rename), so a reader never
sees half a snapshot, and every snapshot is checked against `JobSnapshotSchema` before it
is written. Unlike the partial candidate, the job file is **kept** when the run ends: its
last write carries `closed` and a final `status`. A Supabase row (W6-18, GV-59) replaces
the file later behind the same `GenerationJobSink` interface, with the same payload.

`backend/src/generation/generationStatus.ts` exports `readJobSnapshot(jobDir, forayId,
requestingUserId)` — the READ logic a future `GET /generation/:id` route calls. It reads
exactly one file, `<jobDir>/<forayId>.job.json`, named by the id itself; it never lists the
directory. It returns one of:

```ts
type JobSnapshotOutcome =
  | { found: false; refused?: "invalid-id" }
  | { found: true; authorized: false }
  | { found: true; authorized: true; snapshot: JobSnapshot };
```

- An id that fails `/^[a-z0-9-]{1,120}$/` (`../x`, a slash, a dot) is refused before any
  path is built.
- A missing file, unparseable JSON, a document that fails `JobSnapshotSchema`, or one that
  names another Foray id reads as not found: an unvalidated document is never served.
- **The `authorized` check is the privacy enforcement.** It compares the snapshot's
  `authorId` to the caller's own id. A real handler authenticates the caller, calls
  `readJobSnapshot(dir, forayId, callerId)`, and answers `found:false` (refused or not)
  and `authorized:false` the same way, 404 (a 403 confirms the id exists, which is itself a
  small leak); `authorized:true` → 200 with `snapshot`.

The older `readPartialCandidate(candidateDir, forayId, requestingUserId)` is kept for its
existing callers, unchanged. Its header used to claim it never lists the directory; it
does — it parses every `<candidateDir>/*.partial.json` to find the id, because the partial
file is named by the prompt's slug and hash, which a caller holding only the Foray id
cannot rebuild. New callers use `readJobSnapshot`.

## 3. The append contract — what the player does with it

The target behavior, per `generation-architecture.md` §1.4/§6. GV-57 built the JS-lane
half of it (§3a below); no screen calls it yet.

1. **Playback starts the moment `items` holds more than the disclosure.** Do not wait for
   `status: "complete"`, and do not look at `acts[]` to decide: `items` is already only
   what may play. Build the queue from `items` (see `player/foray-queue.js`'s
   `buildForayQueue` — a snapshot's `items` is a valid input to it as-is, since it is
   always disclosure-first and well-formed).
2. **Poll (or subscribe, once a real service exists) on some interval** — a few seconds is
   plenty. Compare `seq` to the last snapshot you applied and skip the append step entirely
   if it is not higher.
3. **When `items.length` grows, append ONLY the new tail to the live queue — never rebuild
   it, never touch `currentIndex` or anything already loaded/playing.** The new items are
   `snapshot.items.slice(previousItems.length)`. This is the "without interrupting
   playback" requirement: appending to the end of an array the player is walking forward
   through does not affect what is currently loaded or what plays next until the listener
   actually reaches that point.
   - **Id collisions.** `buildForayQueue` derives each queue item's id from its position
     in the Foray's OWN `items` array (`${forayId}#${index}`, `player/foray-queue.js`).
     If you re-run `buildForayQueue` on just the new tail in isolation, its internal
     index will restart at 0 and collide with ids already in the live queue. Either (a)
     re-run `buildForayQueue` on the FULL updated `items` array each time and diff by
     `items.length` (simplest, and correct — this is a `<110`-item array even for a long
     Foray, so re-deriving the whole queue each poll is cheap), or (b) if you want a true
     incremental append without rebuilding, `buildForayQueue` will need a `startIndex`
     option so id numbering continues correctly — a real, small change to
     `player/foray-queue.js`, not yet made (default `startIndex: 0`).
   - **Reaching the end of `items` while `status === "running"`** means the next part is
     not servable yet (still being made, or paused at an unservable act): wait, do not end
     the Foray (W6-04, GV-57; the lock-screen state is GV-70).
4. **Stop polling once `status !== "running"`.** `"complete"` means the run finished and
   the snapshot is final; `"failed"` (with `closed.outcome` `"failed"` or `"aborted"`)
   means nothing more will be appended — play what `items` holds and end there. Either way
   the listener is hearing unpublished, private, generated content — remind them (a badge,
   a line of copy) that this Foray has not gone through the founder-reviewed publish step
   (§1.3) and is not in the shared catalogue.
5. **The servable prefix replaces "validation is advisory".** The old payload asked the
   player to treat `validation.ok === false` as informational and play on. The snapshot
   carries no validation at all: the backend has already cut `items` at the first act that
   may not be served, so there is nothing for the player to judge and no flag to honour.
   An item in `items` may play; anything else is not in the payload.

## 3a. What GV-57 built (JS lane, no screen yet)

GV-57 (`docs/roadmap/generation-v2.md`, #1286) implements §3 in the player modules, dark:
nothing calls it until a screen does, and that wiring waits for the UI revamp.

- **`appendableTail(prevBuiltItems, nextBuilt)`** (`player/foray-queue.js`): option (a)
  of §3.3. The caller rebuilds the whole Foray with `buildForayQueue`; this checks that
  every queued item is still there, same id and same content (keys compared in a fixed
  order), and returns only the new tail. A rebuild that is shorter, or that changed or
  moved any queued item, THROWS before anything is appended. No `startIndex` option was
  added.
- **`PlayerQueueManager`** (`player/queue-manager.js`): `appendForayItems(foray, opts)`
  rebuilds, takes `appendableTail`, pushes the tail and emits
  `foray.stream.appended.n=<k>`. It never touches `currentIndex`, the playing ref or any
  queued item. `setForayStreamOpen(open, { reason })` defaults to closed, and every new
  queue (`setQueueFromForay`, `setQueueFromPick`, `loadQueue`) closes it again. The
  reducer (`queue-state.js`, a recorded parity family) is unchanged: when it lands in
  `ended` with the stream open, `_handle` records the next index, emits
  `foray.stream.waiting at=<n>`, and `forayStreamWaiting` reads true. That is what makes
  `client.js` skip the finished mark. The next append that adds items resumes there by
  itself (`foray.stream.resumed at=<n>`). If the stream closes while the player waits,
  it emits `foray.stream.ended reason=<r>`, stays ended and tells the surface the state
  settled.
- **`createForayStreamFollower({ fetchSnapshot, manager, intervalMs = 3000, schedule,
  queueOptions, telemetry })`** (`player/foray-stream.js`) is the poll loop of §3.2-3.4:
  - It skips any snapshot whose `seq` is not above the last one applied.
  - The first snapshot with items calls `setQueueFromForay`, then `play(0)`, then
    `setForayStreamOpen(true)`. Later snapshots call `appendForayItems`.
  - `complete` or `failed` closes the stream and stops polling.
  - A 403, a 404 or an empty answer is a silent "nothing yet".
  - A snapshot for another Foray, or one whose prefix changed, stops the follower and
    leaves the queue as it was.
- **`ForayPlayer.followForayStream(fetchSnapshot, { follow })`** (`player/client.js`) is
  JS-lane only. The native engine has no append command (`engine-contract.js`
  `COMMANDS`), so in the native lane it refuses with a `foray.stream.refused lane=native`
  telemetry line and returns null. The caller passes `follow` (foray-stream.js's
  `followForayStream`). It is not imported, because an import would add a module to
  client.js's boot closure and so a modulepreload line to `index.html`
  (`test/boot-path.test.js` perf-1), and the UI freeze does not allow that edit. The card
  that wires a screen makes it a static import and adds the line. That card also owns the
  page's Foray state for a stream (the bar, the running order, the resume row, the lock
  screen's "Building the next part", GV-70).
- Tests: `player/foray-stream.test.js` (a real manager on `player/parity/fakes.js`, three
  snapshot fixtures, §5 end to end) and the `appendableTail` block of
  `player/foray-queue.test.js`. Neither is a parity-covered suite: appending is a
  JS-lane rule.
- One thing to know: a part that ends on a narration line reaches its end through the
  reducer's bridge path. On origin/main, that path speaks a closing line that follows a
  clip twice before it ends, whether or not a stream is open. The wait starts after the
  second reading. This card does not change `queue-state.js`.

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

No API key, no real HTTP service needed — everything above is exercisable against
`JobSnapshot` fixtures (see `backend/test/jobSink.test.ts` and the GV-44 block of
`backend/test/generateForays.test.ts` for the backend-side version, the latter driving the
real pipeline with stub builders and reading the job file after every event). A player-side
acceptance test should:

1. Start with a snapshot fixture, `status: "running"`, whose `items` holds the disclosure
   and act 1's items. Build a queue from `items` and start playback (or a fake/mock player
   backend — `player/*.test.js` already has backend stubs).
2. Apply a SECOND snapshot of the same job with a higher `seq` and a longer `items` (act 2's
   items appended). Assert:
   - the queue's length grew by exactly the new items' count;
   - every item that was already in the queue is byte-identical, same array position
     (nothing got rebuilt/reordered);
   - if something is currently playing, it is UNCHANGED (same id, same play position) —
     the append must not touch playback state;
   - the new items are reachable once the listener gets there.
3. Apply a snapshot whose `seq` is NOT higher than the last one applied (a stale or replayed
   response). Assert nothing changes.
4. Reach the end of `items` while `status === "running"` (a paused prefix: `acts[1]`
   ready but not servable, `delivery.pausedAtIndex === items.length`). Assert the player
   waits rather than ending the Foray, and never plays anything not in `items`.
5. Apply a final `status: "complete"` snapshot. Assert the queue now equals
   `buildForayQueue({ ...foray, items: snapshot.items }).items` exactly — a streamed-in
   Foray and one loaded from the same `items` in one shot must converge to the identical
   queue — and that polling stops. A `status: "failed"` snapshot also stops polling and
   ends playback after the last item.
6. A response for another listener's job never reaches the player — that check belongs on
   whatever calls `readJobSnapshot` (`generationStatus.ts`), not in player code — but the
   suite should still assert the player neither crashes nor misbehaves when handed a 404
   instead of a snapshot ("no snapshot yet" is a normal, silent state, not an error state).

## Open questions this brief surfaces but does not answer

- **Where does the player actually GET a `PartialCandidate` from?** Nothing serves one
  over HTTP yet (§0/§2). Until Path B's four founder decisions land, there is no live
  target to poll. Building the append logic against the fixture contract above (§5) now
  is still worthwhile — it is real, testable work independent of that gate — but wiring
  it to an actual fetch/poll loop in `app.js` is blocked on that infrastructure decision,
  not on anything in this brief.
- **`buildForayQueue`'s `startIndex` option** (§3, item 3b) — not built: GV-57 chose
  option (a), rebuild and check the prefix (§3a).
- **The mobile shell.** Everything above is written against the web player
  (`player/*.js`, `app.js`). Whether/how a poll-and-append loop behaves under the iOS/
  Android shell (background/lock-screen playback continuing while polling happens, or
  not) is untouched by this brief and needs its own look before this ships there.
