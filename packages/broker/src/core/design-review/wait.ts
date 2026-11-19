// Design review stage: the waits of a design review that waits on a person (the question card, the cost hold's card, the design's decision) and the sweep that reminds, parks and closes.
// The rows are Cloud's: one WAIT row per task (`DEVTASK#<id>` / `DESIGN_WAIT`) in the sparse due-time index under the partition `DESIGN_WAIT_DUE`, and one NOTIFY row per reminder, park and close (`DESIGN_WAIT_NOTIFY#...`, written once).
// Cloud arms the row from the table's stream; Code arms it in the transaction of the move that starts the wait (`designWaitArmItems`), so the row and the workflow can never differ. The sweep reads the TASK again before it does
// anything (the row only says it is time to look), and:
//   - at 24 h and 72 h writes a reminder: a NOTIFY row and a line on the task's session, once. A laptop has no one to tell but the owner at the page; a `channel` adapter reads the session's lines;
//   - at 7 days parks the review (`parkDesignReview`), with the model keys of its rounds blocked first: nothing runs, nothing spends, nothing is approved;
//   - at 30 days parked closes the task as "not decided" (`closeParkedDesignReview`).
// NOTHING HERE APPROVES, ANSWERS OR SKIPS. With the switch off, or the project Off, it does nothing new for the task; the one exception is the cost hold, which is ended as every step of a switched-off review is (`switched_off`).
import {
  WORKFLOW_DISPATCH_DUE_INDEX, WorkflowSnapshotSchema, change, closeDesignReview, closeParkedDesignReview, parkDesignReview, when, type DocumentStore, type TransactItem, type WorkflowSnapshot,
} from "@agentx/contracts";
import type { SessionTimeline } from "../merge/seams.js";
import type { TaskFlowDeps } from "../task-flow/deps.js";
import { taskKey } from "../task-flow/keys.js";
import { fromDocument, type TaskRecord } from "../task-flow/records.js";
import { closeParts, finishClose } from "../task-flow/close.js";
import { commitWorkflow } from "../task-flow/stage-machine.js";
import { iso, log } from "../task-flow/support.js";
import type { ProjectPlaybookReader } from "./playbook-store.js";
import { designReviewStillOn } from "./switch.js";
import { designWaitStep, nextDesignWaitDueAt, noticeStepOf, type DesignWaitNoticeStep } from "./wait-clock.js";
import { designWaitOf } from "@agentx/contracts";

export const DESIGN_WAIT_DUE_PK = "DESIGN_WAIT_DUE";
export const DESIGN_WAIT_ROW_SK = "DESIGN_WAIT";
export const DESIGN_WAIT_NOTIFY_PREFIX = "DESIGN_WAIT_NOTIFY#";
export const DESIGN_WAIT_SWEEP_LIMIT = 25;
/** A switched-off task's row is looked at again after this long, so turning the switch on picks it up without another event. */
const OFF_RECHECK_MS = 60 * 60 * 1000;

export const designWaitRowKey = (taskId: string): { pk: string; sk: string } => ({ pk: `DEVTASK#${taskId}`, sk: DESIGN_WAIT_ROW_SK });
export const designWaitNotifyKey = (taskId: string, revision: number, step: DesignWaitNoticeStep): { pk: string; sk: string } => ({ pk: `DEVTASK#${taskId}`, sk: `${DESIGN_WAIT_NOTIFY_PREFIX}${String(revision)}#${step}` });
const dueKey = (atMs: number, taskId: string): string => `${new Date(atMs).toISOString()}#${taskId}`;

/** The step that arms (or re-arms) a task's WAIT row for the workflow it is about to hold, to add to the commit of the move that made it. Nothing when the workflow waits on no one. Conditional on the revision, so an older arm never overwrites a newer one. */
export function designWaitArmItems(deps: Pick<TaskFlowDeps, "companyId">, taskId: string, workflow: WorkflowSnapshot, nowMs: number): TransactItem[] {
  const wait = designWaitOf(workflow);
  if (wait === undefined) return [];
  const due = nextDesignWaitDueAt(wait, nowMs);
  if (due === undefined) return [];
  return [{
    kind: "update", key: designWaitRowKey(taskId),
    ops: [
      change.set("entityType", "DESIGN_WAIT"), change.set("taskId", taskId), change.set("workflowRevision", workflow.revision), change.set("waitKind", wait.kind), change.set("orgId", deps.companyId),
      change.set("dispatchDuePk", DESIGN_WAIT_DUE_PK), change.set("dispatchDueSk", dueKey(due, taskId)), change.set("armedAt", new Date(nowMs).toISOString()),
    ],
    condition: when.or(when.notExists("workflowRevision"), when.lte("workflowRevision", workflow.revision)),
  }];
}

