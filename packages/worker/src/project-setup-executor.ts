import type { WorkerInvocation } from "@agentx/contracts";
import type { ContainedRuntimeReadiness } from "@agentx/verifier";
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

/** Production composition for the optional capability; the supplied factory remains lazy so a
 * missing verifier prerequisite cannot prevent ordinary worker startup. */
export function createReadinessGatedProjectSetupRuntime(
  readiness: ContainedRuntimeReadiness,
  executorFactory: () => ReturnType<typeof createDefaultProjectSetupExecutor>,
) {
  const available = readiness.status === "ready";
  return Object.freeze({
    invocationFeatures: available ? ["project.setupSmoke"] as const : [] as const,
    invocationFeatureDiagnostics: Object.freeze({ "project.setupSmoke": readiness }),
    async execute(invocation: Parameters<ReturnType<typeof createDefaultProjectSetupExecutor>>[0]) {
      if (!available) throw new Error(`project.setupSmoke is unavailable: ${readiness.reason}`);
      return executorFactory()(invocation);
    },
  });
}
