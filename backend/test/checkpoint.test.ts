import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { z } from "zod";
import { FakeCheckpointStore } from "./helpers/fakeCheckpointStore";
import { CheckpointSession, checkpointFingerprint, type CheckpointStore } from "../src/generation/checkpoint";
import { FileCheckpointStore } from "../src/cli/checkpointStore";

/**
 * F-17/F-18. Run 1 attempt 4 ran 2 h 35 m, made 103 model calls, finished 22 of
 * 31 beats, and then threw away every one of them because beat 23's narration
 * page was rejected a third time — the batch driver's only resume key is the
 * candidate FILE, which a failed run never writes.
 *
 * `runPipelineCheckpoint.test.ts` drives the whole pipeline through this; these
 * are the store's own rules.
 */

const Payload = z.object({ n: z.number() });
const parsePayload = (raw: unknown) => Payload.parse(raw);
const FP = checkpointFingerprint({ prompt: "a prompt", duration: "medium" });

describe("CheckpointSession", () => {
  it("runs a stage and persists its output the first time", async () => {
    const store = new FakeCheckpointStore(FP);
    const session = await CheckpointSession.open(store, "k", FP);
    let calls = 0;
    const { value, resumed } = await session.stage("spine", parsePayload, async () => {
      calls++;
      return { n: 1 };
    });
    expect(value).toEqual({ n: 1 });
    expect(resumed).toBe(false);
    expect(calls).toBe(1);
    expect(store.saves).toEqual([{ key: "k", stage: "spine" }]);
  });

  it("skips a stage whose output is already on disk", async () => {
    const store = new FakeCheckpointStore(FP);
    store.save("k", "spine", { n: 7 });
    const session = await CheckpointSession.open(store, "k", FP);
    let calls = 0;
    const { value, resumed } = await session.stage("spine", parsePayload, async () => {
      calls++;
      return { n: 99 };
    });
    expect(value).toEqual({ n: 7 });
    expect(resumed).toBe(true);
    expect(calls).toBe(0);
    expect(session.resumed()).toEqual(["spine"]);
  });

  it("re-runs a stage whose stored output no longer parses", async () => {
    /* A checkpoint file is JSON a person can edit and a killed process can
       truncate. A wrong resume is more expensive than a repeated one. */
    const store = new FakeCheckpointStore(FP);
    store.save("k", "spine", { n: "not a number" });
    const session = await CheckpointSession.open(store, "k", FP);
    let calls = 0;
    const { value, resumed } = await session.stage("spine", parsePayload, async () => {
      calls++;
      return { n: 3 };
    });
    expect(value).toEqual({ n: 3 });
    expect(resumed).toBe(false);
    expect(calls).toBe(1);
  });

  it("discards a checkpoint written for a different request", async () => {
    const store = new FakeCheckpointStore(FP);
    store.save("k", "spine", { n: 7 });
    const other = checkpointFingerprint({ prompt: "a prompt", duration: "short" });
    const session = await CheckpointSession.open(store, "k", other);
    let calls = 0;
    await session.stage("spine", parsePayload, async () => {
      calls++;
      return { n: 1 };
    });
    /* Resuming a spine built for a different duration tier would be a WRONG
       Foray rather than a slow one. */
    expect(calls).toBe(1);
  });

  it("is inert with no store and with no key", async () => {
    const noStore = await CheckpointSession.open(undefined, "k", FP);
    const noKey = await CheckpointSession.open(new FakeCheckpointStore(FP), undefined, FP);
    for (const session of [noStore, noKey]) {
      let calls = 0;
      const { value, resumed } = await session.stage("spine", parsePayload, async () => {
        calls++;
        return { n: 1 };
      });
      expect({ value, resumed, calls }).toEqual({ value: { n: 1 }, resumed: false, calls: 1 });
      expect(session.resumed()).toEqual([]);
    }
  });

  it("never fails a stage because the store could not be read or written", async () => {
    /* The cost of a lost checkpoint is one repeated stage. The cost of
       throwing here is the whole Foray, which is the bug F-17 is about. */
    const broken: CheckpointStore = {
      load() {
        throw new Error("disk gone");
      },
      save() {
        throw new Error("disk still gone");
      }
    };
    const session = await CheckpointSession.open(broken, "k", FP);
    const { value } = await session.stage("spine", parsePayload, async () => ({ n: 5 }));
    expect(value).toEqual({ n: 5 });
  });

  it("resumeSync/save give a parallel stage per-unit resume", async () => {
    const store = new FakeCheckpointStore(FP);
    store.save("k", "deepen:1", { n: 11 });
    const session = await CheckpointSession.open(store, "k", FP);

    expect(session.resumeSync("deepen:0", parsePayload)).toBeUndefined();
    expect(session.resumeSync("deepen:1", parsePayload)).toEqual({ n: 11 });
    await session.save("deepen:0", { n: 10 });
    expect(session.resumeSync("deepen:0", parsePayload)).toEqual({ n: 10 });
    expect(session.resumed()).toContain("deepen:1");
  });
});

