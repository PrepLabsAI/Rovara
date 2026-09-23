#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  AgentXError,
  WorkspaceDeploymentModeSchema,
  agentXError,
  type ProjectDefinition,
} from "@agentx/contracts";
import { Command } from "commander";
import { requestWorkspacePreparation } from "./admin/prepare.js";
import { registerProject } from "./admin/register.js";
import { bindSlackChannel, unbindSlackChannel } from "./admin/slack.js";
import { stopWorkspace } from "./admin/stop.js";
import { loginWithPkce, tokenStoreKey } from "./auth.js";
import { requestCancellation } from "./cancel.js";
import { loadReconnectState, saveReconnectState, type ReconnectState } from "./client-state.js";
import { loadProjectConfig } from "./config.js";
import { connectToProject, type ConnectedWorkspace } from "./connect.js";
import { acceptedOperationId, ControlPlaneApi } from "./control-plane-api.js";
import { pollOperation } from "./event-client.js";
import { createPullRequestAndWait } from "./pull-request.js";
import { runOrchestratorInteractive, type OrchestratorOptions } from "./orchestrator.js";
import { formatError, formatSuccess } from "./output.js";
import { SystemSecretStore, type SecretStore } from "./secret-store.js";
import { deleteSlackCredentials } from "./slack-credentials.js";
import { formatWorkspaceStatus } from "./status.js";
import { SystemCredentialTokenStore, type TokenStore } from "./token-store.js";
import { renderProgressEvent } from "./tui.js";

interface GlobalOptions {
  project?: string;
  configDir: string;
  stateDir: string;
  allowLoopback: boolean;
  json: boolean;
  orchestratorProvider?: string;
  orchestratorModel?: string;
}

interface TextWriter {
  write(text: string): unknown;
}

export interface CliDependencies {
  fetchImplementation?: typeof fetch;
  tokenStore?: TokenStore;
  slackSecretStore?: SecretStore;
  stdout?: TextWriter;
  stderr?: TextWriter;
  runInteractive?: (options: OrchestratorOptions) => Promise<void>;
}

interface AuthenticatedProject {
  definition: ProjectDefinition;
  accessToken: string;
}

