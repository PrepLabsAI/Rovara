import { createHash } from "node:crypto";
import { types } from "node:util";
import { z } from "zod";
import { E2E_ANONYMOUS_ACCOUNT_PROFILE_ID, canonicalJson, e2eModelRouteRevision, e2eRuntimeBindingOf, copyBoundedE2EJsonData, e2eAnonymousAccountIdDigest, e2eAnonymousRuntimeAccountRef, E2EApplicationEvidenceRefSchema, E2ECaseCoverageSchema, E2E_REPLAY_STOP_CODES,
  E2EExpectedCaseSchema, E2EQualifiedResultSchema, E2ERoundSchema, E2ERunBindingSchema, E2EAssertionSchema,
  E2EScenarioSchema, E2ERuntimeAccountRefSchema, E2EAppArtifactRefSchema, E2EMockSpecSchema, isE2EAnonymousSessionRef, readE2EApplicationProjectContract, type E2EApplicationEvidenceRef, type E2ECaseCoverage, type E2EQualifiedResult,
  type E2ERound, type E2ERoundScope, type E2ERunBinding, type E2ERuntimeAccountRef } from "@agentx/contracts";
import { E2E_REPORT_MAX_BYTES, E2E_APP_RPC_FRAME_MAX_BYTES, e2ePrivateTransferMaxBytes, type E2EStructuralQualification } from "./result-adapter.js";
import { parseE2EApplicationReport, type E2EApplicationReport } from "./application-report-schema.js";
import type { E2ECompiledApplicationSuite } from "./application-scenarios.js";
import { validateE2EApplicationExecutionAdmission, validateE2ECompiledApplicationAdmission } from "./application-scenarios.js";
import { compareE2EApplicationPublicList, E2EApplicationSelectionPacketSchema } from "./application-identity.js";
import { expectedE2EApplicationReporterDigest } from "./application-runtime-assets.js";
import { isPinnedRovaraHttpEngine } from "./rovara-http-engine-descriptor.js";
import { SINKHOLE_ORIGIN_REF, planApplicationOrigins } from "./application-mocks.js";
import { E2EAgentModelEvidenceSchema, evaluateE2EAgentCase, type E2EAgentCaseResult, type E2EAgentModelEvidence } from "./application-agent-result.js";
import { agentCaseDirectoryName } from "./executor/evidence-paths.js";

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const id = (max = 256) => z.string().min(1).max(max);
const utc = z.string().datetime({ offset: true });
export function e2eApplicationSupervisorEvidenceEntryMax(caseCount: number): number {
  if (!Number.isSafeInteger(caseCount) || caseCount < 1 || caseCount > 64) throw new TypeError("supervisor proof case count is outside the admitted bound");
  return 65 + caseCount * (2 + 200 + 100 * 32 + 20 * 103 + 2 * 100 + 4) + 2 * 200;
}
const boundedData = z.unknown().refine((value) => { try { copyBoundedE2EJsonData(value, { maxBytes: 262_144, maxDepth: 32 }); return true; } catch { return false; } });
export const E2EApplicationProducerSchema = z.object({ producerId: id(120), receiptId: id(200), lifecycleId: id(120), operationId: z.string().uuid(),
  operationFence: z.number().int().positive(), runtimeManifestDigest: sha, transportCorrelationId: z.string().uuid() }).strict();
export type E2EApplicationProducer = z.infer<typeof E2EApplicationProducerSchema>;
export const E2EApplicationProofBytesSchema = z.object({ ref: E2EApplicationEvidenceRefSchema,
  bytes: z.instanceof(Uint8Array).refine((value) => value.byteLength <= 26_214_400) }).strict();
export type E2EApplicationProofBytes = Readonly<{ ref: Readonly<E2EApplicationEvidenceRef>; bytes: Uint8Array }>;
export const E2EApplicationSupervisorReadbackSchema = z.object({ schemaVersion: z.literal("e2e-application-supervisor-readback/v1"),
  receipt: E2EApplicationProofBytesSchema, evidence: z.array(E2EApplicationProofBytesSchema).max(e2eApplicationSupervisorEvidenceEntryMax(64)) }).strict();
export type E2EApplicationSupervisorReadback = Readonly<{ schemaVersion: "e2e-application-supervisor-readback/v1";
  receipt: E2EApplicationProofBytes; evidence: readonly E2EApplicationProofBytes[] }>;
const supervisorContext = z.object({ bindingDigest: sha, compiledInventoryDigest: sha, preparedEnvironmentDigest: sha, candidateDigest: sha,
  roundId: z.string().uuid(), runId: z.string().uuid(), groupId: id(80), lifecycleId: id(120), observedAt: utc,
  producer: E2EApplicationProducerSchema }).strict();
const supervisorRef = E2EApplicationEvidenceRefSchema;
const supervisorReceiptFrame = z.object({ schemaVersion: z.literal("e2e-application-supervisor-receipt/v1"), context: supervisorContext,
  launches: z.array(z.object({ shardId: id(120), launchId: z.string().uuid(), upstreamRunId: z.string().uuid() }).strict()).min(1).max(3),
  caseCaptures: z.array(z.object({ caseId: id(160), shardId: id(120), ref: supervisorRef }).strict()).max(64),
  mockConsumptions: z.array(z.object({ caseId: id(160), shardId: id(120), ref: supervisorRef }).strict()).max(64),
  /** One frame per case that had a call no approved mock matched; absent (not empty) when no case had one. */
  unmockedCalls: z.array(z.object({ caseId: id(160), shardId: id(120), ref: supervisorRef }).strict()).max(64).optional(),
  cleanupRef: supervisorRef, additionalSupervisorReceiptRefs: z.array(supervisorRef).max(32) }).strict();
const mockConsumptionFrame = z.object({ schemaVersion: z.literal("e2e-application-mock-consumption/v1"), context: supervisorContext,
  caseId: id(160), shardId: id(120), upstreamRunId: z.string().uuid(), rows: z.array(z.object({ caseId: id(160), componentId: id(120),
    runId: z.string().uuid(), mockManifestDigest: sha, lifecycleId: id(120), producer: E2EApplicationProducerSchema,
    requestId: id(256), responseId: id(256), requestSha256: sha, responseSha256: sha, observedAt: utc,
    requestRef: supervisorRef, responseRef: supervisorRef }).strict()).max(100) }).strict();
/** One call to a declared origin that no approved mock matched: to the sinkhole (origin `unbound`), to a mock that refused it, or a ledger that could not be read in full. */
const unmockedCall = z.object({ requestId: id(256), origin: id(60), kind: z.enum(["unmatched", "foreign-caller", "malformed", "ledger-overflow"]), method: id(16), path: z.string().max(512), observedAt: utc }).strict();
export type E2EApplicationUnmockedCall = z.infer<typeof unmockedCall>;
const unmockedCallsFrame = z.object({ schemaVersion: z.literal("e2e-application-unmocked-calls/v1"), context: supervisorContext,
  caseId: id(160), shardId: id(120), upstreamRunId: z.string().uuid(), calls: z.array(unmockedCall).min(1).max(100) }).strict();
const unmockedCallsRow = z.object({ caseId: id(160), shardId: id(120), calls: z.array(unmockedCall).min(1).max(100) }).strict();
const cleanupFrame = z.object({ schemaVersion: z.literal("e2e-application-owned-cleanup/v1"), context: supervisorContext,
  phase: z.literal("after-owned-close"), cleanup: z.enum(["confirmed", "pending", "failed"]), confirmed: z.boolean(),
  serverListening: z.boolean().nullable(), ownedResourceInventoryDigest: sha, ownedCleanupReceiptRefs: z.array(supervisorRef).max(32) }).strict();
const origin = z.string().min(1).max(512).refine((value) => {
  try { const url = new URL(value); return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash && !url.hostname.includes("*"); }
  catch { return false; }
}, "origin must be a concrete canonical HTTP(S) origin");
export const E2EApplicationOwnedSubjectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("service"), processId: id(), origin }).strict(),
  z.object({ kind: z.literal("browser"), processId: id(), contextId: id(), pageId: id() }).strict(),
  z.object({ kind: z.literal("mobile"), leaseId: id(), deviceProfileId: id(120), appId: id(), installedArtifactSha256: sha }).strict(),
  z.object({ kind: z.literal("desktop"), sessionId: id(), processId: id(), windowIds: z.array(id()).max(32) }).strict().superRefine((subject, context) => {
    if (new Set(subject.windowIds).size !== subject.windowIds.length) context.addIssue({ code: "custom", path: ["windowIds"], message: "window IDs must be unique" });
  }),
]);
export type E2EApplicationOwnedSubject = z.infer<typeof E2EApplicationOwnedSubjectSchema>;
const accountIdDigest = sha;
export const E2EApplicationObservationBindingSchema = z.object({ caseId: id(160), subject: E2EApplicationOwnedSubjectSchema,
  caseProducer: E2EApplicationProducerSchema, assertionProducers: z.array(z.object({ assertionIndex: z.number().int().min(0).max(19), producer: E2EApplicationProducerSchema }).strict()).max(20),
  accountRef: E2ERuntimeAccountRefSchema, sessionRef: id(256), accountIdDigest,
  identityReceiptRef: E2EApplicationEvidenceRefSchema, subjectIdentityReceiptRef: E2EApplicationEvidenceRefSchema,
  selectedArtifact: E2EAppArtifactRefSchema, connection: z.object({ ref: z.object({ connectionId: id(120), revision: z.number().int().positive(),
    originRef: id(256), grantDigest: sha }).strict(), origin }).strict().nullable() }).strict().superRefine((row, context) => {
  const indexes = row.assertionProducers.map((item) => item.assertionIndex);
  if (new Set(indexes).size !== indexes.length) context.addIssue({ code: "custom", path: ["assertionProducers"], message: "assertion producer indexes must be unique" });
});
export type E2EApplicationObservationBinding = z.infer<typeof E2EApplicationObservationBindingSchema>;
const identityProjectionCommon = { caseId: id(160), bindingDigest: sha, upstreamRunId: z.string().uuid(), lifecycleId: id(120),
  producer: E2EApplicationProducerSchema, observedAt: utc, sourceReceiptRef: E2EApplicationEvidenceRefSchema };
export const E2EApplicationAccountIdentityProjectionSchema = z.object({ ...identityProjectionCommon,
  schemaVersion: z.literal("e2e-application-account-identity/v1"), accountRef: E2ERuntimeAccountRefSchema,
  sessionRef: id(256), accountIdDigest: sha }).strict();
export type E2EApplicationAccountIdentityProjection = z.infer<typeof E2EApplicationAccountIdentityProjectionSchema>;
/**
 * What the executor recorded as the source of an anonymous case's account identity (Ruling AZ): the sentinel session and no login and no identity at all. A signed-in case's source
 * carries a login and an identity; an anonymous case claiming either has claimed a session, and is refused.
 */
const anonymousAccountSourceSchema = z.object({ schemaVersion: z.literal("e2e-executor-account-observation/v1"), caseId: id(160), accountRef: E2ERuntimeAccountRefSchema,
  sessionRef: id(256), accountIdDigest: sha, observedAt: utc, login: z.null(), identity: z.null() }).strict();
export const E2EApplicationSubjectIdentityProjectionSchema = z.object({ ...identityProjectionCommon,
  schemaVersion: z.literal("e2e-application-subject-identity/v1"), subject: E2EApplicationOwnedSubjectSchema }).strict();
export type E2EApplicationSubjectIdentityProjection = z.infer<typeof E2EApplicationSubjectIdentityProjectionSchema>;
export const E2EApplicationAssertionAssetBindingSchema = z.object({ caseId: id(160), assertionIndex: z.number().int().min(0).max(19),
  kind: z.enum(["json-schema", "state-probe", "fixture-root"]), id: id(256), manifestDigest: sha, ref: E2EApplicationEvidenceRefSchema }).strict();
export type E2EApplicationAssertionAssetBinding = z.infer<typeof E2EApplicationAssertionAssetBindingSchema>;
export const E2EApplicationGovernedModelReceiptRowSchema = z.object({ caseId: id(160), declaredStepIndex: z.number().int().min(0).max(29),
  requestId: id(256), receiptId: id(256), receiptRef: E2EApplicationEvidenceRefSchema }).strict();
export type E2EApplicationGovernedModelReceiptRow = z.infer<typeof E2EApplicationGovernedModelReceiptRowSchema>;
const governedModelReceiptProjectionSchema = z.object({ schemaVersion: z.literal("e2e-application-governed-model-receipt/v1"), caseId: id(160),
  declaredStepIndex: z.number().int().min(0).max(29), requestId: id(256), receiptId: id(256), bindingDigest: sha, routeId: id(120), routeRevision: id(120),
  requestDigest: sha, generationDigest: sha, authoritySnapshotDigest: sha, sourceReceiptRef: E2EApplicationEvidenceRefSchema, recordedAt: utc }).strict();
const observationHeader = { schemaVersion: z.literal("e2e-application-assertion-observation/v1"), caseId: id(160),
  assertionIndex: z.number().int().min(0).max(19), assertionDigest: sha, observationId: id(256), lifecycleId: id(120), observedAt: utc,
  producer: E2EApplicationProducerSchema, subject: E2EApplicationOwnedSubjectSchema, accountContextId: id(120), accountContextDigest: sha,
  sessionRef: id(256), accountIdDigest: sha };
const observationRef = E2EApplicationEvidenceRefSchema;
export const E2EApplicationAssertionObservationSchema = z.discriminatedUnion("kind", [
  z.object({ ...observationHeader, kind: z.literal("text"), testId: id(256), text: z.string().max(8192), observationRef }).strict(),
  z.object({ ...observationHeader, kind: z.literal("visible"), testId: id(256), visible: z.boolean(), observationRef }).strict(),
  z.object({ ...observationHeader, kind: z.literal("http-status"), requestId: id(256), responseId: id(256), method: id(12), path: id(2048),
    origin, status: z.number().int().min(100).max(599), bodyRef: observationRef, connectionRef: z.object({ connectionId: id(120), revision: z.number().int().positive(), originRef: id(256), grantDigest: sha }).strict().nullable() }).strict(),
  z.object({ ...observationHeader, kind: z.literal("csv"), downloadId: id(256), downloadName: id(512), contentRef: observationRef }).strict(),
  z.object({ ...observationHeader, kind: z.literal("json"), responseId: id(256), schemaRef: id(256), schemaAssetRef: observationRef, bodyRef: observationRef }).strict(),
  z.object({ ...observationHeader, kind: z.literal("state"), probeId: id(256), probeAssetRef: observationRef, samples: z.array(z.object({ observedAt: utc,
    // "timed-out" is only ever the last sample: a 2xx answer (see httpStatus) that still held another value when the poll budget ran out.
    valueRef: observationRef, disposition: z.enum(["pending", "ready", "failed", "timed-out"]), httpStatus: z.number().int().min(100).max(599).optional() }).strict()).min(1).max(100) }).strict(),
  z.object({ ...observationHeader, kind: z.literal("file"), fixtureRootId: id(256), relativePath: id(1024), rootAssetRef: observationRef, contentRef: observationRef }).strict(),
]);
export type E2EApplicationAssertionObservation = z.infer<typeof E2EApplicationAssertionObservationSchema>;
const agentOperationKind = z.enum(["tap", "doubleTap", "longPress", "secondaryTap", "hover", "scrollTo", "type", "typeSecret", "press", "select",
  "check", "upload", "drag", "scroll", "scrollUntil", "navigate", "back", "typeText", "pressKey", "dismissKeyboard", "tapAt", "hoverAt",
  "swipe", "swipeTo", "request", "invoke-contract", "inspect-contract", "launch-app", "restart-app", "set-permission", "choose-file"]);
export const E2EApplicationAgentOperationObservationSchema = z.object({
  schemaVersion: z.literal("e2e-application-agent-operation/v1"), caseId: id(160), declaredStepIndex: z.number().int().min(0).max(29),
  operationIndex: z.number().int().min(0).max(99), declaredActionDigest: sha, observationId: id(256), lifecycleId: id(120),
  producer: E2EApplicationProducerSchema, subject: E2EApplicationOwnedSubjectSchema, accountContextId: id(120), accountContextDigest: sha,
  sessionRef: id(256), accountIdDigest: sha, upstreamRunId: z.string().uuid(), attemptId: id(256),
  sdkStepIndex: z.number().int().min(0).max(255), sdkActionIndex: z.number().int().min(0).max(99),
  startedAt: utc, finishedAt: utc, operationKind: agentOperationKind, inputDigest: sha,
  outcome: z.enum(["completed", "failed", "unavailable", "uncertain"]), sourceReceiptRef: E2EApplicationEvidenceRefSchema,
}).strict();
export type E2EApplicationAgentOperationObservation = z.infer<typeof E2EApplicationAgentOperationObservationSchema>;
const terminalSchema = z.object({ kind: z.enum(["completed", "assertion-failed", "unavailable", "uncertain"]),
  lastDeclaredStepIndex: z.number().int().min(0).max(29).nullable(), failedAssertionIndex: z.number().int().min(0).max(19).nullable(),
  at: utc, reason: id(500) }).strict();
const captureStep = z.object({ index: z.number().int().min(0).max(99), declaredStepIndex: z.number().int().min(0).max(29),
  kind: z.enum(["navigate", "fill", "click", "agent", "request", "invoke-contract", "inspect-contract", "launch-app", "tap", "swipe", "deep-link", "restart-app", "set-permission", "choose-file"]), actionDigest: sha, observationId: id(256).nullable(), at: utc,
  outcome: z.enum(["completed", "failed", "unavailable", "uncertain"]), evidenceRefs: z.array(E2EApplicationEvidenceRefSchema).max(32),
  agentOperationRefs: z.array(E2EApplicationEvidenceRefSchema).max(100) }).strict();
const captureAssertion = z.object({ index: z.number().int().min(0).max(19), digest: sha, observedAt: utc, observationId: id(256).nullable(),
  value: boundedData.nullable(), evidenceRef: E2EApplicationEvidenceRefSchema.nullable(), outcome: z.enum(["passed", "failed", "unavailable"]),
  reason: id(500), producer: E2EApplicationProducerSchema }).strict();
export const E2EApplicationCaseCaptureSchema = z.object({ schemaVersion: z.literal("e2e-application-case-capture/v1"), caseId: id(160),
  upstreamRunId: z.string().uuid(), shardId: id(120), roundId: z.string().uuid(), runId: z.string().uuid(), groupId: id(80), candidateDigest: sha,
  applicationId: id(120), buildManifestDigest: sha, runtimeManifestDigest: sha, executionDescriptorDigest: sha, accountContextId: id(120),
  accountContextDigest: sha, observedAt: utc, lifecycleId: id(120), subject: E2EApplicationOwnedSubjectSchema, producer: E2EApplicationProducerSchema,
  steps: z.array(captureStep).max(100), assertions: z.array(captureAssertion).min(1).max(20), terminal: terminalSchema,
  modelReceipts: z.array(E2EApplicationGovernedModelReceiptRowSchema).max(200), artifacts: z.array(E2EApplicationEvidenceRefSchema).max(200),
  coverage: E2ECaseCoverageSchema, cleanup: z.enum(["confirmed", "pending", "failed"]) }).strict().superRefine((capture, context) => {
  if (new Set(capture.steps.map((item) => item.index)).size !== capture.steps.length || capture.steps.some((item, index) => item.index !== index)) {
    context.addIssue({ code: "custom", path: ["steps"], message: "capture step indexes must be unique and contiguous" });
  }
  if (new Set(capture.assertions.map((item) => item.index)).size !== capture.assertions.length || capture.assertions.some((item, index) => item.index !== index)) {
    context.addIssue({ code: "custom", path: ["assertions"], message: "capture assertions must be unique and contiguous" });
  }
  for (const value of [capture.steps, capture.assertions, capture.artifacts]) {
    try { copyBoundedE2EJsonData(value, { maxBytes: 262_144, maxDepth: 32 }); }
    catch { context.addIssue({ code: "custom", path: [], message: "capture exceeds the per-record private data limit" }); }
  }
  for (const [index, step] of capture.steps.entries()) {
    if (step.kind !== "agent" && step.agentOperationRefs.length > 0) {
      context.addIssue({ code: "custom", path: ["steps", index, "agentOperationRefs"], message: "agent operation frames must be present only on agent steps" });
    }
    if (new Set(step.agentOperationRefs.map((ref) => ref.artifactId)).size !== step.agentOperationRefs.length) {
      context.addIssue({ code: "custom", path: ["steps", index, "agentOperationRefs"], message: "agent operation refs must be unique within the declared step" });
    }
  }
});
export type E2EApplicationCaseCapture = z.infer<typeof E2EApplicationCaseCaptureSchema>;

