// The three uploads a coding run makes besides its result, on the document store and object storage: the committed source of the candidate (`candidate-export`), the build source manifest
// that describes it (`candidate-build-source`), and the unchanged code for the baseline round (`baseline-source`). They feed the browser and API checks. Each is judged here against
// the committed tree and kept under its content address; nothing the worker says about itself is taken as true.
//
// Everything the hosted product checks is checked here: the operation (a running coding run), its fence, chunk order and digests, the size bounds, the manifest against the tree it names,
// and a repeated request answering the same as the first. The stored keys are the hosted product's. The one thing that differs is how the operation's row says what it recorded: the row is
// changed with a condition on its own fields in the same transaction as the upload's row, as before.
import { z } from "zod";
import {
  CandidateManifestSchema, E2E_APPLICATION_BUILD_SOURCE_MANIFEST_MAX_BYTES, agentXError, canonicalJson, change, createCandidateManifest, verifyE2ESourceSnapshot, when,
  type DocumentKey, type JsonValue, type TransactItem,
} from "@agentx/contracts";
import { BaselineSourceBodySchema, BaselineSourceWireSchema, StoredBaselineSourceSchema, assessBaselineSource, type StoredBaselineSource } from "../../aws/baseline-source.js";
import { CandidateBuildSourceBodySchema, StoredCandidateBuildSourceSchema, assessCandidateBuildSource, type StoredCandidateBuildSource } from "../../aws/candidate-build-source.js";
import { operationKey } from "../task-flow/keys.js";
import {
  MAX_CANDIDATE_EXPORT_BYTES, SourceTooLargeError, UPLOAD_CHUNK_BYTES, acceptChunk, assembleUpload, dropChunks, isLiveOperation, openUpload, parseUploadBody, putOnce, requireCurrentUpload, sha256Of, uploadRowKey, whenOperationLive,
  type UploadOperation, type UploadSpec, type UploadStores,
} from "./uploads-chunks.js";

const SHA256 = z.string().regex(/^[a-f0-9]{64}$/);
const SHA1 = z.string().regex(/^[a-f0-9]{40}$/);
const AGGREGATE_SOURCE_BYTES = 4 * 1024 * 1024;

/** The one sentence a planning run's failed export of the unchanged code is stored as (the grounding record reads it as `not-exported`). */
export const GROUNDING_SOURCE_REFUSED_REASON = "the unchanged code's build source was refused for the plan";
export const GROUNDING_SOURCE_NOT_EXPORTED_REASON = "the worker could not export the unchanged code for the plan";

/** The committed source of a candidate as a worker uploads it: the tree inventory and the safe blobs, per repository. */
export function workflowCandidateSourceExportSchema() {
  return z.object({ schemaVersion: z.literal("workflow-candidate-source/v1"), candidate: CandidateManifestSchema,
    repositories: z.array(z.object({ repositoryId: z.string().min(1).max(200), commitSha: SHA1, treeSha: SHA1, baseCommitSha: SHA1.optional(), treeComplete: z.literal(true),
      treePaths: z.array(z.string().min(1).max(1024)).max(100_000),
      sources: z.array(z.object({ path: z.string().min(1).max(1024), sha256: SHA256, bytesBase64: z.string().max(700_000), kind: z.literal("blob") }).strict()).max(512),
    }).strict()).max(32),
  }).strict();
}
export type CandidateSourceExport = z.infer<ReturnType<typeof workflowCandidateSourceExportSchema>>;

/** Where a candidate's committed source is kept: content addressed, so the same code is the same object. */
export const candidateSourceObjectKey = (sha256: string): string => `workflow-candidate-sources/sha256/${sha256}.json`;

