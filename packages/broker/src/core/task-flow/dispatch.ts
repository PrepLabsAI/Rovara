import { validateFeedbackApproval } from "../pr-feedback/fix-context.js";
import { workspaceKeys } from "./workspace-location.js";
import { acceptedCloseForRun, closeDeliveryReceipt, readAcceptedClose, retireCloseDelivery } from "./close-recovery-state.js";
// Lane L6a, task flow core: dispatching operations to worker machines. The consumer of the dispatch queue: for each message it finds the
// operation, makes sure the workspace's machine is running and ready, builds the worker's invocation (with a repository grant and a callback
// capability issued now, not when the operation was accepted, so a delivery that waits for a machine never carries an expired one) and hands it to
// the machine through the `WorkerMachines` port. The worker's answer comes back through the broker's callback API, not through this module.
//
// At least once, and idempotent: the queue may deliver a message twice, a crash can follow the delivery, and `deliver` is idempotent on the
// operation id. The consumer therefore only moves an operation forward and never undoes a state a result has set.
import {
  CORE_DISPATCH_CLAIM_STALE_MS,
  AGENTX_PROTOCOL_VERSION,
  IMPLICIT_COMPANY_ID,
  OrgIdSchema,
  EVAL_GATEWAY_FEATURE, EVAL_PLAN_DELIVERY_ACTION, EVAL_PROMPT_LOCATIONS_FEATURE, EvalGatewayOriginSchema, EVAL_ROUND_FEATURE, KNOWLEDGE_CONTEXT_FEATURE, ROVARA_SKILLS_FEATURE,
  AGENT_WORKER_OUTDATED,
  AgentXError,
  MachineError,
  STANDING_INSTRUCTIONS_FEATURE,
  USAGE_CHECKPOINTS_FEATURE,
  WorkerInvocationSchema,
  change,
  when,
  workerProjectDefinition,
  projectUseRefusal,
  type ProjectDefinition,
  PREPARE_EGRESS_S3_FEATURE,
  projectAllowedS3Hosts,
  workflowPublicationContext,
  workflowPublicationContextDigest,
  type JsonValue,
  type Queue,
  type ReceivedMessage,
  type StandingInstructionsPayload,
  type WorkerInvocation,
  type WorkflowDependencyInvocation,
} from "@agentx/contracts";
import { serialWorkerCanResume } from "../work-breakdown/parallel-parts.js";
import { CallbackCapabilities, type CallbackAction } from "../../callbacks.js";
import { admit, releaseAdmission } from "./admission.js";
import { runWatchItem } from "./run-watch-rows.js";
import { beforeMachine, savedEnvBuildFields } from "./saved-env-lease-step.js";
import type { DispatchMessage } from "./accept.js";
import type { TaskFlowDeps } from "./deps.js";
import { registriesForPrepare } from "../project-registries/prepare.js";
import { testServicesMissingWords } from "../test-env/seam.js";
import { RUN_START_ACTION, cancelInvocation, isSpendStopCode, queuedCancelOf, spendStopReason } from "./money-stop.js";
import { isTerminalStatus, readOperation, recordOperationResult } from "./results.js";
import { readWorkspace } from "./stage-machine.js";
import { dispatchQueueName, iso, log } from "./support.js";
import type { OperationRecord, WorkspaceRecord } from "./records.js";
import type { PlaybookMode } from "../playbook/service.js";
import { invocationTooBigForWiki, wikiContextForStep } from "./wiki-step.js";
import { chooseStepModel, heldStepModel, type OperationModelChoice, type StepModelOutcome } from "./step-model.js";

/** How long a capability the worker is given lives: nine hours, as Cloud's. */
const CAPABILITY_SECONDS = 32_400;
/** A queued cancel is tried this many times on a machine that is not ready. */
const CANCEL_DELIVERY_ATTEMPTS = 5;
const CLOSE_DELIVERY_ATTEMPTS = 5;
/** After this many deliveries of one message the operation is given up on: the machine never became usable. */
export const DISPATCH_ATTEMPTS_MAX = 20;
/** The reason a run is ended with when its machine never became usable (merge of "the start was tried until its budget ran out"). */
export const DISPATCH_EXHAUSTED_ERROR = "the worker machine did not become ready in time";
const claimTimeField = (operation: OperationRecord): "deliveredAt" | "updatedAt" => operation.deliveredAt === undefined ? "updatedAt" : "deliveredAt";
const staleDispatch = (deps: TaskFlowDeps, operation: OperationRecord): boolean =>
  Date.parse(operation[claimTimeField(operation)]!) < Date.parse(iso(deps)) - CORE_DISPATCH_CLAIM_STALE_MS;

const workerHasClaim = (deps: TaskFlowDeps, operation: OperationRecord): boolean =>
  operation.status === "RUNNING" || (operation.status === "DISPATCHING" && !staleDispatch(deps, operation));

/** Keep the same message beyond freshness. The hosted batch cannot enqueue,
 * and must report this record as a batch failure so Lambda does not delete it. */
async function settleWorkerDuplicate(deps: TaskFlowDeps, queue: Queue, message: ReceivedMessage, operation: OperationRecord, delivery: DeliveryLog): Promise<Outcome> {
  if (operation.status === "DISPATCHING") {
    delivery.decision = "dispatch-fault";
    const remaining = Date.parse(operation[claimTimeField(operation)]!) + CORE_DISPATCH_CLAIM_STALE_MS - Date.parse(iso(deps));
    if (!Number.isFinite(remaining)) {
      log(deps, { event: "task_flow.dispatch_claim_invalid", operationId: operation.id });
      throw new Error("invalid dispatch claim timestamp");
    }
    const seconds = Math.min(43_200, Math.max(1, Math.ceil(remaining / 1_000) + 1));
    if (!(await queue.changeVisibility(message.receiptHandle, seconds))) throw new Error("dispatch deferral not retained");
    delivery.decision = "defer-fresh-duplicate";
    return "retried";
  }
  await queue.ack(message.receiptHandle);
  return "dropped";
}

const BASE_ACCESS_ACTIONS = ["artifacts", "events", "result"] as const;

