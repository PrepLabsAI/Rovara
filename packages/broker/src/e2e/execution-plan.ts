import { createHash } from "node:crypto";
import {
  E2EExecutionPlanSchema, E2EPolicySchema, E2EScenarioSchema, e2eExecutionPlanDigest, canonicalJson,
  type E2EExecutionPlan, type E2EPolicy, type E2ERuntimeAvailability, type E2EScenario,
  type E2EExpectedCase, type E2EMockSpec,
} from "@agentx/contracts";

const TRUSTED_CONTRACT_ADAPTERS = Object.freeze({
  api: "api-contract-v1",
  database: "database-contract-v1",
  queue: "queue-contract-v1",
  identity: "identity-contract-v1",
  "device-service": "portable-device-contract-v1",
  "os-service": "portable-os-contract-v1",
  model: "model-unavailable-v1",
  driver: "driver-unavailable-v1",
} as const);
export const PORTABLE_E2E_TEST_PATH = ".agentx/e2e/generated-contract.test.ts";
type MockableComponent = { componentId: string; requestedTargetId: string; kind: keyof typeof TRUSTED_CONTRACT_ADAPTERS; sourceRefs: Array<{ path: string; sha256: string }> };
type VerifiedSource = { path: string; sha256: string; bytes: Uint8Array };
type PortableOperation = { applicationId: string; targetIds: readonly string[]; manifestPath: string; exportName: string; operationId: string; sourceRefs: readonly { path: string; sha256: string }[] };
export type E2EPlanSelectionInput = {
  candidateDigest: string;
  planDigest: string;
  policy: E2EPolicy;
  scenarios: E2EScenario[];
  selectedTargetIds: string[];
  sandboxAvailability: (E2ERuntimeAvailability & { targetId: "default-sandbox" }) | null;
  runtimeAvailability: E2ERuntimeAvailability[];
  verifiedSources: VerifiedSource[];
  portableOperations: PortableOperation[];
  mockableComponents?: MockableComponent[];
};
const hex = (value: string) => createHash("sha256").update(value).digest("hex");
const stableId = (prefix: string, value: unknown, length = 32) => prefix + hex(canonicalJson(value)).slice(0, length);
/** Compiler-stable upstream test identity; generated titles contain only a tuple digest, never scenario text. */
export function portableE2EUpstreamTestId(identity: readonly unknown[]): string {
  return `${PORTABLE_E2E_TEST_PATH}::case-${hex(canonicalJson(identity))}`;
}
function validSourceIndex(sources: readonly VerifiedSource[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const source of sources) {
    if (source.bytes.byteLength > 512 * 1024 || createHash("sha256").update(source.bytes).digest("hex") !== source.sha256 || index.has(source.path)) throw new Error("planner received an unverified source snapshot");
    index.set(source.path, source.sha256);
  }
  return index;
}

