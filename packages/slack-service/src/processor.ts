import {
  CLOSED_SHARED_NOTICE,
  VIEW_ONLY_NOTICE,
  detailsButtonValue,
  detailsReplyBlocks,
  slackThreadSubject,
  splitSlackMessage,
  WorkspaceClosePreflightResultSchema,
  type SlackRequestMessage,
  type SlackThread,
  type SlackThreadPrepareResult,
  type SlackThreadWorkspaceResult,
  type SlackWorkspaceCloseCompleteResult,
  type SlackWorkspaceCloseStartResult,
  type ThreadConnector,
  type ActionPolicy,
  type PendingConfirmation,
  type TurnObservation,
  type TurnRecord,
  type ModelIdentifier,
  type ProjectModelOptions,
} from "@agentx/contracts";
import type { WorkerAccess } from "@agentx/orchestrator";
import type { GateSession } from "@agentx/orchestrator/action-gate";
import { EXPIRED_TEXT, checkConfirmation, settleConfirmations, type ConfirmationCheck, type ConfirmationStore } from "./confirmations.js";
import { TurnRecorder } from "@agentx/orchestrator/turn-recorder";
import { deterministicUuid, requestIdSequence } from "./ids.js";
import { createLazyWorker } from "./lazy-worker.js";
import { NEW_WORKSPACE_MESSAGE, STILL_PREPARING_MESSAGE, limitMessage, preparationFailedMessage } from "./messages.js";
import { escapeText, slackReplyText } from "./slack-format.js";
import { buildTurnRecord, emitTurnMetrics, type TurnDraft, type TurnRecordSink } from "./turn-records.js";
import { matchApprovedModel, modelName, modelOptionsMessage, parseModelCommand } from "./model-command.js";
import {
  ABANDONED_TASK_CANCEL_FAILED_TEXT, ABANDONED_TASK_FINISHED_TEXT, ABANDONED_TASK_TEXT, HANDOFF_APPROVED_TEXT, HANDOFF_FINAL_CANCEL_FAILED_TEXT,
  HANDOFF_FINAL_FINISHED_TEXT, HANDOFF_FINAL_IDLE_TEXT, HANDOFF_FINAL_TEXT, HANDOFF_TASK_TEXT, HANDOFF_TEXT, RESUME_NOT_FOUND_TEXT, TurnHandedOffError, resumedResultText, turnNoteText,
  type ActiveTurn, type TurnNote,
} from "./interrupted-turn.js";
import { SHARED_CLOSE_REFUSED_MESSAGE, SHARED_SETUP_FAILED_MESSAGE, TASK_STILL_BUSY_MESSAGE, taskBusy, waitForIdleTask } from "./shared-task.js";

export interface ThreadServiceApi {
  ensureWorkspace(requestId: string): Promise<SlackThreadWorkspaceResult>;
  /** Spec 014: prepares compute for a thread whose workspace is UNPREPARED. */
  prepareWorkspace?(requestId: string): Promise<SlackThreadPrepareResult>;
  startClose(requestId: string): Promise<SlackWorkspaceCloseStartResult>;
  completeClose(requestId: string, operationId: string): Promise<SlackWorkspaceCloseCompleteResult>;
  waitForOperation(workspaceId: string, operationId: string, signal?: AbortSignal): Promise<{ status: string; error?: string | undefined; result?: unknown }>;
  /** Issue 157: waits for a worker task and returns its final response; without it, a resumed turn posts the status alone. */
  taskResult?(workspaceId: string, operationId: string, signal?: AbortSignal): Promise<{ status: string; response?: string | undefined; error?: string | undefined }>;
  /**
   * Issue 167: asks the worker to cancel a task (a finished one is left as it is). Called only when
   * a Slack turn gives up for good, so nobody will ever read the task's result.
   */
  cancelOperation?(workspaceId: string, operationId: string): Promise<CancelOutcome>;
  createConversation(workspaceId: string): Promise<string>;
  listProjectModels?(): Promise<ProjectModelOptions>;
  selectProjectModel?(model: ModelIdentifier): Promise<ProjectModelOptions>;
}

/** Issue 167: a cancel was queued for a task still running, or the task had already finished. */
export type CancelOutcome = { outcome: "requested" } | { outcome: "finished"; status: string };

export interface ThreadState {
  workspaceId?: string;
  conversationId?: string;
  /** The settings revision this thread was last told about, so a change is announced once. */
  settingsRevision?: number;
  closedAt?: string;
  /** Connectors whose last turn failed with schema_changed; the next discovery asks for a refresh. */
  refreshConnectors?: string[];
  /** Issue 157: the worker operation a turn was waiting on, so its redelivery can resume it. */
  activeTurn?: ActiveTurn;
  /** Issue 157: what a resumed turn did, for the next turn's model. */
  turnNote?: TurnNote;
}

export interface ThreadStore {
  load(subject: string): Promise<ThreadState>;
  saveConversation(subject: string, state: { workspaceId: string; conversationId: string }): Promise<void>;
  saveSettingsRevision(subject: string, revision: number): Promise<void>;
  close(subject: string, state: { workspaceId: string; closedAt: string }): Promise<void>;
  finish(subject: string): Promise<void>;
  /** Remembers the connectors whose next discovery should ask for a refresh; an empty list clears them. */
  saveRefreshConnectors?(subject: string, connectors: string[]): Promise<void>;
  /**
   * C10: claims the shared thread's hourly notice (the ingress's marker); true when this caller may
   * post it. Absent: the notice is posted every time a view-only or closed thread's message is processed.
   */
  claimSharedNotice?(subject: string, nowSeconds: number, kind: "view" | "closed"): Promise<boolean>;
  /** Issue 157: remembers the worker operation this event's turn waits on. Absent: a redelivery runs the turn again, as before. */
  saveActiveTurn?(subject: string, turn: ActiveTurn): Promise<void>;
  /** Issue 157: forgets the remembered operation, only if it is still this event's. */
  clearActiveTurn?(subject: string, eventId: string): Promise<void>;
  /** Issue 157: keeps (or, with undefined, forgets) the note the next turn's model reads. */
  saveTurnNote?(subject: string, note: TurnNote | undefined): Promise<void>;
}