function evidenceKey(ref: E2EApplicationEvidenceRef): string { return canonicalJson(ref); }
function validateProofBytes(proof: E2EApplicationProofBytes, label: string): Buffer {
  const ref = E2EApplicationEvidenceRefSchema.parse(proof.ref);
  const bytes = Buffer.from(proof.bytes);
  if (bytes.byteLength !== ref.byteLength || createHash("sha256").update(bytes).digest("hex") !== ref.sha256) throw new Error(`${label} bytes differ from their immutable evidence reference`);
  return bytes;
}
function parseCanonicalFrame<T>(proof: E2EApplicationProofBytes, schema: z.ZodType<T>, label: string): T {
  if (proof.ref.mediaType !== "application/json") throw new Error(`${label} must use application/json media type`);
  const bytes = validateProofBytes(proof, label);
  if (bytes.byteLength > 262_144) throw new Error(`${label} exceeds the canonical JSON frame bound`);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const parsed = copyBoundedE2EJsonData(JSON.parse(text), { maxBytes: 262_144, maxDepth: 32 });
  if (canonicalJson(parsed) !== text) throw new Error(`${label} is not canonical UTF-8 JSON`);
  return schema.parse(parsed);
}
function proofBytesFor(inventory: ReadonlyMap<string, E2EApplicationProofBytes>, ref: E2EApplicationEvidenceRef): Buffer {
  const proof = inventory.get(ref.artifactId);
  if (!proof || evidenceKey(proof.ref) !== evidenceKey(ref)) throw new Error("assertion observation references missing or conflicting raw bytes");
  return validateProofBytes(proof, "assertion observation evidence");
}
function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cell = ""; let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { cell += '"'; index++; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"' && cell.length === 0) quoted = true;
    else if (char === ",") { row.push(cell); cell = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index++;
      row.push(cell); cell = ""; rows.push(row); row = [];
    } else cell += char;
    if (rows.length > 10_001 || row.length > 256 || cell.length > 8192) throw new Error("CSV observation exceeds its admitted bounds");
  }
  if (quoted) throw new Error("CSV observation contains an unterminated quoted field");
  if (cell.length > 0 || row.length > 0) { row.push(cell); rows.push(row); }
  return rows;
}
function isSupportedJsonSchema(schema: unknown, depth = 0): boolean {
  if (depth > 16 || !schema || typeof schema !== "object" || Array.isArray(schema)) return false;
  const row = schema as Record<string, unknown>;
  const supportedKeywords = new Set(["type", "required", "properties", "additionalProperties", "items", "enum"]);
  if (Object.keys(row).some((key) => !supportedKeywords.has(key)) || !["object", "array", "string", "number", "integer", "boolean", "null"].includes(String(row.type))) return false;
  if ((row.type !== "object" && ["required", "properties", "additionalProperties"].some((key) => Object.hasOwn(row, key)))
    || (row.type !== "array" && Object.hasOwn(row, "items"))) return false;
  if (row.required !== undefined && (!Array.isArray(row.required) || row.required.some((key) => typeof key !== "string"))) return false;
  if (row.properties !== undefined && (!row.properties || typeof row.properties !== "object" || Array.isArray(row.properties)
    || Object.values(row.properties).some((child) => !isSupportedJsonSchema(child, depth + 1)))) return false;
  if (row.additionalProperties !== undefined && typeof row.additionalProperties !== "boolean") return false;
  if (row.items !== undefined && !isSupportedJsonSchema(row.items, depth + 1)) return false;
  return row.enum === undefined || Array.isArray(row.enum);
}
function schemaMatches(value: unknown, schema: unknown, depth = 0): boolean {
  if (depth > 16 || !schema || typeof schema !== "object" || Array.isArray(schema)) return false;
  if (!isSupportedJsonSchema(schema, depth)) return false;
  const row = schema as Record<string, unknown>;
  const supportedKeywords = new Set(["type", "required", "properties", "additionalProperties", "items", "enum"]);
  if (Object.keys(row).some((key) => !supportedKeywords.has(key))) return false;
  if (typeof row.type !== "string") return false;
  if ((row.type !== "object" && ["required", "properties", "additionalProperties"].some((key) => Object.hasOwn(row, key)))
    || (row.type !== "array" && Object.hasOwn(row, "items"))) return false;
  const typeMatches = row.type === "object" ? !!value && typeof value === "object" && !Array.isArray(value)
    : row.type === "array" ? Array.isArray(value) : row.type === "string" ? typeof value === "string"
      : row.type === "number" ? typeof value === "number" && Number.isFinite(value)
        : row.type === "integer" ? typeof value === "number" && Number.isSafeInteger(value)
          : row.type === "boolean" ? typeof value === "boolean" : row.type === "null" ? value === null : false;
  if (!typeMatches) return false;
  if (row.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const object = value as Record<string, unknown>;
    if (row.required !== undefined && (!Array.isArray(row.required)
      || row.required.some((key) => typeof key !== "string" || !Object.hasOwn(object, key)))) return false;
    const properties = row.properties;
    if (properties !== undefined && (!properties || typeof properties !== "object" || Array.isArray(properties))) return false;
    if (properties && typeof properties === "object" && !Array.isArray(properties)) {
      for (const [key, childSchema] of Object.entries(properties)) if (Object.hasOwn(object, key) && !schemaMatches(object[key], childSchema, depth + 1)) return false;
    }
    if (row.additionalProperties !== undefined && typeof row.additionalProperties !== "boolean") return false;
    if (row.additionalProperties === false && Object.keys(object).some((key) => !properties || typeof properties !== "object" || Array.isArray(properties) || !Object.hasOwn(properties, key))) return false;
  }
  if (row.type === "array" && row.items !== undefined && (!Array.isArray(value) || value.some((item) => !schemaMatches(item, row.items, depth + 1)))) return false;
  if (Array.isArray(row.enum) && !row.enum.some((item) => canonicalJson(item) === canonicalJson(value))) return false;
  return true;
}
export function evaluateE2EApplicationAssertionObservation(input: { assertion: z.infer<typeof E2EAssertionSchema>;
  observation: E2EApplicationAssertionObservation; proofBytes: ReadonlyMap<string, E2EApplicationProofBytes>;
  assetBinding: E2EApplicationAssertionAssetBinding | null }): { supported: boolean; passed: boolean; value: unknown; /** A CSV assertion: SHA-256 of the bytes of the download it read. */ contentSha256?: string } {
  const observation = E2EApplicationAssertionObservationSchema.parse(input.observation);
  const assertion = E2EAssertionSchema.parse(input.assertion);
  if (observation.kind === "text" && assertion.kind === "text") {
    const actualText = new TextDecoder("utf-8", { fatal: true }).decode(proofBytesFor(input.proofBytes, observation.observationRef));
    return { supported: true, passed: observation.testId === assertion.testId && actualText === observation.text && actualText === assertion.equals, value: actualText };
  }
  if (observation.kind === "visible" && assertion.kind === "visible") {
    const actualBytes = proofBytesFor(input.proofBytes, observation.observationRef);
    const actualValue = actualBytes.toString("utf8");
    return { supported: true, passed: (actualValue === "true" || actualValue === "false") && actualValue === String(observation.visible)
      && observation.testId === assertion.testId && observation.visible === assertion.equals, value: observation.visible };
  }
  if (observation.kind === "http-status" && assertion.kind === "http-status") {
    proofBytesFor(input.proofBytes, observation.bodyRef);
    return { supported: true, passed: observation.method === assertion.method && observation.path === assertion.path && observation.status === assertion.equals, value: observation.status };
  }
  if (observation.kind === "csv" && assertion.kind === "csv") {
    const csvBytes = proofBytesFor(input.proofBytes, observation.contentRef);
    const body = new TextDecoder("utf-8", { fatal: true }).decode(csvBytes);
    const rows = parseCsv(body);
    const [columns, ...data] = rows;
    const value = { columns: columns ?? [], rows: data, downloadName: observation.downloadName };
    return { supported: true, passed: observation.downloadName === assertion.downloadName && canonicalJson(value) === canonicalJson({
      columns: assertion.columns, rows: assertion.rows, downloadName: assertion.downloadName }), value, contentSha256: createHash("sha256").update(csvBytes).digest("hex") };
  }
  if (observation.kind === "json" && assertion.kind === "json") {
    if (!input.assetBinding || input.assetBinding.kind !== "json-schema" || input.assetBinding.id !== assertion.schemaRef
      || evidenceKey(input.assetBinding.ref) !== evidenceKey(observation.schemaAssetRef)) return { supported: false, passed: false, value: null };
    let schema: unknown;
    try {
      const schemaText = new TextDecoder("utf-8", { fatal: true }).decode(proofBytesFor(input.proofBytes, observation.schemaAssetRef));
      schema = JSON.parse(schemaText) as unknown;
      if (canonicalJson(schema) !== schemaText || !isSupportedJsonSchema(schema)) return { supported: false, passed: false, value: null };
    } catch { return { supported: false, passed: false, value: null }; }
    const bodyBytes = proofBytesFor(input.proofBytes, observation.bodyRef);
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bodyBytes)) as unknown; }
    catch { return { supported: true, passed: false, value: { malformed: true } }; }
    return { supported: true, passed: schemaMatches(value, schema) && canonicalJson(value) === canonicalJson(assertion.equals), value };
  }
  if (observation.kind === "state" && assertion.kind === "state") {
    if (!input.assetBinding || input.assetBinding.kind !== "state-probe" || input.assetBinding.id !== assertion.probeId
      || evidenceKey(input.assetBinding.ref) !== evidenceKey(observation.probeAssetRef) || observation.probeId !== assertion.probeId) return { supported: false, passed: false, value: null };
    let probeSchema: unknown;
    try {
      const probeBytes = proofBytesFor(input.proofBytes, observation.probeAssetRef);
      const probeText = new TextDecoder("utf-8", { fatal: true }).decode(probeBytes);
      probeSchema = JSON.parse(probeText) as unknown;
      if (canonicalJson(probeSchema) !== probeText || !isSupportedJsonSchema(probeSchema)) return { supported: false, passed: false, value: null };
    } catch { return { supported: false, passed: false, value: null }; }
    const sampleTimes = observation.samples.map((item) => Date.parse(item.observedAt));
    const lastSample = observation.samples.at(-1);
    // A poll ends ready, or (Ruling W) timed out on a 2xx answer: a definite mismatch. Anything else (a 429 or 503 that kept it pending, a failed or
    // unreadable answer, a timeout with no recorded 2xx status) is not an answer about the feature, so the observation is unsupported.
    const timedOut = lastSample?.disposition === "timed-out";
    if (!sampleTimes.every(Number.isFinite) || sampleTimes.some((time, index) => index > 0 && time < sampleTimes[index - 1]!)
      || sampleTimes.at(-1)! - sampleTimes[0]! > assertion.pollTimeoutMs
      || (lastSample?.disposition !== "ready" && !(timedOut && lastSample.httpStatus !== undefined && lastSample.httpStatus >= 200 && lastSample.httpStatus < 300))
      || observation.samples.slice(0, -1).some((sample) => sample.disposition !== "pending")) return { supported: false, passed: false, value: null };
    const sampleValues = observation.samples.map((sample) => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(proofBytesFor(input.proofBytes, sample.valueRef))) as unknown);
    const value = sampleValues.at(-1);
    if (sampleValues.some((sample) => !schemaMatches(sample, probeSchema))) {
      return { supported: false, passed: false, value };
    }
    const matches = canonicalJson(value) === canonicalJson(assertion.equals);
    // A sample that holds the approved value was never a timeout.
    if (timedOut && matches) return { supported: false, passed: false, value };
    return { supported: true, passed: matches, value };
  }
  if (observation.kind === "file" && assertion.kind === "file") {
    if (!input.assetBinding || input.assetBinding.kind !== "fixture-root" || input.assetBinding.id !== assertion.fixtureRootId
      || evidenceKey(input.assetBinding.ref) !== evidenceKey(observation.rootAssetRef) || observation.relativePath !== assertion.relativePath
      || observation.relativePath.startsWith("/") || observation.relativePath.includes("\\")
      || observation.relativePath.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) return { supported: false, passed: false, value: null };
    const bytes = proofBytesFor(input.proofBytes, observation.contentRef);
    return { supported: true, passed: createHash("sha256").update(bytes).digest("hex") === assertion.sha256, value: assertion.sha256 };
  }
  return { supported: false, passed: false, value: null };
}
function refsInCapture(capture: E2EApplicationCaseCapture): E2EApplicationEvidenceRef[] {
  return [...capture.steps.flatMap((step) => [...step.evidenceRefs, ...step.agentOperationRefs]), ...capture.assertions.flatMap((assertion) => assertion.evidenceRef ? [assertion.evidenceRef] : []),
    ...capture.modelReceipts.map((item) => item.receiptRef), ...capture.artifacts];
}
function readAgentOperationFrames(capture: E2EApplicationCaseCapture, proofFor: (ref: E2EApplicationEvidenceRef) => E2EApplicationProofBytes) {
  return capture.steps.flatMap((step) => step.agentOperationRefs.map((ref, operationIndex) => {
    const operation = parseCanonicalFrame(proofFor(ref), E2EApplicationAgentOperationObservationSchema, "agent operation observation frame");
    if (operation.caseId !== capture.caseId || operation.declaredStepIndex !== step.declaredStepIndex || operation.operationIndex !== operationIndex
      || operation.declaredActionDigest !== step.actionDigest || operation.lifecycleId !== capture.lifecycleId
      || canonicalJson(operation.subject) !== canonicalJson(capture.subject) || operation.accountContextId !== capture.accountContextId
      || operation.accountContextDigest !== capture.accountContextDigest || Date.parse(operation.finishedAt) < Date.parse(operation.startedAt)) {
      throw new Error("agent operation frame differs from its declared case, step, subject, account, or lifecycle");
    }
    proofFor(operation.sourceReceiptRef);
    return operation;
  }));
}
function refsInAssertionObservation(observation: E2EApplicationAssertionObservation): E2EApplicationEvidenceRef[] {
  switch (observation.kind) {
    case "text": case "visible": return [observation.observationRef];
    case "http-status": return [observation.bodyRef];
    case "csv": return [observation.contentRef];
    case "json": return [observation.schemaAssetRef, observation.bodyRef];
    case "state": return [observation.probeAssetRef, ...observation.samples.map((item) => item.valueRef)];
    case "file": return [observation.rootAssetRef, observation.contentRef];
  }
}
function ownRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError(`${label} must be ordinary own data`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !keys.includes(key))) throw new TypeError(`${label} has unknown fields`);
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) throw new TypeError(`${label} must contain enumerable own data fields`);
    result[key] = descriptor.value as unknown;
  }
  return result;
}
function proofInventorySnapshot(raw: unknown, caseCount: number): E2EApplicationSupervisorReadback {
  const maxEntries = e2eApplicationSupervisorEvidenceEntryMax(caseCount);
  const root = ownRecord(raw, ["schemaVersion", "receipt", "evidence"], "supervisor readback");
  let total = 0;
  const proof = (value: unknown, label: string) => {
    const row = ownRecord(value, ["ref", "bytes"], label);
    const ref = E2EApplicationEvidenceRefSchema.parse(ownRecord(row.ref, ["artifactId", "sha256", "byteLength", "mediaType"], `${label} ref`));
    if (!(row.bytes instanceof Uint8Array)) throw new TypeError(`${label} bytes must be a Uint8Array`);
    if (ref.byteLength > 26_214_400 || row.bytes.byteLength !== ref.byteLength || total + ref.byteLength > 26_214_400) {
      throw new TypeError(`${label} exceeds its declared or aggregate byte bound`);
    }
    total += ref.byteLength;
    return { ref, source: row.bytes };
  };
  const rawEvidence = root.evidence;
  if (!Array.isArray(rawEvidence) || types.isProxy(rawEvidence) || Object.getPrototypeOf(rawEvidence) !== Array.prototype
    || rawEvidence.length > maxEntries) throw new TypeError("supervisor evidence is not a bounded ordinary array");
  const descriptors = Object.getOwnPropertyDescriptors(rawEvidence);
  if (Reflect.ownKeys(descriptors).some((key) => key !== "length" && (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(key)))) throw new TypeError("supervisor evidence array has extra properties");
  const evidence = Array.from({ length: rawEvidence.length }, (_, index) => {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) throw new TypeError("supervisor evidence array must be dense own data");
    return proof(descriptor.value, "supervisor evidence entry");
  });
  const receipt = proof(root.receipt, "supervisor receipt");
  const copy = ({ ref, source }: { ref: E2EApplicationEvidenceRef; source: Uint8Array }): E2EApplicationProofBytes =>
    ({ ref, bytes: Uint8Array.from(source) });
  return E2EApplicationSupervisorReadbackSchema.parse({ schemaVersion: root.schemaVersion,
    receipt: copy(receipt), evidence: evidence.map(copy) });
}
function snapshotSupervisorReceiptRefs(raw: unknown): E2EApplicationEvidenceRef[] {
  if (!Array.isArray(raw) || types.isProxy(raw) || Object.getPrototypeOf(raw) !== Array.prototype || raw.length < 1 || raw.length > 32) {
    throw new TypeError("protected supervisor receipt expectations must be a nonempty bounded ordinary array");
  }
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  if (Reflect.ownKeys(descriptors).some((key) => key !== "length" && (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(key)))) {
    throw new TypeError("protected supervisor receipt expectations have extra array properties");
  }
  const refs = Array.from({ length: raw.length }, (_, index) => {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) throw new TypeError("protected supervisor receipt refs must be dense own data");
    const item = ownRecord(descriptor.value, ["artifactId", "sha256", "byteLength", "mediaType"], "protected supervisor receipt ref");
    return E2EApplicationEvidenceRefSchema.parse(item);
  });
  if (canonicalJson(refs) !== canonicalJson([...refs].sort((a, b) => a.artifactId.localeCompare(b.artifactId)))
    || new Set(refs.map((ref) => ref.artifactId)).size !== refs.length) throw new TypeError("protected supervisor receipt refs must be sorted and unique");
  return refs;
}

