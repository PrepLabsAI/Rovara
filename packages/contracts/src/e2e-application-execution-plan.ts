import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json.js";
import { E2EApplicationApprovalBindingSchema, E2EApplicationPlanIntentSchema, E2ERuntimeAccountRefSchema, PlanApprovalRefSchema,
  type E2EApplicationApprovalBinding, type E2EApplicationPlanIntent, type PlanApprovalRef, type E2ERuntimeAccountRef } from "./e2e-application.js";
import { e2eApplicationMetadataSourcePaths, e2eApplicationMetadataSourceRefs } from "./e2e-application-metadata.js";
import { selectE2EExecutionPlan, type E2EPlanSelectionInput } from "./e2e-execution-plan.js";
import { E2EExecutionPlanSchema, E2EPolicySchema, E2ERuntimeAvailabilitySchema, E2EScenarioBundleSchema, E2ESetupProposalSchema,
  E2EApiMockFixtureSchema, e2eExecutionPlanDigest, e2eScenarioBundleDigest, validateE2EScenarioBundleForPolicy,
  type E2EExpectedCase, type E2EExecutionPlan, type E2EMockSpec, type E2EScenario, type E2EScenarioBundle, type E2ESetupProposal } from "./e2e.js";
import { e2eApplicationUpstreamTestIdFromIdentity, e2eCaseIdFromIdentity } from "./e2e-case-identity.js";
import { inspectE2ERepository } from "./e2e-catalog.js";
import { verifyE2ESourceSnapshot } from "./e2e-source.js";
import { E2EPortableApprovalBindingSchema, type E2EPortableApprovalBinding } from "./e2e-portable.js";
import { E2ERegisteredRuntimeSchema, type E2ERegisteredRuntime } from "./e2e-runtime-registration.js";
import { resolveE2ERuntimeReadiness } from "./e2e-runtime-capabilities.js";
import { createE2EOpenApiFixtureDescriptor, validateE2EOpenApiFixtureResponse } from "./e2e-openapi-fixture.js";

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const stableId = (prefix: string, value: unknown) => prefix + sha256(canonicalJson(value));
export { APPLICATION_E2E_TEST_PATH, e2eApplicationUpstreamTestIdFromIdentity } from "./e2e-case-identity.js";

export type E2EApplicationPlanSelectionInput = Omit<E2EPlanSelectionInput, "approvedSemanticApproval"> & {
  intent: E2EApplicationPlanIntent;
  intentDigest: string;
  setupProposal: E2ESetupProposal;
  setupApproval: PlanApprovalRef;
  approvedSemanticApproval: PlanApprovalRef;
  applicationApprovalBinding: E2EApplicationApprovalBinding | null;
  portableApprovalBinding?: E2EPortableApprovalBinding;
  registeredRuntimes: E2ERegisteredRuntime[];
  runtimeAccountRefs: E2ERuntimeAccountRef[];
  now: number;
};

export type E2EApplicationPortableProjection = {
  scope: { candidateDigest: string; planDigest: string; intentDigest: string; approvedSemanticApproval: PlanApprovalRef };
  selectionInput: E2EPlanSelectionInput;
  executionPlan: E2EExecutionPlan;
  bundle: E2EScenarioBundle;
};

