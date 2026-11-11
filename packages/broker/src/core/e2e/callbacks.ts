// The two callbacks a checks run makes to the broker, on the ports: it reads the admission it was started with (`e2e-admission`), and it posts its evidence (`e2e-evidence`): one upload per
// admitted group and then one aggregate. Both are bound to the exact admission the broker stored, content addressed, and to the round that is current: the worker's word on which round it runs
// is never taken. The handlers are plain functions of the two ports, the operation as the callback layer read it, and the records of the round kinds, so whatever starts rounds supplies those.
//
// The stored keys are the hosted product's. The one difference from it is the operation's two lists of accepted group evidence: the port has no list append, so they are written whole, with a
// condition that the lists are still what they were when this request read them.
import { z } from "zod";
import {
  E2EWorkflowEvidenceRefSchema, E2EWorkflowGroupEvidenceRefSchema, ObjectConflictError, agentXError, canonicalJson, change, isE2EApplicationAdmissionSchemaVersion, when,
  type E2EApplicationExecutionAdmission, type E2EWorkflowAdmissionRef, type JsonValue,
} from "@agentx/contracts";
import { decodeE2EApplicationExecutionAdmission, e2ePrivateTransferMaxBytes } from "@agentx/verifier";
import { applicationEvidenceLimits } from "../../e2e/application-evidence.js";
import { operationKey } from "../task-flow/keys.js";
import { E2E_OBJECT_RETENTION, E2E_STAGING_RETENTION, UPLOAD_CHUNK_BYTES, expectedChunkBytes, isLiveOperation, newUploadId, nowIso, parseUploadBody, readChunk, sha256Of, uploadRowKey, whenOperationLive, type UploadOperation, type UploadStores } from "./uploads-chunks.js";

/** The most an admission (and so an aggregate of evidence) may hold. */
export const WORKFLOW_E2E_ADMISSION_MAX_BYTES = 24 * 1024 * 1024;
/** The chunk size of the admission read and of the evidence upload. */
export const WORKFLOW_E2E_TRANSFER_CHUNK_BYTES = UPLOAD_CHUNK_BYTES;
const SHA256 = z.string().regex(/^[a-f0-9]{64}$/);

/** A checks operation: the coding-run fields are not read, the admission it was started with is. */
export interface ChecksOperation extends UploadOperation { workflowE2EAdmission?: E2EWorkflowAdmissionRef | undefined }

/** What the round kinds' records say of a round, as far as the admission read needs. The kinds of record are the round code's; this is only the shape read. */
export interface StartedRoundRecord {
  state: string;
  operationId?: string | undefined;
  roundId?: string | undefined;
  admissionSha256?: string | undefined;
  baseCommitSha?: string | undefined;
  attempt?: number | undefined;
  planArtifactSha256?: string | undefined;
}

/** The task as far as the admission read needs it. */
export interface RoundTask {
  taskId: string;
  workspaceId: string;
  closedAt?: string | undefined;
  workflow?: { stage?: string; state?: string; revision?: number; candidate?: { digest?: string } | undefined; e2e?: { currentRoundId?: string | undefined; currentGroupRunIds?: readonly string[] | undefined } | undefined } | undefined;
  /** The plan a planning run is holding back while its grounding round runs. */
  planGrounding?: { artifactSha256?: unknown } | undefined;
}

/** Where the round records are read from. Each answers undefined when there is none. */
export interface RoundRecordReaders {
  task(taskId: string): Promise<RoundTask | undefined>;
  baseline(task: RoundTask): Promise<StartedRoundRecord | undefined>;
  replay(taskId: string, key: { sourceRoundId: string; attempt: number }): Promise<StartedRoundRecord | undefined>;
  grounding(key: { taskId: string; planArtifactSha256: string; attempt: number }): Promise<StartedRoundRecord | undefined>;
}

/** The permitted states of the callback: a running checks operation that was given an admission. */
function requireChecksOperation(operation: ChecksOperation, what: string): E2EWorkflowAdmissionRef {
  if (operation.kind !== "task" || operation.workflowMode !== "CHECKS" || !isLiveOperation(operation.status) || operation.workflowE2EAdmission === undefined) {
    throw agentXError("CALLBACK_FORBIDDEN", `${what} require the active server-assigned CHECKS operation`);
  }
  return operation.workflowE2EAdmission;
}

const readBodySchema = z.object({ stage: z.literal("read"), offset: z.number().int().nonnegative(), sha256: SHA256 }).strict();

/**
 * One 64 KiB piece of the admission the checks operation was started with. The read is refused unless the round it names is the one that is current for its kind: the workflow's own round
 * (the task is verifying exactly this candidate), or the started record of a baseline, replay or grounding round for this operation, with the task still open.
 */
