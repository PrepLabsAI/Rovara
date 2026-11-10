// the ordered-work invocation of a coding run (Cloud's `approvedWorkflowDependencies` and `workflowWithCurrentGraphOperation`, in `developer-tasks/workflow-inputs.ts`).
//
// A coding run of an approved plan with a work breakdown carries the graph, the approval it was bound by, the progress cursor and, for a run that goes on from an earlier one, the retained checkpoints and the tree the
// workspace must hold. The record of that run (the operation's `workflowDependencies`) is the binding every later checkpoint, result and retry is read against.
import { agentXError, canonicalJson, taskGraphDigest, workflowDependencyAttemptTerminalProgress, type WorkflowDependencyInvocation, type WorkflowSnapshot } from "@agentx/contracts";
import { operationKey } from "../task-flow/keys.js";
import type { TaskFlowDeps } from "../task-flow/deps.js";
import { fromDocument, type OperationRecord, type TaskRecord } from "../task-flow/records.js";
import { approvedGraphOf } from "./plan-graph.js";
import { parallelPartsDecision, parallelPartsForTask, workflowDependenciesAllowed } from "./parallel-parts.js";

export const ORDERED_WORK_NOT_ENABLED = "the approved ordered work plan is retained, but this install is not enabled to continue it";

const TERMINAL_OPERATION = new Set(["SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"]);

/** The invocation of the FIRST ordered run of an approved plan: nothing retained, the cursor at zero. Undefined when the plan carries no breakdown. */
export async function firstGraphInvocation(deps: TaskFlowDeps, task: TaskRecord & { workflow: WorkflowSnapshot }): Promise<{ invocation: WorkflowDependencyInvocation; note?: string } | undefined> {
  const { workflow } = task;
  const approval = workflow.workflowDependenciesApproval;
  if (approval === undefined) return undefined;
  if (!workflowDependenciesAllowed(deps, workflow)) throw agentXError("CONFIG_INVALID", ORDERED_WORK_NOT_ENABLED);
  const graph = await approvedGraphOf(deps, task, workflow);
  if (graph === undefined) return undefined;
  const parts = await parallelPartsDecision(deps, { charge: task.charge, workflow }, graph);
  return { invocation: { graph, approval, peopleRevision: 0, sequenceStart: 0, ...(parts.parallel === undefined ? {} : { parallel: parts.parallel }) }, ...(parts.note === undefined ? {} : { note: parts.note }) };
}

/**
 * Reloads the exact ordered run a stopped or finished coding operation was bound to, so a retry cannot fall back to plain coding or to a run the owner did not approve: the operation the workflow names holds a binding
 * with the same graph and approval, no item start is left unresolved, and the checkpoints the retry resumes from are the ones the progress history acknowledges. Undefined when the plan has no breakdown.
 */
