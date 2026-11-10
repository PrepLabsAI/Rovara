// Lane L10, the build step: what Rovara does by itself when checks or reviews block (Cloud's `workflow-autofix-runner.ts`, the policy in `@agentx/contracts` `workflow-autofix.ts`).
//
// The owner's rule (2026-10-23, failure handling): a code fault is sent back to the coding agent by Rovara at most twice per approved plan, then it asks; a one-off hiccup of the checks or
// the reviews is retried once; an unclear fault, a person's job or a reached limit is asked about, with what failed. It never approves, skips, publishes, picks optional checks or acts in a plan
// review or a pull request: the only moves are the two below (and an ask), each of which holds the policy's limits again itself.
//
// What Code does not have, and so what the facts leave out: the original-code (baseline) round (an unclear check fault is asked about rather than waited on; the plan's dry run of its proposed checks on the unchanged code tells the code's fault from the rest when it was recorded),
// the browser and API checks, and Cloud's day budgets (the room is always "yes").
import {
  AUTO_FIX_DEFAULT_CAP_USD, WorkflowTransitionError, autoFixDecision, change, returnWorkflowToImplementationAutomatically, wholeTaskSpendUsd, when, workflowAutomaticRetryDecision,
  type AutoFixAskReason, type AutoFixCode, type AutoFixDecision, type AutoFixFacts, type OriginalCodeResult, type WorkflowAutoSpend, type WorkflowSnapshot,
} from "@agentx/contracts";
import { loadPlanSelfCheck } from "../../developer/plan-self-check.js";
import { textReaderOf } from "./plan-input.js";
import { AutoFixAskSchema, autoFixRetryReason, autoFixSendBackReason } from "../../developer/autofix-messages.js";
import type { TaskFlowDeps } from "../task-flow/deps.js";
import { dispatchRowItem, resolveRowItem } from "../task-flow/dispatch-rows.js";
import { dispatchRowKey, taskKey } from "../task-flow/keys.js";
import { fromDocument, type DispatchRowRecord } from "../task-flow/records.js";
import { readTask } from "../task-flow/reads.js";
import { commitWorkflow, runDispatchRow, type StepStart } from "../task-flow/stage-machine.js";
import { iso, log } from "../task-flow/support.js";
import { toDocument } from "../task-flow/records.js";
import { startChecksRerun, startReview } from "./start.js";

/** One more automatic round: a coding run, the checks and two reviews. A deliberately high figure; the cap is checked against spend plus this. */
export const AUTOFIX_ROUND_ESTIMATE_USD = 3;

export type AutofixOutcome = "DISABLED" | "STALE" | "NONE" | "SENT_BACK" | "RETRIED" | "DUPLICATE" | "ASKED";

async function writeAsk(deps: TaskFlowDeps, taskId: string, revision: number, reason: AutoFixAskReason, codes: readonly AutoFixCode[], at: string): Promise<boolean> {
  const ask = AutoFixAskSchema.parse({ workflowRevision: revision, reason, codes: [...codes].slice(0, 30), at });
  // Only while the task is still blocked at the revision the fixing looked at: the owner may have acted first, and then there is nothing left to ask about.
  const written = await deps.store.update({
    key: taskKey(taskId), ops: [change.set("autofixAsk", toDocument(ask))],
    condition: when.and(when.eq(["workflow", "revision"], revision), when.eq(["workflow", "state"], "BLOCKED"), when.notExists("closedAt")),
  });
  return written.applied;
}

/** What a proposed check did on the original code, from the dry run recorded beside the approved plan. Empty when none was recorded (or the record cannot be trusted). */
async function proposedCheckOriginals(deps: TaskFlowDeps, workflow: WorkflowSnapshot): Promise<Record<string, OriginalCodeResult>> {
  const plan = workflow.artifacts.filter((artifact) => artifact.type === "plan").at(-1);
  if (plan === undefined || deps.artifacts === undefined) return {};
  const read = textReaderOf(deps.artifacts);
  const view = await loadPlanSelfCheck((key) => read(key, 70_000), plan);
  return Object.fromEntries(Object.entries(view.tried).map(([checkId, result]) => [checkId, result === "passed" ? "passed" as const : result === "failed" ? "failed" as const : "cannot-run" as const]));
}