function same(left: unknown, right: unknown): boolean { return canonicalJson(left) === canonicalJson(right); }
function operationStep(scenario: E2EScenario): { operationId: string; kind: "invoke-contract" | "inspect-contract" } | undefined {
  const step = scenario.steps[0];
  if ((step?.kind === "invoke-contract" || step?.kind === "inspect-contract") && scenario.steps.length === 1) return step;
  return undefined;
}
function deriveApprovedApplicationMocks(input: E2EApplicationPlanSelectionInput,
  discovered: ReturnType<typeof inspectE2ERepository>): NonNullable<E2EPlanSelectionInput["mockableComponents"]> {
  return (input.intent.mockFixtureRefs ?? []).map((reference) => {
    const target = discovered.inspection.proposedTargets.find((candidate) => candidate.targetId === reference.requestedTargetId);
    const edge = target === undefined ? undefined : discovered.inspection.dependencyEdges.find((candidate) => candidate.fromApplicationId === target.applicationId
      && candidate.toComponentId === reference.componentId && candidate.sourcePaths.some((path) => /(^|\/)(?:openapi|swagger)\.json$/i.test(path)));
    const schemaPath = edge?.sourcePaths.find((path) => /(^|\/)(?:openapi|swagger)\.json$/i.test(path));
    const schemaSource = schemaPath === undefined ? undefined : input.sourceSnapshot.sources.find((source) => source.path === schemaPath && source.kind === "blob");
    const fixtureSource = input.sourceSnapshot.sources.find((source) => source.path === reference.sourcePath && source.sha256 === reference.sourceSha256 && source.kind === "blob");
    if (!target || !edge || !schemaSource || !fixtureSource) throw new Error("approved application mock does not match a protected API schema edge and fixture source");
    let raw: unknown;
    try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fixtureSource.bytes)) as unknown; }
    catch { throw new Error("approved source-backed API fixture is not valid UTF-8 JSON"); }
    const fixture = E2EApiMockFixtureSchema.parse(raw);
    if (fixture.operationId !== reference.operationId) throw new Error("approved application API fixture operation differs from its canonical source reference");
    return { componentId: reference.componentId, requestedTargetId: reference.requestedTargetId, kind: "api" as const,
      sourceRefs: [{ path: schemaSource.path, sha256: schemaSource.sha256 }], fixture };
  });
}
function portablePairs(input: E2EApplicationPlanSelectionInput): Set<string> {
  const binding = input.portableApprovalBinding ? E2EPortableApprovalBindingSchema.parse(input.portableApprovalBinding) : undefined;
  const pairs = new Set<string>();
  if (!binding) return pairs;
  for (const scenario of input.intent.scenarios) {
    const operation = operationStep(scenario);
    if (!operation) continue;
    const approvedRef = input.intent.portableOperationRefs?.find((item) => item.operationId === operation.operationId);
    const registration = binding.operations.filter((item) => item.operationId === operation.operationId
      && item.purpose === (operation.kind === "invoke-contract" ? "feature-invocation" : "source-interface"));
    if (registration.length !== 1) continue;
    for (const targetId of scenario.requestedTargetIds) if (approvedRef?.requestedTargetIds.includes(targetId)) pairs.add(`${scenario.scenarioId}\0${targetId}`);
  }
  return pairs;
}

