import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { WorkerInvocationSchema, agentXError, type WorkerInvocation } from "@agentx/contracts";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { publishWorkspaceDiff, type ArtifactSink } from "./artifacts.js";
import { WorkspaceConversationStore, type ConversationRecord } from "./conversations.js";
import {
  createDevcontainerCli,
  devcontainerBashOperations,
  ensureDevcontainer,
  preparedDevcontainerTarget,
  type DevcontainerCli,
} from "./devcontainer.js";
import { EventBatcher, redactCredentials, type EventBatchSink } from "./events.js";
import { ToolLoopGuard } from "./tool-loop-guard.js";
import {
  createWorkspacePiSession,
  openRegisteredWorkspacePiSession,
  type PiSessionAdapter,
  type PiSessionHandle,
  type WorkspaceModelConfiguration,
} from "./pi-session.js";
import type { PreparationManifest } from "./prepare.js";
import { WorkerOperationCancelledError, type WorkerCancellationController } from "./cancel.js";
import {
  createTaskUsageTelemetry,
  type TaskUsageOutcome,
} from "./usage.js";

export interface TaskInvocationResult {
  /** The broker-issued conversation ID, which stays the same for every turn of one conversation. */
  conversationId: string;
  /** False on the turn that created the saved session, true on every turn that reopened it. */
  reopened: boolean;
}

