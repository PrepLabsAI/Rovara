// the checkpoints of an ordered run (Cloud's `validateWorkflowProgressChunk` and the workflow write of `appendEventChunk`, in `broker/pull-request-reconcile.ts`).
//
// While an approved work breakdown is coded the worker reports each item's start and end as a `progress` event carrying a `workItemProgress` (`WorkItemProgressV1`). The worker advances to the next item only when the
// broker has durably acknowledged the one before, so what is written here is what a retry resumes from. Each checkpoint is judged against the canonical run the owner approved, never taken on the worker's word:
//   - it is for the operation the workflow names, still running, on the workspace and fence that operation holds;
//   - its sequence number is the next one (an exact repeat of an acknowledged checkpoint is fine; the same number with other content is refused);
//   - the item and the tree it starts from continue the retained graph (one at a time: the next item of the plan's order on the tree the one before ended on; side by side: an item whose dependencies are done, on the
//     run's first tree or a tree some finished part was merged into);
//   - the run's first tree is the retained one, or the tree the code host shows for the task's base commit (read from the code host, never from the worker).
// A checkpoint that passes is written into the task's workflow (one revision up, the operation's revision with it, so the result of this run still reads as the run the workflow waits for).
import {
  WorkItemProgressV1Schema, WorkflowSnapshotSchema, agentXError, canonicalJson, change, taskGraphOrder, when, workflowDependencyAttemptTerminalProgress,
  type TransactItem, type WorkItemProgressV1, type WorkflowDependencyInvocation, type WorkflowSnapshot,
} from "@agentx/contracts";
import { codeHostForRecord } from "../../plugins/routing.js";
import type { TaskFlowDeps } from "../task-flow/deps.js";
import { operationKey, taskKey, workspaceKey } from "../task-flow/keys.js";
import { readTask } from "../task-flow/reads.js";
import { fromDocument, toDocument, type OperationRecord, type TaskRecord, type WorkspaceRecord } from "../task-flow/records.js";
import { iso } from "../task-flow/support.js";
import { parallelStartTrees } from "./parallel-parts.js";

const forbidden = (message: string) => agentXError("CALLBACK_FORBIDDEN", message);
const ATTEMPTS = 3;

/** The work item checkpoints an events batch carries, as sent (unparsed). */
export function workItemProgressOf(events: ReadonlyArray<{ type: string; payload?: unknown }>): unknown[] {
  return events.flatMap((event) => {
    if (event.type !== "progress" || event.payload === null || typeof event.payload !== "object" || Array.isArray(event.payload)) return [];
    const payload = event.payload as Record<string, unknown>;
    return Object.hasOwn(payload, "workItemProgress") ? [payload["workItemProgress"]] : [];
  });
}

/** The tree the run starts from: the retained one, else the tree the code host shows for the base commit the task recorded (never the worker's word). */
async function firstBaseTreeOf(deps: TaskFlowDeps, task: TaskRecord & { workflow: WorkflowSnapshot }, invocation: WorkflowDependencyInvocation): Promise<string> {
  if (invocation.resumeTreeSha !== undefined) return invocation.resumeTreeSha;
  const repositoryId = invocation.graph.items[0]?.repository;
  const baseCommit = (task.workflow.reviewBase ?? task.preparedBase)?.find((entry) => entry.repositoryId === repositoryId)?.baseCommitSha;
  if (baseCommit === undefined) throw forbidden("the approved work breakdown base tree cannot be confirmed");
  const project = await deps.projects.revision(task.project, task.startingRevision);
  const repository = project?.definition.repositories.find((entry) => entry.name === repositoryId);
  if (repository === undefined) throw forbidden("the approved work breakdown repository is no longer registered");
  if (deps.codeHosts === undefined) throw forbidden("the approved work breakdown base tree cannot be confirmed");
  try {
    return await codeHostForRecord(deps.codeHosts, repository).tree({ url: repository.url }, baseCommit, { orgId: deps.companyId });
  } catch {
    throw forbidden("the approved work breakdown base tree cannot be confirmed");
  }
}

