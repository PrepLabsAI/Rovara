import {
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

export interface ThreadServiceApi {
  ensureWorkspace(requestId: string): Promise<SlackThreadWorkspaceResult>;
  /** Spec 014: prepares compute for a thread whose workspace is UNPREPARED. */
  prepareWorkspace?(requestId: string): Promise<SlackThreadPrepareResult>;
  startClose(requestId: string): Promise<SlackWorkspaceCloseStartResult>;
  completeClose(requestId: string, operationId: string): Promise<SlackWorkspaceCloseCompleteResult>;
  waitForOperation(workspaceId: string, operationId: string, signal?: AbortSignal): Promise<{ status: string; error?: string | undefined; result?: unknown }>;
  createConversation(workspaceId: string): Promise<string>;
}

export interface ThreadState {
  workspaceId?: string;
  conversationId?: string;
  /** The settings revision this thread was last told about, so a change is announced once. */
  settingsRevision?: number;
  closedAt?: string;
  /** Connectors whose last turn failed with schema_changed; the next discovery asks for a refresh. */
  refreshConnectors?: string[];
}

export interface ThreadStore {
  load(subject: string): Promise<ThreadState>;
  saveConversation(subject: string, state: { workspaceId: string; conversationId: string }): Promise<void>;
  saveSettingsRevision(subject: string, revision: number): Promise<void>;
  close(subject: string, state: { workspaceId: string; closedAt: string }): Promise<void>;
  finish(subject: string): Promise<void>;
  /** Remembers the connectors whose next discovery should ask for a refresh; an empty list clears them. */
  saveRefreshConnectors?(subject: string, connectors: string[]): Promise<void>;
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
  // Remembers only what reached Slack, so the record never claims a message the member did not see.
  const post = async (text: string) => {
    await dependencies.post(message.thread, text);
    lastPosted = text;
  };
  const api = dependencies.api(message);
  let finished = false;
  // Set when this turn waited for workspace setup up front, which the member was told about.
  let waitedForSetup = false;
  try {
    if (isCloseWorkspaceRequest(message.text)) {
      draft.disposition = "workspace_close";
      const started = await api.startClose(deterministicUuid(`${message.eventId}:close`));
      if (started.outcome === "NOT_FOUND") {
        await post("This thread does not have a workspace to close.");
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
    const workspace = await api.ensureWorkspace(deterministicUuid(`${message.eventId}:workspace`));
    if (workspace.outcome === "LIMIT_REACHED") {
      draft.disposition = "workspace_limit";
      log("request.limit_reached", { eventId: message.eventId, limit: workspace.limit, maximum: workspace.maximum });
      await post(limitMessage(workspace));
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
    // Spec 014 FR-026: the ingress has already said "I'm on it". Say work has started only when the
    // member was told to wait, behind earlier requests, for setup, or because SQS redelivered this
    // request after an earlier attempt threw: that attempt's own "Working on it now" is 15 minutes
    // stale by the time the retry runs, so this one says it again rather than restarting silently. An
    // older ingress sends no count, and a missing receive count is treated as not redelivered.
    const announceStart = options.queuedBehind === undefined || options.queuedBehind > 0 || waitedForSetup || options.redelivered === true;
    if (announceStart) await post("Working on it now. I'll post the result in this thread when it's done.");
    log("task.started", { eventId: message.eventId });
    let response: string;
    try {
      response = await dependencies.runTurn({
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
      });
      draft.disposition = "answered";
      log("task.completed", { eventId: message.eventId, responseLength: response.length });
    } catch (error) {
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
    if (!quiet) for (const chunk of splitSlackMessage(slackReplyText(response))) await post(chunk);
    if (recorder !== undefined) await rememberRefresh(dependencies, log, subject, message.eventId, state.refreshConnectors ?? [], recorder);
    finished = true;
  } catch (error) {
    // Redelivery resumes the same operations because every request ID derives from the Slack event ID.
    if (!options.finalAttempt) throw error;
    draft.disposition = "abandoned";
    draft.error = errorSummary(error);
    // The member sees the abandonment notice, so the record keeps that rather than an unposted answer.
    delete draft.responseText;
    log("request.abandoned", { eventId: message.eventId, errorName: errorName(error) });
    await post(`AgentX could not process this request: ${escapeText(safeMessage(error))}`).catch(() => undefined);
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

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}