export interface TurnInput {
  message: SlackRequestMessage;
  subject: string;
  workspaceId: string;
  conversationId: string;
  orchestratorInstructions: string;
  connectors?: ThreadConnector[];
  repositories?: string[];
  recoverableOperations?: string[];
  /** Spec 014: present only when the thread's compute is not prepared yet. */
  worker?: WorkerAccess;
  /** Spec 014 D5: true only when the thread's compute is already prepared, so coding work runs ungated. */
  computePrepared?: boolean;
  /** Spec 014: this turn's action gate state: the requester, confirmed calls and "yes to all". */
  gate?: GateSession;
  actionPolicy?: ActionPolicy;
  requestId: () => string;
  /** Collects this turn's record; the processor writes it once the event is finished. */
  recorder?: TurnRecorder;
  /** Connectors whose discovery this turn should bypass the broker's catalog cache. */
  refreshConnectors?: string[];
  /** Issue 157: told each accepted worker task or follow-up operation, so the thread can remember it. Never throws. */
  onOperationAccepted?: (operationId: string) => Promise<void>;
  /** Issue 157: aborted when the turn is handed off to a new task; the host then stops the model. */
  signal?: AbortSignal;
  /** Issue 157: what a resumed earlier turn in this thread did, for the model to read this turn only. */
  turnNote?: string;
}

export type ServiceLog = (event: string, fields: Readonly<Record<string, string | number | boolean>>) => void;

export interface ProcessorDependencies {
  api: (message: SlackRequestMessage) => ThreadServiceApi;
  threads: ThreadStore;
  runTurn: (input: TurnInput) => Promise<string>;
  post: (thread: SlackThread, text: string) => Promise<void>;
  log?: ServiceLog;
  /** Pending confirmations for the action gate (spec 014). The hosted service always sets it. */
  confirmations?: ConfirmationStore;
  /** Posts a confirmation with its Approve and Cancel buttons; without it, the text alone is posted. */
  postConfirmation?: (thread: SlackThread, confirmation: PendingConfirmation, text: string) => Promise<void>;
  now?: () => number;
  /** Where one hidden record per finished Slack event goes; without it nothing is recorded. */
  turnRecords?: TurnRecordSink;
  /**
   * Posts a message with Block Kit blocks. The reply's Details button needs it (spec 014 FR-024);
   * without it, replies are text only, exactly as before.
   */
  postWithBlocks?: (thread: SlackThread, text: string, blocks: unknown[]) => Promise<void>;
  /** C13: a Slack member's display name, for a continue-mode turn's record. */
  userName?: (userId: string) => Promise<string | undefined>;
  /** Issue 157: how long the hand-off notice may take before the message is released anyway. Default 10 seconds. */
  handoffNoticeMilliseconds?: number;
  /** Issue 167: how long cancelling an abandoned task may take before the turn finishes anyway. Default 5 seconds. */
  cancelTaskMilliseconds?: number;
}

/** Issue 157: a save already in flight at the hand-off gets this long to land. */
const PENDING_SAVE_MILLISECONDS = 5_000;

/** Issue 167: cancelling an abandoned task gets this long, well inside the time left before SIGKILL. */
const CANCEL_TASK_MILLISECONDS = 5_000;

/** Where a reply's Details button points, and how to post it. */
interface ReplyDetails {
  value: string;
  postWithBlocks: (thread: SlackThread, text: string, blocks: unknown[]) => Promise<void>;
}

const RUNNABLE_STATUSES = new Set(["READY", "STOPPED", "BUSY"]);

