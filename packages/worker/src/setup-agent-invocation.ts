// The setup run as the worker receives it (sh-setup-wire, SH14): builds the real ports of `runSetupAgent` from the task invocation's dependencies and returns the task's result. `run-task.ts` calls it from one
// early hunk; everything about the run itself is in `setup-agent-run.ts`.
import { agentXError } from "@agentx/contracts";
import type { WorkerInvocation } from "@agentx/contracts";
import { EventBatcher, type EventBatchSink } from "./events.js";
import { createWorkspacePiSession, type PiSessionAdapter, type WorkspaceModelConfiguration } from "./pi-session.js";
import type { PreparationManifest } from "./prepare.js";
import { WorkerOperationCancelledError, type WorkerCancellationController } from "./cancel.js";
import { runSetupAgent, type SetupRunResult } from "./setup-agent-run.js";
import { createSetupSandbox } from "./setup-agent.js";
import { assertSetupIsolation } from "./setup-isolation.js";
import { setupWorkspaceKey, startRunNetwork } from "./setup-network.js";
import { TASK_SANDBOX_IMAGE_ENVIRONMENT, type TaskShellSelection } from "./task-sandbox.js";
import { setupModelPrice } from "./setup-agent-price.js";
import { createDockerCli, type DockerCli } from "./swebench/containers.js";

export interface SetupInvocationDependencies {
  rootPath: string;
  model: WorkspaceModelConfiguration;
  piAdapter?: PiSessionAdapter | undefined;
  eventSink: EventBatchSink;
  cancellationController?: WorkerCancellationController | undefined;
  /** The broker's setup callback, with this invocation's own capability (callback-client.ts). Without it the worker cannot run a setup run. */
  setupAgent?: ((body: unknown) => Promise<unknown>) | undefined;
  docker?: DockerCli | undefined;
  taskShell?: TaskShellSelection | undefined;
  environment?: NodeJS.ProcessEnv | undefined;
}

/**
 * F5: a run that was stopped (the cancel aborted it) has finished and holds its partial proposal. It ends as cancelled and carries that report, because the cancel has already made this operation's journal
 * CANCELLED (a success could not be recorded). Undefined for a run nobody cancelled.
 */
export function cancelledWithReport(controller: WorkerCancellationController | undefined, operationId: string, result: SetupRunResult): WorkerOperationCancelledError | undefined {
  return controller?.isCancelled(operationId) === true ? new WorkerOperationCancelledError(operationId, result) : undefined;
}

/** The result a setup run reports (read again by the broker: the proposal by `sanitizeSetupProposal`, the summary by its schema). */
export interface SetupInvocationResult extends SetupRunResult { conversationId: string; reopened: false }

export async function runSetupAgentInvocation(
  invocation: Extract<WorkerInvocation, { kind: "task" }>,
  dependencies: SetupInvocationDependencies,
  manifest: Pick<PreparationManifest, "repositories" | "meta">,
  canonicalRoot: string,
): Promise<SetupInvocationResult> {
  const setup = invocation.payload.setupAgent;
  if (setup === undefined) throw agentXError("CONFIG_INVALID", "a setup run carries its limits");
  if (dependencies.setupAgent === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "the worker cannot reach the control plane's setup callback");
  if (dependencies.taskShell?.kind === "local") throw agentXError("RUNTIME_UNAVAILABLE", "a setup run runs only in the setup sandbox, never in the local shell");
  const environment = dependencies.environment ?? process.env;
  // A worker whose launcher had to withdraw the setup run's firewall rules refuses here, before any network, helper or sandbox exists.
  assertSetupIsolation(environment);
  const image = environment[TASK_SANDBOX_IMAGE_ENVIRONMENT];
  if (image === undefined || image === "") throw agentXError("RUNTIME_UNAVAILABLE", `AgentX has no task sandbox image (${TASK_SANDBOX_IMAGE_ENVIRONMENT}), so it did not run the setup`);
  // Money: a setup run is metered by the model proxy (the broker's spend ledger) and priced from the catalog; without either it does not start.
  const proxy = environment["AGENTX_MODEL_PROXY_URL"];
  if (proxy === undefined || proxy === "") throw agentXError("RUNTIME_UNAVAILABLE", "this install has no model proxy, so AgentX did not run the setup (its spending could not be counted)");
  const price = setupModelPrice(dependencies.model);
  const docker = dependencies.docker ?? createDockerCli();
  const callback = dependencies.setupAgent;
  const events = new EventBatcher(dependencies.eventSink);
  const conversationId = invocation.payload.conversationId;
  const result = await runSetupAgent({
    rootPath: canonicalRoot, operationId: invocation.operationId, basedOnRevision: invocation.projectRevision, limits: setup.limits, price,
    repositories: manifest.repositories, commits: setup.commits,
    ...(manifest.meta === undefined ? {} : { metaRepo: manifest.meta.name }),
    ports: {
      startNetwork: async () => startRunNetwork(docker, { taskId: invocation.operationId, image, workspace: await setupWorkspaceKey(canonicalRoot) }),
      createSandbox: (network) => createSetupSandbox({
        rootPath: canonicalRoot, taskId: invocation.operationId, docker, image, environment,
        dns: [network.helperIp], network: { name: network.name, ip: network.sandboxIp },
      }),
      openSession: (parts) => createWorkspacePiSession({
        rootPath: dependencies.rootPath, model: dependencies.model, conversationId, onDiagnostic: () => undefined, extensionFactories: [], ...parts,
      }, dependencies.piAdapter),
      callback,
      progress: async (message) => { await events.append("progress", { message }); },
      register: (control) => {
        const unregister = dependencies.cancellationController?.register(invocation.operationId, {
          abort: () => control.abort(), steer: (text: string) => control.steer(text), streaming: () => control.streaming(),
        });
        return unregister ?? (() => undefined);
      },
    },
  });
  const stopped = cancelledWithReport(dependencies.cancellationController, invocation.operationId, result);
  if (stopped !== undefined) { await events.flush(); throw stopped; }
  await events.append("result", { status: "SUCCEEDED", conversationId, workflowMode: "SETUP_AGENT" });
  await events.flush();
  return { conversationId, reopened: false, ...result };
}