/** The fixed words of a reminder, a park and a close. No model word is in them. */
export function designWaitWords(step: DesignWaitNoticeStep, kind: "answers" | "cost" | "decision", title: string): string {
  const thing = kind === "answers" ? "answers to its design questions" : kind === "decision" ? "a decision on its design" : "a choice about what its design review may cost";
  const quoted = `"${title.slice(0, 80)}"`;
  switch (step) {
    case "24h": return `Rovara is waiting on ${thing} for ${quoted}. It has waited a day. Rovara does not decide this for anyone.`;
    case "72h": return `Still waiting on ${thing} for ${quoted}. It has waited three days. Rovara does not decide this for anyone.`;
    case "parked": return `Paused: ${quoted} has waited a week for ${thing}. Nothing is running and nothing is spending. Open the task to pick it up again. If nobody does in 30 days it is closed as not decided.`;
    case "closed": return `Closed: nobody decided the design for ${quoted}. The design, the findings and the answers stay on the task.`;
  }
}

export interface DesignWaitSweepPorts {
  flow: TaskFlowDeps;
  reader: ProjectPlaybookReader;
  env: NodeJS.ProcessEnv;
  /** Where a notice is written for the owner (a line on the task's session). Absent: the NOTIFY row alone. */
  timeline?: SessionTimeline | undefined;
  /** Blocks and finalizes the model keys of the task's rounds up to round `throughRound` and drops what they held. Idempotent; never throws. */
  releaseKeys(task: TaskRecord, throughRound: number): Promise<void>;
}

export type DesignWaitSweepOutcome = "off" | "none" | "reminded" | "already_sent" | "parked" | "closed" | "stale" | "gone";

async function reschedule(store: Pick<DocumentStore, "update">, taskId: string, revision: number, dueAtMs: number | undefined): Promise<void> {
  // A newer arm (the workflow moved meanwhile) has set the row; it is not ours to overwrite.
  await store.update({
    key: designWaitRowKey(taskId),
    ops: dueAtMs === undefined ? [change.remove("dispatchDuePk"), change.remove("dispatchDueSk")] : [change.set("dispatchDuePk", DESIGN_WAIT_DUE_PK), change.set("dispatchDueSk", dueKey(dueAtMs, taskId))],
    condition: when.and(when.present(), when.lte("workflowRevision", revision)),
  });
}

/** Up to 25 due waits, oldest due first, each settled once. Never throws for one task: a task that fails is logged by code and looked at again next time. */
export async function sweepDesignWaits(ports: DesignWaitSweepPorts): Promise<{ attempted: number; reminded: number; parked: number; closed: number }> {
  const { flow } = ports;
  const nowMs = (flow.now?.() ?? new Date()).getTime();
  const page = await flow.store.queryIndex({ index: WORKFLOW_DISPATCH_DUE_INDEX.name, partition: DESIGN_WAIT_DUE_PK, sort: { op: "lte", value: `${new Date(nowMs).toISOString()}:` }, limit: DESIGN_WAIT_SWEEP_LIMIT });
  const counts = { attempted: page.items.length, reminded: 0, parked: 0, closed: 0 };
  for (const row of page.items) {
    const taskId = typeof row["taskId"] === "string" && /^[0-9a-f-]{36}$/u.test(row["taskId"]) ? row["taskId"] : undefined;
    if (taskId === undefined) continue;
    try {
      const outcome = await settleDesignWait(ports, taskId, typeof row["workflowRevision"] === "number" ? row["workflowRevision"] : 0, nowMs);
      if (outcome === "reminded") counts.reminded += 1;
      else if (outcome === "parked") counts.parked += 1;
      else if (outcome === "closed") counts.closed += 1;
    } catch (error) {
      log(flow, { event: "design_review.wait_sweep_failed", taskId, error: error instanceof Error ? error.name : "unknown" });
    }
  }
  return counts;
}

