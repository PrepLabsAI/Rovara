import { createHash } from "node:crypto";
import {
  E2EExecutionPlanSchema, E2EPolicySchema, E2EScenarioSchema, e2eExecutionPlanDigest,
  type E2EExecutionPlan, type E2EPolicy, type E2ERuntimeAvailability, type E2EScenario,
  type E2EExpectedCase, type E2EMockSpec,
} from "./e2e.js";
import { canonicalJson } from "./canonical-json.js";
import { copyBoundedE2EJsonData } from "./e2e-safe-data.js";
import { verifyE2ESourceSnapshot, type E2ESourceSnapshot } from "./e2e-source.js";
import type { CandidateManifest } from "./task-workflow.js";
import { createE2EOpenApiFixtureDescriptor } from "./e2e-openapi-fixture.js";
import { E2EPortableApprovalBindingSchema, e2EDefaultSyntheticAccountDefinition, e2ePortableOperationDescriptorDigest, e2ePortableRegistrationKey, e2eSourceInterfaceAssertion, resolveE2EPortableRegistration, type E2EPortableApprovalBinding } from "./e2e-portable.js";
import { E2E_CANDIDATE_ADAPTER_IDENTITY } from "./e2e-portable.js";
import { e2eCaseIdFromIdentity, e2eUpstreamTestIdFromIdentity } from "./e2e-case-identity.js";
import { inspectE2EPortableSource, inspectE2ERepository, type PortableOperation } from "./e2e-catalog.js";

export const PORTABLE_E2E_TEST_PATH = ".agentx/e2e/generated-contract.test.ts";
type MockableComponent = { componentId: string; requestedTargetId: string; kind: "api"; sourceRefs: Array<{ path: string; sha256: string }> };
export type E2EPlanSelectionInput = {
  candidateDigest: string;
  expectedCandidate: CandidateManifest;
  sourceSnapshot: E2ESourceSnapshot;
  planDigest: string;
  policy: E2EPolicy;
  scenarios: E2EScenario[];
  selectedTargetIds: string[];
  sandboxAvailability: (E2ERuntimeAvailability & { targetId: "default-sandbox" }) | null;
  runtimeAvailability: E2ERuntimeAvailability[];
  /** Structural projection; native callers must load the matching approval lineage from trusted storage. */
  portableApprovalBinding?: E2EPortableApprovalBinding;
  /** Independently supplied approved semantic identity, checked against the binding. */
  approvedSemanticApproval?: { artifactId: string; digest: string };
  /** Legacy-shaped entries are ignored unless they match a source-derived API schema edge. */
  mockableComponents?: MockableComponent[];
};
const hex = (value: string) => createHash("sha256").update(value).digest("hex");
const stableId = (prefix: string, value: unknown) => prefix + hex(canonicalJson(value));
export function effectiveContractTargetId(requestedTargetId: string): string {
  return requestedTargetId.length <= 71 ? `contract-${requestedTargetId}` : `contract-${hex(requestedTargetId).slice(0, 64)}`;
}
/** Compiler-stable upstream test identity; generated titles contain only a tuple digest, never scenario text. */
export function portableE2EUpstreamTestId(identity: unknown): string {
  return `${PORTABLE_E2E_TEST_PATH}::case-${hex(canonicalJson(identity))}`;
}
export function portableE2ECaseId(identity: unknown): string { return stableId("case-", identity); }
const JSON_VALUE_SCHEMA_REF = "json-value-v1";
const portableAssertionDigest = (assertion: E2EScenario["assertions"][number]) => hex(canonicalJson([assertion]));
const supportedPortableAssertion = (assertion: E2EScenario["assertions"][number]) =>
  (assertion.kind === "state" && assertion.probeId === "result")
  || (assertion.kind === "json" && assertion.responseId === "result" && assertion.schemaRef === JSON_VALUE_SCHEMA_REF);
