// Lane L10, the build step: the records the publication and the pushes to an open pull request share.
import { fromDocument, type OperationRecord, type TaskRecord } from "../task-flow/records.js";
import { readTask } from "../task-flow/reads.js";
import { taskPointerKey } from "../task-flow/keys.js";
import type { TaskFlowDeps } from "../task-flow/deps.js";

export const pullRequestRecordKey = (workspaceId: string, repository: string, number: number): { pk: string; sk: string } =>
  ({ pk: `WORKSPACE#${workspaceId}`, sk: `PULL_REQUEST#${repository}#${String(number).padStart(10, "0")}` });

/** The pull request the broker opened for a publication: what `recordPublished` and merge tracking (`recordedHead`) read back. */
export interface PullRequestRecord {
  pk: string; sk: string; entityType: "PULL_REQUEST";
  workspaceId: string; repository: string; repositoryUrl: string; number: number; url: string; state: "open" | "closed" | "merged";
  headBranch: string; baseBranch: string; expectedHeadCommit: string; title: string; body: string;
  createdByOperationId: string; updatedAt: string;
  /** Why an earlier draft of a failed attempt was left open by a Retry (a person took it up). */
  leftOpen?: string;
  /** Set when the host's head was seen to differ from `expectedHeadCommit` (a push outside Rovara); cleared when it is back. Merge tracking then reads the head as someone else's. */
  changedOutside?: string;
  /** When the host's head was last read for this record. */
  headCheckedAt?: string;
}

export async function pullRequestRecordOf(deps: Pick<TaskFlowDeps, "store">, workspaceId: string, repository: string, number: number): Promise<PullRequestRecord | undefined> {
  return fromDocument<PullRequestRecord>(await deps.store.get(pullRequestRecordKey(workspaceId, repository, number)));
}

/** The task a worker operation belongs to (through its workspace's pointer). */
export async function taskOfOperation(deps: TaskFlowDeps, operation: OperationRecord): Promise<TaskRecord | undefined> {
  const pointer = await deps.store.get(taskPointerKey(operation.workspaceId));
  return typeof pointer?.["taskId"] === "string" ? readTask(deps, pointer["taskId"]) : undefined;
}
