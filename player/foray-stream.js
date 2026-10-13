/* Following a Foray while it is generated (GV-57, docs/roadmap/generation-v2.md).

   docs/curation/player-streaming-brief.md is the contract: the generator
   publishes a job snapshot (`foray-job/1`, backend/src/generation/jobSink.ts)
   on every act-ready and item-ready event, and a snapshot's `items` is ONLY
   the leading servable prefix of the eventual Foray, disclosure first. This
   module polls for snapshots and drives a `PlayerQueueManager`:

     - the first snapshot with items builds the queue (`setQueueFromForay`),
       starts it (`play(0)`) and opens the stream (`setForayStreamOpen(true)`);
     - every later snapshot with a higher `seq` appends what it adds
       (`appendForayItems`), which never touches what is loaded or playing,
       and resumes a player that ran out of items and was waiting;
     - `status` complete or failed closes the stream and stops polling;
     - a 403 or 404 is "nothing yet", silently: the brief's §2 answers a job
       the caller may not see exactly as one that does not exist, and a job
       that has not written its first snapshot is the normal first state.

   JS LANE ONLY. The Swift engine has no append command (engine-contract.js
   COMMANDS), so `followForayStream` refuses in the native lane with a
   telemetry line, and `client.js`'s facade hands it the lane.

   Nothing here touches a real clock or the network: the fetch and the
   scheduler are injected (`schedule(ms, fn) -> cancel`, the contract
   queue-manager.js's own scheduler uses). No surface calls this yet: the
   screens are frozen for the revamp, and wiring one is a later card. */

/** The snapshot schema this follower reads (jobSink.ts JobSnapshotSchema). */
export const JOB_SNAPSHOT_SCHEMA = "foray-job/1";

/** How often to ask for a new snapshot. The brief's §3.2: "a few seconds is
    plenty" — a generated act takes far longer than this to arrive. */
export const STREAM_POLL_MS = 3000;

/** HTTP statuses that mean "no snapshot yet", silently (brief §2, §5.6). */
const NOTHING_YET = new Set([403, 404]);

/** The real timer, used only when no scheduler is injected. */
const realSchedule = (ms, fn) => {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
};

const isSnapshot = (s) => Boolean(s) && typeof s === "object"
  && s.schema === JOB_SNAPSHOT_SCHEMA
  && Number.isFinite(s.seq)
  && typeof s.forayId === "string" && s.forayId.length > 0
  && Array.isArray(s.items)
  && typeof s.status === "string";

/** An HTTP-ish status carried by a fetch result or a thrown error, or null. */
const httpStatus = (x) => (x && typeof x === "object" && Number.isInteger(x.status) ? x.status : null);

/**
 * @param {object}   opts
 * @param {Function} opts.fetchSnapshot  async () => a JobSnapshot; or null /
 *   undefined, or a value or error carrying `status` 403/404, for "nothing yet"
 * @param {object}   opts.manager        a PlayerQueueManager (JS lane)
 * @param {number}   [opts.intervalMs]   between polls (STREAM_POLL_MS)
 * @param {Function} [opts.schedule]     (ms, fn) => cancel; real timers if omitted
 * @param {object}   [opts.queueOptions] passed to setQueueFromForay and every
 *   appendForayItems (resolveItem, isLocalFile, allowAdPad)
 * @param {Function} [opts.telemetry]    (message) => void
 * @returns {{ start(): void, stop(): void, poll(): Promise<string>,
 *   readonly running: boolean, readonly lastSeq: number|null, readonly started: boolean }}
 */
