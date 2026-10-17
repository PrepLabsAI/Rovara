import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "./canonical-json.js";
import { E2EAppRecipeSchema, E2EFeaturePlanIntentSchema, E2EScenarioSchema } from "./e2e.js";
import { isSafeE2ESourcePath } from "./e2e-source.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const gitSha = z.string().regex(/^[a-f0-9]{40}$/);
const boundedId = (max: number) => z.string().trim().min(1).max(max);
const utcTimestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/).refine((value) => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}, "timestamp must be a real canonical ISO UTC instant");

const normalizedSourcePath = z.string().min(1).max(1024).refine((value) => {
  if (!isSafeE2ESourcePath(value)) return false;
  try {
    let decoded = value;
    for (let depth = 0; depth < 4; depth += 1) decoded = decodeURIComponent(decoded);
    return !/^[a-z][a-z0-9+.-]*:/i.test(decoded) && !/%(?:2e|2f|5c)/i.test(decoded);
  } catch { return false; }
}, "source path must be normalized and traversal-safe");

export const SourceRefSchema = z.object({ path: normalizedSourcePath, sha256: digest }).strict();
export type SourceRef = z.infer<typeof SourceRefSchema>;

function uniqueSourceRefs(refs: readonly SourceRef[]): boolean {
  return new Set(refs.map((ref) => ref.path)).size === refs.length;
}

export const PlanApprovalRefSchema = z.object({ artifactId: boundedId(120), digest }).strict();
export type PlanApprovalRef = z.infer<typeof PlanApprovalRefSchema>;

export const E2EApplicationRuntimeRefSchema = z.object({
  targetId: boundedId(80), applicationId: boundedId(120), recipeDigest: digest,
  sourceRefs: z.array(SourceRefSchema).min(1).max(128), runtimeProfileId: boundedId(120), accountProfileId: boundedId(120),
}).strict().superRefine((value, context) => {
  if (!uniqueSourceRefs(value.sourceRefs)) context.addIssue({ code: "custom", path: ["sourceRefs"], message: "application runtime source references must have unique paths" });
});
export type E2EApplicationRuntimeRef = z.infer<typeof E2EApplicationRuntimeRefSchema>;

export const E2ERuntimeAccountRefSchema = z.object({
  applicationId: boundedId(120), profileId: boundedId(120), revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), definitionDigest: digest,
}).strict();
export type E2ERuntimeAccountRef = z.infer<typeof E2ERuntimeAccountRefSchema>;

