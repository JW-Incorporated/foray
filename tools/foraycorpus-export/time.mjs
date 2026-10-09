/* The corpus export's one timestamp rule (CH2-30, docs/roadmap/code-health-2.md
   T1-20). Every builder that reads a timestamp column goes through here.

   pg returns timestamptz as a Date object; the JSONL fixture carries ISO
   strings. A Date is read with getTime(), never Date.parse: Date.parse(date)
   goes through Date#toString, which has no milliseconds, so a private
   `Date.parse` copy silently compared and wrote pg instants at second
   precision while the copies with this branch kept the ms. */

/** An instant in ms, or null for null / undefined / unparsable. Accepts ISO
    strings and Date objects (what pg returns for timestamptz). */
export function instant(value) {
  if (value == null) return null;
  const t = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

/** The ISO string of `instant(value)`, or null. */
export function toIsoOrNull(value) {
  const t = instant(value);
  return t === null ? null : new Date(t).toISOString();
}
