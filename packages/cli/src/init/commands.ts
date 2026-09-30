// agentx init (FR-015 to FR-020): find the release and region, read any install already under way,
// ask and check and confirm on a first run, then run the steps. Every AWS, GitHub, Slack, browser
// and clock dependency is overridable through InitCliDependencies (main.ts's CliDependencies.init).
import { BudgetsClient } from "@aws-sdk/client-budgets";
import { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SNSClient } from "@aws-sdk/client-sns";
import { SSMClient } from "@aws-sdk/client-ssm";
import { STSClient } from "@aws-sdk/client-sts";
import { agentXError, environmentOperatorRoleName, environmentStackName } from "@agentx/contracts";
import { authorizeCredential, secretsManagerAuthorizeSecrets } from "../admin/authorize.js";
import { loginWithPkce, openSystemBrowser } from "../auth.js";
import { cliErrorFor, cloudFormationOutputsReader, prepareDeployment, realCommandRunner, type DeployCliDependencies, type PreparedDeployment, type Writer } from "../deploy/commands.js";
import { readBundleAnswers, type BundleAnswers } from "../deploy/export-bundle.js";
import { assertReleaseCoversRegion, loadRelease } from "../deploy/release.js";
import { stsCallerIdentity } from "../environments/adopt.js";
import type { LockRecord } from "../environments/lock.js";
import { ssmParameterStore, type ParameterStore } from "../environments/parameter-store.js";
import { readEnvironmentSettings } from "../environments/settings.js";
import { openAdminSession } from "../setup/admin-session.js";
import { awsAlertsApi } from "../setup/alerts.js";
import { slackChannelApi } from "../setup/channel-add.js";
import { vendorApi } from "../setup/connectors/vendors.js";
import { githubRepositoryApi } from "../setup/project-files.js";
import { cognitoAdmin, type SetupServices } from "../setup/services.js";
import type { SigninFlags } from "../signin/collect.js";
import { SystemCredentialTokenStore, type TokenStore } from "../token-store.js";
import { isPrereleaseVersion, RELEASE_VERSION } from "../version.js";
import {
  assertResumeFlagsMatch, checkAlertWebhook, collectInitAnswers, openRouterSecretName, persistInitAnswers, readOpenRouterKeyAnswer, storeAlertWebhook,
  webhookDisplay, webhookFlagDisplay, type CollectedAnswers, type InitFlags,
} from "./answers.js";
import {
  cloudFormationStatusReader, secretsManagerInitSecrets, type FinishFlags, type InitContext, type InitSecrets, type PreMadeGitHubApp, type SecretFlags, type StackStatusReader,
} from "./context.js";
import { deployStep } from "./deploy-steps.js";
import { finishSteps, readSettingsOrThrow, readyText } from "./finish-steps.js";
import { githubAppStep, githubRestApi, type GitHubApi } from "./github-app.js";
import { listAwsProfiles, pickAwsProfile, resolveCaller } from "./aws-account.js";
import { emptyProgress, readInstallAnswers, readInstallProgress, writeInstallProgress, type InitAnswers, type InitStepId } from "./install-state.js";
import { confirmInstallPlan } from "./plan.js";
import { awsPrerequisiteChecks, checkPrerequisites, type PrerequisiteCheck, type PrerequisiteChecks } from "./prerequisites.js";
import { processPrompter, secretFromSource, unattendedPrompter, type Prompter } from "./prompts.js";
import { fetchRelease } from "./release-fetch.js";
import { problemText, retryOnPage } from "./retry.js";
import { developerSignInStep } from "./signin-step.js";
import { slackAppStep, slackWebApi, verifySlackUrls, type SlackApi } from "./slack-app.js";
import { runInitSteps, type InitEvent, type InitRunResult, type InitStep } from "./steps.js";
import { browserAvailable, NO_BROWSER_LINE, resolveUiMode } from "./ui-mode.js";
import { prerequisitesCard, readyCard } from "./ui/cards.js";
import { startInstallWizard, type InstallWizard } from "./ui/index.js";
import type { WizardResume } from "./ui/protocol.js";

export interface InitCliDependencies {
  /** identity, store, deployer, templatesClients, commandRunner: the same seam agentx deploy uses. */
  deploy?: DeployCliDependencies;
  initSecrets?: InitSecrets;
  prompter?: Prompter;
  checks?: PrerequisiteChecks;
  github?: GitHubApi;
  slack?: SlackApi;
  cloudFormation?: { send(command: unknown): Promise<unknown> };
  stackStatus?: StackStatusReader;
  fetch?: typeof fetch;
  /** May throw (no xdg-open, Windows): init reports it and carries on. Its result is ignored. */
  openBrowser?: (url: string) => Promise<unknown>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  processEnv?: NodeJS.ProcessEnv;
  /** Whether a person is at an interactive terminal (default: stdin is a TTY). */
  isInteractive?: () => boolean;
  /** Whether a browser opened here would show on this machine's screen (default: browserAvailable). */
  browserAvailable?: () => boolean;
  /** Overrides RELEASE_VERSION; null means a build from source. */
  releaseVersion?: string | null;
  /** Overrides how the run's deployment is built (tests: a cleanup that fails). */
  prepareDeployment?: typeof prepareDeployment;
  /** Overrides the finishing steps' services (phase 15d2); every field not given is the real one. */
  setup?: Partial<SetupServices>;
}

