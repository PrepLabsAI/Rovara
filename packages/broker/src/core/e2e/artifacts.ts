// The files of the browser and API checks, on the object-storage port: the screenshots behind a round's rows, the content-addressed admission a round runs from, and the readers that hold a
// stored admission to its reference. The object keys are Cloud's, byte for byte (`private/<owner>/<workspace>/workflow-e2e-artifacts/<sha256>`, `workflow-e2e-admissions/sha256/<sha256>.json`).
//
// Differences from the S3 version: a put never replaces an object (the port is immutable by default), so storing a content-addressed object again reads the first one back and keeps it only
// when the bytes are the same; Cloud's retention tag on a screenshot is the port's retention class of the same name (`e2e-screenshot`), which an adapter maps to its own days.
import { createHash } from "node:crypto";
import {
  E2E_ARTIFACT_RETENTION_TAG_VALUE, E2E_DISPLAY_SCREENSHOT_MAX_BYTES, ObjectConflictError, agentXError, e2eAgentRouteNeedsModelChoice,
  type E2EDisplayBaseline, type E2EModelRouteDefinition, type E2EScenarioResults, type E2EWorkflowAdmissionRef, type ObjectStorage,
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

/** Stores an admission under its content address; an object already there must be the same bytes. */
export async function storeWorkflowE2EAdmission(store: WorkflowE2EArtifactStore, input: { key: string; sha256: string; bytes: Uint8Array; taskId: string; candidateDigest: string }): Promise<void> {
  if (input.bytes.byteLength > WORKFLOW_E2E_ADMISSION_MAX_BYTES) throw agentXError("CONFIG_INVALID", "the immutable E2E admission exceeds its bounded object size");
  if (sha256Of(input.bytes) !== input.sha256) throw agentXError("CONFIG_INVALID", "the E2E admission does not have the digest it is stored under");
  const kept = await putContentAddressed(store.objects, input.key, input.bytes,
    { contentType: "application/json", metadata: { sha256: input.sha256, task: input.taskId, candidate: input.candidateDigest }, retention: "task-document" });
  if (!kept) throw agentXError("RUNTIME_UNAVAILABLE", "the content-addressed E2E admission object conflicts with its digest");
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
export async function loadStoredScenarioResults(store: WorkflowE2EArtifactStore, task: Pick<DeveloperTaskRecord, "ownerKey" | "workspaceId" | "workflow">): Promise<E2EScenarioResults | undefined> {
  const progress = task.workflow?.e2e;
  const candidateDigest = task.workflow?.candidate?.digest;
  const ref = progress?.displayRef;
  if (candidateDigest === undefined || progress?.currentRoundId === undefined || ref === undefined) return undefined;
  // After a send-back the code is being changed: the display is of the code that was sent back, and neither its rows nor its screenshots are shown as the task's current ones.
  if (task.workflow?.stage === "IMPLEMENT") return undefined;
  const loaded = await readWorkflowE2ENotifierProjection({ ref, ownerKey: task.ownerKey, workspaceId: task.workspaceId,
    current: { candidateDigest, roundId: progress.currentRoundId, groupRunIds: progress.currentGroupRunIds, admissionSha256: ref.admissionSha256, evidenceSha256: ref.evidenceSha256 },
    readPrivateObject: (key, maxBytes) => (/^private\/[^/]+\/[^/]+\/workflow-e2e-display\/[a-f0-9]{64}\.json$/u.test(key) ? readPrivateObject(store, key, maxBytes) : Promise.resolve(undefined)) });
  return loaded?.scenarioResults;
}

/**
 * The screenshot a digest names, when the task's current display has a row (or a baseline row) that links it and the stored object is exactly those bytes. Anything else is
 * undefined: a digest that no row names is not served, however it came to be in the task's storage. The baseline round's own record is read as soon as it is recorded, before any
 * display names its rows, so its rows are passed in `extra`.
 */
export async function loadWorkflowE2EArtifact(store: WorkflowE2EArtifactStore, task: Pick<DeveloperTaskRecord, "ownerKey" | "workspaceId" | "workflow">, sha256: string,
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

const parsedAdmission = async <T>(store: WorkflowE2EArtifactStore, reference: E2EWorkflowAdmissionRef): Promise<T | undefined> => {
  const admission = await readStoredAdmission(store, reference);
  if (admission === undefined) return undefined;
  try { return JSON.parse(admission.text) as T; } catch { return undefined; }
};

/** What kind of admission a reference names, from its `schemaVersion`; anything that cannot be established answers undefined, which the dispatcher treats as a refusal to deliver. */
export function createWorkflowE2EAdmissionSchemaReader(store: WorkflowE2EArtifactStore) {
  return async (reference: E2EWorkflowAdmissionRef): Promise<string | undefined> => {
    const schemaVersion = (await parsedAdmission<{ schemaVersion?: unknown } | null>(store, reference))?.schemaVersion;
    return typeof schemaVersion === "string" ? schemaVersion : undefined;
  };
}

/**
 * Whether the application admission a reference names has an `agent` step in its scenario bundle, and is not an audit replay: a replay runs those steps with no model channel, so it
 * never needs the worker to list the agent-steps feature. Anything that cannot be established answers undefined, which the dispatcher treats as a refusal.
 */
export function createWorkflowE2EAdmissionAgentStepsReader(store: WorkflowE2EArtifactStore) {
  return async (reference: E2EWorkflowAdmissionRef): Promise<boolean | undefined> => {
    const parsed = await parsedAdmission<{ bundle?: { scenarios?: unknown }; replay?: unknown } | null>(store, reference);
    const scenarios = parsed?.bundle?.scenarios;
    if (!Array.isArray(scenarios)) return undefined;
    if (parsed?.replay !== undefined) return false;
    return scenarios.some((scenario) => Array.isArray((scenario as { steps?: unknown })?.steps) && ((scenario as { steps: Array<{ kind?: unknown }> }).steps).some((step) => step?.kind === "agent"));
  };
}

/**
 * Whether an application admission relies on the normal no-model limits for a group: its policy pins a route (so its groups with no agent step are capped by the no-model limits, not
 * given the policy's agent-sized limits) and some scenario has no agent step. Read from the content-addressed object, never from the reference. A baseline's policy pins no route and a
 * routeless policy keeps its stored limits, so neither relies on it. Over-asking is safe; the answer is undefined when the object cannot be read as the admission the reference names.
 */
export function createWorkflowE2EAdmissionNeedsModelFreeLimitsReader(store: WorkflowE2EArtifactStore) {
  return async (reference: E2EWorkflowAdmissionRef): Promise<boolean | undefined> => {
    const parsed = await parsedAdmission<{ bundle?: { scenarios?: unknown }; policy?: { modelRouteRevision?: unknown } } | null>(store, reference);
    const scenarios = parsed?.bundle?.scenarios;
    if (!Array.isArray(scenarios)) return undefined;
    const routeRevision = parsed?.policy?.modelRouteRevision;
    if (routeRevision === undefined) return undefined;
    if (routeRevision === null) return false;
    return scenarios.some((scenario) => Array.isArray((scenario as { steps?: unknown })?.steps) && !((scenario as { steps: Array<{ kind?: unknown }> }).steps).some((step) => step?.kind === "agent"));
  };
}

/**
 * Whether the route an application admission pins needs a worker that lists the model-choice feature: the admission's `modelRoute` names a revision, and the registry's definition of
 * that revision says whether the model is not the recommended one or the request shape is `minimal`. An admission that pins no route needs nothing. Anything it cannot establish
 * (the object, the registry row, a fault reading it) answers undefined, which the dispatcher treats as a refusal: it never guesses that a route is the default.
 */
export function createWorkflowE2EAdmissionModelChoiceReader(input: WorkflowE2EArtifactStore & {
  /** Reads the registry's definition of a route revision (`readAdmittedE2EModelRoute` over the install's registry rows); null when there is none. The registry is not on the ports yet, so the caller binds it. */
  readRoute: (route: { routeId: string; routeRevision: string }) => Promise<E2EModelRouteDefinition | null>;
}) {
  return async (reference: E2EWorkflowAdmissionRef): Promise<boolean | undefined> => {
    const parsed = await parsedAdmission<{ modelRoute?: unknown } | null>(input, reference);
    if (parsed === undefined) return undefined;
    const route = parsed?.modelRoute;
    if (route === null) return false;
    const named = route as { routeId?: unknown; routeRevision?: unknown } | undefined;
    if (typeof named?.routeId !== "string" || typeof named.routeRevision !== "string") return undefined;
    try {
      const definition = await input.readRoute({ routeId: named.routeId, routeRevision: named.routeRevision });
      return definition === null ? undefined : e2eAgentRouteNeedsModelChoice(definition);
    } catch { return undefined; }
  };
}
