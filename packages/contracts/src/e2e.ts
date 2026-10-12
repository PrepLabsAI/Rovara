import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "./canonical-json.js";
import type { WorkflowVerificationResults } from "./task-workflow.js";
import { redactText } from "./redaction.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const id = (max = 120) => z.string().trim().min(1).max(max);
const ids = (max = 64) => z.array(id()).min(1).max(max).refine((values) => new Set(values).size === values.length, "identifiers must be unique");
const timestamp = z.string().datetime();
const positiveInt = z.number().int().positive();
const relative = z.string().min(1).max(1024).refine((value) => !value.startsWith("/") && !value.includes("\\") && !value.split("/").includes(".."), "path must be relative and traversal-free");
const plainJson = z.unknown().superRefine((value, context) => {
  const visit = (item: unknown, depth: number): void => {
    if (depth > 32) { context.addIssue({ code: "custom", message: "JSON nesting exceeds 32" }); return; }
    if (typeof item === "string" && Buffer.byteLength(item, "utf8") > 65_536) context.addIssue({ code: "custom", message: "JSON string exceeds 65536 bytes" });
    else if (Array.isArray(item)) item.forEach((child) => visit(child, depth + 1));
    else if (item !== null && typeof item === "object") Object.values(item).forEach((child) => visit(child, depth + 1));
  };
  visit(value, 0);
});

export const E2E_WORKER_PROTOCOL = "trusted-e2e/v1" as const;
export const E2EWorkerProtocolSchema = z.literal(E2E_WORKER_PROTOCOL);
export function assertE2EWorkerProtocol(protocol: unknown): typeof E2E_WORKER_PROTOCOL {
  const parsed = E2EWorkerProtocolSchema.safeParse(protocol);
  if (!parsed.success) throw new Error("worker does not support trusted E2E protocol");
  return parsed.data;
}
export const E2E_PROJECT_CHECK_ID = "project-e2e" as const;
export const E2E_HARD_LIMITS = { runTimeoutMs: 1_800_000, startupTimeoutMs: 120_000, preparationTimeoutMs: 300_000, caseTimeoutMs: 300_000, maxActionsPerCase: 100, maxModelRequests: 200, maxInputTokens: 1_000_000, maxOutputTokens: 100_000 } as const;
export const E2E_DEFAULT_LIMITS = { runTimeoutMs: 600_000, startupTimeoutMs: 60_000, preparationTimeoutMs: 180_000, caseTimeoutMs: 90_000, maxActionsPerCase: 30, maxModelRequests: 60, maxInputTokens: 200_000, maxOutputTokens: 20_000, maxSpendUsd: null } as const;

export const E2EEvidenceScopeSchema = z.enum(["source", "mock-contract", "runtime", "external-live"]);
export type E2EEvidenceScope = z.infer<typeof E2EEvidenceScopeSchema>;
export const E2EExecutionModeSchema = z.enum(["mock-only", "hybrid", "real-runtime"]);
export type E2EExecutionMode = z.infer<typeof E2EExecutionModeSchema>;
export const E2ELimitsSchema = z.object({
  runTimeoutMs: positiveInt.max(E2E_HARD_LIMITS.runTimeoutMs), startupTimeoutMs: positiveInt.max(E2E_HARD_LIMITS.startupTimeoutMs),
  preparationTimeoutMs: positiveInt.max(E2E_HARD_LIMITS.preparationTimeoutMs), caseTimeoutMs: positiveInt.max(E2E_HARD_LIMITS.caseTimeoutMs),
  maxActionsPerCase: positiveInt.max(E2E_HARD_LIMITS.maxActionsPerCase), maxModelRequests: positiveInt.max(E2E_HARD_LIMITS.maxModelRequests),
  maxInputTokens: positiveInt.max(E2E_HARD_LIMITS.maxInputTokens), maxOutputTokens: positiveInt.max(E2E_HARD_LIMITS.maxOutputTokens),
  maxSpendUsd: z.number().finite().positive().nullable(),
}).strict();
export type E2ELimits = z.infer<typeof E2ELimitsSchema>;
export const E2ECapturePolicySchema = z.object({ screenshots: z.boolean(), traces: z.boolean(), video: z.boolean(), downloads: z.boolean() }).strict();
export type E2ECapturePolicy = z.infer<typeof E2ECapturePolicySchema>;

