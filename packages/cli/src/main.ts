#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { Writable as NodeWritable, type Readable, type Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import {
  AgentXError,
  AgentXNameSchema,
  DEFAULT_ENVIRONMENT,
  ENVIRONMENT_PLACEHOLDER,
  EnvironmentNameSchema,
  WorkspaceDeploymentModeSchema,
  agentXError,
  type ProjectDefinition,
} from "@agentx/contracts";
import { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SSMClient } from "@aws-sdk/client-ssm";
import { STSClient } from "@aws-sdk/client-sts";
import { Command, Option } from "commander";
import { authorizeCredential, expectedAccountEmail, secretsManagerAuthorizeSecrets, type AuthorizeSecrets } from "./admin/authorize.js";
import { listCredentials, registerCredential } from "./admin/credential.js";
import { cliRuntimeBinding, registerProject } from "./admin/register.js";
import { bindSlackChannel, unbindSlackChannel } from "./admin/slack.js";
import { stopWorkspace } from "./admin/stop.js";
import { setTaskShareMode } from "./admin/task-share-mode.js";
import { cancelWorkspaceTask } from "./admin/cancel.js";
import { askToApply, exportChanges, runCliChange } from "./admin/changes.js";
import { disableEvalChannel, enableEvalChannel, parseMaxCostUsd, showEvalChannel } from "./admin/eval.js";
import { exportTurns, parseSince } from "./admin/turns.js";
import { loginWithPkce, openSystemBrowser, tokenStoreKey } from "./auth.js";
import { loadProjectConfig } from "./config.js";
import { developerLogout, fetchDeveloperProjects, logoutText, whoamiText } from "./developer/commands.js";
import { resolveDeveloperEnvironment } from "./developer/config.js";
import { developerLogin } from "./developer/login.js";
import { fetchDeveloperWorkspaces, type DeveloperWorkspacesResult } from "./developer/workspaces.js";
import { runWorkspacesCommand } from "./workspaces-ui/index.js";
import { loadDeploymentSettings, type DeploymentSettings } from "./deployment.js";
import { installMcp, MCP_CLIENTS, runCommand, type McpClientKind, type McpInstallDeps } from "./mcp/install.js";
import { runMcpServer, type McpServeDeps } from "./mcp/serve.js";
import type { AdminSession } from "@agentx/mcp";
import { resumeCommand, runDeploy, runInitExport, type DeployCliDependencies, type DeployCommandOptions } from "./deploy/commands.js";
import { cloudFormationStackReader, stsCallerIdentity, type CallerIdentity, type StackReader } from "./environments/adopt.js";
import { resolveDeploymentFile } from "./environments/cache.js";
import { DEFAULT_CLASSIFIER_MODEL, DEFAULT_ORCHESTRATOR_MODEL, DEFAULT_WORKER_MODEL, type InitFlags } from "./init/answers.js";
import { runInit, type InitCliDependencies, type InitOptions } from "./init/commands.js";
import type { FinishFlags, SecretFlags } from "./init/context.js";
import { INIT_STEP_IDS, type InitStepId } from "./init/install-state.js";
import { parseConnectorsFlag } from "./init/finish-steps.js";
import { runEnvAdopt, runEnvList, runEnvUse } from "./environments/commands.js";
import { ssmParameterStore, type ParameterStore } from "./environments/parameter-store.js";
import { settingsParameterName, type EnvironmentSettings } from "./environments/settings.js";
import { formatError, formatSuccess } from "./output.js";
import { realSetupContext, type SetupCommandContext } from "./setup/command-context.js";
import { registerSetupCommands } from "./setup/cli.js";
import { registerConfigCommands } from "./config/cli.js";
import type { ConfigServices } from "./config/commands.js";
import { registerDoctorCommand } from "./doctor/cli.js";
import type { DoctorServices } from "./doctor/checks.js";
import { addSignInOptions, definedEntries, registerSigninCommands, secretSource, signInFlags, type SignInCommandOptions } from "./signin/cli.js";
import { registerDestroyCommand } from "./destroy/cli.js";
import type { DestroyDependencies } from "./destroy/run.js";
import { registerUpgradeCommand } from "./upgrade/cli.js";
import type { UpgradeDependencies } from "./upgrade/run.js";
import { SIGNIN_FLAG_NAMES, type SigninFlags } from "./signin/collect.js";
import type { SigninServices } from "./signin/commands.js";
import { SystemCredentialTokenStore, type TokenStore } from "./token-store.js";
import { CLI_VERSION, RELEASE_VERSION } from "./version.js";

interface GlobalOptions {
  project?: string;
  configDir: string;
  deploymentFile?: string;
  env: string;
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
  /** Named-environment overrides, for tests: the SSM-backed store, the local cache's home directory, and env adopt's AWS readers. */
  environments?: {
    store?: ParameterStore;
    home?: string;
    sts?: CallerIdentity;
    stacks?: StackReader;
    /**
     * Overrides how `env list` and `env use` build their region-scoped SSM client, for tests: lets
     * a test observe the --region the CLI passed into client construction even when `store` above
     * also overrides the client's actual use, so that override can't quietly bypass the client.
     */
    ssmClient?: (region?: string) => SSMClient;
  };
  /** `agentx deploy` and `agentx init --export` overrides, for tests: never touch AWS. */
  deploy?: DeployCliDependencies;
  /** `agentx init` overrides, for tests: never touch AWS, GitHub or Slack. */
  init?: InitCliDependencies;
  /** `agentx signin` overrides, for tests: never touch AWS, Slack or an identity provider. */
  signin?: Partial<SigninServices>;
  /** `agentx config` overrides, for tests: never touch AWS. */
  config?: Partial<ConfigServices>;
  /** `agentx doctor` overrides, for tests: never touch AWS or a vendor. */
  doctor?: { store?: ParameterStore; services?: (settings: EnvironmentSettings) => DoctorServices };
  /** `agentx upgrade` overrides, for tests: never touch AWS or GitHub. */
  upgrade?: Partial<UpgradeDependencies>;
  /** `agentx destroy` overrides, for tests: never touch AWS. */
  destroy?: Partial<DestroyDependencies>;
  /** `agentx workspaces` overrides, for tests: never reach the control plane or open a browser. */
  workspaces?: {
    read?: () => Promise<DeveloperWorkspacesResult>;
    openBrowser?: (url: string) => Promise<void>;
    waitForExit?: () => Promise<void>;
    isInteractive?: () => boolean;
    port?: number;
  };
  /** `agentx mcp` reads MCP messages from here; process.stdin by default. */
  stdin?: Readable;
  /** `agentx mcp`'s clock for waits, for tests. */
  mcpClock?: McpServeDeps["clock"];
  /** `agentx mcp install`'s runner for the claude command, for tests. */
  runCommand?: McpInstallDeps["run"];
  /** `agentx mcp install`'s Codex settings folder, for tests; CODEX_HOME by default. */
  codexHome?: string;
  /** `agentx project add` and the other setup commands (phase 15d2), for tests: never touch AWS,
   * GitHub, Slack or the control plane. */
  setup?: SetupCommandContext;
  /** Answers the admin change commands' "Apply this change?" prompt, for tests (spec 025 Q6). */
  confirm?(question: string): Promise<boolean>;
}

interface AuthenticatedDeployment {
  settings: DeploymentSettings;
  accessToken: string;
}

