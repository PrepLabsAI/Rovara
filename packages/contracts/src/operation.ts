import { Buffer } from "node:buffer";
import { z } from "zod";
import { SlackRequesterSchema } from "./slack.js";

/** Spec 025 FR-022: an operation a developer started from an AI tool. */
export const DeveloperRequesterSchema = z
  .object({
    kind: z.literal("developer"),
    developerId: z.string().regex(/^[a-f0-9]{64}$/),
    provider: z.enum(["slack", "oidc"]),
  })
  .strict();
export const OperationRequesterSchema = z.union([SlackRequesterSchema, DeveloperRequesterSchema]);
export type DeveloperRequester = z.infer<typeof DeveloperRequesterSchema>;
export type OperationRequester = z.infer<typeof OperationRequesterSchema>;

export const OperationKindSchema = z.enum([
  "prepare",
  "task",
  "publish",
  "maintain",
  "resume",
  "stop",
  "cancel",
  "close",
]);
export const OperationStatusSchema = z.enum([
  "ACCEPTED",
  "DISPATCHING",
  "RUNNING",
  "CANCEL_REQUESTED",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "INTERRUPTED",
]);

export const OperationRequestSchema = z
  .object({
    requestId: z.string().uuid(),
    conversationId: z.string().uuid(),
    prompt: z
      .string()
      .min(1)
      .refine((value) => Buffer.byteLength(value, "utf8") <= 65_536, "prompt exceeds 65536 UTF-8 bytes"),
  })
  .strict();

export const PullRequestRequestSchema = z
  .object({
    requestId: z.string().uuid(),
    repository: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
    title: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .refine(
        (value) => ![...value].some((character) => {
          const code = character.codePointAt(0) ?? 0;
          return code < 32 || code === 127;
        }),
        "title contains control characters",
      ),
    body: z
      .string()
      .refine((value) => !value.includes("\0"), "body contains a NUL character")
      .refine((value) => Buffer.byteLength(value, "utf8") <= 32_768, "body exceeds 32768 UTF-8 bytes")
      .optional(),
    draft: z.boolean().optional(),
  })
  .strict();

export const PullRequestLifecycleActionSchema = z.enum([
  "append",
  "sync",
  "edit",
  "close",
  "reopen",
  "replace",
  "revert",
]);

const lifecycleTitleSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine(
    (value) => ![...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127;
    }),
    "title contains control characters",
  );

const lifecycleBodySchema = z
  .string()
  .refine((value) => !value.includes("\0"), "body contains a NUL character")
  .refine((value) => Buffer.byteLength(value, "utf8") <= 32_768, "body exceeds 32768 UTF-8 bytes");

export const PullRequestLifecycleRequestSchema = z
  .object({
    requestId: z.string().uuid(),
    repository: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
    pullRequestNumber: z.number().int().positive(),
    action: PullRequestLifecycleActionSchema,
    title: lifecycleTitleSchema.optional(),
    body: lifecycleBodySchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.action === "edit" && value.title === undefined && value.body === undefined) {
      context.addIssue({ code: "custom", message: "edit requires title or body" });
    }
    if (
      ["append", "sync", "close", "reopen"].includes(value.action) &&
      (value.title !== undefined || value.body !== undefined)
    ) {
      context.addIssue({ code: "custom", message: `${value.action} must not include title or body` });
    }
  });

export const PublicationCheckResultSchema = z
  .object({
    index: z.number().int().nonnegative(),
    cwd: z.string().min(1).max(512),
    executable: z.string().min(1).max(256),
    exitCode: z.number().int(),
    stdout: z.string().max(1_048_576),
    stderr: z.string().max(1_048_576),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime(),
    outcome: z.enum(["passed", "failed", "timed_out"]),
  })
  .strict();

export const CodeBuildStatusSchema = z.enum([
  "IN_PROGRESS",
  "SUCCEEDED",
  "FAILED",
  "FAULT",
  "STOPPED",
  "TIMED_OUT",
]);