export interface DispatchReport {
  received: number;
  /** Foreign messages released without any record read, acknowledgement or dead-letter. */
  foreign: number;
  delivered: number;
  /** Put back on the queue to try again after a delay (the machine is starting, busy, or not reachable yet). */
  retried: number;
  /** The operation was ended as failed. */
  failed: number;
  /** Nothing to do: a repeat, an operation already ended, or a message that is not ours. */
  dropped: number;
}

const retryDelay = (receiveCount: number): number => Math.min(60, 2 ** Math.min(receiveCount, 6));

function parseMessage(body: unknown): (Omit<DispatchMessage, "companyId"> & { companyId: unknown }) | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const value = body as Record<string, unknown>;
  return value.v === 1 && typeof value.workspaceId === "string" && typeof value.operationId === "string" ? { v: 1, workspaceId: value.workspaceId, operationId: value.operationId, companyId: Object.hasOwn(value, "companyId") ? value.companyId : IMPLICIT_COMPANY_ID } : undefined;
}

/** Receives up to `maxMessages` dispatch messages and handles each. */
export async function runDispatchOnce(deps: TaskFlowDeps, options: { maxMessages?: number; waitSeconds?: number } = {}): Promise<DispatchReport> {
  const report: DispatchReport = { received: 0, foreign: 0, delivered: 0, retried: 0, failed: 0, dropped: 0 };
  const queue = await deps.queues.queue(dispatchQueueName(deps));
  const messages = await queue.receive({ maxMessages: options.maxMessages ?? 5, ...(options.waitSeconds === undefined ? {} : { waitSeconds: options.waitSeconds }) });
  for (const message of messages) {
    report.received += 1;
    let outcome: keyof Omit<DispatchReport, "received">;
    const delivery: DeliveryLog = { operationId: null, attempt: null, stateAtReceipt: "unread", decision: "dispatch" };
    try {
      outcome = await handleDispatch(deps, queue, message, delivery);
    } catch {
      // A fault we did not model (the store is unreachable): the message comes back after its visibility timeout.
      if (OrgIdSchema.safeParse(deps.companyId).success) log(deps, { event: "task_flow.dispatch_fault", error: "dispatch_failed" });
      outcome = "retried";
    } finally {
      if (OrgIdSchema.safeParse(deps.companyId).success) log(deps, { event: "task_flow.dispatch_delivery", ...delivery, messageId: message.messageId, receiveCount: message.receiveCount });
    }
    report[outcome] += 1;
  }
  return report;
}

interface DeliveryLog {
  operationId: string | null;
  /** Existing operation fence: the workspace's writer attempt, not a POST or SQS counter. */
  attempt: number | null;
  stateAtReceipt: string;
  decision: string;
}

type Outcome = keyof Omit<DispatchReport, "received">;

async function handleDispatch(deps: TaskFlowDeps, queue: Queue, message: ReceivedMessage, delivery: DeliveryLog): Promise<Outcome> {
  if (!OrgIdSchema.safeParse(deps.companyId).success) { await queue.changeVisibility(message.receiptHandle, 30); return "foreign"; }
  const body = parseMessage(message.body);
  if (body === undefined) {
    delivery.decision = "drop-malformed";
    await queue.deadLetter(message.receiptHandle, "malformed");
    return "dropped";
  }
  if (!OrgIdSchema.safeParse(body.companyId).success || body.companyId !== deps.companyId || (Object.hasOwn(message.attributes, "companyId") && message.attributes.companyId !== body.companyId)) {
    delivery.decision = "defer-foreign";
    await queue.changeVisibility(message.receiptHandle, 30);
    log(deps, { event: "task_flow.dispatch_foreign" });
    return "foreign";
  }
  delivery.operationId = body.operationId;
  const operation = await readOperation(deps, body.workspaceId, body.operationId);
  if (operation === undefined || operation.companyId !== deps.companyId) {
    // The operation commits with its message, so a message with none is not ours or is corrupt: set it aside for a person to look at.
    delivery.decision = "drop-missing";
    await queue.deadLetter(message.receiptHandle, "operation_missing");
    return "dropped";
  }
  delivery.attempt = operation.fence;
  delivery.stateAtReceipt = operation.status;
  delivery.decision = operation.status === "RUNNING" ? "ack-running" : operation.status === "DISPATCHING" ? staleDispatch(deps, operation) ? "recover-stale" : "defer-fresh-duplicate" : "dispatch";
  // Broker-owned accepted close work stays retryable until every effect and receipt completes.
  // Never route it through worker dispatch, which would interrupt a CLOSING workspace and acknowledge away recovery.
  if (operation.closeAcceptance !== undefined) return resumeCloseDelivery(deps, queue, message, operation);
  return handleWorkerDispatch(deps, queue, message, operation, delivery);
}

/** Each queue delivery is bounded; the pending durable outbox survives redrive and recreates it. */
async function resumeCloseDelivery(deps: TaskFlowDeps, queue: Queue, message: ReceivedMessage, operation: OperationRecord): Promise<Outcome> {
  try { await deps.resumeAcceptedClose?.(operation); }
  catch { return retryCloseDelivery(deps, queue, message, operation); }
  const fresh = await readAcceptedClose(deps, operation.workspaceId, operation.id);
  if (fresh?.closeAcceptance.phase !== "complete") return retryCloseDelivery(deps, queue, message, operation);
  await queue.ack(message.receiptHandle);
  await closeDeliveryReceipt(deps, fresh);
  return "delivered";
}

async function retryCloseDelivery(deps: TaskFlowDeps, queue: Queue, message: ReceivedMessage, operation: OperationRecord): Promise<Outcome> {
  if (message.receiveCount >= CLOSE_DELIVERY_ATTEMPTS) {
    await retireCloseDelivery(deps, operation);
    await queue.deadLetter(message.receiptHandle, "accepted_close_pending");
    return "dropped";
  }
  await queue.changeVisibility(message.receiptHandle, 30);
  return "retried";
}

