// what the end of an ordered coding run means (the graph parts of Cloud's `completedWorkflowItems`, in `broker/workflow-items.ts`).
//
// The worker's result for an ordered run carries a `workflowDependenciesResult`: the terminal checkpoint of every item, the final candidate digest and a status. None of it is believed as it stands. It must be the result of the
// operation the workflow names, for the graph and approval the owner gave, and its items must be exactly the checkpoints the broker acknowledged while the run went (`workflowDependencyAttemptTerminalProgress` over the
// stored history), in the plan's order, each starting on the tree the one before ended on (or, side by side, merged into a tree). The code the run leaves must be the code of the last item. A run that failed, was
// stopped or ended in doubt marks the item it was on as unknown, so a retry resumes from what was really acknowledged.
import { WorkflowDependencyResultSchema, canonicalJson, taskGraphOrder, workflowDependencyAttemptTerminalProgress, type CandidateManifest, type WorkItemProgressV1, type WorkflowDependencyInvocation, type WorkflowSnapshot } from "@agentx/contracts";
import type { OperationRecord } from "../task-flow/records.js";

/** The words that block a coding run whose ordered-work result is not the approved run's. */
export const GRAPH_RESULT_UNUSABLE = "approved work breakdown result is missing, stale or incomplete";
export const GRAPH_NOT_CARRIED = "approved work breakdown was not carried into this implementation";
export const GRAPH_CANDIDATE_MISMATCH = "work breakdown result does not bind the final combined candidate";
export const GRAPH_FINAL_TREE_MISMATCH = "work breakdown final item does not bind the final combined candidate tree";

export interface GraphResultJudgement {
  /** The binding the operation was started with; absent for a run that carried no graph. */
  binding: WorkflowDependencyInvocation | undefined;
  /** The result names this run, graph and approval, and its items are the acknowledged checkpoints, in order. */
  valid: boolean;
  /** Every item is implemented and the run succeeded. */
  complete: boolean;
  /** The result as the worker reported it, when it read as a result. */
  result?: ReturnType<typeof WorkflowDependencyResultSchema.parse> | undefined;
}

/** Judges the ordered-work result of a coding run that ended in success, against the binding the operation was started with and the checkpoints acknowledged while it ran. */
export function judgeGraphResult(operation: Pick<OperationRecord, "id" | "workflowDependencies">, workflow: WorkflowSnapshot, reported: Record<string, unknown>): GraphResultJudgement {
  const binding = operation.workflowDependencies;
  if (binding === undefined) return { binding, valid: false, complete: false };
  const parsed = WorkflowDependencyResultSchema.safeParse(reported["workflowDependenciesResult"]);
  const order = taskGraphOrder(binding.graph);
  const acknowledged = workflowDependencyAttemptTerminalProgress({
    graph: binding.graph, approval: binding.approval, operationId: operation.id, sequenceStart: binding.sequenceStart, resumeProgress: binding.resumeProgress,
    history: workflow.workflowDependenciesProgress ?? [], parallel: binding.parallel,
  });
  const approval = workflow.workflowDependenciesApproval;
  const valid = parsed.success
    && parsed.data.taskId === binding.graph.taskId && parsed.data.graphDigest === binding.approval.graphDigest && parsed.data.runId === binding.approval.runId
    && parsed.data.operationId === operation.id && parsed.data.workflowRevision === binding.approval.workflowRevision
    && approval?.artifactDigest === binding.approval.artifactDigest && approval.graphDigest === binding.approval.graphDigest && approval.workflowRevision === binding.approval.workflowRevision
    && approval.actorId === binding.approval.actorId && approval.runId === binding.approval.runId
    && acknowledged !== undefined
    && parsed.data.items.length === acknowledged.length
    && parsed.data.items.every((item, index) => canonicalJson(item) === canonicalJson(acknowledged[index]))
    && parsed.data.items.every((item, index) => item.itemId === order[index] && item.sequence > 0
      // One at a time: each item starts on the tree the one before it ended on. In parallel the items are merged as they finish, so each names the tree it was merged into instead.
      && (binding.parallel !== undefined
        ? item.state !== "IMPLEMENTED" || (item.integratedTreeSha ?? item.candidateTreeSha) !== undefined
        : index === 0 || (parsed.data.items[index - 1]?.state === "IMPLEMENTED" && parsed.data.items[index - 1]?.candidateTreeSha === item.baseTreeSha)));
  const complete = parsed.success && parsed.data.status === "SUCCEEDED" && parsed.data.items.length === binding.graph.items.length && parsed.data.items.every((item) => item.state === "IMPLEMENTED");
  return { binding, valid, complete, ...(parsed.success ? { result: parsed.data } : {}) };
}

