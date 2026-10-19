import { createHash, randomUUID } from "node:crypto";
import { canonicalJson, E2EAppRecipeSchema, E2ERunBindingSchema, e2eApplicationPreparedEnvironmentDigest,
  E2EApplicationHostPreparationBindingSchema, E2EApplicationPreparedEnvironmentSchema, E2EApplicationServiceContractSchema,
  E2EApplicationProjectContractSchema, E2EApplicationAccountDefinitionSchema, E2EApplicationEvidenceRefSchema,
  E2EApplicationExternalConnectionRefSchema,
  e2eApplicationAccountDefinitionDigest, validateE2EApplicationAccountBinding,
  type E2EApplicationHostPreparationBinding, type E2EApplicationPreparedEnvironment,
  type E2EApplicationServicePorts, type E2EApplicationNetworkPorts, type E2EApplicationExternalConnectionRef,
  type E2EApplicationAccountDefinition, type E2EApplicationProjectContract, type E2EAppRecipe, type E2ERunBinding,
  type E2EApplicationSupervisorPorts, type E2ERunInput, type ProjectSetupRunnerToolchain,
} from "@agentx/contracts";
import { validateE2EApplicationNetworkRoutes } from "./application-network.js";
import { e2eBindingDigest, e2ePolicyDigest, E2EExpectedCaseSchema, E2ERoundSchema, E2EScenarioSchema, E2ERuntimeAccountRefSchema,
  type E2EExpectedCase, type E2ERound, type E2EScenario, type E2ERuntimeAccountRef } from "@agentx/contracts";
import type { E2EApplicationCliLaunchContext } from "./application-runtime-bootstrap.js";
import type { E2EApplicationRuntimePorts } from "./application-runtime.js";
import type { E2ECompiledApplicationSuite } from "./application-scenarios.js";
import { E2EAssertionSchema } from "@agentx/contracts";
import { E2EMockSpecSchema, type E2EMockSpec } from "@agentx/contracts";
import { E2EApplicationAccountIdentityProjectionSchema, E2EApplicationObservationBindingSchema, E2EApplicationProofBytesSchema,
  E2EApplicationSubjectIdentityProjectionSchema, E2EApplicationCaseCaptureSchema,
  type E2EApplicationObservationBinding, type E2EApplicationProofBytes, type E2EApplicationCaseCapture } from "./application-result-adapter.js";

const sha = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const equal = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);

function strictCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cell = ""; let quoted = false; let afterQuote = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { cell += '"'; index += 1; }
      else if (char === '"') { quoted = false; afterQuote = true; }
      else cell += char;
    } else if (afterQuote) {
      if (char === ",") { row.push(cell); cell = ""; afterQuote = false; }
      else if (char === "\n" || char === "\r") { row.push(cell); rows.push(row); row = []; cell = ""; afterQuote = false; if (char === "\r" && text[index + 1] === "\n") index += 1; }
      else throw new Error("CSV has bytes after a closed quoted field");
    } else if (char === '"' && cell.length === 0) quoted = true;
    else if (char === '"') throw new Error("CSV quote begins inside an unquoted field");
    else if (char === ",") { row.push(cell); cell = ""; }
    else if (char === "\n" || char === "\r") { row.push(cell); rows.push(row); row = []; cell = ""; if (char === "\r" && text[index + 1] === "\n") index += 1; }
    else cell += char;
    if (rows.length > 10_001 || row.length > 256 || cell.length > 8192) throw new Error("CSV exceeds the fixed structural bound");
  }
  if (quoted) throw new Error("CSV has an unterminated quoted field");
  if (cell.length > 0 || row.length > 0 || afterQuote) { row.push(cell); rows.push(row); }
  if (rows.some((item) => item.length !== rows[0]?.length)) throw new Error("CSV rows do not have one exact column count");
  return rows;
}

function schemaSupported(value: unknown, depth = 0): value is Record<string, unknown> {
  if (depth > 16 || !value || typeof value !== "object" || Array.isArray(value)) return false;
  const schema = value as Record<string, unknown>;
  const allowed = new Set(["type", "required", "properties", "additionalProperties", "items", "enum"]);
  if (Object.keys(schema).some((key) => !allowed.has(key)) || !["object", "array", "string", "number", "integer", "boolean", "null"].includes(String(schema.type))) return false;
  if (schema.type === "object") {
    if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== "string"))) return false;
    if (schema.properties !== undefined && (!schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties)
      || Object.values(schema.properties).some((child) => !schemaSupported(child, depth + 1)))) return false;
    if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") return false;
  } else if (schema.required !== undefined || schema.properties !== undefined || schema.additionalProperties !== undefined) return false;
  if (schema.type === "array") { if (schema.items !== undefined && !schemaSupported(schema.items, depth + 1)) return false; }
  else if (schema.items !== undefined) return false;
  return schema.enum === undefined || Array.isArray(schema.enum);
}
function schemaMatches(value: unknown, schema: Record<string, unknown>): boolean {
  const type = schema.type;
  const matches = type === "object" ? !!value && typeof value === "object" && !Array.isArray(value)
    : type === "array" ? Array.isArray(value) : type === "string" ? typeof value === "string"
      : type === "number" ? typeof value === "number" && Number.isFinite(value)
        : type === "integer" ? typeof value === "number" && Number.isSafeInteger(value)
          : type === "boolean" ? typeof value === "boolean" : type === "null" ? value === null : false;
  if (!matches) return false;
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => canonicalJson(candidate) === canonicalJson(value))) return false;
  if (type === "object") {
    const object = value as Record<string, unknown>; const properties = (schema.properties ?? {}) as Record<string, unknown>;
    if (Array.isArray(schema.required) && schema.required.some((key) => !Object.hasOwn(object, key as string))) return false;
    if (schema.additionalProperties === false && Object.keys(object).some((key) => !Object.hasOwn(properties, key))) return false;
    return Object.entries(properties).every(([key, child]) => !Object.hasOwn(object, key) || schemaMatches(object[key], child as Record<string, unknown>));
  }
  return type !== "array" || !schema.items || (value as unknown[]).every((item) => schemaMatches(item, schema.items as Record<string, unknown>));
}

