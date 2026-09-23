/* Which store-upload failures are worth trying again.
 *
 * FOUNDER, 2026-09-22: "It seems these releases are usually quite rocky and
 * fail on a somewhat regular basis."
 *
 * ── THE MEASUREMENT THAT PROMPTED THIS ───────────────────────────────────────
 *
 * 24 release runs to 2026-09-22. Three failed, and ALL THREE were PARTIAL —
 * one store got the build and the other did not:
 *
 *   34042838342  2026-09-06  android failed, ios uploaded
 *   34739630705  2026-09-13  ios failed,     android uploaded
 *   35672098914  2026-09-22  ios failed,     android uploaded
 *
 * The last one is the one with a readable cause, and it is the reason this file
 * exists. The archive built, signed, exported and validated. Then:
 *
 *   CREATE BUILD (ASSET_UPLOAD): received status code 500; internal server
 *   error. (OD7Z2YQCYF53IIOVJK24XP4EGI) (500)
 *
 * Apple's ingestion server, not our bundle. `xcrun altool --upload-app` is
 * invoked exactly once in `.github/actions/ios-archive/action.yml`, so a single
 * 500 from someone else's server threw away a completed archive, failed the
 * release, and left Play on a build TestFlight never received. Nobody found out
 * for sixteen hours.
 *
 * ── WHY A MODULE RATHER THAN `for i in 1 2 3` ────────────────────────────────
 *
 * Because "retry everything three times" is the wrong rule, and the difference
 * is worth a file. A binary Apple REJECTS — a duplicate build number, a bad
 * entitlement, an invalid signature — will be rejected three more times. All
 * that buys is six minutes of runner time and a log where the real reason is
 * the fourth copy of itself. The retry has to know the difference, the
 * knowledge is a list of strings, and a list of strings that nobody can test is
 * how it quietly stops matching what the tools actually print.
 *
 * So: the DECISION lives here and is tested; the LOOP stays in the composite
 * action where a reader of the run log can see it.
 *
 * ── THE ORDER OF THE TWO LISTS IS THE WHOLE RULE ─────────────────────────────
 *
 * PERMANENT is tested FIRST and wins. Apple's rejections routinely arrive
 * wrapped in prose that also contains a transient-looking word — a duplicate
 * build number comes back inside an "ERROR" block that names a request id and
 * can mention a status — so a transient marker found anywhere in the output is
 * not enough on its own. Checking permanence first means a marker we have
 * positively recognised as final beats a generic one.
 *
 * ── AND AN UNRECOGNISED FAILURE IS RETRIED ───────────────────────────────────
 *
 * The two mistakes are not symmetric. Retrying a permanent failure costs a few
 * minutes of a runner nobody is waiting on. NOT retrying a transient one costs
 * the whole release, both stores out of step, and — before the watchdog that
 * ships alongside this — a founder discovering it by using the app. So an
 * output we cannot classify is retried, and the attempt budget is what bounds
 * the waste.
 *
 * `tools/release/upload-retry.test.mjs` owns these rules and carries the real
 * altool output this was written against.
 */

/** How many attempts in total, including the first. */
export const MAX_ATTEMPTS = 3;

/** Seconds to wait before attempt 2 and attempt 3. A 500 from an ingestion
 *  queue clears in seconds to low minutes; anything longer than this is not a
 *  blip and belongs to the watchdog, not to a loop holding a macOS runner. */
export const BACKOFF_SECONDS = [60, 180];

/**
 * Output that means "this binary will never be accepted as it stands".
 *
 * Every entry is something one of the two upload tools actually prints. Kept
 * as lower-case substrings rather than regexes: the matching is done on a
 * lower-cased haystack, and a substring cannot develop a catastrophic
 * backtracking habit on a megabyte of build log.
 */
export const PERMANENT_MARKERS = [
  /* altool / App Store Connect — the binary is wrong or already there. */
  "the bundle version must be higher",
  "redundant binary upload",
  "bundle version must be higher than the previously uploaded version",
  "asset validation failed",
  "invalid signature",
  "invalid code signing",
  "invalid provisioning profile",
  "missing or invalid signature",
  "the provided entity includes an attribute with a value that has already been used",
  "unable to authenticate",
  "authentication credentials are missing or invalid",
  "no suitable application records were found",
  "app record not found",
  "entity_error",
  /* Play — the edit was refused, not dropped. */
  "apk specifies a version code that has already been used",
  "version code that has already been used",
  "the caller does not have permission",
  "package not found",
  "apkupgradeversionconflict",
  "apknotificationmessagekeyupgradeversionconflict",
];