/**
 * The sentence that blocks a successful ordered run whose result does not bind the code it left: the result's candidate digest must be the final combined candidate's, and the last item's tree (in parallel, the tree the
 * last part to finish was merged into) must be that candidate's one tree. Undefined when it does.
 */
export function graphCandidateProblem(judged: GraphResultJudgement, candidate: Pick<CandidateManifest, "digest" | "repositories">): string | undefined {
  const { binding, result } = judged;
  if (binding === undefined || result === undefined) return undefined;
  if (result.candidateDigest !== candidate.digest) return GRAPH_CANDIDATE_MISMATCH;
  const last = binding.parallel === undefined ? result.items.at(-1) : [...result.items].sort((left, right) => right.sequence - left.sequence)[0];
  const actual = candidate.repositories.length === 1 ? candidate.repositories[0]?.treeSha : undefined;
  const expected = binding.parallel === undefined ? last?.candidateTreeSha : last?.integratedTreeSha ?? last?.candidateTreeSha;
  return last?.state !== "IMPLEMENTED" || actual === undefined || expected !== actual ? GRAPH_FINAL_TREE_MISMATCH : undefined;
}

/**
 * The checkpoints after a run that did not finish (failed, stopped, lost): every item the run had started and not ended is marked unknown, by the broker, so a retry resumes only from what was acknowledged as done.
 * One at a time, only the last checkpoint can be open; side by side, several can. The same list when nothing was open.
 */
export function progressAfterStoppedRun(workflow: Pick<WorkflowSnapshot, "workflowDependenciesProgress">, operation: Pick<OperationRecord, "id" | "workflowDependencies">, now: string): WorkItemProgressV1[] {
  const progress = workflow.workflowDependenciesProgress ?? [];
  const binding = operation.workflowDependencies;
  if (binding === undefined) return progress;
  if (binding.parallel !== undefined) {
    // Parts run side by side, so a stopped run can leave several started and unfinished: each is marked unknown, in the order it started.
    const open = new Map<string, WorkItemProgressV1>();
    for (const entry of progress) {
      if (entry.operationId !== operation.id) continue;
      if (entry.state === "STARTED") open.set(entry.itemId, entry);
      else open.delete(entry.itemId);
    }
    let marked = progress;
    for (const entry of [...open.values()].sort((left, right) => left.sequence - right.sequence)) {
      const { candidateTreeSha: _tree, integratedTreeSha: _integrated, ...rest } = entry;
      void _tree; void _integrated;
      marked = [...marked, { ...rest, sequence: (marked.at(-1)?.sequence ?? entry.sequence) + 1, state: "UNKNOWN" as const, at: now, producer: "agentx-broker-terminal" }];
    }
    return marked;
  }
  const unfinished = progress.at(-1);
  if (unfinished?.operationId === operation.id && unfinished.state === "STARTED") {
    const { candidateTreeSha: _tree, ...rest } = unfinished;
    void _tree;
    return [...progress, { ...rest, sequence: unfinished.sequence + 1, state: "UNKNOWN" as const, at: now, producer: "agentx-broker-terminal" }];
  }
  return progress;
}
