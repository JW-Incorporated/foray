/* Wait for a CONDITION, not for a guess at how long it takes (audit round 3,
 * tests-3).
 *
 * The search load-state suites ordered the product's own nested timers (the
 * 250 ms search debounce, then a fetch, then a paint) against fixed real sleeps
 * a little longer than their sum. A loaded runner that fires the debounce late
 * turned the positive tests into flakes and the negative ones into vacuous
 * passes. `waitFor` polls a predicate until it holds or a generous deadline
 * passes, and answers the predicate's last value, so the caller's own assertion
 * still produces the descriptive failure.
 *
 * A NEGATIVE ("zero shard requests") is asserted only after a POSITIVE signal
 * that the pass which could have made the request has run: waiting on the
 * negative itself proves nothing, because it is true from the start.
 *
 * Not a test suite (no `.test.js`), so neither run-suites nor the suite floors
 * see it.
 */

"use strict";

async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value;
    try { value = predicate(); } catch (_) { value = false; }
    if (value) return value;
    if (Date.now() >= deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

module.exports = { waitFor };