export const CodeBuildCheckResultSchema = z
  .object({
    gate: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
    projectName: z.string().regex(/^agentx-[A-Za-z0-9_-]+$/),
    buildId: z.string().min(3).max(1_024),
    status: CodeBuildStatusSchema,
    requestedSourceVersion: z.string().regex(/^[a-f0-9]{40,64}$/),
    resolvedSourceVersion: z.string().regex(/^[a-f0-9]{40,64}$/).optional(),
    currentPhase: z.string().min(1).max(128).optional(),
    startedAt: z.string().datetime().optional(),
    completedAt: z.string().datetime().optional(),
    logsUrl: z.string().url().refine((value) => new URL(value).protocol === "https:", "URL must use HTTPS").optional(),
  })
  .strict();

export const PullRequestResultSchema = z
  .object({
    repository: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
    number: z.number().int().positive(),
    url: z.string().url().refine((value) => new URL(value).protocol === "https:", "URL must use HTTPS"),
    headBranch: z.string().regex(/^agentx\/[0-9a-f-]{36}$/i),
    baseBranch: z.string().min(1).max(255),
    commit: z.string().regex(/^[a-f0-9]{40,64}$/),
    checks: z.array(PublicationCheckResultSchema).max(64),
    codeBuildChecks: z.array(CodeBuildCheckResultSchema).max(8).default([]),
    reconciled: z.boolean(),
  })
  .strict();

export const PullRequestLifecycleResultSchema = z
  .object({
    action: PullRequestLifecycleActionSchema,
    repository: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
    number: z.number().int().positive(),
    url: z.string().url().refine((value) => new URL(value).protocol === "https:", "URL must use HTTPS"),
    state: z.enum(["open", "closed", "merged"]),
    headBranch: z.string().regex(/^agentx\/[0-9a-f-]{36}$/i),
    baseBranch: z.string().min(1).max(255),
    previousCommit: z.string().regex(/^[a-f0-9]{40,64}$/).optional(),
    commit: z.string().regex(/^[a-f0-9]{40,64}$/),
    checks: z.array(PublicationCheckResultSchema).max(64),
    codeBuildChecks: z.array(CodeBuildCheckResultSchema).max(8).default([]),
    reconciled: z.boolean(),
    replacementFor: z.number().int().positive().optional(),
    replacedBy: z.number().int().positive().optional(),
  })
  .strict();

export const OperationSchema = z
  .object({
    id: z.string().uuid(),
    workspaceId: z.string().uuid(),
    conversationId: z.string().uuid().optional(),
    kind: OperationKindSchema,
    requestId: z.string().uuid(),
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    status: OperationStatusSchema,
    fence: z.number().int().positive(),
    heartbeatAt: z.string().datetime().optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    result: z.unknown().optional(),
    error: z.string().max(16_384).optional(),
    requestedBy: OperationRequesterSchema.optional(),
  })
  .strict();

export const TERMINAL_OPERATION_STATUSES = new Set([
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "INTERRUPTED",
] as const);

export type Operation = z.infer<typeof OperationSchema>;
export type OperationRequest = z.infer<typeof OperationRequestSchema>;
export type OperationStatus = z.infer<typeof OperationStatusSchema>;
export type PullRequestRequest = z.infer<typeof PullRequestRequestSchema>;
export type PullRequestLifecycleAction = z.infer<typeof PullRequestLifecycleActionSchema>;
export type PullRequestLifecycleRequest = z.infer<typeof PullRequestLifecycleRequestSchema>;
export type PullRequestLifecycleResult = z.infer<typeof PullRequestLifecycleResultSchema>;
export type PublicationCheckResult = z.infer<typeof PublicationCheckResultSchema>;
export type CodeBuildStatus = z.infer<typeof CodeBuildStatusSchema>;
export type CodeBuildCheckResult = z.infer<typeof CodeBuildCheckResultSchema>;
export type PullRequestResult = z.infer<typeof PullRequestResultSchema>;