export async function processSlackRequest(
  message: SlackRequestMessage,
  dependencies: ProcessorDependencies,
  options: {
    finalAttempt: boolean;
    /** How many earlier requests the ingress told the member this one waits behind; absent from an older ingress. */
    queuedBehind?: number;
    /** Set when SQS's ApproximateReceiveCount shows this attempt was redelivered after an earlier one threw. */
    redelivered?: boolean;
    /** Issue 157: aborted at the hand-off deadline after SIGTERM; a turn still running is then handed off. */
    handoff?: AbortSignal;
  },
): Promise<void> {
  const subject = slackThreadSubject(message.thread);
  const log: ServiceLog = dependencies.log ?? (() => undefined);
  const startedAt = new Date();
  // Only a configured sink or refresh store gets a recorder, so a service without either runs the
  // turn exactly as before.
  const recorder = dependencies.turnRecords === undefined && dependencies.threads.saveRefreshConnectors === undefined
    ? undefined
    : new TurnRecorder();
  const draft: TurnDraft = { disposition: "abandoned" };
  let lastPosted = "";
  // Issue 157: set the moment this attempt is handed off. From then on the new task owns the
  // thread, so the old turn (a lazy worker still waiting, say) posts nothing more and saves nothing.
  let handedOff = false;
  // Remembers only what reached Slack, so the record never claims a message the member did not see.
  const post = async (text: string) => {
    if (handedOff) {
      log("turn.post_after_handoff", { eventId: message.eventId });
      return;
    }
    await dependencies.post(message.thread, text);
    lastPosted = text;
  };
  // Spec 014 FR-024: the last chunk of a reply that followed tool calls carries a Details button. A
  // Slack refusal of the blocks (an API error answer such as invalid_blocks, so nothing was posted)
  // never costs the member the reply: the text is posted on its own. Any other failure (a network
  // error, a timeout, an unreadable answer) may come after Slack posted the message, so it is thrown
  // like any failed post rather than risking the reply twice.
  const postWithDetails = async (details: ReplyDetails, text: string) => {
    try {
      await details.postWithBlocks(message.thread, text, detailsReplyBlocks(text, details.value));
      lastPosted = text;
    } catch (error) {
      const refusal = slackRefusal(error);
      log("reply.details_failed", { eventId: message.eventId, errorName: errorName(error), ...(refusal === undefined ? {} : { slackError: refusal }) });
      if (refusal === undefined) throw error;
      await post(text);
    }
  };
  const api = dependencies.api(message);
  let finished = false;
  const forgetActiveTurn = async (): Promise<void> => {
    try {
      await dependencies.threads.clearActiveTurn?.(subject, message.eventId);
    } catch (error) {
      log("turn.active_clear_failed", { eventId: message.eventId, errorName: errorName(error) });
    }
  };
  const resumeTurn = async (active: ActiveTurn): Promise<void> => {
    log("turn.resuming", { eventId: message.eventId, workspaceId: active.workspaceId, operationId: active.operationId });
    const waitStop = new AbortController();
    const waiting = api.taskResult === undefined
      ? api.waitForOperation(active.workspaceId, active.operationId, waitStop.signal)
      : api.taskResult(active.workspaceId, active.operationId, waitStop.signal);
    let result: { status: string; response?: string | undefined; error?: string | undefined };
    try {
      result = await untilHandoff(waiting, options.handoff);
    } catch (error) {
      if (error instanceof TurnHandedOffError) {
        handedOff = true;
        reportAfterHandoff(waiting);
        waitStop.abort();
        throw error;
      }
      // A task that no longer exists never will: say so once, rather than retrying for an hour.
      if ((error as { code?: unknown } | null)?.code !== "NOT_FOUND") throw error;
      log("turn.resume_not_found", { eventId: message.eventId, workspaceId: active.workspaceId, operationId: active.operationId });
      draft.disposition = "failed";
      draft.responseText = RESUME_NOT_FOUND_TEXT;
      await post(RESUME_NOT_FOUND_TEXT);
      await forgetActiveTurn();
      return;
    }
    log("turn.resumed", { eventId: message.eventId, workspaceId: active.workspaceId, operationId: active.operationId, status: result.status });
    draft.disposition = result.status === "SUCCEEDED" ? "answered" : "failed";
    const text = slackReplyText(resumedResultText({
      status: result.status,
      ...(typeof result.response === "string" ? { response: result.response } : {}),
      ...(result.error === undefined ? {} : { error: result.error }),
    }));
    draft.responseText = text;
    for (const chunk of splitSlackMessage(text)) await post(chunk);
    // The interrupted turn's session was not saved: the next turn's model reads this instead.
    if (dependencies.threads.saveTurnNote !== undefined) {
      try {
        await dependencies.threads.saveTurnNote(subject, { eventId: message.eventId, text: turnNoteText(message.text, active, text) });
      } catch (error) {
        log("turn.note_save_failed", { eventId: message.eventId, errorName: errorName(error) });
      }
    }
    await forgetActiveTurn();
  };
  // The old work goes on until its model or poll stops; how it ended is logged, never posted.
  const reportAfterHandoff = (work: Promise<unknown>) => {
    work.then(
      () => log("turn.after_handoff", { eventId: message.eventId, outcome: "finished" }),
      (error: unknown) => log("turn.after_handoff", { eventId: message.eventId, outcome: "failed", errorName: errorName(error) }),
    );
  };
  // Set when this turn waited for workspace setup up front, which the member was told about.
  let waitedForSetup = false;
  // Issue 157: the worker operation this attempt is waiting on, once the thread has saved it.
  let remembered: ActiveTurn | undefined;
  // Issue 157: a save of it still in flight, and whether this attempt claimed a confirmation.
  let pendingSave: Promise<void> | undefined;
  let claimed = false;
  // Issue 167: the task this attempt last started, saved or not, so a turn that gives up for good can cancel it.
  let accepted: { workspaceId: string; operationId: string } | undefined;
  /**
   * Issue 167: cancels a task nobody will wait on any more, so it stops holding the workspace (and
   * its compute). Bounded, and never throws: the turn must still finish before SIGKILL.
   */
  const cancelTask = async (target: { workspaceId: string; operationId: string }): Promise<"requested" | "finished" | "failed"> => {
    const fields = { eventId: message.eventId, workspaceId: target.workspaceId, operationId: target.operationId };
    try {
      if (api.cancelOperation === undefined) throw Object.assign(new Error("the thread API cannot cancel tasks"), { name: "CancelUnavailable" });
      const answer = await withinMilliseconds(api.cancelOperation(target.workspaceId, target.operationId), dependencies.cancelTaskMilliseconds ?? CANCEL_TASK_MILLISECONDS);
      if (answer.outcome === "finished") {
        log("turn.task_cancel_skipped", { ...fields, status: answer.status });
        return "finished";
      }
      log("turn.task_cancelled", fields);
      return "requested";
    } catch (error) {
      log("turn.task_cancel_failed", { ...fields, errorName: errorName(error) });
      return "failed";
    }
  };
  /** The task this attempt started or resumed, cancelled once the last delivery gives up on it; undefined when there was none. */
  const cancelAbandonedTask = async (): Promise<"requested" | "finished" | "failed" | undefined> => {
    const target = accepted ?? remembered;
    return target === undefined ? undefined : cancelTask(target);
  };
  try {
    // Issue 157: a redelivery of an attempt that ended while the thread still remembered its worker
    // operation (a hand-off, or a crash before the reply was posted) re-attaches to that operation. It runs no model, gate or new work, so an approved call never runs twice.
    if (options.redelivered === true && dependencies.threads.saveActiveTurn !== undefined) {
      const active = (await dependencies.threads.load(subject)).activeTurn;
      if (active?.eventId === message.eventId) {
        remembered = active;
        draft.workspaceId = active.workspaceId;
        await resumeTurn(active);
        finished = true;
        return;
      }
    }
    const modelCommand = parseModelCommand(message.text);
    if (modelCommand !== undefined) {
      if (api.listProjectModels === undefined) throw new Error("project model selection is unavailable in this deployment");
      const options = await api.listProjectModels();
      if (modelCommand.kind === "list") {
        draft.disposition = "model_list";
        await post(modelOptionsMessage(options));
      } else {
        draft.disposition = "model_switch";
        const matches = matchApprovedModel(modelCommand.selector, options.approved);
        if (matches.length !== 1) {
          const reason = modelCommand.selector.length === 0
            ? "Tell me which approved coding model to use."
            : matches.length === 0
              ? `No approved coding model matches “${escapeText(modelCommand.selector)}”.`
              : `“${escapeText(modelCommand.selector)}” matches more than one approved coding model.`;
          await post(modelOptionsMessage(options, reason));
        } else {
          if (api.selectProjectModel === undefined) throw new Error("project model selection is unavailable in this deployment");
          const selected = await api.selectProjectModel({ provider: matches[0]!.provider, modelId: matches[0]!.modelId });
          await post(`Project \`${escapeText(selected.projectName)}\` now uses ${escapeText(modelName(selected.current))} (\`${escapeText(selected.current.provider)}/${escapeText(selected.current.modelId)}\`) for coding work. This applies to every Slack workspace in the project on its next turn.`);
        }
      }
      finished = true;
      return;
    }
    if (isCloseWorkspaceRequest(message.text)) {
      draft.disposition = "workspace_close";
      const started = await api.startClose(deterministicUuid(`${message.eventId}:close`));
      if (started.outcome === "NOT_FOUND") {
        await post("This thread does not have a workspace to close.");
        finished = true;
        return;
      }
      if (started.outcome === "REFUSED") {
        await post(SHARED_CLOSE_REFUSED_MESSAGE);
        finished = true;
        return;
      }
      draft.workspaceId = started.workspaceId;
      if (started.outcome === "CLOSED") {
        await dependencies.threads.close(subject, { workspaceId: started.workspaceId, closedAt: started.closedAt });
        await post("This thread's workspace is already closed and its workspace resources have been released.");
        finished = true;
        return;
      }
      await post("Checking this workspace for unpublished work before closing it.");
      const preflight = await api.waitForOperation(started.workspaceId, started.operationId);
      if (preflight.status !== "SUCCEEDED") {
        await post(`I couldn't close this workspace because its safety check ${preflight.status.toLowerCase()}${preflight.error ? `: ${escapeText(preflight.error)}` : "."}`);
        finished = true;
        return;
      }
      const result = WorkspaceClosePreflightResultSchema.parse(preflight.result);
      if (!result.safeToClose) {
        await post(closeBlockedMessage(result));
        finished = true;
        return;
      }
      const closed = await api.completeClose(deterministicUuid(`${message.eventId}:close-complete`), started.operationId);
      await dependencies.threads.close(subject, { workspaceId: closed.workspaceId, closedAt: closed.closedAt });
      await post(closed.storageReleased
        ? "Workspace closed. Its runtime session and persistent workspace storage have been released."
        : "Workspace closed. This deployment mode has no persistent EBS session to release.");
      finished = true;
      return;
    }
    const now = dependencies.now ?? Date.now;
    let confirmation: Extract<ConfirmationCheck, { run: true }> | undefined;
    if (dependencies.confirmations) {
      // A "yes" from someone else, for a confirmation that is no longer pending, too early or too
      // late runs nothing and needs no workspace. Nothing is claimed until the turn is about to run.
      const check = await checkConfirmation({ message, subject, store: dependencies.confirmations, post, log, now: now() });
      if (!check.run) {
        // Spec 014 FR-021: a refused confirmation answer is recorded as such, not as abandoned.
        if (check.refused !== undefined) draft.disposition = "confirmation_refused";
        else if (check.answered === "cancelled") draft.disposition = "confirmation_cancelled";
        else if (check.answered === "yes_to_all") draft.disposition = "yes_to_all_granted";
        finished = true;
        return;
      }
      confirmation = check;
    }
    const workspaceRequestId = deterministicUuid(`${message.eventId}:workspace`);
    let workspace = await api.ensureWorkspace(workspaceRequestId);
    // Spec 025 FR-054, C12: a continue thread's turn starts only once the task's workspace is idle.
    if (taskBusy(workspace) && workspace.sharedTask !== undefined) {
      const taskId = workspace.sharedTask.taskId;
      const idle = await waitForIdleTask({ api, requestId: workspaceRequestId, first: workspace, post, log, eventId: message.eventId, now, announce: options.redelivered !== true });
      if (idle === "BUSY") {
        draft.disposition = "workspace_unavailable";
        draft.taskId = taskId;
        log("shared_task.still_busy", { eventId: message.eventId });
        await post(TASK_STILL_BUSY_MESSAGE);
        finished = true;
        return;
      }
      workspace = idle;
      // The member was told to wait, so the start is said again (spec 014 FR-026).
      waitedForSetup = true;
    }
    if (workspace.outcome === "LIMIT_REACHED") {
      draft.disposition = "workspace_limit";
      log("request.limit_reached", { eventId: message.eventId, limit: workspace.limit, maximum: workspace.maximum });
      await post(limitMessage(workspace));
      finished = true;
      return;
    }
    // C10: a view-only or closed shared thread; the message was queued before the switch.
    if (workspace.outcome === "VIEW_ONLY") {
      draft.disposition = "workspace_unavailable";
      draft.taskId = workspace.taskId;
      let notify = true;
      if (dependencies.threads.claimSharedNotice !== undefined) {
        try {
          notify = await dependencies.threads.claimSharedNotice(subject, Math.floor(now() / 1000), workspace.closed ? "closed" : "view");
        } catch (error) {
          log("shared_task.notice_claim_failed", { eventId: message.eventId, errorName: errorName(error) });
          notify = false;
        }
      }
      log("shared_task.not_run", { eventId: message.eventId, closed: workspace.closed, notified: notify });
      if (notify) await post(workspace.closed ? CLOSED_SHARED_NOTICE : VIEW_ONLY_NOTICE);
      finished = true;
      return;
    }
    draft.workspaceId = workspace.workspaceId;
    if (workspace.outcome === "CLOSED") {
      draft.disposition = "workspace_closed";
      await post("This thread's workspace is closed. Start a new Slack thread to create a fresh workspace.");
      finished = true;
      return;
    }
    if (workspace.settingsRevision !== undefined) draft.settingsRevision = workspace.settingsRevision;
    // C13: a continue-mode turn names its task and the teammate on its record.
    const shared = workspace.sharedTask;
    if (shared !== undefined) {
      draft.taskId = shared.taskId;
      const name = (await dependencies.userName?.(message.userId).catch(() => undefined))?.trim().slice(0, 80);
      if (name) draft.requesterName = name;
    }
    if (workspace.status === "PREPARING" && workspace.operationId) {
      await post(workspace.created ? NEW_WORKSPACE_MESSAGE : STILL_PREPARING_MESSAGE);
      const prepared = await api.waitForOperation(workspace.workspaceId, workspace.operationId);
      if (prepared.status !== "SUCCEEDED") {
        draft.disposition = "workspace_unavailable";
        log("workspace.preparation_failed", { eventId: message.eventId, status: prepared.status });
        await post(preparationFailedMessage(prepared.status));
        finished = true;
        return;
      }
      waitedForSetup = true;
    } else if (workspace.status !== "UNPREPARED" && !RUNNABLE_STATUSES.has(workspace.status)) {
      draft.disposition = "workspace_unavailable";
      log("workspace.unavailable", { eventId: message.eventId, status: workspace.status });
      // Final review M5: a shared task's failed setup is never retried from the thread (C11), so
      // mentioning again cannot help; only its developer can start the task again.
      if (shared !== undefined && workspace.status === "PREPARATION_FAILED") {
        await post(SHARED_SETUP_FAILED_MESSAGE);
        finished = true;
        return;
      }
      await post(`This thread's workspace is not available right now (${escapeText(workspace.status)}). Mention me again later to retry.`);
      finished = true;
      return;
    }

    const state = await dependencies.threads.load(subject);
    let conversationId = state.workspaceId === workspace.workspaceId ? state.conversationId : undefined;
    if (!conversationId) {
      conversationId = await api.createConversation(workspace.workspaceId);
      await dependencies.threads.saveConversation(subject, { workspaceId: workspace.workspaceId, conversationId });
    }
    draft.conversationId = conversationId;

    // Settings follow the project's latest revision, so say so the first time a thread moves.
    if (workspace.settingsRevision !== undefined && workspace.settingsRevision !== state.settingsRevision) {
      if (state.settingsRevision !== undefined) {
        await post(`Settings updated to revision ${workspace.settingsRevision}.`);
      }
      await dependencies.threads.saveSettingsRevision(subject, workspace.settingsRevision);
    }

    // Spec 014: a thread without compute prepares it only when a tool first needs the worker.
    const worker = workspace.status === "UNPREPARED"
      ? createLazyWorker({ api, post, log, eventId: message.eventId })
      : undefined;
    // Issue 157: past the hand-off deadline nothing new starts, and nothing is claimed, so the
    // redelivery runs this request as if it were the first attempt.
    if (options.handoff?.aborted === true) throw new TurnHandedOffError();
    // Spec 014 C5: claim the confirmation only now, after every early return above, so a turn that
    // never ran leaves it pending for the next "yes". A refused claim (used by another event, or
    // expired since the check) is always told to the member; nothing runs.
    if (confirmation?.claim && dependencies.confirmations
      && !await dependencies.confirmations.claim(subject, confirmation.claim.confirmationId, message.eventId)) {
      const current = await dependencies.confirmations.load(subject);
      const expired = current?.confirmationId === confirmation.claim.confirmationId && current.retiredAt === undefined && now() >= Date.parse(current.expiresAt);
      log("gate.confirmation_refused", { eventId: message.eventId, reason: expired ? "expired" : "already_used" });
      draft.disposition = "confirmation_refused";
      await post(expired ? EXPIRED_TEXT : "That confirmation was already used, so nothing was run. Ask me again if you still want it.");
      finished = true;
      return;
    }
    if (confirmation?.claim) claimed = true;
    // Spec 014 FR-026: the ingress has already said "I'm on it". Say work has started only when the
    // member was told to wait, behind earlier requests, for setup, or because SQS redelivered this
    // request after an earlier attempt threw: that attempt's own "Working on it now" is 15 minutes
    // stale by the time the retry runs, so this one says it again rather than restarting silently. An
    // older ingress sends no count, and a missing receive count is treated as not redelivered.
    const announceStart = options.queuedBehind === undefined || options.queuedBehind > 0 || waitedForSetup || options.redelivered === true;
    if (announceStart) await post("Working on it now. I'll post the result in this thread when it's done.");
    log("task.started", { eventId: message.eventId });
    let response: string;
    const turnStop = new AbortController();
    const workspaceForTurn = workspace.workspaceId;
    const saveActiveTurn = dependencies.threads.saveActiveTurn?.bind(dependencies.threads);
    const onOperationAccepted = async (operationId: string): Promise<void> => {
      // After the hand-off the redelivery owns the thread; a late acceptance must not move it.
      if (saveActiveTurn === undefined) return;
      if (handedOff) {
        // Issue 167: a task the broker accepted only after the last delivery gave up has no waiter at all.
        if (options.finalAttempt) await cancelTask({ workspaceId: workspaceForTurn, operationId });
        return;
      }
      accepted = { workspaceId: workspaceForTurn, operationId };
      // An approval's own text is only "yes": the note names what was approved instead.
      const approved = claimed ? confirmation?.session.approvals.map((approval) => approval.summary).join("; ") : undefined;
      const active: ActiveTurn = { eventId: message.eventId, workspaceId: workspaceForTurn, operationId, ...(approved ? { request: `the member approved: ${approved}` } : {}) };
      const saving = (async () => {
        try {
          await saveActiveTurn(subject, active);
          remembered = active;
        } catch (error) {
          log("turn.active_save_failed", { eventId: message.eventId, errorName: errorName(error) });
        }
      })();
      pendingSave = saving;
      await saving;
    };
    try {
      const turn = dependencies.runTurn({
        message,
        subject,
        workspaceId: workspace.workspaceId,
        conversationId,
        orchestratorInstructions: workspace.orchestratorInstructions,
        ...(workspace.connectors === undefined ? {} : { connectors: workspace.connectors }),
        ...(workspace.repositories === undefined ? {} : { repositories: workspace.repositories }),
        ...(workspace.recoverableOperations === undefined ? {} : { recoverableOperations: workspace.recoverableOperations }),
        // Every status that reaches here other than UNPREPARED has prepared compute (READY, STOPPED,
        // BUSY, or PREPARING that this turn waited out).
        ...(worker === undefined ? { computePrepared: true } : { worker }),
        ...(confirmation === undefined ? {} : { gate: confirmation.session }),
        ...(workspace.actionPolicy === undefined ? {} : { actionPolicy: workspace.actionPolicy }),
        requestId: requestIdSequence(message.eventId),
        ...(recorder === undefined ? {} : { recorder }),
        ...(state.refreshConnectors?.length ? { refreshConnectors: state.refreshConnectors } : {}),
        // A service that cannot remember operations, or is never stopped mid-turn, runs the turn as before.
        ...(dependencies.threads.saveActiveTurn === undefined ? {} : { onOperationAccepted }),
        ...(options.handoff === undefined ? {} : { signal: turnStop.signal }),
        ...(state.turnNote === undefined ? {} : { turnNote: state.turnNote.text }),
      });
      try {
        response = await untilHandoff(turn, options.handoff);
      } catch (error) {
        if (!(error instanceof TurnHandedOffError)) throw error;
        handedOff = true;
        // The old turn keeps running until the model stops; its answer is no longer anyone's.
        reportAfterHandoff(turn);
        turnStop.abort();
        throw error;
      }
      draft.disposition = "answered";
      log("task.completed", { eventId: message.eventId, responseLength: response.length });
    } catch (error) {
      if (error instanceof TurnHandedOffError) throw error;
      draft.disposition = "failed";
      draft.error = errorSummary(error);
      log("task.failed", { eventId: message.eventId, errorName: errorName(error) });
      response = `AgentX could not complete the request: ${safeMessage(error)}`;
    }
    // Formatted before anything is posted (spec 014 FR-022): the turn record keeps the formatted
    // text, and post() remembers each formatted chunk as lastPosted. When a confirmation stands as
    // the whole reply, the member sees only the confirmation, but the record still keeps this text.
    draft.responseText = slackReplyText(response);
    // A turn that posted a confirmation and did nothing else lets the confirmation be its reply: the
    // model's own words would only restate it. Its text is still recorded as the turn's response.
    let quiet = false;
    if (confirmation && dependencies.confirmations) {
      let settled: Awaited<ReturnType<typeof settleConfirmations>> | undefined;
      try {
        settled = await settleConfirmations({
          check: confirmation, message, subject, store: dependencies.confirmations, log, now: now(),
          postConfirmation: (pending, text) => dependencies.postConfirmation ? dependencies.postConfirmation(message.thread, pending, text) : post(text),
        });
      } catch (error) {
        log("gate.confirmation_failed", { eventId: message.eventId, errorName: errorName(error) });
        await post("I couldn't save the confirmation request, so nothing it would list will run. Ask me again.");
      }
      if (settled?.outcome === "posted") draft.confirmationPosted = true;
      // Withheld only when nothing but asks happened (no call ran, none was refused or failed the
      // gate), or when the model said nothing at all; otherwise the member must hear the rest.
      const onlyAsked = confirmation.session.ran === 0
        && !confirmation.session.decisions.some((decision) => decision.outcome === "deny" || decision.source === "gate_error");
      if (settled?.outcome === "posted" && draft.disposition === "answered" && (onlyAsked || draft.responseText.trim().length === 0)) {
        quiet = true;
        log("gate.reply_withheld", { eventId: message.eventId, ran: confirmation.session.ran });
      } else if (settled?.outcome === "already_answered") {
        await post("This request was retried after an interruption, and I had already asked you to confirm it and had my answer, so I didn't ask again. Ask me again if you still want it.");
      } else if (settled?.outcome === "already_pending" && settled.differs) {
        await post(`I didn't ask again: the pending confirmation still lists ${shortList(settled.pendingSummaries)}. Ask me again for anything else.`);
      }
    }
    if (!quiet) {
      // C13: in a continue thread, the reply names the teammate it answers.
      const mention = shared === undefined ? "" : `<@${message.userId}> `;
      const chunks = splitSlackMessage(`${mention}${slackReplyText(response)}`);
      const details = replyDetails(dependencies, recorder, message);
      for (const [index, chunk] of chunks.entries()) {
        if (details !== undefined && index === chunks.length - 1) await postWithDetails(details, chunk);
        else await post(chunk);
      }
    }
    if (recorder !== undefined) await rememberRefresh(dependencies, log, subject, message.eventId, state.refreshConnectors ?? [], recorder);
    // Only once the member has the reply: a failed post before this is redelivered and resumes.
    if (remembered !== undefined) await forgetActiveTurn();
    // The model has read the note from a resumed turn, and a turn that answered saved its session,
    // so later turns have it there. A failed turn saved nothing, so the note stays for the next.
    // Only the latest resume's note is kept: a second resume replaces it.
    if (state.turnNote !== undefined && draft.disposition === "answered") {
      try {
        await dependencies.threads.saveTurnNote?.(subject, undefined);
      } catch (error) {
        log("turn.note_clear_failed", { eventId: message.eventId, errorName: errorName(error) });
      }
    }
    finished = true;
  } catch (error) {
    if (error instanceof TurnHandedOffError) {
      handedOff = true;
      // A save already in flight names the task in the notice and the log (and the redelivery reads it).
      if (pendingSave !== undefined) await withinMilliseconds(pendingSave, PENDING_SAVE_MILLISECONDS).catch(() => undefined);
      log("turn.interrupted", {
        eventId: message.eventId,
        ...(draft.workspaceId === undefined ? {} : { workspaceId: draft.workspaceId }),
        ...(remembered === undefined ? {} : { operationId: remembered.operationId }),
      });
      // The notice is best effort and bounded: the release must happen before SIGKILL whatever Slack does.
      const notice = async (text: string) => {
        try {
          await withinMilliseconds(dependencies.post(message.thread, text), dependencies.handoffNoticeMilliseconds ?? 10_000);
          lastPosted = text;
        } catch (postError) {
          log("turn.interrupted_notice_failed", { eventId: message.eventId, errorName: errorName(postError) });
        }
      };
      if (!options.finalAttempt) {
        await notice(remembered !== undefined ? HANDOFF_TASK_TEXT : claimed ? HANDOFF_APPROVED_TEXT : HANDOFF_TEXT);
        throw error;
      }
      // The last allowed delivery: a release would only send the message to the dead-letter queue.
      draft.disposition = "abandoned";
      delete draft.responseText;
      // Issue 167: nobody will wait on the task any more, so it is stopped before the thread forgets it.
      const cancelled = await cancelAbandonedTask();
      await notice({
        none: HANDOFF_FINAL_IDLE_TEXT, requested: HANDOFF_FINAL_TEXT, finished: HANDOFF_FINAL_FINISHED_TEXT, failed: HANDOFF_FINAL_CANCEL_FAILED_TEXT,
      }[cancelled ?? "none"]);
      if (remembered !== undefined) await forgetActiveTurn();
      finished = true;
      return;
    }
    // Redelivery resumes the same operations because every request ID derives from the Slack event ID.
    if (!options.finalAttempt) throw error;
    draft.disposition = "abandoned";
    draft.error = errorSummary(error);
    // The member sees the abandonment notice, so the record keeps that rather than an unposted answer.
    delete draft.responseText;
    log("request.abandoned", { eventId: message.eventId, errorName: errorName(error) });
    // Issue 167: as at a final hand-off, the task this attempt started is stopped before it is forgotten.
    const cancelled = await cancelAbandonedTask();
    const abandoned = `AgentX could not process this request: ${escapeText(safeMessage(error))}`;
    const after = cancelled === undefined
      ? undefined
      : { requested: ABANDONED_TASK_TEXT, finished: ABANDONED_TASK_FINISHED_TEXT, failed: ABANDONED_TASK_CANCEL_FAILED_TEXT }[cancelled];
    await post(after === undefined ? abandoned : `${abandoned}\n\n${after}`).catch((postError: unknown) => {
      log("request.abandoned_notice_failed", { eventId: message.eventId, errorName: errorName(postError) });
    });
    if (remembered !== undefined) await forgetActiveTurn();
    finished = true;
  } finally {
    if (finished) {
      // Only a finished event is recorded: an attempt that throws for redelivery leaves the one
      // record to the attempt that finishes (SC-006).
      if (dependencies.turnRecords !== undefined && recorder !== undefined) {
        await recordTurn(dependencies.turnRecords, log, recorder, { message, subject, startedAt, finishedAt: new Date(), draft, lastPosted });
      }
      await dependencies.threads.finish(subject);
    }
  }
}

