import { TEST_ENV_PROVE_MEASURE_FEATURE } from "./machine-size.js";
export { TEST_ENV_PROVE_MEASURE_FEATURE } from "./machine-size.js";
import {StageIdSchema} from "./stage-model-shared.js";
import { ActingAttributionSchema } from "./attribution.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import { WORKFLOW_PLAN_MAX_BYTES, WORKFLOW_PROPOSED_CHECKS_MAX, WorkflowCheckProposalSchema, WorkflowFeedbackApprovalBindingSchema, WorkflowReviewBaseSchema } from "./task-workflow.js";
import { AgentXNameSchema } from "./names.js";
import { ProjectCommandSchema } from "./project.js";
import { StoredProjectDefinitionSchema } from "./project-node.js";
import { ModelIdentifierSchema,ModelSelectionSchema } from "./models.js";
import { type ModelSelection } from "./models-node.js";
import { WorkflowDependencyInvocationSchema } from "./workflow-dependencies-node.js";
import { E2EFeaturePlanIntentAnySchema } from "./e2e-application.js";
import { SECOND_REVIEW_CANDIDATES_MAX, SecondReviewContextSchema } from "./second-review.js";
import { E2EWorkflowAdmissionRefSchema } from "./e2e-node.js";
import { DEVELOPER_INSTRUCTIONS_MAX_BYTES } from "./developer-tasks-node.js";
import { AgentIdSchema, SkillIdSchema } from "./agent.js";
import { MAX_RESOLVED_SKILLS, PI_TOOL_NAMES, PiToolNameSchema, StepIdSchema } from "./agent-recipe.js";
import { ResultContractSchema, RunCheckoutSchema } from "./agent-run-node.js";
import { WorkflowFixPayloadSchema } from "./rovara-code.js";
import { LiveSteerPayloadSchema } from "./live-steer.js";
import { PREPARE_PINS_FEATURE, PreparePinsSchema, SETUP_AGENT_FEATURE, SetupAgentWireSchema } from "./setup-run.js";
import { NIGHTLY_RUN_FEATURE, NightlyRunPayloadSchema } from "./nightly-run.js";
import { STANDING_INSTRUCTIONS_FEATURE, StandingInstructionsPayloadSchema } from "./standing-instructions.js";
import { EVAL_FILES_FEATURE, EvalFilesPayloadSchema } from "./eval-files.js";
import { SETUP_RECIPES_FEATURE, SETUP_RECIPE_OFFERS_MAX, SetupRecipeOfferSchema } from "./setup-recipe.js";
import { PrepareMetaSchema } from "./meta-project.js";
import { PREPARE_REGISTRIES_FEATURE, PrepareRegistriesSchema } from "./project-registries.js";
import { PREPARE_SAVED_ENV_FEATURE, PrepareSavedEnvSchema } from "./saved-env-image.js";
import { PREPARE_SAVED_ENV_BUILD_FEATURE, PrepareSavedEnvBuildSchema } from "./saved-env-build.js";
import { WORKER_CREDENTIAL_KINDS_FEATURE } from "./plugins/code-host.js";
import { LearnedContextSchema, LearnedRefsSchema } from "./learned-context.js";
import { SpecReviewInputSchema, SpecWriteBindingSchema } from "./spec-target.js";
import { OWNER_REDIRECT_FEATURE, OwnerRedirectInvocationSchema, PEEK_FEATURE } from "./live-interaction.js";
import { DIAGNOSIS_WORKER_FEATURE, DiagnosisInvocationSchema } from "./live-diagnosis.js";
import { EVIDENCE_CAPTURE_FEATURE } from "./evidence.js";
import { TASK_DEPENDENCY_PLAN_MAX, TEST_ENV_COVERAGE_PATH_FEATURE, TEST_ENV_DETECT_FEATURE, TEST_ENV_PLAN_FEATURE, TEST_SERVICES_AWS_ALL_SERVICES_FEATURE, TEST_SERVICES_AWS_PLAN_FEATURE, TEST_SERVICES_COMPANY_IMAGE_PLAN_FEATURE, TEST_SERVICES_FAKE_PLAN_FEATURE, TEST_SERVICES_FILE_SEED_FEATURE, TEST_SERVICES_PLAN_FEATURE, TEST_SERVICES_SEED_LOCK_FEATURE, TaskDependencyPlanSchema, TestEnvTaskPlanSchema } from "./test-environment-wire.js";
import { PeekPayloadSchema } from "./live-peek.js";
import { DESIGN_REVIEW_REVIEWERS_MAX, ReviewerRoleSchema } from "./design-review.js";

export const AGENTX_PROTOCOL_VERSION = 1 as const;

/**
 * Optional invocation fields that this build's worker parses and an older one does not (spec 053).
 * Worker payload schemas are strict, and a running EC2 worker keeps its image until the idle reaper
 * stops it, so an older worker rejects an invocation that carries one of these. A worker reports the
 * list on GET /ping, and the eval runner image release records it beside the image, so the control
 * plane sends such a field only to a build that lists it.
 */
/** SR-1 (switch `cr`): the second reviewer inside a REVIEW operation. Sent only to a worker that lists it; an older worker gets the review without it (it runs as today) and its result has no second-review key. */
export const SECOND_REVIEWER_FEATURE = "task.workflowSecondReviewer.v1" as const;
/** DR5: the design-review form of the PLAN_CRITIQUE operation (`designReview` binding). A worker without it is never sent the binding; the broker refuses delivery instead (ec2-delivery.ts). */
export const DESIGN_REVIEW_WORKER_FEATURE = "task.designReview.v1" as const;
export const WORKER_INVOCATION_FEATURES = [TEST_ENV_PROVE_MEASURE_FEATURE, "task.modelPolicy", "model.thinkingLevel", "task.readiness", "task.workflowMode", "task.workflowReview", "task.workflowChecks", "task.workflowFeedbackReview", "task.workflowFeedbackApproval", "publish.reportChecks", "task.workflowBase", "publish.candidateTree", "publish.workflowBase", "publish.mode", "publish.contextDigest", "task.workflowReviewChecks", "task.structuredPlans", "task.workflowReviewPlan", "task.workflowPullRequestUpdate", "task.codeAnchors", "task.workflowReviewFeedback", "task.workflowReviewNote", "task.workflowReviewers", "model.chatgpt", "task.workflowDependencies", "task.workflowE2EAdmission", "task.workflowE2EApplicationPlan", "task.workflowE2EApplicationChecks", "task.workflowE2EApplicationChecks.v2", "task.workflowE2EBaselineChecks", "task.workflowE2EBaselineSource", "task.workflowE2EAgentSteps.v1", "task.workflowE2ECaptureExtras.v1", "task.workflowE2EReplayChecks.v1", "task.workflowE2EModelFreeLimits.v1", "task.workflowE2EAgentModelChoice.v1", "task.agentStep", "task.agentRun", "task.agentGrounding.v1", "model.route", "task.workflowUnderstand", "task.workflowPlanCritique", "task.workflowParallelParts", "task.workflowFix", "task.workflowFeedbackAutonomy", "maintain.workflowSync", "task.setupDraft", "task.setupProposal.v2", "publish.branchOnly", "close.trashBundle", "task.workflowReviewRisk", "task.workflowPlanDryRun.v1", "task.workflowE2EGroundingChecks.v1", "task.workflowE2EMidStepSync.v1", "task.liveSteer.v1", "task.workflowApprovedPlan.v1", SETUP_AGENT_FEATURE, SETUP_RECIPES_FEATURE, "prepare.metaRepo", "task.contextSources.v1", "task.specWrite.v1", "task.workflowReviewSpec.v1", "task.learnedContext.v1", OWNER_REDIRECT_FEATURE, PEEK_FEATURE, "publish.attribution", DIAGNOSIS_WORKER_FEATURE, EVIDENCE_CAPTURE_FEATURE, TEST_ENV_DETECT_FEATURE, TEST_ENV_PLAN_FEATURE, TEST_ENV_COVERAGE_PATH_FEATURE, TEST_SERVICES_PLAN_FEATURE, TEST_SERVICES_AWS_PLAN_FEATURE, TEST_SERVICES_AWS_ALL_SERVICES_FEATURE, TEST_SERVICES_FAKE_PLAN_FEATURE, TEST_SERVICES_COMPANY_IMAGE_PLAN_FEATURE, TEST_SERVICES_FILE_SEED_FEATURE, TEST_SERVICES_SEED_LOCK_FEATURE, PREPARE_REGISTRIES_FEATURE, PREPARE_SAVED_ENV_FEATURE, PREPARE_SAVED_ENV_BUILD_FEATURE, PREPARE_PINS_FEATURE, WORKER_CREDENTIAL_KINDS_FEATURE, SECOND_REVIEWER_FEATURE, DESIGN_REVIEW_WORKER_FEATURE,
  NIGHTLY_RUN_FEATURE, STANDING_INSTRUCTIONS_FEATURE, EVAL_FILES_FEATURE] as const;