export async function resumeGraphInvocation(deps: TaskFlowDeps, task: TaskRecord & { workflow: WorkflowSnapshot }): Promise<WorkflowDependencyInvocation | undefined> {
  const { workflow } = task;
  const approval = workflow.workflowDependenciesApproval;
  if (approval === undefined) return undefined;
  if (!workflowDependenciesAllowed(deps, workflow)) throw agentXError("CONFIG_INVALID", ORDERED_WORK_NOT_ENABLED);
  const graph = await approvedGraphOf(deps, task, workflow);
  if (graph === undefined) return undefined;
  const progress = workflow.workflowDependenciesProgress ?? [];
  const operationId = workflow.workflowDependenciesOperationId;
  const bound = operationId === undefined ? undefined : fromDocument<OperationRecord>(await deps.store.get(operationKey(task.workspaceId, operationId)));
  const binding = bound?.workflowDependencies;
  if (bound === undefined || binding === undefined || bound.kind !== "task" || bound.workflowMode !== "IMPLEMENT" || bound.workspaceId !== task.workspaceId || bound.conversationId !== task.conversationId
    || !TERMINAL_OPERATION.has(bound.status)
    || binding.graph.taskId !== task.taskId || taskGraphDigest(binding.graph) !== approval.graphDigest
    || binding.approval.artifactDigest !== approval.artifactDigest || binding.approval.graphDigest !== approval.graphDigest
    || binding.approval.runId !== approval.runId || binding.approval.workflowRevision !== approval.workflowRevision || binding.approval.actorId !== approval.actorId) {
    throw agentXError("CONFIG_INVALID", "the approved ordered plan has no matching operation binding; approve a refreshed whole coding plan before continuing");
  }
  const latest = progress.filter((entry) => entry.operationId === bound.id).at(-1);
  if (latest?.state === "STARTED") throw agentXError("CONFIG_INVALID", "the ordered run has an unresolved item start; inspect the workspace and approve a refreshed whole coding plan before continuing");
  const resumeProgress = workflowDependencyAttemptTerminalProgress({ graph, approval, operationId: bound.id, sequenceStart: binding.sequenceStart, resumeProgress: binding.resumeProgress, history: progress, parallel: binding.parallel });
  if (resumeProgress === undefined) throw agentXError("CONFIG_INVALID", "the latest ordered-work checkpoints do not match their operation attempt; approve a refreshed whole coding plan before continuing");
  const last = resumeProgress.at(-1);
  // Parts built side by side leave the repository on the newest integrated tree (the last part merged), not on the last part of the plan's order.
  const newest = resumeProgress.filter((entry) => entry.state === "IMPLEMENTED").sort((left, right) => right.sequence - left.sequence)[0];
  const resumeTreeSha = binding.parallel !== undefined
    ? (newest !== undefined ? newest.integratedTreeSha ?? newest.candidateTreeSha : [...resumeProgress].sort((left, right) => left.sequence - right.sequence)[0]?.baseTreeSha ?? binding.resumeTreeSha)
    : last === undefined ? binding.resumeTreeSha
    : last.state === "IMPLEMENTED" ? last.candidateTreeSha : last.baseTreeSha;
  if (progress.length > 0 && resumeTreeSha === undefined) throw agentXError("CONFIG_INVALID", "the stopped ordered run has no usable tree checkpoint");
  // The parts setting is read again for each operation (the company's room changes); the earlier operation's is not carried over.
  const { parallel: _earlier, ...withoutParallel } = binding;
  void _earlier;
  const parallel = await parallelPartsForTask(deps, { charge: task.charge, workflow });
  return {
    ...withoutParallel, graph, approval, ...(resumeTreeSha === undefined ? {} : { resumeTreeSha }), peopleRevision: 0,
    sequenceStart: latest?.sequence ?? binding.sequenceStart ?? 0, resumeProgress, ...(parallel === undefined ? {} : { parallel }),
  };
}

/**
 * The invocation for a coding run that goes on from an earlier ordered run after the owner's (or Rovara's own) send-back: the whole plan is run again over the code the workspace holds (nothing retained, the cursor
 * where the history ended), as Cloud's send-back does. `resumed` is `resumeGraphInvocation`'s answer.
 */
export function restartedGraphInvocation(resumed: WorkflowDependencyInvocation, workflow: Pick<WorkflowSnapshot, "workflowDependenciesProgress">): WorkflowDependencyInvocation {
  return { ...resumed, sequenceStart: workflow.workflowDependenciesProgress?.at(-1)?.sequence ?? resumed.sequenceStart ?? 0, resumeProgress: [] };
}

/** Keeps the accepted graph attempt pointer in the task update committed with its operation and outbox (the progress window is cut to the retained checkpoints and the cursor). */
export function workflowWithCurrentGraphOperation(workflow: WorkflowSnapshot, operationId: string | undefined, invocation?: WorkflowDependencyInvocation): WorkflowSnapshot {
  const { workflowDependenciesOperationId: _previous, ...withoutPrevious } = workflow;
  void _previous;
  if (operationId === undefined) return withoutPrevious;
  if (invocation === undefined) return { ...withoutPrevious, workflowDependenciesOperationId: operationId };
  const history = workflow.workflowDependenciesProgress ?? [];
  const retainedBySequence = new Map<number, (typeof history)[number]>();
  for (const candidate of invocation.resumeProgress ?? []) {
    const recorded = history.find((entry) => entry.sequence === candidate.sequence && canonicalJson(entry) === canonicalJson(candidate));
    if (recorded !== undefined) retainedBySequence.set(recorded.sequence, recorded);
  }
  const priorCursor = history.at(-1);
  if (priorCursor !== undefined) retainedBySequence.set(priorCursor.sequence, priorCursor);
  const progress = [...retainedBySequence.values()].sort((left, right) => left.sequence - right.sequence);
  return { ...withoutPrevious, workflowDependenciesProgress: progress, workflowDependenciesOperationId: operationId };
}
