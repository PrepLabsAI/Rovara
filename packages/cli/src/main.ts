#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  AgentXNameSchema,
  WorkspaceDeploymentModeSchema,
  agentXError,
  type ProjectDefinition,
} from "@agentx/contracts";
import { Command } from "commander";
import { listCredentials, registerCredential } from "./admin/credential.js";
import { registerProject } from "./admin/register.js";
import { bindSlackChannel, unbindSlackChannel } from "./admin/slack.js";
import { stopWorkspace } from "./admin/stop.js";
import { loginWithPkce, tokenStoreKey } from "./auth.js";
import { loadProjectConfig } from "./config.js";
import { loadDeploymentSettings, type DeploymentSettings } from "./deployment.js";
import { formatError, formatSuccess } from "./output.js";
import { SystemCredentialTokenStore, type TokenStore } from "./token-store.js";

interface GlobalOptions {
  project?: string;
  configDir: string;
  deploymentFile: string;
  allowLoopback: boolean;
  json: boolean;
}

interface TextWriter {
  write(text: string): unknown;
}

export interface CliDependencies {
  fetchImplementation?: typeof fetch;
  tokenStore?: TokenStore;
  stdout?: TextWriter;
  stderr?: TextWriter;
}

interface AuthenticatedDeployment {
  settings: DeploymentSettings;
  accessToken: string;
}

export function createCliProgram(dependencies: CliDependencies = {}): Command {
  const services = {
    fetchImplementation: dependencies.fetchImplementation ?? fetch,
    tokenStore: dependencies.tokenStore ?? new SystemCredentialTokenStore(),
    stdout: dependencies.stdout ?? process.stdout,
    stderr: dependencies.stderr ?? process.stderr,
  };

  const program = new Command()
    .name("agentx")
    .description("Administration client for AgentX; developers work through the project's Slack channel")
    .version("0.1.0")
    .option("--project <project-name>", "select a locally configured AgentX project")
    .option("--config-dir <directory>", "project configuration directory", join(homedir(), ".agentx/projects"))
    .option("--deployment-file <path>", "AgentX deployment settings", join(homedir(), ".agentx/deployment.yaml"))
    .option("--allow-loopback", "allow loopback HTTP endpoints for local testing only", false)
    .option("--json", "emit stable machine-readable output", false);

  program
    .command("login")
    .description("authenticate with the selected project's OIDC provider")
    .option("--callback-port <port>", "fixed loopback callback port registered with the OIDC client", parsePort, 8765)
    .action(async (options: { callbackPort: number }, command: Command) => {
      const globals = globalOptions(command);
      const settings = await deploymentSettings(globals);
      await loginWithPkce({
        issuer: settings.auth.issuer,
        clientId: settings.auth.clientId,
        audience: settings.auth.audience,
        tokenStore: services.tokenStore,
        fetchImplementation: services.fetchImplementation,
        callbackPort: options.callbackPort,
      });
      services.stdout.write(formatSuccess({ controlPlaneUrl: settings.controlPlaneUrl, authenticated: true }, globals.json));
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
      const { settings, accessToken } = await authenticate(globals, services.tokenStore);
      const deploymentMode = WorkspaceDeploymentModeSchema.parse(options.deploymentMode);
      const result = await registerProject({
        controlPlaneUrl: settings.controlPlaneUrl,
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

  const adminWorkspace = admin.command("workspace").description("administer AgentX workspaces");
  adminWorkspace
    .command("stop")
    .description("stop idle compute while retaining workspace storage")
    .requiredOption("--workspace <workspace-id>", "workspace to stop")
    .action(async (options: { workspace: string }, command: Command) => {
      const globals = globalOptions(command);
      const { settings, accessToken } = await authenticate(globals, services.tokenStore);
      const result = await stopWorkspace({
        controlPlaneUrl: settings.controlPlaneUrl,
        accessToken,
        workspaceId: options.workspace,
      }, services.fetchImplementation);
      services.stdout.write(formatSuccess(result, globals.json));
    });

  const adminSlack = admin.command("slack").description("bind Slack channels to this project for the hosted orchestrator");
  adminSlack
    .command("bind")
    .description("bind a Slack channel to this project; new threads use its latest registered revision")
    .requiredOption("--team <team-id>", "Slack team ID, for example T0123456789")
    .requiredOption("--channel <channel-id>", "Slack channel ID, for example C0123456789")
    .action(async (options: { team: string; channel: string }, command: Command) => {
      const globals = globalOptions(command);
      const { settings, accessToken } = await authenticate(globals, services.tokenStore);
      const result = await bindSlackChannel({
        controlPlaneUrl: settings.controlPlaneUrl,
        accessToken,
        teamId: options.team,
        channelId: options.channel,
        projectName: AgentXNameSchema.parse(requireProject(globals)),
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
      const { settings, accessToken } = await authenticate(globals, services.tokenStore);
      const result = await unbindSlackChannel({
        controlPlaneUrl: settings.controlPlaneUrl,
        accessToken,
        teamId: options.team,
        channelId: options.channel,
      }, services.fetchImplementation);
      services.stdout.write(formatSuccess(result, globals.json));
    });

  const adminCredential = admin.command("credential").description("register connector credentials stored in Secrets Manager under agentx/connectors/");
  adminCredential
    .command("register")
    .description("register or replace a credential reference; the secret must already exist")
    .requiredOption("--ref <reference>", "credential reference used by connectors' credentialRef")
    .requiredOption("--type <type>", "static-secret or oauth-client-credentials")
    .requiredOption("--secret <name>", "Secrets Manager secret name, agentx/connectors/<name>")
    .action(async (options: { ref: string; type: string; secret: string }, command: Command) => {
      const globals = globalOptions(command);
      const { settings, accessToken } = await authenticate(globals, services.tokenStore);
      services.stdout.write(formatSuccess(await registerCredential({ controlPlaneUrl: settings.controlPlaneUrl, accessToken, ref: options.ref, type: options.type, secretName: options.secret }, services.fetchImplementation), globals.json));
    });
  adminCredential
    .command("list")
    .description("list credential references, types, secret names and whether a token is cached; never secret values")
    .action(async (_options: unknown, command: Command) => {
      const globals = globalOptions(command);
      const { settings, accessToken } = await authenticate(globals, services.tokenStore);
      services.stdout.write(formatSuccess(await listCredentials({ controlPlaneUrl: settings.controlPlaneUrl, accessToken }, services.fetchImplementation), globals.json));
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

function deploymentSettings(options: GlobalOptions): Promise<DeploymentSettings> {
  return loadDeploymentSettings({ path: options.deploymentFile, allowLoopback: options.allowLoopback });
}

async function authenticate(
  options: GlobalOptions,
  tokenStore: TokenStore,
): Promise<AuthenticatedDeployment> {
  const settings = await deploymentSettings(options);
  const tokens = await tokenStore.get(tokenStoreKey(settings.auth));
  if (!tokens || tokens.expiresAt <= Date.now()) throw agentXError("AUTH_REQUIRED", "run agentx login");
  return { settings, accessToken: tokens.accessToken };
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
