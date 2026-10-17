import { createHash } from "node:crypto";
import {
  canonicalJson, E2EPortableApprovalBindingSchema, E2EScenarioSchema, e2EDefaultSyntheticAccountDefinition,
  e2EPortableApprovalBindingDigest, e2ePortableOperationDescriptorDigest, e2ePortableRegistrationKey,
  e2eSourceInterfaceAssertion, inspectE2EPortableSource, inspectE2ERepository,
  type E2EPolicy, type E2EPortableApprovalBinding, type E2ERuntimeAvailability, type E2EScenario, type E2ESourceSnapshot, type E2ERepositoryInspection,
} from "@agentx/contracts";

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

/** Derive every source-supported setup inspection case from the exact approved snapshot. */
export function deriveProjectSetupSourceSmoke(input: {
  projectName: string;
  proposalSha256: string;
  approval: unknown;
  snapshot: E2ESourceSnapshot;
  policy: E2EPolicy;
  sandboxAvailability: E2ERuntimeAvailability & { targetId: "default-sandbox" };
  runtimeAvailability: E2ERuntimeAvailability[];
}): {
  semanticApproval: { artifactId: string; digest: string };
  planDigest: string;
  scenarios: E2EScenario[];
  portableApprovalBinding: E2EPortableApprovalBinding;
  targetIds: string[];
  unsupportedTargetIds: string[];
  discoveredApplications: E2ERepositoryInspection["applications"];
  discoveryMissingInputs: E2ERepositoryInspection["missingInputs"];
  discoveredTargetIds: string[];
  selectionInput: {
    candidateDigest: string; expectedCandidate: E2ESourceSnapshot["candidate"]; sourceSnapshot: E2ESourceSnapshot; planDigest: string;
    policy: E2EPolicy; scenarios: E2EScenario[]; selectedTargetIds: string[];
    sandboxAvailability: typeof input.sandboxAvailability; runtimeAvailability: E2ERuntimeAvailability[];
    portableApprovalBinding: E2EPortableApprovalBinding; approvedSemanticApproval: { artifactId: string; digest: string };
  };
} {
  const inspected = inspectE2ERepository(input.snapshot, input.snapshot.candidate);
  const policyTargets = new Map(input.policy.targets.map((target) => [target.targetId, target]));
  const supported = inspected.inspection.proposedTargets.filter((target) => {
    const approved = policyTargets.get(target.targetId);
    return approved !== undefined && canonicalJson(approved) === canonicalJson(target)
      && inspected.portableOperations.some((operation) => operation.applicationId === target.applicationId && operation.targetIds.includes(target.targetId));
  });
  const operations = [] as E2EPortableApprovalBinding["operations"];
  const accountContexts = [] as E2EPortableApprovalBinding["accountContexts"];
  const scenarios: E2EScenario[] = [];
  const scenarioRegistrations: NonNullable<E2EPortableApprovalBinding["scenarioRegistrations"]> = [];
  const registrationsByKey = new Map<string, E2EPortableApprovalBinding["operations"][number]>();
  const accountsSeen = new Set<string>();
  const semanticApproval = {
    artifactId: `project-setup:${input.proposalSha256}`,
    digest: sha256(canonicalJson({ domain: "project-setup-source-interface/v1", projectName: input.projectName, approval: input.approval })),
  };
  const planDigest = sha256(canonicalJson({ domain: "project-setup-source-interface/v1", semanticApproval,
    sourceDigest: sha256(canonicalJson(input.snapshot.candidate)), policy: input.policy }));
  for (const target of supported) {
    const operation = inspected.portableOperations.find((item) => item.applicationId === target.applicationId && item.targetIds.includes(target.targetId));
    if (!operation) continue;
    const module = input.snapshot.sources.find((item) => item.path === operation.sourceRefs[0]?.path);
    const manifest = input.snapshot.sources.find((item) => item.path === operation.manifestPath);
    if (!module || !manifest) throw new Error("approved setup source export is missing its immutable module or package manifest");
    const exportNames = inspectE2EPortableSource(Buffer.from(module.bytes).toString("utf8"), module.path).exports.map((item) => item.name).sort();
    const packageDirectory = operation.manifestPath.includes("/") ? operation.manifestPath.slice(0, operation.manifestPath.lastIndexOf("/")) : ".";
    const moduleSpecifier = packageDirectory === "." ? `./${module.path}` : `./${module.path.slice(packageDirectory.length + 1)}`;
    const registrationBody = {
      operationId: operation.operationId, applicationId: operation.applicationId, packageExportSubpath: operation.exportName,
      moduleSpecifier, callableSelector: null, expectedExportNames: exportNames, purpose: "source-interface" as const,
      schemaVersion: "portable-source-operation/v1" as const, sourceRefs: [...operation.sourceRefs],
    };
    const registration = { ...registrationBody, descriptorDigest: e2ePortableOperationDescriptorDigest(registrationBody) };
    const registrationKey = e2ePortableRegistrationKey(registration);
    registrationsByKey.set(registrationKey, registration);
    const scenarioId = `setup-source-${sha256(target.targetId).slice(0, 32)}`;
    const scenario = E2EScenarioSchema.parse({
      scenarioId, requirementId: "source-package-exports", requestedTargetIds: [target.targetId], required: true,
      accountProfileId: target.accountProfileId, minimumEvidence: "source", requiredRealComponentIds: [],
      steps: [{ kind: "inspect-contract", operationId: operation.operationId }], assertions: [e2eSourceInterfaceAssertion(registration)],
    });
    scenarios.push(scenario);
    scenarioRegistrations.push({ scenarioId, registrationKey });
    const accountKey = `${target.applicationId}\0${target.accountProfileId}`;
    if (!accountsSeen.has(accountKey)) {
      accountsSeen.add(accountKey);
      const accountContext = {
        schemaVersion: "synthetic-account-context/v1" as const, contextId: `account-${target.applicationId}-${target.accountProfileId}-synthetic`,
        profileId: target.accountProfileId, applicationId: target.applicationId, scope: "SYNTHETIC" as const,
        fixture: { version: "synthetic-fixture/v1" as const, sourcePath: operation.manifestPath, sourceSha256: manifest.sha256,
          definition: e2EDefaultSyntheticAccountDefinition(target.applicationId, target.accountProfileId) },
        sourceRefs: [{ path: manifest.path, sha256: manifest.sha256 }], approval: { ...semanticApproval, planDigest },
      };
      accountContexts.push(accountContext);
    }
  }
  operations.push(...registrationsByKey.values());
  if (scenarios.length === 0) throw new Error("approved setup source has no supported source-interface inspection target");
  const bindingBody = { schemaVersion: "portable-approval-binding/v1" as const, planDigest, semanticApproval,
    operations, accountContexts, scenarioRegistrations };
  const portableApprovalBinding = E2EPortableApprovalBindingSchema.parse({ ...bindingBody, bindingDigest: e2EPortableApprovalBindingDigest(bindingBody) });
  const targetIds = supported.map((target) => target.targetId).sort();
  const discoveredTargetIds = inspected.inspection.proposedTargets.map((target) => target.targetId).sort();
  const unsupportedTargetIds = discoveredTargetIds.filter((targetId) => !targetIds.includes(targetId));
  const selectedTargetIds = input.policy.targets.map((target) => target.targetId);
  const selectionInput = {
    candidateDigest: input.snapshot.candidate.digest, expectedCandidate: input.snapshot.candidate, sourceSnapshot: input.snapshot,
    planDigest, policy: input.policy, scenarios, selectedTargetIds,
    sandboxAvailability: input.sandboxAvailability, runtimeAvailability: input.runtimeAvailability,
    portableApprovalBinding, approvedSemanticApproval: semanticApproval,
  };
  return { semanticApproval, planDigest, scenarios, portableApprovalBinding, targetIds, unsupportedTargetIds,
    discoveredApplications: inspected.inspection.applications, discoveryMissingInputs: inspected.inspection.missingInputs, discoveredTargetIds, selectionInput };
}
