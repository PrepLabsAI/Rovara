// The files of the browser and API checks, on the object-storage port: the screenshots behind a round's rows and the read that holds a stored admission to its reference (the admission is
// stored by `storeE2EAdmission` in callbacks.ts). The object keys are Cloud's, byte for byte (`private/<owner>/<workspace>/workflow-e2e-artifacts/<sha256>`, `workflow-e2e-admissions/sha256/<sha256>.json`).
//
// Differences from the S3 version: a put never replaces an object (the port is immutable by default), so storing a content-addressed object again reads the first one back and keeps it only
// when the bytes are the same; Cloud's retention tag on a screenshot is the port's retention class of the same name (`e2e-screenshot`), which an adapter maps to its own days.
import { createHash } from "node:crypto";
import {
  E2E_ARTIFACT_RETENTION_TAG_VALUE, E2E_DISPLAY_SCREENSHOT_MAX_BYTES, ObjectConflictError,
  type E2EDisplayBaseline, type E2EScenarioResults, type E2EWorkflowAdmissionRef, type ObjectStorage,
} from "@agentx/contracts";
import type { DeveloperTaskRecord } from "../../developer/task-records.js";
import { readWorkflowE2ENotifierProjection, workflowE2EArtifactKey } from "../../aws/workflow-e2e-notifier-projection.js";

export { resultsWithStoredArtifacts } from "../../e2e/stored-artifacts.js";
export type { WorkflowE2EArtifact } from "../../e2e/stored-artifacts.js";
import type { WorkflowE2EArtifact } from "../../e2e/stored-artifacts.js";

export type WorkflowE2EArtifactStore = Readonly<{ objects: ObjectStorage }>;

/** The most an admission object may hold (the same bound the worker's chunked read and the evidence upload are held to). */
export const WORKFLOW_E2E_ADMISSION_MAX_BYTES = 24 * 1024 * 1024;

const sha256Of = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const isJpeg = (bytes: Uint8Array) => bytes.byteLength >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
const sameBytes = (left: Uint8Array, right: Uint8Array) => Buffer.from(left).equals(Buffer.from(right));

/**
 * Stores an object under its content address. An object already there is kept when it is the same bytes (answers true) and is never replaced; a different one under the same key answers
 * false. Anything else the store says is its own fault and is thrown.
 */
export async function putContentAddressed(objects: ObjectStorage, key: string, bytes: Uint8Array, meta: { contentType: string; metadata: Record<string, string>; retention: string }): Promise<boolean> {
  try {
    await objects.put(key, bytes, meta);
    return true;
  } catch (error) {
    if (!(error instanceof ObjectConflictError)) throw error;
    const existing = await objects.get(key, bytes.byteLength + 1);
    return existing !== undefined && sameBytes(existing, bytes);
  }
}

/**
 * Stores the artifacts that are what they say (a JPEG within the bound whose bytes have the named digest); anything else is skipped, and the row that named it loses its
 * link when its display is built, because the display only names what was stored. Content addressed, so writing one again changes nothing. Returns the digests stored.
 */
export async function storeWorkflowE2EArtifacts(store: WorkflowE2EArtifactStore, owner: { ownerKey: string; workspaceId: string }, artifacts: readonly WorkflowE2EArtifact[]): Promise<Set<string>> {
  const stored = new Set<string>();
  for (const artifact of artifacts) {
    if (artifact.contentType !== "image/jpeg" || artifact.bytes.byteLength === 0 || artifact.bytes.byteLength > E2E_DISPLAY_SCREENSHOT_MAX_BYTES
      || !isJpeg(artifact.bytes) || sha256Of(artifact.bytes) !== artifact.sha256) continue;
    const kept = await putContentAddressed(store.objects, workflowE2EArtifactKey(owner.ownerKey, owner.workspaceId, artifact.sha256), artifact.bytes,
      { contentType: artifact.contentType, metadata: { sha256: artifact.sha256 }, retention: E2E_ARTIFACT_RETENTION_TAG_VALUE });
    if (kept) stored.add(artifact.sha256);
  }
  return stored;
}

async function readPrivateObject(store: WorkflowE2EArtifactStore, key: string, maxBytes: number): Promise<Uint8Array | undefined> {
  try {
    const bytes = await store.objects.get(key, maxBytes);
    return bytes !== undefined && bytes.byteLength <= maxBytes ? bytes : undefined;
  } catch { return undefined; }
}

