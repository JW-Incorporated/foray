import type { DraftCritic, DraftCritiqueAnswer, DraftCritiqueQuestion } from "../../src/generation/selfCritique";

/**
 * GV-94: a scripted DraftCritic, keyed by sentence. Offline: it never calls
 * a model. The first rule whose `match` fits a question's sentence (a string
 * matches exactly, a RegExp by `test`) answers it:
 *   - { p }      answers with that probability
 *   - { throw }  rejects with that message
 * A sentence no rule matches is answered with `defaultP` (supported).
 * Every question is kept in `questions`, so a test can read the sentence
 * and the sources the critic was shown.
 */
export type FakeDraftCriticRule = { match: string | RegExp } & ({ p: number } | { throw: string });

export class FakeDraftCritic implements DraftCritic {
  readonly kind = "fake";
  readonly questions: DraftCritiqueQuestion[] = [];

  constructor(
    private readonly rules: FakeDraftCriticRule[] = [],
    private readonly defaultP = 0.9
  ) {}

  get calls(): number {
    return this.questions.length;
  }

  async supported(question: DraftCritiqueQuestion): Promise<DraftCritiqueAnswer> {
    this.questions.push(question);
    const rule = this.rules.find((r) => (typeof r.match === "string" ? r.match === question.sentence : r.match.test(question.sentence)));
    if (rule && "throw" in rule) throw new Error(rule.throw);
    return { p: rule ? rule.p : this.defaultP, ms: 1, requestId: `fake-${this.questions.length}` };
  }
}
