import { createHash } from "node:crypto";
import {
  E2EApplicationPlanIntentSchema, E2EPolicySchema, E2EScenarioBundleSchema, canonicalJson, e2eScenarioBundleDigest,
  type E2EApplicationApprovalBinding, type E2EApplicationPlanIntent, type E2EExecutionPlan, type E2EPortableApprovalBinding,
  type E2EScenarioBundle, type E2ESourceSnapshot, type E2ESetupProposal, type PlanApprovalRef,
  type E2ERegisteredRuntime, type E2ERuntimeAvailability, type E2ERuntimeAccountRef,
} from "@agentx/contracts";
import { deriveE2EApplicationApprovalBinding } from "./application-plan-binding.js";
import { deriveE2EFeaturePortableApprovalBinding } from "./feature-plan-intent.js";
import { projectE2EApplicationPortableSelection, selectE2EApplicationExecutionPlan, type E2EApplicationPlanSelectionInput,
  type E2EApplicationPortableProjection } from "@agentx/contracts";
import { admitE2EFeatureVerifier, E2E_FEATURE_PROCESS_RESPONSE_SCOPE, type E2EFeatureVerifierRecord } from "../aws/e2e-feature-verifier-catalog.js";

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

export type E2EApplicationFeatureSelectionInput = {
  intent: E2EApplicationPlanIntent; snapshot: E2ESourceSnapshot; artifactId: string; artifactSha256: string; planDigest: string;
  approvedSemanticApproval: PlanApprovalRef; setupProposal: E2ESetupProposal; setupApproval: PlanApprovalRef; policy: unknown;
  registeredRuntimes: E2ERegisteredRuntime[]; runtimeAvailability: E2ERuntimeAvailability[]; runtimeAccountRefs: E2ERuntimeAccountRef[];
  runtimeCatalogId: string; runtimeBinding: E2EFeatureVerifierRecord["binding"]; featureVerifier: unknown; now: number;
};

