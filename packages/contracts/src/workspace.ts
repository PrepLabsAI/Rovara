import { z } from "zod";
import { agentXError } from "./errors.js";
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
  // Spec 014: a thread's workspace record whose compute has not been prepared. Only Slack services
  // that send lazyPreparation: true are ever shown it.
  "UNPREPARED",
]);

export const WorkspaceDeploymentModeSchema = z.enum(["instances-ebs", "demo-microvm", "ec2-ebs"]);

const WorkspaceRecordSchema = z
  .object({
    id: z.string().uuid(),
    ownerKey: z.string().min(16).max(128),
    projectName: AgentXNameSchema,
    projectRevision: z.number().int().positive(),
    runtimeArn: z.string().startsWith("arn:aws:bedrock-agentcore:").optional(),
    endpointQualifier: z.string().min(1).max(64).optional(),
    runtimeSessionId: z.string().uuid().optional(),
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
  .strict();

// Workspace records written before the environment pin was removed still carry
// `environmentDigest`; it is dropped rather than rejected.
export const WorkspaceInstanceSchema = z.preprocess((value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const remaining: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  delete remaining.environmentDigest;
  return remaining;
}, WorkspaceRecordSchema
  .superRefine((workspace, context) => {
    const agentCoreFields = ["runtimeArn", "endpointQualifier", "runtimeSessionId"] as const;
    switch (workspace.deploymentMode) {
      case "instances-ebs":
      case "demo-microvm":
        for (const field of agentCoreFields) {
          if (workspace[field] === undefined) {
            context.addIssue({ code: "custom", path: [field], message: `${workspace.deploymentMode} workspaces require ${field}` });
          }
        }
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
        break;
      case "ec2-ebs":
        for (const field of [...agentCoreFields, "capacityProviderArn"] as const) {
          if (workspace[field] !== undefined) {
            context.addIssue({ code: "custom", path: [field], message: `ec2-ebs workspaces must not have ${field}` });
          }
        }
        break;
      default:
        unhandledDeploymentMode(workspace.deploymentMode);
    }
    if (workspace.status === "CLOSED" && !workspace.closedAt) {
      context.addIssue({ code: "custom", path: ["closedAt"], message: "closed workspaces require closedAt" });
    }
  })
  // The refinement above guarantees the per-mode shape that WorkspaceInstance describes.
  .transform((workspace) => workspace as WorkspaceInstance));

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

export type WorkspaceStatus = z.infer<typeof WorkspaceStatusSchema>;
export type WorkspaceDeploymentMode = z.infer<typeof WorkspaceDeploymentModeSchema>;
// Modes whose compute is a Bedrock AgentCore runtime session. ec2-ebs workspaces run on instances
// the Session Manager launches, so they carry none of the AgentCore routing fields.
export type AgentCoreDeploymentMode = Exclude<WorkspaceDeploymentMode, "ec2-ebs">;

type WorkspaceInstanceBase = Omit<
  z.output<typeof WorkspaceRecordSchema>,
  "deploymentMode" | "runtimeArn" | "endpointQualifier" | "runtimeSessionId" | "capacityProviderArn"
>;

export interface AgentCoreWorkspaceInstance extends WorkspaceInstanceBase {
  deploymentMode: AgentCoreDeploymentMode;
  runtimeArn: string;
  endpointQualifier: string;
  runtimeSessionId: string;
  capacityProviderArn?: string | undefined;
}

/** Compute state for an ec2-ebs workspace lives in its SESSION record, not here. */
export interface Ec2WorkspaceInstance extends WorkspaceInstanceBase {
  deploymentMode: "ec2-ebs";
}

export type WorkspaceInstance = AgentCoreWorkspaceInstance | Ec2WorkspaceInstance;
export type WorkspaceCloseReason = z.infer<typeof WorkspaceCloseReasonSchema>;
export type WorkspaceClosePreflightResult = z.infer<typeof WorkspaceClosePreflightResultSchema>;

/**
 * The default branch of a switch over deployment modes, so adding a mode fails to compile there.
 * Takes the mode, or the record the switch narrowed.
 */
export function unhandledDeploymentMode(value: never): never {
  const mode: unknown = typeof value === "object" && value !== null ? (value as { deploymentMode?: unknown }).deploymentMode : value;
  throw agentXError("CONFIG_INVALID", `unsupported deployment mode ${String(mode)}`);
}