export async function readE2EAdmissionChunk(stores: UploadStores, readers: RoundRecordReaders, operation: ChecksOperation, rawBody: unknown): Promise<Record<string, JsonValue>> {
  const reference = requireChecksOperation(operation, "E2E admission reads");
  const body = parseUploadBody(readBodySchema, rawBody, "E2E admission read");
  if (body.sha256 !== reference.admissionRef.sha256 || body.offset % WORKFLOW_E2E_TRANSFER_CHUNK_BYTES !== 0 || body.offset >= reference.admissionRef.byteLength) {
    throw agentXError("CALLBACK_FORBIDDEN", "E2E admission read is outside its immutable reference");
  }
  const task = await readers.task(reference.taskId);
  const startedFor = (record: StartedRoundRecord | undefined, extra: boolean): boolean => record !== undefined && record.state === "STARTED" && record.operationId === operation.id
    && record.roundId === reference.roundId && record.admissionSha256 === reference.admissionRef.sha256 && extra;
  const open = task !== undefined && task.workspaceId === operation.workspaceId && task.closedAt === undefined;
  if (reference.purpose === "replay") {
    // An audit replay is not the workflow's round (the workflow has moved past its checks): it is read on what the replay's own record says.
    const record = task === undefined || reference.sourceRoundId === undefined || reference.attempt === undefined ? undefined : await readers.replay(task.taskId, { sourceRoundId: reference.sourceRoundId, attempt: reference.attempt });
    if (!open || !startedFor(record, true)) throw agentXError("STALE_FENCE", "the replay round is no longer the one that was started");
  } else if (reference.purpose === "grounding") {
    // A grounding round is not the workflow's round either (the task holds its plan back, in PLAN): it is read on what the grounding record says, for this plan, base commit and attempt, while
    // the task still holds that plan.
    const record = task === undefined || reference.planArtifactSha256 === undefined || reference.attempt === undefined ? undefined
      : await readers.grounding({ taskId: task.taskId, planArtifactSha256: reference.planArtifactSha256, attempt: reference.attempt });
    const held = task?.planGrounding?.artifactSha256;
    if (!open || !startedFor(record, record?.baseCommitSha === reference.baseCommitSha && record?.attempt === reference.attempt && record?.planArtifactSha256 === reference.planArtifactSha256 && held === reference.planArtifactSha256)) {
      throw agentXError("STALE_FENCE", "the grounding round is no longer the one that was started");
    }
  } else if (reference.purpose === "baseline") {
    // A baseline round is not the workflow's current round: it is read on what the baseline's own record says, for this plan, base commit and attempt.
    const record = task === undefined ? undefined : await readers.baseline(task);
    if (!open || !startedFor(record, record?.baseCommitSha === reference.baseCommitSha && record?.attempt === reference.attempt)) throw agentXError("STALE_FENCE", "the baseline round is no longer the one that was started");
  } else if (task?.workspaceId !== operation.workspaceId || task.workflow?.stage !== "VERIFY" || task.workflow.state !== "RUNNING" || task.workflow.revision !== reference.workflowRevision
    || task.workflow.candidate?.digest !== reference.candidateDigest || task.workflow.e2e?.currentRoundId !== reference.roundId
    || canonicalJson(task.workflow.e2e.currentGroupRunIds) !== canonicalJson(reference.groupRunIds)) {
    throw agentXError("STALE_FENCE", "E2E CHECKS admission is no longer current");
  }
  const found = await stores.objects.get(reference.admissionRef.key, reference.admissionRef.byteLength);
  if (found === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "E2E admission object is unavailable");
  const bytes = Buffer.from(found);
  if (bytes.byteLength !== reference.admissionRef.byteLength || sha256Of(bytes) !== reference.admissionRef.sha256) throw agentXError("CONFIG_INVALID", "E2E admission object failed its content address");
  const chunk = bytes.subarray(body.offset, Math.min(body.offset + WORKFLOW_E2E_TRANSFER_CHUNK_BYTES, bytes.byteLength));
  return { offset: body.offset, totalBytes: bytes.byteLength, sha256: reference.admissionRef.sha256, chunkBase64: chunk.toString("base64") };
}

/** Keeps an admission under its content address (the broker's own object, made when a round starts). The same bytes again are the same object. */
export async function storeE2EAdmission(stores: UploadStores, input: { key: string; sha256: string; bytes: Uint8Array; taskId: string; candidateDigest: string }): Promise<void> {
  if (input.bytes.byteLength > WORKFLOW_E2E_ADMISSION_MAX_BYTES || sha256Of(input.bytes) !== input.sha256 || input.key !== `workflow-e2e-admissions/sha256/${input.sha256}.json`) {
    throw agentXError("CONFIG_INVALID", "an E2E admission is held to its size and content address");
  }
  try {
    await stores.objects.put(input.key, input.bytes, { contentType: "application/json", metadata: { sha256: input.sha256, task: input.taskId, candidate: input.candidateDigest }, retention: E2E_OBJECT_RETENTION });
  } catch (error) {
    if (!(error instanceof ObjectConflictError)) throw error;
    const existing = await stores.objects.get(input.key, WORKFLOW_E2E_ADMISSION_MAX_BYTES);
    if (existing === undefined || !Buffer.from(existing).equals(Buffer.from(input.bytes))) throw agentXError("RUNTIME_UNAVAILABLE", "an existing E2E admission object does not match its content address");
  }
}

