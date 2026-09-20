import { z } from "zod";
import { AgentXNameSchema, OCI_DIGEST_PATTERN } from "./project.js";

export const WorkspaceStatusSchema = z.enum([
  "PREPARING",
  "READY",
  "PREPARATION_FAILED",
  "BUSY",
  "UNHEALTHY",
  "STOPPED",
  "RESUMING",
]);

export const WorkspaceDeploymentModeSchema = z.enum(["instances-ebs", "demo-microvm"]);

export const WorkspaceInstanceSchema = z
  .object({
    id: z.string().uuid(),
    ownerKey: z.string().min(16).max(128),
    projectName: AgentXNameSchema,
    projectRevision: z.number().int().positive(),
    environmentDigest: z.string().regex(OCI_DIGEST_PATTERN),
    runtimeArn: z.string().startsWith("arn:aws:bedrock-agentcore:"),
    endpointQualifier: z.string().min(1).max(64),
    runtimeSessionId: z.string().uuid(),
    deploymentMode: WorkspaceDeploymentModeSchema,
    capacityProviderArn: z.string().startsWith("arn:aws:bedrock-agentcore:").optional(),
    rootPath: z.literal("/mnt/workspace"),
    status: WorkspaceStatusSchema,
    preparationManifest: z.string().max(1_024).optional(),
    activeOperationId: z.string().uuid().nullable().default(null),
    candidateTaskOperationId: z.string().uuid().optional(),
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
  });

export type WorkspaceInstance = z.infer<typeof WorkspaceInstanceSchema>;
export type WorkspaceStatus = z.infer<typeof WorkspaceStatusSchema>;
export type WorkspaceDeploymentMode = z.infer<typeof WorkspaceDeploymentModeSchema>;
