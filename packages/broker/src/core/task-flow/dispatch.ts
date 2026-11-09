// Lane L6a, task flow core: dispatching operations to worker machines. The consumer of the dispatch queue: for each message it finds the
// operation, makes sure the workspace's machine is running and ready, builds the worker's invocation (with a repository grant and a callback
// capability issued now, not when the operation was accepted, so a delivery that waits for a machine never carries an expired one) and hands it to
// the machine through the `WorkerMachines` port. The worker's answer comes back through the broker's callback API, not through this module.
//
// At least once, and idempotent: the queue may deliver a message twice, a crash can follow the delivery, and `deliver` is idempotent on the
// operation id. The consumer therefore only moves an operation forward and never undoes a state a result has set.
import {
  AGENTX_PROTOCOL_VERSION,
  AgentXError,
  MachineError,
  WorkerInvocationSchema,
  change,
  when,
  workerProjectDefinition,
  type Queue,
  type ReceivedMessage,
  type WorkerInvocation,
} from "@agentx/contracts";
import { CallbackCapabilities, type CallbackAction } from "../../callbacks.js";
import { admit, releaseAdmission } from "./admission.js";
import type { DispatchMessage } from "./accept.js";
import type { TaskFlowDeps } from "./deps.js";
import { operationKey, workspaceKey } from "./keys.js";
import { isTerminalStatus, readOperation, recordOperationResult } from "./results.js";
import { readWorkspace } from "./stage-machine.js";
import { dispatchQueueName, iso, log } from "./support.js";
import type { OperationRecord, WorkspaceRecord } from "./records.js";

/** How long a capability the worker is given lives: nine hours, as Cloud's. */
const CAPABILITY_SECONDS = 32_400;
/** After this many deliveries of one message the operation is given up on: the machine never became usable. */
export const DISPATCH_ATTEMPTS_MAX = 20;
const BASE_ACCESS_ACTIONS = ["artifacts", "events", "result"] as const;

export interface DispatchReport {
  received: number;
  delivered: number;
  /** Put back on the queue to try again after a delay (the machine is starting, busy, or not reachable yet). */
  retried: number;
  /** The operation was ended as failed. */
  failed: number;
  /** Nothing to do: a repeat, an operation already ended, or a message that is not ours. */
  dropped: number;
}

const retryDelay = (receiveCount: number): number => Math.min(60, 2 ** Math.min(receiveCount, 6));

function parseMessage(body: unknown): DispatchMessage | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const value = body as Record<string, unknown>;
  return value.v === 1 && typeof value.workspaceId === "string" && typeof value.operationId === "string" ? { v: 1, workspaceId: value.workspaceId, operationId: value.operationId } : undefined;
}

/** Receives up to `maxMessages` dispatch messages and handles each. */
export async function runDispatchOnce(deps: TaskFlowDeps, options: { maxMessages?: number; waitSeconds?: number } = {}): Promise<DispatchReport> {
  const report: DispatchReport = { received: 0, delivered: 0, retried: 0, failed: 0, dropped: 0 };
  const queue = await deps.queues.queue(dispatchQueueName(deps));
  const messages = await queue.receive({ maxMessages: options.maxMessages ?? 5, ...(options.waitSeconds === undefined ? {} : { waitSeconds: options.waitSeconds }) });
  for (const message of messages) {
    report.received += 1;
    let outcome: keyof Omit<DispatchReport, "received">;
    try {
      outcome = await handleDispatch(deps, queue, message);
    } catch (error) {
      // A fault we did not model (the store is unreachable): the message comes back after its visibility timeout.
      log(deps, { event: "task_flow.dispatch_fault", error: error instanceof Error ? error.name : "unknown" });
      outcome = "retried";
    }
    report[outcome] += 1;
  }
  return report;
}