export function createCliProgram(dependencies: CliDependencies = {}): Command {
  const services = {
    fetchImplementation: dependencies.fetchImplementation ?? fetch,
    tokenStore: dependencies.tokenStore ?? new SystemCredentialTokenStore(),
    slackSecretStore: dependencies.slackSecretStore ?? new SystemSecretStore("dev.agentx.slack"),
    stdout: dependencies.stdout ?? process.stdout,
    stderr: dependencies.stderr ?? process.stderr,
    runInteractive: dependencies.runInteractive ?? runOrchestratorInteractive,
  };

  const program = new Command()
    .name("agentx")
    .description("Local orchestration client for isolated AgentX coding workspaces")
    .version("0.1.0")
    .option("--project <project-name>", "select a locally configured AgentX project")
    .option("--config-dir <directory>", "project configuration directory", join(homedir(), ".agentx/projects"))
    .option("--state-dir <directory>", "local reconnect state directory", join(homedir(), ".agentx/state"))
    .option("--allow-loopback", "allow loopback HTTP endpoints for local testing only", false)
    .option("--json", "emit stable machine-readable output", false)
    .option("--prompt <text>", "submit one remote coding task and wait for its result")
    .option("--orchestrator-provider <provider>", "local pi orchestrator model provider")
    .option("--orchestrator-model <model>", "local pi orchestrator model ID")
    .action(async (options: GlobalOptions & {
      prompt?: string;
      orchestratorProvider?: string;
      orchestratorModel?: string;
    }) => {
      const projectName = requireProject(options);
      const authenticated = await authenticateProject(options, projectName, services.tokenStore);
      const workspace = await connectToProject(
        authenticated.definition,
        authenticated.accessToken,
        services.fetchImplementation,
      );
      const api = new ControlPlaneApi(
        authenticated.definition.controlPlaneUrl,
        authenticated.accessToken,
        workspace.id,
        services.fetchImplementation,
      );
      const connection = await loadOrCreateConnection(options.stateDir, authenticated.definition.name, workspace, api);

      if (options.prompt !== undefined) {
        const accepted = await api.submitTask({
          workspaceId: workspace.id,
          conversationId: connection.conversationId,
          requestId: randomUUID(),
          prompt: options.prompt,
        });
        const operationId = acceptedOperationId(accepted);
        const completed = await pollOperation(operationId, api, options.json ? {} : {
          onEvents: (events) => events.forEach((event) => services.stdout.write(`${renderProgressEvent(event)}\n`)),
        });
        services.stdout.write(formatSuccess(completed, options.json));
        return;
      }
      if (options.json) {
        throw agentXError("CONFIG_INVALID", "--json requires --prompt for the non-interactive workflow");
      }
      const provider = options.orchestratorProvider ?? process.env.AGENTX_ORCHESTRATOR_PROVIDER;
      const modelId = options.orchestratorModel ?? process.env.AGENTX_ORCHESTRATOR_MODEL;
      if (!provider || !modelId) {
        throw agentXError(
          "CONFIG_INVALID",
          "interactive mode requires --orchestrator-provider and --orchestrator-model",
        );
      }
      await services.runInteractive({
        stateDirectory: resolve(options.stateDir, authenticated.definition.name),
        projectInstructions: authenticated.definition.orchestratorInstructions,
        api,
        context: { workspaceId: workspace.id, conversationId: connection.conversationId },
        model: { provider, modelId, thinkingLevel: "medium" },
      });
    });

  program
    .command("login")
    .description("authenticate with the selected project's OIDC provider")
    .option("--callback-port <port>", "fixed loopback callback port registered with the OIDC client", parsePort, 8765)
    .action(async (options: { callbackPort: number }, command: Command) => {
      const globals = globalOptions(command);
      const definition = await selectedProject(globals);
      await loginWithPkce({
        issuer: definition.auth.issuer,
        clientId: definition.auth.clientId,
        audience: definition.auth.audience,
        tokenStore: services.tokenStore,
        fetchImplementation: services.fetchImplementation,
        callbackPort: options.callbackPort,
      });
      services.stdout.write(formatSuccess({ project: definition.name, authenticated: true }, globals.json));
    });

  program
    .command("status")
    .description("show the selected private workspace and readiness")
    .action(async (_options, command: Command) => {
      const globals = globalOptions(command);
      const authenticated = await authenticateProject(globals, requireProject(globals), services.tokenStore);
      const workspace = await connectToProject(
        authenticated.definition,
        authenticated.accessToken,
        services.fetchImplementation,
      );
      services.stdout.write(formatSuccess(
        globals.json ? workspace : formatWorkspaceStatus(workspace),
        globals.json,
      ));
    });

  const conversation = program.command("conversation").description("manage remote coding conversations");
  conversation
    .command("new")
    .description("create a new conversation while preserving workspace files")
    .action(async (_options, command: Command) => {
      const globals = globalOptions(command);
      const authenticated = await authenticateProject(globals, requireProject(globals), services.tokenStore);
      const workspace = await connectToProject(
        authenticated.definition,
        authenticated.accessToken,
        services.fetchImplementation,
      );
      const api = new ControlPlaneApi(
        authenticated.definition.controlPlaneUrl,
        authenticated.accessToken,
        workspace.id,
        services.fetchImplementation,
      );
      const created = await api.createConversation();
      const state: ReconnectState = {
        schemaVersion: 1,
        projectName: authenticated.definition.name,
        workspaceId: workspace.id,
        conversationId: created.id,
      };
      await saveReconnectState(globals.stateDir, state);
      services.stdout.write(formatSuccess(state, globals.json));
    });

  const pullRequest = program.command("pr").description("publish validated workspace changes");
  pullRequest
    .command("create")
    .description("create a ready-for-review pull request from one changed repository")
    .requiredOption("--repository <name>", "registered repository name")
    .requiredOption("--title <title>", "pull request title")
    .option("--body <markdown>", "pull request body")
    .action(async (options: { repository: string; title: string; body?: string }, command: Command) => {
      const globals = globalOptions(command);
      const authenticated = await authenticateProject(globals, requireProject(globals), services.tokenStore);
      const workspace = await connectToProject(
        authenticated.definition,
        authenticated.accessToken,
        services.fetchImplementation,
      );
      const api = new ControlPlaneApi(
        authenticated.definition.controlPlaneUrl,
        authenticated.accessToken,
        workspace.id,
        services.fetchImplementation,
      );
      const result = await createPullRequestAndWait({
        api,
        workspaceId: workspace.id,
        repository: options.repository,
        title: options.title,
        ...(options.body === undefined ? {} : { body: options.body }),
        ...(globals.json ? {} : {
          onProgress: (progress: { message: string }) => services.stdout.write(`${progress.message}\n`),
        }),
      });
      services.stdout.write(formatSuccess(result, globals.json));
    });

  const runPullRequestLifecycle = async (
    action: "append" | "sync" | "edit" | "close" | "reopen" | "replace" | "revert",
    options: { repository: string; number: number; title?: string; body?: string },
    command: Command,
  ) => {
    const globals = globalOptions(command);
    const authenticated = await authenticateProject(globals, requireProject(globals), services.tokenStore);
    const workspace = await connectToProject(
      authenticated.definition,
      authenticated.accessToken,
      services.fetchImplementation,
    );
    const api = new ControlPlaneApi(
      authenticated.definition.controlPlaneUrl,
      authenticated.accessToken,
      workspace.id,
      services.fetchImplementation,
    );
    const accepted = await api.managePullRequest({
      workspaceId: workspace.id,
      requestId: randomUUID(),
      repository: options.repository,
      pullRequestNumber: options.number,
      action,
      ...(options.title === undefined ? {} : { title: options.title }),
      ...(options.body === undefined ? {} : { body: options.body }),
    });
    const operationId = acceptedOperationId(accepted);
    const result = await api.pullRequestResult(
      { workspaceId: workspace.id, operationId },
      globals.json ? {} : {
        onProgress: (progress) => services.stdout.write(`${progress.message}\n`),
      },
    );
    services.stdout.write(formatSuccess(result, globals.json));
  };

  pullRequest
    .command("update")
    .description("edit the title or body of an AgentX pull request")
    .requiredOption("--repository <name>", "registered repository name")
    .requiredOption("--number <number>", "pull request number", parsePositiveInteger)
    .option("--title <title>", "new pull request title")
    .option("--body <markdown>", "new pull request body")
    .action((options: { repository: string; number: number; title?: string; body?: string }, command: Command) =>
      runPullRequestLifecycle("edit", options, command));

  for (const action of ["append", "sync", "close", "reopen"] as const) {
    pullRequest
      .command(action)
      .description({
        append: "validate and append workspace changes to an open AgentX pull request without force push",
        sync: "merge the latest base into an open AgentX pull request without rewriting history",
        close: "close an open AgentX pull request",
        reopen: "reopen a closed, unmerged AgentX pull request",
      }[action])
      .requiredOption("--repository <name>", "registered repository name")
      .requiredOption("--number <number>", "pull request number", parsePositiveInteger)
      .action((options: { repository: string; number: number }, command: Command) =>
        runPullRequestLifecycle(action, options, command));
  }

  for (const action of ["replace", "revert"] as const) {
    pullRequest
      .command(action)
      .description(action === "replace"
        ? "create a clean replacement before closing the original pull request"
        : "create a reviewed revert pull request for a merged AgentX pull request")
      .requiredOption("--repository <name>", "registered repository name")
      .requiredOption("--number <number>", "pull request number", parsePositiveInteger)
      .option("--title <title>", "new pull request title")
      .option("--body <markdown>", "new pull request body")
      .action((options: { repository: string; number: number; title?: string; body?: string }, command: Command) =>
        runPullRequestLifecycle(action, options, command));
  }

  program
    .command("cancel")
    .description("request cooperative cancellation of a remote operation")
    .requiredOption("--operation <operation-id>", "operation to cancel")
    .action(async (options: { operation: string }, command: Command) => {
      const globals = globalOptions(command);
      const authenticated = await authenticateProject(globals, requireProject(globals), services.tokenStore);
      const workspace = await connectToProject(
        authenticated.definition,
        authenticated.accessToken,
        services.fetchImplementation,
      );
      const result = await requestCancellation({
        controlPlaneUrl: authenticated.definition.controlPlaneUrl,
        accessToken: authenticated.accessToken,
        workspaceId: workspace.id,
        operationId: options.operation,
      }, services.fetchImplementation);
      services.stdout.write(formatSuccess(result, globals.json));
    });

  const slack = program.command("slack").description("clean up the retired local Slack mode; Slack now runs as a hosted service");
  slack
    .command("logout")
    .description("remove Slack tokens stored by the retired local Slack mode from the OS credential store")
    .action(async (_options, command: Command) => {
      const globals = globalOptions(command);
      const definition = await selectedProject(globals);
      await deleteSlackCredentials(services.slackSecretStore, definition.name);
      services.stdout.write(formatSuccess({ project: definition.name, slackAuthenticated: false }, globals.json));
    });

  const admin = program.command("admin").description("administrator workflows");
  const adminProject = admin.command("project").description("administer registered projects");
  adminProject
    .command("register")
    .description("register an immutable project revision and trusted runtime binding")
    .requiredOption("--file <path>", "project YAML file")
    .requiredOption("--runtime-arn <arn>", "deployed AgentCore runtime ARN")
    .requiredOption("--deployment-mode <mode>", "demo-microvm or instances-ebs")
    .option("--endpoint-qualifier <qualifier>", "runtime endpoint qualifier", "DEFAULT")
    .option("--capacity-provider-arn <arn>", "required for instances-ebs")
    .action(async (options: {
      file: string;
      runtimeArn: string;
      deploymentMode: string;
      endpointQualifier: string;
      capacityProviderArn?: string;
    }, command: Command) => {
      const globals = globalOptions(command);
      const definition = await projectFromFile(options.file, globals.allowLoopback);
      const accessToken = await requiredAccessToken(definition, services.tokenStore);
      const deploymentMode = WorkspaceDeploymentModeSchema.parse(options.deploymentMode);
      const result = await registerProject({
        controlPlaneUrl: definition.controlPlaneUrl,
        accessToken,
        definition,
        runtimeBinding: {
          runtimeArn: options.runtimeArn,
          endpointQualifier: options.endpointQualifier,
          deploymentMode,
          ...(options.capacityProviderArn === undefined
            ? {}
            : { capacityProviderArn: options.capacityProviderArn }),
        },
      }, services.fetchImplementation);
      services.stdout.write(formatSuccess(result, globals.json));
    });

  const adminWorkspace = admin.command("workspace").description("administer private workspaces");
  adminWorkspace
    .command("prepare")
    .description("prepare an owner's private workspace before coding")
    .requiredOption("--owner <subject>", "OIDC subject of the workspace owner")
    .action(async (options: { owner: string }, command: Command) => {
      const globals = globalOptions(command);
      const authenticated = await authenticateProject(globals, requireProject(globals), services.tokenStore);
      const result = await requestWorkspacePreparation({
        controlPlaneUrl: authenticated.definition.controlPlaneUrl,
        accessToken: authenticated.accessToken,
        requestId: randomUUID(),
        projectName: authenticated.definition.name,
        projectRevision: authenticated.definition.revision,
        ownerSubject: options.owner,
      }, services.fetchImplementation);
      const prepared = preparationResult(result);
      if (prepared.alreadyReady) {
        services.stdout.write(formatSuccess(result, globals.json));
        return;
      }
      const api = new ControlPlaneApi(
        authenticated.definition.controlPlaneUrl,
        authenticated.accessToken,
        prepared.workspaceId,
        services.fetchImplementation,
      );
      const completed = await pollOperation(prepared.operationId, api, globals.json ? {} : {
        onEvents: (events) => events.forEach((event) => services.stdout.write(`${renderProgressEvent(event)}\n`)),
      });
      services.stdout.write(formatSuccess(completed, globals.json));
    });

  adminWorkspace
    .command("stop")
    .description("stop idle compute while retaining workspace storage")
    .requiredOption("--workspace <workspace-id>", "workspace to stop")
    .action(async (options: { workspace: string }, command: Command) => {
      const globals = globalOptions(command);
      const authenticated = await authenticateProject(globals, requireProject(globals), services.tokenStore);
      const result = await stopWorkspace({
        controlPlaneUrl: authenticated.definition.controlPlaneUrl,
        accessToken: authenticated.accessToken,
        workspaceId: options.workspace,
      }, services.fetchImplementation);
      services.stdout.write(formatSuccess(result, globals.json));
    });

  const adminSlack = admin.command("slack").description("bind Slack channels to this project for the hosted orchestrator");
  adminSlack
    .command("bind")
    .description("bind a Slack channel to this project revision; channel members can then start thread workspaces")
    .requiredOption("--team <team-id>", "Slack team ID, for example T0123456789")
    .requiredOption("--channel <channel-id>", "Slack channel ID, for example C0123456789")
    .action(async (options: { team: string; channel: string }, command: Command) => {
      const globals = globalOptions(command);
      const authenticated = await authenticateProject(globals, requireProject(globals), services.tokenStore);
      const result = await bindSlackChannel({
        controlPlaneUrl: authenticated.definition.controlPlaneUrl,
        accessToken: authenticated.accessToken,
        teamId: options.team,
        channelId: options.channel,
        projectName: authenticated.definition.name,
        projectRevision: authenticated.definition.revision,
      }, services.fetchImplementation);
      services.stdout.write(formatSuccess(result, globals.json));
    });
  adminSlack
    .command("unbind")
    .description("remove a Slack channel binding; existing thread workspaces are kept")
    .requiredOption("--team <team-id>", "Slack team ID")
    .requiredOption("--channel <channel-id>", "Slack channel ID")
    .action(async (options: { team: string; channel: string }, command: Command) => {
      const globals = globalOptions(command);
      const authenticated = await authenticateProject(globals, requireProject(globals), services.tokenStore);
      const result = await unbindSlackChannel({
        controlPlaneUrl: authenticated.definition.controlPlaneUrl,
        accessToken: authenticated.accessToken,
        teamId: options.team,
        channelId: options.channel,
      }, services.fetchImplementation);
      services.stdout.write(formatSuccess(result, globals.json));
    });

  return program;
}