/** Issue 157: the work's outcome, or a TimeoutError once `milliseconds` pass first. */
function withinMilliseconds<T>(work: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("timed out"), { name: "TimeoutError" })), milliseconds);
    timer.unref?.();
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Issue 157: the work's own outcome, or a TurnHandedOffError once the hand-off deadline passes
 * first (at once when it already has). The work itself is left to the caller to stop.
 */
function untilHandoff<T>(work: Promise<T>, handoff: AbortSignal | undefined): Promise<T> {
  if (handoff === undefined) return work;
  if (handoff.aborted) return Promise.reject(new TurnHandedOffError());
  return new Promise<T>((resolve, reject) => {
    const onHandoff = () => reject(new TurnHandedOffError());
    handoff.addEventListener("abort", onHandoff, { once: true });
    work.then(resolve, reject).finally(() => handoff.removeEventListener("abort", onHandoff));
  });
}

/**
 * The Details button's target, when the reply should carry one: the turn called at least one tool,
 * and its record will be written (a sink and a recorder exist), so the button always names a record
 * the service tries to save. The value derives from the Slack event, as the record's key does.
 */
function replyDetails(dependencies: ProcessorDependencies, recorder: TurnRecorder | undefined, message: SlackRequestMessage): ReplyDetails | undefined {
  const postWithBlocks = dependencies.postWithBlocks;
  if (postWithBlocks === undefined || dependencies.turnRecords === undefined || recorder === undefined) return undefined;
  let calls: number;
  try {
    calls = recorder.observation().calls.length;
  } catch {
    // The record's own write reports a broken recorder; the reply just goes without a button.
    return undefined;
  }
  if (calls === 0) return undefined;
  const value = detailsButtonValue(message);
  return value === undefined ? undefined : { value, postWithBlocks };
}

