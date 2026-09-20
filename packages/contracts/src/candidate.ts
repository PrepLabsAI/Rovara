import { z } from "zod";
import { createHash } from "node:crypto";

export function candidateArtifactId(operationId: string, name: string): string {
  const hex = createHash("sha256").update(`${operationId}\n${name}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export const MAX_CANDIDATE_BYTES = 64 * 1024 * 1024;
export const CANDIDATE_CHUNK_BYTES = 2 * 1024 * 1024;
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const CandidateRequestSchema = z.object({
  jobId: z.string().uuid(),
  attempt: z.number().int().positive(),
  repository: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
  baseCommit: sha,
}).strict();

export const CandidateResultSchema = z.object({
  schemaVersion: z.literal(1),
  candidateId: z.string().uuid(),
  jobId: z.string().uuid(),
  attempt: z.number().int().positive(),
  operationId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  projectRevision: z.number().int().positive(),
  repository: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
  repositoryUrl: z.string().url(),
  baseCommit: sha,
  commit: sha,
  tree: sha,
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  producer: z.literal("agentx-worker"),
  qualification: z.literal("claimed"),
  retrieval: z.object({
    kind: z.literal("agentx-artifacts"),
    format: z.literal("git-bundle"),
    sha256: digest,
    sizeBytes: z.number().int().positive().max(MAX_CANDIDATE_BYTES),
    chunks: z.array(z.object({
      artifactId: z.string().uuid(),
      name: z.string().regex(/^candidate-[0-9a-f-]{36}-[0-9]{4}\.bundle\.base64$/),
      sha256: digest,
      sizeBytes: z.number().int().positive().max(CANDIDATE_CHUNK_BYTES),
    }).strict()).min(1).max(32),
  }).strict(),
}).strict().superRefine((value, context) => {
  if (value.candidateId !== value.operationId || Date.parse(value.expiresAt) <= Date.parse(value.createdAt)) {
    context.addIssue({ code: "custom", message: "candidate identity or lifetime is invalid" });
  }
  if (value.retrieval.chunks.reduce((sum, chunk) => sum + chunk.sizeBytes, 0) !== value.retrieval.sizeBytes ||
      new Set(value.retrieval.chunks.map((chunk) => chunk.artifactId)).size !== value.retrieval.chunks.length ||
      value.retrieval.chunks.some((chunk, index) => chunk.name !== `candidate-${value.operationId}-${String(index).padStart(4, "0")}.bundle.base64`)) {
    context.addIssue({ code: "custom", message: "candidate chunk manifest is inconsistent" });
  }
});

// Actor identity is supplied by authenticated broker admission, never inferred from model output.
export const CandidatePublicationAuthorizationSchema = z.object({
  actor: z.string().min(1).max(256),
  jobId: z.string().uuid(),
  candidateId: z.string().uuid(),
  commit: sha,
  action: z.literal("create-pull-request"),
  repository: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
  baseBranch: z.string().min(1).max(255),
  evidencePacketRef: z.string().min(1).max(2048),
  expiresAt: z.string().datetime(),
}).strict();

export type CandidateRequest = z.infer<typeof CandidateRequestSchema>;
export type CandidateResult = z.infer<typeof CandidateResultSchema>;
export type CandidatePublicationAuthorization = z.infer<typeof CandidatePublicationAuthorizationSchema>;