/** What a batch of checkpoints would write: the new workflow, and the revision it was computed from. Undefined when there is nothing new (every checkpoint was an acknowledged repeat). */
async function judge(deps: TaskFlowDeps, operation: OperationRecord, rawProgress: readonly unknown[]): Promise<{ task: TaskRecord & { workflow: WorkflowSnapshot }; next: WorkflowSnapshot } | "repeat"> {
  const invocation = operation.workflowDependencies;
  if (invocation === undefined || operation.workflowMode !== "IMPLEMENT") throw forbidden("work breakdown progress is not bound to an active approved operation");
  const parsed = rawProgress.map((entry) => WorkItemProgressV1Schema.safeParse(entry));
  const items: WorkItemProgressV1[] = [];
  for (const entry of parsed) {
    if (!entry.success) throw forbidden("work breakdown progress is invalid");
    items.push(entry.data);
  }
  const record = await readTask(deps, invocation.graph.taskId);
  const approved = record?.workflow?.workflowDependenciesApproval;
  if (record === undefined || record.closedAt !== undefined || record.workflow === undefined || record.workflow.stage !== "IMPLEMENT" || record.workflow.state !== "RUNNING"
    || approved?.graphDigest !== invocation.approval.graphDigest || approved.runId !== invocation.approval.runId || approved.artifactDigest !== invocation.approval.artifactDigest
    || approved.workflowRevision !== invocation.approval.workflowRevision || approved.actorId !== invocation.approval.actorId) {
    throw forbidden("work breakdown progress no longer matches the current task and owner approval");
  }
  const task = record as TaskRecord & { workflow: WorkflowSnapshot };
  const workspace = fromDocument<WorkspaceRecord>(await deps.store.get(workspaceKey(operation.workspaceId)));
  if (workspace === undefined || workspace.status !== "BUSY" || workspace.activeOperationId !== operation.id || workspace.fence !== operation.fence) {
    throw forbidden("work breakdown progress belongs to a stale workspace operation");
  }
  const history = task.workflow.workflowDependenciesProgress ?? [];
  const order = taskGraphOrder(invocation.graph);
  const firstBaseTree = await firstBaseTreeOf(deps, task, invocation);
  let latestSequence = history.at(-1)?.sequence ?? 0;
  if (latestSequence !== (invocation.sequenceStart ?? 0) + history.filter((entry) => entry.operationId === operation.id).length) {
    throw forbidden("work breakdown progress cursor changed before this operation");
  }
  let nextWorkflow = task.workflow;
  let wrote = false;
  for (const progress of items) {
    const existing = history.find((entry) => entry.sequence === progress.sequence);
    if (existing !== undefined) {
      if (canonicalJson(existing) !== canonicalJson(progress)) throw forbidden("work breakdown progress sequence was reused with different content");
      if (existing.operationId !== operation.id || existing.graphDigest !== invocation.approval.graphDigest || existing.runId !== invocation.approval.runId) {
        throw forbidden("work breakdown progress replay is not bound to this operation");
      }
      continue;
    }
    if (progress.sequence !== latestSequence + 1 || progress.graphDigest !== invocation.approval.graphDigest || progress.runId !== invocation.approval.runId || progress.operationId !== operation.id) {
      throw forbidden("work breakdown progress is out of sequence or bound to another operation");
    }
    if (invocation.parallel !== undefined) {
      // Rovara Code v2: several items may be running at once. The shape (what may start, how many run, what may finish) is the projection's; the trees are judged here: a part starts from the tree the run began at or
      // from a tree some finished part was merged into. A worker that builds parts side by side names that tree on each finished part (`integratedTreeSha`); one that was not sent the setting (an older worker)
      // builds them one after another, and the tree a finished part ends on is its own.
      const stored = [...(nextWorkflow.workflowDependenciesProgress ?? []), progress];
      const projected = workflowDependencyAttemptTerminalProgress({ graph: invocation.graph, approval: invocation.approval, operationId: operation.id, sequenceStart: invocation.sequenceStart, resumeProgress: invocation.resumeProgress, history: stored, parallel: invocation.parallel });
      if (projected === undefined || (progress.state === "STARTED" && !parallelStartTrees(stored, firstBaseTree).has(progress.baseTreeSha))) {
        throw forbidden("work breakdown progress does not continue the retained graph's trees and order");
      }
      latestSequence = progress.sequence;
      nextWorkflow = WorkflowSnapshotSchema.parse({ ...nextWorkflow, revision: nextWorkflow.revision + 1, workflowDependenciesProgress: stored });
      wrote = true;
      continue;
    }
    const operationHistory = [...history, ...((nextWorkflow.workflowDependenciesProgress ?? []).slice(history.length))].filter((entry) => entry.operationId === operation.id);
    const active = operationHistory.at(-1)?.state === "STARTED" ? operationHistory.at(-1) : undefined;
    const attemptTerminals = workflowDependencyAttemptTerminalProgress({ graph: invocation.graph, approval: invocation.approval, operationId: operation.id, sequenceStart: invocation.sequenceStart, resumeProgress: invocation.resumeProgress, history: nextWorkflow.workflowDependenciesProgress ?? [] });
    if (attemptTerminals === undefined) throw forbidden("work breakdown checkpoints do not match this operation attempt");
    const attemptSequenceStart = invocation.sequenceStart ?? 0;
    const attemptHalted = operationHistory.some((entry) => entry.operationId === operation.id && entry.sequence > attemptSequenceStart && (entry.state === "FAILED" || entry.state === "UNKNOWN"));
    const completed = new Set(attemptTerminals.filter((entry) => entry.state === "IMPLEMENTED").map((entry) => entry.itemId));
    const expectedItemId = order.find((itemId) => !completed.has(itemId));
    const previous = (nextWorkflow.workflowDependenciesProgress ?? []).at(-1);
    const expectedBase = active?.baseTreeSha ?? (previous?.state === "IMPLEMENTED" ? previous.candidateTreeSha : firstBaseTree);
    if (progress.state === "STARTED") {
      if (attemptHalted || active !== undefined || expectedItemId === undefined || progress.itemId !== expectedItemId || (expectedBase !== undefined && progress.baseTreeSha !== expectedBase)) {
        throw forbidden("work breakdown item start does not continue the retained graph tree and order");
      }
    } else if (active === undefined || active.itemId !== progress.itemId || active.baseTreeSha !== progress.baseTreeSha || (progress.state === "IMPLEMENTED" && (expectedItemId === undefined || progress.itemId !== expectedItemId))) {
      throw forbidden("work breakdown item result has no matching acknowledged start");
    }
    latestSequence = progress.sequence;
    nextWorkflow = WorkflowSnapshotSchema.parse({ ...nextWorkflow, revision: nextWorkflow.revision + 1, workflowDependenciesProgress: [...(nextWorkflow.workflowDependenciesProgress ?? []), progress] });
    wrote = true;
  }
  return wrote ? { task, next: nextWorkflow } : "repeat";
}