const E2ETargetBaseSchema = z.object({ targetId: id(80), applicationId: id(120), runtimeProfileId: id(120), accountProfileId: id(120) }).strict();
export const E2ETargetSchema = z.discriminatedUnion("kind", [
  E2ETargetBaseSchema.extend({ kind: z.literal("web"), browser: z.enum(["chromium", "firefox", "webkit"]), viewport: z.object({ width: positiveInt.max(7680), height: positiveInt.max(4320) }).strict() }),
  E2ETargetBaseSchema.extend({ kind: z.literal("api"), protocol: z.literal("http"), originRef: id(200) }),
  E2ETargetBaseSchema.extend({ kind: z.literal("mobile"), os: z.enum(["android", "ios"]), appId: id(200), deviceProfileId: id(120) }),
  E2ETargetBaseSchema.extend({ kind: z.literal("desktop"), os: z.enum(["linux", "macos", "windows"]), driver: z.enum(["electron", "native"]), appId: id(200) }),
  E2ETargetBaseSchema.extend({ kind: z.literal("contract"), requestedTargetId: id(80), adapterProfileId: id(120) }),
]);
export type E2ETarget = z.infer<typeof E2ETargetSchema>;
export const E2EPolicySchema = z.object({ schemaVersion: z.literal(1), policyRevision: positiveInt, executionMode: z.literal("trusted-scenarios"), baselineScenarioIds: z.array(id()).max(32), targets: z.array(E2ETargetSchema).max(12), defaultSandboxProfileId: id(120), fallback: z.literal("mock-unconnected"), modelRouteRevision: id(120).nullable(), capture: E2ECapturePolicySchema, limits: E2ELimitsSchema }).strict().superRefine((policy, context) => {
  if (new Set(policy.targets.map((target) => target.targetId)).size !== policy.targets.length) context.addIssue({ code: "custom", path: ["targets"], message: "target IDs must be unique" });
  if (new Set(policy.baselineScenarioIds).size !== policy.baselineScenarioIds.length) context.addIssue({ code: "custom", path: ["baselineScenarioIds"], message: "baseline scenario IDs must be unique" });
});
export type E2EPolicy = z.infer<typeof E2EPolicySchema>;
export function e2ePolicyDigest(policy: E2EPolicy): string { return createHash("sha256").update(canonicalJson(E2EPolicySchema.parse(policy))).digest("hex"); }
export const E2EWorkflowProgressSchema = z.object({ contractDigest: digest, policyDigest: digest, bundleDigest: digest, executionPlanDigest: digest, required: z.boolean(), currentGroupRunIds: z.array(z.string().uuid()).max(12), resultRefs: z.array(id(200)).max(64) }).strict();
export type E2EWorkflowProgress = z.infer<typeof E2EWorkflowProgressSchema>;