// ---- the evidence upload

const evidenceBodySchema = z.discriminatedUnion("stage", [
  z.object({ stage: z.literal("init"), groupRunId: z.string().uuid().optional(), totalBytes: z.number().int().positive().max(WORKFLOW_E2E_ADMISSION_MAX_BYTES), chunkCount: z.number().int().positive(), sha256: SHA256 }).strict(),
  z.object({ stage: z.literal("chunk"), groupRunId: z.string().uuid().optional(), uploadId: z.string().uuid(), index: z.number().int().nonnegative(),
    bytesBase64: z.string().min(1).max(Math.ceil(WORKFLOW_E2E_TRANSFER_CHUNK_BYTES * 4 / 3) + 8), sha256: SHA256 }).strict(),
  z.object({ stage: z.literal("finalize"), groupRunId: z.string().uuid().optional(), uploadId: z.string().uuid(), sha256: SHA256 }).strict(),
]);

const evidenceRowKey = (operation: UploadOperation, groupRunId: string | undefined) =>
  uploadRowKey(operation.workspaceId, "WORKFLOW_E2E_UPLOAD", operation.id, groupRunId === undefined ? "" : `#${groupRunId}`);
const stagingKeyOf = (operation: UploadOperation, groupRunId: string | undefined, uploadId: string, index: number): string =>
  `workflow-e2e-staging/${operation.workspaceId}/${operation.id}/${groupRunId ?? "aggregate"}/${uploadId}/${index}.chunk`;

/**
 * An application admission as the evidence upload judges it: decoded by the worker's own decoder (its content address is already checked), with the groups the operation's reference names
 * equal to the groups the admission holds (as sets: the admission is the authority, not the order of the reference), and the sizes its cases and shards allow.
 */
function applicationUploadAdmission(admissionBytes: Uint8Array, referencedRunIds: readonly string[]) {
  let admission: E2EApplicationExecutionAdmission;
  try { admission = decodeE2EApplicationExecutionAdmission(admissionBytes); }
  catch { throw agentXError("STALE_FENCE", "E2E admission object is unavailable or changed"); }
  const admitted = admission.groups.map((group) => group.outerBinding.runId);
  if (admitted.length !== referencedRunIds.length || canonicalJson([...admitted].sort()) !== canonicalJson([...referencedRunIds].sort())
    || admission.round.groupBindings.length !== admission.groups.length) throw agentXError("STALE_FENCE", "E2E admission no longer matches its operation");
  return { admission, limits: applicationEvidenceLimits(admission) };
}

/** The open upload row an evidence call continues: this operation's, under this fence and admission, and the upload the caller names. */
function requireOpenEvidenceUpload(upload: Record<string, unknown> | undefined, operation: UploadOperation, admissionRef: E2EWorkflowAdmissionRef, groupRunId: string | undefined, uploadId: string): Record<string, unknown> {
  if (upload === undefined || upload["entityType"] !== "WORKFLOW_E2E_EVIDENCE_UPLOAD" || upload["operationId"] !== operation.id || upload["fence"] !== operation.fence
    || upload["groupRunId"] !== groupRunId || upload["admissionSha256"] !== admissionRef.admissionRef.sha256 || upload["status"] !== "OPEN" || upload["uploadId"] !== uploadId) {
    throw agentXError("STALE_FENCE", "CHECKS evidence upload is no longer current");
  }
  return upload;
}

