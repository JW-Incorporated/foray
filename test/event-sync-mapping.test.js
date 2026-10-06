/* The event-sync mapping, pinned row by row (PKG-17, catalogue-personalization
 * plan; ADR-0005's client half).
 *
 * WHAT THIS SUITE IS FOR
 * `app.js:toEventRow()` is the one place a buffered event-log row becomes a row
 * in the Supabase `events` table, and `syncEventsOnce()` is the one place those
 * rows leave the device. The backend's learning job reads exactly what these two
 * write, so a renamed payload key here is not a crash anywhere — it is a signal
 * the learning job silently stops seeing. These tests pin the EXACT wire shape of
 * every transmitted type (the `JSON.stringify` the POST body goes through, so an
 * `undefined` field is absent here exactly as it is on the wire), with the
 * expected literals mirrored by hand from `backend/src/types/events.ts` and
 * `docs/curation/events-client-integration-spec.md` §2/§3 — never imported, so
 * the client and the contract cannot drift together unnoticed.
 *
 * WHAT IS ALREADY PINNED ELSEWHERE, AND IS DELIBERATELY NOT REPEATED HERE
 *   - Every type in policy §2's "Not sent" list maps to null, and the set of
 *     types that produce a row is exactly policy §2's "Sent" table:
 *     test/legal-citations.test.js — "the event types that leave the device are
 *     exactly the ones policy §2 lists" and "policy §2's \"Not sent\" list is
 *     exactly the local-only set" (it CALLS toEventRow once per logged type with
 *     a payload fat enough to satisfy every guard).
 *   - `diagnostics` is never mapped: test/diagnostics-surface.test.js.
 *   - A changed or withdrawn thumb carries `replaces`, and a `cleared` row
 *     without one is not sent: test/app-surface-round3.test.js "app-2-6 (sweep)".
 *   - 500-row chunks, each chunk's ids (the local-only rows between its rows
 *     included) marked the moment its POST lands, a refused chunk and the rest
 *     left for the next run, which re-sends only those: test/data-deletion.test.js
 *     "app-1-10: a backlog over 500 rows whose second chunk fails re-sends only
 *     what was not accepted" (its mutation — mark every id once after the loop —
 *     is the one PKG-17's card names for the chunking test).
 *   - Single-flight sync: test/data-deletion.test.js "app-1-2: …".
 *
 * HARNESS. No app boot: `SB_ARCHETYPES`, `toEventRow` and `syncEventsOnce` are
 * lifted out of app.js and EVALUATED in a vm context (the technique
 * test/legal-citations.test.js documents at `toEventRowFn()` — run, not
 * parsed). `syncEventsOnce`'s free names (session, fetch, epoch guards) are
 * supplied by the test; the queue is the REAL `player/event-log.js`, memory
 * backed, with a spy on `markSynced`.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { readAppSource } = require("./helpers/app-source.js");

const ROOT = path.join(__dirname, "..");
const SRC = readAppSource().replace(/\r\n/g, "\n");

const TS = "2026-10-04T12:00:00.000Z";
const UID = "uid-1";

/* Mirrored by hand from backend/src/types/events.ts `ArchetypeSlotSchema`. */
const CONTRACT_ARCHETYPES = ["deep-learn", "stretch", "narrative", "comfort", "continue"];

function lift(re, what) {
  const m = re.exec(SRC);
  assert.ok(m, `${what} could not be located in app.js`);
  return m[0];
}

const ARCHETYPES_SRC = lift(/const SB_ARCHETYPES = new Set\(\[[^\]]*\]\);/, "SB_ARCHETYPES");
const TO_ROW_SRC = lift(/function toEventRow\([\s\S]*?\n\}/, "toEventRow");
const SYNC_SRC = lift(/async function syncEventsOnce\([\s\S]*?\n\}/, "syncEventsOnce");
for (const [name, body] of [["toEventRow", TO_ROW_SRC], ["syncEventsOnce", SYNC_SRC]]) {
  /* Under-capture would not parse; over-capture would pull in a second
     declaration. Either way, fail loudly rather than test a fragment. */
  assert.ok(!/\n(?:async )?function /.test(body), `the ${name} extraction ran into another function`);
}

const toEventRow = vm.runInNewContext(`${ARCHETYPES_SRC}\n${TO_ROW_SRC}\ntoEventRow`);