export function deriveE2EApplicationFeatureExecutionSelection(input: E2EApplicationFeatureSelectionInput): {
  applicationApprovalBinding: E2EApplicationApprovalBinding | null; portableApprovalBinding: E2EPortableApprovalBinding | null;
  portableProjection: E2EApplicationPortableProjection | null; sandboxRuntime: E2EFeatureVerifierRecord | null; intentDigest: string;
  plan: E2EExecutionPlan; bundle: E2EScenarioBundle; selectionInput: E2EApplicationPlanSelectionInput;
} {
  const intent = E2EApplicationPlanIntentSchema.parse(input.intent);
  const policy = E2EPolicySchema.parse(input.policy);
  if (input.approvedSemanticApproval.artifactId !== input.artifactId || input.approvedSemanticApproval.digest !== input.artifactSha256
    || !/^[a-f0-9]{64}$/.test(input.artifactSha256) || !/^[a-f0-9]{64}$/.test(input.planDigest)) {
    throw new Error("application intent artifact identity differs from the independent semantic approval");
  }
  const intentDigest = sha256(canonicalJson(intent));
  const realTargetIds = new Set(intent.applicationRuntimeRefs.map((ref) => ref.targetId));
  const realScenarios = intent.scenarios.flatMap((scenario) => {
    if (scenario.steps[0]?.kind === "invoke-contract" || scenario.steps[0]?.kind === "inspect-contract") return [];
    const requestedTargetIds = scenario.requestedTargetIds.filter((targetId) => realTargetIds.has(targetId));
    return requestedTargetIds.length === 0 ? [] : [{ ...scenario, requestedTargetIds }];
  });
  const realProfiles = new Set(intent.applicationRuntimeRefs.map((ref) => `${ref.applicationId}\0${ref.accountProfileId}`));
  const realIntent = intent.applicationRuntimeRefs.length === 0 ? null : E2EApplicationPlanIntentSchema.parse({
    ...intent, requestedTargetIds: [...realTargetIds], scenarios: realScenarios,
    portableOperationRefs: [], mockFixtureRefs: (intent.mockFixtureRefs ?? []).filter((ref) => realTargetIds.has(ref.requestedTargetId)),
    accountContextRefs: intent.accountContextRefs.filter((ref) => realProfiles.has(`${ref.applicationId}\0${ref.profileId}`)),
    applicationRuntimeRefs: intent.applicationRuntimeRefs,
    runtimeAccountRefs: intent.runtimeAccountRefs.filter((ref) => realProfiles.has(`${ref.applicationId}\0${ref.profileId}`)),
    unavailableTargetRefs: [],
    semanticExportDeltas: intent.semanticExportDeltas.filter((ref) => intent.applicationRuntimeRefs.some((runtime) => runtime.applicationId === ref.applicationId)),
  });
  const applicationApprovalBinding = realIntent === null ? null : deriveE2EApplicationApprovalBinding({
    preparedSnapshot: input.snapshot, intent: realIntent, artifactId: input.artifactId, artifactSha256: input.artifactSha256,
    planDigest: input.planDigest, setupProposal: input.setupProposal, setupApproval: input.setupApproval,
  });
  const portablePairs = new Map<string, Set<string>>();
  for (const scenario of intent.scenarios) {
    const step = scenario.steps[0];
    if (step?.kind !== "invoke-contract" && step?.kind !== "inspect-contract") continue;
    const operation = intent.portableOperationRefs?.find((ref) => ref.operationId === step.operationId);
    const targetIds = scenario.requestedTargetIds.filter((targetId) => operation?.requestedTargetIds.includes(targetId));
    if (targetIds.length > 0) portablePairs.set(scenario.scenarioId, new Set(targetIds));
  }
  const portableTargetIds = new Set([...portablePairs.values()].flatMap((values) => [...values]));
  const portableScenarios = intent.scenarios.flatMap((scenario) => {
    const targets = portablePairs.get(scenario.scenarioId);
    return !targets ? [] : [{ ...scenario, requestedTargetIds: scenario.requestedTargetIds.filter((targetId) => targets.has(targetId)) }];
  });
  const portableApps = new Set((intent.portableOperationRefs ?? []).filter((ref) => ref.requestedTargetIds.some((id) => portableTargetIds.has(id))).map((ref) => ref.applicationId));
  const portableProfiles = new Set(portableScenarios.flatMap((scenario) => scenario.requestedTargetIds.map((targetId) => {
    const target = policy.targets.find((item) => item.targetId === targetId);
    return target ? `${target.applicationId}\0${scenario.accountProfileId}` : "";
  })));
  const hasPortable = portableScenarios.length > 0;
  const portableIntent = hasPortable ? {
    schemaVersion: 1 as const, requestedTargetIds: [...portableTargetIds],
    portableOperationRefs: (intent.portableOperationRefs ?? []).filter((ref) => ref.requestedTargetIds.some((id) => portableTargetIds.has(id)))
      .map((ref) => ({ ...ref, requestedTargetIds: ref.requestedTargetIds.filter((id) => portableTargetIds.has(id)) })),
    mockFixtureRefs: (intent.mockFixtureRefs ?? []).filter((ref) => portableTargetIds.has(ref.requestedTargetId)),
    accountContextRefs: intent.accountContextRefs.filter((ref) => portableProfiles.has(`${ref.applicationId}\0${ref.profileId}`)),
    scenarios: portableScenarios, semanticExportDeltas: intent.semanticExportDeltas.filter((ref) => portableApps.has(ref.applicationId)),
  } : undefined;
  const portableApprovalBinding = portableIntent ? deriveE2EFeaturePortableApprovalBinding({
    intent: portableIntent, snapshot: input.snapshot, artifactId: input.artifactId, artifactSha256: input.artifactSha256, planDigest: input.planDigest,
  }) : null;
  let sandboxRuntime: E2EFeatureVerifierRecord | null = null;
  if (portableApprovalBinding && input.featureVerifier !== null && input.featureVerifier !== undefined) {
    sandboxRuntime = admitE2EFeatureVerifier(input.featureVerifier, { runtimeCatalogId: input.runtimeCatalogId,
      profileId: policy.defaultSandboxProfileId, binding: input.runtimeBinding, scope: E2E_FEATURE_PROCESS_RESPONSE_SCOPE, now: input.now }) ?? null;
  }
  const mockableComponents = (portableApprovalBinding?.mockFixtures ?? []).map((fixture) => ({
    componentId: fixture.componentId, requestedTargetId: fixture.requestedTargetId, kind: fixture.kind, sourceRefs: fixture.sourceRefs,
    ...(fixture.fixture === undefined ? { fixtureProfile: fixture.fixtureProfile! } : { fixture: fixture.fixture }),
  }));
  const selectionInput: E2EApplicationPlanSelectionInput = {
    candidateDigest: input.snapshot.candidate.digest, expectedCandidate: input.snapshot.candidate, sourceSnapshot: input.snapshot,
    planDigest: input.planDigest, policy, scenarios: intent.scenarios, selectedTargetIds: intent.requestedTargetIds,
    sandboxAvailability: sandboxRuntime ? { targetId: "default-sandbox", profileId: sandboxRuntime.profileId, connection: "connected",
      approval: "approved", qualification: "qualified", authorizationRevision: `feature-${sandboxRuntime.runtimeCatalogId}-${sandboxRuntime.catalogRevision}-${sandboxRuntime.generation}` } : null,
    runtimeAvailability: input.runtimeAvailability, ...(portableApprovalBinding === null ? {} : { portableApprovalBinding }),
    approvedSemanticApproval: input.approvedSemanticApproval, mockableComponents, intent, intentDigest,
    setupProposal: input.setupProposal, setupApproval: input.setupApproval, applicationApprovalBinding,
    registeredRuntimes: input.registeredRuntimes, runtimeAccountRefs: input.runtimeAccountRefs, now: input.now,
  };
  const portableProjection = projectE2EApplicationPortableSelection(selectionInput);
  const plan = selectE2EApplicationExecutionPlan(selectionInput);
  const bundleBody = { schemaVersion: 1 as const, planDigest: input.planDigest, templateVersion: "trusted-e2e-application/v1",
    scenarios: intent.scenarios, bundleDigest: "0".repeat(64) };
  const bundle = E2EScenarioBundleSchema.parse({ ...bundleBody, bundleDigest: e2eScenarioBundleDigest(bundleBody) });
  return { applicationApprovalBinding, portableApprovalBinding, portableProjection, sandboxRuntime, intentDigest, plan, bundle, selectionInput };
}
