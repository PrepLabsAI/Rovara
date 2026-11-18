// The wiki build run as the worker receives it (W3b): builds the real ports of `runWikiBuild` from the task invocation's dependencies and returns the task's result. `run-task.ts` calls it from one early hunk; everything about the
// run itself is in `wiki-build-run.ts`. The session is read-only: its file tools run in the task sandbox's container on a hosted worker (R56), and in the worker only where the local shell was chosen explicitly.
import type { WorkerInvocation } from "@agentx/contracts";
import { agentXError } from "@agentx/contracts";
import { EventBatcher, type EventBatchSink } from "./events.js";
import { createWorkspacePiSession, type PiSessionAdapter, type WorkspaceModelConfiguration } from "./pi-session.js";
import type { PreparationManifest } from "./prepare.js";
import { WorkerOperationCancelledError, type WorkerCancellationController } from "./cancel.js";
import { runWikiBuild, type WikiSessionParts } from "./wiki-build-run.js";
import { setupModelPrice } from "./setup-agent-price.js";
import { taskSandboxFor, taskShellSelection, type TaskShellSelection } from "./task-sandbox.js";

export interface WikiInvocationDependencies {
  rootPath: string;
  model: WorkspaceModelConfiguration;
  piAdapter?: PiSessionAdapter | undefined;
  eventSink: EventBatchSink;
  cancellationController?: WorkerCancellationController | undefined;
  /** The broker's wiki build callback, with this invocation's own capability (callback-client.ts). Without it the worker cannot run a wiki build. */
  wikiBuild?: ((body: unknown) => Promise<unknown>) | undefined;
  taskShell?: TaskShellSelection | undefined;
  environment?: NodeJS.ProcessEnv | undefined;
}

/**
 * What a wiki build's model session is opened with. The file tools run in the task sandbox's container when there is one (R56), in the worker only where the local shell was chosen explicitly. The run's own `parts` (the WIKI mode and
 * its read-only tools) come LAST, so nothing before them can change the mode or the tool list; no skill, context source or answer tool is ever passed.
 */
export function wikiSessionInputOf(
  base: { rootPath: string; model: WorkspaceModelConfiguration; conversationId: string; fileTools: ReturnType<NonNullable<ReturnType<typeof taskSandboxFor>>["fileOpsTarget"]> | undefined },
  parts: WikiSessionParts,
): Parameters<typeof createWorkspacePiSession>[0] {
  return {
    rootPath: base.rootPath, model: base.model, conversationId: base.conversationId, onDiagnostic: () => undefined, extensionFactories: [],
    ...(base.fileTools === undefined ? { localFileTools: true } : { fileTools: base.fileTools }), ...parts,
  };
}

export interface WikiInvocationResult { conversationId: string; reopened: false; workflowMode: "WIKI_BUILD" }

export async function runWikiBuildInvocation(
  invocation: Extract<WorkerInvocation, { kind: "task" }>,
  dependencies: WikiInvocationDependencies,
  manifest: Pick<PreparationManifest, "repositories">,
  canonicalRoot: string,
): Promise<WikiInvocationResult> {
  const wiki = invocation.payload.wikiBuild;
  if (wiki === undefined) throw agentXError("CONFIG_INVALID", "a wiki build carries its limits and pins");
  if (dependencies.wikiBuild === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "the worker cannot reach the control plane's wiki build callback");
  const environment = dependencies.environment ?? process.env;
  // Money: a wiki build is metered by the model proxy (the broker's spend ledger) and priced from the catalog; without either it does not start.
  const proxy = environment["AGENTX_MODEL_PROXY_URL"];
  if (proxy === undefined || proxy === "") throw agentXError("RUNTIME_UNAVAILABLE", "this install has no model proxy, so AgentX did not build the wiki (its spending could not be counted)");
  const price = setupModelPrice(dependencies.model);
  const callback = dependencies.wikiBuild;
  const events = new EventBatcher(dependencies.eventSink);
  const conversationId = invocation.payload.conversationId;
  // The file tools' container (R56): the task sandbox. No shell is ever given to the session, so the sandbox's network is never reachable from the model.
  const selection = dependencies.taskShell ?? taskShellSelection();
  const sandbox = taskSandboxFor(selection, { rootPath: canonicalRoot, taskId: invocation.operationId });
  try {
    if (sandbox !== undefined) await sandbox.start();
    const result = await runWikiBuild({
      rootPath: canonicalRoot, operationId: invocation.operationId, limits: wiki.limits, pins: wiki.pins, price,
      repositories: manifest.repositories.map((repository) => ({ name: repository.name, path: repository.path, resolvedCommit: repository.resolvedCommit, ...("checkedOut" in repository ? { checkedOut: (repository as { checkedOut?: unknown }).checkedOut } : {}) })),
      ports: {
        openSession: (parts) => createWorkspacePiSession(wikiSessionInputOf({ rootPath: dependencies.rootPath, model: dependencies.model, conversationId, fileTools: sandbox?.fileOpsTarget() }, parts), dependencies.piAdapter),
        callback,
        progress: async (message) => { await events.append("progress", { message }); },
        register: (control) => dependencies.cancellationController?.register(invocation.operationId, { abort: () => control.abort(), steer: async () => false, streaming: () => false }) ?? (() => undefined),
      },
    });
    if (dependencies.cancellationController?.isCancelled(invocation.operationId) === true) { await events.flush(); throw new WorkerOperationCancelledError(invocation.operationId); }
    await events.append("result", { status: "SUCCEEDED", conversationId, workflowMode: "WIKI_BUILD", spentCents: result.spentCents });
    await events.flush();
    return { conversationId, reopened: false, workflowMode: "WIKI_BUILD" };
  } finally {
    await sandbox?.dispose().catch(() => undefined);
  }
}