export type WorkerInvocationFeature = (typeof WORKER_INVOCATION_FEATURES)[number] | "project.setupSmoke";
/** An agent step's payload (`agentStep`) goes only to a worker that lists this; the agent kind also needs AGENT_RUN_FEATURE. */
export const AGENT_STEP_FEATURE = "task.agentStep" as const;
export const AGENT_RUN_FEATURE = "task.agentRun" as const;
/**
 * A worker that lists this checks an agent step's report against the tool calls it made and sends `agentStepResult.grounding` with every step (grounded or unverified).
 * Nothing is sent to the worker for it, so an older worker is never refused: it sends no grounding, the broker has no signal and treats the step as it always did.
 */
export const AGENT_GROUNDING_FEATURE = "task.agentGrounding.v1" as const;
/** A routed model (`modelRoute`) goes only to a worker that lists this. */
export const MODEL_ROUTE_FEATURE = "model.route" as const;
/** What a delivery says when the worker lacks a feature an agent step or a model route needs. Such a field is never dropped. */
export const AGENT_WORKER_OUTDATED = "This agent needs a newer worker. Ask an admin to upgrade Rovara.";
/**
 * The worker tries a coding plan's proposed checks on the unchanged code while it plans, and reports only a fixed class per check (see PlanDryRunReportSchema).
 * Nothing in an invocation asks for it: a worker that lists this feature does it for every structured coding plan that proposes checks. The planner is asked for
 * `expectOnBase` only from a worker that lists it.
 */
/** T7a: the feature a worker lists when it can export a plan's base source and run a grounding round (see E2EWorkflowAdmissionRefSchema `purpose: "grounding"`). */
export const GROUNDING_CHECKS_FEATURE = "task.workflowE2EGroundingChecks.v1" as const;
export const PLAN_DRY_RUN_FEATURE = "task.workflowPlanDryRun.v1" as const;
/** The whole dry run, all checks together, may take this long; a check the budget cannot start is "not-run". */
export const PLAN_DRY_RUN_TOTAL_BUDGET_MS = 120_000;
/**
 * A check's result on the unchanged code. `passed`: exit 0. `failed`: it ran and said no. `broken`: it could not say anything (program missing or not executable, a
 * grep or shell usage error, a syntax error, killed by a signal, out of time or memory). `not-run`: AgentX did not run it (budget, cancel, or the sandbox could not start). `not-checked`: its result would depend on installed dependencies or tools the
 * sandbox does not have (only built-in file checks and plain grep or test are tried), so AgentX did not try it and nothing is concluded from it.
 */
export const PLAN_DRY_RUN_CLASSES = ["passed", "failed", "broken", "not-run", "not-checked"] as const;
export type PlanDryRunClass = (typeof PLAN_DRY_RUN_CLASSES)[number];
/** Why the worker did not try the checks at all; fixed codes, never text from a command or an error. */
export const PLAN_DRY_RUN_UNAVAILABLE_REASONS = ["sandbox-not-configured", "sandbox-unavailable", "source-unavailable", "cancelled", "internal-error"] as const;
export type PlanDryRunUnavailableReason = (typeof PLAN_DRY_RUN_UNAVAILABLE_REASONS)[number];
export const PLAN_DRY_RUN_SCHEMA_VERSION = "workflow-plan-dry-run/v1" as const;
const Sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);
/**
 * What a planning run reports (as a progress event's `planDryRun` member) about the proposed checks: per check the digest of the command that ran, a class and a
 * duration, and nothing else. No output, no exit code and no message leaves the worker. `planSha256` is the digest of the exact plan text the worker uploaded, so
 * the control plane accepts the report only for that plan; each check is attributed by `commandSha256` (the digest of its folder, program and arguments), so the
 * control plane matches it to its own proposed check whatever the numbering.
 */
export const PlanDryRunReportSchema = z.discriminatedUnion("status", [
  z.object({
    schemaVersion: z.literal(PLAN_DRY_RUN_SCHEMA_VERSION), status: z.literal("COMPLETE"), planSha256: Sha256Hex,
    checks: z.array(z.object({
      commandSha256: Sha256Hex, class: z.enum(PLAN_DRY_RUN_CLASSES), durationMs: z.number().int().min(0).max(PLAN_DRY_RUN_TOTAL_BUDGET_MS + 60_000),
    }).strict()).min(1).max(WORKFLOW_PROPOSED_CHECKS_MAX),
    totalMs: z.number().int().min(0).max(PLAN_DRY_RUN_TOTAL_BUDGET_MS + 60_000),
  }).strict(),
  z.object({ schemaVersion: z.literal(PLAN_DRY_RUN_SCHEMA_VERSION), status: z.literal("UNAVAILABLE"), planSha256: Sha256Hex, reason: z.enum(PLAN_DRY_RUN_UNAVAILABLE_REASONS) }).strict(),
]);
export type PlanDryRunReport = z.infer<typeof PlanDryRunReportSchema>;

/** The digest a dry-run report names a check by: its folder, program and arguments (the label and the timeout do not change what runs). */
export function planDryRunCommandSha256(command: { cwd: string; executable: string; args: readonly string[] }): string {
  return createHash("sha256").update(JSON.stringify(["workflow-plan-dry-run-command/v1", command.cwd, command.executable, [...command.args]])).digest("hex");
}

/** The field on /ping that carries WORKER_INVOCATION_FEATURES; absent on a worker built before it. */
export const WORKER_PING_FEATURES_FIELD = "invocationFeatures";

/** The model as a build with `features` can parse it: the thinking level only where it is listed. */
export function modelSelectionFor(model: ModelSelection, features: readonly string[]): ModelSelection {
  if (model.thinkingLevel === undefined || features.includes("model.thinkingLevel")) return model;
  return { provider: model.provider, modelId: model.modelId };
}

/**
 * What the code and security reviewers are told about the checks: the checks AgentX ran on the change (labels and
 * commands as text, shown to reviewers as untrusted data), or that the change is review only, with the plan's reason.
 * At most the project's required (64) and optional (20) checks plus the plan's proposed ones.
 */
export const WorkflowReviewChecksSchema = z.object({
  reviewOnly: z.boolean(),
  checks: z.array(z.object({ label: z.string().min(1).max(80), command: z.string().min(1).max(1_024) }).strict()).max(64 + 20 + WORKFLOW_PROPOSED_CHECKS_MAX),
  noneReason: WorkflowCheckProposalSchema.shape.noneReason,
}).strict().superRefine((value, context) => {
  if (value.reviewOnly && value.checks.length > 0) context.addIssue({ code: "custom", path: ["checks"], message: "a review-only change ran no checks" });
  if (!value.reviewOnly && value.noneReason !== undefined) context.addIssue({ code: "custom", path: ["noneReason"], message: "a reason for no checks is only for a review-only change" });
});
export type WorkflowReviewChecks = z.infer<typeof WorkflowReviewChecksSchema>;

