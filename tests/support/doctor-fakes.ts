// Everything agentx doctor reads, faked: a healthy templates-engine environment by default, with
// every secret well formed. Tests break one thing at a time.
import { environmentStackName, type ReleaseManifest } from "@agentx/contracts";
import type { DoctorContext, DoctorServices, DoctorStack } from "../../packages/cli/src/doctor/checks.js";
import type { InstallProgress } from "../../packages/cli/src/init/install-state.js";
import { fakeGitHubApi, fakeSlackApi, memoryInitSecrets, passingChecks, sampleAnswers, TEST_BOT_TOKEN, TEST_PRIVATE_KEY, TEST_SIGNING_SECRET, T0 } from "./init-fakes.js";
import { fakeAlerts, fakeSlackChannels, fakeVendors, STAGING_SETTINGS } from "./setup-fakes.js";

export const ENV = "staging";
export const SIGNING_KEY = "callbackKEY-".padEnd(43, "q");
export const ASSET = "a".repeat(64);
export const WORKER_DIGEST = `sha256:${"b".repeat(64)}`;
export const SLACK_DIGEST = `sha256:${"c".repeat(64)}`;

export const MANIFEST: ReleaseManifest = {
  schemaVersion: 1, version: STAGING_SETTINGS.version, gitCommit: "d".repeat(40), environmentPlaceholder: "qqenv-placeholderqq", templates: [],
  packages: [{ assetId: ASSET, file: `packages/${ASSET}.zip`, sha256: "e".repeat(64), parts: ["control-plane"], bucketParameter: "AssetBucket", keyParameter: "AssetKey", hashParameter: "AssetHash", keyParameterValue: `packages/${ASSET}.zip` }],
  images: { worker: `public.ecr.aws/agentx/agentx-worker@${WORKER_DIGEST}`, slack: `public.ecr.aws/agentx/agentx-slack@${SLACK_DIGEST}` },
};

export const SECRETS: Record<string, string> = {
  "agentx/staging/callback-signing-key": SIGNING_KEY,
  "agentx/staging/slack": JSON.stringify({ botToken: TEST_BOT_TOKEN, signingSecret: TEST_SIGNING_SECRET }),
  "agentx/staging/github-app": JSON.stringify({ appId: "123", slug: "agentx-acme", account: "acme", privateKey: TEST_PRIVATE_KEY }),
};

/** Every part's stack, healthy, deployed by the templates engine from MANIFEST. */
export function healthyStacks(): Record<string, DoctorStack> {
  const stack = (parameters: Record<string, string> = {}, outputs: Record<string, string> = {}): DoctorStack => ({ status: "UPDATE_COMPLETE", parameters, outputs, drift: "NOT_CHECKED" });
  return {
    [environmentStackName(ENV, "access")]: stack({ OperatorPrincipalArn: "" }),
    [environmentStackName(ENV, "foundation")]: stack({}, { Ec2WorkerLaunchTemplateId: "lt-0123456789abcdef0" }),
    [environmentStackName(ENV, "identity")]: stack(),
    [environmentStackName(ENV, "runtime")]: stack({ WorkerImageUri: `123456789012.dkr.ecr.us-east-1.amazonaws.com/agentx-staging/agentx/agentx-worker@${WORKER_DIGEST}`, ModelId: "amazon.nova-pro-v1:0" }),
    [environmentStackName(ENV, "control-plane")]: stack(
      { AssetHash: ASSET, BudgetMonthlyUsd: "100", BudgetScope: "tag" },
      { SlackEventsUrl: "https://cp.example.test/slack/events", SlackInteractivityUrl: "https://cp.example.test/slack/interactivity", OperatorAlertsTopicArn: "arn:aws:sns:us-east-1:123456789012:agentx-staging-alerts", ApiEndpoint: "https://cp.example.test" },
    ),
    [environmentStackName(ENV, "slack")]: stack({ OrchestratorImageUri: `123456789012.dkr.ecr.us-east-1.amazonaws.com/agentx-staging/agentx/agentx-slack@${SLACK_DIGEST}` }),
  };
}

export const SETTINGS = {
  ...STAGING_SETTINGS,
  stacks: { access: "agentx-staging-access", foundation: "agentx-staging-foundation", identity: "agentx-staging-identity", runtime: "agentx-staging-runtime", "control-plane": "agentx-staging-control-plane", slack: "agentx-staging-slack" },
};

export const PROGRESS: InstallProgress = {
  schemaVersion: 1, env: ENV, steps: {}, updatedAt: new Date(T0).toISOString(),
  github: { account: "acme", appId: "123", slug: "agentx-acme", privateKeySecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/staging/github-app-AbCdEf", installationId: "456" },
  slack: { appId: "A0APP", teamId: "T0TEAM", botUserId: "U0BOT" },
  project: { name: "payments", revision: 1, channelName: "payments", channelId: "C0123456789", teamId: "T0TEAM" },
};

export function doctorServices(overrides: Partial<DoctorServices> & { stackMap?: Record<string, DoctorStack> } = {}): DoctorServices {
  const { stackMap, ...rest } = overrides;
  const stacks = stackMap ?? healthyStacks();
  return {
    secrets: memoryInitSecrets(SECRETS),
    stacks: { describe: async (name) => stacks[name] },
    releaseManifest: async () => MANIFEST,
    checks: passingChecks(),
    slackApi: fakeSlackApi(),
    slackChannels: fakeSlackChannels([{ id: "C0123456789", name: "payments", isPrivate: false, isMember: true }]),
    github: fakeGitHubApi({ installationId: 456 }),
    vendors: fakeVendors(),
    alerts: fakeAlerts({ existing: [{ arn: "arn:aws:sns:us-east-1:123456789012:agentx-staging-alerts:1", protocol: "email", endpoint: "ops@example.com" }], budgetUsd: 100 }),
    // The Slack ingress: echoes the url_verification challenge, and answers the interactivity probe 200.
    fetch: async (_input: unknown, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (body.startsWith("{")) return new Response(JSON.stringify({ challenge: (JSON.parse(body) as { challenge: string }).challenge }), { status: 200 });
      return new Response("", { status: 200 });
    },
    configDir: "/nonexistent-agentx-doctor",
    signIn: async () => [{ name: "settings", ok: true, detail: "Slack sign-in on, company sign-in off" }],
    now: () => T0,
    sleep: async () => undefined,
    ...rest,
  };
}

export function doctorContext(overrides: Partial<DoctorContext> & { services?: DoctorServices } = {}): DoctorContext {
  return { env: ENV, settings: SETTINGS, answers: sampleAnswers({ env: ENV }), progress: PROGRESS, services: doctorServices(), ...overrides };
}