/** Pure same-input evaluator used by both fixed runtime adapters before reporting a causal outcome. */
export function evaluateE2EApplicationRawAssertion(input: { assertion: unknown; bytes?: Uint8Array; status?: number; downloadName?: string; schemaBytes?: Uint8Array }): { supported: boolean; passed: boolean; value: unknown } {
  const assertion = E2EAssertionSchema.parse(input.assertion);
  if (assertion.kind === "csv") {
    if (!(input.bytes instanceof Uint8Array) || input.downloadName === undefined) return { supported: false, passed: false, value: null };
    try {
      const rows = strictCsv(new TextDecoder("utf-8", { fatal: true }).decode(input.bytes));
      const [columns, ...data] = rows;
      const value = { columns: columns ?? [], rows: data, downloadName: input.downloadName };
      return { supported: true, passed: input.downloadName === assertion.downloadName && canonicalJson(value) === canonicalJson({ columns: assertion.columns, rows: assertion.rows, downloadName: assertion.downloadName }), value };
    } catch { return { supported: true, passed: false, value: { malformed: true } }; }
  }
  if (assertion.kind === "json") {
    if (!(input.bytes instanceof Uint8Array) || !(input.schemaBytes instanceof Uint8Array)) return { supported: false, passed: false, value: null };
    try {
      const schemaText = new TextDecoder("utf-8", { fatal: true }).decode(input.schemaBytes); const schema = JSON.parse(schemaText) as unknown;
      if (canonicalJson(schema) !== schemaText || !schemaSupported(schema)) return { supported: false, passed: false, value: null };
      const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.bytes)) as unknown;
      return { supported: true, passed: schemaMatches(value, schema) && canonicalJson(value) === canonicalJson(assertion.equals), value };
    } catch { return { supported: true, passed: false, value: { malformed: true } }; }
  }
  if (assertion.kind === "http-status") return { supported: input.status !== undefined, passed: input.status === assertion.equals, value: input.status ?? null };
  return { supported: false, passed: false, value: null };
}

/** Exact source/build identities used by preparation. These are caller-owned protected records, not worker-authored claims. */
export type E2EApplicationPreparationApplication = Readonly<{
  applicationId: string;
  projectContract: E2EApplicationProjectContract;
  recipe: E2EAppRecipe;
  buildManifestDigest: string;
  artifactSha256: string;
  sourceManifestDigest: string;
  sourceArchiveSha256: string;
}>;
export type E2EApplicationPreparationInputs = Readonly<{
  preparation: E2EApplicationHostPreparationBinding;
  applications: readonly E2EApplicationPreparationApplication[];
  approvedExternalConnectionRefs: readonly E2EApplicationExternalConnectionRef[];
  accountDefinitions: readonly E2EApplicationAccountDefinition[];
  /** Exact protected compiler/source mock descriptors; digest-only rows are not executable authority. */
  mockManifest: readonly { componentId: string; applicationId: string; originRef: string; fixtureDigest: string; mockManifestDigest: string; sourceSpec: E2EMockSpec }[];
}>;
export type E2EApplicationEnvironmentPorts = Readonly<{ services: E2EApplicationServicePorts; network: E2EApplicationNetworkPorts }>;

export type E2EApplicationCliCasePlan = Readonly<{ binding: E2ERunBinding; round: E2ERound; groupCompiledInventoryDigest: string;
  preparedEnvironmentDigest: string; expected: E2EExpectedCase; scenario: E2EScenario; runtimeAccountRef: E2ERuntimeAccountRef }>;

/** Build the shared strict observation header only from the sealed expected case and protected producer binding. */
export function createE2EApplicationAssertionObservationHeader(input: { plan: E2EApplicationCliCasePlan;
  binding: E2EApplicationObservationBinding; index: number; observedAt: string; observationId?: string }) {
  const producerBinding = input.binding.assertionProducers.find((item) => item.assertionIndex === input.index);
  if (!producerBinding || input.plan.expected.assertionDigests[input.index] === undefined) throw new Error("assertion observation has no exact protected producer or compiled assertion digest");
  return Object.freeze({ schemaVersion: "e2e-application-assertion-observation/v1" as const, caseId: input.plan.expected.caseId,
    assertionIndex: input.index, assertionDigest: input.plan.expected.assertionDigests[input.index]!,
    observationId: input.observationId ?? randomUUID(), lifecycleId: producerBinding.producer.lifecycleId, observedAt: input.observedAt,
    producer: producerBinding.producer, subject: input.binding.subject, accountContextId: input.plan.expected.accountContextId,
    accountContextDigest: input.plan.expected.accountContextDigest, sessionRef: input.binding.sessionRef, accountIdDigest: input.binding.accountIdDigest });
}

