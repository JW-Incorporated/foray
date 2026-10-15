import type { SpineJudge, SpineJudgeChoice, SpineJudgeInput } from "../../src/generation/bestOfSpine";

/**
 * GV-91: a scripted SpineJudge. Offline: it never calls a model. Each call
 * takes the next script step (the last one repeats):
 *   - { choose: 0 | 1 }  answers with that index in the PRESENTED order
 *   - { throw: message } rejects
 *   - { hang: true }     never settles (the wrapper's judge timeout fires)
 * Every input is kept in `inputs`, so a test can read the question and the
 * rendered candidates the judge was shown.
 */
export type FakeSpineJudgeStep =
  | { choose: 0 | 1; confidence?: number; probabilities?: number[]; requestId?: string }
  | { throw: string }
  | { hang: true };

export class FakeSpineJudge implements SpineJudge {
  readonly kind = "fake";
  readonly inputs: SpineJudgeInput[] = [];
  private step = 0;

  constructor(private readonly script: FakeSpineJudgeStep[] = [{ choose: 0 }]) {}

  get calls(): number {
    return this.inputs.length;
  }

  async choose(input: SpineJudgeInput): Promise<SpineJudgeChoice> {
    this.inputs.push(input);
    const s = this.script[Math.min(this.step++, this.script.length - 1)] ?? { choose: 0 as const };
    if ("hang" in s) return new Promise<SpineJudgeChoice>(() => undefined);
    if ("throw" in s) throw new Error(s.throw);
    return {
      index: s.choose,
      ms: 1,
      ...(s.confidence !== undefined ? { confidence: s.confidence } : {}),
      ...(s.probabilities !== undefined ? { probabilities: s.probabilities } : {}),
      ...(s.requestId !== undefined ? { requestId: s.requestId } : {})
    };
  }
}