export async function runTaskInvocation(
  untrustedInvocation: WorkerInvocation,
  dependencies: {
    rootPath: string;
    model: WorkspaceModelConfiguration;
    eventSink: EventBatchSink;
    artifactSink: ArtifactSink;
    piAdapter?: PiSessionAdapter;
    cancellationController?: WorkerCancellationController;
    devcontainerCli?: DevcontainerCli;
  },
): Promise<TaskInvocationResult> {
  const invocation = WorkerInvocationSchema.parse(untrustedInvocation);
  if (invocation.kind !== "task") throw agentXError("CONFIG_INVALID", "runTaskInvocation requires a task");
  const manifest = JSON.parse(
    await readFile(resolve(dependencies.rootPath, ".agentx/preparation-manifest.json"), "utf8"),
  ) as PreparationManifest;
  if (!manifest.complete || manifest.projectRevision !== invocation.projectRevision) {
    throw agentXError("WORKSPACE_NOT_READY", "workspace manifest is incomplete or revision-mismatched");
  }

  // The agent's shell runs in the project's devcontainer (#121), started first: on a resumed
  // instance its containers are stopped.
  const canonicalRoot = await realpath(resolve(dependencies.rootPath));
  const devcontainer = preparedDevcontainerTarget(canonicalRoot, manifest);
  let bashOperations: BashOperations | undefined;
  if (devcontainer !== undefined) {
    const cli = dependencies.devcontainerCli ?? createDevcontainerCli();
    await ensureDevcontainer(cli, devcontainer);
    bashOperations = devcontainerBashOperations(cli, devcontainer);
  }

  const conversationId = invocation.payload.conversationId;
  const conversations = new WorkspaceConversationStore(dependencies.rootPath);
  const registered = await conversations.tryResolve(conversationId);
  if (!registered && invocation.payload.conversationStarted === true) {
    throw agentXError(
      "CONVERSATION_STATE_LOST",
      "this conversation already started, but its saved session is not in this workspace",
    );
  }

  const events = new EventBatcher(dependencies.eventSink);
  const toolEvidence: unknown[] = [];
  const contextDiagnostics: string[] = [];
  const onDiagnostic = (message: string): void => {
    contextDiagnostics.push(message);
  };
  if (invocation.payload.modelSelectionDiagnostic !== undefined) {
    onDiagnostic(invocation.payload.modelSelectionDiagnostic);
  }
  for (const message of modelChangeDiagnostics(registered, dependencies.model)) onDiagnostic(message);

  let session: PiSessionHandle;
  if (registered) {
    session = await openRegisteredWorkspacePiSession(
      {
        rootPath: dependencies.rootPath,
        model: dependencies.model,
        conversationId,
        sessionFile: registered.sessionFile,
        onDiagnostic,
        ...(bashOperations === undefined ? {} : { bashOperations }),
      },
      dependencies.piAdapter,
    );
  } else {
    session = await createWorkspacePiSession(
      {
        rootPath: dependencies.rootPath, model: dependencies.model, conversationId, onDiagnostic,
        ...(bashOperations === undefined ? {} : { bashOperations }),
      },
      dependencies.piAdapter,
    );
  }
  try {
    // Written before the prompt, so a crash mid-turn orphans an empty session rather than the transcript.
    if (registered) await conversations.recordTurn(conversationId, dependencies.model);
    else await conversations.register(session.sessionFile, conversationId, dependencies.model);
  } catch (error) {
    session.dispose();
    throw error;
  }

  const unregisterCancellation = dependencies.cancellationController?.register(invocation.operationId, session);
  // A model repeating the same failing call is told once, then stopped (#127).
  const loopGuard = new ToolLoopGuard();
  let loopStop: Error | undefined;
  const unsubscribe = session.subscribe((event) => {
    if (eventType(event) === "tool_end") toolEvidence.push(redactCredentials(event));
    void events.append(eventType(event), event).catch(() => undefined);
    if (loopStop !== undefined) return;
    const action = loopGuard.observe(event);
    if (action.kind === "warn") {
      void events.append("progress", { message: "The agent repeated a failing call; AgentX told it to change approach." }).catch(() => undefined);
      void session.steer?.(action.message).catch(() => undefined);
    } else if (action.kind === "stop") {
      loopStop = action.error;
      void session.abort().catch(() => undefined);
    }
  });
  try {
    let outcome: TaskUsageOutcome = "FAILED";
    let taskResult: TaskInvocationResult | undefined;
    let taskFailure: Error | undefined;
    let evidenceFailure: unknown;
    try {
      await events.append("lifecycle", {
        status: "RUNNING",
        conversationId,
        conversation: { started: true, reopened: registered !== undefined },
      });
      for (const message of contextDiagnostics) await events.append("progress", { message });
      await session.prompt(invocation.payload.prompt);
      // An abort can end the prompt without an error; the guard's reason is the task's outcome.
      if (loopStop !== undefined) throw loopStop;
      await publishWorkspaceDiff(dependencies.rootPath, dependencies.artifactSink);
      await dependencies.artifactSink({
        name: "test-and-tool-evidence.json",
        mediaType: "application/json",
        content: JSON.stringify(toolEvidence, null, 2),
      });
      outcome = "SUCCEEDED";
      await events.append("result", {
        status: "SUCCEEDED",
        conversationId,
        sessionFile: "agent-sessions/[server-generated]",
      });
      taskResult = { conversationId, reopened: registered !== undefined };
    } catch (error) {
      if (loopStop === undefined && dependencies.cancellationController?.isCancelled(invocation.operationId)) {
        outcome = "CANCELLED";
        taskFailure = new WorkerOperationCancelledError(invocation.operationId);
        try {
          await events.append("lifecycle", { status: "CANCELLED", conversationId });
        } catch (reportingError) {
          evidenceFailure = reportingError;
        }
      } else {
        outcome = "FAILED";
        taskFailure = loopStop ?? asError(error);
        try {
          await events.append("error", { message: taskFailure.message });
        } catch (reportingError) {
          evidenceFailure = reportingError;
        }
      }
    }

    let telemetryFailure = evidenceFailure;
    try {
      const usage = createTaskUsageTelemetry(session.getSessionStats(), {
        ...session.getModel(),
        ...(dependencies.model.cacheRetention === undefined
          ? {}
          : { cacheRetention: dependencies.model.cacheRetention }),
      }, outcome);
      const redactedUsage = redactCredentials(usage);
      await events.append("usage", redactedUsage);
      await dependencies.artifactSink({
        name: "usage.json",
        mediaType: "application/json",
        content: JSON.stringify(redactedUsage, null, 2),
      });
    } catch (error) {
      telemetryFailure = error;
    }
    try {
      await events.flush();
    } catch (error) {
      telemetryFailure ??= error;
    }
    if (taskFailure !== undefined) throw taskFailure;
    if (telemetryFailure !== undefined) throw asError(telemetryFailure);
    if (!taskResult) throw new Error("task completed without a result");
    return taskResult;
  } finally {
    unsubscribe();
    unregisterCancellation?.();
    session.dispose();
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * The deployed model wins, because a stack update may move live conversations. The stored value
 * exists to report the change: a transcript continued on another model re-reads no prompt cache.
 */
function modelChangeDiagnostics(
  registered: ConversationRecord | undefined,
  model: WorkspaceModelConfiguration,
): string[] {
  const previous = registered?.model;
  if (!previous || (previous.provider === model.provider && previous.modelId === model.modelId)) return [];
  return [
    `this conversation was built on ${previous.provider}/${previous.modelId} and continues on ` +
      `${model.provider}/${model.modelId}`,
  ];
}

function eventType(event: unknown): "progress" | "tool_start" | "tool_end" {
  if (event && typeof event === "object" && "type" in event) {
    const type = event.type;
    if (type === "tool_execution_start") return "tool_start";
    if (type === "tool_execution_end" || type === "tool_result") return "tool_end";
  }
  return "progress";
}