/** Construct the strict runtime-owned capture. Outer owned-resource cleanup remains pending until the supervisor proves close. */
export function createE2EApplicationCaseCaptureFrame(input: { plan: E2EApplicationCliCasePlan; launchContext: E2EApplicationCliLaunchContext;
  binding: E2EApplicationObservationBinding; upstreamRunId: string; observedAt: string; steps: E2EApplicationCaseCapture["steps"];
  assertions: E2EApplicationCaseCapture["assertions"]; artifacts: E2EApplicationCaseCapture["artifacts"];
  terminal: E2EApplicationCaseCapture["terminal"] }) {
  const { plan, binding } = input;
  return E2EApplicationCaseCaptureSchema.parse({ schemaVersion: "e2e-application-case-capture/v1", caseId: plan.expected.caseId,
    upstreamRunId: input.upstreamRunId, shardId: input.launchContext.shardId, roundId: plan.round.roundId, runId: plan.binding.runId,
    groupId: plan.binding.groupId, candidateDigest: plan.binding.candidateDigest, applicationId: plan.runtimeAccountRef.applicationId,
    buildManifestDigest: binding.selectedArtifact.buildManifestDigest, runtimeManifestDigest: binding.caseProducer.runtimeManifestDigest,
    executionDescriptorDigest: plan.expected.executionDescriptorDigest, accountContextId: plan.expected.accountContextId,
    accountContextDigest: plan.expected.accountContextDigest, observedAt: input.observedAt, lifecycleId: binding.caseProducer.lifecycleId,
    subject: binding.subject, producer: binding.caseProducer, steps: input.steps, assertions: input.assertions, terminal: input.terminal,
    modelReceipts: [], artifacts: input.artifacts, coverage: { observedScope: "runtime", subject: "candidate",
      executedCandidateParts: [plan.expected.upstreamTestId], realComponentIds: [], mockedComponentIds: [], observedMockedComponentIds: [],
      unexercisedBehaviors: plan.scenario.requiredRealComponentIds }, cleanup: "pending" });
}
export type E2EApplicationCliCasePlanReader = Readonly<{ readCasePlan(input: {
  launchContext: E2EApplicationCliLaunchContext; caseId: string; upstreamTestId: string; targetId: string;
}, signal: AbortSignal): Promise<E2EApplicationCliCasePlan> }>;
export type E2EApplicationCliCaseDeclaration = Readonly<{ caseId: string; upstreamTestId: string; targetId: string; assertionBindings: readonly { index: number; kind: string; digest: string }[] }>;
export type E2EApplicationCliEvidenceKind = "case-capture" | "step-observation" | "assertion-observation" | "agent-operation"
  | "agent-operation-source" | "http-request" | "http-response" | "download" | "identity-observation" | "state-sample";
export type E2EApplicationCliEvidenceWriter = Readonly<{ recordCaseEvidence(input: {
  caseId: string; kind: E2EApplicationCliEvidenceKind; bytes: Uint8Array; mediaType: "application/json" | "text/plain" | "text/csv" | "application/octet-stream";
}, signal: AbortSignal): Promise<unknown> }>;

export type E2EApplicationProtectedCaseObservationReader = Readonly<{ readCaseObservationBinding(input: {
  launchContext: E2EApplicationCliLaunchContext; plan: E2EApplicationCliCasePlan; ownedClientRef: string;
}, signal: AbortSignal): Promise<{ observationBinding: E2EApplicationObservationBinding; upstreamRunId: string;
  identityEvidence: readonly E2EApplicationProofBytes[] }> }>;

