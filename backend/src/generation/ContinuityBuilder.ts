/**
 * §4.8 cross-act continuity collaborator (docs/curation/generation-
 * architecture.md §4.8 / §5 / §6.2). §5's topology table calls for
 * exactly ONE continuity agent, run at act boundaries: "Act seams are
 * the only place no single act agent has context." Unlike every other
 * generation-stage collaborator in this codebase (SpineBuilder,
 * DeepenActBuilder, NarrationWriterBuilder...), this one is invoked
 * PER BOUNDARY (acts.length - 1 times for an N-act Foray), not once for
 * the whole Foray and not once per act — a boundary is the unit that
 * needs smoothing, and each boundary's two sides (the act just finished
 * being deepened, and the act about to be built/played) are the only
 * context it needs.
 *
 * FORWARD-ONLY, STRUCTURALLY (§6.2: "the continuity agent becomes
 * forward-only. It runs at each act boundary and may adjust the act
 * about to be built, never the one already played."): this interface's
 * method signature only returns a replacement for `nextIntroduction` —
 * there is no return slot for a revised `previousExit`. A builder simply
 * cannot hand back a rewritten previous act even if it wanted to; the
 * enforcement is the shape of the contract, not a runtime check on the
 * builder's output. `smoothSeam.ts`'s orchestrator additionally never
 * re-reads or re-writes `previousAct` after calling this, so the
 * immutability holds end to end, not just at this interface's boundary.
 *
 * WHY A GENUINE LLM CALL (unlike stitchAct.ts's deterministic within-act
 * rules): smoothing two independently-written strings — one act's own
 * `exit` and the next act's own `introduction` (both produced by §4.4's
 * DeepenActBuilder, per act, with no cross-act awareness) — into actual
 * connected prose is a judgement call about phrasing and callback, not
 * a checkable structural property. That is exactly the line §4.8 itself
 * draws ("the stitching agent has real authority here: it may rewrite
 * the leading and trailing sentences of any narration page it owns")
 * and the line PR #408 (sourceBeats.ts) draws the other way for
 * deterministic logic — see stitchAct.ts's own doc comment for why THAT
 * module skips the Builder pattern instead.
 */
export interface ContinuityBuilder {
  readonly providerName: string;

  /**
   * Smooths ONE act boundary: `previousAct`'s own `exit` (already
   * played, or about to finish playing — never rewritten here) and
   * `nextAct`'s own `introduction` (not yet played — the only side this
   * call may change) into a connected seam. Returns ONLY a replacement
   * `nextIntroduction` string — see the module doc comment for why the
   * shape itself is what makes this forward-only.
   */
  smoothSeam(request: ContinuitySmoothRequest, ctx: ContinuityBuildContext): Promise<ContinuitySmoothResult>;
}

export interface ContinuitySmoothRequest {
  /** The act that just finished (or is about to finish) playing.
   * Read-only context — never mutated, never returned. */
  previousActExit: string;
  previousActTitle: string;
  /** The act about to be built/played — the ONLY side this call may
   * change. */
  nextActIntroduction: string;
  nextActTitle: string;
}

export interface ContinuitySmoothResult {
  /** The seam-adjusted replacement for `nextActIntroduction`. Must still
   * be a real introduction to `nextActTitle` — see `validateSmoothedSeam`
   * in `smoothSeam.ts` for the structural checks applied to it. */
  nextIntroduction: string;
}

export interface ContinuityBuildContext {
  userId: string;
  sessionId?: string;
}
