// Lane L6a, task flow core: dispatching operations to worker machines. The consumer of the dispatch queue: for each message it finds the
// operation, makes sure the workspace's machine is running and ready, builds the worker's invocation (with a repository grant and a callback
// capability issued now, not when the operation was accepted, so a delivery that waits for a machine never carries an expired one) and hands it to
// the machine through the `WorkerMachines` port. The worker's answer comes back through the broker's callback API, not through this module.
//
// At least once, and idempotent: the queue may deliver a message twice, a crash can follow the delivery, and `deliver` is idempotent on the
// operation id. The consumer therefore only moves an operation forward and never undoes a state a result has set.
import {
  AGENTX_PROTOCOL_VERSION,
  AGENT_WORKER_OUTDATED,
  AgentXError,
  MachineError,
  STANDING_INSTRUCTIONS_FEATURE,
  WorkerInvocationSchema,
  change,
  when,
  workerProjectDefinition,
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
import type { DispatchMessage } from "./accept.js";
import type { TaskFlowDeps } from "./deps.js";
import { operationKey, workspaceKey } from "./keys.js";
import { isTerminalStatus, readOperation, recordOperationResult } from "./results.js";
import { readWorkspace } from "./stage-machine.js";
import { dispatchQueueName, iso, log } from "./support.js";
import type { OperationRecord, WorkspaceRecord } from "./records.js";
import type { PlaybookMode } from "../playbook/service.js";
import { chooseStepModel, heldStepModel, type OperationModelChoice, type StepModelOutcome } from "./step-model.js";

/** How long a capability the worker is given lives: nine hours, as Cloud's. */
const CAPABILITY_SECONDS = 32_400;
/** After this many deliveries of one message the operation is given up on: the machine never became usable. */
export const DISPATCH_ATTEMPTS_MAX = 20;
/** The reason a run is ended with when its machine never became usable (merge of "the start was tried until its budget ran out"). */
export const DISPATCH_EXHAUSTED_ERROR = "the worker machine did not become ready in time";
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

type Outcome = keyof Omit<DispatchReport, "received">;

async function handleDispatch(deps: TaskFlowDeps, queue: Queue, message: ReceivedMessage): Promise<Outcome> {
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
  // A redelivered message for a job the worker already reports running is a repeat: the worker has it.
  if (isTerminalStatus(operation.status) || operation.status === "CANCEL_REQUESTED" || operation.status === "RUNNING") {
    await queue.ack(message.receiptHandle);
    return "dropped";
  }
  const retryLater = async (seconds: number = retryDelay(message.receiveCount)): Promise<Outcome> => {
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
  // Standing instructions (the company's rules and the project's How we work): read now, before admission and before any machine is started, since a refusal needs no machine and a code host that is down must
  // not wake one on every try. The playbook is read at the commit the task pinned when it started. A refusal that waiting will not mend ends the step with its sentence; a read that may pass is tried again, and when
  // the tries run out the step ends with the true cause (the rules could not be read), never "the machine did not become ready".
  let standing: StandingInstructionsPayload | undefined;
  if (operation.dispatch.kind === "task" && deps.standingInstructions !== undefined) {
    try {
      standing = await deps.standingInstructions.forOperation({
        project: workspace.projectName, mode: operation.dispatch.payload["workflowMode"] as PlaybookMode | undefined, ...(workspace.playbookCommit === undefined ? {} : { playbookCommit: workspace.playbookCommit }),
      });
    } catch (error) {
      const sentence = error instanceof AgentXError ? error.message.replace(/^[A-Z_]+: /u, "") : undefined;
      if (sentence !== undefined && error instanceof AgentXError && (error.code === "CONFIG_INVALID" || error.code === "PROCESS_UNAVAILABLE")) return endAndAck("FAILED", sentence);
      if (sentence !== undefined && error instanceof AgentXError && error.code === "RUNTIME_UNAVAILABLE") return message.receiveCount >= DISPATCH_ATTEMPTS_MAX ? endAndAck("FAILED", sentence) : retryLater();
      throw error;
    }
  }
  if (message.receiveCount > DISPATCH_ATTEMPTS_MAX) return endAndAck("FAILED", DISPATCH_EXHAUSTED_ERROR);

  // The model of this step (the install's per-step rule), before any machine is started for it: a step no model can serve ends here, with the reason in words, and costs nothing.
  const stepModel = await chooseStepModel(deps, operation);
  if (stepModel?.ok === false) return endAndAck("FAILED", stepModel.sentence);

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
    if (!(await rememberMachine(deps, workspace, handle, reservationId))) return abandon(deps, queue, message, operation, handle.machineId, reservationId);
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
    const missing = [...(operation.dispatch.requires ?? []), ...(routed ? ["model.route"] : [])].filter((feature) => !health.features.includes(feature));
    if (missing.length > 0) return endAndAck("FAILED", "this worker is too old to run this step; upgrade it");
    // A block is never dropped: a worker that cannot place it is refused the step (the rules were read above, before any machine was asked for).
    if (standing !== undefined && !health.features.includes(STANDING_INSTRUCTIONS_FEATURE)) return endAndAck("FAILED", "this worker is too old to run this step; upgrade it");
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
    if (!claimed) return abandon(deps, queue, message, operation, handle.machineId, reservationId ?? workspace.machineReservationId);
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
async function abandon(deps: TaskFlowDeps, queue: Queue, message: ReceivedMessage, operation: OperationRecord, machineId: string | undefined, reservationId: string | undefined): Promise<Outcome> {
  const workspace = await readWorkspace(deps, operation.workspaceId);
  const closed = workspace === undefined || workspace.status === "CLOSED" || workspace.status === "CLOSING";
  if (closed) {
    if (machineId !== undefined) await deps.machines.terminate(machineId).catch((error: unknown) => log(deps, { event: "task_flow.terminate_orphan_failed", error: error instanceof Error ? error.name : "unknown" }));
    await releaseAdmission(deps, reservationId);
  }
  // The worker may have taken the job and reported it running between our read and the claim: it is theirs, not ours to end.
  const fresh = await readOperation(deps, operation.workspaceId, operation.id);
  if (!closed && fresh !== undefined && fresh.status === "RUNNING") {
    await queue.ack(message.receiptHandle);
    return "dropped";
  }
  if (!(await endOperation(deps, operation, "INTERRUPTED", "the workspace no longer waits for this job"))) {
    await queue.changeVisibility(message.receiptHandle, retryDelay(message.receiveCount));
    return "retried";
  }
  await queue.ack(message.receiptHandle);
  return "dropped";
}

/** Builds the worker's invocation, or a sentence saying why this operation cannot be sent to this worker. */
async function buildInvocation(deps: TaskFlowDeps, operation: OperationRecord, workspace: WorkspaceRecord, features: readonly string[], standing: StandingInstructionsPayload | undefined, stepModel?: Extract<StepModelOutcome, { ok: true }>): Promise<WorkerInvocation | string> {
  const spec = operation.dispatch;
  const secret = Buffer.from(deps.callbackSigningKey);
  // The step's own model when the install's rule chose one (its thinking level goes with it), else the install's one model.
  const modelRoute = stepModel !== undefined ? stepModel.choice.route : spec.kind === "task" ? await deps.modelAccess?.route() : undefined;
  const capability = new CallbackCapabilities(secret).issue({
    workspaceId: workspace.id, operationId: operation.id, fence: operation.fence,
    actions: [...BASE_ACCESS_ACTIONS, ...(spec.extraActions ?? []), ...(modelRoute === undefined ? [] : ["model-access"])] as CallbackAction[], expiresInSeconds: CAPABILITY_SECONDS,
  });
  let payload: Record<string, unknown> = { ...spec.payload, ...(modelRoute === undefined ? {} : { modelRoute }), ...(standing === undefined ? {} : { standingInstructions: standing }), ...(stepModel?.selection.thinkingLevel === undefined ? {} : { model: stepModel.selection }) };
  // The lessons the step is given are chosen now, from the lessons as they are at this moment (a lesson retired since the step was queued is not sent). A worker that does not list the feature gets none.
  if (spec.kind === "task" && deps.learned !== undefined) {
    const learned = await deps.learned({ workspaceId: workspace.id, operationId: operation.id, workflowMode: operation.workflowMode, features }).catch(() => undefined);
    if (learned?.learnedContext !== undefined) payload = { ...payload, learnedContext: learned.learnedContext };
  }
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
  const toWorker = <D extends object>(definition: D): ReturnType<typeof workerProjectDefinition<D>> | string => {
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
    const forWorker = toWorker(project.definition);
    if (typeof forWorker === "string") return forWorker;
    payload = {
      ...payload,
      project: forWorker,
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
  if (parsed.success) return parsed.data;
  // Lessons never block a step: a learned context the worker's schema does not take is dropped, and the step is built without it.
  if (draft.payload["learnedContext"] !== undefined) {
    const { learnedContext: _dropped, ...withoutLessons } = draft.payload;
    void _dropped;
    const retried = WorkerInvocationSchema.safeParse({ ...draft, payload: withoutLessons });
    if (retried.success) return retried.data;
  }
  return "the job could not be built for the worker";
}

/** Records the workspace's machine (and the allowance taken for it). False when the workspace has moved on (the fence no longer holds): the caller must not use the machine. */
async function rememberMachine(deps: TaskFlowDeps, workspace: WorkspaceRecord, handle: { machineId: string; machineKey: string }, reservationId: string | undefined): Promise<boolean> {
  if (workspace.machine?.machineId === handle.machineId) return true;
  const written = await deps.store.update({
    key: workspaceKey(workspace.id),
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
  const forgotten = await deps.store.update({ key: workspaceKey(workspaceId), ops: [change.remove("machine"), change.remove("machineReservationId")], condition: when.eq(["machine", "machineId"], machineId) });
  if (forgotten.applied) await releaseAdmission(deps, reservationId);
}

/**
 * Hands the operation over, fenced: the workspace is still held by this operation, at its fence, and is not closing, in the same transaction that marks the
 * operation DISPATCHING. A worker that reported RUNNING already keeps its newer state (the operation's condition then does not hold, which is a repeat).
 */
async function claimDispatch(deps: TaskFlowDeps, operation: OperationRecord, machineId: string, modelChoice?: OperationModelChoice): Promise<boolean> {
  const now = iso(deps);
  const claimed = await deps.store.transact([
    // The operation is watched from the hand-over on (`sweepLostRuns`): the machine it runs on may be lost with no result ever coming back.
    runWatchItem(deps, operation, machineId, now),
    { kind: "check", key: workspaceKey(operation.workspaceId), condition: when.and(when.eq("fence", operation.fence), when.eq("activeOperationId", operation.id), when.not(when.or(when.eq("status", "CLOSED"), when.eq("status", "CLOSING")))) },
    { kind: "update", key: operationKey(operation.workspaceId, operation.id), ops: [change.set("status", "DISPATCHING"), change.set("machineId", machineId), change.set("deliveredAt", now), change.set("updatedAt", now), ...(modelChoice === undefined ? [] : [change.set("modelChoice", modelChoice as unknown as JsonValue)])], condition: when.and(when.or(when.eq("status", "ACCEPTED"), when.eq("status", "DISPATCHING")), ...(modelChoice === undefined ? [] : [when.notExists("modelChoice")])) },
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