/**
 * The scenario results a task's stored display carries, read the way the notifier reads it: only the display of the task's current round, held to its content address.
 * Undefined when the task has no such display, or it is one a reader cannot use.
 */
export async function loadStoredWorkflowDisplay(store: WorkflowE2EArtifactStore, task: Pick<DeveloperTaskRecord, "ownerKey" | "workspaceId" | "workflow" | "closedAt">) {
  const progress = task.workflow?.e2e;
  const candidateDigest = task.workflow?.candidate?.digest;
  const ref = progress?.displayRef;
  if (progress?.required !== true || candidateDigest === undefined || progress.currentRoundId === undefined || ref === undefined || task.workflow?.stage === "IMPLEMENT") return undefined;
  const recorded = progress.qualifiedRound ?? progress.failedRound;
  if (task.closedAt !== undefined && recorded === undefined) return undefined;
  const loaded = await readWorkflowE2ENotifierProjection({ ref, ownerKey: task.ownerKey, workspaceId: task.workspaceId,
    current: { candidateDigest, roundId: progress.currentRoundId, groupRunIds: progress.currentGroupRunIds,
      admissionSha256: recorded?.admissionSha256 ?? ref.admissionSha256, evidenceSha256: recorded?.evidenceSha256 ?? ref.evidenceSha256 },
    readPrivateObject: (key, maxBytes) => readPrivateObject(store, key, maxBytes) });
  if (task.closedAt !== undefined && (loaded === undefined || recorded?.candidateDigest !== candidateDigest || recorded.roundId !== progress.currentRoundId
    || JSON.stringify(recorded.groupRunIds) !== JSON.stringify(progress.currentGroupRunIds)
    || !(Date.parse(loaded.capturedAt) <= Date.parse(task.closedAt))
    || loaded.view.e2e.status !== (progress.qualifiedRound === undefined ? "FAILED" : "PASS"))) return undefined;
  return loaded;
}

export async function loadStoredScenarioResults(store: WorkflowE2EArtifactStore, task: Pick<DeveloperTaskRecord, "ownerKey" | "workspaceId" | "workflow" | "closedAt">): Promise<E2EScenarioResults | undefined> {
  return (await loadStoredWorkflowDisplay(store, task))?.scenarioResults;
}

/**
 * The screenshot a digest names, when the task's current display has a row (or a baseline row) that links it and the stored object is exactly those bytes. Anything else is
 * undefined: a digest that no row names is not served, however it came to be in the task's storage. The baseline round's own record is read as soon as it is recorded, before any
 * display names its rows, so its rows are passed in `extra`.
 */
export async function loadWorkflowE2EArtifact(store: WorkflowE2EArtifactStore, task: Pick<DeveloperTaskRecord, "ownerKey" | "workspaceId" | "workflow" | "closedAt">, sha256: string,
  extra: { baseline?: E2EDisplayBaseline } = {}): Promise<{ contentType: "image/jpeg"; bytes: Uint8Array } | undefined> {
  if (!/^[a-f0-9]{64}$/u.test(sha256)) return undefined;
  const results = await loadStoredScenarioResults(store, task);
  if (results === undefined && extra.baseline === undefined) return undefined;
  const ref = [...(results?.scenarios ?? []), ...(results?.baseline?.scenarios ?? []), ...(extra.baseline?.scenarios ?? [])].find((row) => row.screenshotRef?.sha256 === sha256)?.screenshotRef;
  if (ref === undefined) return undefined;
  const bytes = await readPrivateObject(store, workflowE2EArtifactKey(task.ownerKey, task.workspaceId, sha256), ref.bytes);
  if (bytes === undefined || bytes.byteLength !== ref.bytes || sha256Of(bytes) !== sha256 || !isJpeg(bytes)) return undefined;
  return { contentType: ref.contentType, bytes };
}

// ---- Readers of a stored admission

/** The admission a reference names: its text, held to the reference's size and sha256, or undefined for anything missing, changed or too big. */
export async function readStoredAdmission(store: WorkflowE2EArtifactStore, reference: E2EWorkflowAdmissionRef): Promise<{ text: string; bytes: Buffer } | undefined> {
  const { key, sha256, byteLength } = reference.admissionRef;
  let raw: Uint8Array | undefined;
  try { raw = await store.objects.get(key, byteLength); } catch { return undefined; }
  if (raw === undefined) return undefined;
  const bytes = Buffer.from(raw);
  if (bytes.byteLength !== byteLength || sha256Of(bytes) !== sha256) return undefined;
  return { text: bytes.toString("utf8"), bytes };
}
