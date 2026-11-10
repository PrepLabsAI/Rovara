import {taskFallbackAuthorizer} from "./model-fallback-authority.js";
import type { WorkerInvocation } from "@agentx/contracts";
import { CONTAINED_RUNTIME_PROFILE, inspectContainedRuntimeReadiness, type ContainedRuntimeReadiness } from "@agentx/verifier";
import { OperationJournal } from "./journal.js";
import { prepareWorkspace, preparedBaseResult } from "./prepare.js";
import { createWorkerCallbackSinks } from "./callback-client.js";
import { createRepositoryCredentialProvider } from "./repository-credentials.js";
import { createRegistryCredentialProvider } from "./registry-credentials.js";
import { removeLeftoverRegistryConfigs } from "./registry-config.js";
import { runTaskInvocation } from "./run-task.js";
import { publishWorkspace } from "./publish.js";
import { maintainPullRequest } from "./maintain-pull-request.js";
import { WorkerCancellationController } from "./cancel.js";
import { closeInvocationResult } from "./close-workspace.js";
import { advertisedInvocationFeatures, anotherOperationActive, createWorkerServerState, startWorkerServer } from "./server.js";
import { consoleWorkerLog, logWorkerStarted } from "./worker-log.js";
import { invokeAuthenticationFromEnvironment } from "./invoke-auth.js";
import { installBuildSystemProfiles } from "./build-systems.js";
import { modelFallbackReporter, resolveTaskSessionModel, secondReviewerRuntimes, taskMissingKeyAuthorizer } from "./task-model.js";
import { createDefaultPiSessionAdapter } from "./pi-session.js";
import { chatGptTokenSource } from "./chatgpt-token.js";
import { agentSkillsSource } from "./agent-step.js";
import { brokerContextCall, contextToolsCatalogSource } from "./context-sources/bridge.js";
import { designReviewBindingOf, designReviewDependencies, operationModelProxy } from "./design-review-sessions.js";
import { createDefaultProjectSetupExecutor, createReadinessGatedProjectSetupRuntime } from "./project-setup-executor.js";
import { postProjectSetupTerminalResult } from "./project-setup-callback.js";
import { postWorkerTerminalResult } from "./terminal-callback.js";
import { executeWorkerCancelInvocation } from "./cancel-invocation.js";
import { handleSteerInvocation } from "./steer-invocation.js";
import { handlePeekInvocation } from "./peek-invocation.js";
import { removeLeftoverMaskVolumes } from "./devcontainer.js";
import { removeLeftoverTaskSandboxes, taskShellSelection } from "./task-sandbox.js";
import { removeLeftoverSetupRuns, setupWorkspaceKey } from "./setup-network.js";
import { createSavedEnvFallbackReporter, createSavedEnvLoginProvider } from "./saved-env/login.js";
import { rememberCredentials, runSavedEnvRebuild } from "./saved-env/rebuild.js";
import { savedEnvOptionsOf } from "./saved-env/use.js";
import { createDockerCli } from "./swebench/containers.js";
import { assertWorkerScratchReady, checkWorkerScratch, workerBootFailureOf } from "./worker-scratch.js";
import { collectTestServicesUsage, testServicesAdvertisedFeatures, testServicesAtWorkerBoot } from "./test-services-run.js";
import { createApplicationChecksFeatureMonitor, createWorkflowE2EApplicationRuntime } from "./workflow-e2e-application-runtime.js";

const rootPath = process.env.AGENTX_WORKSPACE_ROOT ?? "/mnt/workspace";
const port = Number.parseInt(process.env.PORT ?? "8080", 10);
const trustedRuntimeBackingOwner = CONTAINED_RUNTIME_PROFILE?.id === "linux-arm64-docker-v1"
  && rootPath === "/mnt/workspace"
  && CONTAINED_RUNTIME_PROFILE.stateRoot === "/mnt/agentx-runtime/state"
  ? { uid: 0, gid: 0 }
  : undefined;

