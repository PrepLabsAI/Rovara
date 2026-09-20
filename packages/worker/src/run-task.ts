import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { WorkerInvocationSchema, agentXError, type CandidateResult, type WorkerInvocation } from "@agentx/contracts";
import { assertTaskCandidateBase, freezeTaskCandidate } from "./candidate.js";
import { publishWorkspaceDiff, type ArtifactSink } from "./artifacts.js";
import { EventBatcher, redactCredentials, type EventBatchSink } from "./events.js";
import { createWorkspacePiSession, type PiSessionAdapter, type PiSessionHandle, type WorkspaceModelConfiguration } from "./pi-session.js";
import { DemoRunLimits } from "./demo-run-limits.js";
import type { PreparationManifest } from "./prepare.js";
import { WorkerOperationCancelledError, type WorkerCancellationController } from "./cancel.js";

interface TaskDependencies {
    rootPath: string;
    model: WorkspaceModelConfiguration;
    eventSink: EventBatchSink;
    artifactSink: ArtifactSink;
    piAdapter?: PiSessionAdapter;
    cancellationController?: WorkerCancellationController;
    demoLimits?: boolean;
}

export async function runTaskInvocation(
  untrustedInvocation: WorkerInvocation,
  dependencies: TaskDependencies,
): Promise<{ conversationId: string; sessionFile: string; candidate?: CandidateResult }> {
  const limits = dependencies.demoLimits ? new DemoRunLimits() : undefined;
  let session: PiSessionHandle | undefined;
  const execute = () => executeTaskInvocation(untrustedInvocation, dependencies, limits, (value) => { session = value; });
  try {
    return limits ? await limits.run(execute, async () => { await session?.abort(); }) : await execute();
  } finally {
    limits?.dispose();
  }
}

async function executeTaskInvocation(
  untrustedInvocation: WorkerInvocation, dependencies: TaskDependencies,
  limits: DemoRunLimits | undefined, onSession: (session: PiSessionHandle) => void,
): Promise<{ conversationId: string; sessionFile: string; candidate?: CandidateResult }> {
  const invocation = WorkerInvocationSchema.parse(untrustedInvocation);
  if (invocation.kind !== "task") throw agentXError("CONFIG_INVALID", "runTaskInvocation requires a task");
  const manifest = JSON.parse(
    await readFile(resolve(dependencies.rootPath, ".agentx/preparation-manifest.json"), "utf8"),
  ) as PreparationManifest;
  if (!manifest.complete || manifest.projectRevision !== invocation.projectRevision) {
    throw agentXError("WORKSPACE_NOT_READY", "workspace manifest is incomplete or revision-mismatched");
  }

  const events = new EventBatcher(dependencies.eventSink);
  const toolCwd = invocation.payload.candidate
    ? await assertTaskCandidateBase(dependencies.rootPath, invocation) : undefined;
  const toolEvidence: unknown[] = [];
  const session = await createWorkspacePiSession(
    { rootPath: dependencies.rootPath, ...(toolCwd === undefined ? {} : { toolCwd }),
      model: dependencies.model, ...(limits ? { limits } : {}) },
    dependencies.piAdapter,
  );
  onSession(session);
  const unregisterCancellation = dependencies.cancellationController?.register(invocation.operationId, session);
  let disposed = false;
  const unsubscribe = session.subscribe((event) => {
    if (eventType(event) === "tool_end") toolEvidence.push(redactCredentials(event));
    void events.append(eventType(event), event).catch(() => undefined);
  });
  try {
    limits?.assertActive();
    await events.append("lifecycle", { status: "RUNNING", conversationId: session.conversationId });
    await session.prompt(invocation.payload.prompt);
    limits?.assertActive();
    if (dependencies.cancellationController?.isCancelled(invocation.operationId)) throw new WorkerOperationCancelledError(invocation.operationId);
    session.dispose();
    disposed = true;
    const candidate = invocation.payload.candidate ? await freezeTaskCandidate({
      rootPath: dependencies.rootPath, invocation, artifactSink: dependencies.artifactSink,
      isCancelled: () => {
        limits?.assertActive();
        return dependencies.cancellationController?.isCancelled(invocation.operationId) ?? false;
      },
    }) : undefined;
    limits?.assertActive();
    await publishWorkspaceDiff(dependencies.rootPath, dependencies.artifactSink);
    limits?.assertActive();
    await dependencies.artifactSink({
      name: "test-and-tool-evidence.json",
      mediaType: "application/json",
      content: JSON.stringify(toolEvidence, null, 2),
    });
    limits?.assertActive();
    await events.append("result", { status: "SUCCEEDED", sessionFile: "agent-sessions/[server-generated]" });
    await events.flush();
    if (dependencies.cancellationController?.isCancelled(invocation.operationId)) throw new WorkerOperationCancelledError(invocation.operationId);
    return { conversationId: session.conversationId, sessionFile: session.sessionFile, ...(candidate === undefined ? {} : { candidate }) };
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
    if (!disposed) session.dispose();
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