/**
 * Builds, validates, fits and writes the record inside one try: any failure, including a record
 * that fails its schema, is logged by event ID and error class with a metric, and never reaches the
 * member, who already has their reply. Record contents are never logged.
 *
 * Turn metrics are emitted in their own try, separate from the write: a turn that ran the
 * orchestrator is counted whether or not its record could be written (including a write that throws
 * or times out), but a turn whose record never built has nothing to derive metrics from. A failure
 * while emitting metrics is reported on its own event, never mislabelled as a write failure.
 */
async function recordTurn(
  sink: TurnRecordSink,
  log: ServiceLog,
  recorder: TurnRecorder,
  input: Omit<Parameters<typeof buildTurnRecord>[0], "observation">,
): Promise<void> {
  let record: TurnRecord | undefined;
  let duplicate = false;
  try {
    record = buildTurnRecord({ ...input, observation: recorder.observation() });
    duplicate = await sink.write(record) === "duplicate";
  } catch (error) {
    // recordTurn must never throw: it runs from processSlackRequest's finally, after the member
    // already has their reply, so a logging failure here must not skip threads.finish and invite a
    // redelivery that would post the reply again.
    try {
      log("turn_record.write_failed", { eventId: input.message.eventId, errorName: errorName(error) });
    } catch {
      // Logging itself failed; nothing left to report to.
    }
    try {
      log("metric", { metric: "TurnRecordWriteFailed", count: 1 });
    } catch {
      // Logging itself failed; nothing left to report to.
    }
  }
  if (duplicate) {
    // Outside the write try, so a logging failure here is never reported as a write failure.
    try {
      log("turn_record.duplicate", { eventId: input.message.eventId });
    } catch {
      // Logging itself failed; nothing left to report to.
    }
  }
  if (record !== undefined && !duplicate) {
    try {
      emitTurnMetrics(record, log);
    } catch (error) {
      try {
        log("turn_metrics.emit_failed", { eventId: input.message.eventId, errorName: errorName(error) });
      } catch {
        // Logging itself failed; nothing left to report to.
      }
    }
  }
}

