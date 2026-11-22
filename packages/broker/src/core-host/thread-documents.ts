// Port of the retired notifier's recorded Canvas intent and verified closeout. These are the
// existing workflow fields, never a second record kind. The host supplies the company's artifact reader.
import { change, sameJsonContent, when, type DocumentStore, type ObjectStorage, type OrgId, type WorkflowArtifact, type WorkflowCanvasLineage, type WorkflowSnapshot } from "@agentx/contracts";
import { loadWorkflowDocument } from "../developer/plan-document-reader.js";
import { documentSummaryLines, planReviewLink, workflowDocumentType } from "../developer/workflow-messages.js";
import type { ChatThreads } from "./chat-threads.js";
import { runTaskCanvasCloseout, type CanvasCloseoutStore, type TaskCanvasCloseoutTask } from "../aws/developer-task-closeout.js";
import { taskKey } from "../core/task-flow/keys.js";
import type { ArtifactReader } from "../core/task-flow/deps.js";
import { sendChannelCommand, type ChannelCommandDeps } from "../core/channel/commands.js";

export interface ThreadDocumentDeps {
  store: DocumentStore;
  blobs: ObjectStorage;
  artifacts: ArtifactReader;
  companyId: OrgId;
  now: () => number;
  createPlanCanvas?: ChatThreads["createPlanCanvas"];
  documentFailure?: ChatThreads["documentFailure"];
}
const versionCondition = (field: string, version: number) => version === 0 ? when.notExists(field) : when.eq(field, version);
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Parameters<DocumentStore["put"]>[0]["item"];
const text = async (reader: ArtifactReader, key: string): Promise<string | undefined> => {
  const bytes = await reader.get(key, 1_572_864);
  return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
};

function canCreateCanvas(deps: ThreadDocumentDeps, markdown: string): boolean {
  return deps.createPlanCanvas !== undefined && new TextEncoder().encode(markdown).byteLength <= 32_768;
}

async function lineageTask(deps: ThreadDocumentDeps, taskId: string, revision: number, key: string) {
  const task = await deps.store.get(taskKey(taskId));
  const workflow = task?.["workflow"] as WorkflowSnapshot | undefined;
  if (task?.["companyId"] !== deps.companyId || workflow?.revision !== revision || task["closedAt"] !== undefined) return undefined;
  const artifact = workflow.artifacts.find((entry) => key.endsWith(`:${entry.id}`));
  return artifact === undefined ? undefined : { task, workflow, artifact };
}

async function mutateLineage(deps: ThreadDocumentDeps, taskId: string, revision: number, key: string, mutate: (prior: WorkflowCanvasLineage | undefined, artifact: WorkflowArtifact) => WorkflowCanvasLineage, requireState?: WorkflowCanvasLineage["state"]) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const loaded = await lineageTask(deps, taskId, revision, key);
    if (loaded === undefined) return undefined;
    const { task, workflow, artifact } = loaded;
    const prior = workflow.canvasLineage?.find((entry) => entry.key === key);
    if (requireState !== undefined && prior?.state !== requireState) return undefined;
    const next = mutate(prior, artifact);
    if (prior !== undefined && sameJsonContent(prior, next)) return prior;
    const version = typeof task["canvasLineageVersion"] === "number" ? task["canvasLineageVersion"] : 0;
    const written = await deps.store.update({ key: taskKey(taskId), ops: [change.set("workflow", json({ ...workflow, canvasLineage: [...(workflow.canvasLineage ?? []).filter((entry) => entry.key !== key), next], canvasLineageVersion: version + 1 })), change.set("canvasLineageVersion", version + 1)],
      condition: when.and(when.eq("companyId", deps.companyId), when.eq("workflow.revision", revision), when.notExists("closedAt"), versionCondition("canvasLineageVersion", version)) });
    if (written.applied) return next;
  }
  return undefined;
}

