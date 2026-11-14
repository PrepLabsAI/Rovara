import type { OrgId, SessionId } from "@agentx/contracts";
import { cancelTask, retryBlockedStep, revisePlanWithLiveMessage, type TaskFlowDeps } from "../core/index.js";

export type SessionActionsServiceOptions = TaskFlowDeps;

/**
 * Task-level actions over the host's injected ports. The host must authorize the caller and resolve
 * the task's company, session and owner before invoking these actions (as the local session routes do).
 * This factory does not replace the session control's access and idempotency checks.
 * Import the factory from `@agentx/broker`, or the individual functions from `@agentx/broker/core`.
 */
export function createSessionActionsService(deps: SessionActionsServiceOptions) {
  return {
    retryBlockedStep: (taskId: string, expectedRevision?: number) => retryBlockedStep(deps, taskId, expectedRevision),
    cancelTask: (taskId: string) => cancelTask(deps, taskId),
    revisePlanWithLiveMessage: (orgId: OrgId, sessionId: SessionId, input: { taskId: string; ownerDeveloperId: string }, value: unknown) => revisePlanWithLiveMessage(deps, orgId, sessionId, input, value),
  };
}

export type SessionActionsService = ReturnType<typeof createSessionActionsService>;
