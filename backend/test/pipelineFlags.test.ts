import { describe, it, expect, afterEach } from "vitest";
import * as crypto from "crypto";
import {
  CLASSIC_PIPELINE_FLAGS,
  FAST_PATH_PIPELINE_FLAGS,
  PIPELINE_FLAG_ENV,
  checkpointVariant,
  readPipelineFlags,
  resolvePipelineFlags,
  type FoldDeepen,
  type PipelineFlags
} from "../src/generation/pipelineFlags";
import { checkpointFingerprint } from "../src/generation/checkpoint";
import { DEFAULT_SEED_FLOOR_REASKS } from "../src/generation/postSeedSpine";

/**
 * GV-15 (W4-01): the pipeline flags, the fast-path umbrella and the
 * checkpoint variant. Each test names the mutation it kills.
 */

afterEach(() => {
  for (const name of Object.values(PIPELINE_FLAG_ENV)) delete process.env[name];
});

describe("readPipelineFlags", () => {
  /* Kills: any field defaulting to anything but today's behaviour. */
  it("with nothing set, every flag is today's pipeline", () => {
    expect(readPipelineFlags({})).toEqual({
      fastPath: false,
      foldSpineCopy: false,
      foldDeepen: "off",
      perActPipeline: false,
      narrationOrder: "parallel",
      writerStream: false,
      roundPolicy: "default",
      tierRuntimeCap: false,
      tierFitGate: false,
      spineBestOf: 1,
      spineSeedFloorReasksOnTimedPath: DEFAULT_SEED_FLOOR_REASKS
    });
    expect(readPipelineFlags({})).toEqual(CLASSIC_PIPELINE_FLAGS);
  });

  /* Kills: the umbrella missing one of its listed defaults, or setting
     tierFitGate / spineBestOf, which it must not. */
  it("FORAY_FAST_PATH=1 yields the listed fast-path defaults", () => {
    expect(readPipelineFlags({ FORAY_FAST_PATH: "1" })).toEqual({
      fastPath: true,
      foldSpineCopy: true,
      foldDeepen: "short",
      perActPipeline: true,
      narrationOrder: "sequential",
      writerStream: true,
      roundPolicy: "timed",
      tierRuntimeCap: true,
      tierFitGate: false,
      spineBestOf: 1,
      spineSeedFloorReasksOnTimedPath: 0
    });
    expect(readPipelineFlags({ FORAY_FAST_PATH: "0" })).toEqual(CLASSIC_PIPELINE_FLAGS);
  });

  /* Kills: a per-field reader that uses the classic default instead of the
     umbrella's base, or the umbrella overriding an explicit per-field value. */
  it("each per-field variable overrides the umbrella", () => {
    const overrides: [string, string, keyof PipelineFlags, unknown][] = [
      ["FORAY_SPINE_FOLD_COPY", "0", "foldSpineCopy", false],
      ["FORAY_SPINE_FOLD_DEEPEN", "all", "foldDeepen", "all"],
      ["FORAY_PER_ACT_PIPELINE", "0", "perActPipeline", false],
      ["FORAY_NARRATION_ORDER", "parallel", "narrationOrder", "parallel"],
      ["FORAY_WRITER_STREAM", "0", "writerStream", false],
      ["FORAY_ROUND_POLICY", "default", "roundPolicy", "default"],
      ["FORAY_TIER_RUNTIME_CAP", "0", "tierRuntimeCap", false],
      ["FORAY_GATE_TIER_FIT", "1", "tierFitGate", true],
      ["FORAY_SPINE_BEST_OF", "2", "spineBestOf", 2]
    ];
    for (const [name, raw, field, expected] of overrides) {
      const flags = readPipelineFlags({ FORAY_FAST_PATH: "1", [name]: raw });
      expect(flags[field], name).toEqual(expected);
      expect({ ...flags, [field]: FAST_PATH_PIPELINE_FLAGS[field] }, name).toEqual(FAST_PATH_PIPELINE_FLAGS);
    }
  });

  /* Kills: a per-field variable that only works under the umbrella, or a
     field read from the wrong variable name. */
  it("each per-field variable turns its own field on without the umbrella", () => {
    const flags = readPipelineFlags({
      FORAY_SPINE_FOLD_COPY: "1",
      FORAY_SPINE_FOLD_DEEPEN: "short",
      FORAY_PER_ACT_PIPELINE: "true",
      FORAY_NARRATION_ORDER: "sequential",
      FORAY_WRITER_STREAM: "on",
      FORAY_ROUND_POLICY: "timed",
      FORAY_TIER_RUNTIME_CAP: "1",
      FORAY_GATE_TIER_FIT: "1",
      FORAY_SPINE_BEST_OF: "2"
    });
    expect(flags).toEqual({
      ...CLASSIC_PIPELINE_FLAGS,
      foldSpineCopy: true,
      foldDeepen: "short",
      perActPipeline: true,
      narrationOrder: "sequential",
      writerStream: true,
      roundPolicy: "timed",
      tierRuntimeCap: true,
      tierFitGate: true,
      spineBestOf: 2
    });
  });

  /* Kills: any reader falling back on a malformed value, or an error that
     carries the value. */
  it("a malformed value throws naming the variable and never the value", () => {
    for (const name of Object.values(PIPELINE_FLAG_ENV)) {
      let message = "";
      try {
        readPipelineFlags({ [name]: "zz-bogus-7" });
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message, name).toContain(name);
      expect(message, name).not.toContain("zz-bogus-7");
    }
    expect(() => readPipelineFlags({ FORAY_SPINE_BEST_OF: "3" })).toThrow(/FORAY_SPINE_BEST_OF/);
  });

  /* Kills: binding `env = process.env` at import (a snapshot). */
  it("reads process.env at call time by default", () => {
    expect(readPipelineFlags().foldSpineCopy).toBe(false);
    process.env.FORAY_SPINE_FOLD_COPY = "1";
    expect(readPipelineFlags().foldSpineCopy).toBe(true);
  });
});