const exportBodySchema = z.discriminatedUnion("stage", [
  z.object({ stage: z.literal("init"), schemaVersion: z.literal("workflow-candidate-export-upload/v1"), totalBytes: z.number().int().positive().max(MAX_CANDIDATE_EXPORT_BYTES),
    chunkCount: z.number().int().positive().max(Math.ceil(MAX_CANDIDATE_EXPORT_BYTES / UPLOAD_CHUNK_BYTES)), sha256: SHA256 }).strict(),
  z.object({ stage: z.literal("chunk"), schemaVersion: z.literal("workflow-candidate-export-chunk/v1"), uploadId: z.string().uuid(), index: z.number().int().nonnegative(),
    bytesBase64: z.string().min(1).max(Math.ceil(UPLOAD_CHUNK_BYTES * 4 / 3) + 8), sha256: SHA256 }).strict(),
  z.object({ stage: z.literal("finalize"), schemaVersion: z.literal("workflow-candidate-export-finalize/v1"), uploadId: z.string().uuid(), sha256: SHA256 }).strict(),
]);

const exportSpec = (operation: UploadOperation): UploadSpec => ({
  label: "candidate source", entityType: "WORKFLOW_CANDIDATE_EXPORT", rowKey: exportRowKey(operation),
  stagingKey: (uploadId, index) => `workflow-candidate-staging/${operation.workspaceId}/${operation.id}/${uploadId}/${index}.chunk`,
});
const exportRowKey = (operation: Pick<UploadOperation, "workspaceId" | "id">): DocumentKey => uploadRowKey(operation.workspaceId, "CANDIDATE_EXPORT", operation.id);

/** A stored source reference, as the operation row and the export row carry it. */
export interface CandidateSourceRef { key: string; sha256: string; byteLength: number; candidateDigest: string }

/** The committed source a reference names, read back and held to its size and digest; undefined when it is missing or is not what the reference says. */
export async function readCandidateSourceExport(stores: Pick<UploadStores, "objects">, reference: CandidateSourceRef): Promise<CandidateSourceExport | undefined> {
  if (reference.byteLength <= 0 || reference.byteLength > MAX_CANDIDATE_EXPORT_BYTES || !/^[a-f0-9]{64}$/.test(reference.sha256)) return undefined;
  const found = await stores.objects.get(reference.key, MAX_CANDIDATE_EXPORT_BYTES);
  if (found === undefined) return undefined;
  const bytes = Buffer.from(found);
  if (bytes.byteLength !== reference.byteLength || sha256Of(bytes) !== reference.sha256) return undefined;
  let json: unknown;
  try { json = JSON.parse(bytes.toString("utf8")); } catch { return undefined; }
  const parsed = workflowCandidateSourceExportSchema().safeParse(json);
  return parsed.success ? parsed.data : undefined;
}

/** The code of a committed source this install's object storage could not hold, as the coding run's row records it. */
export const SOURCE_TOO_LARGE_CODE = "too-large";
/** What the owner reads when the checks need the code and it was too big to keep: one fixed sentence, never built from the upload. */
export const SOURCE_TOO_LARGE_BLOCK_REASON = "The code is too big to keep for the browser and API checks on this install's object storage. Name the folder object storage (see docs/local.md) and Retry.";
const SOURCE_TOO_LARGE_ANSWER = { accepted: false, reason: SOURCE_TOO_LARGE_CODE } as const;

const forbiddenMode = (what: string): never => { throw agentXError("CALLBACK_FORBIDDEN", what); };

/**
 * One request of the candidate's committed source upload. Finalize checks the whole against the candidate manifest it carries (the digest of its repositories, each repository's commit and
 * tree, and every blob against the tree inventory), keeps it under its content address and records its reference on the operation, once.
 */
