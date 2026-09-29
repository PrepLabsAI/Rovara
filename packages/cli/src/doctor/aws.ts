// agentx doctor's real services, built for the environment's own account and region. Every read here
// is one the operator role already allows (day-two-actions.ts's DOCTOR_AWS_ACTIONS).
import { BudgetsClient } from "@aws-sdk/client-budgets";
import { CloudFormationClient, type DescribeStacksCommand, type DescribeStacksCommandOutput } from "@aws-sdk/client-cloudformation";
import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SNSClient } from "@aws-sdk/client-sns";
import { realCommandRunner } from "../deploy/commands.js";
import { cloudFormationStackReader } from "../environments/adopt.js";
import type { ParameterStore } from "../environments/parameter-store.js";
import type { EnvironmentSettings } from "../environments/settings.js";
import { secretsManagerInitSecrets } from "../init/context.js";
import { githubRestApi } from "../init/github-app.js";
import { awsPrerequisiteChecks } from "../init/prerequisites.js";
import type { TextWriter } from "../init/prompts.js";
import { readReleaseManifest } from "../init/release-fetch.js";
import { slackWebApi } from "../init/slack-app.js";
import { awsAlertsApi } from "../setup/alerts.js";
import { slackChannelApi } from "../setup/channel-add.js";
import { vendorApi } from "../setup/connectors/vendors.js";
import { checkDeveloperSignIn } from "../signin/check.js";
import type { DoctorServices } from "./checks.js";

/** DescribeStacks for doctor: env adopt's reader (ruling F9), which also carries the last drift result.
 * Only DescribeStacks is sent; drift detection is never started (question 5). */
export function doctorStackReader(client: { send(command: unknown): Promise<unknown> }): DoctorServices["stacks"] {
  return cloudFormationStackReader({ send: async (command: DescribeStacksCommand) => (await client.send(command)) as DescribeStacksCommandOutput });
}

export function realDoctorServices(input: { settings: EnvironmentSettings; store: ParameterStore; fetch: typeof fetch; home: string; configDir: string; stderr: TextWriter }): DoctorServices {
  const { settings } = input;
  const region = { region: settings.region };
  const secrets = secretsManagerInitSecrets(new SecretsManagerClient(region));
  const slackApi = slackWebApi(input.fetch);
  return {
    secrets,
    stacks: doctorStackReader(new CloudFormationClient(region)),
    releaseManifest: (version) => readReleaseManifest({ version, home: input.home, fetch: input.fetch }),
    checks: awsPrerequisiteChecks({ region: settings.region, account: settings.account, store: input.store, runner: realCommandRunner(input.stderr), fetch: input.fetch }),
    slackApi,
    slackChannels: slackChannelApi(input.fetch),
    github: githubRestApi(input.fetch),
    vendors: vendorApi(input.fetch),
    // AWS Budgets is a global service answered in us-east-1, as init's alerts step uses it.
    alerts: awsAlertsApi({ sns: new SNSClient(region), cloudWatch: new CloudWatchClient(region), budgets: new BudgetsClient({ region: "us-east-1" }) }),
    fetch: input.fetch,
    configDir: input.configDir,
    signIn: (current) => checkDeveloperSignIn({ env: current.env, store: input.store, secrets, settings: current, fetch: input.fetch, slackApi }),
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  };
}