// Read first, so a partly configured EC2 boot fails before the port opens.
const invokeAuthentication = invokeAuthenticationFromEnvironment();
// Port lane P6 (item B1): the build systems this worker was started with (extra detectors and setup programs). A value that cannot be read stops the boot, so no task runs under a half-described build system.
const buildSystems = installBuildSystemProfiles();
if (buildSystems.length > 0) console.log(JSON.stringify({ component: "worker", event: "build-systems.installed", names: buildSystems.map((profile) => profile.name) }));
// Pi installs no package for the worker (R56): a settings file's `packages` would otherwise make it run `npmCommand` here.
process.env.PI_OFFLINE = "1";
// N9: a preparation that crashed may have left a package registry's config (and its token) in the workspace; it is removed before any task runs.
await removeLeftoverRegistryConfigs(rootPath).catch(() => 0);
// R56: where a project without a devcontainer runs its commands comes from the environment (always the task sandbox on EC2),
// so a bad AGENTX_TASK_SHELL, or a request for the local shell on EC2, stops the worker here, not on its first task.
if (taskShellSelection().kind === "sandbox") {
  // A crash or restart skips a sandbox's removal; none of this process's exists yet, so none found is in use.
  await removeLeftoverTaskSandboxes(rootPath).then(
    (removed) => { if (removed > 0) console.log(JSON.stringify({ component: "worker", event: "task-sandbox.leftovers.removed", removed })); },
    (error: unknown) => { console.error(`could not remove leftover task sandboxes: ${error instanceof Error ? error.message : String(error)}`); },
  );
  // SH14: a setup run's helper container and network (a crash skips their removal); they go before anything starts, so their /24 slots are free again.
  await removeLeftoverSetupRuns(await setupWorkspaceKey(rootPath), createDockerCli()).then(
    (removed) => { if (removed.containers + removed.networks > 0) console.log(JSON.stringify({ component: "worker", event: "setup-run.leftovers.removed", ...removed })); },
    (error: unknown) => { console.error(`could not remove leftover setup runs: ${error instanceof Error ? error.message : String(error)}`); },
  );
  // Test services (TS-RN-3 rule 3): a killed worker's run networks and helpers (labelled, this workspace's only) go before any task starts, and the catalog images are pulled ahead. Does nothing on a worker with no test services configuration.
  await testServicesAtWorkerBoot({ rootPath });
  // The empty volumes a dev container's start mounted over the worker's folders go with their container; any no container uses are removed.
  await removeLeftoverMaskVolumes().then(
    (removed) => { if (removed > 0) console.log(JSON.stringify({ component: "worker", event: "mask-volumes.leftovers.removed", removed })); },
    (error: unknown) => { console.error(`could not remove leftover mask volumes: ${error instanceof Error ? error.message : String(error)}`); },
  );
}
// TF12 (M3): worker scratch (throwaway Git, the credential folder) must be made outside the workspace volume. Found out once, here: the answer is on /ping, and a worker that cannot refuses every
// task with the reason, instead of failing in the middle of the first Git operation.
const workerScratch = await checkWorkerScratch();
console.log(JSON.stringify({ component: "worker", event: "worker.scratch.checked", ...workerScratch }));
const containedRuntimeReadiness: ContainedRuntimeReadiness = await inspectContainedRuntimeReadiness().catch((): ContainedRuntimeReadiness => ({ status: "unavailable", reason: "private-runtime-paths-unavailable" }));
if (containedRuntimeReadiness.status !== "ready") {
  console.error(`project.setupSmoke unavailable: ${containedRuntimeReadiness.reason}`);
}
const projectSetupRuntime = createReadinessGatedProjectSetupRuntime(containedRuntimeReadiness, () => createDefaultProjectSetupExecutor({
  sourceRoot: rootPath,
  evidenceRoot: requiredEnvironment("CONTAINED_FOUNDATION_EVIDENCE_DIR"),
  controlPlaneUrl: requiredEnvironment("AGENTX_CONTROL_PLANE_URL"),
}));
const applicationChecks = createApplicationChecksFeatureMonitor({ environment: process.env });
applicationChecks.start();
const journal = new OperationJournal(rootPath);
const cancellationController = new WorkerCancellationController();
const state = createWorkerServerState(
  journal,
  {
    invocationFeatures: [...projectSetupRuntime.invocationFeatures, ...testServicesAdvertisedFeatures()],
    invocationFeatureDiagnostics: { ...projectSetupRuntime.invocationFeatureDiagnostics, "worker.scratch": workerScratch },
    // Application CHECKS are listed on /ping only while this worker can run them, from the last background check (never a Docker call per ping).
    ...applicationChecks.executor,
    // N1: a failed scratch check is a failed boot as far as the broker can see: /ping answers 503 BootFailed, so no task is routed here and the instance is recycled.
    ...(workerBootFailureOf(workerScratch) === undefined ? {} : { bootFailure: workerBootFailureOf(workerScratch)! }),
    steer: (invocation) => handleSteerInvocation(invocation, cancellationController, journal),
    peek: (invocation) => handlePeekInvocation(invocation, rootPath),
    async execute(invocation: WorkerInvocation): Promise<unknown> {
      assertWorkerScratchReady(workerScratch);
      if (invocation.kind === "project-setup-smoke") {
        return projectSetupRuntime.execute(invocation);
      }
      if (invocation.kind === "prepare") {
        const controlPlaneUrl = requiredEnvironment("AGENTX_CONTROL_PLANE_URL");
        // The clone credential is fetched by the preparation alone; its values are remembered for a rebuild's secret scan.
        const cloneCredentials = rememberCredentials(createRepositoryCredentialProvider({ controlPlaneUrl, invocation }));
        // Test services (Prove): a candidate check that carries a dependency plan reports its usage record in the result, under the contract's key `testServicesUsage`.
        const testServicesUsage = collectTestServicesUsage();
        const manifest = await prepareWorkspace({
          rootPath,
          project: invocation.payload.project,
          creationIdentity: invocation.workspaceId,
          ...(trustedRuntimeBackingOwner === undefined ? {} : { trustedRuntimeBackingOwner }),
          credentialProvider: cloneCredentials.provider,
          // An agent-step run that looks at a pull request: its head is checked out after the clone (Plan 3, Task 22).
          ...(invocation.payload.checkout === undefined ? {} : { checkout: invocation.payload.checkout }),
          // An agent-step run's preparation runs none of the repository's code (runs I-2).
          ...(invocation.payload.readOnly === true ? { readOnly: true } : {}),
          // Meta repo lane A3: the project's meta repository, read-only and sparse.
          ...(invocation.payload.meta === undefined ? {} : { meta: invocation.payload.meta }),
          // P1: the heads the broker pinned for a setup run.
          ...(invocation.payload.pins === undefined ? {} : { pins: invocation.payload.pins }),
          // N9 (INTG2): the project's private package registries, for the setup and readiness commands.
          // Saved environments (SH25): start from the project's saved image; any problem sets up fresh.
          ...(invocation.payload.savedEnv === undefined ? {} : { savedEnv: savedEnvOptionsOf(invocation.payload.savedEnv, createSavedEnvLoginProvider({ controlPlaneUrl, invocation }), undefined, createSavedEnvFallbackReporter({ controlPlaneUrl, invocation })) }),
          ...(invocation.payload.registries === undefined ? {} : { registries: invocation.payload.registries, registryCredentialProvider: createRegistryCredentialProvider({ controlPlaneUrl, invocation }) }),
          ...(invocation.payload.testServices === undefined ? {} : { testServices: { dependencies: invocation.payload.testServices.dependencies, operationId: invocation.operationId, cancellation: cancellationController, onUsageRecord: testServicesUsage.collect, fixtureSet: createWorkerCallbackSinks({ controlPlaneUrl, invocation }).fixtureSet } }),
        });
        // Saved project images: a rebuild job builds the project's image from this read-only, pinned preparation (saved-env/rebuild.ts) and posts the result to the broker's lease route.
        if (invocation.payload.savedEnvBuild !== undefined) {
          await runSavedEnvRebuild({
            rootPath, controlPlaneUrl, invocation, manifest, docker: createDockerCli(),
            // The workspace root is shared by everything on this machine: any other running operation means the build would not be in a workspace of its own.
            otherOperations: async () => (anotherOperationActive(state, invocation.operationId) ? [{ id: "another-operation", rootPath }] : []),
            cloneCredentialValues: () => cloneCredentials.values(),
          });
        }
        return {
          manifestPath: ".agentx/preparation-manifest.json",
          projectName: manifest.projectName,
          projectRevision: manifest.projectRevision,
          ...preparedBaseResult(manifest),
          ...testServicesUsage.result(),
        };
      }
      if (invocation.kind === "task") {
        const controlPlaneUrl = requiredEnvironment("AGENTX_CONTROL_PLANE_URL");
        const { chatGptToken, chatGptFallback, authorizeModelFallback, ...callbacks } = createWorkerCallbackSinks({ controlPlaneUrl, invocation });
        // #341: a task on its owner's ChatGPT plan; the token never leaves this process's memory.
        // Ruling R29: on an install with a model proxy the task calls models through it, with a key minted for this task;
        // the worker holds no provider secret. The key is asked for lazily, at the first request that needs the proxy (a ChatGPT
        // plan's own requests never do), so a task on a plan is not held up by a proxy it may never call.
        // DR-KEY-1: a design-review operation's own session (never prompted) never asks for a key; its reviewers ask by slot.
        const proxy = operationModelProxy({ payload: invocation.payload, proxyUrl: process.env.AGENTX_MODEL_PROXY_URL, controlPlaneUrl, capability: invocation.callbackCapability });
        const session = await resolveTaskSessionModel(invocation.payload,
          invocation.payload.chatgpt === undefined ? undefined : chatGptTokenSource(chatGptToken), process.env, chatGptFallback, proxy, taskFallbackAuthorizer(invocation.payload,authorizeModelFallback));
        const missingKeyAuthority=taskMissingKeyAuthorizer(invocation.payload,authorizeModelFallback,proxy,process.env);
        return runTaskInvocation(invocation, {
          rootPath,
          model: session.model,
          // SR-1: the second reviewer's models, each with its own session (and proxy route).
          ...(invocation.payload.workflowSecondReviewer === undefined ? {} : { secondReviewer: { candidates: secondReviewerRuntimes(invocation.payload, proxy, process.env) ?? [], ...(invocation.payload.workflowSecondReviewer.context === undefined ? {} : { context: invocation.payload.workflowSecondReviewer.context }) } }),
          // DR5: a design review's packet source and per-reviewer model keys (only an operation that carries the binding).
          ...(designReviewBindingOf(invocation.payload) === undefined ? {} : { designReview: designReviewDependencies({ controlPlaneUrl, capability: invocation.callbackCapability, proxyUrl: process.env.AGENTX_MODEL_PROXY_URL }) }),
          // MODEL3: a missing provider key that sent the task to the chosen fallback model is told to the task page, once, as a progress event.
          piAdapter: session.piAdapter ?? createDefaultPiSessionAdapter({ onModelFallback: modelFallbackReporter(callbacks.eventSink),...(missingKeyAuthority===undefined?{}:{authorizeModelFallback:missingKeyAuthority}) }),
          ...callbacks,
          // The operation's skills snapshot, asked for only when the invocation's agentStep names skills.
          agentSkills: agentSkillsSource({ controlPlaneUrl, capability: invocation.callbackCapability }),
          // An agent step's connector tools, through the same control plane with the same capability.
          agentRun: { brokerUrl: controlPlaneUrl },
          // Lane E: the project's MCP context sources for an Understand, Plan, Plan-check or Review stage, through the same control plane with the same capability.
          contextSources: {
            catalog: contextToolsCatalogSource({ brokerUrl: controlPlaneUrl, capability: invocation.callbackCapability, onDiagnostic: (message) => console.log(JSON.stringify({ component: "worker", event: "context_sources", message })) }),
            call: brokerContextCall({ brokerUrl: controlPlaneUrl, capability: invocation.callbackCapability }),
          },
          ...(invocation.payload.workflowE2EAdmission === undefined ? {} : {
            workflowE2EEvidenceRoot: requiredEnvironment("CONTAINED_FOUNDATION_EVIDENCE_DIR"),
            workflowE2ERuntimeRoot: process.cwd(),
            // Built only when an application admission asks for it, so a worker without EXECUTOR_IMAGE still runs portable rounds.
            workflowE2EApplicationRuntime: () => createWorkflowE2EApplicationRuntime(process.env),
          }),
          cancellationController,
          // The steps that only read the workspace stop first what earlier work left running; they do not start while another operation still runs here.
          stopBeforeReading: { otherOperationActive: () => anotherOperationActive(state, invocation.operationId) },
        });
      }
      if (invocation.kind === "publish") {
        const controlPlaneUrl = requiredEnvironment("AGENTX_CONTROL_PLANE_URL");
        const callbacks = createWorkerCallbackSinks({ controlPlaneUrl, invocation });
        return publishWorkspace({
          rootPath,
          invocation,
          credentialProvider: createRepositoryCredentialProvider({ controlPlaneUrl, invocation }),
          pullRequestSink: callbacks.pullRequestSink,
          codeBuildSink: callbacks.codeBuildSink,
          otherOperationActive: () => anotherOperationActive(state, invocation.operationId),
        });
      }
      if (invocation.kind === "maintain") {
        const controlPlaneUrl = requiredEnvironment("AGENTX_CONTROL_PLANE_URL");
        const callbacks = createWorkerCallbackSinks({ controlPlaneUrl, invocation });
        return maintainPullRequest({
          rootPath,
          invocation,
          credentialProvider: createRepositoryCredentialProvider({ controlPlaneUrl, invocation }),
          pullRequestUpdateSink: callbacks.pullRequestUpdateSink,
          codeBuildSink: callbacks.codeBuildSink,
          otherOperationActive: () => anotherOperationActive(state, invocation.operationId),
        });
      }
      if (invocation.kind === "cancel") {
        return executeWorkerCancelInvocation(invocation, cancellationController, journal);
      }
      if (invocation.kind === "close") {
        return closeInvocationResult(rootPath, () => anotherOperationActive(state, invocation.operationId));
      }
      throw new Error(`worker operation ${invocation.kind} is not implemented in this delivery slice`);
    },
  },
  {
    log: consoleWorkerLog,
    async onTerminal(result, invocation) {
      if (invocation.kind === "project-setup-smoke") {
        const controlPlaneUrl = requiredEnvironment("AGENTX_CONTROL_PLANE_URL");
        await postProjectSetupTerminalResult({ controlPlaneUrl, invocation, result });
        return;
      }
      const callbacks = createWorkerCallbackSinks({
        controlPlaneUrl: requiredEnvironment("AGENTX_CONTROL_PLANE_URL"),
        invocation,
      });
      await postWorkerTerminalResult(callbacks, result, invocation);
    },
  },
  invokeAuthentication,
);

// Always, whatever the runtime state: without it a quiet worker's CloudWatch stream is empty and looks like a broken pipeline.
logWorkerStarted(consoleWorkerLog, {
  env: process.env,
  containedRuntime: containedRuntimeReadiness,
  invocationFeatures: advertisedInvocationFeatures(state).features,
});
startWorkerServer(state, { port });

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for coding tasks`);
  return value;
}
