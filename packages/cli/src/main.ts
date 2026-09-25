#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  AgentXError,
  AgentXNameSchema,
  WorkspaceDeploymentModeSchema,
  agentXError,
  type ProjectDefinition,
} from "@agentx/contracts";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { Command } from "commander";
import { authorizeCredential, secretsManagerAuthorizeSecrets, type AuthorizeSecrets } from "./admin/authorize.js";
import { listCredentials, registerCredential } from "./admin/credential.js";
import { registerProject } from "./admin/register.js";
import { bindSlackChannel, unbindSlackChannel } from "./admin/slack.js";
import { stopWorkspace } from "./admin/stop.js";
import { exportTurns, parseSince } from "./admin/turns.js";
import { loginWithPkce, openSystemBrowser, tokenStoreKey } from "./auth.js";
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
  /** `admin credential authorize` overrides, for tests. */
  authorize?: {
    secrets?: AuthorizeSecrets;
    openBrowser?: (url: string) => Promise<void>;
    listenPort?: number;
    onListening?: (port: number) => void;
  };
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
      for (const warning of registrationWarnings(result, definition)) services.stderr.write(`Warning: ${warning}\n`);
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
    .requiredOption("--type <type>", "static-secret, oauth-client-credentials or oauth-refresh-token")
    .requiredOption("--secret <name>", "Secrets Manager secret name, agentx/connectors/<name>")
    .action(async (options: { ref: string; type: string; secret: string }, command: Command) => {
      const globals = globalOptions(command);
      const { settings, accessToken } = await authenticate(globals, services.tokenStore);
      services.stdout.write(formatSuccess(await registerCredential({ controlPlaneUrl: settings.controlPlaneUrl, accessToken, ref: options.ref, type: options.type, secretName: options.secret }, services.fetchImplementation), globals.json));
    });
  adminCredential
    .command("authorize")
    .description("sign the connector's bot user in once in a browser, store its refresh token in the secret, and register it as oauth-refresh-token")
    .requiredOption("--ref <reference>", "credential reference used by connectors' credentialRef")
    .requiredOption("--secret <name>", "Secrets Manager secret holding the app's {\"clientId\", \"clientSecret\"}, agentx/connectors/<name>")
    .requiredOption("--provider <name>", "whose sign-in page to use: asana")
    .option("--region <region>", "AWS region of the secret; defaults to your AWS configuration")
    .action(async (options: { ref: string; secret: string; provider: string; region?: string }, command: Command) => {
      const globals = globalOptions(command);
      const { settings, accessToken } = await authenticate(globals, services.tokenStore);
      const overrides = dependencies.authorize ?? {};
      const result = await authorizeCredential({
        controlPlaneUrl: settings.controlPlaneUrl,
        accessToken,
        ref: options.ref,
        secretName: options.secret,
        provider: options.provider,
        secrets: overrides.secrets ?? secretsManagerAuthorizeSecrets(new SecretsManagerClient(options.region ? { region: options.region } : {})),
        openBrowser: overrides.openBrowser ?? openSystemBrowser,
        showUrl: (url, redirectRequirement) => { services.stderr.write(`Sign in as the connector's bot user ${redirectRequirement}. If no browser opened, or it is signed in as someone else, open this URL in a private window signed in as the bot user:\n${url}\n`); },
        showAccount: (line) => { services.stderr.write(`${line}\n`); },
        ...(options.region === undefined ? {} : { region: options.region }),
        fetchImplementation: services.fetchImplementation,
        ...(overrides.listenPort === undefined ? {} : { listenPort: overrides.listenPort }),
        ...(overrides.onListening ? { onListening: overrides.onListening } : {}),
      });
      services.stderr.write(`Stored the refresh token in ${options.secret} and registered ${options.ref} as oauth-refresh-token.\n`);
      services.stdout.write(formatSuccess(result, globals.json));
    });
  adminCredential
    .command("list")
    .description("list credential references, types, secret names and whether a token is cached; never secret values")
    .action(async (_options: unknown, command: Command) => {
      const globals = globalOptions(command);
      const { settings, accessToken } = await authenticate(globals, services.tokenStore);
      services.stdout.write(formatSuccess(await listCredentials({ controlPlaneUrl: settings.controlPlaneUrl, accessToken }, services.fetchImplementation), globals.json));
    });

  const adminTurns = admin.command("turns").description("export turn records: what each Slack turn was offered, asked, chose and answered (kept 30 days)");
  adminTurns
    .command("export")
    .description("write turn records as JSON Lines, newest first; they hold request and response text, so keep the output private")
    .requiredOption("--since <duration>", "how far back to export, such as 30m, 12h or 7d (at most 30d)")
    .option("--output <file>", "write to this file with owner-only permissions instead of stdout")
    .action(async (options: { since: string; output?: string }, command: Command) => {
      const globals = globalOptions(command);
      const since = parseSince(options.since);
      const { settings, accessToken } = await authenticate(globals, services.tokenStore);
      if (options.output === undefined) {
        let printed = 0;
        let result: Awaited<ReturnType<typeof exportTurns>>;
        try {
          result = await exportTurns({
            controlPlaneUrl: settings.controlPlaneUrl,
            accessToken,
            since,
            write: (line) => {
              services.stdout.write(line);
              printed += 1;
            },
          }, services.fetchImplementation);
        } catch (error) {
          throw exportFailure(error, printed, "stdout");
        }
        // stdout carries only JSON Lines, so the summary goes to stderr.
        services.stderr.write(formatSuccess(result, globals.json));
        return;
      }
      // Write beside the target first, so a failure partway never leaves the target itself
      // half-written; only a completed export is ever renamed over it.
      const outputPath = resolve(options.output);
      const partialPath = `${outputPath}.partial`;
      const file = await open(partialPath, "w", 0o600);
      let written = 0;
      try {
        // open() applies the mode only to a new file; tighten an existing one too.
        await file.chmod(0o600);
        const result = await exportTurns({
          controlPlaneUrl: settings.controlPlaneUrl,
          accessToken,
          since,
          write: async (line) => {
            await file.write(line);
            written += 1;
          },
        }, services.fetchImplementation);
        await file.close();
        await rename(partialPath, outputPath);
        // stdout carries only JSON Lines, so the summary goes to stderr.
        services.stderr.write(formatSuccess(result, globals.json));
      } catch (error) {
        await file.close().catch(() => undefined);
        await rm(partialPath, { force: true });
        throw exportFailure(error, written, "file");
      }
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

/**
 * Turns a failure partway through a file export into one naming how many records were written
 * before it happened, so a caller never mistakes a stopped export for a complete one. Keeps the
 * original error's class and, for an AgentXError, its code, so the exit-code mapping is unchanged.
 */
function exportFailure(error: unknown, written: number, target: "file" | "stdout"): unknown {
  const cause = error instanceof Error ? error.message : String(error);
  // Records already printed to stdout stay printed; only a file export can promise nothing was written.
  const message = target === "file"
    ? `turn export failed after ${written} records; no file was written: ${cause}`
    : `turn export failed after ${written} records: ${cause}`;
  if (error instanceof AgentXError) return agentXError(error.code, message);
  if (error instanceof Error) {
    error.message = message;
    return error;
  }
  return new Error(message);
}

/** The server's warnings, plus a note when a control plane too old to run preflight answered. */
function registrationWarnings(result: unknown, definition: ProjectDefinition): string[] {
  const record = result && typeof result === "object" ? result as Record<string, unknown> : {};
  const warnings = Array.isArray(record.warnings) ? record.warnings.filter((entry): entry is string => typeof entry === "string") : [];
  if (definition.integrations && record.preflight === undefined) {
    warnings.push("this control plane did not check connectors at registration; deploy the latest AgentX release to get the preflight report.");
  }
  return warnings;
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