const registrationDescriptor = (registration: E2EPortableApprovalBinding["operations"][number]) => {
  const body = Object.fromEntries(Object.entries(registration).filter(([key]) => key !== "descriptorDigest"));
  return e2ePortableOperationDescriptorDigest(body);
};
const validPortableSemantics = (scenario: E2EScenario, operation: PortableOperation | undefined, registration: E2EPortableApprovalBinding["operations"][number] | undefined, targetKind: string) => {
  if ((targetKind !== "web" && targetKind !== "api") || !operation || !registration || scenario.steps.length !== 1) return false;
  const step = scenario.steps[0];
  if (step?.kind === "invoke-contract") return registration.purpose === "feature-invocation" && step.operationId === operation.operationId && scenario.assertions.length > 0 && scenario.assertions.every(supportedPortableAssertion);
  if (step?.kind === "inspect-contract") return registration.purpose === "source-interface" && step.operationId === operation.operationId
    && scenario.assertions.length === 1 && canonicalJson(scenario.assertions[0]) === canonicalJson(e2eSourceInterfaceAssertion(registration));
  return false;
};


export function selectE2EExecutionPlan(input: E2EPlanSelectionInput): E2EExecutionPlan {
  const policy = E2EPolicySchema.parse(input.policy);
  if (input.expectedCandidate.digest !== input.candidateDigest || input.sourceSnapshot.candidate.digest !== input.candidateDigest) throw new Error("planner candidate does not match the expected immutable source snapshot");
  verifyE2ESourceSnapshot(input.sourceSnapshot, input.expectedCandidate);
  if (!/^[a-f0-9]{64}$/.test(input.planDigest)) throw new Error("approved plan digest is required");
  if (input.scenarios.length === 0 || input.scenarios.length > 32) throw new Error("complete approved scenario inventory is required");
  const scenarios = input.scenarios.map((scenario) => E2EScenarioSchema.parse(scenario));
  if (new Set(scenarios.map((scenario) => scenario.scenarioId)).size !== scenarios.length) throw new Error("approved scenario IDs must be unique");
  const scenariosById = new Map(scenarios.map((scenario) => [scenario.scenarioId, scenario]));
  for (const baselineId of policy.baselineScenarioIds) if (!scenariosById.has(baselineId)) throw new Error(`required baseline scenario is missing from the approved inventory: ${baselineId}`);
  const requestedTargets = new Map(policy.targets.map((target) => [target.targetId, target]));
  if (new Set(input.selectedTargetIds).size !== input.selectedTargetIds.length || input.selectedTargetIds.some((id) => !requestedTargets.has(id))) throw new Error("selected targets must be unique configured target IDs");
  const discovered = inspectE2ERepository(input.sourceSnapshot, input.expectedCandidate);
  const inspection = discovered.inspection;
  const sourceTargets = new Map(inspection.proposedTargets.map((target) => [target.targetId, target]));
  for (const target of policy.targets) if (canonicalJson(sourceTargets.get(target.targetId) ?? null) !== canonicalJson(target)) throw new Error("execution policy target differs from the source-derived target inventory");
  const sourceOperations = discovered.portableOperations;
  const portableById = new Map(sourceOperations.map((operation) => [operation.operationId, operation]));
  const approvalBinding = input.portableApprovalBinding === undefined ? undefined : E2EPortableApprovalBindingSchema.parse(input.portableApprovalBinding);
  if (approvalBinding && (approvalBinding.planDigest !== input.planDigest || !input.approvedSemanticApproval
    || canonicalJson(approvalBinding.semanticApproval) !== canonicalJson(input.approvedSemanticApproval))) throw new Error("portable approval binding does not match the independently supplied plan and approval identity");
  const sourceByPath = new Map(input.sourceSnapshot.sources.map((source) => [source.path, source]));
  const associations = approvalBinding?.scenarioRegistrations ?? [];
  for (const association of associations) {
    const scenario = scenariosById.get(association.scenarioId);
    if (!scenario) throw new Error("scenario registration association references an unknown scenario");
    resolveE2EPortableRegistration(scenario, approvalBinding?.operations ?? [], associations);
  }
  const sourceCapabilityAvailable = new Map<string, boolean>();
  const accountsByApplicationProfile = new Map<string, E2EPortableApprovalBinding["accountContexts"][number]>();
  for (const account of approvalBinding?.accountContexts ?? []) {
    if (!approvalBinding || account.approval.planDigest !== input.planDigest || account.approval.artifactId !== approvalBinding.semanticApproval.artifactId || account.approval.digest !== approvalBinding.semanticApproval.digest) throw new Error("synthetic account context is missing the current approval lineage");
    if (!inspection.applications.some((app) => app.applicationId === account.applicationId)) throw new Error("synthetic account context references a foreign application");
    const fixtureSource = sourceByPath.get(account.fixture.sourcePath);
    if (!fixtureSource || fixtureSource.sha256 !== account.fixture.sourceSha256 || account.sourceRefs.length !== 1 || account.sourceRefs[0]?.path !== fixtureSource.path || account.sourceRefs[0]?.sha256 !== fixtureSource.sha256) throw new Error("synthetic account fixture source references must exactly match its one verified source blob");
    const definition = copyBoundedE2EJsonData(account.fixture.definition, { maxBytes: 65_536, maxDepth: 32 }) as Record<string, unknown>;
    const defaultAccountTarget = inspection.proposedTargets.find((target) => target.applicationId === account.applicationId && target.accountProfileId === account.profileId);
    const defaultManifestPath = sourceOperations.find((operation) => operation.applicationId === account.applicationId)?.manifestPath;
    if (defaultAccountTarget && defaultManifestPath === account.fixture.sourcePath) {
      const canonicalDefault = e2EDefaultSyntheticAccountDefinition(account.applicationId, account.profileId);
      if (canonicalJson(definition) !== canonicalJson(canonicalDefault)) throw new Error("default synthetic account definition differs from the canonical minimal profile");
    } else {
      let fixture: unknown;
      try { fixture = copyBoundedE2EJsonData(JSON.parse(Buffer.from(fixtureSource.bytes).toString("utf8")), { maxBytes: 65_536, maxDepth: 32 }); } catch { throw new Error("synthetic account fixture source must contain bounded JSON data"); }
      if (canonicalJson(fixture) !== canonicalJson(definition)) throw new Error("synthetic account fixture definition differs from its primary source bytes");
    }
    if (definition.profileId !== account.profileId || definition.applicationId !== account.applicationId || Object.keys(definition).some((key) => /people|actor|credential|live|role|permission|answer/i.test(key))) throw new Error("synthetic account fixture attempts unsupported identity or authority semantics");
    accountsByApplicationProfile.set(`${account.applicationId}\0${account.profileId}`, account);
  }
  for (const registration of approvalBinding?.operations ?? []) {
    const operation = portableById.get(registration.operationId);
    if (!operation || operation.applicationId !== registration.applicationId || operation.exportName !== registration.packageExportSubpath || canonicalJson(operation.sourceRefs) !== canonicalJson(registration.sourceRefs)) throw new Error("approved portable operation differs from source-derived package export identity");
    if (registration.descriptorDigest !== registrationDescriptor(registration)) throw new Error("portable operation descriptor digest mismatch");
    const manifest = sourceByPath.get(operation.manifestPath);
    const module = operation.sourceRefs.map((ref) => sourceByPath.get(ref.path)).find((source) => source !== undefined);
    if (!manifest || !module) throw new Error("portable operation source references are incomplete");
    let manifestJson: { exports?: unknown };
    try { manifestJson = JSON.parse(Buffer.from(manifest.bytes).toString("utf8")) as { exports?: unknown }; } catch { throw new Error("package manifest is not valid JSON"); }
    const exports = manifestJson.exports;
    const exportTarget = exports && typeof exports === "object" ? (exports as Record<string, unknown>)[registration.packageExportSubpath] : undefined;
    const manifestDir = operation.manifestPath.includes("/") ? operation.manifestPath.slice(0, operation.manifestPath.lastIndexOf("/")) : ".";
    const moduleSpecifier = manifestDir === "." ? `./${module.path}` : `./${module.path.slice(manifestDir.length + 1)}`;
    if (exportTarget !== moduleSpecifier || registration.moduleSpecifier !== exportTarget) throw new Error("package export subpath and source module specifier do not resolve to the same verified source");
    if (registration.purpose === "feature-invocation") {
      const inspectedSource = inspectE2EPortableSource(Buffer.from(module.bytes).toString("utf8"), module.path);
      const selector = registration.callableSelector;
      const exported = selector === null ? undefined : inspectedSource.exports.find((item) => item.name === (selector.kind === "default" ? "default" : selector.exportName));
      sourceCapabilityAvailable.set(e2ePortableRegistrationKey(registration), inspectedSource.parseable && exported?.kind === "callable");
    } else {
      const inspectedSource = inspectE2EPortableSource(Buffer.from(module.bytes).toString("utf8"), module.path);
      const actualNames = inspectedSource.exports.map((item) => item.name).sort();
      const expectedNames = [...(registration.expectedExportNames ?? [])].sort();
      sourceCapabilityAvailable.set(e2ePortableRegistrationKey(registration), inspectedSource.parseable && canonicalJson(actualNames) === canonicalJson(expectedNames));
    }
  }
  const sandbox = input.sandboxAvailability;
  const sandboxUsable = policy.modelRouteRevision === null && sandbox !== null && sandbox.targetId === "default-sandbox"
    && sandbox.profileId === policy.defaultSandboxProfileId && sandbox.connection === "connected"
    && sandbox.approval === "approved" && sandbox.qualification === "qualified";
  const criteria: E2EExecutionPlan["criteria"] = [];
  const expectedByTarget = new Map<string, E2EExpectedCase[]>();
  const unavailableCriteria: E2EExecutionPlan["unavailableCriteria"] = [];
  const mockSpecs: E2EMockSpec[] = [];
  const selected = new Set(input.selectedTargetIds);
  const baseline = new Set(policy.baselineScenarioIds);
  for (const scenario of scenarios) {
    const required = scenario.required || baseline.has(scenario.scenarioId);
    if (!required && !scenario.requestedTargetIds.some((targetId) => selected.has(targetId))) continue;
    for (const requestedTargetId of scenario.requestedTargetIds) {
      if (!required && !selected.has(requestedTargetId)) continue;
      const requestedTarget = requestedTargets.get(requestedTargetId);
      if (requestedTarget === undefined) throw new Error("scenario target is not configured");
      const criterionId = stableId("criterion-", [scenario.requirementId, scenario.scenarioId, requestedTargetId]);
      const criterion = { criterionId, requirementId: scenario.requirementId, scenarioId: scenario.scenarioId, requestedTargetId,
        required, minimumEvidence: scenario.minimumEvidence, requiredRealComponentIds: [...scenario.requiredRealComponentIds], expectedCaseIds: [] as string[] };
      criteria.push(criterion);
      const scenarioOperationId = scenario.steps[0]?.kind === "invoke-contract" || scenario.steps[0]?.kind === "inspect-contract" ? scenario.steps[0].operationId : undefined;
      const sourceOperation = scenarioOperationId ? portableById.get(scenarioOperationId) : undefined;
      const resolvedRegistration = resolveE2EPortableRegistration(scenario, approvalBinding?.operations ?? [], associations);
      const registration = resolvedRegistration?.registration;
      const accountContext = accountsByApplicationProfile.get(`${requestedTarget.applicationId}\0${scenario.accountProfileId}`);
      let unavailableReason: string | undefined;
      if (!approvalBinding || !input.approvedSemanticApproval) unavailableReason = "approved portable operation and synthetic account registry is unavailable";
      else if (!accountContext) unavailableReason = "scenario account profile has no source- and approval-bound SYNTHETIC account context";
      else if (!registration || (scenario.steps[0]?.kind === "invoke-contract" ? registration.purpose !== "feature-invocation" : scenario.steps[0]?.kind === "inspect-contract" ? registration.purpose !== "source-interface" : true)) unavailableReason = "scenario operation has no approved portable invocation or source-interface registration";
      else if (sourceCapabilityAvailable.get(resolvedRegistration?.registrationKey ?? "") !== true) unavailableReason = scenario.steps[0]?.kind === "inspect-contract" ? "registered module export names do not match source-validated module inventory" : "registered invocation selector is not a source-validated callable capability";
      else if (!sandboxUsable) unavailableReason = "approved qualified default sandbox is unavailable or model route is not disabled";
      else if (requestedTarget.applicationId !== sourceOperation?.applicationId || !sourceOperation.targetIds.includes(requestedTargetId)) unavailableReason = "no source-derived portable operation is bound to this requested target";
      else if (!validPortableSemantics(scenario, sourceOperation, registration, requestedTarget.kind)) unavailableReason = "requested steps, assertions, evidence scope, target kind, or agent semantics are not in the supported portable contract profile";
      const criterionMocks: E2EMockSpec[] = [];
      let fixtureUnavailableReason: string | undefined;
      if (!unavailableReason) for (const componentId of scenario.requiredRealComponentIds) {
        const edge = inspection.dependencyEdges.find((candidate) => candidate.toComponentId === componentId && candidate.fromApplicationId === requestedTarget.applicationId);
        const descriptor = input.mockableComponents?.find((candidate) => candidate.componentId === componentId && candidate.requestedTargetId === requestedTargetId);
        const schemaPath = edge?.sourcePaths.find((path) => /(^|\/)(?:openapi|swagger)\.json$/i.test(path));
        const source = schemaPath ? input.sourceSnapshot.sources.find((item) => item.path === schemaPath) : undefined;
        const fixture = source === undefined ? undefined : createE2EOpenApiFixtureDescriptor(source.bytes);
        if (!edge || !descriptor || descriptor.kind !== "api" || !schemaPath || fixture === undefined || descriptor.sourceRefs.length !== 1 || descriptor.sourceRefs[0]?.path !== schemaPath || descriptor.sourceRefs[0]?.sha256 !== source?.sha256) {
          fixtureUnavailableReason ??= "required real-component floor has no supported source-derived API contract fixture descriptor";
          continue;
        }
        criterionMocks.push({ componentId, requestedTargetId, effectiveTargetId: effectiveContractTargetId(requestedTargetId), kind: "api",
          contractDigest: hex(canonicalJson({ descriptor: fixture, sourceRefs: descriptor.sourceRefs, contractRef: edge.contractRef })),
          fixtureVersion: fixture.version, sourceRefs: descriptor.sourceRefs, reason: "phase-unavailable" });
      }
      if (unavailableReason) { unavailableCriteria.push({ criterionId, reason: unavailableReason }); continue; }
      if (fixtureUnavailableReason) unavailableCriteria.push({ criterionId, reason: fixtureUnavailableReason });
      const effectiveTargetId = effectiveContractTargetId(requestedTargetId);
      const assertionDigests = scenario.assertions.map(portableAssertionDigest);
      const assertionDigest = hex(canonicalJson(assertionDigests));
      const contextBody = { schemaVersion: accountContext!.schemaVersion, contextId: accountContext!.contextId, profileId: accountContext!.profileId, applicationId: accountContext!.applicationId, scope: accountContext!.scope, fixture: accountContext!.fixture, sourceRefs: accountContext!.sourceRefs, approval: accountContext!.approval };
      const accountContextId = accountContext!.contextId;
      const accountContextDigest = hex(canonicalJson(contextBody));
      const effectiveTarget = { targetId: effectiveTargetId, applicationId: requestedTarget.applicationId, runtimeProfileId: "portable-contract-v1", accountProfileId: requestedTarget.accountProfileId, kind: "contract" as const, requestedTargetId, adapterProfileId: "portable-contract-v1" };
      const executionDescriptorDigest = hex(canonicalJson({ schemaVersion: "portable-execution-descriptor/v1", purpose: registration!.purpose, registrationKey: resolvedRegistration!.registrationKey, adapter: E2E_CANDIDATE_ADAPTER_IDENTITY,
        operation: registration, requestedTarget, effectiveTarget, accountContext: { contextId: accountContextId, digest: accountContextDigest, profileId: scenario.accountProfileId },
        semanticApproval: approvalBinding!.semanticApproval, approvalBindingDigest: approvalBinding!.bindingDigest, steps: scenario.steps, assertionDigests,
        timing: { caseTimeoutMs: policy.limits.caseTimeoutMs, runTimeoutMs: policy.limits.runTimeoutMs, effectiveTestTimeoutMs: Math.min(policy.limits.caseTimeoutMs, policy.limits.runTimeoutMs) } }));
      const tuple = { scenarioId: scenario.scenarioId, targetId: effectiveTargetId, requestedTargetId, accountProfileId: scenario.accountProfileId, accountContextId, accountContextDigest, executionDescriptorDigest,
        minimumEvidence: scenario.minimumEvidence, requiredRealComponentIds: [...scenario.requiredRealComponentIds], agentId: "default", repeat: 0, assertionDigests };
      const caseId = e2eCaseIdFromIdentity(tuple);
      const expected: E2EExpectedCase = { caseId, criterionId, scenarioId: scenario.scenarioId, upstreamTestId: e2eUpstreamTestIdFromIdentity(tuple),
        targetId: effectiveTargetId, requestedTargetId, agentId: "default", repeat: 0, executionDescriptorDigest, accountContextId, accountContextDigest, accountProfileId: scenario.accountProfileId, assertionDigest, assertionDigests,
        required, minimumEvidence: scenario.minimumEvidence, requiredRealComponentIds: [...scenario.requiredRealComponentIds] };
      criterion.expectedCaseIds.push(caseId);
      const group = expectedByTarget.get(effectiveTargetId) ?? [];
      group.push(expected);
      expectedByTarget.set(effectiveTargetId, group);
      mockSpecs.push(...criterionMocks);
    }
  }
  if (criteria.length === 0) throw new Error("target selection produced no approved verification criteria");
  if (criteria.length > 64) throw new Error("approved scenario and target expansion exceeds 64 criteria");
  const targets: E2EExecutionPlan["effectiveTargets"] = [];
  const groups: E2EExecutionPlan["groups"] = [];
  const eligibleTargets = [...expectedByTarget.keys()].sort();
  for (let offset = 0; offset < eligibleTargets.length; offset += 3) {
    const targetIds = eligibleTargets.slice(offset, offset + 3);
    const groupCases = targetIds.flatMap((targetId) => expectedByTarget.get(targetId) ?? []);
    if (groups.length >= 4 || groups.reduce((sum, group) => sum + group.expectedCases.length, 0) + groupCases.length > 64) {
      for (const expected of groupCases) {
        const criterion = criteria.find((item) => item.criterionId === expected.criterionId);
        if (criterion) { criterion.expectedCaseIds = []; unavailableCriteria.push({ criterionId: criterion.criterionId, reason: "execution group budget exceeded" }); }
      }
      continue;
    }
    for (const requestedTargetId of targetIds.map((id) => policy.targets.find((target) => effectiveContractTargetId(target.targetId) === id)!.targetId)) {
      const requested = requestedTargets.get(requestedTargetId)!;
      const profile = "portable-contract-v1";
      targets.push({ targetId: effectiveContractTargetId(requestedTargetId), applicationId: requested.applicationId, runtimeProfileId: profile, accountProfileId: requested.accountProfileId, kind: "contract", requestedTargetId, adapterProfileId: profile });
    }
    const groupMocks = [...new Map(mockSpecs.filter((mock) => targetIds.includes(mock.effectiveTargetId)).map((mock) => [canonicalJson(mock), mock])).values()];
    groups.push({ groupId: stableId("group-", ["mock-only", policy.defaultSandboxProfileId, targetIds]), targetIds,
      runtimeProfileId: policy.defaultSandboxProfileId, mode: "mock-only", mockManifestDigest: hex(canonicalJson(groupMocks)), expectedCases: groupCases });
  }
  const unavailableUnique = [...new Map(unavailableCriteria.map((item) => [item.criterionId, item])).values()];
  const retainedTargets = new Set(groups.flatMap((group) => group.targetIds));
  const selectedMocks = [...new Map(mockSpecs.filter((mock) => retainedTargets.has(mock.effectiveTargetId)).map((mock) => [canonicalJson(mock), mock])).values()];
  const base = { schemaVersion: 1 as const, digest: "0".repeat(64), candidateDigest: input.candidateDigest, planDigest: input.planDigest, criteria, effectiveTargets: targets, groups, mocks: selectedMocks, unavailableCriteria: unavailableUnique };
  return E2EExecutionPlanSchema.parse({ ...base, digest: e2eExecutionPlanDigest(base) });
}
