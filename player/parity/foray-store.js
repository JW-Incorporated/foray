/* The `cp_foray` row's storage behaviour, as data (NE-29j, plan §6: the
   `foray-progress` family's storage half).

   WHY THIS FILE EXISTS. Half of player/foray-progress.js is pure (`makeProgress`,
   `resumePoint`, `reconcileSegment`, the labels) and a case calls it directly.
   The other half is a rule about a Storage: what a write of a malformed row
   does, that a refused write returns false instead of throwing, that the list
   is newest-first and skips other rows, that the throttled writer is on the
   CLOCK and per Foray, that a refused write does not advance the throttle and
   is counted. A Storage is an object with methods — nothing a fixture can hold —
   so this adapter builds one from data, runs the REAL functions against it in
   the order a case names, and writes down every answer. Nothing here decides a
   rule. On iOS the engine writes the same `cp_foray:<id>` rows into the same
   CapacitorStorage the page reads (plan §4.6), so NE-29s's ResumeRules/Rows port
   answers the same ops the same way.

   THE CALL SHAPE (one export, `storageRun`):

     storageRun({ storage, initial, everySec, ops })
       storage   "memory" (default): a Storage like the browser's, with
                 length/key()/getItem/setItem/removeItem, `setItem` throwing
                 while writes are failing (a full quota, private mode);
                 "none": no storage at all (null);
                 "noKey": `{ getItem: () => null, length: 3 }` — a Storage-shaped
                 object without key(), which listProgress must survive
       initial   { key: string } rows present before the first op
       everySec  the ForayProgressStore's throttle (omit for its default)
       ops       [[op, ...args], ...], in order:
         ["failWrites", bool]   the storage starts / stops refusing writes
         ["write", record]      writeProgress(storage, record)
         ["read", forayId]      readProgress(storage, forayId)
         ["clear", forayId]     clearProgress(storage, forayId)       -> null
         ["list", opts?]        listProgress(storage, opts)
         ["save", p]            store.save(p)
         ["markFinished", p]    store.markFinished(p)
         ["get", forayId]       store.get(forayId)
         ["storeClear", forayId] store.clear(forayId)                  -> null
         ["storeList", opts?]   store.list(opts)
         ["counters"]           { refusedWrites, failedWrites } of the store
     -> { results: [one answer per op], rows: { key: value } after the last op }

   TIME. Every row stamps `updated_at` and `listProgress` compares against now,
   so the adapter never reads the clock: a `save`/`markFinished` with no `now`
   is stamped FIXED_NOW, and a list with no `now` is asked at FIXED_NOW. A case
   that is about time names its own instant.

   The page never imports this file. It is harness code, like runner.js. */

import {
  ForayProgressStore, readProgress, writeProgress, clearProgress, listProgress,
} from "../foray-progress.js";
import { HarnessError } from "./codec.js";

/** The instant a case that names none is run at. */
export const FIXED_NOW = "2026-08-16T10:00:00.000Z";

export const STORAGE_OPS = Object.freeze([
  "failWrites", "write", "read", "clear", "list", "save", "markFinished", "get", "storeClear", "storeList", "counters",
]);

function memoryStorage(initial) {
  const map = new Map(Object.entries(initial ?? {}));
  const s = {
    failWrites: false,
    get length() { return map.size; },
    key(i) { return [...map.keys()][i] ?? null; },
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) {
      if (s.failWrites) throw new Error("QuotaExceededError");
      map.set(k, String(v));
    },
    removeItem(k) { map.delete(k); },
    rows() { return Object.fromEntries([...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))); },
  };
  return s;
}

const stamped = (p) => ({ ...(p ?? {}), now: p?.now ?? FIXED_NOW });
const listOpts = (o) => {
  const opts = { ...(o ?? {}) };
  opts.now = typeof opts.now === "string" ? Date.parse(opts.now) : (opts.now ?? Date.parse(FIXED_NOW));
  return opts;
};

export function storageRun({ storage = "memory", initial = {}, everySec, ops = [] } = {}) {
  let s;
  if (storage === "memory") s = memoryStorage(initial);
  else if (storage === "none") s = null;
  else if (storage === "noKey") s = { getItem: () => null, length: 3 };
  else throw new HarnessError("E_BAD_CASE", `storageRun: unknown storage ${JSON.stringify(storage)}`);
  /* `storage: null` would make the store fall back to a global localStorage,
     which Node does not have — but a case about "no storage" must never depend
     on that, so the store gets a Storage that has nothing and keeps nothing. */
  const store = new ForayProgressStore({
    storage: s ?? { getItem: () => null, setItem() { throw new Error("no storage"); }, removeItem() {} },
    ...(everySec !== undefined ? { everySec } : {}),
  });
  const results = [];
  for (const [op, ...args] of ops) {
    switch (op) {
      case "failWrites":
        if (!s || !("failWrites" in s)) throw new HarnessError("E_BAD_CASE", "failWrites needs the memory storage");
        s.failWrites = args[0] === true;
        results.push(null);
        break;
      case "write": results.push(writeProgress(s, args[0])); break;
      case "read": results.push(readProgress(s, args[0])); break;
      case "clear": clearProgress(s, args[0]); results.push(null); break;
      case "list": results.push(listProgress(s, listOpts(args[0]))); break;
      case "save": results.push(store.save(stamped(args[0]))); break;
      case "markFinished": results.push(store.markFinished(stamped(args[0]))); break;
      case "get": results.push(store.get(args[0])); break;
      case "storeClear": store.clear(args[0]); results.push(null); break;
      case "storeList": results.push(store.list(listOpts(args[0]))); break;
      case "counters": results.push({ refusedWrites: store.refusedWrites, failedWrites: store.failedWrites }); break;
      default: throw new HarnessError("E_BAD_CASE", `storageRun: unknown op ${JSON.stringify(op)} (have ${STORAGE_OPS.join(", ")})`);
    }
  }
  return { results, rows: s && typeof s.rows === "function" ? s.rows() : {} };
}