/** Bind the protected producer/session facts to the already verified sealed case plan and actual owned client. */
export async function readValidatedE2EApplicationCaseObservation(input: {
  reader: E2EApplicationProtectedCaseObservationReader; launchContext: E2EApplicationCliLaunchContext;
  plan: E2EApplicationCliCasePlan; ownedClientRef: string; expectedSubjectKind: "browser" | "service"; signal: AbortSignal;
}): Promise<{ binding: E2EApplicationObservationBinding; upstreamRunId: string; identityEvidence: readonly E2EApplicationProofBytes[] }> {
  if (input.signal.aborted || !input.ownedClientRef || input.plan.expected.caseId === "") throw new Error("protected application observation binding is unavailable for this case or owned client");
  const raw = await input.reader.readCaseObservationBinding({ launchContext: input.launchContext, plan: input.plan, ownedClientRef: input.ownedClientRef }, input.signal);
  const binding = E2EApplicationObservationBindingSchema.parse(raw.observationBinding);
  if (!Array.isArray(raw.identityEvidence) || raw.identityEvidence.length < 3 || raw.identityEvidence.length > 4) throw new Error("protected account and subject identity evidence is incomplete or outside its exact closure bound");
  const evidence = raw.identityEvidence.map((item) => {
    const proof = E2EApplicationProofBytesSchema.parse(item); const bytes = Uint8Array.from(proof.bytes);
    if (bytes.byteLength !== proof.ref.byteLength || createHash("sha256").update(bytes).digest("hex") !== proof.ref.sha256) throw new Error("protected identity evidence bytes differ from their exact immutable reference");
    return Object.freeze({ ref: proof.ref, bytes });
  });
  const evidenceById = new Map<string, E2EApplicationProofBytes>();
  for (const proof of evidence) {
    const prior = evidenceById.get(proof.ref.artifactId);
    if (prior) throw new Error(canonicalJson(prior.ref) !== canonicalJson(proof.ref) || !Buffer.from(prior.bytes).equals(Buffer.from(proof.bytes))
      ? "protected identity evidence contains a conflicting duplicate reference" : "protected identity inventory repeats the same raw record instead of referencing it once");
    evidenceById.set(proof.ref.artifactId, proof);
  }
  const parseCanonical = <T>(ref: E2EApplicationObservationBinding["identityReceiptRef"], schema: { parse(value: unknown): T }): T => {
    const proof = evidenceById.get(ref.artifactId);
    if (!proof || canonicalJson(proof.ref) !== canonicalJson(ref) || ref.mediaType !== "application/json") throw new Error("protected identity projection ref is missing from the exact identity evidence inventory");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(proof.bytes); const value = JSON.parse(text) as unknown;
    if (canonicalJson(value) !== text) throw new Error("protected identity projection is not canonical UTF-8 JSON");
    return schema.parse(value);
  };
  const accountProjection = parseCanonical(binding.identityReceiptRef, E2EApplicationAccountIdentityProjectionSchema);
  const subjectProjection = parseCanonical(binding.subjectIdentityReceiptRef, E2EApplicationSubjectIdentityProjectionSchema);
  const exactInventoryIds = new Set([binding.identityReceiptRef.artifactId, binding.subjectIdentityReceiptRef.artifactId,
    accountProjection.sourceReceiptRef.artifactId, subjectProjection.sourceReceiptRef.artifactId]);
  if (evidenceById.size !== exactInventoryIds.size || [...evidenceById.keys()].some((artifactId) => !exactInventoryIds.has(artifactId))) {
    throw new Error("protected identity evidence inventory must contain only the exact two projections and their original source receipts");
  }
  for (const sourceRef of [accountProjection.sourceReceiptRef, subjectProjection.sourceReceiptRef]) {
    const source = evidenceById.get(sourceRef.artifactId);
    if (!source || canonicalJson(source.ref) !== canonicalJson(sourceRef)) throw new Error("protected identity projection's original source receipt is missing from the exact evidence inventory");
  }
  const expectedArtifact = binding.selectedArtifact;
  const lowerBound = Date.parse(input.plan.binding.admittedAt); const upperBound = Date.parse(input.plan.binding.deadlineAt);
  const identityTimes = [Date.parse(accountProjection.observedAt), Date.parse(subjectProjection.observedAt)];
  if (input.signal.aborted || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw.upstreamRunId)
    || !Number.isFinite(lowerBound) || !Number.isFinite(upperBound) || identityTimes.some((time) => !Number.isFinite(time) || time < lowerBound || time > upperBound)
    || binding.caseId !== input.plan.expected.caseId || canonicalJson(binding.accountRef) !== canonicalJson(input.plan.runtimeAccountRef)
    || binding.sessionRef.trim() === "" || !/^[a-f0-9]{64}$/.test(binding.accountIdDigest)
    || binding.caseProducer.transportCorrelationId !== input.launchContext.transportCorrelationId
    || binding.assertionProducers.some((item) => item.producer.transportCorrelationId !== input.launchContext.transportCorrelationId)
    || binding.assertionProducers.length !== input.plan.scenario.assertions.length
    || binding.assertionProducers.some((item, index) => item.assertionIndex !== index)
    || binding.subject.kind !== input.expectedSubjectKind
    || expectedArtifact.appId !== input.plan.runtimeAccountRef.applicationId
    || expectedArtifact.platform !== input.launchContext.selectedTarget.kind
    || accountProjection.caseId !== binding.caseId || subjectProjection.caseId !== binding.caseId
    || accountProjection.bindingDigest !== e2eBindingDigest(input.plan.binding) || subjectProjection.bindingDigest !== e2eBindingDigest(input.plan.binding)
    || accountProjection.upstreamRunId !== raw.upstreamRunId || subjectProjection.upstreamRunId !== raw.upstreamRunId
    || accountProjection.lifecycleId !== binding.caseProducer.lifecycleId || subjectProjection.lifecycleId !== binding.caseProducer.lifecycleId
    || [accountProjection.producer, subjectProjection.producer].some((producer) => producer.lifecycleId !== binding.caseProducer.lifecycleId
      || producer.operationId !== binding.caseProducer.operationId || producer.operationFence !== binding.caseProducer.operationFence
      || producer.transportCorrelationId !== input.launchContext.transportCorrelationId)
    || canonicalJson(accountProjection.accountRef) !== canonicalJson(binding.accountRef) || accountProjection.sessionRef !== binding.sessionRef
    || accountProjection.accountIdDigest !== binding.accountIdDigest || canonicalJson(subjectProjection.subject) !== canonicalJson(binding.subject)) {
    throw new Error("protected case observation binding differs from the exact case, account, assertion producers, subject, or selected application artifact");
  }
  return Object.freeze({ binding, upstreamRunId: raw.upstreamRunId, identityEvidence: Object.freeze(evidence) });
}

/** The child writer stores structural source material only; it never asserts trust, custody, or qualification. */
export async function recordE2EApplicationCliEvidence(input: { writer: E2EApplicationCliEvidenceWriter; caseId: string;
  kind: E2EApplicationCliEvidenceKind; bytes: Uint8Array; mediaType: "application/json" | "text/plain" | "text/csv" | "application/octet-stream"; signal: AbortSignal }) {
  const limit = input.kind === "download" ? 5 * 1024 * 1024 : 256 * 1024;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(input.caseId) || !(input.bytes instanceof Uint8Array)
    || input.bytes.byteLength === 0 || input.bytes.byteLength > limit || input.signal.aborted
    || (input.kind === "download" ? input.mediaType !== "text/csv" && input.mediaType !== "application/octet-stream"
      : input.kind === "http-response" ? input.mediaType !== "application/json" && input.mediaType !== "application/octet-stream"
        : input.kind === "assertion-observation" ? input.mediaType !== "application/json" && input.mediaType !== "text/plain" && input.mediaType !== "application/octet-stream"
          : input.mediaType !== "application/json")) throw new Error("application evidence write is outside its bounded fixed producer type");
  const bytes = Uint8Array.from(input.bytes);
  const ref = E2EApplicationEvidenceRefSchema.parse(await input.writer.recordCaseEvidence({ caseId: input.caseId, kind: input.kind, bytes, mediaType: input.mediaType }, input.signal));
  const actualDigest = createHash("sha256").update(bytes).digest("hex");
  if (ref.sha256 !== actualDigest || ref.byteLength !== bytes.byteLength || ref.mediaType !== input.mediaType) throw new Error("protected application evidence writer returned a ref that does not bind the exact immutable bytes");
  return ref;
}