/** Why an approved feedback fix may not start, in the person's words; undefined when the approval is current. A refusal says its own reason, never a guess. */
async function feedbackApprovalRefusal(deps: TaskFlowDeps, operation: OperationRecord): Promise<string | undefined> {
  if (operation.workflowFeedbackApproval === undefined) return undefined;
  try {
    await validateFeedbackApproval(deps, operation, operation.workflowFeedbackApproval);
    return undefined;
  } catch (error) {
    // The stable code goes to the log (fixed words, no ids); the person reads the sentence.
    log(deps, { event: "task_flow.feedback_approval_refused", code: error instanceof AgentXError ? error.code : "UNREADABLE" });
    if (error instanceof AgentXError && error.code === "STALE_FENCE") return "The feedback approval is no longer current. Refresh the task before retrying.";
    if (error instanceof AgentXError) return error.message.replace(/^[A-Z_]+: /u, "");
    return "The feedback approval could not be read just now. Refresh the task before retrying.";
  }
}

/** A queued cancel handed to the worker that runs the operation (moved unchanged out of handleWorkerDispatch, train 5, complexity ratchet). */
async function deliverQueuedCancel(deps: TaskFlowDeps, queue: Queue, message: ReceivedMessage, operation: OperationRecord, cancelId: string): Promise<Outcome> {
  const workspace = operation.status === "CANCEL_REQUESTED" && operation.machineId !== undefined ? await readWorkspace(deps, operation.workspaceId) : undefined;
  if (workspace === undefined || operation.machineId === undefined) { await queue.ack(message.receiptHandle); return "dropped"; }
  try {
    await deps.machines.deliver(operation.machineId, cancelInvocation(deps, workspace, operation, cancelId));
  } catch (error) {
    if (error instanceof MachineError && error.retryable && message.receiveCount < CANCEL_DELIVERY_ATTEMPTS) { await queue.changeVisibility(message.receiptHandle, 1); return "retried"; }
    log(deps, { event: "task_flow.cancel_not_delivered", error: error instanceof MachineError ? error.code : error instanceof Error ? error.name : "unknown" });
    await queue.ack(message.receiptHandle);
    return "failed";
  }
  await queue.ack(message.receiptHandle);
  return "delivered";
}