export async function executeCli(argv = process.argv.slice(2), dependencies: CliDependencies = {}): Promise<number> {
  try {
    await createCliProgram(dependencies).parseAsync(argv, { from: "user" });
    return 0;
  } catch (error) {
    const json = argv.includes("--json");
    const failure = formatError(error, json);
    (dependencies.stderr ?? process.stderr).write(failure.text);
    return failure.exitCode;
  }
}

async function authenticateProject(
  options: GlobalOptions,
  projectName: string,
  tokenStore: TokenStore,
): Promise<AuthenticatedProject> {
  const definition = await loadProjectConfig({
    projectName,
    configDirectory: options.configDir,
    allowLoopback: options.allowLoopback,
  });
  return { definition, accessToken: await requiredAccessToken(definition, tokenStore) };
}

async function selectedProject(options: GlobalOptions): Promise<ProjectDefinition> {
  return loadProjectConfig({
    projectName: requireProject(options),
    configDirectory: options.configDir,
    allowLoopback: options.allowLoopback,
  });
}

async function requiredAccessToken(definition: ProjectDefinition, tokenStore: TokenStore): Promise<string> {
  const key = tokenStoreKey({
    issuer: definition.auth.issuer,
    clientId: definition.auth.clientId,
    audience: definition.auth.audience,
  });
  const tokens = await tokenStore.get(key);
  if (!tokens || tokens.expiresAt <= Date.now()) {
    throw agentXError("AUTH_REQUIRED", `run agentx login --project ${definition.name}`);
  }
  return tokens.accessToken;
}

