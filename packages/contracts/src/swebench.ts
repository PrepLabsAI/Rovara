// Spec 043: SWE-bench runs started from Slack. One run scores the coding agent on one SWE-bench
// task instance, on its own x86 instance, outside any workspace.
import { z } from "zod";
import { ModelIdentifierSchema } from "./models.js";
import { SlackRequesterSchema, SlackThreadSchema, SlackChannelIdSchema, SlackTeamIdSchema } from "./slack.js";
import { TaskUsageTelemetrySchema } from "./usage.js";

/** The datasets a run may name, and the Hugging Face dataset each maps to. */
export const SWEBENCH_DATASETS = {
  verified: "SWE-bench/SWE-bench_Verified",
  lite: "SWE-bench/SWE-bench_Lite",
  full: "SWE-bench/SWE-bench",
} as const;

export const SwebenchDatasetSchema = z.enum(["verified", "lite", "full"]);

/** `<owner>__<repository>-<number>`, as every SWE-bench instance ID is written. */
export const SwebenchInstanceIdSchema = z.string().max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*__[A-Za-z0-9][A-Za-z0-9_.-]*-\d+$/, "not a SWE-bench instance ID");

/** Per-run cost ceiling bounds and default, in USD (spec 043 FR-002, D-2). */
export const SWEBENCH_COST_CEILING_DEFAULT_USD = 10;
export const SWEBENCH_COST_CEILING_MIN_USD = 1;
export const SWEBENCH_COST_CEILING_MAX_USD = 100;
export const SwebenchCostCeilingSchema = z.number().finite().min(SWEBENCH_COST_CEILING_MIN_USD).max(SWEBENCH_COST_CEILING_MAX_USD);

/** How long the agent may work (FR-013) and how long the instance may live (FR-006). */
export const SWEBENCH_AGENT_TIME_LIMIT_SECONDS = 60 * 60;
export const SWEBENCH_RUN_TIME_LIMIT_SECONDS = 2 * 60 * 60;

/** An administrator's enablement of one bound channel (FR-002). */
export const SwebenchChannelSchema = z.object({
  teamId: SlackTeamIdSchema,
  channelId: SlackChannelIdSchema,
  maxCostUsd: SwebenchCostCeilingSchema,
  updatedAt: z.string().datetime(),
}).strict();

export const SwebenchChannelRequestSchema = z.object({
  maxCostUsd: SwebenchCostCeilingSchema.optional(),
}).strict();

export const SwebenchRunStatusSchema = z.enum(["STARTING", "RUNNING", "CANCEL_REQUESTED", "SUCCEEDED", "FAILED", "CANCELLED"]);
export const SWEBENCH_TERMINAL_STATUSES: ReadonlySet<SwebenchRunStatus> = new Set(["SUCCEEDED", "FAILED", "CANCELLED"]);

/** Why the agent stopped working (FR-013). Every reason but `error` still has its patch graded. */
export const SwebenchStopReasonSchema = z.enum(["finished", "time_limit", "cost_ceiling", "cost_unknown", "loop_guard", "model_error"]);

const TestCount = z.object({ passed: z.number().int().nonnegative(), total: z.number().int().nonnegative() }).strict();

/** The runner's report of a graded run (FR-014, FR-015). */
export const SwebenchGradedResultSchema = z.object({
  outcome: z.literal("GRADED"),
  resolved: z.boolean(),
  stopReason: SwebenchStopReasonSchema,
  /** Why the agent stopped early, in words; absent when it finished. */
  stopDetail: z.string().max(500).optional(),
  /** Zero when the agent changed nothing: the harness is not run, and the instance is unresolved. */
  patchBytes: z.number().int().nonnegative(),
  /** The harness's test counts; absent when there was no patch to grade. */
  failToPass: TestCount.optional(),
  passToPass: TestCount.optional(),
  agentSeconds: z.number().int().nonnegative(),
  imageDigest: z.string().max(256),
  usage: TaskUsageTelemetrySchema,
  artifactsPrefix: z.string().max(512),
}).strict();

