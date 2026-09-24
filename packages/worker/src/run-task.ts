import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { WorkerInvocationSchema, agentXError, type WorkerInvocation } from "@agentx/contracts";
import { publishWorkspaceDiff, type ArtifactSink } from "./artifacts.js";
import { EventBatcher, redactCredentials, type EventBatchSink } from "./events.js";
import { createWorkspacePiSession, type PiSessionAdapter, type WorkspaceModelConfiguration } from "./pi-session.js";
import type { PreparationManifest } from "./prepare.js";
import { WorkerOperationCancelledError, type WorkerCancellationController } from "./cancel.js";

export async function runTaskInvocation(
  untrustedInvocation: WorkerInvocation,
  dependencies: {
    rootPath: string;
    model: WorkspaceModelConfiguration;
    eventSink: EventBatchSink;
    artifactSink: ArtifactSink;
    piAdapter?: PiSessionAdapter;
    cancellationController?: WorkerCancellationController;
  },
): Promise<{ conversationId: string; sessionFile: string }> {
  const invocation = WorkerInvocationSchema.parse(untrustedInvocation);
  if (invocation.kind !== "task") throw agentXError("CONFIG_INVALID", "runTaskInvocation requires a task");
  const manifest = JSON.parse(
    await readFile(resolve(dependencies.rootPath, ".agentx/preparation-manifest.json"), "utf8"),
  ) as PreparationManifest;
  if (!manifest.complete || manifest.projectRevision !== invocation.projectRevision) {
    throw agentXError("WORKSPACE_NOT_READY", "workspace manifest is incomplete or revision-mismatched");
  }

  const events = new EventBatcher(dependencies.eventSink);
  const toolEvidence: unknown[] = [];
  const contextDiagnostics: string[] = [];
  const session = await createWorkspacePiSession(
    {
      rootPath: dependencies.rootPath,
      model: dependencies.model,
      onDiagnostic: (message) => contextDiagnostics.push(message),
    },
    dependencies.piAdapter,
  );
  const unregisterCancellation = dependencies.cancellationController?.register(invocation.operationId, session);
  const unsubscribe = session.subscribe((event) => {
    if (eventType(event) === "tool_end") toolEvidence.push(redactCredentials(event));
    void events.append(eventType(event), event).catch(() => undefined);
  });
  try {
    await events.append("lifecycle", { status: "RUNNING", conversationId: session.conversationId });
    for (const message of contextDiagnostics) await events.append("progress", { message });
    await session.prompt(invocation.payload.prompt);
    await publishWorkspaceDiff(dependencies.rootPath, dependencies.artifactSink);
    await dependencies.artifactSink({
      name: "test-and-tool-evidence.json",
      mediaType: "application/json",
      content: JSON.stringify(toolEvidence, null, 2),
    });
    await events.append("result", { status: "SUCCEEDED", sessionFile: "agent-sessions/[server-generated]" });
    await events.flush();
    return { conversationId: session.conversationId, sessionFile: session.sessionFile };
  } catch (error) {
    if (dependencies.cancellationController?.isCancelled(invocation.operationId)) {
      await events.append("lifecycle", { status: "CANCELLED" });
      await events.flush();
      throw new WorkerOperationCancelledError(invocation.operationId);
    }
    await events.append("error", { message: error instanceof Error ? error.message : "task failed" });
    await events.flush();
    throw error;
  } finally {
    unsubscribe();
    unregisterCancellation?.();
    session.dispose();
  }
}

function eventType(event: unknown): "progress" | "tool_start" | "tool_end" {
  if (event && typeof event === "object" && "type" in event) {
    const type = event.type;
    if (type === "tool_execution_start") return "tool_start";
    if (type === "tool_execution_end" || type === "tool_result") return "tool_end";
  }
  return "progress";
}
