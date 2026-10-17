import { createHash } from "node:crypto";
import {
  CodeBuildCheckResultSchema,
  WorkflowFeedbackBundleRefSchema,
  WorkflowFeedbackApprovalBindingSchema,
  WorkflowFeedbackTaskChecksSchema,
  agentXError,
  type CheckEntry,
  type WorkerInvocation,
  type WorkflowFeedbackApprovalBinding,
  type WorkflowFeedbackTaskChecks,
  type E2EWorkflowAdmissionRef,
} from "@agentx/contracts";
import type { ArtifactSink } from "./artifacts.js";
import type { EventBatchSink } from "./events.js";
import type { WorkerTerminalResult } from "./server.js";
import type { CodeBuildSink } from "./codebuild.js";
import type { CommittedCandidateSourceExport } from "./verification/candidate.js";

export type TerminalResultSink = (result: WorkerTerminalResult) => Promise<void>;

export interface FeedbackBundleReadResult {
  taskRequirements: string;
  /** The task's checks, from a broker that sends them, so the reviewer can list the ones its fix makes wrong. */
  taskChecks?: WorkflowFeedbackTaskChecks;
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
  candidateSourceExportSink: (source: CommittedCandidateSourceExport) => Promise<void>;
  workflowE2EAdmissionReader: (reference: E2EWorkflowAdmissionRef, offset: number) => Promise<{ totalBytes: number; chunkBase64: string; sha256: string }>;
  workflowE2EEvidenceSink: (bytes: Uint8Array, sha256: string, maxBytes: number, groupRunId?: string) => Promise<{ key: string; sha256: string }>;
  feedbackBundleReader: FeedbackBundleReader;
  authorizeFeedbackApproval: FeedbackApprovalAuthorizer;
  /** #341: the task owner's ChatGPT access token, for a task that runs on their plan (unparsed; see chatgpt-token.ts). */
  chatGptToken: () => Promise<unknown>;
  /** #342: tells the control plane why the task stopped using its owner's ChatGPT plan. */
  chatGptFallback: (reason: "limit" | "revoked" | "model") => Promise<void>;
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
  const candidateSourceExportSink = async (source: CommittedCandidateSourceExport): Promise<void> => {
    const bytes = Buffer.from(JSON.stringify(source), "utf8");
    const chunkBytes = 64 * 1024;
    const chunkCount = Math.ceil(bytes.byteLength / chunkBytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const initialized = await postForResult("candidate-export", { stage: "init", schemaVersion: "workflow-candidate-export-upload/v1",
      totalBytes: bytes.byteLength, chunkCount, sha256 });
    if (!initialized || typeof initialized !== "object" || typeof (initialized as { uploadId?: unknown }).uploadId !== "string"
      || (initialized as { chunkBytes?: unknown }).chunkBytes !== chunkBytes || (initialized as { chunkCount?: unknown }).chunkCount !== chunkCount) {
      throw agentXError("RUNTIME_UNAVAILABLE", "candidate source upload initialization is invalid");
    }
    const uploadId = (initialized as { uploadId: string }).uploadId;
    for (let index = 0; index < chunkCount; index += 1) {
      const chunk = bytes.subarray(index * chunkBytes, Math.min((index + 1) * chunkBytes, bytes.byteLength));
      await postForResult("candidate-export", { stage: "chunk", schemaVersion: "workflow-candidate-export-chunk/v1", uploadId, index,
        bytesBase64: chunk.toString("base64"), sha256: createHash("sha256").update(chunk).digest("hex") });
    }
    await postForResult("candidate-export", { stage: "finalize", schemaVersion: "workflow-candidate-export-finalize/v1", uploadId, sha256 });
  };
  const workflowE2EAdmissionReader = async (reference: E2EWorkflowAdmissionRef, offset: number) => {
    const value = await postForResult("e2e-admission", { stage: "read", offset, sha256: reference.admissionRef.sha256 });
    if (!value || typeof value !== "object" || Array.isArray(value)) throw agentXError("RUNTIME_UNAVAILABLE", "native E2E admission response is invalid");
    const record = value as Record<string, unknown>;
    if (record.totalBytes !== reference.admissionRef.byteLength || record.sha256 !== reference.admissionRef.sha256
      || record.offset !== offset || typeof record.chunkBase64 !== "string") throw agentXError("RUNTIME_UNAVAILABLE", "native E2E admission chunk does not match its signed reference");
    return { totalBytes: record.totalBytes, chunkBase64: record.chunkBase64, sha256: record.sha256 };
  };
  const workflowE2EEvidenceSink = async (bytes: Uint8Array, sha256: string, maxBytes: number, groupRunId?: string) => {
    if (bytes.byteLength <= 0 || bytes.byteLength > maxBytes) throw agentXError("CONFIG_INVALID", "native E2E evidence exceeds its admitted limit");
    const chunkBytes = 64 * 1024;
    const chunkCount = Math.ceil(bytes.byteLength / chunkBytes);
    const groupBinding = groupRunId === undefined ? {} : { groupRunId };
    const initialized = await postForResult("e2e-evidence", { stage: "init", ...groupBinding, totalBytes: bytes.byteLength, chunkCount, sha256 });
    if (!initialized || typeof initialized !== "object" || typeof (initialized as { uploadId?: unknown }).uploadId !== "string"
      || (initialized as { chunkBytes?: unknown }).chunkBytes !== chunkBytes || (initialized as { chunkCount?: unknown }).chunkCount !== chunkCount
      || groupRunId !== undefined && (initialized as { groupRunId?: unknown }).groupRunId !== groupRunId) {
      throw agentXError("RUNTIME_UNAVAILABLE", "native E2E evidence upload initialization is invalid");
    }
    const initRecord = initialized as { complete?: unknown; groupRunId?: unknown; evidenceRef?: { key?: unknown; sha256?: unknown } };
    if (initRecord.complete === true) {
      if (groupRunId === undefined || initRecord.groupRunId !== groupRunId || initRecord.evidenceRef?.sha256 !== sha256
        || typeof initRecord.evidenceRef.key !== "string") throw agentXError("RUNTIME_UNAVAILABLE", "completed native E2E group upload does not match this run");
      return { key: initRecord.evidenceRef.key, sha256 };
    }
    const uploadId = (initialized as { uploadId: string }).uploadId;
    for (let index = 0; index < chunkCount; index += 1) {
      const chunk = Buffer.from(bytes).subarray(index * chunkBytes, Math.min((index + 1) * chunkBytes, bytes.byteLength));
      await postForResult("e2e-evidence", { stage: "chunk", ...groupBinding, uploadId, index, bytesBase64: chunk.toString("base64"),
        sha256: createHash("sha256").update(chunk).digest("hex") });
    }
    const finalized = await postForResult("e2e-evidence", { stage: "finalize", ...groupBinding, uploadId, sha256 });
    if (!finalized || typeof finalized !== "object" || typeof (finalized as { key?: unknown }).key !== "string"
      || (finalized as { sha256?: unknown }).sha256 !== sha256) throw agentXError("RUNTIME_UNAVAILABLE", "native E2E evidence finalization is invalid");
    return { key: (finalized as { key: string }).key, sha256 };
  };
  return {
    eventSink: async (events) => post("events", { events }),
    chatGptToken: async () => postForResult("chatgpt-token", {}),
    chatGptFallback: async (reason) => post("chatgpt-status", { reason }),
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
      const taskChecks = record.taskChecks === undefined ? undefined : WorkflowFeedbackTaskChecksSchema.safeParse(record.taskChecks);
      if (taskChecks !== undefined && !taskChecks.success) throw agentXError("RUNTIME_UNAVAILABLE", "feedback bundle callback response is invalid");
      return { taskRequirements: record.taskRequirements, bundles, ...(taskChecks === undefined ? {} : { taskChecks: taskChecks.data }) };
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
    candidateSourceExportSink,
    workflowE2EAdmissionReader,
    workflowE2EEvidenceSink,
  };
}
