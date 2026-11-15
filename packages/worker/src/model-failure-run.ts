// TE-F2 part B (M2, release 0.5.19; DECISIONS 161): the failure-pack runner. It runs the customer's command ONCE PER FAILURE MODE through an injected runner (the caller points the command's client at the helper's `/f/<mode>` base
// URL with `modelFailureBaseUrl`, model-helper-env.ts) and returns informational lines: "handled" (the command exited 0), "not handled" (it exited non-zero) or "not run" (it timed out, was stopped or could not run), per mode.
// NEVER "proven": the failure pack informs, it never proves a change (`replyCountsTowardProof` is false for it, pinned in the contracts' tests). Wiring this to a check kind waits for TE-A3's registry: this is the typed seam.
import { FAILURE_MODES, REPLY_PROVENANCE_LABELS, replyCountsTowardProof, type FailureMode } from "@agentx/contracts";

export type FailureRunOutcome = "handled" | "not_handled" | "not_run";
export interface FailureRunCommandResult {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
}
export interface FailureRunInput {
  /** Which modes to run; default all five. */
  readonly modes?: readonly FailureMode[];
  /** Runs the customer's command with its model client pointed at the failure base URL of `mode`. May reject. */
  readonly run: (mode: FailureMode, signal: AbortSignal) => Promise<FailureRunCommandResult>;
  readonly signal?: AbortSignal;
}
export interface FailureRunResult {
  readonly outcomes: ReadonlyArray<{ readonly mode: FailureMode; readonly outcome: FailureRunOutcome }>;
  /** Fixed words only. */
  readonly lines: readonly string[];
  /** Always false: the failure pack never counts. */
  readonly countsTowardProof: false;
}

const WORDS: Record<FailureRunOutcome, string> = { handled: "handled", not_handled: "not handled", not_run: "not run" };

export async function runModelFailurePack(input: FailureRunInput): Promise<FailureRunResult> {
  const signal = input.signal ?? new AbortController().signal;
  const outcomes: Array<{ mode: FailureMode; outcome: FailureRunOutcome }> = [];
  for (const mode of input.modes ?? FAILURE_MODES) {
    let outcome: FailureRunOutcome;
    if (signal.aborted) outcome = "not_run";
    else {
      try {
        const result = await input.run(mode, signal);
        outcome = result.timedOut || result.exitCode === null ? "not_run" : result.exitCode === 0 ? "handled" : "not_handled";
      } catch {
        outcome = "not_run";
      }
    }
    outcomes.push({ mode, outcome });
  }
  const lines = [REPLY_PROVENANCE_LABELS.failure_pack, ...outcomes.map((entry) => `failure pack, ${entry.mode.replace(/_/gu, " ")}: ${WORDS[entry.outcome]}`)];
  // The class never counts, whatever the outcomes are.
  return { outcomes, lines, countsTowardProof: replyCountsTowardProof("failure_pack") as false };
}
