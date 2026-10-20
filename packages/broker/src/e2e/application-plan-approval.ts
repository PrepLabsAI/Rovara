import { createHash } from "node:crypto";
import {
  E2EApplicationPlanIntentSchema, E2EApplicationSelectionRecordSchema, E2EPolicySchema, Ec2RuntimeBindingSchema, canonicalJson,
  deriveE2ESyntheticRuntimeAccountRef, e2eRuntimeKindMatchesTarget, inspectE2ERepository, isE2EQualifiedRuntimeProfileId, readE2EApplicationProjectContract,
  type E2EApplicationPlanIntent, type E2EApplicationSelectionRecord, type E2ERegisteredRuntime, type E2ERuntimeAvailability,
  type E2ESetupProposal, type E2ESourceSnapshot, type Ec2RuntimeBinding, type PlanApprovalRef,
} from "@agentx/contracts";
import { deriveE2EApplicationFeatureExecutionSelection } from "./application-feature-plan-intent.js";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const REASON_MAX_CHARS = 600;
/** What the Owner and the planner are told to do with portable criteria in a version 2 plan (Ruling BE). */
export const BE_REMEDY = "put portable checks in a schemaVersion 1 plan or drop them";
/** Why a version 2 plan may not run web and API targets together (Ruling BF). */
export const BF_REASON = "one runtime kind per plan in M1.2";
const BLOCKED_LISTED = 5;

/** A refusal reason a person can read: one line of at most REASON_MAX_CHARS, with no control characters (planner-written IDs reach it). */
function clean(text: string): string {
  const line = text.replace(/\p{Cc}+/gu, " ").replace(/\s+/gu, " ").trim();
  return line.length > REASON_MAX_CHARS ? `${line.slice(0, REASON_MAX_CHARS - 3)}...` : line;
}

export type ApplicationPlanApprovalInput = {
  /** The plan's v2 intent, exactly as the canonical artifact holds it. */
  intent: E2EApplicationPlanIntent;
  taskId: string;
  /** The canonical plan artifact being approved. */
  artifact: { id: string; sha256: string };
  /** The approved setup's verified source snapshot and its proposal, with the approval that binds them (never the prepared checkout). */
  snapshot: E2ESourceSnapshot;
  setupProposal: E2ESetupProposal;
  setupApproval: PlanApprovalRef;
  /** The task's pinned project policy. */
  policy: unknown;
  /** The runtime rows READY for the project's runtime binding, read at approval time (not cached from planning). */
  registeredRuntimes: E2ERegisteredRuntime[];
  runtimeCatalogId: string;
  runtimeBinding: Ec2RuntimeBinding;
  now: number;
};

export type ApplicationPlanApproval = { ok: true; selection: E2EApplicationSelectionRecord } | { ok: false; reason: string };

/**
 * Evaluates whether the Owner may approve a plan carrying an application intent, against the approved setup and the READY rows now.
 *
 * It refuses (never approves, never drops a scenario, never falls back to portable) when a target the plan lists as executable is not on its
 * approved qualified profile, has no READY row of its kind bound to the project's runtime binding, would run a step or assertion its
 * descriptor lacks, uses an agent step, has only an inferred launch recipe, or names an account other than the synthetic one derived from
 * its recipe. A target the plan itself lists as unavailable is approved: its criteria are recorded as waiting and end UNKNOWN, which blocks
 * publication. Anything that cannot be evaluated is a refusal too.
 */
