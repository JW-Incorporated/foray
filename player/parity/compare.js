/* The parity comparator (NE-03, plan §6.2-6.4).

   Compares an `expect` from a fixture with what a runtime produced, both in the
   ENCODED form (`codec.js`), and returns the differences as data rather than
   throwing. Data, because three callers want different things from a mismatch:
   run.test.js fails with it, `record.mjs --check` prints every one of them for a
   whole family, and `--mutate` only needs to know there was at least one. The
   Swift `ForayEngineParity` comparator implements these same rules; the
   `compare` cases in run.test.js are the table it is ported from.

   THE RULES, each one a decision:
   - Exact by default. A parity fixture that tolerates drift is not a parity
     fixture. A case may opt into an absolute `tolerance` for numbers — for a
     measured-clock family — and that is visible in the fixture, not hidden here.
   - Object key ORDER never matters; array order always does. An op log is an
     array precisely because its order is the assertion.
   - Native-only `n.*` op tokens are stripped from any `ops` array before the
     comparison, EXCEPT in the `prepare` family, which exists to assert them
     (plan §6.2: "Native-only n.* tokens are stripped, except in the prepare
     family"). JS never emits them; the Swift engine emits them for its standby
     deck, and every other family must stay blind to that. */

export const NATIVE_TOKEN_PREFIX = "n.";

/** Families whose op logs keep `n.*` tokens. */
export const NATIVE_TOKEN_FAMILIES = Object.freeze(["prepare"]);

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isSpecialNum = (v) => isPlainObject(v) && Object.keys(v).length === 1 && "$num" in v;

function stripNative(ops) {
  return ops.filter((op) => !(typeof op === "string" && op.startsWith(NATIVE_TOKEN_PREFIX)));
}

/**
 * @param {*} expected  encoded expect from the fixture
 * @param {*} actual    encoded result from the runtime
 * @param {object} [opts]
 * @param {string} [opts.family]     the case's family (decides `n.*` stripping)
 * @param {number} [opts.tolerance]  absolute tolerance for finite numbers
 * @returns {{path: string, expected: *, actual: *, why: string}[]}  empty = equal
 */
export function compare(expected, actual, opts = {}) {
  const diffs = [];
  const keepNative = NATIVE_TOKEN_FAMILIES.includes(opts.family);
  const tol = typeof opts.tolerance === "number" && opts.tolerance >= 0 ? opts.tolerance : 0;
  walk(expected, actual, "$", null);
  return diffs;

  function walk(e, a, at, key) {
    if (typeof e === "number" && typeof a === "number") {
      if (e === a) return;
      if (tol > 0 && Math.abs(e - a) <= tol) return;
      diffs.push({ path: at, expected: e, actual: a, why: tol > 0 ? `differs by more than ${tol}` : "not equal" });
      return;
    }
    if (isSpecialNum(e) || isSpecialNum(a)) {
      // NaN is only ever equal to a NaN tag; -0 only to a -0 tag. Tolerance does
      // not apply: 0 within any tolerance of -0 is exactly the sign bug a -0 case
      // exists to catch.
      if (isSpecialNum(e) && isSpecialNum(a) && e.$num === a.$num) return;
      diffs.push({ path: at, expected: e, actual: a, why: "special number differs" });
      return;
    }
    if (Array.isArray(e) || Array.isArray(a)) {
      if (!Array.isArray(e) || !Array.isArray(a)) {
        diffs.push({ path: at, expected: e, actual: a, why: "one side is not an array" });
        return;
      }
      if (key === "ops" && !keepNative) {
        e = stripNative(e);
        a = stripNative(a);
      }
      if (e.length !== a.length) {
        diffs.push({ path: at, expected: e, actual: a, why: `length ${e.length} != ${a.length}` });
        return;
      }
      for (let i = 0; i < e.length; i++) walk(e[i], a[i], `${at}[${i}]`, null);
      return;
    }
    if (isPlainObject(e) || isPlainObject(a)) {
      if (!isPlainObject(e) || !isPlainObject(a)) {
        diffs.push({ path: at, expected: e, actual: a, why: "one side is not an object" });
        return;
      }
      const keys = new Set([...Object.keys(e), ...Object.keys(a)]);
      for (const k of [...keys].sort()) {
        if (!(k in e)) diffs.push({ path: `${at}.${k}`, expected: undefined, actual: a[k], why: "unexpected key" });
        else if (!(k in a)) diffs.push({ path: `${at}.${k}`, expected: e[k], actual: undefined, why: "missing key" });
        else walk(e[k], a[k], `${at}.${k}`, k);
      }
      return;
    }
    if (e !== a) diffs.push({ path: at, expected: e, actual: a, why: "not equal" });
  }
}

/** One line per difference, for a test failure or the recorder's report. */
export function formatDiffs(diffs, max = 12) {
  const lines = diffs.slice(0, max).map(
    (d) => `  ${d.path}: expected ${JSON.stringify(d.expected)}, got ${JSON.stringify(d.actual)} (${d.why})`
  );
  if (diffs.length > max) lines.push(`  ... and ${diffs.length - max} more`);
  return lines.join("\n");
}
