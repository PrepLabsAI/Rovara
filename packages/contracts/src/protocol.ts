import { z } from "zod";
import { ProjectCommandSchema, StoredProjectDefinitionSchema } from "./project.js";
import { ModelSelectionSchema, type ModelSelection } from "./models.js";

export const AGENTX_PROTOCOL_VERSION = 1 as const;

/**
 * Optional invocation fields that this build's worker parses and an older one does not (spec 053).
 * Worker payload schemas are strict, and a running EC2 worker keeps its image until the idle reaper
 * stops it, so an older worker rejects an invocation that carries one of these. A worker reports the
 * list on GET /ping, and the eval runner image release records it beside the image, so the control
 * plane sends such a field only to a build that lists it.
 */
export const WORKER_INVOCATION_FEATURES = ["model.thinkingLevel", "task.readiness", "task.workflowMode", "publish.reportChecks"] as const;
export type WorkerInvocationFeature = (typeof WORKER_INVOCATION_FEATURES)[number];
/** The field on /ping that carries WORKER_INVOCATION_FEATURES; absent on a worker built before it. */
export const WORKER_PING_FEATURES_FIELD = "invocationFeatures";

/** The model as a build with `features` can parse it: the thinking level only where it is listed. */
export function modelSelectionFor(model: ModelSelection, features: readonly string[]): ModelSelection {
  if (model.thinkingLevel === undefined || features.includes("model.thinkingLevel")) return model;
  return { provider: model.provider, modelId: model.modelId };
}

const InvocationBaseSchema = z.object({
  protocolVersion: z.literal(AGENTX_PROTOCOL_VERSION),
  operationId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  fence: z.number().int().positive(),
  projectRevision: z.number().int().positive(),
  callbackCapability: z.string().min(32).max(8_192),
});

export const WorkerInvocationSchema = z.discriminatedUnion("kind", [
  InvocationBaseSchema.extend({
    kind: z.literal("prepare"),
    payload: z.object({ project: StoredProjectDefinitionSchema, repositoryGrant: z.string().min(1) }).strict(),
  }).strict(),
  InvocationBaseSchema.extend({
    kind: z.literal("task"),
    payload: z
      .object({
        conversationId: z.string().uuid(),
        prompt: z.string().min(1).max(65_536),
        /** The control plane's record that this conversation already owns a saved session. */
        conversationStarted: z.boolean().optional(),
        /** The broker-selected tool boundary for the current native workflow stage (spec 056). */
        workflowMode: z.enum(["PLAN", "IMPLEMENT"]).optional(),
        model: ModelSelectionSchema.optional(),
        modelSelectionDiagnostic: z.string().min(1).max(512).optional(),
        /**
         * Spec 051 (P-1): the project's current readiness commands, which the worker reruns when the agent finishes.
         * Optional: a payload from a broker built before it has none, and the worker falls back to the agent's own
         * test commands. Sent only to a worker whose /ping lists "task.readiness". The limit is the project's own.
         */
        readiness: z.array(ProjectCommandSchema).max(64).optional(),
      })
      .strict(),
  }).strict(),
  InvocationBaseSchema.extend({
    kind: z.literal("publish"),
    payload: z
      .object({
        project: StoredProjectDefinitionSchema,
        repository: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
        title: z.string().min(1).max(256),
        body: z
          .string()
          .refine((value) => !value.includes("\0"), "body contains a NUL character")
          .refine(
            (value) => new TextEncoder().encode(value).byteLength <= 32_768,
            "body exceeds 32768 UTF-8 bytes",
          )
          .optional(),
        headBranch: z.string().regex(/^agentx\/[0-9a-f-]{36}$/i),
        repositoryGrant: z.string().min(1),
        mode: z.enum(["create", "replace", "revert"]).default("create"),
        targetPullRequestNumber: z.number().int().positive().optional(),
        revertCommit: z.string().regex(/^[a-f0-9]{40,64}$/).optional(),
        /**
         * Spec 051 (D-7, P-2): the broker opens a draft pull request with a checks section when a check fails, so the
         * worker publishes despite a failing readiness check and reports its checks with the pull request callback.
         * Without it (a broker built before it), a failing check still refuses the publication, as before. Sent only
         * to a worker whose /ping lists "publish.reportChecks".
         */
        reportChecks: z.literal(true).optional(),
      })
      .strict()
      .superRefine((value, context) => {
        if (value.mode === "create" && (value.targetPullRequestNumber !== undefined || value.revertCommit !== undefined)) {
          context.addIssue({ code: "custom", message: "create mode must not target another pull request" });
        }
        if ((value.mode === "replace" || value.mode === "revert") && value.targetPullRequestNumber === undefined) {
          context.addIssue({ code: "custom", message: `${value.mode} mode requires targetPullRequestNumber` });
        }
        if (value.mode === "revert" && value.revertCommit === undefined) {
          context.addIssue({ code: "custom", message: "revert mode requires revertCommit" });
        }
        if (value.mode !== "revert" && value.revertCommit !== undefined) {
          context.addIssue({ code: "custom", message: "revertCommit is allowed only in revert mode" });
        }
      }),
  }).strict(),
  InvocationBaseSchema.extend({
    kind: z.literal("maintain"),
    payload: z
      .object({
        action: z.enum(["append", "sync"]),
        project: StoredProjectDefinitionSchema,
        repository: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
        pullRequestNumber: z.number().int().positive(),
        headBranch: z.string().regex(/^agentx\/[0-9a-f-]{36}$/i),
        baseBranch: z.string().min(1).max(255),
        expectedHeadCommit: z.string().regex(/^[a-f0-9]{40,64}$/),
        repositoryGrant: z.string().min(1),
      })
      .strict(),
  }).strict(),
  InvocationBaseSchema.extend({
    kind: z.literal("cancel"),
    payload: z.object({ targetOperationId: z.string().uuid() }).strict(),
  }).strict(),
  InvocationBaseSchema.extend({ kind: z.literal("resume"), payload: z.object({}).strict() }).strict(),
  InvocationBaseSchema.extend({ kind: z.literal("close"), payload: z.object({}).strict() }).strict(),
]);

export const WorkerAcknowledgementSchema = z
  .object({ accepted: z.boolean(), operationId: z.string().uuid(), status: z.string().min(1) })
  .strict();

export type WorkerInvocation = z.infer<typeof WorkerInvocationSchema>;
