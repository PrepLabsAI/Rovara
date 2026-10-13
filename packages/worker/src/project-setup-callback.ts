import type { WorkerInvocation } from "@agentx/contracts";
import type { WorkerTerminalResult } from "./server.js";

export async function postProjectSetupTerminalResult(input: {
  controlPlaneUrl: string;
  invocation: Extract<WorkerInvocation, { kind: "project-setup-smoke" }>;
  result: WorkerTerminalResult;
  fetchImplementation?: typeof fetch;
}): Promise<void> {
  const { invocation, result } = input;
  const body = result.result && typeof result.result === "object" ? result.result as Record<string, unknown> : {};
  const response = await (input.fetchImplementation ?? fetch)(new URL(`/v1/internal/project-setups/${invocation.payload.setupExecutionId}/operations/${invocation.operationId}/result`, input.controlPlaneUrl), {
    method: "POST", headers: { "content-type": "application/json", "x-agentx-callback-capability": invocation.callbackCapability },
    body: JSON.stringify({ domain: "project-setup-source-interface/v1", setupExecutionId: invocation.payload.setupExecutionId,
      operationId: invocation.operationId, candidateDigest: typeof body.candidateDigest === "string" ? body.candidateDigest : "0".repeat(64),
      processStatus: result.status === "SUCCEEDED" ? "SUCCEEDED" : "FAILED",
      qualification: result.status === "SUCCEEDED" && (body.qualification === "PASS" || body.qualification === "FAILED") ? body.qualification : "UNKNOWN",
      cleanupConfirmed: body.cleanupConfirmed === true, ...(body.evidenceRef && typeof body.evidenceRef === "object" ? { evidenceRef: body.evidenceRef } : {}) }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`project setup callback returned HTTP ${response.status}`);
}