/** The runner's report of a run it could not grade: the instance was not found, the image did not start. */
export const SwebenchFailedResultSchema = z.object({
  outcome: z.literal("FAILED"),
  error: z.string().min(1).max(2_000),
  usage: TaskUsageTelemetrySchema.optional(),
  artifactsPrefix: z.string().max(512).optional(),
}).strict();

export const SwebenchRunResultSchema = z.discriminatedUnion("outcome", [SwebenchGradedResultSchema, SwebenchFailedResultSchema]);

/** What the Slack service sends to start a run. */
export const SwebenchStartRequestSchema = z.object({
  requestId: z.string().uuid(),
  dataset: SwebenchDatasetSchema,
  instanceId: SwebenchInstanceIdSchema,
  model: ModelIdentifierSchema.optional(),
}).strict();

export const SwebenchRunSchema = z.object({
  runId: z.string().uuid(),
  dataset: SwebenchDatasetSchema,
  instanceId: SwebenchInstanceIdSchema,
  model: ModelIdentifierSchema,
  maxCostUsd: SwebenchCostCeilingSchema,
  thread: SlackThreadSchema,
  requestedBy: SlackRequesterSchema,
  status: SwebenchRunStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  finishedAt: z.string().datetime().optional(),
  error: z.string().max(2_000).optional(),
  result: SwebenchGradedResultSchema.optional(),
}).strict();

export const SwebenchStartResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("STARTED"), run: SwebenchRunSchema }).strict(),
  z.object({ outcome: z.literal("REFUSED"), reason: z.enum(["NOT_ENABLED", "RUN_ACTIVE", "NOT_INSTALLED"]), message: z.string().max(500) }).strict(),
]);

/**
 * What the runner boots with (FR-008): the worker image's `swebench` mode reads it from
 * AGENTX_SWEBENCH_RUN as JSON. The capability authorizes this run's callback only.
 */
export const SwebenchRunnerConfigSchema = z.object({
  runId: z.string().uuid(),
  dataset: SwebenchDatasetSchema,
  instanceId: SwebenchInstanceIdSchema,
  model: ModelIdentifierSchema,
  maxCostUsd: SwebenchCostCeilingSchema,
  controlPlaneUrl: z.string().url().startsWith("https://"),
  capability: z.string().min(1).max(2_048),
  artifactBucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
  artifactsPrefix: z.string().regex(/^evals\/[0-9a-f-]{36}\/$/),
}).strict();

/** The eval capability's claims. Signed with a key derived for evals, so it never passes as a workspace capability. */
export const SwebenchCapabilityClaimsSchema = z.object({
  kind: z.literal("swebench"),
  runId: z.string().uuid(),
  expiresAt: z.number().int().positive(),
}).strict();

/** The Slack message `eval swebench <dataset> <instance> [model <name>]` (FR-001). */
export type SwebenchCommand =
  | { kind: "run"; dataset: SwebenchDataset; instanceId: string; modelSelector?: string }
  | { kind: "invalid"; message: string };

const COMMAND = /^eval\s+swebench\b(.*)$/isu;

export function parseSwebenchCommand(text: string): SwebenchCommand | undefined {
  const command = text.replace(/^\s*<@[A-Z0-9]+>\s*/iu, "").trim().replace(/[.!?]+$/u, "");
  const match = COMMAND.exec(command);
  if (!match) return undefined;
  const words = (match[1] ?? "").trim().split(/\s+/u).filter((word) => word.length > 0);
  const usage = "Use `eval swebench <verified|lite|full> <instance-id> [model <name>]`.";
  const dataset = SwebenchDatasetSchema.safeParse(words[0]?.toLowerCase());
  if (!dataset.success) {
    return { kind: "invalid", message: words[0] === undefined ? `Tell me which dataset and instance to run. ${usage}` : `Unknown dataset “${words[0]}”. ${usage}` };
  }
  const instanceId = words[1];
  if (instanceId === undefined) return { kind: "invalid", message: `Tell me which instance to run. ${usage}` };
  if (!SwebenchInstanceIdSchema.safeParse(instanceId).success) return { kind: "invalid", message: `“${instanceId}” is not a SWE-bench instance ID. ${usage}` };
  const rest = words.slice(2);
  if (rest.length === 0) return { kind: "run", dataset: dataset.data, instanceId };
  if (rest[0]?.toLowerCase() !== "model") {
    return { kind: "invalid", message: `A run takes exactly one instance for now. ${usage}` };
  }
  const modelSelector = rest.slice(1).join(" ");
  if (modelSelector.length === 0) return { kind: "invalid", message: `Tell me which model after \`model\`. ${usage}` };
  return { kind: "run", dataset: dataset.data, instanceId, modelSelector };
}

