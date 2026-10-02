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
import { AgentXError, agentXError, environmentOperatorRoleName, environmentStackName } from "@agentx/contracts";
import { authorizeCredential, secretsManagerAuthorizeSecrets } from "../admin/authorize.js";
import { loginWithPkce, openSystemBrowser } from "../auth.js";
import { cliErrorFor, cloudFormationOutputsReader, prepareDeployment, realCommandRunner, type DeployCliDependencies, type PreparedDeployment, type Writer } from "../deploy/commands.js";
import { readBundleAnswers, type BundleAnswers } from "../deploy/export-bundle.js";
import { assertSourceAtRelease } from "../deploy/cdk-engine.js";
import { installOrder } from "../deploy/parameters.js";
import { assertReleaseCoversRegion, loadRelease, type LoadedRelease } from "../deploy/release.js";
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
import { clashChecks } from "./clash-checks.js";
import { cliCommandLine, currentCliInvocation, type CliInvocation } from "./cli-command.js";
import {
  cloudFormationStatusReader, secretsManagerInitSecrets, type FinishFlags, type InitContext, type InitSecrets, type PreMadeGitHubApp, type SecretFlags, type StackStatusReader,
} from "./context.js";
import { deployStep } from "./deploy-steps.js";
import { finishSteps, readSettingsOrThrow, readyText } from "./finish-steps.js";
import { githubAppStep, githubRestApi, type GitHubApi } from "./github-app.js";
import { listAwsProfiles, pickAwsProfile, realAccountAlias, resolveCaller } from "./aws-account.js";
import { emptyProgress, readInstallAnswers, readInstallProgress, writeInstallProgress, type InitAnswers, type InitStepId } from "./install-state.js";
import { initLogPath, openInitLog, type InitLog } from "./log-file.js";
import { confirmInstallPlan } from "./plan.js";
import { awsPrerequisiteChecks, checkAccount, checkPrerequisites, isRootUser, type PrerequisiteCheck, type PrerequisiteChecks } from "./prerequisites.js";
import { askForm, processPrompter, secretFromSource, unattendedPrompter, type FormField, type FormOptions, type Prompter, type QuestionHelp } from "./prompts.js";
import { fetchRelease, sourceRelease } from "./release-fetch.js";
import { checkWithChangeOnPage, problemText, retryOnPage } from "./retry.js";
import { developerSignInStep } from "./signin-step.js";
import { botNameOf, slackAppStep, slackWebApi, verifySlackUrls, type SlackApi } from "./slack-app.js";
import { isOperatorStop, isWordedOperatorStop } from "./stop.js";
import { runInitSteps, type InitEvent, type InitRunResult, type InitStep } from "./steps.js";
import { browserAvailable, NO_BROWSER_LINE, resolveUiMode } from "./ui-mode.js";
import { accountChecksCard, prerequisitesCard, readyCard } from "./ui/cards.js";
import { askFailureAction, failureScreen, isRetryableStep, plainReason, STOPPED_OUTCOME } from "./ui/failure.js";
import { startInstallWizard, type InstallWizard } from "./ui/index.js";
import { READY_LINE, stageLine, STEP_PLAN, stoppedLine, terminalStepLine } from "./ui/journey.js";
import type { WizardPlan, WizardResume } from "./ui/protocol.js";

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
  /** The command this CLI runs as, for the page's "Continue later with" command (tests pin it; the
   * real one is currentCliInvocation()). */
  cliInvocation?: CliInvocation;
  /** Spec 048 FR-015: the AWS account's alias, for the account card. Defaults to `realAccountAlias`
   * (an IAM call); every test injects its own (usually `async () => undefined`) so none reaches IAM. */
  accountAlias?: () => Promise<string | undefined>;
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
export type InitResult = InitRunResult & {
  env: string; resumed: boolean; controlPlaneUrl?: string; ready?: string; stoppedAfter?: InitStepId;
  /** With the page open, the terminal already has every line it needs (FR-070): `main.ts` prints
   * nothing more for it. */
  pageMode?: true;
};

/** True when `callerArn` is a session of this environment's AgentX operator role (FR-019). */
export function isOperatorRole(callerArn: string, env: string): boolean {
  return new RegExp(`:assumed-role/${environmentOperatorRoleName(env)}/`).test(callerArn);
}

/** FR-058 and FR-059: the ready screen stays up, so the page's outcome names nothing the ready
 * card already says in full (the card is the one place the developer sign-in and day-two commands
 * live); the terminal still gets READY_LINE and the full readyText goes to the log file. */
