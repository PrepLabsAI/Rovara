// The two callbacks of a browser and API checks run, on the document store and object storage: the read of its admission and the upload of its evidence.
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, type DocumentStore, type E2EWorkflowAdmissionRef, type ObjectStorage } from "@rovara-code/contracts";
import { createDocumentObjectStorage } from "../../packages/core/src/core/proof/evidence-blob-store.js";
import { MemoryDocumentStore } from "../../packages/core/src/ports/memory-document-store.js";
import { operationKey } from "../../packages/core/src/core/task-flow/keys.js";
import {
  handleE2EEvidenceUpload, readE2EAdmissionChunk, storeE2EAdmission, type ChecksOperation, type RoundRecordReaders, type RoundTask, type StartedRoundRecord,
} from "../../packages/core/src/core/e2e/callbacks.js";
import { UPLOAD_CHUNK_BYTES, type UploadStores } from "../../packages/core/src/core/e2e/uploads-chunks.js";

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const rejects = (promise: Promise<unknown>, code: string) => expect(promise).rejects.toMatchObject({ code });

const workspaceId = randomUUID();
const operationId = randomUUID();
const taskId = randomUUID();
const roundId = randomUUID();
const runIds = [randomUUID(), randomUUID()];
const CANDIDATE = "c".repeat(64);
const REVISION = 3;

function buildAdmission(padding = 0) {
  const groupBindings = runIds.map((runId, index) => ({ runId, groupId: `group-${index}`, expectedCases: [{ caseId: `case-${index}` }] }));
  const plan = { groups: runIds.map((_, index) => ({ groupId: `group-${index}` })) };
  const round = { groupBindings };
  const object = { schemaVersion: "workflow-e2e-admission/v1", taskId, operationId, operationFence: 1, workflowRevision: REVISION, candidateDigest: CANDIDATE, round, plan,
    ...(padding === 0 ? {} : { padding: "x".repeat(padding) }) };
  const bytes = Buffer.from(JSON.stringify(object), "utf8");
  const sha = sha256(bytes);
  return { object, bytes, sha, groupBindings, plan, round };
}

const refOf = (admission: ReturnType<typeof buildAdmission>, patch: Record<string, unknown> = {}): E2EWorkflowAdmissionRef => ({ schemaVersion: 1, taskId, workflowRevision: REVISION, candidateDigest: CANDIDATE, roundId, groupRunIds: runIds,
  admissionRef: { key: `workflow-e2e-admissions/sha256/${admission.sha}.json`, sha256: admission.sha, byteLength: admission.bytes.byteLength }, ...patch });

async function world(options: { padding?: number; ref?: Record<string, unknown>; objectsOf?: (inner: ObjectStorage) => ObjectStorage; store?: boolean } = {}) {
  const store: DocumentStore = new MemoryDocumentStore();
  const inner = createDocumentObjectStorage(store, { companyId: IMPLICIT_COMPANY_ID });
  const objects = options.objectsOf === undefined ? inner : options.objectsOf(inner);
  const stores: UploadStores = { store, objects };
  const admission = buildAdmission(options.padding ?? 0);
  if (options.store !== false) await storeE2EAdmission(stores, { key: `workflow-e2e-admissions/sha256/${admission.sha}.json`, sha256: admission.sha, bytes: admission.bytes, taskId, candidateDigest: CANDIDATE });
  const ref = refOf(admission, options.ref);
  const seed = async (more: Record<string, unknown> = {}) => store.put({ item: { ...operationKey(workspaceId, operationId), entityType: "OPERATION", id: operationId, workspaceId, kind: "task", workflowMode: "CHECKS",
    status: "RUNNING", fence: 1, workflowE2EAdmission: ref as never, ...more } });
  await seed();
  const operation = async (): Promise<ChecksOperation> => (await store.get(operationKey(workspaceId, operationId))) as unknown as ChecksOperation;
  const keysWith = async (needle: string) => (await store.query({ pk: `ORG#${IMPLICIT_COMPANY_ID}#EVIDENCE_BLOB` })).items.map((item) => item.sk).filter((key) => key.includes(needle));
  return { store, objects, stores, admission, ref, seed, operation, keysWith };
}
type World = Awaited<ReturnType<typeof world>>;

