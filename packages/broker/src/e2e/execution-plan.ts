import { createHash } from "node:crypto";
import {
  E2EExecutionPlanSchema, E2EPolicySchema, E2EScenarioSchema, e2eExecutionPlanDigest, canonicalJson, verifyE2ESourceSnapshot,
  type CandidateManifest, type E2EExecutionPlan, type E2EPolicy, type E2ERuntimeAvailability, type E2EScenario, type E2ESourceSnapshot,
  type E2EExpectedCase, type E2EMockSpec,
} from "@agentx/contracts";
import { inspectE2ERepository, portableOperationId, type PortableOperation } from "./discovery.js";

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
const validPortableSemantics = (scenario: E2EScenario, operation: PortableOperation | undefined, targetKind: string) =>
  (targetKind === "web" || targetKind === "api")
    && operation !== undefined && scenario.steps.length === 1 && scenario.steps[0]?.kind === "invoke-contract"
    && scenario.steps[0].operationId === operation.operationId
    && scenario.assertions.length > 0 && scenario.assertions.every(supportedPortableAssertion);

type JsonObject = Record<string, unknown>;
function isObject(value: unknown): value is JsonObject { return value !== null && typeof value === "object" && !Array.isArray(value); }
type JsonSchemaDescriptor = { type: string; properties?: Record<string, JsonSchemaDescriptor>; required?: string[]; items?: JsonSchemaDescriptor; enum?: unknown[]; format?: string; minimum?: number; maximum?: number; minLength?: number; maxLength?: number; minItems?: number; maxItems?: number; additionalProperties?: false };
function supportedJsonSchema(value: unknown, depth = 0, budget = { nodes: 0 }): JsonSchemaDescriptor | undefined {
  if (!isObject(value) || depth > 16 || ++budget.nodes > 256) return undefined;
  const allowed = new Set(["type", "properties", "required", "items", "enum", "format", "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems", "additionalProperties"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return undefined;
  const type = value.type;
  if (!(["object", "array", "string", "number", "integer", "boolean"] as unknown[]).includes(type)) return undefined;
  const out: JsonSchemaDescriptor = { type: type as string };
  if (value.enum !== undefined) {
    if (!Array.isArray(value.enum) || value.enum.length === 0 || value.enum.length > 32 || value.enum.some((item) => item === null || !["string", "number", "boolean"].includes(typeof item))) return undefined;
    if (value.enum.some((item) => type === "string" ? typeof item !== "string" : type === "boolean" ? typeof item !== "boolean" : type === "integer" ? typeof item !== "number" || !Number.isInteger(item) : type === "number" ? typeof item !== "number" : true)) return undefined;
    out.enum = value.enum;
  }
  if (value.format !== undefined) {
    if (type !== "string" || typeof value.format !== "string" || !["date", "date-time", "email", "uuid"].includes(value.format)) return undefined;
    out.format = value.format;
  }
  for (const key of ["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"] as const) {
    const bound = value[key];
    if (bound !== undefined) {
      const lengthBound = key === "minLength" || key === "maxLength";
      const itemBound = key === "minItems" || key === "maxItems";
      const numberBound = key === "minimum" || key === "maximum";
      if (typeof bound !== "number" || !Number.isFinite(bound) || Math.abs(bound) > 1_000_000 || lengthBound && type !== "string" || itemBound && type !== "array" || numberBound && !["number", "integer"].includes(type as string) || (lengthBound || itemBound) && (!Number.isInteger(bound) || bound < 0)) return undefined;
      out[key] = bound;
    }
  }
  if (typeof out.minimum === "number" && typeof out.maximum === "number" && out.minimum > out.maximum) return undefined;
  if (typeof out.minLength === "number" && typeof out.maxLength === "number" && out.minLength > out.maxLength) return undefined;
  if (typeof out.minItems === "number" && typeof out.maxItems === "number" && out.minItems > out.maxItems) return undefined;
  if (value.additionalProperties !== undefined) {
    if (value.additionalProperties !== false) return undefined;
    out.additionalProperties = false;
  }
  if (type === "object") {
    if (!isObject(value.properties) || Object.keys(value.properties).length > 32) return undefined;
    const properties: Record<string, JsonSchemaDescriptor> = {};
    for (const [name, child] of Object.entries(value.properties)) {
      if (name.length === 0 || name.length > 120) return undefined;
      const parsed = supportedJsonSchema(child, depth + 1, budget);
      if (parsed === undefined) return undefined;
      properties[name] = parsed;
    }
    if (value.required !== undefined && (!Array.isArray(value.required) || value.required.length > 32 || value.required.some((name) => typeof name !== "string" || !(name in properties)) || new Set(value.required).size !== value.required.length)) return undefined;
    out.properties = properties;
    if (Array.isArray(value.required)) out.required = value.required as string[];
  } else if (type === "array") {
    const items = supportedJsonSchema(value.items, depth + 1, budget);
    if (items === undefined) return undefined;
    out.items = items;
  } else if (value.properties !== undefined || value.required !== undefined || value.items !== undefined || value.additionalProperties !== undefined) return undefined;
  return out;
}

type OpenApiFixtureDescriptor = { version: "openapi-json-fixture-v1"; semantics: "schema-defaults-v1"; operations: Array<{ operationId: string; method: string; path: string; requestSchema: JsonSchemaDescriptor | null; responses: Array<{ status: number; schema: JsonSchemaDescriptor }> }> };
function openApiFixtureDescriptor(bytes: Uint8Array): OpenApiFixtureDescriptor | undefined {
  let document: unknown;
  try { document = JSON.parse(Buffer.from(bytes).toString("utf8")); } catch { return undefined; }
  if (!isObject(document) || typeof document.openapi !== "string" || !/^3\.(?:0|1)\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(document.openapi) || !isObject(document.info) || typeof document.info.title !== "string" || document.info.title.length === 0 || typeof document.info.version !== "string" || document.info.version.length === 0 || !isObject(document.paths)) return undefined;
  const pathEntries = Object.entries(document.paths);
  if (pathEntries.length === 0 || pathEntries.length > 64) return undefined;
  const operations: OpenApiFixtureDescriptor["operations"] = [];
  const methodSet = new Set(["get", "post", "put", "patch", "delete"]);
  for (const [path, pathItem] of pathEntries) {
    if (!path.startsWith("/") || path.length > 512 || path.includes("..") || !isObject(pathItem)) return undefined;
    const methodEntries = Object.entries(pathItem).filter(([key]) => methodSet.has(key.toLowerCase()));
    if (methodEntries.length === 0 || Object.keys(pathItem).some((key) => !methodSet.has(key.toLowerCase()) && !["summary", "description", "parameters", "servers"].includes(key))) return undefined;
    for (const [rawMethod, rawOperation] of methodEntries) {
      if (!isObject(rawOperation) || !isObject(rawOperation.responses)) return undefined;
      const method = rawMethod.toUpperCase();
      const operationId = typeof rawOperation.operationId === "string" && /^[A-Za-z0-9_.:-]{1,120}$/.test(rawOperation.operationId) ? rawOperation.operationId : `${method} ${path}`;
      let requestSchema: JsonSchemaDescriptor | null = null;
      if (rawOperation.requestBody !== undefined) {
        if (!isObject(rawOperation.requestBody) || rawOperation.requestBody.required !== undefined && typeof rawOperation.requestBody.required !== "boolean" || !isObject(rawOperation.requestBody.content) || !isObject(rawOperation.requestBody.content["application/json"])) return undefined;
        const parsedRequestSchema = supportedJsonSchema(rawOperation.requestBody.content["application/json"].schema);
        if (parsedRequestSchema === undefined) return undefined;
        requestSchema = parsedRequestSchema;
      }
      if (rawOperation.parameters !== undefined) {
        if (!Array.isArray(rawOperation.parameters) || rawOperation.parameters.length > 32) return undefined;
        for (const parameter of rawOperation.parameters) {
          if (!isObject(parameter) || typeof parameter.name !== "string" || !["path", "query", "header", "cookie"].includes(String(parameter.in)) || parameter.required !== undefined && typeof parameter.required !== "boolean" || supportedJsonSchema(parameter.schema) === undefined) return undefined;
        }
      }
      const responses: OpenApiFixtureDescriptor["operations"][number]["responses"] = [];
      for (const [statusText, response] of Object.entries(rawOperation.responses)) {
        if (!/^2\d\d$/.test(statusText)) continue;
        if (!isObject(response) || !isObject(response.content) || !isObject(response.content["application/json"])) return undefined;
        const responseSchema = supportedJsonSchema(response.content["application/json"].schema);
        if (responseSchema === undefined) return undefined;
        responses.push({ status: Number(statusText), schema: responseSchema });
      }
      if (responses.length === 0) return undefined;
      operations.push({ operationId, method, path, requestSchema, responses });
    }
  }
  if (new Set(operations.map((operation) => operation.operationId)).size !== operations.length) return undefined;
  // Later compilers consume this registered fixture algorithm: choose the lowest 2xx response,
  // recursively emit required-object fields, use the first enum value, and otherwise use the
  // deterministic type defaults defined by schema-defaults-v1. These are mock values, not product expectations.
  return { version: "openapi-json-fixture-v1", semantics: "schema-defaults-v1", operations };
}

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
      if (requestedTarget === undefined || requestedTarget.accountProfileId !== scenario.accountProfileId) throw new Error("scenario target or account profile is not configured");
      const criterionId = stableId("criterion-", [scenario.requirementId, scenario.scenarioId, requestedTargetId]);
      const criterion = { criterionId, requirementId: scenario.requirementId, scenarioId: scenario.scenarioId, requestedTargetId,
        required, minimumEvidence: scenario.minimumEvidence, requiredRealComponentIds: [...scenario.requiredRealComponentIds], expectedCaseIds: [] as string[] };
      criteria.push(criterion);
      const sourceOperation = scenario.steps[0]?.kind === "invoke-contract" ? portableById.get(scenario.steps[0].operationId) : undefined;
      let unavailableReason: string | undefined;
      if (!sandboxUsable) unavailableReason = "approved qualified default sandbox is unavailable or model route is not disabled";
      else if (requestedTarget.applicationId !== sourceOperation?.applicationId || !sourceOperation.targetIds.includes(requestedTargetId)) unavailableReason = "no source-derived portable operation is bound to this requested target";
      else if (!validPortableSemantics(scenario, sourceOperation, requestedTarget.kind)) unavailableReason = "requested steps, assertions, evidence scope, target kind, or agent semantics are not in the supported portable contract profile";
      const criterionMocks: E2EMockSpec[] = [];
      let fixtureUnavailableReason: string | undefined;
      if (!unavailableReason) for (const componentId of scenario.requiredRealComponentIds) {
        const edge = inspection.dependencyEdges.find((candidate) => candidate.toComponentId === componentId && candidate.fromApplicationId === requestedTarget.applicationId);
        const descriptor = input.mockableComponents?.find((candidate) => candidate.componentId === componentId && candidate.requestedTargetId === requestedTargetId);
        const schemaPath = edge?.sourcePaths.find((path) => /(^|\/)(?:openapi|swagger)\.json$/i.test(path));
        const source = schemaPath ? input.sourceSnapshot.sources.find((item) => item.path === schemaPath) : undefined;
        const fixture = source === undefined ? undefined : openApiFixtureDescriptor(source.bytes);
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
      const tuple = { scenario, requestedTargetId, effectiveTargetId, accountProfileId: scenario.accountProfileId, minimumEvidence: scenario.minimumEvidence,
        requiredRealComponentIds: [...scenario.requiredRealComponentIds], agentId: "default", repeat: 0, assertionDigests, assertionDigest };
      const caseId = portableE2ECaseId(tuple);
      const expected: E2EExpectedCase = { caseId, criterionId, scenarioId: scenario.scenarioId, upstreamTestId: portableE2EUpstreamTestId(tuple),
        targetId: effectiveTargetId, requestedTargetId, agentId: "default", repeat: 0, assertionDigest, assertionDigests,
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
  return E2EExecutionPlanSchema.parse({ ...base, digest: e2eExecutionPlanDigest(base as unknown as E2EExecutionPlan) });
}