/**
 * The AWS SDK clients `env adopt` reads from, scoped to its `--region` (never the ambient default
 * region: adopt must read the deployment in the region the operator names, not wherever the AWS
 * profile happens to point). Exported so a test can assert the region reaches client construction
 * without making any network call (constructing a client, or reading its resolved `config.region`,
 * never calls AWS).
 */
export function environmentAdoptClients(region: string): { ssm: SSMClient; cloudFormation: CloudFormationClient; sts: STSClient } {
  return {
    ssm: new SSMClient({ region }),
    cloudFormation: new CloudFormationClient({ region }),
    sts: new STSClient({ region }),
  };
}

/**
 * The SSM client `env list` and `env use` read from: scoped to an explicit `--region` when given,
 * the ambient AWS configuration otherwise. Exported so a test can assert the region reaches client
 * construction without making any network call, the same way `environmentAdoptClients` is tested.
 */
export function environmentSsmClient(region?: string): SSMClient {
  return new SSMClient(region === undefined ? {} : { region });
}

/**
 * The `login --callback-port` default. `auth.ts`'s loopback listener builds its redirect URI as
 * `http://127.0.0.1:<port>/callback`, so the identity stack's Cognito app client must register a
 * callback URL of `http://127.0.0.1:${DEFAULT_CALLBACK_PORT}/callback` for a login with no
 * `--callback-port` override to work; a test ties the two together.
 */
export const DEFAULT_CALLBACK_PORT = 8765;

