// agentx init (FR-015 to FR-020): find the release and region, read any install already under way,
// ask and check and confirm on a first run, then run the steps. Every AWS, GitHub, Slack, browser
// and clock dependency is overridable through InitCliDependencies (main.ts's CliDependencies.init).
import { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SSMClient } from "@aws-sdk/client-ssm";
import { STSClient } from "@aws-sdk/client-sts";
import { agentXError } from "@agentx/contracts";
import { openSystemBrowser } from "../auth.js";
import { cliErrorFor, prepareDeployment, realCommandRunner, type DeployCliDependencies, type PreparedDeployment, type Writer } from "../deploy/commands.js";
import { assertReleaseCoversRegion, loadRelease } from "../deploy/release.js";
import { stsCallerIdentity } from "../environments/adopt.js";
import type { LockRecord } from "../environments/lock.js";
import { ssmParameterStore } from "../environments/parameter-store.js";
import { readEnvironmentSettings, type EnvironmentSettings } from "../environments/settings.js";
import type { SigninFlags } from "../signin/collect.js";
import { isPrereleaseVersion, RELEASE_VERSION } from "../version.js";
import {
  assertResumeFlagsMatch, checkAlertWebhook, collectInitAnswers, openRouterSecretName, persistInitAnswers, readOpenRouterKeyAnswer, storeAlertWebhook,
  webhookDisplay, webhookFlagDisplay, type CollectedAnswers, type InitFlags,
} from "./answers.js";
import { cloudFormationStatusReader, secretsManagerInitSecrets, type InitContext, type InitSecrets, type PreMadeGitHubApp, type SecretFlags, type StackStatusReader } from "./context.js";
import { deployStep } from "./deploy-steps.js";
import { githubAppStep, githubRestApi, type GitHubApi } from "./github-app.js";
import { readInstallAnswers, type InitAnswers } from "./install-state.js";
import { confirmInstallPlan } from "./plan.js";
import { awsPrerequisiteChecks, checkPrerequisites, type PrerequisiteChecks } from "./prerequisites.js";
import { processPrompter, secretFromSource, unattendedPrompter, type Prompter } from "./prompts.js";
import { fetchRelease } from "./release-fetch.js";
import { developerSignInStep } from "./signin-step.js";
import { slackAppStep, slackWebApi, verifySlackUrls, type SlackApi } from "./slack-app.js";
import { runInitSteps, type InitEvent, type InitRunResult, type InitStep } from "./steps.js";

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
  /** Overrides RELEASE_VERSION; null means a build from source. */
  releaseVersion?: string | null;
  /** Overrides how the run's deployment is built (tests: a cleanup that fails). */
  prepareDeployment?: typeof prepareDeployment;
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
  resume: boolean;
  flags: InitFlags;
  secretFlags: SecretFlags;
  signinFlags?: SigninFlags;
  preMadeGitHubApp?: PreMadeGitHubApp;
  /** --slack-install: answers the Slack step's "is it installed?" question (for --yes). */
  slackInstall?: "installed" | "approval";
}

export type InitResult = InitRunResult & { env: string; resumed: boolean; controlPlaneUrl?: string; nextSteps?: string };

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
    deployStep({ id: "access", title: "Deploy the access stack (IAM roles, artifact bucket, image cache)" }),
    deployStep({ id: "core", title: "Deploy the foundation and identity stacks" }),
    githubAppStep(input.github),
    deployStep({ id: "control-plane", title: "Deploy the control plane and runtime" }),
    slackAppStep(input.slack),
    deployStep({ id: "slack-service", title: "Deploy the Slack service", after: verifySlackUrls }),
    developerSignInStep({ slack: input.slack }),
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