async function handleDispatch(deps: TaskFlowDeps, queue: Queue, message: ReceivedMessage): Promise<keyof Omit<DispatchReport, "received">> {
  const body = parseMessage(message.body);
  if (body === undefined) {
    await queue.deadLetter(message.receiptHandle, "malformed");
    return "dropped";
  }
  const operation = await readOperation(deps, body.workspaceId, body.operationId);
  if (operation === undefined || operation.companyId !== deps.companyId) {
    // The operation commits with its message, so a message with none is not ours or is corrupt: set it aside for a person to look at.
    await queue.deadLetter(message.receiptHandle, "operation_missing");
    return "dropped";
  }
  // Already ended, or a cancel is in flight: nothing to deliver.
  if (isTerminalStatus(operation.status) || operation.status === "CANCEL_REQUESTED") {
    await queue.ack(message.receiptHandle);
    return "dropped";
  }
  const workspace = await readWorkspace(deps, operation.workspaceId);
  if (workspace === undefined || workspace.fence !== operation.fence || workspace.activeOperationId !== operation.id || workspace.status === "CLOSED" || workspace.status === "CLOSING") {
    // The workspace has moved on (closed, or taken by a newer hold): this job is no longer wanted.
    await endOperation(deps, operation, "INTERRUPTED", "the workspace no longer waits for this job");
    await queue.ack(message.receiptHandle);
    return "failed";
  }
  if (message.receiveCount > DISPATCH_ATTEMPTS_MAX) {
    await endOperation(deps, operation, "FAILED", "the worker machine did not become ready in time");
    await queue.ack(message.receiptHandle);
    return "failed";
  }

  let reservationId: string | undefined;
  try {
    // A machine that does not exist yet is new spend: ask admission once, before it starts (a refusal ends the operation with the adapter's own sentence).
    if (workspace.machine === undefined) reservationId = (await admit(deps, { idempotencyKey: `machine.start:${workspace.id}`, action: "machine.start", projectName: workspace.projectName, subject: { type: "workspace", id: workspace.id } })).reservationId;
  } catch (error) {
    if (error instanceof AgentXError) {
      await endOperation(deps, operation, "FAILED", error.message.replace(`${error.code}: `, ""));
      await queue.ack(message.receiptHandle);
      return "failed";
    }
    throw error;
  }

  let started = false;
  try {
    const handle = await deps.machines.start({ machineKey: workspace.id, companyId: deps.companyId, projectName: workspace.projectName, labels: { workspaceId: workspace.id } });
    started = true;
    await rememberMachine(deps, workspace, handle, reservationId);
    const health = await deps.machines.health(handle.machineId);
    if (health.state !== "ready" && health.state !== "busy") {
      // Starting, stopping, stopped (the start above wakes it) or unhealthy: try again shortly.
      await queue.changeVisibility(message.receiptHandle, retryDelay(message.receiveCount));
      return "retried";
    }
    const invocation = await buildInvocation(deps, operation, workspace, health.features);
    if (typeof invocation === "string") {
      await endOperation(deps, operation, "FAILED", invocation);
      await queue.ack(message.receiptHandle);
      return "failed";
    }
    await deps.machines.deliver(handle.machineId, invocation);
    await markDispatching(deps, operation, handle.machineId);
    await queue.ack(message.receiptHandle);
    return "delivered";
  } catch (error) {
    // Only a machine that never started gives its allowance back; one that did keeps it (the same key asks again on the next try).
    if (!started) await releaseAdmission(deps, reservationId);
    if (error instanceof MachineError) {
      switch (error.code) {
        case "not_ready":
        case "unavailable":
          await queue.changeVisibility(message.receiptHandle, retryDelay(message.receiveCount));
          return "retried";
        case "not_found":
          // The machine is gone: forget it, and the next try starts another.
          await forgetMachine(deps, workspace);
          await queue.changeVisibility(message.receiptHandle, 0);
          return "retried";
        case "unauthorized":
        case "rejected":
          await endOperation(deps, operation, "FAILED", error.code === "rejected" ? "the worker refused the job" : "the worker refused the job's credentials");
          await queue.ack(message.receiptHandle);
          return "failed";
      }
    }
    throw error;
  }
}

