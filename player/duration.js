/* THE ONE DURATION DIALECT — "45 min", "1 hr", "1 hr 5 min" (audit round 2,
   copy-2: a row read "3h 5m" beside "185 min left"; code-health CH-24).

   This module owns the hours-and-minutes TAIL every listener-facing length in
   the player says. It used to be written out four times — app.js's `fmtDur`,
   foray-resolve's `fmtSpan`, episode-progress's `fmtMinutes` and
   foray-progress's `remainingLabel` — three of them in ES modules that could
   have imported each other, so a copy ruling on the hour had to land in four
   files and the one that was missed read "1h 5m" beside "1 hr 5 min left".

   Each caller keeps its OWN rung below the tail, on purpose, and owns it:
     - `fmtSpan` (here) counts seconds under 90 ("60 sec"): a segment's length
       is a measurement of somebody else's audio;
     - `fmtMinutes` (episode-progress.js) says "0 min" for nothing;
     - `remainingLabel` (foray-progress.js) says "under a minute left", and
       hedges an estimate with "about ";
     - app.js's `fmtDur` says nothing ("") for an unknown length.

   app.js's `fmtDur` stays a classic-script copy: it paints cards before this
   module has loaded (and its test harnesses run without the player), so
   routing it through `window.ForayPlayer` would blank durations on first
   paint. test/format-helpers.test.js pins it word for word against this file.

   No imports: this is a leaf, so anything in the player graph can use it. */

const isNum = (n) => typeof n === "number" && Number.isFinite(n);

/** The tail for a POSITIVE count of minutes: "45 min", "1 hr", "1 hr 5 min" —
    never "1 hr 0 min", never "65 min". A fraction is rounded, never printed.
    Below one minute is the caller's rung, not this function's. */
export function hoursMinutes(mins) {
  const n = Math.round(Number(mins));
  if (n < 60) return `${n} min`;
  const h = Math.floor(n / 60);
  const m = n % 60;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

/** "45 sec" / "2 min" / "1 hr 35 min". Rounded, because a segment's length is a
    measurement of somebody else's audio and second-precision would overstate
    it. Past the hour it rolls over, in the one duration dialect every label in
    4a uses (audit round 2, copy-2): a Foray's header said "about 95 min" over
    rows that said "1h 12m". The colon clock (foray-resolve's `fmtClock`) is for
    live playheads and scrubbers only. foray-resolve.js re-exports this, which
    is where the page and the parity `foray-clock` family read it. */
export function fmtSpan(sec) {
  const total = isNum(sec) && sec > 0 ? Math.round(sec) : 0;
  if (total < 90) return `${total} sec`;
  return hoursMinutes(Math.round(total / 60));
}
