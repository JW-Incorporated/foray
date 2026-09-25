/* Text patches for data/session.json, shared by backfill-audio.mjs and
   classify-dai.mjs.

   session.json is hand-authored ("builder": "hand-architect-v1"): every
   episode block is deliberately kept on one line and the founders read it.
   A blind JSON.stringify would turn a handful of real edits into a ~670-line
   diff, so both scripts patch its TEXT in place and leave every other byte
   alone.

   WHY THIS FILE EXISTS (audit round 3, data-tools-11). Both scripts used to
   write data/discover.json (and classify-dai its DAI cache) FIRST, then patch
   and verify session.json, and the verification can throw. A throw left the
   two client documents disagreeing. They now call `prepareSessionPatch`
   before writing anything: it returns text that is already parsed and
   checked, or throws while nothing has been written.

   REPLACER FUNCTIONS, NOT REPLACEMENT STRINGS. `txt.replace(re, `$1${v}`)`
   reads `$&`, `$'`, `$1` inside an audio URL as replacement patterns, and a
   tracking URL can carry any of them. Every replace below passes a function,
   so the inserted text is literal. */

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Inserts duration_sec/audio_url/audio_type/audio_bytes after each block's
    `"duration_min": N`. Idempotent: a block that already carries `audio_url`
    is left alone. Returns the new text and the ids no regex could reach. */
export function patchAudioFields(txt, episodes) {
  const missed = [];
  for (const [id, e] of Object.entries(episodes)) {
    if (!e.audio_url && e.duration_sec == null) continue;
    const already = new RegExp(`"${escapeRe(id)}":\\s*\\{[^{}]*"audio_url"\\s*:`);
    if (already.test(txt)) continue;

    const re = new RegExp(`("${escapeRe(id)}":\\s*\\{[^{}]*?"duration_min":\\s*(?:-?\\d+(?:\\.\\d+)?|null))`);
    if (!re.test(txt)) { missed.push(id); continue; }
    const fields =
      `, "duration_sec": ${JSON.stringify(e.duration_sec ?? null)}` +
      `, "audio_url": ${JSON.stringify(e.audio_url ?? null)}` +
      `, "audio_type": ${JSON.stringify(e.audio_type ?? null)}` +
      `, "audio_bytes": ${JSON.stringify(e.audio_bytes ?? null)}`;
    txt = txt.replace(re, (whole, head) => head + fields);
  }
  return { txt, missed };
}

/** Sets `dai_suspected` on every block whose episode carries one: updated in
    place when the field exists (so --reclassify can flip it), inserted after
    `"audio_bytes"` otherwise. */
export function patchDaiFlags(txt, episodes) {
  let patched = 0;
  for (const [id, e] of Object.entries(episodes)) {
    if (e.dai_suspected === undefined) continue;
    const value = String(e.dai_suspected);
    const existing = new RegExp(`("${escapeRe(id)}":\\s*\\{[^{}]*?"dai_suspected":\\s*)(?:true|false)`);
    if (existing.test(txt)) {
      txt = txt.replace(existing, (whole, head) => head + value);
      patched++;
      continue;
    }
    const re = new RegExp(`("${escapeRe(id)}":\\s*\\{[^{}]*?"audio_bytes":\\s*(?:-?\\d+|null))`);
    if (!re.test(txt)) continue;
    txt = txt.replace(re, (whole, head) => `${head}, "dai_suspected": ${value}`);
    patched++;
  }
  return { txt, patched };
}

/** Patches the session text and PROVES the result before anyone writes a
    byte: it must parse, keep every episode, and carry exactly the values the
    in-memory episodes hold for `fields`. Throws on any mismatch. */
export function prepareSessionPatch(original, episodes, { kind }) {
  let txt, report;
  if (kind === "audio") {
    const r = patchAudioFields(original, episodes);
    txt = r.txt; report = { missed: r.missed };
  } else if (kind === "dai") {
    const r = patchDaiFlags(original, episodes);
    txt = r.txt; report = { patched: r.patched };
  } else {
    throw new Error(`prepareSessionPatch: unknown kind ${kind}`);
  }

  const reparsed = JSON.parse(txt); // refuse anything unparseable
  for (const [id, e] of Object.entries(episodes)) {
    const got = reparsed.episodes?.[id];
    if (!got) throw new Error(`session patch lost episode ${id}`);
    if (kind === "audio" && (got.audio_url ?? null) !== (e.audio_url ?? null)) {
      throw new Error(`session patch mismatch on ${id}: ${got.audio_url} !== ${e.audio_url}`);
    }
    if (kind === "dai" && e.dai_suspected !== undefined && got.dai_suspected !== e.dai_suspected) {
      throw new Error(`session patch mismatch on ${id}: dai_suspected ${got.dai_suspected} !== ${e.dai_suspected}`);
    }
  }
  return { txt, ...report };
}