export type SwebenchDataset = z.infer<typeof SwebenchDatasetSchema>;
export type SwebenchChannel = z.infer<typeof SwebenchChannelSchema>;
export type SwebenchRunStatus = z.infer<typeof SwebenchRunStatusSchema>;
export type SwebenchStopReason = z.infer<typeof SwebenchStopReasonSchema>;
export type SwebenchGradedResult = z.infer<typeof SwebenchGradedResultSchema>;
export type SwebenchRunResult = z.infer<typeof SwebenchRunResultSchema>;
export type SwebenchStartRequest = z.infer<typeof SwebenchStartRequestSchema>;
export type SwebenchRun = z.infer<typeof SwebenchRunSchema>;
export type SwebenchStartResult = z.infer<typeof SwebenchStartResultSchema>;
export type SwebenchRunnerConfig = z.infer<typeof SwebenchRunnerConfigSchema>;
export type SwebenchCapabilityClaims = z.infer<typeof SwebenchCapabilityClaimsSchema>;

/** SSM parameter names under the environment's settings prefix (spec 043 FR-016). */
export const SWEBENCH_SETTING_PARAMETERS = {
  /** Written by the eval stack: SwebenchSettingsSchema as JSON. */
  settings: "eval/settings",
  /** Written by the runner image release: an ECR linux/amd64 worker image pinned by digest. */
  runnerImage: "eval/runner-image",
} as const;

/** What the eval stack tells the broker about itself. */
export const SwebenchSettingsSchema = z.object({
  stateMachineArn: z.string().regex(/^arn:aws[a-z-]*:states:[a-z0-9-]+:\d{12}:stateMachine:[A-Za-z0-9_-]{1,80}$/),
  subnetIds: z.array(z.string().regex(/^subnet-[0-9a-f]{8,17}$/)).min(1).max(8),
  controlPlaneUrl: z.string().url().startsWith("https://"),
  logGroupName: z.string().regex(/^[A-Za-z0-9._/-]{1,512}$/),
}).strict();

/**
 * What an eval instance boots with: the broker writes it to `<artifactsPrefix>launch.json`, and the
 * eval launch template's boot script reads it by the run ID in the instance's tags. The run's
 * capability stays out of EC2 user data.
 */
export const SwebenchLaunchSchema = z.object({
  runnerImage: z.string().regex(/^\d{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\/[a-z0-9]+(?:[._/-][a-z0-9]+)*@sha256:[0-9a-f]{64}$/, "runner image must be an ECR image pinned by digest"),
  logGroupName: z.string().regex(/^[A-Za-z0-9._/-]{1,512}$/),
  /** Extra worker environment: the prompt cache retention and OpenRouter settings. */
  environment: z.object({
    PI_CACHE_RETENTION: z.enum(["short", "long"]).optional(),
    AGENTX_OPENROUTER_SECRET_ARN: z.string().regex(/^arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@-]+$/).optional(),
    AGENTX_OPENROUTER_PROVIDERS: z.string().regex(/^[a-z0-9][a-z0-9_/-]{0,79}(?:,[a-z0-9][a-z0-9_/-]{0,79})*$/).optional(),
  }).strict(),
  run: SwebenchRunnerConfigSchema,
}).strict();

export type SwebenchSettings = z.infer<typeof SwebenchSettingsSchema>;
export type SwebenchLaunch = z.infer<typeof SwebenchLaunchSchema>;