export async function threadDocumentLink(deps: ThreadDocumentDeps, task: { taskId: string; title: string }, workflow: WorkflowSnapshot, space: string, tenant: string, page?: string): Promise<{ url?: string; summary?: string[] }> {
  const artifact = workflow.artifacts.filter((entry) => entry.type === workflowDocumentType(workflow)).at(-1);
  if (artifact === undefined) return {};
  const loaded = await loadWorkflowDocument((key) => text(deps.artifacts, key), artifact, {});
  if (loaded === undefined) return {};
  // The retired notifier reads structured plans on the task page, never in a Canvas.
  if (loaded.format === "structured") return page === undefined ? {} : { url: planReviewLink(page, workflow, artifact.version) };
  const summary = documentSummaryLines(loaded.markdown);
  const fallback = { summary, ...(page === undefined ? {} : { url: page }) };
  // The document reader accepts larger plans than Canvas. Keep their approval card
  // on the task page without recording an intent for a create Slack will reject.
  if (!canCreateCanvas(deps, loaded.markdown)) return fallback;
  const key = `${workflow.stage}:${workflow.revision}:${artifact.id}`;
  const prior = workflow.canvasLineage?.find((entry) => entry.key === key);
  if (prior?.state === "CREATE_OUTCOME_UNKNOWN") return fallback;
  if (prior?.state === "CREATED") return { summary, ...(prior.permalink === undefined ? {} : { url: prior.permalink }) };
  const row = (state: WorkflowCanvasLineage["state"], current: WorkflowCanvasLineage | undefined): WorkflowCanvasLineage => ({ key, stage: workflow.stage, workflowRevision: workflow.revision, artifactId: artifact.id, artifactRef: artifact.objectKey, artifactDigest: artifact.sha256, state, createdAt: current?.createdAt ?? new Date(deps.now()).toISOString() });
  const prepared = await mutateLineage(deps, task.taskId, workflow.revision, key, (current) => current !== undefined && current.state !== "CREATE_FAILED" ? current : row("PREPARED", current));
  if (prepared === undefined) throw new Error("Canvas creation intent could not be recorded");
  if (prepared.state === "CREATE_OUTCOME_UNKNOWN" || prepared.state === "CREATED") return fallback;
  const attempting = await mutateLineage(deps, task.taskId, workflow.revision, key, (current) => row("CREATE_OUTCOME_UNKNOWN", current), "PREPARED");
  if (attempting === undefined) throw new Error("Canvas create attempt could not be fenced");
  return createCanvasLink(deps, task, workflow, space, tenant, artifact, key, row, summary, fallback, loaded.markdown);
}

async function createCanvasLink(deps: ThreadDocumentDeps, task: { taskId: string; title: string }, workflow: WorkflowSnapshot, space: string, tenant: string,
  artifact: WorkflowArtifact, key: string, row: (state: WorkflowCanvasLineage["state"], current: WorkflowCanvasLineage | undefined) => WorkflowCanvasLineage,
  summary: string[], fallback: { summary: string[]; url?: string }, markdown: string) {
  let result: { canvasId: string; permalink: string };
  try {
    result = await deps.createPlanCanvas!(deps.companyId, tenant, { channel: space, taskId: task.taskId, title: task.title, version: artifact.version, markdown }, async (canvasId) => {
      const recorded = await mutateLineage(deps, task.taskId, workflow.revision, key, (current) => ({ ...row("CREATED", current), canvasId }));
      if (recorded?.canvasId !== canvasId) throw new Error("created Canvas ID could not be persisted");
    });
  } catch (error) {
    const failure = deps.documentFailure?.(error) ?? { mayHaveLanded: true, unavailable: false };
    const latest = await deps.store.get(taskKey(task.taskId));
    const current = (latest?.["workflow"] as WorkflowSnapshot | undefined)?.canvasLineage?.find((entry) => entry.key === key);
    if (current?.state !== "CREATED") await mutateLineage(deps, task.taskId, workflow.revision, key, (prior) => ({ ...row(failure.mayHaveLanded ? "CREATE_OUTCOME_UNKNOWN" : "CREATE_FAILED", prior), ...(failure.category === undefined ? {} : { errorCategory: failure.category }) }));
    if (failure.unavailable) return fallback;
    throw error;
  }
  const linked = await mutateLineage(deps, task.taskId, workflow.revision, key, (current) => ({ ...row("CREATED", current), canvasId: result.canvasId, permalink: result.permalink }));
  if (linked === undefined) throw new Error("Canvas result could not be recorded");
  return { summary, url: result.permalink };
}

