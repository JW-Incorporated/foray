/* Durable "have we already built this exact dump version" marker
   (tools/shows/state/last-build.json, not gitignored — the card asks for
   "somewhere durable under data/ or tools/shows/state/" so a second run on
   a fresh checkout still sees the last build). Pure functions over a
   plain-object state; the caller does the file I/O. */

/** True when `exportVersion` (the dump's Last-Modified header, verbatim)
    matches the last recorded build AND the checksum matches too — belt and
    braces: a version string alone doesn't prove the bytes didn't change
    (a re-publish under an unchanged header would be invisible to a
    version-only check). */
export function alreadyBuilt(state, { exportVersion, checksum }) {
  if (!state || typeof state !== "object") return false;
  return state.export_version === exportVersion && state.checksum === checksum;
}

export function nextState(prev, { exportVersion, checksum, builtAt, counts }) {
  return {
    version: 1,
    export_version: exportVersion,
    checksum,
    built_at: builtAt,
    counts: counts || null,
    previous_export_version: prev?.export_version ?? null,
  };
}
