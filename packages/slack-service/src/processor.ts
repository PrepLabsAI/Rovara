import {
  slackThreadSubject,
  splitSlackMessage,
  WorkspaceClosePreflightResultSchema,
  type SlackRequestMessage,
  type SlackThread,
  type SlackThreadWorkspaceResult,
  type SlackWorkspaceCloseCompleteResult,
  type SlackWorkspaceCloseStartResult,
} from "@agentx/contracts";
import { deterministicUuid, requestIdSequence } from "./ids.js";

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
  githubMcpRepositories?: string[];
  requestId: () => string;
}

export type ServiceLog = (event: string, fields: Readonly<Record<string, string | number | boolean>>) => void;

export interface ProcessorDependencies {
  api: (message: SlackRequestMessage) => ThreadServiceApi;
  threads: ThreadStore;
  runTurn: (input: TurnInput) => Promise<string>;
  post: (thread: SlackThread, text: string) => Promise<void>;
  log?: ServiceLog;
}

const RUNNABLE_STATUSES = new Set(["READY", "STOPPED", "BUSY"]);

export async function processSlackRequest(
  message: SlackRequestMessage,
  dependencies: ProcessorDependencies,
  options: { finalAttempt: boolean },
): Promise<void> {
  const subject = slackThreadSubject(message.thread);
  const log: ServiceLog = dependencies.log ?? (() => undefined);
  const post = (text: string) => dependencies.post(message.thread, text);
  const api = dependencies.api(message);
  let finished = false;
  try {
    if (isCloseWorkspaceRequest(message.text)) {
      const started = await api.startClose(deterministicUuid(`${message.eventId}:close`));
      if (started.outcome === "NOT_FOUND") {
        await post("This thread does not have a workspace to close.");
        finished = true;
        return;
      }
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
      log("request.limit_reached", { eventId: message.eventId, limit: workspace.limit, maximum: workspace.maximum });
      await post(limitMessage(workspace));
      finished = true;
      return;
    }
    if (workspace.outcome === "CLOSED") {
      await post("This thread's workspace is closed. Start a new Slack thread to create a fresh workspace.");
      finished = true;
      return;
    }
    if (workspace.status === "PREPARING" && workspace.operationId) {
      await post(workspace.created
        ? "Setting up a new workspace for this thread. The first request takes a few minutes."
        : "This thread's workspace is still being set up. I'll start as soon as it's ready.");
      const prepared = await api.waitForOperation(workspace.workspaceId, workspace.operationId);
      if (prepared.status !== "SUCCEEDED") {
        log("workspace.preparation_failed", { eventId: message.eventId, status: prepared.status });
        await post(`AgentX could not set up this thread's workspace (${prepared.status}). Mention me again in this thread to retry.`);
        finished = true;
        return;
      }
    } else if (!RUNNABLE_STATUSES.has(workspace.status)) {
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
        ...(workspace.githubMcpRepositories === undefined ? {} : { githubMcpRepositories: workspace.githubMcpRepositories }),
        requestId: requestIdSequence(message.eventId),
      });
      log("task.completed", { eventId: message.eventId, responseLength: response.length });
    } catch (error) {
      log("task.failed", { eventId: message.eventId, errorName: errorName(error) });
      response = `AgentX could not complete the request: ${safeMessage(error)}`;
    }
    for (const chunk of splitSlackMessage(response)) await post(chunk);
    finished = true;
  } catch (error) {
    // Redelivery resumes the same operations because every request ID derives from the Slack event ID.
    if (!options.finalAttempt) throw error;
    log("request.abandoned", { eventId: message.eventId, errorName: errorName(error) });
    await post(`AgentX could not process this request: ${safeMessage(error)}`).catch(() => undefined);
    finished = true;
  } finally {
    if (finished) await dependencies.threads.finish(subject);
  }
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

export function slackThreadUrl(thread: SlackThread): string {
  return `https://slack.com/archives/${thread.channelId}/p${thread.threadTs.replace(".", "")}`;
}

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