export function nextStepsText(settings: EnvironmentSettings): string {
  const { env, region } = settings;
  const admin = settings.identity.mode === "cognito"
    ? (() => {
      const pool = settings.identity.issuer.split("/").at(-1) ?? "<user pool id>";
      return [
        `  1. Create your admin user: aws cognito-idp admin-create-user --user-pool-id ${pool} --username <your email> --region ${region}`,
        `     then: aws cognito-idp admin-add-user-to-group --user-pool-id ${pool} --username <your email> --group-name agentx-admin --region ${region}`,
      ];
    })()
    : ["  1. Make sure your own OIDC provider marks you as an AgentX administrator."];
  return [
    "Next, until agentx init does these too (a later AgentX release):",
    ...admin,
    `  2. agentx login --env ${env}`,
    `  3. agentx admin project register and agentx admin slack bind, as in docs/architecture-production.md`,
  ].join("\n");
}

const realSleep = (ms: number) => new Promise<void>((resolvePromise) => setTimeout(resolvePromise, ms));

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

export async function runInit(options: InitOptions, deps: InitCliDependencies, services: { stderr: Writer; home: string }): Promise<InitResult> {
  try {
    return await init(options, deps, services);
  } catch (error) {
    throw cliErrorFor(error);
  }
}

/** Answers "is the Slack app installed?" from --slack-install; every other question goes to `inner`. */
function answeringSlackInstall(inner: Prompter, answer: "installed" | "approval"): Prompter {
  return {
    ask: (question, options) => inner.ask(question, options),
    confirm: (question, options) => inner.confirm(question, options),
    secret: (question, options) => inner.secret(question, options),
    async choose<T extends string>(question: string, choices: ReadonlyArray<{ value: T; label: string }>, options: { flag: string; defaultValue: T }): Promise<T> {
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

async function init(options: InitOptions, deps: InitCliDependencies, services: { stderr: Writer; home: string }): Promise<InitResult> {
  const { env } = options;
  const write = (line: string) => { services.stderr.write(`${line}\n`); };
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? realSleep;
  const fetchImplementation = deps.fetch ?? fetch;
  const processEnv = deps.processEnv ?? process.env;
  const deployDeps = deps.deploy ?? {};
  // A resume reads the install from the region's SSM, so --yes never guesses it.
  if (options.yes && options.region === undefined) {
    throw agentXError("CONFIG_INVALID", "agentx init needs to know the AWS region; with --yes, pass --region <region>");
  }
  const runner = deployDeps.commandRunner ?? realCommandRunner(services.stderr);

  // The release comes first: a CLI built from source is told to pass --release before anything else.
  const version = deps.releaseVersion === undefined ? RELEASE_VERSION : deps.releaseVersion ?? undefined;
  const releaseDir = options.releaseDir ?? (await fetchRelease({ version, home: services.home, fetch: fetchImplementation, runner, write }));
  const release = await loadRelease(releaseDir);
  // F23: the saved answers take only x.y.z, so a prerelease would otherwise fail after the plan.
  if (isPrereleaseVersion(release.manifest.version)) {
    throw agentXError("CONFIG_INVALID", `release ${release.manifest.version} is a prerelease; agentx init installs only published releases (x.y.z). Pass --release <dir> with a published release`);
  }

  let prompter = deps.prompter;
  if (prompter === undefined) {
    if (options.yes) prompter = unattendedPrompter();
    else if (process.stdin.isTTY !== true) throw agentXError("CONFIG_INVALID", "agentx init asks questions; run it in a terminal, or pass --yes with a flag for every answer");
    else prompter = processPrompter(services.stderr);
  }
  if (options.slackInstall !== undefined) prompter = answeringSlackInstall(prompter, options.slackInstall);

  const regions = release.regions();
  // The AWS CLI's own region comes first, so a resume looks where the install started.
  const environmentRegion = [processEnv.AWS_REGION, processEnv.AWS_DEFAULT_REGION].find((value) => value !== undefined && regions.includes(value));
  const region = options.region ?? (await prompter.choose<string>("AWS region", regions.map((value) => ({ value, label: value })), { flag: "--region", defaultValue: environmentRegion ?? regions[0] ?? "us-east-1" }));
  assertReleaseCoversRegion(release, region);

  const store = deployDeps.store ?? ssmParameterStore(new SSMClient({ region }));
  const secrets = deps.initSecrets ?? secretsManagerInitSecrets(new SecretsManagerClient({ region }));
  const caller = await (deployDeps.identity ?? stsCallerIdentity(new STSClient({ region }))).get();
  if (options.account !== undefined && options.account !== caller.account) {
    throw agentXError("CONFIG_INVALID", `--account ${options.account} does not match your AWS credentials, which are for account ${caller.account}; use credentials for ${options.account}, or leave --account off`);
  }
  const checks = deps.checks ?? awsPrerequisiteChecks({ region, account: caller.account, store, runner, fetch: fetchImplementation });

  const existingSettings = await readEnvironmentSettings(store, env);
  const stored = await readInstallAnswers(store, env);
  if (stored === undefined && existingSettings !== undefined) {
    throw agentXError("CONFIG_INVALID", existingSettings.naming === "legacy"
      ? `environment ${env} is the deployment adopted with fixed stack names; agentx init cannot install over it. Choose another --env`
      : `environment ${env} is already installed, but not by agentx init; there is nothing to resume. Choose another --env, or use agentx deploy --mode upgrade`);
  }
  if (options.resume && stored === undefined) {
    throw agentXError("CONFIG_INVALID", `there is no install of environment ${env} to resume in account ${caller.account} (${region}); run agentx init without --resume to start one`);
  }

  let collected: CollectedAnswers | undefined;
  let answers: InitAnswers;
  if (stored === undefined) {
    collected = await collectInitAnswers({ env, region, account: caller.account, releaseVersion: release.manifest.version, flags: options.flags, prompter, processEnv, now });
    answers = collected.answers;
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
  const finalAnswers = answers;
  // A first run's OpenRouter key is not stored until after the plan, so the check uses it directly.
  const pendingKey = collected?.openRouterKey === undefined
    ? undefined
    : { key: collected.openRouterKey, ...(collected.openRouterProviders === undefined ? {} : { providers: collected.openRouterProviders }) };
  const runPrerequisites = () => checkPrerequisites({ answers: finalAnswers, release, caller, checks, prompter: activePrompter, write, ...(pendingKey === undefined ? {} : { openRouterKey: pendingKey }) });
  let prerequisitesPassed = false;
  let rotatedWebhook: string | undefined;
  let rotatedOpenRouterKey: string | undefined;
  if (collected !== undefined) {
    await runPrerequisites();
    prerequisitesPassed = true;
    // Printed even under --yes, before anything is created.
    await confirmInstallPlan({
      answers: collected.answers, notes: collected.notes, prompter, write: (text) => { services.stderr.write(text); },
      extras: { storesOpenRouterKey: collected.openRouterKey !== undefined, ...(collected.openRouterProviders === undefined ? {} : { openRouterProviders: collected.openRouterProviders }) },
    });
  } else {
    write(`Resuming the install of environment ${env}.`);
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
    ...(options.browser ? { openBrowser: neverThrowingBrowser(deps.openBrowser ?? openSystemBrowser, write) } : {}),
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
    stackStatus: deps.stackStatus ?? cloudFormationStatusReader(new CloudFormationClient({ region })),
    home: services.home,
    prerequisitesPassed,
    runPrerequisites,
  };

  try {
    const result = await runInitSteps({
      env, region, store, holder: caller.arn, context, now,
      steps: initSteps({ github: deps.github ?? githubRestApi(fetchImplementation), slack: deps.slack ?? slackWebApi(fetchImplementation) }),
      beforeSteps: saveAnswers,
      onEvent: (event) => write(eventLine(event)),
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
    const settings = result.status === "complete" ? await readEnvironmentSettings(store, env) : undefined;
    return {
      ...result, env, resumed: stored !== undefined,
      ...(settings === undefined ? {} : { controlPlaneUrl: settings.controlPlaneUrl, nextSteps: nextStepsText(settings) }),
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
