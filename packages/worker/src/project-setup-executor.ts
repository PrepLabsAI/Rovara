import type { WorkerInvocation } from "@agentx/contracts";
import { executeProjectSetupSmoke } from "./project-setup-smoke.js";
import { createProjectSetupTransfer } from "./project-setup-transfer.js";

export function createDefaultProjectSetupExecutor(input: { sourceRoot: string; evidenceRoot: string; controlPlaneUrl: string }) {
  return async (invocation: Extract<WorkerInvocation, { kind: "project-setup-smoke" }>): Promise<unknown> => {
    const transfer = createProjectSetupTransfer({ controlPlaneUrl: input.controlPlaneUrl, invocation: {
      ...invocation.payload, operationId: invocation.operationId, fence: invocation.fence, callbackCapability: invocation.callbackCapability,
    } });
    return executeProjectSetupSmoke({ invocation, sourceRoot: input.sourceRoot, evidenceRoot: input.evidenceRoot, ...transfer });
  };
}
