import { agentXError, type WorkerInvocation } from "@agentx/contracts";
import type { ArtifactSink } from "./artifacts.js";
import type { EventBatchSink } from "./events.js";
import type { WorkerTerminalResult } from "./server.js";

export type TerminalResultSink = (result: WorkerTerminalResult) => Promise<void>;

export function createWorkerCallbackSinks(input: {
  controlPlaneUrl: string;
  invocation: WorkerInvocation;
  fetchImplementation?: typeof fetch;
}): { eventSink: EventBatchSink; artifactSink: ArtifactSink; terminalSink: TerminalResultSink } {
  const fetchImplementation = input.fetchImplementation ?? fetch;
  const base = input.controlPlaneUrl.replace(/\/$/, "");
  const prefix = `${base}/v1/internal/workspaces/${input.invocation.workspaceId}/operations/${input.invocation.operationId}`;
  const post = async (path: string, body: unknown): Promise<void> => {
    const response = await fetchImplementation(`${prefix}/${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agentx-callback-capability": input.invocation.callbackCapability,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw agentXError("RUNTIME_UNAVAILABLE", `worker callback ${path} failed with HTTP ${response.status}`);
    }
  };
  return {
    eventSink: async (events) => post("events", { events }),
    artifactSink: async (artifact) => post("artifacts", artifact),
    terminalSink: async (result) => post("result", {
      status: result.status,
      ...(result.result === undefined ? {} : { result: result.result }),
      ...(result.error === undefined ? {} : { error: result.error }),
    }),
  };
}