async function handleWorkerDispatch(deps: TaskFlowDeps, queue: Queue, message: ReceivedMessage, operation: OperationRecord, delivery: DeliveryLog): Promise<Outcome> {
  // A queued cancel (money-stop.ts: a Stop, a close or a spend stop on a deployed install, whose broker never reaches a worker itself): handed to the worker that runs the operation, while it
  // is still being stopped. A machine not ready is tried again a few times; anything else drops the message (the broker's wait then ends the run, keeping its hold).
  const cancelId = queuedCancelOf(message.body);
  if (cancelId !== undefined) return deliverQueuedCancel(deps, queue, message, operation, cancelId);
  const receiveCount = message.receiveCount;
  if (await acceptedCloseForRun(deps, operation) !== undefined) {
    await queue.ack(message.receiptHandle);
    return "dropped";
  }
  // Already ended, or a cancel is in flight: nothing to deliver.
  // A redelivered message for a job the worker already reports running is a repeat: the worker has it.
  if (isTerminalStatus(operation.status) || operation.status === "CANCEL_REQUESTED" || workerHasClaim(deps, operation)) {
    return settleWorkerDuplicate(deps, queue, message, operation, delivery);
  }
  const retryLater = async (seconds: number = retryDelay(receiveCount)): Promise<Outcome> => {
    await queue.changeVisibility(message.receiptHandle, seconds);
    return "retried";
  };
  /** Ends the operation, and acks only if it is now ended: an operation left held with its message gone would hold the workspace for ever. */
  const endAndAck = async (status: "FAILED" | "INTERRUPTED", error: string): Promise<Outcome> => {
    if (!(await endOperation(deps, operation, status, error))) return retryLater();
    await queue.ack(message.receiptHandle);
    return "failed";
  };
  const workspace = await readWorkspace(deps, operation.workspaceId);
  if (workspace === undefined || workspace.fence !== operation.fence || workspace.activeOperationId !== operation.id || workspace.status === "CLOSED" || workspace.status === "CLOSING") {
    // The workspace has moved on (closed, or taken by a newer hold): this job is no longer wanted.
    return endAndAck("INTERRUPTED", "the workspace no longer waits for this job");
  }
  if (await deps.deliveryAccess?.(deps, operation, workspace) === "PARKED") {
    await queue.ack(message.receiptHandle);
    return "dropped";
  }
  const approvalRefusal = await feedbackApprovalRefusal(deps, operation);
  if (approvalRefusal !== undefined) return endAndAck("FAILED", approvalRefusal);
  // Standing instructions (the company's rules and the project's How we work): read now, before admission and before any machine is started, since a refusal needs no machine and a code host that is down must
  // not wake one on every try. The playbook is read at the commit the task pinned when it started. A refusal that waiting will not mend ends the step with its sentence; a read that may pass is tried again, and when
  // the tries run out the step ends with the true cause (the rules could not be read), never "the machine did not become ready".
  // A rebuild whose lease cannot be handed over is refused here, read only, before admission and before any machine is started (saved-env-lease-step.ts).
  const rules = await beforeMachine(deps, operation, workspace, receiveCount < DISPATCH_ATTEMPTS_MAX, () => dispatchStanding(deps, operation, workspace, receiveCount));
  if (rules.error !== undefined) return rules.retry ? retryLater() : endAndAck("FAILED", rules.error);
  const standing = rules.standing;
  if (receiveCount > DISPATCH_ATTEMPTS_MAX) return endAndAck("FAILED", DISPATCH_EXHAUSTED_ERROR);

  // The model of this step (the install's per-step rule), before any machine is started for it: a step no model can serve ends here, with the reason in words, and costs nothing.
  const stepModel = await chooseStepModel(deps, operation);
  if (stepModel?.ok === false) return endAndAck("FAILED", stepModel.sentence);

  // A deployed install's per-run stop (money-stop.ts): a model run is not handed to a worker when its task or the company's day is at its cap; it ends with the fixed reason.
  if (deps.moneyStop !== undefined && operation.dispatch.kind === "task") {
    const taskId = (await deps.store.get((await workspaceKeys({ store: deps.store, companyId: operation.companyId }, operation.workspaceId)).taskPointerKey()))?.["taskId"];
    const gate = typeof taskId === "string" && taskId !== ""
      ? await deps.admission.admit({ companyId: deps.companyId, idempotencyKey: `${RUN_START_ACTION}:${operation.id}`, action: RUN_START_ACTION, projectName: workspace.projectName, subject: { type: "task", id: taskId } })
      : { allowed: false as const, code: "spend_unknown", message: "" };
    if (!gate.allowed) {
      if (!isSpendStopCode(gate.code)) return endAndAck("FAILED", gate.message);
      // A run its task's or the day's cap refuses ends as a spend stop (CANCELLED with its reason, which blocks the step with the fixed words), not as a failure a retry policy would repeat.
      const now = iso(deps);
      await deps.store.update({
        key: (await workspaceKeys({ store: deps.store, companyId: operation.companyId }, operation.workspaceId)).operationKey(operation.id),
        ops: [change.set("status", "CANCEL_REQUESTED"), change.set("stopReason", gate.code), change.set("stopRequestedAt", now), change.set("updatedAt", now)],
        condition: when.and(when.eq("fence", operation.fence), when.or(when.eq("status", "ACCEPTED"), when.eq("status", "DISPATCHING"))),
      });
      try {
        await recordOperationResult(deps, { workspaceId: operation.workspaceId, operationId: operation.id, fence: operation.fence, status: "CANCELLED", error: spendStopReason(gate.code) });
      } catch (error) {
        if (!(error instanceof AgentXError)) throw error;
        return retryLater();
      }
      await queue.ack(message.receiptHandle);
      return "failed";
    }
  }

  let reservationId: string | undefined;
  // A machine that does not exist yet is new spend: ask admission once for it (each machine of the workspace has its own key), before it starts.
  if (workspace.machine === undefined) {
    const admitted = await admit(deps, { idempotencyKey: `machine.start:${workspace.id}:${(workspace.machineGeneration ?? 0) + 1}`, action: "machine.start", projectName: workspace.projectName, subject: { type: "workspace", id: workspace.id } });
    if ("refusal" in admitted) return endAndAck("FAILED", admitted.refusal.message.replace(`${admitted.refusal.code}: `, ""));
    reservationId = admitted.reservationId;
  }

  let startedMachineId: string | undefined;
  try {
    const handle = await deps.machines.start({ machineKey: workspace.id, companyId: deps.companyId, projectName: workspace.projectName, labels: { workspaceId: workspace.id } });
    startedMachineId = handle.machineId;
    // The adapter gave a different machine than the one the workspace knew (the old one was reaped and the key started a new one): that is a new machine,
    // admitted on its own like any other. Refused, it is stopped again at once.
    if (workspace.machine !== undefined && handle.machineId !== workspace.machine.machineId) {
      const replacement = await admit(deps, { idempotencyKey: `machine.start:${workspace.id}:${(workspace.machineGeneration ?? 0) + 1}`, action: "machine.start", projectName: workspace.projectName, subject: { type: "workspace", id: workspace.id } });
      if ("refusal" in replacement) {
        await deps.machines.terminate(handle.machineId);
        return endAndAck("FAILED", replacement.refusal.message.replace(`${replacement.refusal.code}: `, ""));
      }
      reservationId = replacement.reservationId;
      // The machine it replaces is gone, and so is the allowance held for it.
      await releaseAdmission(deps, workspace.machineReservationId);
    }
    // The workspace must still be ours to give the machine to; if a close got in first, the machine it could not see is stopped here.
    if (!(await rememberMachine(deps, workspace, handle, reservationId))) return abandon(deps, queue, message, operation, handle.machineId, reservationId, delivery);
    const health = await deps.machines.health(handle.machineId);
    if (health.state === "terminated") {
      // The machine is gone for good (reaped): forget it; the next try starts another, admitted on its own.
      await forgetMachine(deps, workspace.id, handle.machineId, workspace.machineReservationId ?? reservationId);
      return retryLater(0);
    }
    if (health.state !== "ready" && health.state !== "busy") return retryLater(); // starting, stopping, stopped (the start above wakes it) or unhealthy
    // A step whose tool boundary the worker cannot enforce is refused, never sent without it: a read-only step must stay read-only.
    // A model route is never dropped: a worker that cannot take one is refused the step rather than sent it without.
    const routed = operation.dispatch.kind === "task" && (stepModel?.ok === true || (await deps.modelAccess?.route()) !== undefined);
    // With the per-run stop, a model run goes only to a worker that reports its usage while it runs (never dropped: the stop would not see the run's spend until it ended).
    const checkpoints = deps.moneyStop !== undefined && operation.dispatch.kind === "task";
    const missing = [...(operation.dispatch.requires ?? []), ...(routed ? ["model.route"] : []), ...(checkpoints ? [USAGE_CHECKPOINTS_FEATURE] : [])].filter((feature) => !health.features.includes(feature));
    // DEC 254zm: a worker that lacks only test-services features could not start them here (its boot stage or pulls failed): the fixed "not available here" words, not "too old".
    if (missing.length > 0) return endAndAck("FAILED", testServicesMissingWords(missing) ?? "this worker is too old to run this step; upgrade it");
    // A block is never dropped: a worker that cannot place it is refused the step (the rules were read above, before any machine was asked for).
    if (standing !== undefined && !health.features.includes(STANDING_INSTRUCTIONS_FEATURE)) return endAndAck("FAILED", "this worker is too old to run this step; upgrade it");
    if (await deps.deliveryAccess?.(deps, operation, workspace) === "PARKED") {
      await queue.ack(message.receiptHandle);
      return "dropped";
    }
    // The claim: in one transaction, the workspace is still held by this operation at its fence and is not closing, and the operation is handed over.
    // Nothing is issued to the worker (no grant, no capability) before it applies.
    let sent = stepModel?.ok === true ? stepModel : undefined;
    let claimed = await claimDispatch(deps, operation, handle.machineId, sent?.fresh === true ? sent.choice : undefined);
    if (!claimed && sent?.fresh === true) {
      // The claim of a fresh choice holds only while the operation has none: another delivery of this job may have recorded its own first. That one is the choice the step runs on, so it is read and used (never overwritten).
      const current = await readOperation(deps, operation.workspaceId, operation.id);
      if (current?.modelChoice !== undefined) {
        sent = heldStepModel(current.modelChoice);
        claimed = await claimDispatch(deps, operation, handle.machineId);
      }
    }
    if (!claimed) return abandon(deps, queue, message, operation, handle.machineId, reservationId ?? workspace.machineReservationId, delivery);
    const invocation = await buildInvocation(deps, operation, workspace, health.features, standing, sent);
    if (typeof invocation === "string") return endAndAck("FAILED", invocation);
    await deps.machines.deliver(handle.machineId, invocation);
    await queue.ack(message.receiptHandle);
    return "delivered";
  } catch (error) {
    // A try that will be repeated keeps its allowance (the same key asks again and gets the same one); a machine that did start keeps it too.
    // It goes back only when no machine is going to be started on it: the job is given up on, or the fault is not the adapter's to retry.
    const repeats = error instanceof MachineError && (error.code === "not_ready" || error.code === "unavailable" || error.code === "not_found");
    if (startedMachineId === undefined && !repeats) await releaseAdmission(deps, reservationId);
    if (error instanceof MachineError) {
      switch (error.code) {
        case "not_ready":
        case "unavailable":
          return retryLater();
        case "not_found":
          // The machine is gone: forget it, and the next try starts another.
          await forgetMachine(deps, workspace.id, workspace.machine?.machineId, workspace.machineReservationId ?? reservationId);
          return retryLater(0);
        case "unauthorized":
        case "rejected":
          return endAndAck("FAILED", error.code === "rejected" ? "the worker refused the job" : "the worker refused the job's credentials");
      }
    }
    throw error;
  }
}

