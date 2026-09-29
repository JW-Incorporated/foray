/* The exit status a launcher passes through from the child it ran
 * (round-3 audit data-tools-8).
 *
 * Node's `exit` event gives `(code, signal)`, and a child ended by a signal
 * (the OOM killer, Task Manager, SIGKILL, or the launcher's own SIGINT
 * forwarding) has `code === null`. Both launchers used `code ?? 0`, so an
 * aborted driver or warmer reported success, and `warm-transcript-index`
 * documents its exit code as the thing a caller gates a run on.
 *
 * A signal becomes the shell convention 128 + its number (130 for SIGINT,
 * 137 for SIGKILL); an unknown signal, or no code and no signal at all, is 1.
 */
import os from "node:os";

export function exitCodeFor(code, signal) {
  if (typeof code === "number") return code;
  if (signal) {
    const n = os.constants.signals[signal];
    return typeof n === "number" ? 128 + n : 1;
  }
  return 1;
}

/** What the launcher prints: the code, and the signal when there was one. */
export function describeExit(code, signal) {
  return signal ? `with signal ${signal} (exit ${exitCodeFor(code, signal)})` : `${exitCodeFor(code, signal)}`;
}