/** Looks at one blocked VERIFY or REVIEW once, and acts or asks. Never throws for a task that moved on. */
export async function runAutofix(deps: TaskFlowDeps, row: { taskId: string; workflowRevision: number }): Promise<StepStart> {
  const done = async (result: AutofixOutcome): Promise<StepStart> => {
    // The row goes whatever was decided, unless the move itself already took it (a send back or a retry resolves it in its own transaction).
    await deps.store.transact([resolveRowItem(deps, row.taskId, row.workflowRevision)]).catch(() => undefined);
    log(deps, { event: "autofix.decided", taskId: row.taskId, revision: row.workflowRevision, outcome: result });
    return result === "STALE" ? "STALE" : "STARTED";
  };
  const config = deps.autofix ?? {};
  if (config.enabled === false) return done("DISABLED");
  const task = await readTask(deps, row.taskId);
  const workflow = task?.workflow;
  if (task === undefined || task.closedAt !== undefined || workflow === undefined || workflow.revision !== row.workflowRevision || workflow.state !== "BLOCKED" || (workflow.stage !== "VERIFY" && workflow.stage !== "REVIEW")) return done("STALE");
  const stage: "VERIFY" | "REVIEW" = workflow.stage;
  // The whole task's spend, when it can be told; nothing priced counts as nothing spent, and the count limits alone then bound the rounds.
  let spent: number | undefined;
  try { spent = deps.taskSpendUsd === undefined ? 0 : (await deps.taskSpendUsd(task.taskId)) ?? 0; } catch { spent = undefined; }
  const spend: WorkflowAutoSpend = { spentUsd: wholeTaskSpendUsd(spent ?? Number.NaN), roundEstimateUsd: config.roundEstimateUsd ?? AUTOFIX_ROUND_ESTIMATE_USD, capUsd: config.capUsd ?? AUTO_FIX_DEFAULT_CAP_USD };
  // How the block came about when no finished run wrote it (the row says so): a lost run is the infrastructure's, one automatic retry, never a send back to coding.
  const row_ = fromDocument<DispatchRowRecord>(await deps.store.get(dispatchRowKey(deps.companyId, row.taskId, row.workflowRevision)));
  const facts: AutoFixFacts = row_?.cause === undefined ? {} : { blockCause: row_.cause };
  let first = autoFixDecision(workflow, facts, { enabled: true, spend, dayBudgetHasRoom: true, baselineRequests: 1 });
  // An unclear check fault is told from the code's own by what the plan's dry run found: a proposed check that already failed (or could not run) on the unchanged code is not the change's fault. The dry run is
  // recorded beside the plan the owner approved (Cloud's `proposedCheckOriginals`); a task without one leaves the fault unclear.
  if (first.action !== "NONE" && first.codes.includes("check-failed-cause-unknown")) {
    const originals = await proposedCheckOriginals(deps, workflow);
    if (Object.keys(originals).length > 0) {
      facts.checkOriginal = originals;
      first = autoFixDecision(workflow, facts, { enabled: true, spend, dayBudgetHasRoom: true, baselineRequests: 1 });
    }
  }
  // There is no original-code round in Code, so an unclear fault is the owner's to settle.
  const decision: AutoFixDecision = first.action === "WAIT_FOR_BASELINE" || first.action === "REQUEST_BASELINE" ? { action: "ASK", reason: "unclear-fault", codes: first.codes } : first;
  const at = iso(deps);
  try {
    switch (decision.action) {
      case "NONE": return await done("NONE");
      case "ASK":
        await writeAsk(deps, task.taskId, workflow.revision, decision.reason, decision.codes, at);
        return await done("ASKED");
      case "SEND_BACK": {
        const next = returnWorkflowToImplementationAutomatically(workflow, { expectedRevision: workflow.revision, reason: autoFixSendBackReason(decision.codes), spend, now: at });
        // The send back and the coding that follows it are one commit; the row of the block goes with it.
        const committed = await commitWorkflow(deps, task, next, [resolveRowItem(deps, task.taskId, workflow.revision), dispatchRowItem(deps, task.taskId, next.revision, "IMPLEMENT", at)]);
        if (!committed) return await done("STALE");
        await runDispatchRow(deps, { taskId: task.taskId, workflowRevision: next.revision, kind: "IMPLEMENT" }).catch((error: unknown) => log(deps, { event: "autofix.start_failed", taskId: task.taskId, error: error instanceof Error ? error.name : "unknown" }));
        log(deps, { event: "autofix.decided", taskId: task.taskId, revision: row.workflowRevision, outcome: "SENT_BACK", codes: decision.codes });
        return "STARTED";
      }
      case "RETRY": {
        const automaticDecision = workflowAutomaticRetryDecision(workflow, { expectedRevision: workflow.revision, stage: decision.stage, reason: autoFixRetryReason(decision.stage, decision.codes), spend, now: at });
        const ref = { taskId: task.taskId, workflowRevision: workflow.revision };
        const started = decision.stage === "VERIFY"
          ? await startChecksRerun(deps, ref, { requestId: `autofix-${task.taskId}-${String(workflow.revision)}`, actorId: automaticDecision.actorId, automaticDecision })
          : await startReview(deps, ref, { retry: true, automaticDecision });
        log(deps, { event: "autofix.decided", taskId: task.taskId, revision: row.workflowRevision, outcome: "RETRIED", result: started, codes: decision.codes, stage });
        return started === "STALE" ? "STALE" : "STARTED";
      }
    }
  } catch (error) {
    if (!(error instanceof WorkflowTransitionError)) throw error;
    // A guard of the engine refused although the policy allowed it (a limit read differently, a stale revision): nobody else will look, so the owner is asked.
    const fresh = await readTask(deps, task.taskId);
    if (fresh?.workflow?.revision !== workflow.revision || fresh.workflow.state !== "BLOCKED") return done("STALE");
    await writeAsk(deps, task.taskId, workflow.revision, "needs-a-person", first.action === "NONE" ? [] : first.codes, at);
    return done("ASKED");
  }
}