export interface InitOptions {
  env: string;
  region?: string;
  /** --account: only checked against the caller's own account. */
  account?: string;
  releaseDir?: string;
  source?: string;
  yes: boolean;
  browser: boolean;
  /** --ui / --no-ui. Undefined means neither was given: the page in an interactive terminal that
   * can open a browser, else the terminal (resolveUiMode). */
  ui?: boolean;
  resume: boolean;
  flags: InitFlags;
  secretFlags: SecretFlags;
  signinFlags?: SigninFlags;
  preMadeGitHubApp?: PreMadeGitHubApp;
  /** --slack-install: answers the Slack step's "is it installed?" question (for --yes). */
  slackInstall?: "installed" | "approval";
  /** The finishing steps' answers (--admin-email, --repository, --channel, --connectors, ...). */
  finishFlags: FinishFlags;
  /** The global --config-dir, where the first project's file is written. */
  configDir: string;
  /** --from-bundle: with --resume, an export bundle whose access stack a platform team deployed. */
  fromBundle?: string;
  /** --stop-after: run the steps up to and including this one, then stop (the release test). */
  stopAfter?: InitStepId;
}

/** `ready` is the message a finished install ends with (readyText). */
export type InitResult = InitRunResult & { env: string; resumed: boolean; controlPlaneUrl?: string; ready?: string; stoppedAfter?: InitStepId };

/** True when `callerArn` is a session of this environment's AgentX operator role (FR-019). */
export function isOperatorRole(callerArn: string, env: string): boolean {
  return new RegExp(`:assumed-role/${environmentOperatorRoleName(env)}/`).test(callerArn);
}

export const OPERATOR_ACCESS_REFUSAL =
  "the access stack needs admin rights, and you are using the AgentX operator role; ask your platform team to deploy it (agentx init --export, then deploy-access.sh), or run agentx init with admin credentials";

/** The note an `access` step deployed by a platform team from an export bundle is recorded with. */
export const PLATFORM_TEAM_ACCESS_NOTE = "deployed by your platform team from the export bundle";

/** The access stack's deploy step, refused up front under the operator role: the operator role
 * cannot create IAM roles, so the deploy would only fail later on IAM. */
function accessStep(): InitStep<InitContext> {
  const deploy = deployStep({ id: "access", title: "Deploy the access stack (IAM roles, artifact bucket, image cache)" });
  return {
    ...deploy,
    async run(context, progress) {
      if (isOperatorRole(context.holder, context.env)) throw agentXError("CONFIG_INVALID", OPERATOR_ACCESS_REFUSAL);
      return deploy.run(context, progress);
    },
  };
}

export function initSteps(input: { github: GitHubApi; slack: SlackApi }): InitStep<InitContext>[] {
  return [
    {
      id: "prerequisites",
      title: "Check prerequisites",
      async run(context) {
        if (!context.prerequisitesPassed) await context.runPrerequisites();
        return { status: "done" };
      },
    },
    accessStep(),
    deployStep({ id: "core", title: "Deploy the foundation and identity stacks" }),
    githubAppStep(input.github),
    deployStep({ id: "control-plane", title: "Deploy the control plane and runtime" }),
    slackAppStep(input.slack),
    deployStep({ id: "slack-service", title: "Deploy the Slack service", after: verifySlackUrls }),
    developerSignInStep({ slack: input.slack }),
    ...finishSteps(),
  ];
}

function eventLine(event: InitEvent): string {
  switch (event.kind) {
    case "step-skipped": return `already done: ${event.title}`;
    case "step-started": return `==> ${event.title}`;
    case "step-done": return `done: ${event.title}`;
    case "step-waiting": return `waiting: ${event.title}`;
  }
}

const realSleep = (ms: number) => new Promise<void>((resolvePromise) => setTimeout(resolvePromise, ms));

/** The real phase 15d2 services. Clients are only constructed here, never called, until a step
 * uses them, so a test that overrides them (InitCliDependencies.setup) reaches no AWS. */
