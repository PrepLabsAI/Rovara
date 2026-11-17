// The `agentx signin` command group (spec 025 FR-045, FR-046) and the developer sign-in flags that
// agentx init shares (F14), kept out of main.ts. Builds real AWS and Slack clients only when a test
// has not overridden them.
import { agentXError } from "@agentx/contracts";
import { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { STSClient } from "@aws-sdk/client-sts";
import type { Command } from "commander";
import { stsCallerIdentity } from "../environments/adopt.js";
import type { ParameterStore } from "../environments/parameter-store.js";
import { secretsManagerInitSecrets } from "../init/context.js";
import { processPrompter, unattendedPrompter, type SecretSource, type TextWriter } from "../init/prompts.js";
import { slackWebApi } from "../init/slack-app.js";
import { formatSuccess } from "../output.js";
import { checkLines } from "./check.js";
import { SIGNIN_FLAG_NAMES, type SigninFlags, type SigninSecretFlags } from "./collect.js";
import { runSigninCheck, runSigninDisable, runSigninEnable, runSigninShow, type SigninServices } from "./commands.js";

/** Keeps only the entries that have a value, so an optional property is absent rather than undefined. */
export function definedEntries<T extends object>(record: { [K in keyof T]: T[K] | undefined }): T {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T;
}

/** A secret's source from its `-file` and `-env` flags; undefined when neither was given (the prompt asks). */
export function secretSource(file?: string, envName?: string): SecretSource | undefined {
  return file === undefined && envName === undefined ? undefined : { ...(file === undefined ? {} : { file }), ...(envName === undefined ? {} : { envName }) };
}

/** The developer sign-in flags, as commander names them from SIGNIN_FLAG_NAMES. */
export interface SignInCommandOptions {
  slackClientId?: string; slackClientSecretFile?: string; slackClientSecretEnv?: string;
  signinOidcIssuer?: string; signinOidcClientId?: string; signinOidcClientSecretFile?: string; signinOidcClientSecretEnv?: string;
  signinOidcRequiredClaim?: string; signinOidcRequiredValues?: string; signinOidcDisplayName?: string;
}

/** Adds the developer sign-in flags (F14): the same names on agentx signin enable and agentx init. */
export function addSignInOptions(command: Command): Command {
  const names = SIGNIN_FLAG_NAMES;
  return command
    .option(`${names.slackClientId} <id>`, "the Slack app's Client ID (Basic Information, App Credentials)")
    .option(`${names.slackClientSecret}-file <path>`, "file holding the Slack app's Client Secret")
    .option(`${names.slackClientSecret}-env <NAME>`, "environment variable holding the Slack app's Client Secret")
    .option(`${names.oidcIssuer} <url>`, "company sign-in issuer URL, for example https://acme.okta.com")
    .option(`${names.oidcClientId} <id>`, "client ID of the company sign-in app")
    .option(`${names.oidcClientSecret}-file <path>`, "file holding the company sign-in app's client secret")
    .option(`${names.oidcClientSecret}-env <NAME>`, "environment variable holding the company sign-in app's client secret")
    .option(`${names.oidcRequiredClaim} <claim>`, "claim a person must carry to use AgentX, for example groups; empty for none")
    .option(`${names.oidcRequiredValues} <values>`, "comma-separated values of the required claim that may use AgentX")
    .option(`${names.oidcDisplayName} <name>`, "name on the sign-in button, for example Okta");
}

export function signInFlags(options: SignInCommandOptions): { flags: SigninFlags; secretFlags: SigninSecretFlags } {
  return {
    flags: definedEntries<SigninFlags>({
      slackClientId: options.slackClientId, oidcIssuer: options.signinOidcIssuer, oidcClientId: options.signinOidcClientId,
      oidcRequiredClaim: options.signinOidcRequiredClaim, oidcRequiredValues: options.signinOidcRequiredValues, oidcDisplayName: options.signinOidcDisplayName,
    }),
    secretFlags: definedEntries<SigninSecretFlags>({
      slackClientSecret: secretSource(options.slackClientSecretFile, options.slackClientSecretEnv),
      oidcClientSecret: secretSource(options.signinOidcClientSecretFile, options.signinOidcClientSecretEnv),
    }),
  };
}

export interface SigninCommandContext {
  /** Test overrides (CliDependencies.signin). */
  overrides?: Partial<SigninServices>;
  /** The CLI's region-scoped SSM store. */
  parameterStore: (region?: string) => ParameterStore;
  fetch: typeof fetch;
  stdout: TextWriter;
  stderr: TextWriter;
}

const globalOptions = (command: Command) => command.optsWithGlobals<{ env: string; json: boolean }>();

export function registerSigninCommands(program: Command, context: SigninCommandContext): void {
  const signin = program.command("signin").description("choose how developers sign in: Slack, your company's sign-in, or both (operator role)");
  /** Real AWS and Slack clients for --region, each built only when a test has not overridden it. */
  const signinServices = (region: string | undefined, yes: boolean): SigninServices => {
    const overrides = context.overrides ?? {};
    const config = region === undefined ? {} : { region };
    return {
      store: overrides.store ?? context.parameterStore(region),
      secrets: overrides.secrets ?? secretsManagerInitSecrets(new SecretsManagerClient(config)),
      cloudFormation: overrides.cloudFormation ?? new CloudFormationClient(config),
      identity: overrides.identity ?? stsCallerIdentity(new STSClient(config)),
      fetch: overrides.fetch ?? context.fetch,
      slackApi: overrides.slackApi ?? slackWebApi(context.fetch),
      prompter: overrides.prompter ?? (yes ? unattendedPrompter() : processPrompter(context.stderr)),
      processEnv: overrides.processEnv ?? process.env,
      write: overrides.write ?? ((line) => { context.stderr.write(`${line}\n`); }),
      now: overrides.now ?? Date.now,
      ...(overrides.sleep === undefined ? {} : { sleep: overrides.sleep }),
      ...(overrides.pollMs === undefined ? {} : { pollMs: overrides.pollMs }),
    };
  };
  const signinMethod = (method: string): "slack" | "oidc" => {
    if (method !== "slack" && method !== "oidc") throw agentXError("CONFIG_INVALID", `unknown sign-in method ${JSON.stringify(method)}; use slack or oidc`);
    return method;
  };
  const changedText = (changed: boolean) => (changed ? "Developer sign-in updated.\n" : "Nothing to change.\n");
  const regionOption = "--region <region>";
  const regionHelp = "AWS region of the environment; defaults to your AWS configuration";
  signin
    .command("show")
    .description("show which sign-in methods are on and what the control plane offers")
    .option(regionOption, regionHelp)
    .action(async (options: { region?: string }, command: Command) => {
      const globals = globalOptions(command);
      const result = await runSigninShow(signinServices(options.region, false), globals.env);
      context.stdout.write(globals.json ? formatSuccess(result.data, true) : `${result.lines.join("\n")}\n`);
    });
  addSignInOptions(
    signin
      .command("enable")
      .description("turn on Slack sign-in or company sign-in; shows the change to the control plane and asks first")
      .argument("<method>", "slack or oidc")
      .option(regionOption, regionHelp)
      .option("--yes", "apply without asking; the change is still printed", false),
  ).action(async (method: string, options: SignInCommandOptions & { region?: string; yes: boolean }, command: Command) => {
    const globals = globalOptions(command);
    const { flags, secretFlags } = signInFlags(options);
    const result = await runSigninEnable(signinServices(options.region, options.yes), globals.env, signinMethod(method), flags, secretFlags, options.yes);
    context.stdout.write(globals.json ? formatSuccess(result, true) : changedText(result.changed));
  });
  signin
    .command("disable")
    .description("turn a sign-in method off; everyone signed in with it is signed out")
    .argument("<method>", "slack or oidc")
    .option(regionOption, regionHelp)
    .option("--yes", "apply without asking; the change is still printed", false)
    .action(async (method: string, options: { region?: string; yes: boolean }, command: Command) => {
      const globals = globalOptions(command);
      const result = await runSigninDisable(signinServices(options.region, options.yes), globals.env, signinMethod(method), options.yes);
      context.stdout.write(globals.json ? formatSuccess(result, true) : changedText(result.changed));
    });
  signin
    .command("check")
    .description("check every piece developer sign-in needs, and say what to fix")
    .option(regionOption, regionHelp)
    .action(async (options: { region?: string }, command: Command) => {
      const globals = globalOptions(command);
      const checks = await runSigninCheck(signinServices(options.region, false), globals.env);
      context.stdout.write(globals.json ? formatSuccess(checks, true) : `${checkLines(checks).join("\n")}\n`);
      const failed = checks.filter((check) => !check.ok).length;
      if (failed > 0) throw agentXError("CONFIG_INVALID", `${failed} developer sign-in check${failed === 1 ? "" : "s"} failed; fix what each one names, then run agentx signin check again`);
    });
}
