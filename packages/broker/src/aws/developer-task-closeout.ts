import { createHash } from "node:crypto";
import { z } from "zod";
import type { WorkflowCanvasCloseout, WorkflowCanvasCloseoutAttempt } from "@agentx/contracts";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const ArtifactSchema = z.object({
  id: z.string().min(1).max(128), type: z.enum(["requirements", "design", "plan", "test_plan", "review_report"]),
  version: z.number().int().positive(), objectKey: z.string().min(1).max(1024), sha256: DigestSchema,
}).strict();
const CanvasSchema = z.object({
  key: z.string().min(1).max(256), workflowRevision: z.number().int().positive(), artifactRef: z.string().min(1).max(1024),
  artifactDigest: DigestSchema, canvasId: z.string().regex(/^F[A-Z0-9]{8,}$/),
}).strict();
export const TaskCanvasCloseoutManifestSchema = z.object({
  schemaVersion: z.literal(1), taskId: z.string().uuid(), workflowRevision: z.number().int().positive(),
  terminalState: z.enum(["MERGED", "CLOSED", "CANCELLED"]), preparedAt: z.string().datetime(),
  artifacts: z.array(ArtifactSchema).max(100), canvases: z.array(CanvasSchema).max(100),
}).strict();
export type TaskCanvasCloseoutManifest = z.infer<typeof TaskCanvasCloseoutManifestSchema>;

export interface TaskCanvasCloseoutTask {
  taskId: string;
  closedAt?: string;
  canvasCloseoutVersion?: number;
  workflow?: {
    revision: number;
    updatedAt: string;
    stage: string;
    state: string;
    outcome?: string;
    artifacts: Array<{ id: string; type: string; version: number; objectKey: string; sha256: string }>;
    pullRequests?: Array<{ required: boolean; state: string }>;
    canvasLineage?: Array<{
      key: string; workflowRevision: number; artifactId: string; artifactRef: string; artifactDigest: string;
      state: string; canvasId?: string;
    }>;
    canvasCloseout?: WorkflowCanvasCloseout;
    canvasCloseoutAttempt?: WorkflowCanvasCloseoutAttempt;
  };
}

export interface CanvasCloseoutStore {
  loadTask(taskId: string): Promise<TaskCanvasCloseoutTask | undefined>;
  readArtifact(ref: { objectKey: string; sha256: string }): Promise<string | undefined>;
  readManifest(key: string): Promise<string | undefined>;
  putManifest(key: string, digest: string, bytes: string): Promise<void>;
  saveCloseout(taskId: string, closeout: WorkflowCanvasCloseout, expectedRevision: number): Promise<boolean>;
  saveCloseoutAttempt(taskId: string, attempt: WorkflowCanvasCloseoutAttempt, expectedRevision: number): Promise<boolean>;
  /** `unknown` includes canvas_not_found: Slack does not distinguish absent from not visible. */
  deleteCanvas(canvasId: string): Promise<"deleted" | "unknown">;
  now(): string;
}

function terminalState(task: TaskCanvasCloseoutTask): "MERGED" | "CLOSED" | "CANCELLED" | undefined {
  const workflow = task.workflow;
  if (workflow?.stage === "MERGED" && workflow.state === "COMPLETE" && workflow.outcome === "MERGED"
    && (workflow.pullRequests ?? []).some((pr) => pr.required)
    && workflow.pullRequests!.filter((pr) => pr.required).every((pr) => pr.state === "MERGED")) return "MERGED";
  if (workflow?.stage === "CLOSED" && workflow.state === "COMPLETE" && workflow.outcome === "CLOSED") return "CLOSED";
  if (task.closedAt !== undefined && workflow?.stage !== "MERGED") return "CLOSED";
  return undefined;
}

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const manifestKey = (taskId: string, digest: string) => `private/task-closeouts/${taskId}/${digest}.json`;
const errorCategory = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "slackError" in error && typeof error.slackError === "string"
    && /^[a-z_]{1,64}$/.test(error.slackError)) return error.slackError;
  return error instanceof Error && error.name === "TimeoutError" ? "timeout" : "unknown";
};