const currentTask = (patch: Partial<RoundTask> = {}): RoundTask => ({ taskId, workspaceId, workflow: { stage: "VERIFY", state: "RUNNING", revision: REVISION, candidate: { digest: CANDIDATE }, e2e: { currentRoundId: roundId, currentGroupRunIds: runIds } }, ...patch });
const readers = (parts: Partial<Omit<RoundRecordReaders, "task">> & { task?: RoundTask | undefined } = {}): RoundRecordReaders => ({
  task: async () => ("task" in parts ? parts.task : currentTask()),
  baseline: parts.baseline ?? (async () => undefined), replay: parts.replay ?? (async () => undefined), grounding: parts.grounding ?? (async () => undefined) });
const started = (patch: Partial<StartedRoundRecord> = {}): StartedRoundRecord => ({ state: "STARTED", operationId, roundId, admissionSha256: "", attempt: 1, ...patch });

describe("the admission read", () => {
  const read = async (w: World, rd: RoundRecordReaders, offset: number, patch: Record<string, unknown> = {}) =>
    readE2EAdmissionChunk(w.stores, rd, await w.operation(), { stage: "read", offset, sha256: w.admission.sha, ...patch });

  it("hands the admission over in 64 KiB pieces that rebuild exactly the stored bytes", async () => {
    const w = await world({ padding: UPLOAD_CHUNK_BYTES + 100 });
    const pieces: Buffer[] = [];
    const first = await read(w, readers(), 0);
    expect(first).toMatchObject({ offset: 0, totalBytes: w.admission.bytes.byteLength, sha256: w.admission.sha });
    pieces.push(Buffer.from(first["chunkBase64"] as string, "base64"));
    const second = await read(w, readers(), UPLOAD_CHUNK_BYTES);
    pieces.push(Buffer.from(second["chunkBase64"] as string, "base64"));
    expect(Buffer.concat(pieces).equals(w.admission.bytes)).toBe(true);
    expect(pieces[0]!.byteLength).toBe(UPLOAD_CHUNK_BYTES);
  });

  it("refuses a read outside the immutable reference", async () => {
    const w = await world({ padding: UPLOAD_CHUNK_BYTES + 100 });
    await rejects(read(w, readers(), 0, { sha256: "d".repeat(64) }), "CALLBACK_FORBIDDEN");
    await rejects(read(w, readers(), 100), "CALLBACK_FORBIDDEN");
    await rejects(read(w, readers(), UPLOAD_CHUNK_BYTES * 2), "CALLBACK_FORBIDDEN");
    await rejects(read(w, readers(), 0, { extra: true }), "CONFIG_INVALID");
    await rejects(read(w, readers(), 0, { stage: "write" }), "CONFIG_INVALID");
  });

  it("is for a running checks operation that has an admission, and nothing else", async () => {
    const w = await world();
    const base = await w.operation();
    const body = { stage: "read", offset: 0, sha256: w.admission.sha };
    for (const patch of [{ workflowMode: "IMPLEMENT" }, { status: "SUCCEEDED" }, { status: "CANCEL_REQUESTED" }, { kind: "publish" }, { workflowE2EAdmission: undefined }]) {
      await rejects(readE2EAdmissionChunk(w.stores, readers(), { ...base, ...patch }, body), "CALLBACK_FORBIDDEN");
    }
    await expect(readE2EAdmissionChunk(w.stores, readers(), { ...base, status: "DISPATCHING" }, body)).resolves.toMatchObject({ offset: 0 });
  });

  it("is refused once the workflow's round is not the current one", async () => {
    const w = await world();
    const stale = async (task: RoundTask | undefined) => rejects(read(w, readers({ task }), 0), "STALE_FENCE");
    const cur = currentTask();
    await stale(undefined);
    await stale(currentTask({ workspaceId: randomUUID() }));
    await stale({ ...cur, workflow: { ...cur.workflow!, stage: "REVIEW" } });
    await stale({ ...cur, workflow: { ...cur.workflow!, state: "BLOCKED" } });
    await stale({ ...cur, workflow: { ...cur.workflow!, revision: REVISION + 1 } });
    await stale({ ...cur, workflow: { ...cur.workflow!, candidate: { digest: "e".repeat(64) } } });
    await stale({ ...cur, workflow: { ...cur.workflow!, e2e: { currentRoundId: randomUUID(), currentGroupRunIds: runIds } } });
    await stale({ ...cur, workflow: { ...cur.workflow!, e2e: { currentRoundId: roundId, currentGroupRunIds: [runIds[0]!] } } });
  });

  it("reads a baseline round on its own started record, for this operation, base commit and attempt, while the task is open", async () => {
    const base = "a".repeat(40);
    const w = await world({ ref: { kind: "application", purpose: "baseline", baseCommitSha: base, attempt: 1 } });
    const good = started({ admissionSha256: w.admission.sha, baseCommitSha: base });
    await expect(read(w, readers({ baseline: async () => good }), 0)).resolves.toMatchObject({ offset: 0 });
    // The workflow's own round is no part of it: the task need not be verifying anything.
    await expect(read(w, readers({ task: currentTask({ workflow: { stage: "REVIEW" } }), baseline: async () => good }), 0)).resolves.toMatchObject({ offset: 0 });
    for (const record of [undefined, { ...good, state: "RECORDED" }, { ...good, operationId: randomUUID() }, { ...good, roundId: randomUUID() }, { ...good, admissionSha256: "f".repeat(64) },
      { ...good, baseCommitSha: "b".repeat(40) }, { ...good, attempt: 2 }]) {
      await rejects(read(w, readers({ baseline: async () => record }), 0), "STALE_FENCE");
    }
    await rejects(read(w, readers({ task: currentTask({ closedAt: "2026-01-01T00:00:00.000Z" }), baseline: async () => good }), 0), "STALE_FENCE");
  });

  it("reads a replay round on the replay's own record, found by the round it replays and the attempt", async () => {
    const sourceRoundId = randomUUID();
    const w = await world({ ref: { kind: "application", purpose: "replay", sourceRoundId, attempt: 2 } });
    const good = started({ admissionSha256: w.admission.sha });
    const asked: unknown[] = [];
    await expect(read(w, readers({ replay: async (id, key) => { asked.push([id, key]); return good; } }), 0)).resolves.toMatchObject({ offset: 0 });
    expect(asked).toEqual([[taskId, { sourceRoundId, attempt: 2 }]]);
    await rejects(read(w, readers({ replay: async () => ({ ...good, operationId: randomUUID() }) }), 0), "STALE_FENCE");
    await rejects(read(w, readers({ replay: async () => undefined }), 0), "STALE_FENCE");
    await rejects(read(w, readers({ task: currentTask({ closedAt: "2026-01-01T00:00:00.000Z" }), replay: async () => good }), 0), "STALE_FENCE");
  });

  it("reads a grounding round on its record, for this plan, base commit and attempt, while the task still holds that plan", async () => {
    const base = "a".repeat(40);
    const plan = "9".repeat(64);
    const w = await world({ ref: { kind: "application", purpose: "grounding", baseCommitSha: base, attempt: 1, planArtifactSha256: plan } });
    const good = started({ admissionSha256: w.admission.sha, baseCommitSha: base, planArtifactSha256: plan });
    const held = currentTask({ planGrounding: { artifactSha256: plan } });
    await expect(read(w, readers({ task: held, grounding: async () => good }), 0)).resolves.toMatchObject({ offset: 0 });
    await rejects(read(w, readers({ task: currentTask(), grounding: async () => good }), 0), "STALE_FENCE");
    await rejects(read(w, readers({ task: currentTask({ planGrounding: { artifactSha256: "8".repeat(64) } }), grounding: async () => good }), 0), "STALE_FENCE");
    for (const record of [undefined, { ...good, planArtifactSha256: "8".repeat(64) }, { ...good, baseCommitSha: "b".repeat(40) }, { ...good, attempt: 3 }, { ...good, state: "UNAVAILABLE" }]) {
      await rejects(read(w, readers({ task: held, grounding: async () => record }), 0), "STALE_FENCE");
    }
  });

  it("answers a missing admission object as unavailable and one that no longer matches its address as invalid", async () => {
    const missing = await world({ store: false });
    await rejects(readE2EAdmissionChunk(missing.stores, readers(), await missing.operation(), { stage: "read", offset: 0, sha256: missing.admission.sha }), "RUNTIME_UNAVAILABLE");
    const changed = await world({ objectsOf: (inner) => ({ put: inner.put.bind(inner), stat: inner.stat.bind(inner), delete: inner.delete.bind(inner), deletePrefix: inner.deletePrefix.bind(inner),
      get: async (key, max) => { const found = await inner.get(key, max); if (found === undefined) return undefined; const copy = Buffer.from(found); copy[10] = copy[10]! ^ 1; return copy; } }) });
    await rejects(readE2EAdmissionChunk(changed.stores, readers(), await changed.operation(), { stage: "read", offset: 0, sha256: changed.admission.sha }), "CONFIG_INVALID");
  });
});

