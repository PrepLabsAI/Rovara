import type { WorkerInvocation } from "@agentx/contracts";
import { CONTAINED_RUNTIME_PROFILE, inspectContainedRuntimeReadiness, type ContainedRuntimeReadiness } from "@agentx/verifier";
import { OperationJournal } from "./journal.js";
import { prepareWorkspace, preparedBaseResult } from "./prepare.js";
import { createWorkerCallbackSinks } from "./callback-client.js";
import { createRepositoryCredentialProvider } from "./repository-credentials.js";
import { runTaskInvocation } from "./run-task.js";
import { publishWorkspace } from "./publish.js";
import { maintainPullRequest } from "./maintain-pull-request.js";
import { WorkerCancellationController } from "./cancel.js";
import { inspectWorkspaceForClose } from "./close-workspace.js";
import { advertisedInvocationFeatures, createWorkerServerState, startWorkerServer } from "./server.js";
import { consoleWorkerLog, logWorkerStarted } from "./worker-log.js";
import { invokeAuthenticationFromEnvironment } from "./invoke-auth.js";
import { modelFallbackReporter, resolveTaskSessionModel } from "./task-model.js";
import { createDefaultPiSessionAdapter } from "./pi-session.js";
import { chatGptTokenSource } from "./chatgpt-token.js";
import { createDefaultProjectSetupExecutor, createReadinessGatedProjectSetupRuntime } from "./project-setup-executor.js";
import { postProjectSetupTerminalResult } from "./project-setup-callback.js";
import { postWorkerTerminalResult } from "./terminal-callback.js";
import { executeWorkerCancelInvocation } from "./cancel-invocation.js";
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
    invocationFeatures: projectSetupRuntime.invocationFeatures,
    invocationFeatureDiagnostics: projectSetupRuntime.invocationFeatureDiagnostics,
    // Application CHECKS are listed on /ping only while this worker can run them, from the last background check (never a Docker call per ping).
    ...applicationChecks.executor,
    async execute(invocation: WorkerInvocation): Promise<unknown> {
      if (invocation.kind === "project-setup-smoke") {
        return projectSetupRuntime.execute(invocation);
      }
      if (invocation.kind === "prepare") {
        const controlPlaneUrl = requiredEnvironment("AGENTX_CONTROL_PLANE_URL");
        const manifest = await prepareWorkspace({
          rootPath,
          project: invocation.payload.project,
          creationIdentity: invocation.workspaceId,
          ...(trustedRuntimeBackingOwner === undefined ? {} : { trustedRuntimeBackingOwner }),
          credentialProvider: createRepositoryCredentialProvider({
            controlPlaneUrl,
            invocation,
          }),
        });
        return {
          manifestPath: ".agentx/preparation-manifest.json",
          projectName: manifest.projectName,
          projectRevision: manifest.projectRevision,
          ...preparedBaseResult(manifest),
        };
      }
      if (invocation.kind === "task") {
        const controlPlaneUrl = requiredEnvironment("AGENTX_CONTROL_PLANE_URL");
        const { chatGptToken, chatGptFallback, ...callbacks } = createWorkerCallbackSinks({ controlPlaneUrl, invocation });
        // #341: a task on its owner's ChatGPT plan; the token never leaves this process's memory.
        const session = await resolveTaskSessionModel(invocation.payload,
          invocation.payload.chatgpt === undefined ? undefined : chatGptTokenSource(chatGptToken), process.env, chatGptFallback);
        return runTaskInvocation(invocation, {
          rootPath,
          model: session.model,
          // MODEL3: a missing provider key that sent the task to the chosen fallback model is told to the task page, once, as a progress event.
          piAdapter: session.piAdapter ?? createDefaultPiSessionAdapter({ onModelFallback: modelFallbackReporter(callbacks.eventSink) }),
          ...callbacks,
          ...(invocation.payload.workflowE2EAdmission === undefined ? {} : {
            workflowE2EEvidenceRoot: requiredEnvironment("CONTAINED_FOUNDATION_EVIDENCE_DIR"),
            workflowE2ERuntimeRoot: process.cwd(),
            // Built only when an application admission asks for it, so a worker without EXECUTOR_IMAGE still runs portable rounds.
            workflowE2EApplicationRuntime: () => createWorkflowE2EApplicationRuntime(process.env),
          }),
          cancellationController,
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
        });
      }
      if (invocation.kind === "cancel") {
        return executeWorkerCancelInvocation(invocation, cancellationController, journal);
      }
      if (invocation.kind === "close") {
        return inspectWorkspaceForClose(rootPath);
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