export function createForayStreamFollower({
  fetchSnapshot, manager, intervalMs = STREAM_POLL_MS, schedule = null, queueOptions = {}, telemetry = null,
} = {}) {
  if (typeof fetchSnapshot !== "function") throw new Error("createForayStreamFollower needs fetchSnapshot");
  if (!manager) throw new Error("createForayStreamFollower needs a manager");
  const sched = typeof schedule === "function" ? schedule : realSchedule;
  const emit = (m) => { if (typeof telemetry === "function") telemetry(m); };

  let running = false;
  let cancelNext = null;
  let lastSeq = null;
  let forayId = null;
  let started = false;
  let inFlight = null;

  const close = (reason) => {
    stop();
    if (started) manager.setForayStreamOpen(false, { reason });
    emit(`foray.stream.closed reason=${reason}`);
  };

  /** Apply one snapshot. Returns what happened, for the poll's own record. */
  async function apply(snap) {
    if (forayId != null && snap.forayId !== forayId) {
      close("other-foray");
      return "other-foray";
    }
    if (lastSeq != null && !(snap.seq > lastSeq)) return "stale";
    lastSeq = snap.seq;
    forayId = snap.forayId;
    const foray = { id: snap.forayId, title: snap.title ?? "", items: snap.items };
    if (!started) {
      if (snap.items.length) {
        manager.setQueueFromForay(foray, queueOptions);
        started = true;
        // play first, then open: the order the card names. The play is not
        // awaited before opening, so an item cannot end before the stream
        // is open however quickly it loads.
        const playing = manager.play(0);
        manager.setForayStreamOpen(true);
        await playing;
      }
    } else {
      await manager.appendForayItems(foray, queueOptions);
    }
    if (snap.status !== "running") {
      close(snap.status);
      return "closed";
    }
    return "applied";
  }

  async function pollOnce() {
    let result;
    try {
      result = await fetchSnapshot();
    } catch (err) {
      if (NOTHING_YET.has(httpStatus(err))) return "nothing-yet";
      emit(`foray.stream.fetchFailed: ${err?.message ?? err}`);
      return "fetch-failed";
    }
    if (result == null) return "nothing-yet";
    if (!isSnapshot(result)) {
      const status = httpStatus(result);
      if (NOTHING_YET.has(status)) return "nothing-yet";
      emit(status != null ? `foray.stream.fetchFailed: status=${status}` : "foray.stream.invalidSnapshot");
      return status != null ? "fetch-failed" : "invalid";
    }
    try {
      return await apply(result);
    } catch (err) {
      /* A prefix mismatch (appendableTail) or a queue the backend cannot play:
         the queue was left as it was, and this stream cannot continue it. */
      emit(`foray.stream.error: ${err?.message ?? err}`);
      close("error");
      return "error";
    }
  }

  function scheduleNext() {
    if (!running) return;
    cancelNext = sched(intervalMs, () => {
      cancelNext = null;
      poll().finally(scheduleNext);
    });
  }

  /** One poll, never two at once: a slow fetch is not overtaken by the next. */
  function poll() {
    if (!inFlight) inFlight = pollOnce().finally(() => { inFlight = null; });
    return inFlight;
  }

  function start() {
    if (running) return;
    running = true;
    poll().finally(scheduleNext);
  }

  function stop() {
    running = false;
    if (cancelNext) { cancelNext(); cancelNext = null; }
  }

  return {
    start, stop, poll,
    get running() { return running; },
    get lastSeq() { return lastSeq; },
    get started() { return started; },
  };
}

/**
 * Follow a streamed Foray in the lane the page is in. The native lane is
 * refused: the engine has no append command, so a streamed Foray handed to it
 * would end at the first part. Returns the started follower, or null.
 *
 * @param {object} opts  `{ lane, manager, telemetry }` plus everything
 *   `createForayStreamFollower` takes
 */
export function followForayStream({ lane, ...opts } = {}) {
  if (lane !== "js") {
    if (typeof opts.telemetry === "function") {
      opts.telemetry(`foray.stream.refused lane=${lane ?? "unknown"} — streaming appends to the JS queue; the native engine has no append command`);
    }
    return null;
  }
  const follower = createForayStreamFollower(opts);
  follower.start();
  return follower;
}
