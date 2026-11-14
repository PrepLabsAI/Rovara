import { z } from "zod";

export const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const TreeSchema = z.string().regex(/^[a-f0-9]{40}$/);

export const WorkflowDependencyApprovalSchema = z.object({
  artifactDigest: DigestSchema,
  graphDigest: DigestSchema,
  workflowRevision: z.number().int().positive(),
  actorId: z.string().regex(/^[a-f0-9]{64}$/),
  runId: z.string().uuid(),
}).strict();

export const WorkItemProgressV1Schema = z.object({
  schemaVersion: z.literal(1),
  graphDigest: DigestSchema,
  runId: z.string().uuid(),
  itemId: z.string().uuid(),
  sequence: z.number().int().positive(),
  state: z.enum(["STARTED", "IMPLEMENTED", "FAILED", "UNKNOWN"]),
  operationId: z.string().uuid(),
  baseTreeSha: TreeSchema,
  candidateTreeSha: TreeSchema.optional(),
  /**
   * Parallel parts (Rovara Code v2): the tree of everything merged so far once this part was merged in, which the next part starts from. A serial run never sets it.
   * Only implemented progress names one.
   */
  integratedTreeSha: TreeSchema.optional(),
  at: z.string().datetime(),
  producer: z.string().trim().min(1).max(80),
}).strict().superRefine((progress, context) => {
  if (progress.state === "IMPLEMENTED" && progress.candidateTreeSha === undefined) {
    context.addIssue({ code: "custom", path: ["candidateTreeSha"], message: "implemented progress requires a candidate tree" });
  }
  if (progress.state !== "IMPLEMENTED" && progress.candidateTreeSha !== undefined) {
    context.addIssue({ code: "custom", path: ["candidateTreeSha"], message: "only implemented progress may name a candidate tree" });
  }
  if (progress.state !== "IMPLEMENTED" && progress.integratedTreeSha !== undefined) {
    context.addIssue({ code: "custom", path: ["integratedTreeSha"], message: "only implemented progress may name an integrated tree" });
  }
});
