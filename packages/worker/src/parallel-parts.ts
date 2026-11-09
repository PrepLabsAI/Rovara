import { PARALLEL_PARTS_MAX, TaskGraphV1Schema, WorkItemProgressV1Schema, taskGraphDigest, taskGraphOrder, type TaskGraphV1, type WorkItemProgressV1 } from "@agentx/contracts";
import type { ExecuteSerialWorkflowDependenciesInput, ExecuteSerialWorkflowDependenciesResult, WorkflowDependencyExecutionContext } from "./workflow-dependencies.js";

// Rovara Code v2: independent parts of an approved plan build at once on the task's one machine, each in its own working copy, and are merged one at a time into one
// integrated tree. This module is the scheduler only (which part starts when, what is checkpointed, what happens on a conflict or a failure); the working copies and the merge
// itself are git work done by parallel-parts-git.ts and handed in as `execute`, `integrate` and `checkout`.
//
// Money: the parts run inside the one operation the broker admitted (its payer, step budget, planning and run limits), on that operation's one model key. A part has no
// spending limit of its own, so what all the parts spend together is held to the operation's limits, and the number running at once is held to `maxParallel`.

export interface ParallelPartContext extends WorkflowDependencyExecutionContext {
  /** Aborted when the operation is cancelled: a part stops its model session when it fires. */
  signal: AbortSignal;
}

export type IntegrationResult = { ok: true; treeSha: string } | { ok: false };

export interface ExecuteParallelWorkflowDependenciesInput extends Omit<ExecuteSerialWorkflowDependenciesInput, "execute"> {
  /** How many parts may run together: 1 to PARALLEL_PARTS_MAX. */
  maxParallel: number;
  /** Runs one part from `context.baseTreeSha` (the integrated tree it was started at) and returns the tree it produced. Its working copy is its own business to remove. */
  execute(item: TaskGraphV1["items"][number], context: ParallelPartContext): Promise<{ treeSha: string; summary?: string }>;
  /** Three-way merge of a finished part into the integrated tree; `baseTreeSha` is the tree the part started from. A conflict is `{ ok: false }`, never a guess. */
  integrate(input: { itemId: string; integratedTreeSha: string; baseTreeSha: string; partTreeSha: string }): Promise<IntegrationResult>;
  /** Makes the repository hold `treeSha`: called once at the end, success or failure, when the integrated tree is not the one the run started from. */
  checkout(treeSha: string): Promise<void>;
}

/** The failure of a run in which a part failed or could not be merged; the parts that failed are in `causes`. */
export class WorkflowPartsHaltedError extends Error {
  constructor(message: string, readonly causes: Error[]) {
    super(message, { cause: causes[0] });
    this.name = "WorkflowPartsHaltedError";
  }
}

const TREE = /^[a-f0-9]{40}$/;
const treeOf = (entry: WorkItemProgressV1): string | undefined => entry.integratedTreeSha ?? entry.candidateTreeSha;

