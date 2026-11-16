// MR3b (TE-R3): the source of `MergeDependencies.repositoryEdges` and of the tracking pass's order reads. TE-MR2's worker records which of a task's repositories depend on which (`EvidenceRaw.repositoryEdges`);
// the broker keeps those facts beside the evidence pack, for the exact code (`loadRepositoryEdges`). This seam answers them for a task's CURRENT code, in the shape `mergeOrderOf` reads.
//
//  - No candidate on the workflow, or no facts kept for it: `undefined` (no facts; the merge order, digest and words are today's, byte for byte).
//  - Something kept that cannot be trusted, a task of another company, or a task the host cannot place: the seam THROWS (a fixed sentence, never the cause). The merge reads a throwing seam as "no safe order" until a person
//    confirms the override (DEC 209), and the tracking pass reads it as "cannot tell" and does nothing.
//  - Company scope: the blob store is scoped to one company by its own key (`createDocumentEvidenceBlobStore`), the seam is built for that company, and a task of any other company is refused before anything is read.
import type { OrgId } from "@agentx/contracts";
import { loadRepositoryEdges } from "../proof/evidence-keep.js";
import type { TaskFlowDeps } from "../task-flow/deps.js";
import { readTask } from "../task-flow/reads.js";
import type { EvidenceBlobStore } from "../proof/evidence-blob-store.js";
import type { TaskRecord } from "../task-flow/records.js";
import { ciWaitLinesOfTask, mergeOrderLinesOfTask } from "./order-watch.js";
import type { MergeTask } from "./seams.js";

/** Where a task's evidence lives (the evidence keys name an owner and a workspace). Undefined for a task the host does not know. */
export type EvidenceHome = { ownerKey: string; workspaceId: string };

export interface RepositoryEdgesSeamOptions {
  blobs: Pick<EvidenceBlobStore, "get" | "stat">;
  /** The company this seam serves (Code: its one implicit company). */
  companyId: OrgId;
  /** Where the task's evidence lives, from the task record. A task of another company, or an unknown one, is undefined. */
  locate(task: MergeTask): Promise<EvidenceHome | undefined>;
}

/** The sentence a refusal carries: fixed words, never the task's text or the cause. */
export const REPOSITORY_EDGES_UNREADABLE = "the dependency facts for this task's repositories could not be read";

export function createRepositoryEdgesSeam(options: RepositoryEdgesSeamOptions): (task: MergeTask) => Promise<unknown> {
  return async (task) => {
    if (task.orgId !== options.companyId) throw new Error(REPOSITORY_EDGES_UNREADABLE);
    const digest = task.workflow?.candidate?.digest;
    if (digest === undefined) return undefined;
    const home = await options.locate(task);
    if (home === undefined) throw new Error(REPOSITORY_EDGES_UNREADABLE);
    const kept = await loadRepositoryEdges(options.blobs, { ownerKey: home.ownerKey, workspaceId: home.workspaceId, taskId: task.taskId }, digest);
    if (kept.kind === "unreadable") throw new Error(REPOSITORY_EDGES_UNREADABLE);
    return kept.kind === "none" ? undefined : kept.edges;
  };
}

/**
 * The seam over a task flow's own records: where a task's evidence lives is read from its record, and a task of another company (or an unknown one) is undefined. A host with its own task store passes `locate` itself.
 */
export function createTaskRepositoryEdgesSeam(options: { flow: Pick<TaskFlowDeps, "store">; blobs: RepositoryEdgesSeamOptions["blobs"]; companyId: OrgId }): (task: MergeTask) => Promise<unknown> {
  return createRepositoryEdgesSeam({
    blobs: options.blobs, companyId: options.companyId,
    locate: async (task) => {
      const record = await readTask(options.flow, task.taskId);
      return record === undefined || record.companyId !== options.companyId ? undefined : { ownerKey: record.ownerKey, workspaceId: record.workspaceId };
    },
  });
}

/** The merge-order lines for a task record (the flow's `mergeOrderLines`, `attention` and the pull request descriptions read them): from the task's own record, through the same seam. Never throws. */
export function createMergeOrderLines(options: {
  flow: Pick<TaskFlowDeps, "store">; companyId: OrgId; repositoryEdges: (task: MergeTask) => Promise<unknown>; log?: (event: string, fields: Record<string, unknown>) => void;
}): (task: TaskRecord, repositoryId?: string) => Promise<readonly string[]> {
  return async (task, repositoryId) => {
    const merge = mergeTaskOfRecord(task, options.companyId);
    return merge === undefined ? [] : mergeOrderLinesOfTask({ repositoryEdges: options.repositoryEdges, ...(options.log === undefined ? {} : { log: options.log }) }, merge, repositoryId).catch(() => []);
  };
}

/** MR4: the page's words for a pull request whose CI is failing while a repository it depends on waits (`TaskFlowDeps.ciWaitLines`). From the task's own record, through the same seam. Never throws. */
export function createCiWaitLines(options: {
  flow: Pick<TaskFlowDeps, "store">; companyId: OrgId; repositoryEdges: (task: MergeTask) => Promise<unknown>; log?: (event: string, fields: Record<string, unknown>) => void;
}): (task: TaskRecord, repositoryId: string) => Promise<readonly string[]> {
  return async (task, repositoryId) => {
    const merge = mergeTaskOfRecord(task, options.companyId);
    return merge === undefined ? [] : ciWaitLinesOfTask({ repositoryEdges: options.repositoryEdges, ...(options.log === undefined ? {} : { log: options.log }) }, merge, repositoryId).catch(() => []);
  };
}

function mergeTaskOfRecord(task: TaskRecord, companyId: OrgId): (MergeTask & { workflow: NonNullable<TaskRecord["workflow"]> }) | undefined {
  if (task.companyId !== companyId || task.workflow === undefined) return undefined;
  return {
    taskId: task.taskId, orgId: companyId, project: task.project, startingRevision: task.startingRevision, workspaceId: task.workspaceId,
    ownerId: task.workflow.ownerId, ownerName: "the owner", workflow: task.workflow,
  };
}