/**
 * Judges the work item checkpoints of an events batch and writes the new ones into the task's workflow, before the batch is acknowledged to the worker. Throws CALLBACK_FORBIDDEN for a checkpoint that does not
 * continue the approved run (the worker then fails the operation). A batch with no checkpoint changes nothing here.
 */
export async function recordWorkItemProgress(deps: TaskFlowDeps, operation: OperationRecord, events: ReadonlyArray<{ type: string; payload?: unknown }>): Promise<void> {
  const raw = workItemProgressOf(events);
  if (raw.length === 0) return;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const judged = await judge(deps, operation, raw);
    if (judged === "repeat") return;
    const { task, next } = judged;
    const approval = operation.workflowDependencies!.approval;
    const now = iso(deps);
    const items: TransactItem[] = [
      {
        kind: "update", key: taskKey(task.taskId), ops: [change.set("workflow", toDocument(next)), change.set("updatedAt", now)],
        condition: when.and(
          when.notExists("closedAt"), when.eq(["workflow", "revision"], task.workflow.revision), when.eq(["workflow", "stage"], "IMPLEMENT"), when.eq(["workflow", "state"], "RUNNING"),
          when.eq(["workflow", "workflowDependenciesApproval", "graphDigest"], approval.graphDigest), when.eq(["workflow", "workflowDependenciesApproval", "runId"], approval.runId),
          when.eq(["workflow", "workflowDependenciesApproval", "artifactDigest"], approval.artifactDigest), when.eq(["workflow", "workflowDependenciesApproval", "workflowRevision"], approval.workflowRevision),
          when.eq(["workflow", "workflowDependenciesApproval", "actorId"], approval.actorId),
        ),
      },
      // The coding run reads as the run the workflow waits for: its revision moves with the workflow's.
      { kind: "update", key: operationKey(operation.workspaceId, operation.id), ops: [change.set("workflowRevision", next.revision), change.set("updatedAt", now)], condition: when.eq("fence", operation.fence) },
      { kind: "check", key: workspaceKey(operation.workspaceId), condition: when.and(when.eq("activeOperationId", operation.id), when.eq("fence", operation.fence), when.eq("status", "BUSY")) },
    ];
    if ((await deps.store.transact(items)).applied) return;
    // Lost a race with another checkpoint (or a stop): judge again from what is stored now.
  }
  throw forbidden("work breakdown progress could not be recorded because the task changed; send it again");
}