/**
 * The coding plan the owner approved, as the reviewers read it: its Markdown copy (with AgentX's recommended answers),
 * cut to fit, and the digest of the approved artifact. Shown to reviewers as untrusted data.
 */
export const WorkflowReviewPlanSchema = z.object({
  markdown: z.string().min(1).refine((value) => new TextEncoder().encode(value).byteLength <= WORKFLOW_PLAN_MAX_BYTES, `plan exceeds ${WORKFLOW_PLAN_MAX_BYTES} UTF-8 bytes`),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  /** Structured E2E intent reloaded from the exact Owner-approved canonical plan artifact. */
  e2eIntent: E2EFeaturePlanIntentAnySchema.optional(),
}).strict();
export type WorkflowReviewPlan = z.infer<typeof WorkflowReviewPlanSchema>;

/**
 * The plan the owner approved, for the coding stage's conversation compaction (worker/src/compaction.ts): the Markdown copy the broker rendered (with the owner's answers) and its
 * digest, plus the owner's own plan-review instructions. The worker keeps the plan's key facts in every summary of a long coding run, and reads them from here, never from the
 * prompt text, which holds teammates' replies and page comments. Coding operations only. Sent only to a worker whose /ping lists "task.workflowApprovedPlan.v1"; an older worker is
 * sent the run without it and its summaries carry no plan.
 */
export const WorkflowApprovedPlanSchema = z.object({
  markdown: z.string().min(1).refine((value) => new TextEncoder().encode(value).byteLength <= WORKFLOW_PLAN_MAX_BYTES, `plan exceeds ${WORKFLOW_PLAN_MAX_BYTES} UTF-8 bytes`),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  /** The owner's own instructions from plan review (their Request changes reasons): at most the five newest, each at most 500 characters, as the coding prompt repeats them. */
  ownerInstructions: z.array(z.string().max(500)).max(5).optional(),
}).strict();
export type WorkflowApprovedPlan = z.infer<typeof WorkflowApprovedPlanSchema>;

/** The most owner-approved PR feedback findings the reviewers are shown, and the most bytes they take as JSON. */
export const WORKFLOW_REVIEW_FEEDBACK_MAX = 20;
export const WORKFLOW_REVIEW_FEEDBACK_MAX_BYTES = 32_768;

/**
 * The fixes the owner approved from pull request feedback since the plan, as the reviewers read them: each approved
 * finding's proposed fix (its summary and file changes) and the owner's note on that decision. Shown to reviewers as
 * untrusted data, with the rule that these changes supersede the plan where they differ.
 */
export const WorkflowReviewFeedbackSchema = z.array(z.object({
  summary: z.string().trim().min(1).max(2_000),
  fileChanges: z.array(z.object({
    repositoryId: z.string().trim().min(1).max(200), path: z.string().trim().min(1).max(1_000), change: z.string().trim().min(1).max(4_000),
  }).strict()).max(32),
  ownerNote: z.string().trim().min(1).max(2_000).optional(),
}).strict()).min(1).max(WORKFLOW_REVIEW_FEEDBACK_MAX)
  .refine((value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= WORKFLOW_REVIEW_FEEDBACK_MAX_BYTES, `approved feedback exceeds ${WORKFLOW_REVIEW_FEEDBACK_MAX_BYTES} UTF-8 bytes`);
export type WorkflowReviewFeedback = z.infer<typeof WorkflowReviewFeedbackSchema>;

/** The owner's review retry note, bounded like the canonical task instruction and shown only as untrusted reviewer context. */
export const WorkflowReviewNoteSchema = z.string().min(1).refine((value) => new TextEncoder().encode(value).byteLength <= DEVELOPER_INSTRUCTIONS_MAX_BYTES, `review note exceeds ${DEVELOPER_INSTRUCTIONS_MAX_BYTES} UTF-8 bytes`);
export type WorkflowReviewNote = z.infer<typeof WorkflowReviewNoteSchema>;

const utf8Encoder = new TextEncoder();
/** Text of at most `max` UTF-8 bytes (`.max` would count UTF-16 units instead). */
const textUpTo = (max: number) => z.string().refine((value) => utf8Encoder.encode(value).byteLength <= max, `must be at most ${max} UTF-8 bytes`);

/**
 * The most bytes of rendered run input and earlier reports one agent step is given, and of its instructions. An
 * invocation is stored inline in the DynamoDB outbox item (400 KB, `OutboxRecordBase.invocation` in broker/aws/lambda.ts)
 * and the worker refuses a body over 1 MiB, so both together stay well under the item limit. Task 22 shortens reports
 * (and the run input's context) to fit; it never relies on a larger payload.
 */
export const AGENT_STEP_INPUTS_MAX_BYTES = 262_144;
export const AGENT_STEP_INSTRUCTIONS_MAX_BYTES = 65_536;
/** The longest a step may run: the check step's 240 minutes. */
export const AGENT_STEP_TIMEOUT_MAX_MS = 240 * 60_000;

/** A skill an agent step may read, pinned to the digest the agent version was published with. */
export const AgentStepSkillSchema = z.object({ skillId: SkillIdSchema, digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const AgentStepBase = { agentId: AgentIdSchema, version: z.number().int().min(1), stepId: StepIdSchema };
const AgentStepTimeoutSchema = z.number().int().min(1).max(AGENT_STEP_TIMEOUT_MAX_MS);
const AgentStepSkillsSchema = z.array(AgentStepSkillSchema).max(MAX_RESOLVED_SKILLS);

/**
 * What the recipe adds to one operation of a coding task (`kind: "coding"`: the step's tools, skills, time limit and
 * instruction section) or what one step of an agent-step run is (`kind: "agent"`). Sent only to a worker that lists
 * `task.agentStep` (and, for the agent kind, `task.agentRun`).
 */
export const AgentStepPayloadSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("coding"),
    ...AgentStepBase,
    // A test run of an agent's draft has no published version.
    version: z.union([AgentStepBase.version, z.literal("draft")]),
    tools: z.array(PiToolNameSchema).max(PI_TOOL_NAMES.length).optional(),
    skills: AgentStepSkillsSchema.optional(),
    timeoutMs: AgentStepTimeoutSchema.optional(),
    promptSection: textUpTo(DEVELOPER_INSTRUCTIONS_MAX_BYTES).pipe(z.string().min(1)).optional(),
  }).strict(),
  z.object({
    kind: z.literal("agent"),
    ...AgentStepBase,
    // A draft test run has no published version, as for the coding variant.
    version: z.union([AgentStepBase.version, z.literal("draft")]),
    instructions: textUpTo(AGENT_STEP_INSTRUCTIONS_MAX_BYTES),
    workspace: z.enum(["none", "read"]),
    inputs: textUpTo(AGENT_STEP_INPUTS_MAX_BYTES).pipe(z.string().min(1)),
    timeoutMs: AgentStepTimeoutSchema.optional(),
    skills: AgentStepSkillsSchema.optional(),
    /** On the last agent step of a run whose start named the branches it may choose between (G1). */
    resultContract: ResultContractSchema.optional(),
    /** The pull request heads the run's workspace has checked out read-only (`AGENT_RUN.checkout`); the worker verifies the commit is what it holds. */
    checkout: z.array(RunCheckoutSchema).max(10).optional(),
  }).strict(),
]);
export type AgentStepPayload = z.infer<typeof AgentStepPayloadSchema>;