describe("resolvePipelineFlags", () => {
  /* Kills: an override fastPath that sets only the field and not the
     umbrella's defaults (then `--fast-path` would change nothing). */
  it("an override fastPath brings the umbrella, and per-field env still wins", () => {
    expect(resolvePipelineFlags({ fastPath: true }, {})).toEqual(FAST_PATH_PIPELINE_FLAGS);
    expect(resolvePipelineFlags({ fastPath: true }, { FORAY_SPINE_FOLD_DEEPEN: "off" }).foldDeepen).toBe("off");
    expect(resolvePipelineFlags({ fastPath: false }, { FORAY_FAST_PATH: "1" })).toEqual(CLASSIC_PIPELINE_FLAGS);
  });

  /* Kills: env winning over an explicit override, or undefined overrides
     erasing env values. */
  it("override fields win over env, undefined ones do not erase it, a full set passes through", () => {
    expect(resolvePipelineFlags({ foldSpineCopy: false }, { FORAY_SPINE_FOLD_COPY: "1" }).foldSpineCopy).toBe(false);
    expect(resolvePipelineFlags({ foldSpineCopy: undefined }, { FORAY_SPINE_FOLD_COPY: "1" }).foldSpineCopy).toBe(true);
    const full: PipelineFlags = { ...FAST_PATH_PIPELINE_FLAGS, writerStream: false, spineBestOf: 2 };
    expect(resolvePipelineFlags(full, { FORAY_WRITER_STREAM: "1", FORAY_FAST_PATH: "0" })).toEqual(full);
  });
});

describe("checkpointVariant", () => {
  /* Kills: a variant set by a flag that does not change what a stage banks,
     or a non-undefined value (e.g. "") for an all-off set. */
  it("is undefined when every semantics-changing flag is off", () => {
    expect(checkpointVariant(CLASSIC_PIPELINE_FLAGS)).toBeUndefined();
    const reachOnly: PipelineFlags = {
      ...CLASSIC_PIPELINE_FLAGS,
      narrationOrder: "sequential",
      writerStream: true,
      roundPolicy: "timed",
      tierRuntimeCap: true,
      tierFitGate: true,
      spineBestOf: 2,
      spineSeedFloorReasksOnTimedPath: 0
    };
    expect(checkpointVariant(reachOnly)).toBeUndefined();
  });

  /* Kills: dropping any one of the three inputs, or collapsing 'short' and
     'all'. */
  it("gives a different value for each combination of foldSpineCopy, foldDeepen and perActPipeline", () => {
    const seen = new Set<string | undefined>();
    let combos = 0;
    for (const foldSpineCopy of [false, true]) {
      for (const foldDeepen of ["off", "short", "all"] as FoldDeepen[]) {
        for (const perActPipeline of [false, true]) {
          combos++;
          seen.add(checkpointVariant({ foldSpineCopy, foldDeepen, perActPipeline }));
        }
      }
    }
    expect(combos).toBe(12);
    expect(seen.size).toBe(12);
  });
});

describe("checkpointFingerprint variant", () => {
  const input = { prompt: "the history of grilling", duration: "medium", topic: "food/grilling-bbq" };

  /* Kills: any change to the classic hashed string (a classic banked run
     would stop resuming). The literal is the pre-GV-15 hash. */
  it("without a variant the hash is byte-identical to before", () => {
    expect(checkpointFingerprint(input)).toBe("1f8c63c986bd");
    expect(checkpointFingerprint({ ...input, variant: undefined })).toBe("1f8c63c986bd");
    expect(checkpointFingerprint({ ...input, variant: "" })).toBe("1f8c63c986bd");
    expect(checkpointFingerprint(input)).toBe(
      crypto.createHash("sha1").update(`${input.prompt}\n${input.duration}\n${input.topic}`).digest("hex").slice(0, 12)
    );
  });

  /* Kills: a fingerprint that ignores the variant (banked runs would resume
     across modes). */
  it("each variant gets its own fingerprint", () => {
    const a = checkpointFingerprint({ ...input, variant: "foldCopy" });
    const b = checkpointFingerprint({ ...input, variant: "foldCopy;perAct" });
    expect(new Set([checkpointFingerprint(input), a, b]).size).toBe(3);
  });
});
