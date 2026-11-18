// Lead 4, slice A4: a task flow on the W0 fakes that can write work events, and a scripted task (start, plan, a request for changes, a second plan, the approval) the tests run with the events on and off.
// The store is wrapped so every transaction is recorded: the golden test compares what the flow writes with and without events.
import { randomUUID } from "node:crypto";
import { decideWorkflow, type DocumentStore, type OrgId, type TransactItem, type WorkerInvocation } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { MemoryQueueService } from "../../packages/broker/src/ports/memory-queue.js";
import { dispatchRowItem } from "../../packages/broker/src/core/task-flow/dispatch-rows.js";
import { workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { readTask } from "../../packages/broker/src/core/task-flow/reads.js";
import type { WorkspaceRecord } from "../../packages/broker/src/core/task-flow/records.js";
import { TASK_FLOW_INDEXES } from "../../packages/broker/src/core/task-flow/flow.js";
import { commitWorkflow, planFeedbackKey, runDispatchRow } from "../../packages/broker/src/core/task-flow/stage-machine.js";
import { reportStartItems } from "../../packages/broker/src/core/report/task-row.js";
import { flowWorkEventItems } from "../../packages/broker/src/core/work-events/flow-events.js";
import { listWorkEvents } from "../../packages/broker/src/core/work-events/work-events.js";
import { COMPANY, createHarness, newRequestId, type Harness } from "./task-flow-harness.js";

export interface RecordedStore { store: DocumentStore; log: TransactItem[][] }

/** A memory store that keeps every transaction it was asked to apply. */
export function recordingStore(clock: { now: number }): RecordedStore {
  const inner = new MemoryDocumentStore({ indexes: TASK_FLOW_INDEXES, nowSeconds: () => Math.floor(clock.now / 1_000) });
  const log: TransactItem[][] = [];
  const store = new Proxy(inner, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (property === "transact") return (items: TransactItem[]) => { log.push([...items]); return target.transact(items); };
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as unknown as DocumentStore;
  return { store, log };
}

export const isEventItem = (item: TransactItem): boolean => item.kind === "put" && String((item as { item: { pk: string } }).item.pk).includes("#WORK_EVENTS#");

export interface EventWorld {
  h: Harness;
  recorded: RecordedStore;
  taskId: string;
  machineId: string;
  finish(invocation: WorkerInvocation, outcome: Record<string, unknown>): Promise<void>;
  planned(round: number): Record<string, unknown>;
  last(): WorkerInvocation;
  workflow(): Promise<NonNullable<Awaited<ReturnType<typeof readTask>>>["workflow"]>;
  /** The owner's decision, as the gate commits it: the engine's transition, then the row that starts the next step. */
  decide(round: number, decision: "APPROVE" | "REQUEST_CHANGES", words: string): Promise<void>;
  events(): Promise<Awaited<ReturnType<typeof listWorkEvents>>["events"]>;
  /** The planning run a request for changes queued: started and delivered to the machine. */
  replan(): Promise<void>;
}

const DIGEST = (round: number): string => String(round).repeat(64);

async function drain(h: Harness, rounds = 12): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    if ((await h.flow.dispatchOnce({ maxMessages: 10 })).received === 0) return;
    h.clock.advance(70);
  }
}