/** Validates raw supervisor bytes without resolving references or elevating claimed producers to authenticated evidence. */
export function readE2EApplicationSupervisorProof(input: { readback: E2EApplicationSupervisorReadback;
  expected: { bindingDigest: string; compiledInventoryDigest: string; preparedEnvironmentDigest: string; candidateDigest: string;
    roundId: string; runId: string; groupId: string; mockManifestDigest: string; caseCount: number;
    expectedSupervisorReceiptRefs: readonly E2EApplicationEvidenceRef[]; ownedResourceInventoryDigest: string;
    expectedIdentityRefs?: readonly E2EApplicationEvidenceRef[];
    launches: readonly { shardId: string; launchId: string; upstreamRunId: string }[] };
  applicationCaptures: readonly unknown[]; supervisorReceiptRefs: readonly unknown[];
  cleanupConfirmed: boolean | null; cleanupServerListening: boolean | null }) {
  const parsedReadback = proofInventorySnapshot(input.readback, input.expected.caseCount);
  const readback: E2EApplicationSupervisorReadback = Object.freeze({ schemaVersion: parsedReadback.schemaVersion,
    receipt: Object.freeze({ ref: Object.freeze({ ...parsedReadback.receipt.ref }), bytes: Uint8Array.from(parsedReadback.receipt.bytes) }),
    evidence: Object.freeze(parsedReadback.evidence.map((item) => Object.freeze({ ref: Object.freeze({ ...item.ref }), bytes: Uint8Array.from(item.bytes) }))) });
  if (!Number.isSafeInteger(input.expected.caseCount) || input.expected.caseCount < 1 || input.expected.caseCount > 64
    || readback.evidence.length > e2eApplicationSupervisorEvidenceEntryMax(input.expected.caseCount)) {
    throw new Error("supervisor proof byte inventory exceeds the admitted global case bound");
  }
  const receipt = parseCanonicalFrame(readback.receipt, supervisorReceiptFrame, "supervisor receipt frame");
  const inventory = new Map<string, E2EApplicationProofBytes>();
  let totalBytes = readback.receipt.bytes.byteLength;
  if (readback.evidence.some((item, index, items) => index > 0 && items[index - 1]!.ref.artifactId.localeCompare(item.ref.artifactId) >= 0)) {
    throw new Error("supervisor evidence byte entries are not deterministically sorted by unique artifact ID");
  }
  for (const item of readback.evidence) {
    const parsed = E2EApplicationProofBytesSchema.parse(item);
    if (inventory.has(parsed.ref.artifactId)) throw new Error("supervisor evidence inventory contains a duplicate artifact ID");
    validateProofBytes(parsed, "supervisor evidence");
    totalBytes += parsed.bytes.byteLength;
    inventory.set(parsed.ref.artifactId, parsed);
  }
  if (totalBytes > 26_214_400) throw new Error("supervisor readback bytes exceed the active private transfer ceiling");
  const expectedContext = { bindingDigest: input.expected.bindingDigest, compiledInventoryDigest: input.expected.compiledInventoryDigest,
    preparedEnvironmentDigest: input.expected.preparedEnvironmentDigest, candidateDigest: input.expected.candidateDigest,
    roundId: input.expected.roundId, runId: input.expected.runId, groupId: input.expected.groupId };
  const baseContext = receipt.context;
  const contextMatches = (context: typeof baseContext) => canonicalJson({ bindingDigest: context.bindingDigest,
    compiledInventoryDigest: context.compiledInventoryDigest, preparedEnvironmentDigest: context.preparedEnvironmentDigest,
    candidateDigest: context.candidateDigest, roundId: context.roundId, runId: context.runId, groupId: context.groupId }) === canonicalJson(expectedContext)
    && canonicalJson(context) === canonicalJson(baseContext);
  if (!contextMatches(baseContext)) throw new Error("supervisor proof context differs from the exact approved group binding");
  const expectedLaunches = [...input.expected.launches].sort((a, b) => a.shardId.localeCompare(b.shardId));
  const launches = [...receipt.launches].sort((a, b) => a.shardId.localeCompare(b.shardId));
  if (canonicalJson(receipt.launches) !== canonicalJson(launches) || canonicalJson(launches) !== canonicalJson(expectedLaunches)
    || new Set(launches.map((item) => item.shardId)).size !== launches.length) {
    throw new Error("supervisor receipt does not cover the exact original shard launch inventory");
  }
  const proofFor = (ref: E2EApplicationEvidenceRef): E2EApplicationProofBytes => {
    const item = inventory.get(ref.artifactId);
    if (!item || evidenceKey(item.ref) !== evidenceKey(ref)) throw new Error("supervisor receipt references missing or conflicting raw evidence bytes");
    return item;
  };
  const captures = receipt.caseCaptures.map((entry) => {
    const launch = launches.find((item) => item.shardId === entry.shardId);
    const capture = parseCanonicalFrame(proofFor(entry.ref), E2EApplicationCaseCaptureSchema, "case capture frame");
    if (!launch || capture.caseId !== entry.caseId || capture.shardId !== entry.shardId || capture.upstreamRunId !== launch.upstreamRunId
      || capture.lifecycleId !== baseContext.lifecycleId) {
      throw new Error("case capture differs from its receipt case, launch, or producer context");
    }
    return capture;
  });
  const sortedCaptureEntries = [...receipt.caseCaptures].sort((a, b) => a.caseId.localeCompare(b.caseId));
  if (canonicalJson(receipt.caseCaptures) !== canonicalJson(sortedCaptureEntries)
    || new Set(receipt.caseCaptures.map((item) => item.caseId)).size !== receipt.caseCaptures.length
    || canonicalJson([...captures].sort((a, b) => a.caseId.localeCompare(b.caseId)))
      !== canonicalJson(input.applicationCaptures.map((raw) => E2EApplicationCaseCaptureSchema.parse(raw)).sort((a, b) => a.caseId.localeCompare(b.caseId)))) {
    throw new Error("supervisor raw captures disagree with the actual run capture set");
  }
  const sortedMockEntries = [...receipt.mockConsumptions].sort((a, b) => a.caseId.localeCompare(b.caseId));
  if (canonicalJson(receipt.mockConsumptions) !== canonicalJson(sortedMockEntries)
    || receipt.caseCaptures.length > input.expected.caseCount || receipt.mockConsumptions.length > input.expected.caseCount
    || receipt.caseCaptures.some((item) => !input.expected.launches.some((launch) => launch.shardId === item.shardId))
    || receipt.mockConsumptions.some((item) => !input.expected.launches.some((launch) => launch.shardId === item.shardId))) {
    throw new Error("supervisor case and mock proof inventory exceeds its exact group bounds");
  }
  const cleanup = parseCanonicalFrame(proofFor(receipt.cleanupRef), cleanupFrame, "owned cleanup frame");
  if (!contextMatches(cleanup.context) || cleanup.phase !== "after-owned-close" || cleanup.cleanup !== "confirmed" || !cleanup.confirmed
    || cleanup.serverListening !== false || cleanup.ownedResourceInventoryDigest !== input.expected.ownedResourceInventoryDigest
    || input.cleanupConfirmed !== true || input.cleanupServerListening !== false) {
    throw new Error("supervisor cleanup receipt does not prove confirmed post-close release with no listener");
  }
  const sortedOwnedRefs = [...cleanup.ownedCleanupReceiptRefs].sort((a, b) => a.artifactId.localeCompare(b.artifactId));
  if (canonicalJson(cleanup.ownedCleanupReceiptRefs) !== canonicalJson(sortedOwnedRefs)
    || new Set(cleanup.ownedCleanupReceiptRefs.map((ref) => ref.artifactId)).size !== cleanup.ownedCleanupReceiptRefs.length) {
    throw new Error("owned cleanup receipt references are unordered or duplicated");
  }
  const expectedSupervisorRefs = snapshotSupervisorReceiptRefs(input.expected.expectedSupervisorReceiptRefs);
  const sortedExpectedSupervisorRefs = [...expectedSupervisorRefs].sort((a, b) => a.artifactId.localeCompare(b.artifactId));
  if (canonicalJson(expectedSupervisorRefs) !== canonicalJson(sortedExpectedSupervisorRefs)
    || canonicalJson(receipt.additionalSupervisorReceiptRefs) !== canonicalJson(expectedSupervisorRefs)) {
    throw new Error("supervisor additional receipt refs differ from the exact protected oracle expectations");
  }
  const expectedRefsById = new Map(expectedSupervisorRefs.map((ref) => [ref.artifactId, ref]));
  for (const ref of cleanup.ownedCleanupReceiptRefs) {
    const expected = expectedRefsById.get(ref.artifactId);
    if (!expected || evidenceKey(expected) !== evidenceKey(ref)) throw new Error("owned cleanup receipt is absent from the protected supervisor receipt expectations");
  }
  const mockRows: z.infer<typeof E2EApplicationCollectionSchema>["mockConsumptions"] = [];
  const mockCaseIds = new Set<string>();
  for (const entry of receipt.mockConsumptions) {
    const launch = launches.find((item) => item.shardId === entry.shardId);
    const frame = parseCanonicalFrame(proofFor(entry.ref), mockConsumptionFrame, "mock consumption frame");
    if (!launch || frame.caseId !== entry.caseId || frame.shardId !== entry.shardId || frame.upstreamRunId !== launch.upstreamRunId
      || !contextMatches(frame.context) || mockCaseIds.has(entry.caseId)) throw new Error("mock consumption frame is foreign, duplicated, or outside its launch context");
    mockCaseIds.add(entry.caseId);
    for (const row of frame.rows) {
      if (row.caseId !== frame.caseId || row.runId !== input.expected.runId || row.mockManifestDigest !== input.expected.mockManifestDigest
        || row.lifecycleId !== frame.context.lifecycleId || canonicalJson(row.producer) !== canonicalJson(frame.context.producer)) {
        throw new Error("mock consumption row differs from its actual run, manifest, lifecycle, or producer");
      }
      const request = proofFor(row.requestRef); const response = proofFor(row.responseRef);
      if (createHash("sha256").update(request.bytes).digest("hex") !== row.requestSha256
        || createHash("sha256").update(response.bytes).digest("hex") !== row.responseSha256) throw new Error("mock request or response bytes differ from the causal witness");
      mockRows.push({ caseId: row.caseId, componentId: row.componentId, runId: row.runId, mockManifestDigest: row.mockManifestDigest,
        lifecycleId: row.lifecycleId, producer: row.producer, requestId: row.requestId, responseId: row.responseId,
        requestSha256: row.requestSha256, responseSha256: row.responseSha256, observedAt: row.observedAt, requestRef: row.requestRef, responseRef: row.responseRef });
    }
  }
  if (mockRows.length > input.expected.caseCount * 100) throw new Error("supervisor mock witness rows exceed the exact group bound");
  const unmockedEntries = receipt.unmockedCalls ?? [];
  if (canonicalJson(unmockedEntries) !== canonicalJson([...unmockedEntries].sort((a, b) => a.caseId.localeCompare(b.caseId)))
    || unmockedEntries.length > input.expected.caseCount || new Set(unmockedEntries.map((item) => item.caseId)).size !== unmockedEntries.length
    || unmockedEntries.some((item) => !captures.some((capture) => capture.caseId === item.caseId && capture.shardId === item.shardId))) {
    throw new Error("supervisor unmocked-call inventory is unordered, duplicated, or outside its exact case bounds");
  }
  const unmockedRows: z.infer<typeof unmockedCallsRow>[] = [];
  for (const entry of unmockedEntries) {
    const launch = launches.find((item) => item.shardId === entry.shardId);
    const frame = parseCanonicalFrame(proofFor(entry.ref), unmockedCallsFrame, "unmocked call frame");
    if (!launch || frame.caseId !== entry.caseId || frame.shardId !== entry.shardId || frame.upstreamRunId !== launch.upstreamRunId || !contextMatches(frame.context)
      || new Set(frame.calls.map((call) => `${call.origin}\u0000${call.requestId}`)).size !== frame.calls.length) {
      throw new Error("unmocked call frame is foreign, duplicated, or outside its launch context");
    }
    unmockedRows.push({ caseId: frame.caseId, shardId: frame.shardId, calls: frame.calls });
  }
  const rowsByCase = new Map<string, string[]>();
  for (const row of mockRows) {
    const components = rowsByCase.get(row.caseId) ?? [];
    components.push(row.componentId);
    rowsByCase.set(row.caseId, components);
  }
  for (const capture of captures) {
    const observed = [...new Set(rowsByCase.get(capture.caseId) ?? [])].sort();
    if (canonicalJson(observed) !== canonicalJson([...capture.coverage.observedMockedComponentIds].sort())) {
      throw new Error("raw mock witness component set differs from the original case capture coverage");
    }
  }
  if (new Set(mockRows.map((row) => row.requestId)).size !== mockRows.length
    || new Set(mockRows.map((row) => row.responseId)).size !== mockRows.length) throw new Error("raw mock witness request and response IDs are not unique");
  const modelSourceRefs = captures.flatMap((capture) => capture.modelReceipts.map((item) => {
    const projection = parseCanonicalFrame(proofFor(item.receiptRef), governedModelReceiptProjectionSchema, "governed model receipt projection");
    if (projection.caseId !== item.caseId || projection.declaredStepIndex !== item.declaredStepIndex
      || projection.requestId !== item.requestId || projection.receiptId !== item.receiptId) {
      throw new Error("governed model projection differs from its original capture row");
    }
    return projection.sourceReceiptRef;
  }));
  const identityProjectionRefs = [...receipt.additionalSupervisorReceiptRefs, ...(input.expected.expectedIdentityRefs ?? []),
    ...captures.flatMap((capture) => capture.artifacts)];
  const identitySourceRefs = identityProjectionRefs.flatMap((ref) => {
    const proof = proofFor(ref);
    const account = E2EApplicationAccountIdentityProjectionSchema.safeParse((() => {
      try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(validateProofBytes(proof, "account identity projection"))) as unknown; }
      catch { return null; }
    })());
    if (account.success) return [account.data.sourceReceiptRef];
    const subject = E2EApplicationSubjectIdentityProjectionSchema.safeParse((() => {
      try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(validateProofBytes(proof, "subject identity projection"))) as unknown; }
      catch { return null; }
    })());
    return subject.success ? [subject.data.sourceReceiptRef] : [];
  });
  const observationEvidenceRefs = captures.flatMap((capture) => capture.assertions.flatMap((assertion) => {
    if (!assertion.evidenceRef) return [];
    const observation = parseCanonicalFrame(proofFor(assertion.evidenceRef), E2EApplicationAssertionObservationSchema, "assertion observation frame");
    return refsInAssertionObservation(observation);
  }));
  const agentOperationSourceRefs = captures.flatMap((capture) => readAgentOperationFrames(capture, proofFor).map((item) => item.sourceReceiptRef));
  const referenced: E2EApplicationEvidenceRef[] = [receipt.cleanupRef, ...receipt.additionalSupervisorReceiptRefs,
    ...(input.expected.expectedIdentityRefs ?? []),
    ...receipt.caseCaptures.flatMap((entry) => [entry.ref]), ...receipt.mockConsumptions.flatMap((entry) => [entry.ref]),
    ...(receipt.unmockedCalls ?? []).flatMap((entry) => [entry.ref]), ...agentOperationSourceRefs,
    ...captures.flatMap(refsInCapture), ...modelSourceRefs, ...identitySourceRefs, ...observationEvidenceRefs, ...cleanup.ownedCleanupReceiptRefs,
    ...receipt.mockConsumptions.flatMap((entry) => {
      const frame = parseCanonicalFrame(proofFor(entry.ref), mockConsumptionFrame, "mock consumption frame");
      return frame.rows.flatMap((row) => [row.requestRef, row.responseRef]);
    })];
  const byId = new Map<string, E2EApplicationEvidenceRef>();
  for (const ref of referenced) {
    const previous = byId.get(ref.artifactId);
    if (previous && evidenceKey(previous) !== evidenceKey(ref)) throw new Error("supervisor evidence closure has conflicting metadata for one artifact ID");
    byId.set(ref.artifactId, ref);
    proofFor(ref);
  }
  if (byId.size !== inventory.size || [...inventory.keys()].some((artifactId) => !byId.has(artifactId))) throw new Error("supervisor evidence inventory contains extra or unreferenced bytes");
  const actualSupervisorRefs = [readback.receipt.ref, ...receipt.additionalSupervisorReceiptRefs]
    .sort((a, b) => a.artifactId.localeCompare(b.artifactId));
  const sortedAdditionalRefs = [...receipt.additionalSupervisorReceiptRefs].sort((a, b) => a.artifactId.localeCompare(b.artifactId));
  if (canonicalJson(receipt.additionalSupervisorReceiptRefs) !== canonicalJson(sortedAdditionalRefs)
    || new Set(actualSupervisorRefs.map((ref) => ref.artifactId)).size !== actualSupervisorRefs.length) throw new Error("supervisor receipt references are unordered or contain duplicate artifact IDs");
  const claimedSupervisorRefs = input.supervisorReceiptRefs.map((raw) => E2EApplicationEvidenceRefSchema.parse(raw));
  const sortedActualSupervisorRefs = [...claimedSupervisorRefs].sort((a, b) => a.artifactId.localeCompare(b.artifactId));
  if (canonicalJson(actualSupervisorRefs) !== canonicalJson(sortedActualSupervisorRefs)
    || canonicalJson(claimedSupervisorRefs) !== canonicalJson(sortedActualSupervisorRefs)) throw new Error("opaque supervisor receipt refs differ from the exact sorted raw receipt inventory");
  return { readback, receipt, captures, cleanup, mockConsumptions: mockRows, unmockedCalls: unmockedRows, evidenceBytes: totalBytes };
}

/** Performs raw-frame and transitive-byte closure checks for the installed transport before it returns bytes. */
export function validateE2EApplicationSupervisorReadbackStructure(readbackInput: E2EApplicationSupervisorReadback, caseCount = 64): void {
  const readback = proofInventorySnapshot(readbackInput, caseCount);
  const receipt = parseCanonicalFrame(readback.receipt, supervisorReceiptFrame, "supervisor receipt frame");
  const inventory = new Map(readback.evidence.map((item) => [item.ref.artifactId, item]));
  const proofFor = (ref: E2EApplicationEvidenceRef) => {
    const proof = inventory.get(ref.artifactId);
    if (!proof || evidenceKey(proof.ref) !== evidenceKey(ref)) throw new Error("supervisor readback has an incomplete or conflicting raw-byte closure");
    return proof;
  };
  const captures = receipt.caseCaptures.map((entry) => parseCanonicalFrame(proofFor(entry.ref), E2EApplicationCaseCaptureSchema, "case capture frame"));
  const cleanup = parseCanonicalFrame(proofFor(receipt.cleanupRef), cleanupFrame, "owned cleanup frame");
  let mockManifestDigest = "0".repeat(64);
  for (const entry of receipt.mockConsumptions) {
    const mock = parseCanonicalFrame(proofFor(entry.ref), mockConsumptionFrame, "mock consumption frame");
    const digest = mock.rows[0]?.mockManifestDigest;
    if (digest) mockManifestDigest = digest;
    for (const row of mock.rows) { proofFor(row.requestRef); proofFor(row.responseRef); }
  }
  for (const entry of receipt.unmockedCalls ?? []) parseCanonicalFrame(proofFor(entry.ref), unmockedCallsFrame, "unmocked call frame");
  for (const capture of captures) for (const row of capture.modelReceipts) {
    const projection = parseCanonicalFrame(proofFor(row.receiptRef), governedModelReceiptProjectionSchema, "governed model receipt projection");
    if (projection.caseId !== row.caseId || projection.declaredStepIndex !== row.declaredStepIndex
      || projection.requestId !== row.requestId || projection.receiptId !== row.receiptId) throw new Error("model receipt projection differs from its capture row");
    proofFor(projection.sourceReceiptRef);
  }
  for (const capture of captures) readAgentOperationFrames(capture, proofFor);
  for (const capture of captures) for (const assertion of capture.assertions) if (assertion.evidenceRef) {
    const observation = parseCanonicalFrame(proofFor(assertion.evidenceRef), E2EApplicationAssertionObservationSchema, "assertion observation frame");
    for (const ref of refsInAssertionObservation(observation)) proofFor(ref);
  }
  const expectedSupervisorRefs = receipt.additionalSupervisorReceiptRefs;
  const claimedRefs = [readback.receipt.ref, ...expectedSupervisorRefs].sort((a, b) => a.artifactId.localeCompare(b.artifactId));
  readE2EApplicationSupervisorProof({ readback, expected: { bindingDigest: receipt.context.bindingDigest,
    compiledInventoryDigest: receipt.context.compiledInventoryDigest, preparedEnvironmentDigest: receipt.context.preparedEnvironmentDigest,
    candidateDigest: receipt.context.candidateDigest, roundId: receipt.context.roundId, runId: receipt.context.runId,
    groupId: receipt.context.groupId, mockManifestDigest, caseCount, expectedSupervisorReceiptRefs: expectedSupervisorRefs,
    ownedResourceInventoryDigest: cleanup.ownedResourceInventoryDigest, launches: receipt.launches },
    applicationCaptures: captures, supervisorReceiptRefs: claimedRefs, cleanupConfirmed: true, cleanupServerListening: false });
}

const selectionPacket = E2EApplicationSelectionPacketSchema;
export function normalizeE2EApplicationPublicList(raw: unknown, targetId: string): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const row = raw as Record<string, unknown>;
  if (Object.keys(row).length === 1 && Object.hasOwn(row, "pairs") && Array.isArray(row.pairs)) {
    return { pairs: row.pairs, targets: [targetId], unmatched: [] };
  }
  return raw;
}
const processRecord = z.object({ status: z.number().int().nullable(), signal: z.string().max(64).nullable(), startedAt: utc, finishedAt: utc,
  timedOut: z.boolean(), aborted: z.boolean(), stdoutSha256: sha, stderrSha256: sha, stdoutBytes: z.number().int().nonnegative().max(E2E_REPORT_MAX_BYTES),
  stderrBytes: z.number().int().nonnegative().max(E2E_REPORT_MAX_BYTES) }).strict();
const encodedBytes = z.object({ bytesBase64: z.string().max(6 * 1024 * 1024), byteLength: z.number().int().nonnegative().max(E2E_REPORT_MAX_BYTES), sha256: sha }).strict();
const encodedProof = z.object({ ref: E2EApplicationEvidenceRefSchema, bytesBase64: z.string().max(35_000_000) }).strict();
export const E2EApplicationSupervisorReadbackWireSchema = z.object({ schemaVersion: z.literal("e2e-application-supervisor-readback/v1"), receipt: encodedProof,
  evidence: z.array(encodedProof).max(e2eApplicationSupervisorEvidenceEntryMax(64)) }).strict();
export type E2EApplicationSupervisorReadbackWire = z.infer<typeof E2EApplicationSupervisorReadbackWireSchema>;
const runStartSchema = z.object({ schemaVersion: z.literal("e2e-run-start-capture/v1"), challenge: z.string().uuid(), runId: z.string().uuid(),
  seq: z.number().int().positive(), at: utc }).strict();
const shardCollection = z.object({ shardId: id(120), launchId: id(128), launchConfigDigest: sha, fixedAssetDigests: z.record(id(256), sha), publicList: boundedData,
  publicListBytes: encodedBytes, listStderr: encodedBytes, rawReport: encodedBytes, runStderr: encodedBytes, runStartCapture: encodedBytes, runStart: runStartSchema,
  listProcess: processRecord, runProcess: processRecord }).strict();
const applicationCapture = E2EApplicationCaseCaptureSchema;
export const E2EApplicationCollectionSchema = z.object({ protocol: z.literal("e2e-application-collection/v1"), shards: z.array(shardCollection).min(1).max(3),
  applicationCaptures: z.array(applicationCapture).max(64), supervisorReceiptRefs: z.array(E2EApplicationEvidenceRefSchema).max(200),
  mockConsumptions: z.array(z.object({ caseId: id(160), componentId: id(120), runId: z.string().uuid(), mockManifestDigest: sha, lifecycleId: id(120),
    producer: E2EApplicationProducerSchema, requestId: id(256), responseId: id(256), requestSha256: sha, responseSha256: sha, observedAt: utc,
    requestRef: E2EApplicationEvidenceRefSchema, responseRef: E2EApplicationEvidenceRefSchema }).strict()).max(2048),
  /** The calls no approved mock matched, per case; absent when there were none. */
  unmockedCalls: z.array(unmockedCallsRow).max(64).optional(),
  declaredMockComponentIds: z.array(id(120)).max(32), supervisorReadback: E2EApplicationSupervisorReadbackWireSchema,
  receivedAt: utc, cleanup: z.enum(["confirmed", "pending", "failed"]) }).strict().superRefine((collection, context) => {
  const transferCeiling = e2eApplicationPrivateTransferMaxBytes(Math.max(1, collection.applicationCaptures.length), collection.shards.length);
  const encodedPayloadLength = collection.shards.reduce((total, shard) => total + shard.publicListBytes.bytesBase64.length + shard.listStderr.bytesBase64.length
    + shard.rawReport.bytesBase64.length + shard.runStderr.bytesBase64.length + shard.runStartCapture.bytesBase64.length, 0)
    + collection.supervisorReadback.receipt.bytesBase64.length + collection.supervisorReadback.evidence.reduce((total, item) => total + item.bytesBase64.length, 0);
  if (encodedPayloadLength > transferCeiling) context.addIssue({ code: "custom", path: [], message: "encoded private evidence exceeds the active transfer ceiling before allocation" });
  if (new Set(collection.shards.map((item) => item.shardId)).size !== collection.shards.length) context.addIssue({ code: "custom", path: ["shards"], message: "shard IDs must be unique" });
  const caseIds = collection.applicationCaptures.map((item) => item.caseId);
  if (new Set(caseIds).size !== caseIds.length) context.addIssue({ code: "custom", path: ["applicationCaptures"], message: "case captures must be unique" });
  const modelRows = collection.applicationCaptures.flatMap((item) => item.modelReceipts);
  if (modelRows.length > 200 || new Set(modelRows.map((item) => item.requestId)).size !== modelRows.length
    || new Set(modelRows.map((item) => item.receiptId)).size !== modelRows.length
    || canonicalJson(modelRows) !== canonicalJson([...modelRows].sort((a, b) => `${a.caseId}:${String(a.declaredStepIndex).padStart(2, "0")}:${a.requestId}`
      .localeCompare(`${b.caseId}:${String(b.declaredStepIndex).padStart(2, "0")}:${b.requestId}`)))) {
    context.addIssue({ code: "custom", path: ["applicationCaptures"], message: "governed model receipt rows must be globally bounded, unique, and ordered" });
  }
  if (new Set(collection.mockConsumptions.map((item) => item.requestId)).size !== collection.mockConsumptions.length
    || new Set(collection.mockConsumptions.map((item) => item.responseId)).size !== collection.mockConsumptions.length) {
    context.addIssue({ code: "custom", path: ["mockConsumptions"], message: "mock consumption request and response identities must be unique" });
  }
  for (const shard of collection.shards) for (const field of [shard.publicListBytes, shard.listStderr, shard.rawReport, shard.runStderr, shard.runStartCapture]) {
    try {
      if (field.byteLength > E2E_REPORT_MAX_BYTES || field.bytesBase64.length !== Math.ceil(field.byteLength / 3) * 4) throw new Error();
      const decoded = Buffer.from(field.bytesBase64, "base64"); if (decoded.toString("base64") !== field.bytesBase64 || decoded.byteLength !== field.byteLength || createHash("sha256").update(decoded).digest("hex") !== field.sha256) throw new Error();
    }
    catch { context.addIssue({ code: "custom", path: ["shards"], message: "private shard bytes are not canonical base64 with the declared size and digest" }); }
  }
  for (const shard of collection.shards) {
    if (shard.publicListBytes.byteLength !== shard.listProcess.stdoutBytes || shard.publicListBytes.sha256 !== shard.listProcess.stdoutSha256
      || shard.listStderr.byteLength !== shard.listProcess.stderrBytes || shard.listStderr.sha256 !== shard.listProcess.stderrSha256
      || shard.rawReport.byteLength !== shard.runProcess.stdoutBytes || shard.rawReport.sha256 !== shard.runProcess.stdoutSha256
      || shard.runStderr.byteLength !== shard.runProcess.stderrBytes || shard.runStderr.sha256 !== shard.runProcess.stderrSha256) {
      context.addIssue({ code: "custom", path: ["shards"], message: "private raw report or public-list bytes do not match their exact process receipt" });
    }
  }
  const proofRows = [collection.supervisorReadback.receipt, ...collection.supervisorReadback.evidence];
  const proofIds = new Set<string>();
  const declaredProofBytes = proofRows.reduce((total, proof) => total + proof.ref.byteLength, 0);
  let proofBytes = 0;
  if (!Number.isSafeInteger(declaredProofBytes) || declaredProofBytes > 26_214_400) {
    context.addIssue({ code: "custom", path: ["supervisorReadback"], message: "retained supervisor proof exceeds the admitted aggregate byte bound" });
  }
  for (const proof of proofRows) {
    try {
      const expectedLength = Math.ceil(proof.ref.byteLength / 3) * 4;
      if (proof.ref.byteLength > 26_214_400 || proof.bytesBase64.length !== expectedLength || proof.bytesBase64.length > 35_000_000) throw new Error();
      const bytes = Buffer.from(proof.bytesBase64, "base64");
      if (bytes.toString("base64") !== proof.bytesBase64 || bytes.byteLength !== proof.ref.byteLength
        || createHash("sha256").update(bytes).digest("hex") !== proof.ref.sha256 || proofIds.has(proof.ref.artifactId)) throw new Error();
      proofIds.add(proof.ref.artifactId); proofBytes += bytes.byteLength;
    } catch { context.addIssue({ code: "custom", path: ["supervisorReadback"], message: "retained supervisor proof bytes do not match unique immutable refs" }); }
  }
  if (collection.supervisorReadback.evidence.length > e2eApplicationSupervisorEvidenceEntryMax(Math.max(1, collection.applicationCaptures.length))
    || proofBytes > 26_214_400) context.addIssue({ code: "custom", path: ["supervisorReadback"], message: "retained supervisor proof exceeds the admitted inventory or byte bound" });
  const aggregateBytes = collection.shards.reduce((total, shard) => total + shard.publicListBytes.byteLength + shard.rawReport.byteLength
    + shard.listStderr.byteLength + shard.runStderr.byteLength + shard.runStartCapture.byteLength, 0)
    + Buffer.byteLength(canonicalJson(collection.applicationCaptures)) + Buffer.byteLength(canonicalJson(collection.mockConsumptions))
    + Buffer.byteLength(canonicalJson(collection.unmockedCalls ?? [])) + Buffer.byteLength(canonicalJson(collection.supervisorReadback));
  if (aggregateBytes > e2eApplicationPrivateTransferMaxBytes(Math.max(1, collection.applicationCaptures.length), collection.shards.length)) {
    context.addIssue({ code: "custom", path: [], message: "application private collection exceeds its aggregate transfer ceiling" });
  }
});
export type E2EApplicationCollection = z.infer<typeof E2EApplicationCollectionSchema>;
export type E2EApplicationMockConsumption = E2EApplicationCollection["mockConsumptions"][number];