describe("checkpointFingerprint", () => {
  it("is stable for the same request and different for a changed one", () => {
    const base = { prompt: "p", duration: "medium" };
    expect(checkpointFingerprint(base)).toBe(checkpointFingerprint({ ...base }));
    expect(checkpointFingerprint(base)).not.toBe(checkpointFingerprint({ ...base, duration: "long" }));
    expect(checkpointFingerprint(base)).not.toBe(checkpointFingerprint({ ...base, prompt: "q" }));
    expect(checkpointFingerprint(base)).not.toBe(checkpointFingerprint({ ...base, topic: "food/grilling-bbq" }));
  });
});

describe("FileCheckpointStore", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "foray-checkpoint-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes one <basename>.checkpoint.json beside the candidate", () => {
    const store = new FileCheckpointStore(dir, FP);
    store.save("grilling-abc12345", "spine", { n: 1 });
    const file = path.join(dir, "grilling-abc12345.checkpoint.json");
    expect(fs.existsSync(file)).toBe(true);
    expect(store.filePathFor("grilling-abc12345")).toBe(file);
  });

  it("accumulates stages across saves rather than replacing the file", () => {
    const store = new FileCheckpointStore(dir, FP);
    store.save("k", "understand", { n: 1 });
    store.save("k", "spine", { n: 2 });
    store.save("k", "deepen:0", { n: 3 });
    const loaded = store.load("k")!;
    expect(Object.keys(loaded.stages).sort()).toEqual(["deepen:0", "spine", "understand"]);
  });

  it("leaves no .tmp file behind", () => {
    const store = new FileCheckpointStore(dir, FP);
    store.save("k", "spine", { n: 1 });
    expect(fs.readdirSync(dir)).toEqual(["k.checkpoint.json"]);
  });

  it("returns null for a missing file, unreadable JSON, or a foreign shape", () => {
    const store = new FileCheckpointStore(dir, FP);
    expect(store.load("nothing-here")).toBeNull();
    fs.writeFileSync(path.join(dir, "broken.checkpoint.json"), "{ not json");
    expect(store.load("broken")).toBeNull();
    fs.writeFileSync(path.join(dir, "foreign.checkpoint.json"), JSON.stringify({ hello: "world" }));
    expect(store.load("foreign")).toBeNull();
  });

  it("drops stages from a checkpoint written for a different request", () => {
    new FileCheckpointStore(dir, FP).save("k", "spine", { n: 1 });
    const other = new FileCheckpointStore(dir, checkpointFingerprint({ prompt: "different", duration: "medium" }));
    other.save("k", "understand", { n: 2 });
    expect(Object.keys(other.load("k")!.stages)).toEqual(["understand"]);
  });

  it("discards the file once the candidate exists", () => {
    const store = new FileCheckpointStore(dir, FP);
    store.save("k", "spine", { n: 1 });
    store.discard("k");
    expect(store.load("k")).toBeNull();
    expect(() => store.discard("k")).not.toThrow();
  });
});

