#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
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
import { cancelWorkspaceTask } from "./admin/cancel.js";
import { exportTurns, parseSince } from "./admin/turns.js";
import { loginWithPkce, openSystemBrowser, tokenStoreKey } from "./auth.js";
import { loadProjectConfig } from "./config.js";
import { developerLogout, fetchDeveloperProjects, logoutText, whoamiText } from "./developer/commands.js";
import { developerLogin } from "./developer/login.js";
import { loadDeploymentSettings, type DeploymentSettings } from "./deployment.js";
import { resumeCommand, runDeploy, runInitExport, type DeployCliDependencies, type DeployCommandOptions } from "./deploy/commands.js";
import { cloudFormationStackReader, stsCallerIdentity, type CallerIdentity, type StackReader } from "./environments/adopt.js";
import { resolveDeploymentFile } from "./environments/cache.js";
import { DEFAULT_CLASSIFIER_MODEL, DEFAULT_ORCHESTRATOR_MODEL, DEFAULT_WORKER_MODEL, type InitFlags } from "./init/answers.js";
import { runInit, type InitCliDependencies, type InitOptions } from "./init/commands.js";
import type { SecretFlags } from "./init/context.js";
import { runEnvAdopt, runEnvList, runEnvUse } from "./environments/commands.js";
import { ssmParameterStore, type ParameterStore } from "./environments/parameter-store.js";
import { settingsParameterName } from "./environments/settings.js";
import { formatError, formatSuccess } from "./output.js";
import { addSignInOptions, definedEntries, registerSigninCommands, secretSource, signInFlags, type SignInCommandOptions } from "./signin/cli.js";
import { SIGNIN_FLAG_NAMES, type SigninFlags } from "./signin/collect.js";
import type { SigninServices } from "./signin/commands.js";
import { SystemCredentialTokenStore, type TokenStore } from "./token-store.js";
import { CLI_VERSION } from "./version.js";

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

  registerSigninCommands(program, {
    ...(dependencies.signin === undefined ? {} : { overrides: dependencies.signin }),
    parameterStore, fetch: services.fetchImplementation, stdout: services.stdout, stderr: services.stderr,
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
      services.stdout.write(formatSuccess(result, globals.json));
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
    .option("--release <dir>", "release directory (agentx release build output); default: download the release matching this agentx")
    .addOption(new Option("--engine <engine>", "deploy engine: published CloudFormation templates, or cdk from a source checkout").choices(["templates", "cdk"]))
    .option("--source <dir>", "git checkout of the release's source tag; required for --engine cdk")
    .option("--resume", "only continue an install already under way; never start a new one", false)
    .option("--yes", "answer every question with its default or its flag, without asking; the plan is still printed. Confirmations such as the Slack bot and workspace check and \"Request URL Verified?\" are answered yes, so check the printed summary afterwards", false)
    .option("--no-browser", "print every address to open instead of opening a browser")
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
    .option("--worker-image <digest-ref>", "worker image by digest (testing only)")
    .option("--slack-image <digest-ref>", "Slack service image by digest (testing only)"),
  )
    .addOption(new Option(`${SIGNIN_FLAG_NAMES.methods} <method>`, "how developers sign in: Slack (default), your company's sign-in (oidc), or both").choices(["slack", "oidc", "both"]))
    .action(async (
      options: InitCommandOptions & { export?: string },
      command: Command,
    ) => {
      const globals = globalOptions(command);
      if (options.export === undefined) {
        const result = await runInit(initOptions(globals.env, options, command), dependencies.init ?? {}, { stderr: services.stderr, home });
        if (globals.json) {
          services.stdout.write(formatSuccess(result, true));
          return;
        }
        if (result.status === "waiting") {
          services.stdout.write(`${result.message}\n`);
          return;
        }
        services.stdout.write(`AgentX environment ${result.env} is deployed. Control plane: ${result.controlPlaneUrl ?? "unknown"}\n${result.nextSteps ?? ""}\n`);
        return;
      }
      // --env defaults to production (the live, legacy-adopted deployment): --export must never
      // silently write a bundle for it just because --env was left off.
      if (command.getOptionValueSourceWithGlobals("env") !== "cli") {
        throw agentXError("CONFIG_INVALID", "agentx init --export requires an explicit --env (the default, production, is the live environment)");
      }
      if (globals.env === DEFAULT_ENVIRONMENT) {
        throw agentXError("CONFIG_INVALID", `--env ${DEFAULT_ENVIRONMENT} belongs to the legacy deployment that predates environments; choose a different --env for the export bundle`);
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
  resume: boolean; yes: boolean; browser: boolean;
  identity: "cognito" | "oidc"; oidcIssuer?: string; oidcAudience?: string; oidcClientId?: string; adminClaim?: string; adminValues?: string;
  modelProvider?: string; orchestratorProvider?: string; classifierProvider?: string; workerProvider?: string; openrouterSecretArn?: string; openrouterProviders?: string;
  openrouterKeyFile?: string; openrouterKeyEnv?: string;
  permissionBoundary?: string; operatorPrincipal?: string; orchestratorModel: string; classifierModel: string; workerModel: string;
  alertEmail?: string; alertWebhookFile?: string; alertWebhookEnv?: string; alerts: boolean;
  githubAccount?: string; githubAccountType?: "organization" | "user"; githubAppName?: string;
  githubAppId?: string; githubInstallationId?: string; githubPrivateKeyFile?: string; githubPrivateKeyEnv?: string;
  slackAppName?: string; slackAppPostedMessages?: "accept" | "ignore"; slackInstall?: "installed" | "approval";
  slackBotTokenFile?: string; slackBotTokenEnv?: string; slackSigningSecretFile?: string; slackSigningSecretEnv?: string;
  workerImage?: string; slackImage?: string;
  /** --signin: which developer sign-in methods agentx init's developer-signin step enables. */
  signin?: "slack" | "oidc" | "both";
}

/** `agentx init`'s options, built from only what was typed: a commander default (the models,
 * --identity, --no-alerts's true) must never silently answer a question init would otherwise ask. */
function initOptions(env: string, options: InitCommandOptions, command: Command): InitOptions {
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
    yes: options.yes, browser: options.browser, resume: options.resume,
    flags,
    secretFlags,
    signinFlags: definedEntries<SigninFlags>({ methods: options.signin, ...signin.flags }),
    ...(appId === undefined || installationId === undefined ? {} : { preMadeGitHubApp: { appId, installationId } }),
    ...(options.slackInstall === undefined ? {} : { slackInstall: options.slackInstall }),
  };
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