function closeoutValue(workflow: WorkflowSnapshot, field: "canvasCloseout" | "canvasCloseoutAttempt", value: unknown): unknown {
  if (field === "canvasCloseoutAttempt") return value;
  const closeout = value as NonNullable<WorkflowSnapshot["canvasCloseout"]>;
  if (workflow.canvasCloseout !== undefined && workflow.canvasCloseout.manifestDigest !== closeout.manifestDigest) return undefined;
  return { ...closeout, canvases: closeout.canvases.map((canvas) => workflow.canvasCloseout?.canvases.find((prior) => prior.lineageKey === canvas.lineageKey && prior.status === "DELETED") ?? canvas) };
}

export function threadCanvasCloseout(deps: ThreadDocumentDeps, command: ChannelCommandDeps, tenant: string, taskId: string) {
  const manifestPrefix = `private/task-closeouts/${taskId}/`;
  const manifestRead = async (key: string) => {
    if (!key.startsWith(manifestPrefix) || !/^[a-f0-9]{64}\.json$/u.test(key.slice(manifestPrefix.length))) return undefined;
    const bytes = await deps.blobs.get(key, 1_572_864);
    return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
  };
  const save = async (field: "canvasCloseout" | "canvasCloseoutAttempt", value: unknown, revision: number) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const task = await deps.store.get(taskKey(taskId));
      const workflow = task?.["workflow"] as WorkflowSnapshot | undefined;
      if (task?.["companyId"] !== deps.companyId || workflow?.revision !== revision) return false;
      const version = typeof task["canvasCloseoutVersion"] === "number" ? task["canvasCloseoutVersion"] : 0;
      const next = closeoutValue(workflow, field, value);
      if (next === undefined) return false;
      const result = await deps.store.update({ key: taskKey(taskId), ops: [change.set(`workflow.${field}`, json(next)), ...(field === "canvasCloseout" ? [change.remove("workflow.canvasCloseoutAttempt")] : []), change.set("canvasCloseoutVersion", version + 1)],
        condition: when.and(when.eq("companyId", deps.companyId), when.eq("workflow.revision", revision), versionCondition("canvasCloseoutVersion", version)) });
      if (result.applied) return true;
    }
    return false;
  };
  const store: CanvasCloseoutStore = {
    async loadTask(id) { const task = await deps.store.get(taskKey(id)); return task?.["companyId"] === deps.companyId && id === taskId ? task as unknown as TaskCanvasCloseoutTask : undefined; },
    readArtifact: (ref) => text(deps.artifacts, ref.objectKey), readManifest: manifestRead,
    async putManifest(key, digest, bytes) {
      if (key !== `${manifestPrefix}${digest}.json`) throw new Error("Canvas manifest binding changed");
      try { await deps.blobs.put(key, new TextEncoder().encode(bytes), { contentType: "application/json", metadata: { sha256: digest }, retention: "evidence-std" }); }
      catch (error) { if (await manifestRead(key) !== bytes) throw error; }
    },
    saveCloseout: (_id, value, revision) => save("canvasCloseout", value, revision),
    saveCloseoutAttempt: (_id, value, revision) => save("canvasCloseoutAttempt", value, revision),
    deleteCanvas: async (documentId) => (await sendChannelCommand(command, "delete_document", { tenant, documentId })).deleted ? "deleted" : "unknown",
    now: () => new Date(deps.now()).toISOString(),
  };
  return runTaskCanvasCloseout(store, { taskId });
}
