import type { WorkerInvocation } from "@agentx/contracts";
import { OperationJournal } from "./journal.js";
import { prepareWorkspace } from "./prepare.js";
import { createWorkerCallbackSinks } from "./callback-client.js";
import { createRepositoryCredentialProvider } from "./repository-credentials.js";
import { runTaskInvocation } from "./run-task.js";
import { publishWorkspace } from "./publish.js";
import { WorkerCancellationController } from "./cancel.js";
import { createWorkerServerState, startWorkerServer } from "./server.js";

const rootPath = process.env.AGENTX_WORKSPACE_ROOT ?? "/mnt/workspace";
const port = Number.parseInt(process.env.PORT ?? "8080", 10);

const journal = new OperationJournal(rootPath);
const cancellationController = new WorkerCancellationController();
const state = createWorkerServerState(
  journal,
  {
    async execute(invocation: WorkerInvocation): Promise<unknown> {
      if (invocation.kind === "prepare") {
        const controlPlaneUrl = requiredEnvironment("AGENTX_CONTROL_PLANE_URL");
        const manifest = await prepareWorkspace({
          rootPath,
          project: invocation.payload.project,
          creationIdentity: invocation.workspaceId,
          credentialProvider: createRepositoryCredentialProvider({
            controlPlaneUrl,
            invocation,
          }),
        });
        return {
          manifestPath: ".agentx/preparation-manifest.json",
          projectName: manifest.projectName,
          projectRevision: manifest.projectRevision,
        };
      }
      if (invocation.kind === "task") {
        const controlPlaneUrl = requiredEnvironment("AGENTX_CONTROL_PLANE_URL");
        const callbacks = createWorkerCallbackSinks({ controlPlaneUrl, invocation });
        return runTaskInvocation(invocation, {
          rootPath,
          model: {
            provider: requiredEnvironment("AGENTX_MODEL_PROVIDER"),
            modelId: requiredEnvironment("AGENTX_MODEL_ID"),
            thinkingLevel: "medium",
          },
          ...callbacks,
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
        });
      }
      if (invocation.kind === "cancel") {
        const result = await cancellationController.cancel(invocation.payload.targetOperationId);
        await journal.transition(
          invocation.payload.targetOperationId,
          result.status,
          result.status === "CANCELLED"
            ? "operation cancelled by user"
            : "cancellation could not confirm all processes stopped",
        );
        return result;
      }
      throw new Error(`worker operation ${invocation.kind} is not implemented in this delivery slice`);
    },
  },
  {
    async onTerminal(result, invocation) {
      const callbacks = createWorkerCallbackSinks({
        controlPlaneUrl: requiredEnvironment("AGENTX_CONTROL_PLANE_URL"),
        invocation,
      });
      await callbacks.terminalSink(result);
    },
  },
);

startWorkerServer(state, { port });

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for coding tasks`);
  return value;
}