const v1IntentShape = E2EFeaturePlanIntentSchema.shape;
export const E2EApplicationPlanIntentSchema = z.object({
  schemaVersion: z.literal(2), requestedTargetIds: z.array(boundedId(80)).min(1).max(12),
  portableOperationRefs: v1IntentShape.portableOperationRefs,
  mockFixtureRefs: v1IntentShape.mockFixtureRefs,
  accountContextRefs: v1IntentShape.accountContextRefs,
  scenarios: z.array(E2EScenarioSchema).min(1).max(32),
  semanticExportDeltas: v1IntentShape.semanticExportDeltas,
  applicationRuntimeRefs: z.array(E2EApplicationRuntimeRefSchema).min(1).max(12),
  runtimeAccountRefs: z.array(E2ERuntimeAccountRefSchema).max(32),
}).strict().superRefine((intent, context) => {
  const requested = new Set(intent.requestedTargetIds);
  if (requested.size !== intent.requestedTargetIds.length) context.addIssue({ code: "custom", path: ["requestedTargetIds"], message: "requested target IDs must be unique" });
  if (new Set(intent.scenarios.map((scenario) => scenario.scenarioId)).size !== intent.scenarios.length) context.addIssue({ code: "custom", path: ["scenarios"], message: "scenario IDs must be unique" });
  const refsByTarget = new Map(intent.applicationRuntimeRefs.map((ref) => [ref.targetId, ref]));
  if (refsByTarget.size !== intent.applicationRuntimeRefs.length) context.addIssue({ code: "custom", path: ["applicationRuntimeRefs"], message: "there must be one application runtime reference per target" });
  for (const [index, ref] of intent.applicationRuntimeRefs.entries()) {
    if (!requested.has(ref.targetId)) context.addIssue({ code: "custom", path: ["applicationRuntimeRefs", index, "targetId"], message: "runtime reference must bind a requested target" });
    if (!intent.scenarios.some((scenario) => scenario.requestedTargetIds.includes(ref.targetId)
      && scenario.accountProfileId === ref.accountProfileId
      && intent.accountContextRefs.some((account) => account.applicationId === ref.applicationId && account.profileId === ref.accountProfileId))) {
      context.addIssue({ code: "custom", path: ["applicationRuntimeRefs", index], message: "runtime reference must bind an assigned scenario and its approved account profile" });
    }
  }
  for (const scenario of intent.scenarios) {
    if (scenario.requestedTargetIds.length === 0 || scenario.requestedTargetIds.some((targetId) => !requested.has(targetId))) {
      context.addIssue({ code: "custom", path: ["scenarios"], message: "every scenario must bind at least one requested target" });
    }
    for (const targetId of scenario.requestedTargetIds) {
      const assignment = refsByTarget.get(targetId);
      if (!assignment || assignment.accountProfileId !== scenario.accountProfileId
        || !intent.accountContextRefs.some((account) => account.applicationId === assignment.applicationId && account.profileId === scenario.accountProfileId)
        || !intent.runtimeAccountRefs.some((account) => account.applicationId === assignment.applicationId && account.profileId === scenario.accountProfileId)) {
        context.addIssue({ code: "custom", path: ["scenarios"], message: `scenario account profile is not approved for target ${targetId}` });
      }
    }
  }
  const contextAccountKeys = intent.accountContextRefs.map((ref) => `${ref.applicationId}\0${ref.profileId}`);
  if (new Set(contextAccountKeys).size !== contextAccountKeys.length) context.addIssue({ code: "custom", path: ["accountContextRefs"], message: "account context references must be unique by application and profile" });
  const deltaKeys = intent.semanticExportDeltas.map((item) => `${item.applicationId}\0${item.operationId}`);
  if (new Set(deltaKeys).size !== deltaKeys.length) context.addIssue({ code: "custom", path: ["semanticExportDeltas"], message: "semantic export deltas must be unique by application and operation" });
  const mockRefs = intent.mockFixtureRefs ?? [];
  if (new Set(mockRefs.map((item) => `${item.requestedTargetId}\0${item.componentId}`)).size !== mockRefs.length) context.addIssue({ code: "custom", path: ["mockFixtureRefs"], message: "source-backed mock selections must be unique by target and component" });
  if (mockRefs.some((item) => !requested.has(item.requestedTargetId))) context.addIssue({ code: "custom", path: ["mockFixtureRefs"], message: "source-backed mock selection must bind a requested target" });
  const portableOperationRefs = intent.portableOperationRefs ?? [];
  if (new Set(portableOperationRefs.map((item) => `${item.applicationId}\0${item.operationId}`)).size !== portableOperationRefs.length) context.addIssue({ code: "custom", path: ["portableOperationRefs"], message: "portable operation references must be unique by application and operation" });
  const accountKeys = intent.runtimeAccountRefs.map((ref) => `${ref.applicationId}\0${ref.profileId}`);
  if (new Set(accountKeys).size !== accountKeys.length) context.addIssue({ code: "custom", path: ["runtimeAccountRefs"], message: "runtime account references must be unique by application and profile" });
  if (intent.runtimeAccountRefs.some((account) => !intent.applicationRuntimeRefs.some((runtime) => runtime.applicationId === account.applicationId && runtime.accountProfileId === account.profileId))) {
    context.addIssue({ code: "custom", path: ["runtimeAccountRefs"], message: "runtime account reference is not selected by an application runtime assignment" });
  }
  for (const ref of intent.applicationRuntimeRefs) {
    if (!intent.runtimeAccountRefs.some((account) => account.applicationId === ref.applicationId && account.profileId === ref.accountProfileId)) {
      context.addIssue({ code: "custom", path: ["runtimeAccountRefs"], message: "application runtime reference lacks its approved account profile identity and revision" });
    }
  }
  for (const [index, operation] of portableOperationRefs.entries()) {
    if (operation.requestedTargetIds.length === 0 || operation.requestedTargetIds.some((targetId) => !requested.has(targetId))) {
      context.addIssue({ code: "custom", path: ["portableOperationRefs", index, "requestedTargetIds"], message: "portable operation targets must be selected by the feature plan" });
    }
    const assignedScenarios = intent.scenarios.filter((scenario) => scenario.steps.some((step) =>
      (step.kind === "invoke-contract" || step.kind === "inspect-contract") && step.operationId === operation.operationId));
    if (assignedScenarios.length === 0 || assignedScenarios.some((scenario) => scenario.requestedTargetIds.some((targetId) => !operation.requestedTargetIds.includes(targetId)))) {
      context.addIssue({ code: "custom", path: ["portableOperationRefs", index], message: "portable operation reference must cover every assigned scenario target" });
    }
  }
  for (const [index, scenario] of intent.scenarios.entries()) {
    const step = scenario.steps[0];
    if (step?.kind !== "invoke-contract") continue;
    const operation = portableOperationRefs.find((item) => item.operationId === step.operationId);
    if (!operation || scenario.requestedTargetIds.some((targetId) => !operation.requestedTargetIds.includes(targetId))) {
      context.addIssue({ code: "custom", path: ["scenarios", index, "steps"], message: "portable invocation must reference an approved operation bound to every scenario target" });
    }
  }
});
export type E2EApplicationPlanIntent = z.infer<typeof E2EApplicationPlanIntentSchema>;
export const E2EFeaturePlanIntentAnySchema = z.discriminatedUnion("schemaVersion", [E2EFeaturePlanIntentSchema, E2EApplicationPlanIntentSchema]);