export function decodeE2EApplicationSupervisorReadback(wireInput: unknown): E2EApplicationSupervisorReadback {
  const wire = E2EApplicationSupervisorReadbackWireSchema.parse(wireInput);
  const declaredBytes = [wire.receipt, ...wire.evidence].reduce((total, item) => total + item.ref.byteLength, 0);
  if (!Number.isSafeInteger(declaredBytes) || declaredBytes > 26_214_400) throw new Error("retained supervisor proof exceeds its aggregate allocation bound");
  const decode = (item: z.infer<typeof encodedProof>): E2EApplicationProofBytes => {
    const expectedEncodedLength = Math.ceil(item.ref.byteLength / 3) * 4;
    if (item.ref.byteLength > 26_214_400 || item.bytesBase64.length !== expectedEncodedLength || item.bytesBase64.length > 35_000_000) {
      throw new Error("retained supervisor proof has an invalid preallocation bound");
    }
    const bytes = Buffer.from(item.bytesBase64, "base64");
    if (bytes.toString("base64") !== item.bytesBase64 || bytes.byteLength !== item.ref.byteLength
      || createHash("sha256").update(bytes).digest("hex") !== item.ref.sha256) throw new Error("retained supervisor proof bytes differ from the immutable reference");
    return { ref: item.ref, bytes: new Uint8Array(bytes) };
  };
  return E2EApplicationSupervisorReadbackSchema.parse({ schemaVersion: wire.schemaVersion,
    receipt: decode(wire.receipt), evidence: wire.evidence.map(decode) });
}

export function encodeE2EApplicationSupervisorReadback(readbackInput: E2EApplicationSupervisorReadback): E2EApplicationSupervisorReadbackWire {
  const readback = proofInventorySnapshot(readbackInput, 64);
  const encode = (proof: E2EApplicationProofBytes) => {
    const bytes = validateProofBytes(proof, "supervisor readback proof");
    return { ref: proof.ref, bytesBase64: bytes.toString("base64") };
  };
  const wire = { schemaVersion: readback.schemaVersion, receipt: encode(readback.receipt), evidence: readback.evidence.map(encode) };
  return E2EApplicationSupervisorReadbackWireSchema.parse(wire);
}

export const E2EApplicationCollectionOracleSchema = z.object({ protocol: z.literal("e2e-application-oracle/v1"), binding: E2ERunBindingSchema, round: E2ERoundSchema,
  groupId: id(80), compiledInventoryDigest: sha, expectedShardIds: z.array(id(120)).min(1).max(3), expectedCases: z.array(E2EExpectedCaseSchema).max(64),
  expectedSupervisorReceiptRefs: z.array(E2EApplicationEvidenceRefSchema).min(1).max(32), ownedResourceInventoryDigest: sha,
  selectionPackets: z.array(selectionPacket).min(1).max(3), compiledShardConfigDigests: z.array(z.object({ shardId: id(120), configDigest: sha }).strict()).min(1).max(3),
  expectedMockComponentIdsByTarget: z.array(z.object({ targetId: id(80), componentIds: z.array(id(120)).max(32) }).strict()).max(3),
  expectedMocksByCase: z.array(z.object({ caseId: id(160), specs: z.array(E2EMockSpecSchema).max(32) }).strict()).max(64),
  /** The mock components the host serves to the application as in-network mocks of its declared origins, and the origin each stands for. Absent means none: rows for any component then follow the executor-request witness rules. */
  mockOrigins: z.array(z.object({ componentId: id(120), originRef: id(200) }).strict()).max(32).optional(),
  observationBindings: z.array(E2EApplicationObservationBindingSchema).max(64).nullable(),
  assertionAssets: z.array(E2EApplicationAssertionAssetBindingSchema).max(128),
  governedModelReceipts: z.array(E2EApplicationGovernedModelReceiptRowSchema).max(200).nullable(), ownedClosedAt: utc.nullable(),
  applicationIdsByCase: z.array(z.object({ caseId: id(160), applicationId: id(120), buildManifestDigest: sha, buildSourceManifestDigest: sha,
    buildSourceArchiveSha256: sha, runtimeManifestDigest: sha, accountRef: E2ERuntimeAccountRefSchema, origin: origin.nullable(), targetId: id(80), platform: id(256),
    artifactCapabilities: z.array(z.enum(["screenshot", "video"])).max(2), stateCapability: z.boolean(),
    engine: z.object({ name: id(120), version: id(120), spiVersion: z.literal(1), platform: id(256), capabilities: z.array(id(120)).max(64) }).strict().nullable(),
    accountContextId: id(120), accountContextDigest: sha, assertionDigests: z.array(sha).min(1).max(20), scenario: E2EScenarioSchema }).strict()).max(64),
  preparedEnvironmentDigest: sha, originByApplicationId: z.array(z.object({ applicationId: id(120), origin }).strict()).max(12),
  fixedAssetDigestsByShard: z.array(z.object({ shardId: id(120), digests: z.record(id(256), sha) }).strict()).max(3),
  modelRoute: z.object({ routeId: id(120), routeRevision: id(120) }).strict().nullable(),
  /**
   * What the worker handed over about its AI navigation steps (Task 4.4a): the receipts of its model calls, the action ledgers, the run's value key. Absent or null for a group
   * with no agent step, and for every oracle built before Task 4.4a. The route in it is the one the oracle's `modelRoute` names (the broker puts the registry's definition there).
   */
  agentModel: E2EAgentModelEvidenceSchema.nullable().optional(),
  /**
   * The scope of the round the oracle is for (Task FU2, AGENTSCOPE): a receipt of the scripted model double is admissible only in a `qualification` round. It comes from the caller that
   * runs the round (the qualification runner), never from the route's own scope, so a registry row that claims `qualification` cannot make scripted receipts count in a customer
   * round. Absent means `standard` (every oracle built before this field, and every customer round).
   */
  roundScope: z.enum(["standard", "qualification"]).optional(),
  /**
   * Present only for the oracle of an audit replay (Task 4.6b): the group runs with no model route, so its AI navigation steps are judged from the runner's account of them (a step is
   * whole only when it is replayed in full from the recording it is bound to) and no model evidence may come with it. The bindings are the admission's.
   */
  replay: z.object({ bindings: z.array(z.object({ caseId: id(160), stepIndex: z.number().int().min(0).max(255), keyHash: sha, traceSha256: sha, actionCount: z.number().int().min(0).max(8) }).strict()).max(12) }).strict().optional(),
  sourceDigest: sha, environment: z.record(id(256), boundedData), usage: z.record(id(256), z.number().nonnegative()), limits: z.record(id(256), z.number().nonnegative()),
  createdAt: utc }).strict().superRefine((oracle, context) => {
    const expectedCasesById = new Map(oracle.expectedCases.map((item) => [item.caseId, item]));
    const mockRowsByCase = new Map(oracle.expectedMocksByCase.map((item) => [item.caseId, item]));
    if (mockRowsByCase.size !== expectedCasesById.size || [...expectedCasesById.keys()].some((caseId) => !mockRowsByCase.has(caseId))) {
      context.addIssue({ code: "custom", path: ["expectedMocksByCase"], message: "source-derived mock expectations must cover every admitted case exactly once" });
    }
    const mockMap = new Map<string, z.infer<typeof E2EMockSpecSchema>>();
    for (const row of oracle.expectedMocksByCase) {
      const expected = expectedCasesById.get(row.caseId);
      if (!expected || row.specs.some((spec) => spec.requestedTargetId !== expected.targetId || spec.effectiveTargetId !== expected.targetId)) {
        context.addIssue({ code: "custom", path: ["expectedMocksByCase"], message: "case mock expectations do not match the compiled target" });
      }
      for (const spec of row.specs) mockMap.set(canonicalJson(spec), spec);
    }
    const sourceDerivedMocks = [...mockMap.values()];
    const originRows = oracle.mockOrigins ?? [];
    if (new Set(originRows.map((item) => item.componentId)).size !== originRows.length
      || originRows.some((item) => !sourceDerivedMocks.some((spec) => spec.componentId === item.componentId))) {
      context.addIssue({ code: "custom", path: ["mockOrigins"], message: "mock origins must name each approved mock component at most once" });
    }
    if (createHash("sha256").update(canonicalJson(sourceDerivedMocks)).digest("hex") !== oracle.binding.mockManifestDigest) {
      context.addIssue({ code: "custom", path: ["expectedMocksByCase"], message: "case mock expectations do not reproduce the admitted mock manifest digest" });
    }
    const componentsByTarget = new Map<string, string[]>();
    for (const spec of sourceDerivedMocks) {
      const components = componentsByTarget.get(spec.effectiveTargetId) ?? [];
      components.push(spec.componentId); componentsByTarget.set(spec.effectiveTargetId, components);
    }
    const derivedComponents = oracle.expectedMockComponentIdsByTarget.map(({ targetId }) => ({ targetId,
      componentIds: (componentsByTarget.get(targetId) ?? []).sort() })).sort((a, b) => a.targetId.localeCompare(b.targetId));
    if ([...componentsByTarget.keys()].some((targetId) => !oracle.expectedMockComponentIdsByTarget.some((row) => row.targetId === targetId))
      || canonicalJson(derivedComponents) !== canonicalJson([...oracle.expectedMockComponentIdsByTarget].sort((a, b) => a.targetId.localeCompare(b.targetId)))) {
      context.addIssue({ code: "custom", path: ["expectedMockComponentIdsByTarget"], message: "mock component projection differs from the source-derived mock inventory" });
    }
    for (const [name, rows, max] of [["environment", oracle.environment, 64], ["usage", oracle.usage, 64], ["limits", oracle.limits, 64]] as const) {
      if (Object.keys(rows).length > max) context.addIssue({ code: "custom", path: [name], message: "oracle fact map exceeds its bounded key count" });
    }
    const agentRoute = oracle.agentModel?.route ?? null;
    // An audit replay (Task 4.6b) has no route: model evidence with one is refused by the qualifier as `replay-model-called`, not as a malformed oracle.
    if (oracle.replay === undefined && oracle.agentModel != null && (oracle.modelRoute === null || !oracle.applicationIdsByCase.some((fact) => fact.scenario.steps.some((step) => step.kind === "agent"))
      || (agentRoute !== null && (agentRoute.routeId !== oracle.modelRoute.routeId || e2eModelRouteRevision(agentRoute) !== oracle.modelRoute.routeRevision)))) {
      context.addIssue({ code: "custom", path: ["agentModel"], message: "model-receipts-mismatch: the model evidence is not for a group with AI navigation steps under the admitted route" });
    }
    const modelRows = oracle.governedModelReceipts ?? [];
    if (modelRows.length > 200 || new Set(modelRows.map((item) => item.requestId)).size !== modelRows.length
      || new Set(modelRows.map((item) => item.receiptId)).size !== modelRows.length
      || (oracle.modelRoute === null && modelRows.length > 0)
      || modelRows.some((item) => !oracle.applicationIdsByCase.some((fact) => fact.caseId === item.caseId
        && fact.scenario.steps[item.declaredStepIndex]?.kind === "agent"))
      || new Set(oracle.expectedShardIds).size !== oracle.expectedShardIds.length
      || new Set(oracle.expectedSupervisorReceiptRefs.map((ref) => ref.artifactId)).size !== oracle.expectedSupervisorReceiptRefs.length
      || canonicalJson(oracle.expectedSupervisorReceiptRefs) !== canonicalJson([...oracle.expectedSupervisorReceiptRefs].sort((a, b) => a.artifactId.localeCompare(b.artifactId)))
      || new Set(oracle.compiledShardConfigDigests.map((item) => item.shardId)).size !== oracle.compiledShardConfigDigests.length
      || new Set(oracle.expectedMockComponentIdsByTarget.map((item) => item.targetId)).size !== oracle.expectedMockComponentIdsByTarget.length
      || new Set(oracle.applicationIdsByCase.map((item) => item.caseId)).size !== oracle.applicationIdsByCase.length
      || new Set(oracle.fixedAssetDigestsByShard.map((item) => item.shardId)).size !== oracle.fixedAssetDigestsByShard.length) {
      context.addIssue({ code: "custom", path: [], message: "oracle contains duplicate shard, target, case or asset identities" });
    }
    for (const item of oracle.fixedAssetDigestsByShard) if (Object.keys(item.digests).length > 16) {
      context.addIssue({ code: "custom", path: ["fixedAssetDigestsByShard"], message: "oracle fixed asset inventory exceeds its bound" });
    }
  });
export type E2EApplicationCollectionOracle = z.infer<typeof E2EApplicationCollectionOracleSchema>;

export function e2eApplicationPrivateTransferMaxBytes(caseCount: number, shardCount: number): number {
  if (!Number.isSafeInteger(caseCount) || caseCount < 1 || caseCount > 64 || !Number.isSafeInteger(shardCount) || shardCount < 1 || shardCount > 3) throw new TypeError("application private transfer inventory exceeds admitted bounds");
  return e2ePrivateTransferMaxBytes(caseCount, 1)
    + (shardCount - 1) * Math.ceil((E2E_REPORT_MAX_BYTES + E2E_APP_RPC_FRAME_MAX_BYTES) * 4 / 3);
}

type ReportTarget = E2EApplicationReport["run"]["targets"][number];
type ExpectedTarget = Pick<E2EApplicationCollectionOracle["applicationIdsByCase"][number], "platform" | "artifactCapabilities" | "stateCapability" | "engine">;
/**
 * Whether the runner's own account of a target is the target the oracle compiled. An engine-less target reports the runner's "none"
 * engine; an engine target reports exactly its name, version, SPI and capabilities. An API target may only ever be engine-less or
 * Rovara's pinned HTTP engine, so a report naming any other engine for it never matches, whatever the oracle holds.
 */
export function e2eApplicationReportTargetMatches(reportTarget: ReportTarget, expectedTarget: ExpectedTarget): boolean {
  if (reportTarget.platform !== expectedTarget.platform
    || canonicalJson([...reportTarget.artifactCapabilities].sort()) !== canonicalJson([...expectedTarget.artifactCapabilities].sort())
    || reportTarget.stateCapability !== expectedTarget.stateCapability) return false;
  const engine = expectedTarget.engine;
  if (engine === null) {
    return reportTarget.engine.name === "none" && reportTarget.engine.version === "unversioned" && reportTarget.engine.spiVersion === 1
      && reportTarget.capabilities.length === 0 && reportTarget.artifactCapabilities.length === 0 && !reportTarget.stateCapability;
  }
  if (expectedTarget.platform === "api" && !isPinnedRovaraHttpEngine(engine)) return false;
  return reportTarget.engine?.name === engine.name && reportTarget.engine.version === engine.version && reportTarget.engine.spiVersion === engine.spiVersion
    && reportTarget.platform === engine.platform && canonicalJson([...reportTarget.capabilities].sort()) === canonicalJson([...engine.capabilities].sort());
}

/**
 * The runtime account reference of one case: the single reference of the case's application and account profile (one application can carry several accounts, an owner and a
 * viewer, so never the application's first), and only when the case's own runtime reference is for that same account. The oracle is the second line after admission
 * validation, so it holds the reference and the case to each other itself.
 */
export function admittedRuntimeAccountRef(input: { runtimeRef: Readonly<{ targetId: string; applicationId: string; accountProfileId: string }>; accountProfileId: string;
  runtimeAccountRefs: readonly E2ERuntimeAccountRef[] }): E2ERuntimeAccountRef {
  const { runtimeRef, accountProfileId } = input;
  if (runtimeRef.accountProfileId !== accountProfileId) {
    throw new Error(`the admitted runtime reference of target ${runtimeRef.targetId} is for account profile ${runtimeRef.accountProfileId}, not the case's account profile ${accountProfileId}`);
  }
  const matches = input.runtimeAccountRefs.filter((item) => item.applicationId === runtimeRef.applicationId && item.profileId === accountProfileId);
  if (matches.length !== 1) {
    throw new Error(`the admitted selection has ${matches.length === 0 ? "no" : "more than one"} runtime account reference for account profile ${accountProfileId} of application ${runtimeRef.applicationId}`);
  }
  return matches[0]!;
}

/**
 * The mocks the host serves to an application as its declared origins, found the way the host finds them: by the origin's contract path in the application's own project contract.
 * A broker derives the same list from the admitted plan, so the containers a run owned are known without asking the worker.
 */
export function e2eApplicationHostedMockOrigins(compiled: E2ECompiledApplicationSuite): { componentId: string; originRef: string }[] {
  const runtimeRefs = compiled.runtimeAdmissionContext.selectionInput.intent.applicationRuntimeRefs;
  const hosted: { componentId: string; originRef: string }[] = [];
  for (const applicationId of new Set(runtimeRefs.map((ref) => ref.applicationId))) {
    const service = readE2EApplicationProjectContract(compiled.runtimeAdmission.sourceSnapshot, applicationId)?.service;
    const targetIds = new Set(compiled.expectedCases.flatMap((expected) => (runtimeRefs.find((ref) => ref.targetId === expected.targetId)?.applicationId === applicationId ? [expected.targetId] : [])));
    const plan = planApplicationOrigins({ originBindings: service?.originBindings ?? [], mocks: compiled.group.mocks.filter((mock) => targetIds.has(mock.requestedTargetId)) });
    for (const origin of plan.mocked) hosted.push({ componentId: origin.componentId, originRef: origin.originRef });
  }
  return hosted;
}

