import { createHash } from "node:crypto";
import { canonicalJson, e2EDefaultSyntheticAccountDefinition, inspectE2EPortableSource, inspectE2ERepository, e2ePortableOperationDescriptorDigest, e2EPortableApprovalBindingDigest, type E2EPlanSelectionInput, type E2ESyntheticAccountContext } from "@agentx/contracts";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** Builds explicit synthetic approval fixtures for tests; production approval comes from trusted plan storage. */
export function withTestPortableApproval<T extends E2EPlanSelectionInput>(input: T): T {
  if (input.portableApprovalBinding !== undefined) return input;
  const discovered = inspectE2ERepository(input.sourceSnapshot, input.expectedCandidate);
  const sourceByPath = new Map(input.sourceSnapshot.sources.map((source) => [source.path, source]));
  const operations = discovered.portableOperations.flatMap((operation) => {
    const module = operation.sourceRefs.map((ref) => sourceByPath.get(ref.path)).find((source) => source !== undefined);
    const manifest = sourceByPath.get(operation.manifestPath);
    if (!module || !manifest) return [];
    const inspected = inspectE2EPortableSource(Buffer.from(module.bytes).toString("utf8"), module.path);
    const selector = inspected.exports.some((item) => item.name === "default" && item.kind === "callable")
      ? { kind: "default" as const }
      : inspected.exports.find((item) => item.kind === "callable")?.name;
    const purposes = new Set(input.scenarios.flatMap((scenario) => scenario.steps.flatMap((step) =>
      (step.kind === "invoke-contract" || step.kind === "inspect-contract") && step.operationId === operation.operationId
        ? [step.kind === "invoke-contract" ? "feature-invocation" as const : "source-interface" as const] : [])));
    if (purposes.size === 0) return [];
    const manifestData = JSON.parse(Buffer.from(manifest.bytes).toString("utf8")) as { exports: Record<string, unknown> };
    const target = manifestData.exports[operation.exportName];
    if (typeof target !== "string") return [];
    return [...purposes].flatMap((purpose) => {
      if (purpose === "feature-invocation" && selector === undefined) return [];
      const base = { schemaVersion: "portable-source-operation/v1" as const, operationId: operation.operationId, applicationId: operation.applicationId,
        purpose, packageExportSubpath: operation.exportName, moduleSpecifier: target,
        callableSelector: purpose === "source-interface" ? null : typeof selector === "string" ? { kind: "named" as const, exportName: selector } : selector!,
        expectedExportNames: purpose === "source-interface" ? inspected.exports.map((item) => item.name).sort() : null, sourceRefs: [...operation.sourceRefs] };
      return [{ ...base, descriptorDigest: e2ePortableOperationDescriptorDigest(base) }];
    });
  });
  const semanticApproval = { artifactId: "test-semantic-approval/v1", digest: sha256(canonicalJson({ planDigest: input.planDigest, candidateDigest: input.candidateDigest, operations: operations.map((item) => item.descriptorDigest) })) };
  const accountMap = new Map<string, E2ESyntheticAccountContext>();
  for (const target of discovered.inspection.proposedTargets) {
    const manifest = discovered.portableOperations.find((operation) => operation.applicationId === target.applicationId)?.manifestPath;
    const source = manifest ? sourceByPath.get(manifest) : undefined;
    if (!source) continue;
    const definition = e2EDefaultSyntheticAccountDefinition(target.applicationId, target.accountProfileId);
    accountMap.set(`${target.applicationId}\0${target.accountProfileId}`, { schemaVersion: "synthetic-account-context/v1" as const, contextId: `test-account:${target.applicationId}:${target.accountProfileId}`, profileId: target.accountProfileId,
      applicationId: target.applicationId, scope: "SYNTHETIC" as const, fixture: { version: "synthetic-fixture/v1" as const, sourcePath: source.path, sourceSha256: source.sha256, definition },
      sourceRefs: [{ path: source.path, sha256: source.sha256 }], approval: { ...semanticApproval, planDigest: input.planDigest } });
  }
  const accounts = [...accountMap.values()];
  const bindingBody = { schemaVersion: "portable-approval-binding/v1" as const, planDigest: input.planDigest, semanticApproval, operations, accountContexts: accounts };
  const binding = { ...bindingBody, bindingDigest: e2EPortableApprovalBindingDigest(bindingBody) };
  return { ...input, portableApprovalBinding: binding, approvedSemanticApproval: semanticApproval };
}