/**
 * The job is no longer wanted by the time the machine was ready (the task was closed, or the workspace moved on). A machine this call started for a
 * workspace that is closed is stopped here, since the close could not see it; the allowance taken for it goes back. The operation is ended if it is not.
 */
async function abandon(deps: TaskFlowDeps, queue: Queue, message: ReceivedMessage, operation: OperationRecord, machineId: string | undefined, reservationId: string | undefined, delivery: DeliveryLog): Promise<Outcome> {
  const workspace = await readWorkspace(deps, operation.workspaceId);
  const closed = workspace === undefined || workspace.status === "CLOSED" || workspace.status === "CLOSING";
  if (closed) {
    if (machineId !== undefined) await deps.machines.terminate(machineId).catch((error: unknown) => log(deps, { event: "task_flow.terminate_orphan_failed", error: error instanceof Error ? error.name : "unknown" }));
    await releaseAdmission(deps, reservationId);
  }
  // The worker may have taken the job and reported it running between our read and the claim: it is theirs, not ours to end.
  const fresh = await readOperation(deps, operation.workspaceId, operation.id);
  if (!closed && fresh !== undefined && workerHasClaim(deps, fresh)) {
    return settleWorkerDuplicate(deps, queue, message, fresh, delivery);
  }
  if (!(await endOperation(deps, operation, "INTERRUPTED", "the workspace no longer waits for this job"))) {
    await queue.changeVisibility(message.receiptHandle, retryDelay(message.receiveCount));
    return "retried";
  }
  await queue.ack(message.receiptHandle);
  return "dropped";
}

/**
 * A pinned preparation reads exactly the repositories it pinned: the worker refuses any repository it prepares that has no pin, and a wiki build pins only the repositories its file map could read, so one unreadable repository must
 * not fail the build for all of them (prod 2026-11-23). Without pins (every ordinary task and setup run) the project goes as it is. A sentence when none of the project's repositories is pinned.
 */
function onlyPinned<P extends { repositories: ReadonlyArray<{ name: string }> }>(project: P | string, pins: unknown): P | string {
  if (typeof project === "string" || !Array.isArray(pins)) return project;
  const pinned = new Set((pins as Array<{ repository?: unknown }>).map((pin) => pin.repository));
  const repositories = project.repositories.filter((repository) => pinned.has(repository.name));
  return repositories.length === 0 ? "none of the project's repositories has a pinned commit" : { ...project, repositories };
}

/** The project as a worker is sent it, with the registries its PREPARE carries (where, never a credential), or the sentence that ends the preparation. */
async function preparedProject(deps: TaskFlowDeps, definition: ProjectDefinition, spec: OperationRecord["dispatch"], features: readonly string[], toWorker: (definition: ProjectDefinition) => object | string, rebuild: { operation: OperationRecord; workspace: WorkspaceRecord }): Promise<string | { forWorker: object; registries: Awaited<ReturnType<typeof registriesForPrepare>> & object; rebuildBuild: object }> {
  const forWorker = toWorker(definition);
  if (typeof forWorker === "string") return forWorker;
  const registries = await registriesForPrepare({ project: definition, companyId: deps.companyId, install: deps.projectRegistries, readOnly: spec.payload["readOnly"] === true, features });
  if (typeof registries === "string") return registries;
  // Saved project images: a rebuild's preparation is sent with its job's lease token, taken now and put in THIS invocation only (never in what is stored; nothing here logs the payload). A refusal is a sentence and the
  // operation ends (fail closed); the registry's settle then ends the job. Any other preparation: nothing added.
  const build = await savedEnvBuildFields(deps, rebuild.operation, rebuild.workspace, features);
  return typeof build === "string" ? build : { forWorker, registries, rebuildBuild: build };
}

