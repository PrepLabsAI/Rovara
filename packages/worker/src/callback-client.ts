import {
  CodeBuildCheckResultSchema,
  WorkflowFeedbackBundleRefSchema,
  WorkflowFeedbackApprovalBindingSchema,
  agentXError,
  type CheckEntry,
  type WorkerInvocation,
  type WorkflowFeedbackApprovalBinding,
} from "@agentx/contracts";
import type { ArtifactSink } from "./artifacts.js";
import type { EventBatchSink } from "./events.js";
import type { WorkerTerminalResult } from "./server.js";
import type { CodeBuildSink } from "./codebuild.js";

export type TerminalResultSink = (result: WorkerTerminalResult) => Promise<void>;

export interface FeedbackBundleReadResult {
  taskRequirements: string;
  bundles: Array<{ ref: ReturnType<typeof WorkflowFeedbackBundleRefSchema.parse>; bytes: string }>;
}

export type FeedbackBundleReader = (binding: { taskId: string; workflowRevision: number; candidateDigest: string }) => Promise<FeedbackBundleReadResult>;
export type FeedbackApprovalAuthorizer = (binding: WorkflowFeedbackApprovalBinding) => Promise<void>;

export interface PullRequestCallbackInput {
  repository: string;
  repositoryUrl: string;
  headBranch: string;
  baseBranch: string;
  commit: string;
  title: string;
  body?: string;
  /**
   * Spec 051 (D-7): publish's readiness checks, each judged against its before. Sent only when the publish payload
   * asks for them (reportChecks), so a broker built before it never sees the field.
   */
  checks?: CheckEntry[];
}

export interface PullRequestCallbackResult {
  number: number;
  url: string;
  reconciled: boolean;
  /** Spec 051 Ruling Z: the pull request opened as a draft. A broker built before it omits this. */
  draft?: boolean;
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
  codeBuildSink: CodeBuildSink;
  feedbackBundleReader: FeedbackBundleReader;
  authorizeFeedbackApproval: FeedbackApprovalAuthorizer;
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
    feedbackBundleReader: async (binding) => {
      const value = await postForResult("feedback-bundles", binding);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw agentXError("RUNTIME_UNAVAILABLE", "feedback bundle callback response is invalid");
      const record = value as Record<string, unknown>;
      if (typeof record.taskRequirements !== "string" || !Array.isArray(record.bundles)) throw agentXError("RUNTIME_UNAVAILABLE", "feedback bundle callback response is invalid");
      const bundles = record.bundles.map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw agentXError("RUNTIME_UNAVAILABLE", "feedback bundle callback response is invalid");
        const item = entry as Record<string, unknown>;
        if (typeof item.bytesBase64 !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.bytesBase64)) throw agentXError("RUNTIME_UNAVAILABLE", "feedback bundle callback response is invalid");
        const bytes = Buffer.from(item.bytesBase64, "base64");
        if (bytes.toString("base64") !== item.bytesBase64) throw agentXError("RUNTIME_UNAVAILABLE", "feedback bundle callback response encoding is invalid");
        return { ref: WorkflowFeedbackBundleRefSchema.parse(item.ref), bytes: bytes.toString("utf8") };
      });
      return { taskRequirements: record.taskRequirements, bundles };
    },
    authorizeFeedbackApproval: async (binding) => {
      const approval = WorkflowFeedbackApprovalBindingSchema.parse(binding);
      const value = await postForResult("feedback-approval", approval);
      if (!value || typeof value !== "object" || Array.isArray(value) || (value as Record<string, unknown>).authorized !== true) {
        throw agentXError("STALE_FENCE", "the owner-approved PR feedback is no longer authorized");
      }
    },
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
        ...(typeof result.draft === "boolean" ? { draft: result.draft } : {}),
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
    codeBuildSink: async (request) => {
      const value = await postForResult("codebuild", request);
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw agentXError("RUNTIME_UNAVAILABLE", "CodeBuild callback response is invalid");
      }
      const build = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).filter(([key]) => key !== "requestId"),
      );
      return CodeBuildCheckResultSchema.parse(build);
    },
  };
}