const CommandRecipeSchema = z.object({ program: id(256), args: z.array(z.string().max(8192)).max(256), cwd: relative, timeoutMs: positiveInt.max(300_000), env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/), z.string().max(4096)).refine((env) => Object.keys(env).length <= 64 && !Object.keys(env).some((key) => /^(PATH|HOME|AWS_|AGENTX_|PI_|GIT_)/i.test(key) || /(TOKEN|SECRET|PASSWORD|API_KEY)$/i.test(key)) && !Object.values(env).some((value) => redactText(value) !== value), "environment must contain only non-secret allowlisted literals") }).strict().superRefine((command, context) => {
  if (/(^|[/\\])(?:sh|bash|zsh|cmd|powershell|pwsh)(\.exe)?$/i.test(command.program) || command.args.some((arg) => /(^|\s)(?:\||&&|;|>|<|\$\(|`)/.test(arg))) context.addIssue({ code: "custom", message: "shell wrappers and shell-interpreted arguments are forbidden" });
});
export type E2ECommandRecipe = z.infer<typeof CommandRecipeSchema>;
export const E2EAppRecipeSchema = z.object({ schemaVersion: z.literal(1), recipeDigest: digest, build: z.array(CommandRecipeSchema).max(16), launch: z.discriminatedUnion("kind", [z.object({ kind: z.literal("service"), start: CommandRecipeSchema, health: z.object({ path: relative, expectedStatus: z.number().int().min(100).max(599) }).strict() }).strict(), z.object({ kind: z.literal("application"), appId: id(200), artifactRef: id(500), arguments: z.array(z.string().max(8192)).max(100) }).strict(), z.object({ kind: z.literal("contract"), adapterProfileId: id(120), operationIds: ids(200) }).strict()]), serviceProfileIds: z.array(id(120)).max(8), seedProfileId: id(120), accountProfileIds: ids(32), allowedOrigins: z.array(id(200)).max(64) }).strict();
export type E2EAppRecipe = z.infer<typeof E2EAppRecipeSchema>;

const stepSchemas = [
  z.object({ kind: z.literal("navigate"), path: relative }), z.object({ kind: z.literal("fill"), testId: id(256), value: z.string().max(8192) }), z.object({ kind: z.literal("click"), testId: id(256) }),
  z.object({ kind: z.literal("agent"), goal: z.string().min(1).max(8192), maxActions: positiveInt.max(100) }), z.object({ kind: z.literal("request"), requestId: id(120), path: relative, method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]), body: plainJson }),
  z.object({ kind: z.literal("invoke-contract"), operationId: id(120), input: plainJson }), z.object({ kind: z.literal("launch-app") }), z.object({ kind: z.literal("tap"), testId: id(256) }),
  z.object({ kind: z.literal("swipe"), direction: z.enum(["up", "down", "left", "right"]) }), z.object({ kind: z.literal("deep-link"), path: relative }), z.object({ kind: z.literal("restart-app") }),
  z.object({ kind: z.literal("set-permission"), permission: id(120), value: z.enum(["grant", "deny", "reset"]) }), z.object({ kind: z.literal("choose-file"), fixtureFileId: id(120) }),
].map((schema) => schema.strict());
export const E2EStepSchema = z.discriminatedUnion("kind", stepSchemas as [typeof stepSchemas[number], typeof stepSchemas[number], ...typeof stepSchemas[number][]]);
export type E2EStep = z.infer<typeof E2EStepSchema>;
export const E2EAssertionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), testId: id(256), equals: z.string().max(8192) }).strict(), z.object({ kind: z.literal("visible"), testId: id(256), equals: z.boolean() }).strict(),
  z.object({ kind: z.literal("csv"), downloadName: id(255), columns: ids(256), rows: z.array(z.array(z.string().max(8192)).max(256)).max(10_000) }).strict(),
  z.object({ kind: z.literal("http-status"), path: relative, method: z.enum(["GET", "POST"]), equals: z.number().int().min(100).max(599) }).strict(),
  z.object({ kind: z.literal("json"), responseId: id(120), schemaRef: id(200), equals: plainJson }).strict(), z.object({ kind: z.literal("state"), probeId: id(120), equals: plainJson, pollTimeoutMs: positiveInt.max(300_000) }).strict(),
  z.object({ kind: z.literal("file"), fixtureRootId: id(120), relativePath: relative, sha256: digest }).strict(),
]);
export type E2EAssertion = z.infer<typeof E2EAssertionSchema>;
export const E2EScenarioSchema = z.object({ scenarioId: id(120), requirementId: id(120), requestedTargetIds: ids(12), required: z.boolean(), accountProfileId: id(120), minimumEvidence: E2EEvidenceScopeSchema, requiredRealComponentIds: z.array(id(120)).max(32), steps: z.array(E2EStepSchema).max(30), assertions: z.array(E2EAssertionSchema).min(1).max(20) }).strict().superRefine((scenario, context) => {
  if (scenario.steps.some((step) => "path" in step && (/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(step.path) || /%2f|%5c/i.test(step.path) || step.path.includes("\\")))) context.addIssue({ code: "custom", path: ["steps"], message: "paths must be same-origin relative paths" });
  if (new Set(scenario.requiredRealComponentIds).size !== scenario.requiredRealComponentIds.length) context.addIssue({ code: "custom", path: ["requiredRealComponentIds"], message: "component IDs must be unique" });
});
export type E2EScenario = z.infer<typeof E2EScenarioSchema>;
export const E2EScenarioBundleSchema = z.object({ schemaVersion: z.literal(1), planDigest: digest, bundleDigest: digest, templateVersion: id(80), scenarios: z.array(E2EScenarioSchema).max(32) }).strict().superRefine((bundle, context) => {
  if (new Set(bundle.scenarios.map((scenario) => scenario.scenarioId)).size !== bundle.scenarios.length) context.addIssue({ code: "custom", path: ["scenarios"], message: "scenario IDs must be unique" });
  const actual = e2eScenarioBundleDigest(bundle);
  if (bundle.bundleDigest !== actual) context.addIssue({ code: "custom", path: ["bundleDigest"], message: "bundle digest does not match canonical content" });
});
export type E2EScenarioBundle = z.infer<typeof E2EScenarioBundleSchema>;
export function e2eScenarioBundleDigest(bundle: E2EScenarioBundle): string { const { bundleDigest: _ignored, ...content } = bundle; return createHash("sha256").update(canonicalJson(content)).digest("hex"); }
export function validateE2EScenarioBundleForPolicy(bundle: unknown, policy: unknown): E2EScenarioBundle {
  const parsedPolicy = E2EPolicySchema.parse(policy); const parsedBundle = E2EScenarioBundleSchema.parse(bundle);
  for (const scenario of parsedBundle.scenarios) {
    for (const requestedTargetId of scenario.requestedTargetIds) {
      const target = parsedPolicy.targets.find((item) => item.targetId === requestedTargetId);
      if (target === undefined) throw new Error(`scenario references unconfigured target ${requestedTargetId}`);
      if (target.accountProfileId !== scenario.accountProfileId) throw new Error(`scenario account profile does not match target ${requestedTargetId}`);
      if (target.kind === "api" && scenario.steps.some((step) => ["navigate", "fill", "click", "launch-app", "tap", "swipe", "deep-link", "restart-app", "set-permission", "choose-file"].includes(step.kind))) throw new Error(`UI scenario steps are incompatible with API target ${requestedTargetId}`);
    }
  }
  if (parsedPolicy.modelRouteRevision === null && parsedBundle.scenarios.some((scenario) => scenario.steps.some((step) => step.kind === "agent"))) throw new Error("agent steps require an approved model route revision");
  return parsedBundle;
}

export const E2EMockSpecSchema = z.object({ componentId: id(120), requestedTargetId: id(80), effectiveTargetId: id(80), kind: z.enum(["api", "database", "queue", "identity", "device-service", "os-service", "model", "driver"]), contractDigest: digest, fixtureVersion: id(80), sourceRefs: z.array(z.object({ path: relative, sha256: digest }).strict()).max(64), reason: z.enum(["unconnected", "unapproved", "declined", "unqualified", "phase-unavailable"]) }).strict();
export type E2EMockSpec = z.infer<typeof E2EMockSpecSchema>;
export const E2ERuntimeAvailabilitySchema = z.object({ targetId: id(80), profileId: id(120), connection: z.enum(["connected", "unconnected"]), approval: z.enum(["approved", "pending", "declined"]), qualification: z.enum(["qualified", "unqualified"]), authorizationRevision: id(120) }).strict();
export type E2ERuntimeAvailability = z.infer<typeof E2ERuntimeAvailabilitySchema>;
export const E2ECriterionExpectationSchema = z.object({ criterionId: id(120), requirementId: id(120), scenarioId: id(120), requestedTargetId: id(80), required: z.boolean(), minimumEvidence: E2EEvidenceScopeSchema, requiredRealComponentIds: z.array(id(120)).max(32), expectedCaseIds: z.array(id(160)).max(64) }).strict();
export type E2ECriterionExpectation = z.infer<typeof E2ECriterionExpectationSchema>;
export const E2ECaseCoverageSchema = z.object({ observedScope: E2EEvidenceScopeSchema, subject: z.enum(["candidate", "simulation", "fixture"]), executedCandidateParts: z.array(id(256)).max(64), realComponentIds: z.array(id(120)).max(32), mockedComponentIds: z.array(id(120)).max(32), unexercisedBehaviors: z.array(id(256)).max(64) }).strict();
export type E2ECaseCoverage = z.infer<typeof E2ECaseCoverageSchema>;
export const E2EExpectedCaseSchema = z.object({ caseId: id(160), criterionId: id(120), scenarioId: id(120), upstreamTestId: id(160), targetId: id(80), requestedTargetId: id(80), agentId: id(120), repeat: z.literal(0), assertionDigest: digest, required: z.boolean(), minimumEvidence: E2EEvidenceScopeSchema, requiredRealComponentIds: z.array(id(120)).max(32) }).strict();
export type E2EExpectedCase = z.infer<typeof E2EExpectedCaseSchema>;
const E2EGroupSchema = z.object({ groupId: id(80), targetIds: ids(3), runtimeProfileId: id(120), mode: E2EExecutionModeSchema, mockManifestDigest: digest, expectedCases: z.array(E2EExpectedCaseSchema).max(64) }).strict();
export const E2EExecutionPlanSchema = z.object({ schemaVersion: z.literal(1), digest, candidateDigest: digest, planDigest: digest, criteria: z.array(E2ECriterionExpectationSchema).max(64), effectiveTargets: z.array(E2ETargetSchema).max(12), groups: z.array(E2EGroupSchema).max(4), mocks: z.array(E2EMockSpecSchema).max(200), unavailableCriteria: z.array(z.object({ criterionId: id(120), reason: id(500) }).strict()).max(64) }).strict().superRefine((plan, context) => {
  if (e2eExecutionPlanDigest(plan) !== plan.digest) context.addIssue({ code: "custom", path: ["digest"], message: "execution plan digest does not match canonical content" });
  if (new Set(plan.criteria.map((criterion) => criterion.criterionId)).size !== plan.criteria.length) context.addIssue({ code: "custom", path: ["criteria"], message: "criterion IDs must be unique" });
  const targets = new Set(plan.effectiveTargets.map((target) => target.targetId));
  if (new Set(plan.effectiveTargets.map((target) => target.targetId)).size !== plan.effectiveTargets.length) context.addIssue({ code: "custom", path: ["effectiveTargets"], message: "effective target IDs must be unique" });
  if (plan.groups.some((group) => group.targetIds.some((targetId) => !targets.has(targetId)))) context.addIssue({ code: "custom", path: ["groups"], message: "group targets must reference effective targets" });
  const cases = plan.groups.flatMap((group) => group.expectedCases);
  if (new Set(plan.unavailableCriteria.map((item) => item.criterionId)).size !== plan.unavailableCriteria.length) context.addIssue({ code: "custom", path: ["unavailableCriteria"], message: "unavailable criteria must be unique" });
  const unavailableIds = new Set(plan.unavailableCriteria.map((item) => item.criterionId));
  for (const unavailableId of unavailableIds) if (!plan.criteria.some((item) => item.criterionId === unavailableId)) context.addIssue({ code: "custom", path: ["unavailableCriteria"], message: "unavailable criteria must reference a planned criterion" });
  if (cases.length > 64) context.addIssue({ code: "custom", path: ["groups"], message: "verification round may expand to at most 64 cases" });
  if (new Set(cases.map((item) => item.caseId)).size !== cases.length) context.addIssue({ code: "custom", path: ["groups"], message: "expected case IDs must be unique" });
  for (const group of plan.groups) for (const item of group.expectedCases) {
    const target = plan.effectiveTargets.find((candidate) => candidate.targetId === item.targetId);
    if (!group.targetIds.includes(item.targetId) || target === undefined || (target.kind === "contract" ? target.requestedTargetId : target.targetId) !== item.requestedTargetId) context.addIssue({ code: "custom", path: ["groups"], message: "expected cases must preserve requested and effective target identities" });
  }
  for (const criterion of plan.criteria) {
    if (criterion.expectedCaseIds.length === 0 && !unavailableIds.has(criterion.criterionId)) context.addIssue({ code: "custom", path: ["criteria"], message: "criteria with no executable cases require an unavailable reason" });
    for (const caseId of criterion.expectedCaseIds) {
      const expected = cases.find((item) => item.caseId === caseId && item.criterionId === criterion.criterionId && item.requestedTargetId === criterion.requestedTargetId);
      if (expected === undefined || expected.required !== criterion.required || expected.minimumEvidence !== criterion.minimumEvidence || canonicalJson(expected.requiredRealComponentIds) !== canonicalJson(criterion.requiredRealComponentIds)) context.addIssue({ code: "custom", path: ["criteria"], message: "criterion cases must preserve criterion, target, and evidence floor bindings" });
    }
  }
});
export type E2EExecutionPlan = z.infer<typeof E2EExecutionPlanSchema>;
export function e2eExecutionPlanDigest(plan: E2EExecutionPlan): string { const { digest: _ignored, ...content } = plan; return createHash("sha256").update(canonicalJson(content)).digest("hex"); }

export const E2EExpectedCaseManifestSchema = E2EExpectedCaseSchema;
export const E2ERunBindingSchema = z.object({ schemaVersion: z.literal(1), runId: z.string().uuid(), roundId: z.string().uuid(), taskId: id(120), operationId: id(120), operationFence: positiveInt, workflowRevision: positiveInt, groupId: id(80), executionPlanDigest: digest, executionMode: E2EExecutionModeSchema, mockManifestDigest: digest, authorizationRevision: id(120), candidateDigest: digest, planDigest: digest, policyDigest: digest, bundleDigest: digest, appBuildDigest: digest, environmentDigest: digest, runtimeManifestDigest: digest, modelRouteRevision: id(120).nullable(), expectedCases: z.array(E2EExpectedCaseSchema).max(64), admittedAt: timestamp, deadlineAt: timestamp }).strict().superRefine((binding, context) => {
  if (Date.parse(binding.deadlineAt) <= Date.parse(binding.admittedAt)) context.addIssue({ code: "custom", path: ["deadlineAt"], message: "run deadline must follow admission" });
  if (new Set(binding.expectedCases.map((item) => item.caseId)).size !== binding.expectedCases.length) context.addIssue({ code: "custom", path: ["expectedCases"], message: "expected case IDs must be unique" });
});
export type E2ERunBinding = z.infer<typeof E2ERunBindingSchema>;
export function e2eBindingDigest(binding: E2ERunBinding): string { return createHash("sha256").update(canonicalJson(E2ERunBindingSchema.parse(binding))).digest("hex"); }
export const E2ERoundSchema = z.object({ schemaVersion: z.literal(1), roundId: z.string().uuid(), taskId: id(120), operationId: id(120), operationFence: positiveInt, workflowRevision: positiveInt, executionPlanDigest: digest, admittedAt: timestamp, deadlineAt: timestamp, limits: E2ELimitsSchema, groupBindings: z.array(E2ERunBindingSchema).max(4) }).strict().superRefine((round, context) => {
  const groups = new Set<string>();
  for (const binding of round.groupBindings) {
    if (groups.has(binding.groupId)) context.addIssue({ code: "custom", path: ["groupBindings"], message: "round group bindings must be unique" }); groups.add(binding.groupId);
    if (binding.roundId !== round.roundId || binding.taskId !== round.taskId || binding.operationId !== round.operationId || binding.operationFence !== round.operationFence || binding.workflowRevision !== round.workflowRevision || binding.executionPlanDigest !== round.executionPlanDigest || binding.admittedAt !== round.admittedAt || binding.deadlineAt !== round.deadlineAt) context.addIssue({ code: "custom", path: ["groupBindings"], message: "group binding must share round identity, deadline, and plan" });
  }
  if (Date.parse(round.deadlineAt) <= Date.parse(round.admittedAt)) context.addIssue({ code: "custom", path: ["deadlineAt"], message: "round deadline must follow admission" });
});
export type E2ERound = z.infer<typeof E2ERoundSchema>;

export const E2ECaseStatusSchema = z.enum(["passed", "failed", "unavailable", "skipped", "unstable", "cancelled", "stale"]);
export type E2ECaseStatus = z.infer<typeof E2ECaseStatusSchema>;
export const E2EArtifactRefSchema = z.object({ artifactId: id(200), sha256: digest, bytes: z.number().int().nonnegative().max(26_214_400), mediaType: id(120), kind: z.enum(["report", "screenshot", "trace", "video", "download"]), captureQualification: z.enum(["synthetic", "redacted", "restricted"]) }).strict();
export type E2EArtifactRef = z.infer<typeof E2EArtifactRefSchema>;
export const E2ECaseResultSchema = z.object({ caseId: id(160), status: E2ECaseStatusSchema, reason: id(500), attemptCount: positiveInt.max(2), assertionDigest: digest, artifacts: z.array(E2EArtifactRefSchema).max(200), coverage: E2ECaseCoverageSchema }).strict();
export type E2ECaseResult = z.infer<typeof E2ECaseResultSchema>;
export const E2EQualifiedResultSchema = z.object({ schemaVersion: z.literal(1), binding: E2ERunBindingSchema, producer: id(120), startedAt: timestamp, finishedAt: timestamp, receivedAt: timestamp, status: E2ECaseStatusSchema, qualification: z.enum(["trusted", "exploratory"]), executionMode: E2EExecutionModeSchema, reason: id(500), cases: z.array(E2ECaseResultSchema).max(64), rawReportSha256: digest.nullable(), modelReceiptIds: z.array(id(200)).max(200), cleanup: z.enum(["confirmed", "pending", "failed"]) }).strict().superRefine((result, context) => {
  if (Date.parse(result.finishedAt) < Date.parse(result.startedAt)) context.addIssue({ code: "custom", path: ["finishedAt"], message: "finish precedes start" });
  if (new Set(result.cases.map((item) => item.caseId)).size !== result.cases.length) context.addIssue({ code: "custom", path: ["cases"], message: "case results must be unique" });
  const expected = new Set(result.binding.expectedCases.map((item) => item.caseId));
  if (result.cases.some((item) => !expected.has(item.caseId))) context.addIssue({ code: "custom", path: ["cases"], message: "result includes an unbound case" });
  if (result.cases.reduce((total, item) => total + item.artifacts.length, 0) > 200) context.addIssue({ code: "custom", path: ["cases"], message: "result may contain at most 200 artifacts" });
  if (result.executionMode !== result.binding.executionMode) context.addIssue({ code: "custom", path: ["executionMode"], message: "result mode must match its frozen binding" });
  if (result.binding.modelRouteRevision === null && result.modelReceiptIds.length > 0) context.addIssue({ code: "custom", path: ["modelReceiptIds"], message: "a null model route cannot have model usage receipts" });
});
export type E2EQualifiedResult = z.infer<typeof E2EQualifiedResultSchema>;
export const E2EProcessResultSchema = z.object({ exitCode: z.number().int().nullable(), timedOut: z.boolean(), aborted: z.boolean() }).strict();
export type E2EProcessResult = z.infer<typeof E2EProcessResultSchema>;

const evidenceRank: Record<E2EEvidenceScope, number> = { source: 0, "mock-contract": 1, runtime: 2, "external-live": 3 };
function qualifies(result: E2EQualifiedResult, item: E2EExpectedCase): boolean {
  const observed = result.cases.find((candidate) => candidate.caseId === item.caseId);
  return result.qualification === "trusted" && result.status === "passed" && result.cleanup === "confirmed" && observed?.status === "passed" && observed.coverage.subject === "candidate" && evidenceRank[observed.coverage.observedScope] >= evidenceRank[item.minimumEvidence] && item.requiredRealComponentIds.every((component) => observed.coverage.realComponentIds.includes(component));
}
function workflowResult(checkId: string, status: "PASS" | "FAILED" | "UNKNOWN") { return { checkId, status }; }
export function projectE2EVerification(input: E2EQualifiedResult): WorkflowVerificationResults {
  const result = E2EQualifiedResultSchema.parse(input);
  const required = result.binding.expectedCases.filter((item) => item.required);
  const passed = result.status === "passed" && result.qualification === "trusted" && result.cleanup === "confirmed" && required.length > 0 && required.every((item) => qualifies(result, item));
  const failed = result.status === "failed" || result.cases.some((item) => item.status === "failed" || item.status === "unstable");
  return { candidateDigest: result.binding.candidateDigest, producer: result.producer, environmentId: result.binding.runtimeManifestDigest, recordedAt: result.receivedAt, results: [workflowResult(E2E_PROJECT_CHECK_ID, passed ? "PASS" : failed ? "FAILED" : "UNKNOWN")] };
}
export function aggregateE2EVerification(planInput: E2EExecutionPlan, resultsInput: E2EQualifiedResult[]): WorkflowVerificationResults {
  const plan = E2EExecutionPlanSchema.parse(planInput); const results = resultsInput.map((item) => E2EQualifiedResultSchema.parse(item));
  const resultsByGroup = new Map<string, E2EQualifiedResult>();
  let identityValid = true;
  for (const result of results) {
    const binding = result.binding;
    const group = plan.groups.find((item) => item.groupId === binding.groupId);
    if (group === undefined || resultsByGroup.has(binding.groupId)
      || binding.candidateDigest !== plan.candidateDigest || binding.planDigest !== plan.planDigest
      || binding.executionPlanDigest !== plan.digest || binding.executionMode !== group.mode
      || binding.mockManifestDigest !== group.mockManifestDigest
      || canonicalJson(binding.expectedCases) !== canonicalJson(group.expectedCases)) identityValid = false;
    resultsByGroup.set(binding.groupId, result);
  }
  const allExpected = plan.groups.flatMap((group) => group.expectedCases);
  const requiredCases = allExpected.filter((item) => item.required);
  const observed = new Map<string, { result: E2EQualifiedResult; expected: E2EExpectedCase }>();
  for (const [groupId, result] of resultsByGroup) for (const expected of result.binding.expectedCases) observed.set(expected.caseId, { result, expected });
  const pass = identityValid && plan.groups.length > 0 && resultsByGroup.size === plan.groups.length && requiredCases.length > 0
    && requiredCases.every((item) => { const found = observed.get(item.caseId); return found !== undefined && canonicalJson(found.expected) === canonicalJson(item) && qualifies(found.result, item); })
    && plan.criteria.every((item) => !item.required || (item.expectedCaseIds.length > 0 && item.expectedCaseIds.every((caseId) => {
      const expected = allExpected.find((candidate) => candidate.caseId === caseId);
      const found = observed.get(caseId);
      return expected !== undefined && expected.criterionId === item.criterionId && expected.requestedTargetId === item.requestedTargetId && found !== undefined && qualifies(found.result, expected);
    })));
  const failed = [...observed.values()].some(({ result, expected }) => expected.required && (result.status === "failed" || result.cases.find((item) => item.caseId === expected.caseId)?.status === "failed"));
  const first = results[0];
  return { candidateDigest: plan.candidateDigest, producer: first?.producer ?? "e2e-aggregator", environmentId: first?.binding.runtimeManifestDigest ?? "unavailable", recordedAt: first?.receivedAt ?? new Date(0).toISOString(), results: [workflowResult(E2E_PROJECT_CHECK_ID, pass ? "PASS" : failed ? "FAILED" : "UNKNOWN")] };
}

// Additional P0 data contracts are exported as strict schemas for future owners; no runtime or broker behavior lives here.
export const E2EDiscoveredApplicationSchema = z.object({ applicationId: id(120), kind: z.enum(["web", "api", "mobile", "desktop"]), sourcePaths: z.array(relative).max(128), recipe: E2EAppRecipeSchema.nullable() }).strict();
export type E2EDiscoveredApplication = z.infer<typeof E2EDiscoveredApplicationSchema>;
export const E2EDependencyEdgeSchema = z.object({ fromApplicationId: id(120), toComponentId: id(120), contractRef: id(200).nullable(), sourcePaths: z.array(relative).max(128) }).strict();
export type E2EDependencyEdge = z.infer<typeof E2EDependencyEdgeSchema>;
export const E2EMissingInputSchema = z.object({ inputId: id(120), targetIds: z.array(id(80)).max(12), kind: z.enum(["access", "auth", "network", "business-rule", "runtime", "target-selection"]), disposition: z.enum(["blocking", "mock-substitutable"]), reason: id(500), sourcePaths: z.array(relative).max(128) }).strict();
export type E2EMissingInput = z.infer<typeof E2EMissingInputSchema>;
export const E2ERepositoryInspectionSchema = z.object({ candidateDigest: digest, sources: z.array(z.object({ path: relative, sha256: digest }).strict()).max(512), applications: z.array(E2EDiscoveredApplicationSchema).max(32), proposedTargets: z.array(E2ETargetSchema).max(12), dependencyEdges: z.array(E2EDependencyEdgeSchema).max(256), proposedScenarios: z.array(E2EScenarioSchema).max(32), missingInputs: z.array(E2EMissingInputSchema).max(128) }).strict();
export type E2ERepositoryInspection = z.infer<typeof E2ERepositoryInspectionSchema>;
export const E2ESetupProposalSchema = z.object({ candidateDigest: digest, applications: z.array(E2EDiscoveredApplicationSchema).max(32), targets: z.array(E2ETargetSchema).max(12), dependencyEdges: z.array(E2EDependencyEdgeSchema).max(256), scenarios: z.array(E2EScenarioSchema).max(32), sources: E2ERepositoryInspectionSchema.shape.sources, missingInputs: z.array(E2EMissingInputSchema).max(128), state: z.enum(["proposed", "needs-input"]) }).strict();
export type E2ESetupProposal = z.infer<typeof E2ESetupProposalSchema>;
export const E2ESetupViewSchema = z.object({ state: z.enum(["mock-ready", "mixed", "runtime-ready", "needs-input"]), selectedTargetIds: z.array(id(80)).max(12), executionPlanDigest: digest.nullable(), blockingInputIds: z.array(id(120)).max(128), mockSubstitutableInputIds: z.array(id(120)).max(128) }).strict();
export type E2ESetupView = z.infer<typeof E2ESetupViewSchema>;

export const E2EMockBindingSchema = z.object({ componentId: id(120), requestedTargetId: id(80), effectiveTargetId: id(80), binding: z.discriminatedUnion("kind", [z.object({ kind: z.literal("http"), runLocalOrigin: z.string().url() }).strict(), z.object({ kind: z.literal("in-process"), adapterProfileId: id(120), fixtureVersion: id(80) }).strict()]), contractDigest: digest }).strict();
export type E2EMockBinding = z.infer<typeof E2EMockBindingSchema>;
export type E2EMockLease = { digest: string; bindings: readonly E2EMockBinding[]; close(signal: AbortSignal): Promise<{ confirmed: boolean }> };
export type E2ECollection = { process: z.infer<typeof E2EProcessResultSchema>; rawReport: Uint8Array | null; observedUpstreamRunId: string | null; coverageByCase: ReadonlyMap<string, E2ECaseCoverage>; artifacts: E2EArtifactRef[]; modelReceiptIds: string[]; startedAt: string; finishedAt: string; cleanup: E2EQualifiedResult["cleanup"] };
export type E2EValidationContext = { binding: E2ERunBinding; producer: string; now: string; qualification: E2EQualifiedResult["qualification"] };
export type E2EApplicationRuntime = { applicationId: string; appBuildManifestDigest: string; appRecipe: E2EAppRecipe };
export type E2ERuntimeProfile = { profileId: string; kind: "default-sandbox" | "web" | "api" | "android" | "ios" | "electron" | "native-desktop"; runtimeManifestDigest: string; applications: E2EApplicationRuntime[]; networkPolicyDigest: string; seedDigest: string; limits: E2ELimits; capture: E2ECapturePolicy };
export type CompiledE2ESuite = { bundle: E2EScenarioBundle; files: ReadonlyMap<string, string>; expectedCases: E2EExpectedCase[] };
export type E2ERunInput = { binding: E2ERunBinding; suite: CompiledE2ESuite; profile: E2ERuntimeProfile; modelPermit: E2EModelPermit | null };
export type E2ERuntimePorts = { allocate(input: E2ERunInput, signal: AbortSignal): Promise<E2ELease> };
export type E2ELease = { leaseId: string; execute(signal: AbortSignal): Promise<E2ECollection>; close(signal: AbortSignal): Promise<{ confirmed: boolean }> };
export type E2EModelPermit = { permitId: string; token: string; runId: string; taskId: string; creatorPrincipal: string; routeRevision: string; expiresAt: string };
export type E2EModelRequest = { requestId: string; permit: E2EModelPermit; prompt: unknown; tools: unknown; responseFormat: unknown; toolChoice: unknown; maxOutputTokens: number; temperature: number | null; stopSequences: string[] };
export type E2EModelResponse = { content: unknown; finishReason: string; usage: { inputTokens: number | null; outputTokens: number | null }; receiptId: string };
export type E2EModelTransport = { generate(request: E2EModelRequest, signal: AbortSignal): Promise<E2EModelResponse> };
