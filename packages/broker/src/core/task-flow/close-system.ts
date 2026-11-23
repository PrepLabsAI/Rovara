// A system closer's close through the BOUND path: the abandoned-review sweep finds a retained inspection that says the workspace is clean, and closes the task bound to that preview's digest. It never
// discards (no `discard_unpublished`), so the destruction is `destroyRetained` and nothing is destroyed without the proof. The request id is derived from the closer and its own key, so a repeated sweep
// replays the same acceptance instead of starting another.
import { AgentXError } from "@agentx/contracts";
import { SYSTEM_CLOSE_PROVIDER, closeOperationId, systemCloseActorId } from "./close-acceptance-record.js";
import { commitAcceptance, prepareAcceptance, type CloseIntent } from "./close-acceptance.js";
import type { CloseSnapshot } from "./close-inspection.js";
import type { TaskCaller, TaskFlowDeps } from "./deps.js";
import type { OperationRecord, TaskRecord } from "./records.js";

/** The caller a system closer reads and accepts a close as. Its person id is its own (`system:<closer>`), never a member's. */
export const systemCloseCaller = (deps: Pick<TaskFlowDeps, "companyId">, closer: string): TaskCaller => ({
  principal: { companyId: deps.companyId, personId: systemCloseActorId(closer), displayName: "Rovara", roles: [], provider: SYSTEM_CLOSE_PROVIDER },
});

/** One close request per closer and key (the review's workflow revision): the same id every sweep, so a repeat is a replay. */
export const systemCloseRequestId = (deps: Pick<TaskFlowDeps, "companyId">, taskId: string, closer: string, key: string): string => closeOperationId(deps.companyId, taskId, `system:${closer}:${key}`);

/**
 * Accepts the close, bound to the digest of the retained preview the guard just read. Undefined when the preview changed under it (a step started, a newer inspection): the caller then skips, as it would
 * for any workspace it cannot prove clean.
 */
export async function acceptSystemClose(deps: TaskFlowDeps, task: TaskRecord, closer: string, key: string, snapshot: CloseSnapshot): Promise<OperationRecord | undefined> {
  const intent: CloseIntent = { requestId: systemCloseRequestId(deps, task.taskId, closer, key), expectedPreviewDigest: snapshot.preview.digest };
  try {
    return await commitAcceptance(deps, await prepareAcceptance(deps, systemCloseCaller(deps, closer), task, intent, []));
  } catch (error) {
    if (error instanceof AgentXError && error.code === "CHANGE_STALE") return undefined;
    throw error;
  }
}
