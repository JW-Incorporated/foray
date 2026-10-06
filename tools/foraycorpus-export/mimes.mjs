/* Transcript mime classification for the corpus export (PKG-02, G-10;
   docs/roadmap/corpus.md). The ONE place this package defines a mime list:
   catalogue.mjs / episodes.mjs (PKG-04/05) import from here.

   The lists are the corpus brief's §2 split
   (docs/curation/corpus-integration-brief.md:57): the corpus's own
   `assets.mime_type` values, which include junk the RSS publishers wrote —
   two leading-slash variants and `plain/txt`. They are kept verbatim because
   they are real rows (763 + 52 timed, 184 plain at the brief's full scan).

   Normalisation is tools/segments/sweep-transcripts.mjs's normalizeMimeType
   (imported, not forked): it drops parameters, trims and lowercases. It does
   NOT strip a leading slash, so "/application/srt" survives normalisation and
   matches its own TIMED_MIMES entry; no separate pre-normalisation branch is
   needed for the leading-slash variants. */
import { normalizeMimeType } from "../segments/sweep-transcripts.mjs";

/** Formats that carry a timeline (brief §2). A superset of
    TIMED_TRANSCRIPT_TYPES in tools/segments/sweep-transcripts.mjs (the
    4 well-formed types); mimes.test.mjs pins the superset relation. */
export const TIMED_MIMES = Object.freeze([
  "text/vtt",
  "application/srt",
  "application/x-subrip",
  "application/json",
  "text/srt",
  "application/vtt",
  "/application/srt",
  "/application/vtt",
]);

/** Prose formats (brief §2's plain list, plus text/markdown). The brief also
    files a null mime as plain; here a null mime classifies as "other" — null
    is not a mime and is not put in this array. */
export const PLAIN_MIMES = Object.freeze([
  "text/plain",
  "plain/txt",
  "text/html",
  "application/pdf",
  "text/markdown",
]);

/** "timed" | "plain" | "other". null / non-string / empty → "other". */
export function classifyTranscriptMime(raw) {
  if (typeof raw !== "string") return "other";
  const mime = normalizeMimeType(raw);
  if (mime === null) return "other";
  if (TIMED_MIMES.includes(mime)) return "timed";
  if (PLAIN_MIMES.includes(mime)) return "plain";
  return "other";
}

export function isTimedMime(raw) {
  return classifyTranscriptMime(raw) === "timed";
}
