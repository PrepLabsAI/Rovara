import { createHash } from "node:crypto";
import { types } from "node:util";
import { z } from "zod";
import { canonicalJson, copyBoundedE2EJsonData, E2EApplicationEvidenceRefSchema, E2ECaseCoverageSchema,
  E2EExpectedCaseSchema, E2EQualifiedResultSchema, E2ERoundSchema, E2ERunBindingSchema,
  E2EScenarioSchema, type E2EApplicationEvidenceRef, type E2ECaseCoverage, type E2EQualifiedResult,
  type E2ERound, type E2ERunBinding } from "@agentx/contracts";
import { E2E_REPORT_MAX_BYTES, E2E_APP_RPC_FRAME_MAX_BYTES, e2ePrivateTransferMaxBytes, type E2EStructuralQualification } from "./result-adapter.js";
import { parseE2EApplicationReport } from "./application-report-schema.js";
import type { E2ECompiledApplicationSuite } from "./application-scenarios.js";
import { validateE2EApplicationExecutionAdmission, validateE2ECompiledApplicationAdmission } from "./application-scenarios.js";
import { compareE2EApplicationPublicList, E2EApplicationSelectionPacketSchema } from "./application-identity.js";
import { expectedE2EApplicationReporterDigest } from "./application-runtime-assets.js";

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const id = (max = 256) => z.string().min(1).max(max);
const utc = z.string().datetime({ offset: true });
const boundedData = z.unknown().refine((value) => { try { copyBoundedE2EJsonData(value, { maxBytes: 262_144, maxDepth: 32 }); return true; } catch { return false; } });
export const E2EApplicationProducerSchema = z.object({ producerId: id(120), receiptId: id(200), lifecycleId: id(120), operationId: z.string().uuid(),
  operationFence: z.number().int().positive(), runtimeManifestDigest: sha, transportCorrelationId: z.string().uuid() }).strict();
export type E2EApplicationProducer = z.infer<typeof E2EApplicationProducerSchema>;
export const E2EApplicationProofBytesSchema = z.object({ ref: E2EApplicationEvidenceRefSchema,
  bytes: z.instanceof(Uint8Array).refine((value) => value.byteLength <= 26_214_400) }).strict();
export type E2EApplicationProofBytes = Readonly<{ ref: Readonly<E2EApplicationEvidenceRef>; bytes: Uint8Array }>;
export const E2EApplicationSupervisorReadbackSchema = z.object({ schemaVersion: z.literal("e2e-application-supervisor-readback/v1"),
  receipt: E2EApplicationProofBytesSchema, evidence: z.array(E2EApplicationProofBytesSchema).max(250_000) }).strict();
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
  cleanupRef: supervisorRef, additionalSupervisorReceiptRefs: z.array(supervisorRef).max(32) }).strict();
const mockConsumptionFrame = z.object({ schemaVersion: z.literal("e2e-application-mock-consumption/v1"), context: supervisorContext,
  caseId: id(160), shardId: id(120), upstreamRunId: z.string().uuid(), rows: z.array(z.object({ caseId: id(160), componentId: id(120),
    runId: z.string().uuid(), mockManifestDigest: sha, lifecycleId: id(120), producer: E2EApplicationProducerSchema,
    requestId: id(256), responseId: id(256), requestSha256: sha, responseSha256: sha, observedAt: utc,
    requestRef: supervisorRef, responseRef: supervisorRef }).strict()).max(100) }).strict();
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
const captureStep = z.object({ index: z.number().int().min(0).max(99), declaredStepIndex: z.number().int().min(0).max(29),
  kind: z.enum(["navigate", "fill", "click", "agent", "request", "invoke-contract", "inspect-contract", "launch-app", "tap", "swipe", "deep-link", "restart-app", "set-permission", "choose-file"]), actionDigest: sha, observationId: id(256).nullable(), at: utc,
  outcome: z.enum(["completed", "failed", "unavailable", "uncertain"]), evidenceRefs: z.array(E2EApplicationEvidenceRefSchema).max(32) }).strict();
const captureAssertion = z.object({ index: z.number().int().min(0).max(19), digest: sha, observedAt: utc, observationId: id(256).nullable(),
  value: boundedData.nullable(), evidenceRef: E2EApplicationEvidenceRefSchema.nullable(), outcome: z.enum(["passed", "failed", "unavailable"]),
  reason: id(500), producer: E2EApplicationProducerSchema }).strict();