export function realSetupServices(input: { region: string; fetch: typeof fetch; configDir: string; tokenStore?: TokenStore }): SetupServices {
  return {
    tokenStore: input.tokenStore ?? new SystemCredentialTokenStore(),
    cognito: cognitoAdmin(new CognitoIdentityProviderClient({ region: input.region })),
    login: loginWithPkce,
    fetch: input.fetch,
    // Task 6: both read the GitHub App's own secret (github-app.ts) or use the installation id and
    // token an earlier call obtained; input.fetch carries no credential itself.
    repositories: githubRepositoryApi(input.fetch),
    github: githubRestApi(input.fetch),
    // Task 7: the foundation's EC2 worker outputs, and where project files are written.
    stackOutputs: cloudFormationOutputsReader(new CloudFormationClient({ region: input.region })),
    configDir: input.configDir,
    // Task 8: both use the bot token read from agentx/<env>/slack, only in the authorization header.
    slackChannels: slackChannelApi(input.fetch),
    slackIdentity: async (token) => {
      const answer = await slackWebApi(input.fetch).authTest(token);
      if (answer.ok !== true || answer.team_id === undefined || answer.user_id === undefined) {
        throw agentXError("CONFIG_INVALID", "Slack refused the stored bot token; run agentx init again to store a new one");
      }
      return { teamId: answer.team_id, botUserId: answer.user_id };
    },
    // Task 9: the one real read each connector's test read needs, before it is saved.
    vendors: vendorApi(input.fetch),
    // Task 11: the bot's sign-in, with the connector secret read and written in the environment's region.
    authorize: authorizeCredential,
    authorizeSecrets: secretsManagerAuthorizeSecrets(new SecretsManagerClient({ region: input.region })),
    // Task 12: the topic and the test alarm are in the environment's region; AWS Budgets has one
    // endpoint, in us-east-1.
    alerts: awsAlertsApi({
      sns: new SNSClient({ region: input.region }), cloudWatch: new CloudWatchClient({ region: input.region }), budgets: new BudgetsClient({ region: "us-east-1" }),
    }),
  };
}

/** A browser that will not open (no xdg-open on CloudShell, SSH hosts and containers; Windows)
 * never stops init: the failure is reported once and the step carries on without it. */
function neverThrowingBrowser(open: (url: string) => Promise<unknown>, write: (line: string) => void): (url: string) => Promise<boolean> {
  return async (url) => {
    try {
      await open(url);
      return true;
    } catch {
      write("could not open a browser; open the address above (or pass --no-browser)");
      return false;
    }
  };
}

/** What `--ui` adds to a run: the wizard, once started, and the `write(line)` that tees every
 * progress line to both the terminal and the page's log pane. Held out here so the wizard is closed
 * with the run whichever way it ends (FR-002). */
interface InitSession {
  wizard?: InstallWizard;
  /** A property, not a method, so `init` can pass it on as `write` without rebinding it. */
  write: (line: string) => void;
}

export async function runInit(options: InitOptions, deps: InitCliDependencies, services: { stderr: Writer; home: string }): Promise<InitResult> {
  const session: InitSession = {
    write: (line) => { services.stderr.write(`${line}\n`); session.wizard?.log(line); },
  };
  try {
    const result = await init(options, deps, services, session);
    // A finished run ends the page on the same summary the terminal ends on: where to talk to
    // AgentX, the developer sign-in command, and the day-2 commands (readyText).
    session.wizard?.finish(result.status !== "complete" ? result.message
      : result.stoppedAfter !== undefined ? `Stopped after the ${result.stoppedAfter} step, as --stop-after asked.`
        : result.ready ?? `AgentX environment ${result.env} is installed.`);
    return result;
  } catch (error) {
    const mapped = cliErrorFor(error);
    session.wizard?.finish(mapped instanceof Error ? mapped.message : String(mapped), "failed");
    throw mapped;
  } finally {
    await session.wizard?.close();
  }
}

/** FR-006: the resume screen's two facts, from the progress `readInstallProgress` already keeps --
 * the steps recorded done, and the first one this run will pick up at. No new state is stored. */
async function resumeScreen(store: ParameterStore, env: string, steps: ReadonlyArray<InitStep<InitContext>>): Promise<WizardResume> {
  const progress = await readInstallProgress(store, env);
  const done = new Set(Object.entries(progress?.steps ?? {}).filter(([, record]) => record?.status === "done").map(([id]) => id));
  const next = steps.find((step) => !done.has(step.id));
  return {
    completed: steps.filter((step) => done.has(step.id)).map((step) => step.title),
    ...(next === undefined ? {} : { continueFrom: next.title }),
  };
}

/** Answers "is the Slack app installed?" from --slack-install; every other question goes to `inner`. */
function answeringSlackInstall(inner: Prompter, answer: "installed" | "approval"): Prompter {
  return {
    ask: (question, options) => inner.ask(question, options),
    confirm: (question, options) => inner.confirm(question, options),
    secret: (question, options) => inner.secret(question, options),
    async choose<T extends string>(question: string, choices: ReadonlyArray<{ value: T; label: string }>, options: { flag: string; defaultValue: T; unattendedRefusal?: string }): Promise<T> {
      const match = options.flag === "--slack-install" ? choices.find((choice) => choice.value === answer) : undefined;
      return match === undefined ? inner.choose(question, choices, options) : match.value;
    },
  };
}