/** Builds the worker's invocation, or a sentence saying why this operation cannot be sent to this worker. */
async function buildInvocation(deps: TaskFlowDeps, operation: OperationRecord, workspace: WorkspaceRecord, features: readonly string[], standing: StandingInstructionsPayload | undefined, stepModel?: Extract<StepModelOutcome, { ok: true }>): Promise<WorkerInvocation | string> {
  const spec = operation.dispatch;
  const secret = Buffer.from(deps.callbackSigningKey);
  // The step's own model when the install's rule chose one (its thinking level goes with it), else the install's one model.
  const modelRoute = stepModel !== undefined ? stepModel.choice.route : spec.kind === "task" ? await deps.modelAccess?.route() : undefined;
  // L4-EVH: an opt-in eval health run's own preparation (no task) may ask for model access: the broker describes its token from the run's claim (core/model-gateway/health.ts). Only where the install has a model route; the payload gets no route.
  const healthAccess = spec.kind === "prepare" && spec.payload["evalHealth"] !== undefined && await deps.modelAccess?.route() !== undefined;
  // A worker that cannot run the eval is sent no `evalRequest` (below), so its capability does not name the eval plan's action either.
  const evalDropped = spec.kind === "task" && spec.payload["evalRequest"] !== undefined && !features.includes(EVAL_ROUND_FEATURE);
  const capability = new CallbackCapabilities(secret).issue({
    workspaceId: workspace.id, operationId: operation.id, fence: operation.fence,
    actions: [...BASE_ACCESS_ACTIONS, ...(spec.kind === "prepare" && spec.payload["savedEnv"] !== undefined ? ["saved-env-login", "saved-env-fallback"] : []), ...(spec.extraActions ?? []).filter((action) => !evalDropped || action !== EVAL_PLAN_DELIVERY_ACTION), ...(modelRoute === undefined && !healthAccess ? [] : ["model-access"])] as CallbackAction[], expiresInSeconds: CAPABILITY_SECONDS,
  });
  let payload: Record<string, unknown> = { ...spec.payload, ...(spec.kind === "task" && deps.moneyStop !== undefined ? { usageCheckpoints: true } : {}), ...(modelRoute === undefined ? {} : { modelRoute }), ...(standing === undefined ? {} : { standingInstructions: standing }), ...(stepModel?.selection.thinkingLevel === undefined ? {} : { model: stepModel.selection }) };
  if (spec.kind === "task" && payload["evalRequest"] !== undefined && !features.includes(EVAL_ROUND_FEATURE)) {
    delete payload["evalRequest"];
    log(deps, { event: "eval_request_dropped_unsupported_worker" });
  }
  // The gateway's address is the dispatcher's own (never a stored or queued value): whatever a stored payload carried is dropped, and it is sent only with an eval request to a worker that lists the feature.
  delete payload["evalGatewayUrl"];
  if (spec.kind === "task" && payload["evalRequest"] !== undefined && features.includes(EVAL_GATEWAY_FEATURE) && EvalGatewayOriginSchema.safeParse(deps.evalGatewayUrl).success) payload["evalGatewayUrl"] = deps.evalGatewayUrl;
  // L4-EVP: the prompt locations ride with the eval request only to a worker that lists them; an older worker's strict parse would refuse the field.
  if (spec.kind === "task" && payload["evalPromptLocations"] !== undefined && (payload["evalRequest"] === undefined || !features.includes(EVAL_PROMPT_LOCATIONS_FEATURE))) {
    delete payload["evalPromptLocations"];
    log(deps, { event: "eval_prompt_locations_dropped_unsupported_worker" });
  }
  // L4-EVH: the same for the opt-in health run's preparation, which has no eval request but the run itself.
  if (spec.kind === "prepare" && payload["evalHealth"] !== undefined && features.includes(EVAL_GATEWAY_FEATURE) && EvalGatewayOriginSchema.safeParse(deps.evalGatewayUrl).success) payload["evalGatewayUrl"] = deps.evalGatewayUrl;
  // The lessons the step is given are chosen now, from the lessons as they are at this moment (a lesson retired since the step was queued is not sent). A worker that does not list the feature gets none.
  if (spec.kind === "task" && deps.learned !== undefined) {
    // A fix round (a build with `workflowFix`) hands the correction's words over so the lessons are picked again by them; the text only ranks and is never stored.
    const fixText = spec.payload["workflowFix"] !== undefined && typeof spec.payload["prompt"] === "string" ? spec.payload["prompt"] : undefined;
    const learned = await deps.learned({ workspaceId: workspace.id, operationId: operation.id, workflowMode: operation.workflowMode, features, ...(fixText === undefined ? {} : { fix: { text: fixText.slice(0, 4000) } }) }).catch(() => undefined);
    if (learned?.learnedContext !== undefined) payload = { ...payload, learnedContext: learned.learnedContext };
    // The knowledge briefing and look-up go only to a worker that lists the feature (an older worker is sent the lessons alone), whatever a reader answered.
    if (learned?.knowledgeContext !== undefined && features.includes(KNOWLEDGE_CONTEXT_FEATURE)) payload = { ...payload, knowledgeContext: learned.knowledgeContext };
    // Rovara skills (L4-AK3): only for a worker that lists the feature (the loader asks for it by the same list), never replacing a payload field a step already has.
    if (learned?.rovaraSkills !== undefined && learned.rovaraSkills.length > 0 && features.includes(ROVARA_SKILLS_FEATURE)) payload = { ...payload, rovaraSkills: learned.rovaraSkills };
  }
  // The project's wiki, when its switch is on (lead 4 A1): built now from the task's own project, for a worker that lists the feature; none otherwise.
  const wikiContext = await wikiContextForStep(deps, workspace, operation, features);
  if (wikiContext !== undefined) payload = { ...payload, wikiContext };
  // An approved plan's parts for a worker that does not list "task.workflowParallelParts": it would reject the `parallel` setting, and it builds the parts one after another, which the checkpoint rules accept and which
  // costs no more (only time). The setting is the one field of an ordered run that is withheld rather than refused, and only when the older worker can take over the retained progress; otherwise the run is refused.
  const ordered = spec.kind === "task" ? payload["workflowDependencies"] as WorkflowDependencyInvocation | undefined : undefined;
  if (ordered?.parallel !== undefined && !features.includes("task.workflowParallelParts")) {
    if (!serialWorkerCanResume(ordered)) return AGENT_WORKER_OUTDATED;
    const { parallel: _parallel, ...serial } = ordered;
    void _parallel;
    payload = { ...payload, workflowDependencies: serial };
  }
  // The worker's copy of the project can refuse (an external check nothing runs): that is a failed operation with its sentence, never an uncaught throw that redelivers until the attempts run out (review M2).
  // The stored record reads without the rules that judge new input (arch rule 8). Every branch that sends the project to a worker (prepare, publish, maintain: each can run its commands, with their env) asks them again here, so a revision
  // pinned before a rule tightened is refused with the rule's fixed sentence and stable id, as a failed operation, and never run.
  const toWorker = (definition: ProjectDefinition): ReturnType<typeof workerProjectDefinition<ProjectDefinition>> | string => {
    const barred = projectUseRefusal(definition);
    if (barred !== undefined) return barred.message.replace(/^CONFIG_INVALID: /u, "");
    try {
      return workerProjectDefinition(definition);
    } catch (error) {
      if (error instanceof AgentXError && error.code === "CONFIG_INVALID") return error.message.replace(/^CONFIG_INVALID: /u, "");
      throw error;
    }
  };
  if (spec.kind === "prepare") {
    const project = await deps.projects.revision(workspace.projectName, workspace.projectRevision);
    if (project === undefined) return "the project revision this task was started on is gone";
    // A1: the project's private package registries (where they are, never a credential), for the PREPARE only: the run of the approved setup and readiness commands. A preparation that only reads carries none; a task, a publication and
    // a push (below, and every other kind) never do. The worker asks for each credential by name, with the preparation's own grant (core/project-registries/exchange.ts). A worker that cannot take the field is refused: setup would
    // otherwise run without the registry and fail on a 401. An install that cannot serve them (or a CodeArtifact registry its rules refuse) ends the preparation with a fixed sentence.
    // A pinned preparation reads exactly the repositories it pinned (see `onlyPinned`); the registries are the project's own.
    const prepared = await preparedProject(deps, project.definition, spec, features, (definition) => onlyPinned(toWorker(definition), spec.payload["pins"]), { operation, workspace });
    if (typeof prepared === "string") return prepared;
    const { forWorker, registries, rebuildBuild } = prepared;
    // L4-NETG follow-up (DEC 254zzz90): the exact S3 hosts the project's allowed websites name, for a worker that lists the feature and only when there are some. The gateway-mode worker publishes them to its host's egress gateway; the allowed
    // websites themselves were approved through the existing audited flow (customer role and company checks), so this adds no route and no permission. Scope, said plainly (owner DEC 254zzz90, review M1/M2): there is NO Rovara staff step on this lift
    // (for the install's own region the VPC list already allows `*.s3.<region>`), and one lifted bucket host is region-wide S3 for that project's sandboxes (the gateway sees the TLS name; S3 routes by Host inside TLS).
    const s3Hosts = features.includes(PREPARE_EGRESS_S3_FEATURE) ? projectAllowedS3Hosts(project.definition.network?.allowedDomains) : [];
    payload = {
      ...payload,
      project: forWorker,
      ...registries,
      ...rebuildBuild,
      ...(s3Hosts.length === 0 ? {} : { egressS3Allow: s3Hosts }),
      repositoryGrant: deps.repositoryGrants.issue({
        ownerKey: workspace.ownerKey, projectName: workspace.projectName, workspaceId: workspace.id, operationId: operation.id,
        repositories: project.definition.repositories.map((repository) => ({ credentialRef: repository.credentialRef, repositoryUrl: repository.url, access: "clone" as const })),
      }),
    };
  }
  if (spec.kind === "publish" || spec.kind === "maintain") {
    // A publication or a push to an open pull request pushes one repository's branch: the grant names that one repository, with push access (the only operation that is ever given it).
    const project = await deps.projects.revision(workspace.projectName, workspace.projectRevision);
    if (project === undefined) return "the project revision this task was started on is gone";
    const repository = project.definition.repositories.find((candidate) => candidate.name === payload["repository"]);
    if (repository === undefined) return "the repository to push is not part of the project";
    const forWorker = toWorker(project.definition);
    if (typeof forWorker === "string") return forWorker;
    payload = {
      ...payload,
      project: forWorker,
      repositoryGrant: deps.repositoryGrants.issue({
        ownerKey: workspace.ownerKey, projectName: workspace.projectName, workspaceId: workspace.id, operationId: operation.id,
        repositories: [{ credentialRef: repository.credentialRef, repositoryUrl: repository.url, access: "push" as const }],
      }),
    };
  }
  const draft = {
    protocolVersion: AGENTX_PROTOCOL_VERSION, kind: spec.kind, operationId: operation.id, workspaceId: workspace.id, fence: operation.fence,
    projectRevision: spec.projectRevision, callbackCapability: capability, payload,
  };
  // A publication of a checked tree carries the digest of its context (which workspace, operation, fence, repository, branch and tree it is for); the worker's signed token names the same
  // digest, so a captured token cannot carry a different publication. The schema wants the digest and the mode together, so the digest is made from the draft before it is read.
  if (spec.kind === "publish" && payload["publicationMode"] !== undefined) {
    try {
      const context = workflowPublicationContext(draft as unknown as WorkerInvocation);
      if (context === undefined) return "the publication could not be built for the worker";
      draft.payload = { ...payload, publicationContextDigest: workflowPublicationContextDigest(context) };
    } catch {
      return "the publication could not be built for the worker";
    }
  }
  const parsed = WorkerInvocationSchema.safeParse(draft);
  if (parsed.success) {
    if ((draft.payload["wikiContext"] === undefined && draft.payload["knowledgeContext"] === undefined) || !invocationTooBigForWiki(parsed.data)) return parsed.data;
    // The step is already large: the wiki is what is left out, so it is never the reason a worker refuses the body. If it is still large, the knowledge look-up goes too (the lessons never do).
    const { wikiContext: _wiki, ...withoutWiki } = draft.payload;
    void _wiki;
    let slim = WorkerInvocationSchema.safeParse({ ...draft, payload: withoutWiki });
    if (slim.success && invocationTooBigForWiki(slim.data) && withoutWiki["knowledgeContext"] !== undefined) {
      const { knowledgeContext: _knowledge, ...withoutKnowledge } = withoutWiki;
      void _knowledge;
      slim = WorkerInvocationSchema.safeParse({ ...draft, payload: withoutKnowledge });
    }
    return slim.success ? slim.data : parsed.data;
  }
  // Lessons and the wiki never block a step: a learned or wiki context the worker's schema does not take is dropped, and the step is built without it.
  // The knowledge context goes first on its own: the lessons and the wiki are not lost to it.
  if (draft.payload["knowledgeContext"] !== undefined) {
    const { knowledgeContext: _knowledgeOnly, ...withoutKnowledgeOnly } = draft.payload;
    void _knowledgeOnly;
    const retriedKnowledge = WorkerInvocationSchema.safeParse({ ...draft, payload: withoutKnowledgeOnly });
    if (retriedKnowledge.success) return retriedKnowledge.data;
  }
  if (draft.payload["learnedContext"] !== undefined || draft.payload["wikiContext"] !== undefined || draft.payload["knowledgeContext"] !== undefined || draft.payload["rovaraSkills"] !== undefined) {
    const { learnedContext: _dropped, wikiContext: _droppedWiki, knowledgeContext: _droppedKnowledge, rovaraSkills: _droppedSkills, ...withoutMemory } = draft.payload;
    void _dropped; void _droppedWiki; void _droppedKnowledge; void _droppedSkills;
    const retried = WorkerInvocationSchema.safeParse({ ...draft, payload: withoutMemory });
    if (retried.success) return retried.data;
  }
  return "the job could not be built for the worker";
}

