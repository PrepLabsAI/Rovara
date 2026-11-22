// Tracking supplies the same host-neutral ports on local and deployed installs.
import type { ReadBudget, RegistryView } from "@agentx/contracts";
import { isCoreFeedbackTask } from "./ownership.js";
import type { TaskRecord } from "../task-flow/records.js";
import { recoverPrFeedback } from "./recovery.js";
import { collectPrFeedback, type PrFeedbackCollectionDeps } from "./collect.js";
import { agentXError } from "@agentx/contracts";
import type { MergeDependencies } from "../merge/merge.js";
import type { TaskFlowDeps } from "../task-flow/deps.js";
import { readMergeTracking } from "../merge/store.js";
import { readTask } from "../task-flow/reads.js";
import { createReadBudget, createRepositoryResolver } from "../../services/merge-tracking.js";

export async function collectTrackedFeedback(deps: Omit<PrFeedbackCollectionDeps, "blobs"> & { registry: RegistryView }, task: TaskRecord, budget: ReadBudget): Promise<"unchanged" | "collected" | "retry"> {
  if (!await isCoreFeedbackTask(deps.flow, task)) return "unchanged";
  await recoverPrFeedback(deps.flow, task);
  // Once tracking has identified an outside push, keep its cheap status reads running.
  // Its head ownership check still holds Merge/fix/sync/ready; do not reread all comments each pass.
  const tracking = await readMergeTracking(deps.flow.store, task.taskId, task.companyId);
  if (tracking.some(item => !item.headByRovara)) return "unchanged";
  return collectPrFeedback({ ...deps, blobs: deps.registry.require("object-storage") }, task, budget);
}

/** A direct Merge press must not rely on the last scheduled tracking read. */
export function withFeedbackMergeReads(merge: MergeDependencies, flow: TaskFlowDeps, registry: RegistryView): MergeDependencies {
  return { ...merge, host: { ...merge.host, loadTask: async taskId => {
    const task = await readTask(flow, taskId);
    if (task === undefined || task.companyId !== flow.companyId) return undefined;
    const { budget, stop } = createReadBudget(merge.now);
    try {
      const collected = await collectTrackedFeedback({ flow, registry, repository: createRepositoryResolver(flow, registry), now: merge.now }, task, budget);
      if (collected === "retry") throw agentXError("MERGE_NOT_READY", "The current pull request feedback could not be verified. Refresh the task before merging.");
    } finally { stop(); }
    return merge.host.loadTask(taskId);
  } } };
}