export const E2EAppArtifactOutputSchema = z.object({
  artifactId: boundedId(120), sha256: digest, appId: boundedId(200),
  platform: z.enum(["android", "ios", "linux", "macos", "windows", "web", "api"]),
}).strict();
export type E2EAppArtifactOutput = z.infer<typeof E2EAppArtifactOutputSchema>;
export const E2EAppArtifactRefSchema = E2EAppArtifactOutputSchema.extend({ buildManifestDigest: digest }).strict();
export type E2EAppArtifactRef = z.infer<typeof E2EAppArtifactRefSchema>;

export const E2EAppBuildManifestSchema = z.object({
  schemaVersion: z.literal("e2e-app-build/v1"), candidateDigest: digest, applicationId: boundedId(120),
  repository: z.object({ repositoryId: boundedId(120), commitSha: gitSha, treeSha: gitSha }).strict(),
  recipeDigest: digest, lockfileRefs: z.array(SourceRefSchema).max(128), toolchainManifestDigest: digest,
  outputs: z.array(E2EAppArtifactOutputSchema).min(1).max(32), createdAt: utcTimestamp, manifestDigest: digest,
}).strict().superRefine((manifest, context) => {
  if (!uniqueSourceRefs(manifest.lockfileRefs)) context.addIssue({ code: "custom", path: ["lockfileRefs"], message: "lockfile paths must be unique" });
  if (new Set(manifest.outputs.map((output) => output.artifactId)).size !== manifest.outputs.length) context.addIssue({ code: "custom", path: ["outputs"], message: "build output artifact IDs must be unique" });
  try {
    if (e2eAppBuildManifestDigest(manifest) !== manifest.manifestDigest) context.addIssue({ code: "custom", path: ["manifestDigest"], message: "build manifest digest does not match canonical content" });
  } catch { context.addIssue({ code: "custom", path: ["manifestDigest"], message: "build manifest digest cannot be computed from canonical content" }); }
});
export type E2EAppBuildManifest = z.infer<typeof E2EAppBuildManifestSchema>;