/** Records the workspace's machine (and the allowance taken for it). False when the workspace has moved on (the fence no longer holds): the caller must not use the machine. */
async function rememberMachine(deps: TaskFlowDeps, workspace: WorkspaceRecord, handle: { machineId: string; machineKey: string }, reservationId: string | undefined): Promise<boolean> {
  if (workspace.machine?.machineId === handle.machineId) return true;
  const written = await deps.store.update({
    key: (await workspaceKeys(deps, workspace.id)).workspaceKey,
    // The reservation is kept with the machine so the path that stops it can give it back.
    ops: [
      change.set("machine", { machineId: handle.machineId, machineKey: handle.machineKey }), change.set("machineGeneration", (workspace.machineGeneration ?? 0) + 1),
      ...(reservationId === undefined ? [] : [change.set("machineReservationId", reservationId)]),
    ],
    condition: when.and(when.eq("fence", workspace.fence), when.not(when.or(when.eq("status", "CLOSED"), when.eq("status", "CLOSING")))),
  });
  return written.applied;
}

/** The machine is gone: the workspace forgets it, and the allowance taken for it goes back (the next machine is admitted on its own). */
async function forgetMachine(deps: TaskFlowDeps, workspaceId: string, machineId: string | undefined, reservationId: string | undefined): Promise<void> {
  if (machineId === undefined) return;
  // Only the machine this handler saw is forgotten: a concurrent delivery may have recorded another since.
  const forgotten = await deps.store.update({ key: (await workspaceKeys(deps, workspaceId)).workspaceKey, ops: [change.remove("machine"), change.remove("machineReservationId")], condition: when.eq(["machine", "machineId"], machineId) });
  if (forgotten.applied) await releaseAdmission(deps, reservationId);
}