/** Stores the next 64 KiB chunk of an open upload, once and in order. */
async function acceptEvidenceChunk(stores: UploadStores, operation: UploadOperation, admissionRef: E2EWorkflowAdmissionRef, groupRunId: string | undefined, upload: Record<string, unknown>,
  body: { index: number; uploadId: string; bytesBase64: string; sha256: string }): Promise<Record<string, JsonValue>> {
  const index = Number(upload["nextChunkIndex"]);
  if (body.index !== index || body.index >= Number(upload["chunkCount"])) throw agentXError("CALLBACK_FORBIDDEN", "E2E evidence chunks must be uploaded once in order");
  const bytes = Buffer.from(body.bytesBase64, "base64");
  if (bytes.byteLength !== expectedChunkBytes(body.index, Number(upload["chunkCount"]), Number(upload["totalBytes"])) || bytes.toString("base64") !== body.bytesBase64 || sha256Of(bytes) !== body.sha256) {
    throw agentXError("CONFIG_INVALID", "E2E evidence chunk bytes or digest are invalid");
  }
  const key = stagingKeyOf(operation, groupRunId, body.uploadId, body.index);
  try {
    await stores.objects.put(key, bytes, { contentType: "application/octet-stream", metadata: { sha256: body.sha256 }, retention: E2E_STAGING_RETENTION });
  } catch (error) {
    if (!(error instanceof ObjectConflictError)) throw error;
    // Staged before a crash moved the row: the same bytes go on, other bytes are refused.
    const prior = await readChunk(stores, key);
    if (prior === undefined || !prior.equals(bytes)) throw agentXError("CALLBACK_FORBIDDEN", "replayed E2E evidence chunk differs from its owned bytes");
  }
  const moved = await stores.store.update({ key: evidenceRowKey(operation, groupRunId), ops: [change.set("nextChunkIndex", index + 1)],
    condition: when.and(when.eq("status", "OPEN"), when.eq("nextChunkIndex", index), when.eq("operationId", operation.id), when.eq("fence", operation.fence), when.eq("admissionSha256", admissionRef.admissionRef.sha256)) });
  if (!moved.applied) throw agentXError("STALE_FENCE", "CHECKS evidence upload is no longer current");
  return { accepted: true, index };
}

const asRecord = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {});

/** One request of the evidence upload of a checks run: the evidence of one admitted group, or the aggregate of every group. */
export async function handleE2EEvidenceUpload(stores: UploadStores, operation: ChecksOperation, rawBody: unknown): Promise<Record<string, JsonValue>> {
  // What the worker staged is not kept when the upload is refused: a retry uploads it again, and a chunk left behind would only wait for its expiry.
  const staged: string[] = [];
  try {
    return await evidenceUploadStep(stores, operation, rawBody, staged);
  } catch (error) {
    for (const key of staged) await stores.objects.delete(key).catch(() => undefined);
    throw error;
  }
}