/** Executes one approved graph with independent parts running together. Same inputs, progress events and result as the serial executor, plus `maxParallel`, `integrate` and `checkout`. */
export async function executeParallelWorkflowDependencies(input: ExecuteParallelWorkflowDependenciesInput): Promise<ExecuteSerialWorkflowDependenciesResult> {
  if (!Number.isInteger(input.maxParallel) || input.maxParallel < 1 || input.maxParallel > PARALLEL_PARTS_MAX) {
    throw new Error(`parallel parts must be between 1 and ${PARALLEL_PARTS_MAX}`);
  }
  const graph = TaskGraphV1Schema.parse(input.graph);
  if (taskGraphDigest(graph) !== input.graphDigest) throw new Error("approved work breakdown digest does not match its graph");
  if (!/^[a-f0-9-]{36}$/.test(input.runId) || !/^[a-f0-9-]{36}$/.test(input.operationId)) throw new Error("work breakdown run binding is invalid");
  if (!TREE.test(input.initialTreeSha)) throw new Error("work breakdown base tree is invalid");

  const order = taskGraphOrder(graph);
  const itemById = new Map(graph.items.map((workItem) => [workItem.id, workItem] as const));
  const done = new Set<string>();
  const outcomes = new Map<string, { treeSha: string; summary?: string }>();
  const progress: WorkItemProgressV1[] = [];
  let sequence = input.sequenceStart ?? 0;

  // Resume: any set of finished items closed under dependencies, from the newest integrated tree (the serial executor's prefix rule, relaxed to this test).
  let integrated = input.initialTreeSha;
  let newestRetained: WorkItemProgressV1 | undefined;
  for (const entry of input.resumeProgress ?? []) {
    if (entry.state !== "IMPLEMENTED") continue;
    if (!itemById.has(entry.itemId)) throw new Error("retained work breakdown checkpoint names an unknown item");
    if (treeOf(entry) === undefined) throw new Error("retained work breakdown checkpoint has no candidate tree");
    done.add(entry.itemId);
    outcomes.set(entry.itemId, { treeSha: treeOf(entry)! });
    if (newestRetained === undefined || entry.sequence > newestRetained.sequence) newestRetained = entry;
  }
  for (const itemId of done) {
    if (itemById.get(itemId)!.dependsOn.some((dependency) => !done.has(dependency))) throw new Error("retained work breakdown checkpoints are not closed under dependencies");
  }
  if (newestRetained !== undefined && treeOf(newestRetained) !== input.initialTreeSha) {
    throw new Error("workspace changed since the retained completed work breakdown parts");
  }

  // One checkpoint at a time, each acknowledged before the next is sent; sequence numbers are assigned inside the queue so they are unique and increasing.
  let queue: Promise<unknown> = Promise.resolve();
  const checkpoint = (value: Omit<WorkItemProgressV1, "sequence">): Promise<WorkItemProgressV1> => {
    const next = queue.then(async () => {
      const event = WorkItemProgressV1Schema.parse({ ...value, sequence: sequence + 1 });
      await input.persist(event);
      sequence += 1;
      progress.push(event);
      return event;
    });
    queue = next.catch(() => undefined);
    return next;
  };
  // Merges one at a time, in the order parts finish.
  let merging: Promise<unknown> = Promise.resolve();
  const exclusively = <T>(work: () => Promise<T>): Promise<T> => {
    const next = merging.then(work);
    merging = next.catch(() => undefined);
    return next;
  };

  const abort = new AbortController();
  const errors: Error[] = [];
  let halted = false;
  let cancelled = false;
  const started = new Set<string>(done);
  const alone: string[] = [];
  const running = new Map<string, Promise<void>>();
  const isCancelled = (): boolean => {
    if (!cancelled && input.shouldContinue?.() === false) {
      cancelled = true;
      abort.abort();
    }
    return cancelled;
  };
  const fail = (error: unknown): void => {
    halted = true;
    errors.push(error instanceof Error ? error : new Error(String(error)));
  };
  const record = (workItem: TaskGraphV1["items"][number], state: "FAILED" | "UNKNOWN", baseTreeSha: string): Promise<WorkItemProgressV1> =>
    checkpoint({ schemaVersion: 1, graphDigest: input.graphDigest, runId: input.runId, itemId: workItem.id, state, operationId: input.operationId, baseTreeSha, at: input.now(), producer: "agentx-worker" });

  /** One part, from its STARTED checkpoint to its merge. It never rejects; what went wrong is in `errors`. */
  const runPart = async (workItem: TaskGraphV1["items"][number], aloneNow: boolean): Promise<void> => {
    const baseTreeSha = integrated;
    const predecessorOutcomes = workItem.dependsOn.map((dependency) => {
      const outcome = outcomes.get(dependency);
      if (outcome === undefined) throw new Error("work breakdown is paused because a prerequisite has no acknowledged outcome");
      return { itemId: dependency, candidateTreeSha: outcome.treeSha, ...(outcome.summary === undefined ? {} : { summary: outcome.summary }) };
    });
    try {
      await checkpoint({ schemaVersion: 1, graphDigest: input.graphDigest, runId: input.runId, itemId: workItem.id, state: "STARTED", operationId: input.operationId, baseTreeSha, at: input.now(), producer: "agentx-worker" });
    } catch (error) {
      // Nothing started, so there is nothing to mark.
      fail(error);
      return;
    }
    let result: { treeSha: string; summary?: string };
    try {
      if (isCancelled()) throw new Error("work breakdown stopped because the operation was cancelled after this part's start checkpoint");
      result = await input.execute(workItem, { baseTreeSha, predecessorOutcomes, signal: abort.signal });
      if (!TREE.test(result.treeSha)) throw new Error("item returned an invalid candidate tree");
    } catch (error) {
      fail(error);
      await record(workItem, "FAILED", baseTreeSha).catch((checkpointError: unknown) => {
        fail(new Error("work breakdown is paused because a part's outcome and its checkpoint are uncertain", { cause: checkpointError }));
      });
      return;
    }
    const finished = result;
    await exclusively(async () => {
      let merged: IntegrationResult;
      try {
        merged = await input.integrate({ itemId: workItem.id, integratedTreeSha: integrated, baseTreeSha, partTreeSha: finished.treeSha });
      } catch (error) {
        fail(error);
        await record(workItem, "UNKNOWN", baseTreeSha).catch(() => undefined);
        return;
      }
      if (!merged.ok) {
        if (aloneNow) {
          // The second conflict (or any conflict of a part that ran alone) is final.
          fail(new Error("a part conflicts with the work already merged, even when built alone"));
          await record(workItem, "FAILED", baseTreeSha).catch(() => undefined);
        } else {
          alone.push(workItem.id);
        }
        return;
      }
      try {
        await checkpoint({
          schemaVersion: 1, graphDigest: input.graphDigest, runId: input.runId, itemId: workItem.id, state: "IMPLEMENTED", operationId: input.operationId, baseTreeSha,
          candidateTreeSha: finished.treeSha, integratedTreeSha: merged.treeSha, at: input.now(), producer: "agentx-worker",
        });
      } catch (error) {
        fail(new Error("work breakdown is paused because a part's outcome and its checkpoint are uncertain", { cause: error }));
        return;
      }
      integrated = merged.treeSha;
      done.add(workItem.id);
      outcomes.set(workItem.id, { treeSha: finished.treeSha, ...(finished.summary === undefined ? {} : { summary: finished.summary }) });
    });
  };

  const launch = (workItem: TaskGraphV1["items"][number], aloneNow: boolean): void => {
    started.add(workItem.id);
    const promise = runPart(workItem, aloneNow).catch(fail).finally(() => { running.delete(workItem.id); });
    running.set(workItem.id, promise);
  };

  try {
    for (;;) {
      if (!isCancelled() && !halted) {
        if (alone.length > 0) {
          // A part that conflicted is built again once, by itself, at the tree everything finished so far made; nothing else starts until it ends.
          if (running.size === 0) {
            const itemId = alone.shift()!;
            launch(itemById.get(itemId)!, true);
          }
        } else {
          for (const itemId of order) {
            if (running.size >= input.maxParallel) break;
            const workItem = itemById.get(itemId)!;
            if (started.has(itemId) || workItem.dependsOn.some((dependency) => !done.has(dependency))) continue;
            launch(workItem, false);
          }
        }
      }
      if (running.size === 0) break;
      await Promise.race(running.values());
      isCancelled();
    }
  } finally {
    // The repository ends on the integrated tree of the parts that finished, whether the run did or not.
    if (integrated !== input.initialTreeSha) {
      await input.checkout(integrated).catch((error: unknown) => { errors.push(error instanceof Error ? error : new Error(String(error))); });
    }
  }
  if (cancelled) throw new Error("work breakdown stopped because the operation was cancelled");
  if (errors.length > 0) throw new WorkflowPartsHaltedError("work breakdown is paused after a failed part", errors);
  if (done.size !== graph.items.length) throw new Error("work breakdown ended with parts that never ran");
  return { finalTreeSha: integrated, progress };
}
