/* TWO GUARDS — "is this a finite number" and "is this a plain object"
   (code-health CH-41, X1-16).

   Every player module that reads a stored row, a fixture, a bridge answer or a
   caller's option asks one of these two questions first, and each used to ask
   it with its own one-liner: `isNum` in eleven modules, `isFiniteNum` in
   client.js, `isPlain` in foray-structure.js, `isPlainObject` in bookmarks.js,
   and an `isObject` in show-alerts.js that, alone among them, let an ARRAY
   through as a record. The copies agreed until one did not; the next one to
   drift would have done it silently. So the rule is written here once:

     - `isNum(n)`: a `number` that is finite. NaN, ±Infinity, a numeric string,
       a boxed Number, null and undefined are all "no number". A clock, a
       duration, a rate or a width that fails it is treated as ABSENT by every
       caller (each caller decides what absent means: 0, the default, null).
     - `isObj(v)`: a non-null `object` that is NOT an array. A stored record or
       a queue item that is an array is corrupt, not a record with no fields.

   WHO STILL KEEPS A COPY, AND WHY (each one pinned equal to these by
   guards.test.js, which also fails on any new copy):
     - foray-resolve.js, foray-queue.js, foray-sources.js and duration.js keep a
       local `isNum`: they are reached by the release signing jobs
       (tools/ci/path-policy.test.mjs walks tools/mobile/prepare-webdir.mjs's
       imports; ACKNOWLEDGED_RELEASE_APP_CODE), and importing this module from
       them would put it on that walk. The same rule CH-40 applied to
       build-stamp.js's copy of deadline.js.
     - engine-contract.js keeps its `isObj` and `isFiniteNum`: its only import
       is the vocabulary (its own header), so the bridge contract can be read,
       ported and checked on its own.
     - locate-window.js keeps its `isNum`: the native webdir copies it as a
       dependency-free reference (its header), and locate-window.test.js pins
       that it loads nothing.
   (player/parity/'s codec.js and compare.js are the parity harness, not the
   player, and keep their own `isPlainObject`.)

   No imports: a leaf, so anything in the player graph can use it. */

/** A finite number: `typeof n === "number"` and `Number.isFinite(n)`. */
export const isNum = (n) => typeof n === "number" && Number.isFinite(n);

/** A plain object: not null, `typeof "object"`, and not an array. */
export const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