/** Validate the private sealed plan again at the point of first case effect. */
export async function readValidatedE2EApplicationCliCasePlan(input: {
  reader: E2EApplicationCliCasePlanReader; launchContext: E2EApplicationCliLaunchContext;
  declaration: { preparedEnvironmentDigest: string; target: { targetId: string; app: { identity: string } | null }; cases: readonly E2EApplicationCliCaseDeclaration[] };
  caseId: string; signal: AbortSignal;
}): Promise<E2EApplicationCliCasePlan> {
  if (input.signal.aborted || Date.now() >= Date.parse(input.launchContext.deadlineAt)) throw new Error("application case plan is unavailable outside the exact live launch window");
  const declared = input.declaration.cases.find((item) => item.caseId === input.caseId);
  if (!declared || declared.targetId !== input.declaration.target.targetId) throw new Error("application case is outside its exact compiled target declaration");
  const raw = await input.reader.readCasePlan({ launchContext: input.launchContext, caseId: declared.caseId,
    upstreamTestId: declared.upstreamTestId, targetId: declared.targetId }, input.signal);
  if (input.signal.aborted || Date.now() >= Date.parse(input.launchContext.deadlineAt)) throw new Error("protected application case plan returned after its launch expired");
  const binding = E2ERunBindingSchema.parse(raw.binding); const round = E2ERoundSchema.parse(raw.round);
  const expected = E2EExpectedCaseSchema.parse(raw.expected); const scenario = E2EScenarioSchema.parse(raw.scenario);
  const runtimeAccountRef = E2ERuntimeAccountRefSchema.parse(raw.runtimeAccountRef);
  if (!/^[a-f0-9]{64}$/.test(raw.groupCompiledInventoryDigest) || !/^[a-f0-9]{64}$/.test(raw.preparedEnvironmentDigest)
    || raw.groupCompiledInventoryDigest !== input.launchContext.groupCompiledInventoryDigest
    || raw.preparedEnvironmentDigest !== input.declaration.preparedEnvironmentDigest
    || e2eBindingDigest(binding) !== input.launchContext.bindingDigest || binding.runId !== input.launchContext.runId
    || binding.roundId !== input.launchContext.roundId || round.roundId !== input.launchContext.roundId
    || round.taskId !== binding.taskId || round.operationId !== binding.operationId || round.operationFence !== binding.operationFence
    || round.workflowRevision !== binding.workflowRevision || round.admittedAt !== binding.admittedAt || round.deadlineAt !== binding.deadlineAt
    || !equal(round.groupBindings.find((item) => item.runId === binding.runId), binding)
    || binding.environmentDigest !== raw.preparedEnvironmentDigest
    || expected.caseId !== declared.caseId || expected.upstreamTestId !== declared.upstreamTestId || expected.targetId !== declared.targetId
    || !binding.expectedCases.some((item) => equal(item, expected)) || scenario.scenarioId !== expected.scenarioId
    || scenario.accountProfileId !== expected.accountProfileId || runtimeAccountRef.applicationId.trim() === ""
    || runtimeAccountRef.applicationId !== input.launchContext.selectedTarget.applicationId
    || runtimeAccountRef.profileId !== expected.accountProfileId || runtimeAccountRef.profileId !== input.launchContext.selectedTarget.accountProfileId
    || input.launchContext.selectedTarget.targetId !== declared.targetId || !scenario.requestedTargetIds.includes(expected.requestedTargetId)
    || (input.declaration.target.app !== null && runtimeAccountRef.applicationId !== input.declaration.target.app.identity)
    || canonicalJson(expected.assertionDigests) !== canonicalJson(declared.assertionBindings.map((item) => item.digest))
    || scenario.assertions.length !== declared.assertionBindings.length
    || scenario.assertions.some((assertion, index) => declared.assertionBindings[index]?.index !== index
      || declared.assertionBindings[index]?.kind !== assertion.kind
      || declared.assertionBindings[index]?.digest !== sha([assertion]))) {
    throw new Error("protected application case plan differs from the exact launch, group, target, account, scenario, or assertion declaration");
  }
  return Object.freeze({ binding, round, groupCompiledInventoryDigest: raw.groupCompiledInventoryDigest,
    preparedEnvironmentDigest: raw.preparedEnvironmentDigest, expected, scenario, runtimeAccountRef });
}

function validatedPreparationInputs(input: E2EApplicationPreparationInputs): E2EApplicationPreparationInputs {
  const preparation = E2EApplicationHostPreparationBindingSchema.parse(input.preparation);
  if (input.applications.length < 1 || input.applications.length > 12) throw new Error("application preparation requires one exact bounded application group");
  const applications = input.applications.map((item) => {
    const contract = E2EApplicationProjectContractSchema.parse(item.projectContract);
    const recipe = E2EAppRecipeSchema.parse(item.recipe);
    if (recipe.recipeDigest !== contract.recipe.recipeDigest || !equal(recipe, contract.recipe)
      || !/^[a-f0-9]{64}$/.test(item.buildManifestDigest) || !/^[a-f0-9]{64}$/.test(item.artifactSha256)
      || !/^[a-f0-9]{64}$/.test(item.sourceManifestDigest) || !/^[a-f0-9]{64}$/.test(item.sourceArchiveSha256)) {
      throw new Error("application preparation does not bind the exact source contract and approved build/artifact identities");
    }
    if ((recipe.launch.kind === "service") !== (contract.service !== null)) throw new Error("application launch recipe and source service contract disagree");
    return Object.freeze({ ...item, projectContract: contract, recipe });
  });
  if (new Set(applications.map((item) => item.applicationId)).size !== applications.length) throw new Error("application preparation contains duplicate identities");
  const approvedExternalConnectionRefs = input.approvedExternalConnectionRefs.map((item) => item);
  const accountDefinitions = input.accountDefinitions.map((item) => E2EApplicationAccountDefinitionSchema.parse(item));
  const mockManifest = input.mockManifest.map((item) => {
    const sourceSpec = E2EMockSpecSchema.parse(item.sourceSpec);
    if (sourceSpec.kind !== "api" || !sourceSpec.apiFixture || sourceSpec.componentId !== item.componentId
      || sourceSpec.requestedTargetId !== sourceSpec.effectiveTargetId
      || sourceSpec.sourceRefs.length === 0
      || sha(sourceSpec) !== item.fixtureDigest) {
      throw new Error("application mock route lacks its exact source-approved API descriptor and fixture digest");
    }
    return { componentId: item.componentId, applicationId: item.applicationId, originRef: item.originRef,
      fixtureDigest: item.fixtureDigest, mockManifestDigest: item.mockManifestDigest, sourceSpec };
  });
  if (new Set(accountDefinitions.map((item) => `${item.applicationId}\0${item.profileId}`)).size !== accountDefinitions.length) throw new Error("account definition inventory contains duplicates");
  if (new Set(mockManifest.map((item) => `${item.applicationId}\0${item.originRef}\0${item.componentId}`)).size !== mockManifest.length) throw new Error("mock route inventory contains duplicate identities");
  const applicationOwnersByOriginRef = new Map<string, Set<string>>();
  for (const application of applications) for (const route of application.projectContract.service?.originBindings ?? []) {
    const owners = applicationOwnersByOriginRef.get(route.originRef) ?? new Set<string>();
    owners.add(application.applicationId);
    applicationOwnersByOriginRef.set(route.originRef, owners);
  }
  for (const rawConnection of approvedExternalConnectionRefs) {
    const connection = E2EApplicationExternalConnectionRefSchema.parse(rawConnection);
    if ((applicationOwnersByOriginRef.get(connection.originRef)?.size ?? 0) > 1) {
      throw new Error("external origin reference has multiple source application owners in this prepared group");
    }
  }
  const serviceApplicationIds = new Set(applications.filter((item) => item.projectContract.service !== null).map((item) => item.applicationId));
  if (mockManifest.some((item) => !serviceApplicationIds.has(item.applicationId))) throw new Error("mock manifest row is foreign to every source-approved service application");
  return { preparation, applications, approvedExternalConnectionRefs, accountDefinitions, mockManifest };
}