/** Builds the worker's invocation, or a sentence saying why this operation cannot be sent to this worker. */
async function buildInvocation(deps: TaskFlowDeps, operation: OperationRecord, workspace: WorkspaceRecord, features: readonly string[]): Promise<WorkerInvocation | string> {
  const spec = operation.dispatch;
  const missing = (spec.requires ?? []).filter((feature) => !features.includes(feature));
  // A step whose tool boundary the worker cannot enforce is refused, never sent without it: a read-only step must stay read-only.
  if (missing.length > 0) return "this worker is too old to run this step; upgrade it";
  const secret = Buffer.from(deps.callbackSigningKey);
  const capability = new CallbackCapabilities(secret).issue({
    workspaceId: workspace.id, operationId: operation.id, fence: operation.fence,
    actions: [...BASE_ACCESS_ACTIONS, ...(spec.extraActions ?? [])] as CallbackAction[], expiresInSeconds: CAPABILITY_SECONDS,
  });
  let payload: Record<string, unknown> = { ...spec.payload };
  if (spec.kind === "prepare") {
    const project = await deps.projects.revision(workspace.projectName, workspace.projectRevision);
    if (project === undefined) return "the project revision this task was started on is gone";
    payload = {
      ...payload,
      project: workerProjectDefinition(project.definition),
      repositoryGrant: deps.repositoryGrants.issue({
        ownerKey: workspace.ownerKey, projectName: workspace.projectName, workspaceId: workspace.id, operationId: operation.id,
        repositories: project.definition.repositories.map((repository) => ({ credentialRef: repository.credentialRef, repositoryUrl: repository.url, access: "clone" as const })),
      }),
    };
  }
  const parsed = WorkerInvocationSchema.safeParse({
    protocolVersion: AGENTX_PROTOCOL_VERSION, kind: spec.kind, operationId: operation.id, workspaceId: workspace.id, fence: operation.fence,
    projectRevision: spec.projectRevision, callbackCapability: capability, payload,
  });
  return parsed.success ? parsed.data : "the job could not be built for the worker";
}

async function rememberMachine(deps: TaskFlowDeps, workspace: WorkspaceRecord, handle: { machineId: string; machineKey: string }, reservationId: string | undefined): Promise<void> {
  if (workspace.machine?.machineId === handle.machineId) return;
  await deps.store.update({
    key: workspaceKey(workspace.id),
    // The reservation is kept with the machine so the path that stops it can settle it.
    ops: [change.set("machine", { machineId: handle.machineId, machineKey: handle.machineKey }), ...(reservationId === undefined ? [] : [change.set("machineReservationId", reservationId)])],
    condition: when.eq("fence", workspace.fence),
  });
}

async function forgetMachine(deps: TaskFlowDeps, workspace: WorkspaceRecord): Promise<void> {
  await deps.store.update({ key: workspaceKey(workspace.id), ops: [change.remove("machine")], condition: when.and(when.eq("fence", workspace.fence), when.exists("machine")) });
}

/** The operation was handed to the machine. A worker that reported RUNNING already keeps its newer state (the condition does not hold, which is fine). */
async function markDispatching(deps: TaskFlowDeps, operation: OperationRecord, machineId: string): Promise<void> {
  await deps.store.update({
    key: operationKey(operation.workspaceId, operation.id),
    ops: [change.set("status", "DISPATCHING"), change.set("machineId", machineId), change.set("deliveredAt", iso(deps)), change.set("updatedAt", iso(deps))],
    condition: when.eq("status", "ACCEPTED"),
  });
}

/** Ends an operation the worker will never answer, through the same path a worker's result takes. */
async function endOperation(deps: TaskFlowDeps, operation: OperationRecord, status: "FAILED" | "INTERRUPTED", error: string): Promise<void> {
  try {
    await recordOperationResult(deps, { workspaceId: operation.workspaceId, operationId: operation.id, fence: operation.fence, status, error });
  } catch (cause) {
    if (!(cause instanceof AgentXError)) throw cause;
    log(deps, { event: "task_flow.end_operation_refused", code: cause.code });
  }
}