/** A task whose first plan waits for its owner. The flow writes work events when `workEvents` is true, with the start's own events joined the way the core runtime joins them. */
export async function planWaiting(options: { workEvents: boolean; companyId?: OrgId; project?: string }): Promise<EventWorld> {
  const companyId = options.companyId ?? COMPANY;
  let recorded!: RecordedStore;
  const h = createHarness({
    companyId, understandFirst: false, machines: { startingChecks: 0 },
    backend: (clock) => { recorded = recordingStore(clock); return { store: recorded.store, queues: new MemoryQueueService({ now: () => clock.now }) }; },
    extra: () => ({
      ...(options.workEvents ? { workEvents: true } : {}),
      // The report's start row, joined to the start the way the core runtime joins it (the work events of the start are the flow's own).
      startExtras: (input) => ({ items: reportStartItems({ companyId, taskId: input.taskId, project: input.project, title: input.title, origin: input.origin, purpose: input.purpose, receivedAt: input.receivedAt }) }),
    }),
  });
  await h.registerProject();
  const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: options.project ?? "payments", instructions: "Add a /health endpoint", workflow: true, workflowPath: "QUICK" });
  await drain(h);
  const workspace = (await h.store.get(workspaceKey(companyId, started.task.workspaceId))) as unknown as WorkspaceRecord;
  const machineId = workspace.machine!.machineId;
  let fence = 1;
  const taskId = started.task.taskId;
  const last = (): WorkerInvocation => h.machines.delivered(machineId).at(-1)!;
  const finish = async (invocation: WorkerInvocation, outcome: Record<string, unknown>): Promise<void> => {
    h.machines.finish(machineId, invocation.operationId);
    await h.flow.recordResult({ workspaceId: workspace.id, operationId: invocation.operationId, fence, status: "SUCCEEDED", outcome } as never);
    fence += 1;
    await drain(h);
  };
  const planned = (round: number): Record<string, unknown> => ({ kind: "planned", artifact: { id: `plan-${round}`, type: "plan", version: round, sha256: DIGEST(round), producer: "agentx-worker-untrusted", objectKey: `tasks/${taskId}/plan-${round}.md`, createdAt: h.deps.now!().toISOString() } });
  await finish(last(), { kind: "prepared" });
  await finish(last(), planned(1));
  const world: EventWorld = {
    h, recorded, taskId, machineId, finish, planned, last,
    workflow: async () => (await readTask(h.deps, taskId))!.workflow,
    async decide(round, decision, words) {
      const task = (await readTask(h.deps, taskId))!;
      const now = h.deps.now!().toISOString();
      const next = decideWorkflow(task.workflow, { requestId: randomUUID(), expectedRevision: task.workflow!.revision, decision, reason: words, artifactDigest: DIGEST(round) }, { actorId: task.workflow!.ownerId, role: "TASK_OWNER" }, { now, allowedSkipStages: [] });
      const row = decision === "APPROVE" ? dispatchRowItem(h.deps, taskId, next.revision, "IMPLEMENT", now) : dispatchRowItem(h.deps, taskId, next.revision, "PLAN", now);
      const extra: TransactItem[] = decision === "REQUEST_CHANGES" ? [{ kind: "put", item: { ...planFeedbackKey(taskId, next.revision), entityType: "PLAN_FEEDBACK", text: words, createdAt: now } }, row] : [row];
      // The decision service adds the events of the decision; here the same helper is called the way `onDecided` calls it.
      extra.push(...flowWorkEventItems({ enabled: h.deps.workEvents, orgId: companyId, project: task.project, before: task.workflow, after: next, room: 50 }));
      if (!(await commitWorkflowRaw(h, task, next, extra))) throw new Error("the decision did not commit");
    },
    async replan() {
      const queued = (await world.workflow())!;
      if ((await runDispatchRow(h.deps, { taskId, workflowRevision: queued.revision, kind: "PLAN" })) !== "STARTED") throw new Error("the planning run did not start");
      await drain(h);
    },
    events: async () => (await listWorkEvents(h.store, { orgId: companyId, from: "2026-01-01T00:00:00.000Z", to: "2027-12-31T00:00:00.000Z" })).events,
  };
  return world;
}

/** `commitWorkflow` adds the transition's events itself; a decision's events are added by the decision service, so a decision is committed with the events already in `extra` and none added twice. */
async function commitWorkflowRaw(h: Harness, task: NonNullable<Awaited<ReturnType<typeof readTask>>>, next: Parameters<typeof commitWorkflow>[2], extra: TransactItem[]): Promise<boolean> {
  const saved = h.deps.workEvents;
  h.deps.workEvents = false;
  try { return await commitWorkflow(h.deps, task, next, extra); } finally { if (saved !== undefined) h.deps.workEvents = saved; }
}