/**
 * Remembers which connectors saw a changed definition this turn, writing only when the set changes.
 * It never throws: the member already has their reply, and a throw here would invite a redelivery
 * that posts it again. The cost of a lost write is one turn served from a stale catalog cache, which
 * the call-time schema check still refuses.
 *
 * The list clears even when the refreshed discovery itself failed. That heals itself: the refresh
 * already evicted the connector's cache entry, so the next turn discovers afresh, and the call-time
 * schema check catches any drift again and puts the connector back on the list.
 */
async function rememberRefresh(
  dependencies: ProcessorDependencies,
  log: ServiceLog,
  subject: string,
  eventId: string,
  previous: readonly string[],
  recorder: TurnRecorder,
): Promise<void> {
  const save = dependencies.threads.saveRefreshConnectors?.bind(dependencies.threads);
  if (save === undefined) return;
  try {
    const observation: TurnObservation = recorder.observation();
    // A turn that never reached its tool offer never finished discovery, so it neither used the
    // remembered refresh nor learned anything new: keep the list for the next turn.
    if (observation.manifestHash === undefined) return;
    const next = [...new Set(observation.calls.flatMap((call) => call.reason === "schema_changed" && call.connector !== undefined ? [call.connector] : []))].sort();
    if (JSON.stringify(next) === JSON.stringify([...previous].sort())) return;
    await save(subject, next);
  } catch (error) {
    try {
      log("thread.refresh_save_failed", { eventId, errorName: errorName(error) });
    } catch {
      // Logging itself failed; nothing left to report to.
    }
  }
}