export const E2EApplicationCaseCaptureSchema = z.object({ schemaVersion: z.literal("e2e-application-case-capture/v1"), caseId: id(160),
  upstreamRunId: z.string().uuid(), shardId: id(120), roundId: z.string().uuid(), runId: z.string().uuid(), groupId: id(80), candidateDigest: sha,
  applicationId: id(120), buildManifestDigest: sha, runtimeManifestDigest: sha, executionDescriptorDigest: sha, accountContextId: id(120),
  accountContextDigest: sha, observedAt: utc, lifecycleId: id(120), subject: E2EApplicationOwnedSubjectSchema, producer: E2EApplicationProducerSchema,
  steps: z.array(captureStep).max(100), assertions: z.array(captureAssertion).min(1).max(20), artifacts: z.array(E2EApplicationEvidenceRefSchema).max(200),
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
function refsInCapture(capture: E2EApplicationCaseCapture): E2EApplicationEvidenceRef[] {
  return [...capture.steps.flatMap((step) => step.evidenceRefs), ...capture.assertions.flatMap((assertion) => assertion.evidenceRef ? [assertion.evidenceRef] : []), ...capture.artifacts];
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
  if (!Number.isSafeInteger(caseCount) || caseCount < 1 || caseCount > 64) throw new TypeError("supervisor proof case count is outside the admitted bound");
  const root = ownRecord(raw, ["schemaVersion", "receipt", "evidence"], "supervisor readback");
  const proof = (value: unknown, label: string) => {
    const row = ownRecord(value, ["ref", "bytes"], label);
    const ref = ownRecord(row.ref, ["artifactId", "sha256", "byteLength", "mediaType"], `${label} ref`);
    if (!(row.bytes instanceof Uint8Array)) throw new TypeError(`${label} bytes must be a Uint8Array`);
    return { ref, bytes: Uint8Array.from(row.bytes) };
  };
  const rawEvidence = root.evidence;
  if (!Array.isArray(rawEvidence) || types.isProxy(rawEvidence) || Object.getPrototypeOf(rawEvidence) !== Array.prototype
    || rawEvidence.length > 65 + caseCount * (2 + 200 + 100 * 32 + 20 + 2 * 100)) throw new TypeError("supervisor evidence is not a bounded ordinary array");
  const descriptors = Object.getOwnPropertyDescriptors(rawEvidence);
  if (Reflect.ownKeys(descriptors).some((key) => key !== "length" && (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(key)))) throw new TypeError("supervisor evidence array has extra properties");
  let total = 0;
  const evidence = Array.from({ length: rawEvidence.length }, (_, index) => {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) throw new TypeError("supervisor evidence array must be dense own data");
    const copy = proof(descriptor.value, "supervisor evidence entry");
    total += copy.bytes.byteLength;
    return copy;
  });
  const receipt = proof(root.receipt, "supervisor receipt");
  total += receipt.bytes.byteLength;
  if (total > 26_214_400) throw new Error("supervisor readback exceeds the active private transfer byte bound");
  return E2EApplicationSupervisorReadbackSchema.parse({ schemaVersion: root.schemaVersion, receipt, evidence });
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
    launches: readonly { shardId: string; launchId: string; upstreamRunId: string }[] };
  applicationCaptures: readonly unknown[]; supervisorReceiptRefs: readonly unknown[];
  cleanupConfirmed: boolean | null; cleanupServerListening: boolean | null }) {
  const parsedReadback = proofInventorySnapshot(input.readback, input.expected.caseCount);
  const readback: E2EApplicationSupervisorReadback = Object.freeze({ schemaVersion: parsedReadback.schemaVersion,
    receipt: Object.freeze({ ref: Object.freeze({ ...parsedReadback.receipt.ref }), bytes: Uint8Array.from(parsedReadback.receipt.bytes) }),
    evidence: Object.freeze(parsedReadback.evidence.map((item) => Object.freeze({ ref: Object.freeze({ ...item.ref }), bytes: Uint8Array.from(item.bytes) }))) });
  if (!Number.isSafeInteger(input.expected.caseCount) || input.expected.caseCount < 1 || input.expected.caseCount > 64
    || readback.evidence.length > 65 + input.expected.caseCount * (2 + 200 + 100 * 32 + 20 + 2 * 100)) {
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
        requestSha256: row.requestSha256, responseSha256: row.responseSha256, observedAt: row.observedAt });
    }
  }
  if (mockRows.length > input.expected.caseCount * 100) throw new Error("supervisor mock witness rows exceed the exact group bound");
  const rowsByCase = new Map<string, string[]>();
  for (const row of mockRows) {
    const components = rowsByCase.get(row.caseId) ?? [];
    components.push(row.componentId);
    rowsByCase.set(row.caseId, components);
  }
  for (const capture of captures) {
    const observed = (rowsByCase.get(capture.caseId) ?? []).sort();
    if (new Set(observed).size !== observed.length || canonicalJson(observed) !== canonicalJson([...capture.coverage.mockedComponentIds].sort())) {
      throw new Error("raw mock witness component set differs from the original case capture coverage");
    }
  }
  if (new Set(mockRows.map((row) => row.requestId)).size !== mockRows.length
    || new Set(mockRows.map((row) => row.responseId)).size !== mockRows.length) throw new Error("raw mock witness request and response IDs are not unique");
  const referenced: E2EApplicationEvidenceRef[] = [receipt.cleanupRef, ...receipt.additionalSupervisorReceiptRefs,
    ...receipt.caseCaptures.flatMap((entry) => [entry.ref]), ...receipt.mockConsumptions.flatMap((entry) => [entry.ref]),
    ...captures.flatMap(refsInCapture), ...cleanup.ownedCleanupReceiptRefs,
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
  return { readback, receipt, captures, cleanup, mockConsumptions: mockRows, evidenceBytes: totalBytes };
}