function authorityDigest(input: E2EApplicationPreparationInputs): string {
  return sha({
    preparation: input.preparation,
    applications: input.applications.map((item) => ({ applicationId: item.applicationId, projectContract: item.projectContract,
      recipe: item.recipe, buildManifestDigest: item.buildManifestDigest, artifactSha256: item.artifactSha256,
      sourceManifestDigest: item.sourceManifestDigest, sourceArchiveSha256: item.sourceArchiveSha256 })),
    accountDefinitions: input.accountDefinitions.map((definition) => ({ definition, definitionDigest: e2eApplicationAccountDefinitionDigest(definition) })),
    approvedExternalConnectionRefs: input.approvedExternalConnectionRefs,
    mockManifest: input.mockManifest,
  });
}

/** Prepare one exact owned network and its source-approved application services before compilation. */
export async function prepareE2EApplicationEnvironment(inputRaw: E2EApplicationPreparationInputs, ports: E2EApplicationEnvironmentPorts, signal: AbortSignal): Promise<E2EApplicationPreparedEnvironment> {
  const input = validatedPreparationInputs(inputRaw);
  if (signal.aborted || Date.now() >= Date.parse(input.preparation.preparationDeadlineAt)) throw new Error("application preparation is cancelled or outside its fixed preparation window");
  const accountProfiles = new Map(input.applications.map((item) => [item.applicationId, item.projectContract.accountProfiles]));
  const serviceApplications = input.applications.filter((application) => application.projectContract.service !== null);
  for (const definition of input.accountDefinitions) {
    const contract = input.applications.find((item) => item.applicationId === definition.applicationId)?.projectContract;
    if (!contract || !contract.accountProfiles.some((profile) => profile.profileId === definition.profileId)) throw new Error("account definition is foreign to the exact source application group");
    const ref = { applicationId: definition.applicationId, profileId: definition.profileId, revision: definition.revision,
      definitionDigest: e2eApplicationAccountDefinitionDigest(definition) };
    validateE2EApplicationAccountBinding({ contract, definition, expectedRef: ref, now: new Date().toISOString() });
    const profile = contract.accountProfiles.find((item) => item.profileId === definition.profileId)!;
    if (profile.scope === "external-test" && !input.approvedExternalConnectionRefs.some((connection) => equal(connection, definition.connectionRef))) {
      throw new Error("external application account is not bound to the exact current approved named connection grant");
    }
  }
  for (const [applicationId, profiles] of accountProfiles) {
    if (!profiles.every((profile) => input.applications.find((item) => item.applicationId === applicationId)!.recipe.accountProfileIds.includes(profile.profileId))) {
      throw new Error("source account inventory differs from its approved recipe");
    }
  }
  let networkLease: { leaseId: string; originByApplicationId: readonly { applicationId: string; origin: string }[]; policyDigest: string } | undefined;
  const serviceLeases: Array<Awaited<ReturnType<E2EApplicationServicePorts["allocate"]>>> = [];
  try {
    networkLease = await ports.network.allocate({ binding: input.preparation, networkPolicyDigest: input.preparation.networkPolicyDigest,
      applications: serviceApplications, approvedExternalConnectionRefs: input.approvedExternalConnectionRefs, mockManifest: input.mockManifest }, signal);
    if (signal.aborted || Date.now() >= Date.parse(input.preparation.preparationDeadlineAt)) throw new Error("application network allocation completed outside its preparation window");
    if (networkLease.policyDigest !== input.preparation.networkPolicyDigest || networkLease.originByApplicationId.length !== serviceApplications.length
      || new Set(networkLease.originByApplicationId.map((row) => row.applicationId)).size !== serviceApplications.length) throw new Error("owned network did not return the exact service group and approved policy identity");
    const origins = new Map(networkLease.originByApplicationId.map((row) => [row.applicationId, row.origin]));
    const routeRows = serviceApplications.map((application) => ({ applicationId: application.applicationId, serviceContract: application.projectContract.service! }));
    const originByApplicationId = serviceApplications.map((application) => {
      const origin = origins.get(application.applicationId);
      if (!origin) throw new Error("owned network omitted a source application origin");
      const ownBindings = application.projectContract.service!.originBindings.filter((route) =>
        !input.mockManifest.some((mock) => mock.applicationId === application.applicationId && mock.originRef === route.originRef)
        && !input.approvedExternalConnectionRefs.some((connection) => connection.originRef === route.originRef));
      if (ownBindings.length !== 1) throw new Error("source service origins do not identify exactly one owned route distinct from named external and mock dependencies");
      return { applicationId: application.applicationId, origins: application.projectContract.service!.originBindings.map((route) => {
        const mock = input.mockManifest.find((item) => item.applicationId === application.applicationId && item.originRef === route.originRef);
        const connection = input.approvedExternalConnectionRefs.find((item) => item.originRef === route.originRef);
        return { originRef: route.originRef, origin: mock || connection ? null : origin,
          ...(mock ? { mockComponentId: mock.componentId } : {}), ...(connection ? { externalConnectionRef: connection } : {}) };
      }) };
    });
    if (serviceApplications.length > 0) validateE2EApplicationNetworkRoutes({ binding: input.preparation, applications: routeRows, originByApplicationId,
      mockManifest: input.mockManifest, approvedExternalConnectionRefs: input.approvedExternalConnectionRefs });
    for (const application of serviceApplications) {
      const contract = application.projectContract.service!;
      const allocated = await ports.services.allocate({ binding: input.preparation, application,
        recipe: application.recipe, serviceContract: E2EApplicationServiceContractSchema.parse(contract), networkLeaseId: networkLease.leaseId }, signal);
      serviceLeases.push(allocated);
      if (signal.aborted || Date.now() >= Date.parse(input.preparation.preparationDeadlineAt)) throw new Error("owned service allocation completed outside its preparation window");
      const expectedOrigin = origins.get(application.applicationId);
      if (allocated.applicationId !== application.applicationId || allocated.origin !== expectedOrigin
        || allocated.buildManifestDigest !== application.buildManifestDigest || allocated.artifactSha256 !== application.artifactSha256
        || allocated.recipeDigest !== application.recipe.recipeDigest) throw new Error("owned application service differs from the exact build, artifact, source recipe, or allocated origin");
      if (application.recipe.launch.kind !== "service") throw new Error("application service preparation received a non-service source recipe");
      const ready = await ports.services.waitReady(allocated, application.recipe.launch.health,
        input.preparation.preparationDeadlineAt, signal);
      if (ready.observedStatus !== application.recipe.launch.health.expectedStatus || Date.parse(ready.observedAt) > Date.parse(input.preparation.preparationDeadlineAt)) throw new Error("owned application service did not pass its source-bound health check before the preparation cap");
      const identity = await ports.services.observeIdentity(allocated, signal);
      if (!equal(identity.processIdentity, allocated.processIdentity) || identity.artifactSha256 !== application.artifactSha256
        || identity.buildManifestDigest !== application.buildManifestDigest || identity.recipeDigest !== application.recipe.recipeDigest) throw new Error("independent service identity readback differs from its exact current process and approved application inputs");
    }
    const networkObservation = await ports.network.observe({ leaseId: networkLease.leaseId }, signal);
    if (networkObservation.policyDigest !== input.preparation.networkPolicyDigest || networkObservation.deniedAttempts.length > 0) throw new Error("owned network readback has a policy mismatch or unexplained denied attempt before compilation");
    const preparedBody = { preparation: input.preparation, authorityDigest: authorityDigest(input), networkLeaseId: networkLease.leaseId,
      services: serviceLeases, originByApplicationId: serviceLeases.map(({ applicationId, origin }) => ({ applicationId, origin })).sort((a, b) => a.applicationId.localeCompare(b.applicationId)),
      receiptRefs: [...networkObservation.receiptRefs] };
    const prepared = { ...preparedBody, preparedDigest: e2eApplicationPreparedEnvironmentDigest(preparedBody) };
    return E2EApplicationPreparedEnvironmentSchema.parse(prepared);
  } catch (error) {
    const cleanupSignal = new AbortController().signal;
    await Promise.allSettled([...(networkLease ? [ports.network.close({ leaseId: networkLease.leaseId }, cleanupSignal)] : []),
      ...serviceLeases.map((lease) => ports.services.close(lease, cleanupSignal))]);
    throw error;
  }
}

