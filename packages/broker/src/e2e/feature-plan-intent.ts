import { createHash } from "node:crypto";
import {
  canonicalJson, E2EFeaturePlanIntentSchema, E2EPortableApprovalBindingSchema, e2EPortableApprovalBindingDigest,
  e2ePortableOperationDescriptorDigest, e2ePortableRegistrationKey, e2EDefaultSyntheticAccountDefinition,
  E2EPolicySchema, E2EScenarioBundleSchema, e2ePolicyDigest, e2eScenarioBundleDigest, selectE2EExecutionPlan,
  E2EApiMockFixtureSchema, type E2EPolicy, type E2EExecutionPlan, type E2EScenarioBundle,
  verifyE2ESourceSnapshot, type E2EFeaturePlanIntent, type E2EPortableApprovalBinding, type E2ESourceSnapshot,
} from "@agentx/contracts";
import { inspectE2EPortableSource, inspectE2ERepository } from "@agentx/contracts";
import { compileE2EScenarios } from "@agentx/verifier";
import { E2ERunBindingSchema, E2ERoundSchema, type E2ERound } from "@agentx/contracts";
import { admitE2EFeatureVerifier, E2E_FEATURE_PROCESS_RESPONSE_SCOPE, type E2EFeatureVerifierRecord } from "../aws/e2e-feature-verifier-catalog.js";

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

export type E2EPortablePlanReferenceFailure = "operation-inventory" | "target-ownership" | "module-path" | "callable-export" | "scenario-binding";

/** A deterministic owner-plan reference mismatch against the candidate's protected source inventory. */
export class E2EPortablePlanReferenceError extends Error {
  readonly reasonCode: E2EPortablePlanReferenceFailure;

  constructor(reasonCode: E2EPortablePlanReferenceFailure, message: string) {
    super(message);
    this.name = "E2EPortablePlanReferenceError";
    this.reasonCode = reasonCode;
  }
}

function deriveApprovedMockSelections(input: { intent: E2EFeaturePlanIntent; snapshot: E2ESourceSnapshot;
  inspection: ReturnType<typeof inspectE2ERepository>["inspection"] }): Array<{ componentId: string; requestedTargetId: string; kind: "api";
  sourceRefs: Array<{ path: string; sha256: string }>; fixture: unknown }> {
  return (input.intent.mockFixtureRefs ?? []).map((reference) => {
    const target = input.inspection.proposedTargets.find((candidate) => candidate.targetId === reference.requestedTargetId);
    const schemaEdge = target === undefined ? undefined : input.inspection.dependencyEdges.find((edge) => edge.fromApplicationId === target.applicationId
      && edge.toComponentId === reference.componentId && edge.sourcePaths.some((path) => /(^|\/)(?:openapi|swagger)\.json$/i.test(path)));
    const schemaPath = schemaEdge?.sourcePaths.find((path) => /(^|\/)(?:openapi|swagger)\.json$/i.test(path));
    const schemaSource = schemaPath === undefined ? undefined : input.snapshot.sources.find((source) => source.path === schemaPath && source.kind === "blob");
    const fixtureSource = input.snapshot.sources.find((source) => source.path === reference.sourcePath && source.sha256 === reference.sourceSha256 && source.kind === "blob");
    if (!target || !schemaEdge || !schemaSource || !fixtureSource) throw new Error("approved mock selection does not match a protected API schema edge and fixture source");
    let raw: unknown;
    try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fixtureSource.bytes)) as unknown; }
    catch { throw new Error("approved source-backed API fixture is not valid UTF-8 JSON"); }
    const fixture = E2EApiMockFixtureSchema.parse(raw);
    if (fixture.operationId !== reference.operationId) throw new Error("approved API fixture operation does not match its canonical source reference");
    return { componentId: reference.componentId, requestedTargetId: reference.requestedTargetId, kind: "api" as const,
      sourceRefs: [{ path: schemaSource.path, sha256: schemaSource.sha256 }], fixture };
  });
}