type Environment = Readonly<{ ci: boolean; trustNoticeShown: boolean; os: string; arch: string; runtime: string }>;
export function createE2EApplicationCollectionOracleFromCompiledSuite(input: { compiled: E2ECompiledApplicationSuite; binding: E2ERunBinding; round: E2ERound;
  environment: Environment; usage: Readonly<Record<string, number>>; limits: Readonly<Record<string, number>>;
  expectedSupervisorReceiptRefs: readonly E2EApplicationEvidenceRef[]; ownedResourceInventoryDigest: string;
  observationBindings: readonly E2EApplicationObservationBinding[] | null; assertionAssets: readonly E2EApplicationAssertionAssetBinding[];
  governedModelReceipts: readonly E2EApplicationGovernedModelReceiptRow[] | null; agentModel?: E2EAgentModelEvidence | null; roundScope?: E2ERoundScope; ownedClosedAt: string | null; now?: string }): E2EApplicationCollectionOracle {
  if (!/^[a-f0-9]{64}$/.test(input.ownedResourceInventoryDigest)) throw new Error("protected cleanup inventory expectation is required");
  const expectedSupervisorReceiptRefs = snapshotSupervisorReceiptRefs(input.expectedSupervisorReceiptRefs);
  const binding = E2ERunBindingSchema.parse(input.binding); const round = E2ERoundSchema.parse(input.round);
  validateE2ECompiledApplicationAdmission(input.compiled, input.compiled.runtimeAdmissionContext.selectionInput.sourceSnapshot);
  const group = input.compiled.group;
  const admittedBinding = round.groupBindings.find((item) => item.groupId === group.groupId);
  const expectedShardIds = input.compiled.shards.map((item) => item.shardId).sort();
  if (!admittedBinding || canonicalJson(admittedBinding) !== canonicalJson(binding) || binding.roundId !== round.roundId
    || binding.groupId !== group.groupId || binding.candidateDigest !== input.compiled.runtimeAdmission.expectedCandidate.digest
    || canonicalJson(binding.expectedCases) !== canonicalJson(input.compiled.expectedCases)
    || canonicalJson(expectedShardIds) !== canonicalJson(input.compiled.inventory.shards.map((item) => item.shardId).sort())) {
    throw new Error("application oracle binding or shard inventory differs from its freshly compiled admitted round");
  }
  const appIds = new Map<string, E2EApplicationCollectionOracle["applicationIdsByCase"][number]>();
  for (const expected of input.compiled.expectedCases) {
    const scenario = input.compiled.bundle.scenarios.find((item) => item.scenarioId === expected.scenarioId);
    const runtimeRef = input.compiled.runtimeAdmissionContext.selectionInput.intent.applicationRuntimeRefs.find((item) => item.targetId === expected.targetId);
    const application = input.compiled.applicationBindings.get(runtimeRef?.applicationId ?? "");
    const runtime = runtimeRef ? e2eRuntimeBindingOf(input.compiled.runtimeBindings, runtimeRef.runtimeProfileId, input.compiled.runtimeKind) : undefined;
    // The case's own account: one application can carry several (an owner and a viewer), so the reference is the one of this case's application and account profile, and
    // exactly one (as approval and the executor's `accountRefFor` resolve it). Never the application's first.
    const accountRef = runtimeRef ? admittedRuntimeAccountRef({ runtimeRef, accountProfileId: expected.accountProfileId,
      runtimeAccountRefs: input.compiled.runtimeAdmissionContext.selectionInput.runtimeAccountRefs }) : undefined;
    const target = input.compiled.runtimeAdmissionContext.launchTargets.find((item) => item.targetId === expected.targetId);
    if (!scenario || !runtimeRef || !application || !runtime || !accountRef || !target) throw new Error("compiled case lacks exact scenario, application, runtime, account, or target binding");
    const originEntry = input.compiled.originByApplicationId.find((item) => item.applicationId === runtimeRef.applicationId);
    if (target.engine?.platform === "api" && !isPinnedRovaraHttpEngine(target.engine)) {
      throw new Error("an API application target may use only Rovara's pinned HTTP engine");
    }
    appIds.set(expected.caseId, { caseId: expected.caseId, applicationId: runtimeRef.applicationId, buildManifestDigest: application.build.manifestDigest,
      buildSourceManifestDigest: application.buildSource.manifest.manifestDigest, buildSourceArchiveSha256: application.buildSource.reference.sha256,
      runtimeManifestDigest: runtime.manifestDigest, accountRef, origin: originEntry?.origin ?? null,
      targetId: expected.targetId, platform: target.engine?.platform ?? "api", artifactCapabilities: target.artifactCapabilities, stateCapability: target.stateCapability,
      engine: target.engine ? { name: target.engine.name, version: target.engine.version, spiVersion: 1, platform: target.engine.platform, capabilities: target.engine.capabilities } : null,
      accountContextId: expected.accountContextId, accountContextDigest: expected.accountContextDigest, assertionDigests: [...expected.assertionDigests], scenario });
  }
  const hostedMockOrigins = e2eApplicationHostedMockOrigins(input.compiled);
  const hostedMockComponents = new Set(hostedMockOrigins.map((item) => item.componentId));
  const body = E2EApplicationCollectionOracleSchema.parse({ protocol: "e2e-application-oracle/v1", binding, round, groupId: group.groupId,
    compiledInventoryDigest: input.compiled.inventory.digest, expectedShardIds, expectedCases: input.compiled.expectedCases,
    expectedSupervisorReceiptRefs, ownedResourceInventoryDigest: input.ownedResourceInventoryDigest,
    selectionPackets: input.compiled.shards.map((item) => item.selection), compiledShardConfigDigests: input.compiled.shards.map((item) => ({ shardId: item.shardId, configDigest: item.expectedConfigDigest })),
    expectedMockComponentIdsByTarget: [...new Set(input.compiled.shards.map((item) => item.targetId))].map((targetId) => ({ targetId,
      componentIds: input.compiled.group.mocks.filter((mock) => mock.requestedTargetId === targetId && mock.effectiveTargetId === targetId).map((mock) => mock.componentId).sort() })),
    expectedMocksByCase: input.compiled.expectedCases.map((expected) => {
      const scenario = input.compiled.bundle.scenarios.find((item) => item.scenarioId === expected.scenarioId);
      if (!scenario) throw new Error("compiled case has no source-derived scenario for mock expectation projection");
      return { caseId: expected.caseId, specs: input.compiled.group.mocks.filter((mock) => mock.requestedTargetId === expected.targetId
        && mock.effectiveTargetId === expected.targetId && (mock.kind !== "api" || (!!mock.apiFixture && (hostedMockComponents.has(mock.componentId)
          || scenario.steps.some((step) => step.kind === "request" && step.method === mock.apiFixture!.method && step.path === mock.apiFixture!.path))))) };
    }),
    ...(hostedMockOrigins.length > 0 ? { mockOrigins: hostedMockOrigins } : {}),
    observationBindings: input.observationBindings, assertionAssets: input.assertionAssets,
    governedModelReceipts: input.governedModelReceipts, ownedClosedAt: input.ownedClosedAt,
    applicationIdsByCase: [...appIds.values()],
    preparedEnvironmentDigest: input.compiled.preparedEnvironmentDigest, originByApplicationId: input.compiled.originByApplicationId,
    fixedAssetDigestsByShard: input.compiled.shards.map((item) => ({ shardId: item.shardId, digests: { compilerInventory: item.inventory.digest } })),
    modelRoute: input.compiled.runtimeAdmissionContext.modelRoute, ...(input.agentModel == null ? {} : { agentModel: input.agentModel }), ...(input.roundScope === undefined ? {} : { roundScope: input.roundScope }),
    ...(input.compiled.runtimeAdmissionContext.replay === undefined ? {} : { replay: { bindings: input.compiled.runtimeAdmissionContext.replay.bindings.map((item) => ({ ...item })) } }),
    sourceDigest: input.compiled.runtimeAdmission.sourceSnapshotDigest,
    environment: input.environment, usage: input.usage, limits: input.limits, createdAt: input.now ?? new Date().toISOString() });
  if (body.observationBindings !== null) {
    const rows = body.observationBindings;
    if (rows.length !== body.expectedCases.length || canonicalJson(rows.map((item) => item.caseId).sort())
      !== canonicalJson(body.expectedCases.map((item) => item.caseId).sort())) throw new Error("protected observation bindings must cover every admitted case exactly once");
    for (const row of rows) {
      const expected = body.expectedCases.find((item) => item.caseId === row.caseId)!;
      const app = input.compiled.applicationBindings.get(row.accountRef.applicationId);
      const compiledAccountRef = body.applicationIdsByCase.find((item) => item.caseId === row.caseId)?.accountRef;
      const selectedArtifact = app?.artifacts.find((item) => canonicalJson(item) === canonicalJson(row.selectedArtifact));
      const assertionIndexes = row.assertionProducers.map((item) => item.assertionIndex).sort((a, b) => a - b);
      const expectedIndexes = expected.assertionDigests.map((_, index) => index);
      if (!app || !compiledAccountRef || canonicalJson(compiledAccountRef) !== canonicalJson(row.accountRef) || !selectedArtifact
        || row.selectedArtifact.buildManifestDigest !== app.build.manifestDigest || row.selectedArtifact.platform !== body.applicationIdsByCase.find((item) => item.caseId === row.caseId)?.platform
        || canonicalJson(assertionIndexes) !== canonicalJson(expectedIndexes)
        || (row.subject.kind === "service" && row.subject.origin !== (body.originByApplicationId.find((item) => item.applicationId === row.accountRef.applicationId)?.origin ?? ""))) {
        throw new Error("protected observation binding differs from admitted account, selected artifact, target, or assertion inventory");
      }
    }
  }
  const derivedAssetIds = body.applicationIdsByCase.flatMap((item) => item.scenario.assertions.flatMap((assertion, index) => assertion.kind === "json"
    ? [{ caseId: item.caseId, assertionIndex: index, kind: "json-schema", id: assertion.schemaRef }]
    : assertion.kind === "state" ? [{ caseId: item.caseId, assertionIndex: index, kind: "state-probe", id: assertion.probeId }]
      : assertion.kind === "file" ? [{ caseId: item.caseId, assertionIndex: index, kind: "fixture-root", id: assertion.fixtureRootId }] : []));
  if (canonicalJson(body.assertionAssets.map(({ caseId, assertionIndex, kind, id }) => ({ caseId, assertionIndex, kind, id })).sort((a, b) => `${a.caseId}:${a.assertionIndex}`.localeCompare(`${b.caseId}:${b.assertionIndex}`)))
    !== canonicalJson(derivedAssetIds.sort((a, b) => `${a.caseId}:${a.assertionIndex}`.localeCompare(`${b.caseId}:${b.assertionIndex}`)))) {
    throw new Error("protected assertion assets differ from the source-derived scenario asset requirements");
  }
  if (body.ownedClosedAt !== null && (!Number.isFinite(Date.parse(body.ownedClosedAt)) || Date.parse(body.ownedClosedAt) < Date.parse(round.admittedAt)
    || Date.parse(body.ownedClosedAt) > Date.parse(round.deadlineAt) + 60_000)) throw new Error("protected owned close time is outside the original run and cleanup window");
  if (body.groupId !== binding.groupId || canonicalJson(body.expectedCases) !== canonicalJson(binding.expectedCases)
    || canonicalJson(body.expectedShardIds) !== canonicalJson(expectedShardIds)
    || canonicalJson(body.compiledShardConfigDigests.map((item) => item.shardId).sort()) !== canonicalJson(expectedShardIds)) {
    throw new Error("application oracle does not cover the exact group binding and shard inventory");
  }
  return body;
}

/** What the verified mock evidence of a run shows, for the people who read the result: how often each variant was served and what no mock matched. Derived from verified bytes only. */
export type E2EApplicationMockSummary = Readonly<{ consumptions: Readonly<{ success: number; refusal: number; invalidData: number }>;
  unmockedCalls: Readonly<{ sinkhole: number; mocked: number }>; mockedOrigins: readonly string[] }>;
/**
 * What the collector saw of one case beyond its verdict (Task 4.6b): the SHA-256 of the CSV bytes the case's download assertion read (null when it has none or read none), and, for
 * a replay, how each AI navigation step ended. The broker compares a replay's facts with those of the round it replays. Facts only: they are never a verdict.
 */
export type E2EApplicationCaseFacts = Readonly<{ caseId: string; csvSha256: string | null;
  agentSteps: ReadonlyArray<Readonly<{ stepIndex: number; whole: boolean; replayedActions: number; totalActions: number; stopCode: string | null }>> }>;
export type E2EApplicationQualification = E2EStructuralQualification & Readonly<{ mockSummary?: E2EApplicationMockSummary; caseFacts?: ReadonlyArray<E2EApplicationCaseFacts> }>;
export type E2EApplicationCollectionResult = Readonly<{ collection: E2EApplicationCollection | null; oracle: E2EApplicationCollectionOracle | null;
  qualification: E2EApplicationQualification | null; unavailableReason: string | null }>;
type E2EApplicationReportStep = E2EApplicationReport["run"]["results"][number]["attempts"][number]["steps"][number];
const summedRunUsageKeys = new Set(["discoveredResults", "artifactBytes", "downloads", "events", "modelTokens"]);
const maximumRunUsageKeys = new Set(["maxAgentContextBytes", "maxLedgerBytes", "maxObservationBytes", "maxModelCallsInStep", "maxActionStepsInStep"]);
const optionalSummedRunUsageKeys = new Set(["modelCachedTokens", "estimatedCostUsd"]);

/** Reconciles report-1 per-shard usage using the pinned runner's sum/max rules. */
export function e2eApplicationAggregateRunUsage(shardUsage: readonly Readonly<Record<string, number>>[]): Readonly<Record<string, number>> | null {
  if (shardUsage.length === 0) return null;
  const result: Record<string, number> = {};
  for (const key of summedRunUsageKeys) result[key] = 0;
  for (const key of maximumRunUsageKeys) result[key] = 0;
  const allowed = new Set([...summedRunUsageKeys, ...maximumRunUsageKeys, ...optionalSummedRunUsageKeys]);
  for (const usage of shardUsage) {
    if (Object.keys(usage).some((key) => !allowed.has(key))) return null;
    for (const key of summedRunUsageKeys) {
      const value = usage[key];
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
      result[key] = (result[key] ?? 0) + value;
      if (!Number.isSafeInteger(result[key])) return null;
    }
    for (const key of maximumRunUsageKeys) {
      const value = usage[key];
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
      result[key] = Math.max(result[key] ?? 0, value);
      if (!Number.isSafeInteger(result[key])) return null;
    }
    for (const key of optionalSummedRunUsageKeys) {
      const value = usage[key];
      if (value === undefined) continue;
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
      result[key] = (result[key] ?? 0) + value;
      if (!Number.isFinite(result[key]) || (key !== "estimatedCostUsd" && !Number.isSafeInteger(result[key]))) return null;
    }
  }
  if (Object.values(result).some((value) => !Number.isFinite(value))) return null;
  return result;
}

export function e2eApplicationModelUseWithinRound(input: { steps: readonly E2EApplicationReportStep[];
  usage: Pick<E2EApplicationReport["run"]["usage"], "modelTokens" | "maxModelCallsInStep">; modelRoutePresent: boolean;
  maxModelRequests: number; maxInputTokens: number; maxOutputTokens: number; actualReceiptCount: number }): boolean {
  const calls = input.steps.reduce((total, step) => total + (step.metrics?.modelCalls ?? 0), 0);
  const inputTokens = input.steps.reduce((total, step) => total + (step.model?.inputTokens ?? 0), 0);
  const outputTokens = input.steps.reduce((total, step) => total + (step.model?.outputTokens ?? 0), 0);
  const maxCallsInStep = input.steps.reduce((max, step) => Math.max(max, step.metrics?.modelCalls ?? 0), 0);
  return input.usage.modelTokens === inputTokens + outputTokens && input.usage.maxModelCallsInStep === maxCallsInStep
    && calls === input.actualReceiptCount && calls <= input.maxModelRequests && inputTokens <= input.maxInputTokens && outputTokens <= input.maxOutputTokens
    && (input.modelRoutePresent || (calls === 0 && inputTokens === 0 && outputTokens === 0 && input.usage.modelTokens === 0 && maxCallsInStep === 0));
}
type E2EApplicationAgentActionFact = Pick<E2EApplicationAgentOperationObservation, "operationKind" | "outcome" | "startedAt" | "finishedAt">;
export function e2eApplicationAgentActionEventGroupsMatch(groups: readonly (readonly E2EApplicationAgentActionFact[])[],
  events: readonly E2EApplicationReportStep["events"][number][]): boolean {
  const candidates = groups.map((actionRows) => {
    const kinds = [...new Set(actionRows.map((item) => item.operationKind))];
    if (actionRows.length === 0 || kinds.length !== 1 || actionRows.some((item) => item.outcome !== "completed")) return [];
    const started = Math.min(...actionRows.map((item) => Date.parse(item.startedAt)));
    const finished = Math.max(...actionRows.map((item) => Date.parse(item.finishedAt)));
    return events.flatMap((event, eventIndex) => event.kind === "engine" && event.name === kinds[0] && event.status === "passed"
      && Date.parse(event.startedAt) <= started && Date.parse(event.startedAt) + event.durationMs >= finished ? [eventIndex] : []);
  });
  const eventAssignments = new Map<number, number>();
  const assignEvent = (groupIndex: number, visited: Set<number>): boolean => {
    for (const eventIndex of candidates[groupIndex] ?? []) {
      if (visited.has(eventIndex)) continue;
      visited.add(eventIndex);
      const previousGroup = eventAssignments.get(eventIndex);
      if (previousGroup === undefined || assignEvent(previousGroup, visited)) {
        eventAssignments.set(eventIndex, groupIndex);
        return true;
      }
    }
    return false;
  };
  return candidates.every((items) => items.length > 0) && candidates.every((_, groupIndex) => assignEvent(groupIndex, new Set<number>()));
}
export function collectE2EApplicationRun(input: { actual: unknown; compiled: E2ECompiledApplicationSuite; binding: E2ERunBinding; round: E2ERound;
  environment: Environment; usage: Readonly<Record<string, number>>; limits: Readonly<Record<string, number>>;
  expectedSupervisorReceiptRefs: readonly E2EApplicationEvidenceRef[]; ownedResourceInventoryDigest: string;
  observationBindings: readonly E2EApplicationObservationBinding[] | null; assertionAssets: readonly E2EApplicationAssertionAssetBinding[];
  governedModelReceipts: readonly E2EApplicationGovernedModelReceiptRow[] | null; agentModel?: E2EAgentModelEvidence | null; roundScope?: E2ERoundScope; ownedClosedAt: string | null }): E2EApplicationCollectionResult {
  try {
    const collection = E2EApplicationCollectionSchema.parse(input.actual);
    const oracle = createE2EApplicationCollectionOracleFromCompiledSuite(input);
    const qualification = qualifyE2EApplicationCollection(oracle, collection);
    return { collection, oracle, qualification, unavailableReason: qualification.status === "UNKNOWN" ? qualification.reason : null };
  } catch (error) {
    // A schema refusal says what it refused (the first issue's own words) rather than printing the whole issue list.
    const message = error instanceof z.ZodError ? error.issues[0]?.message : error instanceof Error ? error.message : undefined;
    return { collection: null, oracle: null, qualification: null, unavailableReason: message === undefined || message === "" ? "application collection unavailable" : message };
  }
}

