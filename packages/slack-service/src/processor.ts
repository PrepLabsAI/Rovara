import {
  slackThreadSubject,
  slackThreadUrl,
  splitSlackMessage,
  WorkspaceClosePreflightResultSchema,
  type SlackRequestMessage,
  type SlackThread,
  type SlackThreadWorkspaceResult,
  type SlackWorkspaceCloseCompleteResult,
  type SlackWorkspaceCloseStartResult,
  type ThreadConnector,
  type TurnRecord,
} from "@agentx/contracts";
import { TurnRecorder } from "@agentx/orchestrator/turn-recorder";
import { deterministicUuid, requestIdSequence } from "./ids.js";
import { buildTurnRecord, emitTurnMetrics, type TurnDraft, type TurnRecordSink } from "./turn-records.js";

export interface ThreadServiceApi {
  ensureWorkspace(requestId: string): Promise<SlackThreadWorkspaceResult>;
  startClose(requestId: string): Promise<SlackWorkspaceCloseStartResult>;
  completeClose(requestId: string, operationId: string): Promise<SlackWorkspaceCloseCompleteResult>;
  waitForOperation(workspaceId: string, operationId: string): Promise<{ status: string; error?: string | undefined; result?: unknown }>;
  createConversation(workspaceId: string): Promise<string>;
}

export interface ThreadState {
  workspaceId?: string;
  conversationId?: string;
  /** The settings revision this thread was last told about, so a change is announced once. */
  settingsRevision?: number;
  closedAt?: string;
}

export interface ThreadStore {
  load(subject: string): Promise<ThreadState>;
  saveConversation(subject: string, state: { workspaceId: string; conversationId: string }): Promise<void>;
  saveSettingsRevision(subject: string, revision: number): Promise<void>;
  close(subject: string, state: { workspaceId: string; closedAt: string }): Promise<void>;
  finish(subject: string): Promise<void>;
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
  requestId: () => string;
  /** Collects this turn's record; the processor writes it once the event is finished. */
  recorder?: TurnRecorder;
}

export type ServiceLog = (event: string, fields: Readonly<Record<string, string | number | boolean>>) => void;

export interface ProcessorDependencies {
  api: (message: SlackRequestMessage) => ThreadServiceApi;
  threads: ThreadStore;
  runTurn: (input: TurnInput) => Promise<string>;
  post: (thread: SlackThread, text: string) => Promise<void>;
  log?: ServiceLog;
  /** Where one hidden record per finished Slack event goes; without it nothing is recorded. */
  turnRecords?: TurnRecordSink;
}

const RUNNABLE_STATUSES = new Set(["READY", "STOPPED", "BUSY"]);

export async function processSlackRequest(
  message: SlackRequestMessage,
  dependencies: ProcessorDependencies,
  options: { finalAttempt: boolean },
): Promise<void> {
  const subject = slackThreadSubject(message.thread);
  const log: ServiceLog = dependencies.log ?? (() => undefined);
  const startedAt = new Date();
  // Only a configured sink gets a recorder, so a service without one runs the turn exactly as before.
  const recorder = dependencies.turnRecords === undefined ? undefined : new TurnRecorder();
  const draft: TurnDraft = { disposition: "abandoned" };
  let lastPosted = "";
  // Remembers only what reached Slack, so the record never claims a message the member did not see.
  const post = async (text: string) => {
    await dependencies.post(message.thread, text);
    lastPosted = text;
  };
  const api = dependencies.api(message);
  let finished = false;
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
        await post(`I couldn't close this workspace because its safety check ${preflight.status.toLowerCase()}${preflight.error ? `: ${preflight.error}` : "."}`);
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
      await post(workspace.created
        ? "Setting up a new workspace for this thread. The first request takes a few minutes."
        : "This thread's workspace is still being set up. I'll start as soon as it's ready.");
      const prepared = await api.waitForOperation(workspace.workspaceId, workspace.operationId);
      if (prepared.status !== "SUCCEEDED") {
        draft.disposition = "workspace_unavailable";
        log("workspace.preparation_failed", { eventId: message.eventId, status: prepared.status });
        await post(`AgentX could not set up this thread's workspace (${prepared.status}). Mention me again in this thread to retry.`);
        finished = true;
        return;
      }
    } else if (!RUNNABLE_STATUSES.has(workspace.status)) {
      draft.disposition = "workspace_unavailable";
      log("workspace.unavailable", { eventId: message.eventId, status: workspace.status });
      await post(`This thread's workspace is not available right now (${workspace.status}). Mention me again later to retry.`);
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

    await post("Working on it now. I'll post the result in this thread when it's done.");
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
        requestId: requestIdSequence(message.eventId),
        ...(recorder === undefined ? {} : { recorder }),
      });
      draft.disposition = "answered";
      log("task.completed", { eventId: message.eventId, responseLength: response.length });
    } catch (error) {
      draft.disposition = "failed";
      draft.error = errorSummary(error);
      log("task.failed", { eventId: message.eventId, errorName: errorName(error) });
      response = `AgentX could not complete the request: ${safeMessage(error)}`;
    }
    draft.responseText = response;
    for (const chunk of splitSlackMessage(response)) await post(chunk);
    finished = true;
  } catch (error) {
    // Redelivery resumes the same operations because every request ID derives from the Slack event ID.
    if (!options.finalAttempt) throw error;
    draft.disposition = "abandoned";
    draft.error = errorSummary(error);
    // The member sees the abandonment notice, so the record keeps that rather than an unposted answer.
    delete draft.responseText;
    log("request.abandoned", { eventId: message.eventId, errorName: errorName(error) });
    await post(`AgentX could not process this request: ${safeMessage(error)}`).catch(() => undefined);
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
    const written = await sink.write(record);
    if (written === "duplicate") {
      duplicate = true;
      log("turn_record.duplicate", { eventId: input.message.eventId });
    }
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

function limitMessage(result: Extract<SlackThreadWorkspaceResult, { outcome: "LIMIT_REACHED" }>): string {
  if (result.limit === "ORGANIZATION") {
    return `This organization already has ${result.maximum} AgentX workspaces, the most allowed, so I can't start a new one. ` +
      "Continue in an existing thread, or ask an administrator to raise the limit.";
  }
  const links = result.starterThreads.map((thread, index) => `• <${slackThreadUrl(thread)}|Thread ${index + 1}>`);
  return [
    `You already have ${result.maximum} AgentX workspaces, the most one person can have, so I can't start a new one. ` +
      "Continue in one of your existing threads instead:",
    ...links,
  ].join("\n");
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown error";
  return message.length > 500 ? `${message.slice(0, 500)}…` : message;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}
