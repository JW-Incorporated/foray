/* Config constants for the corpus export + R2 sync package (PKG-01, G-10/G-11;
   docs/roadmap/corpus.md). Single source of truth for every path, prefix, env
   name and limit the later modules (row sources, exporter, r2-client, sync)
   read, so none of them names one ad hoc.

   Identity: this package invents NO User-Agent strings. It re-exports the
   project's existing identities from ../segments/politeness.mjs (that file's
   header is the registry of who foray claims to be on the wire), and
   config.test.mjs scans every tracked .mjs here for a stray one. */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export { safeKey } from "../segments/fetch-transcripts.mjs";
export { CORPUS_UA, AUDIO_UA, CONTACT } from "../segments/politeness.mjs";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** R2 key layout written by the transcript farm (foray-db
    `transcript-farm/farm/r2.py`): `transcripts/normalized/<safeKey(show_id)>/
    <safeKey(guid)>.json` and `transcripts/raw/<safeKey(show_id)>/
    <safeKey(guid)>.vtt`. Everything outside `transcripts/` (the 7,531 legacy
    whisper JSONs at the bucket root) is ignored by the sync. */
export const NORMALIZED_PREFIX = "transcripts/normalized";
export const RAW_PREFIX = "transcripts/raw";
export const FINGERPRINT_PREFIX = "fingerprints";

/** Env names for the read-only R2 S3 key pair (founder Q1). The first four are
    the same names the farm reads; `R2_CREDENTIALS_FILE` points at a file
    OUTSIDE the tree (default home: ~/.foray/r2-credentials) holding them. */
export const R2_ENV = Object.freeze({
  accessKeyId: "R2_ACCESS_KEY_ID",
  secretAccessKey: "R2_SECRET_ACCESS_KEY",
  endpoint: "R2_S3_ENDPOINT",
  bucket: "R2_BUCKET",
  credentialsFile: "R2_CREDENTIALS_FILE",
});
export const DEFAULT_BUCKET = "foray-transcriptions";

/** Local mirror of the R2 bodies, in the layout the pipeline already reads. */
export const TRANSCRIPTS_DIR = join(ROOT, "data-local", "transcripts");
export const EXPORT_OUT_DIR = join(ROOT, "data-local", "corpus-export");
export const SYNC_STATE_FILE = join(TRANSCRIPTS_DIR, "r2-sync-state.json");

/** Postgres (foraycorpus, `wyatt_readonly`, tailnet-only). Connection string
    from this env var; never committed. Keyset pagination in pages of
    PG_PAGE_SIZE under a per-statement timeout. */
export const PG_ENV = "FORAYCORPUS_DATABASE_URL";
export const PG_STATEMENT_TIMEOUT_MS = 300000;
export const PG_PAGE_SIZE = 5000;

/** Catalogue artifacts publish as GitHub Releases with a committed pointer,
    exactly like tools/shows/ (founder Q2 default). */
export const RELEASE_TAG_PREFIX = "corpus-export-";
export const POINTER_PATH = join(ROOT, "data", "corpus-catalogue-pointer.json");
