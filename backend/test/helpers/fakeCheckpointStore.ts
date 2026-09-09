import { CHECKPOINT_VERSION, type CheckpointFile, type CheckpointStore } from "../../src/generation/checkpoint";

/**
 * In-memory `CheckpointStore` for the F-17/F-18 tests: the real resume logic,
 * no filesystem.
 *
 * It round-trips every saved value through JSON, deliberately. A store that
 * handed back the same object reference would let a test pass on a value the
 * real `FileCheckpointStore` could never have reproduced — a `Date`, a `Map`,
 * an object with a method — and the whole point of a checkpoint is that it
 * survives a process boundary.
 */
export class FakeCheckpointStore implements CheckpointStore {
  readonly files = new Map<string, CheckpointFile>();
  /** Every save in order, so a test can assert what was banked and when. */
  readonly saves: Array<{ key: string; stage: string }> = [];

  constructor(private readonly fingerprint: string) {}

  load(key: string): CheckpointFile | null {
    return this.files.get(key) ?? null;
  }

  save(key: string, stage: string, data: unknown): void {
    this.saves.push({ key, stage });
    const existing = this.files.get(key);
    const stages = existing ? { ...existing.stages } : {};
    stages[stage] = JSON.parse(JSON.stringify(data)) as unknown;
    this.files.set(key, {
      version: CHECKPOINT_VERSION,
      key,
      fingerprint: this.fingerprint,
      updatedAt: "2026-09-09T00:00:00.000Z",
      stages
    });
  }

  /** Stage keys banked for `key`, in insertion order. */
  stageKeys(key: string): string[] {
    return Object.keys(this.files.get(key)?.stages ?? {});
  }
}
