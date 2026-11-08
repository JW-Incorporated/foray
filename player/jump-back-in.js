/* "Jump back in" housekeeping (founder, 2026-10-15): "We should add a little x
   or something so I can remove items from Jump Back In. Also, if they have been
   there a long time then they should just go away on their own instead of
   piling up."

   Pure: app.js owns the storage (`cp_jbi_dismissed`) and the markup, and asks
   this module which rail entries to show. An entry is the rail's own row,
   `{ kind, id, at }`, where `at` is the ISO time it was last played.

   TWO RULES.
   1. AGE. An entry last played more than JBI_MAX_AGE_DAYS ago leaves the rail.
      The thing itself is untouched: the episode keeps its position, the Foray
      its resume point, the playlist its history. Playing it again stamps a new
      `at` and brings it back.
   2. DISMISSED. The x records when the listener removed the entry. It stays
      off while its `at` is no newer than that, so playing the same thing again
      later brings it back. A dismissal is "I'm done with this for now", not
      "never show this again". An entry with no `at` cannot be replayed into
      view, so its dismissal holds for as long as the record is kept.

   The record is capped at JBI_DISMISS_MAX entries, newest kept, so it cannot
   grow without bound. There is no age-based pruning, because pruning a record
   for an entry with no `at` would bring that entry back. */

export const JBI_MAX_AGE_DAYS = 14;
export const JBI_DISMISS_MAX = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The record key for a rail entry: kinds share no id space. */
export function jbiKey(entry) {
  return `${entry.kind}:${entry.id}`;
}

function timeOf(iso) {
  if (typeof iso !== "string" || !iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/**
 * The entries the rail should show, in their given order.
 * @param {Array<{kind: string, id: string, at?: string|null}>} entries
 * @param {{dismissed?: Object<string, string>, now?: number, maxAgeDays?: number}} [opts]
 */
export function visibleJumpBackIn(entries, { dismissed = {}, now = Date.now(), maxAgeDays = JBI_MAX_AGE_DAYS } = {}) {
  const cutoff = now - maxAgeDays * DAY_MS;
  const record = dismissed && typeof dismissed === "object" ? dismissed : {};
  return entries.filter((e) => {
    const at = timeOf(e.at);
    if (at !== null && at < cutoff) return false;
    const gone = timeOf(record[jbiKey(e)]);
    if (gone !== null && (at === null || at <= gone)) return false;
    return true;
  });
}

/** A new dismissal record with `entry` dismissed at `now`, capped at
    JBI_DISMISS_MAX (newest kept). Never mutates `dismissed`. */
export function withDismissed(dismissed, entry, now = Date.now()) {
  const record = dismissed && typeof dismissed === "object" ? dismissed : {};
  const next = { ...record, [jbiKey(entry)]: new Date(now).toISOString() };
  const keys = Object.keys(next).filter((k) => timeOf(next[k]) !== null);
  if (keys.length <= JBI_DISMISS_MAX) return Object.fromEntries(keys.map((k) => [k, next[k]]));
  keys.sort((a, b) => timeOf(next[b]) - timeOf(next[a]));
  return Object.fromEntries(keys.slice(0, JBI_DISMISS_MAX).map((k) => [k, next[k]]));
}