async function evidenceUploadStep(stores: UploadStores, operation: ChecksOperation, rawBody: unknown, staged: string[]): Promise<Record<string, JsonValue>> {
  const admissionRef = requireChecksOperation(operation, "E2E evidence uploads");
  const body = parseUploadBody(evidenceBodySchema, rawBody, "E2E evidence upload");
  // A chunk of an application upload continues a row whose init was judged against the decoded admission and carries its digest (which must still be the operation's): it does not read, hash and
  // parse a multi-megabyte admission again for each 64 KiB. Anything else takes the full path below.
  if (body.stage === "chunk" && (body.groupRunId === undefined || admissionRef.groupRunIds.includes(body.groupRunId))) {
    const row = await stores.store.get(evidenceRowKey(operation, body.groupRunId));
    if (row?.["applicationAdmission"] === true) return acceptEvidenceChunk(stores, operation, admissionRef, body.groupRunId, requireOpenEvidenceUpload(row, operation, admissionRef, body.groupRunId, body.uploadId), body);
  }
  const admissionFound = await stores.objects.get(admissionRef.admissionRef.key, WORKFLOW_E2E_ADMISSION_MAX_BYTES);
  if (admissionFound === undefined || admissionFound.byteLength !== admissionRef.admissionRef.byteLength || sha256Of(admissionFound) !== admissionRef.admissionRef.sha256) {
    throw agentXError("STALE_FENCE", "E2E admission object is unavailable or changed");
  }
  const admissionText = Buffer.from(admissionFound).toString("utf8");
  const stored = JSON.parse(admissionText) as { schemaVersion?: string; round?: { groupBindings?: Array<{ runId?: string; groupId?: string; expectedCases?: unknown[] }> }; plan?: { groups?: unknown[] };
    taskId?: string; operationId?: string; operationFence?: number; workflowRevision?: number; candidateDigest?: string };
  // An application admission is judged by its own decoder: its groups, plan groups and sizes come from it, never from the portable plan an application round does not have.
  const applicationKind = isE2EApplicationAdmissionSchemaVersion(stored.schemaVersion);
  const application = applicationKind ? applicationUploadAdmission(admissionFound, admissionRef.groupRunIds) : undefined;
  const admission = (application?.admission ?? stored) as typeof stored;
  const groups = admission.round?.groupBindings;
  const caseCount = groups?.reduce((sum, group) => sum + (group.expectedCases?.length ?? 0), 0) ?? 0;
  if (!Array.isArray(groups) || groups.length !== admissionRef.groupRunIds.length || caseCount < 1
    || admission.taskId !== admissionRef.taskId || admission.operationId !== operation.id || admission.operationFence !== operation.fence
    || admission.workflowRevision !== admissionRef.workflowRevision || admission.candidateDigest !== admissionRef.candidateDigest) throw agentXError("STALE_FENCE", "E2E admission no longer matches its operation");
  const maxBytes = applicationKind ? application?.limits.aggregate ?? 0 : Math.min(WORKFLOW_E2E_ADMISSION_MAX_BYTES, e2ePrivateTransferMaxBytes(caseCount, groups.length));
  const groupRunId = body.groupRunId;
  const admittedGroupIndex = groupRunId === undefined ? -1 : admissionRef.groupRunIds.indexOf(groupRunId);
  if (groupRunId !== undefined && admittedGroupIndex < 0) throw agentXError("CALLBACK_FORBIDDEN", "E2E group upload is outside the immutable admission");
  // A group is found by its run id in the admission itself; the order of the operation's reference is not what names it.
  const applicationGroupBinding = groupRunId === undefined ? undefined : groups.find((binding) => binding.runId === groupRunId);
  if (application !== undefined && groupRunId !== undefined && (applicationGroupBinding === undefined || !application.limits.byGroup.has(groupRunId))) {
    throw agentXError("CALLBACK_FORBIDDEN", "E2E group upload is outside the immutable admission");
  }
  const selectedGroup = groupRunId === undefined ? undefined : groups[admittedGroupIndex];
  const transferLimit = groupRunId === undefined ? maxBytes : applicationKind ? application?.limits.byGroup.get(groupRunId) ?? 0
    : Math.min(WORKFLOW_E2E_ADMISSION_MAX_BYTES, e2ePrivateTransferMaxBytes(selectedGroup?.expectedCases?.length ?? 0, 1));
  const key = evidenceRowKey(operation, groupRunId);
  if (body.stage === "init") {
    if (body.chunkCount !== Math.ceil(body.totalBytes / WORKFLOW_E2E_TRANSFER_CHUNK_BYTES) || body.totalBytes > transferLimit) throw agentXError("CONFIG_INVALID", "E2E evidence exceeds its admission-derived transfer bound");
    const existing = await stores.store.get(key);
    if (existing) {
      if (groupRunId !== undefined && existing["status"] === "COMPLETE" && existing["entityType"] === "WORKFLOW_E2E_EVIDENCE_UPLOAD" && existing["operationId"] === operation.id
        && existing["groupRunId"] === groupRunId && existing["fence"] === operation.fence && existing["admissionSha256"] === admissionRef.admissionRef.sha256 && existing["sha256"] === body.sha256
        && existing["totalBytes"] === body.totalBytes && existing["chunkCount"] === body.chunkCount && typeof existing["uploadId"] === "string") {
        const groupEvidenceRef = E2EWorkflowGroupEvidenceRefSchema.safeParse(existing["groupEvidenceRef"]);
        if (!groupEvidenceRef.success || groupEvidenceRef.data.groupRunId !== groupRunId || groupEvidenceRef.data.evidenceRef.sha256 !== body.sha256) {
          throw agentXError("CALLBACK_FORBIDDEN", "completed group upload does not match its accepted content reference");
        }
        return { uploadId: existing["uploadId"], groupRunId, complete: true, evidenceRef: groupEvidenceRef.data.evidenceRef as unknown as JsonValue, chunkBytes: WORKFLOW_E2E_TRANSFER_CHUNK_BYTES, chunkCount: body.chunkCount };
      }
      if (existing["entityType"] !== "WORKFLOW_E2E_EVIDENCE_UPLOAD" || existing["status"] !== "OPEN" || existing["operationId"] !== operation.id || existing["groupRunId"] !== groupRunId
        || existing["fence"] !== operation.fence || existing["admissionSha256"] !== admissionRef.admissionRef.sha256 || existing["totalBytes"] !== body.totalBytes
        || existing["chunkCount"] !== body.chunkCount || existing["sha256"] !== body.sha256 || typeof existing["uploadId"] !== "string") throw agentXError("CALLBACK_FORBIDDEN", "CHECKS already owns a different evidence upload");
      return { uploadId: existing["uploadId"], ...(groupRunId === undefined ? {} : { groupRunId }), chunkBytes: WORKFLOW_E2E_TRANSFER_CHUNK_BYTES, chunkCount: body.chunkCount };
    }
    const uploadId = newUploadId(stores);
    const startedAt = nowIso(stores);
    // The broker's own receipt of a group's evidence is when its upload started, written once with the row (a second write is refused, and a retried init finds this row), so a slow or retried
    // upload never moves it. The collector judges the post-close harvest window against it; nothing the worker sends sets it.
    const put = await stores.store.put({ item: { ...key, entityType: "WORKFLOW_E2E_EVIDENCE_UPLOAD", schemaVersion: 1, operationId: operation.id, ...(groupRunId === undefined ? {} : { groupRunId }),
      fence: operation.fence, admissionSha256: admissionRef.admissionRef.sha256, uploadId, totalBytes: body.totalBytes, chunkCount: body.chunkCount, sha256: body.sha256, nextChunkIndex: 0, status: "OPEN",
      createdAt: startedAt, ...(application === undefined ? {} : { applicationAdmission: true, ...(groupRunId === undefined ? {} : { receivedAt: startedAt }) }) }, condition: when.absent() });
    if (!put.applied) throw agentXError("STALE_FENCE", "CHECKS evidence upload is no longer current");
    return { uploadId, ...(groupRunId === undefined ? {} : { groupRunId }), chunkBytes: WORKFLOW_E2E_TRANSFER_CHUNK_BYTES, chunkCount: body.chunkCount };
  }
  const upload = requireOpenEvidenceUpload(await stores.store.get(key), operation, admissionRef, groupRunId, body.uploadId);
  if (body.stage === "chunk") return acceptEvidenceChunk(stores, operation, admissionRef, groupRunId, upload, body);
  if (body.sha256 !== upload["sha256"] || Number(upload["nextChunkIndex"]) !== Number(upload["chunkCount"])) throw agentXError("STALE_FENCE", "E2E evidence upload is incomplete or changed");
  const chunks: Buffer[] = [];
  const chunkKeys: string[] = staged;
  for (let index = 0; index < Number(upload["chunkCount"]); index += 1) {
    const chunkKey = stagingKeyOf(operation, groupRunId, body.uploadId, index);
    const chunk = await readChunk(stores, chunkKey);
    if (chunk === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "an owned E2E evidence chunk is missing");
    chunks.push(chunk);
    chunkKeys.push(chunkKey);
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.byteLength !== Number(upload["totalBytes"]) || bytes.byteLength > transferLimit || sha256Of(bytes) !== body.sha256) { for (const chunkKey of chunkKeys) await stores.objects.delete(chunkKey); throw agentXError("CONFIG_INVALID", "assembled E2E evidence failed its bound or digest"); }
  const drop = async (): Promise<void> => { for (const chunkKey of chunkKeys) await stores.objects.delete(chunkKey); };
  const sameBytes = (existing: Uint8Array | undefined): boolean => existing !== undefined && existing.byteLength === bytes.byteLength && Buffer.from(existing).equals(bytes) && sha256Of(existing) === body.sha256;
  const opKey = operationKey(operation.workspaceId, operation.id);
  const uploadCondition = (extra: ReturnType<typeof when.eq>[]) => when.and(when.eq("status", "OPEN"), when.eq("nextChunkIndex", Number(upload["chunkCount"])), when.eq("chunkCount", Number(upload["chunkCount"])),
    when.eq("uploadId", body.uploadId), when.eq("operationId", operation.id), when.eq("fence", operation.fence), when.eq("admissionSha256", admissionRef.admissionRef.sha256), ...extra);
  const decodedEnvelope = (): Record<string, unknown> => { try { return asRecord(JSON.parse(bytes.toString("utf8"))); } catch { throw agentXError("CONFIG_INVALID", "E2E evidence is not readable"); } };
  if (groupRunId !== undefined) {
    const decoded = decodedEnvelope();
    const expectedBinding = application === undefined ? groups[admittedGroupIndex] : applicationGroupBinding;
    const expectedPlanGroup = application === undefined ? admission.plan?.groups?.[admittedGroupIndex]
      : application.admission.executionPlan.groups.find((planGroup) => planGroup.groupId === expectedBinding?.groupId);
    const groupResult = decoded["groupRun"] as Record<string, unknown> | undefined;
    if (decoded["schemaVersion"] !== "workflow-e2e-group-evidence/v1" || decoded["admissionSha256"] !== admissionRef.admissionRef.sha256 || decoded["taskId"] !== admissionRef.taskId
      || decoded["operationId"] !== operation.id || decoded["operationFence"] !== operation.fence || decoded["workflowRevision"] !== admissionRef.workflowRevision || decoded["candidateDigest"] !== admissionRef.candidateDigest
      || canonicalJson(decoded["round"]) !== canonicalJson(admission.round) || expectedBinding?.runId !== groupRunId
      || !groupResult || canonicalJson(groupResult["binding"]) !== canonicalJson(expectedBinding) || canonicalJson(groupResult["group"]) !== canonicalJson(expectedPlanGroup)) {
      throw agentXError("CALLBACK_FORBIDDEN", "E2E group evidence is outside its exact admitted run binding");
    }
    const groupRef = E2EWorkflowGroupEvidenceRefSchema.parse({ groupRunId, evidenceRef: { key: `workflow-e2e-group-evidence/sha256/${body.sha256}.json`, sha256: body.sha256, byteLength: bytes.byteLength } });
    const existingObject = await stores.objects.get(groupRef.evidenceRef.key, transferLimit);
    if (existingObject !== undefined && !sameBytes(existingObject)) throw agentXError("CALLBACK_FORBIDDEN", "content-addressed E2E group evidence conflicts with an existing object");
    if (existingObject === undefined) {
      try {
        await stores.objects.put(groupRef.evidenceRef.key, bytes, { contentType: "application/json", metadata: { sha256: body.sha256, operation: operation.id, groupRunId }, retention: E2E_OBJECT_RETENTION });
      } catch (error) { if (!(error instanceof ObjectConflictError)) throw error; }
    }
    if (!sameBytes(await stores.objects.get(groupRef.evidenceRef.key, transferLimit))) throw agentXError("RUNTIME_UNAVAILABLE", "stored E2E group evidence could not be read back exactly");
    // The accepted lists are written whole, on the condition that they are still what this request read.
    const current = await stores.store.get(opKey);
    const refs = Array.isArray(current?.["workflowE2EGroupEvidenceRefs"]) ? current["workflowE2EGroupEvidenceRefs"] : [];
    const ids = Array.isArray(current?.["workflowE2EGroupRunIds"]) ? current["workflowE2EGroupRunIds"] : [];
    if (ids.includes(groupRunId)) throw agentXError("CALLBACK_FORBIDDEN", "this group's evidence was already accepted for this operation");
    const listIs = (name: string, value: JsonValue[], present: boolean) => (present ? when.eq(name, value) : when.notExists(name));
    const done = await stores.store.transact([
      { kind: "update", key, ops: [change.set("status", "COMPLETE"), change.set("groupEvidenceRef", groupRef)], condition: uploadCondition([when.eq("groupRunId", groupRunId)]) },
      { kind: "update", key: opKey, ops: [change.set("workflowE2EGroupEvidenceRefs", [...refs, groupRef]), change.set("workflowE2EGroupRunIds", [...ids, groupRunId])],
        condition: when.and(whenOperationLive(), when.eq("fence", operation.fence), when.eq("workflowMode", "CHECKS"), when.eq(["workflowE2EAdmission", "admissionRef", "sha256"], admissionRef.admissionRef.sha256),
          listIs("workflowE2EGroupEvidenceRefs", refs, current?.["workflowE2EGroupEvidenceRefs"] !== undefined), listIs("workflowE2EGroupRunIds", ids, current?.["workflowE2EGroupRunIds"] !== undefined)) },
    ]);
    if (!done.applied) throw agentXError("STALE_FENCE", "E2E group evidence can no longer be recorded for this operation");
    await drop();
    return { key: groupRef.evidenceRef.key, sha256: groupRef.evidenceRef.sha256, groupRunId };
  }
  const evidenceRef = E2EWorkflowEvidenceRefSchema.parse({ key: `workflow-e2e-evidence/sha256/${body.sha256}.json`, sha256: body.sha256, byteLength: bytes.byteLength });
  const decoded = decodedEnvelope();
  if (decoded["schemaVersion"] !== "workflow-e2e-evidence/v1" || decoded["admissionSha256"] !== admissionRef.admissionRef.sha256 || decoded["taskId"] !== admissionRef.taskId
    || decoded["operationId"] !== operation.id || decoded["operationFence"] !== operation.fence || decoded["workflowRevision"] !== admissionRef.workflowRevision
    || decoded["candidateDigest"] !== admissionRef.candidateDigest) throw agentXError("CALLBACK_FORBIDDEN", "E2E evidence is outside its admitted CHECKS operation");
  // An application aggregate carries its group runs under its payload and nothing at the top; the portable shape is not one, whatever it holds.
  const payload = decoded["payload"] as { kind?: unknown; groupRuns?: unknown } | undefined;
  if (application !== undefined && (decoded["groupRuns"] !== undefined || payload === null || typeof payload !== "object" || Array.isArray(payload) || payload.kind !== "application")) {
    throw agentXError("CALLBACK_FORBIDDEN", "E2E evidence is outside its admitted CHECKS operation");
  }
  const aggregateGroups = application === undefined ? decoded["groupRuns"] : payload?.groupRuns;
  const currentOperation = await stores.store.get(opKey);
  const acceptedGroupRefs = Array.isArray(currentOperation?.["workflowE2EGroupEvidenceRefs"]) ? currentOperation["workflowE2EGroupEvidenceRefs"] as unknown[] : [];
  const acceptedGroupIds = Array.isArray(currentOperation?.["workflowE2EGroupRunIds"]) ? currentOperation["workflowE2EGroupRunIds"] as string[] : [];
  if (!Array.isArray(aggregateGroups) || aggregateGroups.length !== admissionRef.groupRunIds.length || acceptedGroupRefs.length !== admissionRef.groupRunIds.length
    || acceptedGroupIds.length !== admissionRef.groupRunIds.length || canonicalJson([...acceptedGroupIds].sort()) !== canonicalJson([...admissionRef.groupRunIds].sort())) {
    throw agentXError("STALE_FENCE", "CHECKS aggregate is missing one or more separately accepted admitted group results");
  }
  const acceptedReferenceIds = acceptedGroupRefs.map((raw) => E2EWorkflowGroupEvidenceRefSchema.parse(raw).groupRunId);
  if (new Set(acceptedReferenceIds).size !== admissionRef.groupRunIds.length || canonicalJson([...acceptedReferenceIds].sort()) !== canonicalJson([...admissionRef.groupRunIds].sort())) {
    throw agentXError("CALLBACK_FORBIDDEN", "accepted group evidence references do not cover the immutable admission exactly once");
  }
  const aggregateByRun = new Map(aggregateGroups.map((raw: unknown) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw agentXError("CONFIG_INVALID", "CHECKS aggregate group result is malformed");
    const run = raw as Record<string, unknown>;
    const binding = run["binding"] as Record<string, unknown> | undefined;
    if (typeof binding?.["runId"] !== "string") throw agentXError("CONFIG_INVALID", "CHECKS aggregate group binding is malformed");
    return [binding["runId"], run] as const;
  }));
  if (aggregateByRun.size !== admissionRef.groupRunIds.length) throw agentXError("CALLBACK_FORBIDDEN", "CHECKS aggregate contains duplicate or foreign group runs");
  for (const accepted of acceptedGroupRefs) {
    const reference = E2EWorkflowGroupEvidenceRefSchema.parse(accepted);
    if (!admissionRef.groupRunIds.includes(reference.groupRunId) || reference.evidenceRef.key !== `workflow-e2e-group-evidence/sha256/${reference.evidenceRef.sha256}.json`) {
      throw agentXError("CALLBACK_FORBIDDEN", "accepted group evidence reference is outside the immutable admission");
    }
    const limit = application !== undefined ? application.limits.byGroup.get(reference.groupRunId) ?? 0
      : Math.min(maxBytes, e2ePrivateTransferMaxBytes(groups[admissionRef.groupRunIds.indexOf(reference.groupRunId)]?.expectedCases?.length ?? 0, 1));
    const groupFound = await stores.objects.get(reference.evidenceRef.key, limit);
    if (groupFound === undefined || groupFound.byteLength !== reference.evidenceRef.byteLength || sha256Of(groupFound) !== reference.evidenceRef.sha256) throw agentXError("STALE_FENCE", "an accepted E2E group result is unavailable or changed");
    const groupEnvelope = asRecord(JSON.parse(Buffer.from(groupFound).toString("utf8")));
    const aggregateGroup = aggregateByRun.get(reference.groupRunId);
    if (groupEnvelope["schemaVersion"] !== "workflow-e2e-group-evidence/v1" || groupEnvelope["admissionSha256"] !== admissionRef.admissionRef.sha256 || groupEnvelope["taskId"] !== admissionRef.taskId
      || groupEnvelope["operationId"] !== operation.id || groupEnvelope["operationFence"] !== operation.fence || groupEnvelope["workflowRevision"] !== admissionRef.workflowRevision
      || groupEnvelope["candidateDigest"] !== admissionRef.candidateDigest || canonicalJson(groupEnvelope["round"]) !== canonicalJson(admission.round) || canonicalJson(groupEnvelope["groupRun"]) !== canonicalJson(aggregateGroup)) {
      throw agentXError("CALLBACK_FORBIDDEN", "CHECKS aggregate differs from a separately accepted group result");
    }
  }
  try {
    await stores.objects.put(evidenceRef.key, bytes, { contentType: "application/json", metadata: { sha256: body.sha256, operation: operation.id }, retention: E2E_OBJECT_RETENTION });
  } catch (error) {
    if (!(error instanceof ObjectConflictError)) throw error;
    if (!sameBytes(await stores.objects.get(evidenceRef.key, maxBytes))) throw agentXError("CALLBACK_FORBIDDEN", "content-addressed E2E evidence conflicts with an existing object");
  }
  const done = await stores.store.transact([
    { kind: "update", key, ops: [change.set("status", "COMPLETE"), change.set("evidenceRef", evidenceRef)], condition: uploadCondition([]) },
    { kind: "update", key: opKey, ops: [change.set("workflowE2EEvidenceRef", evidenceRef)],
      condition: when.and(whenOperationLive(), when.eq("fence", operation.fence), when.eq("workflowMode", "CHECKS"), when.notExists("workflowE2EEvidenceRef")) },
  ]);
  if (!done.applied) throw agentXError("STALE_FENCE", "E2E evidence can no longer be recorded for this operation");
  await drop();
  return { key: evidenceRef.key, sha256: evidenceRef.sha256 };
}