export const READY_OUTCOME = "AgentX is installed.";

/** FR-059: how long the ready screen stays up on its own, once the install is complete. */
export const READY_HOLD_MS = 30 * 60_000;

/** The plain words for a run that stopped waiting on someone else (a workspace admin, an alert
 * subscription), shown as the terminal's one-line summary in place of the raw step message, which
 * carries its own (terminal-only) rerun instruction. */
export const WAITING_STEP_PLAIN: Partial<Record<InitStepId, string>> = {
  "slack-app": "Waiting for a Slack admin to approve the app.",
  alerts: "Waiting for the alert subscription to be confirmed.",
};

/** FR-059: the ready screen stays until the page asks to close (Plan ruling 3: a page button, not
 * a question), or for READY_HOLD_MS, whichever comes first; a real run clears its own timer the
 * moment either happens, so the process exits as soon as Close installer is pressed. */
export async function holdReadyScreen(input: { closeRequested: Promise<void>; ms: number; sleep?: (ms: number) => Promise<void> }): Promise<void> {
  if (input.sleep !== undefined) {
    await Promise.race([input.closeRequested, input.sleep(input.ms)]);
    return;
  }
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([input.closeRequested, new Promise<void>((resolvePromise) => { timer = setTimeout(resolvePromise, input.ms); })]);
  clearTimeout(timer);
}

export const OPERATOR_ACCESS_REFUSAL =
  "the access stack needs admin rights, and you are using the AgentX operator role; ask your platform team to deploy it (agentx init --export, then deploy-access.sh), or run agentx init with admin credentials";

/** The note an `access` step deployed by a platform team from an export bundle is recorded with. */
export const PLATFORM_TEAM_ACCESS_NOTE = "deployed by your platform team from the export bundle";

/** The access stack's deploy step, refused up front under the operator role: the operator role
 * cannot create IAM roles, so the deploy would only fail later on IAM. */
function accessStep(): InitStep<InitContext> {
  const deploy = deployStep({ id: "access", title: STEP_PLAN.access.title });
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
      title: STEP_PLAN.prerequisites.title,
      async run(context) {
        if (!context.prerequisitesPassed) await context.runPrerequisites();
        return { status: "done" };
      },
    },
    githubAppStep(input.github),
    accessStep(),
    deployStep({ id: "core", title: STEP_PLAN.core.title }),
    deployStep({ id: "control-plane", title: STEP_PLAN["control-plane"].title }),
    slackAppStep(input.slack),
    deployStep({ id: "slack-service", title: STEP_PLAN["slack-service"].title, after: verifySlackUrls }),
    developerSignInStep({ slack: input.slack }),
    ...finishSteps(),
  ];
}

function eventLine(event: InitEvent): string | undefined {
  switch (event.kind) {
    case "step-skipped": return `already done: ${event.title}`;
    case "step-started": return `==> ${event.title}`;
    case "step-done": return `done: ${event.title}`;
    case "step-waiting": return `waiting: ${event.title}`;
    case "step-failed": return undefined;
  }
}

/** Issue 152: a source release that read no release.json (or one listing no region) has no region
 * list; the region then comes from --region or the AWS configuration, and init says which it took. */
function configuredRegion(configured: string | undefined, write: (line: string) => void): string {
  if (configured === undefined) throw agentXError("CONFIG_INVALID", "with no release.json there is no list of regions to choose from; pass --region <region>, or set a region in your AWS configuration");
  write(`Region ${configured}, from your AWS configuration; pass --region to choose another`);
  return configured;
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
  /** Task 14: the page-mode log file, opened before the wizard and closed with it. Holds what the
   * terminal no longer shows, and never a secret or the session token (FR-070, FR-071). */
  log?: InitLog;
  /** A property, not a method, so `init` can pass it on as `write` without rebinding it.
   * A progress line: the terminal without the page; the log file and the page's technical log
   * with it. */
  write: (line: string) => void;
  /** The terminal always, and the log: with the page, only the start lines, one line per step,
   * and the last line. */
  say: (line: string) => void;
  /** Child process output and the plan's text: the terminal without the page, the log file with it. */
  output: Writer;
  /** The prompter in use, once chosen: the catch below asks on it when no step hook already did. */
  prompter?: Prompter;
  /** Once known: names the region in a failure shown before a step runs. */
  region?: string;
  /** Set once `onStepFailure` already showed the screen for the error now being thrown, so the
   * catch below does not show a second one for the same failure (Plan ruling 8). */
  failureShown?: boolean;
  /** The command this CLI runs as, for the "Continue later with" command on a failure screen. */
  invocation: CliInvocation;
}