/** Performs raw-frame and transitive-byte closure checks for the installed transport before it returns bytes. */
export function validateE2EApplicationSupervisorReadbackStructure(readbackInput: E2EApplicationSupervisorReadback): void {
  const readback = proofInventorySnapshot(readbackInput, 64);
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
  const expectedSupervisorRefs = receipt.additionalSupervisorReceiptRefs;
  const claimedRefs = [readback.receipt.ref, ...expectedSupervisorRefs].sort((a, b) => a.artifactId.localeCompare(b.artifactId));
  readE2EApplicationSupervisorProof({ readback, expected: { bindingDigest: receipt.context.bindingDigest,
    compiledInventoryDigest: receipt.context.compiledInventoryDigest, preparedEnvironmentDigest: receipt.context.preparedEnvironmentDigest,
    candidateDigest: receipt.context.candidateDigest, roundId: receipt.context.roundId, runId: receipt.context.runId,
    groupId: receipt.context.groupId, mockManifestDigest, caseCount: 64, expectedSupervisorReceiptRefs: expectedSupervisorRefs,
    ownedResourceInventoryDigest: cleanup.ownedResourceInventoryDigest, launches: receipt.launches },
    applicationCaptures: captures, supervisorReceiptRefs: claimedRefs, cleanupConfirmed: true, cleanupServerListening: false });
}

const selectionPacket = E2EApplicationSelectionPacketSchema;
const processRecord = z.object({ status: z.number().int().nullable(), signal: z.string().max(64).nullable(), startedAt: utc, finishedAt: utc,
  timedOut: z.boolean(), aborted: z.boolean(), stdoutSha256: sha, stderrSha256: sha, stdoutBytes: z.number().int().nonnegative().max(E2E_REPORT_MAX_BYTES),
  stderrBytes: z.number().int().nonnegative().max(E2E_REPORT_MAX_BYTES) }).strict();
const encodedBytes = z.object({ bytesBase64: z.string().max(6 * 1024 * 1024), byteLength: z.number().int().nonnegative().max(E2E_REPORT_MAX_BYTES), sha256: sha }).strict();
const runStartSchema = z.object({ schemaVersion: z.literal("e2e-run-start-capture/v1"), challenge: z.string().uuid(), runId: z.string().uuid(),
  seq: z.number().int().positive(), at: utc }).strict();
const shardCollection = z.object({ shardId: id(120), launchId: id(128), launchConfigDigest: sha, fixedAssetDigests: z.record(id(256), sha), publicList: boundedData,
  publicListBytes: encodedBytes, rawReport: encodedBytes, runStderr: encodedBytes, runStartCapture: encodedBytes, runStart: runStartSchema,
  listProcess: processRecord, runProcess: processRecord }).strict();
const applicationCapture = E2EApplicationCaseCaptureSchema;
export const E2EApplicationCollectionSchema = z.object({ protocol: z.literal("e2e-application-collection/v1"), shards: z.array(shardCollection).min(1).max(3),
  applicationCaptures: z.array(applicationCapture).max(64), supervisorReceiptRefs: z.array(E2EApplicationEvidenceRefSchema).max(200),
  mockConsumptions: z.array(z.object({ caseId: id(160), componentId: id(120), runId: z.string().uuid(), mockManifestDigest: sha, lifecycleId: id(120),
    producer: E2EApplicationProducerSchema, requestId: id(256), responseId: id(256), requestSha256: sha, responseSha256: sha, observedAt: utc }).strict()).max(2048),
  declaredMockComponentIds: z.array(id(120)).max(32), receivedAt: utc, cleanup: z.enum(["confirmed", "pending", "failed"]) }).strict().superRefine((collection, context) => {
  if (new Set(collection.shards.map((item) => item.shardId)).size !== collection.shards.length) context.addIssue({ code: "custom", path: ["shards"], message: "shard IDs must be unique" });
  const caseIds = collection.applicationCaptures.map((item) => item.caseId);
  if (new Set(caseIds).size !== caseIds.length) context.addIssue({ code: "custom", path: ["applicationCaptures"], message: "case captures must be unique" });
  if (new Set(collection.mockConsumptions.map((item) => item.requestId)).size !== collection.mockConsumptions.length
    || new Set(collection.mockConsumptions.map((item) => item.responseId)).size !== collection.mockConsumptions.length) {
    context.addIssue({ code: "custom", path: ["mockConsumptions"], message: "mock consumption request and response identities must be unique" });
  }
  for (const shard of collection.shards) for (const field of [shard.publicListBytes, shard.rawReport, shard.runStderr, shard.runStartCapture]) {
    try { const decoded = Buffer.from(field.bytesBase64, "base64"); if (decoded.toString("base64") !== field.bytesBase64 || decoded.byteLength !== field.byteLength || createHash("sha256").update(decoded).digest("hex") !== field.sha256) throw new Error(); }
    catch { context.addIssue({ code: "custom", path: ["shards"], message: "private shard bytes are not canonical base64 with the declared size and digest" }); }
  }
  for (const shard of collection.shards) {
    if (shard.publicListBytes.byteLength !== shard.listProcess.stdoutBytes || shard.publicListBytes.sha256 !== shard.listProcess.stdoutSha256
      || shard.rawReport.byteLength !== shard.runProcess.stdoutBytes || shard.rawReport.sha256 !== shard.runProcess.stdoutSha256
      || shard.runStderr.byteLength !== shard.runProcess.stderrBytes || shard.runStderr.sha256 !== shard.runProcess.stderrSha256) {
      context.addIssue({ code: "custom", path: ["shards"], message: "private raw report or public-list bytes do not match their exact process receipt" });
    }
  }
  const aggregateBytes = collection.shards.reduce((total, shard) => total + shard.publicListBytes.byteLength + shard.rawReport.byteLength
    + shard.runStderr.byteLength + shard.runStartCapture.byteLength, 0)
    + Buffer.byteLength(canonicalJson(collection.applicationCaptures)) + Buffer.byteLength(canonicalJson(collection.mockConsumptions));
  if (aggregateBytes > e2eApplicationPrivateTransferMaxBytes(Math.max(1, collection.applicationCaptures.length), collection.shards.length)) {
    context.addIssue({ code: "custom", path: [], message: "application private collection exceeds its aggregate transfer ceiling" });
  }
});
export type E2EApplicationCollection = z.infer<typeof E2EApplicationCollectionSchema>;
export type E2EApplicationMockConsumption = E2EApplicationCollection["mockConsumptions"][number];