const sealed = new Map<string, string>();
/** Seal only the already prepared leases; this function never reallocates or changes an origin. */
export async function sealE2EApplicationEnvironment(input: { prepared: E2EApplicationPreparedEnvironment; admissionDigest: string; binding: E2ERunBinding }, ports: E2EApplicationEnvironmentPorts, signal: AbortSignal): Promise<E2EApplicationPreparedEnvironment> {
  const prepared = E2EApplicationPreparedEnvironmentSchema.parse(input.prepared);
  const binding = E2ERunBindingSchema.parse(input.binding);
  if (!/^[a-f0-9]{64}$/.test(input.admissionDigest) || signal.aborted || Date.now() >= Date.parse(prepared.preparation.preparationDeadlineAt)) throw new Error("application seal is malformed, cancelled, or outside the preparation deadline");
  const p = prepared.preparation;
  if (binding.candidateDigest !== p.candidateDigest || binding.planDigest !== p.planDigest || binding.operationId !== p.operationId
    || binding.operationFence !== p.operationFence || binding.workflowRevision !== p.workflowRevision || binding.groupId !== p.groupId
    || binding.runtimeManifestDigest !== p.runtimeManifestDigest || binding.admittedAt !== p.admittedAt || binding.deadlineAt !== p.deadlineAt) {
    throw new Error("application run binding differs from the original preparation admission");
  }
  const sealKey = prepared.preparedDigest;
  const sealValue = sha({ admissionDigest: input.admissionDigest, binding });
  const prior = sealed.get(sealKey);
  if (prior) {
    if (prior !== sealValue) throw new Error("prepared application environment is already sealed to another admission");
    return prepared;
  }
  const network = await ports.network.observe({ leaseId: prepared.networkLeaseId }, signal);
  if (network.policyDigest !== p.networkPolicyDigest || network.deniedAttempts.length > 0) throw new Error("current owned network readback no longer matches the prepared admission");
  const services = [];
  for (const lease of prepared.services) {
    const identity = await ports.services.observeIdentity(lease, signal);
    if (!equal(identity.processIdentity, lease.processIdentity) || identity.artifactSha256 !== lease.artifactSha256
      || identity.buildManifestDigest !== lease.buildManifestDigest || identity.recipeDigest !== lease.recipeDigest) throw new Error("current owned service readback differs from its sealed process or artifact identity");
    services.push(lease);
  }
  if (signal.aborted || Date.now() >= Date.parse(p.preparationDeadlineAt)) throw new Error("application seal ended outside its preparation window");
  await ports.network.seal({ leaseId: prepared.networkLeaseId }, { admissionDigest: input.admissionDigest, binding }, signal);
  for (const service of services) await ports.services.seal(service, { admissionDigest: input.admissionDigest, binding }, signal);
  sealed.set(sealKey, sealValue);
  return prepared;
}

