import { AUTO_FIX_BLOCK_CAUSES, type AutoFixBlockCause, type WorkflowSnapshot } from "@agentx/contracts";
import { workflowDispatchItem, type WorkflowDispatchRecord } from "./broker-shared.js";

/**
 * DISPATCHEXHAUST: three ways a task blocks in VERIFY or REVIEW that no finished run wrote, and so never reached the automatic-fix policy (LIVEFIX-1 review, M-1):
 *   - `dispatch-exhausted`: the start of the checks or reviews failed `WORKFLOW_DISPATCH_MAX_ATTEMPTS` times (an infrastructure fault);
 *   - `run-lost`: the runner lost the task partway through the run (an infrastructure fault);
 *   - `owner-stopped`: the owner stopped the run (their choice).
 * Each now commits an AUTOFIX dispatch row in the same transaction as the block, carrying the cause. The policy reads the cause as the whole classification of the block
 * (`AutoFixFacts.blockCause`): the two infrastructure faults get the existing single automatic retry (`autoRetryChecksFromSystem` / `autoRetryReviewsFromSystem`, with their per-stage and
 * per-candidate limit, the six-action limit, the spend cap and the day budget, and their derived request IDs), after a delay; a second block of the same candidate asks; the owner's stop
 * never retries and never sends back. A cause is never a fault of the code, so none of them can send the work back to coding.
 *
 * Every function here only builds the rows. The row is run by the broker's `runAutofixDispatch` (the sweep, or the look right after a block); a row written while automatic fixing is off is
 * removed there, unlooked at.
 */

/** How long the one automatic retry of an infrastructure fault waits: long enough for a lost runner or a busy queue to come back, short of the notifier's hold on the blocked card. */
export const DISPATCH_EXHAUST_RETRY_DELAY_MS = 3 * 60_000;

type PutItem = ReturnType<typeof workflowDispatchItem>;

/** A cause read from a stored row; anything this code does not know (a newer writer's) reads as no cause. */
export function autofixBlockCauseOf(value: unknown): AutoFixBlockCause | undefined {
  return (AUTO_FIX_BLOCK_CAUSES as readonly unknown[]).includes(value) ? value as AutoFixBlockCause : undefined;
}

/** Whether an AUTOFIX row is still inside the delay of its automatic retry. A row with no (or an unreadable) hold is never held. */
export function autofixRowHeld(row: Pick<WorkflowDispatchRecord, "autofixNotBefore">, nowMs: number): boolean {
  if (row.autofixNotBefore === undefined) return false;
  const until = Date.parse(row.autofixNotBefore);
  return Number.isFinite(until) && until > nowMs;
}

/** The workflow fields a row is made from. */
type Step = Pick<WorkflowSnapshot, "taskId" | "revision" | "stage" | "candidate">;

/** The step as the block will leave it: the next revision of the same stage and candidate (blocking only moves the revision). */
const blockedStep = (current: Step): Step => ({ taskId: current.taskId, revision: current.revision + 1, stage: current.stage, candidate: current.candidate });

/**
 * The AUTOFIX row for a block, given the workflow as the block leaves it (`blocked.revision` is the revision the block commits at). Nothing for a step the policy does not look at.
 * The two infrastructure causes are held for `DISPATCH_EXHAUST_RETRY_DELAY_MS`: the row is not due, and a look right after the block finds it held, until then.
 */
export function autofixBlockRows(tableName: string, blocked: Step, cause: AutoFixBlockCause | undefined, now: string): PutItem[] {
  if (blocked.stage !== "VERIFY" && blocked.stage !== "REVIEW") return [];
  const row = workflowDispatchItem(tableName, blocked.taskId, blocked.revision, "AUTOFIX", blocked.candidate?.digest ?? "0".repeat(64), now);
  if (cause === undefined) return [row];
  const item = (row as { Put: { Item: Record<string, unknown> } }).Put.Item;
  item.autofixCause = cause;
  if (cause !== "owner-stopped") {
    const holdUntil = new Date(Date.parse(now) + DISPATCH_EXHAUST_RETRY_DELAY_MS).toISOString();
    item.autofixNotBefore = holdUntil;
    item.nextAttemptAt = holdUntil;
    item.dispatchDueSk = `${holdUntil}#${String(item.sk)}`;
  }
  return [row];
}

/** The broker's own dependencies, as far as the rows need them. */
interface RowDependencies { tableName: string; autofix?: { enabled: boolean } | undefined }

/**
 * recordWorkflowDispatchFailure, budget spent: the row for the block written with it. A plain reason of a deterministic refusal (`exhaustedReason`) is classified by its text as every
 * refusal is, with no cause; the generic give-up is the infrastructure fault.
 */
export function dispatchExhaustRows(dependencies: RowDependencies, item: Pick<WorkflowDispatchRecord, "kind">, current: Step, exhaustedReason: string | undefined, now: string): PutItem[] {
  if (dependencies.autofix?.enabled !== true || (item.kind !== "CHECKS" && item.kind !== "REVIEW")) return [];
  return autofixBlockRows(dependencies.tableName, blockedStep(current), exhaustedReason === undefined ? "dispatch-exhausted" : undefined, now);
}

/** The owner stopped a step that was waiting or running in VERIFY or REVIEW: the row that carries the explanation. */
export function ownerStopRows(dependencies: RowDependencies, current: Step, now: string): PutItem[] {
  return dependencies.autofix?.enabled === true ? autofixBlockRows(dependencies.tableName, blockedStep(current), "owner-stopped", now) : [];
}

/**
 * The installation switch as `autofixConfigFromEnvironment` reads it (on unless `AUTOFIX_ENABLED=false`). It is read again here, not imported, because the runner pulls in the whole task route
 * (which imports the modules that call these functions); a test holds the two readings equal.
 */
export const autofixSwitchOn = (env: Readonly<Record<string, string | undefined>>): boolean => env.AUTOFIX_ENABLED?.trim().toLowerCase() !== "false";

/**
 * A run that ended without its own result (the dispatcher gave up delivering it, its compute was lost, the stuck-cancel release): `FAILED` is a lost run, `CANCELLED` and `INTERRUPTED`
 * are the owner's stop and its failed stop. The Lambdas that write these blocks have no broker configuration, so the installation switch is read from the environment as the broker does;
 * a row written while it is off is removed by the broker unlooked at.
 */
export function endedRunRows(tableName: string, current: Step, endedAs: "CANCELLED" | "INTERRUPTED" | "FAILED", now: string, env: Readonly<Record<string, string | undefined>> = process.env): PutItem[] {
  if (!autofixSwitchOn(env)) return [];
  return autofixBlockRows(tableName, blockedStep(current), endedAs === "FAILED" ? "run-lost" : "owner-stopped", now);
}