/** Derives feature invocation registrations only from canonical Owner-approved refs and the protected final source snapshot. */
export function deriveE2EFeaturePortableApprovalBinding(input: {
  intent: E2EFeaturePlanIntent;
  snapshot: E2ESourceSnapshot;
  artifactId: string;
  artifactSha256: string;
  planDigest: string;
}): E2EPortableApprovalBinding {
  const intent = E2EFeaturePlanIntentSchema.parse(input.intent);
  if (!/^[a-f0-9]{64}$/.test(input.artifactSha256) || !/^[a-f0-9]{64}$/.test(input.planDigest)) throw new Error("canonical feature artifact identity is invalid");
  verifyE2ESourceSnapshot(input.snapshot, input.snapshot.candidate);
  const discovered = inspectE2ERepository(input.snapshot, input.snapshot.candidate);
  const mockableComponents = deriveApprovedMockSelections({ intent, snapshot: input.snapshot, inspection: discovered.inspection });
  const operations: E2EPortableApprovalBinding["operations"] = [];
  const operationById = new Map<string, E2EPortableApprovalBinding["operations"][number]>();
  const targets = new Map(discovered.inspection.proposedTargets.map((target) => [target.targetId, target]));

  for (const proposed of intent.portableOperationRefs ?? []) {
    const sourceOperation = discovered.portableOperations.find((item) => item.operationId === proposed.operationId);
    if (!sourceOperation || sourceOperation.applicationId !== proposed.applicationId || sourceOperation.exportName !== proposed.packageExportSubpath) {
      throw new E2EPortablePlanReferenceError("operation-inventory", "Owner-approved portable operation reference does not match the protected package export inventory");
    }
    if (proposed.requestedTargetIds.some((targetId) => !sourceOperation.targetIds.includes(targetId)
      || targets.get(targetId)?.applicationId !== proposed.applicationId)) {
      throw new E2EPortablePlanReferenceError("target-ownership", "Owner-approved portable operation target is not owned by its protected source application");
    }
    const manifestDirectory = sourceOperation.manifestPath.includes("/")
      ? sourceOperation.manifestPath.slice(0, sourceOperation.manifestPath.lastIndexOf("/")) : ".";
    const moduleSource = sourceOperation.sourceRefs.map((ref) => input.snapshot.sources.find((source) => source.path === ref.path && source.sha256 === ref.sha256))
      .find((source) => source !== undefined);
    if (!moduleSource) throw new Error("protected portable operation module bytes are missing");
    const expectedModuleSpecifier = manifestDirectory === "." ? `./${moduleSource.path}` : `./${moduleSource.path.slice(manifestDirectory.length + 1)}`;
    if (proposed.moduleSpecifier !== expectedModuleSpecifier) throw new E2EPortablePlanReferenceError("module-path", "Owner-approved module reference differs from the protected package module path");
    const moduleInspection = inspectE2EPortableSource(Buffer.from(moduleSource.bytes).toString("utf8"), moduleSource.path);
    const exportName = proposed.callableSelector.kind === "default" ? "default" : proposed.callableSelector.exportName;
    if (!moduleInspection.parseable || moduleInspection.exports.find((item) => item.name === exportName)?.kind !== "callable") {
      throw new E2EPortablePlanReferenceError("callable-export", "Owner-approved callable selector is not an AST-verified callable export in the protected module");
    }
    const body = {
      operationId: sourceOperation.operationId, applicationId: sourceOperation.applicationId, purpose: "feature-invocation" as const,
      packageExportSubpath: sourceOperation.exportName, moduleSpecifier: expectedModuleSpecifier, callableSelector: proposed.callableSelector,
      expectedExportNames: null, sourceRefs: [...sourceOperation.sourceRefs], schemaVersion: "portable-source-operation/v1" as const,
    };
    const registration = { ...body, descriptorDigest: e2ePortableOperationDescriptorDigest(body) };
    operations.push(registration);
    operationById.set(sourceOperation.operationId, registration);
  }

  const semanticApproval = { artifactId: input.artifactId, digest: input.artifactSha256 };
  const planDigest = input.planDigest;
  const accountContexts: E2EPortableApprovalBinding["accountContexts"] = [];
  const seenAccounts = new Set<string>();
  for (const reference of intent.accountContextRefs) {
    const key = `${reference.applicationId}\0${reference.profileId}`;
    if (seenAccounts.has(key)) continue;
    const source = input.snapshot.sources.find((item) => item.path === reference.sourcePath && item.sha256 === reference.sourceSha256);
    if (!source || !discovered.inspection.applications.some((item) => item.applicationId === reference.applicationId)) {
      throw new Error("Owner-approved account context does not match protected application source bytes");
    }
    const definition = e2EDefaultSyntheticAccountDefinition(reference.applicationId, reference.profileId);
    accountContexts.push({ schemaVersion: "synthetic-account-context/v1", contextId: `account-${reference.applicationId}-${reference.profileId}-synthetic`,
      profileId: reference.profileId, applicationId: reference.applicationId, scope: "SYNTHETIC",
      fixture: { version: "synthetic-fixture/v1", sourcePath: source.path, sourceSha256: source.sha256, definition },
      sourceRefs: [{ path: source.path, sha256: source.sha256 }], approval: { ...semanticApproval, planDigest } });
    seenAccounts.add(key);
  }

  const scenarioRegistrations: NonNullable<E2EPortableApprovalBinding["scenarioRegistrations"]> = [];
  for (const scenario of intent.scenarios) {
    const step = scenario.steps[0];
    if (step?.kind !== "invoke-contract") continue;
    const registration = operationById.get(step.operationId);
    if (!registration || scenario.requestedTargetIds.some((targetId) => !(intent.portableOperationRefs ?? []).find((ref) => ref.operationId === step.operationId)?.requestedTargetIds.includes(targetId))) {
      throw new E2EPortablePlanReferenceError("scenario-binding", "feature invocation scenario is not covered by an approved source-bound operation reference");
    }
    scenarioRegistrations.push({ scenarioId: scenario.scenarioId, registrationKey: e2ePortableRegistrationKey(registration) });
  }
  const body = { schemaVersion: "portable-approval-binding/v1" as const, planDigest, semanticApproval, operations, accountContexts,
    ...(mockableComponents.length === 0 ? {} : { mockFixtures: mockableComponents }), scenarioRegistrations };
  return E2EPortableApprovalBindingSchema.parse({ ...body, bindingDigest: e2EPortableApprovalBindingDigest(body) });
}