export function qualifyE2EApplicationCollection(oracleInput: E2EApplicationCollectionOracle, collectionInput: E2EApplicationCollection): E2EApplicationQualification {
  const unknown = (reason: string, runId: string | null = null, reportHash: string | null = null): E2EApplicationQualification => ({ status: "UNKNOWN", reason, runId, rawReportSha256: reportHash, result: null });
  try {
    const oracle = E2EApplicationCollectionOracleSchema.parse(copyBoundedE2EJsonData(oracleInput, { maxBytes: 8 * 1024 * 1024, maxDepth: 64 }));
    const collection = E2EApplicationCollectionSchema.parse(copyBoundedE2EJsonData(collectionInput, { maxBytes: e2eApplicationPrivateTransferMaxBytes(oracle.expectedCases.length, oracle.expectedShardIds.length), maxDepth: 64 }));
    const admittedBinding = oracle.round.groupBindings.find((item) => item.groupId === oracle.groupId);
    const exactShardIds = [...oracle.expectedShardIds].sort();
    if (!admittedBinding || canonicalJson(admittedBinding) !== canonicalJson(oracle.binding) || oracle.binding.groupId !== oracle.groupId
      || oracle.binding.roundId !== oracle.round.roundId || oracle.binding.deadlineAt !== oracle.round.deadlineAt
      || canonicalJson(oracle.binding.expectedCases) !== canonicalJson(oracle.expectedCases)
      || new Set(exactShardIds).size !== exactShardIds.length
      || canonicalJson(oracle.compiledShardConfigDigests.map((item) => item.shardId).sort()) !== canonicalJson(exactShardIds)) {
      return unknown("application oracle differs from the exact admitted round binding or compiled shard inventory", oracle.binding.runId);
    }
    if (collection.cleanup !== "confirmed") return unknown("application owned cleanup is not confirmed", oracle.binding.runId);
    if (canonicalJson(collection.shards.map((item) => item.shardId).sort()) !== canonicalJson([...oracle.expectedShardIds].sort())) return unknown("application collection omits or adds a compiled shard", oracle.binding.runId);
    if (oracle.observationBindings === null || oracle.ownedClosedAt === null) return unknown("protected owned observation or close facts are unavailable", oracle.binding.runId);
    const closedAt = Date.parse(oracle.ownedClosedAt); const receivedAt = Date.parse(collection.receivedAt);
    if (!Number.isFinite(closedAt) || !Number.isFinite(receivedAt) || receivedAt < closedAt || receivedAt > closedAt + 30_000) {
      return unknown("application collection was not received inside the original bounded post-close harvest window", oracle.binding.runId);
    }
    const readback = decodeE2EApplicationSupervisorReadback(collection.supervisorReadback);
    const proof = readE2EApplicationSupervisorProof({ readback, expected: { bindingDigest: createHash("sha256").update(canonicalJson(oracle.binding)).digest("hex"),
      compiledInventoryDigest: oracle.compiledInventoryDigest, preparedEnvironmentDigest: oracle.preparedEnvironmentDigest,
      candidateDigest: oracle.binding.candidateDigest, roundId: oracle.binding.roundId, runId: oracle.binding.runId, groupId: oracle.groupId,
      mockManifestDigest: oracle.binding.mockManifestDigest, caseCount: oracle.expectedCases.length,
      expectedSupervisorReceiptRefs: oracle.expectedSupervisorReceiptRefs, ownedResourceInventoryDigest: oracle.ownedResourceInventoryDigest,
      expectedIdentityRefs: oracle.observationBindings.flatMap((item) => [item.identityReceiptRef, item.subjectIdentityReceiptRef]),
      launches: collection.shards.map((shard) => ({ shardId: shard.shardId, launchId: shard.launchId, upstreamRunId: shard.runStart.runId })) },
      applicationCaptures: collection.applicationCaptures, supervisorReceiptRefs: collection.supervisorReceiptRefs,
      cleanupConfirmed: true, cleanupServerListening: false });
    if (canonicalJson(proof.mockConsumptions) !== canonicalJson(collection.mockConsumptions)) {
      return unknown("normalized mock consumption rows differ from the retained original witness frames", oracle.binding.runId);
    }
    if (canonicalJson(proof.unmockedCalls) !== canonicalJson(collection.unmockedCalls ?? [])) {
      return unknown("normalized unmocked call rows differ from the retained original witness frames", oracle.binding.runId);
    }
    const supervisorObservedAt = Date.parse(proof.receipt.context.observedAt);
    if (!Number.isFinite(supervisorObservedAt) || supervisorObservedAt < closedAt || supervisorObservedAt > receivedAt) {
      return unknown("raw supervisor proof was not observed after owned close within the original harvest window", oracle.binding.runId);
    }
    const proofById = new Map(readback.evidence.map((entry) => [entry.ref.artifactId, entry]));
    const protectedObservationRefs = oracle.observationBindings.flatMap((item) => [item.identityReceiptRef, item.subjectIdentityReceiptRef]);
    const protectedExpectedRefs = [...protectedObservationRefs, ...oracle.assertionAssets.map((item) => item.ref), ...(oracle.governedModelReceipts ?? []).map((item) => item.receiptRef)];
    if (protectedExpectedRefs.some((ref) => {
      const retained = proofById.get(ref.artifactId);
      return !retained || evidenceKey(retained.ref) !== evidenceKey(ref);
    })) return unknown("protected identity, assertion asset, or governed model expectation lacks its exact retained raw bytes", oracle.binding.runId);
    const expectedModelRows = oracle.governedModelReceipts;
    const caseById = new Map(oracle.expectedCases.map((item) => [item.caseId, item]));
    if (expectedModelRows !== null && (expectedModelRows.length > Math.min(200, oracle.round.limits.maxModelRequests)
      || new Set(expectedModelRows.map((item) => item.requestId)).size !== expectedModelRows.length
      || new Set(expectedModelRows.map((item) => item.receiptId)).size !== expectedModelRows.length
      || expectedModelRows.some((item) => !caseById.has(item.caseId)))) return unknown("protected model receipt projection inventory is duplicated or exceeds its original budget", oracle.binding.runId);
    // Task 4.6b: an audit replay has no model. Anything of a model's in its evidence (receipts, tokens, a call in the report) is a replay that was not one.
    const replay = oracle.replay;
    if (replay !== undefined && expectedModelRows?.length) return unknown("replay-model-called: model receipts came with an audit replay", oracle.binding.runId);
    if (oracle.modelRoute === null && expectedModelRows?.length) return unknown("model receipts were supplied for a null governed model route", oracle.binding.runId);
    // Task 4.4a: the AI navigation steps are judged from the worker's receipts and the executor's ledgers (`evaluateE2EAgentCase`), not from per-action frames or projection rows.
    if (expectedModelRows?.length) return unknown("model-receipts-mismatch: governed model receipt projections are not how AI navigation steps are read", oracle.binding.runId);
    const agentCaseIds = new Set(oracle.applicationIdsByCase.filter((fact) => fact.scenario.steps.some((step) => step.kind === "agent")).map((fact) => fact.caseId));
    const agentModel = oracle.agentModel ?? null;
    if (replay !== undefined) {
      // A replay's AI navigation steps need no route and no evidence of a model; model evidence of any kind means a model was in the run.
      if (agentModel !== null) return unknown("replay-model-called: model evidence came with an audit replay", oracle.binding.runId);
    } else if (agentCaseIds.size > 0) {
      if (oracle.modelRoute === null) return unknown("agent-route-not-approved: the group has AI navigation steps and the admission pins no model route", oracle.binding.runId);
      if (agentModel === null) return unknown("model-receipts-mismatch: no model receipts or action ledgers came with the group's AI navigation steps", oracle.binding.runId);
    } else if (agentModel !== null) return unknown("model-receipts-mismatch: model evidence came with a group that has no AI navigation step", oracle.binding.runId);
    const agentReceipts = agentModel?.receipts ?? [];
    if (agentReceipts.some((receipt) => !agentCaseIds.has(receipt.caseId) || receipt.runId !== oracle.binding.runId)) {
      return unknown("model-receipts-mismatch: a model receipt is attributed to a case with no AI navigation step, or to another run", oracle.binding.runId);
    }
    const captures = new Map(collection.applicationCaptures.map((item) => [item.caseId, item]));
    if (captures.size !== caseById.size || [...captures.keys()].some((caseId) => !caseById.has(caseId))) return unknown("application capture inventory differs from the complete admitted case set", oracle.binding.runId);
    const protectedBindings = new Map(oracle.observationBindings.map((item) => [item.caseId, item]));
    if (protectedBindings.size !== oracle.expectedCases.length || [...caseById.keys()].some((caseId) => !protectedBindings.has(caseId))) {
      return unknown("protected observation bindings do not cover the exact admitted application cases", oracle.binding.runId);
    }
    const declaredMocks = [...new Set(oracle.expectedMockComponentIdsByTarget.flatMap((item) => item.componentIds))].sort();
    if (canonicalJson([...collection.declaredMockComponentIds].sort()) !== canonicalJson(declaredMocks)
      || new Set(collection.declaredMockComponentIds).size !== collection.declaredMockComponentIds.length) return unknown("declared application mock inventory differs from the compiled group", oracle.binding.runId);
    const reportByCase = new Map<string, { status: string; runId: string; shardId: string; failureObserved: boolean; failureAssertionIndex: number | null;
      attemptId: string; attempt: E2EApplicationReport["run"]["results"][number]["attempts"][number];
      processStartedAt: string; processFinishedAt: string }>();
    let groupModelCalls = 0; let groupInputTokens = 0; let groupOutputTokens = 0;
    const shardUsageRows: Readonly<Record<string, number>>[] = [];
    for (const shard of collection.shards) {
      const expectedPacket = oracle.selectionPackets.find((item) => item.shardId === shard.shardId);
      const expectedConfig = oracle.compiledShardConfigDigests.find((item) => item.shardId === shard.shardId);
      if (!expectedPacket || !expectedConfig || shard.launchConfigDigest !== expectedConfig.configDigest) return unknown("application shard has no exact immutable config and selection packet", oracle.binding.runId);
      const reportBytes = Buffer.from(shard.rawReport.bytesBase64, "base64");
      const parsed = parseE2EApplicationReport(reportBytes);
      if (parsed.kind !== "parsed") return unknown(parsed.reason, oracle.binding.runId);
      const list = compareE2EApplicationPublicList(expectedPacket, JSON.parse(JSON.stringify(shard.publicList)));
      const startBytes = Buffer.from(shard.runStartCapture.bytesBase64, "base64");
      let publicListFromBytes: unknown;
      try { publicListFromBytes = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(shard.publicListBytes.bytesBase64, "base64"))); } catch { publicListFromBytes = null; }
      let capturedStart: unknown;
      try { capturedStart = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(startBytes).trim()); } catch { capturedStart = null; }
      const processStartedAt = Date.parse(shard.runProcess.startedAt); const listFinishedAt = Date.parse(shard.listProcess.finishedAt);
      const startEventAt = Date.parse(shard.runStart.at); const reportStartedAt = Date.parse(parsed.report.run.startedAt);
      const reportFinishedAtText = parsed.report.run.finishedAt;
      if (typeof reportFinishedAtText !== "string") return unknown("application report has no bounded finish time", oracle.binding.runId, parsed.rawSha256);
      const reportFinishedAt = Date.parse(reportFinishedAtText); const processFinishedAt = Date.parse(shard.runProcess.finishedAt);
      const listStartedAt = Date.parse(shard.listProcess.startedAt); const admittedAt = Date.parse(oracle.round.admittedAt);
      const deadlineAt = Date.parse(oracle.round.deadlineAt);
      if (![processStartedAt, listStartedAt, listFinishedAt, startEventAt, reportStartedAt, reportFinishedAt, processFinishedAt,
        admittedAt, deadlineAt].every(Number.isFinite) || listStartedAt < admittedAt || processStartedAt < admittedAt
        || processFinishedAt > deadlineAt || processFinishedAt > closedAt || listFinishedAt > closedAt
        || reportStartedAt < admittedAt || reportFinishedAt > deadlineAt) {
        return unknown("application report or process timestamps are invalid or outside the original admitted round", oracle.binding.runId, parsed.rawSha256);
      }
      if (!startBytes.equals(Buffer.from(`${JSON.stringify(shard.runStart)}\n`))
        || canonicalJson(normalizeE2EApplicationPublicList(publicListFromBytes, expectedPacket.targetId)) !== canonicalJson(shard.publicList)
        || canonicalJson(capturedStart) !== canonicalJson(shard.runStart) || shard.runStart.challenge !== shard.launchId
        || shard.runStart.runId !== parsed.report.run.id || shard.runProcess.status !== parsed.report.run.exitCode
        || Date.parse(shard.runProcess.startedAt) > processFinishedAt || Date.parse(shard.listProcess.startedAt) > listFinishedAt
        || shard.runProcess.timedOut || shard.runProcess.aborted || shard.listProcess.status !== 0 || shard.listProcess.timedOut || shard.listProcess.aborted
        || Date.parse(shard.runProcess.finishedAt) > Date.parse(oracle.round.deadlineAt)
        || listFinishedAt > processStartedAt || processStartedAt > startEventAt || startEventAt > reportStartedAt
        || reportStartedAt > reportFinishedAt || reportFinishedAt > processFinishedAt
        || parsed.report.run.project.configDigest !== expectedConfig.configDigest || parsed.report.run.runner.name !== "e2e"
        || parsed.report.run.runner.version !== "0.20.0" || parsed.report.run.project.id !== "rovara-application-e2e"
        || canonicalJson(parsed.report.run.environment) !== canonicalJson(oracle.environment)
        || canonicalJson(parsed.report.run.limits) !== canonicalJson(oracle.limits)
        || parsed.report.run.errors.length !== 0) return unknown("application report does not bind to actual process, config, challenge, runtime, environment, budget, and run-start evidence", oracle.binding.runId, parsed.rawSha256);
      shardUsageRows.push(Object.fromEntries(Object.entries(parsed.report.run.usage)
        .filter((entry): entry is [string, number] => entry[1] !== undefined)));
      const expectedTarget = oracle.applicationIdsByCase.find((item) => item.targetId === expectedPacket.targetId);
      const reportTarget = parsed.report.run.targets.find((item) => item.id === expectedPacket.targetId);
      if (!expectedTarget || !reportTarget || !e2eApplicationReportTargetMatches(reportTarget, expectedTarget)) {
        return unknown("application report target engine, platform, or capabilities differ from the immutable runtime oracle", oracle.binding.runId, parsed.rawSha256);
      }
      const targetOrigin = oracle.originByApplicationId.find((item) => item.applicationId === expectedTarget.applicationId)?.origin;
      // An API target has no app of its own, with or without Rovara's HTTP engine, so its report names no base origin.
      const reportOriginMatches = expectedTarget.engine === null || expectedTarget.platform === "api"
        ? reportTarget.baseOrigin === undefined
        : targetOrigin === null || targetOrigin === undefined ? reportTarget.baseOrigin === undefined : reportTarget.baseOrigin === targetOrigin;
      if (expectedTarget.origin !== targetOrigin || !reportOriginMatches) {
        return unknown("application report origin differs from its immutable prepared application origin", oracle.binding.runId, parsed.rawSha256);
      }
      const expectedAssets = oracle.fixedAssetDigestsByShard.find((item) => item.shardId === shard.shardId)?.digests;
      const exactAssets = { ...(expectedAssets ?? {}), reporter: expectedE2EApplicationReporterDigest(shard.launchId) };
      if (canonicalJson(exactAssets) !== canonicalJson(shard.fixedAssetDigests)) return unknown("application fixed runtime assets differ from the immutable oracle", oracle.binding.runId, parsed.rawSha256);
      const rows = parsed.report.run.results;
      const selectedIds = list.selected.map((item) => item.upstreamResultId);
      if (rows.length !== expectedPacket.tuples.length || rows.some((row) => {
        const item = expectedPacket.tuples.find((tuple) => tuple.upstreamResultId === row.id);
        return !item || item.upstreamTestId !== row.testId || item.targetId !== row.targetId || item.platform !== row.platform
          || row.kind !== "test" || row.declarationIndex !== expectedPacket.tuples.indexOf(item) || canonicalJson(row.titlePath) !== canonicalJson([item.title])
          || row.file !== item.source.file || canonicalJson(row.source) !== canonicalJson(item.source) || row.agent !== item.agent
          || row.repeat !== 0 || canonicalJson(row.tags) !== canonicalJson(item.tags) || row.selected !== (item.disposition === "run");
      })) return unknown("application report rows differ from the exact shard tuple, source, selection, or attempt identity", oracle.binding.runId, parsed.rawSha256);
      for (const tuple of expectedPacket.tuples.filter((item) => item.disposition === "run")) {
        const row = rows.find((item) => item.id === tuple.upstreamResultId);
        const attempt = row?.attempts[0];
        // A replay's AI navigation steps may show any cache outcome (they are judged from it below); every other step is as clean as it ever was.
        const cacheClean = attempt?.steps.every((step) => step.cache === undefined || (step.cache.mode === "missed" && step.cache.replayedActions === 0) || (replay !== undefined && step.kind === "agent")) ?? false;
        const reportFailure = attempt?.error;
        if (!row || !attempt || row.attempts.length !== 1 || row.repeat !== 0 || !["passed", "failed"].includes(row.status)
          || row.skip !== undefined || attempt.status !== row.status || attempt.cleanup !== "complete"
          || attempt.secondaryErrors.length !== 0 || !cacheClean
          || (row.status === "passed" && (reportFailure !== undefined || attempt.failure !== undefined))
          || (row.status === "failed" && (!reportFailure || reportFailure.category !== "test" || reportFailure.phase !== "body"))) {
          return unknown("application report is flaky, incomplete, cached, skipped, dirty, or not a clean first attempt", oracle.binding.runId, parsed.rawSha256);
        }
        if (reportByCase.has(tuple.caseId)) return unknown("application case is duplicated across same-platform shard reports", oracle.binding.runId, parsed.rawSha256);
        const failedSteps = attempt.steps.filter((step) => step.status === "failed");
        reportByCase.set(tuple.caseId, { status: row.status, runId: parsed.report.run.id, shardId: shard.shardId,
          failureObserved: row.status === "failed" && failedSteps.length === 1 && failedSteps[0]?.kind === "assertion",
          failureAssertionIndex: failedSteps.length === 1 && failedSteps[0]?.kind === "assertion" ? failedSteps[0].index : null,
          attemptId: attempt.id, attempt,
          processStartedAt: shard.runProcess.startedAt, processFinishedAt: shard.runProcess.finishedAt });
      }
      if (selectedIds.length !== expectedPacket.tuples.filter((item) => item.disposition === "run").length) return unknown("application selection packet is incomplete", oracle.binding.runId, parsed.rawSha256);
      const failedCount = rows.filter((row) => row.status === "failed").length;
      const passedCount = rows.filter((row) => row.status === "passed").length;
      if (parsed.report.run.summary.discovered !== expectedPacket.tuples.length || parsed.report.run.summary.selected !== selectedIds.length
        || parsed.report.run.summary.executed !== rows.length || parsed.report.run.summary.passed !== passedCount
        || parsed.report.run.summary.failed !== failedCount || parsed.report.run.summary.interrupted !== 0 || parsed.report.run.summary.flaky !== 0
        || parsed.report.run.summary.skipped !== 0 || parsed.report.run.status !== (failedCount > 0 ? "failed" : "passed")
        || parsed.report.run.exitCode !== (failedCount > 0 ? 1 : 0)) return unknown("application report summary and run status contradict its exact selected result inventory", oracle.binding.runId, parsed.rawSha256);
      const attemptSteps = rows.flatMap((row) => row.attempts[0]?.steps ?? []);
      const shardModelCalls = attemptSteps.reduce((total, step) => total + (step.metrics?.modelCalls ?? 0), 0);
      const shardInputTokens = attemptSteps.reduce((total, step) => total + (step.model?.inputTokens ?? 0), 0);
      const shardOutputTokens = attemptSteps.reduce((total, step) => total + (step.model?.outputTokens ?? 0), 0);
      const shardCaseIds = new Set(expectedPacket.tuples.map((item) => item.caseId));
      // Each call the report counts has exactly one `ok` receipt (`checkE2EStepModelAccounting` holds each step to it); the other receipts are calls the report does not count.
      const shardReceiptCount = agentReceipts.filter((receipt) => receipt.outcome === "ok" && shardCaseIds.has(receipt.caseId)).length;
      const modelTokens = parsed.report.run.usage.modelTokens;
      const maxModelCallsInStep = parsed.report.run.usage.maxModelCallsInStep;
      if (replay !== undefined && (shardModelCalls > 0 || shardInputTokens > 0 || shardOutputTokens > 0 || (modelTokens ?? 0) > 0 || (maxModelCallsInStep ?? 0) > 0
        || attemptSteps.some((step) => step.model !== undefined))) {
        return unknown("replay-model-called: the replay's report shows a model call or model tokens", oracle.binding.runId, parsed.rawSha256);
      }
      if (typeof modelTokens !== "number" || typeof maxModelCallsInStep !== "number"
        || !e2eApplicationModelUseWithinRound({ steps: attemptSteps, usage: { modelTokens, maxModelCallsInStep }, modelRoutePresent: oracle.modelRoute !== null,
        maxModelRequests: oracle.round.limits.maxModelRequests, maxInputTokens: oracle.round.limits.maxInputTokens,
        maxOutputTokens: oracle.round.limits.maxOutputTokens, actualReceiptCount: shardReceiptCount })) {
        return unknown(`${agentModel === null ? "" : "model-receipts-mismatch: "}application report model counters differ from actual SDK step metrics or a null governed route`, oracle.binding.runId, parsed.rawSha256);
      }
      groupModelCalls += shardModelCalls; groupInputTokens += shardInputTokens; groupOutputTokens += shardOutputTokens;
    }
    const aggregateUsage = e2eApplicationAggregateRunUsage(shardUsageRows);
    if (!aggregateUsage || canonicalJson(aggregateUsage) !== canonicalJson(oracle.usage)) {
      return unknown("application report shard usage does not reconcile to the protected group aggregate", oracle.binding.runId);
    }
    const actualModelReceiptCount = agentReceipts.filter((receipt) => receipt.outcome === "ok").length;
    if (groupModelCalls !== actualModelReceiptCount || groupModelCalls > oracle.round.limits.maxModelRequests
      || groupInputTokens > oracle.round.limits.maxInputTokens || groupOutputTokens > oracle.round.limits.maxOutputTokens) {
      return unknown(`${agentModel === null ? "" : "model-receipts-mismatch: "}group model SDK calls or token use differ from retained governed receipts or exceed original round limits`, oracle.binding.runId);
    }
    const verifiedModelReceiptIds: string[] = [];
    const summaryConsumptions = { success: 0, refusal: 0, invalidData: 0 };
    const summaryUnmocked = new Map<string, string>();
    const summaryOrigins = new Set<string>();
    const caseFactRows: E2EApplicationCaseFacts[] = [];
    const normalizedCases = oracle.expectedCases.map((expected) => {
      const capture = captures.get(expected.caseId)!;
      const facts = oracle.applicationIdsByCase.find((item) => item.caseId === expected.caseId)!;
      const protectedBinding = protectedBindings.get(expected.caseId)!;
      const assertionProducerRows = new Map(protectedBinding.assertionProducers.map((item) => [item.assertionIndex, item.producer]));
      const caseIsBound = capture.runId === oracle.binding.runId && capture.roundId === oracle.binding.roundId && capture.groupId === oracle.binding.groupId
        && capture.candidateDigest === oracle.binding.candidateDigest && capture.executionDescriptorDigest === expected.executionDescriptorDigest
        && capture.accountContextId === expected.accountContextId && capture.accountContextDigest === expected.accountContextDigest
        && capture.applicationId === facts.applicationId && capture.buildManifestDigest === facts.buildManifestDigest && capture.runtimeManifestDigest === facts.runtimeManifestDigest
        && protectedBinding.caseProducer.operationId === oracle.binding.operationId && protectedBinding.caseProducer.operationFence === oracle.binding.operationFence
        && protectedBinding.caseProducer.runtimeManifestDigest === facts.runtimeManifestDigest
        && canonicalJson(capture.producer) === canonicalJson(protectedBinding.caseProducer)
        && protectedBinding.accountRef.applicationId === facts.applicationId && canonicalJson(protectedBinding.accountRef) === canonicalJson(facts.accountRef)
        && canonicalJson(capture.subject) === canonicalJson(protectedBinding.subject)
        && protectedBinding.selectedArtifact.buildManifestDigest === facts.buildManifestDigest
        && protectedBinding.selectedArtifact.platform === facts.platform
        && capture.lifecycleId === capture.producer.lifecycleId;
      const report = reportByCase.get(expected.caseId);
      const withinProcess = (value: string) => report !== undefined && Date.parse(value) >= Date.parse(report.processStartedAt)
        && Date.parse(value) <= Date.parse(report.processFinishedAt);
      const identityProof = proofById.get(protectedBinding.identityReceiptRef.artifactId);
      const subjectIdentityProof = proofById.get(protectedBinding.subjectIdentityReceiptRef.artifactId);
      if (!identityProof || !subjectIdentityProof
        || evidenceKey(identityProof.ref) !== evidenceKey(protectedBinding.identityReceiptRef)
        || evidenceKey(subjectIdentityProof.ref) !== evidenceKey(protectedBinding.subjectIdentityReceiptRef)) {
        throw new Error("protected account or subject identity projection is missing from retained raw proof");
      }
      const bindingDigest = createHash("sha256").update(canonicalJson(oracle.binding)).digest("hex");
      const accountProjection = parseCanonicalFrame(identityProof, E2EApplicationAccountIdentityProjectionSchema, "account identity projection");
      const subjectProjection = parseCanonicalFrame(subjectIdentityProof, E2EApplicationSubjectIdentityProjectionSchema, "subject identity projection");
      const projectionContextMatches = (projection: E2EApplicationAccountIdentityProjection | E2EApplicationSubjectIdentityProjection) =>
        projection.caseId === expected.caseId && projection.bindingDigest === bindingDigest && projection.upstreamRunId === report?.runId
        && projection.lifecycleId === capture.lifecycleId && canonicalJson(projection.producer) === canonicalJson(protectedBinding.caseProducer)
        && Number.isFinite(Date.parse(projection.observedAt)) && Date.parse(projection.observedAt) >= Date.parse(oracle.round.admittedAt)
        && Date.parse(projection.observedAt) <= closedAt && withinProcess(projection.observedAt);
      if (!projectionContextMatches(accountProjection) || accountProjection.schemaVersion !== "e2e-application-account-identity/v1"
        || canonicalJson(accountProjection.accountRef) !== canonicalJson(protectedBinding.accountRef)
        || accountProjection.sessionRef !== protectedBinding.sessionRef || accountProjection.accountIdDigest !== protectedBinding.accountIdDigest
        || !projectionContextMatches(subjectProjection) || subjectProjection.schemaVersion !== "e2e-application-subject-identity/v1"
        || canonicalJson(subjectProjection.subject) !== canonicalJson(protectedBinding.subject)
        || Date.parse(accountProjection.observedAt) > Date.parse(capture.observedAt)
        || Date.parse(subjectProjection.observedAt) > Date.parse(capture.observedAt)) {
        throw new Error("raw account or subject identity projection differs from the exact protected case, lifecycle, producer, session, or owned subject");
      }
      // The signed-out visitor has no account binding (Ruling AZ): its case runs under the reference the application fixes, with the sentinel session and the fixed identity digest, and
      // its recorded source shows no login and no identity. A case of any other profile never has the sentinel session.
      if (expected.accountProfileId === E2E_ANONYMOUS_ACCOUNT_PROFILE_ID) {
        const fixedRef = e2eAnonymousRuntimeAccountRef(facts.applicationId);
        const source = proofById.get(accountProjection.sourceReceiptRef.artifactId);
        if (!source || evidenceKey(source.ref) !== evidenceKey(accountProjection.sourceReceiptRef)) throw new Error("anonymous case account source is missing from retained raw proof");
        const recorded = parseCanonicalFrame(source, anonymousAccountSourceSchema, "anonymous account source");
        if (canonicalJson(facts.accountRef) !== canonicalJson(fixedRef) || canonicalJson(protectedBinding.accountRef) !== canonicalJson(fixedRef)
          || !isE2EAnonymousSessionRef(protectedBinding.sessionRef) || protectedBinding.accountIdDigest !== e2eAnonymousAccountIdDigest(facts.applicationId)
          || recorded.caseId !== expected.caseId || canonicalJson(recorded.accountRef) !== canonicalJson(fixedRef) || recorded.sessionRef !== protectedBinding.sessionRef
          || recorded.accountIdDigest !== protectedBinding.accountIdDigest) {
          throw new Error("an anonymous case claims an account binding: it must have the fixed anonymous reference, the sentinel session and identity digest, and no login or identity");
        }
      } else if (isE2EAnonymousSessionRef(protectedBinding.sessionRef)) {
        throw new Error("a case of an account profile claims the anonymous session");
      }
      if (!caseIsBound || !report || capture.shardId !== report.shardId || capture.upstreamRunId !== report.runId
        || capture.cleanup !== "confirmed" || capture.assertions.length !== expected.assertionDigests.length
        || protectedBinding.assertionProducers.length !== capture.assertions.length || assertionProducerRows.size !== capture.assertions.length
        || !withinProcess(capture.observedAt) || Date.parse(capture.observedAt) < Date.parse(oracle.round.admittedAt) || Date.parse(capture.observedAt) > closedAt
        || capture.steps.some((item) => !withinProcess(item.at) || Date.parse(item.at) < Date.parse(oracle.round.admittedAt) || Date.parse(item.at) > closedAt)
        || capture.assertions.some((item, index) => item.index !== index || item.digest !== expected.assertionDigests[index] || !withinProcess(item.observedAt)
          || Date.parse(item.observedAt) < Date.parse(oracle.round.admittedAt) || Date.parse(item.observedAt) > closedAt)) {
        throw new Error("application capture changed its case, producer, build, runtime, account, time, or assertion identity");
      }
      const stepsObserved = scenarioActionsMatch(facts.scenario, capture);
      if (!stepsObserved) throw new Error("application result does not contain the exact authorized ordered action prefix");
      // Task 4.4a: an agent step leaves no per-action frames (the M1-era design); its actions are the executor's ledger, held to the worker's receipts below.
      const operationFrames = readAgentOperationFrames(capture, (ref) => {
        const proofRow = proofById.get(ref.artifactId);
        if (!proofRow || evidenceKey(proofRow.ref) !== evidenceKey(ref)) throw new Error("agent operation frame or source receipt is absent from retained proof bytes");
        return proofRow;
      });
      const declaredAgentSteps = facts.scenario.steps.flatMap((step, index) => step.kind === "agent" && index < capture.steps.length ? [index] : []);
      const reportAgentSteps = report.attempt.steps.filter((step) => step.kind === "agent");
      let agentOperationsValid = operationFrames.length === 0 && capture.modelReceipts.length === 0 && declaredAgentSteps.length === reportAgentSteps.length;
      for (const declaredStepIndex of declaredAgentSteps) {
        const sdkStep = reportAgentSteps[declaredAgentSteps.indexOf(declaredStepIndex)];
        const declaredCaptureStep = capture.steps.find((item) => item.declaredStepIndex === declaredStepIndex);
        if (!declaredCaptureStep || declaredCaptureStep.agentOperationRefs.length !== 0 || !sdkStep || sdkStep.kind !== "agent" || (replay === undefined && !sdkStep.metrics)
          || (replay === undefined && sdkStep.cache !== undefined && (sdkStep.cache.mode !== "missed" || sdkStep.cache.replayedActions !== 0))) agentOperationsValid = false;
      }
      if (!agentOperationsValid) throw new Error("model-receipts-mismatch: an AI navigation step differs from the e2e report's account of it or carries M1-era operation frames");
      // The agent part of the case: the verdict the receipts and the ledger allow. Null for a case with no agent step.
      let agentResult: E2EAgentCaseResult | null = null;
      // Task 4.6b: in an audit replay there is no model and no ledger. A step is whole only when the runner replayed it in full from the recording it is bound to; any other end of a step is
      // a replay that could not go on, with the fixed code the step recorded (a value the model chose, else that it needed a model).
      let replayCode: string | null = null;
      const replaySteps: Array<{ stepIndex: number; whole: boolean; replayedActions: number; totalActions: number; stopCode: string | null }> = [];
      if (replay !== undefined && agentCaseIds.has(expected.caseId)) {
        for (const declaredStepIndex of declaredAgentSteps) {
          const sdk = reportAgentSteps[declaredAgentSteps.indexOf(declaredStepIndex)]!;
          const captured = capture.steps.find((item) => item.declaredStepIndex === declaredStepIndex)!;
          const bound = replay.bindings.find((item) => item.caseId === expected.caseId && item.stepIndex === declaredStepIndex);
          const cache = sdk.cache;
          const whole = captured.outcome === "completed" && sdk.status === "passed" && cache?.mode === "self-finalized" && bound !== undefined
            && cache.replayedActions === cache.totalActions && cache.totalActions === bound.actionCount && cache.entry === bound.keyHash;
          const frameCode = whole ? null : replayStopCodeOf(captured.evidenceRefs, proofById);
          replaySteps.push({ stepIndex: declaredStepIndex, whole, replayedActions: cache?.replayedActions ?? 0, totalActions: cache?.totalActions ?? 0, stopCode: frameCode });
          replayCode ??= whole ? null : frameCode ?? "replay-needs-model";
        }
      }
      // A case that never reached its agent step (an earlier step stopped it) has nothing of the model's to judge, and no receipt may name it.
      if (replay !== undefined) {
        // judged above
      } else if (agentCaseIds.has(expected.caseId) && declaredAgentSteps.length === 0) {
        if (agentReceipts.some((receipt) => receipt.caseId === expected.caseId)) throw new Error("model-receipts-mismatch: a model receipt is attributed to a case that never reached its AI navigation step");
        const channel = agentModel!.channel;
        agentResult = channel.droppedRequests !== 0 || channel.unscopedRequests !== 0 || channel.overrun || channel.evidenceErrors !== 0
          ? { verdict: { kind: "unknown", code: "model-receipts-mismatch" }, ledger: null, verifiedReceiptIds: [], matched: ["model-receipts-mismatch"] }
          : { verdict: { kind: "deterministic" }, ledger: null, verifiedReceiptIds: [], matched: [] };
      } else if (agentCaseIds.has(expected.caseId)) {
        const ledgerEntry = agentModel!.ledgers.find((item) => item.caseDirectory === agentCaseDirectoryName(expected.caseId));
        const ledgerBytes = ledgerEntry === undefined ? null : (() => {
          const decoded = Buffer.from(ledgerEntry.bytesBase64, "base64");
          return decoded.toString("base64") === ledgerEntry.bytesBase64 && createHash("sha256").update(decoded).digest("hex") === ledgerEntry.sha256 ? new Uint8Array(decoded) : null;
        })();
        const csvIndex = facts.scenario.assertions.findIndex((assertion) => assertion.kind === "csv");
        const csvCaptured = csvIndex >= 0 ? capture.assertions[csvIndex] : undefined;
        // The collector decides a download was captured from the evidence the assertion observed; the executor's own word on why there is none only chooses between two codes.
        const csvDownload = csvIndex < 0 ? "not-applicable" as const : csvCaptured?.evidenceRef != null ? "captured" as const
          : csvCaptured?.outcome === "unavailable" && csvCaptured.reason === "ambiguous-download" ? "multiple" as const
            : csvCaptured?.outcome === "unavailable" && (csvCaptured.reason === "agent-no-download" || csvCaptured.reason === "download-not-observed") ? "none" as const : "not-applicable" as const;
        agentResult = agentModel!.route === null ? { verdict: { kind: "unknown", code: "model-receipts-mismatch" }, ledger: null, verifiedReceiptIds: [], matched: ["model-receipts-mismatch"] }
          : evaluateE2EAgentCase({ roundScope: oracle.roundScope ?? "standard", runId: capture.runId, caseId: expected.caseId, route: agentModel!.route,
            agentSteps: declaredAgentSteps.map((declaredStepIndex, position) => {
              const step = facts.scenario.steps[declaredStepIndex] as Extract<(typeof facts.scenario.steps)[number], { kind: "agent" }>;
              const sdk = reportAgentSteps[position]!;
              return { declaredStepIndex, goal: step.goal, maxActions: step.maxActions,
                report: sdk.metrics ? { modelCalls: sdk.metrics.modelCalls, actionSteps: sdk.metrics.actionSteps, status: sdk.status, errorCode: sdk.error?.code ?? null } : null };
            }),
            receipts: agentReceipts.filter((receipt) => receipt.caseId === expected.caseId), groupReceipts: agentReceipts, ledgerBytes, valueKey: agentModel!.valueKey,
            transcriptDigests: agentModel!.transcriptDigests.filter((digest) => agentReceipts.some((receipt) => receipt.receiptId === digest.receiptId && receipt.caseId === expected.caseId)),
            channel: agentModel!.channel, csvDownload });
      }
      const agentBlocked = (agentResult !== null && agentResult.verdict.kind === "unknown") || replayCode !== null;
      const agentOperationCount = agentResult?.ledger?.steps.reduce((total, step) => total + step.actions.length, 0) ?? 0;
      const deterministicActionCount = capture.steps.filter((step) => step.kind !== "agent").length;
      if (capture.steps.length > facts.scenario.steps.length || deterministicActionCount + agentOperationCount > oracle.round.limits.maxActionsPerCase
        || agentOperationCount > 100) throw new Error("application agent operations exceed the original action budget");
      type RequiredAssertionAsset = Readonly<{ caseId: string; assertionIndex: number;
        kind: "json-schema" | "state-probe" | "fixture-root"; id: string }>;
      const requiredAssets: RequiredAssertionAsset[] = [];
      facts.scenario.assertions.forEach((assertion, index) => {
        if (assertion.kind === "json") requiredAssets.push({ caseId: expected.caseId, assertionIndex: index, kind: "json-schema", id: assertion.schemaRef });
        else if (assertion.kind === "state") requiredAssets.push({ caseId: expected.caseId, assertionIndex: index, kind: "state-probe", id: assertion.probeId });
        else if (assertion.kind === "file") requiredAssets.push({ caseId: expected.caseId, assertionIndex: index, kind: "fixture-root", id: assertion.fixtureRootId });
      });
      const caseAssets = oracle.assertionAssets.filter((asset) => asset.caseId === expected.caseId);
      if (caseAssets.length !== requiredAssets.length || requiredAssets.some((required) => {
        const asset = caseAssets.find((item) => item.assertionIndex === required.assertionIndex);
        return !asset || asset.kind !== required.kind || asset.id !== required.id || !proofById.has(asset.ref.artifactId);
      })) throw new Error("protected assertion assets do not exactly cover the source-derived scenario assertions");
      let assertionPrefixClosed = false;
      const evaluated = capture.assertions.map((captured, index) => {
        const expectedProducer = assertionProducerRows.get(index);
        if (!expectedProducer || canonicalJson(captured.producer) !== canonicalJson(expectedProducer)) throw new Error("assertion has no exact protected producer identity");
        const afterFailure = capture.terminal.kind === "assertion-failed" && capture.terminal.failedAssertionIndex !== null
          && index > capture.terminal.failedAssertionIndex;
        if (captured.outcome === "unavailable") {
          if (captured.value !== null || captured.evidenceRef !== null || captured.observationId !== null || capture.terminal.kind === "completed"
            || (capture.terminal.kind === "assertion-failed" && !afterFailure)) {
            throw new Error("unavailable assertion is inconsistent with the exact terminal observation prefix");
          }
          assertionPrefixClosed = true;
          return null;
        }
        if (afterFailure || assertionPrefixClosed) throw new Error("assertion observation appears after the exact terminal assertion prefix");
        const asset = caseAssets.find((item) => item.assertionIndex === index) ?? null;
        if (!expectedProducer || !captured.evidenceRef || !captured.observationId
          || canonicalJson(captured.producer) !== canonicalJson(expectedProducer)) throw new Error("assertion has no protected producer or retained observation frame");
        const observationProof = proofById.get(captured.evidenceRef.artifactId);
        if (!observationProof || evidenceKey(observationProof.ref) !== evidenceKey(captured.evidenceRef)) throw new Error("assertion observation frame is absent from retained supervisor bytes");
        const observation = parseCanonicalFrame(observationProof, E2EApplicationAssertionObservationSchema, "assertion observation frame");
        if (observation.caseId !== expected.caseId || observation.assertionIndex !== index || observation.assertionDigest !== expected.assertionDigests[index]
          || observation.observationId !== captured.observationId || observation.lifecycleId !== capture.lifecycleId
          || observation.producer.operationId !== expectedProducer.operationId || observation.producer.operationFence !== expectedProducer.operationFence
          || canonicalJson(observation.producer) !== canonicalJson(expectedProducer) || canonicalJson(observation.subject) !== canonicalJson(protectedBinding.subject)
          || observation.accountContextId !== expected.accountContextId || observation.accountContextDigest !== expected.accountContextDigest
          || observation.sessionRef !== protectedBinding.sessionRef || observation.accountIdDigest !== protectedBinding.accountIdDigest
          || !withinProcess(observation.observedAt) || Date.parse(observation.observedAt) < Date.parse(oracle.round.admittedAt) || Date.parse(observation.observedAt) > closedAt) {
          throw new Error("raw assertion observation differs from the exact protected case, account, session, producer, subject, or time binding");
        }
        if (observation.kind === "http-status") {
          const connection = protectedBinding.connection;
          const preparedOrigin = oracle.originByApplicationId.find((item) => item.applicationId === facts.applicationId)?.origin;
          const approvedAssertion = facts.scenario.assertions[index];
          type ApprovedRequestStep = Extract<(typeof facts.scenario.steps)[number], { kind: "request" }>;
          const requestSteps = facts.scenario.steps.filter((step): step is ApprovedRequestStep => step.kind === "request");
          const approvedRequest = approvedAssertion?.kind === "http-status"
            ? requestSteps.filter((step) => step.method === approvedAssertion.method && step.path === approvedAssertion.path).at(-1) : undefined;
          if ((connection === null && (observation.connectionRef !== null || preparedOrigin === null || preparedOrigin === undefined
            || observation.origin !== preparedOrigin))
            || (connection !== null && (canonicalJson(observation.connectionRef) !== canonicalJson(connection.ref) || observation.origin !== connection.origin))
            || (approvedRequest !== undefined && (observation.requestId !== approvedRequest.requestId
              || observation.method !== approvedRequest.method || observation.path !== approvedRequest.path))
            || (approvedRequest === undefined && (approvedAssertion?.kind !== "http-status"
              || observation.method !== approvedAssertion.method || observation.path !== approvedAssertion.path))) {
            throw new Error("HTTP observation connection or origin differs from protected connection assignment");
          }
        }
        const outcome = evaluateE2EApplicationAssertionObservation({ assertion: facts.scenario.assertions[index]!, observation, proofBytes: proofById, assetBinding: asset });
        if (!outcome.supported || canonicalJson(outcome.value) !== canonicalJson(captured.value)
          || captured.outcome !== (outcome.passed ? "passed" : "failed")) throw new Error("capture assertion value or outcome contradicts its typed original observation bytes");
        if (!outcome.passed) assertionPrefixClosed = true;
        return outcome;
      });
      const failedIndexes = evaluated.flatMap((item, index) => item && !item.passed ? [index] : []);
      const failed = failedIndexes.length > 0;
      // A case whose AI navigation did not come out clean is UNKNOWN whatever else it shows, so the checks that tie its terminal record to the report's verdict do not apply: the
      // executor stops such a case without an assertion having failed (a model that was unavailable, a step that never reached a download), and it can no longer pass or fail.
      if (!agentBlocked) {
        if (failed !== (report.status === "failed") || (failed && (!report.failureObserved || capture.terminal.kind !== "assertion-failed"
          || capture.terminal.failedAssertionIndex !== failedIndexes[0] || report.failureAssertionIndex !== failedIndexes[0] || failedIndexes.length !== 1))
          || (!failed && capture.terminal.kind === "assertion-failed")
          || (capture.terminal.kind === "completed" && capture.assertions.some((item) => item.outcome !== "passed"))) {
          throw new Error("raw assertion outcomes, terminal record, and upstream report verdict disagree");
        }
        if (capture.terminal.kind === "completed" && (capture.terminal.failedAssertionIndex !== null
          || capture.terminal.lastDeclaredStepIndex !== facts.scenario.steps.length - 1 || capture.steps.some((step) => step.outcome !== "completed"))) {
          throw new Error("completed terminal does not cover the exact ordered authorized action list");
        }
        if (capture.terminal.kind === "assertion-failed" && (capture.terminal.failedAssertionIndex === null
          || capture.terminal.lastDeclaredStepIndex !== (capture.steps.at(-1)?.declaredStepIndex ?? null)
          || capture.steps.some((step) => step.declaredStepIndex > capture.terminal.lastDeclaredStepIndex!)
          || capture.steps.length !== (capture.terminal.lastDeclaredStepIndex === null ? 0 : capture.terminal.lastDeclaredStepIndex + 1))) {
          throw new Error("failed terminal exceeds the observed authorized action prefix");
        }
        if ((capture.terminal.kind === "unavailable" || capture.terminal.kind === "uncertain")
          && (capture.terminal.failedAssertionIndex !== null
            || capture.terminal.lastDeclaredStepIndex !== (capture.steps.at(-1)?.declaredStepIndex ?? null)
            || capture.steps.some((step, index) => index < capture.steps.length - 1 && step.outcome !== "completed"))) {
          throw new Error("uncertain or unavailable terminal differs from the actual authorized action prefix");
        }
      }
      if (!withinProcess(capture.terminal.at) || Date.parse(capture.terminal.at) < Date.parse(oracle.round.admittedAt) || Date.parse(capture.terminal.at) > closedAt) {
        throw new Error("application terminal timestamp is outside the original process and cleanup window");
      }
      const allPassed = evaluated.every((item) => item !== null && item.passed) && capture.assertions.every((item) => item.outcome === "passed");
      const expectedMockRows = oracle.expectedMocksByCase.find((item) => item.caseId === expected.caseId)?.specs ?? [];
      const caseConsumptions = collection.mockConsumptions.filter((item) => item.caseId === expected.caseId);
      const observedMocks = caseConsumptions.filter((item) => item.runId === capture.runId && item.mockManifestDigest === oracle.binding.mockManifestDigest
        && item.lifecycleId === capture.lifecycleId && item.producer.lifecycleId === capture.lifecycleId
        && item.producer.operationId === oracle.binding.operationId && item.producer.operationFence === oracle.binding.operationFence
        && item.producer.runtimeManifestDigest === facts.runtimeManifestDigest).map((item) => item.componentId);
      const expectedMockComponents = expectedMockRows.map((item) => item.componentId);
      const observedMockComponents = [...new Set(observedMocks)].sort();
      const expectedMockComponentSet = [...new Set(expectedMockComponents)].sort();
      const mockRowsBound = caseConsumptions.every((item) => expectedMockComponents.includes(item.componentId)
        && item.mockManifestDigest === oracle.binding.mockManifestDigest && item.runId === capture.runId
        && item.lifecycleId === capture.lifecycleId && item.producer.lifecycleId === capture.lifecycleId
        && item.producer.operationId === oracle.binding.operationId && item.producer.operationFence === oracle.binding.operationFence
        && item.producer.runtimeManifestDigest === facts.runtimeManifestDigest)
        && canonicalJson([...capture.coverage.observedMockedComponentIds].sort()) === canonicalJson(observedMockComponents);
      // A mock the host serves to the application is judged on the application's own calls to it; any other mock on the executor's request steps, as before.
      const hostedComponents = new Set((oracle.mockOrigins ?? []).map((item) => item.componentId));
      const executorSpecs = expectedMockRows.filter((spec) => !hostedComponents.has(spec.componentId));
      const hostedSpecs = expectedMockRows.filter((spec) => hostedComponents.has(spec.componentId));
      const executorRows = caseConsumptions.filter((row) => !hostedComponents.has(row.componentId));
      const hostedRows = caseConsumptions.filter((row) => hostedComponents.has(row.componentId));
      const mockRequestsBound = mockConsumptionRequestsMatch(facts.scenario, capture, executorSpecs, executorRows);
      const hostedWitnessesAll = hostedMockWitnesses(hostedSpecs, hostedRows, proofById, true);
      const hostedWitnessesSome = hostedMockWitnesses(hostedSpecs, hostedRows, proofById, false);
      const mocksConsumed = expectedMockComponentSet.every((componentId) => observedMockComponents.includes(componentId))
        && observedMockComponents.every((componentId) => expectedMockComponentSet.includes(componentId))
        && mockRowsBound && mockRequestsBound && mockWitnessesMatch(executorSpecs, executorRows, proofById, true, facts.scenario, capture) && hostedWitnessesAll.ok;
      const failureMockPreconditions = mockRowsBound && mockRequestsBound
        && mockWitnessesMatch(executorSpecs, executorRows, proofById, false, facts.scenario, capture) && hostedWitnessesSome.ok;
      // Any call that no approved mock matched makes the case UNKNOWN: it is never a pass, and it is never a failure either, because what the app did with an answer nobody approved says nothing about the feature.
      const caseUnmockedCalls = (collection.unmockedCalls ?? []).filter((item) => item.caseId === expected.caseId).flatMap((item) => item.calls);
      const originOfComponent = new Map((oracle.mockOrigins ?? []).map((item) => [item.componentId, item.originRef]));
      const caseMockedOrigins = [...new Set(hostedSpecs.flatMap((spec) => originOfComponent.get(spec.componentId) ?? []))].sort();
      if (hostedWitnessesSome.ok) for (const variant of hostedWitnessesSome.variants) summaryConsumptions[variant === "invalid-data" ? "invalidData" : variant] += 1;
      for (const call of caseUnmockedCalls) summaryUnmocked.set(`${call.origin}\u0000${call.requestId}`, call.origin);
      for (const origin of caseMockedOrigins) summaryOrigins.add(origin);
      // The agent part is clean when the receipts, the ledger and the report agree and show no stop; a case with no agent step has no model receipts of its own (any attributed to
      // it were refused above).
      const modelBound = agentResult === null || agentResult.verdict.kind === "deterministic";
      if (agentResult !== null && modelBound) verifiedModelReceiptIds.push(...agentResult.verifiedReceiptIds);
      const observedExternal = evaluated.some((item, index) => item !== null && facts.scenario.assertions[index]?.kind === "http-status"
        && protectedBinding.connection !== null && capture.assertions[index]?.evidenceRef !== null);
      const observedScope = observedExternal ? "external-live" : evaluated.some((item) => item !== null) ? "runtime" : "source";
      const expectedCandidateParts = observedScope === "source" ? [] : [facts.applicationId];
      const expectedObservedMocked = [...new Set(observedMocks)].sort();
      const expectedUnexercised = capture.assertions.filter((item) => item.outcome !== "passed").map((item) => item.digest);
      // A case whose AI navigation was not clean observes nothing the result keeps (it is UNKNOWN, with source coverage), so the executor's own scope claim for it is not held to the
      // observations; everything else about its coverage still is.
      if ((!agentBlocked && (capture.coverage.observedScope !== observedScope || canonicalJson(capture.coverage.executedCandidateParts) !== canonicalJson(expectedCandidateParts)))
        || capture.coverage.subject !== "candidate"
        || capture.coverage.realComponentIds.length !== 0
        || canonicalJson([...capture.coverage.mockedComponentIds].sort()) !== canonicalJson([...expectedMockComponents].sort())
        || canonicalJson([...capture.coverage.observedMockedComponentIds].sort()) !== canonicalJson(expectedObservedMocked)
        || canonicalJson(capture.coverage.unexercisedBehaviors) !== canonicalJson(expectedUnexercised)) {
        throw new Error("caller capture coverage differs from the scope, mocks, and behaviors derivable from protected observations");
      }
      const scopeRank = { source: 0, "mock-contract": 1, runtime: 2, "external-live": 3 } as const;
      const evidenceFloor = scopeRank[observedScope] >= scopeRank[expected.minimumEvidence]
        && expected.requiredRealComponentIds.length === 0
        && (expected.minimumEvidence !== "external-live" || (observedScope === "external-live" && protectedBinding.connection !== null));
      const hasIncompleteTerminal = capture.assertions.some((item) => item.outcome === "unavailable");
      const ownedOrigin = oracle.originByApplicationId.find((item) => item.applicationId === facts.applicationId)?.origin;
      const expectedSubjectKind = facts.platform === "web" ? "browser" : facts.platform === "api" ? "service"
        : facts.platform === "android" || facts.platform === "ios" ? "mobile" : "desktop";
      const subjectBound = capture.subject.kind === expectedSubjectKind && (capture.subject.kind === "service" ? capture.subject.origin === ownedOrigin
        : capture.subject.kind === "mobile" ? capture.subject.installedArtifactSha256 === protectedBinding.selectedArtifact.sha256 : true);
      const status = caseUnmockedCalls.length > 0 || agentBlocked ? "unavailable"
        : failed && stepsObserved && agentOperationsValid && subjectBound && failureMockPreconditions ? "failed"
        : !failed && allPassed && stepsObserved && mocksConsumed && modelBound && evidenceFloor && subjectBound && !hasIncompleteTerminal ? "passed" : "unavailable";
      const assertionReceipts = expected.assertionDigests.map((digest, index) => ({ assertionIndex: index, assertionDigest: digest,
        status: capture.assertions[index]?.outcome === "passed" ? "passed" as const : capture.assertions[index]?.outcome === "failed" ? "failed" as const : "unavailable" as const,
        reason: capture.assertions[index]?.reason ?? "assertion was not observed" }));
      const coverage: E2ECaseCoverage = { observedScope: status === "passed" ? observedScope : "source", subject: "candidate",
        executedCandidateParts: expectedCandidateParts, realComponentIds: [], mockedComponentIds: [...expectedMockComponents].sort(),
        observedMockedComponentIds: [...new Set(observedMocks)].sort(),
        unexercisedBehaviors: capture.assertions.filter((item) => item.outcome !== "passed").map((item) => item.digest) };
      const csvAssertionIndex = facts.scenario.assertions.findIndex((assertion) => assertion.kind === "csv");
      caseFactRows.push({ caseId: expected.caseId, csvSha256: csvAssertionIndex < 0 ? null : evaluated[csvAssertionIndex]?.contentSha256 ?? null, agentSteps: replaySteps });
      return { caseId: expected.caseId, executionDescriptorDigest: expected.executionDescriptorDigest, accountContextId: expected.accountContextId,
        accountContextDigest: expected.accountContextDigest, status, reason: status === "passed" ? "structural-application-observations-complete" : status === "failed" ? "observed-application-assertion-failure"
          : caseUnmockedCalls.length > 0 ? UNMOCKED_EXTERNAL_CALL_REASON : agentResult?.verdict.kind === "unknown" ? agentResult.verdict.code : replayCode !== null ? replayCode : "application-evidence-floor-unmet",
        attemptCount: 1, assertionDigest: expected.assertionDigest, assertionReceipts, artifacts: [], coverage,
        ...(caseMockedOrigins.length > 0 ? { mockedOrigins: caseMockedOrigins } : {}) };
    });
    const anyFailed = normalizedCases.some((item) => item.status === "failed"); const allPassed = normalizedCases.every((item) => item.status === "passed");
    const hashes = collection.shards.map((shard) => ({ shardId: shard.shardId, sha256: shard.rawReport.sha256 })).sort((a, b) => a.shardId.localeCompare(b.shardId));
    const reportHash = hashes.length === 1 ? hashes[0]!.sha256 : createHash("sha256").update(canonicalJson(hashes)).digest("hex");
    const unmockedCases = normalizedCases.some((item) => item.status === "unavailable" && item.reason === UNMOCKED_EXTERNAL_CALL_REASON);
    const mockedOrigins = [...summaryOrigins].sort();
    const result = E2EQualifiedResultSchema.parse({ schemaVersion: 1, binding: oracle.binding, producer: "structural-application-report-adapter",
      startedAt: collection.shards.map((item) => item.runProcess.startedAt).sort()[0], finishedAt: collection.shards.map((item) => item.runProcess.finishedAt).sort().at(-1),
      receivedAt: collection.receivedAt, status: anyFailed ? "failed" : allPassed ? "passed" : "unavailable", qualification: "exploratory", executionMode: oracle.binding.executionMode,
      reason: anyFailed ? "observed-application-test-failure" : allPassed ? "structural-application-observations-complete" : unmockedCases ? UNMOCKED_EXTERNAL_CALL_REASON : "application-evidence-floor-unmet",
      cases: normalizedCases, rawReportSha256: reportHash, modelReceiptIds: verifiedModelReceiptIds.sort(), cleanup: collection.cleanup,
      ...(mockedOrigins.length > 0 ? { mockedOrigins } : {}) });
    const unmockedByOrigin = [...summaryUnmocked.values()];
    const mockSummary: E2EApplicationMockSummary | undefined = mockedOrigins.length > 0 || unmockedByOrigin.length > 0
      ? { consumptions: summaryConsumptions, unmockedCalls: { sinkhole: unmockedByOrigin.filter((origin) => origin === SINKHOLE_ORIGIN_REF).length,
        mocked: unmockedByOrigin.filter((origin) => origin !== SINKHOLE_ORIGIN_REF).length }, mockedOrigins } : undefined;
    return { status: anyFailed ? "FAILED" : allPassed ? "PASS" : "UNKNOWN",
      reason: !anyFailed && !allPassed && unmockedCases ? UNMOCKED_EXTERNAL_CALL_REASON : "structural application observations remain exploratory pending independent producer authentication",
      runId: oracle.binding.runId, rawReportSha256: reportHash, result, ...(mockSummary ? { mockSummary } : {}), caseFacts: caseFactRows };
  } catch (error) { return unknown(error instanceof Error ? error.message : "application collection unavailable", oracleInput?.binding?.runId ?? null); }
}

