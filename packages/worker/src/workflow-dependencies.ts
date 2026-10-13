import { TaskGraphV1Schema, WorkItemProgressV1Schema, taskGraphDigest, taskGraphOrder, type TaskGraphV1, type WorkItemProgressV1 } from "@agentx/contracts";

export interface WorkflowDependencyExecutionContext {
  baseTreeSha: string;
  predecessorOutcomes: ReadonlyArray<{ itemId: string; candidateTreeSha: string; summary?: string }>;
}

export interface ExecuteSerialWorkflowDependenciesInput {
  graph: TaskGraphV1;
  graphDigest: string;
  runId: string;
  operationId: string;
  initialTreeSha: string;
  sequenceStart?: number;
  resumeProgress?: readonly WorkItemProgressV1[];
  shouldContinue?(): boolean;
  now(): string;
  /** Must durably acknowledge the callback before this driver advances. */
  persist(progress: WorkItemProgressV1): Promise<void>;
  execute(item: TaskGraphV1["items"][number], context: WorkflowDependencyExecutionContext): Promise<{ treeSha: string; summary?: string }>;
}

export interface ExecuteSerialWorkflowDependenciesResult {
  finalTreeSha: string;
  progress: WorkItemProgressV1[];
}

/** A retry is allowed to resume only from the exact tree retained by the stopped graph invocation. */
export function assertWorkflowDependencyResumeTree(currentTreeSha: string, resumeTreeSha: string | undefined): void {
  if (resumeTreeSha !== undefined && currentTreeSha !== resumeTreeSha) {
    throw new Error("workspace changed since the retained ordered-work checkpoint");
  }
}

/** Execute one graph serially. Any item or checkpoint uncertainty halts the entire remaining graph. */
export async function executeSerialWorkflowDependencies(
  input: ExecuteSerialWorkflowDependenciesInput,
): Promise<ExecuteSerialWorkflowDependenciesResult> {
  const graph = TaskGraphV1Schema.parse(input.graph);
  if (taskGraphDigest(graph) !== input.graphDigest) throw new Error("approved work breakdown digest does not match its graph");
  if (!/^[a-f0-9-]{36}$/.test(input.runId) || !/^[a-f0-9-]{36}$/.test(input.operationId)) throw new Error("work breakdown run binding is invalid");
  if (!/^[a-f0-9]{40}$/.test(input.initialTreeSha)) throw new Error("work breakdown base tree is invalid");

  const itemById = new Map(graph.items.map((item) => [item.id, item] as const));
  const outcomes = new Map<string, { treeSha: string; summary?: string }>();
  const progress: WorkItemProgressV1[] = [];
  let treeSha = input.initialTreeSha;
  let sequence = input.sequenceStart ?? 0;
  const retained = new Map((input.resumeProgress ?? []).map((entry) => [entry.itemId, entry] as const));
  const order = taskGraphOrder(graph);
  let firstPending = 0;
  for (const itemId of order) {
    const prior = retained.get(itemId);
    if (prior === undefined || prior.state !== "IMPLEMENTED") break;
    if (prior.candidateTreeSha === undefined) throw new Error("retained work breakdown checkpoint has no candidate tree");
    outcomes.set(itemId, { treeSha: prior.candidateTreeSha });
    treeSha = prior.candidateTreeSha;
    firstPending += 1;
  }
  if (order.slice(firstPending).some((itemId) => retained.get(itemId)?.state === "IMPLEMENTED")) {
    throw new Error("retained work breakdown checkpoints are not a completed prefix");
  }
  if (firstPending > 0 && treeSha !== input.initialTreeSha) {
    throw new Error("workspace changed since the retained completed work breakdown prefix");
  }
  const checkpoint = async (value: Omit<WorkItemProgressV1, "sequence">): Promise<void> => {
    const event = WorkItemProgressV1Schema.parse({ ...value, sequence: ++sequence });
    await input.persist(event);
    progress.push(event);
  };

  for (const itemId of order.slice(firstPending)) {
    if (input.shouldContinue?.() === false) throw new Error("work breakdown stopped because the operation was cancelled");
    const item = itemById.get(itemId);
    if (item === undefined) throw new Error("approved work breakdown order contains an unknown item");
    const predecessorOutcomes = item.dependsOn.map((dependency) => {
      const outcome = outcomes.get(dependency);
      if (outcome === undefined) throw new Error("work breakdown is paused because a prerequisite has no acknowledged outcome");
      return { itemId: dependency, candidateTreeSha: outcome.treeSha, ...(outcome.summary === undefined ? {} : { summary: outcome.summary }) };
    });
    const baseTreeSha = treeSha;
    await checkpoint({ schemaVersion: 1, graphDigest: input.graphDigest, runId: input.runId, itemId, state: "STARTED", operationId: input.operationId, baseTreeSha, at: input.now(), producer: "agentx-worker" });
    let result: { treeSha: string; summary?: string };
    try {
      if (input.shouldContinue?.() === false) throw new Error("work breakdown stopped because the operation was cancelled after its start checkpoint");
      result = await input.execute(item, { baseTreeSha, predecessorOutcomes });
      if (!/^[a-f0-9]{40}$/.test(result.treeSha)) throw new Error("item returned an invalid candidate tree");
    } catch (error) {
      const unknown = WorkItemProgressV1Schema.parse({
        schemaVersion: 1, graphDigest: input.graphDigest, runId: input.runId, itemId, sequence: sequence + 1,
        state: "UNKNOWN", operationId: input.operationId, baseTreeSha, at: input.now(), producer: "agentx-worker",
      });
      try {
        await input.persist(unknown);
        progress.push(unknown);
      } catch (checkpointError) {
        throw new Error("work breakdown is paused because item outcome and its checkpoint are uncertain", { cause: checkpointError });
      }
      throw new Error("work breakdown is paused after an uncertain item", { cause: error });
    }
    const implemented: WorkItemProgressV1 = WorkItemProgressV1Schema.parse({
      schemaVersion: 1, graphDigest: input.graphDigest, runId: input.runId, itemId, sequence: sequence + 1,
      state: "IMPLEMENTED", operationId: input.operationId, baseTreeSha, candidateTreeSha: result.treeSha,
      at: input.now(), producer: "agentx-worker",
    });
    // Do not begin the next item until its predecessor's outcome is durably accepted.
    await input.persist(implemented);
    sequence += 1;
    progress.push(implemented);
    outcomes.set(itemId, { treeSha: result.treeSha, ...(result.summary === undefined ? {} : { summary: result.summary }) });
    treeSha = result.treeSha;
    if (input.shouldContinue?.() === false) throw new Error("work breakdown stopped because the operation was cancelled after its completion checkpoint");
  }
  return { finalTreeSha: treeSha, progress };
}