function validateFullInput(input: E2EApplicationPlanSelectionInput): {
  intent: E2EApplicationPlanIntent; policy: ReturnType<typeof E2EPolicySchema.parse>; setupProposal: E2ESetupProposal;
  discovered: ReturnType<typeof inspectE2ERepository>;
} {
  const intent = E2EApplicationPlanIntentSchema.parse(input.intent);
  const policy = E2EPolicySchema.parse(input.policy);
  const setupProposal = E2ESetupProposalSchema.parse(input.setupProposal);
  input.runtimeAvailability.forEach((record) => E2ERuntimeAvailabilitySchema.parse(record));
  if (new Set(input.runtimeAvailability.map((record) => `${record.targetId}\0${record.profileId}`)).size !== input.runtimeAvailability.length) {
    throw new Error("runtime availability contains duplicate target/profile projections");
  }
  input.registeredRuntimes.forEach((record) => E2ERegisteredRuntimeSchema.parse(record));
  input.runtimeAccountRefs.forEach((record) => E2ERuntimeAccountRefSchema.parse(record));
  PlanApprovalRefSchema.parse(input.setupApproval);
  PlanApprovalRefSchema.parse(input.approvedSemanticApproval);
  if (!Number.isSafeInteger(input.now) || input.now <= 0) throw new Error("application selection requires a frozen epoch-millisecond clock");
  if (!/^[a-f0-9]{64}$/.test(input.intentDigest) || sha256(canonicalJson(intent)) !== input.intentDigest) throw new Error("application intent digest does not bind the complete canonical intent");
  if (!/^[a-f0-9]{64}$/.test(input.planDigest) || !/^[a-f0-9]{64}$/.test(input.candidateDigest)
    || input.expectedCandidate.digest !== input.candidateDigest || input.sourceSnapshot.candidate.digest !== input.candidateDigest) throw new Error("application candidate or full plan identity is invalid");
  verifyE2ESourceSnapshot(input.sourceSnapshot, input.expectedCandidate);
  if (!same(intent.scenarios, input.scenarios)) throw new Error("application selection scenarios differ from the complete approved intent");
  const fullBundleBody = { schemaVersion: 1 as const, planDigest: input.planDigest, templateVersion: "trusted-e2e-application/v1",
    scenarios: intent.scenarios, bundleDigest: "0".repeat(64) };
  const fullBundle = E2EScenarioBundleSchema.parse({ ...fullBundleBody, bundleDigest: e2eScenarioBundleDigest(fullBundleBody) });
  validateE2EScenarioBundleForPolicy(fullBundle, policy);
  if (intent.scenarios.some((scenario) => scenario.steps.some((step) => step.kind === "invoke-contract" || step.kind === "inspect-contract")
    && !operationStep(scenario))) throw new Error("portable operation scenarios cannot mix portable and application steps");
  if (!same([...intent.requestedTargetIds].sort(), [...input.selectedTargetIds].sort())) throw new Error("application selection targets must equal the complete approved target inventory");
  if (sha256(canonicalJson(setupProposal)) !== input.setupApproval.digest) throw new Error("setup approval does not bind the canonical proposal");
  if (setupProposal.state !== "proposed") throw new Error("approved setup proposal still has unresolved blocking inputs");
  if (!same(intent.runtimeAccountRefs, input.runtimeAccountRefs)) throw new Error("runtime account revisions differ from the complete approved intent");
  const discovered = inspectE2ERepository(input.sourceSnapshot, input.expectedCandidate);
  const derivedMocks = deriveApprovedApplicationMocks({ ...input, intent }, discovered);
  const suppliedMocks = input.mockableComponents ?? [];
  const sortedCanonical = (items: readonly unknown[]) => [...items].sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  if (!same(sortedCanonical(derivedMocks), sortedCanonical(suppliedMocks))) {
    throw new Error("application source-backed mock selections do not exactly match the full approved intent and protected source");
  }
  const sourceTargets = new Map(discovered.inspection.proposedTargets.map((target) => [target.targetId, target]));
  const setupTargets = new Map(setupProposal.targets.map((target) => [target.targetId, target]));
  const setupApplications = new Map(setupProposal.applications.map((application) => [application.applicationId, application]));
  const scenarioIds = new Set(intent.scenarios.map((scenario) => scenario.scenarioId));
  if (policy.baselineScenarioIds.some((id) => !scenarioIds.has(id))) throw new Error("complete approved baseline inventory is missing from application intent");
  if (intent.requestedTargetIds.some((id) => !sourceTargets.has(id) || !policy.targets.some((target) => target.targetId === id && same(target, sourceTargets.get(id))))) {
    throw new Error("application policy or intent contains a target that differs from protected source identity");
  }
  for (const targetId of intent.requestedTargetIds) if (!same(sourceTargets.get(targetId), setupTargets.get(targetId))) {
    throw new Error(`setup-approved target ${targetId} differs from current protected source identity`);
  }
  const metadataRefs = (applicationId: string) => {
    const application = discovered.inspection.applications.find((item) => item.applicationId === applicationId);
    if (!application) throw new Error(`application ${applicationId} is not present in protected source`);
    return e2eApplicationMetadataSourceRefs(input.sourceSnapshot, applicationId, application.sourcePaths);
  };
  const setupMetadataRefs = (applicationId: string) => {
    const application = setupApplications.get(applicationId);
    if (!application) throw new Error(`application ${applicationId} is absent from approved setup lineage`);
    const paths = e2eApplicationMetadataSourcePaths(application.sourcePaths, setupProposal.sources.map((ref) => ref.path), applicationId);
    return paths.map((path) => {
      const source = setupProposal.sources.find((item) => item.path === path);
      if (!source) throw new Error(`approved setup metadata source is missing: ${path}`);
      return { path: source.path, sha256: source.sha256 };
    });
  };
  const selectedApplicationIds = [...new Set(intent.requestedTargetIds.map((id) => sourceTargets.get(id)!.applicationId))];
  for (const applicationId of selectedApplicationIds) {
    const current = discovered.inspection.applications.find((application) => application.applicationId === applicationId);
    const setup = setupApplications.get(applicationId);
    if (!current || !setup || current.kind !== setup.kind) throw new Error(`application ${applicationId} differs from approved setup identity`);
    const currentRefs = metadataRefs(applicationId);
    const setupRefs = setupMetadataRefs(applicationId);
    if (!same(currentRefs, setupRefs)) throw new Error(`application ${applicationId} identity or lockfile metadata changed since setup approval`);
    if (current.recipe !== null && setup.recipe !== null && !same(current.recipe, setup.recipe)) throw new Error(`application ${applicationId} recipe changed since setup approval`);
  }
  const runtimeByTarget = new Map(intent.applicationRuntimeRefs.map((ref) => [ref.targetId, ref]));
  const unavailableByTarget = new Map((intent.unavailableTargetRefs ?? []).map((ref) => [ref.targetId, ref]));
  for (const [targetId, ref] of [...runtimeByTarget, ...unavailableByTarget]) {
    const target = sourceTargets.get(targetId);
    if (!target || target.applicationId !== ref.applicationId || target.accountProfileId !== ref.accountProfileId
      || !same(metadataRefs(ref.applicationId), ref.sourceRefs)) throw new Error(`application target ${targetId} source or account identity differs from its canonical metadata reference`);
  }
  return { intent, policy, setupProposal, discovered };
}