export async function handleCandidateExport(stores: UploadStores, operation: UploadOperation, rawBody: unknown): Promise<Record<string, JsonValue>> {
  if (operation.kind !== "task" || operation.workflowMode !== "IMPLEMENT" || !isLiveOperation(operation.status)) forbiddenMode("candidate source export is limited to the current implementation operation");
  const body = parseUploadBody(exportBodySchema, rawBody, "candidate source upload");
  const spec = exportSpec(operation);
  if (body.stage === "init") return openUpload(stores, operation, spec, body);
  const upload = requireCurrentUpload(await stores.store.get(spec.rowKey), operation, spec);
  const ref = operation.candidateSourceRef as CandidateSourceRef | undefined;
  if (body.stage === "finalize" && upload["status"] === "COMPLETE" && upload["uploadId"] === body.uploadId && upload["sha256"] === body.sha256 && ref !== undefined && typeof ref.key === "string") {
    return { sourceRef: ref as unknown as JsonValue, duplicate: true };
  }
  if (body.stage === "finalize" && upload["status"] === "REFUSED" && upload["uploadId"] === body.uploadId && upload["sha256"] === body.sha256) return { ...SOURCE_TOO_LARGE_ANSWER, duplicate: true };
  if (upload["status"] !== "OPEN") throw agentXError("STALE_FENCE", "candidate source export is no longer open");
  if (body.stage === "chunk") return acceptChunk(stores, operation, spec, upload, body);
  const { bytes, chunkKeys } = await assembleUpload(stores, spec, upload, body);
  // Whatever fails from here on, the bytes the worker staged are not kept: they were judged, and a retry uploads them again.
  try {
    return await finalizeCandidateExport(stores, operation, spec, body, bytes, chunkKeys);
  } catch (error) {
    await dropChunks(stores, chunkKeys);
    throw error;
  }
}

async function finalizeCandidateExport(stores: UploadStores, operation: UploadOperation, spec: UploadSpec, body: { uploadId: string; sha256: string }, bytes: Buffer, chunkKeys: readonly string[]): Promise<Record<string, JsonValue>> {
  let parsed: CandidateSourceExport;
  try { parsed = workflowCandidateSourceExportSchema().parse(JSON.parse(bytes.toString("utf8")) as unknown); }
  catch { throw agentXError("CONFIG_INVALID", "candidate source export is malformed or outside its immutable bounds"); }
  const manifest = CandidateManifestSchema.safeParse(parsed.candidate);
  if (!manifest.success || createCandidateManifest(manifest.data.repositories).digest !== manifest.data.digest || manifest.data.repositories.length !== parsed.repositories.length) {
    throw agentXError("CONFIG_INVALID", "candidate source export manifest is invalid");
  }
  let sourceBytes = 0;
  for (const [index, repository] of parsed.repositories.entries()) {
    const identity = manifest.data.repositories[index];
    if (!identity || identity.repositoryId !== repository.repositoryId || identity.commitSha !== repository.commitSha || identity.treeSha !== repository.treeSha
      || identity.baseCommitSha !== repository.baseCommitSha) throw agentXError("CONFIG_INVALID", "candidate source repository differs from its immutable manifest");
    const single = createCandidateManifest([identity]);
    const sources = repository.sources.map((source) => {
      const decoded = Buffer.from(source.bytesBase64, "base64");
      if (decoded.toString("base64") !== source.bytesBase64) throw agentXError("CONFIG_INVALID", "candidate source blob encoding is invalid");
      sourceBytes += decoded.byteLength;
      if (sourceBytes > AGGREGATE_SOURCE_BYTES) throw agentXError("CONFIG_INVALID", "candidate source blobs exceed their aggregate bound");
      return { path: source.path, sha256: source.sha256, bytes: decoded, kind: "blob" as const };
    });
    try {
      verifyE2ESourceSnapshot({ candidate: single, commitSha: repository.commitSha, treeSha: repository.treeSha, treeComplete: repository.treeComplete, treePaths: repository.treePaths, sources }, single);
    } catch { throw agentXError("CONFIG_INVALID", "candidate source bytes do not match their committed tree inventory"); }
  }
  const candidateDigest = manifest.data.digest;
  const sourceRef: CandidateSourceRef = { key: candidateSourceObjectKey(body.sha256), sha256: body.sha256, byteLength: bytes.byteLength, candidateDigest };
  try {
    await putOnce(stores, sourceRef.key, bytes, { sha256: body.sha256, candidate: candidateDigest, operation: operation.id }, MAX_CANDIDATE_EXPORT_BYTES, "candidate source");
  } catch (error) {
    if (!(error instanceof SourceTooLargeError)) throw error;
    // The code is judged and good but this install cannot keep it: the run's result is not held up for it. The row says so, and the checks that need the code block with a fixed sentence.
    const refused = await stores.store.transact([
      { kind: "update", key: spec.rowKey, ops: [change.set("status", "REFUSED"), change.set("refusedReason", SOURCE_TOO_LARGE_CODE)],
        condition: when.and(when.eq("status", "OPEN"), when.eq("uploadId", body.uploadId), when.eq("sha256", body.sha256), when.eq("operationId", operation.id), when.eq("fence", operation.fence)) },
      { kind: "update", key: operationKey(operation.workspaceId, operation.id), ops: [change.set("candidateSourceRefused", SOURCE_TOO_LARGE_CODE)],
        condition: when.and(whenOperationLive(), when.eq("fence", operation.fence), when.eq("workflowMode", "IMPLEMENT"), when.notExists("candidateSourceRef"), when.notExists("candidateSourceRefused")) },
    ]);
    if (!refused.applied) throw agentXError("STALE_FENCE", "candidate source export can no longer be recorded for this operation");
    await dropChunks(stores, chunkKeys);
    return { ...SOURCE_TOO_LARGE_ANSWER };
  }
  const closed = await stores.store.transact([
    { kind: "update", key: spec.rowKey, ops: [change.set("status", "COMPLETE"), change.set("sourceRef", sourceRef as unknown as JsonValue)],
      condition: when.and(when.eq("status", "OPEN"), when.eq("uploadId", body.uploadId), when.eq("sha256", body.sha256), when.eq("operationId", operation.id), when.eq("fence", operation.fence)) },
    { kind: "update", key: operationKey(operation.workspaceId, operation.id), ops: [change.set("candidateSourceRef", sourceRef as unknown as JsonValue)],
      condition: when.and(whenOperationLive(), when.eq("fence", operation.fence), when.eq("workflowMode", "IMPLEMENT"), when.notExists("candidateSourceRef")) },
  ]);
  if (!closed.applied) throw agentXError("STALE_FENCE", "candidate source export can no longer be recorded for this operation");
  await dropChunks(stores, chunkKeys);
  return { sourceRef: sourceRef as unknown as JsonValue };
}