export async function runInit(options: InitOptions, deps: InitCliDependencies, services: { stderr: Writer; home: string }): Promise<InitResult> {
  const session: InitSession = {
    invocation: deps.cliInvocation ?? currentCliInvocation(),
    write: (line) => {
      if (session.wizard === undefined) { services.stderr.write(`${line}\n`); return; }
      session.log?.write(`${line}\n`);
      session.wizard.log(line);
    },
    say: (line) => { services.stderr.write(`${line}\n`); session.log?.write(`${line}\n`); },
    output: { write: (text: string) => (session.wizard === undefined ? services.stderr.write(text) : session.log?.write(text)) },
  };
  try {
    const result = await init(options, deps, services, session);
    const wizard = session.wizard;
    if (wizard !== undefined) {
      const complete = result.status === "complete" && result.stoppedAfter === undefined;
      // FR-058 and FR-059: the page's outcome never repeats what the ready card already says (its
      // commands and day-two advice); a paused run (waiting on a Slack admin, an alert
      // subscription) gets the same plain form, with the continue command instead of a line
      // naming the terminal; --stop-after keeps its own text.
      if (complete) {
        wizard.finish(READY_OUTCOME);
      } else if (result.stoppedAfter !== undefined) {
        wizard.finish(`Stopped after the ${result.stoppedAfter} step, as --stop-after asked.`);
      } else {
        const region = session.region ?? options.region ?? "<region>";
        wizard.finish("The install is paused. Your progress is saved.", "paused", [
          { label: "Continue later with", command: cliCommandLine(session.invocation, `--env ${options.env} init --region ${region}`) },
        ]);
      }
      // FR-070 and FR-071: the full ready summary goes to the log file, never the terminal; the
      // terminal gets the one fixed line below (Task 15's own finish work says READY_LINE too, per
      // the controller ruling that moved it here so this task's terminal-lines test passes).
      if (result.ready !== undefined) session.log?.write(`${result.ready}\n`);
      if (complete) {
        session.say(READY_LINE);
        // FR-059: the page stays open (Close installer, or 30 minutes) only once the install is
        // actually done; a paused or stopped-after run ends the page right away, as before.
        await holdReadyScreen({ closeRequested: wizard.closeRequested(), ms: READY_HOLD_MS, ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }) });
      } else if (result.status === "waiting") {
        // The step itself names its own phase, the same one the page's rail shows as waiting.
        session.say(stoppedLine({
          phase: STEP_PLAN[result.step].phase,
          problem: WAITING_STEP_PLAIN[result.step] ?? "The install is paused.",
          logPath: session.log?.path ?? "the log",
        }));
      }
    }
    return result;
  } catch (error) {
    const mapped = cliErrorFor(error);
    const wizard = session.wizard;
    if (wizard !== undefined) {
      const region = session.region ?? options.region ?? "<region>";
      // Spec 048 FR-060: a failure outside a step (or a step's own hook never ran, or already
      // showed its screen) still gets the screen here, unless the operator chose to stop
      // themselves (declining the plan, the root warning, or a "check again" question): that is
      // not a failure, so no screen is shown for it (Plan ruling 8).
      if (session.failureShown !== true && !isOperatorStop(error)) {
        wizard.showFailure(failureScreen({ env: options.env, region, error, ...(wizard.logPath === undefined ? {} : { logPath: wizard.logPath }) }));
        await askFailureAction(session.prompter ?? wizard.prompter, { retry: false });
      }
      // Only a stop with its own words (declining the plan, the root warning) tells them; any other
      // stop, such as declining a check-again question, ends on the fixed words.
      const outcome = isWordedOperatorStop(error) ? (plainReason(error) ?? STOPPED_OUTCOME) : STOPPED_OUTCOME;
      wizard.finish(outcome, "failed", [{ label: "Continue later with", command: cliCommandLine(session.invocation, `--env ${options.env} init --region ${region}`) }]);
      // FR-070: a real failure (not a stop the operator chose) collapses to one terminal line;
      // the full error still goes to the log file. An operator stop keeps throwing `mapped` as
      // before (unchanged for FR-005's declined-plan and FR-023's declined-recheck messages).
      if (!isOperatorStop(error)) {
        session.log?.write(`${mapped instanceof Error ? mapped.message : String(mapped)}\n`);
        const what = wizard.hub.state().failure?.what ?? plainReason(error) ?? "The install could not go on.";
        const line = stoppedLine({ phase: wizard.hub.state().journey.current, problem: what, logPath: session.log?.path ?? "the log" });
        throw Object.assign(mapped instanceof AgentXError ? agentXError(mapped.code, line) : new Error(line), { cause: error });
      }
    }
    throw mapped;
  } finally {
    await session.wizard?.close();
    await session.log?.close();
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

/** Answers "is the Slack app installed?" from --slack-install; every other question goes to `inner`,
 * the page's form included when `inner` has one. Exported for its test. */
export function answeringSlackInstall(inner: Prompter, answer: "installed" | "approval"): Prompter {
  return {
    // askForm asks through inner's own form, which is there whenever this key is.
    ...(inner.form === undefined ? {} : { form: (title: string, fields: readonly FormField[], options: FormOptions) => askForm(inner, title, fields, options) }),
    ask: (question, options) => inner.ask(question, options),
    confirm: (question, options) => inner.confirm(question, options),
    secret: (question, options) => inner.secret(question, options),
    async choose<T extends string>(question: string, choices: ReadonlyArray<{ value: T; label: string }>, options: { flag: string; defaultValue: T; unattendedRefusal?: string; help?: QuestionHelp }): Promise<T> {
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
  const runner = deployDeps.commandRunner ?? realCommandRunner(session.output);

  // The release comes first: a CLI built from source is told to pass --release before anything else.
  const version = deps.releaseVersion === undefined ? RELEASE_VERSION : deps.releaseVersion ?? undefined;
  // Issue 152: a CLI built from source with --engine cdk (on the command line: the engine question
  // comes after the release) builds its release from the --source checkout instead.
  const fromSource = options.releaseDir === undefined && version === undefined && options.flags.engine === "cdk";
  let release: LoadedRelease;
  // The regions init offers: the release's, or undefined when nothing lists them (a source release
  // whose images all come from flags, so no release.json was read).
  let releaseRegions: string[] | undefined;
  // Why a source release has no images, when it has none; checked once the saved answers are read.
  let imagesProblem: string | undefined;
  if (fromSource) {
    if (options.source === undefined) throw agentXError("CONFIG_INVALID", "the cdk engine needs --source <a checkout of a release tag>");
    // "allow": a resume's saved answers may hold both images; they are checked once the answers are known.
    const built = await sourceRelease({ runner, source: options.source, images: { worker: options.flags.workerImage, slack: options.flags.slackImage }, fetch: fetchImplementation, missingReleaseJson: "allow" });
    release = built.release;
    releaseRegions = built.regions;
    imagesProblem = built.imagesProblem;
  } else {
    release = await loadRelease(options.releaseDir ?? (await fetchRelease({ version, home: services.home, fetch: fetchImplementation, runner, write })));
    releaseRegions = release.regions();
  }
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
    // Task 14: opened before the wizard, so its address and the log's own path are both ready for
    // the wizard's start lines (FR-070); the token is hidden from it the moment the server has one.
    session.log = await openInitLog(initLogPath(services.home, env), { onError: (line) => services.stderr.write(`${line}\n`) });
    const wizard = await startInstallWizard({
      env,
      write: (line) => services.stderr.write(`${line}\n`),
      logPath: session.log.path,
      ...(options.browser ? { openBrowser: neverThrowingBrowser(deps.openBrowser ?? openSystemBrowser, write) } : {}),
    });
    session.log.hide(wizard.token);
    session.wizard = wizard;
    prompter = deps.prompter ?? wizard.prompter;
    session.say(stageLine("get-started"));
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
  // Spec 048 FR-060: once chosen, so a failure outside any step still has someone to ask.
  session.prompter = prompter;
  // Built once: the wizard shows the checklist from it before the first step runs, and the resume
  // screen names its titles.
  // Spec 048 FR-020: one GitHub client for the steps and for the owner lookup in the settings.
  const github = deps.github ?? githubRestApi(fetchImplementation);
  const steps = initSteps({ github, slack: deps.slack ?? slackWebApi(fetchImplementation) });
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
  const regions = releaseRegions ?? [];
  // The AWS CLI's own region comes first, so a resume looks where the install started.
  const configuredRegions = [processEnv.AWS_REGION, processEnv.AWS_DEFAULT_REGION, awsProfile?.region].filter((value): value is string => value !== undefined && value !== "");
  // The cdk engine synthesizes for any region, so the configured one is offered (and is the
  // default) even when the release does not list it.
  const [configured] = configuredRegions;
  const choices = options.flags.engine === "cdk" && configured !== undefined && !regions.includes(configured) ? [configured, ...regions] : regions;
  const environmentRegion = configuredRegions.find((value) => choices.includes(value));

  // FR-015: the account is shown first, before the region is asked. STS answers in any region, so
  // the caller is read in the region the run already knows, or the AWS configuration's, or
  // us-east-1; with --ui, the page's cards; the terminal path has none (SC-004).
  const identityRegion = options.region ?? bundle?.region ?? configured ?? "us-east-1";
  const surface = session.wizard?.surface;
  // FR-020 and FR-021: the account the install lands in, on the page; there, an expired session
  // is signed in again instead of ending the run. The terminal path throws as before.
  const caller = await resolveCaller({
    identity: () => deployDeps.identity ?? stsCallerIdentity(new STSClient({ region: identityRegion })),
    prompter, runner, write,
    alias: deps.accountAlias ?? (() => realAccountAlias(identityRegion)),
    ...(surface === undefined ? {} : { surface }),
    ...(awsProfile === undefined ? {} : { profile: awsProfile }),
  });
  if (options.account !== undefined && options.account !== caller.account) {
    throw agentXError("CONFIG_INVALID", `--account ${options.account} does not match your AWS credentials, which are for account ${caller.account}; use credentials for ${options.account}, or leave --account off`);
  }
  // A bundle names its region, so a bundle resume never asks it. With no list to choose from, the
  // AWS configuration's region is taken as it is, and said.
  const region = options.region ?? bundle?.region ?? (releaseRegions === undefined
    ? configuredRegion(configured, write)
    : await prompter.choose<string>("AWS region", choices.map((value) => ({ value, label: value })), { flag: "--region", defaultValue: environmentRegion ?? choices[0] ?? "us-east-1" }));
  // Spec 048 FR-060: once known, so a failure before the account checks run still names the region.
  session.region = region;
  if (bundle !== undefined && bundle.region !== region) throw agentXError("CONFIG_INVALID", `the bundle is for region ${bundle.region}; pass --region ${bundle.region}`);
  // The cdk engine synthesizes its own templates for any region; only the templates engine needs the release to cover it.
  if (options.flags.engine !== "cdk") assertReleaseCoversRegion(release, region);

  const store = deployDeps.store ?? ssmParameterStore(new SSMClient({ region }));
  const secrets = deps.initSecrets ?? secretsManagerInitSecrets(new SecretsManagerClient({ region }));
  // Spec 048 FR-001: the header's account and region, once the caller is known and the region chosen.
  session.wizard?.setPlace({ account: caller.account, region });
  const checks = deps.checks ?? awsPrerequisiteChecks({ region, account: caller.account, store, runner, fetch: fetchImplementation });
  const stackStatus = deps.stackStatus ?? cloudFormationStatusReader(new CloudFormationClient({ region }));
  if (bundle !== undefined) await assertBundleResumable({ bundle, bundleDir: options.fromBundle ?? "", account: caller.account, releaseVersion: release.manifest.version, stackStatus });

  const existingSettings = await readEnvironmentSettings(store, env);
  const stored = await readInstallAnswers(store, env);
  // Review I2: a release built from the source with no usable release.json has no images; a resume's
  // saved answers, or else the flags, must then name both. Refused here, before any question.
  const knownImages = stored === undefined ? { worker: options.flags.workerImage, slack: options.flags.slackImage } : stored.images;
  if (imagesProblem !== undefined && (["worker", "slack"] as const).some((which) => knownImages?.[which] === undefined && release.manifest.images[which] === undefined)) {
    throw agentXError("CONFIG_INVALID", imagesProblem);
  }
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

  // FR-018: a first run checks the account and region before any setting is asked. On the page a
  // failure is a checklist with Check again; the terminal stops with every problem, as before.
  const runAccountChecks = () => retryOnPage({
    surface, prompter, question: "Check your AWS account again?",
    // The card already lists every failed check, so the retry shows nothing of its own.
    failed: () => undefined,
    run: async () => {
      const found: PrerequisiteCheck[] = [];
      const show = (status: "running" | "ok" | "failed") => surface?.card(accountChecksCard({ status, checks: found }));
      show("running");
      try {
        await checkAccount({
          region, checks, write, audience: surface === undefined ? "terminal" : "page",
          onCheck: (check) => { found.push(check); show("running"); },
        });
      } catch (error) {
        // A failure no check reported is still listed, so the page never shows a failed card with
        // nothing to fix.
        if (!found.some((check) => !check.ok)) found.push({ label: "Your AWS account", ok: false, detail: problemText(error) });
        show("failed");
        throw error;
      }
      show("ok");
    },
  });
  if (stored === undefined) await runAccountChecks();

  // Spec 048 FR-001: the questions (a first run) and the resume screen (a resume) are both "Your choices".
  session.wizard?.setStage("your-choices");
  if (session.wizard !== undefined) session.say(stageLine("your-choices"));
  // F7: once the engine is known, and before anything is checked, shown or created. Issue 152: a
  // given or downloaded release must be the checkout's tag, refused here rather than after the plan
  // (prepareDeployment checks it again). A release built from the source is its tag.
  const assertEngineSource = async (checked: InitAnswers) => {
    if (checked.engine === "cdk" && options.source === undefined) throw agentXError("CONFIG_INVALID", `the cdk engine needs --source <a checkout of tag v${checked.releaseVersion}>`);
    if (checked.engine === "cdk" && options.source !== undefined && !fromSource) await assertSourceAtRelease({ runner, source: options.source, version: release.manifest.version });
  };
  // Spec 048 FR-029: `kept` is the settings a Change answers starts from, every answer as typed.
  const collect = async (kept?: Readonly<Record<string, string>>): Promise<CollectedAnswers> => {
    const result = await collectInitAnswers({
      env, region, account: caller.account, releaseVersion: release.manifest.version, flags: options.flags, prompter, processEnv, now,
      ...(bundle === undefined ? {} : { fixed: bundle }),
      ...(options.finishFlags.adminEmail === undefined ? {} : { adminEmail: options.finishFlags.adminEmail }),
      ...(options.signinFlags?.methods === undefined ? {} : { signinMethods: options.signinFlags.methods }),
      ...(kept === undefined ? {} : { kept }),
      ownerType: async (login) => {
        try {
          const owner = await github.owner?.(login);
          return owner === undefined ? undefined : owner.type === "Organization" ? "organization" : "user";
        } catch (error) {
          // GitHub could not say (network, rate limit): the type is asked instead, and the reason is said.
          write(`Could not look up ${login} on GitHub (${problemText(error)}); asking instead.`);
          return undefined;
        }
      },
    });
    // A typed flag must not contradict what the bundle already decided.
    if (bundle !== undefined) assertResumeFlagsMatch(result.answers, options.flags);
    await assertEngineSource(result.answers);
    return result;
  };
  let collected: CollectedAnswers | undefined;
  let initialAnswers: InitAnswers;
  if (stored === undefined) {
    collected = await collect();
    initialAnswers = collected.answers;
  } else {
    initialAnswers = stored;
    if (stored.account !== caller.account) throw agentXError("CONFIG_INVALID", `the install of ${env} started in account ${stored.account}, but your AWS credentials are for account ${caller.account}; use credentials for ${stored.account}`);
    if (stored.releaseVersion !== release.manifest.version) {
      throw agentXError("CONFIG_INVALID", `the install of ${env} started with release ${stored.releaseVersion}, but this agentx has release ${release.manifest.version}; run npx @charterarc/agentx@${stored.releaseVersion} init --env ${env}, or pass --release <dir> for ${stored.releaseVersion}`);
    }
    assertResumeFlagsMatch(stored, options.flags);
    await assertEngineSource(stored);
  }
  // Spec 048 FR-028: a holder, because a first run's answers change on each Change answers, and
  // the checks below read whichever answers are current.
  const finalAnswersRef: { current: InitAnswers } = { current: initialAnswers };

  const activePrompter = prompter;
  // Q5: with --ui, every other site is a button on the page. The terminal path opens the system
  // browser, or prints the address with --no-browser, as before.
  const stepBrowser = session.wizard?.openLink
    ?? (options.browser ? neverThrowingBrowser(deps.openBrowser ?? openSystemBrowser, write) : undefined);
  // Spec 048 FR-028 and FR-065: the install name, the GitHub owner and the app name. A bundle's
  // access stack is the platform team's, there by design; an app made beforehand (--github-app-id)
  // is this install's own, so its name is not looked up as a clash.
  const answerChecks = () => clashChecks({
    answers: finalAnswersRef.current, stackStatus, github,
    ...(options.preMadeGitHubApp === undefined ? {} : { preMadeApp: true }),
    audience: surface === undefined ? "terminal" : "page",
    installUsed: async (name) => (await readEnvironmentSettings(store, name)) !== undefined || (await readInstallAnswers(store, name)) !== undefined,
    ...(bundle === undefined ? {} : { expectedStacks: [environmentStackName(bundle.env, "access")] }),
  });
  // FR-023 (Q7): on the page, the checks are a checklist, and a failure can be checked again
  // after the fix; the terminal path stops with the collected problems, as before. FR-018:
  // `skipAccount` leaves out the EC2 vCPU quota and Elastic IPs on a first run, since
  // `runAccountChecks` already checked them right after the region was chosen. Spec 048 FR-028:
  // `askAgain: false` (a first run) throws a failure straight to checkWithChangeOnPage, whose Check
  // again replaces this question.
  const runPrerequisites = (prereqOptions: { skipAccount?: boolean; extraChecks?: () => Promise<readonly PrerequisiteCheck[]>; askAgain?: boolean } = {}) => retryOnPage({
    surface: prereqOptions.askAgain === false ? undefined : surface, prompter: activePrompter, question: "Check the prerequisites again?",
    // The card already lists every failed check, so the retry shows nothing of its own.
    failed: () => undefined,
    run: async () => {
      const found: PrerequisiteCheck[] = [];
      const show = (status: "running" | "ok" | "failed") => surface?.card(prerequisitesCard({ status, checks: found }));
      // A first run's OpenRouter key is not stored until after the plan, so the check uses it directly.
      const pendingKey = collected?.openRouterKey === undefined
        ? undefined
        : { key: collected.openRouterKey, ...(collected.openRouterProviders === undefined ? {} : { providers: collected.openRouterProviders }) };
      show("running");
      try {
        await checkPrerequisites({
          answers: finalAnswersRef.current, release, caller, checks, prompter: activePrompter, write,
          onCheck: (check) => { found.push(check); show("running"); },
          images: release.manifest.images, audience: surface === undefined ? "terminal" : "page",
          skipAccount: prereqOptions.skipAccount === true,
          ...(prereqOptions.extraChecks === undefined ? {} : { extraChecks: prereqOptions.extraChecks }),
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
    // FR-018: the account and region were already checked, right after the region was chosen.
    // Spec 048 FR-028: on the page, a failed check offers Change answers, and the settings come
    // back with every answer kept; nothing is created, saved or locked until the checks pass.
    for (;;) {
      const checked = await checkWithChangeOnPage({
        surface, prompter, question: "Your answers need a change. What next?",
        // The card already lists every failed check.
        failed: () => undefined,
        run: () => runPrerequisites({ skipAccount: true, extraChecks: answerChecks, askAgain: false }),
      });
      if (checked === "passed") {
        // Printed even under --yes, before anything is created. FR-005: with --ui the same plan is
        // the review screen; FR-029 and FR-030: its own words are the page's summary, with Create
        // AgentX and Change answers as its buttons. Spec 048 FR-028: Change answers here loops back
        // exactly as a Change answers from the checks does, with every answer kept.
        const action = await confirmInstallPlan({
          answers: collected.answers, notes: collected.notes, prompter, page: session.wizard !== undefined,
          write: (text) => session.output.write(text),
          ...(session.wizard === undefined ? {} : { show: (plan: WizardPlan) => session.wizard?.plan(plan) }),
          extras: { storesOpenRouterKey: collected.openRouterKey !== undefined, ...(collected.openRouterProviders === undefined ? {} : { openRouterProviders: collected.openRouterProviders }) },
        });
        if (action === "change") {
          collected = await collect(collected.settings);
          finalAnswersRef.current = collected.answers;
          continue;
        }
        break;
      }
      collected = await collect(collected.settings);
      finalAnswersRef.current = collected.answers;
    }
    prerequisitesPassed = true;
  } else {
    write(`Resuming the install of environment ${env}.`);
    if (session.wizard !== undefined) session.wizard.resume(await resumeScreen(store, env, steps));
    rotatedWebhook = await resumedAlertWebhook({ answers: finalAnswersRef.current, flags: options.flags, processEnv, prompter });
    rotatedOpenRouterKey = await resumedOpenRouterKey({ flags: options.flags, processEnv, prompter });
  }

  const finalAnswers = finalAnswersRef.current;
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
    // A preparation that failed (npm ci, build or synth) is forgotten, so "Try this step again"
    // prepares it again instead of failing the same way forever.
    deployment: () => {
      if (deployment === undefined) {
        const preparing = (deps.prepareDeployment ?? prepareDeployment)({
          engine: finalAnswers.engine, env, region, account: finalAnswers.account, identityMode: finalAnswers.identity.mode, release,
          ...(options.source === undefined ? {} : { source: options.source }),
          deps: { ...deployDeps, store, secrets, identity: { get: async () => caller } },
          stderr: session.output,
        });
        deployment = preparing;
        preparing.catch(() => { if (deployment === preparing) deployment = undefined; });
      }
      return deployment;
    },
    stackStatus,
    home: services.home,
    prerequisitesPassed,
    // A resume (the only caller of context.runPrerequisites) checks everything once more, since
    // runAccountChecks runs only on a first run.
    runPrerequisites: () => runPrerequisites(),
    setup,
    adminSession,
    flags: options.finishFlags,
    cliInvocation: session.invocation,
  };

  try {
    const result = await runInitSteps({
      env, region, store, holder: caller.arn, context, now,
      steps: runSteps,
      beforeSteps: saveAnswers,
      onEvent: (event) => {
        const line = eventLine(event);
        if (line !== undefined) write(line);
        // FR-070: with the page open, the one line a step gets in the terminal; everything else
        // this event produced above already went to the log file and the page's technical log.
        if (session.wizard !== undefined && event.kind === "step-started") session.say(terminalStepLine(event.id));
        session.wizard?.event(event);
      },
      // A takeover is never behind --yes, which answers every confirm with yes.
      ...(options.yes ? {} : {
        confirmTakeover: (held: LockRecord) => activePrompter.confirm(
          held.holder === caller.arn && held.command === "init"
            ? `Environment ${env} is locked by your own earlier agentx init since ${held.acquiredAt}. Take the lock over? Say yes only if that run is no longer going.`
            : `Environment ${env} is locked by ${held.holder} running "${held.command}" since ${held.acquiredAt}, more than 2 hours ago. Take the lock over? Say yes only if that command is no longer running.`,
          { defaultValue: false },
        ),
      }),
      // Spec 048 FR-060: on the page only. The terminal path keeps throwing a step's error as before.
      ...(session.wizard === undefined ? {} : {
        onStepFailure: async ({ id, title, error }: { id: InitStepId; title: string; error: unknown }) => {
          const wizard = session.wizard;
          if (wizard === undefined) return "stop";
          // Plan ruling 8: a stop the person already chose inside the step (declining a "check
          // again" question, say) is not a failure; show no screen and no second question for it.
          if (isOperatorStop(error)) return "stop";
          wizard.showFailure(failureScreen({ env, region, stepTitle: title, stepId: id, error, ...(wizard.logPath === undefined ? {} : { logPath: wizard.logPath }) }));
          const action = await askFailureAction(activePrompter, { retry: isRetryableStep(id) });
          if (action === "retry") {
            wizard.clearFailure();
            return "retry";
          }
          session.failureShown = true;
          return "stop";
        },
      }),
    });
    // A run --stop-after cut short is not installed, so it has no ready text.
    if (options.stopAfter !== undefined && result.status === "complete") {
      return { ...result, env, resumed: stored !== undefined, stoppedAfter: options.stopAfter, ...(session.wizard === undefined ? {} : { pageMode: true as const }) };
    }
    const settings = result.status === "complete" ? await readEnvironmentSettings(store, env) : undefined;
    const progress = result.status === "complete" ? await readInstallProgress(store, env) : undefined;
    // FR-058 and FR-059: the page's last card says what works now, and gives every command in a
    // form that works as shown; the terminal and the log file keep readyText, the same facts.
    if (surface !== undefined && settings !== undefined && progress !== undefined) {
      surface.card(readyCard({
        env, controlPlaneUrl: settings.controlPlaneUrl, progress,
        botName: botNameOf(progress, finalAnswers.slack.appName), invocation: session.invocation,
        root: isRootUser(caller.arn), alertsOn: finalAnswers.alert.kind !== "none",
        created: installOrder(finalAnswers.identity.mode).map((part) => environmentStackName(env, part)),
        ...(session.log === undefined ? {} : { logPath: session.log.path }),
      }));
    }
    return {
      ...result, env, resumed: stored !== undefined,
      ...(settings === undefined ? {} : { controlPlaneUrl: settings.controlPlaneUrl }),
      ...(settings === undefined || progress === undefined ? {} : {
        ready: readyText({
          env, controlPlaneUrl: settings.controlPlaneUrl, progress,
          botName: botNameOf(progress, finalAnswers.slack.appName), invocation: session.invocation,
        }),
      }),
      ...(session.wizard === undefined ? {} : { pageMode: true as const }),
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