/**
 * Hands the operation over, fenced: the workspace is still held by this operation, at its fence, and is not closing, in the same transaction that marks the
 * operation DISPATCHING. A worker that reported RUNNING already keeps its newer state (the operation's condition then does not hold, which is a repeat).
 */
async function claimDispatch(deps: TaskFlowDeps, operation: OperationRecord, machineId: string, modelChoice?: OperationModelChoice): Promise<boolean> {
  const now = iso(deps);
  const location = await workspaceKeys(deps, operation.workspaceId);
  const timeField = claimTimeField(operation);
  const staleClaim = when.and(when.eq("status", "DISPATCHING"), when.eq(timeField, operation[timeField]!), when.lt(timeField, new Date(Date.parse(now) - CORE_DISPATCH_CLAIM_STALE_MS).toISOString()));
  const claimed = await deps.store.transact([
    // The operation is watched from the hand-over on (`sweepLostRuns`): the machine it runs on may be lost with no result ever coming back.
    runWatchItem(deps, operation, machineId, now),
    { kind: "check", key: location.workspaceKey, condition: when.and(when.eq("fence", operation.fence), when.eq("activeOperationId", operation.id), when.not(when.or(when.eq("status", "CLOSED"), when.eq("status", "CLOSING")))) },
    { kind: "update", key: location.operationKey(operation.id), ops: [change.set("status", "DISPATCHING"), change.set("machineId", machineId), change.set("deliveredAt", now), change.set("updatedAt", now), ...(modelChoice === undefined ? [] : [change.set("modelChoice", modelChoice as unknown as JsonValue)])], condition: when.and(when.eq("fence", operation.fence), when.or(when.eq("status", "ACCEPTED"), staleClaim), ...(modelChoice === undefined ? [] : [when.notExists("modelChoice")])) },
  ]);
  return claimed.applied;
}

/** Ends an operation the worker will never answer, through the same path a worker's result takes. True when it is ended afterwards. */
async function endOperation(deps: TaskFlowDeps, operation: OperationRecord, status: "FAILED" | "INTERRUPTED", error: string): Promise<boolean> {
  try {
    await recordOperationResult(deps, { workspaceId: operation.workspaceId, operationId: operation.id, fence: operation.fence, status, error });
  } catch (cause) {
    if (!(cause instanceof AgentXError)) throw cause;
    log(deps, { event: "task_flow.end_operation_refused", code: cause.code });
  }
  const fresh = await readOperation(deps, operation.workspaceId, operation.id);
  return fresh !== undefined && isTerminalStatus(fresh.status);
}


async function dispatchStanding(deps: TaskFlowDeps, operation: OperationRecord, workspace: WorkspaceRecord, receiveCount: number): Promise<{ standing?: StandingInstructionsPayload; error?: string; retry?: boolean }> {
  let standing: StandingInstructionsPayload | undefined;
  if (operation.dispatch.kind === "task" && deps.standingInstructions !== undefined) {
    try {
      standing = await deps.standingInstructions.forOperation({
        project: workspace.projectName, mode: operation.dispatch.payload["workflowMode"] as PlaybookMode | undefined, ...(workspace.playbookCommit === undefined ? {} : { playbookCommit: workspace.playbookCommit }),
        ...(workspace.standingPin === undefined ? {} : { pinned: workspace.standingPin }),
      });
    } catch (error) {
      const sentence = error instanceof AgentXError ? error.message.replace(/^[A-Z_]+: /u, "") : undefined;
      if (sentence !== undefined && error instanceof AgentXError && (error.code === "CONFIG_INVALID" || error.code === "PROCESS_UNAVAILABLE")) return { error: sentence };
      if (sentence !== undefined && error instanceof AgentXError && error.code === "RUNTIME_UNAVAILABLE") return { error: sentence, retry: receiveCount < DISPATCH_ATTEMPTS_MAX };
      throw error;
    }
  }
  return standing === undefined ? {} : { standing };
}