// ---- the build source manifest of the candidate

const buildSourceSpec = (operation: UploadOperation): UploadSpec => ({
  label: "candidate build source", entityType: "WORKFLOW_CANDIDATE_BUILD_SOURCE", rowKey: uploadRowKey(operation.workspaceId, "CANDIDATE_BUILD_SOURCE", operation.id),
  stagingKey: (uploadId, index) => `workflow-candidate-build-source-staging/${operation.workspaceId}/${operation.id}/${uploadId}/${index}.chunk`,
});

/**
 * The manifest a worker computed for the candidate it just exported. It follows a finalized export and is judged against it: it is recorded as READY (stored under its content address) or
 * REFUSED with the reason, on the export's row and on the coding operation. A refusal is a successful answer, never an error: the checks that need a build later say why they cannot run.
 */
export async function handleCandidateBuildSource(stores: UploadStores, operation: UploadOperation, rawBody: unknown): Promise<Record<string, JsonValue>> {
  if (operation.kind !== "task" || operation.workflowMode !== "IMPLEMENT" || !isLiveOperation(operation.status)) forbiddenMode("candidate build source export is limited to the current implementation operation");
  const body = parseUploadBody(CandidateBuildSourceBodySchema, rawBody, "candidate build source upload");
  const sourceRef = operation.candidateSourceRef as CandidateSourceRef | undefined;
  if (sourceRef === undefined) throw agentXError("STALE_FENCE", "the candidate build source follows a finalized candidate source export");
  const spec = buildSourceSpec(operation);
  const exportKey = exportRowKey(operation);
  const opKey = operationKey(operation.workspaceId, operation.id);
  /** Records `stored` once. `closing` closes the upload row in the same transaction: COMPLETE for the upload that carried it, ABORTED for one the worker abandoned. A lost race is answered from what won. */
  const record = async (stored: StoredCandidateBuildSource, closing?: { uploadId: string; sha256: string; status: "COMPLETE" | "ABORTED" }): Promise<Record<string, JsonValue>> => {
    const items: TransactItem[] = [
      ...(closing === undefined ? [] : [{ kind: "update" as const, key: spec.rowKey,
        ops: closing.status === "COMPLETE" ? [change.set("status", "COMPLETE"), change.set("buildSource", stored)] : [change.set("status", "ABORTED")],
        condition: when.and(when.eq("status", "OPEN"), when.eq("uploadId", closing.uploadId), when.eq("sha256", closing.sha256), when.eq("operationId", operation.id), when.eq("fence", operation.fence)) }]),
      { kind: "update", key: exportKey, ops: [change.set("buildSource", stored)],
        condition: when.and(when.eq("entityType", "WORKFLOW_CANDIDATE_EXPORT"), when.eq("status", "COMPLETE"), when.eq("operationId", operation.id), when.eq("fence", operation.fence), when.notExists("buildSource")) },
      { kind: "update", key: opKey, ops: [change.set("candidateBuildSource", stored)],
        condition: when.and(whenOperationLive(), when.eq("fence", operation.fence), when.eq("workflowMode", "IMPLEMENT"), when.exists("candidateSourceRef"), when.notExists("candidateBuildSource")) },
    ];
    const done = await stores.store.transact(items);
    if (!done.applied) {
      const winner = StoredCandidateBuildSourceSchema.safeParse((await stores.store.get(opKey))?.["candidateBuildSource"]);
      if (!winner.success) throw agentXError("STALE_FENCE", "candidate build source can no longer be recorded for this operation");
      if (canonicalJson(winner.data) !== canonicalJson(stored)) throw agentXError("CALLBACK_FORBIDDEN", "this implementation already recorded a different build source");
      return { accepted: stored.status === "READY", buildSource: stored as unknown as JsonValue, duplicate: true };
    }
    return { accepted: stored.status === "READY", buildSource: stored as unknown as JsonValue };
  };
  const already = StoredCandidateBuildSourceSchema.safeParse(operation.candidateBuildSource);
  if (body.stage === "unavailable") {
    const stored: StoredCandidateBuildSource = { status: "REFUSED", reason: `the worker could not export a build source manifest: ${body.reason}`.slice(0, 600), candidateDigest: sourceRef.candidateDigest };
    if (already.success) {
      if (canonicalJson(already.data) !== canonicalJson(stored)) throw agentXError("CALLBACK_FORBIDDEN", "this implementation already recorded a different build source");
      return { accepted: false, buildSource: stored as unknown as JsonValue, duplicate: true };
    }
    // An upload the worker started and then abandoned is closed with the answer, and what it staged is deleted.
    const abandoned = await stores.store.get(spec.rowKey);
    if (abandoned?.["entityType"] === spec.entityType && abandoned["status"] === "OPEN" && typeof abandoned["uploadId"] === "string" && typeof abandoned["sha256"] === "string") {
      const abandonedId = abandoned["uploadId"];
      const answer = await record(stored, { uploadId: abandonedId, sha256: abandoned["sha256"], status: "ABORTED" });
      const staged = Array.from({ length: Number(abandoned["chunkCount"]) }, (_, index) => spec.stagingKey(abandonedId, index));
      await dropChunks(stores, staged);
      return answer;
    }
    return record(stored);
  }
  const existing = await stores.store.get(spec.rowKey);
  if (body.stage === "init") {
    if (existing === undefined && already.success) throw agentXError("CALLBACK_FORBIDDEN", "this implementation already recorded its build source");
    return openUpload(stores, operation, spec, body);
  }
  const upload = requireCurrentUpload(existing, operation, spec);
  if (body.stage === "finalize" && upload["status"] === "COMPLETE" && upload["uploadId"] === body.uploadId && upload["sha256"] === body.sha256 && already.success) {
    return { accepted: already.data.status === "READY", buildSource: already.data as unknown as JsonValue, duplicate: true };
  }
  if (upload["status"] !== "OPEN") throw agentXError("STALE_FENCE", "candidate build source upload is no longer open");
  if (body.stage === "chunk") return acceptChunk(stores, operation, spec, upload, body);
  const { bytes, chunkKeys } = await assembleUpload(stores, spec, upload, body);
  const committed = await readCandidateSourceExport(stores, sourceRef);
  if (committed === undefined) {
    await dropChunks(stores, chunkKeys);
    throw agentXError("RUNTIME_UNAVAILABLE", "the committed candidate source export is unavailable to check its build source against");
  }
  const stored = assessCandidateBuildSource({ manifestBytes: bytes, committed });
  if (stored.status === "READY") {
    try { await putOnce(stores, stored.manifestRef.key, bytes, { sha256: stored.manifestRef.sha256, candidate: stored.candidateDigest, operation: operation.id }, E2E_APPLICATION_BUILD_SOURCE_MANIFEST_MAX_BYTES, "candidate build source"); } catch (error) { await dropChunks(stores, chunkKeys); throw error; }
  }
  const answer = await record(stored, { uploadId: body.uploadId, sha256: body.sha256, status: "COMPLETE" }).catch(async (error: unknown) => { await dropChunks(stores, chunkKeys); throw error; });
  await dropChunks(stores, chunkKeys);
  return answer;
}

