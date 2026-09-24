/* The web <-> native engine contract (docs/native-engine-plan.md §5).

   NE-10j declares the first piece of it, OWNED_PREFIXES, because two cards
   consume it before the rest of the contract exists: NE-11j builds this module
   out (PROTOCOL, names, decideMode, validate, extrapolate), and NE-23 makes
   DurableStore treat these keys as DEFERRED on the iOS shell from the moment it
   is constructed. It lives here, and not in durable-store.js, because it is a
   claim both sides make: the Swift EngineStore writes exactly these rows under
   `CapacitorStorage.`, and the page stops writing them while the engine owns
   them. One list, recorded into the `rows` parity family, so the Swift side
   reads the same three strings instead of retyping them.

   Pure data. No DOM, no storage, no imports: the page, the parity recorder and
   the Node tests all load it as is. */

/**
 * The shared storage rows the native engine owns on iOS (plan §4.6).
 *
 *   `cp_pos:`         one row per episode, `position-store.js` (positionKey)
 *   `cp_foray:`       one row per Foray, `foray-progress.js` (KEY_PREFIX)
 *   `cp_last_episode` the single pointer row, `episode-progress.js` (KEY)
 *
 * They are PREFIXES, matched with startsWith, and the trailing colons are
 * load-bearing: `cp_foray` without one would also claim `cp_foray_feedback`,
 * the thumbs store, which the engine never writes — a deferred key nobody
 * writes is a vote that silently stops saving. `cp_last_episode` is one whole
 * key, and needs no colon because nothing else starts with it
 * (engine-contract.test.js checks every `cp_` key the app spells).
 */
export const OWNED_PREFIXES = Object.freeze(["cp_pos:", "cp_foray:", "cp_last_episode"]);
