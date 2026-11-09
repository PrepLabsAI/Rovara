// Lane L10 (review N1): a stop-gap until merge tracking runs on a timer (lane L12). The worker that pushed a pull request's branch held a push credential, and nothing else looks at the branch after
// its operation ends. So whenever a task is read (its page), the host's head of each open pull request Rovara opened is read and compared with the head Rovara recorded (`expectedHeadCommit`).
// A mismatch marks the pull request "changed outside Rovara" on its record (cleared if the head is back), the page says so, and `recordedHeadOf` stops answering for it, so merge tracking reads the
// head as someone else's and never calls the pull request ready. A head that cannot be read marks nothing (the host being down is not a push).
import { change, when } from "@agentx/contracts";
import { codeHostForRecord } from "../../plugins/routing.js";
import type { TaskFlowDeps } from "../task-flow/deps.js";
import type { TaskRecord } from "../task-flow/records.js";
import { iso, log } from "../task-flow/support.js";
import { pullRequestRecordKey, pullRequestRecordOf } from "./records.js";

export const CHANGED_OUTSIDE_NOTE = "changed outside Rovara: the pull request's code is no longer what Rovara checked";
/** A head is not read again for the same pull request within this long (a page that reloads is not a request for the host each time). */
export const HEAD_CHECK_MAX_AGE_MS = 15_000;

export interface HeadCheck { repository: string; number: number; changedOutside: boolean }

/** Reads the host's head of each open pull request of the task and compares it with the head Rovara recorded. */
export async function checkPullRequestHeads(deps: TaskFlowDeps, task: TaskRecord, options: { maxAgeMs?: number } = {}): Promise<HeadCheck[]> {
  const workflow = task.workflow;
  if (workflow === undefined || deps.codeHosts === undefined || task.closedAt !== undefined) return [];
  const results: HeadCheck[] = [];
  const project = await deps.projects.revision(task.project, task.startingRevision);
  const nowMs = (deps.now?.() ?? new Date()).getTime();
  for (const pullRequest of (workflow.pullRequests ?? []).filter((entry) => entry.state === "OPEN" || entry.state === "UNKNOWN")) {
    const record = await pullRequestRecordOf(deps, task.workspaceId, pullRequest.repositoryId, pullRequest.number);
    const definition = project?.definition.repositories.find((entry) => entry.name === pullRequest.repositoryId);
    if (record === undefined || definition === undefined) continue;
    const flagged = record.changedOutside !== undefined;
    const checkedAt = record.headCheckedAt === undefined ? undefined : Date.parse(record.headCheckedAt);
    if (checkedAt !== undefined && nowMs - checkedAt < (options.maxAgeMs ?? HEAD_CHECK_MAX_AGE_MS)) { results.push({ repository: pullRequest.repositoryId, number: pullRequest.number, changedOutside: flagged }); continue; }
    try {
      const host = codeHostForRecord(deps.codeHosts, definition);
      const remote = await host.getChangeRequest({ repository: { url: definition.url }, id: String(pullRequest.number), url: pullRequest.url }, { orgId: deps.companyId });
      const outside = remote.state === "open" && remote.headRevision !== record.expectedHeadCommit;
      await deps.store.update({
        key: pullRequestRecordKey(task.workspaceId, pullRequest.repositoryId, pullRequest.number),
        ops: [change.set("headCheckedAt", iso(deps)), outside ? change.set("changedOutside", `${CHANGED_OUTSIDE_NOTE} (head ${remote.headRevision.slice(0, 12)}).`) : change.remove("changedOutside")], condition: when.present(),
      });
      results.push({ repository: pullRequest.repositoryId, number: pullRequest.number, changedOutside: outside });
    } catch (error) {
      log(deps, { event: "build_step.head_not_read", taskId: task.taskId, number: pullRequest.number, error: error instanceof Error ? error.name : "unknown" });
      results.push({ repository: pullRequest.repositoryId, number: pullRequest.number, changedOutside: flagged });
    }
  }
  return results;
}

/**
 * The head Rovara last pushed to a pull request, for merge tracking's `recordedHead`: undefined when the record is missing or the pull request was seen changed outside Rovara, so tracking reads the
 * head as someone else's and never takes the pull request out of draft.
 */
export function recordedHeadOf(deps: Pick<TaskFlowDeps, "store">): (workspaceId: string, repositoryId: string, number: number) => Promise<string | undefined> {
  return async (workspaceId, repositoryId, number) => {
    const record = await pullRequestRecordOf(deps, workspaceId, repositoryId, number);
    return record === undefined || record.changedOutside !== undefined ? undefined : record.expectedHeadCommit;
  };
}