export function selectE2EExecutionPlan(input: E2EPlanSelectionInput): E2EExecutionPlan {
  const policy = E2EPolicySchema.parse(input.policy);
  if (!/^[a-f0-9]{64}$/.test(input.candidateDigest) || !/^[a-f0-9]{64}$/.test(input.planDigest)) throw new Error("candidate and approved plan digests are required");
  if (input.scenarios.length === 0) throw new Error("at least one approved scenario is required");
  const scenarios = input.scenarios.map((scenario) => E2EScenarioSchema.parse(scenario));
  const sources = validSourceIndex(input.verifiedSources);
  const requestedTargets = new Map(policy.targets.map((target) => [target.targetId, target]));
  if (new Set(input.selectedTargetIds).size !== input.selectedTargetIds.length || input.selectedTargetIds.some((id) => !requestedTargets.has(id))) throw new Error("selected targets must be unique configured target IDs");
  const sandbox = input.sandboxAvailability;
  const sandboxUsable = sandbox !== null && sandbox.targetId === "default-sandbox"
    && sandbox.profileId === policy.defaultSandboxProfileId && sandbox.connection === "connected"
    && sandbox.approval === "approved" && sandbox.qualification === "qualified";
  const criteria: E2EExecutionPlan["criteria"] = [];
  const expectedByTarget = new Map<string, E2EExpectedCase[]>();
  const unavailableCriteria: E2EExecutionPlan["unavailableCriteria"] = [];
  const mockSpecs: E2EMockSpec[] = [];
  const sourceBytes = new Map(input.verifiedSources.map((source) => [source.path, Buffer.from(source.bytes).toString("utf8")]));
  const operations = input.portableOperations.filter((operation) => {
    if (!/^[a-z][a-z0-9._:-]{0,119}$/i.test(operation.operationId) || operation.operationId !== operation.exportName.replace(/^\./, "module-").slice(0, 120)) return false;
    if (sources.get(operation.manifestPath) === undefined || operation.sourceRefs.length !== 1 || operation.sourceRefs.some((ref) => sources.get(ref.path) !== ref.sha256)) return false;
    try {
      const manifest = JSON.parse(sourceBytes.get(operation.manifestPath) ?? "null") as { name?: unknown; exports?: unknown };
      const exportPath = manifest.exports !== null && typeof manifest.exports === "object" && !Array.isArray(manifest.exports)
        ? (manifest.exports as Record<string, unknown>)[operation.exportName] : undefined;
      if (manifest.name !== operation.applicationId || typeof exportPath !== "string" || !exportPath.startsWith("./")) return false;
      const dir = operation.manifestPath.includes("/") ? operation.manifestPath.slice(0, operation.manifestPath.lastIndexOf("/")) : ".";
      const expectedPath = dir === "." ? exportPath.slice(2) : dir + "/" + exportPath.slice(2);
      return operation.sourceRefs[0]?.path === expectedPath;
    } catch { return false; }
  });
  const selected = new Set(input.selectedTargetIds);
  const baseline = new Set(policy.baselineScenarioIds);
  const maxCases = 64;
  for (const scenario of scenarios) {
    if (!scenario.required && !baseline.has(scenario.scenarioId) && !scenario.requestedTargetIds.some((targetId) => selected.has(targetId))) continue;
    for (const requestedTargetId of scenario.requestedTargetIds) {
      const required = scenario.required || baseline.has(scenario.scenarioId);
      if (!required && !selected.has(requestedTargetId)) continue;
      const requestedTarget = requestedTargets.get(requestedTargetId);
      if (requestedTarget === undefined || requestedTarget.accountProfileId !== scenario.accountProfileId) throw new Error("scenario target or account profile is not configured");
      const criterionId = stableId("criterion-", [scenario.scenarioId, requestedTargetId], 28);
      const criterion = {
        criterionId, requirementId: scenario.requirementId, scenarioId: scenario.scenarioId, requestedTargetId,
        required, minimumEvidence: scenario.minimumEvidence, requiredRealComponentIds: [...scenario.requiredRealComponentIds], expectedCaseIds: [] as string[],
      };
      criteria.push(criterion);
      const sourceOperation = operations.find((operation) => operation.applicationId === requestedTarget.applicationId && operation.targetIds.includes(requestedTargetId));
      if (!sandboxUsable) {
        unavailableCriteria.push({ criterionId, reason: "approved qualified default sandbox is unavailable" });
        continue;
      }
      if (sourceOperation === undefined) {
        unavailableCriteria.push({ criterionId, reason: "no supported portable candidate operation is bound to this requested target" });
        continue;
      }
      let mocksValid = true;
      for (const componentId of scenario.requiredRealComponentIds) {
        const component = input.mockableComponents?.find((item) => item.componentId === componentId && item.requestedTargetId === requestedTargetId);
        if (component === undefined) continue;
        const profile = TRUSTED_CONTRACT_ADAPTERS[component.kind];
        const refsValid = component.sourceRefs.length > 0 && component.sourceRefs.every((ref) => sources.get(ref.path) === ref.sha256);
        if (!refsValid || profile === undefined) { mocksValid = false; break; }
        mockSpecs.push({
          componentId, requestedTargetId, effectiveTargetId: "contract-" + requestedTargetId,
          kind: component.kind, contractDigest: hex(canonicalJson({ profile, sourceRefs: component.sourceRefs })),
          fixtureVersion: profile, sourceRefs: component.sourceRefs, reason: "phase-unavailable",
        });
      }
      if (!mocksValid) {
        unavailableCriteria.push({ criterionId, reason: "mock adapter source binding is not in the verified snapshot" });
        continue;
      }
      const effectiveTargetId = "contract-" + requestedTargetId;
      const assertionDigest = hex(canonicalJson(scenario.assertions));
      const caseIdentity = [scenario.scenarioId, requestedTargetId, effectiveTargetId, assertionDigest];
      const caseId = stableId("case-", caseIdentity, 32);
      const expected: E2EExpectedCase = {
        caseId, criterionId, scenarioId: scenario.scenarioId,
        upstreamTestId: portableE2EUpstreamTestId(caseIdentity),
        targetId: effectiveTargetId, requestedTargetId, agentId: "default",
        repeat: 0, assertionDigest, required, minimumEvidence: scenario.minimumEvidence,
        requiredRealComponentIds: [...scenario.requiredRealComponentIds],
      };
      criterion.expectedCaseIds.push(caseId);
      const grouped = expectedByTarget.get(effectiveTargetId) ?? [];
      grouped.push(expected);
      expectedByTarget.set(effectiveTargetId, grouped);
    }
  }
  if (criteria.length === 0) throw new Error("target selection produced no approved verification criteria");
  if (criteria.length > maxCases) throw new Error("approved scenario and target expansion exceeds 64 criteria");
  const targets: E2EExecutionPlan["effectiveTargets"] = [];
  const groups: E2EExecutionPlan["groups"] = [];
  const eligibleTargets = [...expectedByTarget.keys()].sort();
  for (let offset = 0; offset < eligibleTargets.length; offset += 3) {
    const targetIds = eligibleTargets.slice(offset, offset + 3);
    const groupCases = targetIds.flatMap((targetId) => expectedByTarget.get(targetId) ?? []);
    if (groups.length >= 4 || groups.reduce((sum, group) => sum + group.expectedCases.length, 0) + groupCases.length > maxCases) {
      for (const expected of groupCases) {
        const criterion = criteria.find((item) => item.criterionId === expected.criterionId);
        if (criterion) { criterion.expectedCaseIds = []; unavailableCriteria.push({ criterionId: criterion.criterionId, reason: "execution group budget exceeded" }); }
      }
      continue;
    }
    for (const requestedTargetId of targetIds.map((id) => id.slice("contract-".length))) {
      const requested = requestedTargets.get(requestedTargetId)!;
      const profile = requested.kind === "api" ? "api-contract-v1" : "portable-contract-v1";
      targets.push({ targetId: "contract-" + requestedTargetId, applicationId: requested.applicationId, runtimeProfileId: profile, accountProfileId: requested.accountProfileId, kind: "contract", requestedTargetId, adapterProfileId: profile });
    }
    const specs = mockSpecs.filter((mock) => targetIds.includes(mock.effectiveTargetId));
    const mode = "mock-only" as const;
    groups.push({
      groupId: stableId("group-", [mode, policy.defaultSandboxProfileId, targetIds], 24),
      targetIds, runtimeProfileId: policy.defaultSandboxProfileId, mode,
      mockManifestDigest: hex(canonicalJson(specs)), expectedCases: groupCases,
    });
  }
  const unavailableUnique = [...new Map(unavailableCriteria.map((item) => [item.criterionId, item])).values()];
  const base = { schemaVersion: 1 as const, digest: "0".repeat(64), candidateDigest: input.candidateDigest, planDigest: input.planDigest, criteria, effectiveTargets: targets, groups, mocks: mockSpecs, unavailableCriteria: unavailableUnique };
  return E2EExecutionPlanSchema.parse({ ...base, digest: e2eExecutionPlanDigest(base as unknown as E2EExecutionPlan) });
}