/** Build the application-specific E2ERuntimePorts from the real prepared leases and supervisor.
 * The supervisor owns allocate/execute/close facts; private application readback is deliberately
 * reachable only through readActualRun, which the outer runtime calls after confirmed close.
 */
export function createE2EApplicationRuntimePorts(input: {
  compiled: E2ECompiledApplicationSuite;
  runInput: E2ERunInput;
  prepared: E2EApplicationPreparedEnvironment;
  admissionDigest: string;
  runnerToolchain: ProjectSetupRunnerToolchain;
  accountSessionRefs: readonly string[];
  modelProxyRef: string | null;
  supervisor: E2EApplicationSupervisorPorts;
  readActualRun(signal: AbortSignal): ReturnType<E2EApplicationRuntimePorts["readActualRun"]>;
}): E2EApplicationRuntimePorts {
  const prepared = E2EApplicationPreparedEnvironmentSchema.parse(input.prepared);
  const binding = E2ERunBindingSchema.parse(input.runInput.binding);
  if (!/^[a-f0-9]{64}$/.test(input.admissionDigest) || input.accountSessionRefs.length > 32
    || input.accountSessionRefs.some((ref) => !ref.trim()) || new Set(input.accountSessionRefs).size !== input.accountSessionRefs.length
    || (input.compiled.runtimeAdmissionContext.modelRoute === null) !== (input.modelProxyRef === null)
    || (input.modelProxyRef !== null && !input.modelProxyRef.trim())) {
    throw new Error("application supervisor composition has an invalid admission, account-session, or model-proxy identity");
  }
  const preparation = prepared.preparation;
  if (prepared.preparedDigest !== input.compiled.preparedEnvironmentDigest
    || input.runInput.suite.bundle.bundleDigest !== input.compiled.bundle.bundleDigest
    || canonicalJson(input.runInput.suite.expectedCases) !== canonicalJson(input.compiled.expectedCases)
    || input.runInput.profile.profileId !== input.compiled.group.runtimeProfileId
    || input.runInput.profile.runtimeManifestDigest !== preparation.runtimeManifestDigest
    || input.runInput.profile.networkPolicyDigest !== preparation.networkPolicyDigest
    || input.compiled.runtimeBindings.get(input.compiled.group.runtimeProfileId)?.manifestDigest !== preparation.runtimeManifestDigest
    || binding.groupId !== preparation.groupId || binding.operationId !== preparation.operationId
    || binding.operationFence !== preparation.operationFence || binding.workflowRevision !== preparation.workflowRevision
    || binding.candidateDigest !== preparation.candidateDigest || binding.planDigest !== preparation.planDigest
    || binding.runtimeManifestDigest !== preparation.runtimeManifestDigest
    || binding.policyDigest !== e2ePolicyDigest(input.compiled.runtimeAdmissionContext.selectionInput.policy)
    || binding.executionPlanDigest !== input.compiled.runtimeAdmissionContext.executionPlan.digest
    || binding.bundleDigest !== input.compiled.bundle.bundleDigest
    || binding.admittedAt !== preparation.admittedAt
    || binding.deadlineAt !== preparation.deadlineAt || binding.environmentDigest !== prepared.preparedDigest
    || binding.appBuildDigest !== createHash("sha256").update(canonicalJson(input.compiled.inventory)).digest("hex")
    || sealed.get(prepared.preparedDigest) !== sha({ admissionDigest: input.admissionDigest, binding })) {
    throw new Error("application supervisor composition differs from the exact compiled suite, prepared leases, sealed admission, or run binding");
  }
  return Object.freeze({
    async allocate(runInput: E2ERunInput, signal: AbortSignal) {
      if (signal.aborted || runInput !== input.runInput || canonicalJson(E2ERunBindingSchema.parse(runInput.binding)) !== canonicalJson(binding)
        || runInput.suite.bundle.bundleDigest !== input.compiled.bundle.bundleDigest
        || Date.now() >= Date.parse(binding.deadlineAt)
        || sealed.get(prepared.preparedDigest) !== sha({ admissionDigest: input.admissionDigest, binding })) {
        throw new Error("application supervisor allocation is outside the exact sealed run admission");
      }
      const launched = await input.supervisor.launch({ compiled: input.compiled, binding, runnerToolchain: input.runnerToolchain,
        prepared, accountSessionRefs: input.accountSessionRefs, modelProxyRef: input.modelProxyRef, deadlineAt: binding.deadlineAt }, signal);
      if (signal.aborted || !launched.leaseId.trim()) throw new Error("application supervisor returned no live owned lease for the admitted run");
      const lease = Object.freeze({ leaseId: launched.leaseId,
        execute: (executeSignal: AbortSignal) => input.supervisor.execute(launched, executeSignal),
        close: (closeSignal: AbortSignal) => input.supervisor.close(launched, closeSignal) });
      return lease;
    },
    readActualRun: (signal: AbortSignal) => input.readActualRun(signal),
  });
}