/**
 * The fixed code an AI navigation step of an audit replay recorded for why it did not go on (Task 4.6b): read from the step's retained observation, and only ever one of the two codes
 * the replay port writes; anything else, or nothing readable, is no code (the caller then says the replay needed a model).
 */
function replayStopCodeOf(refs: readonly E2EApplicationEvidenceRef[], proofById: ReadonlyMap<string, E2EApplicationProofBytes>): string | null {
  for (const ref of refs) {
    try {
      const proof = proofById.get(ref.artifactId);
      if (proof === undefined || evidenceKey(proof.ref) !== evidenceKey(ref)) continue;
      const frame = z.object({ agent: z.object({ stopCode: z.string().nullable() }).passthrough() }).passthrough().safeParse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(proof.bytes)));
      if (frame.success && frame.data.agent.stopCode !== null && (E2E_REPLAY_STOP_CODES as readonly string[]).includes(frame.data.agent.stopCode)) return frame.data.agent.stopCode;
    } catch { /* an unreadable frame names no code */ }
  }
  return null;
}

function scenarioActionsMatch(scenarioInput: unknown, capture: E2EApplicationCaseCapture): boolean {
  if (!scenarioInput || typeof scenarioInput !== "object" || !Array.isArray((scenarioInput as Record<string, unknown>).steps)) return false;
  const steps = (scenarioInput as { steps: unknown[] }).steps;
  const expectedLength = capture.terminal.kind === "completed" ? steps.length
    : capture.terminal.lastDeclaredStepIndex === null ? 0 : capture.terminal.lastDeclaredStepIndex + 1;
  if (capture.steps.length !== expectedLength || capture.steps.some((item, index) => {
    if (item.index !== index || item.declaredStepIndex !== index) return true;
    const approved = steps[item.declaredStepIndex];
    return !approved || typeof approved !== "object" || Array.isArray(approved)
      || (approved as Record<string, unknown>).kind !== item.kind
      || item.actionDigest !== createHash("sha256").update(canonicalJson(approved)).digest("hex")
      || (index < capture.steps.length - 1 && item.outcome !== "completed")
      || (item.outcome === "completed" && item.observationId === null)
      || (capture.terminal.kind === "completed" && (item.outcome !== "completed" || item.observationId === null))
      || ((capture.terminal.kind === "unavailable" || capture.terminal.kind === "uncertain") && index === capture.steps.length - 1
        && item.outcome !== "completed" && item.outcome !== capture.terminal.kind);
  })) return false;
  return capture.steps.every((item, index) => item.declaredStepIndex === index)
    && (capture.terminal.kind !== "completed" || steps.every((_, index) => capture.steps[index]?.declaredStepIndex === index));
}