export const E2EApplicationCollectionOracleSchema = z.object({ protocol: z.literal("e2e-application-oracle/v1"), binding: E2ERunBindingSchema, round: E2ERoundSchema,
  groupId: id(80), compiledInventoryDigest: sha, expectedShardIds: z.array(id(120)).min(1).max(3), expectedCases: z.array(E2EExpectedCaseSchema).max(64),
  expectedSupervisorReceiptRefs: z.array(E2EApplicationEvidenceRefSchema).min(1).max(32), ownedResourceInventoryDigest: sha,
  selectionPackets: z.array(selectionPacket).min(1).max(3), compiledShardConfigDigests: z.array(z.object({ shardId: id(120), configDigest: sha }).strict()).min(1).max(3),
  expectedMockComponentIdsByTarget: z.array(z.object({ targetId: id(80), componentIds: z.array(id(120)).max(32) }).strict()).max(3),
  applicationIdsByCase: z.array(z.object({ caseId: id(160), applicationId: id(120), buildManifestDigest: sha, buildSourceManifestDigest: sha,
    buildSourceArchiveSha256: sha, runtimeManifestDigest: sha, origin: origin.nullable(), targetId: id(80), platform: id(256),
    engine: z.object({ name: id(120), version: id(120), spiVersion: z.literal(1), platform: id(256), capabilities: z.array(id(120)).max(64) }).strict().nullable(),
    accountContextId: id(120), accountContextDigest: sha, assertionDigests: z.array(sha).min(1).max(20), scenario: E2EScenarioSchema }).strict()).max(64),
  preparedEnvironmentDigest: sha, originByApplicationId: z.array(z.object({ applicationId: id(120), origin }).strict()).max(12),
  fixedAssetDigestsByShard: z.array(z.object({ shardId: id(120), digests: z.record(id(256), sha) }).strict()).max(3),
  modelRoute: z.object({ routeId: id(120), routeRevision: id(120) }).strict().nullable(),
  sourceDigest: sha, environment: z.record(id(256), boundedData), usage: z.record(id(256), z.number().nonnegative()), limits: z.record(id(256), z.number().nonnegative()),
  createdAt: utc }).strict().superRefine((oracle, context) => {
    for (const [name, rows, max] of [["environment", oracle.environment, 64], ["usage", oracle.usage, 64], ["limits", oracle.limits, 64]] as const) {
      if (Object.keys(rows).length > max) context.addIssue({ code: "custom", path: [name], message: "oracle fact map exceeds its bounded key count" });
    }
    if (new Set(oracle.expectedShardIds).size !== oracle.expectedShardIds.length
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

type Environment = Readonly<{ ci: boolean; trustNoticeShown: boolean; os: string; arch: string; runtime: string }>;
export function createE2EApplicationCollectionOracleFromCompiledSuite(input: { compiled: E2ECompiledApplicationSuite; binding: E2ERunBinding; round: E2ERound;
  environment: Environment; usage: Readonly<Record<string, number>>; limits: Readonly<Record<string, number>>;
  expectedSupervisorReceiptRefs: readonly E2EApplicationEvidenceRef[]; ownedResourceInventoryDigest: string; now?: string }): E2EApplicationCollectionOracle {
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
    const runtime = runtimeRef ? input.compiled.runtimeBindings.get(runtimeRef.runtimeProfileId) : undefined;
    const target = input.compiled.runtimeAdmissionContext.launchTargets.find((item) => item.targetId === expected.targetId);
    if (!scenario || !runtimeRef || !application || !runtime || !target) throw new Error("compiled case lacks exact scenario, application, runtime, or target binding");
    const originEntry = input.compiled.originByApplicationId.find((item) => item.applicationId === runtimeRef.applicationId);
    appIds.set(expected.caseId, { caseId: expected.caseId, applicationId: runtimeRef.applicationId, buildManifestDigest: application.build.manifestDigest,
      buildSourceManifestDigest: application.buildSource.manifest.manifestDigest, buildSourceArchiveSha256: application.buildSource.reference.sha256,
      runtimeManifestDigest: runtime.manifestDigest, origin: originEntry?.origin ?? null,
      targetId: expected.targetId, platform: target.engine?.platform ?? "api", engine: target.engine ? { name: target.engine.name, version: target.engine.version, spiVersion: 1, platform: target.engine.platform, capabilities: target.engine.capabilities } : null,
      accountContextId: expected.accountContextId, accountContextDigest: expected.accountContextDigest, assertionDigests: [...expected.assertionDigests], scenario });
  }
  const body = E2EApplicationCollectionOracleSchema.parse({ protocol: "e2e-application-oracle/v1", binding, round, groupId: group.groupId,
    compiledInventoryDigest: input.compiled.inventory.digest, expectedShardIds: input.compiled.shards.map((item) => item.shardId), expectedCases: input.compiled.expectedCases,
    expectedSupervisorReceiptRefs, ownedResourceInventoryDigest: input.ownedResourceInventoryDigest,
    selectionPackets: input.compiled.shards.map((item) => item.selection), compiledShardConfigDigests: input.compiled.shards.map((item) => ({ shardId: item.shardId, configDigest: item.expectedConfigDigest })),
    expectedMockComponentIdsByTarget: [...new Set(input.compiled.shards.map((item) => item.targetId))].map((targetId) => ({ targetId,
      componentIds: input.compiled.group.mocks.filter((mock) => mock.requestedTargetId === targetId && mock.effectiveTargetId === targetId).map((mock) => mock.componentId).sort() })),
    applicationIdsByCase: [...appIds.values()],
    preparedEnvironmentDigest: input.compiled.preparedEnvironmentDigest, originByApplicationId: input.compiled.originByApplicationId,
    fixedAssetDigestsByShard: input.compiled.shards.map((item) => ({ shardId: item.shardId, digests: { compilerInventory: item.inventory.digest } })),
    modelRoute: input.compiled.runtimeAdmissionContext.modelRoute, sourceDigest: input.compiled.runtimeAdmission.sourceSnapshotDigest,
    environment: input.environment, usage: input.usage, limits: input.limits, createdAt: input.now ?? new Date().toISOString() });
  if (body.groupId !== binding.groupId || canonicalJson(body.expectedCases) !== canonicalJson(binding.expectedCases)
    || canonicalJson(body.expectedShardIds) !== canonicalJson(expectedShardIds)
    || canonicalJson(body.compiledShardConfigDigests.map((item) => item.shardId).sort()) !== canonicalJson(expectedShardIds)) {
    throw new Error("application oracle does not cover the exact group binding and shard inventory");
  }
  return body;
}

export type E2EApplicationCollectionResult = Readonly<{ collection: E2EApplicationCollection | null; oracle: E2EApplicationCollectionOracle | null;
  qualification: E2EStructuralQualification | null; unavailableReason: string | null }>;
export function collectE2EApplicationRun(input: { actual: unknown; compiled: E2ECompiledApplicationSuite; binding: E2ERunBinding; round: E2ERound;
  environment: Environment; usage: Readonly<Record<string, number>>; limits: Readonly<Record<string, number>>;
  expectedSupervisorReceiptRefs: readonly E2EApplicationEvidenceRef[]; ownedResourceInventoryDigest: string }): E2EApplicationCollectionResult {
  try {
    const collection = E2EApplicationCollectionSchema.parse(input.actual);
    const oracle = createE2EApplicationCollectionOracleFromCompiledSuite(input);
    const qualification = qualifyE2EApplicationCollection(oracle, collection);
    return { collection, oracle, qualification, unavailableReason: qualification.status === "UNKNOWN" ? qualification.reason : null };
  } catch (error) { return { collection: null, oracle: null, qualification: null, unavailableReason: error instanceof Error ? error.message : "application collection unavailable" }; }
}

export function qualifyE2EApplicationCollection(oracleInput: E2EApplicationCollectionOracle, collectionInput: E2EApplicationCollection): E2EStructuralQualification {
  const unknown = (reason: string, runId: string | null = null, reportHash: string | null = null): E2EStructuralQualification => ({ status: "UNKNOWN", reason, runId, rawReportSha256: reportHash, result: null });
  try {
    const oracle = E2EApplicationCollectionOracleSchema.parse(copyBoundedE2EJsonData(oracleInput, { maxBytes: 8 * 1024 * 1024, maxDepth: 64 }));
    const collection = E2EApplicationCollectionSchema.parse(copyBoundedE2EJsonData(collectionInput, { maxBytes: e2eApplicationPrivateTransferMaxBytes(oracle.expectedCases.length, oracle.expectedShardIds.length), maxDepth: 64 }));
    if (collection.cleanup !== "confirmed") return unknown("application owned cleanup is not confirmed", oracle.binding.runId);
    if (canonicalJson(collection.shards.map((item) => item.shardId).sort()) !== canonicalJson([...oracle.expectedShardIds].sort())) return unknown("application collection omits or adds a compiled shard", oracle.binding.runId);
    const caseById = new Map(oracle.expectedCases.map((item) => [item.caseId, item]));
    const captures = new Map(collection.applicationCaptures.map((item) => [item.caseId, item]));
    if (captures.size !== caseById.size || [...captures.keys()].some((caseId) => !caseById.has(caseId))) return unknown("application capture inventory differs from the complete admitted case set", oracle.binding.runId);
    const declaredMocks = [...new Set(oracle.expectedMockComponentIdsByTarget.flatMap((item) => item.componentIds))].sort();
    if (canonicalJson([...collection.declaredMockComponentIds].sort()) !== canonicalJson(declaredMocks)
      || new Set(collection.declaredMockComponentIds).size !== collection.declaredMockComponentIds.length) return unknown("declared application mock inventory differs from the compiled group", oracle.binding.runId);
    const reportByCase = new Map<string, { status: string; runId: string; shardId: string; failureObserved: boolean; processStartedAt: string; processFinishedAt: string }>();
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
      if (!startBytes.equals(Buffer.from(`${JSON.stringify(shard.runStart)}\n`))
        || canonicalJson(publicListFromBytes) !== canonicalJson(shard.publicList)
        || canonicalJson(capturedStart) !== canonicalJson(shard.runStart) || shard.runStart.challenge !== shard.launchId
        || shard.runStart.runId !== parsed.report.run.id || shard.runProcess.status !== parsed.report.run.exitCode
        || Date.parse(shard.runProcess.startedAt) > processFinishedAt || Date.parse(shard.listProcess.startedAt) > listFinishedAt
        || shard.runProcess.timedOut || shard.runProcess.aborted || shard.listProcess.status !== 0 || shard.listProcess.timedOut || shard.listProcess.aborted
        || Date.parse(shard.runProcess.finishedAt) > Date.parse(oracle.round.deadlineAt)
        || listFinishedAt > processStartedAt || processStartedAt > startEventAt || startEventAt > reportStartedAt
        || reportStartedAt > reportFinishedAt || reportFinishedAt > processFinishedAt
        || parsed.report.run.project.configDigest !== expectedConfig.configDigest) return unknown("application report does not bind to actual process, config, challenge, deadline, and run-start evidence", oracle.binding.runId, parsed.rawSha256);
      const expectedTarget = oracle.applicationIdsByCase.find((item) => item.targetId === expectedPacket.targetId);
      const reportTarget = parsed.report.run.targets.find((item) => item.id === expectedPacket.targetId);
      if (!expectedTarget || !reportTarget || reportTarget.platform !== expectedTarget.platform || (expectedTarget.engine === null
        ? reportTarget.engine.name !== "none" || reportTarget.engine.version !== "unversioned" || reportTarget.engine.spiVersion !== 1
          || reportTarget.capabilities.length !== 0 || reportTarget.artifactCapabilities.length !== 0 || reportTarget.stateCapability
        : reportTarget.engine?.name !== expectedTarget.engine.name || reportTarget.engine.version !== expectedTarget.engine.version
          || reportTarget.engine.spiVersion !== expectedTarget.engine.spiVersion || reportTarget.platform !== expectedTarget.engine.platform
          || canonicalJson([...reportTarget.capabilities].sort()) !== canonicalJson([...expectedTarget.engine.capabilities].sort()))) {
        return unknown("application report target engine, platform, or capabilities differ from the immutable runtime oracle", oracle.binding.runId, parsed.rawSha256);
      }
      const targetOrigin = oracle.originByApplicationId.find((item) => item.applicationId === expectedTarget.applicationId)?.origin;
      const reportOriginMatches = expectedTarget.engine === null
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
      if (rows.length !== expectedPacket.tuples.length || rows.some((row) => !expectedPacket.tuples.some((item) => item.upstreamResultId === row.id && item.upstreamTestId === row.testId && item.targetId === row.targetId && item.platform === row.platform))) return unknown("application report rows differ from the exact shard packet", oracle.binding.runId, parsed.rawSha256);
      for (const tuple of expectedPacket.tuples.filter((item) => item.disposition === "run")) {
        const row = rows.find((item) => item.id === tuple.upstreamResultId);
        if (!row || row.attempts.length !== 1 || row.repeat !== 0 || !["passed", "failed"].includes(row.status)
          || row.attempts[0]?.status !== row.status) return unknown("application report is flaky, incomplete, skipped, or not a clean first attempt", oracle.binding.runId, parsed.rawSha256);
        if (reportByCase.has(tuple.caseId)) return unknown("application case is duplicated across same-platform shard reports", oracle.binding.runId, parsed.rawSha256);
        reportByCase.set(tuple.caseId, { status: row.status, runId: parsed.report.run.id, shardId: shard.shardId,
          failureObserved: row.status === "failed" && row.attempts[0].steps.some((step) => step.status === "failed"),
          processStartedAt: shard.runProcess.startedAt, processFinishedAt: shard.runProcess.finishedAt });
      }
      if (selectedIds.length !== expectedPacket.tuples.filter((item) => item.disposition === "run").length) return unknown("application selection packet is incomplete", oracle.binding.runId, parsed.rawSha256);
    }
    const normalizedCases = oracle.expectedCases.map((expected) => {
      const capture = captures.get(expected.caseId)!;
      const facts = oracle.applicationIdsByCase.find((item) => item.caseId === expected.caseId)!;
      const caseIsBound = capture.runId === oracle.binding.runId && capture.roundId === oracle.binding.roundId && capture.groupId === oracle.binding.groupId
        && capture.candidateDigest === oracle.binding.candidateDigest && capture.executionDescriptorDigest === expected.executionDescriptorDigest
        && capture.accountContextId === expected.accountContextId && capture.accountContextDigest === expected.accountContextDigest
        && capture.applicationId === facts.applicationId && capture.buildManifestDigest === facts.buildManifestDigest && capture.runtimeManifestDigest === facts.runtimeManifestDigest
        && capture.producer.operationId === oracle.binding.operationId && capture.producer.operationFence === oracle.binding.operationFence
        && capture.producer.runtimeManifestDigest === facts.runtimeManifestDigest && capture.lifecycleId === capture.producer.lifecycleId;
      const report = reportByCase.get(expected.caseId);
      const failedHere = capture.assertions.some((item) => item.outcome === "failed");
      const withinProcess = (value: string) => report !== undefined && Date.parse(value) >= Date.parse(report.processStartedAt)
        && Date.parse(value) <= Date.parse(report.processFinishedAt);
      if (!caseIsBound || !report || capture.shardId !== report.shardId || capture.upstreamRunId !== report.runId
        || capture.cleanup !== "confirmed" || capture.assertions.length !== expected.assertionDigests.length
        || !withinProcess(capture.observedAt) || capture.steps.some((item) => !withinProcess(item.at))
        || capture.assertions.some((item, index) => item.index !== index || item.digest !== expected.assertionDigests[index] || !withinProcess(item.observedAt))) {
        throw new Error("application capture changed its case, producer, build, runtime, account, time, or assertion identity");
      }
      if (failedHere !== (report.status === "failed")) throw new Error("actual application assertion capture conflicts with the upstream report verdict");
      if (failedHere && !report.failureObserved) throw new Error("failed application assertion has no matching failed step in the original upstream report");
      const failed = failedHere;
      const allPassed = capture.assertions.every((item) => item.outcome === "passed" && item.observationId !== null);
      const stepsObserved = scenarioActionsMatch(facts.scenario, capture);
      const expectedMocks = oracle.binding.executionMode === "real-runtime" || oracle.binding.executionMode === "hybrid"
        ? (oracle.expectedMockComponentIdsByTarget.find((item) => item.targetId === expected.targetId)?.componentIds ?? []) : [];
      const caseConsumptions = collection.mockConsumptions.filter((item) => item.caseId === expected.caseId);
      const observedMocks = caseConsumptions.filter((item) => item.runId === capture.runId && item.mockManifestDigest === oracle.binding.mockManifestDigest
        && item.lifecycleId === capture.lifecycleId && item.producer.lifecycleId === capture.lifecycleId
        && item.producer.operationId === oracle.binding.operationId && item.producer.operationFence === oracle.binding.operationFence
        && item.producer.runtimeManifestDigest === facts.runtimeManifestDigest).map((item) => item.componentId);
      const mocksConsumed = expectedMocks.every((componentId) => observedMocks.includes(componentId))
        && observedMocks.every((componentId) => expectedMocks.includes(componentId))
        && caseConsumptions.every((item) => expectedMocks.includes(item.componentId) && item.mockManifestDigest === oracle.binding.mockManifestDigest
          && item.runId === capture.runId && item.lifecycleId === capture.lifecycleId && item.producer.lifecycleId === capture.lifecycleId
          && item.producer.operationId === oracle.binding.operationId && item.producer.operationFence === oracle.binding.operationFence
          && item.producer.runtimeManifestDigest === facts.runtimeManifestDigest)
        && new Set(observedMocks).size === observedMocks.length
        && (expectedMocks.length === 0 || canonicalJson([...capture.coverage.mockedComponentIds].sort()) === canonicalJson([...expectedMocks].sort()));
      const assertionsAreObserved = scenarioAssertionsMatch(facts.scenario, capture);
      const modelDependent = facts.scenario.steps.some((item) => item.kind === "agent");
      // Model receipts live in the authenticated private transport. The structural packet has no such proof,
      // so a model-driven case remains unavailable until T8 recollects it.
      const modelBound = !modelDependent;
      const scopeRank = { source: 0, "mock-contract": 1, runtime: 2, "external-live": 3 } as const;
      const evidenceFloor = scopeRank[capture.coverage.observedScope] >= scopeRank[expected.minimumEvidence]
        && expected.requiredRealComponentIds.every((componentId) => capture.coverage.realComponentIds.includes(componentId))
        && (expected.minimumEvidence !== "external-live" || capture.coverage.observedScope === "external-live");
      const hasIncompleteTerminal = capture.assertions.some((item) => item.outcome === "unavailable");
      const ownedOrigin = oracle.originByApplicationId.find((item) => item.applicationId === facts.applicationId)?.origin;
      const expectedSubjectKind = facts.platform === "web" ? "browser" : facts.platform === "api" ? "service"
        : facts.platform === "android" || facts.platform === "ios" ? "mobile" : "desktop";
      const subjectBound = capture.subject.kind === expectedSubjectKind && (capture.subject.kind === "service" ? capture.subject.origin === ownedOrigin
        : capture.subject.kind === "mobile" ? capture.subject.installedArtifactSha256 === facts.buildManifestDigest : true);
      const status = failed ? "failed" : allPassed && stepsObserved && mocksConsumed && assertionsAreObserved && modelBound && evidenceFloor && subjectBound && !hasIncompleteTerminal ? "passed" : "unavailable";
      const assertionReceipts = expected.assertionDigests.map((digest, index) => ({ assertionIndex: index, assertionDigest: digest,
        status: capture.assertions[index]?.outcome === "passed" ? "passed" as const : capture.assertions[index]?.outcome === "failed" ? "failed" as const : "unavailable" as const,
        reason: capture.assertions[index]?.reason ?? "assertion was not observed" }));
      const coverage: E2ECaseCoverage = { ...capture.coverage, observedScope: status === "passed" ? capture.coverage.observedScope : "source", subject: "candidate",
        observedMockedComponentIds: [...new Set(observedMocks)].sort() };
      return { caseId: expected.caseId, executionDescriptorDigest: expected.executionDescriptorDigest, accountContextId: expected.accountContextId,
        accountContextDigest: expected.accountContextDigest, status, reason: status === "passed" ? "structural-application-observations-complete" : status === "failed" ? "observed-application-assertion-failure" : "application-evidence-floor-unmet",
        attemptCount: 1, assertionDigest: expected.assertionDigest, assertionReceipts, artifacts: [], coverage };
    });
    const anyFailed = normalizedCases.some((item) => item.status === "failed"); const allPassed = normalizedCases.every((item) => item.status === "passed");
    const hashes = collection.shards.map((shard) => ({ shardId: shard.shardId, sha256: shard.rawReport.sha256 })).sort((a, b) => a.shardId.localeCompare(b.shardId));
    const reportHash = hashes.length === 1 ? hashes[0]!.sha256 : createHash("sha256").update(canonicalJson(hashes)).digest("hex");
    const result = E2EQualifiedResultSchema.parse({ schemaVersion: 1, binding: oracle.binding, producer: "structural-application-report-adapter",
      startedAt: collection.shards.map((item) => item.runProcess.startedAt).sort()[0], finishedAt: collection.shards.map((item) => item.runProcess.finishedAt).sort().at(-1),
      receivedAt: collection.receivedAt, status: anyFailed ? "failed" : allPassed ? "passed" : "unavailable", qualification: "exploratory", executionMode: oracle.binding.executionMode,
      reason: anyFailed ? "observed-application-test-failure" : allPassed ? "structural-application-observations-complete" : "application-evidence-floor-unmet",
      cases: normalizedCases, rawReportSha256: reportHash, modelReceiptIds: [], cleanup: collection.cleanup });
    return { status: anyFailed ? "FAILED" : allPassed ? "PASS" : "UNKNOWN", reason: "structural application observations remain exploratory pending independent producer authentication", runId: oracle.binding.runId, rawReportSha256: reportHash, result };
  } catch (error) { return unknown(error instanceof Error ? error.message : "application collection unavailable", oracleInput?.binding?.runId ?? null); }
}

function scenarioAssertionsMatch(scenarioInput: unknown, capture: E2EApplicationCaseCapture): boolean {
  if (!scenarioInput || typeof scenarioInput !== "object" || !Array.isArray((scenarioInput as Record<string, unknown>).assertions)) return false;
  const assertions = (scenarioInput as { assertions: unknown[] }).assertions;
  if (assertions.length !== capture.assertions.length) return false;
  const equals = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
  return assertions.every((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const assertion = raw as Record<string, unknown>;
    const observed = capture.assertions[index]!;
    if (observed.outcome !== "passed" || observed.observationId === null) return false;
    switch (assertion.kind) {
      case "text": case "visible": case "http-status": return observed.value === assertion.equals && observed.evidenceRef !== null;
      case "csv": return observed.evidenceRef !== null && observed.value !== null && typeof observed.value === "object" && !Array.isArray(observed.value)
        && equals(observed.value, { columns: assertion.columns, rows: assertion.rows, downloadName: assertion.downloadName });
      case "json": case "state": return equals(observed.value, assertion.equals) && observed.evidenceRef !== null;
      case "file": return observed.evidenceRef?.sha256 === assertion.sha256;
      default: return false;
    }
  });
}

function scenarioActionsMatch(scenarioInput: unknown, capture: E2EApplicationCaseCapture): boolean {
  if (!scenarioInput || typeof scenarioInput !== "object" || !Array.isArray((scenarioInput as Record<string, unknown>).steps)) return false;
  const steps = (scenarioInput as { steps: unknown[] }).steps;
  if (capture.steps.length === 0 || capture.steps.some((item) => {
    const approved = steps[item.declaredStepIndex];
    return !approved || typeof approved !== "object" || Array.isArray(approved)
      || (approved as Record<string, unknown>).kind !== item.kind
      || item.actionDigest !== createHash("sha256").update(canonicalJson(approved)).digest("hex")
      || item.outcome !== "completed" || item.observationId === null;
  })) return false;
  return steps.every((_, index) => capture.steps.some((item) => item.declaredStepIndex === index));
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
