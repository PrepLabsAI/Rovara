import { z } from "zod";
import { DeveloperTaskStatusSchema } from "./developer-tasks.js";

export const TaskCloseDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const TaskCloseActionSchema = z.enum(["close", "discard"]);
export const TaskCloseInspectionSchema = z.object({
  operationId: z.string().uuid(),
  workspaceFence: z.number().int().nonnegative(),
  contentDigest: TaskCloseDigestSchema,
}).strict();

// This module is also consumed by browsers. Keep runtime dependencies browser compatible.
export const TaskClosePreviewSchema = z.object({
  action: TaskCloseActionSchema,
  taskId: z.string().uuid(),
  digest: TaskCloseDigestSchema,
  taskStatus: DeveloperTaskStatusSchema,
  workflow: z.object({ revision: z.number().int().nonnegative(), stage: z.string(), state: z.string() }).strict().nullable(),
  workspace: z.object({
    status: z.enum(["PREPARING", "READY", "PREPARATION_FAILED", "BUSY", "UNHEALTHY", "STOPPED", "RESUMING", "CLOSING", "CLOSED", "UNPREPARED"]),
    fence: z.number().int().nonnegative(), activeOperationId: z.string().uuid().nullable(),
  }).strict(),
  unpublished: z.array(z.object({
    repository: z.string().min(1),
    reasons: z.array(z.enum(["worktree_changes", "untracked_files", "unpushed_head", "unpushed_branch"])).min(1).max(4),
  }).strict()).max(32),
  inspection: TaskCloseInspectionSchema.nullable(),
}).strict().superRefine((preview, ctx) => {
  if (new Set(preview.unpublished.map((r) => r.repository)).size !== preview.unpublished.length) {
    ctx.addIssue({ code: "custom", path: ["unpublished"], message: "repository identities must be unique" });
  }
  for (const [i, repository] of preview.unpublished.entries()) {
    if (new Set(repository.reasons).size !== repository.reasons.length) ctx.addIssue({ code: "custom", path: ["unpublished", i, "reasons"], message: "reasons must be unique" });
  }
  if (preview.action === "discard" && preview.inspection === null) ctx.addIssue({ code: "custom", path: ["inspection"], message: "discard requires a complete inspection" });
  if (preview.inspection === null && preview.unpublished.length !== 0) ctx.addIssue({ code: "custom", path: ["unpublished"], message: "findings require their inspection" });
  if (preview.inspection !== null && preview.inspection.workspaceFence !== preview.workspace.fence) ctx.addIssue({ code: "custom", path: ["inspection"], message: "inspection must describe this workspace fence" });
});

export const TaskClosePreviewResponseSchema = z.union([
  z.object({ preview: TaskClosePreviewSchema }).strict(),
  z.object({ preview: z.null(), unavailable: z.enum(["inspection_required", "busy", "unsupported"]) }).strict(),
]);

export type TaskClosePreview = z.infer<typeof TaskClosePreviewSchema>;
export type TaskClosePreviewResponse = z.infer<typeof TaskClosePreviewResponseSchema>;
export type TaskCloseAction = z.infer<typeof TaskCloseActionSchema>;
export type TaskCloseInspection = z.infer<typeof TaskCloseInspectionSchema>;