function mockWitnessesMatch(expected: readonly z.infer<typeof E2EMockSpecSchema>[], rows: readonly E2EApplicationMockConsumption[],
  proofById: ReadonlyMap<string, E2EApplicationProofBytes>, requireEveryExpected: boolean,
  scenario: z.infer<typeof E2EScenarioSchema>, capture: E2EApplicationCaseCapture): boolean {
  if (rows.length === 0) return !requireEveryExpected || expected.length === 0;
  if (expected.length === 0) return false;
  for (const row of rows) {
    const candidateSpecs = expected.filter((candidate) => candidate.componentId === row.componentId && candidate.kind === "api" && candidate.apiFixture);
    if (candidateSpecs.length === 0) return false;
    try {
      const requestBytes = proofBytesFor(proofById, row.requestRef);
      const responseBytes = proofBytesFor(proofById, row.responseRef);
      const request = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(requestBytes)) as unknown;
      const response = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(responseBytes)) as unknown;
      if (canonicalJson(request) !== new TextDecoder("utf-8", { fatal: true }).decode(requestBytes)
        || canonicalJson(response) !== new TextDecoder("utf-8", { fatal: true }).decode(responseBytes)
        || !request || typeof request !== "object" || Array.isArray(request) || !response || typeof response !== "object" || Array.isArray(response)) return false;
      const requestFrame = z.object({ requestId: id(256), componentId: id(120), caseId: id(160), method: id(12), path: id(2048), input: z.record(z.string(), boundedData) }).strict().safeParse(request);
      const responseFrame = z.object({ responseId: id(256), requestId: id(256), status: z.number().int().min(100).max(599), body: boundedData }).strict().safeParse(response);
      if (!requestFrame.success || !responseFrame.success) return false;
      const req = requestFrame.data; const res = responseFrame.data;
      const executedRequests = capture.steps.flatMap((capturedStep) => {
        const step = scenario.steps[capturedStep.declaredStepIndex];
        if (step?.kind !== "request" || step.requestId !== req.requestId) return [];
        const matchingComponents = candidateSpecs.filter((spec) => spec.apiFixture?.method === step.method
          && spec.apiFixture.path === step.path && typeof step.body === "object" && step.body !== null && !Array.isArray(step.body)
          && canonicalJson(req.input) === canonicalJson(step.body));
        return matchingComponents.map((spec) => ({ step, spec }));
      });
      const matchingVariants = candidateSpecs.flatMap((spec) => {
        if (!spec.apiFixture) return [];
        const selectedInput = req.input[spec.apiFixture.inputField];
        if (typeof selectedInput !== "string" || req.method !== spec.apiFixture.method || req.path !== spec.apiFixture.path) return [];
        return spec.apiFixture.variants.filter((variant) => selectedInput === variant.inputValue
          && res.status === variant.status && canonicalJson(res.body) === canonicalJson(variant.body));
      });
      if (matchingVariants.length !== 1 || executedRequests.length !== 1 || executedRequests[0]?.step.method !== req.method
        || executedRequests[0]?.step.path !== req.path || executedRequests[0]?.spec.componentId !== req.componentId
        || req.requestId !== row.requestId || req.componentId !== row.componentId || req.caseId !== row.caseId
        || res.responseId !== row.responseId || res.requestId !== row.requestId) return false;
    } catch { return false; }
  }
  return (!requireEveryExpected || expected.every((spec) => rows.some((row) => row.componentId === spec.componentId)))
    && rows.every((row) => expected.some((spec) => spec.componentId === row.componentId));
}

/** The reason of a case, and of a run with no failed case, that made a call to a declared origin no approved mock matched. */
export const UNMOCKED_EXTERNAL_CALL_REASON = "unmocked-external-call";

const hostedRequestFrame = z.object({ requestId: id(256), componentId: id(120), caseId: id(160), method: id(12), path: id(2048), input: z.record(z.string(), boundedData),
  origin: z.literal("application") }).strict();
const hostedResponseFrame = z.object({ responseId: id(256), requestId: id(256), status: z.number().int().min(100).max(599), body: boundedData }).strict();
type HostedMockWitnesses = Readonly<{ ok: true; variants: readonly ("success" | "refusal" | "invalid-data")[] }> | Readonly<{ ok: false }>;

/**
 * Whether every call the application made to an approved, host-served mock is exactly what that mock's fixture would answer: the request frame is the fixture's method and path
 * with the one input field set to a variant's value, and the response frame is that variant's status and body. Nothing here relies on a step of the scenario, because it is the
 * application, not the executor, that makes the call. With `requireEveryExpected`, every approved mock of the case must also have been called at least once, so a dependency
 * that was never exercised cannot let a case pass.
 */
function hostedMockWitnesses(expected: readonly z.infer<typeof E2EMockSpecSchema>[], rows: readonly E2EApplicationMockConsumption[],
  proofById: ReadonlyMap<string, E2EApplicationProofBytes>, requireEveryExpected: boolean): HostedMockWitnesses {
  const variants: ("success" | "refusal" | "invalid-data")[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const fixture = expected.find((spec) => spec.componentId === row.componentId && spec.kind === "api")?.apiFixture;
    if (!fixture || seen.has(row.requestId)) return { ok: false };
    try {
      const requestBytes = proofBytesFor(proofById, row.requestRef); const responseBytes = proofBytesFor(proofById, row.responseRef);
      const requestText = new TextDecoder("utf-8", { fatal: true }).decode(requestBytes); const responseText = new TextDecoder("utf-8", { fatal: true }).decode(responseBytes);
      const requestValue = JSON.parse(requestText) as unknown; const responseValue = JSON.parse(responseText) as unknown;
      if (canonicalJson(requestValue) !== requestText || canonicalJson(responseValue) !== responseText) return { ok: false };
      const request = hostedRequestFrame.parse(requestValue); const response = hostedResponseFrame.parse(responseValue);
      const selected = request.input[fixture.inputField];
      const variant = typeof selected === "string" && Object.keys(request.input).length === 1 ? fixture.variants.find((candidate) => candidate.inputValue === selected) : undefined;
      if (!variant || request.method !== fixture.method || request.path !== fixture.path || response.status !== variant.status
        || canonicalJson(response.body) !== canonicalJson(variant.body ?? null)
        || request.requestId !== row.requestId || request.componentId !== row.componentId || request.caseId !== row.caseId
        || response.responseId !== row.responseId || response.requestId !== row.requestId) return { ok: false };
      seen.add(row.requestId); variants.push(variant.id);
    } catch { return { ok: false }; }
  }
  if (requireEveryExpected && !expected.every((spec) => rows.some((row) => row.componentId === spec.componentId))) return { ok: false };
  return { ok: true, variants };
}

function mockConsumptionRequestsMatch(scenario: z.infer<typeof E2EScenarioSchema>, capture: E2EApplicationCaseCapture,
  expected: readonly z.infer<typeof E2EMockSpecSchema>[], rows: readonly E2EApplicationMockConsumption[]): boolean {
  const authorized = new Map<string, string>();
  for (const capturedStep of capture.steps) {
    const step = scenario.steps[capturedStep.declaredStepIndex];
    if (step?.kind !== "request") continue;
    for (const spec of expected) {
      const fixture = spec.kind === "api" ? spec.apiFixture : undefined;
      if (!fixture || fixture.method !== step.method || fixture.path !== step.path
        || typeof step.body !== "object" || step.body === null || Array.isArray(step.body)) continue;
      const input = (step.body as Record<string, unknown>)[fixture.inputField];
      if (typeof input !== "string" || !fixture.variants.some((variant) => variant.inputValue === input)) continue;
      const key = `${step.requestId}\u0000${spec.componentId}`;
      if (authorized.has(key)) return false;
      authorized.set(key, spec.componentId);
    }
  }
  if (rows.length === 0) return authorized.size === 0;
  if (authorized.size === 0) return false;
  const consumed = new Set<string>();
  for (const row of rows) {
    const key = `${row.requestId}\u0000${row.componentId}`;
    if (!authorized.has(key) || consumed.has(key)) return false;
    consumed.add(key);
  }
  return consumed.size === authorized.size;
}

export const E2EApplicationGroupResultEnvelopeSchema = z.object({ schemaVersion: z.literal("e2e-application-group-result/v1"), admissionDigest: sha, groupId: id(80),
  protocol: z.enum(["trusted-e2e-application/v1", "trusted-e2e/v1"]), outerBinding: E2ERunBindingSchema, executionBinding: E2ERunBindingSchema,
  rawEvidenceRef: E2EApplicationEvidenceRefSchema, rawEvidenceSha256: sha, result: E2EQualifiedResultSchema, mappingDigest: sha }).strict();
export type E2EApplicationGroupResultEnvelope = z.infer<typeof E2EApplicationGroupResultEnvelopeSchema>;
function mappingDigest(envelope: Omit<E2EApplicationGroupResultEnvelope, "mappingDigest">): string { return createHash("sha256").update(canonicalJson(envelope)).digest("hex"); }
export function mapE2EApplicationGroupResult(input: { admission: unknown; envelope: unknown; rawEvidenceBytes: Uint8Array }): E2EQualifiedResult {
  if (!(input.rawEvidenceBytes instanceof Uint8Array) || input.rawEvidenceBytes.byteLength > 26_214_400) throw new Error("group result raw evidence exceeds the private artifact bound");
  const bytes = Buffer.from(input.rawEvidenceBytes);
  const validated = validateE2EApplicationExecutionAdmission(input.admission);
  const envelope = E2EApplicationGroupResultEnvelopeSchema.parse(copyBoundedE2EJsonData(input.envelope, { maxBytes: 8 * 1024 * 1024, maxDepth: 64 }));
  if (bytes.byteLength !== envelope.rawEvidenceRef.byteLength || createHash("sha256").update(bytes).digest("hex") !== envelope.rawEvidenceRef.sha256
    || envelope.rawEvidenceSha256 !== envelope.rawEvidenceRef.sha256 || envelope.admissionDigest !== validated.admission.admissionDigest) throw new Error("group result raw evidence or admission digest mismatch");
  if (envelope.groupId !== envelope.outerBinding.groupId || envelope.groupId !== envelope.executionBinding.groupId) throw new Error("group result envelope group identity differs from its bindings");
  const resultCaseIds = envelope.result.cases.map((item) => item.caseId).sort();
  const expectedExecutionCaseIds = envelope.executionBinding.expectedCases.map((item) => item.caseId).sort();
  if (resultCaseIds.length !== expectedExecutionCaseIds.length || canonicalJson(resultCaseIds) !== canonicalJson(expectedExecutionCaseIds)) {
    throw new Error("group result must contain exactly one result for every expected execution case");
  }
  const groupAdmission = validated.admission.groups.find((item) => item.outerBinding.groupId === envelope.groupId);
  if (!groupAdmission || groupAdmission.protocol !== envelope.protocol || canonicalJson(groupAdmission.outerBinding) !== canonicalJson(envelope.outerBinding)) throw new Error("group result does not match an admitted group");
  if (envelope.protocol === "trusted-e2e-application/v1") {
    if (canonicalJson(envelope.executionBinding) !== canonicalJson(envelope.outerBinding)) throw new Error("application result binding must remain the outer binding");
  } else {
    if (groupAdmission.protocol !== "trusted-e2e/v1" || canonicalJson(groupAdmission.childBinding) !== canonicalJson(envelope.executionBinding)
      || canonicalJson(groupAdmission.childRound.groupBindings.find((item) => item.groupId === envelope.groupId)) !== canonicalJson(envelope.executionBinding)) throw new Error("portable result binding is not the exact admitted child binding");
    if (groupAdmission.childRound.roundId !== envelope.executionBinding.roundId
      || groupAdmission.childRound.executionPlanDigest !== envelope.executionBinding.executionPlanDigest
      || envelope.executionBinding.modelRouteRevision !== null
      || canonicalJson(envelope.outerBinding.expectedCases) !== canonicalJson(envelope.executionBinding.expectedCases)) {
      throw new Error("portable child round, model-free route, or full expected-case inventory differs from its combined group");
    }
    const projectedSuite = validated.portableSuites.find((suite) => suite.group.groupId === envelope.groupId);
    if (!projectedSuite || projectedSuite.inventory.digest !== groupAdmission.compiledInventoryDigest
      || createHash("sha256").update(canonicalJson(validated.admission.portableProjection)).digest("hex") !== groupAdmission.projectionDigest) {
      throw new Error("portable result does not bind to the freshly derived child projection and compiled inventory");
    }
  }
  if (canonicalJson(envelope.result.binding) !== canonicalJson(envelope.executionBinding)) throw new Error("result's original execution binding differs from envelope provenance");
  for (const observed of envelope.result.cases) {
    const expected = envelope.executionBinding.expectedCases.find((item) => item.caseId === observed.caseId);
    if (!expected || observed.executionDescriptorDigest !== expected.executionDescriptorDigest || observed.accountContextId !== expected.accountContextId
      || observed.accountContextDigest !== expected.accountContextDigest || observed.assertionDigest !== expected.assertionDigest
      || observed.assertionReceipts.length !== expected.assertionDigests.length
      || observed.assertionReceipts.some((receipt, index) => receipt.assertionIndex !== index || receipt.assertionDigest !== expected.assertionDigests[index])) {
      throw new Error("group result case or assertion identity differs from the exact execution binding");
    }
  }
  const { mappingDigest: claimedDigest, ...body } = envelope;
  if (mappingDigest(body) !== claimedDigest) throw new Error("group result mapping digest is invalid");
  const projection = { ...envelope.result, binding: envelope.outerBinding };
  return E2EQualifiedResultSchema.parse(projection);
}