/** One due wait: what the task is doing now decides everything; the row only said it was time to look. */
export async function settleDesignWait(ports: DesignWaitSweepPorts, taskId: string, rowRevision: number, nowMs: number): Promise<DesignWaitSweepOutcome> {
  const { flow } = ports;
  const nowIso = new Date(nowMs).toISOString();
  const task = fromDocument<TaskRecord>(await flow.store.get(taskKey(taskId)));
  const parsed = task?.workflow === undefined ? undefined : WorkflowSnapshotSchema.safeParse(task.workflow);
  if (task === undefined || task.closedAt !== undefined || parsed === undefined || !parsed.success) {
    await reschedule(flow.store, taskId, rowRevision, undefined);
    return "gone";
  }
  const workflow = parsed.data;
  const due = designWaitStep(workflow, nowMs);
  if (due === undefined) {
    await reschedule(flow.store, taskId, Math.max(rowRevision, workflow.revision), undefined);
    return "gone";
  }
  const { wait, step } = due;
  const asTask: TaskRecord & { workflow: WorkflowSnapshot } = { ...task, workflow };
  if (!(await designReviewStillOn(ports.reader, flow.companyId, task.project, workflow.designReview?.decidedBy, ports.env))) {
    // The cost hold only waits for a spending choice for a review that is no longer to run: end it as every step does when the switch is off.
    if (wait.kind === "cost") {
      const ended = closeDesignReview(workflow, { expectedRevision: workflow.revision, outcome: "not_run", notRunReason: "switched_off", now: nowIso });
      if (!(await commitWorkflow(flow, asTask, ended))) return "stale";
      await reschedule(flow.store, taskId, ended.revision, undefined);
      log(flow, { event: "design_review.wait_switched_off", taskId });
      return "off";
    }
    await reschedule(flow.store, taskId, Math.max(rowRevision, workflow.revision), nowMs + OFF_RECHECK_MS);
    return "off";
  }
  if (step.kind === "none") {
    await reschedule(flow.store, taskId, workflow.revision, nextDesignWaitDueAt(wait, nowMs));
    return "none";
  }
  const noticeStep = noticeStepOf(step);
  /** The notice of this step, written once: its NOTIFY row and a line on the task's session. */
  const notice = (revision: number): TransactItem[] => [
    { kind: "put", item: { ...designWaitNotifyKey(taskId, revision, noticeStep), entityType: "DESIGN_WAIT_NOTIFY", schemaVersion: 1, taskId, workflowRevision: revision, step: noticeStep, waitKind: wait.kind, at: nowIso, status: "PENDING" }, condition: when.absent() },
    ...(task.sessionId === undefined || ports.timeline === undefined ? [] : [ports.timeline.statusLine({ orgId: flow.companyId, sessionId: task.sessionId }, { eventId: `design_wait:${taskId}:${String(revision)}:${noticeStep}`, at: nowIso, text: designWaitWords(noticeStep, wait.kind, task.title) })]),
  ];
  if (step.kind === "remind") {
    const written = await flow.store.transact(notice(workflow.revision));
    await reschedule(flow.store, taskId, workflow.revision, nextDesignWaitDueAt(wait, nowMs));
    if (!written.applied) return "already_sent";
    log(flow, { event: "design_review.wait_reminded", taskId, step: noticeStep, wait: wait.kind });
    return "reminded";
  }
  // Park and close both end the task's use of its model keys for good: they are released first (idempotent), so a commit that loses a race has still left nothing live.
  await ports.releaseKeys(task, workflow.designReview?.rounds.length ?? 0);
  const next = step.kind === "park"
    ? parkDesignReview(workflow, { expectedRevision: workflow.revision, now: nowIso })
    : closeParkedDesignReview(workflow, { expectedRevision: workflow.revision, now: nowIso });
  // A review nobody decided closes the task the way closing it by hand does, in the same commit: its slot goes back, its workspace and pointer are closed, and a running step is interrupted (the machines and the allowances follow).
  const closing = step.kind === "close" ? await closeParts(flow, task, nowIso, { type: "system", id: "design-review" }) : undefined;
  // The task moved (a person answered or decided meanwhile): theirs is the newer word, and the move that made it armed the row again.
  const committed = await commitWorkflow(flow, asTask, next, [...notice(next.revision), ...(closing?.items ?? [])], closing === undefined ? [] : closing.taskOps.filter((op) => op.path[0] !== "updatedAt"));
  if (!committed) return "stale";
  if (closing !== undefined) await finishClose(flow, task, closing, nowIso).catch((error: unknown) => log(flow, { event: "design_review.close_finish_failed", taskId, error: error instanceof Error ? error.name : "unknown" }));
  const after = designWaitStep(next, nowMs);
  await reschedule(flow.store, taskId, next.revision, after === undefined ? undefined : nextDesignWaitDueAt(after.wait, nowMs));
  log(flow, { event: step.kind === "park" ? "design_review.wait_parked" : "design_review.wait_closed", taskId, wait: wait.kind });
  return step.kind === "park" ? "parked" : "closed";
}

export { iso };