// ---- the unchanged code, for the baseline round

const baselineSpec = (operation: UploadOperation): UploadSpec => ({
  label: "baseline source", entityType: "WORKFLOW_BASELINE_SOURCE", rowKey: uploadRowKey(operation.workspaceId, "BASELINE_SOURCE", operation.id),
  stagingKey: (uploadId, index) => `workflow-baseline-staging/${operation.workspaceId}/${operation.id}/${uploadId}/${index}.chunk`,
});

/**
 * The unchanged code (the task's base commit) a worker exported at the end of a coding run, or at the end of a planning run that was asked for it. One upload (the export and its manifest,
 * as the exact bytes the worker made) or one report that there is none, judged by `assessBaselineSource` and recorded once on the operation. A refusal of the manifest is a successful
 * answer; an export that is not the unchanged code of one repository is an error and records nothing. Whether it is the base the task pinned is decided when the round is dispatched.
 */
export async function handleBaselineSource(stores: UploadStores, operation: UploadOperation, rawBody: unknown): Promise<Record<string, JsonValue>> {
  const planAsked = operation.workflowMode === "PLAN" && operation.groundingSourceAsked === true;
  if (operation.kind !== "task" || (operation.workflowMode !== "IMPLEMENT" && !planAsked) || !isLiveOperation(operation.status)) {
    forbiddenMode("baseline source export is limited to the current implementation operation or a planning operation asked for it");
  }
  const body = parseUploadBody(BaselineSourceBodySchema, rawBody, "baseline source upload");
  const spec = baselineSpec(operation);
  const opKey = operationKey(operation.workspaceId, operation.id);
  const recorded = StoredBaselineSourceSchema.safeParse(operation.baselineSource);
  /** Records `stored` once; the record already there is answered from, and differs only as an error. `closing` closes the upload row in the same transaction. */
  const record = async (stored: StoredBaselineSource, closing?: { uploadId: string; sha256: string }): Promise<Record<string, JsonValue>> => {
    const items: TransactItem[] = [
      ...(closing === undefined ? [] : [{ kind: "update" as const, key: spec.rowKey, ops: [change.set("status", "COMPLETE")],
        condition: when.and(when.eq("status", "OPEN"), when.eq("uploadId", closing.uploadId), when.eq("sha256", closing.sha256), when.eq("operationId", operation.id), when.eq("fence", operation.fence)) }]),
      { kind: "update", key: opKey, ops: [change.set("baselineSource", stored)],
        condition: when.and(whenOperationLive(), when.eq("fence", operation.fence), when.eq("workflowMode", planAsked ? "PLAN" : "IMPLEMENT"), when.notExists("baselineSource"),
          ...(planAsked ? [when.eq("groundingSourceAsked", true)] : [])) },
    ];
    const done = await stores.store.transact(items);
    if (!done.applied) {
      const winner = StoredBaselineSourceSchema.safeParse((await stores.store.get(opKey))?.["baselineSource"]);
      if (!winner.success) throw agentXError("STALE_FENCE", "the baseline source can no longer be recorded for this operation");
      if (canonicalJson(winner.data) !== canonicalJson(stored)) throw agentXError("CALLBACK_FORBIDDEN", "this implementation already recorded a different baseline source");
      return { accepted: stored.status === "READY", baselineSource: stored as unknown as JsonValue, duplicate: true };
    }
    return { accepted: stored.status === "READY", baselineSource: stored as unknown as JsonValue };
  };
  if (body.stage === "unavailable") {
    const stored: StoredBaselineSource = { status: "REFUSED", reason: planAsked ? GROUNDING_SOURCE_NOT_EXPORTED_REASON : `the worker could not export the unchanged code: ${body.reason}`.slice(0, 600) };
    if (recorded.success) {
      if (canonicalJson(recorded.data) !== canonicalJson(stored)) throw agentXError("CALLBACK_FORBIDDEN", "this implementation already recorded a different baseline source");
      return { accepted: false, baselineSource: stored as unknown as JsonValue, duplicate: true };
    }
    return record(stored);
  }
  const existing = await stores.store.get(spec.rowKey);
  if (body.stage === "init") {
    if (body.totalBytes > MAX_CANDIDATE_EXPORT_BYTES) throw agentXError("CONFIG_INVALID", "baseline source chunk count does not match its total, or the upload is over its bound");
    if (existing === undefined && recorded.success) throw agentXError("CALLBACK_FORBIDDEN", "this implementation already recorded its baseline source");
    return openUpload(stores, operation, spec, body);
  }
  const upload = requireCurrentUpload(existing, operation, spec);
  if (body.stage === "finalize" && upload["status"] === "COMPLETE" && upload["uploadId"] === body.uploadId && upload["sha256"] === body.sha256 && recorded.success) {
    return { accepted: recorded.data.status === "READY", baselineSource: recorded.data as unknown as JsonValue, duplicate: true };
  }
  if (upload["status"] !== "OPEN") throw agentXError("STALE_FENCE", "baseline source upload is no longer open");
  if (body.stage === "chunk") return acceptChunk(stores, operation, spec, upload, body);
  const { bytes, chunkKeys } = await assembleUpload(stores, spec, upload, body);
  let sourceBytes: Buffer;
  let manifestBytes: Buffer;
  let stored: StoredBaselineSource;
  try {
    const wire = BaselineSourceWireSchema.parse(JSON.parse(bytes.toString("utf8")) as unknown);
    sourceBytes = Buffer.from(wire.sourceBase64, "base64");
    manifestBytes = Buffer.from(wire.manifestBase64, "base64");
    if (sourceBytes.toString("base64") !== wire.sourceBase64 || manifestBytes.toString("base64") !== wire.manifestBase64) throw new Error("the baseline source encoding is invalid");
    stored = assessBaselineSource({ sourceBytes, manifestBytes });
  } catch (error) {
    await dropChunks(stores, chunkKeys);
    throw agentXError("CONFIG_INVALID", `baseline source export is malformed or is not the unchanged code of one repository: ${planAsked ? "unreadable" : error instanceof Error ? error.message : "unreadable"}`.slice(0, 480));
  }
  // A planning run's refused export keeps no text of the validator's (it can name paths): one fixed sentence, which the grounding record reads as `not-exported`.
  if (planAsked && stored.status === "REFUSED") stored = { status: "REFUSED", reason: GROUNDING_SOURCE_REFUSED_REASON };
  if (stored.status === "READY") {
    const content = [{ key: stored.sourceRef.key, bytes: sourceBytes, limit: MAX_CANDIDATE_EXPORT_BYTES }, { key: stored.buildSource.manifestRef.key, bytes: manifestBytes, limit: E2E_APPLICATION_BUILD_SOURCE_MANIFEST_MAX_BYTES }];
    try {
      for (const item of content) await putOnce(stores, item.key, item.bytes, { sha256: sha256Of(item.bytes), candidate: stored.sourceRef.candidateDigest, operation: operation.id }, item.limit, "baseline source");
    } catch (error) {
      if (!(error instanceof SourceTooLargeError)) { await dropChunks(stores, chunkKeys); throw error; }
      // The unchanged code is informational: one that this install cannot keep is a refusal with a fixed reason, never a lost result.
      stored = { status: "REFUSED", reason: "the unchanged code is too large for this install's object storage" };
    }
  }
  const answer = await record(stored, { uploadId: body.uploadId, sha256: body.sha256 }).catch(async (error: unknown) => { await dropChunks(stores, chunkKeys); throw error; });
  await dropChunks(stores, chunkKeys);
  return answer;
}