export function createCliProgram(dependencies: CliDependencies = {}): Command {
  const services = {
    fetchImplementation: dependencies.fetchImplementation ?? fetch,
    tokenStore: dependencies.tokenStore ?? new SystemCredentialTokenStore(),
    stdout: dependencies.stdout ?? process.stdout,
    stderr: dependencies.stderr ?? process.stderr,
  };
  // Where `agentx env use` caches settings and, for production only, where the legacy
  // deployment file lives.
  const home = dependencies.environments?.home ?? homedir();
  const parameterStore = (region?: string): ParameterStore => {
    // Always built from the given region, even when a test overrides the store below: env list and
    // env use must read the account/region the operator names, never an ambient default. A test can
    // substitute how this client itself is built (environments.ssmClient) to observe that, the same
    // way env adopt's client construction is independently testable.
    const client = (dependencies.environments?.ssmClient ?? environmentSsmClient)(region);
    return dependencies.environments?.store ?? ssmParameterStore(client);
  };

  /** The deployment settings for the selected --env: an explicit --deployment-file wins, then the environment cache, then, for production only, the legacy ~/.agentx/deployment.yaml. */
  async function deploymentSettings(options: GlobalOptions): Promise<DeploymentSettings> {
    const path = await resolveDeploymentFile({
      home,
      env: options.env,
      ...(options.deploymentFile === undefined ? {} : { explicitFile: options.deploymentFile }),
    });
    return loadDeploymentSettings({ path, allowLoopback: options.allowLoopback, expectedEnv: options.env });
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

  /** This computer's unexpired admin sign-in (agentx --env <name> login --admin) for an environment by name. Never refreshed (Q4). */
  async function adminSessionFor(name: string): Promise<AdminSession | undefined> {
    try {
      const settings = await deploymentSettings({ ...globalOptions(program), env: name });
      const tokens = await services.tokenStore.get(tokenStoreKey(settings.auth));
      return tokens !== undefined && tokens.expiresAt > Date.now() ? { baseUrl: settings.controlPlaneUrl.replace(/\/$/, ""), accessToken: tokens.accessToken } : undefined;
    } catch {
      return undefined;
    }
  }

  /** The developer sign-in's session dependencies: this computer's home and token store. */
  const developerSession = () => ({ home, tokenStore: services.tokenStore, fetch: services.fetchImplementation });

  const program = new Command()
    .name("agentx")
    .description("AgentX: sign in, and administer AgentX; developers hand off tasks from their AI tools or work in Slack")
    .version(CLI_VERSION)
    .option("--project <project-name>", "select a locally configured AgentX project")
    .option("--config-dir <directory>", "project configuration directory", join(homedir(), ".agentx/projects"))
    .option("--deployment-file <path>", "AgentX deployment settings; defaults to this environment's local cache, or, for production, ~/.agentx/deployment.yaml")
    .option("--env <name>", "AgentX environment", DEFAULT_ENVIRONMENT)
    .option("--allow-loopback", "allow loopback HTTP endpoints for local testing only", false)
    .option("--json", "emit stable machine-readable output", false);

  // Refuse an invalid --env before any command runs, so a malformed name never reaches AWS.
  program.hook("preAction", (_program, actionCommand) => {
    const { env } = actionCommand.optsWithGlobals<GlobalOptions>();
    const parsed = EnvironmentNameSchema.safeParse(env);
    if (!parsed.success) {
      throw agentXError("CONFIG_INVALID", `invalid --env ${JSON.stringify(env)}: ${parsed.error.issues[0]?.message ?? "invalid environment name"}`);
    }
    // EnvironmentNameSchema itself still accepts the placeholder (synthesizing its templates
    // requires that), but it is reserved for published templates, not a real deployment: refuse it
    // here, before any AWS or file access.
    if (parsed.data === ENVIRONMENT_PLACEHOLDER) {
      throw agentXError("CONFIG_INVALID", `--env ${JSON.stringify(env)} is reserved for published templates and cannot be used as a real environment`);
    }
  });

  program
    .command("login")
    .description("sign in: agentx login <url> for developers; agentx login --admin (or no URL) for administrators")
    .argument("[url]", "your AgentX URL, for developer sign-in")
    .option("--admin", "sign in as an administrator with the admin identity provider (the default when no URL is given)", false)
    .option("--no-browser", "developer sign-in: print the sign-in link instead of opening a browser")
    .option("--callback-port <port>", "fixed loopback callback port registered with the OIDC client", parsePort, DEFAULT_CALLBACK_PORT)
    .action(async (url: string | undefined, options: { admin: boolean; browser: boolean; callbackPort: number }, command: Command) => {
      const globals = globalOptions(command);
      if (url !== undefined && options.admin) {
        throw agentXError("CONFIG_INVALID", "use either agentx login <url> (developer sign-in) or agentx login --admin, not both");
      }
      if (url !== undefined) {
        const result = await developerLogin({
          url,
          allowLoopback: globals.allowLoopback,
          browser: options.browser,
          home,
          tokenStore: services.tokenStore,
          fetch: services.fetchImplementation,
          write: (line) => { services.stderr.write(`${line}\n`); },
          ...(command.getOptionValueSource("callbackPort") === "cli" ? { callbackPort: options.callbackPort } : {}),
        });
        const projects = await fetchDeveloperProjects(developerSession(), result.env);
        services.stdout.write(globals.json ? formatSuccess({ env: projects.env, url: projects.url, ...projects.projects }, true) : whoamiText(projects));
        return;
      }
      // A bare login (or --admin) is today's admin login, unchanged.
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

  /** The developer environment: --env when typed, otherwise the default agentx login set. */
  const developerEnv = (command: Command): string | undefined =>
    command.getOptionValueSourceWithGlobals("env") === "cli" ? globalOptions(command).env : undefined;

  program
    .command("logout")
    .description("sign out of AgentX on this computer and end the sign-in at the server; --admin signs out of the admin sign-in")
    .option("--admin", "sign out of the administrator sign-in instead", false)
    .action(async (options: { admin: boolean }, command: Command) => {
      const globals = globalOptions(command);
      if (options.admin) {
        const settings = await deploymentSettings(globals);
        await services.tokenStore.delete(tokenStoreKey(settings.auth));
        services.stdout.write(globals.json ? formatSuccess({ env: globals.env, admin: true }, true) : `Signed out of the admin sign-in for ${globals.env}.\n`);
        return;
      }
      const result = await developerLogout(developerSession(), developerEnv(command));
      services.stdout.write(globals.json ? formatSuccess(result, true) : logoutText(result));
    });

  program
    .command("whoami")
    .description("show who you are signed in as and which AgentX projects you can use")
    .action(async (_options: unknown, command: Command) => {
      const globals = globalOptions(command);
      const result = await fetchDeveloperProjects(developerSession(), developerEnv(command));
      services.stdout.write(globals.json ? formatSuccess({ env: result.env, url: result.url, ...result.projects }, true) : whoamiText(result));
    });

  program
    .command("workspaces")
    .description("show your AgentX projects and the workspaces in them, on a page served from 127.0.0.1; --no-ui prints them instead")
    .option("--no-ui", "print the list in the terminal instead of opening a browser")
    .action(async (options: { ui: boolean }, command: Command) => {
      const globals = globalOptions(command);
      const overrides = dependencies.workspaces ?? {};
      const env = developerEnv(command);
      // --json is machine-readable output, so it never opens a browser; neither does a session with
      // no terminal, where nobody is there to see the page open.
      const interactive = (overrides.isInteractive ?? (() => process.stdin.isTTY === true))();
      const ui = options.ui && !globals.json && interactive;
      await runWorkspacesCommand({
        read: overrides.read ?? (() => fetchDeveloperWorkspaces(developerSession(), env)),
        ui,
        json: globals.json,
        stdout: services.stdout,
        stderr: services.stderr,
        openBrowser: overrides.openBrowser ?? openSystemBrowser,
        ...(overrides.waitForExit === undefined ? {} : { waitForExit: overrides.waitForExit }),
        ...(overrides.port === undefined ? {} : { port: overrides.port }),
      });
    });

  registerSigninCommands(program, {
    ...(dependencies.signin === undefined ? {} : { overrides: dependencies.signin }),
    parameterStore, fetch: services.fetchImplementation, stdout: services.stdout, stderr: services.stderr,
  });
  registerConfigCommands(program, {
    ...(dependencies.config === undefined ? {} : { overrides: dependencies.config }), parameterStore, fetch: services.fetchImplementation, stdout: services.stdout, stderr: services.stderr,
    stdin: dependencies.stdin ?? process.stdin,
    // Spec 025 FR-053: the workspace limits change with the admin sign-in of the environment --env names.
    adminSession: async (env: string) => {
      const session = await adminSessionFor(env);
      return session === undefined ? undefined : { controlPlaneUrl: session.baseUrl, accessToken: session.accessToken };
    },
  });

  registerDoctorCommand(program, {
    ...(dependencies.doctor?.store === undefined ? {} : { store: dependencies.doctor.store }),
    ...(dependencies.doctor?.services === undefined ? {} : { services: dependencies.doctor.services }),
    parameterStore, fetch: services.fetchImplementation, home, stdout: services.stdout, stderr: services.stderr,
  });
  registerUpgradeCommand(program, {
    ...(dependencies.upgrade === undefined ? {} : { overrides: dependencies.upgrade }),
    ...(dependencies.deploy === undefined ? {} : { deploy: dependencies.deploy }),
    parameterStore, fetch: services.fetchImplementation, home, stdout: services.stdout, stderr: services.stderr,
  });
  registerDestroyCommand(program, {
    ...(dependencies.destroy === undefined ? {} : { overrides: dependencies.destroy }),
    parameterStore, stdin: dependencies.stdin ?? process.stdin, home, tokenStore: services.tokenStore, stdout: services.stdout, stderr: services.stderr,
  });

  const admin = program.command("admin").description("administrator workflows");
  const adminProject = admin.command("project").description("administer registered projects");
  adminProject
    .command("register")
    .description("register an immutable project revision and trusted runtime binding")
    .requiredOption("--file <path>", "project YAML file")
    .option("--deployment-mode <mode>", "ec2-ebs", "ec2-ebs")
    .option("--launch-template-id <id>", "EC2 worker launch template (ec2-ebs), the foundation's Ec2WorkerLaunchTemplateId")
    .option("--subnets <pairs>", "availabilityZone=subnetId pairs, comma-separated (ec2-ebs), the foundation's Ec2WorkerSubnets")
    .option("--volume-size-gib <size>", "workspace volume size in GiB (ec2-ebs)", "20")
    .option("--volume-type <type>", "workspace volume type (ec2-ebs)", "gp3")
    .action(async (options: {
      file: string;
      deploymentMode: string;
      launchTemplateId?: string;
      subnets?: string;
      volumeSizeGib: string;
      volumeType: string;
    }, command: Command) => {
      const globals = globalOptions(command);
      const deploymentMode = WorkspaceDeploymentModeSchema.parse(options.deploymentMode);
      const runtimeBinding = cliRuntimeBinding(deploymentMode, options);
      const definition = await projectFromFile(options.file, globals.allowLoopback);
      const { settings, accessToken } = await authenticate(globals, services.tokenStore);
      const result = await registerProject({
        controlPlaneUrl: settings.controlPlaneUrl,
        accessToken,
        definition,
        runtimeBinding,
      }, services.fetchImplementation);
      services.stdout.write(formatSuccess(result, globals.json));
      for (const warning of registrationWarnings(result, definition)) services.stderr.write(`Warning: ${warning}\n`);
    });

  // Spec 025 E17 (Q6): a person typing the command is the confirmation; --yes answers for them.
  // Without --yes the prompt needs a terminal, checked before anything is planned.
  // Final review M11: as config set limits.* does, the prompt reads the command's own stdin and
  // writes through its own stderr, and no terminal is CONFIRMATION_UNAVAILABLE.
  const changeConfirmer = (yes: boolean): ((question: string) => Promise<boolean>) => {
    if (yes) return async () => true;
    if (dependencies.confirm !== undefined) return (question) => dependencies.confirm!(question);
    const stdin: NodeJS.ReadableStream & { isTTY?: boolean } = dependencies.stdin ?? process.stdin;
    if (stdin.isTTY !== true) throw agentXError("CONFIRMATION_UNAVAILABLE", "this change needs a yes: run the command in a terminal to answer its prompt, or pass --yes; nothing changed");
    const output = new NodeWritable({ write(chunk: Buffer | string, _encoding, done) { services.stderr.write(chunk.toString()); done(); } });
    return (question) => askToApply(question, { input: stdin, output, signals: process });
  };
  for (const action of ["grant", "revoke"] as const) {
    adminProject
      .command(action)
      .description(action === "grant"
        ? "let a developer hand tasks to a project from an AI tool: shows the change and asks first"
        : "remove a developer's granted access to a project: shows the change and asks first")
      .option("--project <name>", "the project's name (required)")
      .option("--developer <who>", "a Slack user ID such as U0123456789, the email they signed in with, or a developer ID (required)")
      .option("--yes", "apply without asking; the change is still printed", false)
      .action(async (options: { project?: string; developer?: string; yes: boolean }, command: Command) => {
        // Checked here, not by commander, so the refusal is AgentX's own and names what to do.
        // The program's own --project can take the value first, as it does for admin slack bind.
        const globals = globalOptions(command);
        // The global --project takes the value when given (as for admin slack bind), so read both.
        const projectName = options.project ?? globals.project;
        if (projectName === undefined) throw agentXError("CONFIG_INVALID", `--project is required: name the project, such as agentx admin project ${action} --project payments --developer U0123456789`);
        const project = AgentXNameSchema.safeParse(projectName);
        if (!project.success) throw agentXError("CONFIG_INVALID", "--project must be a project name: a lowercase letter, then up to 62 lowercase letters, digits or hyphens");
        // The developer reference is never echoed: it may be an email.
        const developer = options.developer?.trim();
        if (developer === undefined || developer === "") {
          throw agentXError("CONFIG_INVALID", "--developer is required: a Slack user ID such as U0123456789, the email they signed in to AgentX with, or a developer ID");
        }
        if (developer.length > 254) {
          throw agentXError("CONFIG_INVALID", "--developer must be at most 254 characters; name them by Slack user ID, the email they signed in with, or developer ID");
        }
        const confirm = changeConfirmer(options.yes);
        const { settings, accessToken } = await authenticate(globals, services.tokenStore);
        const result = await runCliChange({
          controlPlaneUrl: settings.controlPlaneUrl,
          accessToken,
          cliVersion: CLI_VERSION,
          change: { kind: action === "grant" ? "grant_project_access" : "revoke_project_access", project: project.data, developer },
          // The effect is already printed above the prompt.
          confirm: () => confirm("Apply this change?"),
          write: (line) => { services.stderr.write(`${line}\n`); },
        }, services.fetchImplementation);
        services.stdout.write(formatSuccess({ outcome: result.outcome, changeId: result.change.changeId }, globals.json));
      });
  }

  const adminWorkspace = admin.command("workspace").description("administer AgentX workspaces");
  adminWorkspace
    .command("cancel")
    .description("cancel the workspace's running coding task; its conversation keeps what finished before")
    .requiredOption("--workspace <workspace-id>", "workspace whose task to cancel")
    .action(async (options: { workspace: string }, command: Command) => {
      const globals = globalOptions(command);
      const { settings, accessToken } = await authenticate(globals, services.tokenStore);
      const result = await cancelWorkspaceTask({
        controlPlaneUrl: settings.controlPlaneUrl,
        accessToken,
        workspaceId: options.workspace,
      }, services.fetchImplementation);
      // Issue 196: a task that had already finished keeps its result; say so plainly.
      const finished = (result as { finishedStatus?: unknown } | null)?.finishedStatus;
      const plain = finished === "CANCELLED" ? "The task was already cancelled."
        : typeof finished === "string" ? `The task had already finished as ${finished}, so nothing was cancelled.` : result;
      services.stdout.write(formatSuccess(globals.json ? result : plain, globals.json));
    });
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

  const adminEval = admin.command("eval").description("SWE-bench runs from Slack (spec 043): `@agentx eval swebench <dataset> <instance>` in an enabled channel");
  const evalChannel = (options: { team: string; channel: string }, settings: { controlPlaneUrl: string }, accessToken: string) => ({
    controlPlaneUrl: settings.controlPlaneUrl, accessToken, teamId: options.team, channelId: options.channel,
  });
  adminEval
    .command("enable")
    .description("let any member of a bound channel start SWE-bench runs, each capped at a cost ceiling")
    .requiredOption("--team <team-id>", "Slack team ID, for example T0123456789")
    .requiredOption("--channel <channel-id>", "Slack channel ID, for example C0123456789")
    .option("--max-cost-usd <usd>", "per-run cost ceiling in US dollars, from 1 to 100 (default 10)", parseMaxCostUsd)
    .action(async (options: { team: string; channel: string; maxCostUsd?: number }, command: Command) => {
      const globals = globalOptions(command);
      const { settings, accessToken } = await authenticate(globals, services.tokenStore);
      const result = await enableEvalChannel({
        ...evalChannel(options, settings, accessToken),
        ...(options.maxCostUsd === undefined ? {} : { maxCostUsd: options.maxCostUsd }),
      }, services.fetchImplementation);
      services.stdout.write(formatSuccess(result, globals.json));
    });
  adminEval
    .command("show")
    .description("show whether a channel may start SWE-bench runs, and its cost ceiling")
    .requiredOption("--team <team-id>", "Slack team ID")
    .requiredOption("--channel <channel-id>", "Slack channel ID")
    .action(async (options: { team: string; channel: string }, command: Command) => {
      const globals = globalOptions(command);
      const { settings, accessToken } = await authenticate(globals, services.tokenStore);
      services.stdout.write(formatSuccess(await showEvalChannel(evalChannel(options, settings, accessToken), services.fetchImplementation), globals.json));
    });
  adminEval
    .command("disable")
    .description("stop a channel from starting SWE-bench runs; a run in progress finishes")
    .requiredOption("--team <team-id>", "Slack team ID")
    .requiredOption("--channel <channel-id>", "Slack channel ID")
    .action(async (options: { team: string; channel: string }, command: Command) => {
      const globals = globalOptions(command);
      const { settings, accessToken } = await authenticate(globals, services.tokenStore);
      services.stdout.write(formatSuccess(await disableEvalChannel(evalChannel(options, settings, accessToken), services.fetchImplementation), globals.json));
    });

  const adminCredential = admin.command("credential").description("register connector credentials stored in Secrets Manager under agentx/connectors/ or agentx/<env>/connectors/");
  adminCredential
    .command("register")
    .description("register or replace a credential reference; the secret must already exist")
    .requiredOption("--ref <reference>", "credential reference used by connectors' credentialRef")
    .requiredOption("--type <type>", "static-secret, oauth-client-credentials or oauth-refresh-token")
    .requiredOption("--secret <name>", "Secrets Manager secret name, agentx/connectors/<name> or agentx/<env>/connectors/<name>")
    .action(async (options: { ref: string; type: string; secret: string }, command: Command) => {
      const globals = globalOptions(command);
      const { settings, accessToken } = await authenticate(globals, services.tokenStore);
      services.stdout.write(formatSuccess(await registerCredential({ controlPlaneUrl: settings.controlPlaneUrl, accessToken, ref: options.ref, type: options.type, secretName: options.secret }, services.fetchImplementation), globals.json));
    });
  adminCredential
    .command("authorize")
    .description("sign the connector's bot user in once in a browser, store its refresh token in the secret, and register it as oauth-refresh-token")
    .requiredOption("--ref <reference>", "credential reference used by connectors' credentialRef")
    .requiredOption("--secret <name>", "Secrets Manager secret holding the app's {\"clientId\", \"clientSecret\"}, agentx/connectors/<name> or agentx/<env>/connectors/<name>")
    .requiredOption("--provider <name>", "whose sign-in page to use: asana")
    .option("--region <region>", "AWS region of the secret; defaults to your AWS configuration")
    .option("--no-browser", "do not open a browser; only print the sign-in URL, to open in a private window signed in as the bot user")
    .option("--expect-account <email>", "the bot user's email; refuse, storing nothing, when another account signs in")
    .action(async (options: { ref: string; secret: string; provider: string; region?: string; browser: boolean; expectAccount?: string }, command: Command) => {
      const globals = globalOptions(command);
      // A blank --expect-account fails before logging in or reading the secret.
      expectedAccountEmail(options.expectAccount);
      const { settings, accessToken } = await authenticate(globals, services.tokenStore);
      const overrides = dependencies.authorize ?? {};
      const result = await authorizeCredential({
        controlPlaneUrl: settings.controlPlaneUrl,
        accessToken,
        ref: options.ref,
        secretName: options.secret,
        provider: options.provider,
        secrets: overrides.secrets ?? secretsManagerAuthorizeSecrets(new SecretsManagerClient(options.region ? { region: options.region } : {})),
        ...(options.browser ? { openBrowser: overrides.openBrowser ?? openSystemBrowser } : {}),
        ...(options.expectAccount === undefined ? {} : { expectAccount: options.expectAccount }),
        showUrl: (url, redirectRequirement) => {
          const open = options.browser
            ? "If no browser opened, or it is signed in as someone else, open this URL in a private window signed in as the bot user"
            : "Open this URL in a private window signed in as the bot user";
          services.stderr.write(`Sign in as the connector's bot user ${redirectRequirement}. ${open}:\n${url}\n`);
        },
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

  const adminTask = admin.command("task").description("administer tasks started from AI tools");
  adminTask
    .command("share-mode")
    .description("switch a shared task between view only and continue, within its project's policy")
    .requiredOption("--task <task-id>", "the task to change")
    .requiredOption("--mode <mode>", "view or continue")
    .action(async (options: { task: string; mode: string }, command: Command) => {
      if (options.mode !== "view" && options.mode !== "continue") throw agentXError("CONFIG_INVALID", "--mode must be view or continue");
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(options.task)) {
        throw agentXError("CONFIG_INVALID", "--task must be a task ID, such as 44444444-4444-4444-8444-444444444444; agentx admin turns export shows task IDs");
      }
      const globals = globalOptions(command);
      const { settings, accessToken } = await authenticate(globals, services.tokenStore);
      const result = await setTaskShareMode({ controlPlaneUrl: settings.controlPlaneUrl, accessToken, taskId: options.task, mode: options.mode }, services.fetchImplementation);
      services.stdout.write(formatSuccess(result, globals.json));
    });

  // Spec 025 FR-052: registered after the existing admin commands, so their order is unchanged.
  admin
    .command("changes")
    .description("list admin change records (kept 30 days): who asked, the change, how it was confirmed and how it ended; --json writes JSON Lines")
    .requiredOption("--since <duration>", "how far back, such as 30m, 12h or 7d (at most 30d)")
    .action(async (options: { since: string }, command: Command) => {
      const globals = globalOptions(command);
      const since = parseSince(options.since, Date.now(), "change records");
      const { settings, accessToken } = await authenticate(globals, services.tokenStore);
      const result = await exportChanges({
        controlPlaneUrl: settings.controlPlaneUrl,
        accessToken,
        since,
        json: globals.json,
        write: (line) => { services.stdout.write(line); },
      }, services.fetchImplementation);
      // stdout carries only the records, so the count goes to stderr.
      services.stderr.write(`${result.exported} change record${result.exported === 1 ? "" : "s"} since ${result.since}\n`);
    });

  registerSetupCommands(program, dependencies.setup ?? realSetupContext({
    parameterStore, fetch: services.fetchImplementation, tokenStore: services.tokenStore, stdout: services.stdout, stderr: services.stderr,
  }));

  const envCommand = program.command("env").description("AgentX environments in this AWS account and region");
  envCommand
    .command("list")
    .description("list the environments installed in this AWS account and region")
    .option("--region <region>", "AWS region to list environments in; defaults to your AWS configuration")
    .action(async (options: { region?: string }, command: Command) => {
      const globals = globalOptions(command);
      const environments = await runEnvList(parameterStore(options.region));
      if (globals.json) {
        services.stdout.write(formatSuccess({ environments }, true));
      } else {
        services.stdout.write(
          environments.length > 0
            ? environments.map((name) => `${name}\n`).join("")
            : "no environments in this account and region\n",
        );
      }
    });
  envCommand
    .command("use")
    .description("rebuild the selected --env's local settings cache from SSM")
    .option("--region <region>", "AWS region of the environment's SSM parameters; defaults to your AWS configuration")
    .action(async (options: { region?: string }, command: Command) => {
      const globals = globalOptions(command);
      const result = await runEnvUse({ store: parameterStore(options.region), home, env: globals.env });
      services.stdout.write(
        globals.json
          ? formatSuccess(result, true)
          : `Using environment ${result.env} (${result.controlPlaneUrl}); settings saved to ${result.path}\n`,
      );
    });
  envCommand
    .command("adopt")
    .description("register the existing deployment (fixed legacy stack names) as the selected --env, reading its CloudFormation stacks; never changes them")
    .requiredOption("--region <region>", "AWS region of the existing deployment")
    .option("--client-id <id>", "OIDC/Cognito app client ID; defaults to the control plane's OidcAudience")
    .action(async (options: { region: string; clientId?: string }, command: Command) => {
      const globals = globalOptions(command);
      // Always built from --region, even when a test overrides the higher-level store/stacks/sts
      // below: adopt must read the deployment in the named region, never an ambient default.
      const clients = environmentAdoptClients(options.region);
      const result = await runEnvAdopt({
        store: dependencies.environments?.store ?? ssmParameterStore(clients.ssm),
        home,
        env: globals.env,
        region: options.region,
        ...(options.clientId === undefined ? {} : { clientId: options.clientId }),
        stacks: dependencies.environments?.stacks ?? cloudFormationStackReader(clients.cloudFormation),
        identity: dependencies.environments?.sts ?? stsCallerIdentity(clients.sts),
      });
      services.stdout.write(
        globals.json
          ? formatSuccess(result, true)
          : `Adopted ${result.env}: ${result.controlPlaneUrl}; settings in ${settingsParameterName(result.env)}\n`,
      );
    });

  program
    .command("deploy")
    .description("deploy or upgrade an environment from a release; used by init and upgrade, and for automation")
    .addOption(new Option("--mode <mode>", "install a fresh environment or upgrade an existing one").choices(["install", "upgrade"]).makeOptionMandatory())
    .addOption(new Option("--engine <engine>", "deploy engine: pre-synthesized CloudFormation change sets, or a real cdk deploy").choices(["templates", "cdk"]).default("templates"))
    .requiredOption("--release <dir>", "release directory (agentx release build output)")
    .requiredOption("--answers <file>", "deploy answers JSON file (see DeployAnswers)")
    .option("--parts <parts>", "comma-separated subset of parts to deploy, in the mode's order; default: the whole order")
    .option("--source <dir>", "git checkout of the release's source tag; required for --engine cdk")
    .option("--yes", "execute without an interactive change-set confirmation; required for --engine cdk", false)
    .action(async (options: { mode: "install" | "upgrade"; engine: "templates" | "cdk"; release: string; answers: string; parts?: string; source?: string; yes: boolean }, command: Command) => {
      const globals = globalOptions(command);
      // --env is a global option (defaulting to production); only cross-check it against the
      // answers file's own env when the operator actually typed --env, never against the silent
      // default, so an omitted --env keeps working unchanged (the answers file alone decides).
      const envGivenExplicitly = command.getOptionValueSourceWithGlobals("env") === "cli";
      const deployOptions: DeployCommandOptions = {
        mode: options.mode,
        engine: options.engine,
        releaseDir: options.release,
        answersFile: options.answers,
        yes: options.yes,
        ...(options.parts === undefined ? {} : { parts: options.parts }),
        ...(options.source === undefined ? {} : { source: options.source }),
        ...(envGivenExplicitly ? { expectedEnv: globals.env } : {}),
      };
      const result = await runDeploy(deployOptions, dependencies.deploy ?? {}, { stderr: services.stderr });
      if (globals.json) {
        services.stdout.write(formatSuccess(result, true));
        return;
      }
      const lines = [`${options.mode === "install" ? "Installed" : "Upgraded"} environment ${result.env}${result.settingsWritten ? "" : " (not every part is deployed yet)"}`];
      if (!result.settingsWritten) {
        lines.push(
          `Deployed parts: ${result.deployedParts.join(", ") || "none"}`,
          `Missing parts: ${result.missingParts.join(", ") || "none"}`,
          "Environment settings are written once every part is deployed.",
        );
        if (result.missingParts.length > 0) lines.push(`Resume with: ${resumeCommand(deployOptions, result.missingParts)}`);
      }
      services.stdout.write(`${lines.join("\n")}\n`);
    });

  addSignInOptions(
  program
    .command("init")
    .description("install AgentX in this AWS account, step by step, resuming where it stopped; --export writes a bundle for a platform team instead")
    .option("--export <dir>", "write a self-contained bundle a platform team deploys to create the access stack")
    .option("--region <region>", "AWS region to deploy into")
    .option("--account <account>", "AWS account id; defaults to the caller's own account (sts GetCallerIdentity, read-only)")
    .option("--release <dir>", "release directory (agentx release build output); default: download the release matching this agentx. An agentx built from source needs none with --engine cdk --source")
    .addOption(new Option("--engine <engine>", "deploy engine: published CloudFormation templates, or cdk from a source checkout").choices(["templates", "cdk"]))
    .option("--source <dir>", "clean git checkout of a release tag; required for --engine cdk. An agentx built from source takes the version from its tag")
    .option("--resume", "only continue an install already under way; never start a new one", false)
    .option("--from-bundle <dir>", "with --resume: continue an install whose access stack a platform team deployed from this export bundle")
    .option("--yes", "answer every question with its default or its flag, without asking; the plan is still printed. Confirmations such as the Slack bot and workspace check and \"Request URL Verified?\" are answered yes, so check the printed summary afterwards", false)
    .option("--no-browser", "print every address to open instead of opening a browser, and ask in the terminal unless --ui is given")
    .option("--ui", "ask every question on a page on 127.0.0.1 (the default in an interactive terminal that can open a browser)")
    .option("--no-ui", "ask every question in the terminal")
    .addOption(new Option("--identity <mode>", "identity provider").choices(["cognito", "oidc"]).default("cognito"))
    .option("--oidc-issuer <url>", "your OIDC provider's issuer URL (required with --identity oidc)")
    .option("--oidc-audience <audience>", "your OIDC provider's audience (required with --identity oidc)")
    .option("--oidc-client-id <id>", "your OIDC provider's client id, needed for agentx login")
    .option("--admin-claim <claim>", "the OIDC claim that marks AgentX administrators")
    .option("--admin-values <values>", "comma-separated values of --admin-claim that mark an administrator")
    .option("--permission-boundary <arn>", "IAM permissions boundary ARN applied to every role AgentX creates")
    .option("--operator-principal <arn>", "IAM principal ARN allowed to assume the AgentX operator role")
    .addOption(new Option("--model-provider <provider>", "model provider for the orchestrator, classifier and worker; a per-component provider flag wins over it").choices(["amazon-bedrock", "openrouter"]))
    .option("--orchestrator-provider <provider>", "amazon-bedrock (default) or openrouter")
    .option("--classifier-provider <provider>", "amazon-bedrock (default) or openrouter")
    .option("--worker-provider <provider>", "amazon-bedrock (default) or openrouter")
    .option("--openrouter-key-file <path>", "file holding the OpenRouter API key; init stores it in agentx/<env>/openrouter")
    .option("--openrouter-key-env <NAME>", "environment variable holding the OpenRouter API key; init stores it in agentx/<env>/openrouter")
    .option("--openrouter-secret-arn <arn>", "a Secrets Manager secret you made yourself holding the raw OpenRouter key; init then asks for no key")
    .option("--openrouter-providers <slugs>", "comma-separated OpenRouter provider allowlist")
    .option("--orchestrator-model <id>", "Provider model id for the Slack orchestrator", DEFAULT_ORCHESTRATOR_MODEL)
    .option("--classifier-model <id>", "Provider model id for the gate classifier", DEFAULT_CLASSIFIER_MODEL)
    .option("--worker-model <id>", "Provider model id for the runtime worker", DEFAULT_WORKER_MODEL)
    .option("--alert-email <address>", "email address AgentX sends alerts to")
    .option("--alert-webhook-file <path>", "file holding a PagerDuty or Opsgenie integration address (kept secret)")
    .option("--alert-webhook-env <NAME>", "environment variable holding a PagerDuty or Opsgenie integration address (kept secret)")
    .option("--no-alerts", "send alerts nowhere for now")
    .option("--budget <usd>", "monthly AWS budget in whole US dollars; 0 for none (default 100)")
    .addOption(new Option("--budget-scope <scope>", "tag: costs tagged agentx:env; account: the whole account").choices(["tag", "account"]))
    .option("--github-account <login>", "GitHub organization or user that will own the AgentX GitHub App")
    .addOption(new Option("--github-account-type <type>", "whether --github-account is an organization or a personal account").choices(["organization", "user"]))
    .option("--github-app-name <name>", "GitHub App name (unique on GitHub)")
    .option("--github-app-id <id>", "a GitHub App made beforehand: its app id")
    .option("--github-installation-id <id>", "a GitHub App made beforehand: its installation id")
    .option("--github-private-key-file <path>", "a GitHub App made beforehand: its private key .pem file")
    .option("--github-private-key-env <NAME>", "a GitHub App made beforehand: environment variable holding its private key")
    .option("--slack-app-name <name>", "Slack app name")
    .addOption(new Option("--slack-app-posted-messages <mode>", "answer mentions people post through other apps with their own Slack token").choices(["accept", "ignore"]))
    .addOption(new Option("--slack-install <state>", "whether the Slack app is installed, or waits for an admin's approval (default with --yes: installed)").choices(["installed", "approval"]))
    .option("--slack-bot-token-file <path>", "file holding the Slack Bot User OAuth Token")
    .option("--slack-bot-token-env <NAME>", "environment variable holding the Slack Bot User OAuth Token")
    .option("--slack-signing-secret-file <path>", "file holding the Slack signing secret")
    .option("--slack-signing-secret-env <NAME>", "environment variable holding the Slack signing secret")
    .option("--worker-image <digest-ref>", "worker image by digest; an agentx built from source needs it with --engine cdk when the tag has no published release.json")
    .option("--slack-image <digest-ref>", "Slack service image by digest; an agentx built from source needs it with --engine cdk when the tag has no published release.json")
    .option("--admin-email <email>", "Cognito: your email, for the AgentX admin user")
    .option("--repository <owner/name>", "the first project's repository")
    .option("--project-name <name>", "the first project's name (default: the repository's)")
    .option("--setup-command <command>", "the first project's setup command, or \"\" for none")
    .option("--test-command <command>", "the first project's test command, or \"\" for none")
    .option("--channel <name>", "the Slack channel for the first project")
    .option("--connectors <list>", "connectors to add now: comma-separated linear, jira, asana, or none")
    .option("--linear-key-file <path>", "file holding the Linear API key")
    .option("--linear-key-env <NAME>", "environment variable holding the Linear API key")
    .option("--linear-team <id or key>", "the Linear team the first project may use")
    .option("--jira-site <site>", "the <site> in <site>.atlassian.net")
    .option("--jira-project <key>", "the Jira project key")
    .option("--jira-token-file <path>", "file holding the Jira service account's API token")
    .option("--jira-token-env <NAME>", "environment variable holding the Jira service account's API token")
    .option("--asana-client-id <id>", "the Asana MCP app's Client ID")
    .option("--asana-client-secret-file <path>", "file holding the Asana app's Client secret")
    .option("--asana-client-secret-env <NAME>", "environment variable holding the Asana app's Client secret")
    .option("--asana-bot-email <email>", "the Asana bot user's email; a sign-in by any other account is refused")
    .option("--asana-project <gid>", "the Asana project's GID"),
  )
    .addOption(new Option(`${SIGNIN_FLAG_NAMES.methods} <method>`, "how developers sign in: Slack (default), your company's sign-in (oidc), or both").choices(["slack", "oidc", "both"]))
    // Checked in initOptions, not with .choices(): commander would exit the process on a bad value.
    .option("--stop-after <step>", "run the steps up to and including this one, then stop; agentx init again finishes (for automated tests)")
    .action(async (
      options: InitCommandOptions & { export?: string },
      command: Command,
    ) => {
      const globals = globalOptions(command);
      if (options.export !== undefined && options.stopAfter !== undefined) throw agentXError("CONFIG_INVALID", "--stop-after cannot be used with --export, which runs no init step; drop one of them");
      if (options.export === undefined) {
        const result = await runInit(initOptions(globals, options, command), dependencies.init ?? {}, { stderr: services.stderr, home });
        if (globals.json) {
          // pageMode is the CLI's own note that the page already told the person; not part of the result.
          // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to drop the key
          const { pageMode: _pageMode, ...printed } = result;
          services.stdout.write(formatSuccess(printed, true));
          return;
        }
        if (result.pageMode === true) return;
        if (result.status === "waiting") {
          services.stdout.write(`${result.message}\n`);
          return;
        }
        if (result.stoppedAfter !== undefined) {
          services.stdout.write(`Stopped after the ${result.stoppedAfter} step, as --stop-after asked. Run agentx init --env ${result.env} --region ${options.region ?? "<region>"} again to finish.\n`);
          return;
        }
        services.stdout.write(`${result.ready ?? `AgentX environment ${result.env} is deployed. Control plane: ${result.controlPlaneUrl ?? "unknown"}`}\n`);
        return;
      }
      // --env defaults to production (the live, legacy-adopted deployment): --export must never
      // silently write a bundle for it just because --env was left off.
      if (command.getOptionValueSourceWithGlobals("env") !== "cli") {
        throw agentXError("CONFIG_INVALID", "agentx init --export requires an explicit --env (the default, production, is the live environment)");
      }
      if (options.region === undefined) throw agentXError("CONFIG_INVALID", "--region is required with --export");
      if (options.release === undefined) throw agentXError("CONFIG_INVALID", "--release is required with --export");
      if (options.openrouterKeyFile !== undefined || options.openrouterKeyEnv !== undefined) {
        throw agentXError("CONFIG_INVALID", "--export stores no secret, so it takes no OpenRouter key; create the secret yourself and pass --openrouter-secret-arn");
      }
      const exportProvider = (component?: string) => component ?? options.modelProvider;
      const result = await runInitExport(
        {
          env: globals.env,
          dir: options.export,
          region: options.region,
          releaseDir: options.release,
          identity: options.identity,
          orchestratorModel: options.orchestratorModel,
          classifierModel: options.classifierModel,
          workerModel: options.workerModel,
          ...(exportProvider(options.orchestratorProvider) ? { orchestratorProvider: exportProvider(options.orchestratorProvider) } : {}),
          ...(exportProvider(options.classifierProvider) ? { classifierProvider: exportProvider(options.classifierProvider) } : {}),
          ...(exportProvider(options.workerProvider) ? { workerProvider: exportProvider(options.workerProvider) } : {}),
          ...(options.openrouterSecretArn ? { openrouterSecretArn: options.openrouterSecretArn } : {}),
          ...(options.openrouterProviders ? { openrouterProviders: options.openrouterProviders } : {}),
          ...(options.account === undefined ? {} : { account: options.account }),
          ...(options.oidcIssuer === undefined ? {} : { oidcIssuer: options.oidcIssuer }),
          ...(options.oidcAudience === undefined ? {} : { oidcAudience: options.oidcAudience }),
          ...(options.oidcClientId === undefined ? {} : { oidcClientId: options.oidcClientId }),
          ...(options.adminClaim === undefined ? {} : { adminClaim: options.adminClaim }),
          ...(options.adminValues === undefined ? {} : { adminValues: options.adminValues }),
          ...(options.permissionBoundary === undefined ? {} : { permissionsBoundaryArn: options.permissionBoundary }),
          ...(options.operatorPrincipal === undefined ? {} : { operatorPrincipalArn: options.operatorPrincipal }),
        },
        dependencies.deploy ?? {},
      );
      services.stdout.write(
        globals.json
          ? formatSuccess(result, true)
          : `Wrote export bundle to ${result.dir}\nNext: have your platform team run ${result.dir}/deploy-access.sh (see ${result.dir}/README.md) with their own AWS credentials to deploy the access stack.\n`,
      );
    });

  /** R24 and spec 025 A14: this computer's unexpired admin sign-in for the developer's environment. Never refreshed (Q4). */
  const adminSession = async (env: string | undefined): Promise<AdminSession | undefined> => {
    let name: string;
    try {
      name = (await resolveDeveloperEnvironment(home, env)).env;
    } catch {
      return undefined;
    }
    return adminSessionFor(name);
  };
  const adminSignedIn = async (env: string | undefined): Promise<boolean> => (await adminSession(env)) !== undefined;

  const mcp = program
    .command("mcp")
    .description("run the AgentX MCP server for your AI tool (stdio); add it with agentx mcp install")
    .action(async (_options: unknown, command: Command) => {
      // FR-026: stdout carries only MCP messages, so everything else this command says goes to stderr.
      const env = developerEnv(command);
      const shutdown = new AbortController();
      const stop = () => shutdown.abort();
      process.once("SIGTERM", stop);
      process.once("SIGINT", stop);
      try {
        await runMcpServer({
          ...developerSession(),
          ...(env === undefined ? {} : { env }),
          adminSignedIn,
          adminSession,
          stdin: dependencies.stdin ?? process.stdin,
          stdout: (dependencies.stdout ?? process.stdout) as Writable,
          stderr: services.stderr,
          shutdown: shutdown.signal,
          ...(dependencies.mcpClock === undefined ? {} : { clock: dependencies.mcpClock }),
        });
      } finally {
        process.off("SIGTERM", stop);
        process.off("SIGINT", stop);
      }
    });

  mcp
    .command("install")
    .description("add the AgentX MCP server to Claude Code, Codex or Cursor")
    .addOption(new Option("--client <client>", "the AI tool").choices([...MCP_CLIENTS]).makeOptionMandatory())
    .option("--print", "only print the entry; change nothing", false)
    .action(async (options: { client: McpClientKind; print: boolean }, command: Command) => {
      const env = developerEnv(command);
      services.stdout.write(await installMcp(options.client, { print: options.print, ...(env === undefined ? {} : { env }) }, { home, codexHome: dependencies.codexHome ?? codexHomeFromEnvironment(), run: dependencies.runCommand ?? runCommand, version: RELEASE_VERSION }));
    });

  return program;
}

/** Codex's own settings folder override; an empty CODEX_HOME counts as unset. */
function codexHomeFromEnvironment(): string | undefined {
  const value = process.env.CODEX_HOME;
  return value === undefined || value === "" ? undefined : value;
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

interface InitCommandOptions extends SignInCommandOptions {
  region?: string; account?: string; release?: string; engine?: "templates" | "cdk"; source?: string;
  resume: boolean; yes: boolean; browser: boolean; fromBundle?: string; stopAfter?: string;
  /** --ui / --no-ui. Undefined when neither was given (resolveUiMode decides). */
  ui?: boolean;
  identity: "cognito" | "oidc"; oidcIssuer?: string; oidcAudience?: string; oidcClientId?: string; adminClaim?: string; adminValues?: string;
  modelProvider?: string; orchestratorProvider?: string; classifierProvider?: string; workerProvider?: string; openrouterSecretArn?: string; openrouterProviders?: string;
  openrouterKeyFile?: string; openrouterKeyEnv?: string;
  permissionBoundary?: string; operatorPrincipal?: string; orchestratorModel: string; classifierModel: string; workerModel: string;
  alertEmail?: string; alertWebhookFile?: string; alertWebhookEnv?: string; alerts: boolean;
  budget?: string; budgetScope?: "tag" | "account";
  githubAccount?: string; githubAccountType?: "organization" | "user"; githubAppName?: string;
  githubAppId?: string; githubInstallationId?: string; githubPrivateKeyFile?: string; githubPrivateKeyEnv?: string;
  slackAppName?: string; slackAppPostedMessages?: "accept" | "ignore"; slackInstall?: "installed" | "approval";
  slackBotTokenFile?: string; slackBotTokenEnv?: string; slackSigningSecretFile?: string; slackSigningSecretEnv?: string;
  workerImage?: string; slackImage?: string;
  /** --signin: which developer sign-in methods agentx init's developer-signin step enables. */
  signin?: "slack" | "oidc" | "both";
  adminEmail?: string; repository?: string; projectName?: string; setupCommand?: string; testCommand?: string; channel?: string; connectors?: string;
  linearKeyFile?: string; linearKeyEnv?: string; linearTeam?: string;
  jiraSite?: string; jiraProject?: string; jiraTokenFile?: string; jiraTokenEnv?: string;
  asanaClientId?: string; asanaClientSecretFile?: string; asanaClientSecretEnv?: string; asanaBotEmail?: string; asanaProject?: string;
}

/** `agentx init`'s options, built from only what was typed: a commander default (the models,
 * --identity, --no-alerts's true) must never silently answer a question init would otherwise ask. */
function initOptions(globals: GlobalOptions, options: InitCommandOptions, command: Command): InitOptions {
  const { env } = globals;
  const { stopAfter } = options;
  if (stopAfter !== undefined && !isInitStepId(stopAfter)) {
    throw agentXError("CONFIG_INVALID", `--stop-after ${JSON.stringify(stopAfter)} names no init step; use one of: ${INIT_STEP_IDS.join(", ")}`);
  }
  // A --connectors typo fails here, before anything is asked or deployed.
  if (options.connectors !== undefined) parseConnectorsFlag(options.connectors);
  const finishFlags = definedEntries<FinishFlags>({
    adminEmail: options.adminEmail, repository: options.repository, projectName: options.projectName,
    setupCommand: options.setupCommand, testCommand: options.testCommand, channel: options.channel,
    // Under --yes, no --connectors means none: an unattended run never starts a connector's questions.
    connectors: options.connectors ?? (options.yes ? "none" : undefined),
    linearKey: secretSource(options.linearKeyFile, options.linearKeyEnv), linearTeam: options.linearTeam,
    jiraSite: options.jiraSite, jiraProject: options.jiraProject, jiraToken: secretSource(options.jiraTokenFile, options.jiraTokenEnv),
    asanaClientId: options.asanaClientId, asanaClientSecret: secretSource(options.asanaClientSecretFile, options.asanaClientSecretEnv),
    asanaBotEmail: options.asanaBotEmail, asanaProject: options.asanaProject,
  });
  const typed = <T>(name: string, value: T): T | undefined => (command.getOptionValueSource(name) === "cli" ? value : undefined);
  const flags = definedEntries<InitFlags>({
    engine: options.engine,
    identity: typed("identity", options.identity),
    oidcIssuer: options.oidcIssuer, oidcAudience: options.oidcAudience, oidcClientId: options.oidcClientId,
    adminClaim: options.adminClaim, adminValues: options.adminValues,
    orchestratorModel: typed("orchestratorModel", options.orchestratorModel),
    classifierModel: typed("classifierModel", options.classifierModel),
    workerModel: typed("workerModel", options.workerModel),
    modelProvider: options.modelProvider,
    orchestratorProvider: options.orchestratorProvider, classifierProvider: options.classifierProvider, workerProvider: options.workerProvider,
    openrouterSecretArn: options.openrouterSecretArn, openrouterProviders: options.openrouterProviders,
    openrouterKey: secretSource(options.openrouterKeyFile, options.openrouterKeyEnv),
    permissionBoundary: options.permissionBoundary, operatorPrincipal: options.operatorPrincipal,
    alertEmail: options.alertEmail,
    alertWebhook: secretSource(options.alertWebhookFile, options.alertWebhookEnv),
    alerts: typed("alerts", options.alerts),
    budget: options.budget, budgetScope: options.budgetScope,
    githubAccount: options.githubAccount, githubAccountType: options.githubAccountType, githubAppName: options.githubAppName,
    slackAppName: options.slackAppName, slackAppPostedMessages: options.slackAppPostedMessages,
    workerImage: options.workerImage, slackImage: options.slackImage,
  });
  const keySource = secretSource(options.githubPrivateKeyFile, options.githubPrivateKeyEnv);
  const { githubAppId: appId, githubInstallationId: installationId } = options;
  const preMadeGiven = appId !== undefined || installationId !== undefined;
  if (preMadeGiven && (appId === undefined || installationId === undefined || keySource === undefined)) {
    throw agentXError("CONFIG_INVALID", "--github-app-id, --github-installation-id and --github-private-key-file (or --github-private-key-env) go together");
  }
  const signin = signInFlags(options);
  const secretFlags = definedEntries<SecretFlags>({
    slackBotToken: secretSource(options.slackBotTokenFile, options.slackBotTokenEnv),
    slackSigningSecret: secretSource(options.slackSigningSecretFile, options.slackSigningSecretEnv),
    githubPrivateKey: keySource,
    slackClientSecret: signin.secretFlags.slackClientSecret,
    oidcClientSecret: signin.secretFlags.oidcClientSecret,
  });
  return {
    env,
    ...(options.region === undefined ? {} : { region: options.region }),
    ...(options.account === undefined ? {} : { account: options.account }),
    ...(options.release === undefined ? {} : { releaseDir: options.release }),
    ...(options.source === undefined ? {} : { source: options.source }),
    ...(options.fromBundle === undefined ? {} : { fromBundle: options.fromBundle }),
    yes: options.yes, browser: options.browser, resume: options.resume,
    ...(options.ui === undefined ? {} : { ui: options.ui }),
    flags,
    secretFlags,
    signinFlags: definedEntries<SigninFlags>({ methods: options.signin, ...signin.flags }),
    ...(appId === undefined || installationId === undefined ? {} : { preMadeGitHubApp: { appId, installationId } }),
    ...(options.slackInstall === undefined ? {} : { slackInstall: options.slackInstall }),
    finishFlags,
    configDir: globals.configDir,
    ...(stopAfter === undefined ? {} : { stopAfter }),
  };
}

function isInitStepId(value: string): value is InitStepId {
  return (INIT_STEP_IDS as readonly string[]).includes(value);
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
