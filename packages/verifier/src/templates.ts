import { createHash } from "node:crypto";
import { canonicalJson, E2E_CANDIDATE_INSPECTION_PROTOCOL, e2ePortableOperationDescriptorDigest as contractDescriptorDigest, resolveE2EPortableRegistration, type E2EExpectedCase, type E2EExecutionPlan, type E2EPortableOperationRegistration, type E2EPortablePurpose, type E2EScenario } from "@agentx/contracts";
import { E2E_CANDIDATE_RESPONSE_PROTOCOL, E2E_CANDIDATE_REQUEST_PROTOCOL, E2E_CANDIDATE_RESPONSE_SCOPE, E2E_SUPERVISOR_RPC_PROTOCOL, E2E_GENERATED_CONFIG_PATH, E2E_GENERATED_TEST_PATH, E2E_SELECTION_PACKET_PATH, expectedE2EConfigDigest, upstreamE2ECaseIdentity, type E2ECompiledFile, type E2ECompiledInventory } from "./identity.js";
import { createE2ESelectionPacket } from "./selection.js";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
export type E2EOperationRegistration = E2EPortableOperationRegistration;
export type E2ECompilerPurpose = E2EPortablePurpose;
export function e2ePortableOperationDescriptorDigest(input: Omit<E2EOperationRegistration, "descriptorDigest">): string {
  return contractDescriptorDigest(input);
}

