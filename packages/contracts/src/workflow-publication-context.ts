import { createHash } from "node:crypto";
import { z } from "zod";
import type { WorkerInvocation } from "./protocol.js";

const sha1 = z.string().regex(/^[a-f0-9]{40}$/);

export const WorkflowPublicationContextV1Schema = z.object({
  schemaVersion: z.literal("workflow-publication-context/v1"),
  workspaceId: z.string().uuid(),
  operationId: z.string().uuid(),
  fence: z.number().int().positive(),
  projectRevision: z.number().int().positive(),
  kind: z.literal("publish"),
  mode: z.literal("create"),
  publicationMode: z.enum(["COMMITTED_HEAD", "CHECKED_TREE"]),
  repository: z.string().min(1).max(255),
  repositoryUrl: z.string().min(1).max(4_096),
  repositoryPath: z.string().min(1).max(4_096),
  defaultBranch: z.string().min(1).max(1_024),
  headBranch: z.string().min(1).max(1_024),
  candidateTreeSha: sha1,
  candidateCommitSha: sha1.nullable(),
  workflowBaseCommit: sha1.nullable(),
}).strict().superRefine((context, issue) => {
  if ((context.publicationMode === "COMMITTED_HEAD") !== (context.candidateCommitSha !== null)) {
    issue.addIssue({ code: "custom", path: ["candidateCommitSha"], message: "publication mode and exact commit must agree" });
  }
});

export type WorkflowPublicationContextV1 = z.infer<typeof WorkflowPublicationContextV1Schema>;

/** Extracts the immutable destination and candidate tuple from a workflow publish invocation. */
export function workflowPublicationContext(invocation: WorkerInvocation): WorkflowPublicationContextV1 | undefined {
  if (invocation.kind !== "publish") return undefined;
  const payload = invocation.payload;
  const workflowFieldsPresent = payload.publicationMode !== undefined || payload.candidateTreeSha !== undefined
    || payload.candidateCommitSha !== undefined || payload.workflowBaseCommit !== undefined;
  if (!workflowFieldsPresent) return undefined;
  if (payload.publicationMode === undefined || payload.candidateTreeSha === undefined) {
    throw new TypeError("workflow publication context is incomplete");
  }
  const repository = payload.project.repositories.find((entry) => entry.name === payload.repository);
  if (repository === undefined) throw new TypeError("workflow publication repository is not registered in the invocation");
  return WorkflowPublicationContextV1Schema.parse({
    schemaVersion: "workflow-publication-context/v1",
    workspaceId: invocation.workspaceId,
    operationId: invocation.operationId,
    fence: invocation.fence,
    projectRevision: invocation.projectRevision,
    kind: "publish",
    mode: payload.mode,
    publicationMode: payload.publicationMode,
    repository: payload.repository,
    repositoryUrl: repository.url,
    repositoryPath: repository.path,
    defaultBranch: repository.defaultBranch,
    headBranch: payload.headBranch,
    candidateTreeSha: payload.candidateTreeSha,
    candidateCommitSha: payload.candidateCommitSha ?? null,
    workflowBaseCommit: payload.workflowBaseCommit ?? null,
  });
}

/** Hashes a fixed-order primitive tuple; nullable fields remain explicit in the signed context. */
export function workflowPublicationContextDigest(context: WorkflowPublicationContextV1): string {
  const value = WorkflowPublicationContextV1Schema.parse(context);
  const tuple = [value.schemaVersion, value.workspaceId, value.operationId, value.fence, value.projectRevision,
    value.kind, value.mode, value.publicationMode, value.repository, value.repositoryUrl, value.repositoryPath,
    value.defaultBranch, value.headBranch, value.candidateTreeSha, value.candidateCommitSha, value.workflowBaseCommit];
  return createHash("sha256").update(JSON.stringify(tuple), "utf8").digest("hex");
}