/** The API a routed model speaks through the model proxy. */
export const MODEL_ROUTE_APIS = ["anthropic-messages", "openai-responses", "openai-completions"] as const;
/** Where one operation's model comes from: the proxy alias its key may call, the API it speaks, and the catalog entry for its limits and usage. */
export const ModelRouteSchema = z.object({
  alias: z.string().min(1).max(512),
  api: z.enum(MODEL_ROUTE_APIS),
  catalog: z.string().min(1).max(256),
}).strict();
export type InvocationModelRoute = z.infer<typeof ModelRouteSchema>;
/**
 * SR-1: the second reviewer of a REVIEW operation: the models it may try, in order (each with the proxy route the broker chose for it, so it is called the way the broker checked), at most two names
 * (`SECOND_REVIEW_CANDIDATES_MAX`; the worker makes at most 3 tries in all). The key may call only the aliases the broker chose for these models and no others, and the proxy is configured with no router fallbacks (`litellmConfig` writes none and the guard refuses fallback fields in a request; checked by a test for Rovara's own config, and a deferred check for company sources), so the model named is the model that answers.
 */
export const SecondReviewerSchema = z.object({
  candidates: z.array(z.object({ model: ModelSelectionSchema, modelRoute: ModelRouteSchema.optional() }).strict()).min(1).max(SECOND_REVIEW_CANDIDATES_MAX),
  /** What the second reviewer is shown besides the change: absent means `change_only` (no source tools, lessons, step instructions or skills). */
  context: SecondReviewContextSchema.optional(),
}).strict();
export type SecondReviewerPayload = z.infer<typeof SecondReviewerSchema>;

const DesignReviewKeySlot = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/);
/**
 * DR5: the design-review form of a PLAN_CRITIQUE operation (design-review-stage.md 3.2 and 3.10). The binding is small on purpose: it names each reviewer, the model key slot the broker minted for that reviewer alone, the packet digest
 * the broker built, and the model; the packets themselves (up to 400 KB each) are fetched from the broker by the worker, which then digests what it really sends. Reviewers resolve their model through the `plan_check` stage, so
 * the worker never picks one. `merge` is absent for the Light tier (a code-only merge). Nothing in a binding can set a tier, an approver, a cost or a mode.
 */
