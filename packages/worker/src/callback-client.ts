import { agentXError, type WorkerInvocation } from "@agentx/contracts";
import type { ArtifactSink } from "./artifacts.js";
import type { EventBatchSink } from "./events.js";
import type { WorkerTerminalResult } from "./server.js";

export type TerminalResultSink = (result: WorkerTerminalResult) => Promise<void>;

export interface PullRequestCallbackInput {
  repository: string;
  repositoryUrl: string;
  headBranch: string;
  baseBranch: string;
  commit: string;
  title: string;
  body?: string;
}

export interface PullRequestCallbackResult {
  number: number;
  url: string;
  reconciled: boolean;
}

export type PullRequestSink = (input: PullRequestCallbackInput) => Promise<PullRequestCallbackResult>;

export interface PullRequestUpdateCallbackInput {
  repository: string;
  pullRequestNumber: number;
  action: "append" | "sync";
  headBranch: string;
  baseBranch: string;
  previousCommit: string;
  commit: string;
}

export interface PullRequestUpdateCallbackResult {
  url: string;
  state: "open" | "closed" | "merged";
  reconciled: boolean;
}

export type PullRequestUpdateSink = (
  input: PullRequestUpdateCallbackInput,
) => Promise<PullRequestUpdateCallbackResult>;

export function createWorkerCallbackSinks(input: {
  controlPlaneUrl: string;
  invocation: WorkerInvocation;
  fetchImplementation?: typeof fetch;
}): {
  eventSink: EventBatchSink;
  artifactSink: ArtifactSink;
  terminalSink: TerminalResultSink;
  pullRequestSink: PullRequestSink;
  pullRequestUpdateSink: PullRequestUpdateSink;
} {
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
  const postForResult = async (path: string, body: unknown): Promise<unknown> => {
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
    return response.json();
  };
  return {
    eventSink: async (events) => post("events", { events }),
    artifactSink: async (artifact) => post("artifacts", artifact),
    terminalSink: async (result) => post("result", {
      status: result.status,
      ...(result.result === undefined ? {} : { result: result.result }),
      ...(result.error === undefined ? {} : { error: result.error }),
    }),
    pullRequestSink: async (request) => {
      const value = await postForResult("pull-request", request);
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw agentXError("RUNTIME_UNAVAILABLE", "pull request callback response is invalid");
      }
      const result = value as Record<string, unknown>;
      if (
        !Number.isInteger(result.number) ||
        (result.number as number) < 1 ||
        typeof result.url !== "string" ||
        !result.url.startsWith("https://") ||
        typeof result.reconciled !== "boolean"
      ) {
        throw agentXError("RUNTIME_UNAVAILABLE", "pull request callback response is invalid");
      }
      return {
        number: result.number as number,
        url: result.url,
        reconciled: result.reconciled,
      };
    },
    pullRequestUpdateSink: async (request) => {
      const value = await postForResult("pull-request-update", request);
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw agentXError("RUNTIME_UNAVAILABLE", "pull request update callback response is invalid");
      }
      const result = value as Record<string, unknown>;
      if (
        typeof result.url !== "string" ||
        !result.url.startsWith("https://") ||
        (result.state !== "open" && result.state !== "closed" && result.state !== "merged") ||
        typeof result.reconciled !== "boolean"
      ) {
        throw agentXError("RUNTIME_UNAVAILABLE", "pull request update callback response is invalid");
      }
      return { url: result.url, state: result.state, reconciled: result.reconciled };
    },
  };
}