/** Derives a candidate-bound execution plan only when a separate feature verifier is currently admitted. */
export function deriveE2EFeatureExecutionAdmission(input: {
  intent: E2EFeaturePlanIntent;
  snapshot: E2ESourceSnapshot;
  artifactId: string;
  artifactSha256: string;
  planDigest: string;
  policy: E2EPolicy;
  runtimeCatalogId: string;
  runtimeBinding: E2EFeatureVerifierRecord["binding"];
  featureVerifier: unknown;
  now: number;
}): { runtime: E2EFeatureVerifierRecord; portableApprovalBinding: E2EPortableApprovalBinding; plan: E2EExecutionPlan;
  bundle: E2EScenarioBundle; selectionInput: Parameters<typeof selectE2EExecutionPlan>[0] } {
  const policy = E2EPolicySchema.parse(input.policy);
  const runtime = admitE2EFeatureVerifier(input.featureVerifier, { runtimeCatalogId: input.runtimeCatalogId,
    profileId: policy.defaultSandboxProfileId, binding: input.runtimeBinding, scope: E2E_FEATURE_PROCESS_RESPONSE_SCOPE, now: input.now });
  if (!runtime) throw new Error("a current separately qualified portable feature verifier is unavailable");
  const portableApprovalBinding = deriveE2EFeaturePortableApprovalBinding(input);
  const discovered = inspectE2ERepository(input.snapshot, input.snapshot.candidate);
  const mockableComponents = deriveApprovedMockSelections({ intent: input.intent, snapshot: input.snapshot, inspection: discovered.inspection });
  const semanticApproval = portableApprovalBinding.semanticApproval;
  const selectionInput = {
    candidateDigest: input.snapshot.candidate.digest, expectedCandidate: input.snapshot.candidate, sourceSnapshot: input.snapshot,
    planDigest: input.planDigest, policy, scenarios: E2EFeaturePlanIntentSchema.parse(input.intent).scenarios,
    selectedTargetIds: E2EFeaturePlanIntentSchema.parse(input.intent).requestedTargetIds,
    sandboxAvailability: { targetId: "default-sandbox" as const, profileId: runtime.profileId, connection: "connected" as const,
      approval: "approved" as const, qualification: "qualified" as const,
      authorizationRevision: `feature-${runtime.runtimeCatalogId}-${runtime.catalogRevision}-${runtime.generation}` },
    runtimeAvailability: [], portableApprovalBinding, approvedSemanticApproval: semanticApproval, mockableComponents,
  };
  const plan = selectE2EExecutionPlan(selectionInput);
  const bundleBody = { schemaVersion: 1 as const, planDigest: input.planDigest, templateVersion: "trusted-e2e/v1", scenarios: selectionInput.scenarios, bundleDigest: "0".repeat(64) };
  const bundle = E2EScenarioBundleSchema.parse({ ...bundleBody, bundleDigest: e2eScenarioBundleDigest(bundleBody) });
  return { runtime, portableApprovalBinding, plan, bundle, selectionInput };
}