export const DesignReviewBindingSchema = z.object({
  version: z.literal(1),
  round: z.union([z.literal(1), z.literal(2)]),
  reviewers: z.array(z.object({
    role: ReviewerRoleSchema,
    /** Names the model key this reviewer alone uses: the worker asks the broker's model-access route for this slot, and no other reviewer is given its key. */
    keySlot: DesignReviewKeySlot,
    /** The digest of the packet the broker built; the worker refuses to start the reviewer when the packet it fetches hashes to anything else. */
    packetDigest: z.string().regex(/^[a-f0-9]{64}$/),
    model: ModelSelectionSchema,
    modelRoute: ModelRouteSchema.optional(),
  }).strict()).min(1).max(DESIGN_REVIEW_REVIEWERS_MAX),
  /** The round's pinned base commit of each repository (by the name section 8 uses): the worker's early citation check accepts a code citation at these pins. The broker checks again with its own. */
  baseCommits: z.record(z.string().min(1).max(200), z.string().regex(/^[a-f0-9]{40}$/)).optional().refine((pins) => pins === undefined || Object.keys(pins).length <= 20, "at most 20 repositories"),
  merge: z.object({
    keySlot: DesignReviewKeySlot,
    model: ModelSelectionSchema,
    modelRoute: ModelRouteSchema.optional(),
    prompt: z.object({ id: z.string().min(1).max(100), version: z.number().int().min(1), text: z.string().min(1).max(64_000) }).strict(),
  }).strict().optional(),
}).strict().superRefine((binding, context) => {
  const roles = binding.reviewers.map((reviewer) => reviewer.role);
  if (new Set(roles).size !== roles.length) context.addIssue({ code: "custom", path: ["reviewers"], message: "a reviewer role is used once per round" });
  const slots = [...binding.reviewers.map((reviewer) => reviewer.keySlot), ...(binding.merge === undefined ? [] : [binding.merge.keySlot])];
  if (new Set(slots).size !== slots.length) context.addIssue({ code: "custom", path: ["reviewers"], message: "every reviewer and the merge step have a model key of their own" });
});
export type DesignReviewBinding = z.infer<typeof DesignReviewBindingSchema>;
/** Broker-created task context, never a client choice or permission to fallback. */
export const TaskModelPolicyBindingSchema=z.object({version:z.literal(1),stage:StageIdSchema,companyRevision:z.number().int().min(0),recipeDigest:z.string().regex(/^[a-f0-9]{64}$/u)}).strict();
export type TaskModelPolicyBinding=z.infer<typeof TaskModelPolicyBindingSchema>;
/** A worker must match the binding before using a server-authorized replacement. No credentials are carried. */
export const TaskModelFallbackAuthorizationSchema=z.object({version:z.literal(1),binding:TaskModelPolicyBindingSchema,model:ModelSelectionSchema,modelRoute:ModelRouteSchema.optional(),sourcesRevision:z.number().int().min(0)}).strict();
export type TaskModelFallbackAuthorization=z.infer<typeof TaskModelFallbackAuthorizationSchema>;
export const TaskModelFallbackRequestSchema=z.object({version:z.literal(1),binding:TaskModelPolicyBindingSchema,reason:z.enum(["unavailable","limit","revoked","model","missing_key"]),failedModel:ModelIdentifierSchema,environmentFallback:ModelIdentifierSchema.optional()}).strict().superRefine((request,context)=>{
 if(request.environmentFallback!==undefined&&request.reason!=="missing_key")context.addIssue({code:"custom",path:["environmentFallback"],message:"only a missing-key fallback names an environment candidate"});
});
export type TaskModelFallbackRequest=z.infer<typeof TaskModelFallbackRequestSchema>;



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
    kind: z.literal("project-setup-smoke"),
    payload: z.object({
      domain: z.literal("project-setup-source-interface/v1"),
      setupExecutionId: z.string().uuid(),
      subjectId: z.string().uuid(),
      approvalRevision: z.number().int().positive(),
      /** Opaque supervisor-issued correlation for transport auth; never a project workspace identity. */
      transportCorrelationId: z.string().uuid(),
      executionRef: z.object({
        key: z.string().regex(/^project-setup-executions\/sha256\/[a-f0-9]{64}\.json$/),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        byteLength: z.number().int().positive().max(24 * 1024 * 1024),
      }).strict(),
    }).strict(),
  }).strict(),
  InvocationBaseSchema.extend({
    kind: z.literal("prepare"),
    payload: z.object({
      project: StoredProjectDefinitionSchema,
      repositoryGrant: z.string().min(1),
      /** An agent-step run that looks at pull requests: after cloning, the worker fetches each head, checks the commit out detached and verifies it (Plan 3, Task 22). Sent only to a worker that lists `task.agentRun`. */
      checkout: z.array(RunCheckoutSchema).max(10).optional(),
      /** An agent-step run's preparation clones and checks out only: no devcontainer, no setup command, no readiness command (Plan 3 final fix wave). Sent only to a worker that lists `task.agentRun`. */
      readOnly: z.literal(true).optional(),
      /** Meta repo lane A3: the project's meta repository, read-only and sparse, beside the code. Sent only to a worker that lists `prepare.metaRepo`. */
      meta: PrepareMetaSchema.optional(),
      /** N9 (INTG2): the project's private package registries (where they are, never a credential): the worker asks the broker for each one's short-lived token by name, writes the package manager's config outside the repository for the setup and readiness commands, and removes it. Sent only to a worker that lists `prepare.registries.v1`. */
      registries: PrepareRegistriesSchema.optional(),
      /** Saved environments (SH25, switch `sv`): the project's saved image to start from (digest, a one-repository pull login, the revision the task is pinned to). Informational: a worker that does not list `prepare.savedEnv.v1` is sent no field and sets up fresh. */
      savedEnv: PrepareSavedEnvSchema.optional(),
      /** P1: the default-branch head the broker read for each repository of a setup run; the worker refuses the preparation if its own resolution differs. Sent only to a worker that lists `prepare.pins.v1`. */
      pins: PreparePinsSchema.optional(),
      /** Saved project images (switch `sv`): a rebuild of the project's image. The preparation is read only and pinned (`pins` are the job's commits); after it the worker proves the approved environment in a fresh sandbox and builds and pushes the image (saved-env/rebuild.ts). The lease token is added by the dispatcher at delivery. Sent only to a worker that lists `prepare.savedEnvBuild.v1`; never dropped. */
      savedEnvBuild: PrepareSavedEnvBuildSchema.optional(),
      /**
       * Test services (slice 1, Prove): a test environment's CANDIDATE check starts these dependencies (pinned by digest; no secret), runs the proposal's readiness commands against them with the sealed check runners and
       * reports a usage record under `testServicesUsage` in its result. Sent only with the switch `tx` on and only to a worker whose /ping lists `task.testServices.v1`; never dropped (delivery refuses an older worker).
       */
      testServices: z.object({ dependencies: z.array(TaskDependencyPlanSchema).min(1).max(TASK_DEPENDENCY_PLAN_MAX) }).strict().optional(),
    }).strict(),
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
        workflowMode: z.enum(["PLAN", "IMPLEMENT", "REVIEW", "CHECKS", "FEEDBACK_REVIEW", "UNDERSTAND", "PLAN_CRITIQUE", "SETUP_DRAFT", "SETUP_AGENT", "SPEC_WRITE"]).optional(),
        /** The setup run that runs commands (SH14, switch `su`): its limits, fixed by the broker when the run started. Only with `workflowMode: "SETUP_AGENT"`, and only to a worker whose /ping lists "task.setupAgent.v1". */
        setupAgent: SetupAgentWireSchema.optional(),
        /** The nightly run (NH-1, switch `nh`): what the broker fixed when the fire started it. Only with `workflowMode: "CHECKS"`, and only to a worker whose /ping lists "task.nightlyRun.v1". */
        nightlyRun: NightlyRunPayloadSchema.optional(),
        /**
         * Meta repo lane B: a setup proposal run is told which of the project's repositories is its meta repository (the team's rules, specs and runbooks live there), so it
         * knows where to look for them. Sent only with `workflowMode: "SETUP_DRAFT"`, and only to a worker whose /ping lists "task.setupProposal.v2".
         */
        setupMetaRepo: AgentXNameSchema.optional(),
        /**
         * The document a planning run writes in the Full path (a Quick plan has none). The worker uses it to read the
         * planner's answer as that kind of plan. Sent only to a worker whose /ping lists "task.structuredPlans"; an older
         * worker is sent the run without it.
         */
        workflowPhase: z.enum(["REQUIREMENTS", "DESIGN", "IMPLEMENTATION_PLAN"]).optional(),
        /**
         * The broker asked this planning run for a structured plan (spec 061). Only then does the worker check the answer
         * and ask once more when it cannot be read. Sent only to a worker whose /ping lists "task.structuredPlans".
         */
        planFormat: z.literal("structured").optional(),
        /**
         * Opt-in to the schema-v2 application E2E plan: the planner may propose it and the worker's plan parser accepts it. Sent only to a
         * worker whose /ping lists "task.workflowE2EApplicationPlan"; an older one is sent the portable-only prompt, without this field.
         * Absent means the portable schemaVersion 1 intent only.
         */
        workflowE2EPlanVersion: z.literal(2).optional(),
        workflowFeedbackReview: z.object({ taskId: z.string().uuid(), workflowRevision: z.number().int().positive(), candidateDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
        workflowFeedbackApproval: WorkflowFeedbackApprovalBindingSchema.optional(),
        /** Server-assigned immutable native E2E round; the worker must reload it through its signed callback capability. */
        workflowE2EAdmission: E2EWorkflowAdmissionRefSchema.optional(),
        /**
         * M1.3 Task 3.7b: a coding run is asked to export the unchanged code (its recorded base commit) beside the candidate, for the baseline round of the approved application plan.
         * Sent only to a worker whose /ping lists "task.workflowE2EBaselineSource" (which, unlike the baseline CHECKS feature, needs no executor image: the export reads the repository alone); an older one is sent the run without it, and the baseline then says it could not be checked.
         */
        workflowE2EBaselineSource: z.literal(true).optional(),
        /**
         * T7a: a coding plan run is asked to export the unchanged code (the signed workflow base) after planning, so the plan's must-not-change checks can be tried on the current app before the owner is asked.
         * Sent only to a worker whose /ping lists "task.workflowE2EGroundingChecks.v1" and only to a structured planning run that negotiated the application plan; absent means the run is as before.
         */
        workflowE2EGroundingSource: z.literal(true).optional(),
        /** One approved same-repository dependency graph, sent only to workers advertising task.workflowDependencies. */
        workflowDependencies: WorkflowDependencyInvocationSchema.optional(),
        /**
         * The task's pinned base commit per repository (the workflow's reviewBase). The worker records it in the
         * candidate and reviewers see the diff from it. Sent only to a worker whose /ping lists "task.workflowBase".
         */
        workflowBase: WorkflowReviewBaseSchema.optional(),
        /**
         * The checks that ran on the candidate under review, or that it is review only, for the reviewers' prompt.
         * Review operations only. Sent only to a worker whose /ping lists "task.workflowReviewChecks"; an older worker
         * is sent the review without it and reviews as before, without that section.
         */
        workflowReviewChecks: WorkflowReviewChecksSchema.optional(),
        /**
         * The coding plan the owner approved, for the reviewers' prompt. Review operations only. Sent only to a worker
         * whose /ping lists "task.workflowReviewPlan"; an older worker is sent the review without it.
         */
        workflowReviewPlan: WorkflowReviewPlanSchema.optional(),
        /**
         * The plan the owner approved, for the coding step's conversation compaction. Coding operations only. Sent only to a worker whose /ping lists
         * "task.workflowApprovedPlan.v1"; an older worker is sent the run without it.
         */
        workflowApprovedPlan: WorkflowApprovedPlanSchema.optional(),
        /**
         * The fixes the owner approved from pull request feedback since the plan, for the reviewers' prompt. Review
         * operations only. Sent only to a worker whose /ping lists "task.workflowReviewFeedback"; an older worker is sent
         * the review without it.
         */
        workflowReviewFeedback: WorkflowReviewFeedbackSchema.optional(),
        /**
         * Meta repo lane D (D3): the spec's requirements, read by the broker at the commit recorded when the spec was published, for the code review to walk. Review operations only. Sent only to a worker whose /ping
         * lists "task.workflowReviewSpec.v1"; never dropped, because an older worker would review without the spec.
         */
        workflowReviewSpec: SpecReviewInputSchema.optional(),
        /** The exact owner retry note, shown as untrusted context. Older workers omit it and review as before. */
        workflowReviewNote: WorkflowReviewNoteSchema.optional(),
        /**
         * Which reviews a review operation runs when its step asks for fewer than both (a custom coding sequence's
         * security-only review). Absent: both, as always. Sent only to a worker whose /ping lists "task.workflowReviewers";
         * never dropped, because an older worker would run reviews the step did not ask for.
         */
        workflowReviewers: z.array(z.enum(["CRITIC", "SECURITY"])).min(1).max(2).refine((roles) => new Set(roles).size === roles.length, "reviewers must be unique").optional(),
        /**
         * Rovara Code version 2: the code review states a risk level (low, medium or high) beside its findings. Review operations only. It only adds one word to the report; a worker whose /ping does not list
         * "task.workflowReviewRisk" is sent the review without it, and the risk level then comes from the paths, the size and the checks alone.
         */
        workflowReviewRisk: z.literal(true).optional(),
        /** SR-1: the second reviewer (another AI company's model) that runs after the reviews above, inside this operation. Review operations only; a worker without "task.workflowSecondReviewer.v1" is sent the review without it. */
        workflowSecondReviewer: SecondReviewerSchema.optional(),
        /**
         * DR5: this PLAN_CRITIQUE operation reviews a design with several fresh reviewers (see DesignReviewBindingSchema). Plan-check mode only; sent only to a worker that lists "task.designReview.v1"; never dropped,
         * because an older worker would run the plan check on the design with one session that has the planner's workspace and history.
         */
        designReview: DesignReviewBindingSchema.optional(),
        /**
         * Rovara Code (Plan 6 Task 15): this coding run fixes a pull request that is already open (failing CI, a conflict, comments), so it changes that code and leaves it alone when
         * nothing it can do helps. Implementation mode only. Sent only to a worker whose /ping lists "task.workflowFix"; never dropped, because an older worker would take the run for a first build.
         */
        workflowFix: WorkflowFixPayloadSchema.optional(),
        /**
         * Meta repo lane D: the spec write run. It reads the owner-approved plan (in the prompt, as data) and returns a structured spec draft; it changes nothing. SPEC_WRITE mode only. Sent only to a worker whose /ping
         * lists "task.specWrite.v1"; never dropped, because an older worker would not know the mode.
         */
        specWrite: SpecWriteBindingSchema.optional(),
        /**
         * Lane E: the project has MCP context sources for this stage (Understand, Plan, Plan check or Review; never Build), so the worker asks the broker for the stage's source tools with its
         * `context-tools` capability. Sent only to a worker that lists "task.contextSources.v1"; never dropped, because an older worker would run the stage without the team's sources and say nothing.
         */
        contextSources: z.literal(true).optional(),
        model: ModelSelectionSchema.optional(),
        /**
         * Sign in with ChatGPT (#341): the task runs on its owner's ChatGPT plan, with this model, and the worker asks
         * the control plane for the owner's access token through its callback capability. `model` stays the install's
         * default, which the worker uses when the plan cannot be. Sent only to a worker whose /ping lists "model.chatgpt".
         */
        chatgpt: z.object({ model: ModelSelectionSchema }).strict().optional(),
        modelSelectionDiagnostic: z.string().min(1).max(512).optional(),
        /**
         * Spec 051 (P-1): the project's current readiness commands, which the worker reruns when the agent finishes.
         * Optional: a payload from a broker built before it has none, and the worker falls back to the agent's own
         * test commands. Sent only to a worker whose /ping lists "task.readiness". The limit is the project's own.
         */
        readiness: z.array(ProjectCommandSchema).max(64).optional(),
        /** What the agent's recipe adds to this operation, or the agent step it is. Sent only to a worker that lists "task.agentStep"; never dropped. */
        agentStep: AgentStepPayloadSchema.optional(),
        /**
         * Standing instructions: the company's rules and the project's "How we work" for this step, as one text the worker puts in the SYSTEM prompt, after Rovara's own prompt and preamble and before the
         * repository's files and the skills. Sent only to a worker that lists "task.standingInstructions.v1"; never dropped (an older worker is refused the step at delivery).
         */
        standingInstructions: StandingInstructionsPayloadSchema.optional(),
        /** The model proxy alias to use in place of the install's default route. Sent only to a worker that lists "model.route"; never dropped. */
        modelRoute: ModelRouteSchema.optional(),
        /** Governed tasks require broker authorization before any worker-side replacement; never dropped. */
        modelPolicy:TaskModelPolicyBindingSchema.optional(),
        /**
         * Learning v2: the lessons chosen for this stage, advice the worker re-checks against the task's base commit and renders in a labelled block. Sent only to a worker that lists
         * "task.learnedContext.v1"; an older worker is sent none, which is safe (the task runs as without memory). Never carries a tool, a check, an approval or a limit.
         */
        learnedContext: LearnedContextSchema.optional(),
        /**
         * The stored and queued form of `learnedContext` (WL-6): lesson ids and versions only. The dispatcher turns it into `learnedContext` from the lesson store at delivery and never sends it on
         * to a worker, so no lesson text sits in an outbox row, a queue message or a dead-letter copy.
         */
        learnedRefs: LearnedRefsSchema.optional(),
        /**
         * Lessons replay, the file arm (DECISIONS 50.5, 68): the lessons file and its pointer the worker places in a replay copy's checkout before the agent starts, kept out of any diff. Built by the dispatcher at
         * delivery for a replay copy only; never stored or queued. Sent only to a worker that lists "task.evalFiles.v1"; never dropped (an older worker is refused the step).
         */
        evalFiles: EvalFilesPayloadSchema.optional(),
        /**
         * Live interaction, Stop & redirect (keep the plan): the owner's instruction that stopped the previous run of this coding step. The worker records it as taken from the owner (so the re-approval stop applies) and
         * puts it in the prompt, framed and untrusted. Implementation mode only. Sent only to a worker whose /ping lists "task.ownerRedirect.v1"; never dropped, because an older worker would run the step
         * without the re-approval stop the owner's instruction is bound by.
         */
        ownerRedirect: OwnerRedirectInvocationSchema.optional(),
        /**
         * Live interaction F3 (Fix with agent, deep tier): this read-only look is a diagnosis, not a setup draft. The worker adds the diagnosis instructions and answers with the diagnosis JSON. Setup-draft mode
         * only (read, grep, find and ls: no shell, no write tool, no network, no MCP). Sent only to a worker whose /ping lists "task.diagnosis.v1"; never dropped, because an older worker would run it as a setup draft.
         */
        diagnosis: DiagnosisInvocationSchema.optional(),
        /**
         * Proof and evidence (wire-proof): this verification run also writes `evidence-raw.json` (the test report of each check that names one, read in the workspace; never a change to any command). Verification mode
         * only. Sent only while the proof switch is on, and only to a worker whose /ping lists "task.evidenceCapture.v1"; the dispatcher drops the field for an older worker (no evidence is captured and the omission is logged), because its strict parse would refuse it.
         */
        evidenceCapture: z.literal(true).optional(),
        /**
         * Test environment (wire-testenv): this setup draft also runs the environment detectors over the default branch's files and reports the environment it would propose (a draft, never approved or run). Setup-draft
         * mode only. Sent only while the test environment switch is on, and only to a worker whose /ping lists "task.testEnvDetect.v1"; the dispatcher drops the field for an older worker (the setup draft then has no environment draft and the omission is logged), because its strict parse would refuse it.
         */
        testEnvDetect: z.literal(true).optional(),
        /** SH30 (switch `sp`): the company recipes offered to the detectors' proposal. Only with `testEnvDetect`; only to a worker whose /ping lists "task.setupRecipes.v1". */
        testEnvRecipes: z.array(SetupRecipeOfferSchema).max(SETUP_RECIPE_OFFERS_MAX).optional(),
        /**
         * Test environment (wire-testenv): the approved environment as this verification run needs it (which commands are its checks, how to select tests, the round budget). Verification mode only; a coding run is sent it too, but only a plan with dependencies (test services: the working sandbox gets them while the agent codes). Sent only while the
         * switch is on and the task pinned an environment a task may use, and only to a worker whose /ping lists "task.testEnvironment.v1"; never dropped, because an older worker's strict parse would refuse it.
         */
        testEnvironment: TestEnvTaskPlanSchema.optional(),
      })
      .strict().superRefine((payload, context) => {
        if ((payload.setupAgent !== undefined) !== (payload.workflowMode === "SETUP_AGENT")) {
          context.addIssue({ code: "custom", path: ["setupAgent"], message: "a setup run carries its limits, and only a setup run does" });
        }
        if (payload.setupAgent !== undefined && (payload.agentStep !== undefined || payload.ownerRedirect !== undefined || payload.specWrite !== undefined || payload.contextSources !== undefined || payload.diagnosis !== undefined || payload.testEnvDetect !== undefined)) {
          context.addIssue({ code: "custom", path: ["setupAgent"], message: "a setup run carries no agent step, redirect, spec write, context sources, diagnosis or detection" });
        }
        if (payload.nightlyRun !== undefined && payload.workflowMode !== "CHECKS") {
          context.addIssue({ code: "custom", path: ["nightlyRun"], message: "a nightly run is a verification-mode operation" });
        }
        if (payload.diagnosis !== undefined && payload.workflowMode !== "SETUP_DRAFT") {
          context.addIssue({ code: "custom", path: ["diagnosis"], message: "a diagnosis is a read-only look and requires the setup draft mode" });
        }
        if (payload.diagnosis !== undefined && (payload.agentStep !== undefined || payload.ownerRedirect !== undefined || payload.specWrite !== undefined || payload.contextSources !== undefined)) {
          context.addIssue({ code: "custom", path: ["diagnosis"], message: "a diagnosis carries no agent step, redirect, spec write or context sources" });
        }
        if (payload.evidenceCapture !== undefined && payload.workflowMode !== "CHECKS") {
          context.addIssue({ code: "custom", path: ["evidenceCapture"], message: "evidence capture requires the verification (checks) mode" });
        }
        if (payload.testEnvRecipes !== undefined && payload.testEnvDetect !== true) {
          context.addIssue({ code: "custom", path: ["testEnvRecipes"], message: "company recipes are offered to a test environment detection only" });
        }
        if (payload.testEnvDetect !== undefined && (payload.workflowMode !== "SETUP_DRAFT" || payload.diagnosis !== undefined)) {
          context.addIssue({ code: "custom", path: ["testEnvDetect"], message: "test environment detection requires the setup draft mode and is not a diagnosis" });
        }
        // Test services (slice 1): a coding run carries the plan too, but only one with dependencies (the working sandbox gets them while the agent codes); every other mode is as it was.
        if (payload.testEnvironment !== undefined && payload.workflowMode !== "CHECKS" && !(payload.workflowMode === "IMPLEMENT" && (payload.testEnvironment.dependencies?.length ?? 0) > 0)) {
          context.addIssue({ code: "custom", path: ["testEnvironment"], message: "a test environment plan requires the verification (checks) mode, or a coding run with dependencies" });
        }
        if (payload.ownerRedirect !== undefined && payload.workflowMode !== "IMPLEMENT") {
          context.addIssue({ code: "custom", path: ["ownerRedirect"], message: "an owner redirect requires implementation mode" });
        }
        if (payload.ownerRedirect !== undefined && payload.agentStep !== undefined) {
          context.addIssue({ code: "custom", path: ["ownerRedirect"], message: "an owner redirect is for a coding step, not an agent step (the agent step would ignore it)" });
        }
        if(payload.modelPolicy!==undefined&&payload.model===undefined)context.addIssue({code:"custom",path:["model"],message:"a governed task requires an explicit server-resolved model"});
        if ((payload.workflowMode === "FEEDBACK_REVIEW") !== (payload.workflowFeedbackReview !== undefined)) {
          context.addIssue({ code: "custom", path: ["workflowFeedbackReview"], message: "feedback review mode requires its exact task workflow binding" });
        }
        if (payload.workflowPhase !== undefined && payload.workflowMode !== "PLAN") {
          context.addIssue({ code: "custom", path: ["workflowPhase"], message: "the document a run writes requires planning mode" });
        }
        if (payload.planFormat !== undefined && payload.workflowMode !== "PLAN") {
          context.addIssue({ code: "custom", path: ["planFormat"], message: "the plan format requires planning mode" });
        }
        if (payload.workflowE2EPlanVersion !== undefined && (payload.workflowMode !== "PLAN" || payload.planFormat !== "structured")) {
          context.addIssue({ code: "custom", path: ["workflowE2EPlanVersion"], message: "the application E2E plan version requires a structured planning run" });
        }
        if (payload.workflowE2EGroundingSource !== undefined && (payload.workflowMode !== "PLAN" || payload.planFormat !== "structured" || payload.workflowE2EPlanVersion !== 2)) {
          context.addIssue({ code: "custom", path: ["workflowE2EGroundingSource"], message: "the grounding source export requires a structured planning run with the application plan version" });
        }
        if (payload.workflowReviewChecks !== undefined && payload.workflowMode !== "REVIEW") {
          context.addIssue({ code: "custom", path: ["workflowReviewChecks"], message: "the checks reviewers are told about require review mode" });
        }
        if (payload.workflowApprovedPlan !== undefined && payload.workflowMode !== undefined && payload.workflowMode !== "IMPLEMENT") {
          context.addIssue({ code: "custom", path: ["workflowApprovedPlan"], message: "the approved plan a coding run keeps through compaction requires coding mode" });
        }
        if (payload.workflowReviewPlan !== undefined && payload.workflowMode !== "REVIEW") {
          context.addIssue({ code: "custom", path: ["workflowReviewPlan"], message: "the approved plan reviewers are shown requires review mode" });
        }
        if (payload.workflowReviewFeedback !== undefined && payload.workflowMode !== "REVIEW") {
          context.addIssue({ code: "custom", path: ["workflowReviewFeedback"], message: "the approved feedback reviewers are shown requires review mode" });
        }
        if (payload.workflowReviewNote !== undefined && payload.workflowMode !== "REVIEW") {
          context.addIssue({ code: "custom", path: ["workflowReviewNote"], message: "the retry note reviewers are shown requires review mode" });
        }
        if (payload.workflowReviewSpec !== undefined && payload.workflowMode !== "REVIEW") {
          context.addIssue({ code: "custom", path: ["workflowReviewSpec"], message: "the spec the review walks requires review mode" });
        }
        if (payload.workflowReviewers !== undefined && payload.workflowMode !== "REVIEW") {
          context.addIssue({ code: "custom", path: ["workflowReviewers"], message: "the reviews to run require review mode" });
        }
        if (payload.workflowSecondReviewer !== undefined && (payload.workflowMode !== "REVIEW" || (payload.workflowReviewers !== undefined && !payload.workflowReviewers.includes("CRITIC")))) {
          context.addIssue({ code: "custom", path: ["workflowSecondReviewer"], message: "the second reviewer requires review mode with the code review" });
        }
        if (payload.designReview !== undefined && payload.workflowMode !== "PLAN_CRITIQUE") {
          context.addIssue({ code: "custom", path: ["designReview"], message: "the design review requires plan-check mode" });
        }
        if (payload.workflowReviewRisk !== undefined && payload.workflowMode !== "REVIEW") {
          context.addIssue({ code: "custom", path: ["workflowReviewRisk"], message: "the review's risk level requires review mode" });
        }
        if (payload.workflowFix !== undefined && (payload.workflowMode !== "IMPLEMENT" || payload.workflowDependencies !== undefined)) {
          context.addIssue({ code: "custom", path: ["workflowFix"], message: "a fix to an open pull request requires implementation mode and no work breakdown" });
        }
        if ((payload.workflowMode === "SPEC_WRITE") !== (payload.specWrite !== undefined)) {
          context.addIssue({ code: "custom", path: ["specWrite"], message: "the spec write mode and its binding go together" });
        }
        if (payload.workflowFeedbackApproval !== undefined && payload.workflowMode !== "IMPLEMENT") {
          context.addIssue({ code: "custom", path: ["workflowFeedbackApproval"], message: "feedback approval binding requires implementation mode" });
        }
        // Rovara's own decision on review comments (Plan 6 Task 16) is a feedback fix. (A feedback fix may also run with no approval: the owner's Retry of one that stopped continues it from the current code.)
        if (payload.workflowFeedbackApproval?.autonomy !== undefined && payload.workflowFix?.source !== "feedback") {
          context.addIssue({ code: "custom", path: ["workflowFeedbackApproval"], message: "an automatic feedback approval belongs to a feedback fix" });
        }
        if (payload.workflowDependencies !== undefined && payload.workflowMode !== "IMPLEMENT") {
          context.addIssue({ code: "custom", path: ["workflowDependencies"], message: "a work breakdown requires implementation mode" });
        }
        if (payload.workflowE2EAdmission !== undefined && payload.workflowMode !== "CHECKS") {
          context.addIssue({ code: "custom", path: ["workflowE2EAdmission"], message: "a trusted E2E admission requires its separate CHECKS operation" });
        }
      }),
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
        /**
         * The tree the task's checks and reviews passed on. The worker publishes exactly this tree on the task's base and
         * refuses before pushing when the workspace no longer matches it. Sent only to a worker whose /ping lists
         * "publish.candidateTree"; never dropped for an older one.
         */
        candidateTreeSha: z.string().regex(/^[a-f0-9]{40}$/).optional(),
        /** Server-selected behavior for publishing a workflow candidate; never supplied by a caller. */
        publicationMode: z.enum(["COMMITTED_HEAD", "CHECKED_TREE"]).optional(),
        /** Digest of the immutable workflow publication context, copied into the signed worker claims. */
        publicationContextDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
        /** The exact committed HEAD whose tree was checked and reviewed. */
        candidateCommitSha: z.string().regex(/^[a-f0-9]{40}$/).optional(),
        /**
         * The base commit the broker pinned for the task in this repository: the published commit's only parent, in
         * place of the commit the workspace's (agent-writable) preparation manifest records. Only with candidateTreeSha.
         * Sent only to a worker whose /ping lists "publish.workflowBase"; never dropped for an older one.
         */
        workflowBaseCommit: z.string().regex(/^[a-f0-9]{40}$/).optional(),
        /**
         * Plug-in foundations I3: who asked for the work and who approved its plan, written as `Requested-by` / `Approved-by` trailers on the commit the worker makes. Built by the broker from its
         * own records (a person who was erased is "a former member", never named). Sent only to a worker whose /ping lists "publish.attribution"; never dropped for an older one, because a
         * publication that was meant to say whose it was must not go out saying nothing.
         */
        attribution: ActingAttributionSchema.optional(),
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
        if (value.mode !== "create" && value.candidateTreeSha !== undefined) {
          context.addIssue({ code: "custom", message: "candidateTreeSha is allowed only in create mode" });
        }
        if (value.workflowBaseCommit !== undefined && value.candidateTreeSha === undefined) {
          context.addIssue({ code: "custom", message: "workflowBaseCommit is allowed only with candidateTreeSha" });
        }
        if (value.candidateCommitSha !== undefined && value.candidateTreeSha === undefined) {
          context.addIssue({ code: "custom", message: "candidateCommitSha is allowed only with candidateTreeSha" });
        }
        if ((value.candidateTreeSha === undefined) !== (value.publicationMode === undefined)) {
          context.addIssue({ code: "custom", path: ["publicationMode"], message: "candidateTreeSha and publicationMode go together" });
        }
        if (value.publicationMode === "COMMITTED_HEAD" && value.candidateCommitSha === undefined) {
          context.addIssue({ code: "custom", path: ["candidateCommitSha"], message: "committed-head publication requires the exact checked commit" });
        }
        if (value.publicationMode === "CHECKED_TREE" && value.candidateCommitSha !== undefined) {
          context.addIssue({ code: "custom", path: ["candidateCommitSha"], message: "checked-tree publication cannot select a commit" });
        }
        if ((value.publicationMode === undefined) !== (value.publicationContextDigest === undefined)) {
          context.addIssue({ code: "custom", path: ["publicationContextDigest"], message: "workflow publication mode and context digest must be present together" });
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
        /**
         * A workflow task's fix to its pull request: the tree the fix's checks and reviews passed on. The worker pushes
         * exactly this tree, runs no readiness checks again, and refuses before pushing when the workspace no longer
         * matches it. Sent only to a worker whose /ping lists "task.workflowPullRequestUpdate".
         */
        workflowCandidateTreeSha: z.string().regex(/^[a-f0-9]{40}$/).optional(),
        /** The base commit the broker pinned for the task in this repository; it must be in the workspace's history. Always and only with workflowCandidateTreeSha. */
        workflowBaseCommit: z.string().regex(/^[a-f0-9]{40}$/).optional(),
        /**
         * Which fix the reviewed tree is (failing CI, a conflict, comments), so its commit says so. Only with workflowCandidateTreeSha. It changes nothing about the push: a worker whose /ping does not list
         * "task.workflowFix" is sent the push without it, and its commit keeps the usual message.
         */
        workflowFix: WorkflowFixPayloadSchema.optional(),
        /**
         * A workflow task's merge of the base branch into its pull request's branch (Plan 6 Task 17, `sync` only): the worker merges exactly `baseCommit` (no rebase, no force-push), runs the readiness
         * checks and pushes to the head it was told (`expectedHeadCommit`); a conflict is returned as the conflicting files, nothing pushed, the merge's files left in the workspace. Sent only to a
         * worker whose /ping lists "maintain.workflowSync"; never dropped, because an older worker would merge whatever the base is now.
         */
        workflowSync: z.object({ baseCommit: z.string().regex(/^[a-f0-9]{40}$/), expectedHeadCommit: z.string().regex(/^[a-f0-9]{40,64}$/) }).strict().optional(),
        /**
         * A conflict round's reviewed fix is pushed as a merge commit (`append` with the reviewed tree only): the first parent is the head the pull request has, the second is this commit of the base.
         * Sent only to a worker whose /ping lists "maintain.workflowSync".
         */
        workflowMergeBase: z.string().regex(/^[a-f0-9]{40}$/).optional(),
      })
      .strict()
      .superRefine((value, context) => {
        if (value.workflowSync !== undefined && (value.action !== "sync" || value.workflowCandidateTreeSha !== undefined || value.workflowSync.expectedHeadCommit !== value.expectedHeadCommit)) {
          context.addIssue({ code: "custom", path: ["workflowSync"], message: "a merge of the base branch is a sync of the recorded head, with no reviewed tree" });
        }
        if (value.workflowMergeBase !== undefined && value.workflowCandidateTreeSha === undefined) {
          context.addIssue({ code: "custom", path: ["workflowMergeBase"], message: "the base a fix was merged with goes with the reviewed tree" });
        }
        if (value.workflowFix !== undefined && value.workflowCandidateTreeSha === undefined) {
          context.addIssue({ code: "custom", path: ["workflowFix"], message: "the fix a push is for goes with the reviewed tree" });
        }
        if (value.workflowCandidateTreeSha !== undefined && value.action !== "append") {
          context.addIssue({ code: "custom", message: "workflowCandidateTreeSha is allowed only with append" });
        }
        // A reviewed fix is pushed only with the task's base, so its base ancestry is always checked.
        if ((value.workflowBaseCommit === undefined) !== (value.workflowCandidateTreeSha === undefined)) {
          context.addIssue({ code: "custom", message: "workflowBaseCommit and workflowCandidateTreeSha go together" });
        }
      }),
  }).strict(),
  InvocationBaseSchema.extend({
    kind: z.literal("cancel"),
    payload: z.object({ targetOperationId: z.string().uuid() }).strict(),
  }).strict(),
  // Live steer: a person's message for the pi session of the running step `payload.targetOperationId` (live-steer.ts).
  InvocationBaseSchema.extend({ kind: z.literal("steer"), payload: LiveSteerPayloadSchema }).strict(),
  // Live interaction A2: a read-only look at the workspace's working tree for an Ask (live-peek.ts). Answered on the same request; no operation record, no callback.
  InvocationBaseSchema.extend({ kind: z.literal("peek"), payload: PeekPayloadSchema }).strict(),
  InvocationBaseSchema.extend({ kind: z.literal("resume"), payload: z.object({}).strict() }).strict(),
  InvocationBaseSchema.extend({ kind: z.literal("close"), payload: z.object({}).strict() }).strict(),
]);

export const WorkerAcknowledgementSchema = z
  .object({ accepted: z.boolean(), operationId: z.string().uuid(), status: z.string().min(1) })
  .strict();

export type WorkerInvocation = z.infer<typeof WorkerInvocationSchema>;