/** The row as it goes over the wire (and as a plain object of this realm). */
const wire = (e) => {
  const row = toEventRow({ ts: TS, builder: "unknown", profile: "p-1", ...e }, UID);
  return row === null ? null : JSON.parse(JSON.stringify(row));
};

test("picked: exact row; a contract archetype rides the row's archetype column, any other context is null", () => {
  /* MUTATION (ran, red): `SB_ARCHETYPES.has(p.context) ? p.context : null` ->
     `p.context || null` -- an Up Next pick sends archetype "upnext", which
     events.ts's ArchetypeSlotSchema rejects.
     Note on the contract: PickedPayloadSchema wants `archetype` INSIDE the
     payload; the client sends it in the row column instead and
     backend/src/curation/eventStore.ts folds the column into the payload on
     read (and accepts a slotless pick via SlotlessPickedRowSchema). So the
     payload below carries no `archetype`, by design. */
  for (const context of CONTRACT_ARCHETYPES) {
    assert.deepStrictEqual(
      wire({ type: "picked", payload: { episode_id: "lex-353-whyte", topics: ["engineering/energy-fusion"], app: "Apple Podcasts", context } }),
      {
        user_id: UID, ts: TS, type: "picked", archetype: context,
        payload: { episode_slug: "lex-353-whyte", topics: ["engineering/energy-fusion"], app: "Apple Podcasts" },
      },
      `context ${context}`
    );
  }
  /* "upnext" is UP_NEXT_CTX, "jbi-episode" is Jump back in; "top" is not in
     ArchetypeSlotSchema today (PKG-18 adds it to the contract and the client
     together, and moves it out of this list). */
  for (const context of ["upnext", "jbi-episode", "top", undefined]) {
    const row = wire({ type: "picked", payload: { episode_id: "ep-9", app: "Overcast", context } });
    assert.strictEqual(row.archetype, null, `context ${context} must not reach the archetype column`);
    assert.deepStrictEqual(row.payload, { episode_slug: "ep-9", topics: [], app: "Overcast" }, `context ${context}`);
  }
});

test("saved: exact row — {episode_slug, topics}, no archetype, nothing else", () => {
  /* MUTATION (ran, red): `episode_slug: p.episode_id` -> `episode_id: p.episode_id`
     in the `saved` arm -- the payload names the uuid FK column events.ts's
     contract decision (1) says stays null, and the learning job finds no slug. */
  assert.deepStrictEqual(
    wire({ type: "saved", payload: { episode_id: "ep-1", topics: ["food", "food/baking"] } }),
    { user_id: UID, ts: TS, type: "saved", archetype: null, payload: { episode_slug: "ep-1", topics: ["food", "food/baking"] } }
  );
  assert.deepStrictEqual(
    wire({ type: "saved", payload: { episode_id: "ep-2" } }).payload,
    { episode_slug: "ep-2", topics: [] },
    "a save with no topics sends an empty list, not a missing key"
  );
});

test("thumbs: exact row with a node; no node -> not sent; a missing episode is an ABSENT episode_slug, never null", () => {
  /* setFeedback logs `node_id: entry.topic || null` and
     `episode_slug: entry.item_id || null`, so the nulls below are the shapes it
     really writes.
     MUTATION (ran, red): replace the `...(p.episode_slug ? {...} : {})` spread
     with `episode_slug: p.episode_slug,` -- the row carries `episode_slug: null`,
     which ThumbsPayloadSchema's `z.string().optional()` rejects.
     MUTATION (ran, red): drop `!p.node_id ||` from the guard -- a thumb with no
     node is sent as a row the learning job cannot key. */
  assert.deepStrictEqual(
    wire({ type: "thumbs", payload: { direction: "down", node_id: "science", episode_slug: "ep-3", reasons: ["Not my subject"], note: "too basic", segment_id: "seg-2", foray_id: "g-1", replaces: null } }),
    {
      user_id: UID, ts: TS, type: "thumbs", archetype: null,
      payload: { direction: "down", node_id: "science", episode_slug: "ep-3", reasons: ["Not my subject"], note: "too basic", segment_id: "seg-2", foray_id: "g-1" },
    }
  );
  const noEpisode = wire({ type: "thumbs", payload: { direction: "up", node_id: "history", episode_slug: null, segment_id: null, foray_id: null, reasons: [], note: null, replaces: null } });
  assert.deepStrictEqual(noEpisode, {
    user_id: UID, ts: TS, type: "thumbs", archetype: null,
    payload: { direction: "up", node_id: "history", reasons: [], note: null, segment_id: null, foray_id: null },
  });
  assert.ok(!Object.prototype.hasOwnProperty.call(noEpisode.payload, "episode_slug"), "episode_slug must be absent, not null");
  assert.strictEqual(wire({ type: "thumbs", payload: { direction: "up", node_id: null, episode_slug: "ep-3" } }), null, "no node -> no row");
  assert.strictEqual(wire({ type: "thumbs", payload: { direction: "sideways", node_id: "history" } }), null, "an unknown direction -> no row");
});