describe("keeping an admission", () => {
  it("holds it to its content address and its size, and answers the same bytes again", async () => {
    const w = await world({ store: false });
    const input = { key: w.ref.admissionRef.key, sha256: w.admission.sha, bytes: w.admission.bytes, taskId, candidateDigest: CANDIDATE };
    await storeE2EAdmission(w.stores, input);
    await storeE2EAdmission(w.stores, input);
    await rejects(storeE2EAdmission(w.stores, { ...input, sha256: "0".repeat(64) }), "CONFIG_INVALID");
    await rejects(storeE2EAdmission(w.stores, { ...input, key: `workflow-e2e-admissions/sha256/${"0".repeat(64)}.json` }), "CONFIG_INVALID");
    await rejects(storeE2EAdmission(w.stores, { ...input, bytes: Buffer.alloc(24 * 1024 * 1024 + 1) }), "CONFIG_INVALID");
  });
});

// ---- the evidence

type Evidence = { w: World; envelope: (index: number, patch?: Record<string, unknown>) => Record<string, unknown>; aggregate: (patch?: Record<string, unknown>) => Record<string, unknown> };
function evidenceOf(w: World): Evidence {
  const { admission } = w;
  const base = { admissionSha256: admission.sha, taskId, operationId, operationFence: 1, workflowRevision: REVISION, candidateDigest: CANDIDATE };
  const groupRun = (index: number) => ({ binding: admission.groupBindings[index], group: admission.plan.groups[index], verdict: "PASS" });
  return {
    w,
    envelope: (index, patch = {}) => ({ schemaVersion: "workflow-e2e-group-evidence/v1", ...base, round: admission.round, groupRun: groupRun(index), ...patch }),
    aggregate: (patch = {}) => ({ schemaVersion: "workflow-e2e-evidence/v1", ...base, groupRuns: [groupRun(0), groupRun(1)], ...patch }),
  };
}
const bytesOf = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8");