/** On a resume, --alert-webhook-file or --alert-webhook-env replaces the stored address (a rotated
 * integration key); without either, the stored secret is kept. The host must stay the same: it is
 * part of the answers already shown in the plan. */
async function resumedAlertWebhook(input: { answers: InitAnswers; flags: InitFlags; processEnv: NodeJS.ProcessEnv; prompter: Prompter }): Promise<string | undefined> {
  const source = input.flags.alertWebhook;
  const { alert } = input.answers;
  // assertResumeFlagsMatch already refused a webhook flag on an install without a webhook.
  if (source === undefined || alert.kind !== "webhook") return undefined;
  const address = checkAlertWebhook(await secretFromSource({ what: "alert webhook address", flag: "--alert-webhook", source, processEnv: input.processEnv, prompter: input.prompter }));
  const display = webhookDisplay(address);
  if (display !== alert.display) {
    throw agentXError(
      "CONFIG_INVALID",
      `${webhookFlagDisplay(source)} (${display}) differs from what this install started with (${alert.display}); an install's answers cannot change halfway. Give an address on the same host, or run agentx init without that flag to keep the stored one`,
    );
  }
  return address;
}

/** On a resume, --openrouter-key-file or --openrouter-key-env replaces the key init stored (a
 * rotated key), so rerunning the same unattended command works; assertResumeFlagsMatch already
 * refused either flag on an install whose key is not in openRouterSecretName(env). */
async function resumedOpenRouterKey(input: { flags: InitFlags; processEnv: NodeJS.ProcessEnv; prompter: Prompter }): Promise<string | undefined> {
  if (input.flags.openrouterKey === undefined) return undefined;
  return readOpenRouterKeyAnswer({ source: input.flags.openrouterKey, processEnv: input.processEnv, prompter: input.prompter });
}

/** A bundle resume goes on only in the bundle's own account and release, once the platform team's
 * access stack exists and finished. */
async function assertBundleResumable(input: { bundle: BundleAnswers; bundleDir: string; account: string; releaseVersion: string; stackStatus: StackStatusReader }): Promise<void> {
  const { bundle } = input;
  if (bundle.account !== input.account) throw agentXError("CONFIG_INVALID", `the bundle is for account ${bundle.account}, but your AWS credentials are for account ${input.account}`);
  if (bundle.releaseVersion !== input.releaseVersion) {
    throw agentXError("CONFIG_INVALID", `the bundle is for release ${bundle.releaseVersion}; run npx @charterarc/agentx@${bundle.releaseVersion} init --resume --from-bundle ${input.bundleDir}`);
  }
  const accessStack = environmentStackName(bundle.env, "access");
  const status = await input.stackStatus.status(accessStack);
  if (status === undefined || !status.endsWith("_COMPLETE") || status.startsWith("ROLLBACK") || status.startsWith("DELETE")) {
    throw agentXError("CONFIG_INVALID", status === undefined
      ? `the access stack ${accessStack} does not exist yet; ask your platform team to run deploy-access.sh from the bundle, then run this again`
      : `the access stack ${accessStack} is ${status}; ask your platform team to fix it (see the bundle's README, "If it fails"), then run this again`);
  }
  // Every later stack's roles carry the bundle's boundary; refused now, not halfway through the
  // deploy. The default boundary is an empty parameter.
  const deployed = (await input.stackStatus.parameters?.(accessStack))?.PermissionsBoundaryArn;
  const wanted = bundle.permissionsBoundaryArn ?? "";
  if (deployed !== undefined && deployed !== wanted) {
    const describe = (arn: string) => (arn === "" ? "AgentX's default boundary" : arn);
    throw agentXError("CONFIG_INVALID", `the bundle's permission boundary (${describe(wanted)}) differs from the one the access stack ${accessStack} was deployed with (${describe(deployed)}); use the bundle the platform team deployed from`);
  }
}

