import { createHash } from "node:crypto";
import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { E2E_DISPLAY_SCREENSHOT_MAX_BYTES, type E2EScenarioResults } from "@agentx/contracts";
import type { DeveloperTaskRecord } from "../developer/task-records.js";
import { readWorkflowE2ENotifierProjection, workflowE2EArtifactKey } from "./workflow-e2e-notifier-projection.js";

/**
 * M1.3 Task 3.7: the screenshots behind the rows of a browser and API round. Each is a private object by its SHA-256 under the task's own owner and workspace, written when
 * the round's display is, and read only through the task page's API for a digest the task's current display names.
 */

export type WorkflowE2EArtifactStore = Readonly<{ s3: Pick<S3Client, "send">; artifactBucketName: string }>;
export type WorkflowE2EArtifact = Readonly<{ sha256: string; bytes: Uint8Array; contentType: "image/jpeg" }>;

const sha256Of = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const isJpeg = (bytes: Uint8Array) => bytes.byteLength >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;

/**
 * Stores the artifacts that are what they say (a JPEG within the bound whose bytes have the named digest); anything else is skipped, and the row that named it loses its
 * link when its display is built, because the display only names what was stored. Content addressed, so writing one again changes nothing. Returns the digests stored.
 */
export async function storeWorkflowE2EArtifacts(store: WorkflowE2EArtifactStore, owner: { ownerKey: string; workspaceId: string }, artifacts: readonly WorkflowE2EArtifact[]): Promise<Set<string>> {
  const stored = new Set<string>();
  for (const artifact of artifacts) {
    if (artifact.contentType !== "image/jpeg" || artifact.bytes.byteLength === 0 || artifact.bytes.byteLength > E2E_DISPLAY_SCREENSHOT_MAX_BYTES
      || !isJpeg(artifact.bytes) || sha256Of(artifact.bytes) !== artifact.sha256) continue;
    await store.s3.send(new PutObjectCommand({ Bucket: store.artifactBucketName, Key: workflowE2EArtifactKey(owner.ownerKey, owner.workspaceId, artifact.sha256),
      Body: artifact.bytes, ContentType: artifact.contentType, Metadata: { sha256: artifact.sha256 } }));
    stored.add(artifact.sha256);
  }
  return stored;
}

/** The results with a screenshot link kept only where its object was stored. */
export function resultsWithStoredArtifacts(results: E2EScenarioResults, stored: ReadonlySet<string>): E2EScenarioResults {
  const keep = (row: E2EScenarioResults["scenarios"][number]) => {
    if (row.screenshotRef === undefined || stored.has(row.screenshotRef.sha256)) return row;
    const { screenshotRef: _dropped, ...rest } = row;
    void _dropped;
    return rest;
  };
  return { scenarios: results.scenarios.map(keep), ...(results.baseline === undefined ? {} : { baseline: { ...results.baseline, scenarios: results.baseline.scenarios.map(keep) } }) };
}

async function readPrivateObject(store: WorkflowE2EArtifactStore, key: string, maxBytes: number): Promise<Uint8Array | undefined> {
  try {
    const object = await store.s3.send(new GetObjectCommand({ Bucket: store.artifactBucketName, Key: key })) as { ContentLength?: number; Body?: { transformToByteArray(): Promise<Uint8Array> } };
    if (!Number.isSafeInteger(object.ContentLength) || object.ContentLength! > maxBytes) return undefined;
    const bytes = await object.Body?.transformToByteArray();
    return bytes !== undefined && bytes.byteLength === object.ContentLength && bytes.byteLength <= maxBytes ? bytes : undefined;
  } catch { return undefined; }
}

/**
 * The scenario results a task's stored display carries, read the way the notifier reads it: only the display of the task's current round, held to its content address.
 * Undefined when the task has no such display, or it is one a reader cannot use.
 */
export async function loadStoredScenarioResults(store: WorkflowE2EArtifactStore, task: Pick<DeveloperTaskRecord, "ownerKey" | "workspaceId" | "workflow">): Promise<E2EScenarioResults | undefined> {
  const progress = task.workflow?.e2e;
  const candidateDigest = task.workflow?.candidate?.digest;
  const ref = progress?.displayRef;
  if (candidateDigest === undefined || progress?.currentRoundId === undefined || ref === undefined) return undefined;
  const loaded = await readWorkflowE2ENotifierProjection({ ref, ownerKey: task.ownerKey, workspaceId: task.workspaceId,
    current: { candidateDigest, roundId: progress.currentRoundId, groupRunIds: progress.currentGroupRunIds, admissionSha256: ref.admissionSha256, evidenceSha256: ref.evidenceSha256 },
    readPrivateObject: (key, maxBytes) => (/^private\/[^/]+\/[^/]+\/workflow-e2e-display\/[a-f0-9]{64}\.json$/u.test(key) ? readPrivateObject(store, key, maxBytes) : Promise.resolve(undefined)) });
  return loaded?.scenarioResults;
}

/**
 * The screenshot a digest names, when the task's current display has a row (or a baseline row) that links it and the stored object is exactly those bytes. Anything else is
 * undefined: a digest that no row names is not served, however it came to be in the task's storage.
 */
export async function loadWorkflowE2EArtifact(store: WorkflowE2EArtifactStore, task: Pick<DeveloperTaskRecord, "ownerKey" | "workspaceId" | "workflow">, sha256: string):
  Promise<{ contentType: "image/jpeg"; bytes: Uint8Array } | undefined> {
  if (!/^[a-f0-9]{64}$/u.test(sha256)) return undefined;
  const results = await loadStoredScenarioResults(store, task);
  if (results === undefined) return undefined;
  const ref = [...results.scenarios, ...(results.baseline?.scenarios ?? [])].find((row) => row.screenshotRef?.sha256 === sha256)?.screenshotRef;
  if (ref === undefined) return undefined;
  const bytes = await readPrivateObject(store, workflowE2EArtifactKey(task.ownerKey, task.workspaceId, sha256), ref.bytes);
  if (bytes === undefined || bytes.byteLength !== ref.bytes || sha256Of(bytes) !== sha256 || !isJpeg(bytes)) return undefined;
  return { contentType: ref.contentType, bytes };
}