/** One canonical v1 compiler projection. It is intentionally a projection, never full acceptance. */
export function projectE2EApplicationPortableSelection(input: E2EApplicationPlanSelectionInput): E2EApplicationPortableProjection | null {
  const { intent, policy } = validateFullInput(input);
  const pairs = portablePairs(input);
  if (pairs.size === 0 || !input.portableApprovalBinding) return null;
  const scenarios = intent.scenarios.flatMap((scenario) => {
    const requestedTargetIds = scenario.requestedTargetIds.filter((targetId) => pairs.has(`${scenario.scenarioId}\0${targetId}`));
    if (requestedTargetIds.length === 0) return [];
    if (!operationStep(scenario)) throw new Error("portable approval cannot absorb a mixed portable and application scenario");
    return [{ ...scenario, requestedTargetIds }];
  });
  const targetIds = [...new Set(scenarios.flatMap((scenario) => scenario.requestedTargetIds))].sort();
  const projectedPolicy = E2EPolicySchema.parse({ ...policy, modelRouteRevision: null,
    baselineScenarioIds: policy.baselineScenarioIds.filter((id) => scenarios.some((scenario) => scenario.scenarioId === id)),
    targets: policy.targets.filter((target) => targetIds.includes(target.targetId)) });
  const selectionInput: E2EPlanSelectionInput = {
    candidateDigest: input.candidateDigest, expectedCandidate: input.expectedCandidate, sourceSnapshot: input.sourceSnapshot,
    planDigest: input.planDigest, policy: projectedPolicy, scenarios, selectedTargetIds: targetIds,
    sandboxAvailability: input.sandboxAvailability, runtimeAvailability: input.runtimeAvailability,
    portableApprovalBinding: input.portableApprovalBinding, approvedSemanticApproval: input.approvedSemanticApproval,
    mockableComponents: (input.mockableComponents ?? []).filter((item) => targetIds.includes(item.requestedTargetId)),
  };
  const executionPlan = selectE2EExecutionPlan(selectionInput);
  const bundleBody = { schemaVersion: 1 as const, planDigest: input.planDigest, templateVersion: "trusted-e2e/v1", scenarios, bundleDigest: "0".repeat(64) };
  const bundle = E2EScenarioBundleSchema.parse({ ...bundleBody, bundleDigest: e2eScenarioBundleDigest(bundleBody) });
  return { scope: { candidateDigest: input.candidateDigest, planDigest: input.planDigest, intentDigest: input.intentDigest,
    approvedSemanticApproval: input.approvedSemanticApproval }, selectionInput, executionPlan, bundle };
}