/** Builds every immutable group binding for one server-owned CHECKS operation. */
export function buildE2EFeatureRound(input: {
  admission: ReturnType<typeof deriveE2EFeatureExecutionAdmission>;
  taskId: string;
  operationId: string;
  operationFence: number;
  workflowRevision: number;
  roundId: string;
  runIds: readonly string[];
  admittedAt: string;
  deadlineAt: string;
}): { round: E2ERound; groupAdmissions: Array<Record<string, unknown>> } {
  const { admission } = input;
  if (admission.plan.groups.length === 0 || admission.plan.groups.length > 4
    || input.runIds.length !== admission.plan.groups.length || new Set(input.runIds).size !== input.runIds.length) {
    throw new Error("feature CHECKS admission must bind every bounded execution group exactly once");
  }
  const groups = admission.plan.groups.map((group, index) => {
    const compiled = compileE2EScenarios(admission.bundle, admission.plan.effectiveTargets, group,
      { selectionInput: admission.selectionInput, executionPlan: admission.plan, group });
    const binding = E2ERunBindingSchema.parse({ schemaVersion: 1, runId: input.runIds[index], roundId: input.roundId,
      taskId: input.taskId, operationId: input.operationId, operationFence: input.operationFence,
      workflowRevision: input.workflowRevision, groupId: group.groupId, executionPlanDigest: admission.plan.digest,
      executionMode: group.mode, mockManifestDigest: group.mockManifestDigest,
      authorizationRevision: `feature-${admission.runtime.runtimeCatalogId}-${admission.runtime.catalogRevision}-${admission.runtime.generation}`,
      candidateDigest: admission.selectionInput.candidateDigest, planDigest: admission.selectionInput.planDigest,
      policyDigest: e2ePolicyDigest(admission.selectionInput.policy), bundleDigest: admission.bundle.bundleDigest,
      appBuildDigest: sha256(canonicalJson(compiled.inventory)), environmentDigest: admission.runtime.runnerEnvironmentDigest,
      runtimeManifestDigest: admission.runtime.manifestDigest, modelRouteRevision: admission.selectionInput.policy.modelRouteRevision,
      expectedCases: compiled.expectedCases, admittedAt: input.admittedAt, deadlineAt: input.deadlineAt });
    return { group, binding, expectedConfigDigest: compiled.expectedConfigDigest,
      compiledInventoryDigest: compiled.inventory.digest, expectedCases: compiled.expectedCases,
      selectionPacketPath: compiled.selectionPacketPath };
  });
  const round = E2ERoundSchema.parse({ schemaVersion: 1, roundId: input.roundId, taskId: input.taskId,
    operationId: input.operationId, operationFence: input.operationFence, workflowRevision: input.workflowRevision,
    executionPlanDigest: admission.plan.digest, admittedAt: input.admittedAt, deadlineAt: input.deadlineAt,
    limits: admission.selectionInput.policy.limits, groupBindings: groups.map((group) => group.binding) });
  return { round, groupAdmissions: groups };
}

/** A compact stable identity for derived feature semantics; candidate bytes are bound separately on every admission. */
export function e2eFeatureIntentDigest(intent: E2EFeaturePlanIntent): string {
  return sha256(canonicalJson(E2EFeaturePlanIntentSchema.parse(intent)));
}