async function projectFromFile(path: string, allowLoopback: boolean): Promise<ProjectDefinition> {
  const absolute = resolve(path);
  if (extname(absolute) !== ".yaml") throw agentXError("CONFIG_INVALID", "project file must use .yaml");
  return loadProjectConfig({
    projectName: basename(absolute, ".yaml"),
    configDirectory: dirname(absolute),
    allowLoopback,
  });
}

async function loadOrCreateConnection(
  stateDirectory: string,
  projectName: string,
  workspace: ConnectedWorkspace,
  api: ControlPlaneApi,
): Promise<ReconnectState> {
  try {
    const saved = await loadReconnectState(stateDirectory, projectName);
    if (saved.workspaceId === workspace.id) return saved;
  } catch (error) {
    if (!(error instanceof AgentXError) || error.code !== "NOT_FOUND") throw error;
  }
  const conversation = await api.createConversation();
  const state: ReconnectState = {
    schemaVersion: 1,
    projectName,
    workspaceId: workspace.id,
    conversationId: conversation.id,
  };
  await saveReconnectState(stateDirectory, state);
  return state;
}

function preparationResult(value: unknown): {
  operationId: string;
  workspaceId: string;
  alreadyReady: boolean;
} {
  if (!value || typeof value !== "object") {
    throw agentXError("RUNTIME_UNAVAILABLE", "control plane returned an invalid preparation result");
  }
  const response = value as Record<string, unknown>;
  const workspace = response.workspace;
  if (
    typeof response.operationId !== "string" ||
    !workspace ||
    typeof workspace !== "object" ||
    typeof (workspace as Record<string, unknown>).id !== "string" ||
    typeof response.alreadyReady !== "boolean"
  ) {
    throw agentXError("RUNTIME_UNAVAILABLE", "control plane returned an invalid preparation result");
  }
  return {
    operationId: response.operationId,
    workspaceId: (workspace as Record<string, unknown>).id as string,
    alreadyReady: response.alreadyReady,
  };
}

function requireProject(options: Pick<GlobalOptions, "project">): string {
  if (!options.project) throw agentXError("CONFIG_INVALID", "--project is required");
  return options.project;
}

function parsePort(value: string): number {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw agentXError("CONFIG_INVALID", "callback port must be from 1 through 65535");
  }
  return port;
}

function parsePositiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!/^[1-9][0-9]*$/u.test(value) || !Number.isSafeInteger(parsed)) {
    throw agentXError("CONFIG_INVALID", "value must be a positive integer");
  }
  return parsed;
}

function globalOptions(command: Command): GlobalOptions {
  return command.optsWithGlobals<GlobalOptions>();
}

function isDirectExecution(): boolean {
  const script = process.argv[1];
  return script !== undefined && pathToFileURL(realpathSync(resolve(script))).href === import.meta.url;
}

if (isDirectExecution()) {
  process.exitCode = await executeCli();
}