async function uploadEvidence(w: World, content: Buffer, groupRunId: string | undefined, options: { stopBeforeFinalize?: boolean; operation?: Partial<ChecksOperation> } = {}) {
  const at = async () => ({ ...(await w.operation()), ...options.operation });
  const count = Math.ceil(content.byteLength / UPLOAD_CHUNK_BYTES);
  const digest = sha256(content);
  const group = groupRunId === undefined ? {} : { groupRunId };
  const init = await handleE2EEvidenceUpload(w.stores, await at(), { stage: "init", ...group, totalBytes: content.byteLength, chunkCount: count, sha256: digest });
  const uploadId = init["uploadId"] as string;
  for (let index = 0; index < count; index += 1) {
    const chunk = content.subarray(index * UPLOAD_CHUNK_BYTES, Math.min((index + 1) * UPLOAD_CHUNK_BYTES, content.byteLength));
    await handleE2EEvidenceUpload(w.stores, await at(), { stage: "chunk", ...group, uploadId, index, bytesBase64: chunk.toString("base64"), sha256: sha256(chunk) });
  }
  if (options.stopBeforeFinalize === true) return { uploadId, digest, answer: undefined };
  return { uploadId, digest, answer: await handleE2EEvidenceUpload(w.stores, await at(), { stage: "finalize", ...group, uploadId, sha256: digest }) };
}