function errorSummary(error: unknown): { name: string; code?: string } {
  const code = (error as { code?: unknown } | null)?.code;
  return {
    name: errorName(error).slice(0, 128),
    ...(typeof code === "string" ? { code: code.slice(0, 64) } : {}),
  };
}

export function isCloseWorkspaceRequest(text: string): boolean {
  const normalized = text
    .replace(/^\s*<@[A-Z0-9]+>\s*/iu, "")
    .trim()
    .replace(/[.!?]+$/u, "")
    .trim()
    .toLowerCase();
  return normalized === "close this workspace" || normalized === "close workspace";
}

function closeBlockedMessage(result: ReturnType<typeof WorkspaceClosePreflightResultSchema.parse>): string {
  const findings = result.repositories.map((repository) => {
    const reasons = repository.reasons.map((reason) => ({
      worktree_changes: "uncommitted changes",
      untracked_files: "untracked files",
      unpushed_head: "an unpushed current commit",
      unpushed_branch: "commits on a local-only branch",
    })[reason]);
    return `• ${repository.name}: ${reasons.join(", ")}`;
  });
  return [
    "I didn't close this workspace because it contains unpublished work:",
    ...findings,
    "Publish or remove that work, then ask me to close the workspace again.",
  ].join("\n");
}

export { slackThreadUrl } from "@agentx/contracts";

/** At most three Slack-escaped summaries of at most 80 characters each, then how many more. */
function shortList(summaries: readonly string[]): string {
  const shown = summaries.slice(0, 3).map((summary) => escapeText(summary.length > 80 ? `${summary.slice(0, 79)}…` : summary));
  return summaries.length > 3 ? `${shown.join("; ")} and ${summaries.length - 3} more` : shown.join("; ");
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown error";
  return message.length > 500 ? `${message.slice(0, 500)}…` : message;
}

/**
 * Slack's error code when chat.postMessage answered with a refusal ("Slack chat.postMessage failed:
 * invalid_blocks"), so the message was not posted; undefined for anything else, including an HTTP
 * status with no error code. Codes are lowercase identifiers and carry no user text.
 */
function slackRefusal(error: unknown): string | undefined {
  const match = error instanceof Error ? /^Slack chat\.postMessage failed: ([a-z_]{1,64})$/.exec(error.message) : null;
  return match?.[1];
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}