function pendingState(input: {
  terminalState: "MERGED" | "CLOSED" | "CANCELLED"; digest: string; key: string; now: string;
  canvases: WorkflowCanvasCloseout["canvases"];
}): WorkflowCanvasCloseout {
  const completed = input.canvases.every((canvas) => canvas.status === "DELETED");
  return {
    status: completed ? "COMPLETE" : "ARCHIVE_PENDING", terminalState: input.terminalState,
    manifestDigest: input.digest, manifestRef: input.key, preparedAt: input.now,
    ...(completed ? { completedAt: input.now } : {}), canvases: input.canvases,
  };
}

async function persistPreparationFailure(input: {
  store: CanvasCloseoutStore; taskId: string; workflowRevision: number; terminalState: "MERGED" | "CLOSED" | "CANCELLED";
  previousAttempts: number; reason: WorkflowCanvasCloseoutAttempt["reason"];
  candidate?: { digest: string; key: string; preparedAt: string };
}): Promise<{ status: "ARCHIVE_PENDING"; reason: string }> {
  const attempt: WorkflowCanvasCloseoutAttempt = {
    status: "ARCHIVE_PENDING", workflowRevision: input.workflowRevision, terminalState: input.terminalState,
    reason: input.reason, attempts: Math.min(1000, input.previousAttempts + 1), updatedAt: input.store.now(),
    ...(input.candidate === undefined ? {} : { candidateManifestDigest: input.candidate.digest,
      candidateManifestRef: input.candidate.key, candidatePreparedAt: input.candidate.preparedAt }),
  };
  let saved: boolean;
  try { saved = await input.store.saveCloseoutAttempt(input.taskId, attempt, input.workflowRevision); }
  catch { return { status: "ARCHIVE_PENDING", reason: "closeout_attempt_write_failed" }; }
  return { status: "ARCHIVE_PENDING", reason: saved ? input.reason : "closeout_attempt_write_failed" };
}

