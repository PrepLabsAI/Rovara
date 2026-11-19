// Port lane L7a: the read allowance of a tracking pass and the answer of a sweep step. Same shapes as Cloud's `aws/workflow-merge-recovery.ts` (the sweep itself is the runtime's).
import type { ReadBudget } from "@agentx/contracts";

/** A tracking pass's allowance of requests to the code host (one `beforeRequest` for each), and the signal that stops them. */
export type MergeReadBudget = ReadBudget;

export type MergeRecoveryResult =
  /** `nextAt` (a tracking row only): when the row must be looked at again if nothing wakes it sooner. */
  | { kind: "OBSERVED"; nextAt?: number }
  | { kind: "RETRY"; retryAt: number; scope: "task" | "github-global" }
  | { kind: "TERMINAL"; release: "confirmed" | "queued" }
  | { kind: "MISSING" };

/** How often a task's merge is observed even when nothing woke it. */
export const SWEEP_INTERVAL_MS = 5 * 60_000;
