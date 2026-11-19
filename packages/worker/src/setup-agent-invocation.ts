// The setup run as the worker receives it (sh-setup-wire, SH14): builds the real ports of `runSetupAgent` from the task invocation's dependencies and returns the task's result. `run-task.ts` calls it from one
// early hunk; everything about the run itself is in `setup-agent-run.ts`.
import { SETUP_RUN_REFUSED_MESSAGES, agentXError } from "@agentx/contracts";
import type { WorkerInvocation } from "@agentx/contracts";
import { EventBatcher, type EventBatchSink } from "./events.js";
import { createWorkspacePiSession, type PiSessionAdapter, type WorkspaceModelConfiguration } from "./pi-session.js";
import type { PreparationManifest } from "./prepare.js";
import { WorkerOperationCancelledError, type WorkerCancellationController } from "./cancel.js";
import { runSetupAgent, type SetupRunResult } from "./setup-agent-run.js";
import { createSetupSandbox } from "./setup-agent.js";
import { assertSetupIsolation } from "./setup-isolation.js";
import { setupWorkspaceKey, startRunNetwork } from "./setup-network.js";
import { TASK_SANDBOX_IMAGE_ENVIRONMENT, gatewayEgressFor, sandboxNetworkFromEnvironment, type TaskShellSelection } from "./task-sandbox.js";
import type { RunNetwork } from "./setup-network.js";
import { modelSpendIsMetered, setupModelPrice } from "./setup-agent-price.js";
import { createDockerCli, type DockerCli } from "./swebench/containers.js";
import { EVAL_WORKER_IMAGE_VARIABLE } from "./verification/eval-wiring.js";
import { runSetupEvalDryRun } from "./verification/eval-dry-run.js";
import { testServicesConfigFromEnvironment } from "./test-services-run.js";
import { join } from "node:path";
import { standInRequestOf } from "./standin-shapes.js";
import { standInSessionInputOf } from "./standin-writer.js";

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

/**
 * The shared sandbox network a setup run joins, or undefined when it gets a run network of its own (an EC2 worker without the gateway). A gateway-mode worker (L4-NETG) always returns its internal network, or refuses
 * (RUNTIME_UNAVAILABLE) when the network or name server is missing: a setup run never falls back to a bridge with a way out. A laptop returns the network `rovara up` named.
 */
export function setupSharedNetwork(environment: NodeJS.ProcessEnv): string | undefined {
  const gateway = gatewayEgressFor(environment);
  if (gateway !== undefined) return gateway.network;
  return environment["AGENTX_RUNTIME"] === "ec2" ? undefined : sandboxNetworkFromEnvironment(environment);
}

/** The run's network on a laptop (or a gateway-mode worker): the machine's own sandbox network, which the run neither makes nor removes. It reports no blocked website (nothing watches DNS there). */
export function sharedRunNetwork(name: string): RunNetwork {
  return { name, subnet: "", gateway: "", helperName: "", helperIp: "", sandboxIp: "", readBlocked: async () => [], stop: async () => undefined };
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
  if (image === undefined || image === "") throw agentXError("RUNTIME_UNAVAILABLE", SETUP_RUN_REFUSED_MESSAGES.noSandboxImage);
  // Money: a setup run is metered by the model proxy (the broker's spend ledger) and priced from the catalog; without either it does not start.
  // Hotfix 0.5.33: the boot-time proxy (laptop) OR the invocation's own model route (hosted, metered through the control plane); neither refuses.
  if (!modelSpendIsMetered(environment, invocation.payload)) throw agentXError("RUNTIME_UNAVAILABLE", SETUP_RUN_REFUSED_MESSAGES.noModelProxy);
  const price = setupModelPrice(dependencies.model, invocation.payload.modelRoute);
  const docker = dependencies.docker ?? createDockerCli();
  const callback = dependencies.setupAgent;
  // On a laptop (`rovara up`) the worker is walled in by its own sandbox network and name server: the run joins that network, and the Docker socket guard does not let a worker make a network of its own or
  // start a helper container. So there is no DNS watch there: no website is reported blocked, and a command that needs one fails like any other (the owner adds the site to the install's list).
  // L4-NETG: on an EC2 worker whose sandboxes go through the egress gateway (AGENTX_SANDBOX_EGRESS=gateway) the setup run joins the same internal network as every sandbox. Its own run network (setup-network.ts) is a bridge with a way
  // out, which is exactly what the gateway mode closes; so, as on a laptop, there is no DNS watch there (the gateway logs what it refused) and a command that needs a blocked site fails like any other.
  const sharedNetwork = setupSharedNetwork(environment);
  const events = new EventBatcher(dependencies.eventSink);
  const conversationId = invocation.payload.conversationId;
  const result = await runSetupAgent({
    rootPath: canonicalRoot, operationId: invocation.operationId, basedOnRevision: invocation.projectRevision, limits: setup.limits, price,
    repositories: manifest.repositories, commits: setup.commits, evalImage: environment[EVAL_WORKER_IMAGE_VARIABLE],
    // L4-E12 (E2): the free dry run of the drafted eval, started without asking, never spending (scripted model replies, no bridge). It needs the worker's own pinned image and the fresh eval sandbox's walls; otherwise it gives nothing.
    evalDryRun: (report, signal) => runSetupEvalDryRun({
      docker, environment, taskId: invocation.operationId, workspaceKey: () => setupWorkspaceKey(canonicalRoot), commits: setup.commits, servicesOff: testServicesConfigFromEnvironment(environment, docker) === undefined,
      repositories: manifest.repositories.map((repository) => ({ name: repository.name, directory: join(canonicalRoot, repository.path) })), signal,
    }, report),
    ...(manifest.meta === undefined ? {} : { metaRepo: manifest.meta.name }),
    ports: {
      startNetwork: async () => (sharedNetwork !== undefined ? sharedRunNetwork(sharedNetwork) : startRunNetwork(docker, { taskId: invocation.operationId, image, workspace: await setupWorkspaceKey(canonicalRoot) })),
      createSandbox: (network) => (sharedNetwork !== undefined
        ? createSetupSandbox({ rootPath: canonicalRoot, taskId: invocation.operationId, docker, image, environment })
        : createSetupSandbox({
          rootPath: canonicalRoot, taskId: invocation.operationId, docker, image, environment,
          dns: [network.helperIp], network: { name: network.name, ip: network.sandboxIp },
        })),
      openSession: (parts) => createWorkspacePiSession({
        rootPath: dependencies.rootPath, model: dependencies.model, conversationId, onDiagnostic: () => undefined, extensionFactories: [], ...parts,
      }, dependencies.piAdapter),
      callback,
      // L4-E7: the stand-in writer's own session: its own system prompt, no repository context, and NO tool at all (`agentTools: []`; the file-tool guard is satisfied only because none is active). The company's model, the setup run's cap.
      standIn: {
        input: (repositories, tracked) => standInRequestOf(repositories, tracked),
        openSession: () => createWorkspacePiSession(standInSessionInputOf({ rootPath: dependencies.rootPath, model: dependencies.model }), dependencies.piAdapter),
      },
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