/** Verifies and snapshots first, then removes only exact, durably recorded Canvas IDs. */
export async function runTaskCanvasCloseout(
  store: CanvasCloseoutStore,
  input: { taskId: string; expectedManifestDigest?: string; expectedWorkflowRevision?: number },
): Promise<WorkflowCanvasCloseout | { status: "ARCHIVE_PENDING"; reason: string }> {
  const task = await store.loadTask(input.taskId);
  const workflow = task?.workflow;
  if (task === undefined || task.taskId !== input.taskId || workflow === undefined) return { status: "ARCHIVE_PENDING", reason: "task_unavailable" };
  const terminal = terminalState(task);
  if (terminal === undefined) return { status: "ARCHIVE_PENDING", reason: "task_not_terminal" };
  if (input.expectedWorkflowRevision !== undefined && input.expectedWorkflowRevision !== workflow.revision) {
    return { status: "ARCHIVE_PENDING", reason: "manifest_binding_changed" };
  }
  const lineage = workflow.canvasLineage ?? [];
  if (lineage.some((entry) => !workflow.artifacts.some((artifact) => artifact.id === entry.artifactId
    && artifact.objectKey === entry.artifactRef && artifact.sha256 === entry.artifactDigest))) {
    return persistPreparationFailure({ store, taskId: task.taskId, workflowRevision: workflow.revision, terminalState: terminal,
      previousAttempts: workflow.canvasCloseoutAttempt?.attempts ?? 0, reason: "canvas_artifact_binding_failed" });
  }
  if (lineage.some((entry) => entry.state !== "CREATED" || entry.canvasId === undefined)
    || new Set(lineage.map((entry) => entry.canvasId)).size !== lineage.length) {
    return persistPreparationFailure({ store, taskId: task.taskId, workflowRevision: workflow.revision, terminalState: terminal,
      previousAttempts: workflow.canvasCloseoutAttempt?.attempts ?? 0, reason: "canvas_lineage_unresolved" });
  }

  let closeout = workflow.canvasCloseout;
  const priorAttempt = workflow.canvasCloseoutAttempt;
  if (input.expectedManifestDigest !== undefined) {
    const currentDigest = closeout?.manifestDigest ?? priorAttempt?.candidateManifestDigest;
    if (currentDigest !== input.expectedManifestDigest) return { status: "ARCHIVE_PENDING", reason: "manifest_binding_changed" };
  } else if (priorAttempt?.candidateManifestDigest !== undefined) {
    input = { ...input, expectedManifestDigest: priorAttempt.candidateManifestDigest };
  }
  const preparedAt = closeout?.preparedAt ?? priorAttempt?.candidatePreparedAt ?? store.now();
  const candidate = TaskCanvasCloseoutManifestSchema.parse({
    schemaVersion: 1, taskId: task.taskId, workflowRevision: workflow.revision, terminalState: terminal, preparedAt,
    artifacts: workflow.artifacts.map(({ id, type, version, objectKey, sha256: digest }) => ({ id, type, version, objectKey, sha256: digest }))
      .sort((left, right) => left.objectKey.localeCompare(right.objectKey)),
    canvases: lineage.map((entry) => ({ key: entry.key, workflowRevision: entry.workflowRevision,
      artifactRef: entry.artifactRef, artifactDigest: entry.artifactDigest, canvasId: entry.canvasId! }))
      .sort((left, right) => left.key.localeCompare(right.key)),
  });
  const candidateBytes = JSON.stringify(candidate);
  const candidateDigest = sha256(candidateBytes);
  const candidateKey = manifestKey(task.taskId, candidateDigest);
  const candidateBinding = { digest: candidateDigest, key: candidateKey, preparedAt };
  if (priorAttempt?.candidateManifestDigest !== undefined
    && (priorAttempt.candidateManifestDigest !== candidateDigest || priorAttempt.candidateManifestRef !== candidateKey)) {
    return persistPreparationFailure({ store, taskId: task.taskId, workflowRevision: workflow.revision, terminalState: terminal,
      previousAttempts: priorAttempt.attempts, reason: "manifest_binding_changed", candidate: candidateBinding });
  }
  if (input.expectedManifestDigest !== undefined && input.expectedManifestDigest !== candidateDigest) {
    return persistPreparationFailure({ store, taskId: task.taskId, workflowRevision: workflow.revision, terminalState: terminal,
      previousAttempts: priorAttempt?.attempts ?? 0, reason: "manifest_binding_changed", candidate: candidateBinding });
  }
  let manifestBytes: string | undefined;

  if (closeout !== undefined) {
    if (closeout.manifestRef !== candidateKey || closeout.manifestDigest !== candidateDigest) {
      return persistPreparationFailure({ store, taskId: task.taskId, workflowRevision: workflow.revision, terminalState: terminal,
        previousAttempts: priorAttempt?.attempts ?? 0, reason: "manifest_binding_changed", candidate: candidateBinding });
    }
    try { manifestBytes = await store.readManifest(closeout.manifestRef); }
    catch { return persistPreparationFailure({ store, taskId: task.taskId, workflowRevision: workflow.revision, terminalState: terminal,
      previousAttempts: priorAttempt?.attempts ?? 0, reason: "manifest_integrity_failed", candidate: candidateBinding }); }
    if (manifestBytes === undefined || sha256(manifestBytes) !== closeout.manifestDigest || manifestBytes !== candidateBytes) {
      return persistPreparationFailure({ store, taskId: task.taskId, workflowRevision: workflow.revision, terminalState: terminal,
        previousAttempts: priorAttempt?.attempts ?? 0, reason: "manifest_integrity_failed", candidate: candidateBinding });
    }
  } else {
    for (const artifact of workflow.artifacts) {
      let content: string | undefined;
      try { content = await store.readArtifact({ objectKey: artifact.objectKey, sha256: artifact.sha256 }); }
      catch { return persistPreparationFailure({ store, taskId: task.taskId, workflowRevision: workflow.revision, terminalState: terminal,
        previousAttempts: priorAttempt?.attempts ?? 0, reason: "artifact_unavailable" }); }
      if (content === undefined) return persistPreparationFailure({ store, taskId: task.taskId, workflowRevision: workflow.revision, terminalState: terminal,
        previousAttempts: priorAttempt?.attempts ?? 0, reason: "artifact_unavailable" });
      if (sha256(content) !== artifact.sha256) return persistPreparationFailure({ store, taskId: task.taskId, workflowRevision: workflow.revision, terminalState: terminal,
        previousAttempts: priorAttempt?.attempts ?? 0, reason: "artifact_digest_mismatch" });
    }
    const intent: WorkflowCanvasCloseoutAttempt = { status: "ARCHIVE_PENDING", workflowRevision: workflow.revision,
      terminalState: terminal, reason: "manifest_preparation_pending", attempts: Math.min(1000, (priorAttempt?.attempts ?? 0) + 1),
      updatedAt: store.now(), candidateManifestDigest: candidateDigest, candidateManifestRef: candidateKey, candidatePreparedAt: preparedAt };
    let intentSaved = false;
    try { intentSaved = await store.saveCloseoutAttempt(task.taskId, intent, workflow.revision); }
    catch { /* No manifest write or deletion is allowed without a durable candidate intent. */ }
    if (!intentSaved) return { status: "ARCHIVE_PENDING", reason: "closeout_attempt_write_failed" };
    try { await store.putManifest(candidateKey, candidateDigest, candidateBytes); }
    catch { return persistPreparationFailure({ store, taskId: task.taskId, workflowRevision: workflow.revision, terminalState: terminal,
      previousAttempts: priorAttempt?.attempts ?? 0, reason: "manifest_write_failed", candidate: candidateBinding }); }
    try { manifestBytes = await store.readManifest(candidateKey); }
    catch { return persistPreparationFailure({ store, taskId: task.taskId, workflowRevision: workflow.revision, terminalState: terminal,
      previousAttempts: priorAttempt?.attempts ?? 0, reason: "manifest_integrity_failed", candidate: candidateBinding }); }
    if (manifestBytes !== candidateBytes || sha256(manifestBytes ?? "") !== candidateDigest) {
      return persistPreparationFailure({ store, taskId: task.taskId, workflowRevision: workflow.revision, terminalState: terminal,
        previousAttempts: priorAttempt?.attempts ?? 0, reason: "manifest_integrity_failed", candidate: candidateBinding });
    }
    closeout = pendingState({ terminalState: terminal, digest: candidateDigest, key: candidateKey, now: candidate.preparedAt,
      canvases: candidate.canvases.map((canvas) => ({ lineageKey: canvas.key, canvasId: canvas.canvasId, status: "PENDING", attempts: 0 })) });
    if (!await store.saveCloseout(task.taskId, closeout, workflow.revision)) {
      return persistPreparationFailure({ store, taskId: task.taskId, workflowRevision: workflow.revision, terminalState: terminal,
        previousAttempts: priorAttempt?.attempts ?? 0, reason: "manifest_pointer_write_failed", candidate: candidateBinding });
    }
    if (closeout.status === "COMPLETE") return closeout;
  }

  if (closeout === undefined || manifestBytes === undefined) return { status: "ARCHIVE_PENDING", reason: "manifest_unavailable" };
  for (const entry of closeout.canvases) {
    if (entry.status === "DELETED") continue;
    const attemptAt = store.now();
    const attempted = pendingState({ terminalState: closeout.terminalState, digest: closeout.manifestDigest,
      key: closeout.manifestRef, now: closeout.preparedAt,
      canvases: closeout.canvases.map((item) => item.lineageKey === entry.lineageKey
        ? { ...item, status: "PENDING" as const, attempts: item.attempts + 1, attemptedAt: attemptAt }
        : item) });
    if (!await store.saveCloseout(task.taskId, attempted, workflow.revision)) return persistPreparationFailure({ store, taskId: task.taskId,
      workflowRevision: workflow.revision, terminalState: terminal, previousAttempts: priorAttempt?.attempts ?? 0,
      reason: "attempt_checkpoint_failed", candidate: candidateBinding });
    let result: "deleted" | "unknown" = "unknown";
    let category: string | undefined;
    try {
      result = await store.deleteCanvas(entry.canvasId);
      if (result === "unknown") category = "canvas_not_found";
    }
    catch (error) { category = errorCategory(error); }
    const updated = pendingState({ terminalState: attempted.terminalState, digest: attempted.manifestDigest,
      key: attempted.manifestRef, now: attempted.preparedAt,
      canvases: attempted.canvases.map((item) => item.lineageKey === entry.lineageKey
        ? { ...item, status: result === "deleted" ? "DELETED" as const : "UNKNOWN" as const, ...(category === undefined ? {} : { errorCategory: category }) }
        : item) });
    if (!await store.saveCloseout(task.taskId, updated, workflow.revision)) return persistPreparationFailure({ store, taskId: task.taskId,
      workflowRevision: workflow.revision, terminalState: terminal, previousAttempts: priorAttempt?.attempts ?? 0,
      reason: "outcome_checkpoint_failed", candidate: candidateBinding });
    closeout = updated;
  }
  return closeout;
}