export const E2EApplicationApprovalBindingSchema = z.object({
  schemaVersion: z.literal("e2e-application-approval/v1"),
  semanticApproval: PlanApprovalRefSchema, planDigest: digest, setupApproval: PlanApprovalRefSchema,
  proposalSource: z.object({ candidateDigest: digest, commitSha: gitSha, treeSha: gitSha }).strict(),
  applications: z.array(z.object({ applicationId: boundedId(120), sourceRefs: z.array(SourceRefSchema).min(1).max(128), recipe: E2EAppRecipeSchema }).strict()).min(1).max(12),
  runtimeRefs: z.array(E2EApplicationRuntimeRefSchema).min(1).max(12),
  accountRefs: z.array(E2ERuntimeAccountRefSchema).max(32), bindingDigest: digest,
}).strict().superRefine((binding, context) => {
  if (new Set(binding.applications.map((item) => item.applicationId)).size !== binding.applications.length) context.addIssue({ code: "custom", path: ["applications"], message: "approved application identities must be unique" });
  for (const [index, application] of binding.applications.entries()) {
    if (!uniqueSourceRefs(application.sourceRefs)) context.addIssue({ code: "custom", path: ["applications", index, "sourceRefs"], message: "approved application source paths must be unique" });
  }
  const runtimeKeys = binding.runtimeRefs.map((ref) => ref.targetId);
  if (new Set(runtimeKeys).size !== runtimeKeys.length) context.addIssue({ code: "custom", path: ["runtimeRefs"], message: "approved runtime references must have unique targets" });
  const accountKeys = binding.accountRefs.map((ref) => `${ref.applicationId}\0${ref.profileId}`);
  if (new Set(accountKeys).size !== accountKeys.length) context.addIssue({ code: "custom", path: ["accountRefs"], message: "approved account references must be unique by application and profile" });
  for (const ref of binding.runtimeRefs) {
    const application = binding.applications.find((item) => item.applicationId === ref.applicationId);
    if (!application) context.addIssue({ code: "custom", path: ["runtimeRefs"], message: "runtime reference belongs to an unapproved application" });
    else {
      try {
        if (application.recipe.recipeDigest !== ref.recipeDigest || !uniqueSourceRefs(ref.sourceRefs)
          || canonicalJson([...application.sourceRefs].sort((a, b) => a.path.localeCompare(b.path)))
            !== canonicalJson([...ref.sourceRefs].sort((a, b) => a.path.localeCompare(b.path)))) {
          context.addIssue({ code: "custom", path: ["runtimeRefs"], message: "runtime reference recipe or source identities differ from the approved application" });
        }
      } catch { context.addIssue({ code: "custom", path: ["runtimeRefs"], message: "runtime reference source identity cannot be compared" }); }
    }
    if (!binding.accountRefs.some((account) => account.applicationId === ref.applicationId && account.profileId === ref.accountProfileId)) context.addIssue({ code: "custom", path: ["accountRefs"], message: "runtime reference has no approved account identity" });
  }
  try {
    if (e2eApplicationApprovalBindingDigest(binding) !== binding.bindingDigest) context.addIssue({ code: "custom", path: ["bindingDigest"], message: "application approval binding digest does not match canonical content" });
  } catch { context.addIssue({ code: "custom", path: ["bindingDigest"], message: "application approval binding digest cannot be computed from canonical content" }); }
});
export type E2EApplicationApprovalBinding = z.infer<typeof E2EApplicationApprovalBindingSchema>;

export function e2eAppBuildManifestDigest(manifest: Omit<E2EAppBuildManifest, "manifestDigest"> | E2EAppBuildManifest): string {
  const body = Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== "manifestDigest"));
  return createHash("sha256").update(canonicalJson(body)).digest("hex");
}

export function e2eApplicationApprovalBindingDigest(binding: Omit<E2EApplicationApprovalBinding, "bindingDigest"> | E2EApplicationApprovalBinding): string {
  const body = Object.fromEntries(Object.entries(binding).filter(([key]) => key !== "bindingDigest"));
  return createHash("sha256").update(canonicalJson(body)).digest("hex");
}
