import { z } from "zod";
import { AgentXNameSchema } from "./project.js";

export const WorkspaceStatusSchema = z.enum([
  "PREPARING",
  "READY",
  "PREPARATION_FAILED",
  "BUSY",
  "UNHEALTHY",
  "STOPPED",
  "RESUMING",
  "CLOSING",
  "CLOSED",
]);

export const WorkspaceDeploymentModeSchema = z.enum(["instances-ebs", "demo-microvm"]);

// Workspace records written before the environment pin was removed still carry
// `environmentDigest`; it is dropped rather than rejected.
export const WorkspaceInstanceSchema = z.preprocess((value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const remaining: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  delete remaining.environmentDigest;
  return remaining;
}, z
  .object({
    id: z.string().uuid(),
    ownerKey: z.string().min(16).max(128),
    projectName: AgentXNameSchema,
    projectRevision: z.number().int().positive(),
    runtimeArn: z.string().startsWith("arn:aws:bedrock-agentcore:"),
    endpointQualifier: z.string().min(1).max(64),
    runtimeSessionId: z.string().uuid(),
    deploymentMode: WorkspaceDeploymentModeSchema,
    capacityProviderArn: z.string().startsWith("arn:aws:bedrock-agentcore:").optional(),
    rootPath: z.literal("/mnt/workspace"),
    status: WorkspaceStatusSchema,
    preparationManifest: z.string().max(1_024).optional(),
    closeOperationId: z.string().uuid().optional(),
    closedAt: z.string().datetime().optional(),
    closedBy: z
      .object({
        teamId: z.string().regex(/^[TE][A-Z0-9]{2,31}$/),
        userId: z.string().regex(/^[UW][A-Z0-9]{2,31}$/),
      })
      .strict()
      .optional(),
    closeError: z.string().max(16_384).optional(),
    activeOperationId: z.string().uuid().nullable().default(null),
    fence: z.number().int().nonnegative(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((workspace, context) => {
    if (workspace.deploymentMode === "instances-ebs" && !workspace.capacityProviderArn) {
      context.addIssue({
        code: "custom",
        path: ["capacityProviderArn"],
        message: "instances-ebs workspaces require a capacity provider ARN",
      });
    }
    if (workspace.deploymentMode === "demo-microvm" && workspace.capacityProviderArn) {
      context.addIssue({
        code: "custom",
        path: ["capacityProviderArn"],
        message: "demo-microvm workspaces must not have a capacity provider ARN",
      });
    }
    if (workspace.status === "CLOSED" && !workspace.closedAt) {
      context.addIssue({ code: "custom", path: ["closedAt"], message: "closed workspaces require closedAt" });
    }
  }));

export const WorkspaceCloseReasonSchema = z.enum([
  "worktree_changes",
  "untracked_files",
  "unpushed_head",
  "unpushed_branch",
]);

export const WorkspaceClosePreflightResultSchema = z
  .object({
    safeToClose: z.boolean(),
    repositories: z
      .array(
        z
          .object({
            name: AgentXNameSchema,
            reasons: z.array(WorkspaceCloseReasonSchema).min(1).max(4),
          })
          .strict(),
      )
      .max(32),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.safeToClose !== (result.repositories.length === 0)) {
      context.addIssue({ code: "custom", message: "safeToClose must match whether repository findings are empty" });
    }
    for (const [index, repository] of result.repositories.entries()) {
      if (new Set(repository.reasons).size !== repository.reasons.length) {
        context.addIssue({ code: "custom", path: ["repositories", index, "reasons"], message: "reasons must be unique" });
      }
    }
  });

export type WorkspaceInstance = z.infer<typeof WorkspaceInstanceSchema>;
export type WorkspaceStatus = z.infer<typeof WorkspaceStatusSchema>;
export type WorkspaceDeploymentMode = z.infer<typeof WorkspaceDeploymentModeSchema>;
export type WorkspaceCloseReason = z.infer<typeof WorkspaceCloseReasonSchema>;
export type WorkspaceClosePreflightResult = z.infer<typeof WorkspaceClosePreflightResultSchema>;