async function init(options: InitOptions, deps: InitCliDependencies, services: { stderr: Writer; home: string }, session: InitSession): Promise<InitResult> {
  const { env } = options;
  const { write } = session;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? realSleep;
  const fetchImplementation = deps.fetch ?? fetch;
  const processEnv = deps.processEnv ?? process.env;
  const deployDeps = deps.deploy ?? {};
  if (options.fromBundle !== undefined && !options.resume) throw agentXError("CONFIG_INVALID", "--from-bundle goes with --resume");
  // Read first, so a bad bundle is refused before anything is asked or downloaded.
  const bundle = options.fromBundle === undefined ? undefined : await readBundleAnswers(options.fromBundle);
  if (bundle !== undefined && bundle.env !== env) throw agentXError("CONFIG_INVALID", `the bundle is for environment ${bundle.env}; pass --env ${bundle.env}`);
  // A resume reads the install from the region's SSM, so --yes never guesses it (a bundle names it).
  if (options.yes && options.region === undefined && bundle === undefined) {
    throw agentXError("CONFIG_INVALID", "agentx init needs to know the AWS region; with --yes, pass --region <region>");
  }
  const runner = deployDeps.commandRunner ?? realCommandRunner(services.stderr);

  // The release comes first: a CLI built from source is told to pass --release before anything else.
  const version = deps.releaseVersion === undefined ? RELEASE_VERSION : deps.releaseVersion ?? undefined;
  const releaseDir = options.releaseDir ?? (await fetchRelease({ version, engine: options.flags.engine, home: services.home, fetch: fetchImplementation, runner, write }));
  const release = await loadRelease(releaseDir);
  // F23: the saved answers take only x.y.z, so a prerelease would otherwise fail after the plan.
  if (isPrereleaseVersion(release.manifest.version)) {
    throw agentXError("CONFIG_INVALID", `release ${release.manifest.version} is a prerelease; agentx init installs only published releases (x.y.z). Pass --release <dir> with a published release`);
  }

  // FR-001: --ui, --no-ui, or (neither given) the page in an interactive terminal on a machine
  // that can open a browser. --no-browser reads as "no browser here" for the default (Q2).
  const uiMode = resolveUiMode({
    ui: options.ui, yes: options.yes, injectedPrompter: deps.prompter !== undefined,
    interactive: (deps.isInteractive ?? (() => process.stdin.isTTY === true))(),
    browser: options.browser && (deps.browserAvailable ?? (() => browserAvailable({ platform: process.platform, env: processEnv })))(),
  });
  let prompter: Prompter;
  if (uiMode.mode === "page") {
    if (options.yes) throw agentXError("CONFIG_INVALID", "agentx init --ui asks its questions on a page; --yes answers them without asking. Use one or the other");
    const wizard = await startInstallWizard({
      env, write,
      ...(options.browser ? { openBrowser: neverThrowingBrowser(deps.openBrowser ?? openSystemBrowser, write) } : {}),
    });
    session.wizard = wizard;
    prompter = deps.prompter ?? wizard.prompter;
  } else if (deps.prompter !== undefined) {
    prompter = deps.prompter;
  } else if (options.yes) {
    prompter = unattendedPrompter();
  } else {
    if (uiMode.noBrowser === true) write(NO_BROWSER_LINE);
    if (process.stdin.isTTY !== true) {
      throw agentXError("CONFIG_INVALID", "agentx init asks questions; run it in a terminal, pass --ui to answer them in a browser, or pass --yes with a flag for every answer");
    }
    prompter = processPrompter(services.stderr);
  }
  if (options.slackInstall !== undefined) prompter = answeringSlackInstall(prompter, options.slackInstall);
  // Built once: the wizard shows the checklist from it before the first step runs, and the resume
  // screen names its titles.
  const steps = initSteps({ github: deps.github ?? githubRestApi(fetchImplementation), slack: deps.slack ?? slackWebApi(fetchImplementation) });
  session.wizard?.setSteps(steps.map((step) => ({ id: step.id, title: step.title })));
  // --stop-after runs a prefix of the steps; the wizard's checklist still shows them all.
  const stopIndex = options.stopAfter === undefined ? -1 : steps.findIndex((step) => step.id === options.stopAfter);
  const runSteps = stopIndex < 0 ? steps : steps.slice(0, stopIndex + 1);

  // FR-020 (Q9): on the page, the operator picks the AWS profile before anything reads AWS. It is
  // put in AWS_PROFILE, which every AWS client built below, and every child process (cdk, the AWS
  // CLI), reads. processEnv is process.env on a real run. The terminal path asks nothing here.
  const awsProfile = session.wizard === undefined
    ? undefined
    : await pickAwsProfile({ profiles: await listAwsProfiles({ home: services.home, processEnv }), processEnv, prompter });
  const regions = release.regions();
  // The AWS CLI's own region comes first, so a resume looks where the install started.
  const environmentRegion = [processEnv.AWS_REGION, processEnv.AWS_DEFAULT_REGION, awsProfile?.region].find((value) => value !== undefined && regions.includes(value));
  // A bundle names its region, so a bundle resume never asks it.
  const region = options.region ?? bundle?.region ?? (await prompter.choose<string>("AWS region", regions.map((value) => ({ value, label: value })), { flag: "--region", defaultValue: environmentRegion ?? regions[0] ?? "us-east-1" }));
  if (bundle !== undefined && bundle.region !== region) throw agentXError("CONFIG_INVALID", `the bundle is for region ${bundle.region}; pass --region ${bundle.region}`);
  assertReleaseCoversRegion(release, region);

  const store = deployDeps.store ?? ssmParameterStore(new SSMClient({ region }));
  const secrets = deps.initSecrets ?? secretsManagerInitSecrets(new SecretsManagerClient({ region }));
  // FR-020 and FR-021: the account the install lands in, on the page; there, an expired session
  // is signed in again instead of ending the run. The terminal path throws as before.
  const caller = await resolveCaller({
    identity: () => deployDeps.identity ?? stsCallerIdentity(new STSClient({ region })),
    region, prompter, runner,
    ...(session.wizard === undefined ? {} : { surface: session.wizard.surface }),
    ...(awsProfile === undefined ? {} : { profile: awsProfile }),
  });
  if (options.account !== undefined && options.account !== caller.account) {
    throw agentXError("CONFIG_INVALID", `--account ${options.account} does not match your AWS credentials, which are for account ${caller.account}; use credentials for ${options.account}, or leave --account off`);
  }
  const checks = deps.checks ?? awsPrerequisiteChecks({ region, account: caller.account, store, runner, fetch: fetchImplementation });
  const stackStatus = deps.stackStatus ?? cloudFormationStatusReader(new CloudFormationClient({ region }));
  if (bundle !== undefined) await assertBundleResumable({ bundle, bundleDir: options.fromBundle ?? "", account: caller.account, releaseVersion: release.manifest.version, stackStatus });

  const existingSettings = await readEnvironmentSettings(store, env);
  const stored = await readInstallAnswers(store, env);
  if (stored === undefined && existingSettings !== undefined) {
    throw agentXError("CONFIG_INVALID", existingSettings.naming === "legacy"
      ? `environment ${env} is the deployment adopted with fixed stack names; agentx init cannot install over it. Choose another --env`
      : `environment ${env} is already installed, but not by agentx init; there is nothing to resume. Choose another --env, or use agentx deploy --mode upgrade`);
  }
  // With a bundle and no install yet, the bundle is what is resumed.
  if (options.resume && stored === undefined && bundle === undefined) {
    const nothing = `there is no install of environment ${env} to resume in account ${caller.account} (${region})`;
    throw agentXError("CONFIG_INVALID", isOperatorRole(caller.arn, env)
      ? `${nothing}; you are using the AgentX operator role, so if your platform team deployed the access stack from an export bundle, run agentx init --resume --from-bundle <the bundle directory>`
      : `${nothing}; run agentx init without --resume to start one`);
  }
  // A first run under --yes (no install under way, and no --resume): the finishing steps can ask
  // nothing, so what they need is checked here, before anything is created. The Cognito admin's
  // email (your own OIDC needs none), and the channel. A resume skips this: each finishing step
  // refuses with its flag named only when it still needs the value.
  if (options.yes && !options.resume && stored === undefined) {
    const missing = [
      ...(options.flags.identity !== "oidc" && options.finishFlags.adminEmail === undefined ? [["--admin-email <email>", "the email of your AgentX admin user"]] : []),
      ...(options.finishFlags.channel === undefined ? [["--channel <name>", "the Slack channel for the first project"]] : []),
    ];
    const [first] = missing;
    if (first !== undefined) throw agentXError("CONFIG_INVALID", `agentx init --yes needs ${first[0]} (${first[1]}); pass it, or run agentx init without --yes to be asked`);
  }

  let collected: CollectedAnswers | undefined;
  let answers: InitAnswers;
  if (stored === undefined) {
    collected = await collectInitAnswers({
      env, region, account: caller.account, releaseVersion: release.manifest.version, flags: options.flags, prompter, processEnv, now,
      ...(bundle === undefined ? {} : { fixed: bundle }),
    });
    answers = collected.answers;
    // A typed flag must not contradict what the bundle already decided.
    if (bundle !== undefined) assertResumeFlagsMatch(answers, options.flags);
  } else {
    answers = stored;
    if (answers.account !== caller.account) throw agentXError("CONFIG_INVALID", `the install of ${env} started in account ${answers.account}, but your AWS credentials are for account ${caller.account}; use credentials for ${answers.account}`);
    if (answers.releaseVersion !== release.manifest.version) {
      throw agentXError("CONFIG_INVALID", `the install of ${env} started with release ${answers.releaseVersion}, but this agentx has release ${release.manifest.version}; run npx @charterarc/agentx@${answers.releaseVersion} init --env ${env}, or pass --release <dir> for ${answers.releaseVersion}`);
    }
    assertResumeFlagsMatch(answers, options.flags);
  }
  // F7: once, now that the engine is known, and before anything is checked, shown or created.
  if (answers.engine === "cdk" && options.source === undefined) throw agentXError("CONFIG_INVALID", `the cdk engine needs --source <a checkout of tag v${answers.releaseVersion}>`);

  const activePrompter = prompter;
  // With --ui, the page's cards; the terminal path has none (SC-004).
  const surface = session.wizard?.surface;
  // Q5: with --ui, every other site is a button on the page. The terminal path opens the system
  // browser, or prints the address with --no-browser, as before.
  const stepBrowser = session.wizard?.openLink
    ?? (options.browser ? neverThrowingBrowser(deps.openBrowser ?? openSystemBrowser, write) : undefined);
  const finalAnswers = answers;
  // A first run's OpenRouter key is not stored until after the plan, so the check uses it directly.
  const pendingKey = collected?.openRouterKey === undefined
    ? undefined
    : { key: collected.openRouterKey, ...(collected.openRouterProviders === undefined ? {} : { providers: collected.openRouterProviders }) };
  // FR-023 (Q7): on the page, the checks are a checklist, and a failure can be checked again
  // after the fix; the terminal path stops with the collected problems, as before.
  const runPrerequisites = () => retryOnPage({
    surface, prompter: activePrompter, question: "Check the prerequisites again?",
    // The card already lists every failed check, so the retry shows nothing of its own.
    failed: () => undefined,
    run: async () => {
      const found: PrerequisiteCheck[] = [];
      const show = (status: "running" | "ok" | "failed") => surface?.card(prerequisitesCard({ status, checks: found }));
      show("running");
      try {
        await checkPrerequisites({
          answers: finalAnswers, release, caller, checks, prompter: activePrompter, write,
          onCheck: (check) => { found.push(check); show("running"); },
          ...(pendingKey === undefined ? {} : { openRouterKey: pendingKey }),
        });
      } catch (error) {
        // A failure no check reported (a cdk bootstrap that fails after yes, say) is still listed,
        // so the page never shows a failed card with nothing to fix.
        if (!found.some((check) => !check.ok)) found.push({ label: "Prerequisites", ok: false, detail: problemText(error) });
        show("failed");
        throw error;
      }
      show("ok");
    },
  });
  let prerequisitesPassed = false;
  let rotatedWebhook: string | undefined;
  let rotatedOpenRouterKey: string | undefined;
  if (collected !== undefined) {
    await runPrerequisites();
    prerequisitesPassed = true;
    // Printed even under --yes, before anything is created. FR-005: with --ui the same priced plan
    // is the review screen, and its confirm is a button.
    await confirmInstallPlan({
      answers: collected.answers, notes: collected.notes, prompter,
      write: (text) => { services.stderr.write(text); session.wizard?.plan(text); },
      extras: { storesOpenRouterKey: collected.openRouterKey !== undefined, ...(collected.openRouterProviders === undefined ? {} : { openRouterProviders: collected.openRouterProviders }) },
    });
  } else {
    write(`Resuming the install of environment ${env}.`);
    if (session.wizard !== undefined) session.wizard.resume(await resumeScreen(store, env, steps));
    rotatedWebhook = await resumedAlertWebhook({ answers, flags: options.flags, processEnv, prompter });
    rotatedOpenRouterKey = await resumedOpenRouterKey({ flags: options.flags, processEnv, prompter });
  }

  // F14: the answers and the alert and OpenRouter secrets are saved under the environment lock,
  // which is taken once for the whole run; the deploy steps pass lockHeld. The secrets are stored
  // before the answers, and before any step, so every stack that takes OpenRouterSecretArn gets it.
  const firstRun = collected;
  const saveAnswers = async () => {
    if (firstRun !== undefined) {
      if ((await readInstallAnswers(store, env)) !== undefined) {
        throw agentXError("CONFIG_INVALID", `another agentx init started installing environment ${env} while this one was asking its questions; nothing was saved. Run agentx init again to continue that install`);
      }
      // The saved answers carry the stored OpenRouter key's ARN, which every step reads.
      context.answers = await persistInitAnswers({ store, secrets, collected: firstRun });
    } else {
      if (rotatedWebhook !== undefined && finalAnswers.alert.kind === "webhook") await storeAlertWebhook(secrets, finalAnswers.alert.secretName, rotatedWebhook);
      if (rotatedOpenRouterKey !== undefined) await secrets.put(openRouterSecretName(env), rotatedOpenRouterKey);
    }
    // On every bundle run, not only the first: a run that stopped between saving the answers and
    // this write would otherwise leave access pending, and the operator role refused on it.
    if (bundle !== undefined) {
      const progress = (await readInstallProgress(store, env)) ?? emptyProgress(env, now());
      if (progress.steps.access?.status !== "done") {
        await writeInstallProgress(store, { ...progress, steps: { ...progress.steps, access: { status: "done", at: new Date(now()).toISOString(), note: PLATFORM_TEAM_ACCESS_NOTE } } });
      }
    }
  };

  const setup: SetupServices = { ...realSetupServices({ region, fetch: fetchImplementation, configDir: options.configDir }), ...deps.setup };
  const identity = finalAnswers.identity;
  // F13: your own OIDC's admin claim, when the answers name both halves of it. The admin-user step
  // refuses answers that do not (C6), before any session is opened.
  const adminClaim = identity.mode === "oidc" && identity.adminClaim !== undefined && identity.adminValues !== undefined
    ? { claim: identity.adminClaim, values: identity.adminValues } : undefined;
  const adminSession = async () => {
    const settings = await readSettingsOrThrow(store, env);
    return openAdminSession({
      settings, services: setup, write, now,
      ...(stepBrowser === undefined ? {} : { openBrowser: stepBrowser }),
      ...(adminClaim === undefined ? {} : { adminClaim }),
    });
  };

  let deployment: Promise<PreparedDeployment> | undefined;
  const context: InitContext = {
    env,
    answers: finalAnswers,
    release,
    holder: caller.arn,
    store,
    secrets,
    prompter: activePrompter,
    write,
    ...(stepBrowser === undefined ? {} : { openBrowser: stepBrowser }),
    ...(surface === undefined ? {} : { surface }),
    ...(session.wizard === undefined ? {} : { manifestHost: session.wizard.manifestHost }),
    now,
    sleep,
    fetch: fetchImplementation,
    processEnv,
    secretFlags: options.secretFlags,
    cloudFormation: deps.cloudFormation ?? new CloudFormationClient({ region }),
    signinFlags: options.signinFlags ?? {},
    ...(options.preMadeGitHubApp === undefined ? {} : { preMadeGitHubApp: options.preMadeGitHubApp }),
    // Built once and reused by every deploy step. The caller identity is the one already checked
    // against the answers' account, and no partition is passed, so prepareDeployment's "answers
    // file" account and partition errors cannot arise here.
    deployment: () => {
      deployment ??= (deps.prepareDeployment ?? prepareDeployment)({
        engine: finalAnswers.engine, env, region, account: finalAnswers.account, identityMode: finalAnswers.identity.mode, release,
        ...(options.source === undefined ? {} : { source: options.source }),
        deps: { ...deployDeps, store, secrets, identity: { get: async () => caller } },
        stderr: services.stderr,
      });
      return deployment;
    },
    stackStatus,
    home: services.home,
    prerequisitesPassed,
    runPrerequisites,
    setup,
    adminSession,
    flags: options.finishFlags,
  };

  try {
    const result = await runInitSteps({
      env, region, store, holder: caller.arn, context, now,
      steps: runSteps,
      beforeSteps: saveAnswers,
      onEvent: (event) => { write(eventLine(event)); session.wizard?.event(event); },
      // A takeover is never behind --yes, which answers every confirm with yes.
      ...(options.yes ? {} : {
        confirmTakeover: (held: LockRecord) => activePrompter.confirm(
          held.holder === caller.arn && held.command === "init"
            ? `Environment ${env} is locked by your own earlier agentx init since ${held.acquiredAt}. Take the lock over? Say yes only if that run is no longer going.`
            : `Environment ${env} is locked by ${held.holder} running "${held.command}" since ${held.acquiredAt}, more than 2 hours ago. Take the lock over? Say yes only if that command is no longer running.`,
          { defaultValue: false },
        ),
      }),
    });
    // A run --stop-after cut short is not installed, so it has no ready text.
    if (options.stopAfter !== undefined && result.status === "complete") {
      return { ...result, env, resumed: stored !== undefined, stoppedAfter: options.stopAfter };
    }
    const settings = result.status === "complete" ? await readEnvironmentSettings(store, env) : undefined;
    const progress = result.status === "complete" ? await readInstallProgress(store, env) : undefined;
    // FR-052: the page's last card says what works now; the terminal and the page's outcome keep
    // readyText.
    if (surface !== undefined && settings !== undefined && progress !== undefined) {
      surface.card(readyCard({ env, controlPlaneUrl: settings.controlPlaneUrl, progress }));
    }
    return {
      ...result, env, resumed: stored !== undefined,
      ...(settings === undefined ? {} : { controlPlaneUrl: settings.controlPlaneUrl }),
      ...(settings === undefined || progress === undefined ? {} : { ready: readyText({ env, controlPlaneUrl: settings.controlPlaneUrl, progress }) }),
    };
  } finally {
    // Whether init succeeded or failed; a deployment that failed to build has nothing to clean up.
    // A failed cleanup is reported, never thrown: it must not replace the step's own error or result.
    if (deployment !== undefined) {
      try {
        await deployment.then((prepared) => prepared.cleanup(), () => undefined);
      } catch (error) {
        write(`could not remove temporary files: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}
