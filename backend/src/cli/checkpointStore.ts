import * as fs from "fs";
import * as path from "path";
import {
  CHECKPOINT_VERSION,
  CheckpointFileSchema,
  type CheckpointFile,
  type CheckpointStageKey,
  type CheckpointStore
} from "../generation/checkpoint";

/**
 * The on-disk half of F-17/F-18's per-stage resume: one
 * `<out>/<candidate-basename>.checkpoint.json` per prompt, sitting beside the
 * candidate file the same prompt will eventually produce.
 *
 * WHY IT LIVES IN `src/cli/` AND NOT BESIDE `checkpoint.ts`. §9.4 is a founder
 * ruling — "Each prompt is discarded. The Foray is given a title on creation,
 * which is retained." — and `test/promptNoPersistence.test.ts` enforces it
 * structurally, by scanning every file in `src/generation/` for a persistence
 * primitive and failing if one appears. That test is right and it caught this
 * class on its first run. The §4 stages must not be able to write anything;
 * the DRIVER writes, and it already did (it writes the candidate and the
 * report). So the interface, the session and the fingerprint stay in
 * `generation/checkpoint.ts`, where the pipeline can use them without gaining
 * the ability to persist, and the only code that touches a file is here.
 *
 * WHAT IT WRITES, against that ruling: stage outputs, keyed by a sha1
 * fingerprint of the request. Not the raw prompt — the closest thing to it is
 * §4.1's `intent`, whose `subject` the finished candidate already retains as
 * its title and summary, which is exactly the carve-out §9.4 names. The file
 * is deleted the moment the candidate is written.
 *
 * WRITE DISCIPLINE. Every `save` rewrites the whole file through a temp file
 * and a rename, because the alternative — appending, or writing in place — is
 * how a run that is killed mid-write (precisely the situation this exists for;
 * see I-15, where the harness killed run 1's shell) leaves behind a file that
 * parses as valid JSON and is missing half a stage.
 */
export class FileCheckpointStore implements CheckpointStore {
  constructor(
    private readonly dir: string,
    private readonly fingerprint: string
  ) {}

  /** Public so the driver can name the file in a message a human will act on. */
  filePathFor(key: string): string {
    return path.join(this.dir, `${key}.checkpoint.json`);
  }

  load(key: string): CheckpointFile | null {
    const file = this.filePathFor(key);
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- `key` is the driver's own sha1-suffixed candidate basename, not external input.
      if (!fs.existsSync(file)) return null;
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- same.
      const parsed = CheckpointFileSchema.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  save(key: string, stage: CheckpointStageKey, data: unknown): void {
    const file = this.filePathFor(key);
    const existing = this.load(key);
    const stages =
      existing && existing.version === CHECKPOINT_VERSION && existing.fingerprint === this.fingerprint ? { ...existing.stages } : {};
    stages[stage] = data;
    const next: CheckpointFile = {
      version: CHECKPOINT_VERSION,
      key,
      fingerprint: this.fingerprint,
      updatedAt: new Date().toISOString(),
      stages
    };
    const tmp = `${file}.tmp`;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- see load().
    fs.mkdirSync(this.dir, { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- see load().
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- see load().
    fs.renameSync(tmp, file);
  }

  /** Called once a candidate has been written: the checkpoint has done its job
   * and a stale one beside a finished candidate is only a trap for the next
   * reader. Never throws — a leftover file is harmless. */
  discard(key: string): void {
    try {
      fs.rmSync(this.filePathFor(key), { force: true });
    } catch {
      /* ignore */
    }
  }
}