/**
 * Output that means "someone else's server had a bad moment".
 *
 * Only consulted when nothing in `PERMANENT_MARKERS` matched — see the header.
 * It exists to make the common case legible in the log ("retrying: transient"),
 * not to gate the retry: an unrecognised failure is retried anyway.
 */
export const TRANSIENT_MARKERS = [
  "unexpected_error",
  "an unexpected error occurred",
  "internal server error",
  "status code 500",
  "status code 502",
  "status code 503",
  "status code 504",
  "service unavailable",
  "temporarily unavailable",
  "try again later",
  "please try again",
  "connection reset",
  "connection refused",
  "timed out",
  "timeout",
  "etimedout",
  "econnreset",
  "enotfound",
  "network is unreachable",
  "the request timed out",
  "504 gateway",
  "502 bad gateway",
  "rate limit",
  "too many requests",
];

/**
 * Classify one upload attempt's combined stdout+stderr.
 *
 * @param {string} output
 * @returns {{ retry: boolean, reason: "permanent"|"transient"|"unrecognised", marker: string|null }}
 *   `marker` is the string that decided it, so the run log can say WHY it is
 *   about to wait three minutes rather than only that it is.
 */
export function classifyUploadFailure(output) {
  const hay = String(output ?? "").toLowerCase();

  /* PERMANENT FIRST. See the header: a rejection's prose can carry a generic
     transient word, and a marker we positively recognise as final must win. */
  for (const marker of PERMANENT_MARKERS) {
    if (hay.includes(marker)) return { retry: false, reason: "permanent", marker };
  }
  for (const marker of TRANSIENT_MARKERS) {
    if (hay.includes(marker)) return { retry: true, reason: "transient", marker };
  }
  /* Neither list matched. Retry — the asymmetry argument in the header. */
  return { retry: true, reason: "unrecognised", marker: null };
}

/**
 * Should attempt number `attempt` (1-based) be followed by another?
 *
 * Separate from `classifyUploadFailure` because the two questions are
 * genuinely different and a caller that conflates them retries a permanent
 * failure until it runs out of attempts.
 */
export function shouldRetry(output, attempt, maxAttempts = MAX_ATTEMPTS) {
  const verdict = classifyUploadFailure(output);
  return verdict.retry && attempt < maxAttempts;
}

/** Seconds to sleep after a failed attempt `attempt` (1-based). */
export function backoffFor(attempt, table = BACKOFF_SECONDS) {
  if (attempt < 1) return table[0];
  /* The last entry repeats rather than running off the end, so raising
     MAX_ATTEMPTS without touching the table cannot produce an undefined sleep
     — which in shell becomes `sleep` with no argument, an instant retry, and a
     "backoff" that silently is not one. */
  return table[Math.min(attempt, table.length) - 1];
}

/* ------------------------------------------------------------------ the CLI */

/**
 * `node tools/release/upload-retry.mjs classify <file> <attempt>`
 *
 * Prints one shell-evalable line and exits 0 either way — the CALLER decides
 * what to do, so a classification that exited non-zero would trip `set -e` in
 * the composite and fail the job it was invoked to rescue.
 *
 *   RETRY=1 REASON=transient SLEEP=60 MARKER='status code 500'
 */
async function main(argv) {
  const [command, file, attemptRaw] = argv;
  if (command !== "classify" || !file) {
    console.error("usage: upload-retry.mjs classify <output-file> <attempt>");
    return 2;
  }
  const attempt = Number.parseInt(attemptRaw ?? "1", 10) || 1;
  let output = "";
  try {
    const fs = await import("node:fs");
    output = fs.readFileSync(file, "utf8");
  } catch (e) {
    /* A missing log is not a reason to give up on a built archive: an upload
       whose output we cannot read is exactly the "unrecognised" case. */
    output = "";
  }
  const verdict = classifyUploadFailure(output);
  const retry = verdict.retry && attempt < MAX_ATTEMPTS;
  const marker = (verdict.marker ?? "").replace(/'/g, "");
  console.log(
    `RETRY=${retry ? 1 : 0} REASON=${verdict.reason} ` +
    `SLEEP=${backoffFor(attempt)} MARKER='${marker}'`,
  );
  return 0;
}

const invokedAs = String(process.argv[1] || "").split(String.fromCharCode(92)).join("/");
if (invokedAs.endsWith("/upload-retry.mjs")) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
