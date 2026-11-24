import { z } from "zod";
import { WorkspaceDataIdentitySchema, WorkspaceClosePreflightResultSchema, type CloseRetention, type WorkspaceDataIdentity, type MachineHealth, type TransactItem, change, when, type TaskCloseAction, type TaskClosePreviewResponse } from "@agentx/contracts";
import { buildTaskClosePreview } from "../../developer/task-close-preview.js";
import type { TaskCaller, TaskFlowDeps } from "./deps.js";
import { loadOwnedTask, workspaceOperations } from "./reads.js";
import { deriveTaskStatus } from "../../developer/task-records.js";
import type { OperationRecord, TaskRecord, TaskPointerRecord } from "./records.js";
import { isTerminalStatus, readOperation } from "./results.js";
import { readWorkspace } from "./stage-machine.js";
import { workspaceKeys } from "./workspace-location.js";
import { preparationDeliveryItem } from "./close-preparation.js";
import { toDocument } from "./records.js";

/** Internal approved retained-inspection port. A journal high-water barrier alone cannot implement this contract. */
export interface CloseInspectionIdentity { workspaceId: string; operationId: string; fence: number }
export interface RetainedCloseInspection extends CloseInspectionIdentity { retentionId: string; retentionProof?: { schemaVersion: 1; generation: WorkspaceDataIdentity } | undefined }
export interface CloseInspectionProvider {
  ready?(workspaceId: string, live?: boolean): Promise<boolean>;
  /**
   * What a check of this workspace needs, from the session item alone (no machine is touched): `ready` the machine is up and its worker is known to retain; `wake` its instance is gone (stopped or stopping)
   * and the volume is kept, so a preparation must start it first; `unsupported` a check can never run (an old worker, a session that is failed, starting or gone).
   */
  availability?(workspaceId: string): Promise<"ready" | "wake" | "unsupported">;
  /** Dispatcher only. Starts the machine of a stopped workspace (idempotent; the workspace's machine already exists, so this admits no new machine). `ready` once it is up and its runtime is noted; `waking` while it starts; `gone` when there is no session to start. */
  wake?(workspaceId: string): Promise<"ready" | "waking" | "gone">;
  noteRuntime?(workspaceId: string, health: MachineHealth, operation?: OperationRecord): Promise<void>;
  /**
   * Dispatcher only. A step took over a retention the broker never confirmed: asks the worker to replay that retain (same preflight, same fence, same target, so the worker answers from its journal) and returns the
   * retention it answered, when it did seal and answer. Undefined when it answered anything else (it never sealed, it cannot prove the seal): the step then goes without a selector, which the worker admits only over
   * a retention it never answered.
   */
  replayRetention?(workspaceId: string, unconfirmed: NonNullable<OperationRecord["supersedesUnconfirmed"]>): Promise<CloseRetention | undefined>;
  acceptanceItems?(input: RetainedCloseInspection & { contentDigest: string }, acceptedOperationId: string): TransactItem[];
  /** DEC 290's durable, monotonic journal barrier, before inspection. */
  raiseFence(workspaceId: string, fence: number): Promise<void>;
  /** Inspect under exclusive retention; exclude live, delayed, same-fence and external writers through restart and deletion. */
  inspectWorkspaceForClose(input: CloseInspectionIdentity): Promise<{ inspection: unknown; retentionId: string; retentionProof?: { schemaVersion: 1; generation: WorkspaceDataIdentity } }>;
  /** Read-only proof that this exact retained content still exists exclusively, including after restart. Never reacquire or inspect here. */
  retained(input: RetainedCloseInspection & { contentDigest: string }): Promise<boolean>;
  /** Destroy ONLY this retained content and its immutable machines under exclusive ownership.
   * Persist an effect-id tombstone: retry after deletion/restart returns true for the SAME effect,
   * without touching newer content. False (or missing adapter) keeps accepted work held.
   * A read followed by unguarded deletion cannot implement this internal effect port. */
  destroyRetained?(input: RetainedCloseInspection & { contentDigest: string; effectId: string; machineIds: readonly string[] }): Promise<boolean>;
}
export const CloseInspectionSchema = WorkspaceClosePreflightResultSchema.safeExtend({
  retentionProof: z.object({ schemaVersion: z.literal(1), generation: WorkspaceDataIdentitySchema }).strict().optional(),
  schemaVersion: z.literal(1), retentionId: z.string().min(1).max(128),
  workspaceId: z.string().uuid(), operationId: z.string().uuid(), fence: z.number().int().nonnegative(),
  contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
const unavailable = (): TaskClosePreviewResponse => ({ preview: null, unavailable: "inspection_required" });

/** Preparation is separate from preview/confirmation. Only an already-claimed close-preflight operation can receive the result. */
export async function prepareCloseInspection(deps: TaskFlowDeps, workspaceId: string, operationId: string): Promise<boolean> {
  const provider = deps.closeInspection;
  if (provider === undefined) return false;
  try {
    const workspace = await readWorkspace(deps, workspaceId), operation = await readOperation(deps, workspaceId, operationId);
    if (workspace === undefined || workspace.legacyCloseClaim !== undefined || operation?.kind !== "close" || operation.status !== "RUNNING" || workspace.activeOperationId !== operationId || workspace.fence !== operation.fence) return false;
    const identity = { workspaceId, operationId, fence: workspace.fence };
    await provider.raiseFence(workspaceId, workspace.fence);
    const inspected = await provider.inspectWorkspaceForClose(identity);
    const parsed = WorkspaceClosePreflightResultSchema.parse(inspected.inspection);
    const result = CloseInspectionSchema.parse({ ...parsed, ...identity, schemaVersion: 1, retentionId: inspected.retentionId, ...(inspected.retentionProof === undefined ? {} : { retentionProof: inspected.retentionProof }) });
    result.repositories.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const repo of result.repositories) repo.reasons.sort();
    if (!await provider.retained(result)) return false;
    const location = await workspaceKeys(deps, workspaceId);
    return (await deps.store.transact([
      { kind: "check", key: location.workspaceKey, condition: when.and(when.notExists("legacyCloseClaim"), when.eq("fence", workspace.fence), when.eq("activeOperationId", operationId), when.eq("status", workspace.status), when.eq("ownerKey", workspace.ownerKey), when.eq("companyId", deps.companyId)) },
      { kind: "update", key: location.operationKey(operationId), condition: when.and(when.eq("kind", "close"), when.eq("status", "RUNNING"), when.eq("fence", workspace.fence), when.eq("companyId", deps.companyId), when.eq("workspaceId", workspaceId)), ops: [change.set("status", "SUCCEEDED"), change.set("result", toDocument({ closeInspection: result }))] },
      ...(operation.closePreflight === undefined ? [] : [preparationDeliveryItem(deps, operation)]),
    ])).applied;
  } catch { return false; }
}

/** One retained read set, shared by the preview and its atomic acceptance predicates. */
export async function readCloseSnapshot(deps: TaskFlowDeps, caller: TaskCaller, task: TaskRecord, action: TaskCloseAction) {
  if (deps.closeInspection === undefined) return undefined;
  const workspace = await readWorkspace(deps, task.workspaceId);
  if (workspace === undefined || workspace.legacyCloseClaim !== undefined || workspace.activeOperationId === null) return undefined;
  const location = await workspaceKeys(deps, workspace.id);
  const [operations, pointer] = await Promise.all([workspaceOperations(deps, workspace.id), deps.store.get(location.taskPointerKey())]);
  const operation = operations.find((op) => op.id === workspace.activeOperationId);
  if (operation?.kind !== "close" || operation.status !== "SUCCEEDED" || operation.fence !== workspace.fence) return undefined;
  if (operation.companyId !== deps.companyId || operation.workspaceId !== workspace.id) return undefined;
  const result = CloseInspectionSchema.safeParse((operation.result as { closeInspection?: unknown } | undefined)?.closeInspection);
  if (!result.success || result.data.workspaceId !== workspace.id || result.data.operationId !== operation.id || result.data.fence !== workspace.fence) return undefined;
  if (!await deps.closeInspection.retained(result.data)) return undefined;
  const status = deriveTaskStatus({ closedAt: task.closedAt, workspaceStatus: workspace.status, pointer: pointer as unknown as TaskPointerRecord | undefined, operations });
  const preview = buildTaskClosePreview({
    companyId: deps.companyId, actorId: caller.principal.personId, workspaceId: workspace.id,
    action, taskId: task.taskId, taskStatus: status.status,
    workflow: task.workflow === undefined ? null : { revision: task.workflow.revision, stage: task.workflow.stage, state: task.workflow.state },
    workspace: { status: workspace.status, fence: workspace.fence, activeOperationId: workspace.activeOperationId },
    unpublished: result.data.repositories.map((r) => ({ repository: r.name, reasons: r.reasons })),
    inspection: { operationId: operation.id, workspaceFence: workspace.fence, contentDigest: result.data.contentDigest },
  });
  return { task, workspace, location, operations, pointer, inspection: result.data, operation, preview };
}
export type CloseSnapshot = NonNullable<Awaited<ReturnType<typeof readCloseSnapshot>>>;

/**
 * Why there is no preview, said truthfully: `busy` while a step of the task is running and the install can inspect at all (the person stops it or waits; the dialog fails closed on it), `inspection_required` for everything else (no provider, a stopped
 * machine, no inspection yet, a closed task, an unreadable record: unknown is never an empty list or a digest). `unsupported` is not emitted here: it would switch a client to its legacy path.
 */
async function unavailableFor(deps: TaskFlowDeps, task: TaskRecord): Promise<TaskClosePreviewResponse> {
  try {
    // Without the provider there is nothing to wait for: a person stops the step or not, and the check still cannot be made.
    if (task.closedAt !== undefined || deps.closeInspection === undefined) return unavailable();
    const workspace = await readWorkspace(deps, task.workspaceId);
    if (workspace === undefined || workspace.activeOperationId === null) return unavailable();
    const holder = await readOperation(deps, workspace.id, workspace.activeOperationId);
    return holder !== undefined && holder.kind !== "close" && !isTerminalStatus(holder.status) ? { preview: null, unavailable: "busy" } : unavailable();
  } catch { return unavailable(); }
}

/** Read-only projection for GET. Missing proof never becomes an empty unpublished list or a usable digest. */
export async function previewTaskClose(deps: TaskFlowDeps, caller: TaskCaller, taskId: string, action: TaskCloseAction): Promise<TaskClosePreviewResponse> {
  const task = await loadOwnedTask(deps, caller, taskId);
  try {
    const snapshot = await readCloseSnapshot(deps, caller, task, action);
    return snapshot === undefined ? await unavailableFor(deps, task) : { preview: snapshot.preview };
  } catch { return await unavailableFor(deps, task); }
}