test("session_shown is sent as session_built {session_key, builder}, builder read from the logged row", () => {
  /* logEvent stamps `builder` on the ROW (beside `ts`), not in the payload; the
     payload is only `{session_id}`.
     MUTATION (ran, red): `builder: e.builder || "unknown"` ->
     `builder: p.builder || "unknown"` -- every session_built row says "unknown". */
  assert.deepStrictEqual(
    wire({ type: "session_shown", builder: "llm-v2", payload: { session_id: "2026-07-08-morning" } }),
    { user_id: UID, ts: TS, type: "session_built", archetype: null, payload: { session_key: "2026-07-08-morning", builder: "llm-v2" } }
  );
  assert.deepStrictEqual(
    wire({ type: "session_shown", builder: undefined, payload: { session_id: "s-2" } }).payload,
    { session_key: "s-2", builder: "unknown" },
    "a row with no builder says so rather than sending an empty one"
  );
});

/** syncEventsOnce over the real (memory-backed) queue, with a recorded fetch. */
async function syncHarness(rows) {
  const { createEventLog } = await import("../player/event-log.js");
  const queue = createEventLog({ indexedDB: null, scheduleFlush: () => {} });
  for (const r of rows) queue.append({ ts: TS, builder: "unknown", profile: "p-1", ...r });
  await queue.unsynced();                                   // flushed, like yesterday's rows
  const marks = [];
  const realMark = queue.markSynced.bind(queue);
  queue.markSynced = async (ids) => { marks.push([...ids]); return realMark(ids); };
  const posts = [];
  const ctx = {
    window: { forayEventLog: queue },
    localClears: 0,
    dataDeletionInProgress: false,
    SB_URL: "https://sb.test",
    SB_KEY: "anon",
    flushBufferedEvents() {},
    syncOutlived: () => false,
    ensureAnonSession: async () => ({ user_id: UID, access_token: "at-1" }),
    fetch: async (url, opts) => { posts.push({ url, body: opts.body }); return { ok: true, status: 201 }; },
  };
  const syncEventsOnce = vm.runInNewContext(`${ARCHETYPES_SRC}\n${TO_ROW_SRC}\n${SYNC_SRC}\nsyncEventsOnce`, ctx);
  return { queue, marks, posts, run: () => syncEventsOnce(0) };
}

test("a batch of only local-only rows marks them synced without a POST", async () => {
  /* Nothing in it maps to a row, so there is nothing to send — but the rows must
     still leave the unsynced set, or every sync re-reads them forever.
     MUTATION (ran, red): `if (chunk.rows.length) {` -> `{` -- an empty array is
     POSTed to /rest/v1/events.
     MUTATION (ran, red): delete the `chunks.push(cur);` after the loop -- the
     rows are never marked and stay unsynced. */
  const { queue, marks, posts, run } = await syncHarness([
    { type: "position", payload: { episode_id: "ep-1", seconds: 12, duration: 100 } },
    { type: "unsaved", payload: { episode_id: "ep-1" } },
    { type: "family_mode", payload: { on: true } },
    { type: "refreshed_all", payload: {} },
  ]);
  const ids = (await queue.unsynced()).map((r) => r.id);
  assert.strictEqual(ids.length, 4, "premise: four rows queued");
  await run();
  assert.deepStrictEqual(posts, [], "nothing to send, so nothing is POSTed");
  assert.deepStrictEqual(marks, [ids], "all four are marked, in one call");
  assert.deepStrictEqual(await queue.unsynced(), [], "and none is left for the next sync");
});