/** Composes a complete criterion inventory with the unchanged portable v1 plan. */
export function selectE2EApplicationExecutionPlan(input: E2EApplicationPlanSelectionInput): E2EExecutionPlan {
  const { intent, policy, discovered } = validateFullInput(input);
  const approvedMocks = input.mockableComponents ?? [];
  const semantic = input.approvedSemanticApproval;
  const realRefs = intent.applicationRuntimeRefs;
  const realTargets = new Set(realRefs.map((ref) => ref.targetId));
  const nonportablePairs = intent.scenarios.flatMap((scenario) => scenario.requestedTargetIds
    .filter((targetId) => !portablePairs(input).has(`${scenario.scenarioId}\0${targetId}`))
    .map((targetId) => ({ scenario, targetId })));
  if (nonportablePairs.some(({ targetId }) => !realTargets.has(targetId) && !intent.unavailableTargetRefs?.some((ref) => ref.targetId === targetId))) {
    throw new Error("every nonportable application criterion requires an executable assignment or explicit unavailable source reference");
  }
  if (realRefs.length > 0) {
    const binding = input.applicationApprovalBinding && E2EApplicationApprovalBindingSchema.parse(input.applicationApprovalBinding);
    if (!binding || binding.planDigest !== input.planDigest || !same(binding.semanticApproval, semantic)
      || !same(binding.setupApproval, input.setupApproval) || !same(binding.runtimeRefs, realRefs)
      || !same(binding.accountRefs, input.runtimeAccountRefs)
      || !same(binding.proposalSource, { candidateDigest: input.candidateDigest, commitSha: input.sourceSnapshot.commitSha, treeSha: input.sourceSnapshot.treeSha })
      || !same(binding.applications.map((application) => ({ applicationId: application.applicationId, sourceRefs: application.sourceRefs, recipe: application.recipe })),
        [...new Set(realRefs.map((ref) => ref.applicationId))].sort().map((applicationId) => ({ applicationId,
          sourceRefs: e2eApplicationMetadataSourceRefs(input.sourceSnapshot, applicationId,
            validateFullInput(input).discovered.inspection.applications.find((item) => item.applicationId === applicationId)!.sourcePaths),
          recipe: validateFullInput(input).discovered.inspection.applications.find((item) => item.applicationId === applicationId)!.recipe })))) {
      throw new Error("application approval binding must exactly match the real executable subset and independent approval");
    }
  } else if (input.applicationApprovalBinding !== null) throw new Error("application approval binding must be null when no real assignments exist");
  if (input.portableApprovalBinding && (input.portableApprovalBinding.planDigest !== input.planDigest
    || !same(input.portableApprovalBinding.semanticApproval, semantic))) throw new Error("portable approval binding must use the full plan and semantic approval");
  const projection = projectE2EApplicationPortableSelection(input);
  const criteria: E2EExecutionPlan["criteria"] = [];
  const unavailable: E2EExecutionPlan["unavailableCriteria"] = [];
  const groups: E2EExecutionPlan["groups"] = [];
  const effectiveTargets: E2EExecutionPlan["effectiveTargets"] = [];
  const mocks: E2EExecutionPlan["mocks"] = [];
  if (projection) {
    criteria.push(...projection.executionPlan.criteria);
    unavailable.push(...projection.executionPlan.unavailableCriteria);
    groups.push(...projection.executionPlan.groups);
    effectiveTargets.push(...projection.executionPlan.effectiveTargets);
    mocks.push(...projection.executionPlan.mocks);
  }
  const realCasesByTarget = new Map<string, E2EExpectedCase[]>();
  const realTargetProfiles = new Map<string, { target: (typeof policy.targets)[number]; ref: (typeof realRefs)[number]; groupKey: string }>();
  const portable = portablePairs(input);
  const baseline = new Set(policy.baselineScenarioIds);
  for (const scenario of intent.scenarios) for (const targetId of scenario.requestedTargetIds) {
    if (portable.has(`${scenario.scenarioId}\0${targetId}`)) continue;
    const required = scenario.required || baseline.has(scenario.scenarioId);
    if (!required && !input.selectedTargetIds.includes(targetId)) continue;
    const criterionId = stableId("criterion-", [scenario.requirementId, scenario.scenarioId, targetId]);
    if (criteria.some((item) => item.criterionId === criterionId)) throw new Error("application and portable criterion identities collided");
    const criterion = { criterionId, requirementId: scenario.requirementId, scenarioId: scenario.scenarioId, requestedTargetId: targetId,
      required, minimumEvidence: scenario.minimumEvidence, requiredRealComponentIds: [...scenario.requiredRealComponentIds], expectedCaseIds: [] as string[] };
    criteria.push(criterion);
    const availability = input.runtimeAvailability.filter((item) => item.targetId === targetId);
    const ref = realRefs.find((item) => item.targetId === targetId);
    const account = input.runtimeAccountRefs.find((item) => item.applicationId === ref?.applicationId && item.profileId === ref?.accountProfileId);
    const runtime = input.registeredRuntimes.find((item) => item.profileId === ref?.runtimeProfileId);
    const sourceApplication = input.applicationApprovalBinding?.applications.find((item) => item.applicationId === ref?.applicationId);
    const access = availability.find((item) => item.profileId === ref?.runtimeProfileId);
    const readiness = ref && runtime && access
      ? resolveE2ERuntimeReadiness({ target: { ...policy.targets.find((item) => item.targetId === targetId)!, runtimeProfileId: ref.runtimeProfileId },
        requiredSteps: scenario.steps.map((step) => step.kind), requiredAssertions: scenario.assertions.map((assertion) => assertion.kind),
        minimumEvidence: scenario.minimumEvidence, installationEnabled: false, activationEnabled: true,
        connection: access.connection, approval: access.approval, qualification: access.qualification, state: runtime.state,
        expiresAt: runtime.expiresAt, now: input.now, capabilities: runtime.capabilities })
      : null;
    const ready = ref !== undefined && account !== undefined && runtime !== undefined && sourceApplication !== undefined
      && access !== undefined && readiness?.status === "READY" && Date.parse(runtime.qualifiedAt) <= input.now;
    if (!ready || !ref || !account || !runtime || !sourceApplication) {
      const reason = !ref ? "application runtime assignment is explicitly unavailable"
        : !account ? "current application account revision is unavailable"
          : !runtime || !sourceApplication ? "approved application runtime profile is currently unavailable"
            : readiness === null ? "application runtime access projection is currently unavailable"
              : readiness.status !== "READY" ? `application runtime is not ready: ${readiness.status.toLowerCase()}/${readiness.reasonCode}`
                : "application runtime qualification begins after the frozen selection clock";
      unavailable.push({ criterionId, reason });
      continue;
    }
    const target = policy.targets.find((item) => item.targetId === targetId)!;
    const accountContextId = stableId("app-account-", [ref.applicationId, ref.accountProfileId, account.revision, account.definitionDigest]).slice(0, 120);
    const accountContextDigest = sha256(canonicalJson({ schemaVersion: "application-account-context/v1", applicationId: ref.applicationId,
      profileId: ref.accountProfileId, revision: account.revision, definitionDigest: account.definitionDigest, approval: semantic }));
    const assertionDigests = scenario.assertions.map((assertion) => sha256(canonicalJson([assertion])));
    const executionDescriptorDigest = sha256(canonicalJson({ schemaVersion: "application-execution-descriptor/v1", candidateDigest: input.candidateDigest,
      planDigest: input.planDigest, intentDigest: input.intentDigest, applicationApprovalBindingDigest: input.applicationApprovalBinding!.bindingDigest,
      application: sourceApplication, runtimeRef: ref, accountRef: account, runtimeCapabilityDigest: runtime.capabilityDigest,
      runtimeManifestDigest: runtime.manifestDigest,
      runtimeIdentity: { runtimeCatalogId: runtime.runtimeCatalogId, catalogRevision: runtime.catalogRevision, generation: runtime.generation,
        bindingDigest: runtime.bindingDigest, qualifiedAt: runtime.qualifiedAt, expiresAt: runtime.expiresAt },
      accessProjection: access, target, scenario: { scenarioId: scenario.scenarioId, steps: scenario.steps,
        assertions: scenario.assertions, minimumEvidence: scenario.minimumEvidence, requiredRealComponentIds: scenario.requiredRealComponentIds },
      modelRouteRevision: policy.modelRouteRevision, limits: policy.limits }));
    const identity = { scenarioId: scenario.scenarioId, targetId, requestedTargetId: targetId, accountProfileId: ref.accountProfileId,
      accountContextId, accountContextDigest, executionDescriptorDigest, minimumEvidence: scenario.minimumEvidence,
      requiredRealComponentIds: [...scenario.requiredRealComponentIds], agentId: "default", repeat: 0 as const, assertionDigests };
    const caseId = e2eCaseIdFromIdentity(identity);
    const expected: E2EExpectedCase = { caseId, criterionId, scenarioId: scenario.scenarioId,
      upstreamTestId: e2eApplicationUpstreamTestIdFromIdentity(identity), targetId, requestedTargetId: targetId,
      agentId: "default", repeat: 0, executionDescriptorDigest, accountContextId, accountContextDigest,
      accountProfileId: ref.accountProfileId, assertionDigest: sha256(canonicalJson(assertionDigests)), assertionDigests,
      required, minimumEvidence: scenario.minimumEvidence, requiredRealComponentIds: [...scenario.requiredRealComponentIds] };
    criterion.expectedCaseIds.push(caseId);
    const cases = realCasesByTarget.get(targetId) ?? [];
    cases.push(expected);
    realCasesByTarget.set(targetId, cases);
    const compatibilityKey = `${ref.runtimeProfileId}\0${target.kind}\0${"browser" in target ? target.browser : ""}`
      + `\0${"protocol" in target ? target.protocol : ""}\0${"os" in target ? target.os : ""}\0${"driver" in target ? target.driver : ""}`;
    realTargetProfiles.set(targetId, { target: { ...target, runtimeProfileId: ref.runtimeProfileId }, ref, groupKey: compatibilityKey });
  }
  const compatibleTargets = new Map<string, string[]>();
  for (const [targetId, profile] of realTargetProfiles) {
    const ids = compatibleTargets.get(profile.groupKey) ?? [];
    ids.push(targetId);
    compatibleTargets.set(profile.groupKey, ids);
  }
  for (const [groupKey, targetIdsForGroup] of compatibleTargets) {
    targetIdsForGroup.sort();
    for (let offset = 0; offset < targetIdsForGroup.length; offset += 3) {
      if (groups.length >= 4) throw new Error("application execution groups exceed the approved four-group limit");
      const selected = targetIdsForGroup.slice(offset, offset + 3);
      const groupCases = selected.flatMap((targetId) => realCasesByTarget.get(targetId) ?? []);
      if (groupCases.length === 0) continue;
      if (groupCases.length > 64) throw new Error("application execution group exceeds the 64-case limit");
      const profile = realTargetProfiles.get(selected[0]!)!;
      const groupId = stableId("group-", ["real-application", groupKey, selected]);
      const requiredRealIds = new Set(groupCases.flatMap((item) => item.requiredRealComponentIds));
      const groupMocks: E2EMockSpec[] = selected.flatMap((targetId) => approvedMocks
        .filter((item) => item.requestedTargetId === targetId && !requiredRealIds.has(item.componentId))
        .map((item) => {
          const target = policy.targets.find((candidate) => candidate.targetId === targetId)!;
          const edge = discovered.inspection.dependencyEdges.find((candidate) => candidate.fromApplicationId === target.applicationId
            && candidate.toComponentId === item.componentId && candidate.sourcePaths.includes(item.sourceRefs[0]!.path));
          const schemaSource = input.sourceSnapshot.sources.find((source) => source.path === item.sourceRefs[0]!.path && source.sha256 === item.sourceRefs[0]!.sha256);
          const descriptor = schemaSource && createE2EOpenApiFixtureDescriptor(schemaSource.bytes);
          const fixture = E2EApiMockFixtureSchema.safeParse(item.fixture);
          const operation = fixture.success ? descriptor?.operations.find((candidate) => candidate.operationId === fixture.data.operationId
            && candidate.method === fixture.data.method && candidate.path === fixture.data.path) : undefined;
          const success = fixture.success ? fixture.data.variants.find((variant) => variant.id === "success") : undefined;
          const refusal = fixture.success ? fixture.data.variants.find((variant) => variant.id === "refusal") : undefined;
          const invalid = fixture.success ? fixture.data.variants.find((variant) => variant.id === "invalid-data") : undefined;
          const validated = edge !== undefined && descriptor !== undefined && fixture.success && operation !== undefined && success !== undefined && refusal !== undefined && invalid !== undefined
            && success.status >= 200 && success.status < 300
            && validateE2EOpenApiFixtureResponse({ descriptor, method: fixture.data.method, path: fixture.data.path, status: success.status, body: success.body })
            && refusal.status >= 400 && refusal.status < 500
            && validateE2EOpenApiFixtureResponse({ descriptor, method: fixture.data.method, path: fixture.data.path, status: refusal.status, body: refusal.body })
            && invalid.status >= 200 && invalid.status < 300
            && !validateE2EOpenApiFixtureResponse({ descriptor, method: fixture.data.method, path: fixture.data.path, status: invalid.status, body: invalid.body });
          if (!validated || !descriptor || !edge || !fixture.success) throw new Error("approved application API fixture does not validate against its protected OpenAPI contract");
          return { componentId: item.componentId, requestedTargetId: targetId, effectiveTargetId: targetId, kind: "api" as const,
            contractDigest: sha256(canonicalJson({ descriptor, sourceRefs: item.sourceRefs, contractRef: edge.contractRef,
              fixtureProfile: null, explicitFixture: fixture.data })), fixtureVersion: descriptor.version, sourceRefs: item.sourceRefs,
            reason: "phase-unavailable" as const, apiFixture: fixture.data };
        }));
      mocks.push(...groupMocks);
      effectiveTargets.push(...selected.map((targetId) => realTargetProfiles.get(targetId)!.target));
      groups.push({ groupId, targetIds: selected, runtimeProfileId: profile.ref.runtimeProfileId, mode: groupMocks.length > 0 ? "hybrid" : "real-runtime",
        mockManifestDigest: sha256(canonicalJson(groupMocks)), expectedCases: groupCases });
    }
  }
  if (criteria.length === 0) throw new Error("complete application selection produced no approved criteria");
  if (criteria.length > 64 || groups.length > 4 || effectiveTargets.length > 12) throw new Error("application execution plan exceeds the complete bounded inventory");
  const body = { schemaVersion: 1 as const, digest: "0".repeat(64), candidateDigest: input.candidateDigest, planDigest: input.planDigest,
    criteria, effectiveTargets, groups, mocks, unavailableCriteria: [...new Map(unavailable.map((item) => [item.criterionId, item])).values()] };
  return E2EExecutionPlanSchema.parse({ ...body, digest: e2eExecutionPlanDigest(body) });
}