export function evaluateApplicationPlanApproval(input: ApplicationPlanApprovalInput): ApplicationPlanApproval {
  const refuse = (reason: string): ApplicationPlanApproval => ({ ok: false, reason: clean(reason) });
  try {
    const parsed = E2EApplicationPlanIntentSchema.safeParse(input.intent);
    if (!parsed.success) return refuse(`the application intent is not valid: ${parsed.error.issues[0]?.message ?? "unreadable"}`);
    const fullIntent = parsed.data;
    const policy = E2EPolicySchema.parse(input.policy);
    // As operationStep does: a portable scenario is exactly one portable step. One that goes on to application steps is refused as a mix.
    const isPortable = (scenario: E2EApplicationPlanIntent["scenarios"][number]) => scenario.steps.length === 1
      && (scenario.steps[0]?.kind === "invoke-contract" || scenario.steps[0]?.kind === "inspect-contract");
    const mixed = fullIntent.scenarios.find((scenario) => !isPortable(scenario) && scenario.steps.some((step) => step.kind === "invoke-contract" || step.kind === "inspect-contract"));
    if (mixed !== undefined) return refuse(`scenario ${mixed.scenarioId} cannot mix portable and application steps`);
    const applicationScenarios = fullIntent.scenarios.filter((scenario) => !isPortable(scenario));
    if (applicationScenarios.length === 0) return refuse("the plan has no application scenario, so it is a portable plan: use schemaVersion 1");
    // Ruling BE: one CHECKS operation carries one admission, and an application admission runs no portable child group, so a version 2 plan carries no
    // portable criteria in M1.2 (mixed rounds wait for M1.3). Nothing is dropped silently: the plan is refused and the owner asks for the plan to be corrected.
    const portableScenarios = fullIntent.scenarios.filter((scenario) => isPortable(scenario));
    if (portableScenarios.length > 0) {
      return refuse(`scenario ${portableScenarios.map((scenario) => scenario.scenarioId).join(", ")} is a portable check, and a plan with application scenarios runs only application scenarios in M1.2: ${BE_REMEDY}`);
    }
    const scenarioIds = new Set(fullIntent.scenarios.map((scenario) => scenario.scenarioId));
    const omitted = policy.baselineScenarioIds.filter((id) => !scenarioIds.has(id));
    if (omitted.length > 0) return refuse(`the plan omits baseline scenarios pinned by the approved setup: ${omitted.join(", ")}`);
    const applicationTargetIds = new Set(applicationScenarios.flatMap((scenario) => scenario.requestedTargetIds));
    const applicationScenarioIds = new Set(applicationScenarios.map((scenario) => scenario.scenarioId));
    const intent = E2EApplicationPlanIntentSchema.parse({ ...fullIntent,
      requestedTargetIds: fullIntent.requestedTargetIds.filter((targetId) => applicationTargetIds.has(targetId)),
      portableOperationRefs: [], semanticExportDeltas: [], scenarios: applicationScenarios,
      mockFixtureRefs: (fullIntent.mockFixtureRefs ?? []).filter((ref) => applicationTargetIds.has(ref.requestedTargetId)) });
    const applicationPolicy = { ...policy, baselineScenarioIds: policy.baselineScenarioIds.filter((id) => applicationScenarioIds.has(id)) };
    const bindingDigest = sha256(canonicalJson(Ec2RuntimeBindingSchema.parse(input.runtimeBinding)));
    const discovered = inspectE2ERepository(input.snapshot, input.snapshot.candidate);
    // Ruling BF: an application round carries exactly one runtime kind (the verifier keys its runtime bindings by profile, so a web row and an api row of
    // one profile cannot be admitted together). Kind-aware rounds wait for M1.3.
    const executableKinds = [...new Set(intent.applicationRuntimeRefs.flatMap((ref) => {
      const target = policy.targets.find((item) => item.targetId === ref.targetId);
      return target === undefined ? [] : [target.kind];
    }))].sort();
    if (executableKinds.length > 1) return refuse(`the plan's executable targets span ${executableKinds.join(" and ")}: ${BF_REASON}`);
    const availability: E2ERuntimeAvailability[] = [];
    const usedRows: Array<{ kind: "web" | "api"; row: E2ERegisteredRuntime }> = [];
    for (const ref of intent.applicationRuntimeRefs) {
      const target = policy.targets.find((item) => item.targetId === ref.targetId);
      if (target === undefined) return refuse(`target ${ref.targetId} is not in the pinned project policy`);
      if (target.kind !== "web" && target.kind !== "api") return refuse(`target ${ref.targetId} is a ${target.kind} target; only web and API targets run application scenarios`);
      if (!isE2EQualifiedRuntimeProfileId(target.runtimeProfileId)) {
        return refuse(`target ${ref.targetId} is approved on runtime profile ${target.runtimeProfileId}, which cannot run application scenarios; list it in unavailableTargetRefs or ask an administrator to approve it on the qualified profile`);
      }
      if (ref.runtimeProfileId !== target.runtimeProfileId) return refuse(`the plan runs target ${ref.targetId} on runtime profile ${ref.runtimeProfileId}, not the runtime profile ${target.runtimeProfileId} it was approved on`);
      const application = discovered.inspection.applications.find((item) => item.applicationId === ref.applicationId);
      if (application?.recipe === undefined || application.recipe === null) return refuse(`application ${ref.applicationId} has no launch recipe in the approved source`);
      // The synthetic account authorizes nothing beyond what the approved project contract declares: its profile must be a declared synthetic test account.
      const contract = readE2EApplicationProjectContract(input.snapshot, ref.applicationId);
      if (contract !== null && contract.accountProfiles.find((profile) => profile.profileId === ref.accountProfileId)?.scope !== "synthetic-test") {
        return refuse(`account profile ${ref.accountProfileId} is not declared as a synthetic test account by the application's project contract`);
      }
      const account = intent.runtimeAccountRefs.find((item) => item.applicationId === ref.applicationId && item.profileId === ref.accountProfileId);
      const synthetic = deriveE2ESyntheticRuntimeAccountRef({ applicationId: ref.applicationId, accountProfileId: ref.accountProfileId, recipeDigest: application.recipe.recipeDigest });
      if (account === undefined || canonicalJson(account) !== canonicalJson(synthetic)) {
        return refuse(`the runtime account reference for application ${ref.applicationId} and account profile ${ref.accountProfileId} is not its synthetic account identity; copy runtimeAccountRefs from the planning context`);
      }
      const row = input.registeredRuntimes.find((item) => item.runtimeCatalogId === input.runtimeCatalogId && item.profileId === ref.runtimeProfileId
        && e2eRuntimeKindMatchesTarget({ ...target, runtimeProfileId: ref.runtimeProfileId }, item.capabilities));
      if (row === undefined) return refuse(`no ${target.kind} runtime of profile ${ref.runtimeProfileId} is READY for this project's runtime binding, so target ${ref.targetId} cannot run application scenarios now`);
      if (row.bindingDigest !== bindingDigest) return refuse(`the ${target.kind} runtime of profile ${ref.runtimeProfileId} is bound to another runtime binding than this project's`);
      if (row.state !== "READY" || Date.parse(row.qualifiedAt) > input.now || Date.parse(row.expiresAt) <= input.now) {
        return refuse(`the ${target.kind} runtime of profile ${ref.runtimeProfileId} is not READY now (state ${row.state}, expires ${row.expiresAt})`);
      }
      availability.push({ targetId: ref.targetId, profileId: ref.runtimeProfileId, connection: "connected", approval: "approved", qualification: "qualified",
        authorizationRevision: `feature-${row.runtimeCatalogId}-${row.catalogRevision}-${row.generation}`.slice(0, 120) });
      if (!usedRows.some((used) => used.row === row)) usedRows.push({ kind: target.kind, row });
    }
    // The approval-time identity of the plan: the canonical artifact. Dispatch derives its own plan digest and re-runs the whole selection.
    const planDigest = sha256(canonicalJson({ domain: "workflow-e2e-application-approval-plan/v1", taskId: input.taskId, artifactId: input.artifact.id, artifactSha256: input.artifact.sha256 }));
    const semanticApproval = { artifactId: input.artifact.id, digest: input.artifact.sha256 };
    const selection = deriveE2EApplicationFeatureExecutionSelection({ intent, snapshot: input.snapshot, artifactId: semanticApproval.artifactId,
      artifactSha256: semanticApproval.digest, planDigest, approvedSemanticApproval: semanticApproval, setupProposal: input.setupProposal,
      setupApproval: input.setupApproval, policy: applicationPolicy, registeredRuntimes: input.registeredRuntimes, runtimeAvailability: availability,
      runtimeAccountRefs: intent.runtimeAccountRefs, runtimeCatalogId: input.runtimeCatalogId, runtimeBinding: input.runtimeBinding, featureVerifier: null, now: input.now });
    // A criterion on a target the plan called executable that the selection could not make executable is a refusal; the rest wait as UNKNOWN.
    const executableTargetIds = [...new Set(intent.applicationRuntimeRefs.map((ref) => ref.targetId))].sort();
    const criteria = new Map(selection.plan.criteria.map((criterion) => [criterion.criterionId, criterion]));
    const blocked = selection.plan.unavailableCriteria.flatMap((item) => {
      const criterion = criteria.get(item.criterionId);
      return criterion !== undefined && executableTargetIds.includes(criterion.requestedTargetId)
        ? [`scenario ${criterion.scenarioId} on target ${criterion.requestedTargetId}: ${item.reason}`] : [];
    });
    if (blocked.length > 0) {
      const more = blocked.length > BLOCKED_LISTED ? `; and ${blocked.length - BLOCKED_LISTED} more` : "";
      return refuse(`the plan lists targets as executable whose scenarios cannot run now (${blocked.slice(0, BLOCKED_LISTED).join("; ")}${more})`);
    }
    return { ok: true, selection: E2EApplicationSelectionRecordSchema.parse({
      schemaVersion: "e2e-application-selection/v1", intentDigest: sha256(canonicalJson(fullIntent)), planDigest, semanticApproval, setupApproval: input.setupApproval,
      applicationApprovalBindingDigest: selection.applicationApprovalBinding?.bindingDigest ?? null, applicationExecutionPlanDigest: selection.plan.digest,
      applicationBundleDigest: selection.bundle.bundleDigest, executableTargetIds,
      unavailableCriteria: selection.plan.unavailableCriteria.map((item) => ({ criterionId: item.criterionId, reason: item.reason })),
      runtimeRows: usedRows.map(({ kind, row }) => ({ kind, profileId: row.profileId, runtimeCatalogId: row.runtimeCatalogId, catalogRevision: row.catalogRevision,
        generation: row.generation, bindingDigest: row.bindingDigest, capabilityDigest: row.capabilityDigest, expiresAt: row.expiresAt })),
      evaluatedAt: new Date(input.now).toISOString() }) };
  } catch (error) {
    return refuse(`the plan could not be derived against the approved setup and the ready runtimes: ${error instanceof Error ? error.message : "unreadable input"}`);
  }
}