export function emitE2ECompilationFiles(input: { expectedCases: readonly E2EExpectedCase[]; scenarios: readonly E2EScenario[]; scenarioRegistrations?: readonly { scenarioId: string; registrationKey: string }[]; group: { groupId: string; targetIds: readonly string[] }; plan: E2EExecutionPlan; bundleDigest: string; registrations: readonly E2EOperationRegistration[]; runTimeoutMs: number; caseTimeoutMs: number }): { files: ReadonlyMap<string, string>; inventory: E2ECompiledInventory; expectedConfigDigest: string; hostRequestPayloads: ReadonlyMap<string, unknown>; caseBindings: ReadonlyMap<string, { compilerCaseIdentity: string; registrationKey: string; candidateResponseScope: typeof E2E_CANDIDATE_RESPONSE_SCOPE; requestProtocol: typeof E2E_CANDIDATE_REQUEST_PROTOCOL; operationId: string; applicationId: string; accountProfileId: string; accountContextId: string; accountContextDigest: string; requestedTargetId: string; packageExportSubpath: string; moduleSpecifier: string; callableSelector: E2EOperationRegistration["callableSelector"]; descriptorDigest: string; executionDescriptorDigest: string }> } {
  if (input.expectedCases.length === 0 || input.group.targetIds.length < 1 || input.group.targetIds.length > 3) throw new Error("compiler requires a nonempty assigned group of at most three targets");
  const scenarios = new Map(input.scenarios.map((scenario) => [scenario.scenarioId, scenario]));
  const titleByCaseId = new Map(input.expectedCases.map((item) => [item.caseId, item.upstreamTestId.slice(item.upstreamTestId.lastIndexOf("::") + 2)]));
  const tests = input.expectedCases.map((item) => {
    const scenario = scenarios.get(item.scenarioId);
    const resolved = scenario ? resolveE2EPortableRegistration(scenario, input.registrations, input.scenarioRegistrations) : undefined;
    const registration = resolved?.registration;
    if (!scenario || !registration || !resolved || registration.schemaVersion !== "portable-source-operation/v1" || !/^[a-f0-9]{64}$/.test(registration.descriptorDigest)) throw new Error("expected case has no uniquely resolved registered source operation descriptor");
    validateRegistration(registration);
    const title = titleByCaseId.get(item.caseId)!;
    const identity = upstreamE2ECaseIdentity(item, title);
    if (identity.upstreamTestId !== item.upstreamTestId) throw new Error("upstream test identity is not the pinned test ID derived from fixed path and digest title");
    return { item, scenario, registration, registrationKey: resolved.registrationKey, title };
  });
  const caseTestById = new Map(tests.map((item) => [item.item.caseId, item]));
  const caseBindings = new Map(input.expectedCases.map((item) => {
    const resolved = caseTestById.get(item.caseId);
    if (!resolved) throw new Error("case has no operation binding");
    const { registration, registrationKey } = resolved;
    return [item.caseId, Object.freeze({ compilerCaseIdentity: sha256(canonicalJson({ caseId: item.caseId, executionDescriptorDigest: item.executionDescriptorDigest, registrationKey, accountContextId: item.accountContextId, accountContextDigest: item.accountContextDigest, candidateResponse: E2E_CANDIDATE_RESPONSE_PROTOCOL, operationDescriptorDigest: registration.descriptorDigest })), registrationKey, candidateResponseScope: E2E_CANDIDATE_RESPONSE_SCOPE, requestProtocol: E2E_CANDIDATE_REQUEST_PROTOCOL, operationId: registration.operationId, applicationId: registration.applicationId, accountProfileId: item.accountProfileId, accountContextId: item.accountContextId, accountContextDigest: item.accountContextDigest, requestedTargetId: item.requestedTargetId, packageExportSubpath: registration.packageExportSubpath, moduleSpecifier: registration.moduleSpecifier, callableSelector: registration.callableSelector, descriptorDigest: registration.descriptorDigest, executionDescriptorDigest: item.executionDescriptorDigest })] as const;
  }));
  const packet = createE2ESelectionPacket(input.plan, input.group.groupId, titleByCaseId, caseBindings);
  const hostRequestPayloads = new Map<string, unknown>();
  const generatedTest = [
    'import { test } from "e2e";',
    'const observation = globalThis.__agentxE2EObservation;',
    ...tests.map(({ item, scenario, registration, registrationKey, title }) => {
      const caseBinding = caseBindings.get(item.caseId)!;
      const payload = { protocol: E2E_SUPERVISOR_RPC_PROTOCOL, purpose: registration.purpose, registrationKey, inspectionProtocol: registration.purpose === "source-interface" ? E2E_CANDIDATE_INSPECTION_PROTOCOL : null, expectedExportNames: registration.expectedExportNames, caseId: item.caseId, executionDescriptorDigest: item.executionDescriptorDigest, accountContextId: item.accountContextId, accountContextDigest: item.accountContextDigest, candidateResponse: E2E_CANDIDATE_RESPONSE_PROTOCOL, compilerCaseIdentity: caseBinding.compilerCaseIdentity, candidateResponseScope: E2E_CANDIDATE_RESPONSE_SCOPE, requestProtocol: E2E_CANDIDATE_REQUEST_PROTOCOL, bundleDigest: input.bundleDigest, scenarioId: item.scenarioId, requestedTargetId: item.requestedTargetId, effectiveTargetId: item.targetId, accountProfileId: scenario.accountProfileId, operationId: registration.operationId, packageExportSubpath: registration.packageExportSubpath, moduleSpecifier: registration.moduleSpecifier, callableSelector: registration.callableSelector, descriptorSchemaVersion: registration.schemaVersion, descriptorDigest: registration.descriptorDigest, input: scenario.steps[0]?.kind === "invoke-contract" ? scenario.steps[0].input : null };
      hostRequestPayloads.set(item.caseId, Object.freeze(payload));
      const tests = scenario.assertions.map((assertion, assertionIndex) => ({ assertionIndex, assertionDigest: item.assertionDigests[assertionIndex], assertion }));
      if (tests.some((assertion) => assertion.assertionDigest === undefined) || tests.length !== item.assertionDigests.length) throw new Error("every approved assertion must map to exactly one ordered digest");
      const observationCall = registration.purpose === "source-interface" ? "observation.inspectContract" : "observation.request";
      return `test(${JSON.stringify(title)}, { platforms: [${JSON.stringify(`contract-${item.targetId.slice("contract-".length)}`)}], timeout: ${Math.min(input.caseTimeoutMs, input.runTimeoutMs)}, retries: 0 }, async () => { const response = await ${observationCall}(${JSON.stringify(payload)}); ${tests.map((assertion) => `await observation.assertion(${JSON.stringify({ ...assertion, caseId: item.caseId, bundleDigest: input.bundleDigest })}, response);`).join(" ")} });`;
    }),
  ].join("\n");
  const config = JSON.stringify({ projectId: "rovara-contract-p0", tests: [E2E_GENERATED_TEST_PATH], targets: input.group.targetIds.map((targetId) => ({ name: `contract-${targetId.slice("contract-".length)}`, platform: `contract-${targetId.slice("contract-".length)}` })), workers: 1, retries: 0, timeout: Math.min(input.caseTimeoutMs, input.runTimeoutMs), trace: "off", video: "off", cache: "off" }, null, 2) + "\n";
  const configObject = JSON.parse(config) as { projectId: string; tests: string[]; targets: { name: string; platform: string }[]; workers: number; retries: number; timeout: number; cache: "off" };
  const expectedConfigDigest = expectedE2EConfigDigest(configObject);
  const packetBytes = JSON.stringify(packet, null, 2) + "\n";
  const files = new Map<string, string>([[E2E_GENERATED_TEST_PATH, generatedTest], [E2E_GENERATED_CONFIG_PATH, config], [E2E_SELECTION_PACKET_PATH, packetBytes]]);
  const inventoryFiles = [...files].map(([path, content]): E2ECompiledFile => Object.freeze({ path, sha256: sha256(content), byteLength: Buffer.byteLength(content), role: path === E2E_GENERATED_TEST_PATH ? "test" : path === E2E_GENERATED_CONFIG_PATH ? "config" : "selection-packet" }));
  const inventoryBody = { schemaVersion: 1 as const, compilerProtocol: "trusted-e2e-compiler/v1" as const, upstream: { package: "e2e" as const, version: "0.20.0" as const, idAlgorithm: "e2e-0.20.0-test-id-result-id/v1" as const, configDigestAlgorithm: "e2e-0.20.0-sanitized-config/v1" as const, expectedConfigDigest }, files: inventoryFiles };
  const inventory: E2ECompiledInventory = Object.freeze({ ...inventoryBody, files: Object.freeze(inventoryFiles), digest: sha256(canonicalJson(inventoryBody)) });
  return { files, inventory, caseBindings, expectedConfigDigest, hostRequestPayloads };
}

function validateRegistration(item: E2EOperationRegistration): void {
  if (!(item.packageExportSubpath === "." || /^\.\/[A-Za-z0-9_./-]{1,160}$/.test(item.packageExportSubpath)) || item.packageExportSubpath.includes("..")) throw new Error("package export subpath is unsafe");
  if (!/^\.{1,2}\/[^\0\\]{1,512}$/.test(item.moduleSpecifier) || item.moduleSpecifier.split("/").some((part) => part === "..")) throw new Error("module source reference is unsafe");
  if (item.purpose === "feature-invocation" && item.callableSelector === null) throw new Error("feature invocation requires an explicit selector");
  if (item.purpose === "source-interface" && item.callableSelector !== null) throw new Error("source-interface inspection cannot bind an invocation selector");
  if (item.callableSelector?.kind === "named" && !/^[A-Za-z_$][A-Za-z0-9_$]{0,62}$/.test(item.callableSelector.exportName)) throw new Error("named callable selector is invalid");
}