describe("the evidence upload", () => {
  it("accepts each admitted group's evidence and then the aggregate, and records them on the operation once", async () => {
    const w = await world();
    const e = evidenceOf(w);
    const one = await uploadEvidence(w, bytesOf(e.envelope(0)), runIds[0]);
    expect(one.answer).toEqual({ key: `workflow-e2e-group-evidence/sha256/${one.digest}.json`, sha256: one.digest, groupRunId: runIds[0] });
    expect((await w.operation() as unknown as Record<string, unknown>)["workflowE2EGroupRunIds"]).toEqual([runIds[0]]);
    const two = await uploadEvidence(w, bytesOf(e.envelope(1)), runIds[1]);
    const operation = await w.operation() as unknown as Record<string, unknown>;
    expect(operation["workflowE2EGroupRunIds"]).toEqual(runIds);
    expect(operation["workflowE2EGroupEvidenceRefs"]).toEqual([
      { groupRunId: runIds[0], evidenceRef: { key: `workflow-e2e-group-evidence/sha256/${one.digest}.json`, sha256: one.digest, byteLength: bytesOf(e.envelope(0)).byteLength } },
      { groupRunId: runIds[1], evidenceRef: { key: `workflow-e2e-group-evidence/sha256/${two.digest}.json`, sha256: two.digest, byteLength: bytesOf(e.envelope(1)).byteLength } },
    ]);
    const aggregate = bytesOf(e.aggregate());
    const done = await uploadEvidence(w, aggregate, undefined);
    expect(done.answer).toEqual({ key: `workflow-e2e-evidence/sha256/${done.digest}.json`, sha256: done.digest });
    expect((await w.operation() as unknown as Record<string, unknown>)["workflowE2EEvidenceRef"]).toEqual({ key: `workflow-e2e-evidence/sha256/${done.digest}.json`, sha256: done.digest, byteLength: aggregate.byteLength });
    expect(Buffer.from((await w.objects.get(`workflow-e2e-evidence/sha256/${done.digest}.json`, aggregate.byteLength))!).equals(aggregate)).toBe(true);
    expect(await w.keysWith("workflow-e2e-staging/")).toEqual([]);
    expect(await w.store.get({ pk: `WORKSPACE#${workspaceId}`, sk: `WORKFLOW_E2E_UPLOAD#${operationId}` })).toMatchObject({ status: "COMPLETE", evidenceRef: { sha256: done.digest } });
    expect(await w.store.get({ pk: `WORKSPACE#${workspaceId}`, sk: `WORKFLOW_E2E_UPLOAD#${operationId}#${runIds[0]}` })).toMatchObject({ status: "COMPLETE", groupRunId: runIds[0] });
  });

  it("answers a repeated init of a finished group with its accepted reference", async () => {
    const w = await world();
    const e = evidenceOf(w);
    const content = bytesOf(e.envelope(0));
    const first = await uploadEvidence(w, content, runIds[0]);
    const again = await handleE2EEvidenceUpload(w.stores, await w.operation(), { stage: "init", groupRunId: runIds[0], totalBytes: content.byteLength, chunkCount: 1, sha256: first.digest });
    expect(again).toMatchObject({ complete: true, groupRunId: runIds[0], evidenceRef: { sha256: first.digest } });
    // A finalize of the same upload is no longer open.
    await rejects(handleE2EEvidenceUpload(w.stores, await w.operation(), { stage: "finalize", groupRunId: runIds[0], uploadId: first.uploadId, sha256: first.digest }), "STALE_FENCE");
  });

  it("answers a repeated init of an open upload with the same upload and refuses one for other bytes", async () => {
    const w = await world();
    const content = bytesOf(evidenceOf(w).envelope(0));
    const init = { stage: "init", groupRunId: runIds[0], totalBytes: content.byteLength, chunkCount: 1, sha256: sha256(content) };
    const opened = await handleE2EEvidenceUpload(w.stores, await w.operation(), init);
    expect(await handleE2EEvidenceUpload(w.stores, await w.operation(), init)).toEqual(opened);
    await rejects(handleE2EEvidenceUpload(w.stores, await w.operation(), { ...init, sha256: "1".repeat(64) }), "CALLBACK_FORBIDDEN");
  });

  it("refuses group evidence that is for another admission, round, run or case list", async () => {
    const e0 = (w: World) => evidenceOf(w);
    const cases: Array<(e: Evidence) => Record<string, unknown>> = [
      (e) => e.envelope(0, { admissionSha256: "2".repeat(64) }), (e) => e.envelope(0, { taskId: randomUUID() }), (e) => e.envelope(0, { operationId: randomUUID() }),
      (e) => e.envelope(0, { operationFence: 2 }), (e) => e.envelope(0, { workflowRevision: REVISION + 1 }), (e) => e.envelope(0, { candidateDigest: "3".repeat(64) }),
      (e) => e.envelope(0, { round: { groupBindings: [] } }), (e) => e.envelope(1), (e) => e.envelope(0, { schemaVersion: "workflow-e2e-evidence/v1" }),
      (e) => e.envelope(0, { groupRun: { binding: e.w.admission.groupBindings[0], group: { groupId: "other" } } }),
      (e) => e.envelope(0, { groupRun: { binding: { ...e.w.admission.groupBindings[0], groupId: "other" }, group: e.w.admission.plan.groups[0] } }),
    ];
    for (const make of cases) {
      const w = await world();
      await expect(uploadEvidence(w, bytesOf(make(e0(w))), runIds[0])).rejects.toMatchObject({ code: "CALLBACK_FORBIDDEN" });
      expect((await w.operation() as unknown as Record<string, unknown>)["workflowE2EGroupRunIds"]).toBeUndefined();
      // The chunks the refused upload staged are not kept.
      expect(await w.keysWith("workflow-e2e-staging/")).toEqual([]);
    }
  });

  it("refuses a group the admission does not hold", async () => {
    const w = await world();
    const content = bytesOf(evidenceOf(w).envelope(0));
    await rejects(handleE2EEvidenceUpload(w.stores, await w.operation(), { stage: "init", groupRunId: randomUUID(), totalBytes: content.byteLength, chunkCount: 1, sha256: sha256(content) }), "CALLBACK_FORBIDDEN");
  });

  it("refuses an aggregate before every group was accepted", async () => {
    const none = await world();
    await rejects(uploadEvidence(none, bytesOf(evidenceOf(none).aggregate()), undefined), "STALE_FENCE");
    const one = await world();
    await uploadEvidence(one, bytesOf(evidenceOf(one).envelope(0)), runIds[0]);
    await rejects(uploadEvidence(one, bytesOf(evidenceOf(one).aggregate()), undefined), "STALE_FENCE");
    expect((await one.operation() as unknown as Record<string, unknown>)["workflowE2EEvidenceRef"]).toBeUndefined();
  });

  it("refuses an aggregate when the accepted references and the accepted run ids do not agree", async () => {
    const w = await world();
    const e = evidenceOf(w);
    await uploadEvidence(w, bytesOf(e.envelope(0)), runIds[0]);
    await uploadEvidence(w, bytesOf(e.envelope(1)), runIds[1]);
    const operation = await w.operation() as unknown as Record<string, unknown>;
    await w.store.update({ key: operationKey(workspaceId, operationId), ops: [{ op: "set", path: ["workflowE2EGroupEvidenceRefs"], value: (operation["workflowE2EGroupEvidenceRefs"] as never[]).slice(0, 1) }] });
    await rejects(uploadEvidence(w, bytesOf(e.aggregate()), undefined), "STALE_FENCE");
  });

  it("refuses an aggregate that differs from what was accepted, or that repeats a group", async () => {
    const accepted = async () => { const w = await world(); const e = evidenceOf(w); await uploadEvidence(w, bytesOf(e.envelope(0)), runIds[0]); await uploadEvidence(w, bytesOf(e.envelope(1)), runIds[1]); return { w, e }; };
    const run = (w: World, index: number, verdict: string) => ({ binding: w.admission.groupBindings[index], group: w.admission.plan.groups[index], verdict });
    const first = await accepted();
    await rejects(uploadEvidence(first.w, bytesOf(first.e.aggregate({ groupRuns: [run(first.w, 0, "FAIL"), run(first.w, 1, "PASS")] })), undefined), "CALLBACK_FORBIDDEN");
    expect((await first.w.operation() as unknown as Record<string, unknown>)["workflowE2EEvidenceRef"]).toBeUndefined();
    const second = await accepted();
    await rejects(uploadEvidence(second.w, bytesOf(second.e.aggregate({ groupRuns: [run(second.w, 0, "PASS"), run(second.w, 0, "PASS")] })), undefined), "CALLBACK_FORBIDDEN");
  });

  it("refuses an aggregate that is for another admission or operation", async () => {
    for (const patch of [{ admissionSha256: "2".repeat(64) }, { operationFence: 2 }, { candidateDigest: "3".repeat(64) }, { schemaVersion: "workflow-e2e-group-evidence/v1" }]) {
      const w = await world();
      const e = evidenceOf(w);
      await uploadEvidence(w, bytesOf(e.envelope(0)), runIds[0]);
      await uploadEvidence(w, bytesOf(e.envelope(1)), runIds[1]);
      await expect(uploadEvidence(w, bytesOf(e.aggregate(patch)), undefined)).rejects.toMatchObject({ code: "CALLBACK_FORBIDDEN" });
    }
  });

  it("takes chunks once and in order, and holds an upload to its fence, its operation and its bounds", async () => {
    const w = await world();
    const content = bytesOf(evidenceOf(w).envelope(0, { padding: "y".repeat(UPLOAD_CHUNK_BYTES + 10) }));
    const count = Math.ceil(content.byteLength / UPLOAD_CHUNK_BYTES);
    expect(count).toBe(2);
    const init = { stage: "init", groupRunId: runIds[0], totalBytes: content.byteLength, chunkCount: count, sha256: sha256(content) };
    const opened = await handleE2EEvidenceUpload(w.stores, await w.operation(), init);
    const chunk = (index: number, patch: Record<string, unknown> = {}) => { const part = content.subarray(index * UPLOAD_CHUNK_BYTES, Math.min((index + 1) * UPLOAD_CHUNK_BYTES, content.byteLength));
      return { stage: "chunk", groupRunId: runIds[0], uploadId: opened["uploadId"], index, bytesBase64: part.toString("base64"), sha256: sha256(part), ...patch }; };
    await rejects(handleE2EEvidenceUpload(w.stores, await w.operation(), chunk(1)), "CALLBACK_FORBIDDEN");
    await rejects(handleE2EEvidenceUpload(w.stores, await w.operation(), chunk(0, { sha256: "4".repeat(64) })), "CONFIG_INVALID");
    await rejects(handleE2EEvidenceUpload(w.stores, { ...(await w.operation()), fence: 2 }, chunk(0)), "STALE_FENCE");
    await rejects(handleE2EEvidenceUpload(w.stores, await w.operation(), chunk(0, { uploadId: randomUUID() })), "STALE_FENCE");
    expect(await handleE2EEvidenceUpload(w.stores, await w.operation(), chunk(0))).toEqual({ accepted: true, index: 0 });
    await rejects(handleE2EEvidenceUpload(w.stores, await w.operation(), chunk(0)), "CALLBACK_FORBIDDEN");
    await rejects(handleE2EEvidenceUpload(w.stores, await w.operation(), { stage: "finalize", groupRunId: runIds[0], uploadId: opened["uploadId"], sha256: sha256(content) }), "STALE_FENCE");
    await rejects(handleE2EEvidenceUpload(w.stores, await w.operation(), { ...init, totalBytes: 25 * 1024 * 1024, chunkCount: Math.ceil(25 * 1024 * 1024 / UPLOAD_CHUNK_BYTES) }), "CONFIG_INVALID");
    await rejects(handleE2EEvidenceUpload(w.stores, await w.operation(), { ...init, groupRunId: runIds[1], chunkCount: count + 1 }), "CONFIG_INVALID");
  });

  it("is for a running checks operation that has an admission, whose object is still the one it names", async () => {
    const w = await world();
    const content = bytesOf(evidenceOf(w).envelope(0));
    const init = { stage: "init", groupRunId: runIds[0], totalBytes: content.byteLength, chunkCount: 1, sha256: sha256(content) };
    const base = await w.operation();
    for (const patch of [{ workflowMode: "IMPLEMENT" }, { status: "FAILED" }, { workflowE2EAdmission: undefined }]) await rejects(handleE2EEvidenceUpload(w.stores, { ...base, ...patch }, init), "CALLBACK_FORBIDDEN");
    const missing = await world({ store: false });
    await rejects(handleE2EEvidenceUpload(missing.stores, await missing.operation(), init), "STALE_FENCE");
    // The admission the operation names must say it is this operation's, under this fence and revision.
    const other = { ...base, fence: 2 };
    await rejects(handleE2EEvidenceUpload(w.stores, other, init), "STALE_FENCE");
  });

  it("does not record evidence under a newer fence of the operation", async () => {
    const w = await world();
    const e = evidenceOf(w);
    const started = await uploadEvidence(w, bytesOf(e.envelope(0)), runIds[0], { stopBeforeFinalize: true });
    await w.seed({ fence: 2 });
    await rejects(handleE2EEvidenceUpload(w.stores, { ...(await w.operation()), fence: 1 }, { stage: "finalize", groupRunId: runIds[0], uploadId: started.uploadId, sha256: started.digest }), "STALE_FENCE");
    expect((await w.operation() as unknown as Record<string, unknown>)["workflowE2EGroupRunIds"]).toBeUndefined();
  });
});
